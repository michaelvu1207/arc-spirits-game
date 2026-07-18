#!/usr/bin/env python3
"""Fail-closed post-generation audit for the authorized V35 P30 screen."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from analyze_v35_p30_long_horizon import (
    REPO_ROOT,
    SOURCE_FILE_PATHS,
    SOURCE_LOCK_SCHEMA,
    is_git_commit,
    is_sha256,
    resolve_artifact,
    validate_initial_policy_artifacts,
    validate_policy_manifest,
    validate_protocol,
    validate_root_materialization,
    verify_git_context,
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_commitment(path: Path) -> dict[str, int | str]:
    if not path.is_dir():
        raise FileNotFoundError(path)
    digest = hashlib.sha256()
    files = 0
    total_bytes = 0
    for file in sorted(item for item in path.rglob("*") if item.is_file()):
        relative = file.relative_to(path).as_posix().encode()
        file_digest = sha256(file).encode()
        size = file.stat().st_size
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(size.to_bytes(8, "big"))
        digest.update(file_digest)
        files += 1
        total_bytes += size
    if files == 0 or total_bytes == 0:
        raise ValueError("generation data tree is empty")
    return {"sha256": digest.hexdigest(), "files": files, "bytes": total_bytes}


def read_object(path: Path, label: str) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def source_identity(protocol: dict[str, Any], protocol_path: Path) -> tuple[str, str]:
    contract = protocol["sourceContract"]
    lock_path = resolve_artifact(
        contract.get("artifact"), anchor=REPO_ROOT, label="P30 source lock"
    )
    if not lock_path.is_file() or sha256(lock_path) != contract.get("sha256"):
        raise ValueError("P30 source lock is missing or hash-invalid")
    lock = read_object(lock_path, "P30 source lock")
    if (
        set(lock)
        != {
            "schemaVersion",
            "authorized",
            "immutable",
            "promotionEligible",
            "implementationBaseCommit",
            "implementationCommit",
            "gitContext",
            "files",
        }
        or
        lock.get("schemaVersion") != SOURCE_LOCK_SCHEMA
        or lock.get("authorized") is not True
        or lock.get("immutable") is not True
        or lock.get("promotionEligible") is not False
        or lock.get("implementationBaseCommit") != protocol["implementationBaseCommit"]
        or not is_git_commit(lock.get("implementationCommit"))
        or not isinstance(lock.get("files"), dict)
    ):
        raise ValueError("P30 source lock identity changed")
    files = lock["files"]
    if set(files) != set(SOURCE_FILE_PATHS):
        raise ValueError("P30 source lock file registry changed")
    for label, relative in SOURCE_FILE_PATHS.items():
        entry = files[label]
        if (
            not isinstance(entry, dict)
            or set(entry) != {"path", "sha256", "gitBlobOid"}
            or entry.get("path") != relative
            or not is_sha256(entry.get("sha256"))
            or not is_git_commit(entry.get("gitBlobOid"))
        ):
            raise ValueError(f"P30 source lock has malformed {label} binding")
        source_path = REPO_ROOT / relative
        if not source_path.is_file() or sha256(source_path) != entry["sha256"]:
            raise ValueError(f"P30 source lock has hash-invalid {label}")
    verify_git_context(lock)
    return lock["implementationCommit"], sha256(lock_path)


def audit(root: Path, generation: int, protocol_path: Path) -> dict[str, Any]:
    from audit_v32_generation import audit as audit_v32_generation

    root = root.resolve()
    protocol_path = protocol_path.resolve()
    config_path = root / "config.json"
    binding_path = root / "v35-binding.json"
    for required in (protocol_path, config_path, binding_path):
        if not required.is_file():
            raise FileNotFoundError(required)
    protocol = read_object(protocol_path, "P30 protocol")
    validate_protocol(protocol, require_authorized=True)
    validate_initial_policy_artifacts(protocol, protocol_path=protocol_path)
    binding = read_object(binding_path, "P30 root binding")
    replicate = binding.get("replicate")
    arm = binding.get("arm")
    validate_root_materialization(
        config_path=config_path,
        binding_path=binding_path,
        protocol=protocol,
        protocol_path=protocol_path,
        replicate=replicate,
        arm=arm,
    )
    if generation < 1 or generation > protocol["seedSchedule"]["maxGeneration"]:
        raise ValueError("generation is outside the P30 seed schedule")
    implementation_commit, source_contract_sha256 = source_identity(protocol, protocol_path)
    gates = protocol["trustGates"]
    training = protocol["training"]
    core = audit_v32_generation(
        SimpleNamespace(
            root=root,
            gen=generation,
            max_approx_kl=float(gates["maxApproxKl"]),
            max_clip_fraction=min(
                float(gates["maxOrdinaryClipFraction"]),
                float(gates["maxWeightedClipFraction"]),
            ),
            max_ece=float(gates["maxBehaviorReach30Ece"]),
            max_logp_error=float(gates["maxBehaviorLogpReconstructionError"]),
            optimizer_steps=int(training["optimizerStepsPerEpoch"]),
            batch_size=int(training["batchSize"]),
        )
    )
    if core.get("valid") is not True or core.get("stalls") != gates["stalls"]:
        raise ValueError("trusted core generation audit failed")
    if core.get("evaluationStalls") != gates["stalls"]:
        raise ValueError("trusted core evaluation stall gate failed")
    if (
        core.get("malformedEpisodes") != gates["malformedEpisodes"]
        or core.get("malformedRows") != gates["malformedRows"]
    ):
        raise ValueError("trusted core malformed-data gate failed")
    calibration = core.get("behaviorReach30Calibration")
    if (
        not isinstance(calibration, dict)
        or not {"brier", "constant_brier", "rows"}.issubset(calibration)
        or int(calibration["rows"]) <= 0
    ):
        raise ValueError("behavior reach30 Brier telemetry is incomplete")
    if gates["behaviorReach30BrierNoWorseThanConstant"] and (
        float(calibration["brier"]) > float(calibration["constant_brier"]) + 1e-12
    ):
        raise ValueError("behavior reach30 Brier gate failed")
    checkpoint = root / "checkpoints" / f"main-0-gen{generation}.pt"
    manifest = checkpoint.with_suffix(".manifest.json")
    if core.get("checkpointSha256") != sha256(checkpoint) or core.get(
        "manifestSha256"
    ) != sha256(manifest):
        raise ValueError("trusted core checkpoint binding changed")
    validate_policy_manifest(
        read_object(manifest, "P30 endpoint checkpoint manifest"),
        label="P30 endpoint checkpoint manifest",
        protocol=protocol,
    )
    if generation == 1:
        expected_behavior_sha256 = protocol["initialPolicy"]["sha256"]
        previous_audit_sha256 = None
        audit_chain: list[dict[str, Any]] = []
    else:
        previous_path = root / "artifacts" / f"gen{generation - 1}-audit.json"
        if not previous_path.is_file():
            raise ValueError("previous P30 generation audit is missing")
        previous = read_object(previous_path, "previous P30 generation audit")
        if (
            previous.get("schemaVersion") != "arc-v35-generation-audit-v1"
            or previous.get("valid") is not True
            or previous.get("generation") != generation - 1
            or previous.get("protocolSha256") != sha256(protocol_path)
            or previous.get("sourceCommit") != implementation_commit
            or previous.get("sourceContractSha256") != source_contract_sha256
            or not isinstance(previous.get("checkpointSha256"), str)
            or not isinstance(previous.get("auditChain"), list)
            or len(previous["auditChain"]) != generation - 2
        ):
            raise ValueError("previous P30 generation audit chain is invalid")
        previous_audit_sha256 = sha256(previous_path)
        audit_chain = [
            *previous["auditChain"],
            {
                "generation": generation - 1,
                "path": str(previous_path),
                "sha256": previous_audit_sha256,
                "checkpointSha256": previous["checkpointSha256"],
            },
        ]
        expected_behavior_sha256 = previous["checkpointSha256"]
    if core.get("behaviorCheckpointSha256") != expected_behavior_sha256:
        raise ValueError("P30 behavior-checkpoint chain changed")

    environment_path = root / "artifacts" / f"gen{generation}-environment.json"
    if not environment_path.is_file():
        raise ValueError("prospective P30 environment manifest is missing")
    environment = read_object(environment_path, "P30 environment manifest")
    gpu_line = environment.get("gpuLine")
    authorization_token_id = environment.get("authorizationTokenId")
    expected_source_path = resolve_artifact(
        protocol["sourceContract"]["artifact"],
        anchor=REPO_ROOT,
        label="P30 source contract",
    )
    if (
        environment.get("schemaVersion") != "arc-v35-p30-generation-environment-v1"
        or environment.get("root") != str(root)
        or environment.get("generation") != generation
        or not isinstance(authorization_token_id, str)
        or len(authorization_token_id) != 64
        or any(character not in "0123456789abcdef" for character in authorization_token_id)
        or gpu_line != f"7,{protocol['runtime']['gpuUuid']},0,0"
        or environment.get("cudaAvailable") is not True
        or environment.get("visibleDeviceCount") != 1
        or not isinstance(environment.get("visibleDeviceName"), str)
        or not environment["visibleDeviceName"]
        or environment.get("determinism")
        != {
            "CUDA_DEVICE_ORDER": "PCI_BUS_ID",
            "CUDA_VISIBLE_DEVICES": protocol["runtime"]["gpuUuid"],
            "PYTHONHASHSEED": "0",
            "CUBLAS_WORKSPACE_CONFIG": ":4096:8",
        }
        or environment.get("protocol")
        != {"path": str(protocol_path), "sha256": sha256(protocol_path)}
        or environment.get("sourceContract")
        != {"path": str(expected_source_path.resolve()), "sha256": source_contract_sha256}
    ):
        raise ValueError("prospective P30 environment manifest is invalid")
    result = dict(core)
    result["trustedCoreAuditSchema"] = result.pop("schemaVersion")
    result.update(
        {
            "schemaVersion": "arc-v35-generation-audit-v1",
            "experiment": protocol["experiment"],
            "replicate": replicate,
            "arm": arm,
            "protocol": str(protocol_path),
            "protocolSha256": sha256(protocol_path),
            "configSha256": sha256(config_path),
            "bindingSha256": sha256(binding_path),
            "catalogSha256": protocol["catalog"]["sha256"],
            "sourceCommit": implementation_commit,
            "sourceContractSha256": source_contract_sha256,
            "environmentSha256": sha256(environment_path),
            "authorizationTokenId": authorization_token_id,
            "previousAuditSha256": previous_audit_sha256,
            "auditChain": audit_chain,
            "rawGenerationCommitment": tree_commitment(root / "data" / f"gen{generation}"),
            "promotionEligible": False,
        }
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--gen", type=int, required=True)
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()
    result = audit(args.root, args.gen, args.protocol)
    payload = json.dumps(result, indent=2, allow_nan=False) + "\n"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.out.exists():
        raise FileExistsError(args.out)
    temporary = args.out.with_name(f".{args.out.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, args.out)
        temporary.unlink()
        directory = os.open(args.out.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    if not args.quiet:
        print(payload, end="")


if __name__ == "__main__":
    main()
