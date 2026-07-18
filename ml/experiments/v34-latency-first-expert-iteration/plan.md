# V34 — latency-first strategic reranking and offline expert iteration

Status: Fable review incorporated; implementation not frozen and no V34 seed is open.

## Why V34 exists

V33 proved that full policy-rollout search is the wrong online serving shape. Its least-compute
registered arm completed only 23 games in 1,038 seconds at four workers. The observed 4,096-game
projection was 51.35 hours, and even crediting all four in-flight games as completed at the cutoff
left a 43.74-hour projection versus the preregistered six-hour ceiling. The partial, non-binding
search-decision p95 was 11.53 seconds. V33 stopped before Phase 2 and did not open a strength,
development, hidden, expert-iteration, or promotion seed.

The useful result is architectural: expensive policy rollouts belong in an offline teacher lane.
Online play needs a bounded number of batched critic calls or cheap engine-only rollouts.

## Objective

Build a production-shaped solo policy that plans for reaching 30 VP by round 30 without sacrificing
late-game engine strength:

1. pass hidden-information and deterministic replay audits;
2. pass binding search-decision p95 limits of 1,000 ms at one concurrent game and 2,000 ms at eight;
3. improve fair paired solo win rate by at least 3 percentage points in development;
4. reach at least 80% fair held-out solo wins by round 30, with 95% as the stretch target;
5. then improve multiplayer Elo and pass exploiter, regression, and human-play gates before promotion.

V34 is not promotion eligible at creation. Production remains unchanged.

## Frozen predecessors

- Live catalog: `ml/catalogs/live-20260713-5f4ad348.json`, SHA-256
  `5f4ad348f6c7add612c736df0f3e00b7d4c821758e0561049f2e550e798c6e2e`.
- Acting policy and round-30 critic: `ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt`,
  SHA-256 `aeb254c20367029696da1e6ca823b96187191140056d646a7c2d3d47ec4e567b`.
- V33 implementation source lock: SHA-256
  `d56411fab63e2851785c8b6001b92579f6eca8b9f4c821f3437f04ffbb7fcf6f`.
- V33 operational rejection: `ml/experiments/v33-strategic-search/artifacts/systems-early-rejection.json`,
  SHA-256 `6d3bc1be3346ab682be34340c34dc79caf90dd10f3205ccf3a9b45955cfa298a`.
- Historical context only: the V30 validation dataset recorded 276/512 true wins (53.91%) from the
  V23 behavior policy on the same catalog. That is not a current V34 qualification baseline; Phase 2
  measures the frozen V32/V30 actor on 4,096 paired current seeds before any strength claim.

## Non-negotiable fairness contract

- All decisions use only the acting seat's public information at commitment time.
- Public monster stats and deterministic/public reward expectations are allowed. Unrevealed die,
  bag, spirit-drop, opponent-lock, and randomized reward realizations are not.
- One fresh information-set determinization is used per stochastic simulation.
- Systems screens may inspect only timing, error, provenance, memory, and search-count telemetry.
- Development outcomes may be inspected only after the systems report authorizes strength seeds.
- Hidden outcomes are opened exactly once, only after one candidate and all thresholds are frozen.
- Training, development, hidden, guardian, multiplayer, and human-reference seeds never overlap.
- A serving error, provenance mismatch, replay mismatch, stall, NaN, or information-safety failure
  rejects the arm; it is never silently retried as a favorable sample.

## Seed ledger

All ranges below are inclusive and disjoint from V33 and its local smoke seed.

| Purpose                                    |               Range |
| ------------------------------------------ | ------------------: |
| critic preview-calibration training audit  | 957800000–957804095 |
| systems smoke and latency only             | 957900000–957900255 |
| online-search Phase 2 paired development   | 957000000–957004095 |
| online-search guardian paired development  | 957300000–957308191 |
| final solo development                     | 957100000–957104095 |
| final solo hidden                          | 957200000–957204095 |
| offline teacher generation, generation 1   | 958000000–958004095 |
| offline teacher generation, generation 2   | 958010000–958014095 |
| offline teacher generation, generation 3   | 958020000–958024095 |
| PPO/on-policy training, generation 1       | 958030000–958034095 |
| PPO/on-policy training, generation 2       | 958040000–958044095 |
| PPO/on-policy training, generation 3       | 958050000–958054095 |
| expert-policy development, generation 1    | 958100000–958104095 |
| expert-policy development, generation 2    | 958110000–958114095 |
| expert-policy development, generation 3    | 958120000–958124095 |
| distilled-policy online-arm transfer check | 958200000–958204095 |
| model-width training A (1.0x)              | 959000000–959004095 |
| model-width training B (1.5x)              | 959100000–959104095 |
| model-width training C (2.0x)              | 959200000–959204095 |
| model-width paired development             | 959900000–959904095 |
| generation-1 multiplayer canary            | 960000000–960000511 |
| multiplayer development and exploiters     | 960010000–960099999 |
| multiplayer hidden                         | 960100000–960199999 |
| human-reference replay schedule            | 960900000–960909999 |

Registered smoke seeds are game seeds. Planner RNG keys are derived from game seed, round, per-game
decision ordinal, seat, and arm id; they are not game seeds and must not be passed to the engine.

## Lane A — production-bounded online decision improvement

### A1. Batched critic reranker

Add a batched state-only reach-30 API to both local and remote policy implementations. One remote
request carries every candidate preview observation as batch dimension B; it must not issue B serial
roundtrips. The reranker performs:

1. one normal root policy-logit request over all legal candidates;
2. one batched reach-30 request over each candidate's information-safe `policyPreviewState`;
3. exact terminal overrides: reached 30 VP = 1, terminal below 30 = 0;
4. stable combination of policy and critic by within-root ranks, avoiding incompatible raw scales;
5. deterministic argmax with original candidate order as the final tie break.

Registered mixtures are policy-rank weights 0.25, 0.50, and 0.75. A weight-1.0 deterministic
policy-rank arm is the argmax control and makes critic gain distinguishable from the change from
temperature-0.55 sampling to argmax. Rank normalization is frozen before systems seeds. Navigation
and encounter are the only eligible phases; forced or singleton decisions bypass reranking. The
policy preview must never expose a realized hidden outcome.

Before systems seeds, audit the round-30 critic on 4,096 registered calibration-training games.
Taken-action preview states must have AUC >=0.75, ECE <=0.10, and Brier <=0.20 against the eventual
round-30 result. Every legal candidate preview must be finite and terminal overrides must be exact.
Failure disables all critic-based online arms before systems seeds; it cannot be used to tune weights.

### A2. Cheap stochastic search

Screen engine-only heuristic rollouts with a single critic batch at leaves:

- `heuristic-s4-h2`;
- `heuristic-s8-h3`.

No policy inference is allowed inside a rollout. This preserves stochastic lookahead while avoiding
V33's serial neural calls. Search remains navigation/encounter only and uses the V33 solo reach-30
leaf objective. The existing raw policy is the paired baseline.

### A3. Latency-first systems protocol

The systems runner is resumable and records every stage before advancing. It never waits for a full
256-game sweep after a decisive operational failure.

1. Preflight: source lock, served checkpoint/catalog hashes, information-safety tests, deterministic
   replay tests, batched-vs-serial critic equivalence, and a 100,000-sample determinization audit.
2. Smoke: 4 games per arm, one worker. Any error rejects. Runtime rejects only if an explicitly
   optimistic bound—crediting perfect linear scaling from one to the maximum 24 workers—still
   projects above six hours, or if searched-decision p95 exceeds 10 seconds. Outcomes are not loaded
   into the recorder.
3. Binding latency: 64 games per surviving arm at one worker and 64 at eight workers. Empirical
   decision p95 must be <=1,000 ms and <=2,000 ms respectively; at least 256 searched decisions are
   required in each concurrency condition.
4. Throughput: 128 games at 4/8/12/16/24 workers for survivors. Select the smallest worker count
   within 5% of peak games/s. Projected 4,096-game time must remain <=6 hours.
5. Record one immutable eligibility report. Phase 2 authorization exists only if at least one search
   arm survives all gates.

The runner logs completed-game progress so early projection does not depend on temporary full game
records. It stores no VP, win, action, or reward outcomes in systems artifacts.

### A4. Paired online-search strength screen

Run raw plus every systems-eligible arm on the same 4,096 development seeds. Freeze candidate order,
server backend, binary wire, sampling temperature 0.55, max round 30, max status 2, and absolute
balanced guardian scheduling.

There are six registered candidate arms: four reranker weights and two heuristic-search arms. Use
complete-seed paired bootstrap clusters with 10,000 draws and a max-statistic simultaneous 95%
family across all six arms and the four core outcomes (win, final VP, post-15 VP/round, censored
round-to-30). The family and bootstrap RNG seed are frozen in the protocol. An arm advances only if
all hold:

- paired win-rate gain >=3 points and simultaneous lower bound >0;
- final-VP simultaneous lower bound >=0;
- post-round-15 VP/round simultaneous lower bound >=0;
- censored first-round-reaching-30 simultaneous upper bound <=0, with failures encoded as round 31;
- zero stalls, information failures, replay mismatches, serving errors, or provenance mismatches;
- binding latency evidence still passes.

Run every core-passing arm on the independent 8,192-seed guardian range with absolute-balanced
scheduling. Across all surviving arm-by-guardian comparisons, require point delta >=-5 percentage
points and a simultaneous one-sided 95% lower bound above -10. This is confirmation, not a retry on
the Phase 2 seeds; any failure rejects the arm.

Freeze exactly one arm by largest paired win gain, then lower latency, then smaller arm id. If none
passes, close online search and continue with raw serving plus Lane B; do not weaken thresholds.

## Lane B — expensive search as an offline teacher

### B1. State curriculum

Generate complete raw-policy solo games only from registered teacher ranges. Retain information-safe
decision snapshots and oversample strategic states rather than easy forced actions:

- 50% rounds 16–30;
- 25% rounds 9–15;
- 15% rounds 1–8;
- 10% recovery states: Fallen/Corrupted, weak engine after round 15, or zero recent scoring.

Within each band, prioritize policy entropy, close top-two logits, disagreement between policy and
reach critic, and large engine-investment choices. Cap repeated structural states and cap snapshots
per game so a few long failures cannot dominate. Freeze exactly 100,000 strategic snapshots per
generation before teacher search; the four bands therefore contain 50k/25k/15k/10k rows.

### B2. Offline teacher

Run the V33 policy-rollout teacher only on retained snapshots. It may use 32–64 simulations and a
6–10 round horizon because it is never called during production play. Parallelize independent
snapshots across free A100s and CPU workers; batch leaf/root inference and write one append-only shard
per worker. Each row includes source seed/round/ordinal, public-state hash, legal-action hashes, visit
distribution, teacher Q, raw-policy distribution, reach prediction, selected action, wall time, and
served provenance. It excludes hidden realizations unavailable at the snapshot.

Teacher data gates:

- exact replay of >=1,000 randomly selected rows reproduces legal actions and state hashes;
- duplicate snapshot/action hashes agree exactly within the same backend;
- no seed outside the registered teacher ranges;
- no development/hidden seed;
- zero safety/provenance failures;
- effective teacher improvement: teacher must disagree with raw on >=5% of the 100,000 strategic
  snapshots, mean candidate-count-normalized visit entropy must be >=0.10, and >=10% of rows must
  have normalized entropy >=0.20; otherwise do not train on it.

### B3. Distillation and policy improvement

Train generation `g+1` from generation `g` using a fixed mixture:

- teacher visit-distribution cross-entropy on strategic snapshots;
- PPO/on-policy policy loss from complete solo games;
- calibrated round-30 reach loss;
- terminal win and censored time-to-30 value targets;
- replay anchor loss on generation-0 policy support for every generation, so the reference never
  drifts with the current actor.

Use three generations maximum. Each generation gets a fresh teacher seed range and must pass a
fresh 4,096-seed paired development range before becoming the next teacher actor. After generation 1,
run a non-binding 512-game 2/3/4-player canary from the multiplayer development range; a catastrophic
Elo drop below -100 or any stall stops solo-only iteration for redesign. Never train against a
development result or reuse hidden games.

Train three capacity arms only after the first valid teacher dataset exists: current width, 1.5x
width, and 2x width with matched optimizer-step and sample budgets. Capacity is selected on disjoint
paired development by win gain first, post-round-15 scoring second, calibration third, and inference
latency fourth. Every capacity arm must first pass the binding 1,000/2,000 ms limits as a hard gate;
parameter count alone is not a reason to advance.

If Lane A froze an online arm, test exactly two candidates on the independent transfer range after
the final distilled policy is frozen: distilled raw and distilled plus that unchanged online arm.
The combination is selected only if its paired win gain is >=3 points with family-adjusted lower
bound >0, all late-game/regression gates pass, and latency passes; otherwise select distilled raw.
If Lane A froze no arm, distilled raw is selected without a transfer comparison. Final solo
development is never used to decide composition.

## Solo qualification

Freeze one final production-shaped candidate: raw distilled policy optionally combined with the one
eligible online arm. On 4,096 final development seeds require:

- win by round 30 >=80%; stretch target >=95%;
- one-sided 95% lower confidence bound >=75%;
- final VP and post-round-15 VP/round not below the frozen predecessor;
- no regression in rounds 1–15 scoring greater than 2 points;
- every guardian win rate >=70%;
- Fallen/Corrupted recovery success improves and zero action stalls;
- reach-30 AUC >=0.85, ECE <=0.05, Brier <=0.15;
- production concurrency and latency gates pass.

Open the 4,096 hidden seeds once. Require hidden win by round 30 >=80%, lower bound >=75%, all
regression/safety/latency gates, and hidden point win rate no more than 5 percentage points below
final development. The 80% point gate is retained because it is the user's explicit target despite
its power cost near the boundary. Failure closes V34; it never triggers hidden-aware tuning.

## Multiplayer and human gates

Only a hidden-qualified solo candidate enters multiplayer work:

1. 2/3/4-player seat-balanced league against current production, champion archive, heuristic styles,
   and targeted exploiters; require point Elo gain >=+100 with a 95% bootstrap lower bound >0.
2. Exploitability probes for pass loops, Fallen/Corrupted recovery, free summon/action handling,
   late-game engine starvation, and PvP avoidance/aggression extremes.
3. Regression suite for every spirit/ability selection, Arcane Abyss remaining rewards, overflow
   costs, initiative, corruption pass, summon/pass, and information safety.
4. Disjoint replays of Michael's reference games, including solo `7RPYHU` and multiplayer `LGXJ5D`,
   using only state available to the bot at each decision.
5. At least 50 fair live head-to-head games against Michael with randomized seats and a frozen build.
   Promotion requires a one-sided 95% Wilson win-rate lower bound >50%; descriptive games are not a
   substitute for this gate.

## Promotion rule

No checkpoint is copied into production weights and no deployment is made until solo development,
solo hidden, multiplayer Elo, exploiter, regression, hidden-information, deterministic replay,
latency, and human-play gates all pass. Promotion is a separate signed manifest containing source,
catalog, checkpoint, protocol, and every qualification artifact SHA-256.

## Immediate implementation order

1. Fable-review this plan and incorporate blockers before protocol freeze.
2. Implement batched reach inference, critic reranking, progress telemetry, and tests.
3. Implement the latency-first resumable systems recorder and freeze a source lock.
4. Run only V34 systems seeds on SimForge.
5. Open Phase 2 only from an immutable eligibility artifact.
6. Build the offline snapshot/teacher lane in parallel after systems behavior is understood; it may
   use teacher training seeds but never development or hidden seeds.
