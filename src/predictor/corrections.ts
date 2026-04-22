import type { Prediction } from './elo';

/**
 * CF's two delta corrections, applied to the raw per-contestant deltas in place.
 *
 * Step 1 — "sum correction": shift every delta by the same integer `inc` so that
 *   Σ delta_i ≈ 0  (strictly: Σ delta_i becomes in the range (-n, 0], because rating
 *   should conserve except for tiny lost fractions). The adjustment is:
 *       inc = clamp(floor(-sumDelta / n) - 1, min=-n)   // at most a single-unit overshoot
 *   then every delta += inc.
 *
 * Step 2 — "top-seeded correction": take the top s = min(n, floor(4·sqrt(n))) contestants
 *   *by pre-contest rating* (highest rating first). Their summed delta should be 0 (no
 *   inflation at the top). Compute the average required shift and clamp to [-inc..0]:
 *       inc2 = clamp(floor(-sumTop / s), min=-inc, max=0)
 *   then every contestant's delta += inc2. Clamping keeps things from running away.
 *
 * Reference: Carrot's `predict.js` implements the exact same two-step scheme, which matches
 * CF production within ±1.
 */
export function applyCorrections(preds: Prediction[]): void {
  const n = preds.length;
  if (n === 0) return;

  // Step 1
  const sumAll = preds.reduce((s, p) => s + p.delta, 0);
  const inc1 = Math.min(0, Math.floor(-sumAll / n) - 1);
  for (const p of preds) p.delta += inc1;

  // Step 2 — sort a shallow copy by rating desc
  const byRatingDesc = [...preds].sort((a, b) => b.rating - a.rating);
  const s = Math.min(n, Math.floor(4 * Math.sqrt(n)));
  let sumTop = 0;
  for (let i = 0; i < s; i++) sumTop += byRatingDesc[i].delta;
  const inc2 = Math.min(0, Math.max(Math.floor(-sumTop / s), -inc1));
  for (const p of preds) p.delta += inc2;

  // Round to nearest integer — CF reports integer deltas.
  for (const p of preds) p.delta = Math.round(p.delta);
}
