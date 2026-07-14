# Claude Fable re-review of the V34 Lane B amendment

Model: Claude Fable
Effort: high
Date: 2026-07-14
Status: second-round findings incorporated; final Fable validation passed.

Fable confirmed that all twelve first-review findings were incorporated and found no information leak,
seed-range collision, PCG64 collision, or batch-arithmetic error. It then identified four remaining issues:

1. Teacher audit rows share source-game trajectory prefixes, so B2 must cluster its bootstrap and standard
   error by complete source game rather than treating rows as independent.
2. A 10,000-game three-player stage cannot be exactly balanced across three seats and four opponent
   strata; the count needs to be divisible by twelve.
3. B3 must pin its per-generation/per-epoch/per-stream permutation seeds, and the width handoff must define
   the anchor traversal after three complete 25,000-row passes.
4. Each width replicate needs disjoint, explicit teacher-source and PPO-behavior ranges; one 4,096-game
   range cannot ambiguously stand for both 100,000-row streams.

The plan now uses a complete-source-game cluster bootstrap and cluster-robust SE, 9,996 exactly balanced
three-player games, a closed-form PCG64 permutation seed rule plus an exact handoff anchor traversal, and
three explicit disjoint 959 teacher/PPO range pairs. A final Fable validation is required before tooling
implementation or authorization.
