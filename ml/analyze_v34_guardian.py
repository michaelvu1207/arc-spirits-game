#!/usr/bin/env python3
"""Fail-closed analysis for the frozen V34 guardian confirmation.

The guardian wave is an independent robustness filter.  This module never pools
guardian rows with Phase 2 rows and never uses guardian outcomes to reorder the
Phase 2 ranking.  It consumes only immutable, hash-bound authorization,
execution-lock, and condition manifests.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from statistics import NormalDist
from typing import Any, Mapping, Sequence

import numpy as np


ANALYSIS_SCHEMA = "arc-v34-guardian-analysis-v1"
PROTOCOL_SCHEMA = "arc-v34-guardian-execution-protocol-v1"
AUTHORIZATION_SCHEMA = "arc-v34-guardian-authorization-v1"
TOOLING_LOCK_SCHEMA = "arc-v34-guardian-tooling-lock-v1"
EXECUTION_LOCK_SCHEMA = "arc-v34-guardian-execution-lock-v1"
CONDITION_SCHEMA = "arc-v34-guardian-condition-v1"
PHASE2_ANALYSIS_SCHEMA = "arc-v34-phase2-analysis-v1"
PHASE2_CONDITION_SCHEMA = "arc-v34-phase2-condition-v1"
REPORT_SCHEMA = "solo-heldout-v2"

REFERENCE_ARM = "raw"
REGISTERED_ARMS = (
    "rerank-p025",
    "rerank-p050",
    "rerank-p075",
    "rerank-p100",
    "heuristic-s4-h2",
    "heuristic-s8-h3",
)
SEED0 = 957_300_000
GAMES = 8_192
SEED_MAX = 957_308_191
REPLAY_GAMES = 64
REPLAY_WORKERS = 8
GUARDIAN_COUNT = 10
EXPECTED_GUARDIAN_COUNTS = (820, 820, 819, 819, 819, 819, 819, 819, 819, 819)
BOOTSTRAP_DRAWS = 10_000
BOOTSTRAP_SEED = 34_032_026
CONFIDENCE = 0.95
FROZEN_FAMILY_SIZE = 60
POINT_MIN = -5.0
LOWER_STRICT_MIN = -10.0

LATER_AUTHORIZATION_KEYS = {
    "teacherSeedsOpen",
    "finalDevelopmentSeedsOpen",
    "hiddenSeedsOpen",
    "multiplayerSeedsOpen",
    "humanReferenceSeedsOpen",
    "productionPromotionOpen",
}
AUTHORIZATION_FLAGS = {"guardianSeedsOpen", *LATER_AUTHORIZATION_KEYS}
PROTOCOL_EXECUTION_FLAGS = {"guardianExecutionOpen", *LATER_AUTHORIZATION_KEYS}
EXECUTION_FLAGS = {"guardianSeedsOpen", "guardianExecutionOpen", *LATER_AUTHORIZATION_KEYS}

AUTHORIZATION_KEYS = {
    "schemaVersion",
    "authoritative",
    "strengthProtocolHistoricalGuardianFlagsIgnored",
    "phase2Analysis",
    "strengthToolingLock",
    "registeredCandidateSlots",
    "systemsEligibleArms",
    "corePassingArms",
    "authorizedArms",
    "phase2RankedArms",
    "phase2Leader",
    "laneAClosed",
    "authorization",
    "sourceCommit",
    "createdAt",
}
EXECUTION_LOCK_KEYS = {
    "schemaVersion",
    "authoritative",
    "implementationCommit",
    "guardianToolingLock",
    "guardianProtocol",
    "phase2Analysis",
    "guardianAuthorization",
    "guardianPreflight",
    "phase2Conditions",
    "authorizedArms",
    "phase2RankedArms",
    "sourceCommit",
    "environment",
    "authorization",
    "createdAt",
}
CONDITION_KEYS = {
    "schemaVersion",
    "valid",
    "immutable",
    "condition",
    "attempt",
    "workers",
    "arm",
    "sourceCommit",
    "seed0",
    "games",
    "seedMax",
    "commonDecode",
    "checkpoint",
    "catalog",
    "inference",
    "telemetry",
    "stalls",
    "integrity",
    "guardians",
    "inputs",
}
CONDITION_INPUT_KEYS = {
    "guardianExecutionLock",
    "guardianAuthorization",
    "guardianToolingLock",
    "baseProtocol",
    "strengthProtocol",
    "guardianProtocol",
    "systemsEligibility",
    "guardianPreflight",
    "report",
    "replayReport",
    "replayStdout",
    "replayStderr",
    "replayExitCode",
    "inferLog",
    "stdout",
    "stderr",
    "launch",
    "resourceSnapshot",
    "launchPid",
    "exitCode",
}
INTEGRITY_COUNTER_KEYS = {
    "informationSafetyFailures",
    "replayMismatches",
    "servingErrors",
    "provenanceMismatches",
}
INTEGRITY_KEYS = {*INTEGRITY_COUNTER_KEYS, "derivedOnlyAfterStrictValidation", "evidence"}
TELEMETRY_KEYS = {
    "plannerMode",
    "strategicDecisions",
    "strategicSimulations",
    "decisionWallMsP50",
    "decisionWallMsP95",
    "byPhase",
    "wallSeconds",
}
RESOURCE_KEYS = {
    "schemaVersion",
    "recordedAt",
    "host",
    "sourceCommit",
    "guardianToolingLock",
    "guardianExecutionLock",
    "gpu",
    "locks",
    "workers",
    "maxConcurrentConditions",
    "maxActorWorkers",
    "scratch",
    "persistent",
    "memory",
    "loadAverage",
    "passed",
}
LAUNCH_KEYS = {
    "schemaVersion",
    "condition",
    "attempt",
    "workers",
    "gpu",
    "sourceCommit",
    "watchdogSeconds",
    "watchdogKillAfterSeconds",
    "guardianExecutionLock",
    "resourceSnapshot",
    "seed0",
    "games",
    "seedMax",
    "commonDecode",
    "arm",
    "checkpoint",
    "catalog",
    "retryJustification",
    "evaluatorArgs",
    "replayEvaluatorArgs",
}
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
INFERENCE_KEYS = {"format", "obsDim", "actDim", "weightsPath", "weightsSha256", "wire"}
REPORT_KEYS = {
    "schemaVersion",
    "sourceCommit",
    "weights",
    "weightsSha256",
    "catalog",
    "catalogSha256",
    "inference",
    "seed0",
    "games",
    "maxRounds",
    "maxStatusLevel",
    "decode",
    "trueWins",
    "trueWinRate",
    "trueWinWilson95",
    "namedWinRate",
    "stalls",
    "stallRate",
    "reach15Rate",
    "nearMiss27To29Rate",
    "vp",
    "vpBuckets",
    "guardianBreakdown",
    "first30Round",
    "engine",
    "performance",
    "perGame",
}

ARM_CONFIGS: dict[str, dict[str, Any]] = {
    "rerank-p025": {"id": "rerank-p025", "kind": "critic-rerank", "policyRankWeight": 0.25},
    "rerank-p050": {"id": "rerank-p050", "kind": "critic-rerank", "policyRankWeight": 0.5},
    "rerank-p075": {"id": "rerank-p075", "kind": "critic-rerank", "policyRankWeight": 0.75},
    "rerank-p100": {"id": "rerank-p100", "kind": "critic-rerank", "policyRankWeight": 1.0},
    "heuristic-s4-h2": {
        "id": "heuristic-s4-h2",
        "kind": "heuristic-batched",
        "simulations": 4,
        "horizonRounds": 2,
    },
    "heuristic-s8-h3": {
        "id": "heuristic-s8-h3",
        "kind": "heuristic-batched",
        "simulations": 8,
        "horizonRounds": 3,
    },
}
GUARDIAN_TOOLING_FILES = {
    "ml/analyze_v34_guardian.py",
    "ml/experiments/v34-latency-first-expert-iteration/guardian-execution-protocol.json",
    "ml/experiments/v34-latency-first-expert-iteration/guardian-tooling-fable-review.md",
    "ml/experiments/v34-latency-first-expert-iteration/guardian-tooling-plan.md",
    "ml/test_analyze_v34_guardian.py",
    "scripts/lock-v34-guardian-execution.mjs",
    "scripts/lock-v34-guardian-tooling.mjs",
    "scripts/record-v34-guardian-authorization.mjs",
    "scripts/record-v34-guardian-condition.mjs",
    "scripts/record-v34-guardian-preflight.mjs",
    "scripts/run-v34-guardian-confirmation.sh",
    "scripts/run-v34-guardian-preflight.sh",
    "scripts/test-v34-guardian-condition.mjs",
    "scripts/v34-guardian-tooling-files.mjs",
    "scripts/validate-v34-guardian-protocol.mjs",
    "scripts/verify-v34-guardian-chain.mjs",
}


@dataclass(frozen=True)
class Artifact:
    path: Path
    sha256: str
    size: int
    value: dict[str, Any]


@dataclass(frozen=True)
class Authorization:
    artifact: Artifact
    phase2: Artifact
    strength_lock: Artifact
    authorized: tuple[str, ...]
    ranked: tuple[str, ...]


@dataclass(frozen=True)
class Execution:
    artifact: Artifact
    tooling_lock: Artifact
    preflight: Artifact


@dataclass(frozen=True)
class Condition:
    arm: str
    manifest: Artifact
    report: Artifact
    replay: Artifact
    rows: dict[int, dict[str, Any]]
    stalls: int


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def is_commit(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 40
        and all(character in "0123456789abcdef" for character in value)
    )


def exact_keys(
    value: Any,
    expected: set[str],
    label: str,
    *,
    optional: set[str] | None = None,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    optional = optional or set()
    missing = expected - set(value)
    extra = set(value) - expected - optional
    if missing or extra:
        raise ValueError(
            f"{label} has non-exact keys (missing={sorted(missing)}, extra={sorted(extra)})"
        )
    return value


def finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label} must be finite")
    return result


def nonnegative_int(value: Any, label: str) -> int:
    if type(value) is not int or value < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return value


def resolve_path(raw: Any, repo: Path) -> Path:
    if not isinstance(raw, str) or not raw:
        raise ValueError("artifact path must be a non-empty string")
    path = Path(raw).expanduser()
    return path.resolve() if path.is_absolute() else (repo / path).resolve()


def load_json(path: Path, label: str) -> Artifact:
    path = path.resolve()
    if not path.is_file():
        raise ValueError(f"{label}: missing artifact {path}")
    try:
        value = json.loads(path.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label}: invalid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label}: JSON root must be an object")
    return Artifact(path=path, sha256=sha256(path), size=path.stat().st_size, value=value)


def verify_file_record(record: Any, repo: Path, label: str, *, expect_json: bool = False) -> Artifact | Path:
    record = exact_keys(record, {"path", "bytes", "sha256"}, label)
    if type(record["bytes"]) is not int or record["bytes"] < 0 or not is_sha256(record["sha256"]):
        raise ValueError(f"{label}: malformed file record")
    path = resolve_path(record["path"], repo)
    if (
        not path.is_file()
        or path.stat().st_size != record["bytes"]
        or sha256(path) != record["sha256"]
    ):
        raise ValueError(f"{label}: missing, size-invalid, or hash-invalid artifact")
    return load_json(path, label) if expect_json else path


def record_matches(record: Any, artifact: Artifact, repo: Path, label: str) -> None:
    loaded = verify_file_record(record, repo, label, expect_json=True)
    assert isinstance(loaded, Artifact)
    if loaded.path != artifact.path or loaded.sha256 != artifact.sha256 or loaded.size != artifact.size:
        raise ValueError(f"{label}: file record does not name the supplied artifact")


def repo_label(path: Path, repo: Path) -> str:
    try:
        return path.resolve().relative_to(repo.resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def artifact_record(artifact: Artifact, repo: Path) -> dict[str, Any]:
    return {"path": repo_label(artifact.path, repo), "bytes": artifact.size, "sha256": artifact.sha256}


def require_closed_flags(value: Any, expected: set[str], label: str, *, open_key: str | None = None) -> None:
    flags = exact_keys(value, expected, label)
    for key in expected:
        wanted = key == open_key
        if flags[key] is not wanted:
            raise ValueError(f"{label}: {key} must be {str(wanted).lower()}")


def utc_timestamp(value: Any, label: str) -> None:
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", value
    ):
        raise ValueError(f"{label}: expected an RFC3339 UTC timestamp")


def ordered_subset(value: Any, registry: Sequence[str], label: str) -> tuple[str, ...]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"{label} must be a string array")
    result = tuple(value)
    if len(set(result)) != len(result) or any(item not in registry for item in result):
        raise ValueError(f"{label} has duplicates or unregistered arms")
    expected = tuple(item for item in registry if item in result)
    if result != expected:
        raise ValueError(f"{label} is not in registered-slot order")
    return result


def protocol_guardian_block(protocol: Mapping[str, Any]) -> Mapping[str, Any]:
    block = protocol.get("guardian")
    if not isinstance(block, dict):
        block = protocol.get("experiment")
    if not isinstance(block, dict):
        raise ValueError("guardian protocol lacks its experiment block")
    return block


def protocol_guardians(protocol: Mapping[str, Any]) -> tuple[dict[str, str], ...]:
    block = protocol_guardian_block(protocol)
    raw = block.get("guardiansFromFrozenCatalog", block.get("guardians"))
    if not isinstance(raw, list) or len(raw) != GUARDIAN_COUNT:
        raise ValueError("guardian protocol must contain ten guardians")
    guardians: list[dict[str, str]] = []
    for index, row in enumerate(raw):
        row = exact_keys(row, {"id", "name"}, f"guardian {index}")
        if not isinstance(row["id"], str) or not row["id"] or not isinstance(row["name"], str) or not row["name"]:
            raise ValueError(f"guardian {index}: invalid id/name")
        guardians.append({"id": row["id"], "name": row["name"]})
    if len({row["id"] for row in guardians}) != GUARDIAN_COUNT or len({row["name"] for row in guardians}) != GUARDIAN_COUNT:
        raise ValueError("guardian protocol ids/names must be unique")
    return tuple(guardians)


def validate_guardian_protocol(protocol: Artifact, repo: Path) -> tuple[dict[str, str], ...]:
    value = exact_keys(
        protocol.value,
        {
            "schemaVersion",
            "status",
            "authoritativeStateArtifacts",
            "base",
            "environment",
            "commonDecode",
            "guardian",
            "runtime",
            "authorization",
            "result",
        },
        "guardian execution protocol",
    )
    if value.get("schemaVersion") != PROTOCOL_SCHEMA:
        raise ValueError("unexpected guardian execution protocol schema")
    if value.get("status") != "closed" or value.get("result") is not None:
        raise ValueError("guardian execution protocol historical state changed")
    base = exact_keys(
        value.get("base"),
        {
            "protocol",
            "strengthProtocol",
            "sourceLock",
            "strengthToolingLock",
            "catalog",
            "checkpoint",
            "sourceCommit",
        },
        "guardian protocol base",
    )
    if not is_commit(base.get("sourceCommit")):
        raise ValueError("guardian protocol source commit is malformed")
    for name in ("protocol", "strengthProtocol", "sourceLock", "strengthToolingLock", "catalog", "checkpoint"):
        verify_file_record(base[name], repo, f"guardian protocol base {name}")
    _validate_environment(value.get("environment"), "guardian protocol environment")
    if value.get("commonDecode") != {
        "seats": 1,
        "maxRounds": 30,
        "maxStatusLevel": 2,
        "guardianSchedule": "absolute-balanced",
        "selection": "hybrid",
        "sample": True,
        "temperature": 0.55,
        "learnMonsterRewardChoices": False,
        "obsVersion": 1,
        "policyObsVersion": 2,
        "inferenceWire": "binary",
    }:
        raise ValueError("guardian common decode changed")
    block = protocol_guardian_block(value)
    if (
        block.get("seed0") != SEED0
        or block.get("games") != GAMES
        or block.get("seedMax") != SEED_MAX
        or block.get("referenceArm") != REFERENCE_ARM
        or tuple(block.get("registeredCandidateSlots", ())) != REGISTERED_ARMS
        or block.get("guardianOutcomesMayReorderPhase2Ranking") is not False
        or block.get("poolPhase2Outcomes") is not False
    ):
        raise ValueError("guardian seed contract changed")
    guardians = protocol_guardians(value)
    assignment = block.get("assignment", {})
    if (
        assignment.get("algorithm")
        != "guardianIndexForSeed(seed, guardianCount) = seed % guardianCount"
        or assignment.get("dependsOnlyOnEngineSeed") is not True
        or tuple(assignment.get("expectedCountsInGuardianOrder", ())) != EXPECTED_GUARDIAN_COUNTS
    ):
        raise ValueError("guardian assignment contract changed")
    replay = block.get("replayAudit", {})
    if replay != {
        "seed0": SEED0,
        "games": REPLAY_GAMES,
        "seedMax": SEED0 + REPLAY_GAMES - 1,
        "workers": REPLAY_WORKERS,
        "sameInferenceProcess": True,
        "exactPerGameEqualityBySeed": True,
    }:
        raise ValueError("guardian replay contract changed")
    family = block.get("family", value.get("family", {}))
    gates = block.get("gates", value.get("gates", {}))
    if (
        family.get("draws") != BOOTSTRAP_DRAWS
        or family.get("rngSeed") != BOOTSTRAP_SEED
        or family.get("maximumArms") != 6
        or family.get("guardians") != GUARDIAN_COUNT
        or family.get("maximumFamilySize") != FROZEN_FAMILY_SIZE
        or finite_number(family.get("confidence"), "guardian confidence") != CONFIDENCE
    ):
        raise ValueError("guardian family contract changed")
    if (
        finite_number(gates.get("everyCellPointDeltaPointsMin"), "guardian point gate") != POINT_MIN
        or finite_number(
            gates.get("everyCellSimultaneousLowerStrictlyAbovePoints"), "guardian lower gate"
        )
        != LOWER_STRICT_MIN
        or gates.get("candidateMeasuredStalls") != 0
        or gates.get("rawMeasuredStalls") != 0
        or gates.get("safetyAndProvenanceFailures") != 0
    ):
        raise ValueError("guardian gate contract changed")
    require_closed_flags(
        value.get("authorization"), PROTOCOL_EXECUTION_FLAGS, "guardian protocol flags"
    )
    return guardians


def phase2_contract(analysis: Artifact) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]]:
    value = analysis.value
    if value.get("schemaVersion") != PHASE2_ANALYSIS_SCHEMA or value.get("valid") is not True:
        raise ValueError("guardian authorization references an invalid Phase 2 analysis")
    contract = value.get("contract", {})
    if tuple(contract.get("registeredCandidateSlots", ())) != REGISTERED_ARMS:
        raise ValueError("Phase 2 registered candidate slots changed")
    systems_eligible = ordered_subset(
        contract.get("systemsEligibleArms"), REGISTERED_ARMS, "Phase 2 systems-eligible arms"
    )
    passing = ordered_subset(value.get("corePassingArms"), REGISTERED_ARMS, "Phase 2 core passes")
    if any(arm not in systems_eligible for arm in passing):
        raise ValueError("Phase 2 core pass was not systems eligible")
    rows = value.get("arms")
    if not isinstance(rows, list):
        raise ValueError("Phase 2 analysis lacks arm results")
    by_arm: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or row.get("arm") not in REGISTERED_ARMS or row["arm"] in by_arm:
            raise ValueError("Phase 2 arm results are duplicate or malformed")
        by_arm[row["arm"]] = row
    if set(by_arm) != set(REGISTERED_ARMS):
        raise ValueError("Phase 2 arm results are incomplete")
    for arm in REGISTERED_ARMS:
        if (by_arm[arm].get("corePass") is True) != (arm in passing):
            raise ValueError("Phase 2 corePassingArms disagrees with arm results")

    def rank_key(arm: str) -> tuple[float, float, str]:
        row = by_arm[arm]
        endpoints = row.get("endpoints")
        binding = row.get("bindingDecisionWallMsP95")
        if not isinstance(endpoints, dict) or not isinstance(binding, dict):
            raise ValueError(f"Phase 2 passing arm {arm} lacks ranking evidence")
        win = finite_number(endpoints.get("winPoints", {}).get("mean"), f"{arm} Phase 2 win gain")
        w8 = finite_number(binding.get("binding-w8"), f"{arm} binding-w8 p95")
        return (-win, w8, arm)

    ranked = tuple(sorted(passing, key=rank_key))
    decision = value.get("decision", {})
    if (
        decision.get("guardianAuthorizationMayOpen") is not bool(passing)
        or tuple(decision.get("guardianAuthorizationMustNameExactly", ())) != passing
        or decision.get("guardianSeedsOpen") is not False
        or any(decision.get(key) is not False for key in LATER_AUTHORIZATION_KEYS)
    ):
        raise ValueError("Phase 2 decision does not safely authorize guardian recording")
    return systems_eligible, passing, ranked


def validate_authorization(artifact: Artifact, repo: Path) -> Authorization:
    value = exact_keys(artifact.value, AUTHORIZATION_KEYS, "guardian authorization")
    if (
        value.get("schemaVersion") != AUTHORIZATION_SCHEMA
        or value.get("authoritative") is not True
        or value.get("strengthProtocolHistoricalGuardianFlagsIgnored") is not True
        or not is_commit(value.get("sourceCommit"))
    ):
        raise ValueError("guardian authorization header is invalid")
    utc_timestamp(value.get("createdAt"), "guardian authorization createdAt")
    phase2 = verify_file_record(value["phase2Analysis"], repo, "Phase 2 analysis", expect_json=True)
    strength_lock = verify_file_record(
        value["strengthToolingLock"], repo, "strength tooling lock", expect_json=True
    )
    assert isinstance(phase2, Artifact) and isinstance(strength_lock, Artifact)
    if strength_lock.value.get("schemaVersion") != "arc-v34-strength-tooling-lock-v1":
        raise ValueError("guardian authorization strength lock schema mismatch")
    if strength_lock.value.get("implementationCommit") != value["sourceCommit"]:
        raise ValueError("guardian authorization source commit differs from strength lock")
    phase2_strength = phase2.value.get("inputs", {}).get("strengthToolingLock", {})
    if (
        phase2_strength.get("sha256") != strength_lock.sha256
        or resolve_path(phase2_strength.get("path"), repo) != strength_lock.path
    ):
        raise ValueError("Phase 2 analysis does not bind the authorization strength lock")
    systems_eligible, passing, ranked = phase2_contract(phase2)
    if tuple(value.get("registeredCandidateSlots", ())) != REGISTERED_ARMS:
        raise ValueError("guardian authorization registered slots changed")
    if tuple(value.get("systemsEligibleArms", ())) != systems_eligible:
        raise ValueError("guardian authorization systems-eligible arms mismatch")
    if tuple(value.get("corePassingArms", ())) != passing:
        raise ValueError("guardian authorization core-pass set mismatch")
    authorized = ordered_subset(value.get("authorizedArms"), REGISTERED_ARMS, "authorized arms")
    if authorized != passing or tuple(value.get("phase2RankedArms", ())) != ranked:
        raise ValueError("guardian authorization changed the Phase 2 pass set or ranking")
    leader = ranked[0] if ranked else None
    if value.get("phase2Leader") != leader:
        raise ValueError("guardian authorization Phase 2 leader mismatch")
    if value.get("laneAClosed") is not (not authorized):
        raise ValueError("guardian authorization Lane A closure mismatch")
    require_closed_flags(
        value.get("authorization"),
        AUTHORIZATION_FLAGS,
        "guardian authorization flags",
        open_key="guardianSeedsOpen" if authorized else None,
    )
    return Authorization(artifact, phase2, strength_lock, authorized, ranked)


def _validate_environment(value: Any, label: str) -> None:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    if value.get("python") != platform.python_version() or value.get("numpy") != np.__version__:
        raise ValueError(f"{label} does not match the executing Python/NumPy runtime")
    rng = value.get("rng")
    if rng not in {"numpy.random.Generator(PCG64)", "numpy.random.Generator(numpy.random.PCG64)"}:
        raise ValueError(f"{label} RNG is not PCG64")


def _phase2_condition_records(analysis: Artifact, repo: Path) -> tuple[tuple[str, Artifact], ...]:
    raw = analysis.value.get("inputs", {}).get("conditions")
    if not isinstance(raw, list) or not raw:
        raise ValueError("Phase 2 analysis condition inventory is missing")
    records: list[tuple[str, Artifact]] = []
    for item in raw:
        if not isinstance(item, dict) or set(item) != {"arm", "manifest", "report"}:
            raise ValueError("Phase 2 condition inventory is malformed")
        arm = item["arm"]
        if arm != REFERENCE_ARM and arm not in REGISTERED_ARMS:
            raise ValueError("Phase 2 condition inventory names an unknown arm")
        ref = item["manifest"]
        if not isinstance(ref, dict) or set(ref) != {"path", "sha256"} or not is_sha256(ref["sha256"]):
            raise ValueError("Phase 2 condition manifest reference is malformed")
        path = resolve_path(ref["path"], repo)
        manifest = load_json(path, f"Phase 2 {arm} completion")
        if manifest.sha256 != ref["sha256"] or manifest.value.get("schemaVersion") != PHASE2_CONDITION_SCHEMA:
            raise ValueError("Phase 2 condition completion is missing or hash-invalid")
        records.append((arm, manifest))
    if len({arm for arm, _ in records}) != len(records) or records[0][0] != REFERENCE_ARM:
        raise ValueError("Phase 2 condition inventory must contain one leading raw condition")
    return tuple(records)


def validate_tooling_lock(
    tooling: Artifact,
    *,
    protocol: Artifact,
    authorization: Authorization,
    preflight: Artifact,
    repo: Path,
) -> None:
    value = exact_keys(
        tooling.value,
        {
            "schemaVersion",
            "authoritative",
            "implementationCommit",
            "baseSourceLock",
            "strengthProtocol",
            "strengthToolingLock",
            "guardianProtocol",
            "guardianPreflight",
            "files",
            "environment",
            "authorization",
            "createdAt",
        },
        "guardian tooling lock",
    )
    if (
        value.get("schemaVersion") != TOOLING_LOCK_SCHEMA
        or value.get("authoritative") is not True
        or not is_commit(value.get("implementationCommit"))
    ):
        raise ValueError("guardian tooling lock is invalid")
    utc_timestamp(value.get("createdAt"), "guardian tooling lock createdAt")
    base = protocol.value["base"]
    for name, protocol_name in (
        ("baseSourceLock", "sourceLock"),
        ("strengthProtocol", "strengthProtocol"),
        ("strengthToolingLock", "strengthToolingLock"),
    ):
        locked = verify_file_record(value[name], repo, f"tooling lock {name}", expect_json=True)
        expected = verify_file_record(base[protocol_name], repo, f"protocol base {protocol_name}", expect_json=True)
        assert isinstance(locked, Artifact) and isinstance(expected, Artifact)
        if locked.path != expected.path or locked.sha256 != expected.sha256:
            raise ValueError(f"tooling lock {name} differs from the guardian protocol")
    record_matches(value["strengthToolingLock"], authorization.strength_lock, repo, "tooling strength lock")
    record_matches(value["guardianProtocol"], protocol, repo, "tooling guardian protocol")
    record_matches(value["guardianPreflight"], preflight, repo, "tooling guardian preflight")
    _validate_environment(value.get("environment"), "guardian tooling environment")
    require_closed_flags(
        value.get("authorization"), EXECUTION_FLAGS, "guardian tooling authorization"
    )
    files = value.get("files")
    if not isinstance(files, dict) or set(files) != GUARDIAN_TOOLING_FILES:
        raise ValueError("guardian tooling lock file inventory changed")
    for raw_path, expected_hash in files.items():
        path = resolve_path(raw_path, repo)
        if not is_sha256(expected_hash) or not path.is_file() or sha256(path) != expected_hash:
            raise ValueError(f"guardian tooling source changed: {raw_path}")


def validate_execution_lock(
    artifact: Artifact,
    *,
    authorization: Authorization,
    protocol: Artifact,
    repo: Path,
    verify_git: bool = True,
) -> Execution:
    value = exact_keys(artifact.value, EXECUTION_LOCK_KEYS, "guardian execution lock")
    if (
        value.get("schemaVersion") != EXECUTION_LOCK_SCHEMA
        or value.get("authoritative") is not True
        or not is_commit(value.get("implementationCommit"))
        or value.get("sourceCommit") != authorization.artifact.value["sourceCommit"]
    ):
        raise ValueError("guardian execution lock header is invalid")
    utc_timestamp(value.get("createdAt"), "guardian execution lock createdAt")
    tooling = verify_file_record(
        value["guardianToolingLock"], repo, "guardian tooling lock", expect_json=True
    )
    locked_protocol = verify_file_record(
        value["guardianProtocol"], repo, "guardian execution protocol", expect_json=True
    )
    locked_phase2 = verify_file_record(
        value["phase2Analysis"], repo, "execution-lock Phase 2 analysis", expect_json=True
    )
    locked_auth = verify_file_record(
        value["guardianAuthorization"], repo, "execution-lock guardian authorization", expect_json=True
    )
    preflight = verify_file_record(
        value["guardianPreflight"], repo, "guardian execution preflight", expect_json=True
    )
    assert all(isinstance(item, Artifact) for item in (tooling, locked_protocol, locked_phase2, locked_auth, preflight))
    assert isinstance(tooling, Artifact) and isinstance(locked_protocol, Artifact)
    assert isinstance(locked_phase2, Artifact) and isinstance(locked_auth, Artifact) and isinstance(preflight, Artifact)
    validate_tooling_lock(
        tooling,
        protocol=protocol,
        authorization=authorization,
        preflight=preflight,
        repo=repo,
    )
    if tooling.value.get("implementationCommit") != value["implementationCommit"]:
        raise ValueError("guardian execution/tooling implementation commits differ")
    record_matches(value["guardianProtocol"], protocol, repo, "guardian protocol")
    record_matches(value["phase2Analysis"], authorization.phase2, repo, "Phase 2 analysis")
    record_matches(value["guardianAuthorization"], authorization.artifact, repo, "guardian authorization")
    tooling_protocol = tooling.value.get("guardianProtocol")
    if tooling_protocol is not None:
        record_matches(tooling_protocol, protocol, repo, "tooling-lock guardian protocol")
    if (
        preflight.value.get("schemaVersion") != "arc-v34-guardian-preflight-v1"
        or preflight.value.get("passed") is not True
        or preflight.value.get("phase") != "tooling"
    ):
        raise ValueError("guardian execution preflight did not pass")
    if tuple(value.get("authorizedArms", ())) != authorization.authorized:
        raise ValueError("execution lock authorized arms mismatch")
    if tuple(value.get("phase2RankedArms", ())) != authorization.ranked:
        raise ValueError("execution lock Phase 2 ranking mismatch")
    _validate_environment(value.get("environment"), "guardian execution environment")
    execution_flags = exact_keys(
        value.get("authorization"), EXECUTION_FLAGS, "guardian execution flags"
    )
    if (
        execution_flags["guardianSeedsOpen"] is not True
        or execution_flags["guardianExecutionOpen"] is not True
        or any(execution_flags[key] is not False for key in LATER_AUTHORIZATION_KEYS)
    ):
        raise ValueError("guardian execution flags are not exactly open for guardian only")
    expected_phase2 = _phase2_condition_records(authorization.phase2, repo)
    locked_conditions = value.get("phase2Conditions")
    if not isinstance(locked_conditions, list) or len(locked_conditions) != len(expected_phase2):
        raise ValueError("execution lock Phase 2 condition inventory is incomplete")
    for item, (expected_arm, expected_manifest) in zip(locked_conditions, expected_phase2, strict=True):
        if not isinstance(item, dict) or set(item) != {"arm", "path", "bytes", "sha256"}:
            raise ValueError("execution lock Phase 2 condition record is malformed")
        if item["arm"] != expected_arm:
            raise ValueError("execution lock Phase 2 condition order changed")
        record_matches(
            {key: item[key] for key in ("path", "bytes", "sha256")},
            expected_manifest,
            repo,
            f"execution lock Phase 2 condition {expected_arm}",
        )
    if verify_git:
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
        ancestor = subprocess.run(
            ["git", "merge-base", "--is-ancestor", value["implementationCommit"], head],
            cwd=repo,
            check=False,
        )
        if ancestor.returncode != 0:
            raise ValueError("guardian tooling commit is not an ancestor of the executing tree")
    return Execution(artifact, tooling, preflight)


def _expected_arm(protocol: Mapping[str, Any], arm: str) -> dict[str, Any]:
    if arm == REFERENCE_ARM:
        return {"id": REFERENCE_ARM, "kind": "raw", "selectedWorkers": 24}
    result = ARM_CONFIGS.get(arm)
    if result is None:
        raise ValueError(f"guardian protocol lacks authorized arm {arm}")
    if tuple(protocol_guardian_block(protocol).get("registeredCandidateSlots", ())) != REGISTERED_ARMS:
        raise ValueError("guardian protocol registered arms changed")
    return dict(result)


def _expected_decode(protocol: Mapping[str, Any], arm: str, socket: Any) -> dict[str, Any]:
    common = protocol.get("commonDecode")
    if not isinstance(common, dict):
        common = protocol.get("decode")
    if not isinstance(common, dict):
        raise ValueError("guardian protocol lacks common decode")
    expected: dict[str, Any] = {
        "policyObsVersion": 2,
        "inferenceSocket": socket,
        "learnMonsterRewardChoices": False,
        "sample": True,
        "temperature": 0.55,
    }
    if not isinstance(socket, str) or not socket:
        raise ValueError(f"{arm}: report lacks an inference socket")
    if arm == REFERENCE_ARM:
        return expected
    config = _expected_arm(protocol, arm)
    kind = config.get("kind")
    if kind == "critic-rerank":
        expected["rerank"] = {"policyRankWeight": config.get("policyRankWeight")}
    elif kind == "heuristic-batched":
        expected["search"] = {
            "sims": config.get("simulations"),
            "objective": "solo-reach30",
            "horizonRounds": config.get("horizonRounds"),
            "frac": 1,
            "valueWeight": 0.5,
            "rollout": "heuristic",
            "navTemperature": 0,
        }
    else:
        raise ValueError(f"{arm}: unknown arm kind")
    return expected


def _report_contract(protocol: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    checkpoint = protocol.get("checkpoint")
    catalog = protocol.get("catalog")
    common = protocol.get("commonDecode")
    if not isinstance(checkpoint, dict) or not isinstance(catalog, dict):
        base = protocol.get("base", {})
        checkpoint = checkpoint if isinstance(checkpoint, dict) else base.get("checkpoint")
        catalog = catalog if isinstance(catalog, dict) else base.get("catalog")
    if not isinstance(checkpoint, dict) or not isinstance(catalog, dict) or not isinstance(common, dict):
        raise ValueError("guardian protocol lacks checkpoint/catalog/decode contract")
    return checkpoint, catalog, common


def validate_report(
    report: Mapping[str, Any],
    *,
    arm: str,
    expected_workers: int,
    source_commit: str,
    protocol: Mapping[str, Any],
    guardians: Sequence[Mapping[str, str]],
    games: int = GAMES,
) -> dict[int, dict[str, Any]]:
    exact_keys(report, REPORT_KEYS, f"{arm} report")
    checkpoint, catalog, _ = _report_contract(protocol)
    if (
        report.get("schemaVersion") != REPORT_SCHEMA
        or report.get("sourceCommit") != source_commit
        or report.get("weightsSha256") != checkpoint.get("sha256")
        or report.get("catalogSha256") != catalog.get("sha256")
        or report.get("seed0") != SEED0
        or report.get("games") != games
        or report.get("maxRounds") != 30
        or report.get("maxStatusLevel") != 2
    ):
        raise ValueError(f"{arm}: report provenance or horizon mismatch")
    if report.get("weights") != checkpoint.get("path") or report.get("catalog") != catalog.get("path"):
        raise ValueError(f"{arm}: report checkpoint/catalog path mismatch")
    inference = exact_keys(report.get("inference"), INFERENCE_KEYS, f"{arm} inference")
    if (
        inference.get("weightsSha256") != checkpoint.get("sha256")
        or inference.get("wire") != "binary"
        or (checkpoint.get("format") is not None and inference.get("format") != checkpoint.get("format"))
        or (checkpoint.get("obsDim") is not None and inference.get("obsDim") != checkpoint.get("obsDim"))
        or (checkpoint.get("actDim") is not None and inference.get("actDim") != checkpoint.get("actDim"))
    ):
        raise ValueError(f"{arm}: inference provenance mismatch")
    decode = report.get("decode")
    if decode != _expected_decode(protocol, arm, decode.get("inferenceSocket") if isinstance(decode, dict) else None):
        raise ValueError(f"{arm}: decode differs from the frozen arm")
    performance = report.get("performance")
    if not isinstance(performance, dict) or performance.get("workers") != expected_workers:
        raise ValueError(f"{arm}: worker allocation mismatch")
    rows = report.get("perGame")
    if not isinstance(rows, list) or len(rows) != games:
        raise ValueError(f"{arm}: report must contain exactly {games} per-game rows")
    names = [row["name"] for row in guardians]
    by_seed: dict[int, dict[str, Any]] = {}
    expected_end = SEED0 + games - 1
    for row in rows:
        exact_keys(row, ROW_KEYS, f"{arm} per-game row")
        seed = row.get("seed")
        if type(seed) is not int or seed < SEED0 or seed > expected_end or seed in by_seed:
            raise ValueError(f"{arm}: missing, duplicate, or out-of-range seed")
        if type(row.get("trueWin")) is not bool or type(row.get("stalled")) is not bool:
            raise ValueError(f"{arm} seed {seed}: malformed outcome flags")
        final_vp = finite_number(row.get("finalVP"), f"{arm} seed {seed} finalVP")
        finite_number(row.get("post15VpPerRound"), f"{arm} seed {seed} post15 rate")
        first30 = row.get("first30Round")
        if first30 is not None and (type(first30) is not int or first30 < 1 or first30 > 30):
            raise ValueError(f"{arm} seed {seed}: invalid first30Round")
        if row.get("guardian") != names[seed % GUARDIAN_COUNT]:
            raise ValueError(f"{arm} seed {seed}: guardian is not seed % 10")
        if row["trueWin"] != (final_vp >= 30 and not row["stalled"]):
            raise ValueError(f"{arm} seed {seed}: trueWin disagrees with VP/stall")
        cycle = row.get("cycle")
        if not isinstance(cycle, dict):
            raise ValueError(f"{arm} seed {seed}: cycle telemetry is missing")
        for field in (
            "first30Round",
            "post15VpPerRound",
            "finalAttackDice",
            "finalSpirits",
            "finalMaxBarrier",
        ):
            if cycle.get(field) != row.get(field):
                raise ValueError(f"{arm} seed {seed}: cycle {field} mismatch")
        by_seed[seed] = dict(row)
    if set(by_seed) != set(range(SEED0, expected_end + 1)):
        raise ValueError(f"{arm}: exact seed coverage failed")
    true_wins = sum(row["trueWin"] for row in rows)
    stalls = sum(row["stalled"] for row in rows)
    if (
        report.get("trueWins") != true_wins
        or report.get("stalls") != stalls
        or not math.isclose(
            finite_number(report.get("trueWinRate"), f"{arm} trueWinRate"),
            true_wins / games,
            rel_tol=0,
            abs_tol=1e-15,
        )
        or not math.isclose(
            finite_number(report.get("stallRate"), f"{arm} stallRate"),
            stalls / games,
            rel_tol=0,
            abs_tol=1e-15,
        )
    ):
        raise ValueError(f"{arm}: aggregates differ from per-game rows")
    counts = tuple(sum(row["guardian"] == name for row in rows) for name in names)
    expected_counts = EXPECTED_GUARDIAN_COUNTS if games == GAMES else tuple(
        sum(names[seed % GUARDIAN_COUNT] == name for seed in range(SEED0, expected_end + 1))
        for name in names
    )
    if counts != expected_counts:
        raise ValueError(f"{arm}: guardian counts are not the seed-derived frozen counts")
    breakdown = report.get("guardianBreakdown")
    if not isinstance(breakdown, list) or len(breakdown) != len(names):
        raise ValueError(f"{arm}: guardian breakdown is incomplete")
    if [entry.get("guardian") for entry in breakdown if isinstance(entry, dict)] != names:
        raise ValueError(f"{arm}: guardian breakdown order changed")
    seen: set[str] = set()
    for entry in breakdown:
        if not isinstance(entry, dict):
            raise ValueError(f"{arm}: malformed guardian breakdown")
        name = entry.get("guardian")
        if name not in names or name in seen:
            raise ValueError(f"{arm}: guardian breakdown identity mismatch")
        matching = [row for row in rows if row["guardian"] == name]
        if entry.get("games") != len(matching) or entry.get("trueWins") != sum(
            row["trueWin"] for row in matching
        ):
            raise ValueError(f"{arm}: guardian breakdown counts mismatch")
        seen.add(name)
    return by_seed


def _validate_replay(primary: Artifact, replay: Artifact, arm: str) -> None:
    p = primary.value
    r = replay.value
    for field in (
        "schemaVersion",
        "sourceCommit",
        "weights",
        "weightsSha256",
        "catalog",
        "catalogSha256",
        "maxRounds",
        "maxStatusLevel",
        "decode",
        "inference",
    ):
        if r.get(field) != p.get(field):
            raise ValueError(f"{arm}: replay {field} mismatch")
    if r.get("seed0") != SEED0 or r.get("games") != REPLAY_GAMES:
        raise ValueError(f"{arm}: replay seed range mismatch")
    if r.get("performance", {}).get("workers") != REPLAY_WORKERS:
        raise ValueError(f"{arm}: replay worker count mismatch")
    if r.get("stalls") != sum(row.get("stalled") is True for row in r.get("perGame", [])):
        raise ValueError(f"{arm}: replay stall aggregate mismatch")
    primary_by = {row["seed"]: row for row in p.get("perGame", []) if SEED0 <= row.get("seed", -1) < SEED0 + REPLAY_GAMES}
    replay_by = {row["seed"]: row for row in r.get("perGame", [])}
    if len(primary_by) != REPLAY_GAMES or len(replay_by) != REPLAY_GAMES or primary_by != replay_by:
        raise ValueError(f"{arm}: replay is not exact by seed")


def _parse_infer_log(path: Path, arm: str) -> dict[str, int]:
    lines = path.read_text(errors="replace").splitlines()
    serving = sum(line.startswith("[infer] serving ") for line in lines)
    shutdown = sum(line == "[infer] shut down" for line in lines)
    reloads = sum("[infer] reloaded weights" in line for line in lines)
    errors = sum(bool(re.search(r"Traceback|reload FAILED|RuntimeError|Exception", line)) for line in lines)
    requests = rows = batches = 0
    for line in lines:
        match = re.search(r"\[infer\] reqs=(\d+) rows=(\d+) batches=(\d+)", line)
        if match:
            requests += int(match[1])
            rows += int(match[2])
            batches += int(match[3])
    if serving != 1 or shutdown != 1 or reloads or errors or requests <= 0 or rows < requests or batches <= 0:
        raise ValueError(f"{arm}: inference server lifecycle is invalid")
    return {
        "servingLines": serving,
        "shutdownLines": shutdown,
        "reloadLines": reloads,
        "errorLines": errors,
        "requests": requests,
        "rows": rows,
        "batches": batches,
    }


def _condition_input_artifacts(inputs: Mapping[str, Any], repo: Path, arm: str) -> dict[str, Artifact | Path]:
    result: dict[str, Artifact | Path] = {}
    json_names = {
        "guardianExecutionLock",
        "guardianAuthorization",
        "guardianToolingLock",
        "baseProtocol",
        "strengthProtocol",
        "guardianProtocol",
        "systemsEligibility",
        "guardianPreflight",
        "report",
        "replayReport",
        "launch",
        "resourceSnapshot",
        "retryJustification",
    }
    for name, record in inputs.items():
        result[name] = verify_file_record(
            record, repo, f"{arm} condition input {name}", expect_json=name in json_names
        )
    return result


def _path_hash_matches(value: Any, artifact: Artifact, repo: Path, label: str) -> None:
    link = exact_keys(value, {"path", "sha256"}, label)
    if (
        not is_sha256(link.get("sha256"))
        or link["sha256"] != artifact.sha256
        or resolve_path(link.get("path"), repo) != artifact.path
    ):
        raise ValueError(f"{label}: path/hash mismatch")


def _js_number(value: Any) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _arm_evaluator_args(arm: Mapping[str, Any], base_protocol: Mapping[str, Any]) -> list[str]:
    kind = arm.get("kind")
    if kind == "raw":
        return []
    if kind == "critic-rerank":
        return ["--rerank-policy-weight", _js_number(arm.get("policyRankWeight"))]
    if kind == "heuristic-batched":
        decode = base_protocol.get("systems", {}).get("heuristicDecode", {})
        return [
            "--search-sims",
            _js_number(arm.get("simulations")),
            "--search-horizon",
            _js_number(arm.get("horizonRounds")),
            "--search-objective",
            "solo-reach30",
            "--search-rollout",
            "heuristic",
            "--search-frac",
            _js_number(decode.get("frac")),
            "--search-value-weight",
            _js_number(decode.get("valueWeight")),
            "--search-nav-temperature",
            _js_number(decode.get("navTemperature")),
        ]
    raise ValueError("guardian launch has an unknown arm kind")


def _validate_resource_snapshot(
    snapshot: Artifact,
    *,
    arm: str,
    workers: int,
    source_commit: str,
    execution: Execution,
    protocol: Artifact,
    repo: Path,
    scheduled_manifests: Sequence[Path],
) -> int:
    value = exact_keys(snapshot.value, RESOURCE_KEYS, f"{arm} resource snapshot")
    if (
        value.get("schemaVersion") != "arc-v34-guardian-resource-snapshot-v1"
        or value.get("sourceCommit") != source_commit
        or value.get("workers") != workers
        or value.get("passed") is not True
        or not isinstance(value.get("host"), str)
        or not value["host"]
    ):
        raise ValueError(f"{arm}: resource snapshot header mismatch")
    utc_timestamp(value.get("recordedAt"), f"{arm} resource recordedAt")
    recorded_at = datetime.fromisoformat(value["recordedAt"].replace("Z", "+00:00")).timestamp()
    _path_hash_matches(
        value.get("guardianToolingLock"), execution.tooling_lock, repo, f"{arm} resource tooling lock"
    )
    _path_hash_matches(
        value.get("guardianExecutionLock"), execution.artifact, repo, f"{arm} resource execution lock"
    )
    gpu = exact_keys(value.get("gpu"), {"index", "uuid", "computeApps"}, f"{arm} resource GPU")
    runtime = protocol.value.get("runtime", {})
    eligible = runtime.get("eligibleGpus")
    if (
        type(gpu.get("index")) is not int
        or not isinstance(eligible, list)
        or gpu["index"] not in eligible
        or gpu["index"] == runtime.get("excludedGpu")
        or not isinstance(gpu.get("uuid"), str)
        or not gpu["uuid"]
        or gpu.get("computeApps") != []
    ):
        raise ValueError(f"{arm}: resource GPU was not eligible and empty")
    locks = exact_keys(
        value.get("locks"), {"conditionSlot", "gpu", "phase2Gpu"}, f"{arm} resource locks"
    )
    if (
        any(not isinstance(item, str) or not item for item in locks.values())
        or re.search(r"\.condition-slot-[1-9][0-9]*\.lock$", locks["conditionSlot"]) is None
        or not locks["gpu"].endswith(f".gpu-{gpu['index']}.lock")
        or locks["phase2Gpu"]
        != os.path.join(runtime.get("legacyPhase2GpuLockRoot", ""), f".gpu-{gpu['index']}.lock")
    ):
        raise ValueError(f"{arm}: resource lock contract mismatch")
    max_conditions = runtime.get("maxConcurrentConditions")
    max_workers = runtime.get("maxActorWorkers")
    if (
        value.get("maxConcurrentConditions") != max_conditions
        or value.get("maxActorWorkers") != max_workers
        or type(max_conditions) is not int
        or type(max_workers) is not int
        or max_conditions * workers > max_workers
    ):
        raise ValueError(f"{arm}: resource concurrency contract mismatch")
    scratch = exact_keys(value.get("scratch"), {"freeBytes", "requiredBytes"}, f"{arm} scratch")
    scratch_required = runtime.get("minimumScratchFreeBytes")
    if (
        scratch.get("requiredBytes") != scratch_required
        or type(scratch.get("freeBytes")) is not int
        or scratch["freeBytes"] < scratch_required
    ):
        raise ValueError(f"{arm}: scratch headroom mismatch")
    persistent = exact_keys(
        value.get("persistent"),
        {"freeBytes", "requiredBytes", "remainingConditions"},
        f"{arm} persistent storage",
    )
    completed = sum(
        path.is_file() and path.stat().st_mtime <= recorded_at for path in scheduled_manifests
    )
    remaining = len(scheduled_manifests) - completed
    persistent_required = runtime.get("minimumPersistentFreeBytes")
    per_remaining = runtime.get("persistentBytesPerRemainingCondition")
    if type(persistent_required) is not int or type(per_remaining) is not int:
        raise ValueError("guardian protocol persistent storage contract is malformed")
    expected_required = persistent_required + remaining * per_remaining
    if (
        persistent.get("remainingConditions") != remaining
        or persistent.get("requiredBytes") != expected_required
        or type(persistent.get("freeBytes")) is not int
        or persistent["freeBytes"] < expected_required
    ):
        raise ValueError(f"{arm}: persistent headroom mismatch")
    memory = exact_keys(value.get("memory"), {"availableBytes", "requiredBytes"}, f"{arm} memory")
    memory_required = runtime.get("minimumAvailableMemoryBytes")
    if (
        memory.get("requiredBytes") != memory_required
        or type(memory.get("availableBytes")) is not int
        or memory["availableBytes"] < memory_required
    ):
        raise ValueError(f"{arm}: memory headroom mismatch")
    load_average = value.get("loadAverage")
    valid_load = (isinstance(load_average, str) and bool(load_average)) or (
        isinstance(load_average, list)
        and len(load_average) == 3
        and all(
            not isinstance(item, bool) and isinstance(item, (int, float)) and math.isfinite(item)
            for item in load_average
        )
    )
    if not valid_load:
        raise ValueError(f"{arm}: load average is malformed")
    return gpu["index"]


def _validate_launch(
    launch: Artifact,
    *,
    arm_name: str,
    attempt: int,
    workers: int,
    arm: Mapping[str, Any],
    source_commit: str,
    gpu: int,
    report: Artifact,
    replay: Artifact,
    resource: Artifact,
    execution: Execution,
    protocol: Artifact,
    base_protocol: Artifact,
    retry: Artifact | None,
    repo: Path,
) -> None:
    value = exact_keys(launch.value, LAUNCH_KEYS, f"{arm_name} launch")
    runtime = protocol.value.get("runtime", {})
    checkpoint, catalog, common = _report_contract(protocol.value)
    if (
        value.get("schemaVersion") != "arc-v34-guardian-launch-v1"
        or value.get("condition") != arm_name
        or value.get("attempt") != attempt
        or value.get("workers") != workers
        or value.get("gpu") != gpu
        or value.get("sourceCommit") != source_commit
        or value.get("watchdogSeconds") != runtime.get("watchdogSeconds")
        or value.get("watchdogKillAfterSeconds") != runtime.get("watchdogKillAfterSeconds")
        or value.get("seed0") != SEED0
        or value.get("games") != GAMES
        or value.get("seedMax") != SEED_MAX
        or value.get("commonDecode") != common
        or value.get("arm") != arm
        or value.get("checkpoint") != {"path": checkpoint.get("path"), "sha256": checkpoint.get("sha256")}
        or value.get("catalog") != {"path": catalog.get("path"), "sha256": catalog.get("sha256")}
    ):
        raise ValueError(f"{arm_name}: launch contract mismatch")
    _path_hash_matches(
        value.get("guardianExecutionLock"), execution.artifact, repo, f"{arm_name} launch execution lock"
    )
    _path_hash_matches(value.get("resourceSnapshot"), resource, repo, f"{arm_name} launch resource")
    if retry is None:
        if value.get("retryJustification") is not None:
            raise ValueError(f"{arm_name}: attempt 1 launch names a retry justification")
    else:
        _path_hash_matches(
            value.get("retryJustification"), retry, repo, f"{arm_name} launch retry justification"
        )
    socket = report.value.get("decode", {}).get("inferenceSocket")
    argv = [
        "scripts/evaluate-solo-checkpoint.mjs",
        "--weights",
        str(checkpoint.get("path")),
        "--catalog",
        str(catalog.get("path")),
        "--source-commit",
        source_commit,
        "--infer-socket",
        str(socket),
        "--policy-obs-version",
        _js_number(common.get("policyObsVersion")),
        "--games",
        str(GAMES),
        "--workers",
        str(workers),
        "--seed0",
        str(SEED0),
        "--max-rounds",
        _js_number(common.get("maxRounds")),
        "--max-status-level",
        _js_number(common.get("maxStatusLevel")),
        "--sample",
        "--temperature",
        _js_number(common.get("temperature")),
        "--include-games",
        *_arm_evaluator_args(arm, base_protocol.value),
        "--out",
        repo_label(report.path, repo),
    ]
    replay_argv = list(argv)
    replay_argv[replay_argv.index("--games") + 1] = str(REPLAY_GAMES)
    replay_argv[replay_argv.index("--workers") + 1] = str(REPLAY_WORKERS)
    replay_argv[replay_argv.index("--out") + 1] = repo_label(replay.path, repo)
    if value.get("evaluatorArgs") != argv or value.get("replayEvaluatorArgs") != replay_argv:
        raise ValueError(f"{arm_name}: launch evaluator argv mismatch")


def validate_retry_justification(
    artifact: Artifact,
    *,
    arm: str,
    source_commit: str,
    execution_lock: Artifact,
    repo: Path,
) -> None:
    value = exact_keys(
        artifact.value,
        {
            "schemaVersion",
            "condition",
            "attempt",
            "reason",
            "reasonCode",
            "infrastructureAttributed",
            "identicalSeedRetry",
            "outcomesInspected",
            "attempt1ReportExisted",
            "attempt1ReplayReportExisted",
            "sourceCommit",
            "guardianExecutionLockSha256",
            "seed0",
            "games",
            "seedMax",
            "failureEvidence",
        },
        f"{arm} retry justification",
    )
    retryable = {"server-start": 90, "process-interrupted": 92}
    reason = value.get("reason")
    if (
        value.get("schemaVersion") != "arc-v34-guardian-retry-justification-v1"
        or value.get("condition") != arm
        or value.get("attempt") != 2
        or value.get("reasonCode") not in retryable
        or value.get("infrastructureAttributed") is not True
        or value.get("identicalSeedRetry") is not True
        or value.get("outcomesInspected") is not False
        or value.get("attempt1ReportExisted") is not False
        or value.get("attempt1ReplayReportExisted") is not False
        or value.get("sourceCommit") != source_commit
        or value.get("guardianExecutionLockSha256") != execution_lock.sha256
        or value.get("seed0") != SEED0
        or value.get("games") != GAMES
        or value.get("seedMax") != SEED_MAX
        or not isinstance(reason, str)
        or not reason
    ):
        raise ValueError(f"{arm}: retry justification is not an identical outcome-blind retry")
    if (
        not re.search(
            r"infra|server|socket|cuda|gpu|oom|process|signal|host|machine|power|filesystem|disk|network|runtime|interrupt|service",
            reason,
            re.IGNORECASE,
        )
        or re.search(
            r"outcome|result|win|victor|score|\bvp\b|stall|malform|missing seed|duplicate|provenance|replay|safety|integrity|weak|strength|guardian result",
            reason,
            re.IGNORECASE,
        )
    ):
        raise ValueError(f"{arm}: retry reason is not outcome-blind infrastructure evidence")
    failure = verify_file_record(
        value["failureEvidence"], repo, f"{arm} attempt-1 failure evidence", expect_json=True
    )
    assert isinstance(failure, Artifact)
    failure_value = exact_keys(
        failure.value,
        {
            "schemaVersion",
            "condition",
            "attempt",
            "runtimeError",
            "reasonCode",
            "exitCode",
            "reportExists",
            "replayReportExists",
            "outcomesInspected",
            "sourceCommit",
            "guardianExecutionLockSha256",
            "files",
        },
        f"{arm} attempt-1 failure evidence",
    )
    if (
        failure_value.get("schemaVersion") != "arc-v34-guardian-attempt-failure-v1"
        or failure_value.get("condition") != arm
        or failure_value.get("attempt") != 1
        or failure_value.get("reasonCode") != value["reasonCode"]
        or failure_value.get("exitCode") != retryable[value["reasonCode"]]
        or failure_value.get("runtimeError") is not True
        or failure_value.get("reportExists") is not False
        or failure_value.get("replayReportExists") is not False
        or failure_value.get("outcomesInspected") is not False
        or failure_value.get("sourceCommit") != source_commit
        or failure_value.get("guardianExecutionLockSha256") != execution_lock.sha256
    ):
        raise ValueError(f"{arm}: attempt-1 failure is not retry eligible")
    failure_files = exact_keys(
        failure_value.get("files"),
        {"launch", "resourceSnapshot", "launchPid", "exitCode", "inferLog", "stdout", "stderr"},
        f"{arm} attempt-1 failure files",
    )
    for name, record in failure_files.items():
        verify_file_record(record, repo, f"{arm} attempt-1 failure {name}")
    for forbidden in ("report.json", "replay-report.json"):
        if (failure.path.parent / forbidden).exists():
            raise ValueError(f"{arm}: attempt-1 {forbidden} exists; retry was forbidden")


def load_conditions(
    manifest_paths: Sequence[Path],
    *,
    repo: Path,
    protocol: Artifact,
    guardians: Sequence[Mapping[str, str]],
    authorization: Authorization,
    execution: Execution,
) -> dict[str, Condition]:
    expected = (REFERENCE_ARM, *authorization.authorized)
    if len(manifest_paths) != len(expected):
        raise ValueError("guardian condition set must contain one raw plus every authorized arm")
    checkpoint, catalog, common = _report_contract(protocol.value)
    conditions: dict[str, Condition] = {}
    phase2_rows = {
        row.get("arm"): row
        for row in authorization.phase2.value.get("arms", [])
        if isinstance(row, dict) and isinstance(row.get("arm"), str)
    }
    assignment_algorithm = protocol_guardian_block(protocol.value).get("assignment", {}).get("algorithm")
    scheduled_manifests = tuple(Path(path).resolve() for path in manifest_paths)
    for supplied_path, expected_arm in zip(manifest_paths, expected, strict=True):
        manifest = load_json(supplied_path, f"guardian condition {expected_arm}")
        sidecar = manifest.path.with_name(manifest.path.name + ".sha256")
        expected_sidecar = f"{manifest.sha256}  {manifest.path.name}\n"
        if not sidecar.is_file() or sidecar.read_text() != expected_sidecar:
            raise ValueError(f"{expected_arm}: immutable completion sidecar is missing or invalid")
        value = exact_keys(manifest.value, CONDITION_KEYS, f"{expected_arm} condition")
        if (
            value.get("schemaVersion") != CONDITION_SCHEMA
            or value.get("valid") is not True
            or value.get("immutable") is not True
            or value.get("condition") != expected_arm
            or value.get("sourceCommit") != execution.artifact.value["sourceCommit"]
            or value.get("seed0") != SEED0
            or value.get("games") != GAMES
            or value.get("seedMax") != SEED_MAX
            or value.get("commonDecode") != common
            or value.get("checkpoint") != {"path": checkpoint.get("path"), "sha256": checkpoint.get("sha256")}
            or value.get("catalog") != {"path": catalog.get("path"), "sha256": catalog.get("sha256")}
        ):
            raise ValueError(f"{expected_arm}: completion contract mismatch")
        attempt = value.get("attempt")
        if attempt not in (1, 2):
            raise ValueError(f"{expected_arm}: invalid attempt")
        workers = value.get("workers")
        expected_workers = (
            24
            if expected_arm == REFERENCE_ARM
            else phase2_rows.get(expected_arm, {}).get("selectedWorkers")
        )
        if type(workers) is not int or workers != expected_workers:
            raise ValueError(f"{expected_arm}: worker metadata mismatch")
        expected_arm_metadata = {**_expected_arm(protocol.value, expected_arm), "selectedWorkers": workers}
        if value.get("arm") != expected_arm_metadata:
            raise ValueError(f"{expected_arm}: arm metadata mismatch")
        guardians_evidence = exact_keys(
            value.get("guardians"), {"assignment", "ordered", "countByName"}, f"{expected_arm} guardians"
        )
        ordered = [{"id": row["id"], "name": row["name"]} for row in guardians]
        counts_by_name = {
            row["name"]: EXPECTED_GUARDIAN_COUNTS[index] for index, row in enumerate(guardians)
        }
        if (
            guardians_evidence.get("assignment") != assignment_algorithm
            or guardians_evidence.get("ordered") != ordered
            or guardians_evidence.get("countByName") != counts_by_name
        ):
            raise ValueError(f"{expected_arm}: guardian schedule evidence mismatch")
        inputs_expected = set(CONDITION_INPUT_KEYS)
        if attempt == 2:
            inputs_expected.add("retryJustification")
        inputs = exact_keys(value.get("inputs"), inputs_expected, f"{expected_arm} inputs")
        loaded = _condition_input_artifacts(inputs, repo, expected_arm)
        assert isinstance(loaded["guardianExecutionLock"], Artifact)
        assert isinstance(loaded["guardianAuthorization"], Artifact)
        assert isinstance(loaded["guardianToolingLock"], Artifact)
        assert isinstance(loaded["guardianProtocol"], Artifact)
        record_matches(inputs["guardianExecutionLock"], execution.artifact, repo, f"{expected_arm} execution lock")
        record_matches(inputs["guardianAuthorization"], authorization.artifact, repo, f"{expected_arm} authorization")
        record_matches(inputs["guardianToolingLock"], execution.tooling_lock, repo, f"{expected_arm} tooling lock")
        record_matches(inputs["guardianProtocol"], protocol, repo, f"{expected_arm} protocol")
        record_matches(inputs["guardianPreflight"], execution.preflight, repo, f"{expected_arm} preflight")
        base_protocol = verify_file_record(
            protocol.value["base"]["protocol"], repo, "guardian protocol base protocol", expect_json=True
        )
        strength_protocol = verify_file_record(
            protocol.value["base"]["strengthProtocol"],
            repo,
            "guardian protocol strength protocol",
            expect_json=True,
        )
        assert isinstance(base_protocol, Artifact) and isinstance(strength_protocol, Artifact)
        record_matches(inputs["baseProtocol"], base_protocol, repo, f"{expected_arm} base protocol")
        record_matches(
            inputs["strengthProtocol"], strength_protocol, repo, f"{expected_arm} strength protocol"
        )
        systems_ref = authorization.phase2.value.get("inputs", {}).get("systemsEligibility", {})
        if not isinstance(systems_ref, dict) or set(systems_ref) != {"path", "sha256"}:
            raise ValueError("Phase 2 systems-eligibility reference is malformed")
        systems = load_json(resolve_path(systems_ref["path"], repo), "Phase 2 systems eligibility")
        if systems.sha256 != systems_ref["sha256"]:
            raise ValueError("Phase 2 systems eligibility is hash-invalid")
        record_matches(inputs["systemsEligibility"], systems, repo, f"{expected_arm} systems eligibility")
        retry: Artifact | None = None
        if attempt == 2:
            retry = loaded["retryJustification"]
            assert isinstance(retry, Artifact)
            validate_retry_justification(
                retry,
                arm=expected_arm,
                source_commit=value["sourceCommit"],
                execution_lock=execution.artifact,
                repo=repo,
            )
        for name in ("exitCode", "replayExitCode"):
            path = loaded[name]
            assert isinstance(path, Path)
            if path.read_text().strip() != "0":
                raise ValueError(f"{expected_arm}: {name} is nonzero")
        launch_pid = loaded["launchPid"]
        assert isinstance(launch_pid, Path)
        if not re.fullmatch(r"\d+", launch_pid.read_text().strip()):
            raise ValueError(f"{expected_arm}: launch PID is invalid")
        report = loaded["report"]
        replay = loaded["replayReport"]
        assert isinstance(report, Artifact) and isinstance(replay, Artifact)
        rows = validate_report(
            report.value,
            arm=expected_arm,
            expected_workers=workers,
            source_commit=value["sourceCommit"],
            protocol=protocol.value,
            guardians=guardians,
        )
        _validate_replay(report, replay, expected_arm)
        resource = loaded["resourceSnapshot"]
        launch = loaded["launch"]
        assert isinstance(resource, Artifact) and isinstance(launch, Artifact)
        gpu = _validate_resource_snapshot(
            resource,
            arm=expected_arm,
            workers=workers,
            source_commit=value["sourceCommit"],
            execution=execution,
            protocol=protocol,
            repo=repo,
            scheduled_manifests=scheduled_manifests,
        )
        _validate_launch(
            launch,
            arm_name=expected_arm,
            attempt=attempt,
            workers=workers,
            arm=expected_arm_metadata,
            source_commit=value["sourceCommit"],
            gpu=gpu,
            report=report,
            replay=replay,
            resource=resource,
            execution=execution,
            protocol=protocol,
            base_protocol=base_protocol,
            retry=retry,
            repo=repo,
        )
        stalls = sum(row["stalled"] for row in rows.values())
        if value.get("stalls") != stalls:
            raise ValueError(f"{expected_arm}: manifest stalls differ from report")
        inference = exact_keys(value.get("inference"), INFERENCE_KEYS, f"{expected_arm} completion inference")
        if inference != report.value.get("inference"):
            raise ValueError(f"{expected_arm}: completion inference differs from report")
        telemetry = exact_keys(value.get("telemetry"), TELEMETRY_KEYS, f"{expected_arm} telemetry")
        search = report.value.get("performance", {}).get("search")
        if not isinstance(search, dict):
            search = {}
        expected_telemetry = {
            "plannerMode": expected_arm_metadata["kind"],
            "strategicDecisions": search.get("decisions", 0),
            "strategicSimulations": search.get("simulations", 0),
            "decisionWallMsP50": search.get("decisionWallMsP50"),
            "decisionWallMsP95": search.get("decisionWallMsP95"),
            "byPhase": search.get("byPhase", {"navigation": 0, "encounter": 0}),
            "wallSeconds": report.value.get("performance", {}).get("wallSeconds"),
        }
        if telemetry != expected_telemetry:
            raise ValueError(f"{expected_arm}: telemetry differs from the report")
        integrity = exact_keys(value.get("integrity"), INTEGRITY_KEYS, f"{expected_arm} integrity")
        if integrity.get("derivedOnlyAfterStrictValidation") is not True:
            raise ValueError(f"{expected_arm}: integrity is not strictly derived")
        counters = {
            key: nonnegative_int(integrity[key], f"{expected_arm} {key}")
            for key in INTEGRITY_COUNTER_KEYS
        }
        if any(counters.values()):
            raise ValueError(f"{expected_arm}: safety/provenance integrity failure")
        evidence = exact_keys(
            integrity.get("evidence"),
            {"informationSafety", "replay", "serving", "provenance"},
            f"{expected_arm} integrity evidence",
        )
        information_safety = exact_keys(
            evidence["informationSafety"], {"guardianPreflight"}, f"{expected_arm} safety evidence"
        )
        record_matches(
            information_safety["guardianPreflight"],
            execution.preflight,
            repo,
            f"{expected_arm} safety preflight",
        )
        replay_evidence = exact_keys(
            evidence["replay"],
            {"seed0", "games", "workers", "exactPerGameEquality", "mismatches", "stalls"},
            f"{expected_arm} replay evidence",
        )
        if replay_evidence != {
            "seed0": SEED0,
            "games": REPLAY_GAMES,
            "workers": REPLAY_WORKERS,
            "exactPerGameEquality": True,
            "mismatches": 0,
            "stalls": replay.value.get("stalls"),
        }:
            raise ValueError(f"{expected_arm}: replay evidence mismatch")
        infer_log = loaded["inferLog"]
        assert isinstance(infer_log, Path)
        lifecycle = _parse_infer_log(infer_log, expected_arm)
        serving_evidence = exact_keys(
            evidence["serving"],
            {"servingLines", "shutdownLines", "errorLines", "requests", "rows", "batches"},
            f"{expected_arm} serving evidence",
        )
        if serving_evidence != {key: lifecycle[key] for key in serving_evidence}:
            raise ValueError(f"{expected_arm}: serving evidence mismatch")
        provenance = exact_keys(
            evidence["provenance"],
            {
                "acceptedGameSummariesChecked",
                "evaluatorCrossGameHandshakeInvariant",
                "fixedInferenceProcess",
                "reloadLines",
            },
            f"{expected_arm} provenance evidence",
        )
        if provenance != {
            "acceptedGameSummariesChecked": GAMES,
            "evaluatorCrossGameHandshakeInvariant": True,
            "fixedInferenceProcess": True,
            "reloadLines": lifecycle["reloadLines"],
        }:
            raise ValueError(f"{expected_arm}: provenance reload evidence mismatch")
        conditions[expected_arm] = Condition(expected_arm, manifest, report, replay, rows, stalls)
    if tuple(conditions) != expected:
        raise ValueError(f"guardian condition order must be {list(expected)}")
    return conditions


def guardian_effects(
    indexed: Mapping[str, Mapping[int, Mapping[str, Any]]], authorized: Sequence[str]
) -> tuple[dict[str, np.ndarray], np.ndarray]:
    raw = indexed.get(REFERENCE_ARM)
    if raw is None:
        raise ValueError("guardian analysis has no shared raw condition")
    seeds = range(SEED0, SEED_MAX + 1)
    guardian_index = np.fromiter((seed % GUARDIAN_COUNT for seed in seeds), dtype=np.int8, count=GAMES)
    effects: dict[str, np.ndarray] = {}
    for arm in authorized:
        candidate = indexed.get(arm)
        if candidate is None:
            raise ValueError(f"guardian analysis is missing authorized arm {arm}")
        values = np.fromiter(
            (
                100.0 * (float(candidate[seed]["trueWin"]) - float(raw[seed]["trueWin"]))
                for seed in seeds
            ),
            dtype=np.float64,
            count=GAMES,
        )
        effects[arm] = values
    return effects, guardian_index


def _bootstrap_maxima(
    matrix: np.ndarray,
    guardian_index: np.ndarray,
    observed: np.ndarray,
    standard_errors: np.ndarray,
    *,
    draws: int,
    rng_seed: int,
    chunk_size: int,
) -> np.ndarray:
    """Global complete-seed bootstrap; one sampled index vector is shared by all arms."""

    n, arms = matrix.shape
    guardian_count = int(guardian_index.max()) + 1
    active = standard_errors > 0
    maxima = np.zeros(draws, dtype=np.float64)
    if not np.any(active):
        return maxima
    rng = np.random.Generator(np.random.PCG64(rng_seed))
    masks = [guardian_index == guardian for guardian in range(guardian_count)]
    for start in range(0, draws, chunk_size):
        count = min(chunk_size, draws - start)
        indices = rng.integers(0, n, size=(count, n))
        multiplicities = np.zeros((count, n), dtype=np.int16)
        for row in range(count):
            multiplicities[row] = np.bincount(indices[row], minlength=n)
        bootstrap = np.empty((count, arms * guardian_count), dtype=np.float64)
        for guardian, mask in enumerate(masks):
            weights = multiplicities[:, mask]
            denominators = weights.sum(axis=1)
            if np.any(denominators == 0):
                raise ValueError("global bootstrap produced an empty guardian cell")
            means = weights @ matrix[mask] / denominators[:, None]
            bootstrap[:, guardian::guardian_count] = means
        studentized = (bootstrap[:, active] - observed[active]) / standard_errors[active]
        maxima[start : start + count] = np.max(studentized, axis=1)
    return maxima


def guardian_max_t(
    effects: Mapping[str, np.ndarray],
    guardian_index: np.ndarray,
    guardian_names: Sequence[str],
    *,
    draws: int = BOOTSTRAP_DRAWS,
    rng_seed: int = BOOTSTRAP_SEED,
    confidence: float = CONFIDENCE,
    family_size: int = FROZEN_FAMILY_SIZE,
    chunk_size: int = 32,
) -> dict[str, Any]:
    if not effects:
        raise ValueError("guardian max-t requires at least one authorized arm")
    if draws <= 0 or family_size != FROZEN_FAMILY_SIZE or not (0 < confidence < 1):
        raise ValueError("invalid guardian max-t configuration")
    arms = tuple(effects)
    if len(arms) > 6:
        raise ValueError("guardian max-t cannot exceed six arms")
    arrays = [np.asarray(effects[arm], dtype=np.float64) for arm in arms]
    lengths = {array.shape for array in arrays}
    if len(lengths) != 1:
        raise ValueError("guardian effect arrays have unequal shapes")
    shape = lengths.pop()
    if len(shape) != 1 or shape[0] < 2:
        raise ValueError("guardian effects require at least two seeds")
    n = shape[0]
    guardian_index = np.asarray(guardian_index)
    if guardian_index.shape != (n,) or guardian_index.dtype.kind not in "iu":
        raise ValueError("guardian index vector is malformed")
    guardian_count = len(guardian_names)
    if guardian_count <= 0 or set(np.unique(guardian_index)) != set(range(guardian_count)):
        raise ValueError("guardian index coverage is malformed")
    matrix = np.column_stack(arrays)
    if not np.isfinite(matrix).all():
        raise ValueError("guardian effects must be finite")
    observed = np.empty(len(arms) * guardian_count, dtype=np.float64)
    standard_errors = np.empty_like(observed)
    counts: list[int] = []
    for guardian in range(guardian_count):
        mask = guardian_index == guardian
        count = int(mask.sum())
        counts.append(count)
        if count < 2:
            raise ValueError("guardian cells require at least two paired seeds")
        values = matrix[mask]
        observed[guardian::guardian_count] = values.mean(axis=0)
        standard_errors[guardian::guardian_count] = values.std(axis=0, ddof=1) / math.sqrt(count)
    maxima = _bootstrap_maxima(
        matrix,
        guardian_index,
        observed,
        standard_errors,
        draws=draws,
        rng_seed=rng_seed,
        chunk_size=chunk_size,
    )
    rank = math.ceil(confidence * draws) - 1
    empirical = float(np.partition(maxima, rank)[rank])
    floor = float(NormalDist().inv_cdf(1 - (1 - confidence) / family_size))
    critical = max(empirical, floor)
    selected_by = "empirical" if empirical > floor else "fixed60NormalFloor"
    endpoints: dict[str, dict[str, Any]] = {}
    for arm_index, arm in enumerate(arms):
        cells: dict[str, Any] = {}
        for guardian, name in enumerate(guardian_names):
            index = arm_index * guardian_count + guardian
            mean = float(observed[index])
            se = float(standard_errors[index])
            cells[name] = guardian_cell(mean, se, critical, counts[guardian])
        endpoints[arm] = cells
    return {
        "method": "global complete-seed centered paired one-sided max-t bootstrap",
        "studentization": "(bootstrapMean-observedMean)/originalPairedSE",
        "standardError": "sample standard deviation ddof=1 divided by sqrt(n_cell)",
        "draws": draws,
        "rng": "numpy.random.Generator(numpy.random.PCG64)",
        "rngSeed": rng_seed,
        "confidence": confidence,
        "nearestRankIndex": rank,
        "registeredFamilySize": family_size,
        "observedCellCount": len(arms) * guardian_count,
        "nonzeroStandardErrorCellCount": int(np.count_nonzero(standard_errors)),
        "guardianCounts": counts,
        "empiricalCritical": empirical,
        "fixed60NormalFloor": floor,
        "critical": critical,
        "criticalSelectedBy": selected_by,
        "bootstrapMaximaSha256": hashlib.sha256(maxima.tobytes()).hexdigest(),
        "endpoints": endpoints,
    }


def guardian_cell(mean: float, standard_error: float, critical: float, games: int) -> dict[str, Any]:
    mean = finite_number(mean, "guardian cell mean")
    standard_error = finite_number(standard_error, "guardian cell standard error")
    critical = finite_number(critical, "guardian critical value")
    if standard_error < 0 or critical < 0 or type(games) is not int or games < 2:
        raise ValueError("guardian cell inputs are invalid")
    lower = mean if standard_error == 0.0 else mean - critical * standard_error
    point_pass = mean >= POINT_MIN
    lower_pass = lower > LOWER_STRICT_MIN
    return {
        "games": games,
        "mean": mean,
        "standardError": standard_error,
        "zeroStandardError": standard_error == 0.0,
        "simultaneousLower": lower,
        "pointAtLeastMinus5": point_pass,
        "lowerStrictlyAboveMinus10": lower_pass,
        "cellPass": point_pass and lower_pass,
    }


def analyze_guardian(
    *,
    repo: Path,
    protocol: Artifact,
    authorization: Artifact,
    execution_lock: Artifact | None,
    manifest_paths: Sequence[Path],
    verify_git: bool = True,
) -> dict[str, Any]:
    repo = repo.resolve()
    guardians = validate_guardian_protocol(protocol, repo)
    authorized = validate_authorization(authorization, repo)
    protocol_base = protocol.value["base"]
    record_matches(
        protocol_base["strengthToolingLock"],
        authorized.strength_lock,
        repo,
        "authorization strength tooling lock",
    )
    if protocol_base["sourceCommit"] != authorized.artifact.value["sourceCommit"]:
        raise ValueError("guardian authorization source commit differs from guardian protocol")
    guardian_names = [row["name"] for row in guardians]
    common_inputs: dict[str, Any] = {
        "guardianProtocol": artifact_record(protocol, repo),
        "guardianAuthorization": artifact_record(authorized.artifact, repo),
        "phase2Analysis": artifact_record(authorized.phase2, repo),
        "strengthToolingLock": artifact_record(authorized.strength_lock, repo),
    }
    if not authorized.authorized:
        if execution_lock is not None or manifest_paths:
            raise ValueError("K=0 forbids an execution lock and guardian condition manifests")
        return {
            "schemaVersion": ANALYSIS_SCHEMA,
            "valid": True,
            "promotionEligible": False,
            "guardianUse": True,
            "inputs": common_inputs,
            "contract": {
                "seed0": SEED0,
                "games": GAMES,
                "seedMax": SEED_MAX,
                "referenceArm": REFERENCE_ARM,
                "authorizedArms": [],
                "phase2RankedArms": [],
                "guardians": list(guardians),
                "python": platform.python_version(),
                "numpy": np.__version__,
            },
            "simultaneousFamily": None,
            "arms": [],
            "guardianSurvivors": [],
            "selectedArm": None,
            "decision": {
                "laneAStatus": "closed-no-core-pass",
                "laneBReferenceArm": REFERENCE_ARM,
                "guardianExecuted": False,
                "phase2RankingPreserved": True,
                "winnerSelected": False,
                **{key: False for key in sorted(AUTHORIZATION_FLAGS)},
            },
        }
    if execution_lock is None:
        raise ValueError("K>0 requires a guardian execution lock")
    execution = validate_execution_lock(
        execution_lock,
        authorization=authorized,
        protocol=protocol,
        repo=repo,
        verify_git=verify_git,
    )
    conditions = load_conditions(
        manifest_paths,
        repo=repo,
        protocol=protocol,
        guardians=guardians,
        authorization=authorized,
        execution=execution,
    )
    raw = conditions[REFERENCE_ARM]
    if raw.stalls:
        raise ValueError("raw guardian reference stalled; the shared campaign is invalid")
    indexed = {arm: condition.rows for arm, condition in conditions.items()}
    for seed in range(SEED0, SEED_MAX + 1):
        expected_guardian = guardian_names[seed % GUARDIAN_COUNT]
        if any(indexed[arm][seed]["guardian"] != expected_guardian for arm in conditions):
            raise ValueError(f"seed {seed}: cross-condition guardian pairing mismatch")
    effects, guardian_index = guardian_effects(indexed, authorized.authorized)
    family = guardian_max_t(effects, guardian_index, guardian_names)
    arm_results: list[dict[str, Any]] = []
    survivors: list[str] = []
    for arm in authorized.authorized:
        cells = family["endpoints"][arm]
        cell_pass = all(cell["cellPass"] for cell in cells.values())
        stalls_zero = conditions[arm].stalls == 0
        survives = cell_pass and stalls_zero
        if survives:
            survivors.append(arm)
        arm_results.append(
            {
                "arm": arm,
                "phase2Rank": authorized.ranked.index(arm) + 1,
                "stalls": conditions[arm].stalls,
                "gates": {
                    "allGuardianCellsPass": cell_pass,
                    "candidateStallsZero": stalls_zero,
                },
                "guardianCells": cells,
                "survives": survives,
            }
        )
    selected = next((arm for arm in authorized.ranked if arm in survivors), None)
    common_inputs.update(
        {
            "guardianExecutionLock": artifact_record(execution.artifact, repo),
            "guardianToolingLock": artifact_record(execution.tooling_lock, repo),
            "guardianPreflight": artifact_record(execution.preflight, repo),
            "conditions": [
                {
                    "arm": arm,
                    "manifest": artifact_record(conditions[arm].manifest, repo),
                    "report": artifact_record(conditions[arm].report, repo),
                    "replayReport": artifact_record(conditions[arm].replay, repo),
                }
                for arm in conditions
            ],
        }
    )
    return {
        "schemaVersion": ANALYSIS_SCHEMA,
        "valid": True,
        "promotionEligible": False,
        "guardianUse": True,
        "inputs": common_inputs,
        "contract": {
            "seed0": SEED0,
            "games": GAMES,
            "seedMax": SEED_MAX,
            "referenceArm": REFERENCE_ARM,
            "authorizedArms": list(authorized.authorized),
            "phase2RankedArms": list(authorized.ranked),
            "guardians": list(guardians),
            "python": platform.python_version(),
            "numpy": np.__version__,
        },
        "simultaneousFamily": family,
        "arms": arm_results,
        "guardianSurvivors": survivors,
        "selectedArm": selected,
        "decision": {
            "laneAStatus": "guardian-survivor-selected" if selected else "closed-no-guardian-survivor",
            "laneBReferenceArm": REFERENCE_ARM,
            "guardianExecuted": True,
            "phase2RankingPreserved": True,
            "winnerSelected": selected is not None,
            **{key: False for key in sorted(AUTHORIZATION_FLAGS)},
        },
    }


def deterministic_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n"


def write_immutable_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sidecar = path.with_name(path.name + ".sha256")
    if path.exists() or sidecar.exists():
        raise FileExistsError(f"refusing to overwrite immutable output {path}")
    payload = deterministic_json(value)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(payload)
    except BaseException:
        try:
            path.unlink()
        except OSError:
            pass
        raise
    digest = hashlib.sha256(payload.encode()).hexdigest()
    try:
        side_descriptor = os.open(sidecar, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
        with os.fdopen(side_descriptor, "w") as handle:
            handle.write(f"{digest}  {path.name}\n")
    except BaseException:
        try:
            path.unlink()
        except OSError:
            pass
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--authorization", type=Path, required=True)
    parser.add_argument("--execution-lock", type=Path)
    parser.add_argument("--condition", action="append", type=Path, default=[])
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--no-git-verify", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    protocol = load_json(args.protocol, "guardian execution protocol")
    authorization = load_json(args.authorization, "guardian authorization")
    execution = (
        load_json(args.execution_lock, "guardian execution lock") if args.execution_lock is not None else None
    )
    result = analyze_guardian(
        repo=args.repo,
        protocol=protocol,
        authorization=authorization,
        execution_lock=execution,
        manifest_paths=args.condition,
        verify_git=not args.no_git_verify,
    )
    write_immutable_json(args.out, result)
    print(deterministic_json(result), end="")


if __name__ == "__main__":
    main()
