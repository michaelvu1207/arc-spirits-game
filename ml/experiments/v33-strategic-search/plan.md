# V33 strategic-search and expert-iteration plan

Status: Claude Fable high-effort review incorporated. Nothing in this file opens
a strength seed or authorizes production promotion. Review artifact:
`fable-review.md`.

## Objective and pivot evidence

The objective remains a genuinely superhuman Arc Spirits bot: at least 80%
fair, disjoint solo wins by round 30 (stretch 95%+), then superiority to the
current bot and Michael in balanced multiplayer play. Solo evidence alone can
never promote a checkpoint.

V32 is closed as invalid. Replicate-C `round-reweighted` generation 1 produced
round-weighted PPO clip fraction 0.201, above the frozen 0.200 trust ceiling.
That semantic trust failure is not retryable. All V32 processes were stopped,
and no V32 development or hidden seed was opened. Across the valid V32 audits,
the maximum round-weighted clip fraction was 0.192 for round reweighting, 0.159
for control, and 0.152 for P30 credit. The single complete replicate-A endpoint
was only descriptively +2.34 win-rate points for round weighting and -1.56
points for P30 credit versus control; those outcomes are not causal decisions.

Repeated reward, width, offline-credit, imitation, and one-step PPO variants
have not moved the bot close to 80%. V33 therefore tests the missing capability
directly: multi-round lookahead at the small set of strategic decisions. It
does not weaken V32's trust gate or rerun a coefficient sweep.

## Frozen common inputs

- Catalog: `ml/catalogs/live-20260713-5f4ad348.json`, SHA-256
  `5f4ad348f6c7add612c736df0f3e00b7d4c821758e0561049f2e550e798c6e2e`.
- Policy/value checkpoint: V32 shared critic, SHA-256
  `aeb254c20367029696da1e6ca823b96187191140056d646a7c2d3d47ec4e567b`.
  Its action logits are exactly identical to V30 on all 119,279 validation
  rows; its round-30 head has AUC 0.8971, ECE 0.0253, and Brier 0.1309.
- Production binary obs-v2 inference, hybrid action selection, temperature
  0.55 outside searched decisions, absolute-balanced guardians, one player,
  status cap 2, and round cap 30.
- Search is allowed only at navigation and encounter decisions with at least
  two legal actions. Every nonsearched decision stays on the frozen policy.
- Search may use current public state, public deterministic monster stats and
  rewards, and newly sampled determinizations. It may not condition on secret
  opponent locks, future private draws, random spirit drops, or a dry-run's
  already-realized hidden outcome. Existing information-safety tests remain
  mandatory and will be expanded with deterministic replay tests for every
  V33 search configuration.

The exact search evaluator is the real game engine, not an approximate model.
Each simulation creates one fresh information-set determinization and advances
it through legal engine commands; the total 16/32 budget is shared across root
candidates by Gumbel sequential halving, so there is exactly one determinization
per simulated candidate visit. A hidden-outcome root is not advanced through a
dry-run's realization: it is valued from the masked public preview plus only an
explicit public expectation term where one exists.

V33 adds an explicit `solo-reach30` leaf objective. At an active horizon state,
`v_net` is the checkpoint's calibrated round-30 reach probability (the run fails
if the head is absent or has another horizon), and `v_rollout` is
`clamp(currentVP / 30, 0, 1)`. The leaf is
`0.5 * v_net + 0.5 * v_rollout`; any state already at 30 VP is exactly 1 and a
terminal state below 30 VP is exactly 0. This replaces the current multiplayer
placement/VP blend, whose solo placement term is ill-defined. At a masked
public combat root, only `v_rollout` uses
`clamp((currentVP + expectedPublicRewardVP) / 30, 0, 1)`; the reach head never
receives a sampled or otherwise hidden combat result. Unit tests
freeze all terminal, active, hidden-root, and horizon cases.

## Phase 0: immutable closeout and implementation freeze

1. Freeze the V32 invalidation artifact and the failed root's config, state,
   history, checkpoint, manifest, train log, and orchestrator log hashes.
2. Add a V33 machine-readable protocol, source lock, launcher, report validator,
   paired analyzer, latency recorder, and tests before any 952M strength seed.
3. Require exact checkpoint/catalog/source hashes, exact seed coverage, balanced
   guardians, zero stalls, binary inference, and immutable reports. A valid weak
   result, stall, integrity failure, or second infrastructure failure is never
   rerunnable. One pre-report environment-only failure may receive one documented
   identical-seed retry after its partial evidence is quarantined without outcome
   inspection.
4. Use `/dev/shm/arc-v33-search` for scratch, `nice 10`, no more than 96 actor
   threads, and only GPUs 5/6/7/0 when available. GPU 4 and unrelated workloads
   are excluded.

## Phase 1: outcome-blind systems screen

On diagnostic seeds 953,900,000-953,900,255, benchmark but do not inspect game
strength for:

1. raw policy;
2. Gumbel root search with 16 simulations and four-round horizon;
3. 16 simulations and six-round horizon;
4. 32 simulations and six-round horizon.

Search uses full search fraction, policy self-model rollouts, the frozen
`solo-reach30` leaf above, navigation temperature 0 in solo, and encounter
argmax. Sweep 4/8/12/16/24 workers per configuration. Record games/s, policy
requests, batch sizes, GPU memory/utilization, CPU load, per-decision p50/p95,
and errors. Pick the smallest worker count within 5% of each configuration's
peak throughput. Because this outcome-blind screen also measures the already
frozen binding 1-second single-concurrency and 2-second eight-concurrency
decision-latency gates, reject a dose before phase 2 when either latency gate
fails; spending 4,096 strength seeds cannot repair an operational failure. This
phase may otherwise reject an operationally impossible dose only for errors,
memory exhaustion, or projected wall time over six hours for 4,096 games, never
for wins, VP, guardians, or round outcomes. Freeze the exact eligible dose set
before phase 2.

The determinization test draws at least 100,000 engine outcomes from a frozen
public state and requires every categorical hidden outcome's empirical frequency
to fall inside a simultaneous 99% multinomial confidence envelope around the
engine distribution. A separate replay test proves identical state, game seed,
seat, round, and monotonically increasing per-game search invocation ordinal
produce identical visits/action, and that two invocations in one round never
reuse a random stream.

## Phase 2: paired search-dose development screen

Evaluate raw policy and every operationally eligible registered dose on exactly
seeds 952,000,000-952,004,095. Use identical seed/guardian assignments
and the common decode contract. Search randomness is a deterministic function
of game seed, round, and decision index.

For each search dose versus raw, report paired deltas for true win, final VP,
post-round-15 VP/round, and censored first-30 round (failures equal 31), plus
guardian deltas and end-to-end latency. Bootstrap complete game-seed clusters
with 10,000 deterministic draws. Use simultaneous 98.33% two-sided intervals
for the family of up to three dose-versus-raw contrasts; if a systems rejection
reduces the family, retain the predeclared family size of three.

A dose is eligible only if:

- paired win gain is at least +3 points and its simultaneous lower bound is
  above zero;
- final VP and post-round-15 pace do not regress, censored finish round does not
  increase, and no guardian regresses by more than 5 points after one frozen
  8,192-game guardian-only confirmation if needed;
- there are zero stalls, information-safety failures, replay mismatches, serving
  errors, or provenance mismatches; and
- p95 searched-decision latency is at most 1 second at one concurrent game and
  at most 2 seconds under eight concurrent games, with zero timeout/error; p95
  full-game wall time is also recorded. These are the binding production budgets
  and cannot be tightened or relaxed after dose outcomes are visible.

A guardian confirmation is triggered only when every non-guardian gate passes
but at least one aggregate guardian point delta is below -5 points. Run all
frozen phase-2 arms once on exactly 8,192 new seeds, pool only guardian deltas
from the original and confirmation blocks, and leave every other metric and the
dose-selection win rate unchanged. No second confirmation is allowed.

If multiple doses qualify, select the highest paired win rate; differences under
one point choose the lower simulation budget. The selected dose and raw policy
are frozen before phase 3. If none qualifies, search is rejected as an inference
mechanism and V33 proceeds directly to the training redesign in phase 4 using no
phase-2 seed as training data.

## Phase 3: fixed-dose solo qualification

Evaluate exactly three policies on seeds 952,100,000-952,104,095:

- the frozen selected search dose;
- the identical raw shared-critic policy; and
- frozen V23.

Use one family of two paired contrasts and 97.5% two-sided bootstrap intervals
with 10,000 complete-seed draws. The search candidate advances only with at
least +3 points and a positive lower bound versus both comparators, no late-game
or guardian regression, zero stalls, and an absolute round-30 win rate of at
least 80%. Then run the binding production-load and decision-latency gate.

Only after passing those gates open hidden seeds 952,200,000-952,204,095 and
repeat the exact three-policy confirmation with the same thresholds. A hidden
failure rejects the candidate and cannot reopen dose selection. Round-35 success
is descriptive and cannot substitute for the round-30 objective.

## Phase 4: search expert iteration if raw search is insufficient

If search is directionally useful but misses the absolute 80% or latency gate,
use it as a teacher rather than deploy it:

1. Implement obs-v2 Gumbel expert iteration that records the full visit
   distribution only at navigation/encounter decisions, while retaining exact
   on-policy action/log-probability rows elsewhere. Search targets use fresh
   training-only seeds and never use 952M development/hidden games.
2. Train the policy head toward the search-improved distribution at strategic
   nodes and train value/reach-30 heads from resolved outcomes. Freeze the entity
   encoder initially; unfreeze only in a separately preregistered stage if
   policy-only distillation saturates. Do not combine PPO and search-target
   gradients until a unit test proves loss masks, scales, and behavior support.
3. Use exactly three expert-iteration generations in each of three matched
   replicates. Generation 1 searches with the frozen shared critic; generations
   2 and 3 search with the immediately preceding checkpoint for that replicate.
   There is no outcome-driven early stop or epoch selection. Each generation
   consumes 4,096 games from these training-only blocks:
   replicate A 954,000,000 + `(generation - 1) * 10,000`, replicate B 954,100,000 +
   that stride, and replicate C 954,200,000 + that stride. The recorded target
   is the completed-Q improved root distribution over every legal candidate;
   it is accepted only with finite entries, exact candidate alignment, at least
   two candidates, and visit counts summing to the frozen simulation budget.
   Distillation target temperature is 1.0.
4. Use a globally
   safer learning rate of 0.00004, keep clip/KL ceilings at 0.20/0.02, and audit
   each generation before continuation. Never lower a gate after seeing a run.
5. Before generation, use phase-1 throughput to freeze projected GPU-hours and
   fail closed if the complete teacher corpus cannot fit the declared resource
   budget. Preserve per-decision simulation counts and wall time.
6. At the fixed generation-3 endpoint, compare equal-replicate distilled policy,
   raw policy, original teacher search, and online search using the new distilled
   value/reach-30 heads on disjoint seeds 955,000,000-955,004,095. A distilled
   model must retain the teacher's late-game gain
   within 2 points, improve raw by at least 3 points with a positive lower bound,
   and meet binary p95 inference under 100 ms. If it cannot, keep search online
   or redesign the value/search target; do not promote a lossy distillation.
   The new-value online-search arm explicitly tests the distribution-shift
   confound: a phase-2 null does not falsify search with a search-trained value.
7. If both raw search and first distillation remain far below 80%, expand search
   from navigation/encounter to the other engine-cycle decisions using the real
   forward model and explicit hidden-outcome expectation nodes. This is a new
   frozen experiment, not an unregistered V33 patch.

## Phase 5: multiplayer and superhuman gates

A hidden-qualified solo bot still must pass fixed two-, three-, and four-player
champion/exploiter/heuristic gauntlets; adversarial exploitability; Fallen,
corruption, free-summon, reward/passing, and late-engine regression suites;
hidden-information and future-public-information audits; deterministic replay;
zero-stall soak; production load; and balanced live games against Michael. Search
uses navigation temperature 0.8 in multiplayer unless a separately frozen
mixed-strategy screen proves another value. Production promotion is forbidden
until every fairness, strength, regression, latency, and human gate passes.

## Stop and preservation rules

- Training loss, critic calibration, quick evaluation, or unadjusted dose wins
  are not strength claims.
- Never train on systems, development, hidden, or Michael-evaluation seeds.
- Never select a checkpoint, dose, horizon, rollout type, or epoch on hidden
  outcomes.
- A phase-2 null rejects only the frozen search/value configuration, not search
  with a value function trained on search-induced states.
- Preserve failures and unrelated artifacts/processes. Stop only experiment-owned
  work after a semantic gate failure.
- Keep the superhuman-bot goal active until the complete objective is verified.
