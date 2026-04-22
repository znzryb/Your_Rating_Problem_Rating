// Reverse-Elo: given the rating distribution of solvers/non-solvers, infer a problem's rating.
//
// Model: contestant i with rating R_i solves problem X with probability
//    P_i(R_X) = 1 / (1 + 10^((R_X - R_i) / 400))
// Expected solve count E(R_X) = Σ P_i(R_X). E is strictly decreasing in R_X (harder problem →
// fewer expected solvers), so binary-search R_X so that E(R_X) ≈ actualSolveCount.
//
// This is a much cruder model than CF's internal difficulty setter (which factors in time to
// solve, submission count etc.) but it's the standard first-order approximation and gives a
// sensible number for Gym / fresh / unrated problems where no official rating exists.

export interface SolveSample {
  rating: number;
  solved: boolean;
}

/**
 * Returns `null` if there aren't enough signal in the data (no rated contestants, or everyone /
 * nobody solved it — in those cases the answer is unbounded below/above). Otherwise returns
 * a rating rounded to the nearest 100, clamped to [800, 3500] (CF's published range).
 */
export function inferProblemRating(samples: SolveSample[]): number | null {
  const rated = samples.filter((s) => Number.isFinite(s.rating) && s.rating > 0);
  if (rated.length < 10) return null; // too few rated solvers to say anything

  const solved = rated.filter((s) => s.solved).length;
  if (solved === 0 || solved === rated.length) return null;

  const expectedSolves = (rx: number): number => {
    let e = 0;
    for (const s of rated) e += 1 / (1 + Math.pow(10, (rx - s.rating) / 400));
    return e;
  };

  let lo = 0;
  let hi = 5000;
  // 40 iterations → sub-1 rating precision, irrelevant for rounding to 100.
  for (let it = 0; it < 40; it++) {
    const mid = (lo + hi) / 2;
    if (expectedSolves(mid) < solved) hi = mid;
    else lo = mid;
  }
  const raw = (lo + hi) / 2;
  const rounded = Math.round(raw / 100) * 100;
  return Math.max(800, Math.min(3500, rounded));
}
