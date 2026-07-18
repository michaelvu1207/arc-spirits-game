# Fable high re-review: V34 B1 density-smoke integration, attempt 2

Reviewed: 2026-07-15

Verdict: **PASS**

Supersedes: b1-smoke-integration-fable-review-attempt1.md

The reviewer verified that all three attempt-1 blockers are resolved:

1. The lock builder, verifier, and orchestrator use the real
   `expectedExecutionProviderBindingCanonicalSha256` key, independently recompute the canonical
   execution-provider hash, and reject the stale key.
2. Both sides validate the exact `targetDeletionInvariance` object, including no target read/hash,
   unlink-only deletion, one freezer run, exact ledger verification, and unchanged hashes.
3. The durable consumed marker, structured result/failure evidence, and final report are direct
   siblings of the execution lock outside the absent scratch root. The durable success path is
   `b1-density-smoke-attempt-1.orchestrator.result.json`; publication is self-owned, exclusive, and
   no-redirection.

The reviewer also verified:

- A real lock built by `buildV34B1DensitySmokeExecutionLock` is accepted by the exact orchestrator
  launch-plan validator, closing the fixture-masking gap.
- The merger contract is `collector-exported-bounded-16-way-feature-only-merge-v1` with exactly 16
  feature files and fan-in 16.
- The required `strict-environment-preflight` is exact, five-key, zero-game, outcome-blind,
  provider-bound, and fail-closed while its real GPU7 evidence file is absent.
- Basis creation is impossible until the real strict-environment evidence and this PASS exist and
  validate.
- The consumed marker is durable and exclusive-create before the attempt root; result XOR failure and
  the durable report are new-only and hash-verified.
- The storage probe, 16 x 32 unregistered seed ledger, GPU7-only boundary, feature-only postflight,
  freezer floors/caps, 1,000 trace replays, and failure classes match the reviewed plan.
- Registered collection, teacher search, training, development/hidden evaluation, human, promotion,
  deployment, Phase 2 outcome, and future-target-reading gates all remain closed.

Authorized order only: commit the reviewed files; run the zero-game strict-environment preflight on GPU
7; then create the basis, run the storage probe, and run the single unregistered 512-game density smoke
only if every intervening runtime gate passes.

PASS
