#!/usr/bin/env python3
"""Build a fully signed, synthetic P30 analyzer fixture without real outcomes."""

from __future__ import annotations

import copy
import datetime as dt
import hashlib
import json
import os
import random
from pathlib import Path
from typing import Any, Mapping

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from analyze_v35_p30_long_horizon import (
    ARMS,
    CONTROL,
    INPUT_SCHEMA,
    REPLICATES,
    REPORT_SCHEMA,
    REPO_ROOT,
    endpoint_label,
    read_json_object,
    sha256,
    signed_inventory_merkle_root,
    validate_protocol,
    validate_root_materialization,
)
from audit_v35_p30_generation import source_identity
from issue_v35_p30_analysis_bundle import (
    build_analysis_authorization_payload,
    rebind_reviewed_analysis_authorization_times,
)
from issue_v35_p30_pair_integrity import build as build_pair_integrity_payload
from v35_p30_analysis_review import (
    ANALYSIS_REVIEW_ATTEMPT_SCHEMA,
    ANALYSIS_REVIEW_RECEIPT_SCHEMA,
    APPROVED_CLAUDE_EXECUTABLE,
    APPROVED_REVIEW_CONTAINER,
    APPROVED_REVIEW_RUNTIME,
    CLAUDE_AUTH_DELIVERY,
    CLOCK_SKEW_SCHEMA,
    CONTAINER_REVIEW_ROOT,
    LOCAL_REVIEW_LAUNCHER_RELATIVE,
    REVIEW_LIVENESS_PROMPT,
    REVIEW_LIVENESS_SCHEMA,
    REVIEW_LIVENESS_STDOUT,
    SANITIZED_ENVIRONMENT_KEYS,
    expected_argv,
    expected_container_cleanup_argv,
    expected_container_config,
    expected_container_create_argv,
    expected_container_start_argv,
    liveness_claude_argv,
    validate_analysis_review_receipt,
)
from v35_p30_authorized_execution import AUTHORIZATION_SCHEMA, RECEIPT_SCHEMA
from v35_p30_crypto import (
    ROLE_POLICIES,
    atomic_write_exclusive,
    canonical_json,
    public_key_identity,
    sha256_bytes,
    sha256_file,
    sign_payload,
)
from run_v35_p30_analysis_review_local import build_analysis_review_payload
from v35_p30_phase0 import (
    analyzer_rehearsal_campaign_id,
    analyzer_rehearsal_ledger_root,
    analyzer_rehearsal_protocol_path,
    analyzer_rehearsal_result_root,
)


FINAL_BARRIER_SCHEMA = "arc-v35-p30-final-generation-completeness-v1"
PAIR_SCHEMA = "arc-v35-p30-evaluation-pair-integrity-v1"
EVALUATION_RECEIPT_SCHEMA = "arc-v35-p30-evaluation-receipt-v1"
EVALUATION_INNER_SCHEMA = "arc-v35-p30-evaluation-inner-execution-v1"
ROOT_BINDING_SCHEMA = "arc-v35-root-binding-v1"
EMPTY_SHA256 = sha256_bytes(b"")
SOURCE_LOCK_RELATIVE = (
    "ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/source-lock.json"
)
BASE_CONFIG = REPO_ROOT / "ml/league/configs/fair-v35-late-credit-base.json"


def utc(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def write_json(path: Path, value: Any) -> None:
    atomic_write_exclusive(path, canonical_json(value) + b"\n")


def binding(path: Path) -> dict[str, str]:
    return {"path": str(path.resolve()), "sha256": sha256_file(path.resolve())}


def source_contract_path(protocol: Mapping[str, Any]) -> Path:
    path = Path(protocol["sourceContract"]["artifact"])
    return path if path.is_absolute() else REPO_ROOT / path


def write_bytes(path: Path, payload: bytes) -> None:
    atomic_write_exclusive(path, payload)


def generate_keypair(root: Path, role: str) -> tuple[Path, Path]:
    private = root / f"{role}.private.pem"
    public = root / f"{role}.public.pem"
    key = Ed25519PrivateKey.generate()
    write_bytes(
        private,
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ),
    )
    write_bytes(
        public,
        key.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ),
    )
    os.chmod(private, 0o600)
    os.chmod(public, 0o600)
    return private, public


def sign_to(
    path: Path,
    payload: Mapping[str, Any],
    *,
    role: str,
    keys: Mapping[str, tuple[Path, Path]],
) -> Path:
    private, public = keys[role]
    descriptor = os.open(private, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
    try:
        signed = dict(payload)
        signed["signature"] = sign_payload(
            signed,
            role=role,
            private_key_fd=descriptor,
            public_key_path=public,
        )
    finally:
        os.close(descriptor)
    write_json(path, signed)
    return path


def trust_roles(keys: Mapping[str, tuple[Path, Path]]) -> dict[str, Any]:
    roles: dict[str, Any] = {}
    for role, policy in ROLE_POLICIES.items():
        public = keys[role][1]
        key_id, der = public_key_identity(public)
        roles[role] = {
            "publicKeyPath": str(public),
            "publicKeyPemSha256": sha256_file(public),
            "publicKeyDerSha256": der,
            "keyId": key_id,
            "allowedArtifactSchemas": policy["artifactSchemas"],
            "allowedKinds": policy["kinds"],
        }
    return roles


def make_request(
    ledger: Path,
    *,
    name: str,
    protocol_path: Path,
    campaign_id: str,
    role: str,
    verb: str,
    subject: Mapping[str, Any],
    predecessor: Path | None,
    output: Path,
) -> dict[str, str]:
    path = ledger / "requests" / f"{name}.json"
    payload = {
        "schemaVersion": "arc-v35-p30-role-request-v1",
        "campaignInstanceId": campaign_id,
        "protocol": binding(protocol_path),
        "role": role,
        "verb": verb,
        "subject": dict(subject),
        "predecessorSha256": None if predecessor is None else sha256_file(predecessor),
        "expectedOutputPath": str(output.resolve()),
        "requestNonce": sha256_bytes(f"synthetic-request:{name}".encode()),
    }
    write_json(path, payload)
    return binding(path)


def artifact(path: Path) -> dict[str, Any]:
    return {"path": str(path.resolve()), "sha256": sha256_file(path), "bytes": path.stat().st_size}


def consumed_marker(
    path: Path,
    *,
    token: str,
    authorization_path: Path,
    started: str,
) -> Path:
    write_json(
        path,
        {
            "schemaVersion": "arc-v35-p30-consumed-token-v1",
            "tokenId": token,
            "authorizationPath": str(authorization_path.resolve()),
            "authorizationSha256": sha256_file(authorization_path),
            "consumedAtUtc": started,
            "consumerPid": 1,
            "host": "synthetic-rehearsal",
            "bootId": "synthetic-rehearsal",
        },
    )
    return path


def base_receipt(
    *,
    kind: str,
    token: str,
    campaign_id: str,
    authorization_path: Path,
    consumed_path: Path,
    started: str,
    finished: str,
    subject: Mapping[str, Any],
    command: Mapping[str, Any],
    predecessor: Mapping[str, str] | None,
    execution_request: Mapping[str, str],
    artifacts: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "schemaVersion": RECEIPT_SCHEMA,
        "valid": True,
        "promotionEligible": False,
        "kind": kind,
        "tokenId": token,
        "campaignId": campaign_id,
        "authorization": binding(authorization_path),
        "consumedMarker": binding(consumed_path),
        "startedAtUtc": started,
        "finishedAtUtc": finished,
        "subject": dict(subject),
        "command": dict(command),
        "isolation": {"synthetic": True},
        "process": {"synthetic": True},
        "exitCode": 0,
        "noSupervisorChildRemaining": True,
        "gpuBefore": None,
        "gpuAfter": None,
        "gpuEmptyAfter": True,
        "leaseReleased": True,
        "missingRequiredOutputs": [],
        "artifacts": dict(artifacts),
        "predecessor": None if predecessor is None else dict(predecessor),
        "executionRequest": dict(execution_request),
    }


def synthetic_row(seed: int, guardian: str, strength: int) -> dict[str, Any]:
    final_vp = 27 + seed % 5 + strength
    won = final_vp >= 30
    first30 = 25 - strength if won else None
    post15 = 1.0 + strength * 0.15 + (seed % 3) * 0.01
    engine = 7 + strength
    return {
        "seed": seed,
        "guardian": guardian,
        "trueWin": won,
        "stalled": False,
        "finalVP": final_vp,
        "first30Round": first30,
        "post15VpPerRound": post15,
        "finalAttackDice": engine,
        "finalSpirits": engine,
        "finalMaxBarrier": engine,
        "cycle": {
            "decisions": 12,
            "productiveDecisions": 9,
            "optionalYieldDecisions": 2,
            "locationInteractions": 5,
            "summons": 2,
            "awakens": 1,
            "combats": 2,
            "rewards": 2,
            "pvpAttacks": 0,
            "first15Round": 14,
            "first30Round": first30,
            "post15VpPerRound": post15,
            "finalAttackDice": engine,
            "finalSpirits": engine,
            "finalMaxBarrier": engine,
            "vpAfterRound": {"15": 14 + strength, "30": final_vp},
        },
    }


def synthetic_report(
    *,
    protocol: Mapping[str, Any],
    guardians: tuple[str, ...],
    replicate: str,
    arm: str,
    checkpoint: Path,
    config_sha256: str,
    binding_sha256: str,
    root: Path,
    socket: str,
    source_commit: str,
) -> dict[str, Any]:
    strength = 0 if arm == CONTROL else (2 if arm == "uniform-040" else 1)
    seed0 = protocol["seedSchedule"]["commonPublicBase"]
    games = protocol["seedSchedule"]["commonPublicGames"]
    rows = [
        synthetic_row(seed, guardians[seed % len(guardians)], strength)
        for seed in range(seed0, seed0 + games)
    ]
    wins = sum(row["trueWin"] for row in rows)
    return {
        "schemaVersion": REPORT_SCHEMA,
        "executionIdentity": {
            "experiment": protocol["experiment"],
            "replicate": replicate,
            "arm": arm,
            "configSha256": config_sha256,
            "bindingSha256": binding_sha256,
            "root": str(root.resolve()),
        },
        "sourceCommit": source_commit,
        "weightsSha256": sha256_file(checkpoint),
        "catalogSha256": protocol["catalog"]["sha256"],
        "seed0": seed0,
        "games": games,
        "maxRounds": 30,
        "maxStatusLevel": 2,
        "inference": {
            "format": protocol["initialPolicy"]["format"],
            "obsDim": protocol["initialPolicy"]["obsDim"],
            "actDim": protocol["initialPolicy"]["actDim"],
            "weightsPath": str(checkpoint.resolve()),
            "weightsSha256": sha256_file(checkpoint),
            "wire": protocol["initialPolicy"]["wire"],
        },
        "decode": {
            "policyObsVersion": protocol["initialPolicy"]["policyObsVersion"],
            "inferenceSocket": socket,
            "learnMonsterRewardChoices": False,
            "sample": True,
            "temperature": protocol["training"]["temperature"],
        },
        "performance": {
            "wallSeconds": 1.0,
            "gamesPerSecond": float(games),
            "workers": protocol["training"]["workers"],
            "gameWallMsP50": 100.0 + strength,
            "gameWallMsP95": 125.0 + strength,
        },
        "perGame": rows,
        "trueWins": wins,
        "trueWinRate": wins / games,
        "stalls": 0,
        "stallRate": 0.0,
        "reach15Rate": 1.0,
        "replayHashes": [
            {
                "seed": row["seed"],
                "replayTraceSha256": sha256_bytes(
                    f"synthetic:{replicate}:{arm}:{row['seed']}".encode()
                ),
            }
            for row in rows
        ],
    }


def materialize_config(
    root: Path,
    *,
    protocol: Mapping[str, Any],
    protocol_path: Path,
    replicate: str,
    arm: str,
) -> tuple[Path, Path]:
    config = copy.deepcopy(read_json_object(BASE_CONFIG, "P30 base config"))
    replicate_contract = next(row for row in protocol["replicates"] if row["id"] == replicate)
    arm_contract = next(row for row in protocol["arms"] if row["id"] == arm)
    schedule = protocol["seedSchedule"]
    expected_root = (
        "ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/"
        f"league/rep-{replicate}/{arm}"
    )
    config.update(
        {
            "seedBase": replicate_contract["trainBase"],
            "seedSchedule": {
                "trainBase": replicate_contract["trainBase"],
                "trainStride": schedule["trainStride"],
                "evalBase": replicate_contract["evalBase"],
                "evalStride": schedule["evalStride"],
                "maxGeneration": schedule["maxGeneration"],
            },
            "initFrom": protocol["initialPolicy"]["path"],
            "laneInit": {"main-0": protocol["initialPolicy"]["path"]},
            "paths": {"root": expected_root},
        }
    )
    extra = config["train"]["extraArgs"]
    scalar = extra.index("--solo-reach30-coef")
    extra[scalar + 1] = f"{float(arm_contract['soloReach30Coef']):g}"
    if arm_contract["soloReach30Bands"] is not None:
        extra.extend(
            [
                "--solo-reach30-bands",
                ",".join(
                    f"{upper}:{float(coefficient):g}"
                    for upper, coefficient in arm_contract["soloReach30Bands"]
                ),
            ]
        )
    config_path = root / "config.json"
    write_json(config_path, config)
    binding_path = root / "v35-binding.json"
    write_json(
        binding_path,
        {
            "schemaVersion": ROOT_BINDING_SCHEMA,
            "experiment": protocol["experiment"],
            "replicate": replicate,
            "arm": arm,
            "protocolPath": str(protocol_path.resolve()),
            "protocolSha256": sha256_file(protocol_path),
            "configSha256": sha256_file(config_path),
            "catalogSha256": protocol["catalog"]["sha256"],
            "initialPolicySha256": protocol["initialPolicy"]["sha256"],
            "promotionEligible": False,
        },
    )
    validate_root_materialization(
        config_path=config_path,
        binding_path=binding_path,
        protocol=protocol,
        protocol_path=protocol_path,
        replicate=replicate,
        arm=arm,
    )
    return config_path, binding_path


def build_generation_chain(
    root: Path,
    *,
    protocol: Mapping[str, Any],
    protocol_path: Path,
    ledger: Path,
    keys: Mapping[str, tuple[Path, Path]],
    replicate: str,
    arm: str,
    source_commit: str,
    source_contract_sha256: str,
    time_base: dt.datetime,
) -> tuple[list[Path], Path, Path, Path, Path]:
    config_path, binding_path = materialize_config(
        root,
        protocol=protocol,
        protocol_path=protocol_path,
        replicate=replicate,
        arm=arm,
    )
    artifacts_root = root / "artifacts"
    checkpoints_root = root / "checkpoints"
    artifacts_root.mkdir()
    checkpoints_root.mkdir()
    policy_manifest = {
        "format": protocol["initialPolicy"]["format"],
        "obs_version": protocol["initialPolicy"]["policyObsVersion"],
        "obs_flat_len": protocol["initialPolicy"]["obsDim"],
        "act_dim": protocol["initialPolicy"]["actDim"],
        "d_model": 128,
        "layers": 3,
        "heads": 4,
        "params": 1,
        "reach30_horizons": protocol["initialPolicy"]["reach30Horizons"],
        "reach30_trained": protocol["initialPolicy"]["reach30Trained"],
    }
    arm_contract = next(row for row in protocol["arms"] if row["id"] == arm)
    replicate_contract = next(row for row in protocol["replicates"] if row["id"] == replicate)
    audit_chain: list[dict[str, Any]] = []
    receipt_paths: list[Path] = []
    predecessor: Path | None = None
    maximum = protocol["seedSchedule"]["maxGeneration"]
    for generation in range(1, maximum + 1):
        label = endpoint_label(replicate, arm)
        token = sha256_bytes(
            f"synthetic-generation:{protocol['executionTrust']['campaignInstanceId']}:{label}:{generation}".encode()
        )
        authorization_path = ledger / "authorizations" / f"{label}-gen{generation}.json"
        request = make_request(
            ledger,
            name=f"issue-{label}-gen{generation}",
            protocol_path=protocol_path,
            campaign_id=protocol["executionTrust"]["campaignInstanceId"],
            role="issuer",
            verb="issue-generation",
            subject={
                "logicalId": f"{label}-gen{generation}",
                "replicate": replicate,
                "arm": arm,
                "generation": generation,
                "root": str(root.resolve()),
            },
            predecessor=predecessor,
            output=authorization_path,
        )
        checkpoint = checkpoints_root / f"main-0-gen{generation}.pt"
        checkpoint_manifest = checkpoint.with_suffix(".manifest.json")
        write_bytes(checkpoint, f"synthetic-checkpoint:{label}:{generation}\n".encode())
        write_json(checkpoint_manifest, policy_manifest)
        audit_path = artifacts_root / f"gen{generation}-audit.json"
        generation_offset = generation - 1
        train_min = (
            replicate_contract["trainBase"]
            + generation_offset * protocol["seedSchedule"]["trainStride"]
        )
        eval_min = (
            replicate_contract["evalBase"]
            + generation_offset * protocol["seedSchedule"]["evalStride"]
        )
        treatment_enabled = arm_contract["soloReach30Coef"] > 0 or bool(
            arm_contract["soloReach30Bands"]
        )
        applied_by_band = (
            {"1-8": 3, "9-18": 3, "19-30": 4}
            if treatment_enabled
            else {"1-8": 0, "9-18": 0, "19-30": 0}
        )
        dose_coefficients = (
            [float(arm_contract["soloReach30Coef"])] * 3
            if arm_contract["soloReach30Bands"] is None
            else [float(entry[1]) for entry in arm_contract["soloReach30Bands"]]
        )
        dose_by_band = {
            band: applied_by_band[band] * coefficient
            for band, coefficient in zip(
                ("1-8", "9-18", "19-30"),
                dose_coefficients,
                strict=True,
            )
        }
        audit = {
            "schemaVersion": "arc-v35-generation-audit-v1",
            "valid": True,
            "generation": generation,
            "root": str(root.resolve()),
            "replicate": replicate,
            "arm": arm,
            "checkpointSha256": sha256_file(checkpoint),
            "manifestSha256": sha256_file(checkpoint_manifest),
            "protocolSha256": sha256_file(protocol_path),
            "configSha256": sha256_file(config_path),
            "bindingSha256": sha256_file(binding_path),
            "catalogSha256": protocol["catalog"]["sha256"],
            "sourceCommit": source_commit,
            "sourceContractSha256": source_contract_sha256,
            "environmentSha256": sha256_bytes(f"synthetic-environment:{label}:{generation}".encode()),
            "authorizationTokenId": token,
            "previousAuditSha256": None if not audit_chain else audit_chain[-1]["sha256"],
            "auditChain": copy.deepcopy(audit_chain),
            "promotionEligible": False,
            "trustedCoreAuditSchema": "arc-v32-generation-audit-v1",
            "games": protocol["seedSchedule"]["gamesPerGeneration"],
            "stalls": 0,
            "evaluationStalls": 0,
            "malformedEpisodes": 0,
            "malformedRows": 0,
            "trainingSeeds": {
                "min": train_min,
                "max": train_min + protocol["seedSchedule"]["gamesPerGeneration"] - 1,
                "count": protocol["seedSchedule"]["gamesPerGeneration"],
            },
            "evaluationSeeds": {
                "min": eval_min,
                "max": eval_min + protocol["seedSchedule"]["evalGamesPerGeneration"] - 1,
                "count": protocol["seedSchedule"]["evalGamesPerGeneration"],
            },
            "rows": 100,
            "policyRows": 90,
            "behaviorLogpMaxAbsError": 0.0001,
            "behaviorReach30Calibration": {
                "ece": 0.05,
                "brier": 0.1,
                "constant_brier": 0.2,
                "rows": 100.0,
            },
            "epochMetrics": [
                {
                    "epoch": epoch,
                    "approxKl": 0.01,
                    "clipFraction": 0.1,
                    "roundWeightedKl": 0.01,
                    "roundWeightedClipFraction": 0.1,
                    "optimizerSteps": protocol["training"]["optimizerStepsPerEpoch"],
                }
                for epoch in range(1, protocol["training"]["epochs"] + 1)
            ],
            "soloReach30Bands": arm_contract["soloReach30Bands"],
            "soloReach30Credit": {
                "soloReach30Coef": arm_contract["soloReach30Coef"],
                "reach30Horizon": "30",
                "soloReach30Applied": 10 if treatment_enabled else 0,
                "soloReach30AppliedByBand": applied_by_band,
                "soloReach30DoseByBand": dose_by_band,
                "soloReach30RealizedDose": sum(dose_by_band.values()),
            },
            "rawGenerationCommitment": {
                "sha256": sha256_bytes(f"synthetic-raw:{label}:{generation}".encode()),
                "files": 2,
                "bytes": 10,
            },
        }
        write_json(audit_path, audit)
        audit_chain.append(
            {
                "generation": generation,
                "path": str(audit_path.resolve()),
                "sha256": sha256_file(audit_path),
                "checkpointSha256": sha256_file(checkpoint),
            }
        )
        started = utc(time_base + dt.timedelta(seconds=generation * 2))
        finished = utc(time_base + dt.timedelta(seconds=generation * 2 + 1))
        subject = {
            "root": str(root.resolve()),
            "replicate": replicate,
            "arm": arm,
            "generation": generation,
            "protocolSha256": sha256_file(protocol_path),
            "sourceCommit": source_commit,
            "sourceContractSha256": source_contract_sha256,
            "configSha256": sha256_file(config_path),
            "bindingSha256": sha256_file(binding_path),
            "inputCheckpointPath": (
                protocol["initialPolicy"]["path"]
                if generation == 1
                else str((checkpoints_root / f"main-0-gen{generation - 1}.pt").resolve())
            ),
            "inputCheckpointSha256": (
                protocol["initialPolicy"]["sha256"]
                if generation == 1
                else sha256_file(checkpoints_root / f"main-0-gen{generation - 1}.pt")
            ),
        }
        command = {
            "argv": ["synthetic-generation", label, str(generation)],
            "cwd": str(REPO_ROOT),
            "env": {},
            "executableSha256": sha256_bytes(b"synthetic-generation"),
        }
        predecessor_binding = None if predecessor is None else {
            "receiptPath": str(predecessor.resolve()),
            "sha256": sha256_file(predecessor),
        }
        authorization = {
            "schemaVersion": AUTHORIZATION_SCHEMA,
            "authorized": True,
            "immutable": True,
            "promotionEligible": False,
            "kind": "generation",
            "tokenId": token,
            "campaignId": protocol["experiment"],
            "issuedAtUtc": started,
            "notBeforeUtc": started,
            "expiresAtUtc": utc(time_base + dt.timedelta(hours=1)),
            "protocol": binding(protocol_path),
            "sourceContract": {
                "path": str(source_contract_path(protocol).resolve()),
                "sha256": source_contract_sha256,
            },
            "subject": subject,
            "command": command,
            "isolation": {"synthetic": True},
            "outputs": {},
            "ledger": {
                "root": str(ledger),
                "consumedPath": str(ledger / f"{token}.consumed.json"),
                "receiptPath": str(ledger / f"{token}.receipt.json"),
                "leasePath": protocol["executionTrust"]["leasePath"],
            },
            "predecessor": predecessor_binding,
            "request": request,
        }
        sign_to(authorization_path, authorization, role="issuer", keys=keys)
        consumed_path = consumed_marker(
            ledger / f"{token}.consumed.json",
            token=token,
            authorization_path=authorization_path,
            started=started,
        )
        receipt_path = ledger / f"{token}.receipt.json"
        execution_request = make_request(
            ledger,
            name=f"execute-{label}-gen{generation}",
            protocol_path=protocol_path,
            campaign_id=protocol["executionTrust"]["campaignInstanceId"],
            role="executor",
            verb="execute",
            subject={
                "logicalId": f"{label}-gen{generation}",
                "authorizationPath": str(authorization_path.resolve()),
                "replicate": replicate,
                "arm": arm,
                "generation": generation,
            },
            predecessor=authorization_path,
            output=receipt_path,
        )
        receipt = base_receipt(
            kind="generation",
            token=token,
            campaign_id=protocol["experiment"],
            authorization_path=authorization_path,
            consumed_path=consumed_path,
            started=started,
            finished=finished,
            subject=subject,
            command=command,
            predecessor=predecessor_binding,
            execution_request=execution_request,
            artifacts={"audit": artifact(audit_path), "checkpoint": artifact(checkpoint)},
        )
        sign_to(receipt_path, receipt, role="executor", keys=keys)
        receipt_paths.append(receipt_path)
        predecessor = receipt_path
    return receipt_paths, checkpoint, checkpoint_manifest, config_path, binding_path


def build_legacy_evaluation_receipt(
    path: Path,
    *,
    role: str,
    label: str,
    replicate: str,
    arm: str,
    protocol: Mapping[str, Any],
    source_commit: str,
    checkpoint: Path,
    report_path: Path,
    stdout_path: Path,
    stderr_path: Path,
    exit_path: Path,
    server_log_path: Path,
    socket: str,
    config_sha256: str,
    binding_sha256: str,
    root: Path,
    started: str,
    finished: str,
) -> Path:
    argv = [
        "/usr/bin/node",
        "scripts/evaluate-solo-checkpoint.mjs",
        "--weights",
        str(checkpoint.resolve()),
        "--infer-socket",
        socket,
        "--policy-obs-version",
        str(protocol["initialPolicy"]["policyObsVersion"]),
        "--catalog",
        str((REPO_ROOT / protocol["catalog"]["path"]).resolve()),
        "--source-commit",
        source_commit,
        "--experiment",
        protocol["experiment"],
        "--replicate",
        replicate,
        "--arm",
        arm,
        "--config-sha256",
        config_sha256,
        "--binding-sha256",
        binding_sha256,
        "--root-identity",
        str(root.resolve()),
        "--games",
        str(protocol["seedSchedule"]["commonPublicGames"]),
        "--workers",
        str(protocol["training"]["workers"]),
        "--seed0",
        str(protocol["seedSchedule"]["commonPublicBase"]),
        "--max-rounds",
        str(protocol["training"]["maxRounds"]),
        "--max-status-level",
        str(protocol["training"]["soloMaxStatusLevel"]),
        "--sample",
        "--temperature",
        str(protocol["training"]["temperature"]),
        "--include-games",
        "--include-replay-hashes",
        "--quiet",
        "--out",
        str(report_path.resolve()),
    ]
    write_json(
        path,
        {
            "schemaVersion": EVALUATION_RECEIPT_SCHEMA,
            "valid": True,
            "attemptId": f"{label}:{role}:attempt-{'1' if role == 'primary' else '2'}",
            "role": role,
            "label": label,
            "replicate": replicate,
            "arm": arm,
            "malformedEpisodes": 0,
            "startedAtUtc": started,
            "finishedAtUtc": finished,
            "execution": {
                "cwd": str(REPO_ROOT),
                "argv": argv,
                "env": {"CUDA_VISIBLE_DEVICES": ""},
                "inferenceSocket": socket,
            },
            "contract": {
                "sourceCommit": source_commit,
                "catalogSha256": protocol["catalog"]["sha256"],
                "checkpointSha256": sha256_file(checkpoint),
                "seed0": protocol["seedSchedule"]["commonPublicBase"],
                "games": protocol["seedSchedule"]["commonPublicGames"],
                "maxRounds": protocol["training"]["maxRounds"],
                "maxStatusLevel": protocol["training"]["soloMaxStatusLevel"],
                "workers": protocol["training"]["workers"],
                "policyObsVersion": protocol["initialPolicy"]["policyObsVersion"],
                "sample": protocol["training"]["sample"],
                "temperature": protocol["training"]["temperature"],
                "includeGames": True,
                "includeReplayHashes": True,
                "configSha256": config_sha256,
                "bindingSha256": binding_sha256,
                "root": str(root.resolve()),
            },
            "artifacts": {
                "checkpoint": {"path": str(checkpoint.resolve()), "sha256": sha256_file(checkpoint)},
                "report": {"path": str(report_path.resolve()), "sha256": sha256_file(report_path)},
                "stdout": {"path": str(stdout_path.resolve()), "sha256": sha256_file(stdout_path)},
                "stderr": {"path": str(stderr_path.resolve()), "sha256": sha256_file(stderr_path)},
                "exitCode": {"path": str(exit_path.resolve()), "sha256": sha256_file(exit_path)},
                "serverLog": {"path": str(server_log_path.resolve()), "sha256": sha256_file(server_log_path)},
            },
        },
    )
    return path


def build_evaluation(
    root: Path,
    *,
    protocol: Mapping[str, Any],
    protocol_path: Path,
    ledger: Path,
    keys: Mapping[str, tuple[Path, Path]],
    replicate: str,
    arm: str,
    source_commit: str,
    source_contract_sha256: str,
    checkpoint: Path,
    config_path: Path,
    binding_path: Path,
    final_generation_receipt: Path,
    guardians: tuple[str, ...],
    time_base: dt.datetime,
) -> tuple[dict[str, Path], dict[str, Any]]:
    label = endpoint_label(replicate, arm)
    result: dict[str, Path] = {}
    predecessor = final_generation_receipt
    report_values: dict[str, Any] = {}
    for ordinal, role in enumerate(("primary", "replay"), 1):
        token = sha256_bytes(
            f"synthetic-evaluation:{protocol['executionTrust']['campaignInstanceId']}:{label}:{role}".encode()
        )
        eval_root = ledger / "evaluations" / label / role
        eval_root.mkdir(parents=True)
        report_path = eval_root / "report.json"
        socket = f"/tmp/synthetic-{label}-{role}.sock"
        report = synthetic_report(
            protocol=protocol,
            guardians=guardians,
            replicate=replicate,
            arm=arm,
            checkpoint=checkpoint,
            config_sha256=sha256_file(config_path),
            binding_sha256=sha256_file(binding_path),
            root=root,
            socket=socket,
            source_commit=source_commit,
        )
        write_json(report_path, report)
        stdout_path = eval_root / "evaluator.stdout"
        stderr_path = eval_root / "evaluator.stderr"
        exit_path = eval_root / "evaluator.exit-code"
        server_log_path = eval_root / "server.stdout"
        supervisor_stdout = eval_root / "supervisor.stdout"
        supervisor_stderr = eval_root / "supervisor.stderr"
        supervisor_exit = eval_root / "supervisor.exit-code"
        server_stderr = eval_root / "server.stderr"
        server_exit = eval_root / "server.exit-code"
        for empty in (stdout_path, stderr_path, supervisor_stdout, supervisor_stderr, server_stderr):
            write_bytes(empty, b"")
        for exit_file in (exit_path, supervisor_exit, server_exit):
            write_bytes(exit_file, b"0\n")
        write_bytes(server_log_path, f"synthetic-server:{label}:{role}\n".encode())
        started = utc(time_base + dt.timedelta(seconds=20 + ordinal * 2))
        finished = utc(time_base + dt.timedelta(seconds=21 + ordinal * 2))
        legacy_path = eval_root / "legacy-receipt.json"
        build_legacy_evaluation_receipt(
            legacy_path,
            role=role,
            label=label,
            replicate=replicate,
            arm=arm,
            protocol=protocol,
            source_commit=source_commit,
            checkpoint=checkpoint,
            report_path=report_path,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            exit_path=exit_path,
            server_log_path=server_log_path,
            socket=socket,
            config_sha256=sha256_file(config_path),
            binding_sha256=sha256_file(binding_path),
            root=root,
            started=started,
            finished=finished,
        )
        audit_path = root / "artifacts" / "gen8-audit.json"
        inner_path = eval_root / "inner-execution.json"
        write_json(
            inner_path,
            {
                "schemaVersion": EVALUATION_INNER_SCHEMA,
                "valid": True,
                "promotionEligible": False,
                "role": role,
                "attemptToken": token,
                "protocolSha256": sha256_file(protocol_path),
                "sourceCommit": source_commit,
                "sourceContractSha256": source_contract_sha256,
                "root": str(root.resolve()),
                "replicate": replicate,
                "arm": arm,
                "configSha256": sha256_file(config_path),
                "bindingSha256": sha256_file(binding_path),
                "checkpointSha256": sha256_file(checkpoint),
                "generationAuditSha256": sha256_file(audit_path),
                "socketPath": socket,
                "socketInode": ordinal,
                "report": binding(report_path),
                "legacyReceipt": binding(legacy_path),
            },
        )
        authorization_path = ledger / "authorizations" / f"{label}-{role}.json"
        authorization_request = make_request(
            ledger,
            name=f"issue-{label}-{role}",
            protocol_path=protocol_path,
            campaign_id=protocol["executionTrust"]["campaignInstanceId"],
            role="issuer",
            verb="issue-evaluation",
            subject={
                "logicalId": f"{label}-{role}",
                "replicate": replicate,
                "arm": arm,
                "evaluationRole": role,
                "root": str(root.resolve()),
            },
            predecessor=predecessor,
            output=authorization_path,
        )
        subject = {
            "root": str(root.resolve()),
            "replicate": replicate,
            "arm": arm,
            "role": role,
            "protocolSha256": sha256_file(protocol_path),
            "sourceCommit": source_commit,
            "sourceContractSha256": source_contract_sha256,
            "configSha256": sha256_file(config_path),
            "bindingSha256": sha256_file(binding_path),
            "checkpointPath": str(checkpoint.resolve()),
            "checkpointSha256": sha256_file(checkpoint),
            "generationAuditPath": str(audit_path.resolve()),
            "generationAuditSha256": sha256_file(audit_path),
            "seed0": protocol["seedSchedule"]["commonPublicBase"],
            "games": protocol["seedSchedule"]["commonPublicGames"],
        }
        command = {
            "argv": ["synthetic-evaluation", label, role],
            "cwd": str(REPO_ROOT),
            "env": {},
            "executableSha256": sha256_bytes(b"synthetic-evaluation"),
        }
        predecessor_binding = {"receiptPath": str(predecessor.resolve()), "sha256": sha256_file(predecessor)}
        authorization = {
            "schemaVersion": AUTHORIZATION_SCHEMA,
            "authorized": True,
            "immutable": True,
            "promotionEligible": False,
            "kind": f"evaluation-{role}",
            "tokenId": token,
            "campaignId": protocol["experiment"],
            "issuedAtUtc": started,
            "notBeforeUtc": started,
            "expiresAtUtc": utc(time_base + dt.timedelta(hours=1)),
            "protocol": binding(protocol_path),
            "sourceContract": {"path": str(source_contract_path(protocol).resolve()), "sha256": source_contract_sha256},
            "subject": subject,
            "command": command,
            "isolation": {"synthetic": True},
            "outputs": {},
            "ledger": {"root": str(ledger), "consumedPath": str(ledger / f"{token}.consumed.json"), "receiptPath": str(ledger / f"{token}.receipt.json"), "leasePath": protocol["executionTrust"]["leasePath"]},
            "predecessor": predecessor_binding,
            "request": authorization_request,
        }
        sign_to(authorization_path, authorization, role="issuer", keys=keys)
        consumed_path = consumed_marker(ledger / f"{token}.consumed.json", token=token, authorization_path=authorization_path, started=started)
        receipt_path = ledger / f"{token}.receipt.json"
        execution_request = make_request(
            ledger,
            name=f"execute-{label}-{role}",
            protocol_path=protocol_path,
            campaign_id=protocol["executionTrust"]["campaignInstanceId"],
            role="executor",
            verb="execute",
            subject={"logicalId": f"{label}-{role}", "authorizationPath": str(authorization_path.resolve()), "replicate": replicate, "arm": arm, "evaluationRole": role},
            predecessor=authorization_path,
            output=receipt_path,
        )
        outer_artifacts = {
            "evaluatorExitCode": artifact(exit_path),
            "evaluatorStderr": artifact(stderr_path),
            "evaluatorStdout": artifact(stdout_path),
            "exitCode": artifact(supervisor_exit),
            "innerExecution": artifact(inner_path),
            "legacyReceipt": artifact(legacy_path),
            "report": artifact(report_path),
            "serverExitCode": artifact(server_exit),
            "serverStderr": artifact(server_stderr),
            "serverStdout": artifact(server_log_path),
            "stderr": artifact(supervisor_stderr),
            "stdout": artifact(supervisor_stdout),
        }
        receipt = base_receipt(
            kind=f"evaluation-{role}", token=token, campaign_id=protocol["experiment"],
            authorization_path=authorization_path, consumed_path=consumed_path,
            started=started, finished=finished, subject=subject, command=command,
            predecessor=predecessor_binding, execution_request=execution_request,
            artifacts=outer_artifacts,
        )
        sign_to(receipt_path, receipt, role="executor", keys=keys)
        result[f"{role}Receipt"] = receipt_path
        result[f"{role}Legacy"] = legacy_path
        result[f"{role}Report"] = report_path
        result[f"{role}Exit"] = exit_path
        result[f"{role}Stdout"] = stdout_path
        result[f"{role}Stderr"] = stderr_path
        result[f"{role}Server"] = server_log_path
        report_values[role] = report
        predecessor = receipt_path
    if report_values["primary"]["perGame"] != report_values["replay"]["perGame"]:
        raise RuntimeError("synthetic primary/replay rows diverged")
    return result, report_values


def build_pair(
    *,
    protocol: Mapping[str, Any],
    protocol_path: Path,
    ledger: Path,
    keys: Mapping[str, tuple[Path, Path]],
    replicate: str,
    arm: str,
    root: Path,
    checkpoint: Path,
    evaluation: Mapping[str, Path],
    reports: Mapping[str, Any],
    issued: str,
) -> Path:
    label = endpoint_label(replicate, arm)
    path = ledger / "pairs" / f"{label}.json"
    request = make_request(
        ledger,
        name=f"attest-{label}-pair",
        protocol_path=protocol_path,
        campaign_id=protocol["executionTrust"]["campaignInstanceId"],
        role="guardian",
        verb="attest-pair",
        subject={"logicalId": f"{label}-pair", "replicate": replicate, "arm": arm},
        predecessor=evaluation["replayReceipt"],
        output=path,
    )
    payload = build_pair_integrity_payload(
        protocol_path=protocol_path,
        public_key_path=keys["executor"][1],
        primary_receipt_path=evaluation["primaryReceipt"],
        replay_receipt_path=evaluation["replayReceipt"],
    )
    payload["issuedAtUtc"] = issued
    payload["request"] = request
    return sign_to(path, payload, role="guardian", keys=keys)


def report_entry(
    *,
    label: str,
    replicate: str,
    arm: str,
    root: Path,
    checkpoint: Path,
    checkpoint_manifest: Path,
    config: Path,
    root_binding: Path,
    final_generation_receipt: Path,
    evaluation: Mapping[str, Path],
    pair: Path,
) -> dict[str, Any]:
    audit = root / "artifacts" / "gen8-audit.json"
    return {
        "label": label,
        "replicate": replicate,
        "arm": arm,
        "path": str(evaluation["primaryReport"].resolve()),
        "sha256": sha256_file(evaluation["primaryReport"]),
        "weightsSha256": sha256_file(checkpoint),
        "generationAuditPath": str(audit.resolve()),
        "generationAuditSha256": sha256_file(audit),
        "generationExecutionReceiptPath": str(final_generation_receipt.resolve()),
        "generationExecutionReceiptSha256": sha256_file(final_generation_receipt),
        "checkpointPath": str(checkpoint.resolve()),
        "checkpointManifestPath": str(checkpoint_manifest.resolve()),
        "checkpointManifestSha256": sha256_file(checkpoint_manifest),
        "configPath": str(config.resolve()),
        "configSha256": sha256_file(config),
        "bindingPath": str(root_binding.resolve()),
        "bindingSha256": sha256_file(root_binding),
        "exitCodePath": str(evaluation["primaryExit"].resolve()),
        "exitCodeSha256": sha256_file(evaluation["primaryExit"]),
        "evaluatorStdoutPath": str(evaluation["primaryStdout"].resolve()),
        "evaluatorStdoutSha256": sha256_file(evaluation["primaryStdout"]),
        "evaluatorStderrPath": str(evaluation["primaryStderr"].resolve()),
        "evaluatorStderrSha256": sha256_file(evaluation["primaryStderr"]),
        "serverLogPath": str(evaluation["primaryServer"].resolve()),
        "serverLogSha256": sha256_file(evaluation["primaryServer"]),
        "primaryReceiptPath": str(evaluation["primaryLegacy"].resolve()),
        "primaryReceiptSha256": sha256_file(evaluation["primaryLegacy"]),
        "primaryExecutionReceiptPath": str(evaluation["primaryReceipt"].resolve()),
        "primaryExecutionReceiptSha256": sha256_file(evaluation["primaryReceipt"]),
        "replayReportPath": str(evaluation["replayReport"].resolve()),
        "replayReportSha256": sha256_file(evaluation["replayReport"]),
        "replayExitCodePath": str(evaluation["replayExit"].resolve()),
        "replayExitCodeSha256": sha256_file(evaluation["replayExit"]),
        "replayEvaluatorStdoutPath": str(evaluation["replayStdout"].resolve()),
        "replayEvaluatorStdoutSha256": sha256_file(evaluation["replayStdout"]),
        "replayEvaluatorStderrPath": str(evaluation["replayStderr"].resolve()),
        "replayEvaluatorStderrSha256": sha256_file(evaluation["replayStderr"]),
        "replayServerLogPath": str(evaluation["replayServer"].resolve()),
        "replayServerLogSha256": sha256_file(evaluation["replayServer"]),
        "replayReceiptPath": str(evaluation["replayLegacy"].resolve()),
        "replayReceiptSha256": sha256_file(evaluation["replayLegacy"]),
        "replayExecutionReceiptPath": str(evaluation["replayReceipt"].resolve()),
        "replayExecutionReceiptSha256": sha256_file(evaluation["replayReceipt"]),
        "pairIntegrityPath": str(pair.resolve()),
        "pairIntegritySha256": sha256_file(pair),
    }


def inventory_entry(
    ordinal: int, kind: str, label: str, path: Path, token: str | None
) -> dict[str, Any]:
    return {
        "ordinal": ordinal,
        "kind": kind,
        "label": label,
        "path": str(path.resolve()),
        "sha256": sha256_file(path),
        "tokenId": token,
    }


def unsigned_token(path: Path) -> str:
    value = read_json_object(path, "synthetic signed receipt")
    token = value.get("tokenId")
    if not isinstance(token, str):
        raise ValueError("synthetic receipt lacks token")
    return token


def build_barrier_and_manifest(
    *,
    protocol: Mapping[str, Any],
    protocol_path: Path,
    ledger: Path,
    keys: Mapping[str, tuple[Path, Path]],
    endpoints: Mapping[str, Mapping[str, Any]],
    issued: dt.datetime,
) -> tuple[Path, Path, list[str], list[str]]:
    barrier_path = ledger / "barriers" / "final-generation-complete.json"
    barrier_request = make_request(
        ledger,
        name="attest-final-generation-barrier",
        protocol_path=protocol_path,
        campaign_id=protocol["executionTrust"]["campaignInstanceId"],
        role="guardian",
        verb="attest-final-barrier",
        subject={"logicalId": "final-generation-barrier"},
        predecessor=None,
        output=barrier_path,
    )
    barrier_endpoints = []
    for replicate in REPLICATES:
        for arm in ARMS:
            label = endpoint_label(replicate, arm)
            endpoint = endpoints[label]
            barrier_endpoints.append(
                {
                    "label": label,
                    "finalReceipt": binding(endpoint["generationReceipts"][-1]),
                    "finalAuditSha256": sha256_file(endpoint["root"] / "artifacts" / "gen8-audit.json"),
                    "finalCheckpointSha256": sha256_file(endpoint["checkpoint"]),
                }
            )
    sign_to(
        barrier_path,
        {
            "schemaVersion": FINAL_BARRIER_SCHEMA,
            "valid": True,
            "promotionEligible": False,
            "outcomesInspected": False,
            "issuedAtUtc": utc(issued),
            "protocol": binding(protocol_path),
            "endpointCount": 54,
            "endpoints": barrier_endpoints,
            "diagnosticCodes": ["ALL_FINAL_GENERATION_CHAINS_COMPLETE"],
            "request": barrier_request,
        },
        role="guardian",
        keys=keys,
    )
    inventory = [inventory_entry(0, "final-generation-barrier", "final-generation-barrier", barrier_path, None)]
    ordinal = 1
    canonical_entries: list[dict[str, Any]] = []
    for replicate in REPLICATES:
        for arm in ARMS:
            label = endpoint_label(replicate, arm)
            endpoint = endpoints[label]
            for generation, path in enumerate(endpoint["generationReceipts"], 1):
                inventory.append(inventory_entry(ordinal, "generation", f"{label}-gen{generation}", path, unsigned_token(path)))
                ordinal += 1
            for role in ("primary", "replay"):
                path = endpoint["evaluation"][f"{role}Receipt"]
                inventory.append(inventory_entry(ordinal, f"evaluation-{role}", f"{label}-{role}", path, unsigned_token(path)))
                ordinal += 1
            inventory.append(inventory_entry(ordinal, "evaluation-pair", f"{label}-pair", endpoint["pair"], None))
            ordinal += 1
            canonical_entries.append(endpoint["reportEntry"])
    if len(inventory) != 595 or len({entry["tokenId"] for entry in inventory if entry["tokenId"] is not None}) != 540:
        raise RuntimeError("synthetic receipt inventory cardinality changed")
    shuffled_entries = list(canonical_entries)
    random.Random(0xAA80).shuffle(shuffled_entries)
    canonical_labels = [entry["label"] for entry in canonical_entries]
    shuffled_labels = [entry["label"] for entry in shuffled_entries]
    if canonical_labels == shuffled_labels:
        raise RuntimeError("synthetic report label permutation was not applied")
    manifest_path = ledger / "analysis" / "input-manifest.signed.json"
    last_pair = endpoints[endpoint_label(REPLICATES[-1], ARMS[-1])]["pair"]
    manifest_request = make_request(
        ledger,
        name="attest-analysis-manifest",
        protocol_path=protocol_path,
        campaign_id=protocol["executionTrust"]["campaignInstanceId"],
        role="guardian",
        verb="attest-analysis-manifest",
        subject={"logicalId": "final-analysis-manifest", "finalGenerationBarrier": binding(barrier_path)},
        predecessor=last_pair,
        output=manifest_path,
    )
    source_path = source_contract_path(protocol)
    manifest = {
        "schemaVersion": INPUT_SCHEMA,
        "valid": True,
        "immutable": True,
        "promotionEligible": False,
        "outcomesInspected": False,
        "metricsIncluded": False,
        "issuedAtUtc": utc(issued + dt.timedelta(seconds=1)),
        "campaignInstanceId": protocol["executionTrust"]["campaignInstanceId"],
        "protocol": binding(protocol_path),
        "sourceContract": {"path": str(source_path.resolve()), "sha256": protocol["sourceContract"]["sha256"]},
        "finalGenerationBarrier": binding(barrier_path),
        "receiptMerkleRoot": signed_inventory_merkle_root(inventory),
        "counts": {"endpoints": 54, "generationReceipts": 432, "evaluationReceipts": 108, "pairIntegrityReceipts": 54, "signedReceipts": 595, "uniqueExecutionTokens": 540},
        "signedReceiptInventory": inventory,
        "reports": shuffled_entries,
        "request": manifest_request,
    }
    sign_to(manifest_path, manifest, role="guardian", keys=keys)
    return barrier_path, manifest_path, canonical_labels, shuffled_labels


def build_synthetic_analysis_review(
    *,
    protocol: Mapping[str, Any],
    protocol_path: Path,
    ledger: Path,
    keys: Mapping[str, tuple[Path, Path]],
    manifest_path: Path,
    analysis_out: Path,
    token: str,
    time_base: dt.datetime,
) -> tuple[Path, Path, Path, dict[str, Any]]:
    draft_path = ledger / "analysis" / "analysis-authorization.unsigned.json"
    review_receipt_path = ledger / "analysis" / "review" / "fable-analysis-authorization.receipt.json"
    final_authorization_path = ledger / "authorizations" / "final-analysis.json"
    analysis_request = make_request(
        ledger,
        name="issue-final-analysis",
        protocol_path=protocol_path,
        campaign_id=protocol["executionTrust"]["campaignInstanceId"],
        role="analysis-authorizer",
        verb="issue-analysis",
        subject={
            "logicalId": "final-analysis",
            "manifest": binding(manifest_path),
            "authorizationDraftPath": str(draft_path.resolve()),
            "reviewReceiptPath": str(review_receipt_path.resolve()),
            "analysisOut": str(analysis_out.resolve()),
        },
        predecessor=manifest_path,
        output=final_authorization_path,
    )
    draft = build_analysis_authorization_payload(
        protocol_path=protocol_path,
        manifest_path=manifest_path,
        request_binding=analysis_request,
        authorization_draft_path=draft_path,
        review_receipt_path=review_receipt_path,
        analysis_out=analysis_out,
        token_id=token,
        now=time_base,
    )
    write_json(draft_path, draft)
    review_root = ledger / "analysis" / "review"
    attempt_path = review_root / "fable-analysis-authorization.attempt.json"
    stdout_path = review_root / "fable-analysis-authorization.stdout"
    stderr_path = review_root / "fable-analysis-authorization.stderr"
    launcher_path = REPO_ROOT / LOCAL_REVIEW_LAUNCHER_RELATIVE
    launcher_sha = sha256_file(launcher_path)
    review_request = make_request(
        ledger,
        name="attest-final-analysis-review",
        protocol_path=protocol_path,
        campaign_id=protocol["executionTrust"]["campaignInstanceId"],
        role="review-attester",
        verb="attest-analysis-review",
        subject={
            "logicalId": "final-analysis-fable-review-attestation",
            "authorizationDraft": binding(draft_path),
            "manifest": binding(manifest_path),
            "reviewAttemptPath": str(attempt_path),
            "reviewStdoutPath": str(stdout_path),
            "reviewStderrPath": str(stderr_path),
            "reviewAttesterPublicKey": {
                "path": str(keys["review-attester"][1]),
                "sha256": sha256_file(keys["review-attester"][1]),
            },
            "claudeExecutable": APPROVED_CLAUDE_EXECUTABLE,
            "reviewRuntime": APPROVED_REVIEW_RUNTIME,
            "launcherSha256": launcher_sha,
        },
        predecessor=draft_path,
        output=review_receipt_path,
    )
    capsule = review_root / "synthetic-capsule"
    (capsule / "input").mkdir(parents=True)
    (capsule / "runtime-home").mkdir()
    (capsule / "tmp").mkdir()
    local_draft = capsule / "input" / "draft.json"
    local_manifest = capsule / "input" / "manifest.json"
    local_request = capsule / "input" / "request.json"
    local_attempt = capsule / "input" / "attempt.json"
    local_completion = capsule / "input" / "completion.json"
    local_stdout = capsule / "input" / "review.stdout"
    local_stderr = capsule / "input" / "review.stderr"
    local_source_lock = capsule / "input" / "source-lock.json"
    local_review_key = capsule / "input" / "review-attester.pem"
    source_path = source_contract_path(protocol)
    for source, target in (
        (draft_path, local_draft),
        (manifest_path, local_manifest),
        (Path(review_request["path"]), local_request),
        (source_path, local_source_lock),
        (keys["review-attester"][1], local_review_key),
    ):
        write_bytes(target, source.read_bytes())
    write_bytes(stdout_path, b"VERDICT: ACCEPT\n")
    write_bytes(stderr_path, b"")
    write_bytes(local_stdout, b"VERDICT: ACCEPT\n")
    write_bytes(local_stderr, b"")
    write_bytes(capsule / "liveness.stdout", REVIEW_LIVENESS_STDOUT)
    write_bytes(capsule / "liveness.stderr", b"")
    reserved = time_base + dt.timedelta(seconds=2)
    started = time_base + dt.timedelta(seconds=3)
    finished = time_base + dt.timedelta(seconds=4)
    liveness_started = time_base + dt.timedelta(seconds=1)
    liveness_finished = time_base + dt.timedelta(seconds=1, microseconds=1)
    container_name = f"arc-p30-review-{protocol['executionTrust']['campaignInstanceId'][:16]}"
    container_id = sha256_bytes(f"synthetic-container:{container_name}".encode())
    liveness_name = f"arc-p30-review-{sha256_bytes(f'synthetic-liveness:{container_name}'.encode())[:16]}"
    liveness_id = sha256_bytes(f"synthetic-container:{liveness_name}".encode())
    liveness_argv = liveness_claude_argv()
    liveness_create = expected_container_create_argv(
        capsule=capsule, container_name=liveness_name, claude_argv=liveness_argv
    )
    liveness_config = expected_container_config(
        capsule=capsule,
        container_name=liveness_name,
        container_id=liveness_id,
        claude_argv=liveness_argv,
    )
    liveness = {
        "schemaVersion": REVIEW_LIVENESS_SCHEMA,
        "valid": True,
        "immutable": True,
        "outcomesInspected": False,
        "promotionEligible": False,
        "model": "fable",
        "effort": "high",
        "tools": ["Read"],
        "noSessionPersistence": True,
        "authDelivery": CLAUDE_AUTH_DELIVERY,
        "prompt": REVIEW_LIVENESS_PROMPT,
        "containerArgv": liveness_create,
        "containerName": liveness_name,
        "containerInvocationSha256": sha256_bytes(canonical_json(liveness_create)),
        "containerId": liveness_id,
        "containerConfig": liveness_config,
        "containerConfigSha256": sha256_bytes(canonical_json(liveness_config)),
        "startArgv": expected_container_start_argv(liveness_name),
        "cleanupArgv": expected_container_cleanup_argv(liveness_name),
        "cleanupVerified": True,
        "startedAtUtc": utc(liveness_started),
        "finishedAtUtc": utc(liveness_finished),
        "exitCode": 0,
        "stdout": {"path": str(capsule / "liveness.stdout"), "sha256": sha256_bytes(REVIEW_LIVENESS_STDOUT), "bytes": len(REVIEW_LIVENESS_STDOUT)},
        "stderr": {"path": str(capsule / "liveness.stderr"), "sha256": EMPTY_SHA256, "bytes": 0},
    }
    clock = {
        "schemaVersion": CLOCK_SKEW_SCHEMA,
        "valid": True,
        "localBeforeUtc": utc(liveness_started),
        "remoteUtc": utc(liveness_started),
        "localAfterUtc": utc(liveness_started),
        "roundTripMs": 0,
        "absoluteSkewMs": 0,
    }
    container_draft = CONTAINER_REVIEW_ROOT / local_draft.relative_to(capsule)
    container_manifest = CONTAINER_REVIEW_ROOT / local_manifest.relative_to(capsule)
    container_request = CONTAINER_REVIEW_ROOT / local_request.relative_to(capsule)
    claude_argv = expected_argv(
        local_draft_path=container_draft,
        draft_sha256=sha256_file(draft_path),
        local_manifest_path=container_manifest,
        manifest_sha256=sha256_file(manifest_path),
        local_request_path=container_request,
        request_sha256=review_request["sha256"],
        remote_draft_path=str(draft_path),
        remote_manifest_path=str(manifest_path),
        claude_path=APPROVED_CLAUDE_EXECUTABLE["path"],
    )
    create_argv = expected_container_create_argv(
        capsule=capsule, container_name=container_name, claude_argv=claude_argv
    )
    container_config = expected_container_config(
        capsule=capsule,
        container_name=container_name,
        container_id=container_id,
        claude_argv=claude_argv,
    )
    attempt = {
        "schemaVersion": ANALYSIS_REVIEW_ATTEMPT_SCHEMA,
        "valid": True,
        "immutable": True,
        "outcomesInspected": False,
        "promotionEligible": False,
        "request": review_request,
        "authorizationDraft": binding(draft_path),
        "manifest": binding(manifest_path),
        "attemptPath": str(attempt_path),
        "receiptPath": str(review_receipt_path),
        "stdoutPath": str(stdout_path),
        "stderrPath": str(stderr_path),
        "sourceLockSha256": protocol["sourceContract"]["sha256"],
        "launcherSha256": launcher_sha,
        "claudeExecutable": APPROVED_CLAUDE_EXECUTABLE,
        "containerRuntime": APPROVED_REVIEW_CONTAINER,
        "containerName": container_name,
        "containerInvocationSha256": sha256_bytes(canonical_json(create_argv)),
        "containerId": container_id,
        "containerConfigSha256": sha256_bytes(canonical_json(container_config)),
        "authenticatedLiveness": liveness,
        "clockSkewPreflight": clock,
        "reservedAtUtc": utc(reserved),
    }
    write_json(attempt_path, attempt)
    write_bytes(local_attempt, attempt_path.read_bytes())
    write_json(local_completion, {"synthetic": True, "valid": True})
    status = {
        "authorizationDraft": binding(draft_path),
        "manifest": binding(manifest_path),
        "reviewAttestationRequest": review_request,
        "reviewAttemptPath": str(attempt_path),
        "reviewStdoutPath": str(stdout_path),
        "reviewStderrPath": str(stderr_path),
        "reviewAttesterPublicKey": {"path": str(keys["review-attester"][1]), "sha256": sha256_file(keys["review-attester"][1])},
    }
    review_payload = build_analysis_review_payload(
        status=status,
        repo_root=REPO_ROOT,
        capsule=capsule,
        manifest_local=local_manifest,
        draft_local=local_draft,
        request_local=local_request,
        source_lock_local=local_source_lock,
        review_attester_key_local=local_review_key,
        attempt_local=local_attempt,
        completion_path=local_completion,
        stdout_local=local_stdout,
        stderr_local=local_stderr,
        draft=draft,
        launcher_sha=launcher_sha,
        executable=APPROVED_CLAUDE_EXECUTABLE,
        claude_argv=claude_argv,
        container_argv=create_argv,
        container_name=container_name,
        container_invocation_sha256=sha256_bytes(canonical_json(create_argv)),
        container_id=container_id,
        container_config=container_config,
        container_config_sha256=sha256_bytes(canonical_json(container_config)),
        authenticated_liveness=liveness,
        clock_skew_preflight=clock,
        start_argv=expected_container_start_argv(container_name),
        cleanup_argv=expected_container_cleanup_argv(container_name),
        cleanup_verified=True,
        container_runtime=APPROVED_REVIEW_CONTAINER,
        started=utc(started),
        finished=utc(finished),
        exit_code=0,
    )
    sign_to(review_receipt_path, review_payload, role="review-attester", keys=keys)
    validate_analysis_review_receipt(
        review_receipt_path,
        draft_path=draft_path,
        manifest_path=manifest_path,
        review_attester_public_key_path=keys["review-attester"][1],
    )
    final = rebind_reviewed_analysis_authorization_times(
        draft,
        review_finished_at_utc=utc(finished),
        now=finished + dt.timedelta(seconds=1),
    )
    sign_to(final_authorization_path, final, role="analysis-authorizer", keys=keys)
    return draft_path, review_receipt_path, final_authorization_path, final


def build_fixture(
    *,
    parent_protocol_path: Path,
    private_key_root: Path,
) -> dict[str, Any]:
    """Materialize the exact signed synthetic chain consumed by production load_inputs."""

    parent_protocol_path = parent_protocol_path.resolve()
    parent = read_json_object(parent_protocol_path, "parent P30 protocol")
    validate_protocol(parent, require_authorized=True)
    synthetic_id = analyzer_rehearsal_campaign_id(parent)
    ledger = analyzer_rehearsal_ledger_root(parent)
    result_root = analyzer_rehearsal_result_root(parent)
    protocol_path = analyzer_rehearsal_protocol_path(parent)
    if ledger.exists() and any(ledger.iterdir()):
        raise FileExistsError("synthetic analyzer rehearsal ledger is not empty")
    ledger.mkdir(parents=True, exist_ok=True)
    if result_root.exists() and any(result_root.iterdir()):
        raise FileExistsError("synthetic analyzer rehearsal result root is not empty")
    result_root.mkdir(parents=True, exist_ok=True)
    for directory in (
        ledger / "analysis" / "review",
        ledger / "authorizations",
        ledger / "barriers",
        ledger / "endpoints",
        ledger / "evaluations",
        ledger / "pairs",
        ledger / "requests",
        ledger / "supervisor",
        ledger / "trust" / "public",
        private_key_root,
    ):
        directory.mkdir(parents=True, exist_ok=True)
    keys: dict[str, tuple[Path, Path]] = {}
    for role in ROLE_POLICIES:
        private, staged_public = generate_keypair(private_key_root, role)
        public = ledger / "trust" / "public" / f"{role}.pem"
        write_bytes(public, staged_public.read_bytes())
        staged_public.unlink()
        keys[role] = (private, public)
    protocol = copy.deepcopy(parent)
    protocol["executionTrust"]["campaignInstanceId"] = synthetic_id
    protocol["executionTrust"]["roles"] = trust_roles(keys)
    # The fixed ledger root, lease, bubblewrap, review runtime, source lock,
    # protocol review, and experiment remain byte-for-byte inherited.
    write_json(protocol_path, protocol)
    validate_protocol(protocol, require_authorized=True)
    source_commit, source_contract_sha256 = source_identity(protocol, protocol_path)
    catalog = read_json_object(REPO_ROOT / protocol["catalog"]["path"], "P30 catalog")
    guardians = tuple(item["name"] for item in catalog["guardians"])
    time_base = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=5)
    endpoints: dict[str, dict[str, Any]] = {}
    for replicate in REPLICATES:
        for arm in ARMS:
            label = endpoint_label(replicate, arm)
            root = ledger / "endpoints" / label
            root.mkdir()
            generation_receipts, checkpoint, checkpoint_manifest, config, root_binding = (
                build_generation_chain(
                    root,
                    protocol=protocol,
                    protocol_path=protocol_path,
                    ledger=ledger,
                    keys=keys,
                    replicate=replicate,
                    arm=arm,
                    source_commit=source_commit,
                    source_contract_sha256=source_contract_sha256,
                    time_base=time_base,
                )
            )
            evaluation, report_values = build_evaluation(
                root,
                protocol=protocol,
                protocol_path=protocol_path,
                ledger=ledger,
                keys=keys,
                replicate=replicate,
                arm=arm,
                source_commit=source_commit,
                source_contract_sha256=source_contract_sha256,
                checkpoint=checkpoint,
                config_path=config,
                binding_path=root_binding,
                final_generation_receipt=generation_receipts[-1],
                guardians=guardians,
                time_base=time_base,
            )
            pair = build_pair(
                protocol=protocol,
                protocol_path=protocol_path,
                ledger=ledger,
                keys=keys,
                replicate=replicate,
                arm=arm,
                root=root,
                checkpoint=checkpoint,
                evaluation=evaluation,
                reports=report_values,
                issued=utc(time_base + dt.timedelta(seconds=30)),
            )
            entry = report_entry(
                label=label,
                replicate=replicate,
                arm=arm,
                root=root,
                checkpoint=checkpoint,
                checkpoint_manifest=checkpoint_manifest,
                config=config,
                root_binding=root_binding,
                final_generation_receipt=generation_receipts[-1],
                evaluation=evaluation,
                pair=pair,
            )
            endpoints[label] = {
                "root": root,
                "generationReceipts": generation_receipts,
                "checkpoint": checkpoint,
                "checkpointManifest": checkpoint_manifest,
                "config": config,
                "binding": root_binding,
                "evaluation": evaluation,
                "pair": pair,
                "reportEntry": entry,
            }
    manifest_time = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=60)
    barrier, manifest, canonical_labels, shuffled_labels = build_barrier_and_manifest(
        protocol=protocol,
        protocol_path=protocol_path,
        ledger=ledger,
        keys=keys,
        endpoints=endpoints,
        issued=manifest_time,
    )
    token = sha256_bytes(
        canonical_json(
            {
                "domain": "arc-v35-p30-analyzer-rehearsal-analysis-token-v1",
                "syntheticCampaignInstanceId": synthetic_id,
            }
        )
    )
    analysis_out = result_root / "analysis.json"
    draft, review, authorization, authorization_payload = build_synthetic_analysis_review(
        protocol=protocol,
        protocol_path=protocol_path,
        ledger=ledger,
        keys=keys,
        manifest_path=manifest,
        analysis_out=analysis_out,
        token=token,
        time_base=manifest_time + dt.timedelta(seconds=10),
    )
    return {
        "parentProtocol": parent,
        "protocol": protocol,
        "protocolPath": protocol_path,
        "syntheticCampaignInstanceId": synthetic_id,
        "ledger": ledger,
        "resultRoot": result_root,
        "analysisOut": analysis_out,
        "manifest": manifest,
        "barrier": barrier,
        "draft": draft,
        "review": review,
        "authorization": authorization,
        "authorizationPayload": authorization_payload,
        "token": token,
        "keys": keys,
        "canonicalLabels": canonical_labels,
        "shuffledLabels": shuffled_labels,
    }
