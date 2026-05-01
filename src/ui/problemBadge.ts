import {
  fetchAllContestSubmissions,
  findContest,
  getUserInfos,
} from '../cf/api';
import { cacheGet, cacheSet } from '../storage/cache';
import { inferProblemRating, type SolveSample } from '../problem-rating/reverseElo';
import type { CfContest, CfSubmission, CfUserInfo } from '../cf/types';
import { ratingColor } from './colors';
import { isSpoilerEnabled, spoilerCss, SPOILER_HINT } from './spoiler';
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

interface Contestant {
  /** Lowercased handles of every member of this party (1 for solo, 2-3 for ICPC teams). */
  handles: string[];
  /** Problem indexes this contestant got an AC on during the contest window. */
  solved: Set<string>;
}

interface DerivedStandings {
  problems: string[];
  /** stable team-id (sorted-handles join) → contestant. Solo contestants land here too. */
  contestants: Map<string, Contestant>;
}

function isOfficialContestSubmission(
  sub: CfSubmission,
  durationSeconds: number,
  gym: boolean,
): boolean {
  const a = sub.author;
  if (!a) return false;
  if (a.ghost) return false;
  // Both solo and team submissions count — for ICPC gym contests every row is a 3-member
  // team, and we still want to treat each team as one contestant for the Elo fit.
  if (!a.members || a.members.length === 0) return false;
  const rel = sub.relativeTimeSeconds;
  if (!Number.isFinite(rel)) return false;
  if (rel < 0 || rel > durationSeconds) return false;

  if (gym) {
    // Gym: real timed attempts only — CONTESTANT (live registered), VIRTUAL (vp), and
    // OUT_OF_COMPETITION (live but unrated, common for ICPC team gyms). PRACTICE is
    // excluded: post-contest with editorials/solutions floating around, very noisy.
    return (
      a.participantType === 'CONTESTANT' ||
      a.participantType === 'VIRTUAL' ||
      a.participantType === 'OUT_OF_COMPETITION'
    );
  }
  // Regular rounds: live CONTESTANT only, that's where the signal is cleanest.
  return a.participantType === 'CONTESTANT';
}

function partyId(sub: CfSubmission): string {
  return sub.author.members.map((m) => m.handle.toLowerCase()).sort().join('|');
}

function deriveStandingsFromSubmissions(
  submissions: CfSubmission[],
  contest: CfContest,
  gym: boolean,
): DerivedStandings {
  // Diagnostic: dump the participantType breakdown so it's obvious from the console why
  // the filter let through (or rejected) what it did.
  const typeCounts = new Map<string, number>();
  for (const sub of submissions) {
    const t = sub.author?.participantType ?? 'NONE';
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  }
  console.log('[YRPR] participantType breakdown:', Object.fromEntries(typeCounts));

  const problemSet = new Set<string>();
  const contestants = new Map<string, Contestant>();
  for (const sub of submissions) {
    if (!isOfficialContestSubmission(sub, contest.durationSeconds, gym)) continue;
    const idx = sub.problem?.index;
    if (!idx) continue;
    problemSet.add(idx);
    const id = partyId(sub);
    let row = contestants.get(id);
    if (!row) {
      row = {
        handles: sub.author.members.map((m) => m.handle.toLowerCase()),
        solved: new Set<string>(),
      };
      contestants.set(id, row);
    }
    if (sub.verdict === 'OK') row.solved.add(idx);
  }
  const problems = Array.from(problemSet).sort();
  return { problems, contestants };
}

async function computeForContest(contestId: number, gym: boolean): Promise<ContestInferenceResult> {
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
    const contest = await findContest(contestId, gym);
    if (!contest) throw new Error(`contest ${contestId} not found in contest.list`);
    console.log(`[YRPR] contest ${contestId}: "${contest.name}", duration=${contest.durationSeconds}s`);

    const submissions = await fetchAllContestSubmissions(contestId, (loaded) => {
      console.log(`[YRPR] contest.status: ${loaded} submissions loaded so far…`);
    });
    console.log(`[YRPR] total submissions fetched: ${submissions.length} in ${Math.round(performance.now() - t0)}ms`);

    const { problems, contestants } = deriveStandingsFromSubmissions(submissions, contest, gym);
    console.log(`[YRPR] derived: ${problems.length} problems, ${contestants.size} unique contestants`);
    if (contestants.size === 0) return { entries: new Map(), totalRated: 0 };

    // Collect every individual handle across all parties (solo + team members).
    const allHandles = new Set<string>();
    for (const row of contestants.values()) for (const h of row.handles) allHandles.add(h);
    const handles = Array.from(allHandles);
    const tRatings = performance.now();
    const infos = await getUserInfos(handles);
    const ratingByHandle = new Map<string, number>();
    for (const u of infos as CfUserInfo[]) ratingByHandle.set(u.handle.toLowerCase(), u.rating ?? 0);
    console.log(`[YRPR] user.info for ${handles.length} handles in ${Math.round(performance.now() - tRatings)}ms`);

    // Effective rating per contestant = max over its members. For ICPC teams this treats
    // the team as if its strongest member played alone — a coarse but well-defined proxy
    // when CF doesn't expose a team rating.
    const effectiveRating = new Map<string, number>();
    for (const [id, row] of contestants) {
      let best = 0;
      for (const h of row.handles) {
        const r = ratingByHandle.get(h) ?? 0;
        if (r > best) best = r;
      }
      effectiveRating.set(id, best);
    }

    const entries = new Map<string, InferredEntry>();
    let totalRated = 0;
    for (const idx of problems) {
      const samples: SolveSample[] = [];
      for (const [id, row] of contestants) {
        const rating = effectiveRating.get(id) ?? 0;
        if (rating <= 0) continue;
        samples.push({ rating, solved: row.solved.has(idx) });
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

interface BadgeStyleSpec {
  marginLeft: string;
  innerStyle: string[];
  text: string;
  title: string;
  isRating: boolean;
}

/**
 * Build a badge whose visible text lives inside an open shadow tree.
 *
 * The host span sits where the old badge sat (e.g. as a child of `.title` on
 * single-problem pages), but `Element.outerHTML` does not serialize shadow
 * roots and `Node.textContent` does not walk into them, so Competitive
 * Companion's `.problem-statement > .header > .title` parser sees a clean
 * problem name without our `≈XXXX` tail.
 */
function buildShadowBadge(spec: BadgeStyleSpec): HTMLSpanElement {
  const host = document.createElement('span');
  host.className = 'yrpr-badge';
  host.style.cssText = `display:inline-block;vertical-align:middle;margin-left:${spec.marginLeft}`;

  const wantSpoiler = spec.isRating && isSpoilerEnabled();
  host.title = wantSpoiler ? spec.title + SPOILER_HINT : spec.title;

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .inner { font: inherit; }
    ${spoilerCss()}
  `;
  shadow.appendChild(style);

  const inner = document.createElement('span');
  inner.className = wantSpoiler ? 'inner spoiler' : 'inner';
  inner.style.cssText = spec.innerStyle.join(';');
  inner.textContent = spec.text;
  shadow.appendChild(inner);

  return host;
}

function makeBadge(state: BadgeState): HTMLSpanElement {
  const innerBase = [
    'display:inline-block',
    'font-weight:700', 'font-size:0.85em',
    'padding:1px 6px', 'border-radius:4px',
  ];
  if (state.kind === 'pending') {
    return buildShadowBadge({
      marginLeft: '10px',
      innerStyle: [...innerBase, 'color:#aa8a20', 'border:1px dashed #d4b54f'],
      text: '≈…',
      title: 'YRPR computing inferred problem rating from CF submissions…',
      isRating: false,
    });
  }
  if (state.kind === 'unknown') {
    return buildShadowBadge({
      marginLeft: '10px',
      innerStyle: [...innerBase, 'color:#888', 'border:1px solid #bbb'],
      text: '≈?',
      title: 'YRPR: not enough signal in submissions (everyone or nobody solved it, or too few rated contestants).',
      isRating: false,
    });
  }
  if (state.kind === 'error') {
    return buildShadowBadge({
      marginLeft: '10px',
      innerStyle: [...innerBase, 'color:#cc0000', 'border:1px solid #cc0000', 'cursor:help'],
      text: '≈!',
      title: `YRPR error: ${state.message}\n\nOpen the DevTools console and look for [YRPR] for details.`,
      isRating: false,
    });
  }
  return buildShadowBadge({
    marginLeft: '10px',
    innerStyle: [
      ...innerBase,
      `color:${ratingColor(state.entry.rating)}`,
      `border:1px solid ${ratingColor(state.entry.rating)}`,
    ],
    text: `≈${state.entry.rating}`,
    title: `YRPR inferred rating (Carrot-style reverse Elo over ${state.entry.raters} rated contestants).`,
    isRating: true,
  });
}

function setTitleBadge(state: BadgeState): void {
  const header = document.querySelector('.problem-statement .header .title');
  if (!header) return;
  const existing = header.querySelector('.yrpr-badge');
  if (existing) existing.remove();
  header.appendChild(makeBadge(state));
}

function makeContestListBadge(state: BadgeState): HTMLSpanElement {
  const innerBase = ['font-weight:700', 'font-size:0.9em'];
  if (state.kind === 'pending') {
    return buildShadowBadge({
      marginLeft: '8px',
      innerStyle: [...innerBase, 'color:#888'],
      text: '≈…',
      title: 'YRPR computing inferred problem rating from CF submissions…',
      isRating: false,
    });
  }
  if (state.kind === 'unknown') {
    return buildShadowBadge({
      marginLeft: '8px',
      innerStyle: [...innerBase, 'color:#888'],
      text: '≈?',
      title: 'YRPR: not enough signal in submissions (everyone or nobody solved it, or too few rated contestants).',
      isRating: false,
    });
  }
  if (state.kind === 'error') {
    return buildShadowBadge({
      marginLeft: '8px',
      innerStyle: [...innerBase, 'color:#cc0000', 'cursor:help'],
      text: '≈!',
      title: `YRPR error: ${state.message}\n\nOpen DevTools console and look for [YRPR] for details.`,
      isRating: false,
    });
  }
  return buildShadowBadge({
    marginLeft: '8px',
    innerStyle: [...innerBase, `color:${ratingColor(state.entry.rating)}`],
    text: `≈${state.entry.rating}`,
    title: `YRPR inferred rating (Carrot-style reverse Elo over ${state.entry.raters} rated contestants).`,
    isRating: true,
  });
}

function setRowBadge(anchor: HTMLElement, state: BadgeState): void {
  const existing = anchor.querySelector('.yrpr-badge');
  if (existing) existing.remove();
  anchor.appendChild(makeContestListBadge(state));
}

/**
 * Snapshot the contest-list table once, before any DOM mutation, so we can keep mapping
 * row → problem index even after we've appended badges that change `textContent`.
 */
function snapshotContestListRows(): Map<string, HTMLAnchorElement> {
  const map = new Map<string, HTMLAnchorElement>();
  const rows = document.querySelectorAll<HTMLTableRowElement>('table.problems tr');
  for (const tr of Array.from(rows)) {
    const first = tr.querySelector<HTMLAnchorElement>('td.id a');
    if (!first) continue;
    const idx = first.textContent?.trim();
    if (!idx) continue;
    map.set(idx, first);
  }
  return map;
}

export async function bootstrapProblemBadge(): Promise<void> {
  const ctx = contestIdFromPath();
  if (!ctx) return;
  const { contestId, gym } = ctx;

  const onSingleProblem = /\/problem\/[A-Za-z]/.test(location.pathname);

  if (onSingleProblem) {
    const titleEl = await waitFor('.problem-statement .header .title');
    if (!titleEl) return;
    const idx = problemIndexFromPath();
    if (!idx) return;
    setTitleBadge({ kind: 'pending' });
    try {
      const { entries } = await computeForContest(contestId, gym);
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

  // Snapshot the row → letter mapping BEFORE we mutate, then drop a gray ≈… placeholder
  // on every row so the user gets immediate feedback that the inference has started.
  const rowMap = snapshotContestListRows();
  for (const anchor of rowMap.values()) {
    setRowBadge(anchor, { kind: 'pending' });
  }

  try {
    const { entries } = await computeForContest(contestId, gym);
    for (const [idx, anchor] of rowMap) {
      const entry = entries.get(idx);
      setRowBadge(anchor, entry ? { kind: 'rating', entry } : { kind: 'unknown' });
    }
  } catch (err) {
    console.error('[YRPR] problem badge (contest list) failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    for (const anchor of rowMap.values()) {
      setRowBadge(anchor, { kind: 'error', message });
    }
  }
}
