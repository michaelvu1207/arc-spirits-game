# V35 Phase 1: Long-Horizon V2 Training Screen

Status: proposed execution amendment; no training seed may be consumed until Fable high review passes.

Date: 2026-07-14

## Evidence and objective

The immutable V35 public evaluator measured the shared-critic entity-V2 checkpoint at 53.52% true
solo wins over 512 current-catalog seeds, versus 44.73% for the strongest completed V17 unrestricted
checkpoint. The paired late-game-score delta was +0.0609 with a +0.0307 bootstrap lower bound. On a
separate 256-seed suite, inference-time reranking at 0.75 regressed by 0.0125 and every sampled/search
configuration was worse. V17 h256, terminal-outcome coefficients, and additional generations all
failed to reach the 80% target. The next experiment therefore improves long-horizon policy credit on
the stronger V2 representation; it does not spend more compute on inference search or width.

The immediate objective is a valid mechanism screen, not promotion: determine whether late-round
policy weighting or calibrated reach-30 residual credit improves current-catalog round-15+ play over
matched on-policy PPO. The development gate is a +3 percentage-point solo gain with a positive paired
bound and no late-game, stall, fairness-contract, or latency regression. The 80% solo threshold and all
multiplayer/exploitability/human gates remain closed.

## Frozen inputs and isolation

- Base checkpoint: `ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt`, SHA-256
  `aeb254c20367029696da1e6ca823b96187191140056d646a7c2d3d47ec4e567b`.
- Current catalog: `ml/catalog.json`, SHA-256
  `62203ec1b981c2e59f129db54cf1863639f605f331ed8d7408c53693c941bc59`.
- Entity architecture: d128/l3/h4, 832,009 parameters, binary socket inference.
- Exactly physical GPU 7 under the V35 lease. GPUs 4-6 are forbidden. Every root runs sequentially.
- Training scratch is under `/dev/shm/arc-v35-training`; persistent roots hold configs, audit summaries,
  logs, and checkpoints only. Compressed rollout data is deleted after its audit and all consumers pass.
- Require at least 4 GiB `/data/share8`, 32 GiB `/dev/shm`, 64 GiB available RAM, and an empty GPU 7
  immediately before every generation. A controller trap releases the lease and server.
- The controller is local/private. SimForge receives frozen configs and performs trusted simulation and
  training only. No Weco or other hosted service is used.

## Matched screen

Run three arms across three scratch replicates. Within a replicate, all arms have identical starting
checkpoint, catalog, train/eval seeds, 1,024 games per generation, two epochs, 100,000 exact-policy rows
per epoch, batch 512, temperature 0.55, balanced guardians, one seat, round cap 30, and status cap 2.
The status-2 cap isolates the engine-building mechanism; every finalist is separately evaluated at both
status caps 2 and 3. No status-2 result may support production promotion.

Shared PPO settings are the V32 screen settings except learning rate is reduced from `5e-5` to `4e-5`
because the prior screen was invalidated when one round-weighted generation reached clip fraction 0.201
against the frozen 0.200 trust threshold. The threshold remains 0.200; it is not relaxed after seeing
that failure. Other shared settings remain clip 0.10, value clip 0.10, entropy 0.003, cosine schedule,
generation-start KL penalty 0.05, value coefficient 0.5, reach-30 head coefficient 1.0, gamma 0.999,
GAE lambda 0.95, win bonus 4, and all-Fallen penalty -3.

`reach30-value-coef=1.0` trains the probability heads in every arm; it is distinct from
`solo-reach30-coef`, which changes the policy advantage and is zero in arms 1-2. Before each update,
the current generation's resolved outcomes must give the pre-update round-30 head ECE <=0.10 and Brier
no worse than the constant-rate predictor. Arm 3 is invalid if this calibration gate fails.

Arms:

1. `control-uniform`: uniform policy loss and `solo_reach30_coef=0`.
2. `late-reweighted`: policy-loss bands `1-8:0.5`, `9-18:1.0`, `19-30:2.0`, normalized to mean one;
   `solo_reach30_coef=0`.
3. `p30-credit025`: uniform rows plus 25% calibrated reach-30 residual credit on engine-cycle strategic
decisions.

Every epoch selects exactly 100,000 post-GAE exact-policy rows uniformly without replacement using the
frozen trainer RNG; it does not stratify or oversample by round. For arm 2, fixed band weights are then
normalized once over those selected rows to mean one. The trainer reports ordinary and weighted KL,
clip fraction, and entropy from that same selected set. The trust gate applies separately to ordinary
and weighted clip fractions, both <=0.20. `engine-cycle` is the frozen command-type set already defined
by the V32 `strategicDecisionScope` implementation and hash manifest; no text/LLM classification is used.
P30 residual credit uses the pre-update calibrated round-30 head, centers and standardizes dense GAE and
probability-residual terms over eligible strategic rows, and mixes them 75/25 before final advantage
normalization. A clean null at this one registered 25% dose kills this mechanism for V35 Phase 1.

The first pass is one generation of all three replicate-A arms with identical seeds. It is a trust and
throughput smoke only. All three must pass exact behavior-ratio reconstruction, finite weights, zero
stalls, replay/seed coverage, optimizer-step count, KL <=0.02, ordinary and weighted clip <=0.20,
behavior-head ECE <=0.10, and the V35 GPU/disk/lease checks. A failure stops without an outcome-based
retry. A safe infrastructure failure can resume unchanged seeds/checkpoint only after an incident record.

After smoke passes, run all nine roots to generation 8. Extension to generation 12 is allowed only by the
pre-registered non-outcome manipulation rule: treatment cumulative KL below 0.005 in at least two
replicates, missing late/early KL-ratio movement for reweighting, or missing residual/log-probability
covariance for P30 credit. If either treatment triggers extension, all nine roots—including controls—run
unchanged to generation 12, which becomes the sole endpoint. Generation 8 is then ineligible. The global
extension decision is frozen before any public-strength evaluation; no win/VP curve may trigger it.

## Seeds and multiple selection

- Replicate A training starts at 966,100,000, B at 966,300,000, C at 966,500,000.
- Per-generation train stride is 2,048; each generation consumes exactly 1,024 contiguous seeds.
- Quick evaluation bases are 966,700,000, 966,820,000, and 966,940,000 with stride 8,192; each consumes
  exactly 256 seeds. A prelaunch inventory must prove every 966.1M-967.1M training/quick range and
  969,030,000-969,034,095 development range unused. Existing V35 public ranges stop at 969,020,511.
- Public powered development uses 969,030,000 for 4,096 common games after every generation-8/12
  endpoint is frozen. No intermediate checkpoint is eligible.
- Each advancing mechanism then receives one fresh private confirmation through the V35 broker. The
  broker returns only permitted codes outside the trusted selector and enforces the campaign cap.
- Two treatment-family comparisons use simultaneous confidence intervals/Holm correction. Require at
  least two of three positive replicate effects and no replicate below -1 percentage point.

Replicates estimate mechanism effects; they are not three selectable checkpoints. Before development,
select one outcome-blind policy medoid per treatment using the frozen shared-critic validation states:
compute tempered-policy symmetric KL on every exact legal support, average rows within game and games
equally, select the replicate with minimum mean distance to the other two with A/B/C tie-breaking, and
bind the same-replicate control. Run one CPU thread, float64 probabilities/KL, and reject any nonfinite or
support/hash mismatch. The selector cannot inspect rewards, wins, VP, targets, guardians, or quick/public
strength outcomes. The mechanism aggregate and its preselected representative must both pass.

## Autoresearch boundary

This screen supplies the first real training task to the local AIDE controller. Phase 1 does not let it
rewrite engine or evaluator code. It may propose only one of the prevalidated arm configurations, lower
resource allocations, or stopping under the frozen non-outcome rules. After the screen, the controller
may select at most one mechanism for fresh-seed confirmation. A later code-mutation pilot requires the
candidate sandbox and a separate authorization.

## Stop and advancement gates

Stop the lane if any private-seed leak, hidden-information failure, replay mismatch, illegal action,
stall, non-finite update, trust-gate violation, GPU lease conflict, or disk-floor breach occurs. Preserve
the failure and do not substitute seeds.

Before the smoke, freeze SHA-256 records for the engine, observation/action contract, actor, trainer,
auditor, launcher, evaluator, analyzer, all nine configs, checkpoint, catalog, Node/Python dependency
locks, Python/Torch/CUDA/driver versions, determinism flags, and GPU UUID. A safe infrastructure failure
may restart only the entire unchanged generation from its input checkpoint after quarantining partial
data and recording the incident. There is no semantic/LR retry: another clip-gate failure invalidates the
screen rather than triggering a post hoc step-down.

Advance one frozen mechanism only if its equal-replicate aggregate has:

- solo true-win gain at least +3 points versus control and a multiplicity-adjusted positive paired bound;
- solo true-win rate no worse than the frozen shared-critic base on the same development suite;
- positive late-game-score and post-round-15 pace bounds;
- zero stalls and no guardian worse by more than 5 points without follow-up;
- status-3 unrestricted non-regression versus both its same-replicate control and the frozen shared base;
- the hidden-information/future-RNG invariance and exact behavior-probability contract tests pass on the
  frozen source before smoke and again for the finalist;
- binary inference p95 within the production budget.

The mechanism-level bootstrap clusters complete common seeds and keeps all three matched replicate pairs
together; two treatment contrasts use familywise 95% coverage. Inference is conditional on the three
realized training roots. The conservative false-negative risk near +3 points is accepted and gates may
not be relaxed. Any guardian below -5 points triggers exactly one 8,192-fresh-seed pooled follow-up for
all frozen policies; it cannot alter any other metric, and a second follow-up is forbidden.

Even a passing mechanism is not promotable. It must later clear 80% solo, multiplayer, historical and
heuristic fields, exploiters, hidden-information/fairness, replay, latency, catalog regression, and
Michael's blinded games.
