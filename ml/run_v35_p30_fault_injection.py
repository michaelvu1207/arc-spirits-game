#!/usr/bin/env python3
"""Run the frozen CPU-only P30 fault matrix and emit metric-free evidence."""

from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path

from v35_p30_crypto import atomic_write_exclusive, canonical_json, sha256_bytes


SCHEMA = "arc-v35-p30-fault-injection-preflight-v1"
TESTS = (
    (
        "authorization-clock-skew-expiry",
        "ml.test_v35_p30_authorized_execution.AuthorizedExecutionTests."
        "test_rejects_expired_and_preexisting_output_contract",
    ),
    (
        "lease-acquisition-failure",
        "ml.test_v35_p30_authorized_execution.AuthorizedExecutionTests."
        "test_lease_acquisition_failure_is_pre_child_and_releases_nothing",
    ),
    (
        "output-open-failure",
        "ml.test_v35_p30_authorized_execution.AuthorizedExecutionTests."
        "test_pre_child_draft_exists_only_before_popen_and_with_no_outputs",
    ),
    (
        "popen-ambiguity",
        "ml.test_v35_p30_authorized_execution.AuthorizedExecutionTests."
        "test_popen_failure_after_consumption_never_signs_invalid_receipt",
    ),
    (
        "child-failure",
        "ml.test_v35_p30_authorized_execution.AuthorizedExecutionTests."
        "test_child_failure_is_terminally_sealed_in_unsigned_draft",
    ),
    (
        "signal-interruption",
        "ml.test_v35_p30_authorized_execution.AuthorizedExecutionTests."
        "test_signal_interruption_terminates_child_and_seals_draft",
    ),
    (
        "gpu-postcheck-failure",
        "ml.test_v35_p30_authorized_execution.AuthorizedExecutionTests."
        "test_gpu_postcheck_failure_keeps_lease_and_fails_closed",
    ),
    (
        "enospc-output-sealing",
        "ml.test_v35_p30_authorized_execution.AuthorizedExecutionTests."
        "test_enospc_during_draft_sealing_is_terminal",
    ),
    (
        "receipt-signing-failure",
        "ml.test_v35_p30_authorized_execution.AuthorizedExecutionTests."
        "test_normal_seal_attempt_is_durable_before_private_key_use",
    ),
    (
        "custody-death-after-marker",
        "ml.test_v35_p30_durable_nonexecutor_signing."
        "P30DurableNonexecutorSigningTests."
        "test_existing_attempt_closes_action_before_payload_recomputation",
    ),
    (
        "real-block-reservation",
        "ml.test_v35_p30_recovery_scheduler.StorageReservationTests."
        "test_real_blocks_are_reserved_shrunk_and_released",
    ),
)


def run(output: Path) -> None:
    repo = Path(__file__).resolve().parents[1]
    python = repo / "ml/.venv/bin/python"
    path_entries = [
        value
        for value in (
            "/opt/homebrew/bin",
            "/usr/local/sbin",
            "/usr/local/bin",
            "/usr/sbin",
            "/usr/bin",
            "/sbin",
            "/bin",
        )
        if Path(value).is_dir()
    ]
    environment = {
        "HOME": "/tmp",
        "PATH": ":".join(path_entries),
        "PYTHONHASHSEED": "0",
        "PYTHONPATH": "ml",
    }
    checks = []
    for diagnostic, test_id in TESTS:
        command = [str(python), "-m", "unittest", "-q", test_id]
        completed = subprocess.run(
            command,
            cwd=repo,
            env=environment,
            stdin=subprocess.DEVNULL,
            capture_output=True,
        )
        checks.append(
            {
                "diagnostic": diagnostic,
                "testId": test_id,
                "commandSha256": sha256_bytes(canonical_json(command)),
                "exitCode": completed.returncode,
                "stdoutSha256": sha256_bytes(completed.stdout),
                "stderrSha256": sha256_bytes(completed.stderr),
                "passed": completed.returncode == 0,
            }
        )
    if not all(check["passed"] for check in checks):
        raise RuntimeError("P30 CPU fault-injection preflight failed")
    payload = {
        "schemaVersion": SCHEMA,
        "valid": True,
        "immutable": True,
        "promotionEligible": False,
        "outcomesInspected": False,
        "platform": "linux" if os.name == "posix" else os.name,
        "checks": checks,
        "diagnosticCodes": [check["diagnostic"] for check in checks],
    }
    atomic_write_exclusive(output, canonical_json(payload) + b"\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    run(args.out.resolve())


if __name__ == "__main__":
    main()
