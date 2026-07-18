# V34 guardian execution and tooling plan

Status: outcome-blind draft for mandatory Fable review. No Phase 2 report or outcome was read while
writing this plan. Guardian seeds remain closed.

## Purpose and immutability boundary

Guardian confirmation is an independent robustness filter for every V34 Phase 2 core-passing arm. It
must never rescue a Phase 2 failure, pool Phase 2 and guardian observations, or reorder Phase 2
survivors. The first surviving arm in the preregistered Phase 2 ranking advances; if none survives,
Lane A closes.

Do not modify the existing 16-file strength-tooling inventory, `strength-protocol.json`, either V34
lock, or any completed Phase 2 artifact. Add a separate guardian protocol and exact new-file
inventory that hash-bind the old source/strength locks. Commit and lock all guardian statistics,
runner behavior, schemas, and adversarial fixtures before the Phase 2 analyzer is executed.

## Outcome-independent tooling and lock layers

Create these new source files only:

1. `guardian-execution-protocol.json`
2. `guardian-tooling-fable-review.md`
3. `scripts/v34-guardian-tooling-files.mjs`
4. `scripts/validate-v34-guardian-protocol.mjs`
5. `scripts/record-v34-guardian-authorization.mjs`
6. `scripts/run-v34-guardian-preflight.sh`
7. `scripts/record-v34-guardian-preflight.mjs`
8. `scripts/lock-v34-guardian-tooling.mjs`
9. `scripts/lock-v34-guardian-execution.mjs`
10. `scripts/verify-v34-guardian-chain.mjs`
11. `scripts/run-v34-guardian-confirmation.sh`
12. `scripts/record-v34-guardian-condition.mjs`
13. `scripts/test-v34-guardian-condition.mjs`
14. `ml/analyze_v34_guardian.py`
15. `ml/test_analyze_v34_guardian.py`

The pre-outcome guardian-tooling lock binds the exact files above, this plan/review, the original V34
source lock, the strength-tooling lock, the frozen strength protocol, the catalog, checkpoint, pinned
Python/NumPy runtime, and a passing synthetic preflight. It opens no seeds.

After all seven Phase 2 completions are independently verified, copied locally, and committed, run the
already-locked Phase 2 analyzer exactly once. The authorization recorder independently revalidates the
analysis and writes one immutable artifact:

- If `K=0`, record `guardianSeedsOpen:false`, `authorizedArms:[]`, and `laneAClosed:true`. Do not create
  a guardian execution lock or consume a guardian seed.
- If `K>0`, authorize exactly the core-passing arms in registered-slot order. Freeze a separate
  `phase2RankedArms` list by descending Phase 2 paired win gain, ascending systems binding-w8 p95,
  then lexicographic arm id. Every later authorization remains false.

Only for `K>0`, run the live SimForge preflight and create an immutable guardian-execution lock that
binds the tooling lock, Phase 2 completions and analysis, guardian authorization, live preflight, and
exact authorized-arm set. This lock alone opens guardian execution.

## Frozen guardian experiment

- Reference: raw V32 checkpoint under the unchanged V34 decode.
- Candidates: exactly every authorized Phase 2 core passer; no omissions.
- Conditions: exactly one shared raw condition plus `K` authorized candidate conditions. Run raw once
  and pair the same raw row against every candidate by seed.
- Seeds: exactly `957300000..957308191` (8,192) per condition.
- Guardians: the ten ordered `{id,name}` records already frozen in `strength-protocol.json` and the
  frozen catalog.
- Assignment: guardian index `seed % 10`, depending only on engine seed. Counts must be exactly
  `[820,820,819,819,819,819,819,819,819,819]` in frozen guardian order and identical in every
  condition.
- Workers: raw 24; each candidate uses its systems-selected binding worker count.
- GPUs: only 0, 5, 6, or 7; GPU 4 is forbidden. At most three conditions and 96 actor workers.
- Decode/checkpoint/catalog/evaluator/inference wire: byte-for-byte equivalent to Phase 2.
- Guardian decision latency p50/p95 is non-binding telemetry. The previously frozen systems
  binding-w8 p95 remains the ranking tie-break.

Each primary 8,192-game condition keeps one inference process alive for an exact 64-seed prefix replay
(`957300000..957300063`) at eight workers. Compare complete game rows by seed. Require one
serving/shutdown lifecycle, zero reload/error lines, one checkpoint handshake, exact report provenance,
and exact replay equality. This establishes evaluation-level, not per-decision, provenance.

## Frozen statistic

For each authorized arm `j`, guardian `g`, and assigned seed `i`, define
`D[j,g,i] = 100 * (candidate_true_win - raw_true_win)` in percentage points.

Use 10,000 global complete-seed cluster draws from `numpy.random.Generator(PCG64(34032026))`. Each
draw samples 8,192 seed indices with replacement once and applies that same draw to all arms. Compute
each guardian-cell mean from sampled rows assigned to that guardian; guardian cells are large enough
that an empty sampled cell is effectively impossible. Any empty sampled cell is a structural analysis
abort, not an arm-level failure.

For every observed nonzero-SE cell `e`, compute
`t[b,e] = (bootstrap_mean[b,e] - observed_mean[e]) / original_paired_SE[e]` and
`T[b] = max_e(t[b,e])`. The simultaneous critical value is the 95th nearest-rank draw
(`ceil(0.95*10000)-1`), floored at `NormalDist().inv_cdf(1 - 0.05/60)`. The empirical maximum uses
the observed `K*10` cells, while the floor always preserves the frozen maximum six-arm by ten-guardian
family. A cell lower bound is `observed_mean - critical * SE`.

`original_paired_SE` is the sample standard deviation of the per-seed paired percentage-point
differences within that guardian cell using `ddof=1`, divided by `sqrt(n_cell)`.

Zero-SE cells are excluded from `T`; their lower bound equals their point estimate. A cell passes only
when its point delta is at least -5 percentage points and its simultaneous lower bound is strictly
greater than -10 points. An arm survives only when all ten cells pass.

Guardian outcomes filter the frozen Phase 2 ranking but never reorder it. Select the first ranked
survivor, or close Lane A if none survive. Guardian analysis opens no teacher, final-development,
hidden, multiplayer, human, or promotion seeds.

## Structural validity, measured failures, and retries

Structural faults abort confirmation rather than becoming model outcomes: missing/duplicate seeds,
wrong guardian assignment, pair mismatch, changed argv/decode, checkpoint/catalog/source mismatch,
malformed report, replay mismatch, serving lifecycle error, or missing condition.

A structurally valid candidate report may record a measured stall. It receives an immutable completion
manifest but the candidate fails confirmation. Any raw stall or raw safety/provenance failure aborts the
whole gate because the reference is invalid. Candidate safety/provenance failures other than a measured
stall are structural and abort the gate; they are not exploitable arm-level losses.
This is a deliberate fail-closed strictification of the frozen protocol's per-arm
`safetyAndProvenanceFailures: 0` wording: untrusted evaluation provenance invalidates the shared
campaign rather than merely lowering one candidate.

Because the committed protocol names exactly one guardian seed range and no reserve family, any
structural fault after a registered guardian seed has been consumed permanently closes guardian
confirmation and Lane A. No fresh family may be invented and no partial evidence may be repaired or
pooled. Continue Lane B from raw. A failure before any registered seed is consumed does not close the
lane and may be corrected under a newly reviewed and locked preflight.

Permit one identical-full-seed retry only for immutable attempt-1 `server-start`/90 or trapped
`process-interrupted`/92 evidence, only when neither primary nor replay report exists. The prelaunch
manual reason is outcome-blind and infrastructure-specific. Never splice attempts. Evaluator failure,
timeout, report existence, missing/malformed report, replay failure, hard-crash remnants, or attempt-2
failure closes the condition without another retry.

## Runtime and resource contract

Acquire a guardian condition-slot flock, guardian GPU flock, and the corresponding legacy Phase 2 GPU
flock. Query the selected GPU UUID and require an empty compute-app list both after locking and
immediately before server launch. Record an immutable prelaunch resource snapshot with UTC/host,
source/tooling/execution-lock hashes, GPU index/UUID, empty compute list, lock names, workers/concurrency,
scratch and persistent free bytes, load, and MemAvailable.

- Watchdog: 46,800 seconds plus 60-second kill grace; timeout is not retryable.
- Scratch: at least 16 GiB free.
- Persistent storage: at least 1 GiB per remaining condition plus a 2 GiB floor.
- RAM: at least 64 GiB MemAvailable immediately before launch.
- CPU load is recorded but not gated because the shared machine has unrelated jobs and the outcome gate
  does not depend on wall time.

All locks and resource gates run before creating an attempt directory, retry justification, or server
process. A resource failure therefore consumes no attempt and may be retried unchanged when resources
are available.

The runner never analyzes results. Every attempt, report, log, completion, manifest, and hash sidecar is
exclusive-create and made read-only. After the full guardian wave, copy and commit all immutable inputs
before running analysis or opening any later seed family.

## Adversarial verification and preflight

Before guardian seeds open, test exact arm parameters, authorization order, seed coverage, guardian
counts and identity, raw/candidate pairing, global shared-draw reproducibility, one-sided max-t sign,
fixed-60 ghost penalty, zero-SE and boundary behavior, K=0 closure, Phase 2 ranking freeze, candidate
stall rejection, raw stall abort, retry inventory, report/replay/serving corruption, lock/hash/argv
tampering, missing conditions, immutable creation, and all later-authorization flags.

Run deterministic engine, information-safety, TypeScript, Python, shell syntax, recorder fixtures,
statistical fixtures, replay-determinism, and live resource gates locally and on SimForge. Record the
exact versions, commands, exit codes, stdout/stderr hashes, and inventory in immutable preflight
evidence.

The preflight must import the source-locked `guardianIndexForSeed` implementation and run the
source-locked evaluator on non-guardian seeds to prove that `absolute-balanced` currently means
`seed % guardianCount` in frozen catalog order. It must independently derive the expected
`[820,820,819,819,819,819,819,819,819,819]` registered-range counts rather than asserting a fixture
against a duplicated formula.

Statistical fixtures must also estimate the family-level false-closure rate of the frozen unadjusted
-5-point cell gate across realistic paired disagreement rates. This is interpretation evidence only;
it cannot weaken the committed gate. The fixed-60 normal floor is expected to dominate the empirical
critical value for realistic `K`, and the analysis must report which term selected the final critical
value.

The new authorization and execution artifacts are authoritative for guardian state. The immutable
`strength-protocol.json` remains the historical closed-at-creation contract, so the chain verifier must
explicitly reject any attempt to infer current authorization from its permanently false seed flags or
`guardianResult: null`.

Candidate stalls are arm-level failures only when the evaluator completes an otherwise structurally
valid full report and a `GameSummary.stalled === true` row is deterministically reproduced by the
same-process prefix replay when the stalled seed lies in that prefix. Runtime, inference, timeout, or
report-construction failures must never be reclassified as model stalls.

## Questions for the mandatory Fable review

1. Does global complete-seed resampling best match the committed guardian language, or should sampling
   be stratified within guardian while sharing draws across arms?
2. Is candidate measured-stall rejection versus raw-stall whole-gate abort consistent and fail-closed?
3. Is the same-process 64-seed guardian replay a valid clarification of the existing serving contract?
4. Are the pre-outcome tooling lock and post-authorization execution lock sufficient without mutating
   the existing strength lock?
5. Is the observed-cell empirical maximum plus fixed-60 normal floor valid when `K<6`?
6. Are the watchdog, persistent headroom, and 64-GiB RAM thresholds operationally sound?
7. Are K=0 closure and malformed/missing-condition semantics unambiguous?
