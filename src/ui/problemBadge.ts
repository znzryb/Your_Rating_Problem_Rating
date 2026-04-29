import {
  fetchAllContestSubmissions,
  findContest,
  getUserInfos,
} from '../cf/api';
import { cacheGet, cacheSet } from '../storage/cache';
import { inferProblemRating, type SolveSample } from '../problem-rating/reverseElo';
import type { CfContest, CfSubmission, CfUserInfo } from '../cf/types';
import { ratingColor } from './colors';
import { contestIdFromPath, problemIndexFromPath, waitFor } from '../utils/dom';

const PROBLEM_TTL = 24 * 60 * 60 * 1000;

interface InferredEntry {
  rating: number;
  raters: number;
}

interface ContestInferenceResult {
  entries: Map<string, InferredEntry>;
  totalRated: number;
}

const inflightByContest = new Map<number, Promise<ContestInferenceResult>>();

interface DerivedStandings {
  problems: string[];
  /** handle (lowercase) → set of problem indexes solved during the contest */
  solvedByHandle: Map<string, Set<string>>;
}

function isOfficialContestSubmission(sub: CfSubmission, durationSeconds: number): boolean {
  const a = sub.author;
  if (!a) return false;
  if (a.participantType !== 'CONTESTANT') return false;
  if (a.ghost) return false;
  // Single-contestant rows only — skip teams (CF has both team contests and individual rounds).
  if (!a.members || a.members.length !== 1) return false;
  const rel = sub.relativeTimeSeconds;
  if (!Number.isFinite(rel)) return false;
  return rel >= 0 && rel <= durationSeconds;
}

function deriveStandingsFromSubmissions(
  submissions: CfSubmission[],
  contest: CfContest,
): DerivedStandings {
  const problemSet = new Set<string>();
  const solvedByHandle = new Map<string, Set<string>>();
  for (const sub of submissions) {
    if (!isOfficialContestSubmission(sub, contest.durationSeconds)) continue;
    const idx = sub.problem?.index;
    if (!idx) continue;
    problemSet.add(idx);
    if (sub.verdict !== 'OK') continue;
    const handle = sub.author.members[0].handle.toLowerCase();
    let solved = solvedByHandle.get(handle);
    if (!solved) {
      solved = new Set<string>();
      solvedByHandle.set(handle, solved);
    }
    solved.add(idx);
  }
  // Also walk submissions once more to make sure every party that *attempted* (even if no AC)
  // is registered as a contestant — they count as a non-solver, which is signal for the Elo fit.
  for (const sub of submissions) {
    if (!isOfficialContestSubmission(sub, contest.durationSeconds)) continue;
    const handle = sub.author.members[0].handle.toLowerCase();
    if (!solvedByHandle.has(handle)) {
      solvedByHandle.set(handle, new Set<string>());
    }
  }
  const problems = Array.from(problemSet).sort();
  return { problems, solvedByHandle };
}

async function computeForContest(contestId: number): Promise<ContestInferenceResult> {
  const cached = inflightByContest.get(contestId);
  if (cached) return cached;
  const promise = (async (): Promise<ContestInferenceResult> => {
    const cacheKey = `yrpr:problem-rating:${contestId}`;
    const cachedRecord = cacheGet<{ entries: Record<string, InferredEntry>; totalRated: number }>(cacheKey);
    if (cachedRecord) {
      console.log(`[YRPR] cache hit for contest ${contestId}`);
      return { entries: new Map(Object.entries(cachedRecord.entries)), totalRated: cachedRecord.totalRated };
    }

    const t0 = performance.now();
    const contest = await findContest(contestId);
    if (!contest) throw new Error(`contest ${contestId} not found in contest.list`);
    console.log(`[YRPR] contest ${contestId}: "${contest.name}", duration=${contest.durationSeconds}s`);

    const submissions = await fetchAllContestSubmissions(contestId, (loaded) => {
      console.log(`[YRPR] contest.status: ${loaded} submissions loaded so far…`);
    });
    console.log(`[YRPR] total submissions fetched: ${submissions.length} in ${Math.round(performance.now() - t0)}ms`);

    const { problems, solvedByHandle } = deriveStandingsFromSubmissions(submissions, contest);
    console.log(`[YRPR] derived: ${problems.length} problems, ${solvedByHandle.size} unique contestants`);
    if (solvedByHandle.size === 0) return { entries: new Map(), totalRated: 0 };

    const handles = Array.from(solvedByHandle.keys());
    const tRatings = performance.now();
    const infos = await getUserInfos(handles);
    const ratingByHandle = new Map<string, number>();
    for (const u of infos as CfUserInfo[]) ratingByHandle.set(u.handle.toLowerCase(), u.rating ?? 0);
    console.log(`[YRPR] user.info for ${handles.length} handles in ${Math.round(performance.now() - tRatings)}ms`);

    const entries = new Map<string, InferredEntry>();
    let totalRated = 0;
    for (const idx of problems) {
      const samples: SolveSample[] = [];
      for (const [handle, solvedSet] of solvedByHandle.entries()) {
        const rating = ratingByHandle.get(handle) ?? 0;
        if (rating <= 0) continue;
        samples.push({ rating, solved: solvedSet.has(idx) });
      }
      if (idx === problems[0]) totalRated = samples.length;
      const inferred = inferProblemRating(samples);
      if (inferred !== null) entries.set(idx, { rating: inferred, raters: samples.length });
    }
    console.log(`[YRPR] inferred ratings for ${entries.size}/${problems.length} problems`);

    const asObj: Record<string, InferredEntry> = {};
    for (const [k, v] of entries) asObj[k] = v;
    cacheSet(cacheKey, { entries: asObj, totalRated }, PROBLEM_TTL);
    return { entries, totalRated };
  })();
  inflightByContest.set(contestId, promise);
  return promise;
}

type BadgeState =
  | { kind: 'pending' }
  | { kind: 'unknown' }
  | { kind: 'error'; message: string }
  | { kind: 'rating'; entry: InferredEntry };

function makeBadge(state: BadgeState): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = 'yrpr-badge';
  const baseStyle = [
    'display:inline-block', 'margin-left:10px',
    'font-weight:700', 'font-size:0.85em',
    'padding:1px 6px', 'border-radius:4px',
    'vertical-align:middle',
  ];
  if (state.kind === 'pending') {
    badge.textContent = '≈…';
    badge.title = 'YRPR computing inferred problem rating from CF submissions…';
    badge.style.cssText = [...baseStyle, 'color:#aa8a20', 'border:1px dashed #d4b54f'].join(';');
    return badge;
  }
  if (state.kind === 'unknown') {
    badge.textContent = '≈?';
    badge.title = 'YRPR: not enough signal in submissions (everyone or nobody solved it, or too few rated contestants).';
    badge.style.cssText = [...baseStyle, 'color:#888', 'border:1px solid #bbb'].join(';');
    return badge;
  }
  if (state.kind === 'error') {
    badge.textContent = '≈!';
    badge.title = `YRPR error: ${state.message}\n\nOpen the DevTools console and look for [YRPR] for details.`;
    badge.style.cssText = [...baseStyle, 'color:#cc0000', 'border:1px solid #cc0000', 'cursor:help'].join(';');
    return badge;
  }
  badge.textContent = `≈${state.entry.rating}`;
  badge.title = `YRPR inferred rating (Carrot-style reverse Elo over ${state.entry.raters} rated contestants).`;
  badge.style.cssText = [
    ...baseStyle,
    `color:${ratingColor(state.entry.rating)}`,
    `border:1px solid ${ratingColor(state.entry.rating)}`,
  ].join(';');
  return badge;
}

function setTitleBadge(state: BadgeState): void {
  const header = document.querySelector('.problem-statement .header .title');
  if (!header) return;
  const existing = header.querySelector('.yrpr-badge');
  if (existing) existing.remove();
  header.appendChild(makeBadge(state));
}

function renderBadgeInContestList(entries: Map<string, InferredEntry>): void {
  const rows = document.querySelectorAll<HTMLTableRowElement>('table.problems tr');
  for (const tr of Array.from(rows)) {
    const first = tr.querySelector<HTMLElement>('td.id a');
    if (!first) continue;
    const idx = first.textContent?.trim();
    if (!idx) continue;
    const entry = entries.get(idx);
    if (!entry) continue;
    if (tr.querySelector('.yrpr-badge')) continue;
    const badge = document.createElement('span');
    badge.className = 'yrpr-badge';
    badge.textContent = `≈${entry.rating}`;
    badge.title = `YRPR inferred rating (Carrot-style reverse Elo over ${entry.raters} rated contestants).`;
    badge.style.cssText = [
      'margin-left:8px',
      `color:${ratingColor(entry.rating)}`,
      'font-weight:700',
      'font-size:0.9em',
    ].join(';');
    first.appendChild(badge);
  }
}

export async function bootstrapProblemBadge(): Promise<void> {
  const contestId = contestIdFromPath();
  if (!contestId) return;

  const onSingleProblem = /\/problem\/[A-Za-z]/.test(location.pathname);

  if (onSingleProblem) {
    const titleEl = await waitFor('.problem-statement .header .title');
    if (!titleEl) return;
    const idx = problemIndexFromPath();
    if (!idx) return;
    setTitleBadge({ kind: 'pending' });
    try {
      const { entries } = await computeForContest(contestId);
      const entry = entries.get(idx);
      setTitleBadge(entry ? { kind: 'rating', entry } : { kind: 'unknown' });
    } catch (err) {
      console.error('[YRPR] problem badge failed:', err);
      const message = err instanceof Error ? err.message : String(err);
      setTitleBadge({ kind: 'error', message });
    }
    return;
  }

  const problemsTable = await waitFor('table.problems');
  if (!problemsTable) return;
  try {
    const { entries } = await computeForContest(contestId);
    if (entries.size > 0) renderBadgeInContestList(entries);
  } catch (err) {
    console.error('[YRPR] problem badge (contest list) failed:', err);
  }
}
