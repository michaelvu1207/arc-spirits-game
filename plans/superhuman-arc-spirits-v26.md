# V26 Superhuman Arc Spirits Bot Program

## Objective and proof standard

Develop a bot that is demonstrably stronger than Michael under the current production rules and
catalog, not merely stronger than an earlier checkpoint. The bot may use public monster stats,
public monster rewards, visible market/build information, and known deterministic consequences. It
may not read hidden bag order, future random outcomes, private choices, or simulator-only state.

The program has three success levels:

1. **Development gate:** at least 80% true solo wins by the real round-30 cap over 4,096 fresh,
   absolute-seed-balanced live-catalog games; Wilson 95% lower bound at least 78%; zero stalls; every
   guardian at least 70%.
2. **Superhuman solo gate:** at least 95% over 10,000 fresh games, with 100% as the finite-block
   stretch target, mean first-30 round at most 22, zero stalls, and no guardian below 90%.
3. **Human/multiplayer gate:** a frozen checkpoint must establish a greater than 50% win rate in a
   preregistered group-sequential matched challenge against Michael, with a target point estimate of
   at least 65%. A 20-game block is an early look, not sufficient proof. The multiplayer aggregate
   Elo improvement must have a 95% lower bound of at least +250 over the current production champion.
   Generalist frozen strata must have positive lower-bound performance; purpose-built exploiters
   must not push the bot below a preregistered 45% point-estimate robustness floor.

A checkpoint is not production-promotable until it passes solo, multiplayer, exploitability,
collusion, hidden-information, regression, latency, and human-play gates. Elo is never inferred from
training opponents or a single ladder population.

## Current evidence

- Frozen V23 control generation 5 scored 58.74% on 4,096 old-catalog games.
- The versioned live-catalog qualification scored 598/1,030 = 58.06%, mean 25.67 VP, zero stalls.
- Michael's held-out game `7RPYHU` replays exactly to 33 VP in round 17. On the identical engine
  seed, guardian, and live catalog, V23 ended round 30 at 25 VP.
- In that matched seed Michael used 15 location interactions, 10 combats, and eight monster rewards;
  the bot used 41 location interactions, seven combats, and five rewards. Both ended with seven
  spirits. The bot overbuilt barrier and delayed conversion.
- Navigation-only and meaningful-yield terminal teachers improved engine telemetry but did not
  establish reliable win-rate gains on the frozen catalog. Blind width, generic search, reward-choice
  labels, self-imitation, continuation replay, and macro/option experiments have also failed earlier
  controlled screens. They may only return with a new causal hypothesis and fresh control.
- The completed 64-game live-catalog combined navigation+yield pilot also failed its causal screen:
  baseline 39/64 versus teacher 38/64 (-1.56 points), mean VP 25.61 versus 24.95, zero stalls. The
  intervention evaluated all games and changed 62/64, so this is an effect rejection rather than a
  support failure. Do not distill or train this teacher; proceed to the late-state curriculum.
- A learner-contract audit found that round-cap solo failures carried `reach30Target=0` but remained
  PPO truncations, allowing the main value return to bootstrap instead of observing a resolved loss.
  V26 adds an explicit resolved-horizon mode and an order-preserving lexicographic terminal mode;
  legacy bootstrapping remains only as a controlled ablation.
- The exact `7RPYHU` trajectory diagnostic scored 85 ambiguous Michael decisions under frozen V23.
  Production V23 agreed with 25/85 (29.4%) and its raw policy top choice agreed with 17/85 (20.0%).
  The reach-30 critic averaged only 0.276 on Michael's eventual round-17 win and fell below 0.05 for
  much of the winning middle game. In the matched V23 line, the policy sacrificed all five spirits
  during round 8, then remained at 11 VP through round 19 before ending at 25 VP in round 30. This is
  direct evidence of policy/critic temporal-credit failure, not missing language-style reasoning.
- A targeted live-catalog terminal audit evaluated 14 navigation, corruption-discard, relic-mix, and
  awakening decisions with eight common-random-number rollouts per candidate. Nine teacher choices
  differed from V23, but none passed the preregistered decisiveness margin. The exact bot line still
  ended at 25 VP. These labels are diagnostic only and must not be trained; the next causal screen is
  the corrected terminal objective against a compute-matched legacy control.
- The first V26 objective smoke exposed that the league manager and actor-pool CLI still defaulted
  silently to `ml/catalog.json` (hash `62203e...`) even when the experiment intended the frozen live
  catalog (hash `5f4ad3...`). Both partial roots were stopped and permanently marked invalid before a
  generation completed. The league config now pins `catalogPath` plus `catalogSha256`, validates the
  bytes before actor generation, passes the same path to training and evaluation pools, and records
  both fields in every history row. The V26 chain independently checks the same hash and refuses any
  root carrying an `INVALID` marker.
- Production catalog drift proved that every result must carry exact source, checkpoint, and catalog
  hashes. Historical results remain valid only in their recorded environment.

## Workstream 1: rules, data, and measurement integrity

1. Freeze every production catalog used by an experiment; never overwrite the active frozen file.
2. Require source commit, checkpoint hash, catalog hash, seed block, guardian schedule, decoder,
   player count, and latency configuration in every artifact.
3. Keep guardian assignment a pure absolute-seed schedule so arbitrary sharding cannot change it.
4. Maintain exact event replay for live games. Record post-round and terminal public-state snapshots
   on real phase transitions and deadline transitions, not the obsolete `commitRound` command.
5. Add golden parity cases for Michael's games and representative bot failures. A rules/catalog
   change must either replay exactly or explicitly version/fork the case.
6. Expand cycle telemetry to record destinations, action categories, combat attempts, monster
   rewards, dice quality, trait breakpoints, barrier investment, first-15/first-30 rounds, and
   post-15 pace. Report distributions and guardian strata, not only means.
7. Run invariant tests for hidden-bag permutation, legal-command reordering, sharding, seat color,
   and public-projection equivalence. Any leak or stall invalidates the run.
8. Keep training, development, held-out, human-reference, and final certification seeds disjoint.
9. Version the stall detector. A stall is a nonterminal state in which the active bot fails to issue
   a legal progress command or fails to reach the next decision/phase within the configured command,
   reducer-step, or wall-clock budget. Separately report policy indecision, reducer loops, deadlines,
   and infrastructure timeouts; only confirmed policy/reducer stalls count as bot failures, while any
   infrastructure fault invalidates and reruns the paired unit.
10. Validate curriculum forking before using its labels: a public snapshot must reproduce exactly
    under a fixed legal hidden-state sample, and estimates must remain invariant under hidden-bag
    permutations when averaged over the preregistered resampling set.
11. Final certification always uses the then-current production catalog hash. Any catalog or rules
    change after certification expires the result and triggers replay parity, regression, and at
    least the complete solo development gate before promotion can resume.

## Workstream 2: correct the objective and temporal credit assignment

Use a lexicographic terminal objective:

1. reach 30 VP legally by the cap;
2. among wins, finish earlier;
3. among equal outcomes, maximize final VP margin;
4. use engine terms only as potential-based dense shaping that is zero at terminal state.

Implement it as an order-preserving scalar terminal reward suitable for PPO:

`R = W + 0.001 * W * (31 - finish_round) + 0.000001 * clamp(vp_margin, -499, 499)`

where `W=1` only when 30 VP is reached legally by round 30 and the finish term is zero on a loss.
One win therefore dominates every secondary term, and one earlier finishing round dominates the
largest possible margin difference. Unit/property tests must prove these inequalities for every
legal terminal state. Dense engine guidance is allowed only as `gamma * Phi(s') - Phi(s)`, with
`Phi(terminal)=0`, so it cannot change the optimal terminal policy.

Before new training, run the existing critic and policy along Michael's exact `7RPYHU` trajectory
and the bot's matched-seed trajectory. Measure calibrated reach-30 values, action ranks, and value
error at each round. If the critic fails to rank Michael's eventual line above the bot's overbuild
line before the outcome becomes obvious, treat that as a value-target or representation failure and
prioritize this workstream plus Workstream 4 over additional environment steps.

This prevents early VP farming and permanent engine building from becoming ends in themselves. Train
and report separate value targets for reach-30 probability, final VP, first-30 round, and post-15
conversion rather than forcing one scalar critic to represent all horizons.

Create a phase-balanced replay and curriculum:

- **Build:** rounds 1–8, learn efficient engine acquisition without sacrificing future feasibility.
- **Convert:** rounds 9–20, learn when to stop buying defense/rows and revisit the Abyss.
- **Finish:** rounds 21–30, prioritize legal scoring lines and avoid low-value detours.

Mine clean round-12, round-16, and round-20 snapshots from natural failures and near misses. Balance
them by guardian, VP band, status, dice quality, spirit/trait composition, and monster rung. Fork
suffixes only from public information, use common random numbers, and include successful source games
as controls so the curriculum does not teach recovery-only behavior.

Before PPO, run a direct terminal ceiling test: an intervention over these late states must improve
fresh full-game win rate by at least eight points with a paired 95% lower bound of at least four
points and no VP/pace/stall regression. If it fails, change the estimator or representation rather
than training labels that cannot causally improve games. First validate that a known beneficial
scripted intervention is detected by the fork/estimator. If that positive control fails, repair the
forking or variance-reduction machinery; if it passes but learned interventions fail, run the critic
trajectory diagnostic, entity representation probe, and finish-state exact-search ceiling in
parallel. Only close the late-state hypothesis when all three fail on adequately covered states.

## Workstream 3: learn conversion quality, not just engine size

Add public, information-safe supervision for the following explicit hypotheses:

- **Combat feasibility:** poor conversion comes from miscalibrated fight success now versus after one
  build action.
- **Monster reward and next-rung accessibility:** the policy undervalues the scoring chain unlocked
  by public encounter rewards.
- **Dice quality/damage distribution:** raw dice count aliases weak and combat-ready engines.
- **Trait breakpoints:** the policy cannot value an active or one-piece-away synergy from flat totals.
- **Location-versus-Abyss marginal value:** the policy lacks a direct estimate of when another row is
  worse than converting in combat.
- **Barrier surplus:** the policy treats defensive stock as monotonically valuable after it exceeds
  the current public threat.
- **Multi-horizon reach-30 probability:** a single critic does not propagate terminal credit across
  the long build-to-combat sequence.
- **Outcome-derived phase/mode:** the policy aliases build, convert, finish, and forced-recovery
  states with similar scalar resources.

Auxiliary heads are retained only if three matched seeds show a held-out win-rate improvement. Their
losses must not dominate policy/value gradients, and coefficient-zero controls must forward the
same tensors and consume equivalent compute.

## Workstream 4: model architecture and size

Do not assume a wider MLP produces reasoning. First test whether the flat encoder aliases materially
different builds. Construct curated pairs that hold aggregate resources constant but require
opposite actions: barrier-sufficient/deficient, weak/strong dice quality, inactive/active trait,
pre-conversion/finishable, and accessible/inaccessible monster rung. Fit a linear probe and measure
policy divergence, counterfactual action ranking, and representation distance. Failure means the
current encoder cannot separate at least 90% of pairs or ranks the strategically correct action in
fewer than 80% of them. If it fails, move to an entity-aware scorer with separate spirit, mat, die,
monster, location, and player entities; masked pooling/attention; and permutation-invariance tests.
Preserve the legal-candidate scorer so new action vocabularies remain append-only.

Run compute-matched size ablations only after the target/representation gate:

- compact deployment student: width 256;
- strategic model: width 512;
- teacher candidate: width 768 or 1,024 with deeper residual blocks;
- entity-attention variants with matched parameter and environment-step budgets.

Compare learning efficiency, calibration, inference latency, actor throughput, and final held-out
strength—not training loss. A larger teacher may be distilled into the width-256 student. Add
recurrence or memory only if an observation-history ablation proves that the current public state
omits strategically necessary history; the game should not need language-style chain-of-thought.

## Workstream 5: selective planning and search

Complete the live combined navigation+yield terminal ceiling pilot first. If it passes, collect
immutable labels and distill only those supported decision families. If it fails with adequate
intervention coverage, close that teacher and move to the late-state curriculum.

Search is selective, not universal:

- exact/endgame search for finishable public states;
- Gumbel/MCTS only at navigation, encounter, and high-impact location decisions where a causal
  ceiling audit shows headroom;
- explicit chance nodes for dice and hidden draws, with determinization averaged over legal hidden
  states rather than peeking at the realized future;
- transposition caching keyed by sanitized public state plus legal support;
- batched leaf evaluation and action pruning that never removes a legal immediate win.

Every search configuration must beat its no-search paired control after charging its real latency.
If a large search teacher is strong but slow, distill its policy/value targets into the production
student and retain search as an optional expert tier.

## Workstream 6: solo-to-multiplayer curriculum

Train in stages, retaining earlier environments in replay to prevent forgetting:

1. solo until the 80% development gate;
2. two players with balanced seats/guardians and frozen solo evaluation every generation;
3. three players;
4. four players, then sampled five/six-player robustness.

Use a population league containing current policy snapshots, historical champions, heuristic styles,
search teachers, main exploiters, best-response exploiters, and deliberately non-clone stochastic
opponents. Balance opponent/seat/guardian matrices. Measure Nash-style exploitability, collusion,
kingmaking, passivity, fallen-state recovery, and late-game combat behavior. Never select a champion
only by self-play Elo against its own distribution.

## Workstream 7: human data and human evaluation

Keep `7RPYHU` held out as an exact replay and strategy regression case. Early in the program, collect
a 40-game Michael baseline spanning balanced guardians and preregistered disjoint solo seeds. Record
win rate, finish round, VP, conversion pace, combat/reward frequency, and per-guardian results. Use it
to calibrate the superhuman thresholds; the existing 95%/round-22/per-guardian-90% thresholds remain
minimum aspirations and may be raised if Michael's measured baseline is stronger. Collect additional
consented human games with their live catalog hashes. Reconstruct observations exclusively through
the bot's public encoder and verify command legality before admitting a row.

After at least 20 independent legal human games, including at least 10 wins and coverage of every
guardian, create a separate imitation/DAgger-style screen using phase-balanced human decisions.
Hold out entire games and players, not random rows. Human imitation is a warm start or auxiliary
target; online self-play/search must exceed it.

Preregister the final human challenge before viewing results. Freeze the checkpoint, inference/search
budget, analysis code, seed blocks, guardian/seat schedule, and every stopping boundary for the whole
challenge. Use 20-game group-sequential looks up to a fixed maximum of 100 games, with a one-sided
5% alpha-spending boundary for `H0: p <= 0.50` versus the design alternative `p = 0.65`; stop early
only at a preregistered efficacy or futility boundary. Include solo seed races and direct multiplayer,
alternate seats/guardians, and use disjoint seeds. Success requires rejection of `H0`, a target point
estimate of at least 65%, zero stalls, and no manual force-advance. An inconclusive result at the
maximum is a failed gate, not permission to switch checkpoints or extend the sample opportunistically.

## Workstream 8: A100 and simulation efficiency

Benchmark before optimizing. Record environment steps/s, decisions/s, games/s, CPU utilization,
GPU utilization, GPU memory, inference batch distribution, learner time, actor wait time, and disk
write volume for fixed workloads.

The simulator is mostly CPU/reducer-bound; A100s help only when inference/training is batched. Test:

- one persistent GPU inference server shared by many CPU actors;
- dynamic microbatching with bounded latency and float32 parity checks;
- BF16/TF32 learner kernels where numerical parity gates allow them;
- `torch.compile`/CUDA graphs for stable model shapes;
- pinned-memory/asynchronous host-to-device transfer;
- overlapping actor generation, replay loading, and learner updates;
- binary/chunked replay formats and fewer tiny JSONL writes;
- cached public-state encodings and batched candidate scoring;
- actor counts and CPU affinity tuned to measured saturation, not all-core launch by default.

For each optimization, compare a fixed-seed output hash or bounded numeric parity, throughput,
latency, and total cost. Preserve unrelated SimForge processes, disk headroom, and paired seeds.

After the initial throughput benchmark, freeze a first-pass compute allocation: 10% integrity and
causal ceiling audits, 45% curriculum/control training, 20% representation/size ablations, 15%
selective search and distillation, and 10% final certification. Reallocate only from a stopped or
completed workstream with a written reason. Curriculum/control runs have priority over throughput
tuning, and certification compute may not be borrowed for exploratory training.

## Workstream 9: controlled experiment sequence

1. Finish and adjudicate the current live combined navigation+yield 64-game pilot.
2. If it passes the pilot gate, extend/confirm on fresh live seeds and distill with a coefficient-zero
   training control. If it fails, do not train it.
3. Run the matched human-versus-bot critic trajectory diagnostic, then implement and validate the
   round-12/16/20 late-failure forking machinery and ceiling audit on the live catalog.
4. Train the smallest controlled curriculum treatment that passes the ceiling audit; compare three
   matched seeds against a compute-matched control.
5. If the treatment reaches at least 70%, run representation/size ablations and selective-search
   distillation. If it remains below 70%, prioritize entity representation and multi-horizon values
   before spending more environment steps.
6. At 80% solo, begin the staged multiplayer league while continuing frozen solo checks.
7. Collect Michael's balanced baseline throughout development; at 95% solo and after multiplayer
   gates, run the preregistered frozen-checkpoint sequential challenge.
8. Canary the passing checkpoint behind an explicit versioned bot profile, monitor stalls/latency and
   real-game outcomes, and retain one-command rollback. Promote only after the canary gates pass.

## Experiment and promotion contract

Every experiment has a written hypothesis, immutable config, disjoint seed block, minimum effect,
confidence requirement, compute budget, and stop rule. Preserve negative results and invalid runs.
Never pool across catalog hashes, decoder modes, or fairness schedules. Never reclassify development
games as held out. Never promote because training Elo rose, a single human game looked good, or a
larger model had lower loss.

The active goal stays open until the bot passes all stated gates and is verified in production. A
result that reaches the token/compute/time limit is incomplete, not successful.
