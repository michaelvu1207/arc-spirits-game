I've now traced every named finding through the source-locked implementation and its regression tests. Here is my final pre-authorization review.

---

# Final pre-authorization review — V35 P30 long-horizon campaign

**Scope reviewed:** `plan.md` and the source-locked files it directly names, focused on `analyze_v35_p30_long_horizon.py`, `v35_p30_phase0.py`, `v35_p30_authorized_execution.py`, `issue_v35_p30_preflight_authorization.py`, `run_v35_p30_cuda_determinism.py`, `run_v35_p30_campaign.py`, and the two named test modules.

## Prior-review findings — verification

**1. Quantitative confirmation gates — addressed.** `validate_protocol` hash-pins `confirmation-gates.proposed.json` (`sha256 a3aca14a…`, `frozenBeforeP30Outcomes: True`) and verifies the file on disk. The analyzer enforces the decision family numerically: exact paired sign-flip inference (`paired_replicate_sign_flip`, 262,144 enumerations), Holm correction across the six primary tests, and the frozen safety gates (`minimumTrueWinPointGain 0.03`, `≥13/18` positive replicates, `≤2/18` below `-0.01`, latency/stall/malformed/guardian floors). Phase 5's held-out and Michael gates are enumerated as a machine-readable contract, not prose.

**2. Divergence classification — addressed.** CUDA primary/replay divergence is treated as an integrity failure: `run_v35_p30_cuda_determinism.run` raises (fail-closed, closes the instance) on any per-game or replay-hash mismatch, and requires distinct socket inodes. Runtime failures are classified through the bounded `PRE_CHILD`/`RECEIPT_ONLY` state machine, with every ambiguous/second/child-started-without-sealable-draft case forced to terminal close (`ensure_recovery_execution_draft`). Training-quality failure is explicitly barred from infrastructure recovery.

**3. Realized-dose telemetry — addressed.** `validate_generation_dose_telemetry` checks applied counts and realized dose per band (1–8, 9–18, 19–30), reconciles `dose = applied × coefficient` and the summed realized dose, and enforces the treatment-enabled/disabled invariant. These are sealed manipulation-check quantities that cannot influence scheduling or selection; the analyzer surfaces `realizedDose` per replicate for inspection only.

**4. Duration/storage go-no-go — addressed.** `require_preflight` fails closed unless `projectedCampaignComputeSeconds ≤ maxCampaignComputeSeconds` (1,209,600 s / 14 days) and `projectedFinalFreeBytes ≥ 6 GiB`, then re-checks live headroom against the signed conservative projection. `set_storage_reservation` uses `posix_fallocate` with a sparse-detection guard and fsync of file+parent; the 25% safety factor and 512 MiB evaluation reserve are embedded.

**5. Local-only review provenance — addressed.** `validate_gate_review_receipt` binds a `review-attester` signature over a pinned container config (digest-pinned image, read-only root/capsule, zero caps, no-new-privileges, seccomp, fd-0-only OAuth via `CLAUDE_AUTH_DELIVERY`), the launcher SHA-256 (`gate_review_launcher_sha256`), authenticated-liveness and cross-host clock preflights, exact argv/prompt, verified container cleanup, empty stderr, and `VERDICT: ACCEPT` as the last nonempty stdout line. The one-shot `scp`-creates-then-seals fetch is regression-tested.

**6. One-shot launch/signing boundaries — addressed.** The executor launch permit binds `executorProcess` identity (pid/startTicks/uid/host/bootId) and is single-use; `validate_authorization` rejects forged/replayed/stale permits, validates consumed markers against start time, and enforces the analysis one-shot reentry rejection and sealed-memfd `--ro-bind-data` capability transport. No private key reaches candidate code.

**7. Exact-stack determinism — addressed.** The CUDA preflight pins `CUBLAS_WORKSPACE_CONFIG`, `CUDA_DEVICE_ORDER`, `NVIDIA_TF32_OVERRIDE=0`, `TORCH_ALLOW_TF32_CUBLAS_OVERRIDE=0`, `PYTHONHASHSEED`, batch/window/worker shapes, and the exact evaluator argv, then requires bitwise per-game and replay-hash equality across two fresh servers.

## Most-recent incident fix (instance `33641f25…`) — verified

Both `run_v35_p30_analyzer_rehearsal.py` and `run_v35_p30_cuda_determinism.py` are now treated as nested-isolation controllers. The issuer (`issue_v35_p30_preflight_authorization.build`) appends `/proc/driver/nvidia` **only** for `fault-injection`; the executor (`validate_nested_controller_mount_contract`, called unconditionally in `validate_authorization`) rejects any controller in `NESTED_ISOLATION_CONTROLLERS` if that submount is present. Regression coverage exists on **both** sides: the executor test asserts rejection/acceptance for all three nested controllers, and the issuer test asserts analyzer-rehearsal omits the submount while fault-injection includes it.

## Residual observations (non-blocking)

- **P3 (test completeness):** the issuer regression test asserts the mount contract explicitly for `analyzer-rehearsal` and `fault-injection` but not `cuda-determinism`. The issuer adds the submount only in the `fault-injection` branch, so cuda-determinism is covered by construction and by the executor guard test; an explicit issuer assertion for cuda-determinism would tighten the proof but is not required for safety.
- **Governance precondition, not a defect:** per the plan's own stop rule (instance `33641f25…` closed before generation two), the next production launch requires *both* a new Fable-reviewed design *and* an explicit user cumulative-spend decision (current cross-instance budget: 1,319.47 GPU-lease seconds, 16,384 games, 17,952,933 retained bytes across six closed instances). This review satisfies the design-review gate only. Launch remains contingent on that explicit cumulative-spend decision and on the runtime guardian gates (Phase-0 readiness, gen-1 preflight, full-campaign authorization) the scheduler independently enforces — none of which an ACCEPT here bypasses.

## Conclusion

All seven prior-review findings are concretely and verifiably addressed in the source-locked implementation, the most recent nested-isolation incident fix is implemented and regression-tested on both the issuer and executor sides, and the fail-closed enforcement machinery is internally consistent. I find no remaining P0 or P1 defect in the reviewed artifacts. The outstanding cumulative-spend decision is a required human authorization the protocol correctly defers to the user, not an unaddressed blocker in the design.

VERDICT: ACCEPT
