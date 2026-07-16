All verification is complete. Here is the final pre-authorization review.

# Final pre-authorization review — V35 P30 long-horizon campaign (v14)

I read the plan (including the four incident amendments and the v12/v13 review amendments), both prior rejected reviews, and re-verified the enforcement closure first-hand: `v35_p30_phase0.py`, `run_v35_p30_gate_review_local.py`, `test_v35_p30_phase0_gates.py`, and `issue_v35_p30_preflight_authorization.py` in full; the complete scheduler `run_v35_p30_campaign.py` and role runner `run_v35_p30_role.py`; plus the hash-bound `confirmation-gates.proposed.json`, the CUDA determinism runner, and the realized-dose audit in `audit_v32_generation.py`.

## The v13 P1 is concretely fixed, end to end

The v13 blocker was that `validate_gate_review_receipt` bound the review request to `ledger/reviews/<mode>/review-request.json`, a file nothing ever creates, while the scheduler and launcher used `ledger/requests/<mode>-fable-review.json`. All four sides now bind the same bytes at the same canonical path:

- `gate_review_paths()` returns `request` = `ledger/requests/<mode>-fable-review.json` (`ml/v35_p30_phase0.py:71-74`), which is exactly `_request_path(protocol, f"{mode}-fable-review")`.
- The scheduler's `_review_required_status` emits the request via `emit_request` (which physically writes that file) and binds `reviewRequest` to that same path (`ml/run_v35_p30_campaign.py:292-314`, `1360-1391`).
- The launcher copies `status["reviewRequest"]` verbatim into the receipt (`ml/run_v35_p30_gate_review_local.py:410`), and the remote validator compares it to `binding(paths["request"])` (`ml/v35_p30_phase0.py:187`) — same path string, same recomputed hash.
- The promised integration-style regression exists: `test_scheduler_and_validator_share_the_gate_review_request_binding` (`ml/test_v35_p30_phase0_gates.py:17-55`) constructs the real scheduler status and proves its `reviewRequest` equals `phase0.binding(gate_review_paths(...)["request"])`, binding the two sides rather than constructing the receipt from the validator's own expectation (the masking v13 called out).

I also confirmed no residual consumer of the old path: the role runner uses only `gate_review_paths(...)["receipt"]` directly (`ml/run_v35_p30_role.py:1385`, `1435`) and reaches the request binding solely through the corrected validator; the launcher's `inputs/review-request.json` is a local capsule copy only. Ordering is sound — `emit_request` durably writes the request before `phase0_binding` hashes it, and every later validation (`require_phase0_readiness`, `_attest_phase0_readiness`, `_authorize_full_campaign`, `require_full_campaign_authorization`) rehashes the persisted ledger file. The `emit_request` non-executor attempt guard cannot spuriously close the review lane, because gate-review receipts are uploaded by `scp`, never through a remote signing marker on the receipt path.

## Prior findings — re-verified as addressed

- **v12 P1 (fetcher).** `fetch()` requires an absent, non-symlink target, lets `scp` create it, lstat-verifies a regular file, recomputes the SHA-256, then chmods 0400 and fsyncs file and parent, unlinking on any failure (`run_v35_p30_gate_review_local.py:126-161`); regression at `test_v35_p30_phase0_gates.py:174-198`.
- **v12 provenance note.** The receipt binds `launcherSha256`, recomputed by the remote validator from the source-locked copy; a mismatched or manual launcher fails validation (`v35_p30_phase0.py:101-104`, `189`; negative test at `test_v35_p30_phase0_gates.py:321-339`).
- **Quantitative confirmation gates.** `confirmation-gates.proposed.json` matches Phase 5 exactly and conjunctively: 8,192 fresh public games with 6,631/7,431 win floors and the +0.05 paired-bootstrap bound; 4,096 private with 3,337/3,732 and 751-per-1,024 slice floors; Elo +50 overall / per-format ≥ 0 / seat spread ≤ 0.02; exploitability +0.03 / −0.01 / 0.40 / −0.02; zero-tolerance fairness and systems gates; 28/40 versus Michael with ties as non-wins.
- **Divergence classification.** `ensure_recovery_execution_draft` refuses PRE_CHILD once any invalid draft exists after `Popen`, treats a consumed token without a canonical draft as terminal, closes non-eligible kinds on any unsealed state, and every recovery phase is ordinal-1 with `secondRecoveryForbidden` and frozen `protected_bindings_sha256` (`run_v35_p30_campaign.py:529-600`, `663-724`).
- **Realized-dose telemetry.** `validate_reach30_credit` requires applied/dose telemetry for exactly bands 1-8/9-18/19-30, cross-checks band sums against totals, verifies dose = applied × the frozen per-band coefficient, requires applied > 0 for treatments and exactly 0 for control, and forbids scalar plus scheduled credit together (`audit_v32_generation.py:70-149`). Sealed in the audit; never feeds the scheduler.
- **Duration/storage go-no-go.** `_attest_preflight` fail-closes before signing if the projection exceeds the frozen 1,209,600 s ceiling or the 6 GiB + 512 MiB floor (`run_v35_p30_role.py:1271-1300`); `require_preflight` re-verifies the signed numbers non-discretionarily; `_rolling_budget_guard` recomputes remaining bytes/runtime from max(frozen, observed), maintains a real `posix_fallocate` reservation with an `st_blocks` sparseness check, releases one buffered action at a time, and returns to zero only after all 54 pairs seal (`run_v35_p30_campaign.py:111-167`, `1841-1923`, `2186`).
- **Local-only review provenance.** The gate-review lane signs via a local 1Password pipe into a `--sign-only` subprocess with the key never sent to SimForge; the remote attempt token is O_EXCL-reserved before Fable runs; the validator pins the exact Claude executable, 13-element sandbox argv, sanitized environment-key set, empty stderr, exact final `VERDICT: ACCEPT` line, and now the launcher hash.
- **One-shot launch/signing boundaries.** O_EXCL signing-attempt markers precede every non-executor key release and a marker without its artifact is terminal (`run_v35_p30_role.py:189-233`, `1705-1710`); executor launch permits bind protocol/source/action/request and are validated before token consumption and `Popen`; direct issuer CLIs are disabled.
- **Exact-stack determinism and incident amendments.** The CUDA preflight uses the pinned GPU7 UUID, the venv interpreter with separately hashed resolved bytes, TF32-disabling environment, binary-wire `--window-ms 2 --max-batch 512` server, protocol-frozen games/workers/seeds; the supervisor-precreated empty/nonempty/symlink/non-directory contract, the `/proc/driver/nvidia` exclusion for `cuda-determinism` only, and the 93/92-byte `/dev/shm/p/<campaign-id>` socket contract are each implemented and regression-tested (`run_v35_p30_cuda_determinism.py:41-50`, `issue_v35_p30_preflight_authorization.py:42-51`, `166-167`).

## Remaining P0/P1 launch blockers

None found. I specifically probed the repaired lane for new failure modes — receipt key-set completeness against the launcher payload, attempt/stdout/stderr hash bindings across the scp boundary, the source-contract hash equality between `inputs[2]` and the protocol pin, and interaction of the request file with the non-executor attempt guard — and each either matches exactly or fails closed.

## Non-blocking observations (P2, carried over)

- `require_preflight` re-checks the full-campaign byte projection against current free space on every scheduler call, which can spuriously halt a healthy campaign late in the run; it fails closed and outcome-blind, so this remains a liveness/cost concern only.
- The synthetic analyzer-rehearsal fixture still omits the per-band dose fields; acceptable because the audit side enforces them.
- `gate_review_launcher_sha256()` hashes the local Mac checkout while the remote validator hashes the source-locked remote copy; an unsynced checkout fails closed but burns the one-shot review attempt — sync before launching a review.

Both prior P1 blockers are concretely repaired with the binding-style regressions the amendments promised, all four incident amendments are implemented, and no new P0/P1 was found.

VERDICT: ACCEPT
