#!/usr/bin/env python3
"""Issue one signed, one-shot, outcome-blind P30 generation authorization."""

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
    read_json_object,
    sha256,
    validate_initial_policy_artifacts,
    validate_protocol,
    validate_root_materialization,
)
from audit_v35_p30_generation import source_identity
from v35_p30_authorized_execution import AUTHORIZATION_SCHEMA, RECEIPT_SCHEMA
from v35_p30_crypto import (
    atomic_write_exclusive,
    canonical_json,
    public_key_identity,
    read_regular_nofollow,
    role_public_key_path,
    sha256_file,
    sign_payload,
    validate_role_trust,
    verify_signed_payload,
)


GPU_UUID = "GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0"


def utc(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def runtime_sha256(path: Path) -> str:
    return sha256_file(path.resolve())


def validate_trust(
    protocol: dict[str, Any], public_key_path: Path, *, role: str = "issuer"
) -> dict[str, Any]:
    trust = protocol.get("executionTrust")
    roles = validate_role_trust(trust, require_materialized=True)
    entry = roles[role]
    if (
        not public_key_path.is_absolute()
        or public_key_path.is_symlink()
        or Path(str(entry["publicKeyPath"])) != public_key_path
        or not isinstance(trust["campaignInstanceId"], str)
        or len(trust["campaignInstanceId"]) != 64
        or any(character not in "0123456789abcdef" for character in trust["campaignInstanceId"])
    ):
        raise ValueError("P30 public signing key differs from the authorized trust root")
    bubblewrap = Path(trust["bubblewrapPath"])
    if not bubblewrap.is_absolute() or runtime_sha256(bubblewrap) != trust["bubblewrapSha256"]:
        raise ValueError("P30 bubblewrap executable differs from the authorized trust root")
    for field in ("ledgerRoot", "leasePath"):
        if not Path(trust[field]).is_absolute():
            raise ValueError(f"P30 {field} must be absolute")
    return trust


def verify_predecessor(
    receipt_path: Path,
    *,
    public_key_path: Path,
    root: Path,
    generation: int,
    protocol_sha256: str,
    source_contract_sha256: str,
) -> dict[str, str]:
    signed = json.loads(read_regular_nofollow(receipt_path).decode("utf-8"))
    receipt = verify_signed_payload(
        signed, expected_role="executor", public_key_path=public_key_path
    )
    subject = receipt.get("subject")
    if (
        receipt.get("schemaVersion") != RECEIPT_SCHEMA
        or receipt.get("valid") is not True
        or receipt.get("kind") != "generation"
        or not isinstance(subject, dict)
        or subject.get("root") != str(root)
        or subject.get("generation") != generation - 1
        or subject.get("protocolSha256") != protocol_sha256
        or subject.get("sourceContractSha256") != source_contract_sha256
        or receipt.get("promotionEligible") is not False
    ):
        raise ValueError("prior generation execution receipt is invalid")
    return {"receiptPath": str(receipt_path), "sha256": sha256_file(receipt_path)}


def build(
    *,
    protocol_path: Path,
    root: Path,
    generation: int,
    public_key_path: Path,
    predecessor_receipt: Path | None,
    request_binding: dict[str, str],
    token_id: str | None = None,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    protocol_path = protocol_path.resolve()
    root = root.resolve()
    if not public_key_path.is_absolute() or public_key_path.is_symlink():
        raise ValueError("P30 public key path must be absolute and non-symlink")
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
    binding = read_json_object(root / "v35-binding.json", "P30 root binding")
    validate_root_materialization(
        config_path=root / "config.json",
        binding_path=root / "v35-binding.json",
        protocol=protocol,
        protocol_path=protocol_path,
        replicate=binding.get("replicate"),
        arm=binding.get("arm"),
    )
    maximum = protocol["seedSchedule"]["maxGeneration"]
    if generation < 1 or generation > maximum:
        raise ValueError("generation is outside the P30 schedule")
    state_path = root / "state.json"
    if generation == 1:
        if state_path.exists():
            state = read_json_object(state_path, "P30 state")
            if state.get("gen") != 0:
                raise ValueError("generation-one authorization requires state generation zero")
        predecessor = None
        input_checkpoint = Path(protocol["initialPolicy"]["path"])
        if not input_checkpoint.is_absolute():
            input_checkpoint = REPO_ROOT / input_checkpoint
        input_checkpoint_sha256 = protocol["initialPolicy"]["sha256"]
        if predecessor_receipt is not None:
            raise ValueError("generation one must not name a predecessor receipt")
    else:
        if not state_path.is_file() or read_json_object(state_path, "P30 state").get("gen") != generation - 1:
            raise ValueError("P30 state is not immediately before the authorized generation")
        if predecessor_receipt is None:
            raise ValueError("later generations require a signed predecessor receipt")
        predecessor = verify_predecessor(
            predecessor_receipt.resolve(),
            public_key_path=role_public_key_path(trust, "executor"),
            root=root,
            generation=generation,
            protocol_sha256=sha256(protocol_path),
            source_contract_sha256=source_contract_sha256,
        )
        input_checkpoint = root / "checkpoints" / f"main-0-gen{generation - 1}.pt"
        prior_audit = read_json_object(
            root / "artifacts" / f"gen{generation - 1}-audit.json", "prior generation audit"
        )
        input_checkpoint_sha256 = prior_audit.get("checkpointSha256")
    if not input_checkpoint.is_file() or sha256_file(input_checkpoint) != input_checkpoint_sha256:
        raise ValueError("generation input checkpoint is missing or hash-invalid")
    token = token_id or secrets.token_hex(32)
    if len(token) != 64 or any(character not in "0123456789abcdef" for character in token):
        raise ValueError("token ID must be 32 random bytes encoded as lowercase hex")
    moment = now or dt.datetime.now(dt.timezone.utc)
    ledger_root = Path(trust["ledgerRoot"]) / trust["campaignInstanceId"]
    scratch = Path("/dev/shm/arc-v35-p30-training") / root.relative_to(
        REPO_ROOT / "ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/league"
    )
    artifacts = root / "artifacts"
    checkpoint = root / "checkpoints" / f"main-0-gen{generation}.pt"
    checkpoint_manifest = checkpoint.with_suffix(".manifest.json")
    stdout = artifacts / f"gen{generation}-execution.stdout"
    stderr = artifacts / f"gen{generation}-execution.stderr"
    exit_code = artifacts / f"gen{generation}-execution.exit-code"
    outputs = {
        "audit": {"path": str(artifacts / f"gen{generation}-audit.json"), "required": True, "mustBeAbsentAtStart": True},
        "checkpoint": {"path": str(checkpoint), "required": True, "mustBeAbsentAtStart": True},
        "checkpointManifest": {"path": str(checkpoint_manifest), "required": True, "mustBeAbsentAtStart": True},
        "config": {"path": str(root / "config.json"), "required": True, "mustBeAbsentAtStart": False},
        "binding": {"path": str(root / "v35-binding.json"), "required": True, "mustBeAbsentAtStart": False},
        "environment": {"path": str(artifacts / f"gen{generation}-environment.json"), "required": True, "mustBeAbsentAtStart": True},
        "exitCode": {"path": str(exit_code), "required": True, "mustBeAbsentAtStart": True},
        "stderr": {"path": str(stderr), "required": True, "mustBeAbsentAtStart": True},
        "stdout": {"path": str(stdout), "required": True, "mustBeAbsentAtStart": True},
        "state": {"path": str(state_path), "required": True, "mustBeAbsentAtStart": not state_path.exists()},
        "trainLog": {"path": str(artifacts / f"gen{generation}-train.log"), "required": True, "mustBeAbsentAtStart": True},
        "trainMeta": {"path": str(artifacts / f"gen{generation}-train-meta.json"), "required": True, "mustBeAbsentAtStart": True},
    }
    config_sha256 = sha256(root / "config.json")
    binding_sha256 = sha256(root / "v35-binding.json")
    executable = Path("/usr/bin/bash")
    payload: dict[str, Any] = {
        "schemaVersion": AUTHORIZATION_SCHEMA,
        "authorized": True,
        "immutable": True,
        "promotionEligible": False,
        "kind": "generation",
        "tokenId": token,
        "campaignId": protocol["experiment"],
        "issuedAtUtc": utc(moment),
        "notBeforeUtc": utc(moment),
        "expiresAtUtc": utc(moment + dt.timedelta(hours=2)),
        "protocol": {"path": str(protocol_path), "sha256": sha256(protocol_path)},
        "sourceContract": {
            "path": str(source_contract_path.resolve()),
            "sha256": source_contract_sha256,
        },
        "subject": {
            "root": str(root),
            "replicate": binding["replicate"],
            "arm": binding["arm"],
            "generation": generation,
            "protocolSha256": sha256(protocol_path),
            "sourceCommit": source_commit,
            "sourceContractSha256": source_contract_sha256,
            "configSha256": config_sha256,
            "bindingSha256": binding_sha256,
            "inputCheckpointPath": str(input_checkpoint.resolve()),
            "inputCheckpointSha256": input_checkpoint_sha256,
        },
        "command": {
            "argv": [str(executable), "scripts/run-v35-p30-root.sh", str(root), str(generation)],
            "cwd": str(REPO_ROOT),
            "env": {
                "ARC_ROOT": str(REPO_ROOT),
                "ARC_V35_P30_EXTERNAL_LEASE": "1",
                "ARC_V35_P30_AUTH_TOKEN": token,
                "ARC_V35_P30_PROTOCOL": str(protocol_path),
                "ARC_V35_P30_SCRATCH": "/dev/shm/arc-v35-p30-training",
                "CUBLAS_WORKSPACE_CONFIG": ":4096:8",
                "CUDA_DEVICE_ORDER": "PCI_BUS_ID",
                "CUDA_VISIBLE_DEVICES": GPU_UUID,
                "HOME": "/tmp",
                "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "PYTHONHASHSEED": "0",
            },
            "executableSha256": runtime_sha256(executable),
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
            "writablePaths": sorted((str(root), str(scratch))),
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
        "predecessor": predecessor,
        "request": request_binding,
    }
    return payload


def main() -> None:
    raise SystemExit(
        "direct issuer CLI is disabled; use run_v35_p30_role.py through local custody"
    )


if __name__ == "__main__":
    main()
