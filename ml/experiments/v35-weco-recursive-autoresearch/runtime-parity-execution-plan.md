# V35 Runtime Action-Trace Parity Execution Plan

Status: public systems preflight only; outcome-blind; strength, private, and
promotion flags remain closed.

## Purpose

Prove that the head-sharing inference repair changes neither the selected game
commands nor deadline advances for a new public corpus before any latency or
strength comparison. This is a rejection gate, not evidence that the optimized
bot is stronger.

## Immutable source pair

- Legacy runtime base: `0239cb8e6524ce0548a398d94a186cda590d48e1`.
- Legacy runtime plus the common trace instrumentation:
  `5574310327a19a609eb3713bff76efe48535aa91`.
- Optimized runtime plus the same trace instrumentation:
  `07dc5e2a183a3f8dbb3ad1719fc228da7d7508af`.
- The only tree differences between the instrumented commits are
  `ml/infer_server.py`, `ml/model_v2.py`, `ml/test_infer_server.py`, the accepted
  runtime plan/reviews, and the runtime microbenchmark artifact. The six trace
  instrumentation/evaluator files are byte-identical between both commits.

The authorization created after this review must bind archive SHA-256 values,
the exact per-file hashes, and the complete `git diff --name-only` allowlist. A
machine check must fail if any path outside that allowlist differs.

## Frozen gameplay inputs

- Checkpoint:
  `ml/experiments/v35-weco-recursive-autoresearch/league/rep-a/p30-credit025/checkpoints/main-0-gen8.pt`,
  SHA-256
  `c799ee8587c5a82013dd06830eab7818b359a07944629a236de3dd1d2bd24e91`.
- Catalog SHA-256:
  `62203ec1b981c2e59f129db54cf1863639f605f331ed8d7408c53693c941bc59`.
- Candidate: public-pilot champion `f4e6230e8d983dbc`, canonical SHA-256
  `f4e6230e8d983dbc65c25ab7132f9b9d24dc2c0d6567c1628fd70634416b7d18`.
- Exact evaluator suffix, matching the frozen eight-significant-digit public
  pilot invocation:

```text
--temperature 0.70727915
--search-sims 4
--search-objective solo-reach30
--search-horizon 6
--search-frac 0.84868158
--search-value-weight 0.25337527
--search-rollout policy
--search-nav-temperature 0.01453346
```

Every game uses one seat, round cap 30, public status level 2, absolute-balanced
guardians, greedy policy selection, and binary inference wire format.
All search, rollout, policy-pick, and environment RNG streams are derived from
the individual game seed by the hash-bound driver/planner implementation; no
process-shared RNG may depend on worker completion order.

## Public seed contract

The accepted runtime inventory authorizes
`969060000..969060063`. It proves disjointness from the hash-pinned structured
declarations and remote metadata sweep, not absolute historical non-use.

- Functional isolation: first 8 seeds, `969060000..969060007`.
- Operational parity: all 64 seeds, `969060000..969060063`.

Functional reuse inside the operational corpus is intentional: this lane tests
two runtime batching regimes and is not a statistical strength evaluation.

## Execution order and runtime settings

Run exactly four sequential jobs on physical GPU 7 in ABBA source order:

1. legacy functional: 1 actor worker, inference window 0 ms, max batch 1;
2. optimized functional: 1 actor worker, inference window 0 ms, max batch 1;
3. optimized operational: 24 actor workers, inference window 2 ms, max batch 512;
4. legacy operational: 24 actor workers, inference window 2 ms, max batch 512.

Each job starts a fresh inference process, performs one evaluator invocation,
then shuts the process down cleanly. No server reload is allowed. Bind the GPU
UUID, driver, CUDA, PyTorch, cuDNN, deterministic flags, argv, source archive,
checkpoint, catalog, and evaluator hashes.

## Outcome blindness and artifacts

The evaluator writes its full public report only into a new mode-0700 remote
attempt directory. Neither a human nor an agent may open the strength fields.
A trusted comparator may read only:

- source/checkpoint/catalog/inference provenance;
- requested seed interval and row coverage;
- `stalls`;
- the opt-in `(seed, replayTraceSha256)` rows;
- inference process lifecycle/error counts.

The comparator emits only coverage, mismatch counts, per-setting trace-root
hashes, provenance hashes, lifecycle counts, and pass/fail. It must not emit VP,
win, round, guardian, cycle, latency, or search-quality values. Hash raw reports,
stdout, stderr, inference logs, environment, and exit codes before the parity
result is opened. Preserve the sealed raw files for audit without inspecting
them.

The comparator is trusted code with access to sealed reports. Its exact file
SHA-256 must be included in the authorization. Its stdout is the only artifact
that may be opened. Every evaluator and inference process must be launched
without a TTY, with stdout and stderr redirected directly into the mode-0700
sealed directory; do not tail or display those files. Hashing uses `sha256sum`
on file paths and records only the resulting digests, never a tool that renders
file contents into an agent context.

The trace schema is also part of the gate. It contains, in order, only cloned
successful setup commands, successful live heuristic commands, selected live
neural commands, and successful deadline advances with their pre-advance
revision/round/phase. It contains no timestamps, latency, worker identity,
batch identity, model output, outcome, or other timing-dependent value. The
authorization binds the six byte-identical instrumentation/evaluator hashes
and mechanically verifies equality across both source commits.

## Resource and isolation rules

- Claim exactly physical GPU 7 using a unique lease; GPUs 4-6 are forbidden.
- Every Python/evaluator process receives
  `CUDA_VISIBLE_DEVICES=GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0`, not a numeric
  ordinal. The environment manifest must show PyTorch sees exactly one CUDA
  device and that device's bound properties. Recheck that no parity process is
  alive and GPU 7 is back to 0 MiB after every job. Record before/after all-GPU
  process accounting without displaying unrelated command lines.
- Verify GPU 7 UUID
  `GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0`, 0 MiB used, and 0% utilization
  before the lease.
- Do not start if `/data/share8` has less than 8 GiB free or if remote `/tmp`
  cannot hold both source archives, extracted trees, and sealed reports.
- Extract the two hash-bound Git archives under remote `/tmp`; link only the
  existing `node_modules` and `ml/.venv`. Never mutate the shared source tree,
  checkpoint, or dependencies.
- Delete only the two disposable extracted trees after hashing. Preserve the
  compact sealed attempt and parity result under the V35 artifact directory.

## Gate and failure policy

Pass only if all four jobs have exact seed coverage, valid 64-hex trace hashes,
zero stalls, identical frozen checkpoint/catalog/candidate provenance, one
server start and one clean shutdown per job, no reload, and no
inference/evaluator error. Compare exactly:

1. legacy functional versus optimized functional on all 8 functional seeds;
2. legacy operational versus optimized operational on all 64 operational seeds;
3. legacy functional versus legacy operational on the shared first 8 seeds;
4. optimized functional versus optimized operational on the shared first 8 seeds.

Every comparison must have zero trace mismatches. The two cross-runtime checks
prove the repair does not change actions in either batching regime. The two
within-runtime checks prove asynchronous batch composition did not itself
change actions on the shared control seeds. A within-runtime mismatch classifies
the preflight as `batching-control-invalid`, not as evidence against either
runtime, and still prevents advancement.

Any cross-runtime trace mismatch, missing/duplicate seed, semantic error,
provenance drift, GPU-scope violation, source/archive drift, or outcome
disclosure rejects the optimization. A within-runtime mismatch invalidates the
batching test as described above. Do not retry or replace a semantic result. An
infrastructure failure before any report is complete requires a new reviewed
amendment; it does not authorize an ad-hoc retry. Passing this gate authorizes
only the separate 256-pair public outcome-blind latency precheck.
