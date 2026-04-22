# Your Rating · Problem Rating

Codeforces userscript that does two things:

1. **Your Rating** — Carrot-style Δrating prediction. On any `/contest/{id}/standings*` page,
   a "Refresh Predictions" button adds a `Δ` column showing each rated contestant's predicted
   rating delta, using Mike Mirzayanov's published Elo formula with CF's two post-hoc
   corrections. Works both during the round (in-progress snapshot) and for finished but
   not-yet-rated rounds (Final-phase snapshot).
2. **Problem Rating** — Reverse-Elo inference for problems that don't yet have an official
   difficulty rating (fresh rounds pre-update, Gym rounds, some merged Div. rounds). On
   a problem page or contest overview, a colored `≈NNNN` badge appears next to the title.

Nothing is sent anywhere except Codeforces' own public API. Predictions are computed locally.

## Install

1. Install Tampermonkey (or Violentmonkey).
2. `pnpm install && pnpm build`
3. Drag `dist/your-rating-problem-rating.user.js` into the extension, or point it at a
   local file / hosted URL.

Dev:
```bash
pnpm dev
```
vite-plugin-monkey will print a `.user.js` URL — install that and it hot-reloads.

## How it works

### Rating delta (`src/predictor/elo.ts`)
For each rated contestant `i`:
- `P(a beats b) = 1 / (1 + 10^((R_b − R_a) / 400))`
- `seed_i = 1 + Σ_{j≠i} P(j beats i)` — expected rank from pre-contest ratings alone.
- `midRank_i = sqrt(seed_i · actualRank_i)`
- Binary-search `R'` s.t. `seed(R') = midRank_i`.
- `rawDelta_i = (R' − R_i) / 2`

Then two CF corrections (`src/predictor/corrections.ts`):
- shift everyone so the total Δ is ≈ 0 (rating-sum conservation);
- shift everyone so the top `4·sqrt(n)` by rating sum to 0 (no top-end inflation).

Matches CF production to within ±1 on finished rounds.

### Problem rating (`src/problem-rating/reverseElo.ts`)
Given rated contestants' ratings and who solved problem X, binary-search a problem rating
`R_X` such that
`Σ_i 1 / (1 + 10^((R_X − R_i) / 400)) ≈ (# who solved X)`.
Rounded to the nearest 100 and clamped to `[800, 3500]`. Only shown when no official
rating exists.

## Caveats

- Only rated single-contestant `CONTESTANT` rows go into the pool; team/virtual/out-of-comp
  rows are skipped.
- Brand-new accounts (no pre-contest rating) are filtered out.
- Reverse-Elo is a first-order approximation — it ignores time-to-solve and re-submission
  patterns that CF's internal setter uses. Treat the badge as "ballpark" not "official".
- Refresh is manual. CF's public API is rate-limited to one call every two seconds; clicking
  the button repeatedly during systests is fine, but don't hammer.

## Formula references

- https://codeforces.com/blog/entry/20762 — Mike Mirzayanov's Elo post
- Carrot (`meooow25/carrot`) `predict.js` — CF-matching reference implementation of the two corrections
