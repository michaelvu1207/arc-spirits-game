#!/usr/bin/env python3
"""Fail-closed paired analyzer for the review-gated V35 P30 dose screen."""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import fcntl
import functools
import hashlib
import itertools
import json
import math
import os
import stat
import subprocess
import time
from pathlib import Path
from typing import Any, Mapping

import numpy as np

from calibrate_v35_p30_power import build as build_power_calibration
from v35_p30_crypto import (
    canonical_json,
    public_key_identity,
    role_public_key_path,
    sha256_file as secure_sha256_file,
    validate_role_trust,
    verify_signed_payload,
)
from v35_p30_statistics import conservative_sign_flip_tolerance


SCHEMA = "arc-v35-p30-long-horizon-analysis-v1"
PROTOCOL_SCHEMA = "arc-v35-p30-long-horizon-protocol-v1"
INPUT_SCHEMA = "arc-v35-p30-analysis-manifest-v1"
INPUT_AUTH_SCHEMA = "arc-v35-p30-execution-authorization-v1"
REPORT_SCHEMA = "solo-heldout-v2"
SOURCE_LOCK_SCHEMA = "arc-v35-p30-source-lock-v1"
GIT_CONTEXT_SCHEMA = "arc-v35-p30-git-context-v1"
POWER_SCHEMA = "arc-v35-p30-power-calibration-v1"
EVALUATION_RECEIPT_SCHEMA = "arc-v35-p30-evaluation-receipt-v1"
AUTHORIZED_EXECUTION_RECEIPT_SCHEMA = "arc-v35-p30-authorized-execution-receipt-v1"
EXECUTION_AUTHORIZATION_SCHEMA = "arc-v35-p30-execution-authorization-v1"
EVALUATION_INNER_SCHEMA = "arc-v35-p30-evaluation-inner-execution-v1"
PAIR_INTEGRITY_SCHEMA = "arc-v35-p30-evaluation-pair-integrity-v1"
FABLE_RECEIPT_SCHEMA = "arc-v35-p30-fable-review-command-receipt-v2"
EXECUTION_TRUST_SCHEMA = "arc-v35-p30-role-trust-v2"
ROOT_BINDING_SCHEMA = "arc-v35-root-binding-v1"
REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_REGISTRY_RELATIVE = (
    "ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/"
    "source-registry.proposed.json"
)
SOURCE_REGISTRY_SHA256 = "b8a624f6871e67e36b10abc266c3984ed4e7d28d64cf6ba48730a73cf9b2886a"
REPLICATES = tuple("abcdefghijklmnopqr")
CONTROL = "control-zero"
TREATMENTS = ("uniform-040", "late-scheduled")
ARMS = (CONTROL, *TREATMENTS)
PRIMARY = ("trueWinRate", "lateGameScore", "postRound15Vp")
ROW_KEYS = {
    "seed",
    "guardian",
    "trueWin",
    "stalled",
    "finalVP",
    "first30Round",
    "post15VpPerRound",
    "finalAttackDice",
    "finalSpirits",
    "finalMaxBarrier",
    "cycle",
}
CYCLE_KEYS = {
    "decisions",
    "productiveDecisions",
    "optionalYieldDecisions",
    "locationInteractions",
    "summons",
    "awakens",
    "combats",
    "rewards",
    "pvpAttacks",
    "first15Round",
    "first30Round",
    "post15VpPerRound",
    "finalAttackDice",
    "finalSpirits",
    "finalMaxBarrier",
    "vpAfterRound",
}
SOURCE_FILE_PATHS = {
    "baseConfig": "ml/league/configs/fair-v35-late-credit-base.json",
    "packageLock": "package-lock.json",
    "mlRequirements": "ml/requirements.txt",
    "runRoot": "scripts/run-v35-p30-root.sh",
    "leagueRunner": "scripts/run-league.mjs",
    "leagueManager": "src/lib/play/ml/league/manager.ts",
    "trainer": "ml/train.py",
    "ppo": "ml/ppo.py",
    "evaluator": "scripts/evaluate-solo-checkpoint.mjs",
    "inferenceServer": "ml/infer_server.py",
    "actorPool": "src/lib/play/ml/actorPool.ts",
    "guardianSchedule": "src/lib/play/ml/evalSchedule.ts",
    "generationAuditor": "ml/audit_v35_p30_generation.py",
    "generationAuditCore": "ml/audit_v32_generation.py",
    "generationAuditorTests": "ml/test_audit_v35_p30_generation.py",
    "statisticsCore": "ml/v35_p30_statistics.py",
    "powerCalibrator": "ml/calibrate_v35_p30_power.py",
    "powerArtifact": (
        "ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/"
        "power-calibration.proposed.json"
    ),
    "analyzer": "ml/analyze_v35_p30_long_horizon.py",
    "analyzerTests": "ml/test_analyze_v35_p30_long_horizon.py",
    "sourceRegistry": SOURCE_REGISTRY_RELATIVE,
    "sourceRegistryGenerator": "scripts/generate-v35-p30-source-registry.mjs",
}
_source_registry_path = REPO_ROOT / SOURCE_REGISTRY_RELATIVE
if (
    not _source_registry_path.is_file()
    or hashlib.sha256(_source_registry_path.read_bytes()).hexdigest()
    != SOURCE_REGISTRY_SHA256
):
    raise RuntimeError("P30 source registry is missing or hash-invalid")
_source_registry = json.loads(_source_registry_path.read_text())
if (
    not isinstance(_source_registry, dict)
    or set(_source_registry) != {"schemaVersion", "purpose", "promotionEligible", "files"}
    or _source_registry.get("schemaVersion") != "arc-v35-p30-source-registry-v1"
    or _source_registry.get("purpose") != "complete-runtime-and-evaluation-source-closure"
    or _source_registry.get("promotionEligible") is not False
    or not isinstance(_source_registry.get("files"), list)
    or len(_source_registry["files"]) != 538
    or _source_registry["files"] != sorted(set(_source_registry["files"]))
    or any(not isinstance(path, str) or not path for path in _source_registry["files"])
):
    raise RuntimeError("P30 source registry contract changed")
for _relative in _source_registry["files"]:
    if _relative not in SOURCE_FILE_PATHS.values():
        SOURCE_FILE_PATHS[f"runtime:{_relative}"] = _relative


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def is_git_commit(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 40
        and all(character in "0123456789abcdef" for character in value)
    )


def exact_keys(value: Any, expected: set[str], label: str) -> Mapping[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError(f"{label} keys changed")
    return value


def nonnegative_int(value: Any, label: str) -> int:
    if type(value) is not int or value < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return value


def resolve_artifact(path_value: Any, *, anchor: Path, label: str) -> Path:
    if not isinstance(path_value, str) or not path_value:
        raise ValueError(f"{label} path is missing")
    path = Path(path_value)
    if path.is_absolute():
        return path.resolve()
    return (anchor / path).resolve()


def validate_role_request_binding(
    binding: Any,
    *,
    protocol: Mapping[str, Any],
    protocol_path: Path,
    role: str,
    verb: str,
    predecessor_path: Path | None,
    expected_output_path: Path,
    expected_subject_fields: Mapping[str, Any] | None = None,
    label: str,
) -> dict[str, Any]:
    exact_keys(binding, {"path", "sha256"}, f"{label} role-request binding")
    request_path = resolve_artifact(
        binding["path"],
        anchor=expected_output_path.parent,
        label=f"{label} role request",
    )
    trust = protocol["executionTrust"]
    expected_parent = (
        Path(trust["ledgerRoot"]) / trust["campaignInstanceId"] / "requests"
    )
    if (
        request_path.parent != expected_parent
        or not is_sha256(binding["sha256"])
        or sha256(request_path) != binding["sha256"]
    ):
        raise ValueError(f"{label}: role request is outside the ledger or hash-invalid")
    request = read_json_object(request_path, f"{label} role request")
    exact_keys(
        request,
        {
            "schemaVersion",
            "campaignInstanceId",
            "protocol",
            "role",
            "verb",
            "subject",
            "predecessorSha256",
            "expectedOutputPath",
            "requestNonce",
        },
        f"{label} role request",
    )
    subject = request.get("subject")
    if (
        request.get("schemaVersion") != "arc-v35-p30-role-request-v1"
        or request.get("campaignInstanceId") != trust["campaignInstanceId"]
        or request.get("protocol")
        != {"path": str(protocol_path.resolve()), "sha256": sha256(protocol_path)}
        or request.get("role") != role
        or request.get("verb") != verb
        or not isinstance(subject, dict)
        or request.get("predecessorSha256")
        != (
            None
            if predecessor_path is None
            else sha256(predecessor_path.resolve())
        )
        or request.get("expectedOutputPath") != str(expected_output_path.resolve())
        or not is_sha256(request.get("requestNonce"))
    ):
        raise ValueError(f"{label}: role request contract changed")
    for key, expected in (expected_subject_fields or {}).items():
        if subject.get(key) != expected:
            raise ValueError(f"{label}: role request subject changed at {key}")
    return request


def finite(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label} must be finite")
    return result


def utc_instant(value: Any, label: str) -> dt.datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError(f"{label} must be an ISO-8601 UTC instant")
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise ValueError(f"{label} must be an ISO-8601 UTC instant") from exc
    if parsed.tzinfo != dt.timezone.utc:
        raise ValueError(f"{label} must be UTC")
    return parsed


def git_output(git_dir: Path, *arguments: str, binary: bool = False) -> bytes | str:
    result = subprocess.run(
        ["git", f"--git-dir={git_dir}", *arguments],
        check=True,
        capture_output=True,
        text=not binary,
    )
    return result.stdout


def git_tree_entries(git_dir: Path, commit: str) -> dict[str, tuple[str, str, str]]:
    raw = git_output(git_dir, "ls-tree", "-rz", "--full-tree", commit, binary=True)
    assert isinstance(raw, bytes)
    result: dict[str, tuple[str, str, str]] = {}
    for record in raw.split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split(" ")
        result[raw_path.decode()] = (mode, kind, oid)
    return result


def git_object_inventory_sha256(git_dir: Path) -> str:
    raw = git_output(
        git_dir,
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname) %(objecttype) %(objectsize)",
    )
    assert isinstance(raw, str)
    normalized = "\n".join(sorted(line for line in raw.splitlines() if line)) + "\n"
    return hashlib.sha256(normalized.encode()).hexdigest()


def verify_git_context(source_lock: Mapping[str, Any]) -> None:
    context = source_lock.get("gitContext")
    if not isinstance(context, dict) or set(context) != {
        "schemaVersion",
        "gitDir",
        "shallow",
        "objectFormat",
        "baseCommit",
        "implementationCommit",
        "implementationTree",
        "objectInventorySha256",
        "registeredPaths",
    }:
        raise ValueError("P30 Git context declaration is malformed")
    git_dir = Path(context["gitDir"])
    if (
        context.get("schemaVersion") != GIT_CONTEXT_SCHEMA
        or not git_dir.is_absolute()
        or not git_dir.is_dir()
        or git_dir.resolve() == (REPO_ROOT / ".git").resolve()
        or context.get("shallow") is not True
        or not (git_dir / "shallow").is_file()
        or context.get("objectFormat") != "sha1"
        or context.get("baseCommit") != source_lock["implementationBaseCommit"]
        or context.get("implementationCommit") != source_lock["implementationCommit"]
        or context.get("registeredPaths") != len(set(SOURCE_FILE_PATHS.values()))
        or not is_sha256(context.get("objectInventorySha256"))
    ):
        raise ValueError("P30 Git context identity changed")
    subprocess.run(
        ["git", f"--git-dir={git_dir}", "fsck", "--full", "--strict"],
        check=True,
        capture_output=True,
        text=True,
    )
    for commit, label in (
        (source_lock["implementationBaseCommit"], "base"),
        (source_lock["implementationCommit"], "implementation"),
    ):
        if git_output(git_dir, "cat-file", "-t", commit).strip() != "commit":
            raise ValueError(f"P30 Git context {label} object is not a commit")
    ancestry = subprocess.run(
        [
            "git",
            f"--git-dir={git_dir}",
            "merge-base",
            "--is-ancestor",
            source_lock["implementationBaseCommit"],
            source_lock["implementationCommit"],
        ],
        capture_output=True,
    )
    if ancestry.returncode != 0:
        raise ValueError("P30 implementation base is not an ancestor")
    tree = git_output(
        git_dir, "rev-parse", f"{source_lock['implementationCommit']}^{{tree}}"
    ).strip()
    if tree != context.get("implementationTree"):
        raise ValueError("P30 implementation tree changed")
    if git_object_inventory_sha256(git_dir) != context["objectInventorySha256"]:
        raise ValueError("P30 Git object inventory changed")
    tree_entries = git_tree_entries(git_dir, source_lock["implementationCommit"])
    for entry in source_lock["files"].values():
        relative = entry["path"]
        tree_entry = tree_entries.get(relative)
        if tree_entry is None or tree_entry[1] != "blob" or tree_entry[2] != entry["gitBlobOid"]:
            raise ValueError(f"P30 Git tree does not bind {relative}")
        blob = git_output(git_dir, "cat-file", "blob", entry["gitBlobOid"], binary=True)
        assert isinstance(blob, bytes)
        if hashlib.sha256(blob).hexdigest() != entry["sha256"]:
            raise ValueError(f"P30 Git blob hash differs for {relative}")


def repo_relative(path: Path, label: str) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError as exc:
        raise ValueError(f"{label} must be inside the frozen repository") from exc


def read_json_object(path: Path, label: str) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def extra_arg(extra: Any, name: str, label: str) -> str:
    if not isinstance(extra, list) or any(not isinstance(item, str) for item in extra):
        raise ValueError(f"{label} trainer arguments are malformed")
    positions = [index for index, item in enumerate(extra) if item == name]
    if len(positions) != 1 or positions[0] + 1 >= len(extra):
        raise ValueError(f"{label} must contain exactly one {name} value")
    return extra[positions[0] + 1]


def validate_policy_manifest(
    manifest: Mapping[str, Any], *, label: str, protocol: Mapping[str, Any]
) -> None:
    initial = protocol["initialPolicy"]
    required = {
        "format": initial["format"],
        "obs_version": initial["policyObsVersion"],
        "obs_flat_len": initial["obsDim"],
        "act_dim": initial["actDim"],
        "d_model": 128,
        "layers": 3,
        "heads": 4,
        "reach30_horizons": initial["reach30Horizons"],
        "reach30_trained": initial["reach30Trained"],
    }
    if any(manifest.get(key) != value for key, value in required.items()):
        raise ValueError(f"{label} architecture or reach-30 contract changed")
    if type(manifest.get("params")) is not int or manifest["params"] <= 0:
        raise ValueError(f"{label} parameter count is invalid")


def validate_initial_policy_artifacts(
    protocol: Mapping[str, Any], *, protocol_path: Path
) -> None:
    initial = protocol["initialPolicy"]
    checkpoint = resolve_artifact(
        initial.get("path"), anchor=REPO_ROOT, label="initial checkpoint"
    )
    manifest_path = resolve_artifact(
        initial.get("manifestPath"),
        anchor=REPO_ROOT,
        label="initial checkpoint manifest",
    )
    if not checkpoint.is_file() or sha256(checkpoint) != initial["sha256"]:
        raise ValueError("P30 initial checkpoint is missing or hash-invalid")
    if not manifest_path.is_file() or sha256(manifest_path) != initial["manifestSha256"]:
        raise ValueError("P30 initial checkpoint manifest is missing or hash-invalid")
    validate_policy_manifest(
        read_json_object(manifest_path, "initial checkpoint manifest"),
        label="initial checkpoint manifest",
        protocol=protocol,
    )


def validate_protocol(protocol: Mapping[str, Any], *, require_authorized: bool = True) -> None:
    if protocol.get("schemaVersion") != PROTOCOL_SCHEMA:
        raise ValueError("unexpected P30 protocol schema")
    if protocol.get("promotionEligible") is not False:
        raise ValueError("P30 development protocol must remain promotion-ineligible")
    if not is_git_commit(protocol.get("implementationBaseCommit")):
        raise ValueError("P30 implementation base commit is invalid")
    initial_policy = protocol.get("initialPolicy")
    if not isinstance(initial_policy, dict) or {
        "path": initial_policy.get("path"),
        "manifestPath": initial_policy.get("manifestPath"),
        "sha256": initial_policy.get("sha256"),
        "manifestSha256": initial_policy.get("manifestSha256"),
        "format": initial_policy.get("format"),
        "obsDim": initial_policy.get("obsDim"),
        "actDim": initial_policy.get("actDim"),
        "policyObsVersion": initial_policy.get("policyObsVersion"),
        "wire": initial_policy.get("wire"),
        "reach30Horizons": initial_policy.get("reach30Horizons"),
        "reach30Trained": initial_policy.get("reach30Trained"),
    } != {
        "path": (
            "ml/experiments/v35-weco-recursive-autoresearch/league/rep-a/"
            "p30-credit025/checkpoints/main-0-gen8.pt"
        ),
        "manifestPath": (
            "ml/experiments/v35-weco-recursive-autoresearch/league/rep-a/"
            "p30-credit025/checkpoints/main-0-gen8.manifest.json"
        ),
        "sha256": "c799ee8587c5a82013dd06830eab7818b359a07944629a236de3dd1d2bd24e91",
        "manifestSha256": "fe21b3adfc1b688515dc3a3d2de0d7a6defa611728aac0ccbdfb79bf36678fad",
        "format": "arc-entity-scorer-v2",
        "obsDim": 3419,
        "actDim": 104,
        "policyObsVersion": 2,
        "wire": "binary",
        "reach30Horizons": [20, 25, 30],
        "reach30Trained": True,
    }:
        raise ValueError("P30 initial policy contract changed")
    replicates = protocol.get("replicates")
    expected_replicates = [
        {"id": "a", "trainBase": 967040000, "evalBase": 968000000},
        {"id": "b", "trainBase": 967056000, "evalBase": 968058000},
        {"id": "c", "trainBase": 967072000, "evalBase": 968116000},
        {"id": "d", "trainBase": 967088000, "evalBase": 968174000},
        {"id": "e", "trainBase": 967104000, "evalBase": 968232000},
        {"id": "f", "trainBase": 967120000, "evalBase": 968290000},
        {"id": "g", "trainBase": 967136000, "evalBase": 968348000},
        {"id": "h", "trainBase": 967152000, "evalBase": 968406000},
        {"id": "i", "trainBase": 967168000, "evalBase": 968464000},
        {"id": "j", "trainBase": 967184000, "evalBase": 968522000},
        {"id": "k", "trainBase": 967200000, "evalBase": 968580000},
        {"id": "l", "trainBase": 967216000, "evalBase": 968638000},
        {"id": "m", "trainBase": 967232000, "evalBase": 968696000},
        {"id": "n", "trainBase": 967248000, "evalBase": 968754000},
        {"id": "o", "trainBase": 967264000, "evalBase": 968812000},
        {"id": "p", "trainBase": 967280000, "evalBase": 968870000},
        {"id": "q", "trainBase": 967296000, "evalBase": 968928000},
        {"id": "r", "trainBase": 967312000, "evalBase": 967400000},
    ]
    if replicates != expected_replicates:
        raise ValueError("P30 replicate registry changed")
    expected_arms = {
        CONTROL: (0.0, None),
        "uniform-040": (0.4, None),
        "late-scheduled": (0.0, [[8, 0.15], [18, 0.3], [30, 0.5]]),
    }
    arms = protocol.get("arms")
    if not isinstance(arms, list) or [row.get("id") for row in arms] != list(ARMS):
        raise ValueError("P30 arm registry changed")
    for arm in arms:
        if (arm.get("soloReach30Coef"), arm.get("soloReach30Bands")) != expected_arms[arm["id"]]:
            raise ValueError(f"P30 arm {arm['id']} dose changed")
    schedule = protocol.get("seedSchedule")
    if not isinstance(schedule, dict) or {
        "trainStride": schedule.get("trainStride"),
        "evalStride": schedule.get("evalStride"),
        "maxGeneration": schedule.get("maxGeneration"),
        "gamesPerGeneration": schedule.get("gamesPerGeneration"),
        "evalGamesPerGeneration": schedule.get("evalGamesPerGeneration"),
        "commonPublicBase": schedule.get("commonPublicBase"),
        "commonPublicGames": schedule.get("commonPublicGames"),
    } != {
        "trainStride": 2048,
        "evalStride": 8192,
        "maxGeneration": 8,
        "gamesPerGeneration": 1024,
        "evalGamesPerGeneration": 256,
        "commonPublicBase": 969070000,
        "commonPublicGames": 4096,
    }:
        raise ValueError("P30 seed schedule changed")
    training = protocol.get("training")
    if not isinstance(training, dict) or {
        key: training.get(key)
        for key in (
            "seats",
            "maxRounds",
            "soloMaxStatusLevel",
            "gamesPerGeneration",
            "evalGamesPerGeneration",
            "epochs",
            "batchSize",
            "ppoRowsPerEpoch",
            "optimizerStepsPerEpoch",
            "learningRate",
            "clipEpsilon",
            "valueClipEpsilon",
            "entropyCoef",
            "klReferenceCoef",
            "gamma",
            "gaeLambda",
            "valueCoef",
            "reach30ValueCoef",
            "winBonus",
            "allFallenPenalty",
            "sample",
            "temperature",
            "strategicDecisionScope",
            "guardianSchedule",
            "workers",
        )
    } != {
        "seats": 1,
        "maxRounds": 30,
        "soloMaxStatusLevel": 2,
        "gamesPerGeneration": 1024,
        "evalGamesPerGeneration": 256,
        "epochs": 2,
        "batchSize": 512,
        "ppoRowsPerEpoch": 100000,
        "optimizerStepsPerEpoch": 196,
        "learningRate": 0.00004,
        "clipEpsilon": 0.1,
        "valueClipEpsilon": 0.1,
        "entropyCoef": 0.003,
        "klReferenceCoef": 0.05,
        "gamma": 0.999,
        "gaeLambda": 0.95,
        "valueCoef": 0.5,
        "reach30ValueCoef": 1.0,
        "winBonus": 4.0,
        "allFallenPenalty": -3.0,
        "sample": True,
        "temperature": 0.55,
        "strategicDecisionScope": "engine-cycle",
        "guardianSchedule": "absolute-balanced",
        "workers": 24,
    }:
        raise ValueError("P30 safety-critical training contract changed")
    if protocol.get("trustGates") != {
        "maxApproxKl": 0.02,
        "maxOrdinaryClipFraction": 0.2,
        "maxWeightedClipFraction": 0.2,
        "maxBehaviorReach30Ece": 0.1,
        "behaviorReach30BrierNoWorseThanConstant": True,
        "maxBehaviorLogpReconstructionError": 0.001,
        "stalls": 0,
        "malformedEpisodes": 0,
        "malformedRows": 0,
    }:
        raise ValueError("P30 training trust gates changed")
    runtime = protocol.get("runtime")
    if not isinstance(runtime, dict) or {
        "physicalGpu": runtime.get("physicalGpu"),
        "gpuUuid": runtime.get("gpuUuid"),
        "forbiddenGpus": runtime.get("forbiddenGpus"),
        "maxConcurrentRoots": runtime.get("maxConcurrentRoots"),
        "maxCampaignComputeSeconds": runtime.get("maxCampaignComputeSeconds"),
    } != {
        "physicalGpu": 7,
        "gpuUuid": "GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0",
        "forbiddenGpus": [4, 5, 6],
        "maxConcurrentRoots": 1,
        "maxCampaignComputeSeconds": 1209600,
    }:
        raise ValueError("P30 GPU allocation contract changed")
    if protocol.get("recoveryPolicy") != {
        "schemaVersion": "arc-v35-p30-bounded-recovery-policy-v1",
        "maximumRecoveriesPerLogicalAction": 1,
        "classes": ["PRE_CHILD", "RECEIPT_ONLY"],
        "eligibleKinds": ["generation", "evaluation-primary", "evaluation-replay"],
        "preChildRequiresNoChildStart": True,
        "preChildRequiresNoSeedConsumption": True,
        "receiptOnlyForbidsCandidateRerun": True,
        "guardianClassificationRequired": True,
        "secondRecoveryClosesCampaign": True,
        "outcomeExposureClosesCampaign": True,
    }:
        raise ValueError("P30 bounded recovery policy changed")
    execution_trust = protocol.get("executionTrust")
    validate_role_trust(execution_trust, require_materialized=require_authorized)
    if (
        execution_trust.get("schemaVersion") != EXECUTION_TRUST_SCHEMA
        or execution_trust.get("algorithm") != "Ed25519"
        or execution_trust.get("ledgerRoot")
        != "/data/share8/michaelvuaprilexperimentation/arc-v35-p30-ledger"
        or execution_trust.get("leasePath")
        != "/data/share8/michaelvuaprilexperimentation/arc-bot/.leases/arc-v35-gpu7"
        or execution_trust.get("bubblewrapPath") != "/usr/bin/bwrap"
    ):
        raise ValueError("P30 execution trust constants changed")
    if require_authorized:
        if (
            not is_sha256(execution_trust.get("campaignInstanceId"))
            or not is_sha256(execution_trust.get("bubblewrapSha256"))
        ):
            raise ValueError("P30 execution trust root is not frozen")
    elif any(
        execution_trust.get(field) is not None
        for field in (
            "campaignInstanceId",
            "bubblewrapSha256",
        )
    ):
        raise ValueError("proposed P30 protocol unexpectedly contains an execution trust root")
    review = protocol.get("review")
    if (
        not isinstance(review, dict)
        or review.get("requiredModel") != "Claude Fable"
        or review.get("requiredEffort") != "high"
    ):
        raise ValueError("P30 protocol lacks a review record")
    if require_authorized and (
        protocol.get("status") != "authorized"
        or protocol.get("authorized") is not True
        or review.get("verdict") != "ACCEPT"
        or not isinstance(review.get("artifact"), str)
        or not is_sha256(review.get("sha256"))
        or not isinstance(review.get("commandReceipt"), dict)
        or not isinstance(review["commandReceipt"].get("path"), str)
        or not is_sha256(review["commandReceipt"].get("sha256"))
    ):
        raise ValueError("P30 protocol is not Fable-accepted and authorized")
    source_contract = protocol.get("sourceContract")
    if not isinstance(source_contract, dict) or source_contract.get("schemaVersion") != SOURCE_LOCK_SCHEMA:
        raise ValueError("P30 source-contract declaration changed")
    if require_authorized and (
        not isinstance(source_contract.get("artifact"), str)
        or not is_sha256(source_contract.get("sha256"))
    ):
        raise ValueError("P30 source contract is not frozen")
    if protocol.get("sourceRegistry") != {
        "schemaVersion": "arc-v35-p30-source-registry-v1",
        "path": SOURCE_REGISTRY_RELATIVE,
        "sha256": SOURCE_REGISTRY_SHA256,
        "files": 538,
    }:
        raise ValueError("P30 source registry declaration changed")
    power_calibration = protocol.get("powerCalibration")
    if power_calibration != {
        "schemaVersion": POWER_SCHEMA,
        "path": "ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/power-calibration.proposed.json",
        "sha256": "82b021acb98b5ea5f937b9fc476b1c4df744250636ec5ee035bec20dc4b9851a",
        "claim": "primary-efficacy-eligibility-power-only",
        "replicates": 18,
        "minimumJointPrimaryEligibilityPower": 0.8,
        "adequateForPrimaryEfficacy": True,
        "fullSelectorPowerClaimed": False,
    }:
        raise ValueError("P30 power calibration changed")
    confirmation_gates = protocol.get("confirmationGates")
    if confirmation_gates != {
        "schemaVersion": "arc-v35-superhuman-confirmation-gates-v1",
        "path": "ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/confirmation-gates.proposed.json",
        "sha256": "a3aca14aedd75fc4947d45b8e86d672d78deb54569ae8b1e921d2a0454f85085",
        "frozenBeforeP30Outcomes": True,
    }:
        raise ValueError("P30 confirmation-gate declaration changed")
    confirmation_path = REPO_ROOT / confirmation_gates["path"]
    if (
        not confirmation_path.is_file()
        or sha256(confirmation_path) != confirmation_gates["sha256"]
    ):
        raise ValueError("P30 confirmation gates are missing or hash-invalid")
    analysis = protocol.get("analysis")
    if not isinstance(analysis, dict):
        raise ValueError("P30 protocol lacks analysis settings")
    if tuple(analysis.get("primaryEndpoints", ())) != PRIMARY:
        raise ValueError("P30 primary endpoint family changed")
    if analysis.get("commonPublicGames") != schedule["commonPublicGames"]:
        raise ValueError("P30 analysis game count changed")
    if analysis.get("primaryFamilySize") != len(TREATMENTS) * len(PRIMARY):
        raise ValueError("P30 primary family size is wrong")
    if analysis.get("simultaneousTreatmentComparisons") != 2 or analysis.get("pairedWithinReplicate") is not True:
        raise ValueError("P30 paired treatment family changed")
    if analysis.get("correction") != "holm" or finite(analysis.get("familywiseAlpha"), "familywiseAlpha") != 0.05:
        raise ValueError("P30 familywise inference changed")
    bootstrap = analysis.get("bootstrap")
    if (
        not isinstance(bootstrap, dict)
        or bootstrap.get("method") != "crossed-paired-replicate-and-common-seed-safety-bounds"
        or bootstrap.get("draws") != 20000
        or bootstrap.get("seed") != 35153040
    ):
        raise ValueError("P30 diagnostic bootstrap changed")
    decision = analysis.get("decisionInference")
    if decision != {
        "method": "exact-paired-replicate-sign-flip",
        "replicates": 18,
        "enumerations": 262144,
        "oneSided": True,
        "nullAssumption": "paired replicate effects are independent and sign-exchangeable under the null",
    }:
        raise ValueError("P30 decision inference changed")
    if analysis.get("expectedGuardianCount") != 10:
        raise ValueError("P30 guardian registry size changed")
    if analysis.get("minimumPositiveReplicates") != 13:
        raise ValueError("P30 replicate consistency requirement changed")
    if finite(analysis.get("minimumReplicateTrueWinGain"), "minimumReplicateTrueWinGain") != -0.01:
        raise ValueError("P30 replicate floor changed")
    if analysis.get("maximumReplicatesBelowFloor") != 2:
        raise ValueError("P30 replicate outlier tolerance changed")
    if analysis.get("primaryBootstrapDecisionBearing") is not False:
        raise ValueError("P30 primary bootstrap must remain non-decision-bearing")
    if analysis.get("safetyBootstrapDecisionBearing") is not True:
        raise ValueError("P30 safety bootstrap gate changed")
    if analysis.get("requireReplayTraceHashes") is not True:
        raise ValueError("P30 replay-trace requirement changed")
    if analysis.get("requireOutcomeBlindInputAuthorization") is not True:
        raise ValueError("P30 input-authorization requirement changed")
    if finite(analysis.get("minimumTrueWinPointGain"), "minimumTrueWinPointGain") != 0.03:
        raise ValueError("P30 minimum true-win gain changed")
    if analysis.get("selectionIsDevelopmentOnly") is not True:
        raise ValueError("P30 development-only selection gate changed")
    if analysis.get("freshPublicConfirmationRequired") is not True:
        raise ValueError("P30 fresh-public gate changed")
    if analysis.get("privateEvaluationAuthorized") is not False:
        raise ValueError("P30 private-evaluation gate opened")
    if analysis.get("mandatoryNonRegression") != [
        "reach15Rate",
        "finalVp",
        "finishRound",
        "guardianWorstCase",
        "stalls",
        "malformedEpisodes",
        "latency",
    ]:
        raise ValueError("P30 mandatory non-regression family changed")
    if analysis.get("nonRegressionThresholds") != {
        "reach15RateDeltaLower": -0.01,
        "finalVpDeltaLower": 0.0,
        "finishSpeedDeltaLower": 0.0,
        "guardianTrueWinDeltaLower": -0.05,
        "maxStalls": 0,
        "maxGameWallMsP95": 60000,
        "maxLatencyRatioToMatchedControl": 1.25,
    }:
        raise ValueError("P30 non-regression thresholds changed")
    weights = analysis.get("scoreWeights", {})
    weight_values = tuple(finite(weights.get(name), f"scoreWeights.{name}") for name in ("terminal", "vpGrowth", "engineGrowth"))
    if (
        not math.isclose(sum(weight_values), 1.0, abs_tol=1e-12)
        or weight_values != (0.6, 0.25, 0.15)
        or any(value < 0 for value in weight_values)
    ):
        raise ValueError("late-game score weights must sum to one and remain terminal-dominant")


def late_game_score(row: Mapping[str, Any], weights: Mapping[str, Any]) -> float:
    terminal = float(bool(row["trueWin"]))
    vp_growth = min(max(finite(row["post15VpPerRound"], "post15VpPerRound") / 3.0, 0.0), 1.0)
    engine_growth = min(
        max(
            (
                finite(row["finalAttackDice"], "finalAttackDice") / 8.0
                + finite(row["finalSpirits"], "finalSpirits") / 8.0
                + finite(row["finalMaxBarrier"], "finalMaxBarrier") / 8.0
            )
            / 3.0,
            0.0,
        ),
        1.0,
    )
    return (
        finite(weights["terminal"], "scoreWeights.terminal") * terminal
        + finite(weights["vpGrowth"], "scoreWeights.vpGrowth") * vp_growth
        + finite(weights["engineGrowth"], "scoreWeights.engineGrowth") * engine_growth
    )


def validate_report(
    report: Mapping[str, Any],
    *,
    label: str,
    protocol: Mapping[str, Any],
    source_commit: str,
    weights_sha256: str,
    guardian_names: tuple[str, ...],
    replicate: str,
    arm: str,
    config_sha256: str,
    binding_sha256: str,
    root_identity: str,
) -> dict[int, dict[str, Any]]:
    schedule = protocol["seedSchedule"]
    expected_seed0 = int(schedule["commonPublicBase"])
    expected_games = int(schedule["commonPublicGames"])
    if report.get("schemaVersion") != REPORT_SCHEMA:
        raise ValueError(f"{label}: unexpected report schema")
    expected = {
        "seed0": expected_seed0,
        "games": expected_games,
        "maxRounds": 30,
        "maxStatusLevel": 2,
        "catalogSha256": protocol["catalog"]["sha256"],
        "sourceCommit": source_commit,
        "weightsSha256": weights_sha256,
    }
    for field, value in expected.items():
        if report.get(field) != value:
            raise ValueError(f"{label}: {field} differs from the frozen contract")
    if report.get("executionIdentity") != {
        "experiment": protocol["experiment"],
        "replicate": replicate,
        "arm": arm,
        "configSha256": config_sha256,
        "bindingSha256": binding_sha256,
        "root": root_identity,
    }:
        raise ValueError(f"{label}: execution identity differs from the endpoint root")
    inference = report.get("inference")
    initial_policy = protocol["initialPolicy"]
    if not isinstance(inference, dict) or {
        "format": inference.get("format"),
        "obsDim": inference.get("obsDim"),
        "actDim": inference.get("actDim"),
        "weightsSha256": inference.get("weightsSha256"),
        "wire": inference.get("wire"),
    } != {
        "format": initial_policy["format"],
        "obsDim": initial_policy["obsDim"],
        "actDim": initial_policy["actDim"],
        "weightsSha256": weights_sha256,
        "wire": initial_policy["wire"],
    }:
        raise ValueError(f"{label}: inference handshake differs from the endpoint checkpoint")
    if not isinstance(inference.get("weightsPath"), str) or not inference["weightsPath"]:
        raise ValueError(f"{label}: inference handshake lacks a checkpoint path")
    decode = report.get("decode")
    if not isinstance(decode, dict) or set(decode) != {
        "policyObsVersion",
        "inferenceSocket",
        "learnMonsterRewardChoices",
        "sample",
        "temperature",
    } or decode.get("policyObsVersion") != initial_policy["policyObsVersion"]:
        raise ValueError(f"{label}: report is not obs-v2")
    if not isinstance(decode.get("inferenceSocket"), str) or not decode["inferenceSocket"]:
        raise ValueError(f"{label}: report lacks binary inference transport")
    for field, value in {
        "learnMonsterRewardChoices": False,
        "sample": True,
        "temperature": protocol["training"]["temperature"],
    }.items():
        if decode.get(field) != value:
            raise ValueError(f"{label}: decode field {field} changed")
    performance = report.get("performance")
    if not isinstance(performance, dict) or performance.get("workers") != protocol["training"]["workers"]:
        raise ValueError(f"{label}: performance worker count changed")
    for field in ("wallSeconds", "gamesPerSecond", "gameWallMsP50", "gameWallMsP95"):
        if finite(performance.get(field), f"{label}.{field}") <= 0:
            raise ValueError(f"{label}: {field} must be positive")
    if performance["gameWallMsP95"] < performance["gameWallMsP50"]:
        raise ValueError(f"{label}: performance percentile ordering is invalid")
    rows = report.get("perGame")
    if not isinstance(rows, list) or len(rows) != expected_games:
        raise ValueError(f"{label}: per-game row count changed")
    indexed: dict[int, dict[str, Any]] = {}
    for raw in rows:
        exact_keys(raw, ROW_KEYS, f"{label} per-game row")
        if type(raw.get("seed")) is not int:
            raise ValueError(f"{label}: malformed per-game row")
        seed = raw["seed"]
        if seed in indexed:
            raise ValueError(f"{label}: duplicate seed {seed}")
        if type(raw.get("trueWin")) is not bool or type(raw.get("stalled")) is not bool:
            raise ValueError(f"{label}: malformed outcome flags")
        final_vp = finite(raw.get("finalVP"), f"{label}.finalVP")
        if raw["trueWin"] != (final_vp >= 30 and not raw["stalled"]):
            raise ValueError(f"{label}: trueWin is not derivable")
        expected_guardian = guardian_names[seed % len(guardian_names)]
        if raw.get("guardian") != expected_guardian:
            raise ValueError(f"{label}: guardian is not the seed-only absolute-balanced assignment")
        for field in ("post15VpPerRound", "finalAttackDice", "finalSpirits", "finalMaxBarrier"):
            finite(raw.get(field), f"{label}.{field}")
        finish = raw.get("first30Round")
        if finish is not None and (type(finish) is not int or not 1 <= finish <= 30):
            raise ValueError(f"{label}: invalid first30Round")
        cycle = raw.get("cycle")
        exact_keys(cycle, CYCLE_KEYS, f"{label} cycle telemetry")
        for field in (
            "decisions",
            "productiveDecisions",
            "optionalYieldDecisions",
            "locationInteractions",
            "summons",
            "awakens",
            "combats",
            "rewards",
            "pvpAttacks",
            "finalAttackDice",
            "finalSpirits",
            "finalMaxBarrier",
        ):
            nonnegative_int(cycle.get(field), f"{label}.cycle.{field}")
        if (
            cycle["productiveDecisions"] > cycle["decisions"]
            or cycle["optionalYieldDecisions"] > cycle["decisions"]
        ):
            raise ValueError(f"{label}: impossible decision telemetry")
        vp_after = cycle.get("vpAfterRound")
        if not isinstance(vp_after, dict):
            raise ValueError(f"{label}: cycle vpAfterRound must be an object")
        for round_text, vp in vp_after.items():
            if not isinstance(round_text, str) or not round_text.isdigit() or int(round_text) < 1:
                raise ValueError(f"{label}: invalid vpAfterRound key")
            finite(vp, f"{label}.cycle.vpAfterRound")
        first15 = cycle.get("first15Round")
        if first15 is not None and (type(first15) is not int or not 1 <= first15 <= 30):
            raise ValueError(f"{label}: invalid first15Round")
        if (
            raw["first30Round"] != cycle["first30Round"]
            or float(raw["post15VpPerRound"]) != finite(cycle["post15VpPerRound"], f"{label}.cycle.post15VpPerRound")
            or raw["finalAttackDice"] != cycle["finalAttackDice"]
            or raw["finalSpirits"] != cycle["finalSpirits"]
            or raw["finalMaxBarrier"] != cycle["finalMaxBarrier"]
        ):
            raise ValueError(f"{label}: objective telemetry differs from the cycle summary")
        indexed[seed] = dict(raw)
    expected_seeds = set(range(expected_seed0, expected_seed0 + expected_games))
    if set(indexed) != expected_seeds:
        raise ValueError(f"{label}: seed coverage changed")
    true_wins = sum(row["trueWin"] for row in indexed.values())
    stalls = sum(row["stalled"] for row in indexed.values())
    if report.get("trueWins") != true_wins or report.get("stalls") != stalls:
        raise ValueError(f"{label}: aggregates differ from per-game rows")
    if not math.isclose(finite(report.get("trueWinRate"), f"{label}.trueWinRate"), true_wins / expected_games, abs_tol=1e-15):
        raise ValueError(f"{label}: trueWinRate differs from per-game rows")
    if not math.isclose(finite(report.get("stallRate"), f"{label}.stallRate"), stalls / expected_games, abs_tol=1e-15):
        raise ValueError(f"{label}: stallRate differs from per-game rows")
    reach15 = sum(row["cycle"]["first15Round"] is not None for row in indexed.values())
    if not math.isclose(finite(report.get("reach15Rate"), f"{label}.reach15Rate"), reach15 / expected_games, abs_tol=1e-15):
        raise ValueError(f"{label}: reach15Rate differs from per-game rows")
    replay_hashes = report.get("replayHashes")
    if not isinstance(replay_hashes, list) or len(replay_hashes) != expected_games:
        raise ValueError(f"{label}: replay-trace coverage changed")
    replay_by_seed: dict[int, str] = {}
    for replay in replay_hashes:
        if (
            not isinstance(replay, dict)
            or set(replay) != {"seed", "replayTraceSha256"}
            or type(replay.get("seed")) is not int
            or not is_sha256(replay.get("replayTraceSha256"))
            or replay["seed"] in replay_by_seed
        ):
            raise ValueError(f"{label}: malformed or duplicate replay trace")
        replay_by_seed[replay["seed"]] = replay["replayTraceSha256"]
    if set(replay_by_seed) != expected_seeds:
        raise ValueError(f"{label}: replay-trace seed coverage changed")
    return indexed


def endpoint_label(replicate: str, arm: str) -> str:
    return f"rep-{replicate}-{arm}"


def endpoint_label_parts(label: str | None) -> tuple[str, str]:
    for replicate in REPLICATES:
        for arm in ARMS:
            if label == endpoint_label(replicate, arm):
                return replicate, arm
    raise ValueError("unknown P30 endpoint label")


def manifest_receipt_merkle_root(entries: list[Mapping[str, Any]]) -> str:
    leaves: list[bytes] = []
    for entry in entries:
        label = entry.get("label")
        if not isinstance(label, str):
            raise ValueError("manifest Merkle entry lacks a label")
        for key in sorted(entry):
            if key.endswith("Sha256"):
                value = entry[key]
                if not is_sha256(value):
                    raise ValueError(f"{label}: malformed manifest hash {key}")
                leaves.append(hashlib.sha256(f"{label}\0{key}\0{value}".encode()).digest())
    if not leaves:
        raise ValueError("manifest receipt Merkle tree is empty")
    level = leaves
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        level = [
            hashlib.sha256(level[index] + level[index + 1]).digest()
            for index in range(0, len(level), 2)
        ]
    return level[0].hex()


def signed_inventory_merkle_root(entries: list[Mapping[str, Any]]) -> str:
    if not entries:
        raise ValueError("signed receipt inventory is empty")
    level = [
        hashlib.sha256(
            json.dumps(
                entry,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            ).encode()
        ).digest()
        for entry in entries
    ]
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        level = [
            hashlib.sha256(level[index] + level[index + 1]).digest()
            for index in range(0, len(level), 2)
        ]
    return level[0].hex()


def validate_signed_receipt_inventory(
    manifest: Mapping[str, Any],
    *,
    protocol: Mapping[str, Any],
    protocol_path: Path,
    manifest_path: Path,
) -> None:
    """Validate the guardian inventory without opening any outcome report JSON."""

    trust = protocol["executionTrust"]
    ledger = Path(trust["ledgerRoot"]) / trust["campaignInstanceId"]
    guardian_public = role_public_key_path(trust, "guardian")
    executor_public = role_public_key_path(trust, "executor")
    inventory = manifest.get("signedReceiptInventory")
    reports = manifest.get("reports")
    counts = manifest["counts"]
    if not isinstance(inventory, list) or len(inventory) != counts["signedReceipts"]:
        raise ValueError("development input signed-receipt inventory length changed")
    if not isinstance(reports, list) or len(reports) != counts["endpoints"]:
        raise ValueError("development input report binding count changed")
    report_by_label: dict[str, Mapping[str, Any]] = {}
    for report in reports:
        if not isinstance(report, dict) or not isinstance(report.get("label"), str):
            raise ValueError("development input has a malformed report binding")
        if report["label"] in report_by_label:
            raise ValueError("development input has a duplicate report binding")
        report_by_label[report["label"]] = report

    expected: list[tuple[str, str, Path | None, str | None]] = [
        (
            "final-generation-barrier",
            "final-generation-barrier",
            ledger / "barriers/final-generation-complete.json",
            None,
        )
    ]
    maximum = protocol["seedSchedule"]["maxGeneration"]
    for replicate in REPLICATES:
        for arm in ARMS:
            label = endpoint_label(replicate, arm)
            for generation in range(1, maximum + 1):
                expected.append(("generation", f"{label}-gen{generation}", None, label))
            expected.extend(
                (
                    ("evaluation-primary", f"{label}-primary", None, label),
                    ("evaluation-replay", f"{label}-replay", None, label),
                    ("evaluation-pair", f"{label}-pair", ledger / "pairs" / f"{label}.json", label),
                )
            )
    if len(expected) != counts["signedReceipts"]:
        raise ValueError("development input expected inventory cardinality changed")

    seen_paths: set[Path] = set()
    seen_tokens: set[str] = set()
    indexed: dict[tuple[str, str], Mapping[str, Any]] = {}
    for ordinal, (entry, specification) in enumerate(zip(inventory, expected, strict=True)):
        exact_keys(
            entry,
            {"ordinal", "kind", "label", "path", "sha256", "tokenId"},
            f"signed receipt inventory entry {ordinal}",
        )
        kind, label, fixed_path, endpoint = specification
        path = resolve_artifact(
            entry["path"], anchor=manifest_path.parent, label=f"{label} inventory receipt"
        )
        if (
            entry.get("ordinal") != ordinal
            or entry.get("kind") != kind
            or entry.get("label") != label
            or path in seen_paths
            or (fixed_path is not None and path != fixed_path.resolve())
            or not path.is_file()
            or not is_sha256(entry.get("sha256"))
            or sha256(path) != entry["sha256"]
        ):
            raise ValueError(f"{label}: signed receipt inventory entry changed")
        seen_paths.add(path)
        indexed[(kind, label)] = entry
        token = entry.get("tokenId")
        if kind in {"generation", "evaluation-primary", "evaluation-replay"}:
            if not is_sha256(token) or token in seen_tokens or path != (ledger / f"{token}.receipt.json").resolve():
                raise ValueError(f"{label}: execution token inventory changed")
            seen_tokens.add(token)
            receipt = verify_signed_payload(
                read_json_object(path, f"{label} signed execution receipt"),
                expected_role="executor",
                public_key_path=executor_public,
            )
            subject = receipt.get("subject")
            expected_role = kind.removeprefix("evaluation-")
            if (
                receipt.get("schemaVersion") != AUTHORIZED_EXECUTION_RECEIPT_SCHEMA
                or receipt.get("valid") is not True
                or receipt.get("promotionEligible") is not False
                or receipt.get("campaignId") != protocol["experiment"]
                or receipt.get("kind") != kind
                or receipt.get("tokenId") != token
                or not isinstance(subject, dict)
                or subject.get("replicate") != endpoint_label_parts(endpoint)[0]
                or subject.get("arm") != endpoint_label_parts(endpoint)[1]
                or (
                    kind == "generation"
                    and subject.get("generation") != int(label.rsplit("gen", 1)[1])
                )
                or (
                    kind != "generation"
                    and subject.get("role") != expected_role
                )
            ):
                raise ValueError(f"{label}: inventoried execution receipt identity changed")
        else:
            if token is not None:
                raise ValueError(f"{label}: guardian receipt unexpectedly has a token")
            guardian_receipt = verify_signed_payload(
                read_json_object(path, f"{label} signed guardian receipt"),
                expected_role="guardian",
                public_key_path=guardian_public,
            )
            if kind == "evaluation-pair" and (
                guardian_receipt.get("schemaVersion") != PAIR_INTEGRITY_SCHEMA
                or guardian_receipt.get("valid") is not True
                or guardian_receipt.get("replicate") != endpoint_label_parts(endpoint)[0]
                or guardian_receipt.get("arm") != endpoint_label_parts(endpoint)[1]
            ):
                raise ValueError(f"{label}: inventoried pair receipt identity changed")

    if len(seen_tokens) != counts["uniqueExecutionTokens"]:
        raise ValueError("development input unique execution-token count changed")
    if signed_inventory_merkle_root(inventory) != manifest["receiptMerkleRoot"]:
        raise ValueError("development input signed-receipt Merkle root is invalid")

    barrier_binding = manifest["finalGenerationBarrier"]
    exact_keys(barrier_binding, {"path", "sha256"}, "final generation barrier binding")
    barrier_path = resolve_artifact(
        barrier_binding["path"], anchor=manifest_path.parent, label="final generation barrier"
    )
    if (
        barrier_path != (ledger / "barriers/final-generation-complete.json").resolve()
        or barrier_binding["sha256"] != sha256(barrier_path)
        or inventory[0]["path"] != str(barrier_path)
        or inventory[0]["sha256"] != barrier_binding["sha256"]
    ):
        raise ValueError("final generation barrier manifest binding changed")
    barrier = verify_signed_payload(
        read_json_object(barrier_path, "final generation barrier"),
        expected_role="guardian",
        public_key_path=guardian_public,
    )
    exact_keys(
        barrier,
        {
            "schemaVersion",
            "valid",
            "promotionEligible",
            "outcomesInspected",
            "issuedAtUtc",
            "protocol",
            "endpointCount",
            "endpoints",
            "diagnosticCodes",
            "request",
        },
        "final generation barrier",
    )
    if (
        barrier.get("schemaVersion") != "arc-v35-p30-final-generation-completeness-v1"
        or barrier.get("valid") is not True
        or barrier.get("promotionEligible") is not False
        or barrier.get("outcomesInspected") is not False
        or barrier.get("protocol")
        != {"path": str(protocol_path.resolve()), "sha256": sha256(protocol_path)}
        or barrier.get("endpointCount") != counts["endpoints"]
        or barrier.get("diagnosticCodes") != ["ALL_FINAL_GENERATION_CHAINS_COMPLETE"]
        or not isinstance(barrier.get("endpoints"), list)
        or len(barrier["endpoints"]) != counts["endpoints"]
    ):
        raise ValueError("final generation barrier changed")
    validate_role_request_binding(
        barrier["request"],
        protocol=protocol,
        protocol_path=protocol_path,
        role="guardian",
        verb="attest-final-barrier",
        predecessor_path=None,
        expected_output_path=barrier_path,
        label="final generation barrier",
    )
    for barrier_entry, (replicate, arm) in zip(
        barrier["endpoints"],
        ((replicate, arm) for replicate in REPLICATES for arm in ARMS),
        strict=True,
    ):
        label = endpoint_label(replicate, arm)
        report = report_by_label.get(label)
        exact_keys(
            barrier_entry,
            {"label", "finalReceipt", "finalAuditSha256", "finalCheckpointSha256"},
            f"{label} barrier entry",
        )
        expected_final = indexed[("generation", f"{label}-gen{maximum}")]
        if (
            report is None
            or barrier_entry.get("label") != label
            or barrier_entry.get("finalReceipt")
            != {"path": expected_final["path"], "sha256": expected_final["sha256"]}
            or barrier_entry.get("finalAuditSha256") != report.get("generationAuditSha256")
            or barrier_entry.get("finalCheckpointSha256") != report.get("weightsSha256")
            or report.get("generationExecutionReceiptPath") != expected_final["path"]
            or report.get("generationExecutionReceiptSha256") != expected_final["sha256"]
            or report.get("primaryExecutionReceiptPath")
            != indexed[("evaluation-primary", f"{label}-primary")]["path"]
            or report.get("primaryExecutionReceiptSha256")
            != indexed[("evaluation-primary", f"{label}-primary")]["sha256"]
            or report.get("replayExecutionReceiptPath")
            != indexed[("evaluation-replay", f"{label}-replay")]["path"]
            or report.get("replayExecutionReceiptSha256")
            != indexed[("evaluation-replay", f"{label}-replay")]["sha256"]
            or report.get("pairIntegrityPath")
            != indexed[("evaluation-pair", f"{label}-pair")]["path"]
            or report.get("pairIntegritySha256")
            != indexed[("evaluation-pair", f"{label}-pair")]["sha256"]
        ):
            raise ValueError(f"{label}: manifest report and receipt inventory differ")


def row_metric(row: Mapping[str, Any], metric: str, score_weights: Mapping[str, Any]) -> float:
    if metric == "trueWinRate":
        return float(row["trueWin"])
    if metric == "lateGameScore":
        return late_game_score(row, score_weights)
    if metric == "postRound15Vp":
        return finite(row["post15VpPerRound"], "post15VpPerRound")
    if metric == "finalVp":
        return finite(row["finalVP"], "finalVP")
    if metric == "finishSpeed":
        return 31.0 - finite(row["first30Round"] or 31, "first30Round")
    if metric == "reach15Rate":
        return float(row["cycle"].get("first15Round") is not None)
    raise ValueError(f"unknown metric {metric}")


def delta_matrix(
    indexed: Mapping[str, Mapping[int, Mapping[str, Any]]],
    *,
    treatment: str,
    metric: str,
    score_weights: Mapping[str, Any],
    guardian: str | None = None,
) -> np.ndarray:
    rows: list[np.ndarray] = []
    for replicate in REPLICATES:
        control = indexed[endpoint_label(replicate, CONTROL)]
        candidate = indexed[endpoint_label(replicate, treatment)]
        seeds = [
            seed
            for seed in sorted(control)
            if guardian is None or control[seed]["guardian"] == guardian
        ]
        if not seeds:
            raise ValueError(f"no rows for guardian {guardian!r}")
        if any(candidate[seed]["guardian"] != control[seed]["guardian"] for seed in seeds):
            raise ValueError("guardian assignment differs within a paired comparison")
        rows.append(
            np.asarray(
                [
                    row_metric(candidate[seed], metric, score_weights)
                    - row_metric(control[seed], metric, score_weights)
                    for seed in seeds
                ],
                dtype=np.float64,
            )
        )
    if len({len(row) for row in rows}) != 1:
        raise ValueError("replicates have unequal paired seed counts")
    return np.stack(rows)


def hierarchical_draws(values: np.ndarray, *, draws: int, seed: int) -> np.ndarray:
    if values.ndim != 2 or values.shape[0] != len(REPLICATES) or values.shape[1] < 1:
        raise ValueError("hierarchical bootstrap requires replicate-by-seed values")
    if draws < 1000:
        raise ValueError("hierarchical bootstrap requires at least 1000 draws")
    rng = np.random.default_rng(seed)
    result = np.empty(draws, dtype=np.float64)
    chunk = min(128, draws)
    for start in range(0, draws, chunk):
        count = min(chunk, draws - start)
        replicate_indices = rng.integers(0, values.shape[0], size=(count, values.shape[0]))
        seed_indices = rng.integers(0, values.shape[1], size=(count, values.shape[1]))
        sampled = values[replicate_indices[:, :, None], seed_indices[:, None, :]]
        result[start : start + count] = sampled.mean(axis=(1, 2))
    return result


@functools.lru_cache(maxsize=1)
def sign_flip_matrix() -> np.ndarray:
    matrix = np.asarray(
        tuple(itertools.product((-1.0, 1.0), repeat=len(REPLICATES))),
        dtype=np.float64,
    )
    matrix.setflags(write=False)
    return matrix


def paired_replicate_sign_flip(values: np.ndarray) -> dict[str, Any]:
    """Exact one-sided sign-flip inference over independent training-replicate pairs."""
    if values.ndim != 2 or values.shape[0] != len(REPLICATES) or values.shape[1] < 1:
        raise ValueError("paired sign-flip inference requires replicate-by-seed values")
    replicate_points = values.mean(axis=1)
    point = float(replicate_points.mean())
    signs = sign_flip_matrix()
    permuted = signs @ replicate_points / len(REPLICATES)
    tolerance = conservative_sign_flip_tolerance(replicate_points)
    extreme = int(np.count_nonzero(permuted >= point - tolerance))
    one_sided_p = extreme / len(permuted)
    return {
        "point": point,
        "replicatePoints": [float(value) for value in replicate_points],
        "decisionMethod": "exact-paired-replicate-sign-flip",
        "enumerations": len(permuted),
        "extremeEnumerations": extreme,
        "oneSidedP": float(one_sided_p),
    }


def holm_adjust(p_values: Mapping[str, float]) -> dict[str, float]:
    ordered = sorted(p_values.items(), key=lambda item: (item[1], item[0]))
    adjusted: dict[str, float] = {}
    running = 0.0
    total = len(ordered)
    for index, (name, p_value) in enumerate(ordered):
        running = max(running, min(1.0, (total - index) * p_value))
        adjusted[name] = running
    return {name: adjusted[name] for name in sorted(adjusted)}


def analyze_indexed(
    indexed: Mapping[str, Mapping[int, Mapping[str, Any]]],
    reports: Mapping[str, Mapping[str, Any]],
    protocol: Mapping[str, Any],
) -> dict[str, Any]:
    expected_labels = {
        endpoint_label(replicate, arm) for replicate in REPLICATES for arm in ARMS
    }
    if set(indexed) != expected_labels or set(reports) != expected_labels:
        raise ValueError("analysis requires the exact fifty-four replicate-arm endpoints")
    analysis = protocol["analysis"]
    bootstrap = analysis["bootstrap"]
    draws_count = int(bootstrap["draws"])
    bootstrap_seed = int(bootstrap["seed"])
    alpha = finite(analysis["familywiseAlpha"], "familywiseAlpha")
    score_weights = analysis["scoreWeights"]
    primary_p: dict[str, float] = {}
    comparisons: dict[str, dict[str, Any]] = {}
    for treatment_index, treatment in enumerate(TREATMENTS):
        metrics: dict[str, Any] = {}
        for metric_index, metric in enumerate((*PRIMARY, "reach15Rate", "finalVp", "finishSpeed")):
            matrix = delta_matrix(indexed, treatment=treatment, metric=metric, score_weights=score_weights)
            decision_summary = paired_replicate_sign_flip(matrix)
            draws = hierarchical_draws(
                matrix,
                draws=draws_count,
                seed=bootstrap_seed + treatment_index * 1000 + metric_index,
            )
            metrics[metric] = {
                **decision_summary,
                "lower95": float(np.quantile(draws, 0.05)),
                "upper95": float(np.quantile(draws, 0.95)),
                "crossedBootstrapSafetyOrDiagnosticQ05": float(np.quantile(draws, 0.05)),
                "crossedBootstrapSafetyOrDiagnosticQ95": float(np.quantile(draws, 0.95)),
            }
            if metric in PRIMARY:
                key = f"{treatment}/{metric}"
                primary_p[key] = decision_summary["oneSidedP"]
        guardians = sorted({row["guardian"] for row in indexed[endpoint_label("a", CONTROL)].values()})
        guardian_metrics: dict[str, Any] = {}
        for guardian_index, guardian in enumerate(guardians):
            matrix = delta_matrix(
                indexed,
                treatment=treatment,
                metric="trueWinRate",
                score_weights=score_weights,
                guardian=guardian,
            )
            draws = hierarchical_draws(
                matrix,
                draws=draws_count,
                seed=bootstrap_seed + treatment_index * 1000 + 100 + guardian_index,
            )
            guardian_metrics[guardian] = {
                **paired_replicate_sign_flip(matrix),
                "lower95": float(np.quantile(draws, 0.05)),
                "crossedBootstrapSafetyQ05": float(np.quantile(draws, 0.05)),
            }
        latency_ratios = []
        candidate_p95 = []
        control_p95 = []
        for replicate in REPLICATES:
            control_latency = finite(
                reports[endpoint_label(replicate, CONTROL)]["performance"]["gameWallMsP95"],
                "control latency",
            )
            candidate_latency = finite(
                reports[endpoint_label(replicate, treatment)]["performance"]["gameWallMsP95"],
                "candidate latency",
            )
            control_p95.append(control_latency)
            candidate_p95.append(candidate_latency)
            latency_ratios.append(candidate_latency / control_latency)
        stalls = sum(
            int(reports[endpoint_label(replicate, treatment)]["stalls"])
            for replicate in REPLICATES
        )
        control_stalls = sum(
            int(reports[endpoint_label(replicate, CONTROL)]["stalls"])
            for replicate in REPLICATES
        )
        malformed_episodes = sum(
            nonnegative_int(
                reports[endpoint_label(replicate, treatment)].get(
                    "_verifiedMalformedEpisodes"
                ),
                "verified candidate malformed episodes",
            )
            for replicate in REPLICATES
        )
        control_malformed_episodes = sum(
            nonnegative_int(
                reports[endpoint_label(replicate, CONTROL)].get(
                    "_verifiedMalformedEpisodes"
                ),
                "verified control malformed episodes",
            )
            for replicate in REPLICATES
        )
        comparisons[treatment] = {
            "metrics": metrics,
            "guardians": guardian_metrics,
            "latency": {
                "candidateWorstP95Ms": max(candidate_p95),
                "controlWorstP95Ms": max(control_p95),
                "worstMatchedRatio": max(latency_ratios),
            },
            "stalls": stalls,
            "matchedControlStalls": control_stalls,
            "malformedEpisodes": malformed_episodes,
            "matchedControlMalformedEpisodes": control_malformed_episodes,
        }
    adjusted = holm_adjust(primary_p)
    thresholds = analysis["nonRegressionThresholds"]
    for treatment in TREATMENTS:
        comparison = comparisons[treatment]
        for metric in PRIMARY:
            key = f"{treatment}/{metric}"
            comparison["metrics"][metric]["oneSidedP"] = primary_p[key]
            comparison["metrics"][metric]["holmAdjustedP"] = adjusted[key]
        primary_pass = all(
            comparison["metrics"][metric]["holmAdjustedP"] <= alpha for metric in PRIMARY
        )
        gates = {
            "primaryFamily": primary_pass,
            "minimumWinGain": comparison["metrics"]["trueWinRate"]["point"]
            >= finite(analysis["minimumTrueWinPointGain"], "minimumTrueWinPointGain"),
            "replicateConsistency": (
                sum(
                    value > 0
                    for value in comparison["metrics"]["trueWinRate"]["replicatePoints"]
                )
                >= int(analysis["minimumPositiveReplicates"])
                and sum(
                    value
                    < finite(
                        analysis["minimumReplicateTrueWinGain"],
                        "minimumReplicateTrueWinGain",
                    )
                    for value in comparison["metrics"]["trueWinRate"]["replicatePoints"]
                )
                <= int(analysis["maximumReplicatesBelowFloor"])
            ),
            "reach15": comparison["metrics"]["reach15Rate"]["lower95"]
            >= finite(thresholds["reach15RateDeltaLower"], "reach15 threshold"),
            "finalVp": comparison["metrics"]["finalVp"]["lower95"]
            >= finite(thresholds["finalVpDeltaLower"], "finalVp threshold"),
            "finishSpeed": comparison["metrics"]["finishSpeed"]["lower95"]
            >= finite(thresholds["finishSpeedDeltaLower"], "finish threshold"),
            "guardianWorstCase": min(item["lower95"] for item in comparison["guardians"].values())
            >= finite(thresholds["guardianTrueWinDeltaLower"], "guardian threshold"),
            "stalls": max(comparison["stalls"], comparison["matchedControlStalls"])
            <= int(thresholds["maxStalls"]),
            "malformedEpisodes": max(
                comparison["malformedEpisodes"],
                comparison["matchedControlMalformedEpisodes"],
            )
            == 0,
            "latencyAbsolute": comparison["latency"]["candidateWorstP95Ms"]
            <= finite(thresholds["maxGameWallMsP95"], "latency absolute threshold"),
            "latencyRatio": comparison["latency"]["worstMatchedRatio"]
            <= finite(thresholds["maxLatencyRatioToMatchedControl"], "latency ratio threshold"),
        }
        comparison["gates"] = gates
        comparison["passed"] = all(gates.values())
    eligible = [treatment for treatment in TREATMENTS if comparisons[treatment]["passed"]]
    selected = (
        max(
            eligible,
            key=lambda treatment: (
                comparisons[treatment]["metrics"]["trueWinRate"]["point"],
                comparisons[treatment]["metrics"]["lateGameScore"]["point"],
                -TREATMENTS.index(treatment),
            ),
        )
        if eligible
        else None
    )
    return {
        "schemaVersion": SCHEMA,
        "valid": True,
        "developmentOnly": True,
        "promotionEligible": False,
        "freshPublicConfirmationRequired": True,
        "bootstrap": bootstrap,
        "familywiseAlpha": alpha,
        "holmAdjustedPrimaryP": adjusted,
        "comparisons": comparisons,
        "selectedTreatment": selected,
        "privateEvaluationAuthorized": False,
    }


def validate_fable_receipt(
    protocol: Mapping[str, Any], *, protocol_path: Path, review_path: Path
) -> None:
    receipt_contract = protocol["review"]["commandReceipt"]
    receipt_path = resolve_artifact(
        receipt_contract.get("path"),
        anchor=REPO_ROOT,
        label="Fable command receipt",
    )
    if not receipt_path.is_file() or sha256(receipt_path) != receipt_contract["sha256"]:
        raise ValueError("Fable command receipt is missing or hash-invalid")
    receipt = read_json_object(receipt_path, "Fable command receipt")
    expected_keys = {
        "schemaVersion",
        "valid",
        "model",
        "effort",
        "tools",
        "noSessionPersistence",
        "argv",
        "cwd",
        "plan",
        "startedAtUtc",
        "finishedAtUtc",
        "exitCode",
        "stdoutPath",
        "stdoutSha256",
        "stderrPath",
        "stderrSha256",
    }
    exact_keys(receipt, expected_keys, "Fable command receipt")
    plan_relative = protocol.get("plan")
    runtime_plan_path = resolve_artifact(
        plan_relative, anchor=REPO_ROOT, label="P30 plan"
    )
    plan_contract = receipt.get("plan")
    cwd_value = receipt.get("cwd")
    if (
        not isinstance(plan_contract, dict)
        or set(plan_contract) != {"path", "sha256"}
        or plan_contract.get("path") != plan_relative
        or plan_contract.get("sha256") != sha256(runtime_plan_path)
        or not isinstance(cwd_value, str)
        or not Path(cwd_value).is_absolute()
        or "\n" in cwd_value
    ):
        raise ValueError("Fable command receipt does not bind the reviewed P30 plan")
    reviewed_plan_path = Path(cwd_value) / str(plan_relative)
    prompt = final_fable_review_prompt(reviewed_plan_path)
    expected_argv = [
        "claude",
        "-p",
        "--model",
        "fable",
        "--effort",
        "high",
        "--tools",
        "Read",
        "--no-session-persistence",
        prompt,
    ]
    if (
        receipt.get("schemaVersion") != FABLE_RECEIPT_SCHEMA
        or receipt.get("valid") is not True
        or receipt.get("model") != "fable"
        or receipt.get("effort") != "high"
        or receipt.get("tools") != ["Read"]
        or receipt.get("noSessionPersistence") is not True
        or receipt.get("argv") != expected_argv
        or receipt.get("exitCode") != 0
        or receipt.get("stdoutSha256") != sha256(review_path)
        or not is_sha256(receipt.get("stderrSha256"))
    ):
        raise ValueError("Fable command receipt differs from the mandatory high-effort review")
    if utc_instant(receipt.get("finishedAtUtc"), "Fable finish") <= utc_instant(
        receipt.get("startedAtUtc"), "Fable start"
    ):
        raise ValueError("Fable command receipt has non-positive duration")
    stdout_path = resolve_artifact(
        receipt.get("stdoutPath"), anchor=receipt_path.parent, label="Fable stdout"
    )
    stderr_path = resolve_artifact(
        receipt.get("stderrPath"), anchor=receipt_path.parent, label="Fable stderr"
    )
    if stdout_path.resolve() != review_path.resolve() or sha256(stdout_path) != receipt["stdoutSha256"]:
        raise ValueError("Fable command receipt names a different review artifact")
    if (
        not stderr_path.is_file()
        or sha256(stderr_path) != receipt["stderrSha256"]
        or stderr_path.stat().st_size != 0
    ):
        raise ValueError("Fable review command did not have an empty bound stderr")
    if len({receipt_path.resolve(), review_path.resolve(), stderr_path.resolve()}) != 3:
        raise ValueError("Fable receipt, stdout, and stderr paths must be distinct")


def final_fable_review_prompt(plan_path: Path) -> str:
    return (
        f"Perform the final pre-authorization review of {plan_path.resolve()} and the "
        "source-locked implementation files it directly names. Verify that the prior "
        "review findings are concretely addressed, especially quantitative confirmation "
        "gates, divergence classification, realized-dose telemetry, duration/storage "
        "go-no-go rules, local-only review provenance, one-shot launch/signing boundaries, "
        "and exact-stack determinism. Identify any remaining P0/P1 launch blocker. End the "
        "final nonempty line with exactly VERDICT: ACCEPT only if no P0/P1 blocker remains; "
        "otherwise end with exactly VERDICT: REJECT."
    )


def validate_root_materialization(
    *,
    config_path: Path,
    binding_path: Path,
    protocol: Mapping[str, Any],
    protocol_path: Path,
    replicate: str,
    arm: str,
) -> None:
    config = read_json_object(config_path, "P30 root config")
    binding = read_json_object(binding_path, "P30 root binding")
    binding_keys = {
        "schemaVersion",
        "experiment",
        "replicate",
        "arm",
        "protocolPath",
        "protocolSha256",
        "configSha256",
        "catalogSha256",
        "initialPolicySha256",
        "promotionEligible",
    }
    exact_keys(binding, binding_keys, "P30 root binding")
    bound_protocol = resolve_artifact(
        binding.get("protocolPath"), anchor=REPO_ROOT, label="root-bound protocol"
    )
    if (
        binding.get("schemaVersion") != ROOT_BINDING_SCHEMA
        or binding.get("experiment") != protocol["experiment"]
        or binding.get("replicate") != replicate
        or binding.get("arm") != arm
        or bound_protocol.resolve() != protocol_path.resolve()
        or binding.get("protocolSha256") != sha256(protocol_path)
        or binding.get("configSha256") != sha256(config_path)
        or binding.get("catalogSha256") != protocol["catalog"]["sha256"]
        or binding.get("initialPolicySha256") != protocol["initialPolicy"]["sha256"]
        or binding.get("promotionEligible") is not False
    ):
        raise ValueError("P30 root binding differs from the authorized protocol materialization")
    replicate_contract = next(row for row in protocol["replicates"] if row["id"] == replicate)
    arm_contract = next(row for row in protocol["arms"] if row["id"] == arm)
    schedule = protocol["seedSchedule"]
    training = protocol["training"]
    expected_root = (
        "ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon/"
        f"league/rep-{replicate}/{arm}"
    )
    base_config_path = REPO_ROOT / SOURCE_FILE_PATHS["baseConfig"]
    if (
        not base_config_path.is_file()
        or sha256(base_config_path)
        != "c2c0fd7637f27dbc6afdee4adbef48a57b83c19d2c60ebf351f165f506bfb52e"
    ):
        raise ValueError("P30 frozen base config is missing or hash-invalid")
    expected_config = copy.deepcopy(read_json_object(base_config_path, "P30 frozen base config"))
    expected_config.update(
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
    expected_extra = expected_config["train"]["extraArgs"]
    scalar_at = expected_extra.index("--solo-reach30-coef")
    expected_extra[scalar_at + 1] = f"{float(arm_contract['soloReach30Coef']):g}"
    if arm_contract["soloReach30Bands"] is not None:
        expected_extra.extend(
            [
                "--solo-reach30-bands",
                ",".join(
                    f"{upper}:{float(coefficient):g}"
                    for upper, coefficient in arm_contract["soloReach30Bands"]
                ),
            ]
        )
    config_without_readme = dict(config)
    expected_without_readme = dict(expected_config)
    config_without_readme.pop("_readme", None)
    expected_without_readme.pop("_readme", None)
    if config_without_readme != expected_without_readme:
        raise ValueError("P30 root config differs from the exact frozen materialization")
    required_config = {
        "catalogPath": protocol["catalog"]["path"],
        "catalogSha256": protocol["catalog"]["sha256"],
        "seats": training["seats"],
        "soloMaxStatusLevel": training["soloMaxStatusLevel"],
        "maxRounds": training["maxRounds"],
        "gamesPerGen": training["gamesPerGeneration"],
        "matchupGames": training["gamesPerGeneration"],
        "evalGames": training["evalGamesPerGeneration"],
        "strategicDecisionScope": training["strategicDecisionScope"],
        "guardianSchedule": training["guardianSchedule"],
        "sample": training["sample"],
        "temperature": training["temperature"],
        "workers": training["workers"],
        "initFrom": protocol["initialPolicy"]["path"],
        "laneInit": {"main-0": protocol["initialPolicy"]["path"]},
        "paths": {"root": expected_root},
        "seedBase": replicate_contract["trainBase"],
        "seedSchedule": {
            "trainBase": replicate_contract["trainBase"],
            "trainStride": schedule["trainStride"],
            "evalBase": replicate_contract["evalBase"],
            "evalStride": schedule["evalStride"],
            "maxGeneration": schedule["maxGeneration"],
        },
        "lanes": {"main": 1, "mainExploiter": 0, "leagueExploiter": 0},
        "promoteEvery": 0,
    }
    if any(config.get(key) != value for key, value in required_config.items()):
        raise ValueError("P30 root config differs from the protocol materialization")
    train = config.get("train")
    if not isinstance(train, dict) or {
        "epochs": train.get("epochs"),
        "batchSize": train.get("batchSize"),
        "ppoRowsPerEpoch": train.get("ppoRowsPerEpoch"),
    } != {
        "epochs": training["epochs"],
        "batchSize": training["batchSize"],
        "ppoRowsPerEpoch": training["ppoRowsPerEpoch"],
    }:
        raise ValueError("P30 root trainer materialization changed")
    extra = train.get("extraArgs")
    frozen_trainer_args = {
        "--lr": training["learningRate"],
        "--clip-eps": training["clipEpsilon"],
        "--value-clip-eps": training["valueClipEpsilon"],
        "--entropy-coef": training["entropyCoef"],
        "--kl-ref-coef": training["klReferenceCoef"],
        "--gamma": training["gamma"],
        "--gae-lambda": training["gaeLambda"],
        "--value-coef": training["valueCoef"],
        "--reach30-value-coef": training["reach30ValueCoef"],
        "--win-bonus": training["winBonus"],
        "--all-fallen-loss": training["allFallenPenalty"],
        "--behavior-reach30-ece-max": protocol["trustGates"]["maxBehaviorReach30Ece"],
    }
    for name, expected in frozen_trainer_args.items():
        actual = finite(float(extra_arg(extra, name, "P30 root config")), name)
        if not math.isclose(actual, finite(expected, name), abs_tol=1e-15):
            raise ValueError(f"P30 root trainer argument {name} changed")
    scalar = float(extra_arg(extra, "--solo-reach30-coef", "P30 root config"))
    if not math.isclose(scalar, float(arm_contract["soloReach30Coef"]), abs_tol=1e-15):
        raise ValueError("P30 root reach-30 scalar dose changed")
    band_positions = [index for index, item in enumerate(extra) if item == "--solo-reach30-bands"]
    bands = arm_contract["soloReach30Bands"]
    if bands is None:
        if band_positions:
            raise ValueError("P30 scalar arm unexpectedly enables scheduled reach-30 credit")
    else:
        if len(band_positions) != 1:
            raise ValueError("P30 scheduled arm lacks exactly one reach-30 band declaration")
        expected_bands = ",".join(f"{upper}:{coefficient}" for upper, coefficient in bands)
        if extra_arg(extra, "--solo-reach30-bands", "P30 root config") != expected_bands:
            raise ValueError("P30 root scheduled reach-30 dose changed")


def validate_generation_audit_trust(
    audit: Mapping[str, Any], *, protocol: Mapping[str, Any], arm: str, label: str
) -> None:
    gates = protocol["trustGates"]
    training = protocol["training"]
    arm_contract = next(row for row in protocol["arms"] if row["id"] == arm)
    if audit.get("trustedCoreAuditSchema") != "arc-v32-generation-audit-v1":
        raise ValueError(f"{label}: generation audit trusted-core schema changed")
    if finite(audit.get("behaviorLogpMaxAbsError"), f"{label} logp error") > gates[
        "maxBehaviorLogpReconstructionError"
    ]:
        raise ValueError(f"{label}: generation audit behavior logp gate failed")
    calibration = audit.get("behaviorReach30Calibration")
    if not isinstance(calibration, dict) or not {
        "ece",
        "brier",
        "constant_brier",
        "rows",
    }.issubset(calibration):
        raise ValueError(f"{label}: generation audit calibration is incomplete")
    if (
        finite(calibration["ece"], f"{label} calibration ECE")
        > gates["maxBehaviorReach30Ece"]
        or finite(calibration["brier"], f"{label} calibration Brier")
        > finite(calibration["constant_brier"], f"{label} constant Brier") + 1e-12
        or finite(calibration["rows"], f"{label} calibration rows") <= 0
    ):
        raise ValueError(f"{label}: generation audit calibration gate failed")
    metrics = audit.get("epochMetrics")
    if not isinstance(metrics, list) or len(metrics) != training["epochs"]:
        raise ValueError(f"{label}: generation audit PPO epoch coverage changed")
    for expected_epoch, metric in enumerate(metrics, 1):
        if not isinstance(metric, dict) or set(metric) != {
            "epoch",
            "approxKl",
            "clipFraction",
            "roundWeightedKl",
            "roundWeightedClipFraction",
            "optimizerSteps",
        }:
            raise ValueError(f"{label}: generation audit PPO metric is malformed")
        if (
            metric["epoch"] != expected_epoch
            or metric["optimizerSteps"] != training["optimizerStepsPerEpoch"]
            or finite(metric["approxKl"], f"{label} approximate KL") > gates["maxApproxKl"]
            or finite(metric["roundWeightedKl"], f"{label} weighted KL")
            > gates["maxApproxKl"]
            or finite(metric["clipFraction"], f"{label} clip fraction")
            > gates["maxOrdinaryClipFraction"]
            or finite(metric["roundWeightedClipFraction"], f"{label} weighted clip fraction")
            > gates["maxWeightedClipFraction"]
        ):
            raise ValueError(f"{label}: generation audit PPO trust gate failed")
    if audit.get("soloReach30Bands") != arm_contract["soloReach30Bands"]:
        raise ValueError(f"{label}: generation audit reach30 schedule changed")
    credit = audit.get("soloReach30Credit")
    treatment_enabled = arm_contract["soloReach30Coef"] > 0 or bool(
        arm_contract["soloReach30Bands"]
        and any(coefficient > 0 for _, coefficient in arm_contract["soloReach30Bands"])
    )
    if (
        not isinstance(credit, dict)
        or finite(credit.get("soloReach30Coef"), f"{label} reach30 coefficient")
        != arm_contract["soloReach30Coef"]
        or credit.get("reach30Horizon") != "30"
        or type(credit.get("soloReach30Applied")) is not int
        or (treatment_enabled and credit["soloReach30Applied"] <= 0)
        or (not treatment_enabled and credit["soloReach30Applied"] != 0)
    ):
        raise ValueError(f"{label}: generation audit reach30 credit telemetry changed")


def validate_generation_audit_chain(
    audit: Mapping[str, Any],
    *,
    endpoint_root: Path,
    protocol: Mapping[str, Any],
    protocol_sha256: str,
    source_commit: str,
    source_contract_sha256: str,
    label: str,
) -> None:
    endpoint = protocol["seedSchedule"]["maxGeneration"]
    chain = audit.get("auditChain")
    if not isinstance(chain, list) or len(chain) != endpoint - 1:
        raise ValueError(f"{label}: generation audit chain length changed")
    accumulated: list[dict[str, Any]] = []
    for generation, entry in enumerate(chain, 1):
        if not isinstance(entry, dict) or set(entry) != {
            "generation",
            "path",
            "sha256",
            "checkpointSha256",
        }:
            raise ValueError(f"{label}: generation audit chain entry is malformed")
        expected_path = endpoint_root / "artifacts" / f"gen{generation}-audit.json"
        bound_path = resolve_artifact(
            entry["path"], anchor=endpoint_root, label=f"{label} prior generation audit"
        )
        if (
            entry["generation"] != generation
            or bound_path.resolve() != expected_path.resolve()
            or not bound_path.is_file()
            or not is_sha256(entry["sha256"])
            or sha256(bound_path) != entry["sha256"]
            or not is_sha256(entry["checkpointSha256"])
        ):
            raise ValueError(f"{label}: prior generation audit binding changed")
        prior = read_json_object(bound_path, f"{label} generation {generation} audit")
        expected_previous = accumulated[-1]["sha256"] if accumulated else None
        if (
            prior.get("schemaVersion") != "arc-v35-generation-audit-v1"
            or prior.get("valid") is not True
            or prior.get("generation") != generation
            or prior.get("root") != str(endpoint_root)
            or prior.get("protocolSha256") != protocol_sha256
            or prior.get("sourceCommit") != source_commit
            or prior.get("sourceContractSha256") != source_contract_sha256
            or prior.get("checkpointSha256") != entry["checkpointSha256"]
            or prior.get("previousAuditSha256") != expected_previous
            or prior.get("auditChain") != accumulated
        ):
            raise ValueError(f"{label}: prior generation audit chain is invalid")
        accumulated.append(entry)
    if audit.get("previousAuditSha256") != chain[-1]["sha256"]:
        raise ValueError(f"{label}: endpoint audit does not bind its predecessor")


def validate_generation_execution_receipt_chain(
    *,
    final_receipt_path: Path,
    final_receipt_sha256: Any,
    endpoint_root: Path,
    protocol: Mapping[str, Any],
    protocol_path: Path,
    source_commit: str,
    source_contract_sha256: str,
    replicate: str,
    arm: str,
    config_sha256: str,
    binding_sha256: str,
    final_checkpoint_sha256: str,
    label: str,
) -> dict[str, Any]:
    if (
        not final_receipt_path.is_file()
        or not is_sha256(final_receipt_sha256)
        or sha256(final_receipt_path) != final_receipt_sha256
    ):
        raise ValueError(f"{label}: final generation execution receipt is missing or hash-invalid")
    trust = protocol["executionTrust"]
    executor_public_key = role_public_key_path(trust, "executor")
    issuer_public_key = role_public_key_path(trust, "issuer")
    receipt_path = final_receipt_path.resolve()
    seen_tokens: set[str] = set()
    later_started: dt.datetime | None = None
    final_receipt: dict[str, Any] | None = None
    for generation in range(protocol["seedSchedule"]["maxGeneration"], 0, -1):
        signed_receipt = read_json_object(receipt_path, f"{label} generation {generation} receipt")
        receipt = verify_signed_payload(
            signed_receipt,
            expected_role="executor",
            public_key_path=executor_public_key,
        )
        exact_keys(
            receipt,
            {
                "schemaVersion",
                "valid",
                "promotionEligible",
                "kind",
                "tokenId",
                "campaignId",
                "authorization",
                "consumedMarker",
                "startedAtUtc",
                "finishedAtUtc",
                "subject",
                "command",
                "isolation",
                "process",
                "exitCode",
                "noSupervisorChildRemaining",
                "gpuBefore",
                "gpuAfter",
                "gpuEmptyAfter",
                "leaseReleased",
                "missingRequiredOutputs",
                "artifacts",
                "predecessor",
                "executionRequest",
            },
            f"{label} generation {generation} execution receipt",
        )
        subject = receipt.get("subject")
        if (
            receipt.get("schemaVersion") != AUTHORIZED_EXECUTION_RECEIPT_SCHEMA
            or receipt.get("valid") is not True
            or receipt.get("promotionEligible") is not False
            or receipt.get("kind") != "generation"
            or receipt.get("campaignId") != protocol["experiment"]
            or not isinstance(subject, dict)
            or subject.get("root") != str(endpoint_root)
            or subject.get("replicate") != replicate
            or subject.get("arm") != arm
            or subject.get("generation") != generation
            or subject.get("protocolSha256") != sha256(protocol_path)
            or subject.get("sourceCommit") != source_commit
            or subject.get("sourceContractSha256") != source_contract_sha256
            or subject.get("configSha256") != config_sha256
            or subject.get("bindingSha256") != binding_sha256
            or receipt.get("exitCode") != 0
            or receipt.get("noSupervisorChildRemaining") is not True
            or receipt.get("gpuEmptyAfter") is not True
            or receipt.get("leaseReleased") is not True
            or receipt.get("missingRequiredOutputs") != []
            or receipt.get("tokenId") in seen_tokens
        ):
            raise ValueError(f"{label}: signed generation {generation} execution failed closed")
        seen_tokens.add(receipt["tokenId"])
        started = utc_instant(receipt.get("startedAtUtc"), "generation execution start")
        finished = utc_instant(receipt.get("finishedAtUtc"), "generation execution finish")
        if finished <= started or (later_started is not None and finished > later_started):
            raise ValueError(f"{label}: generation execution chronology changed")
        later_started = started
        authorization_binding = receipt.get("authorization")
        consumed_binding = receipt.get("consumedMarker")
        if (
            not isinstance(authorization_binding, dict)
            or set(authorization_binding) != {"path", "sha256"}
            or not isinstance(consumed_binding, dict)
            or set(consumed_binding) != {"path", "sha256"}
        ):
            raise ValueError(f"{label}: generation authorization evidence is malformed")
        authorization_path = resolve_artifact(
            authorization_binding["path"], anchor=receipt_path.parent, label="generation authorization"
        )
        consumed_path = resolve_artifact(
            consumed_binding["path"], anchor=receipt_path.parent, label="generation consumed marker"
        )
        if (
            not authorization_path.is_file()
            or sha256(authorization_path) != authorization_binding["sha256"]
            or not consumed_path.is_file()
            or sha256(consumed_path) != consumed_binding["sha256"]
        ):
            raise ValueError(f"{label}: generation authorization evidence is hash-invalid")
        authorization = verify_signed_payload(
            read_json_object(authorization_path, "generation authorization"),
            expected_role="issuer",
            public_key_path=issuer_public_key,
        )
        exact_keys(
            authorization,
            {
                "schemaVersion",
                "authorized",
                "immutable",
                "promotionEligible",
                "kind",
                "tokenId",
                "campaignId",
                "issuedAtUtc",
                "notBeforeUtc",
                "expiresAtUtc",
                "protocol",
                "sourceContract",
                "subject",
                "command",
                "isolation",
                "outputs",
                "ledger",
                "predecessor",
                "request",
            },
            f"{label} generation {generation} authorization",
        )
        consumed = read_json_object(consumed_path, "generation consumed marker")
        exact_keys(
            consumed,
            {
                "schemaVersion",
                "tokenId",
                "authorizationPath",
                "authorizationSha256",
                "consumedAtUtc",
                "consumerPid",
                "host",
                "bootId",
            },
            f"{label} generation {generation} consumed marker",
        )
        if (
            authorization.get("schemaVersion") != EXECUTION_AUTHORIZATION_SCHEMA
            or authorization.get("authorized") is not True
            or authorization.get("immutable") is not True
            or authorization.get("promotionEligible") is not False
            or authorization.get("kind") != "generation"
            or authorization.get("tokenId") != receipt["tokenId"]
            or authorization.get("subject") != subject
            or authorization.get("command") != receipt.get("command")
            or authorization.get("predecessor") != receipt.get("predecessor")
            or consumed.get("schemaVersion") != "arc-v35-p30-consumed-token-v1"
            or consumed.get("tokenId") != receipt["tokenId"]
            or consumed.get("authorizationPath") != str(authorization_path.resolve())
            or consumed.get("authorizationSha256") != sha256(authorization_path)
            or consumed.get("consumedAtUtc") != receipt.get("startedAtUtc")
        ):
            raise ValueError(f"{label}: generation one-shot token evidence changed")
        authorization_predecessor = authorization.get("predecessor")
        predecessor_path_for_request = (
            None
            if authorization_predecessor is None
            else resolve_artifact(
                authorization_predecessor["receiptPath"],
                anchor=authorization_path.parent,
                label=f"{label} generation authorization predecessor",
            )
        )
        validate_role_request_binding(
            authorization["request"],
            protocol=protocol,
            protocol_path=protocol_path,
            role="issuer",
            verb="issue-generation",
            predecessor_path=predecessor_path_for_request,
            expected_output_path=authorization_path,
            expected_subject_fields={
                "replicate": replicate,
                "arm": arm,
                "generation": generation,
                "root": str(endpoint_root),
            },
            label=f"{label} generation {generation} authorization",
        )
        validate_role_request_binding(
            receipt["executionRequest"],
            protocol=protocol,
            protocol_path=protocol_path,
            role="executor",
            verb="execute",
            predecessor_path=authorization_path,
            expected_output_path=receipt_path,
            expected_subject_fields={
                "authorizationPath": str(authorization_path.resolve()),
                "replicate": replicate,
                "arm": arm,
                "generation": generation,
            },
            label=f"{label} generation {generation} execution",
        )
        artifacts = receipt.get("artifacts")
        if not isinstance(artifacts, dict):
            raise ValueError(f"{label}: generation artifact registry is malformed")
        audit_entry = artifacts.get("audit")
        checkpoint_entry = artifacts.get("checkpoint")
        expected_audit_path = endpoint_root / "artifacts" / f"gen{generation}-audit.json"
        expected_checkpoint_path = (
            endpoint_root / "checkpoints" / f"main-0-gen{generation}.pt"
        )
        if (
            not isinstance(audit_entry, dict)
            or Path(audit_entry.get("path", "")).resolve() != expected_audit_path.resolve()
            or sha256(expected_audit_path) != audit_entry.get("sha256")
            or not isinstance(checkpoint_entry, dict)
            or Path(checkpoint_entry.get("path", "")).resolve()
            != expected_checkpoint_path.resolve()
            or sha256(expected_checkpoint_path) != checkpoint_entry.get("sha256")
        ):
            raise ValueError(f"{label}: generation receipt artifact binding changed")
        audit = read_json_object(expected_audit_path, f"{label} generation {generation} audit")
        if (
            audit.get("generation") != generation
            or audit.get("authorizationTokenId") != receipt["tokenId"]
            or audit.get("protocolSha256") != sha256(protocol_path)
            or audit.get("sourceCommit") != source_commit
            or audit.get("checkpointSha256") != checkpoint_entry["sha256"]
        ):
            raise ValueError(f"{label}: generation audit is not bound to its signed execution")
        if generation == protocol["seedSchedule"]["maxGeneration"]:
            final_receipt = receipt
            if checkpoint_entry["sha256"] != final_checkpoint_sha256:
                raise ValueError(f"{label}: final signed execution checkpoint changed")
        predecessor = receipt.get("predecessor")
        if generation == 1:
            if predecessor is not None:
                raise ValueError(f"{label}: generation-one receipt has a predecessor")
        else:
            if not isinstance(predecessor, dict) or set(predecessor) != {"receiptPath", "sha256"}:
                raise ValueError(f"{label}: generation receipt predecessor is malformed")
            predecessor_path = resolve_artifact(
                predecessor["receiptPath"], anchor=receipt_path.parent, label="prior generation receipt"
            )
            if not predecessor_path.is_file() or sha256(predecessor_path) != predecessor["sha256"]:
                raise ValueError(f"{label}: generation receipt predecessor is hash-invalid")
            receipt_path = predecessor_path
    assert final_receipt is not None
    return final_receipt


def validate_evaluation_receipt(
    *,
    receipt_path: Path,
    expected_hash: Any,
    role: str,
    label: str,
    replicate: str,
    arm: str,
    protocol: Mapping[str, Any],
    source_commit: str,
    checkpoint_path: Path,
    weights_hash: str,
    report_path: Path,
    stdout_path: Path,
    stderr_path: Path,
    exit_code_path: Path,
    server_log_path: Path,
    config_sha256: str,
    binding_sha256: str,
    root_identity: str,
) -> dict[str, Any]:
    if not receipt_path.is_file() or not is_sha256(expected_hash) or sha256(receipt_path) != expected_hash:
        raise ValueError(f"{label}: {role} execution receipt is missing or hash-invalid")
    receipt = read_json_object(receipt_path, f"{label} {role} execution receipt")
    exact_keys(
        receipt,
        {
            "schemaVersion",
            "valid",
            "attemptId",
            "role",
            "label",
            "replicate",
            "arm",
            "malformedEpisodes",
            "startedAtUtc",
            "finishedAtUtc",
            "execution",
            "contract",
            "artifacts",
        },
        f"{label} {role} execution receipt",
    )
    expected_attempt = f"{label}:{role}:attempt-{'1' if role == 'primary' else '2'}"
    if (
        receipt.get("schemaVersion") != EVALUATION_RECEIPT_SCHEMA
        or receipt.get("valid") is not True
        or receipt.get("attemptId") != expected_attempt
        or receipt.get("role") != role
        or receipt.get("label") != label
        or receipt.get("replicate") != replicate
        or receipt.get("arm") != arm
        or receipt.get("malformedEpisodes") != 0
    ):
        raise ValueError(f"{label}: {role} execution receipt identity or parser result changed")
    if utc_instant(receipt.get("finishedAtUtc"), f"{label} {role} finish") <= utc_instant(
        receipt.get("startedAtUtc"), f"{label} {role} start"
    ):
        raise ValueError(f"{label}: {role} execution receipt has non-positive duration")
    contract = receipt.get("contract")
    expected_contract = {
        "sourceCommit": source_commit,
        "catalogSha256": protocol["catalog"]["sha256"],
        "checkpointSha256": weights_hash,
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
        "root": root_identity,
    }
    if contract != expected_contract:
        raise ValueError(f"{label}: {role} execution receipt contract changed")
    execution = receipt.get("execution")
    if not isinstance(execution, dict):
        raise ValueError(f"{label}: {role} execution metadata is malformed")
    exact_keys(execution, {"cwd", "argv", "env", "inferenceSocket"}, f"{label} {role} execution")
    socket = execution.get("inferenceSocket")
    if not isinstance(socket, str) or not socket:
        raise ValueError(f"{label}: {role} inference socket is missing")
    expected_argv = [
        "/usr/bin/node",
        "scripts/evaluate-solo-checkpoint.mjs",
        "--weights",
        str(checkpoint_path.resolve()),
        "--infer-socket",
        socket,
        "--policy-obs-version",
        str(protocol["initialPolicy"]["policyObsVersion"]),
        "--catalog",
        str(resolve_artifact(protocol["catalog"]["path"], anchor=REPO_ROOT, label="catalog").resolve()),
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
        root_identity,
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
    if (
        execution.get("cwd") != str(REPO_ROOT)
        or execution.get("argv") != expected_argv
        or execution.get("env") != {"CUDA_VISIBLE_DEVICES": ""}
    ):
        raise ValueError(f"{label}: {role} execution command, cwd, or environment changed")
    expected_artifacts = {
        "checkpoint": (checkpoint_path, weights_hash),
        "report": (report_path, sha256(report_path)),
        "stdout": (stdout_path, sha256(stdout_path)),
        "stderr": (stderr_path, sha256(stderr_path)),
        "exitCode": (exit_code_path, sha256(exit_code_path)),
        "serverLog": (server_log_path, sha256(server_log_path)),
    }
    artifacts = receipt.get("artifacts")
    if not isinstance(artifacts, dict) or set(artifacts) != set(expected_artifacts):
        raise ValueError(f"{label}: {role} execution artifact registry changed")
    for artifact_label, (path, digest) in expected_artifacts.items():
        entry = artifacts[artifact_label]
        if entry != {"path": str(path.resolve()), "sha256": digest}:
            raise ValueError(f"{label}: {role} receipt has a wrong {artifact_label} binding")
    return receipt


def validate_authorized_evaluation_execution(
    *,
    receipt_path: Path,
    expected_hash: Any,
    legacy_receipt_path: Path,
    role: str,
    label: str,
    replicate: str,
    arm: str,
    protocol: Mapping[str, Any],
    protocol_path: Path,
    source_commit: str,
    source_contract_sha256: str,
    checkpoint_path: Path,
    weights_hash: str,
    generation_audit_path: Path,
    config_sha256: str,
    binding_sha256: str,
    root_identity: str,
) -> dict[str, Any]:
    if not receipt_path.is_file() or not is_sha256(expected_hash) or sha256(receipt_path) != expected_hash:
        raise ValueError(f"{label}: signed {role} execution receipt is missing or hash-invalid")
    trust = protocol["executionTrust"]
    executor_public_key = role_public_key_path(trust, "executor")
    issuer_public_key = role_public_key_path(trust, "issuer")
    signed_receipt = read_json_object(receipt_path, f"{label} signed {role} receipt")
    receipt = verify_signed_payload(
        signed_receipt,
        expected_role="executor",
        public_key_path=executor_public_key,
    )
    exact_keys(
        receipt,
        {
            "schemaVersion",
            "valid",
            "promotionEligible",
            "kind",
            "tokenId",
            "campaignId",
            "authorization",
            "consumedMarker",
            "startedAtUtc",
            "finishedAtUtc",
            "subject",
            "command",
            "isolation",
            "process",
            "exitCode",
            "noSupervisorChildRemaining",
            "gpuBefore",
            "gpuAfter",
            "gpuEmptyAfter",
            "leaseReleased",
            "missingRequiredOutputs",
            "artifacts",
            "predecessor",
            "executionRequest",
        },
        f"{label} signed {role} receipt",
    )
    expected_subject = {
        "root": root_identity,
        "replicate": replicate,
        "arm": arm,
        "role": role,
        "protocolSha256": sha256(protocol_path),
        "sourceCommit": source_commit,
        "sourceContractSha256": source_contract_sha256,
        "configSha256": config_sha256,
        "bindingSha256": binding_sha256,
        "checkpointPath": str(checkpoint_path.resolve()),
        "checkpointSha256": weights_hash,
        "generationAuditPath": str(generation_audit_path.resolve()),
        "generationAuditSha256": sha256(generation_audit_path),
        "seed0": protocol["seedSchedule"]["commonPublicBase"],
        "games": protocol["seedSchedule"]["commonPublicGames"],
    }
    if (
        receipt.get("schemaVersion") != AUTHORIZED_EXECUTION_RECEIPT_SCHEMA
        or receipt.get("valid") is not True
        or receipt.get("promotionEligible") is not False
        or receipt.get("kind") != f"evaluation-{role}"
        or receipt.get("campaignId") != protocol["experiment"]
        or receipt.get("subject") != expected_subject
        or receipt.get("exitCode") != 0
        or receipt.get("noSupervisorChildRemaining") is not True
        or receipt.get("gpuEmptyAfter") is not True
        or receipt.get("leaseReleased") is not True
        or receipt.get("missingRequiredOutputs") != []
    ):
        raise ValueError(f"{label}: signed {role} execution receipt failed closed")
    if utc_instant(receipt["finishedAtUtc"], "execution finish") <= utc_instant(
        receipt["startedAtUtc"], "execution start"
    ):
        raise ValueError(f"{label}: signed {role} execution has non-positive duration")
    authorization_binding = receipt.get("authorization")
    if not isinstance(authorization_binding, dict) or set(authorization_binding) != {"path", "sha256"}:
        raise ValueError(f"{label}: signed {role} authorization binding is malformed")
    authorization_path = resolve_artifact(
        authorization_binding["path"], anchor=receipt_path.parent, label="execution authorization"
    )
    if (
        not authorization_path.is_file()
        or sha256(authorization_path) != authorization_binding["sha256"]
    ):
        raise ValueError(f"{label}: signed {role} authorization is missing or hash-invalid")
    signed_authorization = read_json_object(authorization_path, "signed execution authorization")
    authorization = verify_signed_payload(
        signed_authorization,
        expected_role="issuer",
        public_key_path=issuer_public_key,
    )
    exact_keys(
        authorization,
        {
            "schemaVersion",
            "authorized",
            "immutable",
            "promotionEligible",
            "kind",
            "tokenId",
            "campaignId",
            "issuedAtUtc",
            "notBeforeUtc",
            "expiresAtUtc",
            "protocol",
            "sourceContract",
            "subject",
            "command",
            "isolation",
            "outputs",
            "ledger",
            "predecessor",
            "request",
        },
        f"{label} signed {role} authorization",
    )
    if (
        authorization.get("schemaVersion") != EXECUTION_AUTHORIZATION_SCHEMA
        or authorization.get("authorized") is not True
        or authorization.get("immutable") is not True
        or authorization.get("promotionEligible") is not False
        or authorization.get("kind") != receipt["kind"]
        or authorization.get("tokenId") != receipt["tokenId"]
        or authorization.get("campaignId") != receipt["campaignId"]
        or authorization.get("subject") != expected_subject
        or authorization.get("command") != receipt["command"]
        or authorization.get("predecessor") != receipt["predecessor"]
    ):
        raise ValueError(f"{label}: signed {role} authorization differs from execution")
    consumed_binding = receipt.get("consumedMarker")
    if not isinstance(consumed_binding, dict) or set(consumed_binding) != {"path", "sha256"}:
        raise ValueError(f"{label}: consumed-token binding is malformed")
    consumed_path = resolve_artifact(
        consumed_binding["path"], anchor=receipt_path.parent, label="consumed token"
    )
    if not consumed_path.is_file() or sha256(consumed_path) != consumed_binding["sha256"]:
        raise ValueError(f"{label}: consumed token is missing or hash-invalid")
    consumed = read_json_object(consumed_path, "consumed token")
    exact_keys(
        consumed,
        {
            "schemaVersion",
            "tokenId",
            "authorizationPath",
            "authorizationSha256",
            "consumedAtUtc",
            "consumerPid",
            "host",
            "bootId",
        },
        f"{label} signed {role} consumed token",
    )
    if (
        consumed.get("schemaVersion") != "arc-v35-p30-consumed-token-v1"
        or consumed.get("tokenId") != receipt["tokenId"]
        or consumed.get("authorizationPath") != str(authorization_path.resolve())
        or consumed.get("authorizationSha256") != sha256(authorization_path)
        or consumed.get("consumedAtUtc") != receipt.get("startedAtUtc")
    ):
        raise ValueError(f"{label}: consumed token does not bind the signed authorization")
    predecessor_binding = authorization.get("predecessor")
    if not isinstance(predecessor_binding, dict) or set(predecessor_binding) != {
        "receiptPath",
        "sha256",
    }:
        raise ValueError(f"{label}: signed {role} predecessor is malformed")
    predecessor_path = resolve_artifact(
        predecessor_binding["receiptPath"],
        anchor=authorization_path.parent,
        label=f"{label} signed {role} predecessor",
    )
    if sha256(predecessor_path) != predecessor_binding["sha256"]:
        raise ValueError(f"{label}: signed {role} predecessor is hash-invalid")
    validate_role_request_binding(
        authorization["request"],
        protocol=protocol,
        protocol_path=protocol_path,
        role="issuer",
        verb="issue-evaluation",
        predecessor_path=predecessor_path,
        expected_output_path=authorization_path,
        expected_subject_fields={
            "replicate": replicate,
            "arm": arm,
            "evaluationRole": role,
            "root": root_identity,
        },
        label=f"{label} signed {role} authorization",
    )
    validate_role_request_binding(
        receipt["executionRequest"],
        protocol=protocol,
        protocol_path=protocol_path,
        role="executor",
        verb="execute",
        predecessor_path=authorization_path,
        expected_output_path=receipt_path,
        expected_subject_fields={
            "authorizationPath": str(authorization_path.resolve()),
            "replicate": replicate,
            "arm": arm,
            "evaluationRole": role,
        },
        label=f"{label} signed {role} execution",
    )
    artifacts = receipt.get("artifacts")
    if not isinstance(artifacts, dict):
        raise ValueError(f"{label}: signed {role} artifact registry is malformed")
    for artifact_label, entry in artifacts.items():
        if (
            not isinstance(entry, dict)
            or set(entry) != {"path", "sha256", "bytes"}
            or not is_sha256(entry.get("sha256"))
            or type(entry.get("bytes")) is not int
            or entry["bytes"] < 0
        ):
            raise ValueError(f"{label}: signed {role} {artifact_label} binding is malformed")
        path = resolve_artifact(
            entry["path"], anchor=receipt_path.parent, label=f"signed {artifact_label}"
        )
        if (
            not path.is_file()
            or sha256(path) != entry["sha256"]
            or path.stat().st_size != entry["bytes"]
        ):
            raise ValueError(f"{label}: signed {role} {artifact_label} is hash-invalid")
    legacy = artifacts.get("legacyReceipt")
    inner_entry = artifacts.get("innerExecution")
    if (
        not isinstance(legacy, dict)
        or Path(legacy["path"]).resolve() != legacy_receipt_path.resolve()
        or legacy["sha256"] != sha256(legacy_receipt_path)
        or not isinstance(inner_entry, dict)
    ):
        raise ValueError(f"{label}: signed {role} receipt does not bind its inner evidence")
    inner_path = Path(inner_entry["path"]).resolve()
    inner = read_json_object(inner_path, f"{label} {role} inner execution")
    if (
        inner.get("schemaVersion") != EVALUATION_INNER_SCHEMA
        or inner.get("valid") is not True
        or inner.get("promotionEligible") is not False
        or inner.get("role") != role
        or inner.get("attemptToken") != receipt["tokenId"]
        or inner.get("protocolSha256") != sha256(protocol_path)
        or inner.get("sourceCommit") != source_commit
        or inner.get("sourceContractSha256") != source_contract_sha256
        or inner.get("root") != root_identity
        or inner.get("replicate") != replicate
        or inner.get("arm") != arm
        or inner.get("configSha256") != config_sha256
        or inner.get("bindingSha256") != binding_sha256
        or inner.get("checkpointSha256") != weights_hash
        or inner.get("generationAuditSha256") != sha256(generation_audit_path)
        or inner.get("legacyReceipt")
        != {"path": str(legacy_receipt_path.resolve()), "sha256": sha256(legacy_receipt_path)}
    ):
        raise ValueError(f"{label}: signed {role} inner execution identity changed")
    if Path(artifacts["stdout"]["path"]).stat().st_size != 0 or Path(
        artifacts["stderr"]["path"]
    ).stat().st_size != 0:
        raise ValueError(f"{label}: signed {role} supervisor leaked output")
    return receipt


def validate_pair_integrity_receipt(
    *,
    receipt_path: Path,
    expected_hash: Any,
    primary_execution_receipt_path: Path,
    replay_execution_receipt_path: Path,
    primary_report_path: Path,
    replay_report_path: Path,
    protocol: Mapping[str, Any],
    protocol_path: Path,
    root_identity: str,
    replicate: str,
    arm: str,
    weights_hash: str,
) -> dict[str, Any]:
    if not receipt_path.is_file() or not is_sha256(expected_hash) or sha256(receipt_path) != expected_hash:
        raise ValueError("P30 pair-integrity receipt is missing or hash-invalid")
    trust = protocol["executionTrust"]
    public_key_path = role_public_key_path(trust, "guardian")
    receipt = verify_signed_payload(
        read_json_object(receipt_path, "P30 pair-integrity receipt"),
        expected_role="guardian",
        public_key_path=public_key_path,
    )
    exact_keys(
        receipt,
        {
            "schemaVersion",
            "valid",
            "promotionEligible",
            "diagnosticCodes",
            "issuedAtUtc",
            "protocol",
            "root",
            "replicate",
            "arm",
            "checkpointSha256",
            "primaryReceipt",
            "replayReceipt",
            "games",
            "perGameSha256",
            "replayHashesSha256",
            "malformedEpisodes",
            "request",
        },
        "P30 pair-integrity receipt",
    )
    primary_report = read_json_object(primary_report_path, "pair primary report")
    replay_report = read_json_object(replay_report_path, "pair replay report")
    primary_games = primary_report.get("perGame")
    replay_games = replay_report.get("perGame")
    primary_replays = primary_report.get("replayHashes")
    replay_replays = replay_report.get("replayHashes")
    if (
        receipt.get("schemaVersion") != PAIR_INTEGRITY_SCHEMA
        or receipt.get("valid") is not True
        or receipt.get("promotionEligible") is not False
        or receipt.get("diagnosticCodes")
        != ["EXACT_PER_GAME_MATCH", "EXACT_REPLAY_HASH_MATCH"]
        or receipt.get("protocol")
        != {"path": str(protocol_path.resolve()), "sha256": sha256(protocol_path)}
        or receipt.get("root") != root_identity
        or receipt.get("replicate") != replicate
        or receipt.get("arm") != arm
        or receipt.get("checkpointSha256") != weights_hash
        or receipt.get("primaryReceipt")
        != {
            "path": str(primary_execution_receipt_path.resolve()),
            "sha256": sha256(primary_execution_receipt_path),
        }
        or receipt.get("replayReceipt")
        != {
            "path": str(replay_execution_receipt_path.resolve()),
            "sha256": sha256(replay_execution_receipt_path),
        }
        or receipt.get("games") != protocol["seedSchedule"]["commonPublicGames"]
        or receipt.get("malformedEpisodes") != 0
        or primary_games != replay_games
        or primary_replays != replay_replays
        or receipt.get("perGameSha256")
        != hashlib.sha256(
            json.dumps(
                primary_games,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            ).encode()
        ).hexdigest()
        or receipt.get("replayHashesSha256")
        != hashlib.sha256(
            json.dumps(
                primary_replays,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            ).encode()
        ).hexdigest()
    ):
        raise ValueError("P30 signed pair-integrity receipt failed closed")
    validate_role_request_binding(
        receipt["request"],
        protocol=protocol,
        protocol_path=protocol_path,
        role="guardian",
        verb="attest-pair",
        predecessor_path=replay_execution_receipt_path,
        expected_output_path=receipt_path,
        expected_subject_fields={"replicate": replicate, "arm": arm},
        label=f"{replicate}-{arm} pair integrity",
    )
    utc_instant(receipt.get("issuedAtUtc"), "pair-integrity issue time")
    return receipt


def _analysis_runtime_namespaces() -> dict[str, str]:
    try:
        return {
            "pid": os.readlink("/proc/self/ns/pid"),
            "user": os.readlink("/proc/self/ns/user"),
            "network": os.readlink("/proc/self/ns/net"),
        }
    except OSError as exc:
        raise RuntimeError("analysis namespace evidence is unavailable") from exc


def _analysis_runtime_start_ticks() -> int:
    try:
        return int(Path("/proc/self/stat").read_text().split()[21])
    except (FileNotFoundError, OSError, IndexError, ValueError) as exc:
        raise RuntimeError("analysis process start evidence is unavailable") from exc


def _consume_analysis_capability(
    capability_fd: int, *, expected_sha256: str, expected_bytes: int
) -> None:
    """Validate and close the sole inherited sealed capability descriptor."""

    try:
        metadata = os.fstat(capability_fd)
    except OSError as exc:
        raise RuntimeError(
            "analysis launch capability FD is missing; direct CLI execution is forbidden"
        ) from exc
    try:
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != expected_bytes:
            raise RuntimeError("analysis launch capability is not the sealed memfd contract")
        link = os.readlink(f"/proc/self/fd/{capability_fd}")
        if "memfd:arc-v35-p30-analysis-capability" not in link or not link.endswith(
            " (deleted)"
        ):
            raise RuntimeError("analysis launch capability is not an anonymous memfd")
        get_seals = getattr(fcntl, "F_GET_SEALS", None)
        required_names = ("F_SEAL_SEAL", "F_SEAL_SHRINK", "F_SEAL_GROW", "F_SEAL_WRITE")
        required_values = [getattr(fcntl, name, None) for name in required_names]
        if get_seals is None or any(value is None for value in required_values):
            raise RuntimeError("analysis launch capability sealing cannot be verified")
        required_mask = 0
        for value in required_values:
            assert value is not None
            required_mask |= value
        if fcntl.fcntl(capability_fd, get_seals) & required_mask != required_mask:
            raise RuntimeError("analysis launch capability memfd is not fully sealed")
        duplicate_fds: list[int] = []
        for name in os.listdir("/proc/self/fd"):
            try:
                descriptor = int(name)
                candidate = os.fstat(descriptor)
            except (OSError, ValueError):
                continue
            if (
                candidate.st_dev == metadata.st_dev
                and candidate.st_ino == metadata.st_ino
            ):
                duplicate_fds.append(descriptor)
        if duplicate_fds != [capability_fd]:
            raise RuntimeError("analysis launch capability FD was duplicated")
        secret = os.pread(capability_fd, expected_bytes + 1, 0)
        if len(secret) != expected_bytes or hashlib.sha256(secret).hexdigest() != expected_sha256:
            raise RuntimeError("analysis launch capability hash mismatch")
    finally:
        os.close(capability_fd)


def validate_analysis_launch_boundary(
    protocol_path: Path,
    authorization_path: Path,
    *,
    evidence_wait_seconds: float = 10.0,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Prove this analyzer is the exact namespace child launched by its executor.

    This function reads only the protocol, signed authorization, consumed-token
    marker, and non-outcome launch evidence.  It must complete before the input
    manifest or any report is opened.
    """

    from v35_p30_authorized_execution import (
        ANALYSIS_CAPABILITY_BYTES,
        ANALYSIS_CAPABILITY_FD,
        ANALYSIS_LAUNCH_EVIDENCE_SCHEMA,
        ANALYSIS_LAUNCH_INTENT_SCHEMA,
        analysis_launch_paths,
        host_boot_id,
    )

    protocol = read_json_object(protocol_path, "P30 launch-boundary protocol")
    trust = protocol.get("executionTrust")
    validate_role_trust(trust, require_materialized=True)
    signed_authorization = read_json_object(
        authorization_path, "P30 launch-boundary authorization"
    )
    authorization = verify_signed_payload(
        signed_authorization,
        expected_role="analysis-authorizer",
        public_key_path=role_public_key_path(trust, "analysis-authorizer"),
    )
    token = authorization.get("tokenId")
    ledger = authorization.get("ledger")
    isolation = authorization.get("isolation")
    if (
        authorization.get("schemaVersion") != INPUT_AUTH_SCHEMA
        or authorization.get("kind") != "analysis"
        or not is_sha256(token)
        or authorization.get("protocol")
        != {"path": str(protocol_path.resolve()), "sha256": sha256(protocol_path)}
        or not isinstance(ledger, dict)
        or set(ledger) != {"root", "consumedPath", "receiptPath", "leasePath"}
        or not isinstance(isolation, dict)
        or isolation.get("network") != "none"
        or isolation.get("newPidNamespace") is not True
        or isolation.get("newUserNamespace") is not True
    ):
        raise ValueError("analysis launch-boundary authorization changed")
    ledger_root = Path(trust["ledgerRoot"]) / trust["campaignInstanceId"]
    consumed_path = ledger_root / f"{token}.consumed.json"
    if (
        Path(ledger["root"]) != ledger_root
        or Path(ledger["consumedPath"]) != consumed_path
        or Path(ledger["receiptPath"]) != ledger_root / f"{token}.receipt.json"
    ):
        raise ValueError("analysis launch-boundary ledger changed")
    consumed = read_json_object(consumed_path, "P30 launch-boundary consumed token")
    exact_keys(
        consumed,
        {
            "schemaVersion",
            "tokenId",
            "authorizationPath",
            "authorizationSha256",
            "consumedAtUtc",
            "consumerPid",
            "host",
            "bootId",
        },
        "P30 launch-boundary consumed token",
    )
    if (
        consumed.get("schemaVersion") != "arc-v35-p30-consumed-token-v1"
        or consumed.get("tokenId") != token
        or consumed.get("authorizationPath") != str(authorization_path.resolve())
        or consumed.get("authorizationSha256") != sha256(authorization_path)
        or type(consumed.get("consumerPid")) is not int
        or consumed["consumerPid"] <= 0
    ):
        raise ValueError("analysis launch-boundary consumed token changed")
    intent_path, evidence_path = analysis_launch_paths(ledger_root, token)
    intent = read_json_object(intent_path, "P30 analysis launch intent")
    exact_keys(
        intent,
        {
            "schemaVersion",
            "immutable",
            "promotionEligible",
            "kind",
            "tokenId",
            "campaignId",
            "authorization",
            "consumedMarker",
            "launchPermit",
            "capabilitySha256",
            "capabilityFd",
            "supervisor",
            "launchEvidencePath",
            "createdAtUtc",
        },
        "P30 analysis launch intent",
    )
    expected_authorization = {
        "path": str(authorization_path.resolve()),
        "sha256": sha256(authorization_path),
    }
    expected_consumed = {
        "path": str(consumed_path),
        "sha256": sha256(consumed_path),
    }
    launch_permit = intent.get("launchPermit")
    supervisor = intent.get("supervisor")
    if (
        intent.get("schemaVersion") != ANALYSIS_LAUNCH_INTENT_SCHEMA
        or intent.get("immutable") is not True
        or intent.get("promotionEligible") is not False
        or intent.get("kind") != "analysis"
        or intent.get("tokenId") != token
        or intent.get("campaignId") != authorization.get("campaignId")
        or intent.get("authorization") != expected_authorization
        or intent.get("consumedMarker") != expected_consumed
        or not isinstance(launch_permit, dict)
        or set(launch_permit) != {"path", "sha256"}
        or not Path(str(launch_permit.get("path"))).is_file()
        or sha256(Path(str(launch_permit.get("path"))))
        != launch_permit.get("sha256")
        or not is_sha256(intent.get("capabilitySha256"))
        or intent.get("capabilityFd") != ANALYSIS_CAPABILITY_FD
        or intent.get("launchEvidencePath") != str(evidence_path)
        or not isinstance(supervisor, dict)
        or set(supervisor)
        != {"pid", "uid", "gid", "bootId", "startTicks", "namespaces"}
        or supervisor.get("pid") != consumed["consumerPid"]
        or supervisor.get("bootId") != consumed["bootId"]
        or supervisor.get("bootId") != host_boot_id()
        or not isinstance(supervisor.get("namespaces"), dict)
        or set(supervisor["namespaces"]) != {"pid", "user", "network"}
    ):
        raise ValueError("analysis launch intent changed")
    _consume_analysis_capability(
        ANALYSIS_CAPABILITY_FD,
        expected_sha256=intent["capabilitySha256"],
        expected_bytes=ANALYSIS_CAPABILITY_BYTES,
    )
    deadline = time.monotonic() + evidence_wait_seconds
    while not evidence_path.is_file() and time.monotonic() < deadline:
        time.sleep(0.01)
    if not evidence_path.is_file():
        raise RuntimeError("analysis child launch evidence was not committed")
    evidence = read_json_object(evidence_path, "P30 analysis child launch evidence")
    exact_keys(
        evidence,
        {
            "schemaVersion",
            "immutable",
            "promotionEligible",
            "kind",
            "tokenId",
            "campaignId",
            "authorization",
            "consumedMarker",
            "launchPermit",
            "launchIntent",
            "capabilitySha256",
            "supervisor",
            "child",
            "committedAtUtc",
        },
        "P30 analysis child launch evidence",
    )
    child = evidence.get("child")
    if not isinstance(child, dict) or set(child) != {
        "launcherPid",
        "hostPid",
        "namespacePid",
        "namespacePidChain",
        "uid",
        "gid",
        "startTicks",
        "namespaces",
        "executableSha256",
    }:
        raise ValueError("analysis child process evidence changed")
    runtime_namespaces = _analysis_runtime_namespaces()
    namespace_chain = child.get("namespacePidChain")
    runtime_start_ticks = _analysis_runtime_start_ticks()
    consumed_at = utc_instant(consumed["consumedAtUtc"], "analysis token consumption")
    intent_created = utc_instant(intent["createdAtUtc"], "analysis launch intent")
    evidence_committed = utc_instant(
        evidence["committedAtUtc"], "analysis launch evidence"
    )
    if (
        evidence.get("schemaVersion") != ANALYSIS_LAUNCH_EVIDENCE_SCHEMA
        or evidence.get("immutable") is not True
        or evidence.get("promotionEligible") is not False
        or evidence.get("kind") != "analysis"
        or evidence.get("tokenId") != token
        or evidence.get("campaignId") != authorization.get("campaignId")
        or evidence.get("authorization") != expected_authorization
        or evidence.get("consumedMarker") != expected_consumed
        or evidence.get("launchPermit") != launch_permit
        or evidence.get("launchIntent")
        != {"path": str(intent_path), "sha256": sha256(intent_path)}
        or evidence.get("capabilitySha256") != intent["capabilitySha256"]
        or evidence.get("supervisor") != supervisor
        or not consumed_at <= intent_created <= evidence_committed
        or evidence_committed - consumed_at > dt.timedelta(minutes=5)
        or child.get("launcherPid") == child.get("hostPid")
        or type(child.get("launcherPid")) is not int
        or type(child.get("hostPid")) is not int
        or type(child.get("namespacePid")) is not int
        or not isinstance(namespace_chain, list)
        or not namespace_chain
        or namespace_chain[0] != child.get("hostPid")
        or namespace_chain[-1] != child.get("namespacePid")
        or os.getpid() != child.get("namespacePid")
        or child.get("uid") != os.getuid()
        or child.get("gid") != os.getgid()
        or child.get("startTicks") != runtime_start_ticks
        or child.get("namespaces") != runtime_namespaces
        or any(
            runtime_namespaces[name] == supervisor["namespaces"][name]
            for name in ("pid", "user", "network")
        )
        or child.get("executableSha256")
        != authorization.get("command", {}).get("executableSha256")
        or secure_sha256_file(Path("/proc/self/exe").resolve())
        != child.get("executableSha256")
    ):
        raise ValueError("analysis process/namespace launch evidence changed")
    return protocol, authorization


def load_inputs(
    protocol_path: Path, manifest_path: Path, authorization_path: Path
) -> tuple[dict[str, Any], dict[str, dict[int, dict[str, Any]]], dict[str, dict[str, Any]]]:
    protocol, _launch_authorization = validate_analysis_launch_boundary(
        protocol_path, authorization_path
    )
    validate_protocol(protocol, require_authorized=True)
    validate_initial_policy_artifacts(protocol, protocol_path=protocol_path)
    review_path = resolve_artifact(
        protocol["review"]["artifact"], anchor=REPO_ROOT, label="Fable review"
    )
    if not review_path.is_file() or sha256(review_path) != protocol["review"]["sha256"]:
        raise ValueError("Fable review artifact is missing or hash-invalid")
    review_lines = [line.strip() for line in review_path.read_text().splitlines() if line.strip()]
    if not review_lines or review_lines[-1] != "VERDICT: ACCEPT":
        raise ValueError("Fable review artifact does not end in an ACCEPT verdict")
    validate_fable_receipt(protocol, protocol_path=protocol_path, review_path=review_path)
    power_contract = protocol["powerCalibration"]
    power_path = resolve_artifact(
        power_contract["path"], anchor=REPO_ROOT, label="power calibration"
    )
    if not power_path.is_file() or sha256(power_path) != power_contract["sha256"]:
        raise ValueError("P30 power calibration is missing or hash-invalid")
    recomputed_power_bytes = (
        json.dumps(
            build_power_calibration(REPO_ROOT),
            indent=2,
            ensure_ascii=False,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")
    if recomputed_power_bytes != power_path.read_bytes():
        raise ValueError("P30 power calibration does not reproduce byte-for-byte")
    power = json.loads(power_path.read_text())
    if (
        not isinstance(power, dict)
        or power.get("schemaVersion") != POWER_SCHEMA
        or power.get("valid") is not True
        or power.get("promotionEligible") is not False
        or power.get("test", {}).get("method") != "exact-paired-replicate-sign-flip"
        or power.get("test", {}).get("replicates") != len(REPLICATES)
        or power.get("test", {}).get("enumerations") != 2 ** len(REPLICATES)
        or power.get("scope", {}).get("claim") != power_contract["claim"]
        or power.get("scope", {}).get("fullSelectorPowerClaimed") is not False
        or power.get("scope", {}).get("safetyGatePowerClaimed") is not False
        or power.get("simulation", {}).get("adequateForPrimaryEfficacy") is not True
        or power.get("simulation", {}).get("endpointMonteCarloBound")
        != {
            "method": "one-sided-Wilson-with-Bonferroni-simultaneous-endpoint-coverage",
            "familywiseAlpha": 0.05,
            "endpointAlpha": 0.05 / len(PRIMARY),
            "z": 2.128045234184984,
        }
        or set(
            power.get("simulation", {}).get(
                "powerSimultaneousFamilywise95MonteCarloLowerByPrimaryEndpoint", {}
            )
        )
        != set(PRIMARY)
        or finite(
            power.get("simulation", {}).get(
                "bonferroniJointPrimaryEligibilityPowerSimultaneousMonteCarloLower95"
            ),
            "joint primary eligibility power lower bound",
        )
        < power_contract["minimumJointPrimaryEligibilityPower"]
        or power.get("test", {}).get("primaryEligibilityGates")
        != {
            "minimumTrueWinPointGain": protocol["analysis"]["minimumTrueWinPointGain"],
            "minimumPositiveReplicates": protocol["analysis"]["minimumPositiveReplicates"],
            "replicateFloor": protocol["analysis"]["minimumReplicateTrueWinGain"],
            "maximumReplicatesBelowFloor": protocol["analysis"]["maximumReplicatesBelowFloor"],
        }
    ):
        raise ValueError("P30 power calibration is not adequate for the frozen design")
    source_contract = protocol["sourceContract"]
    source_lock_path = resolve_artifact(
        source_contract["artifact"], anchor=REPO_ROOT, label="source contract"
    )
    if not source_lock_path.is_file() or sha256(source_lock_path) != source_contract["sha256"]:
        raise ValueError("P30 source contract is missing or hash-invalid")
    source_lock = json.loads(source_lock_path.read_text())
    if (
        not isinstance(source_lock, dict)
        or set(source_lock)
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
        or source_lock.get("schemaVersion") != SOURCE_LOCK_SCHEMA
        or source_lock.get("authorized") is not True
        or source_lock.get("immutable") is not True
        or source_lock.get("promotionEligible") is not False
        or not is_git_commit(source_lock.get("implementationCommit"))
    ):
        raise ValueError("P30 source contract is not an immutable development-only lock")
    source_files = source_lock.get("files")
    if (
        source_lock.get("implementationBaseCommit") != protocol["implementationBaseCommit"]
        or not isinstance(source_files, dict)
        or set(source_files) != set(SOURCE_FILE_PATHS)
    ):
        raise ValueError("P30 source-contract file registry changed")
    for label, expected_relative in SOURCE_FILE_PATHS.items():
        entry = source_files[label]
        if (
            not isinstance(entry, dict)
            or set(entry) != {"path", "sha256", "gitBlobOid"}
            or entry.get("path") != expected_relative
            or not is_sha256(entry.get("sha256"))
            or not is_git_commit(entry.get("gitBlobOid"))
        ):
            raise ValueError(f"P30 source contract has malformed {label} binding")
        bound_path = REPO_ROOT / expected_relative
        if not bound_path.is_file() or sha256(bound_path) != entry["sha256"]:
            raise ValueError(f"P30 source contract has hash-invalid {label}")
    verify_git_context(source_lock)

    trust = protocol["executionTrust"]
    public_key_path = role_public_key_path(trust, "analysis-authorizer")
    signed_authorization = read_json_object(authorization_path, "P30 analysis authorization")
    authorization = verify_signed_payload(
        signed_authorization,
        expected_role="analysis-authorizer",
        public_key_path=public_key_path,
    )
    from v35_p30_authorized_execution import validate_authorization

    executor_validated_authorization = validate_authorization(
        signed_authorization,
        issuer_public_key_path=role_public_key_path(trust, "issuer"),
        analysis_authorizer_public_key_path=public_key_path,
        authorization_path=authorization_path,
    )
    if canonical_json(executor_validated_authorization) != canonical_json(authorization):
        raise ValueError("analysis authorization differs across executor and analyzer validation")
    exact_keys(
        authorization,
        {
            "schemaVersion",
            "authorized",
            "immutable",
            "promotionEligible",
            "kind",
            "tokenId",
            "campaignId",
            "issuedAtUtc",
            "notBeforeUtc",
            "expiresAtUtc",
            "protocol",
            "sourceContract",
            "subject",
            "command",
            "isolation",
            "outputs",
            "ledger",
            "predecessor",
            "request",
        },
        "P30 analysis authorization",
    )
    manifest_value = verify_signed_payload(
        read_json_object(manifest_path, "P30 signed input manifest"),
        expected_role="guardian",
        public_key_path=role_public_key_path(trust, "guardian"),
    )
    ledger_root = Path(trust["ledgerRoot"]) / trust["campaignInstanceId"]
    draft_path = ledger_root / "analysis/analysis-authorization.unsigned.json"
    review_receipt_path = (
        ledger_root / "analysis/review/fable-analysis-authorization.receipt.json"
    )
    review_attempt_path = (
        ledger_root / "analysis/review/fable-analysis-authorization.attempt.json"
    )
    review_stdout_path = (
        ledger_root / "analysis/review/fable-analysis-authorization.stdout"
    )
    review_stderr_path = (
        ledger_root / "analysis/review/fable-analysis-authorization.stderr"
    )
    expected_subject = {
        "inputManifestPath": str(manifest_path.resolve()),
        "inputManifestSha256": sha256(manifest_path),
        "receiptMerkleRoot": manifest_value.get("receiptMerkleRoot"),
        "sourceCommit": source_lock["implementationCommit"],
        "sourceContractSha256": source_contract["sha256"],
        "outcomesInspected": False,
        "privateEvaluationAuthorized": False,
        "counts": manifest_value.get("counts"),
        "authorizationDraftPath": str(draft_path),
        "reviewReceiptPath": str(review_receipt_path),
    }
    outputs = authorization.get("outputs")
    if not isinstance(outputs, dict) or set(outputs) != {"analysis", "exitCode", "stderr", "stdout"}:
        raise ValueError("P30 analysis authorization output registry changed")
    analysis_out = resolve_artifact(
        outputs["analysis"].get("path") if isinstance(outputs["analysis"], dict) else None,
        anchor=authorization_path.parent,
        label="P30 analysis output",
    )
    executable = (REPO_ROOT / "ml/.venv/bin/python").resolve()
    expected_argv = [
        str(executable),
        "ml/analyze_v35_p30_long_horizon.py",
        "--protocol",
        str(protocol_path.resolve()),
        "--manifest",
        str(manifest_path.resolve()),
        "--authorization",
        str(authorization_path.resolve()),
        "--out",
        str(analysis_out),
        "--quiet",
    ]
    expected_command = {
            "argv": expected_argv,
            "cwd": str(REPO_ROOT),
            "env": {
                "HOME": "/tmp",
                "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "PYTHONHASHSEED": "0",
                "PYTHONPATH": "ml",
            },
            "executableSha256": secure_sha256_file(executable),
        }
    from issue_v35_p30_analysis_bundle import build_analysis_authorization_payload

    authorization_issue_time = utc_instant(
        authorization["issuedAtUtc"], "analysis authorization issue time"
    )
    reproduced_authorization = build_analysis_authorization_payload(
        protocol_path=protocol_path,
        manifest_path=manifest_path,
        request_binding=authorization["request"],
        authorization_draft_path=draft_path,
        review_receipt_path=review_receipt_path,
        analysis_out=analysis_out,
        token_id=authorization["tokenId"],
        now=authorization_issue_time,
    )
    if canonical_json(reproduced_authorization) != canonical_json(authorization):
        raise ValueError("P30 analysis authorization does not reproduce exactly")
    authorization_checks = {
        "schema": authorization.get("schemaVersion") == INPUT_AUTH_SCHEMA,
        "authorized": authorization.get("authorized") is True,
        "immutable": authorization.get("immutable") is True,
        "promotion": authorization.get("promotionEligible") is False,
        "kind": authorization.get("kind") == "analysis",
        "campaign": authorization.get("campaignId") == protocol["experiment"],
        "protocol": authorization.get("protocol")
        == {"path": str(protocol_path.resolve()), "sha256": sha256(protocol_path)},
        "source": authorization.get("sourceContract")
        == {"path": str(source_lock_path.resolve()), "sha256": source_contract["sha256"]},
        "subject": authorization.get("subject") == expected_subject,
        "predecessor": authorization.get("predecessor")
        == {"receiptPath": str(manifest_path.resolve()), "sha256": sha256(manifest_path)},
        "command": authorization.get("command") == expected_command,
    }
    failed_authorization_checks = sorted(
        label for label, passed in authorization_checks.items() if not passed
    )
    if failed_authorization_checks:
        raise ValueError(
            "P30 signed analysis authorization is invalid or hash-unbound: "
            + ",".join(failed_authorization_checks)
        )
    validate_role_request_binding(
        authorization["request"],
        protocol=protocol,
        protocol_path=protocol_path,
        role="analysis-authorizer",
        verb="issue-analysis",
        predecessor_path=manifest_path,
        expected_output_path=authorization_path,
        expected_subject_fields={
            "manifest": {
                "path": str(manifest_path.resolve()),
                "sha256": sha256(manifest_path),
            },
            "authorizationDraftPath": str(draft_path),
            "reviewReceiptPath": str(review_receipt_path),
            "analysisOut": str(analysis_out),
        },
        label="P30 analysis authorization",
    )
    draft = read_json_object(draft_path, "reviewed P30 analysis authorization draft")
    from v35_p30_analysis_review import validate_analysis_review_receipt

    analysis_review = validate_analysis_review_receipt(
        review_receipt_path,
        draft_path=draft_path,
        manifest_path=manifest_path,
        review_attester_public_key_path=role_public_key_path(trust, "review-attester"),
    )
    from issue_v35_p30_analysis_bundle import (
        validate_reviewed_analysis_authorization_rebinding,
    )

    validate_reviewed_analysis_authorization_rebinding(
        draft,
        authorization,
        review_finished_at_utc=analysis_review["finishedAtUtc"],
    )
    validate_role_request_binding(
        analysis_review["request"],
        protocol=protocol,
        protocol_path=protocol_path,
        role="review-attester",
        verb="attest-analysis-review",
        predecessor_path=draft_path,
        expected_output_path=review_receipt_path,
        expected_subject_fields={
            "authorizationDraft": {
                "path": str(draft_path),
                "sha256": sha256(draft_path),
            },
            "manifest": {
                "path": str(manifest_path),
                "sha256": sha256(manifest_path),
            },
            "reviewAttemptPath": str(review_attempt_path),
            "reviewStdoutPath": str(review_stdout_path),
            "reviewStderrPath": str(review_stderr_path),
            "reviewAttesterPublicKey": {
                "path": str(role_public_key_path(trust, "review-attester")),
                "sha256": sha256(role_public_key_path(trust, "review-attester")),
            },
            "claudeExecutable": trust["reviewRuntime"]["claudeExecutable"],
        },
        label="P30 analysis Fable review",
    )
    analysis_review_started = utc_instant(
        analysis_review["startedAtUtc"], "analysis Fable review start"
    )
    if analysis_review_started <= max(
        utc_instant(manifest_value["issuedAtUtc"], "analysis manifest issue time"),
        utc_instant(draft["issuedAtUtc"], "analysis authorization draft issue time"),
    ):
        raise ValueError("analysis Fable review did not start after manifest and draft creation")
    protocol_review_receipt_path = resolve_artifact(
        protocol["review"]["commandReceipt"]["path"],
        anchor=REPO_ROOT,
        label="protocol Fable receipt",
    )
    analysis_review_paths = {
        review_receipt_path.resolve(),
        resolve_artifact(
            analysis_review["stdoutPath"],
            anchor=review_receipt_path.parent,
            label="analysis Fable stdout",
        ),
        resolve_artifact(
            analysis_review["stderrPath"],
            anchor=review_receipt_path.parent,
            label="analysis Fable stderr",
        ),
    }
    if analysis_review_paths & {review_path.resolve(), protocol_review_receipt_path.resolve()}:
        raise ValueError("analysis Fable review is not distinct from the protocol review")
    ledger = authorization.get("ledger")
    if not isinstance(ledger, dict) or set(ledger) != {
        "root",
        "consumedPath",
        "receiptPath",
        "leasePath",
    }:
        raise ValueError("P30 analysis token ledger binding changed")
    consumed_path = resolve_artifact(
        ledger["consumedPath"], anchor=authorization_path.parent, label="analysis consumed token"
    )
    if not consumed_path.is_file():
        raise ValueError("P30 analysis token was not consumed before analyzer startup")
    consumed = read_json_object(consumed_path, "P30 analysis consumed token")
    exact_keys(
        consumed,
        {
            "schemaVersion",
            "tokenId",
            "authorizationPath",
            "authorizationSha256",
            "consumedAtUtc",
            "consumerPid",
            "host",
            "bootId",
        },
        "P30 analysis consumed token",
    )
    if (
        consumed.get("schemaVersion") != "arc-v35-p30-consumed-token-v1"
        or consumed.get("tokenId") != authorization["tokenId"]
        or consumed.get("authorizationPath") != str(authorization_path.resolve())
        or consumed.get("authorizationSha256") != sha256(authorization_path)
    ):
        raise ValueError("P30 analysis consumed token differs from its authorization")
    if Path(__file__).resolve() != (REPO_ROOT / source_files["analyzer"]["path"]).resolve():
        raise ValueError("executing analyzer differs from the source-locked analyzer")

    manifest = manifest_value
    exact_keys(
        manifest,
        {
            "schemaVersion",
            "valid",
            "immutable",
            "promotionEligible",
            "outcomesInspected",
            "metricsIncluded",
            "issuedAtUtc",
            "campaignInstanceId",
            "protocol",
            "sourceContract",
            "finalGenerationBarrier",
            "receiptMerkleRoot",
            "counts",
            "signedReceiptInventory",
            "reports",
            "request",
        },
        "P30 input manifest",
    )
    if (
        manifest.get("schemaVersion") != INPUT_SCHEMA
        or manifest.get("valid") is not True
        or manifest.get("immutable") is not True
        or manifest.get("promotionEligible") is not False
        or manifest.get("outcomesInspected") is not False
        or manifest.get("metricsIncluded") is not False
        or manifest.get("campaignInstanceId") != trust["campaignInstanceId"]
        or manifest.get("protocol")
        != {"path": str(protocol_path.resolve()), "sha256": sha256(protocol_path)}
    ):
        raise ValueError("development input manifest is not valid and protocol-bound")
    source_commit = source_lock["implementationCommit"]
    if manifest.get("sourceContract") != {
        "path": str(source_lock_path.resolve()),
        "sha256": source_contract["sha256"],
    }:
        raise ValueError("development input source contract is invalid")
    if (
        not is_sha256(manifest.get("receiptMerkleRoot"))
        or manifest.get("counts")
        != {
            "endpoints": 54,
            "generationReceipts": 54 * protocol["seedSchedule"]["maxGeneration"],
            "evaluationReceipts": 108,
            "pairIntegrityReceipts": 54,
            "signedReceipts": 595,
            "uniqueExecutionTokens": 540,
        }
    ):
        raise ValueError("development input receipt inventory changed")
    ledger_root = Path(trust["ledgerRoot"]) / trust["campaignInstanceId"]
    last_pair_path = (
        ledger_root / "pairs" / f"{endpoint_label(REPLICATES[-1], ARMS[-1])}.json"
    )
    validate_role_request_binding(
        manifest["request"],
        protocol=protocol,
        protocol_path=protocol_path,
        role="guardian",
        verb="attest-analysis-manifest",
        predecessor_path=last_pair_path,
        expected_output_path=manifest_path,
        expected_subject_fields={
            "logicalId": "final-analysis-manifest",
            "finalGenerationBarrier": manifest["finalGenerationBarrier"],
        },
        label="P30 analysis manifest",
    )
    validate_signed_receipt_inventory(
        manifest,
        protocol=protocol,
        protocol_path=protocol_path,
        manifest_path=manifest_path,
    )
    catalog_path = resolve_artifact(
        protocol["catalog"]["path"], anchor=REPO_ROOT, label="catalog"
    )
    if not catalog_path.is_file() or sha256(catalog_path) != protocol["catalog"]["sha256"]:
        raise ValueError("P30 catalog is missing or hash-invalid")
    catalog = json.loads(catalog_path.read_text())
    guardians = catalog.get("guardians") if isinstance(catalog, dict) else None
    if not isinstance(guardians, list):
        raise ValueError("P30 catalog guardian registry is malformed")
    guardian_names = tuple(
        guardian.get("name") if isinstance(guardian, dict) else None for guardian in guardians
    )
    if (
        len(guardian_names) != protocol["analysis"]["expectedGuardianCount"]
        or len(set(guardian_names)) != len(guardian_names)
        or not all(isinstance(name, str) and name for name in guardian_names)
    ):
        raise ValueError("P30 catalog guardian registry changed")
    entries = manifest.get("reports")
    if not isinstance(entries, list):
        raise ValueError("development input reports must be a list")
    by_label: dict[str, dict[str, Any]] = {}
    indexed: dict[str, dict[int, dict[str, Any]]] = {}
    endpoint_artifact_paths: set[Path] = set()
    endpoint_identity_hashes: set[str] = set()
    expected_labels = {
        endpoint_label(replicate, arm) for replicate in REPLICATES for arm in ARMS
    }
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("label"), str):
            raise ValueError("development input has a malformed report entry")
        label = entry["label"]
        if label in by_label:
            raise ValueError(f"duplicate report label {label}")
        replicate = entry.get("replicate")
        arm = entry.get("arm")
        if replicate not in REPLICATES or arm not in ARMS or label != endpoint_label(replicate, arm):
            raise ValueError(f"{label}: report label is not bound to its replicate and arm")
        path = resolve_artifact(entry.get("path"), anchor=manifest_path.parent, label=f"{label} report")
        expected_hash = entry.get("sha256")
        weights_hash = entry.get("weightsSha256")
        if not path.is_file() or not is_sha256(expected_hash) or sha256(path) != expected_hash:
            raise ValueError(f"{label}: report artifact is missing or hash-invalid")
        if not is_sha256(weights_hash):
            raise ValueError(f"{label}: checkpoint hash is invalid")
        artifacts: dict[str, Path] = {}
        for path_field, hash_field in (
            ("generationAuditPath", "generationAuditSha256"),
            ("generationExecutionReceiptPath", "generationExecutionReceiptSha256"),
            ("checkpointPath", "weightsSha256"),
            ("checkpointManifestPath", "checkpointManifestSha256"),
            ("configPath", "configSha256"),
            ("bindingPath", "bindingSha256"),
            ("exitCodePath", "exitCodeSha256"),
            ("evaluatorStdoutPath", "evaluatorStdoutSha256"),
            ("evaluatorStderrPath", "evaluatorStderrSha256"),
            ("serverLogPath", "serverLogSha256"),
            ("primaryReceiptPath", "primaryReceiptSha256"),
            ("primaryExecutionReceiptPath", "primaryExecutionReceiptSha256"),
            ("replayReportPath", "replayReportSha256"),
            ("replayExitCodePath", "replayExitCodeSha256"),
            ("replayEvaluatorStdoutPath", "replayEvaluatorStdoutSha256"),
            ("replayEvaluatorStderrPath", "replayEvaluatorStderrSha256"),
            ("replayServerLogPath", "replayServerLogSha256"),
            ("replayReceiptPath", "replayReceiptSha256"),
            ("replayExecutionReceiptPath", "replayExecutionReceiptSha256"),
            ("pairIntegrityPath", "pairIntegritySha256"),
        ):
            artifact_path = resolve_artifact(
                entry.get(path_field), anchor=manifest_path.parent, label=f"{label} {path_field}"
            )
            expected_artifact_hash = entry.get(hash_field)
            if (
                not artifact_path.is_file()
                or not is_sha256(expected_artifact_hash)
                or sha256(artifact_path) != expected_artifact_hash
            ):
                raise ValueError(f"{label}: {hash_field} artifact is missing or hash-invalid")
            artifacts[path_field] = artifact_path
        current_paths = {path.resolve()} | {
            artifact_path.resolve() for artifact_path in artifacts.values()
        }
        if endpoint_artifact_paths & current_paths:
            raise ValueError(f"{label}: artifact path is reused by another endpoint")
        endpoint_artifact_paths.update(current_paths)
        identity_hashes = {
            expected_hash,
            weights_hash,
            entry["generationAuditSha256"],
            entry["generationExecutionReceiptSha256"],
            entry["configSha256"],
            entry["bindingSha256"],
            entry["primaryReceiptSha256"],
            entry["primaryExecutionReceiptSha256"],
            entry["replayReportSha256"],
            entry["replayReceiptSha256"],
            entry["replayExecutionReceiptSha256"],
            entry["pairIntegritySha256"],
        }
        if len(identity_hashes) != 12 or endpoint_identity_hashes & identity_hashes:
            raise ValueError(f"{label}: identity-bearing artifact hash is reused")
        endpoint_identity_hashes.update(identity_hashes)
        endpoint_root = artifacts["configPath"].parent.resolve()
        if (
            artifacts["bindingPath"].parent.resolve() != endpoint_root
            or artifacts["checkpointPath"].parent.resolve() != endpoint_root / "checkpoints"
            or artifacts["checkpointManifestPath"].parent.resolve()
            != endpoint_root / "checkpoints"
            or artifacts["generationAuditPath"].parent.resolve() != endpoint_root / "artifacts"
        ):
            raise ValueError(f"{label}: training artifacts are outside the bound endpoint root")
        root_identity = str(endpoint_root)
        if artifacts["exitCodePath"].read_text() != "0\n":
            raise ValueError(f"{label}: evaluator exit code is not exactly zero")
        if artifacts["evaluatorStderrPath"].stat().st_size != 0:
            raise ValueError(f"{label}: evaluator stderr is non-empty")
        if artifacts["evaluatorStdoutPath"].stat().st_size != 0:
            raise ValueError(f"{label}: evaluator stdout leaked outcome-bearing data")
        if artifacts["replayExitCodePath"].read_text() != "0\n":
            raise ValueError(f"{label}: replay evaluator exit code is not exactly zero")
        if artifacts["replayEvaluatorStderrPath"].stat().st_size != 0:
            raise ValueError(f"{label}: replay evaluator stderr is non-empty")
        if artifacts["replayEvaluatorStdoutPath"].stat().st_size != 0:
            raise ValueError(f"{label}: replay evaluator stdout leaked outcome-bearing data")
        primary_run_paths = {
            artifacts[field].resolve()
            for field in (
                "exitCodePath",
                "evaluatorStdoutPath",
                "evaluatorStderrPath",
                "serverLogPath",
                "primaryReceiptPath",
            )
        }
        replay_run_paths = {
            artifacts[field].resolve()
            for field in (
                "replayReportPath",
                "replayExitCodePath",
                "replayEvaluatorStdoutPath",
                "replayEvaluatorStderrPath",
                "replayServerLogPath",
                "replayReceiptPath",
            )
        }
        primary_run_paths.add(path.resolve())
        if len(primary_run_paths) != 6 or len(replay_run_paths) != 6 or primary_run_paths & replay_run_paths:
            raise ValueError(f"{label}: primary and replay runs do not have distinct artifact paths")
        validate_root_materialization(
            config_path=artifacts["configPath"],
            binding_path=artifacts["bindingPath"],
            protocol=protocol,
            protocol_path=protocol_path,
            replicate=replicate,
            arm=arm,
        )
        checkpoint_manifest = read_json_object(
            artifacts["checkpointManifestPath"], f"{label} checkpoint manifest"
        )
        validate_policy_manifest(
            checkpoint_manifest, label=f"{label} checkpoint manifest", protocol=protocol
        )
        primary_receipt = validate_evaluation_receipt(
            receipt_path=artifacts["primaryReceiptPath"],
            expected_hash=entry.get("primaryReceiptSha256"),
            role="primary",
            label=label,
            replicate=replicate,
            arm=arm,
            protocol=protocol,
            source_commit=source_commit,
            checkpoint_path=artifacts["checkpointPath"],
            weights_hash=weights_hash,
            report_path=path,
            stdout_path=artifacts["evaluatorStdoutPath"],
            stderr_path=artifacts["evaluatorStderrPath"],
            exit_code_path=artifacts["exitCodePath"],
            server_log_path=artifacts["serverLogPath"],
            config_sha256=entry["configSha256"],
            binding_sha256=entry["bindingSha256"],
            root_identity=root_identity,
        )
        replay_receipt = validate_evaluation_receipt(
            receipt_path=artifacts["replayReceiptPath"],
            expected_hash=entry.get("replayReceiptSha256"),
            role="replay",
            label=label,
            replicate=replicate,
            arm=arm,
            protocol=protocol,
            source_commit=source_commit,
            checkpoint_path=artifacts["checkpointPath"],
            weights_hash=weights_hash,
            report_path=artifacts["replayReportPath"],
            stdout_path=artifacts["replayEvaluatorStdoutPath"],
            stderr_path=artifacts["replayEvaluatorStderrPath"],
            exit_code_path=artifacts["replayExitCodePath"],
            server_log_path=artifacts["replayServerLogPath"],
            config_sha256=entry["configSha256"],
            binding_sha256=entry["bindingSha256"],
            root_identity=root_identity,
        )
        primary_execution_receipt = validate_authorized_evaluation_execution(
            receipt_path=artifacts["primaryExecutionReceiptPath"],
            expected_hash=entry.get("primaryExecutionReceiptSha256"),
            legacy_receipt_path=artifacts["primaryReceiptPath"],
            role="primary",
            label=label,
            replicate=replicate,
            arm=arm,
            protocol=protocol,
            protocol_path=protocol_path,
            source_commit=source_commit,
            source_contract_sha256=source_contract["sha256"],
            checkpoint_path=artifacts["checkpointPath"],
            weights_hash=weights_hash,
            generation_audit_path=artifacts["generationAuditPath"],
            config_sha256=entry["configSha256"],
            binding_sha256=entry["bindingSha256"],
            root_identity=root_identity,
        )
        replay_execution_receipt = validate_authorized_evaluation_execution(
            receipt_path=artifacts["replayExecutionReceiptPath"],
            expected_hash=entry.get("replayExecutionReceiptSha256"),
            legacy_receipt_path=artifacts["replayReceiptPath"],
            role="replay",
            label=label,
            replicate=replicate,
            arm=arm,
            protocol=protocol,
            protocol_path=protocol_path,
            source_commit=source_commit,
            source_contract_sha256=source_contract["sha256"],
            checkpoint_path=artifacts["checkpointPath"],
            weights_hash=weights_hash,
            generation_audit_path=artifacts["generationAuditPath"],
            config_sha256=entry["configSha256"],
            binding_sha256=entry["bindingSha256"],
            root_identity=root_identity,
        )
        validate_pair_integrity_receipt(
            receipt_path=artifacts["pairIntegrityPath"],
            expected_hash=entry.get("pairIntegritySha256"),
            primary_execution_receipt_path=artifacts["primaryExecutionReceiptPath"],
            replay_execution_receipt_path=artifacts["replayExecutionReceiptPath"],
            primary_report_path=path,
            replay_report_path=artifacts["replayReportPath"],
            protocol=protocol,
            protocol_path=protocol_path,
            root_identity=root_identity,
            replicate=replicate,
            arm=arm,
            weights_hash=weights_hash,
        )
        if (
            primary_receipt["attemptId"] == replay_receipt["attemptId"]
            or primary_receipt["execution"]["inferenceSocket"]
            == replay_receipt["execution"]["inferenceSocket"]
        ):
            raise ValueError(f"{label}: replay execution is not a distinct attempt")
        if replay_execution_receipt.get("predecessor") != {
            "receiptPath": str(artifacts["primaryExecutionReceiptPath"].resolve()),
            "sha256": entry["primaryExecutionReceiptSha256"],
        }:
            raise ValueError(f"{label}: replay does not consume the primary signed receipt")
        audit_path = artifacts["generationAuditPath"]
        audit = json.loads(audit_path.read_text())
        if (
            not isinstance(audit, dict)
            or audit.get("valid") is not True
            or audit.get("schemaVersion") != "arc-v35-generation-audit-v1"
            or audit.get("generation") != protocol["seedSchedule"]["maxGeneration"]
            or audit.get("replicate") != replicate
            or audit.get("arm") != arm
            or audit.get("checkpointSha256") != weights_hash
            or audit.get("manifestSha256") != entry.get("checkpointManifestSha256")
            or audit.get("protocolSha256") != sha256(protocol_path)
            or audit.get("configSha256") != entry.get("configSha256")
            or audit.get("bindingSha256") != entry.get("bindingSha256")
            or audit.get("catalogSha256") != protocol["catalog"]["sha256"]
            or audit.get("root") != root_identity
            or audit.get("sourceCommit") != source_commit
            or audit.get("sourceContractSha256") != source_contract["sha256"]
            or not is_sha256(audit.get("environmentSha256"))
            or not isinstance(audit.get("authorizationTokenId"), str)
            or len(audit["authorizationTokenId"]) != 64
            or any(
                character not in "0123456789abcdef"
                for character in audit["authorizationTokenId"]
            )
            or audit.get("promotionEligible") is not False
        ):
            raise ValueError(f"{label}: generation audit does not bind the endpoint checkpoint")
        replicate_contract = next(row for row in protocol["replicates"] if row["id"] == replicate)
        generation_offset = protocol["seedSchedule"]["maxGeneration"] - 1
        expected_training_min = (
            replicate_contract["trainBase"]
            + generation_offset * protocol["seedSchedule"]["trainStride"]
        )
        expected_evaluation_min = (
            replicate_contract["evalBase"]
            + generation_offset * protocol["seedSchedule"]["evalStride"]
        )
        if (
            audit.get("games") != protocol["seedSchedule"]["gamesPerGeneration"]
            or audit.get("stalls") != 0
            or audit.get("evaluationStalls") != 0
            or audit.get("malformedEpisodes") != 0
            or audit.get("malformedRows") != 0
            or audit.get("trainingSeeds")
            != {
                "min": expected_training_min,
                "max": expected_training_min + protocol["seedSchedule"]["gamesPerGeneration"] - 1,
                "count": protocol["seedSchedule"]["gamesPerGeneration"],
            }
            or audit.get("evaluationSeeds")
            != {
                "min": expected_evaluation_min,
                "max": expected_evaluation_min + protocol["seedSchedule"]["evalGamesPerGeneration"] - 1,
                "count": protocol["seedSchedule"]["evalGamesPerGeneration"],
            }
            or type(audit.get("rows")) is not int
            or audit["rows"] <= 0
            or type(audit.get("policyRows")) is not int
            or audit["policyRows"] <= 0
        ):
            raise ValueError(f"{label}: generation audit seed or row coverage changed")
        validate_generation_audit_chain(
            audit,
            endpoint_root=endpoint_root,
            protocol=protocol,
            protocol_sha256=sha256(protocol_path),
            source_commit=source_commit,
            source_contract_sha256=source_contract["sha256"],
            label=label,
        )
        validate_generation_audit_trust(audit, protocol=protocol, arm=arm, label=label)
        validate_generation_execution_receipt_chain(
            final_receipt_path=artifacts["generationExecutionReceiptPath"],
            final_receipt_sha256=entry.get("generationExecutionReceiptSha256"),
            endpoint_root=endpoint_root,
            protocol=protocol,
            protocol_path=protocol_path,
            source_commit=source_commit,
            source_contract_sha256=source_contract["sha256"],
            replicate=replicate,
            arm=arm,
            config_sha256=entry["configSha256"],
            binding_sha256=entry["bindingSha256"],
            final_checkpoint_sha256=weights_hash,
            label=label,
        )
        commitment = audit.get("rawGenerationCommitment")
        if (
            not isinstance(commitment, dict)
            or not is_sha256(commitment.get("sha256"))
            or type(commitment.get("files")) is not int
            or commitment["files"] <= 0
            or type(commitment.get("bytes")) is not int
            or commitment["bytes"] <= 0
        ):
            raise ValueError(f"{label}: generation audit lacks a raw-generation commitment")
        report = json.loads(path.read_text())
        if not isinstance(report, dict):
            raise ValueError(f"{label}: report must be an object")
        primary_indexed = validate_report(
            report,
            label=label,
            protocol=protocol,
            source_commit=source_commit,
            weights_sha256=weights_hash,
            guardian_names=guardian_names,
            replicate=replicate,
            arm=arm,
            config_sha256=entry["configSha256"],
            binding_sha256=entry["bindingSha256"],
            root_identity=root_identity,
        )
        report_weights_path = resolve_artifact(
            report["inference"]["weightsPath"], anchor=path.parent, label=f"{label} weights"
        )
        if (
            report_weights_path.resolve() != artifacts["checkpointPath"].resolve()
            or report["decode"]["inferenceSocket"]
            != primary_receipt["execution"]["inferenceSocket"]
        ):
            raise ValueError(f"{label}: primary report differs from its execution receipt")
        replay_report = json.loads(artifacts["replayReportPath"].read_text())
        if not isinstance(replay_report, dict):
            raise ValueError(f"{label}: replay report must be an object")
        replay_indexed = validate_report(
            replay_report,
            label=f"{label} replay",
            protocol=protocol,
            source_commit=source_commit,
            weights_sha256=weights_hash,
            guardian_names=guardian_names,
            replicate=replicate,
            arm=arm,
            config_sha256=entry["configSha256"],
            binding_sha256=entry["bindingSha256"],
            root_identity=root_identity,
        )
        replay_weights_path = resolve_artifact(
            replay_report["inference"]["weightsPath"],
            anchor=artifacts["replayReportPath"].parent,
            label=f"{label} replay weights",
        )
        if (
            replay_weights_path.resolve() != artifacts["checkpointPath"].resolve()
            or replay_report["decode"]["inferenceSocket"]
            != replay_receipt["execution"]["inferenceSocket"]
        ):
            raise ValueError(f"{label}: replay report differs from its execution receipt")
        if (
            replay_indexed != primary_indexed
            or replay_report.get("replayHashes") != report.get("replayHashes")
        ):
            raise ValueError(f"{label}: deterministic replay differs from the primary evaluation")
        indexed[label] = primary_indexed
        by_label[label] = {
            **report,
            "_verifiedMalformedEpisodes": (
                primary_receipt["malformedEpisodes"] + replay_receipt["malformedEpisodes"]
            ),
        }
    if set(by_label) != expected_labels:
        raise ValueError("development input does not contain the exact fifty-four reports")
    reference = indexed[endpoint_label("a", CONTROL)]
    for seed in reference:
        guardian = reference[seed]["guardian"]
        if any(rows[seed]["guardian"] != guardian for rows in indexed.values()):
            raise ValueError(f"seed {seed}: guardian assignment differs across reports")
    guardian_counts: dict[str, int] = {}
    for row in reference.values():
        guardian_counts[row["guardian"]] = guardian_counts.get(row["guardian"], 0) + 1
    if (
        len(guardian_counts) != int(protocol["analysis"]["expectedGuardianCount"])
        or max(guardian_counts.values()) - min(guardian_counts.values()) > 1
    ):
        raise ValueError("common development guardian schedule is not exactly balanced")
    return protocol, indexed, by_label


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--authorization", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()
    protocol, indexed, reports = load_inputs(args.protocol, args.manifest, args.authorization)
    public_key_path = role_public_key_path(
        protocol["executionTrust"], "analysis-authorizer"
    )
    analysis_authorization = verify_signed_payload(
        read_json_object(args.authorization, "P30 analysis authorization"),
        expected_role="analysis-authorizer",
        public_key_path=public_key_path,
    )
    authorized_out = resolve_artifact(
        analysis_authorization["outputs"]["analysis"]["path"],
        anchor=args.authorization.parent,
        label="authorized P30 analysis output",
    )
    if args.out.resolve() != authorized_out.resolve():
        raise ValueError("analyzer output path differs from its one-shot authorization")
    result = analyze_indexed(indexed, reports, protocol)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.out.exists():
        raise FileExistsError(args.out)
    temporary = args.out.with_name(f".{args.out.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write(json.dumps(result, indent=2, allow_nan=False) + "\n")
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
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
