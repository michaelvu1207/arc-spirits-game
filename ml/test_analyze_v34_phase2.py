from __future__ import annotations

import copy
import json
import math
import platform
import tempfile
import unittest
from pathlib import Path
from statistics import NormalDist

import numpy as np

from analyze_v34_phase2 import (
    Artifact,
    BOOTSTRAP_DRAWS,
    BOOTSTRAP_SEED,
    CONDITION_SCHEMA,
    FAMILY_SIZE,
    GAMES,
    LOCKED_TOOLING_FILES,
    OUTCOMES,
    REGISTERED_ARMS,
    SEED0,
    SEED_MAX,
    analyze_phase2,
    deterministic_json,
    evaluate_arm_gates,
    js_number_string,
    load_conditions,
    load_json,
    max_t_family,
    sha256,
    validate_phase2_authorization,
    validate_report,
    validate_strength_lock,
)


IMPLEMENTATION_COMMIT = "b" * 40
SOURCE_COMMIT = "a" * 40
GUARDIANS = (
    "Bubblepop",
    "Embers",
    "Fjorn",
    "Human Avatar",
    "Lumina",
    "Myrtle",
    "Pixia",
    "Prox",
    "Taron",
    "Void Avatar",
)


def write_json(path: Path, value: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")
    return path


def write_text(path: Path, value: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)
    return path


def ref(root: Path, path: Path) -> dict[str, object]:
    return {"path": path.relative_to(root).as_posix(), "sha256": sha256(path)}


def file_record(root: Path, path: Path) -> dict[str, object]:
    return {
        "path": path.relative_to(root).as_posix(),
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
    }


def quantile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * q
    lo, hi = math.floor(index), math.ceil(index)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (index - lo)


def wilson(wins: int, games: int) -> dict[str, float]:
    z = 1.959963984540054
    p = wins / games
    z2 = z * z
    denominator = 1 + z2 / games
    center = (p + z2 / (2 * games)) / denominator
    radius = z * math.sqrt((p * (1 - p) + z2 / (4 * games)) / games) / denominator
    return {"lower": center - radius, "upper": center + radius}


def make_report(arm: str, *, candidate: bool) -> dict:
    rows: list[dict] = []
    for index in range(GAMES):
        seed = SEED0 + index
        raw_win = index % 2 == 0
        added_win = candidate and not raw_win and index < 492
        win = raw_win or added_win
        if candidate:
            final_vp = 31 if raw_win else (30 if added_win else 21)
            first30 = 24 if raw_win else (30 if added_win else None)
            post15 = 1.2
        else:
            final_vp = 30 if raw_win else 20
            first30 = 25 if raw_win else None
            post15 = 1.0
        cycle = {
            "vpAfterRound": {"1": 0},
            "first15Round": 10,
            "first30Round": first30,
            "decisions": 20,
            "productiveDecisions": 15,
            "optionalYieldDecisions": 1,
            "locationInteractions": 8,
            "summons": 3,
            "awakens": 2,
            "combats": 4,
            "rewards": 5,
            "pvpAttacks": 0,
            "finalAttackDice": 6,
            "finalSpirits": 5,
            "finalMaxBarrier": 3,
            "post15VpPerRound": post15,
        }
        rows.append(
            {
                "seed": seed,
                "guardian": GUARDIANS[seed % len(GUARDIANS)],
                "trueWin": win,
                "stalled": False,
                "finalVP": final_vp,
                "first30Round": first30,
                "post15VpPerRound": post15,
                "finalAttackDice": 6,
                "finalSpirits": 5,
                "finalMaxBarrier": 3,
                "cycle": cycle,
            }
        )
    wins = sum(row["trueWin"] for row in rows)
    vps = [row["finalVP"] for row in rows]
    first30 = [row["first30Round"] for row in rows if row["first30Round"] is not None]
    guardian_breakdown = []
    for guardian in GUARDIANS:
        group = [row for row in rows if row["guardian"] == guardian]
        group_wins = sum(row["trueWin"] for row in group)
        group_vp = [row["finalVP"] for row in group]
        guardian_breakdown.append(
            {
                "guardian": guardian,
                "games": len(group),
                "trueWins": group_wins,
                "trueWinRate": group_wins / len(group),
                "trueWinWilson95": wilson(group_wins, len(group)),
                "meanVP": sum(group_vp) / len(group_vp),
                "medianVP": quantile(group_vp, 0.5),
            }
        )
    decode = {
        "policyObsVersion": 2,
        "inferenceSocket": f"/dev/shm/{arm}.sock",
        "learnMonsterRewardChoices": False,
        "sample": True,
        "temperature": 0.55,
    }
    performance = {
        "wallSeconds": 100.0,
        "gamesPerSecond": 40.96,
        "workers": 8 if candidate else 24,
        "gameWallMsP50": 10.0,
        "gameWallMsP95": 20.0,
    }
    if candidate:
        decode["rerank"] = {"policyRankWeight": 0.25}
        performance["search"] = {
            "mode": "critic-rerank",
            "decisions": 8192,
            "simulations": 0,
            "byPhase": {"navigation": 4096, "encounter": 4096},
            "decisionWallMsP50": 1.0,
            "decisionWallMsP95": 2.0,
        }
    buckets = {
        "under15": sum(vp < 15 for vp in vps),
        "from15To19": sum(15 <= vp < 20 for vp in vps),
        "from20To24": sum(20 <= vp < 25 for vp in vps),
        "from25To26": sum(25 <= vp < 27 for vp in vps),
        "from27To29": sum(27 <= vp < 30 for vp in vps),
        "atLeast30WithoutStall": wins,
        "stalledAtLeast30": 0,
    }
    inference = {
        "format": "arc-entity-scorer-v2",
        "obsDim": 3419,
        "actDim": 104,
        "weightsPath": "checkpoint.pt",
        "weightsSha256": "0" * 64,  # Fixture replaces this after writing the checkpoint.
        "wire": "binary",
    }
    return {
        "schemaVersion": "solo-heldout-v2",
        "sourceCommit": IMPLEMENTATION_COMMIT,
        "weights": "checkpoint.pt",
        "weightsSha256": "0" * 64,
        "catalog": "catalog.json",
        "catalogSha256": "0" * 64,
        "inference": inference,
        "seed0": SEED0,
        "games": GAMES,
        "maxRounds": 30,
        "maxStatusLevel": 2,
        "decode": decode,
        "trueWins": wins,
        "trueWinRate": wins / GAMES,
        "trueWinWilson95": wilson(wins, GAMES),
        "namedWinRate": 1.0,
        "stalls": 0,
        "stallRate": 0.0,
        "reach15Rate": 1.0,
        "nearMiss27To29Rate": buckets["from27To29"] / GAMES,
        "vp": {
            "mean": sum(vps) / GAMES,
            "p10": quantile(vps, 0.1),
            "median": quantile(vps, 0.5),
            "p90": quantile(vps, 0.9),
            "min": min(vps),
            "max": max(vps),
        },
        "vpBuckets": buckets,
        "guardianBreakdown": guardian_breakdown,
        "first30Round": {"mean": sum(first30) / len(first30), "median": quantile(first30, 0.5)},
        "engine": {
            "meanPost15VpPerRound": sum(row["post15VpPerRound"] for row in rows) / GAMES,
            "meanFinalAttackDice": 6.0,
            "meanFinalSpirits": 5.0,
            "meanFinalMaxBarrier": 3.0,
        },
        "performance": performance,
        "perGame": rows,
    }


class Fixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        checkpoint = write_text(root / "checkpoint.pt", "frozen checkpoint")
        catalog = write_json(
            root / "catalog.json",
            {"guardians": [{"id": str(index), "name": name} for index, name in enumerate(GUARDIANS)]},
        )
        self.policy_sha = sha256(checkpoint)
        self.catalog_sha = sha256(catalog)
        self.base_value = self._base_protocol()
        self.base_path = write_json(root / "protocol.json", self.base_value)
        source_file = write_text(root / "source.txt", "frozen source")
        self.source_path = write_json(
            root / "artifacts/source-lock.json",
            {
                "schemaVersion": "arc-v34-source-lock-v1",
                "implementationCommit": SOURCE_COMMIT,
                "files": {"source.txt": sha256(source_file)},
                "authorization": {
                    "previewCalibrationSeedsOpen": True,
                    "systemsSeedsOpen": False,
                    "phase2SeedsOpen": False,
                    "guardianSeedsOpen": False,
                    "teacherSeedsOpen": False,
                    "finalDevelopmentSeedsOpen": False,
                    "hiddenSeedsOpen": False,
                    "multiplayerSeedsOpen": False,
                    "humanReferenceSeedsOpen": False,
                    "productionPromotionOpen": False,
                },
            },
        )
        self.strength_value = self._strength_protocol()
        strength_rel = "ml/experiments/v34-latency-first-expert-iteration/strength-protocol.json"
        self.strength_path = write_json(root / strength_rel, self.strength_value)
        self._write_original_chain()
        self._write_systems_and_authorization()
        self._write_tooling_files()
        self._write_strength_preflight_and_lock()
        self.manifest_paths = [
            self._write_condition("raw", candidate=False),
            self._write_condition("rerank-p025", candidate=True),
        ]
        self.base = load_json(self.base_path, "base")
        self.source = load_json(self.source_path, "source")
        self.strength = load_json(self.strength_path, "strength")
        self.systems_auth = load_json(self.systems_auth_path, "systems auth")
        self.systems = load_json(self.systems_path, "systems")
        self.phase_auth = load_json(self.phase_auth_path, "phase auth")
        self.lock = load_json(self.lock_path, "strength lock")

    def _base_protocol(self) -> dict:
        arms = [
            {"id": "rerank-p025", "kind": "critic-rerank", "policyRankWeight": 0.25},
            {"id": "rerank-p050", "kind": "critic-rerank", "policyRankWeight": 0.5},
            {"id": "rerank-p075", "kind": "critic-rerank", "policyRankWeight": 0.75},
            {"id": "rerank-p100", "kind": "critic-rerank", "policyRankWeight": 1.0},
            {"id": "heuristic-s4-h2", "kind": "heuristic-batched", "simulations": 4, "horizonRounds": 2},
            {"id": "heuristic-s8-h3", "kind": "heuristic-batched", "simulations": 8, "horizonRounds": 3},
        ]
        return {
            "schemaVersion": "arc-controlled-experiment-v1",
            "inputs": {
                "catalog": {"path": "catalog.json", "sha256": self.catalog_sha},
                "policy": {
                    "path": "checkpoint.pt",
                    "sha256": self.policy_sha,
                    "format": "arc-entity-scorer-v2",
                    "obsDim": 3419,
                    "actDim": 104,
                },
            },
            "commonDecode": {
                "seats": 1,
                "maxRounds": 30,
                "maxStatusLevel": 2,
                "guardianSchedule": "absolute-balanced",
                "selection": "hybrid",
                "sample": True,
                "temperature": 0.55,
                "learnMonsterRewardChoices": False,
                "policyObsVersion": 2,
                "inferenceWire": "binary",
                "planningScope": ["navigation", "encounter"],
                "minimumCandidates": 2,
            },
            "previewCalibration": {"seed0": 100, "games": 10},
            "systems": {
                "candidateArms": arms,
                "heuristicDecode": {"frac": 1.0, "valueWeight": 0.5, "navTemperature": 0.0},
                "binding": [
                    {"workers": 1, "decisionP95MsMax": 1000},
                    {"workers": 8, "decisionP95MsMax": 2000},
                ],
                "throughput": {"workerCounts": [4, 8, 12, 16, 24]},
            },
            "phase2": {
                "seed0": SEED0,
                "games": GAMES,
                "seedMax": SEED_MAX,
                "referenceArm": "raw",
                "registeredCandidateSlots": list(REGISTERED_ARMS),
                "family": {
                    "candidateSlots": 6,
                    "coreOutcomesPerSlot": 4,
                    "familySize": FAMILY_SIZE,
                    "draws": BOOTSTRAP_DRAWS,
                    "rngSeed": BOOTSTRAP_SEED,
                    "simultaneousConfidence": 0.95,
                    "familyNeverShrinksAfterSystemsRejection": True,
                },
                "gates": {
                    "pairedWinGainPointsMin": 3,
                    "pairedWinLowerBoundStrictlyAbove": 0,
                    "finalVpLowerBoundMin": 0,
                    "post15VpPerRoundLowerBoundMin": 0,
                    "censoredFirst30RoundUpperBoundMax": 0,
                    "stalls": 0,
                    "informationSafetyFailures": 0,
                    "replayMismatches": 0,
                    "servingErrors": 0,
                    "provenanceMismatches": 0,
                },
            },
        }

    def _strength_protocol(self) -> dict:
        return {
            "schemaVersion": "arc-v34-strength-protocol-v1",
            "base": {
                "protocolPath": "protocol.json",
                "protocolSha256": sha256(self.base_path),
                "sourceLockPath": "artifacts/source-lock.json",
                "sourceLockSha256": sha256(self.source_path),
                "catalogPath": "catalog.json",
                "catalogSha256": self.catalog_sha,
                "checkpointPath": "checkpoint.pt",
                "checkpointSha256": self.policy_sha,
            },
            "environment": {
                "executable": "ml/v34_stats_env/.venv/bin/python",
                "python": platform.python_version(),
                "numpy": np.__version__,
                "rng": "numpy.random.Generator(PCG64)",
                "exactFixtureRequired": True,
            },
            "commonDecode": {
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
            },
            "runtime": {
                "eligibleGpus": [0, 5, 6, 7],
                "excludedGpu": 4,
                "rawWorkers": 24,
                "minimumScratchFreeBytes": 17179869184,
            },
            "phase2": {
                "seed0": SEED0,
                "games": GAMES,
                "seedMax": SEED_MAX,
                "referenceArm": "raw",
                "registeredCandidateSlots": list(REGISTERED_ARMS),
                "outcomes": list(OUTCOMES),
                "family": {
                    "draws": BOOTSTRAP_DRAWS,
                    "rngSeed": BOOTSTRAP_SEED,
                    "candidateSlots": 6,
                    "outcomesPerSlot": 4,
                    "familySize": FAMILY_SIZE,
                    "confidence": 0.95,
                    "systemsRejectedSlotsRemainFailed": True,
                },
                "gates": {
                    "winPointGainMin": 3.0,
                    "winSimultaneousLowerStrictlyAbove": 0.0,
                    "finalVpSimultaneousLowerMin": -0.5,
                    "post15SimultaneousLowerMin": -0.025,
                    "censoredFirst30SimultaneousUpperMax": 0.5,
                    "stalls": 0,
                    "informationSafetyFailures": 0,
                    "replayMismatches": 0,
                    "servingErrors": 0,
                    "evaluationProvenanceMismatches": 0,
                    "bindingEvidenceHashesMustMatch": True,
                },
                "replayAudit": {
                    "seed0": SEED0,
                    "games": 64,
                    "seedMax": SEED0 + 63,
                    "workers": 8,
                    "exactPerGameEquality": True,
                    "sameInferenceProcess": True,
                },
                "integrityEvidence": {
                    "informationSafety": "fixture",
                    "replay": "fixture",
                    "serving": "fixture",
                    "provenance": "fixture",
                },
            },
            "guardian": {
                "guardiansFromFrozenCatalog": [
                    {"id": str(index), "name": name} for index, name in enumerate(GUARDIANS)
                ]
            },
        }

    def _write_original_chain(self) -> None:
        checks = {}
        for name in ("vitest", "python", "typecheck", "protocol", "shellSyntax", "determinization"):
            log = write_text(self.root / f"preflight/{name}.log", "ok\n")
            checks[name] = {"exitCode": 0, "log": log.relative_to(self.root).as_posix(), "logSha256": sha256(log)}
        preflight = write_json(
            self.root / "preflight/result.json",
            {
                "schemaVersion": "arc-v34-preflight-evidence-v1",
                "passed": True,
                "sourceLock": {"sha256": sha256(self.source_path), "implementationCommit": SOURCE_COMMIT},
                "checks": checks,
            },
        )
        collection = write_json(
            self.root / "preview-collection.json",
            {
                "schemaVersion": "arc-v34-preview-collection-v1",
                "seed0": 100,
                "games": 10,
                "completed": 10,
                "stalls": 0,
                "checkpoint": {"sha256": self.policy_sha},
                "catalog": {"sha256": self.catalog_sha},
                "inference": {"wire": "binary"},
                "previewInputs": [],
            },
        )
        calibration = write_json(
            self.root / "preview-calibration.json",
            {
                "schemaVersion": "arc-v34-preview-calibration-v1",
                "seed0": 100,
                "games": 10,
                "uniqueSeeds": 10,
                "candidateCount": 0,
                "finiteCandidateCount": 0,
                "terminalOverrides": {"mismatches": 0},
                "inputs": [],
                "passed": True,
            },
        )
        self.systems_auth_path = write_json(
            self.root / "systems-authorization.json",
            {
                "schemaVersion": "arc-v34-systems-authorization-v1",
                "strengthUse": False,
                "sourceLock": ref(self.root, self.source_path),
                "preflight": ref(self.root, preflight),
                "previewCollection": ref(self.root, collection),
                "previewCalibration": ref(self.root, calibration),
                "criticCalibrationPassed": True,
                "enabledCandidateArms": list(REGISTERED_ARMS),
                "disabledCandidateArms": {},
                "authorization": {
                    "systemsSeedsOpen": True,
                    "phase2SeedsOpen": False,
                    "guardianSeedsOpen": False,
                    "teacherSeedsOpen": False,
                    "finalDevelopmentSeedsOpen": False,
                    "hiddenSeedsOpen": False,
                    "multiplayerSeedsOpen": False,
                    "humanReferenceSeedsOpen": False,
                    "productionPromotionOpen": False,
                },
            },
        )

    def _write_systems_and_authorization(self) -> None:
        stage = write_json(self.root / "systems-stage.json", {"valid": True})
        arms = []
        for arm in REGISTERED_ARMS:
            if arm == "rerank-p025":
                arms.append(
                    {
                        "id": arm,
                        "enabledBeforeSystems": True,
                        "operationallyEligible": True,
                        "rejectionReason": None,
                        "selectedWorkers": 8,
                        "binding": {"binding-w1": 500.0, "binding-w8": 1000.0},
                        "stageReports": [ref(self.root, stage)],
                    }
                )
            else:
                arms.append(
                    {
                        "id": arm,
                        "enabledBeforeSystems": True,
                        "operationallyEligible": False,
                        "rejectionReason": "synthetic systems rejection",
                    }
                )
        self.systems_path = write_json(
            self.root / "systems-eligibility.json",
            {
                "schemaVersion": "arc-v34-systems-eligibility-v1",
                "strengthUse": False,
                "outcomesLoaded": False,
                "protocol": ref(self.root, self.base_path),
                "systemsAuthorization": ref(self.root, self.systems_auth_path),
                "arms": arms,
                "eligibleCandidateArms": ["rerank-p025"],
                "phase2MayOpen": True,
            },
        )
        self.phase_auth_path = write_json(
            self.root / "phase2-authorization.json",
            {
                "schemaVersion": "arc-v34-phase2-authorization-v1",
                "systemsEligibility": ref(self.root, self.systems_path),
                "registeredFamilyCandidateSlots": list(REGISTERED_ARMS),
                "eligibleCandidateArms": ["rerank-p025"],
                "authorization": {
                    "phase2SeedsOpen": True,
                    "guardianSeedsOpen": False,
                    "teacherSeedsOpen": False,
                    "finalDevelopmentSeedsOpen": False,
                    "hiddenSeedsOpen": False,
                    "multiplayerSeedsOpen": False,
                    "humanReferenceSeedsOpen": False,
                    "productionPromotionOpen": False,
                },
            },
        )

    def _write_tooling_files(self) -> None:
        for raw in LOCKED_TOOLING_FILES:
            path = self.root / raw
            if path == self.strength_path:
                continue
            write_text(path, f"synthetic locked file {raw}\n")

    def _write_strength_preflight_and_lock(self) -> None:
        tooling = {raw: sha256(self.root / raw) for raw in sorted(LOCKED_TOOLING_FILES)}
        checks = {}
        replay_audit = {
            "schemaVersion": "arc-v34-replay-determinism-preflight-v1",
            "passed": True,
            "implementationCommit": IMPLEMENTATION_COMMIT,
            "gpu": 5,
            "seed0": 957_800_000,
            "games": 64,
            "primaryWorkers": 24,
            "replayWorkers": 8,
            "sameInferenceProcess": True,
            "comparedBySeed": True,
            "mismatches": 0,
            "checkpointSha256": self.policy_sha,
            "catalogSha256": self.catalog_sha,
            "inference": {"weightsSha256": self.policy_sha},
            "lifecycle": {
                "servingLines": 1,
                "shutdownLines": 1,
                "reloadLines": 0,
                "errorLines": 0,
            },
            "inputs": {
                "primaryReportSha256": "1" * 64,
                "replayReportSha256": "2" * 64,
                "inferLogSha256": "3" * 64,
            },
        }
        write_json(self.root / "strength-preflight/replay-determinism-audit.json", replay_audit)
        for name in (
            "sourceLock", "evidenceChain", "strengthProtocol", "pythonFixtures", "recorderFixtures", "replayDeterminism", "vitest",
            "typecheck", "nodeSyntax", "shellSyntax", "determinization", "resources",
        ):
            log = write_text(
                self.root / f"strength-preflight/{name}.log",
                (json.dumps(replay_audit) if name == "replayDeterminism" else "ok") + "\n",
            )
            checks[name] = {"exitCode": 0, "log": log.relative_to(self.root).as_posix(), "logSha256": sha256(log)}
        persistent = 2 * 1024**3
        self.strength_preflight_path = write_json(
            self.root / "strength-preflight/result.json",
            {
                "schemaVersion": "arc-v34-strength-preflight-evidence-v1",
                "implementationCommit": IMPLEMENTATION_COMMIT,
                "baseSourceLock": ref(self.root, self.source_path),
                "strengthProtocol": ref(self.root, self.strength_path),
                "systemsEligibility": ref(self.root, self.systems_path),
                "phase2Authorization": ref(self.root, self.phase_auth_path),
                "toolingFiles": tooling,
                "environment": {"python": platform.python_version(), "numpy": np.__version__},
                "resources": {
                    "schemaVersion": "arc-v34-strength-resource-preflight-v1",
                    "scratchFreeBytes": 20 * 1024**3,
                    "scratchRequiredBytes": 17179869184,
                    "persistentFreeBytes": 10 * 1024**3,
                    "persistentRequiredBytes": persistent,
                    "eligibleGpus": [0, 5, 6, 7],
                    "excludedGpu": 4,
                    "freeEligibleGpus": [5],
                    "gpuProbeError": None,
                    "passed": True,
                },
                "checks": checks,
                "passed": True,
                "recordedAt": "synthetic",
            },
        )
        self.lock_path = write_json(
            self.root / "strength-tooling-lock.json",
            {
                "schemaVersion": "arc-v34-strength-tooling-lock-v1",
                "implementationCommit": IMPLEMENTATION_COMMIT,
                "baseSourceLock": ref(self.root, self.source_path),
                "strengthProtocol": ref(self.root, self.strength_path),
                "systemsEligibility": ref(self.root, self.systems_path),
                "phase2Authorization": ref(self.root, self.phase_auth_path),
                "strengthPreflight": ref(self.root, self.strength_preflight_path),
                "files": tooling,
                "environment": {"python": platform.python_version(), "numpy": np.__version__},
                "eligibleCandidateArms": ["rerank-p025"],
                "authorization": {
                    "phase2ExecutionOpen": True,
                    "guardianSeedsOpen": False,
                    "teacherSeedsOpen": False,
                    "finalDevelopmentSeedsOpen": False,
                    "hiddenSeedsOpen": False,
                    "multiplayerSeedsOpen": False,
                    "humanReferenceSeedsOpen": False,
                    "productionPromotionOpen": False,
                },
                "createdAt": "synthetic",
            },
        )

    def _write_condition(self, condition: str, *, candidate: bool) -> Path:
        directory = self.root / f"conditions/{condition}/attempt-1"
        report = make_report(condition, candidate=candidate)
        report["weightsSha256"] = self.policy_sha
        report["catalogSha256"] = self.catalog_sha
        report["inference"]["weightsSha256"] = self.policy_sha
        report_path = write_json(directory / "report.json", report)
        replay = json.loads(json.dumps(report))
        replay["games"] = 64
        replay["perGame"] = replay["perGame"][:64]
        replay["trueWins"] = sum(row["trueWin"] for row in replay["perGame"])
        replay["trueWinRate"] = replay["trueWins"] / replay["games"]
        replay["performance"]["workers"] = 8
        replay_path = write_json(directory / "replay-report.json", replay)
        replay_stdout = write_text(directory / "replay-stdout", "")
        replay_stderr = write_text(directory / "replay-stderr", "")
        replay_exit_code = write_text(directory / "replay-exit-code.txt", "0\n")
        infer_log = write_text(
            directory / "infer.log",
            "[infer] serving fixture\n[infer] reqs=10 rows=20 batches=5 avg_batch=4.0\n[infer] shut down\n",
        )
        stdout = write_text(directory / "stdout", "")
        stderr = write_text(directory / "stderr", "")
        launch_pid = write_text(directory / "launch.pid", "123\n")
        exit_code = write_text(directory / "exit-code.txt", "0\n")
        arm = (
            {"id": "raw", "kind": "raw", "selectedWorkers": 24}
            if not candidate
            else {"id": "rerank-p025", "kind": "critic-rerank", "policyRankWeight": 0.25, "selectedWorkers": 8}
        )
        arm_args = [] if not candidate else ["--rerank-policy-weight", "0.25"]
        common = self.strength_value["commonDecode"]
        evaluator_args = [
            "scripts/evaluate-solo-checkpoint.mjs",
            "--weights", "checkpoint.pt",
            "--catalog", "catalog.json",
            "--source-commit", IMPLEMENTATION_COMMIT,
            "--infer-socket", report["decode"]["inferenceSocket"],
            "--policy-obs-version", str(common["policyObsVersion"]),
            "--games", str(GAMES),
            "--workers", str(arm["selectedWorkers"]),
            "--seed0", str(SEED0),
            "--max-rounds", str(common["maxRounds"]),
            "--max-status-level", str(common["maxStatusLevel"]),
            "--sample",
            "--temperature", str(common["temperature"]),
            "--include-games",
            *arm_args,
            "--out", report_path.relative_to(self.root).as_posix(),
        ]
        replay_evaluator_args = evaluator_args.copy()
        replay_evaluator_args[replay_evaluator_args.index("--games") + 1] = "64"
        replay_evaluator_args[replay_evaluator_args.index("--workers") + 1] = "8"
        replay_evaluator_args[replay_evaluator_args.index("--out") + 1] = replay_path.relative_to(self.root).as_posix()
        launch_path = write_json(
            directory / "launch.json",
            {
                "schemaVersion": "arc-v34-phase2-launch-v1",
                "condition": condition,
                "attempt": 1,
                "workers": arm["selectedWorkers"],
                "gpu": 5,
                "sourceCommit": IMPLEMENTATION_COMMIT,
                "watchdogSeconds": 23400,
                "watchdogKillAfterSeconds": 60,
                "strengthLock": ref(self.root, self.lock_path),
                "seed0": SEED0,
                "games": GAMES,
                "seedMax": SEED_MAX,
                "commonDecode": self.strength_value["commonDecode"],
                "arm": arm,
                "checkpoint": {"path": "checkpoint.pt", "sha256": self.policy_sha},
                "catalog": {"path": "catalog.json", "sha256": self.catalog_sha},
                "retryJustification": None,
                "evaluatorArgs": evaluator_args,
                "replayEvaluatorArgs": replay_evaluator_args,
            },
        )
        search = report["performance"].get("search")
        inputs = {
            "strengthLock": file_record(self.root, self.lock_path),
            "baseProtocol": file_record(self.root, self.base_path),
            "strengthProtocol": file_record(self.root, self.strength_path),
            "systemsEligibility": file_record(self.root, self.systems_path),
            "phase2Authorization": file_record(self.root, self.phase_auth_path),
            "strengthPreflight": file_record(self.root, self.strength_preflight_path),
            "report": file_record(self.root, report_path),
            "replayReport": file_record(self.root, replay_path),
            "replayStdout": file_record(self.root, replay_stdout),
            "replayStderr": file_record(self.root, replay_stderr),
            "replayExitCode": file_record(self.root, replay_exit_code),
            "inferLog": file_record(self.root, infer_log),
            "stdout": file_record(self.root, stdout),
            "stderr": file_record(self.root, stderr),
            "launch": file_record(self.root, launch_path),
            "launchPid": file_record(self.root, launch_pid),
            "exitCode": file_record(self.root, exit_code),
        }
        completion = {
            "schemaVersion": CONDITION_SCHEMA,
            "valid": True,
            "immutable": True,
            "condition": condition,
            "attempt": 1,
            "workers": arm["selectedWorkers"],
            "arm": arm,
            "sourceCommit": IMPLEMENTATION_COMMIT,
            "seed0": SEED0,
            "games": GAMES,
            "seedMax": SEED_MAX,
            "commonDecode": self.strength_value["commonDecode"],
            "checkpoint": {"path": "checkpoint.pt", "sha256": self.policy_sha},
            "catalog": {"path": "catalog.json", "sha256": self.catalog_sha},
            "inference": report["inference"],
            "telemetry": {
                "plannerMode": arm["kind"],
                "strategicDecisions": search["decisions"] if search else 0,
                "strategicSimulations": search["simulations"] if search else 0,
                "decisionWallMsP50": search["decisionWallMsP50"] if search else None,
                "decisionWallMsP95": search["decisionWallMsP95"] if search else None,
                "byPhase": search["byPhase"] if search else {"navigation": 0, "encounter": 0},
                "wallSeconds": report["performance"]["wallSeconds"],
            },
            "stalls": 0,
            "integrity": {
                "informationSafetyFailures": 0,
                "replayMismatches": 0,
                "servingErrors": 0,
                "provenanceMismatches": 0,
                "derivedOnlyAfterStrictValidation": True,
                "evidence": {
                    "informationSafety": {
                        "strengthPreflight": file_record(self.root, self.strength_preflight_path),
                        "vitestExitCode": 0,
                        "determinizationExitCode": 0,
                    },
                    "replay": {
                        "seed0": SEED0,
                        "games": 64,
                        "workers": 8,
                        "exactPerGameEquality": True,
                        "preflightExitCode": 0,
                        "mismatches": 0,
                    },
                    "serving": {
                        "servingLines": 1,
                        "shutdownLines": 1,
                        "errorLines": 0,
                        "requests": 10,
                        "rows": 20,
                        "batches": 5,
                    },
                    "provenance": {
                        "acceptedGameSummariesChecked": GAMES,
                        "evaluatorCrossGameHandshakeInvariant": True,
                        "fixedInferenceProcess": True,
                        "reloadLines": 0,
                    },
                },
            },
            "inputs": inputs,
        }
        manifest = write_json(self.root / f"conditions/{condition}/completion.json", completion)
        write_text(Path(f"{manifest}.sha256"), f"{sha256(manifest)}  {manifest.name}\n")
        return manifest

    def analyze(self) -> dict:
        return analyze_phase2(
            repo=self.root,
            base=self.base,
            strength_protocol=self.strength,
            source_lock=self.source,
            systems_authorization=self.systems_auth,
            systems=self.systems,
            phase2_authorization=self.phase_auth,
            strength_lock=self.lock,
            manifest_paths=self.manifest_paths,
            verify_git=False,
        )


class AnalyzeV34Phase2Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory()
        cls.fixture = Fixture(Path(cls.temp.name))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp.cleanup()

    def test_full_4096_analysis_preserves_six_slots_and_emits_no_winner(self) -> None:
        result = self.fixture.analyze()
        self.assertEqual(result["contract"]["games"], 4096)
        self.assertEqual(result["contract"]["registeredCandidateSlots"], list(REGISTERED_ARMS))
        self.assertEqual(result["simultaneousFamily"]["registeredEndpointCount"], 24)
        self.assertEqual(result["simultaneousFamily"]["observedEndpointCount"], 4)
        rejected = [row for row in result["arms"] if not row["systemsEligible"]]
        self.assertEqual(len(rejected), 5)
        self.assertTrue(all(row["failedRegisteredSlot"] and not row["corePass"] for row in rejected))
        self.assertEqual(result["corePassingArms"], ["rerank-p025"])
        self.assertFalse(result["decision"]["winnerSelected"])
        self.assertFalse(result["decision"]["guardianSeedsOpen"])
        self.assertEqual(deterministic_json(result), deterministic_json(result))

    def test_max_t_exact_pcg64_centered_nearest_rank_and_floor(self) -> None:
        effects = {
            "a": np.array([0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0]),
            "b": np.array([-2.0, 0.0, 1.0, 2.0, -1.0, 0.5, 1.5, -0.5]),
        }
        observed = max_t_family(effects)
        rng = np.random.Generator(np.random.PCG64(BOOTSTRAP_SEED))
        matrix = np.column_stack(list(effects.values()))
        means = matrix.mean(axis=0)
        se = matrix.std(axis=0, ddof=1) / math.sqrt(len(matrix))
        maxima = []
        for _ in range(BOOTSTRAP_DRAWS):
            sample = matrix[rng.integers(0, len(matrix), size=len(matrix))].mean(axis=0)
            maxima.append(float(np.max(np.abs((sample - means) / se))))
        maxima.sort()
        expected_empirical = maxima[math.ceil(0.95 * BOOTSTRAP_DRAWS) - 1]
        expected_floor = NormalDist().inv_cdf(1 - 0.05 / (2 * FAMILY_SIZE))
        self.assertEqual(observed["empiricalCritical"], expected_empirical)
        self.assertEqual(observed["bonferroniNormalFloor"], expected_floor)
        self.assertEqual(observed["critical"], max(expected_empirical, expected_floor))
        self.assertEqual(observed, max_t_family(effects))

    def test_protocol_numbers_use_javascript_cli_serialization(self) -> None:
        self.assertEqual(js_number_string(1.0), "1")
        self.assertEqual(js_number_string(0.0), "0")
        self.assertEqual(js_number_string(0.5), "0.5")
        self.assertEqual(js_number_string(8), "8")

    def test_zero_se_excluded_and_point_gate_fails_closed(self) -> None:
        family = max_t_family({name: np.full(32, value) for name, value in {
            "winPoints": 3.0, "finalVp": 0.0, "post15VpPerRound": 0.0, "censoredFirst30Round": 0.0,
        }.items()})
        self.assertEqual(family["nonzeroStandardErrorEndpointCount"], 0)
        self.assertTrue(all(row["zeroStandardError"] for row in family["endpoints"].values()))
        gates = evaluate_arm_gates(
            {name: family["endpoints"][name] for name in OUTCOMES},
            binding={"binding-w1": 1000, "binding-w8": 2000},
            integrity={key: 0 for key in ("informationSafetyFailures", "replayMismatches", "servingErrors", "provenanceMismatches")},
            stalls=0,
        )
        self.assertTrue(all(gates.values()))
        bad = copy.deepcopy({name: family["endpoints"][name] for name in OUTCOMES})
        bad["winPoints"]["mean"] = bad["winPoints"]["simultaneousLower"] = 2.999
        self.assertFalse(evaluate_arm_gates(bad, binding={"binding-w1": 1000, "binding-w8": 2000}, integrity={key: 0 for key in ("informationSafetyFailures", "replayMismatches", "servingErrors", "provenanceMismatches")}, stalls=0)["winPointGainAtLeast3"])

    def test_every_gate_is_independently_binding(self) -> None:
        endpoints = {
            "winPoints": {"mean": 4.0, "simultaneousLower": 1.0},
            "finalVp": {"simultaneousLower": 0.0},
            "post15VpPerRound": {"simultaneousLower": 0.0},
            "censoredFirst30Round": {"simultaneousUpper": 0.0},
        }
        integrity = {key: 0 for key in ("informationSafetyFailures", "replayMismatches", "servingErrors", "provenanceMismatches")}
        base = evaluate_arm_gates(endpoints, binding={"binding-w1": 1000, "binding-w8": 2000}, integrity=integrity, stalls=0)
        self.assertTrue(all(base.values()))
        mutations = {
            "winPointGainAtLeast3": ("winPoints", "mean", 2.9),
            "winSimultaneousLowerStrictlyAbove0": ("winPoints", "simultaneousLower", 0.0),
            "finalVpSimultaneousLowerAtLeastMinus0p5": ("finalVp", "simultaneousLower", -0.501),
            "post15SimultaneousLowerAtLeastMinus0p025": ("post15VpPerRound", "simultaneousLower", -0.026),
            "censoredFirst30SimultaneousUpperAtMost0p5": ("censoredFirst30Round", "simultaneousUpper", 0.501),
        }
        for gate, (endpoint, field, value) in mutations.items():
            changed = copy.deepcopy(endpoints)
            changed[endpoint][field] = value
            self.assertFalse(evaluate_arm_gates(changed, binding={"binding-w1": 1000, "binding-w8": 2000}, integrity=integrity, stalls=0)[gate])
        self.assertFalse(evaluate_arm_gates(endpoints, binding={"binding-w1": 1001, "binding-w8": 2000}, integrity=integrity, stalls=0)["bindingLatencyStillValid"])
        self.assertFalse(evaluate_arm_gates(endpoints, binding={"binding-w1": 1000, "binding-w8": 2000}, integrity=integrity, stalls=1)["stallsZero"])
        for field, gate in (
            ("informationSafetyFailures", "informationSafetyFailuresZero"),
            ("replayMismatches", "replayMismatchesZero"),
            ("servingErrors", "servingErrorsZero"),
            ("provenanceMismatches", "provenanceMismatchesZero"),
        ):
            changed = dict(integrity)
            changed[field] = 1
            self.assertFalse(evaluate_arm_gates(endpoints, binding={"binding-w1": 1000, "binding-w8": 2000}, integrity=changed, stalls=0)[gate])

    def test_exact_report_schema_seed_pairing_stalls_and_provenance_fail_closed(self) -> None:
        raw = copy.deepcopy(load_json(Path(self.fixture.manifest_paths[0]).parent / "attempt-1/report.json", "raw").value)
        kwargs = dict(
            arm="raw", expected_workers=24, implementation_commit=IMPLEMENTATION_COMMIT,
            base=self.fixture.base_value, strength=self.fixture.strength_value,
        )
        validate_report(raw, **kwargs)
        cases = []
        extra = copy.deepcopy(raw); extra["unexpected"] = True; cases.append(extra)
        missing = copy.deepcopy(raw); missing.pop("cycle", None); missing["perGame"][0].pop("cycle"); cases.append(missing)
        duplicate = copy.deepcopy(raw); duplicate["perGame"][1]["seed"] = duplicate["perGame"][0]["seed"]; cases.append(duplicate)
        wrong_guardian = copy.deepcopy(raw); wrong_guardian["perGame"][0]["guardian"] = "Embers"; cases.append(wrong_guardian)
        stalled = copy.deepcopy(raw); stalled["perGame"][0]["stalled"] = True; stalled["stalls"] = 1; stalled["stallRate"] = 1 / GAMES; cases.append(stalled)
        wrong_hash = copy.deepcopy(raw); wrong_hash["inference"]["weightsSha256"] = "f" * 64; cases.append(wrong_hash)
        wrong_decode = copy.deepcopy(raw); wrong_decode["decode"]["temperature"] = 0.6; cases.append(wrong_decode)
        for report in cases:
            with self.assertRaises(ValueError):
                validate_report(report, **kwargs)

    def test_missing_attempt_and_manifest_hash_links_fail_closed(self) -> None:
        original = json.loads(self.fixture.manifest_paths[0].read_text())
        bad_dir = self.fixture.root / "conditions/bad"
        bad = copy.deepcopy(original)
        bad["attempt"] = 2
        bad_path = write_json(bad_dir / "completion.json", bad)
        write_text(Path(f"{bad_path}.sha256"), f"{sha256(bad_path)}  {bad_path.name}\n")
        with self.assertRaises(ValueError):
            load_conditions(
                [bad_path, self.fixture.manifest_paths[1]], repo=self.fixture.root,
                strength_lock=self.fixture.lock, strength_protocol=self.fixture.strength,
                systems=self.fixture.systems, phase2_authorization=self.fixture.phase_auth,
                strength_preflight=load_json(self.fixture.strength_preflight_path, "strength preflight"),
                eligible=("rerank-p025",), base=self.fixture.base,
            )
        bad = copy.deepcopy(original)
        bad["inputs"]["report"]["sha256"] = "f" * 64
        bad_path = write_json(bad_dir / "hash-completion.json", bad)
        write_text(Path(f"{bad_path}.sha256"), f"{sha256(bad_path)}  {bad_path.name}\n")
        with self.assertRaises(ValueError):
            load_conditions(
                [bad_path, self.fixture.manifest_paths[1]], repo=self.fixture.root,
                strength_lock=self.fixture.lock, strength_protocol=self.fixture.strength,
                systems=self.fixture.systems, phase2_authorization=self.fixture.phase_auth,
                strength_preflight=load_json(self.fixture.strength_preflight_path, "strength preflight"),
                eligible=("rerank-p025",), base=self.fixture.base,
            )

    def test_corrupt_replay_is_reconstructed_and_rejected(self) -> None:
        original = json.loads(self.fixture.manifest_paths[0].read_text())
        corrupt_dir = self.fixture.root / "conditions/corrupt-replay"
        replay_path = self.fixture.root / original["inputs"]["replayReport"]["path"]
        replay = json.loads(replay_path.read_text())
        replay["perGame"][0]["finalVP"] += 1
        bad_replay = write_json(corrupt_dir / "replay-report.json", replay)
        original["inputs"]["replayReport"] = file_record(self.fixture.root, bad_replay)
        bad_manifest = write_json(corrupt_dir / "completion.json", original)
        write_text(Path(f"{bad_manifest}.sha256"), f"{sha256(bad_manifest)}  {bad_manifest.name}\n")
        with self.assertRaises(ValueError):
            load_conditions(
                [bad_manifest, self.fixture.manifest_paths[1]],
                repo=self.fixture.root,
                strength_lock=self.fixture.lock,
                strength_protocol=self.fixture.strength,
                systems=self.fixture.systems,
                phase2_authorization=self.fixture.phase_auth,
                strength_preflight=load_json(
                    self.fixture.strength_preflight_path, "strength preflight"
                ),
                eligible=("rerank-p025",),
                base=self.fixture.base,
            )

    def test_authorization_preflight_lock_and_every_primary_link_are_hash_bound(self) -> None:
        phase = copy.deepcopy(self.fixture.phase_auth.value)
        phase["systemsEligibility"]["sha256"] = "f" * 64
        with self.assertRaises(ValueError):
            validate_phase2_authorization(
                Artifact(self.fixture.phase_auth.path, self.fixture.phase_auth.sha256, phase),
                self.fixture.systems, ("rerank-p025",), self.fixture.root,
            )
        for field in ("baseSourceLock", "strengthProtocol", "systemsEligibility", "phase2Authorization", "strengthPreflight"):
            lock = copy.deepcopy(self.fixture.lock.value)
            lock[field]["sha256"] = "f" * 64
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_strength_lock(
                    Artifact(self.fixture.lock.path, self.fixture.lock.sha256, lock),
                    self.fixture.source, self.fixture.strength, self.fixture.systems,
                    self.fixture.phase_auth, ("rerank-p025",), self.fixture.root,
                    verify_git=False,
                )


if __name__ == "__main__":
    unittest.main()
