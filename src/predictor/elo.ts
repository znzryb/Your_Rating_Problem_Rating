// Codeforces Elo rating prediction — Mike Mirzayanov's formula
// Reference: https://codeforces.com/blog/entry/20762
//
// Definitions (for contestant i, over the set S of rated contestants):
//   winProb(a, b)   = 1 / (1 + 10^((R_b - R_a) / 400))         // P(a beats b)
//   seed_i          = 1 + Σ_{j ∈ S, j ≠ i} winProb(R_j, R_i)   // expected rank given ratings only
//   midRank_i       = sqrt(seed_i · actualRank_i)              // geometric mean of expected & actual
//   needed_i        = binSearch R such that seed_R_i = midRank_i
//   rawDelta_i      = (needed_i − R_i) / 2
//
// Two corrections are then applied in `corrections.ts` — see that file for details.

import { applyCorrections } from './corrections';

export interface Contestant {
  handle: string;
  rating: number;     // rating *before* this contest; new / unrated contestants should be filtered out upstream
  rank: number;       // actual (tied-adjusted) rank among rated contestants
}

export interface Prediction {
  handle: string;
  rating: number;
  rank: number;
  seed: number;
  delta: number;
}

function winProb(ra: number, rb: number): number {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

/**
 * Compute seed_i for a single contestant at a hypothetical rating `r`, relative to the
 * rest of the contestants. If `excludeIndex` is provided, that contestant is skipped
 * (used when computing the true seed of contestant i against the other n-1 contestants).
 */
function seedAt(r: number, contestants: Contestant[], excludeIndex: number): number {
  let s = 1;
  for (let j = 0; j < contestants.length; j++) {
    if (j === excludeIndex) continue;
    s += winProb(contestants[j].rating, r);
  }
  return s;
}

/** Binary search for the rating R such that seed(R) ≈ target, searching 0..8000. */
function ratingForSeed(target: number, contestants: Contestant[], excludeIndex: number): number {
  let lo = 1;
  let hi = 8000;
  // 30 iterations gives ~1e-5 precision — overkill but cheap.
  for (let it = 0; it < 30; it++) {
    const mid = (lo + hi) / 2;
    const s = seedAt(mid, contestants, excludeIndex);
    // seed is a strictly decreasing function of r (higher rating → beats more people → lower expected rank).
    if (s < target) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Compute tied-adjusted rank for each contestant. Contestants with identical "points/penalty"
 * share the average rank of their group — CF ranking convention.
 *
 * `pointsKey` extracts the comparable score tuple. Higher is better for points, lower for penalty,
 * so we sort by a composite score the caller provides.
 */
export function assignTiedRanks<T>(
  items: T[],
  cmp: (a: T, b: T) => number, // negative if a ranks higher than b
): Map<T, number> {
  const sorted = [...items].sort(cmp);
  const ranks = new Map<T, number>();
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && cmp(sorted[i], sorted[j]) === 0) j++;
    // group [i, j) — average rank is ((i+1) + j) / 2 (1-indexed)
    const avg = ((i + 1) + j) / 2;
    for (let k = i; k < j; k++) ranks.set(sorted[k], avg);
    i = j;
  }
  return ranks;
}

/**
 * Compute predicted rating deltas for the given rated contestants.
 * The input must already be filtered to *rated* contestants with a rating (≥ 1) and
 * their actual (tied-adjusted) rank filled in.
 */
export function predict(contestants: Contestant[]): Prediction[] {
  const n = contestants.length;
  const predictions: Prediction[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const seed = seedAt(contestants[i].rating, contestants, i);
    const midRank = Math.sqrt(seed * contestants[i].rank);
    const needed = ratingForSeed(midRank, contestants, i);
    const raw = (needed - contestants[i].rating) / 2;
    predictions[i] = {
      handle: contestants[i].handle,
      rating: contestants[i].rating,
      rank: contestants[i].rank,
      seed,
      delta: raw,
    };
  }

  applyCorrections(predictions);
  return predictions;
}
