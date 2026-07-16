#!/usr/bin/env python3
"""Outcome-free full-shape rehearsal for the one-shot P30 analyzer trust path."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from v35_p30_crypto import (
    atomic_write_exclusive,
    canonical_json,
    sha256_bytes,
    venv_python_entrypoint,
)


TEST_ID = (
    "ml.test_analyze_v35_p30_long_horizon."
    "V35P30AnalyzerTests.test_load_inputs_verifies_complete_outcome_blind_hash_chain"
)


def run(output: Path) -> None:
    command = [
        str(venv_python_entrypoint(Path(__file__).resolve().parents[1])),
        "-m",
        "unittest",
        "-q",
        TEST_ID,
    ]
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
        "MKL_NUM_THREADS": "1",
        "NUMEXPR_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "OPENBLAS_NUM_THREADS": "1",
        "PATH": ":".join(path_entries),
        "PYTHONHASHSEED": "0",
        "PYTHONPATH": "ml",
    }
    completed = subprocess.run(
        command,
        cwd=Path(__file__).resolve().parent.parent,
        env=environment,
        stdin=subprocess.DEVNULL,
        capture_output=True,
    )
    if completed.returncode != 0:
        stderr_tail = completed.stderr.decode("utf-8", "replace")[-4096:]
        raise RuntimeError(
            "synthetic analyzer trust-path rehearsal failed "
            f"(exit={completed.returncode}, "
            f"stdoutSha256={sha256_bytes(completed.stdout)}, "
            f"stderrSha256={sha256_bytes(completed.stderr)}):\n{stderr_tail}"
        )
    payload = {
        "schemaVersion": "arc-v35-p30-analyzer-synthetic-rehearsal-v1",
        "valid": True,
        "promotionEligible": False,
        "outcomesInspected": False,
        "testId": TEST_ID,
        "commandSha256": sha256_bytes(canonical_json(command)),
        "stdoutSha256": sha256_bytes(completed.stdout),
        "stderrSha256": sha256_bytes(completed.stderr),
        "environment": environment,
    }
    atomic_write_exclusive(output, canonical_json(payload) + b"\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    run(args.out)


if __name__ == "__main__":
    main()
