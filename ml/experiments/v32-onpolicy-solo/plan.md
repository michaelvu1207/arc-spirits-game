# V32 on-policy solo improvement plan

Status: Fable-reviewed draft; concrete review changes below must be frozen in the machine-readable protocol before optimizer creation. This document is not an authorization to promote a checkpoint.

Required review: Claude Fable, high effort, 2026-07-14. Artifact: `ml/experiments/v32-onpolicy-solo/fable-review.md`. Incorporated changes: exact tempered-policy PPO audit; empirical row-supply audit and replacement of infeasible late-row quotas with normalized policy-loss weights; three rather than two replicates; eight generations with a manipulation-check-only extension to twelve; explicit reach-30 blend scaling and strategic mask; distinction between critic and policy-credit coefficients; held-out behavior-head calibration; exact policy freeze during critic warm-up; and an explicit finalist latency gate.

## Objective and decision context

Build a genuinely stronger Arc Spirits policy, starting with Michael's requested solo objective: reach 30 VP by round 30 (round 35 remains a secondary report). The immediate success threshold is at least 80% on fair, disjoint held-out solo games; the stretch goal is 95%+. A solo winner still cannot ship until multiplayer, exploitability, fairness, regression, latency, and live-human gates pass.

Current evidence constrains the next experiment:

- Frozen V23 reaches 30 by round 30 in about 52.5% of the 4,096-game V31 development block. V30 is a fidelity- and latency-valid entity-v2 reconstruction but not yet stronger (52.1%).
- V26's three-seed legacy-versus-lexicographic PPO comparison was null: +0.26 percentage points at generation 5, p=0.939, with worse VP and late-game pace.
- V31's offline terminal-credit arms were null; the best arm gained only +1.27 points versus its matched anchor and regressed post-round-15 pace.
- Earlier V18 reach-30 credit, V19 continuation, V20 width, V21 imitation, V22 macro features, and V23 option heads did not produce a repeatable final improvement.
- V27's d64/d128/d256 screen showed no monotonic strength benefit from size. Width is not the first V32 lever.

Therefore V32 changes the data distribution and uses truly on-policy actions. It does not relabel another frozen V23 dataset, repeat lexicographic-only reward shaping, or claim strength from training loss.

## Phase 0: fail-closed infrastructure

Before consuming a V32 training seed:

1. Add an optional explicit league seed schedule with independent train and quick-evaluation bases/strides, while preserving historical defaults when omitted. Validate safe integers, per-generation non-overlap, and a configured maximum generation. This prevents the current million-stride default from colliding with V30's used 947/948 blocks.
2. Add generic decision-round retention to the PPO trajectory buffer and optional normalized policy-loss weights by round band. All arms still draw the same fixed number of post-GAE rows without replacement. The treatment multiplies the clipped policy surrogate, entropy, and per-generation reference KL by fixed round weights, normalized to mean one over selected exact-policy rows; value and reach-30 critic losses stay uniformly weighted. Report both weighted and unweighted KL/clip/entropy plus per-band counts and KL. Existing V30 rows show that a 45% late-row quota was infeasible without replacement: in two representative shards, only 8,290 of 38,834 exact-policy rows (21.35%) were from rounds 21-30. Weighting avoids an availability-dependent failure or duplicate-row confound.
3. Add tests for exact row counts, reproducibility, normalized weights, control-path numerical parity at unit weights, per-band loss/diagnostic math, missing/invalid rounds, seed scheduling, exact temperature reconstruction, potential-shaping telescoping at gamma 0.999, and v2 round-trip behavior.
4. Add a V32 generation auditor that rejects a generation before continuation on: wrong catalog/checkpoint/seed set, malformed or truncated episodes, stalls, non-finite weights or metrics, optimizer-step mismatch, approximate KL above 0.02, clip fraction above 0.20, pre-update behavior-head ECE above 0.10 after the shared warm-up, or missing phase/round telemetry. Preserve all failed artifacts. Calibration is computed from the current checkpoint's recorded `reach30Pred` and later resolved outcome on the newly generated generation before that generation's optimizer runs; it is not measured on rows after the head has trained on them.
5. All actor/evaluation scratch, sockets, and temporary files live under an experiment-owned `/dev/shm` directory. Require at least 16 GiB free there and 8 GiB on `/data/share8`; compress completed immutable JSONL after every consumer finishes. Never use root-backed `/tmp` for bulk work.
6. Freeze source commit, catalog SHA, V30 checkpoint and manifest SHAs, all configs, launcher/analyzer hashes, seed allocations, GPU assignments, and the Fable review before optimizer creation.

## Phase 1: systems benchmark (not model selection)

Use a diagnostic-only seed range beginning at 951,900,000. On one currently idle A100, serve the exact V30 checkpoint through the production binary inference path and sweep actor workers 4/8/12/16/24 with two repeated 128-game solo trials in deterministic shuffled order. Measure games/s, valid policy rows/s, inference batch sizes, GPU utilization/memory, CPU load, and p50/p95 game time. Choose the smallest worker count within 5% of peak valid-policy-row throughput. This systems diagnostic never enters training, selection, or strength evaluation.

Run every learner at `nice 10`, pin one visible A100 per root, and coexist with unrelated processes. Do not use or interrupt a heavily loaded GPU. Recheck GPUs, CPU, `/data/share8`, `/dev/shm`, process trees, and logs before and after launch.

## Phase 2: shared v2 critic warm-up

V30 has trustworthy policy behavior but no calibrated on-policy reach-30 head. Generate 4,096 fresh V30 solo games on seeds 946,000,000 through 946,004,095, with the pinned live catalog, shuffled/absolute-balanced guardians, one seat, status cap 2, maximum round 30, hybrid sampling at temperature 0.55, obs-v2 policy inference, and zero stalls.

Train one shared checkpoint with the entity trunk and every policy-scoring parameter frozen: update only the ordinary value head and newly enabled equal-game multi-horizon reach-30 heads for horizons 20/25/30. Policy coefficient and entropy coefficient are zero. Use a fixed epoch/update budget and no early stopping. Evaluate calibration once on disjoint seeds 946,004,096 through 946,005,119. Require finite weights, round-30 AUC at least 0.70, Brier no worse than the constant-rate baseline, ECE at most 0.10, and maximum absolute policy-logit difference versus V30 at most 1e-6 on every validation row. If policy parity or calibration fails, repair/reject the warm-up before any treatment.

Every V32 arm and replicate starts from the same hash-verified shared checkpoint. The critic warm-up is not a gameplay-strength claim.

## Phase 3: matched on-policy mechanism screen

Run three arms across three independent matched replicates (nine roots), initially eight generations each. Within a replicate, all arms use the same guardian/game seeds, rollout count, trainer seeds, starting checkpoint, architecture, optimizer steps, decode, and evaluation seeds. Policies generate their own current-generation actions, so row identity is not expected after generation 1.

Shared settings:

- entity-v2 d128/l3/h4 initialized from the shared critic checkpoint;
- 1,024 full natural solo games per generation, maximum round 30, status cap 2;
- hybrid sampling at temperature 0.55 for training and production-aligned evaluation. PPO explicitly optimizes this tempered policy: every row stores the exact filtered support, temperature, and acting log-probability; the learner recomputes `softmax(logits / 0.55)` on that same support. Pre-update chosen-log-probability reconstruction error must be at most 1e-3 and initial PPO importance ratios must be one within numerical tolerance;
- resolved terminal handling (cap failures are terminal, while dense VP and policy-invariant build-potential rewards remain);
- gamma 0.999, GAE lambda 0.95, no strategic full-return blend;
- two PPO epochs, batch 512, exactly 100,000 post-GAE rows per epoch;
- learning rate 0.00005 with cosine decay, clip epsilon 0.10, value clipping 0.10, entropy coefficient 0.003, KL-to-generation-start coefficient 0.05, max gradient norm 1;
- value coefficient 0.5 and multi-horizon reach-30 critic-loss coefficient 1.0 in every arm, including the control. This coefficient trains probability heads; it is distinct from `solo_reach30_coef`, which changes the policy advantage and is zero in the control;
- true-win bonus 4, no tempo decay in this mechanism screen;
- no continuation forks, imitation replay, search, promotion, distillation, or multiplayer data.

Arms:

1. `control-uniform`: uniform fixed-row PPO sampling and `solo_reach30_coef=0`.
2. `round-reweighted`: identical rows and objective, with policy-loss weights 0.5/1.0/2.0 for rounds 1-8/9-18/19-30, normalized to mean one each epoch. On the audited V30 sample this shifts effective policy mass from approximately 35%/37%/27% to approximately 16%/35%/50% without replacement or extra optimizer steps. This tests whether late-game decisions are underweighted.
3. `p30-credit025`: uniform rows, but blend 25% toward `reach30Target - behaviorReach30Probability` on engine-cycle strategic decisions. The strategic mask means any decision state containing navigation, location interaction, spirit spawn/absorb/awaken/discard/augment, combat/PvP, monster reward, conversion, or yield candidates; it is defined by the frozen `engine-cycle` command set in `driver.ts`. The dense GAE component and probability-residual component are each centered and standardized over eligible strategic rows before the 75/25 blend, then the resulting strategic advantages are normalized for PPO. Report both pre-standardization standard deviations and applied-row counts. Because every rollout is generated by the current calibrated policy, this is on-policy state-dependent long-horizon credit rather than V31's frozen offline correction.

Replicate A uses training seeds beginning 946,100,000; replicate B begins 946,200,000; replicate C begins 946,300,000. Use compact explicit per-generation strides and reserve non-overlapping quick-eval/calibration subranges beginning 946,700,000. Exact endpoints through the maximum twelve generations are written into the frozen machine-readable protocol. No V32 run may touch V27-V31 seeds 941-945, V30 seeds 947-948, or the unopened V31 hidden block at 945,000,000.

Run one generation at a time. The auditor must pass before the chain advances. A root that fails an integrity/trust gate stops; a safe environment-only failure may resume the same generation with unchanged seeds and checkpoint. Never replace just one paired arm's game seeds.

The screen includes a non-outcome manipulation check on the frozen critic-validation states. At generation 8, report cumulative KL from V30 overall and by round band. A treatment must have mean cumulative KL at least 0.005 in at least two replicates; `round-reweighted` must also have a late-to-early KL ratio at least 1.25 times its matched control, while `p30-credit025` must show positive covariance between the standardized reach-30 residual and chosen-action log-probability change on strategic rows. If a treatment misses only its movement check while every trust gate passes, its result is `inconclusive-underdosed`, not negative, and all three arms in all replicates continue unchanged on preregistered fresh seeds through generation 12. No outcome metric may trigger this extension. Generation 12 then becomes the sole eligible endpoint. If the manipulation check still fails, reject the implementation/dose rather than the mechanism.

## Phase 4: frozen development decision

The final preregistered generation (8, or 12 only under the manipulation rule) of each root is the only checkpoint eligible for the causal screen; intermediate curves are descriptive and cannot be used to choose epochs. Freeze all nine final checkpoints and hashes before opening development seeds beginning 949,000,000.

Evaluate V23, V30, shared critic-only, and all nine final checkpoints on the same 4,096 solo games with production binary inference where applicable, hybrid sampling at temperature 0.55, balanced guardians, per-game output, and zero stalls. Aggregate each treatment against its matched control within replicate, then combine the three replicate effects with equal replicate weight. Apply simultaneous confidence intervals across the two treatment families.

A mechanism advances only if all are true:

- mean causal win-rate gain versus matched controls is at least +3.0 percentage points;
- the multiplicity-adjusted paired lower confidence bound is above zero;
- at least two of three replicate point estimates are positive and none is worse than -1 point;
- win rate versus V23 is at least +3.0 points with a positive paired lower bound;
- mean final VP and post-round-15 VP/round do not regress, and censored finish round does not increase;
- no guardian has a regression larger than 5 points without an explicit follow-up;
- all integrity, zero-stall, calibration, and trust gates pass.

If neither treatment passes, reject both and use the complete telemetry to choose one genuinely new next mechanism; do not sweep these coefficients on the development block. If one passes, freeze it. If both pass, select the higher paired win rate; a difference under one point is a tie, favoring `round-reweighted` because it does not depend on critic calibration. Before hidden confirmation, re-run the V30 binary-wire latency protocol on the sole frozen winner (32 rows/request, 30 candidates/row, eight clients) and require p95 at most 100 ms; failure rejects the candidate.

## Phase 5: composition, search, and capacity

Only after a causal V32 mechanism passes:

1. Confirm the frozen winner once on a new hidden solo block beginning 950,000,000. Require at least +3 points over its matched control and V23, positive paired 95% bounds, zero stalls, and no late-game regression.
2. If both mechanisms passed development, preregister a fresh-seed composition (`round-balanced + p30-credit025`) versus the winning single mechanism. Never infer additivity from the first screen.
3. Add fair inference-time search as a separate factorial experiment, initially only on strategic navigation/engine decisions. Compare raw policy versus fixed-budget search on identical states and report latency. Search must use only public/current information plus public deterministic monster stats/rewards; hidden random drops and future private randomness remain unavailable.
4. Revisit model size only after a policy-learning or search mechanism has demonstrated strength. Compare d128 and a function-preserving d256 expansion at matched environment games and optimizer FLOPs. Width advances only with a positive strength bound and p95 request latency below 100 ms.
5. Continue solo training on fresh seeds until the frozen policy reaches at least 80% fair held-out wins by round 30 (stretch 95%+). Report round-35 success separately; do not substitute it for the round-30 goal.

## Phase 6: superhuman and deployment gates

A solo-qualified checkpoint enters, in order:

- fixed held-out two-, three-, and four-player gauntlets against champion snapshots, main exploiters, league exploiters, and strong heuristics;
- adversarial exploitability and corruption/Fallen recovery suites, including free-summon/pass progression and late-game engine behavior;
- hidden-information/future-public-information audit, catalog/rules regression, deterministic replay, zero-stall soak, and production binary latency/load tests;
- disjoint replay comparison against Michael's referenced games and then fair live head-to-head games with seat/guardian/seed balancing.

Production promotion is allowed only if the candidate clears every gate, materially exceeds the current valid multiplayer Elo, and demonstrates superiority to Michael. Until then V30/current production remains unchanged.

## Stop and preservation rules

- No result from training loss, critic AUC, quick eval, or search rollouts alone is a strength claim.
- Development and hidden blocks are never training data.
- Never open a hidden block without exactly one frozen development winner.
- Never promote on a solo-only result.
- Preserve unrelated processes and artifacts; preserve failed attempts with exit codes, logs, hashes, and whether any game seed was consumed.
- Keep the active superhuman-bot goal open until the full objective is verified.
