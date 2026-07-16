#!/usr/bin/env python3
"""Build one source-locked Phase-0 P30 execution authorization."""

from __future__ import annotations

import datetime as dt
import os
import secrets
from pathlib import Path
from typing import Any

from analyze_v35_p30_long_horizon import (
    REPO_ROOT,
    read_json_object,
    sha256,
    validate_initial_policy_artifacts,
    validate_protocol,
)
from audit_v35_p30_generation import source_identity
from issue_v35_p30_generation_authorization import utc, validate_trust
from v35_p30_authorized_execution import AUTHORIZATION_SCHEMA
from v35_p30_crypto import executable_sha256, venv_python_entrypoint
from v35_p30_phase0 import (
    PHASE0_NAMES,
    artifact_root,
    ledger_for,
    phase0_output_root,
)


GPU_UUID = "GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0"


def _output(path: Path) -> dict[str, Any]:
    return {
        "path": str(path),
        "required": True,
        "mustBeAbsentAtStart": True,
    }


def cuda_socket_root(campaign_instance_id: str) -> Path:
    if len(campaign_instance_id) != 64 or any(
        character not in "0123456789abcdef" for character in campaign_instance_id
    ):
        raise ValueError("P30 campaign instance ID is malformed")
    root = Path("/dev/shm/p") / campaign_instance_id
    for name in ("p30d-primary.sock", "p30d-replay.sock"):
        if len(os.fsencode(root / name)) > 107:
            raise ValueError("P30 CUDA preflight socket exceeds Linux AF_UNIX limit")
    return root


def build(
    *,
    protocol_path: Path,
    name: str,
    public_key_path: Path,
    request_binding: dict[str, str],
    token_id: str | None = None,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    protocol_path = protocol_path.resolve()
    if name not in PHASE0_NAMES:
        raise ValueError("unknown P30 phase-zero authorization")
    protocol = read_json_object(protocol_path, "P30 protocol")
    validate_protocol(protocol, require_authorized=True)
    validate_initial_policy_artifacts(protocol, protocol_path=protocol_path)
    source_commit, source_contract_sha = source_identity(protocol, protocol_path)
    source_contract_path = Path(protocol["sourceContract"]["artifact"])
    if not source_contract_path.is_absolute():
        source_contract_path = REPO_ROOT / source_contract_path
    source_lock = read_json_object(source_contract_path, "P30 source lock")
    git_dir = Path(source_lock.get("gitContext", {}).get("gitDir", ""))
    if not git_dir.is_absolute() or not git_dir.is_dir():
        raise ValueError("P30 source lock lacks its external Git database")
    trust = validate_trust(protocol, public_key_path)
    token = token_id or secrets.token_hex(32)
    if len(token) != 64 or any(c not in "0123456789abcdef" for c in token):
        raise ValueError("P30 preflight token is malformed")
    moment = now or dt.datetime.now(dt.timezone.utc)
    root = phase0_output_root(protocol, name)
    stdout = root / "execution.stdout"
    stderr = root / "execution.stderr"
    exit_code = root / "execution.exit-code"
    report = root / "report.json"
    python = venv_python_entrypoint(REPO_ROOT)
    if name == "fault-injection":
        argv = [
            str(python),
            "ml/run_v35_p30_fault_injection.py",
            "--out",
            str(report),
        ]
        gpu_mode = "none"
        gpu_uuid = None
        outputs = {
            "report": _output(report),
            "exitCode": _output(exit_code),
            "stderr": _output(stderr),
            "stdout": _output(stdout),
        }
        writable = [str(root)]
    elif name == "analyzer-rehearsal":
        argv = [
            str(python),
            "ml/run_v35_p30_analyzer_rehearsal.py",
            "--out",
            str(report),
        ]
        gpu_mode = "none"
        gpu_uuid = None
        outputs = {
            "report": _output(report),
            "exitCode": _output(exit_code),
            "stderr": _output(stderr),
            "stdout": _output(stdout),
        }
        writable = [str(root)]
    else:
        socket_root = cuda_socket_root(trust["campaignInstanceId"])
        argv = [
            str(python),
            "ml/run_v35_p30_cuda_determinism.py",
            "--protocol",
            str(protocol_path),
            "--output-root",
            str(root),
            "--socket-root",
            str(socket_root),
        ]
        gpu_mode = "exclusive-gpu7"
        gpu_uuid = GPU_UUID
        outputs = {
            "report": _output(report),
            "primaryReport": _output(root / "primary/report.json"),
            "primaryEvaluatorStdout": _output(
                root / "primary/evaluator.stdout"
            ),
            "primaryEvaluatorStderr": _output(
                root / "primary/evaluator.stderr"
            ),
            "primaryServerStdout": _output(root / "primary/server.stdout"),
            "primaryServerStderr": _output(root / "primary/server.stderr"),
            "replayReport": _output(root / "replay/report.json"),
            "replayEvaluatorStdout": _output(root / "replay/evaluator.stdout"),
            "replayEvaluatorStderr": _output(root / "replay/evaluator.stderr"),
            "replayServerStdout": _output(root / "replay/server.stdout"),
            "replayServerStderr": _output(root / "replay/server.stderr"),
            "exitCode": _output(exit_code),
            "stderr": _output(stderr),
            "stdout": _output(stdout),
        }
        writable = [str(root), str(socket_root)]
    ledger = ledger_for(protocol)
    read_only_candidates = [
        Path("/bin"),
        Path("/etc"),
        Path("/lib"),
        Path("/lib64"),
        Path("/sys"),
        Path("/usr"),
        REPO_ROOT,
        git_dir,
    ]
    if name != "cuda-determinism":
        read_only_candidates.append(Path("/proc/driver/nvidia"))
    read_only = sorted(str(path) for path in read_only_candidates if path.exists())
    payload: dict[str, Any] = {
        "schemaVersion": AUTHORIZATION_SCHEMA,
        "authorized": True,
        "immutable": True,
        "promotionEligible": False,
        "kind": "preflight",
        "tokenId": token,
        "campaignId": protocol["experiment"],
        "issuedAtUtc": utc(moment),
        "notBeforeUtc": utc(moment),
        "expiresAtUtc": utc(moment + dt.timedelta(hours=24)),
        "protocol": {"path": str(protocol_path), "sha256": sha256(protocol_path)},
        "sourceContract": {
            "path": str(source_contract_path.resolve()),
            "sha256": source_contract_sha,
        },
        "subject": {
            "name": name,
            "root": str(root),
            "replicate": "phase0",
            "arm": name,
            "protocolSha256": sha256(protocol_path),
            "sourceCommit": source_commit,
            "sourceContractSha256": source_contract_sha,
        },
        "command": {
            "argv": argv,
            "cwd": str(REPO_ROOT),
            "env": {
                "CUBLAS_WORKSPACE_CONFIG": ":4096:8",
                "CUDA_DEVICE_ORDER": "PCI_BUS_ID",
                "CUDA_VISIBLE_DEVICES": GPU_UUID if gpu_mode != "none" else "",
                "HOME": "/tmp",
                "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "PYTHONHASHSEED": "0",
                "PYTHONPATH": "ml",
            },
            "executableSha256": executable_sha256(python),
        },
        "isolation": {
            "backend": "bubblewrap",
            "backendPath": trust["bubblewrapPath"],
            "backendSha256": trust["bubblewrapSha256"],
            "network": "none",
            "newPidNamespace": True,
            "newUserNamespace": True,
            "readOnlyPaths": read_only,
            "writablePaths": sorted(writable),
            "tmpfsPaths": ["/tmp"],
            "gpuMode": gpu_mode,
            "gpuUuid": gpu_uuid,
            "forbiddenGpuIndices": [4, 5, 6],
        },
        "outputs": outputs,
        "ledger": {
            "root": str(ledger),
            "consumedPath": str(ledger / f"{token}.consumed.json"),
            "receiptPath": str(ledger / f"{token}.receipt.json"),
            "leasePath": trust["leasePath"],
        },
        "predecessor": None,
        "request": request_binding,
    }
    if artifact_root(protocol) not in root.parents:
        raise RuntimeError("P30 phase-zero output escaped its artifact root")
    return payload


def main() -> None:
    raise SystemExit(
        "direct issuer CLI is disabled; use run_v35_p30_role.py through local custody"
    )


if __name__ == "__main__":
    main()
