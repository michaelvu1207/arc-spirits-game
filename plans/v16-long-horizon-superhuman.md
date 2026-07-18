# Arc Spirits v16 Long-Horizon Training Plan

## Objective and non-negotiable gates

Build a learned production bot that completes the full build-convert-finish cycle, beats the
current v15-1 champion by a large margin, and ultimately beats Michael in live play. The requested
stretch target is at least 3x the current v15-1 gauntlet-v10 Elo (476 -> 1428) on the same frozen
scale. Elo has an arbitrary zero, so “3x” is not by itself a meaningful strength ratio. Preserve it
as the requested frozen-scale stretch target, but also require at least 90% pairwise score against
v15-1 (roughly a +382 Elo head-to-head gap). Because an anchor scale can saturate or be distorted by
weak opponents, neither number is sufficient: no checkpoint promotes without the fairness,
held-out, completion, exploitability, and human gates below.

Promotion requires all of:

1. Hidden-seed invariance, exact PPO behavior ratios, complete trajectories, engine tests, and ML
   smoke tests pass.
2. The candidate reaches 30 VP reliably in mixed held-out fields and improves the 15->30 conversion
   rate, late-game VP/round, and productive-action rate over v15-1.
3. The candidate clears the same frozen gauntlet, historical neural field, champion duel,
   collusion, and heuristic-field gates without training on held-out seeds, then survives a fresh
   fixed-budget exploiter trained specifically against the frozen candidate.
4. The candidate is not promoted solely because an anchor suite saturates; a harder recalibrated
   suite must preserve ordering if the original suite loses resolution.
5. Michael's live match set shows the bot can beat him. Use at least 20 four-player games with one
   adapting Michael and three frozen copies/variants of the candidate, rotating seats and guardians.
   The primary null is the bot population's expected 75% aggregate win share (25% per equal seat);
   report exact multinomial/binomial intervals and continue sequentially if the first 20 games are
   inconclusive. Michael may adapt between games: robustness to learned exploitation is the point.

## Evidence-driven implementation sequence

### 1. Fix strategic credit assignment without destabilizing tactical PPO

- Record a `strategic` mask. The first controlled ablation marks navigation only—the clean
  round-level strategy skeleton. Expand to encounter, combat commitment, summon/awaken/cultivate,
  and optional engine-spending decisions only after the navigation pilot has a positive verdict.
- In the PPO loader, calculate both ordinary GAE and full-episode Monte Carlo returns.
- Add a configurable strategic Monte Carlo blend. Tactical rows keep ordinary GAE; strategic rows
  blend their advantage/value target toward the complete-game return, so a navigation/build choice
  receives the final placement/win consequence directly instead of losing it through
  `(gamma * lambda)^N`.
- Keep the default coefficient at zero for backward compatibility. Unit-test terminal propagation,
  truncated episodes, policy masks, and coefficient-zero bit parity.
- For the first v16 lane, disable late-win bonus decay. Restore a tempo incentive only after true
  completion is reliable.

### 2. Force training to contain the game phase that production exposes

- Train a deterministic mixed player-count curriculum instead of a one-way 1->2->3->4 sequence
  that would forget earlier skills. Generations 1-5 are 50% solo; generations 6-12 are balanced;
  generation 13 onward is 62.5% four-player while retaining 12.5% each of solo, two-, and
  three-player games. Ranked evaluation and every promotion gate remain four-player only.
- Solo episodes use no placement reward or placement-head target because a lone bot is always
  first by definition. They learn from actual VP progress and true 30-VP finishes, with a
  solo-only full-episode Monte Carlo blend on engine-cycle decisions. Cap solo corruption below
  Fallen so a one-seat all-Fallen ending cannot replace learning the build-convert-finish cycle.
- Seat a verified non-Fallen termination blocker in a randomized portion of training matchups so
  all-neural collapse cannot erase the late game, while retaining no-blocker games so the learner
  cannot free-ride. Evaluate blocker and no-blocker completion separately.
- Use strong engine builders and the current champion/exploiter population, not only mirrors.
- Add a deterministic late-game evaluation slice and, after snapshot reconstruction is reliable, a
  curriculum that starts from valid rounds 8/12/16/20 states. Seed the first slice from diverse
  historical, heuristic-builder, and human games, then refresh part of it from recent candidate
  self-play. Never hand-edit invalid states.
- Track individual Fallen collapse even when another player keeps the game alive; all-Fallen loss is
  not enough.

### 3. Measure the actual economic cycle

- Extend game/eval summaries with VP at rounds 8/12/16/20, first-15 round, first-30 round,
  15->30 conversion, post-15 VP/round, productive decisions, no-op/pass rate, combat/reward/summon
  counts, retained engine strength, max-round rate, and stall rate. These are evaluation gates only;
  do not add them directly to the reward.
- Add regression scenarios based on LGXJ5D: free summon while Fallen, late-game Telecove pass loops,
  and a human-like engine builder who remains active.
- Promotion scripts must compare these metrics against v15-1, not only aggregate Elo.

### 4. Run controlled experiments before expanding architecture

- Locally run engine, PPO, generation, training, and eval smoke gates.
- On SimForge, run matched seeds for v15 objective vs strategic-MC + blocker + flat win bonus.
- Start with a small coefficient sweep (0.25/0.5/0.75) and GAE lambda sweep (0.95/0.98), using equal
  environment steps and wall-clock reporting. Do not set lambda=1 blindly.
- Normalize and report strategic and tactical advantages separately; report value explained
  variance for both groups so noisy full-game credit cannot hide inside a global mean.
- Use two-of-three seeds only as a screen. Final promotion requires a pooled held-out effect across
  expanded evaluation seeds with a confidence interval above v15-1 on both strength and completion.
- Stage 1 uses local + remote smoke only. Stage 2 runs three matched 20-generation pilot pairs and
  aborts coefficients that regress completion or produce unstable KL/value diagnostics. Stage 3
  extends only the best recipe to 80 generations across three seeds. If every pilot is negative,
  stop the sweep and move to the round-option/data redesign rather than spending all 18 long runs.

### 5. Escalate only after the objective/data experiment has a verdict

- The first outcome-credit pilots were seed-unstable and did not clear promotion. Before the next
  matched runs, expand v1 from 83 to 188 observations: preserve the frozen prefix and append the
  complete active/dormant 37-class and 8-origin engine, initiative/combat resources, held-material
  composition, horizon/score pace, and public co-located threat state. Zero-expand the 500-Elo
  warm start so all old outputs are exactly preserved until the new columns train.
- If strategic credit improves conversion but plateaus on representation, reopen the v2 entity
  model with a named failure and train it directly (d64/l2 then d128/l3).
- If the learned value becomes accurate enough, re-benchmark full-seat search. Existing Gumbel
  search stays off in production until it beats raw policy; prior tests showed rollout/Q noise made
  it weaker.
- Add a round-level option policy (`build`, `stabilize`, `convert`, `hunt/block`) only after the
  strategic-MC data contract proves which states and actions need option labels. Options must be
  learned/search-improved, not a permanent hand-coded strategy.
- Sweep width/model size after representation and targets are corrected; a larger flat MLP cannot
  recover omitted information or missing credit.
- If the original gauntlet exceeds 95% pairwise score and loses resolution, trigger a harder frozen
  suite built from v15-1, v14b, the strongest v2 candidate, new builder/conversion policies, and the
  fresh exploiter. Require rank ordering over a historical checkpoint panel to retain positive
  Spearman correlation with the original suite while separating the finalists.

## Artifact and operational rules

- Preserve the six ongoing v15 paired seeds and unrelated SimForge processes.
- Every long run has an immutable config, source commit, catalog hash, seed range, logs, state,
  checkpoints, and evaluation manifests.
- Use free A100 capacity alongside existing workloads; do not evict unrelated jobs.
- Keep v15-1 deployed until a candidate clears every gate.
