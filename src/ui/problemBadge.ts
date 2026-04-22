import { getUserInfos } from '../cf/api';
import { fetchFullStandings } from '../cf/standingsScrape';
import { cacheGet, cacheSet } from '../storage/cache';
import { inferProblemRating, type SolveSample } from '../problem-rating/reverseElo';
import type { CfUserInfo } from '../cf/types';
import { ratingColor } from './colors';
import { contestIdFromPath, problemIndexFromPath, waitFor } from '../utils/dom';

const PROBLEM_TTL = 24 * 60 * 60 * 1000; // 24h — problem rating stabilises once a round ends

interface InferredEntry {
  rating: number;
  raters: number;
}

async function computeForContest(contestId: number): Promise<Map<string, InferredEntry>> {
  const cacheKey = `yrpr:problem-rating:${contestId}`;
  const cached = cacheGet<Record<string, InferredEntry>>(cacheKey);
  if (cached) return new Map(Object.entries(cached));

  const { problems, rows } = await fetchFullStandings(contestId);
  const officialRated = rows.filter((r) => r.participantId !== null && r.handle.length > 0);
  if (officialRated.length === 0) return new Map();

  const infos = await getUserInfos(officialRated.map((r) => r.handle));
  const ratingByHandle = new Map<string, number>();
  for (const u of infos as CfUserInfo[]) ratingByHandle.set(u.handle.toLowerCase(), u.rating ?? 0);

  const result = new Map<string, InferredEntry>();
  for (let pIdx = 0; pIdx < problems.length; pIdx++) {
    const samples: SolveSample[] = [];
    for (const row of officialRated) {
      const rating = ratingByHandle.get(row.handle.toLowerCase()) ?? 0;
      if (rating <= 0) continue;
      samples.push({ rating, solved: row.solved[pIdx] === true });
    }
    const inferred = inferProblemRating(samples);
    if (inferred !== null) result.set(problems[pIdx], { rating: inferred, raters: samples.length });
  }

  const asObj: Record<string, InferredEntry> = {};
  for (const [k, v] of result) asObj[k] = v;
  cacheSet(cacheKey, asObj, PROBLEM_TTL);
  return result;
}

function renderBadgeInTitle(entry: InferredEntry): void {
  const header = document.querySelector('.problem-statement .header .title');
  if (!header || header.querySelector('.yrpr-badge')) return;
  const badge = document.createElement('span');
  badge.className = 'yrpr-badge';
  badge.textContent = `≈${entry.rating}`;
  badge.title = `YRPR inferred rating (reverse Elo over ${entry.raters} rated contestants). Official difficulty not yet set.`;
  badge.style.cssText = [
    'display:inline-block',
    'margin-left:10px',
    `color:${ratingColor(entry.rating)}`,
    'font-weight:700',
    'font-size:0.85em',
    `border:1px solid ${ratingColor(entry.rating)}`,
    'padding:1px 6px',
    'border-radius:4px',
    'vertical-align:middle',
  ].join(';');
  header.appendChild(badge);
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
    badge.title = `YRPR inferred rating (reverse Elo over ${entry.raters} rated contestants).`;
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
    await waitFor('.problem-statement .header .title');
    const idx = problemIndexFromPath();
    if (!idx) return;
    const entries = await computeForContest(contestId);
    const entry = entries.get(idx);
    if (entry) renderBadgeInTitle(entry);
    return;
  }

  const problemsTable = await waitFor('table.problems');
  if (!problemsTable) return;
  const entries = await computeForContest(contestId);
  if (entries.size > 0) renderBadgeInContestList(entries);
}
