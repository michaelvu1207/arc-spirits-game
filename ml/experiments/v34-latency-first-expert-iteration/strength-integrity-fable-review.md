# V34 strength integrity Fable review

Reviewer: Claude Fable, high effort, read-only plan/tooling review

Date: 2026-07-14

Scope: final pre-Phase-2 strength plan, replay/provenance evidence, retry policy, simultaneous
statistics, immutable lock, and seed firewall.

## Findings and dispositions

1. **Provenance claims exceeded the emitted evidence.** The original wording implied per-decision
   counters while the locked evaluator actually enforces a served-checkpoint hash and cross-game
   summary-handshake invariant before report emission. The amended plan and manifests now describe
   evaluation-level provenance, derive covered summaries from the accepted report, and keep runtime
   serving/reload evidence separate.
2. **Exact replay across worker counts was not proven before registered seeds.** The strength preflight
   now runs 64 already-consumed preview seeds at 24 and 8 workers through the same GPU inference process,
   compares results by seed, and hash-binds the zero-mismatch audit before the strength lock can open.
   Each Phase 2 condition still repeats its registered 64-seed prefix through the same process.
3. **The original secondary gates accidentally required simultaneous superiority.** The win gate remains
   a +3-point effect with a simultaneous lower bound above zero. Final VP, post-15 VP/round, and censored
   round-to-30 now use explicit small non-inferiority margins of -0.5 VP, -0.025 VP/round, and +0.5 round.
4. **The narrow retry taxonomy can sacrifice a campaign to infrastructure failure.** This is retained
   deliberately: only structured pre-evaluation server-start failure and a trapped process interruption
   may receive one identical-seed retry. Evaluator exits, validation failures, missing reports, timeouts,
   and hard-crash remnants fail closed because a transient semantic instability must not be normalized.
5. **Filesystem immutability is procedural against a machine owner.** The plan now states the threat model:
   exclusive creation, read-only files, hashes, and locks protect against automation error and drift, not a
   malicious host owner. Completed waves are copied into local Git before later seed families open.

## Additional implementation corrections from the review cycle

- The exact remote Python preflight command now sets `PYTHONPATH=ml`.
- Statistical fixtures and analysis use the dedicated, protocol-pinned
  `ml/v34_stats_env/.venv/bin/python` (Python 3.12.8, NumPy 2.5.0), leaving the shared Torch inference
  environment unchanged.
- The Python analyzer independently reconstructs replay equality and the complete launch argv contract.
- Python protocol numbers use JavaScript-compatible CLI serialization, including `1.0 -> "1"` and
  `0.0 -> "0"`, so rerank-p100 and heuristic arms cannot be falsely rejected.
- Retry evidence, GPU occupancy failures, bounded server cleanup, and exact tooling inventory remain
  fail-closed.

No Phase 2 outcome was inspected or seed consumed during this review.

## Final re-review

After the dispositions above were implemented, Fable re-read the final plan and all locked strength
tooling and reported **no remaining important blockers**. It confirmed the preview-seed replay preflight,
same-process condition replay, honest evaluation-level provenance, preregistered non-inferiority margins,
narrow fail-closed retry policy, exact 16-file lock, and explicit threat model are coherent. Its one minor
log-scanning suggestion was adopted by requiring zero traceback, runtime, exception, CUDA, or generic error
lines in the replay-determinism inference lifecycle.
