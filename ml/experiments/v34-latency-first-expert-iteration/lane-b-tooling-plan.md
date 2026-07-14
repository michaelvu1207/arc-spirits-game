# V34 Lane B teacher, capacity, and multiplayer amendment

Status: outcome-blind implementation draft. No Phase 2 report or outcome was read while writing it.
All 958/959/960/961 teacher, training, development, hidden, and multiplayer seeds remain closed.

## Why an amendment is required

The frozen V34 direction is correct: late/recovery snapshots, offline search, joint PPO plus search
distillation, capacity comparison, then multiplayer qualification. The current code cannot execute that
contract honestly:

1. continuation snapshots cover only clean navigation boundaries and retain RNG cursors;
2. online Gumbel collection filters search to navigation/encounter, excluding summon, awaken, absorb,
   combat, rewards, and other engine-building decisions;
3. the v2 learner cannot jointly mix exact PPO, search-policy cross-entropy, a generation-0 anchor, and
   censored time-to-finish targets;
4. width tooling is v1-only and the frozen one-range-per-width allocation confounds width with one
   training initialization;
5. multiplayer league qualification still uses a distilled-v1 proxy rather than the served raw-v2
   policy, and no multiplayer training ranges are registered.

This is a state-action credit and data-distribution problem, not a need for an LLM in the move loop.
Width may help fit the teacher, but width alone does not add planning.

Do not edit any source- or strength-locked file while Phase 2 is active. Implement new standalone
schema/collector/teacher/trainer/benchmark files and synthetic tests only. Before consuming a registered
seed, Fable-review this amendment, commit an exact source inventory, pass local and SimForge smoke gates,
and create a separate teacher authorization.

## Governance, artifacts, and failure semantics

Lane B gets its own reviewed `lane-b-execution-protocol.json`, exact tooling inventory, synthetic fixture
suite, source/tooling lock, outcome-blind authorization, live preflight, execution lock, immutable
per-condition attempts/completions, analyzer, and final selection manifest. The tooling lock binds every
statistical family, RNG seed, seed ledger, model initialization, loss mask, evaluator argument, retry rule,
and storage location before any 958/959/960/961 seed opens. An execution lock additionally binds the exact
parent checkpoint and all prerequisite completion manifests. Historical `status: closed` fields are never
silently edited or treated as authority; each new authorization explicitly names which one stage is open
and keeps every later stage closed.

All paired evaluation conditions in a stage finish and their completion manifests are copied,
independently hash-verified, and committed before the locked analyzer is run once. Evaluation outcome
files are not inspected during a blinded campaign. PPO/PFSP training loops may consume their own rewards,
advantages, and match outcomes exactly as frozen for optimization and opponent weighting, but those
training signals cannot authorize a gate, alter an evaluation schedule, or select evaluation retries.
One identical full-seed retry is allowed only for immutable attempt-1 `server-start`/90 or
trapped `process-interrupted`/92 evidence when no primary or replay report exists. No attempt splicing,
seed substitution, outcome-dependent retry, or partial repair is allowed. A semantic, replay, provenance,
hidden-information, or safety fault closes that registered stage; an infrastructure/resource failure
before a registered seed is consumed creates no attempt and may be corrected under the same lock.

## B1. Information-safe strategic snapshots

Add a versioned snapshot contract and collector that drives complete raw-policy games but records only
ambiguous engine-cycle choices. Each row contains:

- source game seed, round, decision ordinal, public-state hash, and current visible state;
- the exact canonical taken-action command trace from reset through the snapshot and a separate bot-action
  sampling seed, sufficient for an auditor to reconstruct the state from the source game seed;
- obs-v1 and obs-v2 encodings;
- canonical legal command hashes and candidate features;
- raw logits/probabilities, calibrated reach-30 probability, and current public recovery diagnostics;
- no future outcome, hidden bag order, future RNG cursor, not-yet-drawn identity, or uncommitted random
  resolution.

The source game seed and action trace are audit provenance only and are never model inputs or teacher
rollout RNG. Reconstruction replays already-taken commands from reset and verifies the state, observation,
and legal-action hashes; teacher rollouts then redeterminize only information hidden at that decision.
Future realized outcomes are written only after game completion to a separate target shard keyed by opaque
row id. The feature/snapshot shard contains no target; the target shard is never loaded by snapshot replay,
teacher search, action selection, or observation construction. The learner joins targets only after teacher
labels are finalized, and an adversarial fixture proves that deleting the target shard cannot change any
observation, legal action, teacher visit count, or selected action.

Freeze exactly 100,000 deduplicated rows per generation after all 4,096 source games:

- 50,000 from rounds 16–30;
- 25,000 from rounds 9–15;
- 15,000 from rounds 1–8;
- 10,000 current-state recovery rows: Fallen/Corrupted, weak post-15 engine, or no recent scoring.

The four bands are disjoint: recovery takes precedence, then the three round bands are filled only from
non-recovery rows. Recovery classification uses current and past public facts only; "no recent scoring"
means zero positive VP change in the acting seat's previous three completed rounds. Keep at most 48 rows
per source game and four rows per structural public-state hash. A retained choice must have at least two
legal actions after deterministic forced-action closure and at least two semantically distinct outcomes;
forced payments and singleton choices are excluded. If a generation cannot supply an exact band after all
4,096 registered games, that generation closes without backfill, duplicated rows, cross-generation seeds,
or relaxed caps. Later generation seeds remain closed. First prove row density on an unregistered smoke
range.

The structural hash is SHA-256 over canonical sorted JSON containing round, phase/stage, acting seat,
public guardian, public status/corruption, VP, resources/capacity/overflow, dice/runes/relics, public
spirits/classes/abilities/upgrades/inventory, public board/monster/abyss/summon/reward state, and sorted
legal-command hashes. It excludes engine and sampling seeds, action trace, timestamps, row/game ids, raw
logits, targets, private/hidden zones, future RNG, and fields not visible to the acting seat. A schema
fixture enumerates every included and excluded path.

Collect a 512-game unregistered density smoke before authorization using the final cap/dedup rules. It may
proceed only if projected post-dedup supply is at least 110% of every quota: at least 6,875 late, 3,438 mid,
2,063 early, and 1,375 recovery rows in the 512-game smoke. Eligible rows are first sorted by
`(publicStateHash, sourceGameSeed, decisionOrdinal)`; generation G1/G2/G3 then samples without replacement
within each disjoint band using `PCG64(34043101)`, `PCG64(34043102)`, or `PCG64(34043103)`. A smoke
shortfall prevents registered collection and may change only through a newly Fable-reviewed protocol.

Suggested new entry points:

- `src/lib/play/ml/expertIteration/snapshot.ts`
- `scripts/collect-v34-teacher-snapshots.mjs`
- `scripts/test-v34-teacher-snapshots.mjs`

## B2. Offline all-engine-cycle teacher

Search the frozen selectable support at every retained engine-cycle snapshot, not only navigation and
encounter. Reuse source-locked determinization and Gumbel planning through a standalone runner.

Outcome-blind systems candidates are 64 simulations × 10 rounds, 48 × 8, and 32 × 6. Choose on a
1,000-snapshot timing/storage pilot drawn only from the unregistered 512-game density smoke; never use a
registered 958 row or inspect teacher strength during systems selection.
Use policy/self-model rollouts, at most eight root actions, solo reach-30 leaf value, common-random-number
redeterminization, and batched inference across independent snapshots. Write append-only compressed
content-addressed shards with an exact ledger.

Teacher systems selection uses no outcome or teacher-strength fields. The chosen arm is the fastest arm
that fits the frozen wall/storage budget and passes deterministic-label fixtures; ties use fewer simulated
round-steps. The unregistered pilot records the root-action disagreement rate `q` and its one-sided 95%
Wilson upper bound `q_upper`, but no rollout outcome. Before registered execution, freeze
`n_audit = max(8192, ceil(q_upper * ((z5 + z80) / 0.01)^2))`, where
`z5 = NormalDist().inv_cdf(1 - 0.05 / 5)` and `z80 = NormalDist().inv_cdf(0.80)`. If `n_audit` exceeds
65,536 or any band lacks its proportional allocation, teacher execution stays closed. Allocate the frozen
audit size 50% late, 25% mid, 15% early, and 10% recovery by largest remainder, then select without
replacement using `PCG64(34041026)`.

Every G1/G2/G3 teacher reruns this audit against that generation's bound current parent. At each row
compare the teacher-visit argmax action with the current-parent raw-policy argmax under 32 common-random-
number redeterminizations and that same current parent as downstream policy through round 30. Matching root
actions contribute zero paired difference. Require at least `max(512, ceil(0.04 * n_audit))` disagreeing
root rows in the frozen audit; otherwise the teacher fails before strength inference.

Use 10,000 complete-source-game cluster draws from `PCG64(34041027)` and a one-sided max-t family over the
overall true-win delta and four band deltas. Each draw samples the 4,096 source game seeds with replacement
once and carries every selected audit row from each sampled game into every endpoint. For an endpoint with
`G` contributing games, `N` rows, row differences `d`, and observed row-weighted mean `m`, use the original
cluster-robust SE `sqrt((G / (G - 1)) * sum_g(sum_{r in g}(d_r - m))^2) / N`. Empty sampled endpoints or
fewer than two contributing games are structural aborts; zero-SE endpoints use their point estimate. Use
the 95th nearest-rank maximum with a
`NormalDist().inv_cdf(1 - 0.05 / 5)` floor. The teacher audit passes only if the overall true-win point
gain is at least +1 percentage point and its simultaneous lower bound is strictly above zero, every band
point estimate is nonnegative, and the late-band simultaneous lower bound is greater than -3 points.

Teacher gates for every generation:

- at least 1,000 randomly selected rows replay to identical state/legal-action hashes;
- duplicate state/action hashes yield identical labels under the same backend;
- exact registered source-seed ledger, zero development/hidden overlap, zero safety/provenance failure;
- raw/teacher disagreement at least 5%, mean candidate-normalized entropy at least 0.10, and at least
  10% of rows at entropy 0.20 or above;
- the exact powered audit above passes, including its late-band non-reversal bound.

Disagreement and entropy alone do not prove a better teacher.

Suggested new entry points:

- `src/lib/play/ml/expertIteration/teacher.ts`
- `scripts/run-v34-offline-teacher.mjs`
- `scripts/test-v34-offline-teacher.mjs`

## B3. Joint v2 expert-iteration learner

Implement a standalone v2 learner that imports frozen model/observation code until Phase 2 retires.
Each generation uses deterministic, independent row-order streams and one combined optimizer step. G1
starts from the frozen generation-0 checkpoint. G2 starts from the valid G1 checkpoint and G3 from valid
G2; a failed generation closes all later generations. Snapshot collection, PPO behavior generation,
teacher rollouts, and development comparison all bind that generation's current parent checkpoint.

Each generation contains:

- 100,000 complete on-policy PPO rows;
- 100,000 teacher rows;
- an immutable 25,000-row generation-0 replay anchor with frozen generation-0 logits.

The PPO shard uses the B1 48-per-game/four-per-structural-hash cap, disjoint band quotas, feature/target
segregation, and deterministic within-band selection; its behavior log probability and sampling seed are
mandatory provenance. Teacher and PPO rows remain distinct even when their public structural hashes match.

Starting coefficients, frozen before outcomes:

- PPO policy 1.0;
- search visit-distribution cross-entropy 1.0;
- value 0.5;
- reach-30 BCE 1.0;
- discrete rounds-16–30 finish-hazard/right-censor auxiliary 0.25;
- generation-0 KL anchor 0.05;
- entropy 0.003;
- clip and value-clip 0.1;
- learning rate 5e-5 cosine, gradient norm 1;
- batch 512, exactly 447 optimizer steps per epoch, two epochs. Every batch has 224 PPO, 224 teacher,
  and 64 anchor rows. Each 100,000-row PPO/teacher stream is traversed once per epoch plus 128 rows from
  a deterministic wraparound permutation; the anchor is traversed once plus 3,608 rows. Epoch two uses
  separately frozen permutations.

For generation `g` in 1..3, epoch `e` in 1..2, and stream id `s` = 1 PPO, 2 teacher, 3 anchor, seed the
permutation with `PCG64(34044000 + 100*g + 10*e + s)`. Sort opaque row ids first, take one full
permutation, then take wraparound rows from the start of a new permutation produced by the continuing
generator. No loader or worker RNG may change this order.

Loss masks are exact: PPO policy, clipped value, and behavior-log-probability reconstruction use PPO rows;
search cross-entropy uses teacher rows; generation-0 KL uses anchor rows only; value, reach-30 BCE, and
finish-hazard losses use PPO and teacher rows with their own information-safe realized continuation
labels; entropy is the equally weighted mean of PPO and teacher actor entropies. Anchor rows do not enter
value/reach/hazard metrics. The discrete hazard target spans rounds 16–30, has one event at the first
reach-30 round, includes only at-risk rounds, and right-censors at terminal or round 30. No post-decision
field is admitted to an observation.

Keep the calibrated 20/25/30 reach head. Add the finish-hazard head for credit assignment; do not add a
hand-shaped engine score as a primary objective.

Use the already registered generation ranges:

| Generation | teacher games | PPO games | paired development |
| --- | --- | --- | --- |
| G1 | 958000000–958004095 | 958030000–958034095 | 958100000–958104095 |
| G2 | 958010000–958014095 | 958040000–958044095 | 958110000–958114095 |
| G3 | 958020000–958024095 | 958050000–958054095 | 958120000–958124095 |

Development uses one complete-seed paired family frozen across all three generation slots and five
endpoints per slot: true win, final VP, post-15 VP/round, censored first-30 round, and rounds-1–15 VP.
Use 10,000 global draws from `PCG64(34042026)`, centered paired max-absolute-t, the 95th nearest rank, and
the fixed 15-endpoint two-sided floor `NormalDist().inv_cdf(1 - 0.05 / (2 * 15))`. Unused later slots
remain in the floor after early stopping. Zero-SE endpoints use their point estimate.

Advance only with zero stalls/safety/provenance failures, reconstructed behavior-log-probability error
at most 1e-3, approximate KL at most 0.02, clip fraction at most 0.20, behavior P30 ECE at most 0.10,
and paired development versus the current parent: true-win gain at least +3 points with simultaneous
lower bound strictly above zero, final-VP and post-15 lower bounds at least zero, censored first-30 upper
bound at most zero, and rounds-1–15 VP lower bound at least -2 points. Stop after three generations.

## B4. Fair v2 capacity study

Only after one valid teacher set, compare d128/l3/h4, d192/l3/h6, and d256/l3/h8. Do not vary depth.
Expected sizes are approximately 0.83M, 1.83M, and 3.20M parameters.

The frozen 959 ranges become three paired training replicates, not one range confounded with each width.
Each replicate produces a fixed 100,000-row teacher shard and a disjoint 100,000-row on-policy PPO shard;
all three widths consume the same immutable shards for that replicate:

| replicate | teacher source games | PPO behavior games |
| --- | --- | --- |
| R1 | 959000000–959004095 | 959010000–959014095 |
| R2 | 959100000–959104095 | 959110000–959114095 |
| R3 | 959200000–959204095 | 959210000–959214095 |

The added PPO ranges are reserved only by the separately reviewed superseding width protocol; all remain
closed until then. Both shards use the B1 cap/dedup/target-segregation rules and the same valid teacher arm.

This nine-arm reinterpretation requires a separately reviewed superseding width authorization before
any 959 seed is consumed. All arms receive the same fixed parent-policy/search-distillation curriculum;
warm d128 versus scratch-wide is forbidden. Replicates use initialization seeds 34051101, 34051201, and
34051301 respectively for all three widths, and row-order base seeds 34051102, 34051202, and 34051302.
For epoch `e` and stream `s`, use `PCG64(base + 10*e + s)` under the same sorted-id/wraparound rule as B3. Each
arm receives the exact 447-by-two update schedule and identical row identities/order for its replicate.
Evaluate all nine checkpoints on the shared paired 959900000–959904095 development block.

Capacity inference compares d192 and d256 against the matched d128 within each replicate. Use 10,000
complete-development-seed draws from `PCG64(34052026)` with a centered max-absolute-t family containing
true-win, final-VP, and post-15 deltas for all six within-replicate contrasts plus the same three pooled
endpoints for each wider family (24 endpoints total). The pooled endpoint clusters all three replicate
rows by engine seed and replicate. Use the 95th nearest rank and fixed two-sided 24-endpoint normal floor;
zero-SE endpoints use their point estimate. Retain d128 unless a wider family has a positive true-win point
delta in at least two of three replicates, pooled true-win point gain at least +2 points with simultaneous
lower bound strictly above zero, pooled final-VP and post-15 lower bounds at least zero, and no individual
replicate true-win lower bound below -3 points.

Run separate heuristic-field and exploiter probes on preregistered ranges 959910000–959913071 and
959920000–959923071. Require no simultaneous lower bound below -3 true-win points relative to matched
d128. Direct serving must meet 1,000 ms p95 for one active game and 2,000 ms p95 for eight concurrent
games in both solo and four-seat scheduling. These ranges and their family are bound by the superseding
width protocol before use.

Add a real-ragged v2 forward/backward benchmark across batch 256/512/1024/2048/4096 and random versus
candidate-count bucketing. Record padding, optimizer updates, KL, clip fraction, entropy, gradient norm,
and wall time.

The winning width never hands a lucky replicate directly to multiplayer. Deterministically retrain the
selected architecture from the same pre-width parent on the pooled three-replicate training shards with
initialization seed 34051999 and row-order seed 34051998. Use the same 224 PPO + 224 teacher + 64 anchor
batch, exactly 1,340 updates per epoch for two epochs: each 300,000-row PPO/teacher pool is traversed once
plus 160 deterministic wraparound rows per epoch; the 25,000-row anchor is traversed three full times plus
10,760 rows from the next continuing-generator permutation. Derive epoch/stream seeds from row-order base
34051998 by the same `base + 10*e + s` rule. Evaluate this handoff checkpoint on fresh paired seeds
959930000–959934095 against the pre-width parent with a five-endpoint 10,000-draw max-absolute-t family
from `PCG64(34053026)` and the same B3 point/bound gates. It must also repeat the heuristic, exploiter, and
latency gates. If it fails, width transfer is rejected and the pre-width parent—not a replicate—enters B5.

## B5. Multiplayer training before final hidden

The current 960 development/hidden ranges are evaluation-only. If zero-shot multiplayer fails and the
policy is trained afterward, earlier final solo-hidden evidence becomes stale. Therefore the corrected
order is:

1. solo development-qualified candidate;
2. 2-player-heavy, then 3-player, then 4-player/PFSP training;
3. solo development regression after each stage;
4. freeze the final policy;
5. only then open final solo hidden and multiplayer hidden.

Reserve new training-only ranges in a separate protocol before use:

- 2-player training: 961000000–961099999;
- 3-player training: 961100000–961199999;
- 4-player/PFSP training: 961200000–961299999.

After the 9615 exploiter stage described below has produced and hash-frozen all four opponent manifests,
but before any candidate multiplayer learner update, run the existing 512-game canary
960000000–960000511 once with 176 two-player, 144
three-player, and 192 four-player games, exact seat/stratum balance, and frozen production/archive/heuristic/
exploiter strata. It establishes the zero-shot baseline and must have zero stalls and valid direct-v2
provenance; it neither opens nor substitutes for final development.

Retain exactly 25% immutable solo-anchor rows in every multiplayer optimizer batch. Supervise solo reach
heads only on solo rows; multiplayer rows use seat-balanced placement/outcome value. Opponents include
production, archive, heuristics, main exploiters, and league exploiters. Two-player training starts from
the solo-qualified checkpoint; three-player starts only from the passing two-player checkpoint; four-
player/PFSP starts only from the passing three-player checkpoint.

Exploiters are not trained ad hoc. Freeze their recipes, initialization seeds, parent/opponent pools,
checkpoint cadence, and selection rule before use. Reserve 961500000–961529999 for the main exploiter,
961530000–961559999 for the two-player league exploiter, 961560000–961589999 for the three-player league
exploiter, and 961590000–961619999 for the four-player league exploiter. Each produces an immutable
training ledger and checkpoint manifest; every development/final field binds exact exploiter hashes.
PFSP may adapt weights only among those manifest-bound checkpoints using its own training outcomes.

The two-player and four-player stages get 10,000 development games at 961400000–961409999 and
961420000–961429999. The three-player stage gets exactly 9,996 games at 961410000–961419995, divisible
across three seats and four opponent strata; 961419996–961419999 remain permanently unused. Each stage
advances only with zero stalls/provenance failures,
pairwise score at least 0.55 against the frozen field with a one-sided 95% lower bound above 0.50, and
no opponent-stratum point estimate below 0.45. Each stage also replays a 4,096-game paired solo
regression block: 961300000–961304095, 961310000–961314095, and 961320000–961324095. Across three stage
slots and three solo endpoints (true win, final VP, post-15 VP/round), use 10,000 complete-seed global
draws from `PCG64(34062026)`, centered max-absolute-t, the 95th nearest rank, and the fixed two-sided
nine-endpoint normal floor. Relative to the frozen pre-multiplayer solo candidate, require true-win point
loss no worse than -2 points and simultaneous lower bound at least -5, final-VP lower bound at least -0.5,
and post-15 lower bound at least -0.025. Each stage and the final checkpoint must also pass direct-v2
serving at 1,000 ms p95 for one game and 2,000 ms p95 for eight concurrent four-seat games.

Implement direct served-v2 seat-balanced league evaluation. A distilled-v1 proxy cannot prove raw-v2
Elo. The three 961 stage-development blocks total 29,996 games and are advancement checks, not the final
development campaign. After all training is frozen, separately open the existing 90,000-game final
development range 960010000–960099999, split it evenly across 2/3/4-player formats, and balance learner
seat and four opponent strata. Freeze the 960100000–960199999 hidden schedule analogously before opening
it.

## Compute and storage gates

The teacher is expected to require roughly 19.2M–64M simulated round-steps per generation. Benchmark
1,000 snapshots and extrapolate before full generation. The pilot may run for at most two hours. A teacher
generation may project at most 72 wall-hours for search and 96 wall-hours end to end; the three-generation
teacher/search/learner campaign may project at most 288 wall-hours. Any larger projection keeps teacher
authorization closed unless a newly reviewed protocol changes the budget. A100 memory is not the likely
bottleneck—CPU engine stepping, obs-v2 collation, and inference request granularity are.

One hundred thousand obs-v2 vectors alone are about 1.27 GiB binary before actions/state/provenance.
Require a dedicated durable Lane B root with at least 128 GiB free and a separate scratch root with at
least twice the pilot's peak temporary footprint. `/data/share8` currently has about 9 GiB free and
`/data/share11` about 9 GiB, so neither is authorized. The storage preflight must either bind a newly
provisioned filesystem/path or an agent-accessible content-addressed object-store prefix. In the object-
store case, shards may stage under `/dev/shm`, but every shard and ledger must be hashed, uploaded,
download-verified, and represented in an immutable durable manifest before the local copy is released.
No unrelated artifact may be deleted or moved to make room. The 1,000-snapshot pilot records compressed
bytes/row, action-trace bytes/row, shard overhead, peak scratch, upload/download throughput, and projected
three-generation total; the full run requires the greater of 128 GiB or 1.5 times that projection.
The action-trace projection alone must fit that same durable budget and must not exceed 25% of it. The live
preflight writes the concrete absolute filesystem root or exact bucket/prefix into the execution lock and
proves create/read/hash/delete of an unregistered probe object. A placeholder, `/dev/shm`-only location,
or unverified credential leaves all Lane B seeds closed.

## Promotion boundary

No Lane B checkpoint promotes from teacher fit, width, or solo score alone. It must still pass final
solo development/hidden, every guardian, direct-v2 multiplayer Elo, exploiters/collusion, regression,
hidden-information invariance, deterministic replay, production latency, Michael's disjoint replays,
and at least 50 fair live games. Production remains unchanged until a signed promotion manifest binds
every artifact hash.

## Mandatory Fable review questions

1. Are the snapshot bands and recovery classification information-safe and likely to supply enough
   ambiguous decisions?
2. Does the full-to-round-30 audit subset sufficiently prove teacher advantage beyond entropy?
3. Are the joint loss coefficients and discrete finish-hazard target conservative enough for the
   frozen V32 parent?
4. Is reinterpreting the three unused 959 blocks as paired width replicates defensible only through a
   superseding authorization?
5. Is moving multiplayer training before final solo hidden necessary and are 961 ranges adequate?
6. Is the 128-GiB storage gate appropriate given compressed snapshot/state shards?
