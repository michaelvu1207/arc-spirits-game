# Fable high review: V34 B1 density-smoke integration, attempt 1

Reviewed: 2026-07-15

Verdict: **BLOCK**

The reviewer found the safety architecture sound and fail-closed, but identified three integration
defects that make the real lock/orchestrator launch unsatisfiable:

1. The orchestrator read `providerBindingCanonicalSha256`, while the real lock emits
   `expectedExecutionProviderBindingCanonicalSha256`; hand-built fixtures masked the drift.
2. The orchestrator required a nonexistent `targetDeletionInvarianceRequired` boolean instead of the
   lock's bound `targetDeletionInvariance` object; fixtures again masked the drift.
3. Bound orchestrator stdout/stderr paths were inside the attempt root even though the lock requires
   that root to remain absent until the orchestrator creates it. An external launcher could not create
   or redirect to those paths without invalidating the lock.

Required fixes:

- Align the two lock keys and validate the actual target-deletion contract.
- Move or self-publish durable orchestrator result/failure evidence outside the scratch attempt root.
- Add an integration test that sends a real lock-tool output through the orchestrator launch-plan
  validator.

Non-blocking recommendations accepted for this revision:

- Keep the consumed marker and final report durably outside `/dev/shm` so a reboot cannot erase the
  evidence and make an immutable lock appear unconsumed.
- Confirm the no-game server preflight under the exact stripped five-key child environment.
- Reconcile the feature-merger `bounded-128-way` label with its actual fan-in of 16.

No authorization basis, storage write, game, seed, outcome, registered gate, or promotion was opened
after this BLOCK.
