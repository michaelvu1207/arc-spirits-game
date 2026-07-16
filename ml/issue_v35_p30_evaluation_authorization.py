#!/usr/bin/env python3
"""Issue a signed one-shot primary or replay P30 evaluation authorization."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import secrets
from pathlib import Path
from typing import Any

from analyze_v35_p30_long_horizon import (
    REPO_ROOT,
    endpoint_label,
    read_json_object,
    sha256,
    validate_initial_policy_artifacts,
    validate_protocol,
    validate_root_materialization,
)
from audit_v35_p30_generation import source_identity
from issue_v35_p30_generation_authorization import GPU_UUID, utc, validate_trust
from v35_p30_authorized_execution import AUTHORIZATION_SCHEMA, RECEIPT_SCHEMA
from v35_p30_crypto import (
    atomic_write_exclusive,
    canonical_json,
    executable_sha256,
    read_regular_nofollow,
    role_public_key_path,
    sha256_file,
    sign_payload,
    verify_signed_payload,
    venv_python_entrypoint,
)


def read_receipt(path: Path, public_key: Path) -> dict[str, Any]:
    signed = json.loads(read_regular_nofollow(path).decode("utf-8"))
    receipt = verify_signed_payload(
        signed, expected_role="executor", public_key_path=public_key
    )
    if (
        receipt.get("schemaVersion") != RECEIPT_SCHEMA
        or receipt.get("valid") is not True
        or receipt.get("promotionEligible") is not False
    ):
        raise ValueError("predecessor execution receipt is invalid")
    return receipt


def build(
    *,
    protocol_path: Path,
    root: Path,
    role: str,
    public_key_path: Path,
    predecessor_receipt_path: Path,
    request_binding: dict[str, str],
    token_id: str | None = None,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    protocol_path = protocol_path.resolve()
    root = root.resolve()
    if not public_key_path.is_absolute() or public_key_path.is_symlink():
        raise ValueError("P30 public key path must be absolute and non-symlink")
    predecessor_receipt_path = predecessor_receipt_path.resolve()
    if role not in ("primary", "replay"):
        raise ValueError("role must be primary or replay")
    protocol = read_json_object(protocol_path, "P30 protocol")
    validate_protocol(protocol, require_authorized=True)
    validate_initial_policy_artifacts(protocol, protocol_path=protocol_path)
    source_commit, source_contract_sha256 = source_identity(protocol, protocol_path)
    source_contract_path = Path(protocol["sourceContract"]["artifact"])
    if not source_contract_path.is_absolute():
        source_contract_path = REPO_ROOT / source_contract_path
    source_lock = read_json_object(source_contract_path, "P30 source lock")
    git_dir = Path(source_lock.get("gitContext", {}).get("gitDir", ""))
    if not git_dir.is_absolute() or not git_dir.is_dir():
        raise ValueError("P30 source lock lacks its external Git database")
    trust = validate_trust(protocol, public_key_path)
    binding_path = root / "v35-binding.json"
    config_path = root / "config.json"
    binding = read_json_object(binding_path, "P30 root binding")
    validate_root_materialization(
        config_path=config_path,
        binding_path=binding_path,
        protocol=protocol,
        protocol_path=protocol_path,
        replicate=binding.get("replicate"),
        arm=binding.get("arm"),
    )
    generation = protocol["seedSchedule"]["maxGeneration"]
    checkpoint = root / "checkpoints" / f"main-0-gen{generation}.pt"
    audit = root / "artifacts" / f"gen{generation}-audit.json"
    if not checkpoint.is_file() or not audit.is_file():
        raise ValueError("endpoint final checkpoint or audit is missing")
    predecessor_receipt = read_receipt(
        predecessor_receipt_path, role_public_key_path(trust, "executor")
    )
    predecessor_subject = predecessor_receipt.get("subject")
    expected_kind = "generation" if role == "primary" else "evaluation-primary"
    if (
        predecessor_receipt.get("kind") != expected_kind
        or not isinstance(predecessor_subject, dict)
        or predecessor_subject.get("root") != str(root)
        or predecessor_subject.get("protocolSha256") != sha256(protocol_path)
        or predecessor_subject.get("sourceContractSha256") != source_contract_sha256
        or (role == "primary" and predecessor_subject.get("generation") != generation)
        or (role == "replay" and predecessor_subject.get("role") != "primary")
    ):
        raise ValueError("evaluation predecessor is not the required endpoint execution")
    token = token_id or secrets.token_hex(32)
    if len(token) != 64 or any(character not in "0123456789abcdef" for character in token):
        raise ValueError("token ID must be 32 random bytes encoded as lowercase hex")
    moment = now or dt.datetime.now(dt.timezone.utc)
    label = endpoint_label(binding["replicate"], binding["arm"])
    evaluation_root = (
        REPO_ROOT
        / "ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/evaluations"
        / label
        / f"{role}-{token}"
    )
    # Linux AF_UNIX paths are limited to 107 pathname bytes. Keep the token in a
    # deliberately short namespace; endpoint and role remain bound by the signed
    # authorization rather than duplicated in the socket path.
    scratch = Path("/dev/shm/a35") / token
    ledger_root = Path(trust["ledgerRoot"]) / trust["campaignInstanceId"]
    socket_path = scratch / "s"
    if len(os.fsencode(socket_path)) > 107:
        raise ValueError("authorized inference socket exceeds Linux AF_UNIX limit")
    outputs = {
        "evaluatorExitCode": {"path": str(evaluation_root / "evaluator.exit-code"), "required": True, "mustBeAbsentAtStart": True},
        "evaluatorStderr": {"path": str(evaluation_root / "evaluator.stderr"), "required": True, "mustBeAbsentAtStart": True},
        "evaluatorStdout": {"path": str(evaluation_root / "evaluator.stdout"), "required": True, "mustBeAbsentAtStart": True},
        "exitCode": {"path": str(evaluation_root / "supervisor.exit-code"), "required": True, "mustBeAbsentAtStart": True},
        "innerExecution": {"path": str(evaluation_root / "inner-execution.json"), "required": True, "mustBeAbsentAtStart": True},
        "legacyReceipt": {"path": str(evaluation_root / "legacy-receipt.json"), "required": True, "mustBeAbsentAtStart": True},
        "report": {"path": str(evaluation_root / "report.json"), "required": True, "mustBeAbsentAtStart": True},
        "serverExitCode": {"path": str(evaluation_root / "server.exit-code"), "required": True, "mustBeAbsentAtStart": True},
        "serverStderr": {"path": str(evaluation_root / "server.stderr"), "required": True, "mustBeAbsentAtStart": True},
        "serverStdout": {"path": str(evaluation_root / "server.stdout"), "required": True, "mustBeAbsentAtStart": True},
        "stderr": {"path": str(evaluation_root / "supervisor.stderr"), "required": True, "mustBeAbsentAtStart": True},
        "stdout": {"path": str(evaluation_root / "supervisor.stdout"), "required": True, "mustBeAbsentAtStart": True},
    }
    executable = venv_python_entrypoint(REPO_ROOT)
    payload: dict[str, Any] = {
        "schemaVersion": AUTHORIZATION_SCHEMA,
        "authorized": True,
        "immutable": True,
        "promotionEligible": False,
        "kind": f"evaluation-{role}",
        "tokenId": token,
        "campaignId": protocol["experiment"],
        "issuedAtUtc": utc(moment),
        "notBeforeUtc": utc(moment),
        "expiresAtUtc": utc(moment + dt.timedelta(hours=4)),
        "protocol": {"path": str(protocol_path), "sha256": sha256(protocol_path)},
        "sourceContract": {"path": str(source_contract_path.resolve()), "sha256": source_contract_sha256},
        "subject": {
            "root": str(root),
            "replicate": binding["replicate"],
            "arm": binding["arm"],
            "role": role,
            "protocolSha256": sha256(protocol_path),
            "sourceCommit": source_commit,
            "sourceContractSha256": source_contract_sha256,
            "configSha256": sha256(config_path),
            "bindingSha256": sha256(binding_path),
            "checkpointPath": str(checkpoint),
            "checkpointSha256": sha256_file(checkpoint),
            "generationAuditPath": str(audit),
            "generationAuditSha256": sha256_file(audit),
            "seed0": protocol["seedSchedule"]["commonPublicBase"],
            "games": protocol["seedSchedule"]["commonPublicGames"],
        },
        "command": {
            "argv": [
                str(executable),
                "ml/run_v35_p30_evaluation_attempt.py",
                "--protocol",
                str(protocol_path),
                "--root",
                str(root),
                "--role",
                role,
                "--attempt-token",
                token,
                "--output-dir",
                str(evaluation_root),
                "--socket",
                str(socket_path),
            ],
            "cwd": str(REPO_ROOT),
            "env": {
                "CUBLAS_WORKSPACE_CONFIG": ":4096:8",
                "CUDA_DEVICE_ORDER": "PCI_BUS_ID",
                "CUDA_VISIBLE_DEVICES": GPU_UUID,
                "HOME": "/tmp",
                "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "PYTHONHASHSEED": "0",
                "PYTHONPATH": "ml",
            },
            "executableSha256": executable_sha256(executable),
        },
        "isolation": {
            "backend": "bubblewrap",
            "backendPath": trust["bubblewrapPath"],
            "backendSha256": trust["bubblewrapSha256"],
            "network": "none",
            "newPidNamespace": True,
            "newUserNamespace": True,
            "readOnlyPaths": sorted(
                path
                for path in (
                    "/bin",
                    "/etc",
                    "/lib",
                    "/lib64",
                    "/sys",
                    "/proc/driver/nvidia",
                    "/usr",
                    str(REPO_ROOT),
                    str(git_dir),
                )
                if Path(path).exists()
            ),
            "writablePaths": sorted((str(evaluation_root), str(scratch))),
            "tmpfsPaths": ["/tmp"],
            "gpuMode": "exclusive-gpu7",
            "gpuUuid": GPU_UUID,
            "forbiddenGpuIndices": [4, 5, 6],
        },
        "outputs": outputs,
        "ledger": {
            "root": str(ledger_root),
            "consumedPath": str(ledger_root / f"{token}.consumed.json"),
            "receiptPath": str(ledger_root / f"{token}.receipt.json"),
            "leasePath": trust["leasePath"],
        },
        "predecessor": {
            "receiptPath": str(predecessor_receipt_path),
            "sha256": sha256_file(predecessor_receipt_path),
        },
        "request": request_binding,
    }
    return payload


def main() -> None:
    raise SystemExit(
        "direct issuer CLI is disabled; use run_v35_p30_role.py through local custody"
    )


if __name__ == "__main__":
    main()
