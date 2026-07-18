#!/usr/bin/env python3
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

from ml.analyze_v34_guardian import (
    AUTHORIZATION_FLAGS,
    BOOTSTRAP_SEED,
    CONDITION_INPUT_KEYS,
    EXPECTED_GUARDIAN_COUNTS,
    EXECUTION_FLAGS,
    FROZEN_FAMILY_SIZE,
    GAMES,
    GUARDIAN_TOOLING_FILES,
    GUARDIAN_COUNT,
    LATER_AUTHORIZATION_KEYS,
    REGISTERED_ARMS,
    REPLAY_GAMES,
    SEED0,
    SEED_MAX,
    analyze_guardian,
    artifact_record,
    guardian_cell,
    guardian_max_t,
    load_json,
    sha256,
    validate_retry_justification,
    write_immutable_json,
)


REPO = Path(__file__).resolve().parents[1]
PROTOCOL_PATH = (
    REPO
    / "ml/experiments/v34-latency-first-expert-iteration/guardian-execution-protocol.json"
)
NOW = "2026-07-14T12:00:00Z"


def write_json(path: Path, value: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    return path


def write_text(path: Path, value: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)
    return path


def write_completion(path: Path, value: object) -> Path:
    write_json(path, value)
    write_text(path.with_name(path.name + ".sha256"), f"{sha256(path)}  {path.name}\n")
    return path


def record(path: Path) -> dict[str, object]:
    return {"path": str(path.resolve()), "bytes": path.stat().st_size, "sha256": sha256(path)}


def phase2_ref(path: Path) -> dict[str, str]:
    return {"path": str(path.resolve()), "sha256": sha256(path)}


def closed_flags(keys: set[str], *opened: str) -> dict[str, bool]:
    opened_set = set(opened)
    return {key: key in opened_set for key in sorted(keys)}


class Fixture:
    def __init__(
        self,
        root: Path,
        *,
        passing: tuple[str, ...] = (),
        phase2_win: dict[str, float] | None = None,
        candidate_stalls: dict[str, int] | None = None,
        raw_stall_seed: int | None = None,
        wrong_guardian_arm: str | None = None,
    ) -> None:
        self.root = root
        self.protocol = load_json(PROTOCOL_PATH, "guardian protocol")
        self.protocol_value = self.protocol.value
        base = self.protocol_value["base"]
        self.base_protocol = load_json(REPO / base["protocol"]["path"], "base protocol")
        self.strength_lock_path = REPO / base["strengthToolingLock"]["path"]
        self.strength_lock = load_json(self.strength_lock_path, "strength lock")
        self.source_commit = base["sourceCommit"]
        self.passing = tuple(arm for arm in REGISTERED_ARMS if arm in passing)
        self.phase2_win = phase2_win or {arm: 4.0 for arm in self.passing}
        self.candidate_stalls = candidate_stalls or {}
        self.raw_stall_seed = raw_stall_seed
        self.wrong_guardian_arm = wrong_guardian_arm
        self.systems_path = write_json(
            root / "systems.json", {"schemaVersion": "arc-v34-systems-eligibility-v1"}
        )

        self.phase2_completion_paths: list[tuple[str, Path]] = []
        for arm in ("raw", *self.passing):
            path = write_json(
                root / "phase2" / f"{arm}.json",
                {
                    "schemaVersion": "arc-v34-phase2-condition-v1",
                    "valid": True,
                    "condition": arm,
                },
            )
            self.phase2_completion_paths.append((arm, path))
        phase2_rows = []
        for arm in REGISTERED_ARMS:
            core = arm in self.passing
            phase2_rows.append(
                {
                    "arm": arm,
                    "systemsEligible": core,
                    "selectedWorkers": 8 if core else None,
                    "bindingDecisionWallMsP95": {"binding-w1": 10.0, "binding-w8": 100.0},
                    "endpoints": {"winPoints": {"mean": self.phase2_win.get(arm, 0.0)}} if core else None,
                    "corePass": core,
                }
            )
        phase2 = {
            "schemaVersion": "arc-v34-phase2-analysis-v1",
            "valid": True,
            "promotionEligible": False,
            "strengthUse": True,
            "inputs": {
                "strengthToolingLock": phase2_ref(self.strength_lock_path),
                "systemsEligibility": phase2_ref(self.systems_path),
                "conditions": [
                    {
                        "arm": arm,
                        "manifest": phase2_ref(path),
                        "report": phase2_ref(path),
                    }
                    for arm, path in self.phase2_completion_paths
                ],
            },
            "contract": {
                "registeredCandidateSlots": list(REGISTERED_ARMS),
                "systemsEligibleArms": list(self.passing),
            },
            "arms": phase2_rows,
            "corePassingArms": list(self.passing),
            "decision": {
                "guardianAuthorizationMayOpen": bool(self.passing),
                "guardianAuthorizationMustNameExactly": list(self.passing),
                "guardianSeedsOpen": False,
                **{key: False for key in LATER_AUTHORIZATION_KEYS},
            },
        }
        self.phase2_path = write_json(root / "phase2-analysis.json", phase2)
        self.ranked = tuple(
            sorted(self.passing, key=lambda arm: (-self.phase2_win[arm], 100.0, arm))
        )
        authorization = {
            "schemaVersion": "arc-v34-guardian-authorization-v1",
            "authoritative": True,
            "strengthProtocolHistoricalGuardianFlagsIgnored": True,
            "phase2Analysis": record(self.phase2_path),
            "strengthToolingLock": record(self.strength_lock_path),
            "registeredCandidateSlots": list(REGISTERED_ARMS),
            "systemsEligibleArms": list(self.passing),
            "corePassingArms": list(self.passing),
            "authorizedArms": list(self.passing),
            "phase2RankedArms": list(self.ranked),
            "phase2Leader": self.ranked[0] if self.ranked else None,
            "laneAClosed": not self.passing,
            "authorization": closed_flags(
                AUTHORIZATION_FLAGS, *("guardianSeedsOpen",) if self.passing else ()
            ),
            "sourceCommit": self.source_commit,
            "createdAt": NOW,
        }
        self.authorization_path = write_json(root / "authorization.json", authorization)
        self.authorization = load_json(self.authorization_path, "authorization")
        self.execution = None
        self.execution_path: Path | None = None
        self.condition_paths: list[Path] = []
        if self.passing:
            self._build_execution()

    def _build_execution(self) -> None:
        preflight_path = write_json(
            self.root / "preflight.json",
            {
                "schemaVersion": "arc-v34-guardian-preflight-v1",
                "passed": True,
                "phase": "tooling",
            },
        )
        tooling_path = self.root / "tooling-lock.json"
        tooling = {
            "schemaVersion": "arc-v34-guardian-tooling-lock-v1",
            "authoritative": True,
            "implementationCommit": "a" * 40,
            "baseSourceLock": self.protocol_value["base"]["sourceLock"],
            "strengthProtocol": self.protocol_value["base"]["strengthProtocol"],
            "strengthToolingLock": self.protocol_value["base"]["strengthToolingLock"],
            "guardianProtocol": record(PROTOCOL_PATH),
            "guardianPreflight": record(preflight_path),
            "files": {name: sha256(REPO / name) for name in sorted(GUARDIAN_TOOLING_FILES)},
            "environment": {
                "python": platform.python_version(),
                "numpy": np.__version__,
                "rng": "numpy.random.Generator(PCG64)",
            },
            "authorization": closed_flags(
                {"guardianSeedsOpen", "guardianExecutionOpen", *LATER_AUTHORIZATION_KEYS}
            ),
            "createdAt": NOW,
        }
        write_json(tooling_path, tooling)
        execution = {
            "schemaVersion": "arc-v34-guardian-execution-lock-v1",
            "authoritative": True,
            "implementationCommit": "a" * 40,
            "guardianToolingLock": record(tooling_path),
            "guardianProtocol": record(PROTOCOL_PATH),
            "phase2Analysis": record(self.phase2_path),
            "guardianAuthorization": record(self.authorization_path),
            "guardianPreflight": record(preflight_path),
            "phase2Conditions": [
                {"arm": arm, **record(path)} for arm, path in self.phase2_completion_paths
            ],
            "authorizedArms": list(self.passing),
            "phase2RankedArms": list(self.ranked),
            "sourceCommit": self.source_commit,
            "environment": {
                "python": platform.python_version(),
                "numpy": np.__version__,
                "rng": "numpy.random.Generator(PCG64)",
            },
            "authorization": closed_flags(
                EXECUTION_FLAGS, "guardianSeedsOpen", "guardianExecutionOpen"
            ),
            "createdAt": NOW,
        }
        self.execution_path = write_json(self.root / "execution-lock.json", execution)
        self.execution = load_json(self.execution_path, "execution lock")
        self.condition_paths = []
        for arm in ("raw", *self.passing):
            workers = 24 if arm == "raw" else 8
            arm_meta = (
                {"id": "raw", "kind": "raw", "selectedWorkers": 24}
                if arm == "raw"
                else self._arm_meta(arm, workers)
            )
            stalls = self.candidate_stalls.get(arm, 0)
            stalled_seed = SEED0 + 1 if stalls else None
            if arm == "raw":
                stalled_seed = self.raw_stall_seed
            report_path = self._write_report(
                arm,
                stalled_seed=stalled_seed,
                wrong_guardian=arm == self.wrong_guardian_arm,
            )
            report = json.loads(report_path.read_text())
            replay_path = write_json(
                self.root / "conditions" / arm / "replay.json",
                self._replay(report),
            )
            infer_path = write_text(
                self.root / "conditions" / arm / "infer.log",
                "[infer] serving fixture\n"
                "[infer] reqs=100 rows=200 batches=10 avg_batch=20\n"
                "[infer] shut down\n",
            )
            runtime = self.protocol_value["runtime"]
            resource_path = write_json(
                self.root / "conditions" / arm / "resources.json",
                {
                    "schemaVersion": "arc-v34-guardian-resource-snapshot-v1",
                    "recordedAt": "2000-01-01T00:00:00Z",
                    "host": "fixture-host",
                    "sourceCommit": self.source_commit,
                    "guardianToolingLock": phase2_ref(tooling_path),
                    "guardianExecutionLock": phase2_ref(self.execution_path),
                    "gpu": {"index": 0, "uuid": "GPU-fixture", "computeApps": []},
                    "locks": {
                        "conditionSlot": "/tmp/.condition-slot-1.lock",
                        "gpu": "/tmp/.gpu-0.lock",
                        "phase2Gpu": f"{runtime['legacyPhase2GpuLockRoot']}/.gpu-0.lock",
                    },
                    "workers": workers,
                    "maxConcurrentConditions": runtime["maxConcurrentConditions"],
                    "maxActorWorkers": runtime["maxActorWorkers"],
                    "scratch": {
                        "freeBytes": runtime["minimumScratchFreeBytes"],
                        "requiredBytes": runtime["minimumScratchFreeBytes"],
                    },
                    "persistent": {
                        "freeBytes": runtime["minimumPersistentFreeBytes"]
                        + (1 + len(self.passing))
                        * runtime["persistentBytesPerRemainingCondition"],
                        "requiredBytes": runtime["minimumPersistentFreeBytes"]
                        + (1 + len(self.passing))
                        * runtime["persistentBytesPerRemainingCondition"],
                        "remainingConditions": 1 + len(self.passing),
                    },
                    "memory": {
                        "availableBytes": runtime["minimumAvailableMemoryBytes"],
                        "requiredBytes": runtime["minimumAvailableMemoryBytes"],
                    },
                    "loadAverage": [0.0, 0.0, 0.0],
                    "passed": True,
                },
            )
            launch_path = write_json(
                self.root / "conditions" / arm / "launch.json",
                {
                    "schemaVersion": "arc-v34-guardian-launch-v1",
                    "condition": arm,
                    "attempt": 1,
                    "workers": workers,
                    "gpu": 0,
                    "sourceCommit": self.source_commit,
                    "watchdogSeconds": runtime["watchdogSeconds"],
                    "watchdogKillAfterSeconds": runtime["watchdogKillAfterSeconds"],
                    "guardianExecutionLock": phase2_ref(self.execution_path),
                    "resourceSnapshot": phase2_ref(resource_path),
                    "seed0": SEED0,
                    "games": GAMES,
                    "seedMax": SEED_MAX,
                    "commonDecode": self.protocol_value["commonDecode"],
                    "arm": arm_meta,
                    "checkpoint": {
                        key: self.protocol_value["base"]["checkpoint"][key]
                        for key in ("path", "sha256")
                    },
                    "catalog": {
                        key: self.protocol_value["base"]["catalog"][key]
                        for key in ("path", "sha256")
                    },
                    "retryJustification": None,
                    "evaluatorArgs": self._launch_args(
                        arm, workers, report_path, replay_path, replay=False
                    ),
                    "replayEvaluatorArgs": self._launch_args(
                        arm, workers, report_path, replay_path, replay=True
                    ),
                },
            )
            files = {
                "replayStdout": write_text(self.root / "conditions" / arm / "replay.stdout", "ok\n"),
                "replayStderr": write_text(self.root / "conditions" / arm / "replay.stderr", ""),
                "replayExitCode": write_text(self.root / "conditions" / arm / "replay.exit", "0\n"),
                "stdout": write_text(self.root / "conditions" / arm / "stdout", "ok\n"),
                "stderr": write_text(self.root / "conditions" / arm / "stderr", ""),
                "launchPid": write_text(self.root / "conditions" / arm / "pid", "123\n"),
                "exitCode": write_text(self.root / "conditions" / arm / "exit", "0\n"),
                "launch": launch_path,
                "resourceSnapshot": resource_path,
            }
            inputs = {
                "guardianExecutionLock": record(self.execution_path),
                "guardianAuthorization": record(self.authorization_path),
                "guardianToolingLock": record(tooling_path),
                "baseProtocol": self.protocol_value["base"]["protocol"],
                "strengthProtocol": self.protocol_value["base"]["strengthProtocol"],
                "guardianProtocol": record(PROTOCOL_PATH),
                "systemsEligibility": record(self.systems_path),
                "guardianPreflight": record(preflight_path),
                "report": record(report_path),
                "replayReport": record(replay_path),
                "inferLog": record(infer_path),
                **{name: record(path) for name, path in files.items()},
            }
            self.assert_input_inventory(inputs)
            guardians = self.protocol_value["guardian"]["guardians"]
            search = report["performance"].get("search", {})
            manifest = {
                "schemaVersion": "arc-v34-guardian-condition-v1",
                "valid": True,
                "immutable": True,
                "condition": arm,
                "attempt": 1,
                "workers": workers,
                "arm": arm_meta,
                "sourceCommit": self.source_commit,
                "seed0": SEED0,
                "games": GAMES,
                "seedMax": SEED_MAX,
                "commonDecode": self.protocol_value["commonDecode"],
                "checkpoint": {
                    key: self.protocol_value["base"]["checkpoint"][key]
                    for key in ("path", "sha256")
                },
                "catalog": {
                    key: self.protocol_value["base"]["catalog"][key]
                    for key in ("path", "sha256")
                },
                "inference": report["inference"],
                "telemetry": {
                    "plannerMode": arm_meta["kind"],
                    "strategicDecisions": search.get("decisions", 0),
                    "strategicSimulations": search.get("simulations", 0),
                    "decisionWallMsP50": search.get("decisionWallMsP50"),
                    "decisionWallMsP95": search.get("decisionWallMsP95"),
                    "byPhase": search.get("byPhase", {"navigation": 0, "encounter": 0}),
                    "wallSeconds": report["performance"]["wallSeconds"],
                },
                "stalls": int(report["stalls"]),
                "integrity": {
                    "informationSafetyFailures": 0,
                    "replayMismatches": 0,
                    "servingErrors": 0,
                    "provenanceMismatches": 0,
                    "derivedOnlyAfterStrictValidation": True,
                    "evidence": {
                        "informationSafety": {"guardianPreflight": record(preflight_path)},
                        "replay": {
                            "seed0": SEED0,
                            "games": REPLAY_GAMES,
                            "workers": 8,
                            "mismatches": 0,
                            "exactPerGameEquality": True,
                            "stalls": self._replay(report)["stalls"],
                        },
                        "serving": {
                            "servingLines": 1,
                            "shutdownLines": 1,
                            "errorLines": 0,
                            "requests": 100,
                            "rows": 200,
                            "batches": 10,
                        },
                        "provenance": {
                            "acceptedGameSummariesChecked": GAMES,
                            "evaluatorCrossGameHandshakeInvariant": True,
                            "fixedInferenceProcess": True,
                            "reloadLines": 0,
                        },
                    },
                },
                "guardians": {
                    "assignment": self.protocol_value["guardian"]["assignment"]["algorithm"],
                    "ordered": guardians,
                    "countByName": {
                        guardian["name"]: EXPECTED_GUARDIAN_COUNTS[index]
                        for index, guardian in enumerate(guardians)
                    },
                },
                "inputs": inputs,
            }
            self.condition_paths.append(
                write_completion(self.root / "conditions" / arm / "completion.json", manifest)
            )

    @staticmethod
    def assert_input_inventory(inputs: dict[str, object]) -> None:
        if set(inputs) != CONDITION_INPUT_KEYS:
            raise AssertionError((sorted(set(inputs) - CONDITION_INPUT_KEYS), sorted(CONDITION_INPUT_KEYS - set(inputs))))

    @staticmethod
    def _arm_meta(arm: str, workers: int) -> dict[str, object]:
        if arm.startswith("rerank-p"):
            weight = {
                "rerank-p025": 0.25,
                "rerank-p050": 0.5,
                "rerank-p075": 0.75,
                "rerank-p100": 1.0,
            }[arm]
            return {"id": arm, "kind": "critic-rerank", "policyRankWeight": weight, "selectedWorkers": workers}
        sims, horizon = (4, 2) if arm == "heuristic-s4-h2" else (8, 3)
        return {
            "id": arm,
            "kind": "heuristic-batched",
            "simulations": sims,
            "horizonRounds": horizon,
            "selectedWorkers": workers,
        }

    @staticmethod
    def _number(value: object) -> str:
        if isinstance(value, float) and value.is_integer():
            return str(int(value))
        return str(value)

    def _launch_args(
        self,
        arm: str,
        workers: int,
        report_path: Path,
        replay_path: Path,
        *,
        replay: bool,
    ) -> list[str]:
        common = self.protocol_value["commonDecode"]
        checkpoint = self.protocol_value["base"]["checkpoint"]
        catalog = self.protocol_value["base"]["catalog"]
        args = [
            "scripts/evaluate-solo-checkpoint.mjs",
            "--weights",
            checkpoint["path"],
            "--catalog",
            catalog["path"],
            "--source-commit",
            self.source_commit,
            "--infer-socket",
            f"/tmp/{arm}.sock",
            "--policy-obs-version",
            self._number(common["policyObsVersion"]),
            "--games",
            str(REPLAY_GAMES if replay else GAMES),
            "--workers",
            str(8 if replay else workers),
            "--seed0",
            str(SEED0),
            "--max-rounds",
            self._number(common["maxRounds"]),
            "--max-status-level",
            self._number(common["maxStatusLevel"]),
            "--sample",
            "--temperature",
            self._number(common["temperature"]),
            "--include-games",
        ]
        if arm.startswith("rerank-p"):
            args.extend(
                ["--rerank-policy-weight", self._number(self._arm_meta(arm, workers)["policyRankWeight"])]
            )
        elif arm.startswith("heuristic"):
            meta = self._arm_meta(arm, workers)
            decode = self.base_protocol.value["systems"]["heuristicDecode"]
            args.extend(
                [
                    "--search-sims",
                    self._number(meta["simulations"]),
                    "--search-horizon",
                    self._number(meta["horizonRounds"]),
                    "--search-objective",
                    "solo-reach30",
                    "--search-rollout",
                    "heuristic",
                    "--search-frac",
                    self._number(decode["frac"]),
                    "--search-value-weight",
                    self._number(decode["valueWeight"]),
                    "--search-nav-temperature",
                    self._number(decode["navTemperature"]),
                ]
            )
        args.extend(["--out", str((replay_path if replay else report_path).resolve())])
        return args

    def _decode(self, arm: str) -> dict[str, object]:
        decode: dict[str, object] = {
            "policyObsVersion": 2,
            "inferenceSocket": f"/tmp/{arm}.sock",
            "learnMonsterRewardChoices": False,
            "sample": True,
            "temperature": 0.55,
        }
        if arm.startswith("rerank-p"):
            decode["rerank"] = {"policyRankWeight": self._arm_meta(arm, 8)["policyRankWeight"]}
        elif arm.startswith("heuristic"):
            meta = self._arm_meta(arm, 8)
            decode["search"] = {
                "sims": meta["simulations"],
                "objective": "solo-reach30",
                "horizonRounds": meta["horizonRounds"],
                "frac": 1,
                "valueWeight": 0.5,
                "rollout": "heuristic",
                "navTemperature": 0,
            }
        return decode

    def _rows(self, *, stalled_seed: int | None, wrong_guardian: bool) -> list[dict[str, object]]:
        names = [row["name"] for row in self.protocol_value["guardian"]["guardians"]]
        rows = []
        for seed in range(SEED0, SEED_MAX + 1):
            stalled = seed == stalled_seed
            natural_win = seed % 3 == 0
            final_vp = 30 if natural_win else 20
            guardian = names[seed % GUARDIAN_COUNT]
            if wrong_guardian and seed == SEED0:
                guardian = names[1]
            cycle = {
                "first30Round": 25 if natural_win else None,
                "post15VpPerRound": 1.0,
                "finalAttackDice": 4,
                "finalSpirits": 4,
                "finalMaxBarrier": 4,
            }
            rows.append(
                {
                    "seed": seed,
                    "guardian": guardian,
                    "trueWin": natural_win and not stalled,
                    "stalled": stalled,
                    "finalVP": final_vp,
                    **cycle,
                    "cycle": cycle,
                }
            )
        return rows

    def _report_from_rows(self, arm: str, rows: list[dict[str, object]], workers: int) -> dict[str, object]:
        true_wins = sum(bool(row["trueWin"]) for row in rows)
        stalls = sum(bool(row["stalled"]) for row in rows)
        names = [row["name"] for row in self.protocol_value["guardian"]["guardians"]]
        breakdown = []
        for name in names:
            selected = [row for row in rows if row["guardian"] == name]
            wins = sum(bool(row["trueWin"]) for row in selected)
            breakdown.append(
                {
                    "guardian": name,
                    "games": len(selected),
                    "trueWins": wins,
                    "trueWinRate": wins / len(selected) if selected else 0,
                    "trueWinWilson95": {"lower": 0, "upper": 1},
                    "meanVP": 20,
                    "medianVP": 20,
                }
            )
        checkpoint = self.protocol_value["base"]["checkpoint"]
        catalog = self.protocol_value["base"]["catalog"]
        performance: dict[str, object] = {
            "wallSeconds": 1,
            "gamesPerSecond": 1,
            "workers": workers,
            "gameWallMsP50": 1,
            "gameWallMsP95": 2,
        }
        if arm.startswith("rerank-p"):
            performance["search"] = {
                "mode": "critic-rerank",
                "decisions": 10,
                "simulations": 0,
                "byPhase": {"navigation": 5, "encounter": 5},
                "decisionWallMsP50": 1,
                "decisionWallMsP95": 2,
            }
        elif arm.startswith("heuristic"):
            sims = self._arm_meta(arm, workers)["simulations"]
            performance["search"] = {
                "mode": "heuristic-batched",
                "decisions": 10,
                "simulations": 10 * sims,
                "byPhase": {"navigation": 5, "encounter": 5},
                "decisionWallMsP50": 1,
                "decisionWallMsP95": 2,
            }
        return {
            "schemaVersion": "solo-heldout-v2",
            "sourceCommit": self.source_commit,
            "weights": checkpoint["path"],
            "weightsSha256": checkpoint["sha256"],
            "catalog": catalog["path"],
            "catalogSha256": catalog["sha256"],
            "inference": {
                "format": "arc-entity-scorer-v2",
                "obsDim": 3419,
                "actDim": 104,
                "weightsPath": checkpoint["path"],
                "weightsSha256": checkpoint["sha256"],
                "wire": "binary",
            },
            "seed0": SEED0,
            "games": len(rows),
            "maxRounds": 30,
            "maxStatusLevel": 2,
            "decode": self._decode(arm),
            "trueWins": true_wins,
            "trueWinRate": true_wins / len(rows),
            "trueWinWilson95": {"lower": 0, "upper": 1},
            "namedWinRate": 1,
            "stalls": stalls,
            "stallRate": stalls / len(rows),
            "reach15Rate": 1,
            "nearMiss27To29Rate": 0,
            "vp": {"mean": 20, "p10": 20, "median": 20, "p90": 30, "min": 20, "max": 30},
            "vpBuckets": {
                "under15": 0,
                "from15To19": 0,
                "from20To24": len(rows) - true_wins,
                "from25To26": 0,
                "from27To29": 0,
                "atLeast30WithoutStall": true_wins,
                "stalledAtLeast30": sum(bool(row["stalled"]) and row["finalVP"] >= 30 for row in rows),
            },
            "guardianBreakdown": breakdown,
            "first30Round": {"mean": 25, "median": 25},
            "engine": {
                "meanPost15VpPerRound": 1,
                "meanFinalAttackDice": 4,
                "meanFinalSpirits": 4,
                "meanFinalMaxBarrier": 4,
            },
            "performance": performance,
            "perGame": rows,
        }

    def _write_report(self, arm: str, *, stalled_seed: int | None, wrong_guardian: bool) -> Path:
        workers = 24 if arm == "raw" else 8
        report = self._report_from_rows(
            arm, self._rows(stalled_seed=stalled_seed, wrong_guardian=wrong_guardian), workers
        )
        return write_json(self.root / "conditions" / arm / "report.json", report)

    def _replay(self, primary: dict[str, object]) -> dict[str, object]:
        replay = copy.deepcopy(primary)
        rows = copy.deepcopy(primary["perGame"][:REPLAY_GAMES])
        arm = "raw"
        decode = primary["decode"]
        if "rerank" in decode:
            weight = decode["rerank"]["policyRankWeight"]
            arm = {0.25: "rerank-p025", 0.5: "rerank-p050", 0.75: "rerank-p075", 1.0: "rerank-p100"}[weight]
        elif "search" in decode:
            arm = "heuristic-s4-h2" if decode["search"]["sims"] == 4 else "heuristic-s8-h3"
        rebuilt = self._report_from_rows(arm, rows, 8)
        for field in ("schemaVersion", "sourceCommit", "weights", "weightsSha256", "catalog", "catalogSha256", "inference", "maxRounds", "maxStatusLevel", "decode"):
            rebuilt[field] = copy.deepcopy(primary[field])
        return rebuilt


class AnalyzeV34GuardianTest(unittest.TestCase):
    def test_analysis_output_is_immutable_and_hash_sidecar_bound(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "analysis.json"
            write_immutable_json(out, {"schemaVersion": "fixture", "valid": True})
            self.assertEqual(
                out.with_name(out.name + ".sha256").read_text(),
                f"{sha256(out)}  {out.name}\n",
            )
            with self.assertRaises(FileExistsError):
                write_immutable_json(out, {"schemaVersion": "replacement"})

    def test_global_bootstrap_sign_matches_direct_reference(self) -> None:
        effects = np.asarray([100, 0, -100, 100, 0, 100, -100, 0] * 5, dtype=np.float64)
        guardians = np.arange(effects.size, dtype=np.int64) % 2
        draws = 201
        seed = 1234
        result = guardian_max_t(
            {"a": effects}, guardians, ["g0", "g1"], draws=draws, rng_seed=seed, chunk_size=17
        )
        observed = np.asarray([effects[guardians == g].mean() for g in range(2)])
        se = np.asarray(
            [effects[guardians == g].std(ddof=1) / math.sqrt(np.sum(guardians == g)) for g in range(2)]
        )
        rng = np.random.Generator(np.random.PCG64(seed))
        maxima = []
        for _ in range(draws):
            indices = rng.integers(0, effects.size, size=effects.size)
            sampled_guardians = guardians[indices]
            means = np.asarray(
                [effects[indices][sampled_guardians == g].mean() for g in range(2)]
            )
            maxima.append(float(np.max((means - observed) / se)))
        rank = math.ceil(0.95 * draws) - 1
        expected = float(np.partition(np.asarray(maxima), rank)[rank])
        self.assertAlmostEqual(result["empiricalCritical"], expected, places=12)
        self.assertEqual(
            result["studentization"], "(bootstrapMean-observedMean)/originalPairedSE"
        )

    def test_shared_draws_reproducible_ddof1_and_fixed60_floor(self) -> None:
        a = np.asarray([100, 0, -100, 0] * 10, dtype=np.float64)
        b = -a
        guardians = np.arange(a.size, dtype=np.int64) % 2
        one = guardian_max_t(
            {"a": a, "b": b}, guardians, ["g0", "g1"], draws=300, rng_seed=99
        )
        two = guardian_max_t(
            {"a": a, "b": b}, guardians, ["g0", "g1"], draws=300, rng_seed=99
        )
        self.assertEqual(one["bootstrapMaximaSha256"], two["bootstrapMaximaSha256"])
        expected_se = a[guardians == 0].std(ddof=1) / math.sqrt(np.sum(guardians == 0))
        self.assertAlmostEqual(one["endpoints"]["a"]["g0"]["standardError"], expected_se)
        floor = NormalDist().inv_cdf(1 - 0.05 / FROZEN_FAMILY_SIZE)
        self.assertAlmostEqual(one["fixed60NormalFloor"], floor)
        self.assertGreaterEqual(one["critical"], floor)
        self.assertEqual(one["registeredFamilySize"], 60)

    def test_zero_se_and_strict_lower_boundary(self) -> None:
        zero = guardian_cell(-5.0, 0.0, 4.0, 819)
        self.assertEqual(zero["simultaneousLower"], -5.0)
        self.assertTrue(zero["cellPass"])
        boundary = guardian_cell(-5.0, 1.25, 4.0, 819)
        self.assertEqual(boundary["simultaneousLower"], -10.0)
        self.assertTrue(boundary["pointAtLeastMinus5"])
        self.assertFalse(boundary["lowerStrictlyAboveMinus10"])
        self.assertFalse(boundary["cellPass"])

    def test_empty_bootstrap_guardian_cell_aborts(self) -> None:
        effects = np.asarray([100, -100, *([0] * 8)], dtype=np.float64)
        guardians = np.asarray([0, 0, *([1] * 8)], dtype=np.int64)
        with self.assertRaisesRegex(ValueError, "empty guardian cell"):
            guardian_max_t(
                {"a": effects}, guardians, ["rare", "common"], draws=100, rng_seed=1
            )

    def test_k0_closes_without_execution_and_all_flags_false(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture(Path(tmp))
            result = analyze_guardian(
                repo=REPO,
                protocol=fixture.protocol,
                authorization=fixture.authorization,
                execution_lock=None,
                manifest_paths=[],
                verify_git=False,
            )
        self.assertEqual(result["decision"]["laneAStatus"], "closed-no-core-pass")
        self.assertIsNone(result["selectedArm"])
        self.assertIsNone(result["simultaneousFamily"])
        self.assertFalse(result["decision"]["guardianExecuted"])
        for key in AUTHORIZATION_FLAGS:
            self.assertIs(result["decision"][key], False)

    def test_phase2_ranking_filters_survivors_without_guardian_reorder(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture(
                Path(tmp),
                passing=("rerank-p025", "rerank-p050"),
                phase2_win={"rerank-p025": 4.0, "rerank-p050": 6.0},
            )
            result = analyze_guardian(
                repo=REPO,
                protocol=fixture.protocol,
                authorization=fixture.authorization,
                execution_lock=fixture.execution,
                manifest_paths=fixture.condition_paths,
                verify_git=False,
            )
        self.assertEqual(result["guardianSurvivors"], ["rerank-p025", "rerank-p050"])
        self.assertEqual(result["contract"]["phase2RankedArms"], ["rerank-p050", "rerank-p025"])
        self.assertEqual(result["selectedArm"], "rerank-p050")
        self.assertTrue(result["decision"]["phase2RankingPreserved"])
        for key in AUTHORIZATION_FLAGS:
            self.assertIs(result["decision"][key], False)

    def test_candidate_measured_stall_is_arm_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture(
                Path(tmp), passing=("rerank-p025",), candidate_stalls={"rerank-p025": 1}
            )
            result = analyze_guardian(
                repo=REPO,
                protocol=fixture.protocol,
                authorization=fixture.authorization,
                execution_lock=fixture.execution,
                manifest_paths=fixture.condition_paths,
                verify_git=False,
            )
        self.assertEqual(result["arms"][0]["stalls"], 1)
        self.assertFalse(result["arms"][0]["gates"]["candidateStallsZero"])
        self.assertFalse(result["arms"][0]["survives"])
        self.assertEqual(result["decision"]["laneAStatus"], "closed-no-guardian-survivor")

    def test_raw_measured_stall_aborts_the_shared_campaign(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture(
                Path(tmp), passing=("rerank-p025",), raw_stall_seed=SEED0 + 1
            )
            with self.assertRaisesRegex(ValueError, "raw guardian reference stalled"):
                analyze_guardian(
                    repo=REPO,
                    protocol=fixture.protocol,
                    authorization=fixture.authorization,
                    execution_lock=fixture.execution,
                    manifest_paths=fixture.condition_paths,
                    verify_git=False,
                )

    def test_wrong_seed_modulo_guardian_assignment_aborts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture(
                Path(tmp), passing=("rerank-p025",), wrong_guardian_arm="rerank-p025"
            )
            with self.assertRaisesRegex(ValueError, "guardian is not seed % 10"):
                analyze_guardian(
                    repo=REPO,
                    protocol=fixture.protocol,
                    authorization=fixture.authorization,
                    execution_lock=fixture.execution,
                    manifest_paths=fixture.condition_paths,
                    verify_git=False,
                )

    def test_completion_sidecar_and_exact_integrity_evidence_are_required(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture(Path(tmp), passing=("rerank-p025",))
            completion = fixture.condition_paths[0]
            sidecar = completion.with_name(completion.name + ".sha256")
            sidecar.unlink()
            with self.assertRaisesRegex(ValueError, "completion sidecar"):
                analyze_guardian(
                    repo=REPO,
                    protocol=fixture.protocol,
                    authorization=fixture.authorization,
                    execution_lock=fixture.execution,
                    manifest_paths=fixture.condition_paths,
                    verify_git=False,
                )
            write_text(sidecar, f"{sha256(completion)}  {completion.name}\n")
            manifest = json.loads(completion.read_text())
            manifest["integrity"]["evidence"]["provenance"]["fixedInferenceProcess"] = False
            write_completion(completion, manifest)
            with self.assertRaisesRegex(ValueError, "provenance"):
                analyze_guardian(
                    repo=REPO,
                    protocol=fixture.protocol,
                    authorization=fixture.authorization,
                    execution_lock=fixture.execution,
                    manifest_paths=fixture.condition_paths,
                    verify_git=False,
                )

    def test_resource_persistent_remaining_conditions_is_derived(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture(Path(tmp), passing=("rerank-p025",))
            completion = fixture.condition_paths[0]
            manifest = json.loads(completion.read_text())
            resource_path = Path(manifest["inputs"]["resourceSnapshot"]["path"])
            resource = json.loads(resource_path.read_text())
            resource["persistent"]["remainingConditions"] -= 1
            write_json(resource_path, resource)
            launch_path = Path(manifest["inputs"]["launch"]["path"])
            launch = json.loads(launch_path.read_text())
            launch["resourceSnapshot"] = phase2_ref(resource_path)
            write_json(launch_path, launch)
            manifest["inputs"]["resourceSnapshot"] = record(resource_path)
            manifest["inputs"]["launch"] = record(launch_path)
            write_completion(completion, manifest)
            with self.assertRaisesRegex(ValueError, "persistent headroom mismatch"):
                analyze_guardian(
                    repo=REPO,
                    protocol=fixture.protocol,
                    authorization=fixture.authorization,
                    execution_lock=fixture.execution,
                    manifest_paths=fixture.condition_paths,
                    verify_git=False,
                )

    def test_replay_corruption_aborts_before_analysis(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture(Path(tmp), passing=("rerank-p025",))
            completion = fixture.condition_paths[0]
            manifest = json.loads(completion.read_text())
            replay_path = Path(manifest["inputs"]["replayReport"]["path"])
            replay = json.loads(replay_path.read_text())
            replay["perGame"][0]["finalVP"] += 1
            write_json(replay_path, replay)
            manifest["inputs"]["replayReport"] = record(replay_path)
            write_completion(completion, manifest)
            with self.assertRaisesRegex(ValueError, "replay is not exact"):
                analyze_guardian(
                    repo=REPO,
                    protocol=fixture.protocol,
                    authorization=fixture.authorization,
                    execution_lock=fixture.execution,
                    manifest_paths=fixture.condition_paths,
                    verify_git=False,
                )

    def test_serving_reload_and_launch_argv_tampering_abort(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture(Path(tmp), passing=("rerank-p025",))
            completion = fixture.condition_paths[0]
            manifest = json.loads(completion.read_text())
            infer_path = Path(manifest["inputs"]["inferLog"]["path"])
            write_text(
                infer_path,
                infer_path.read_text() + "[infer] reloaded weights fixture\n",
            )
            manifest["inputs"]["inferLog"] = record(infer_path)
            write_completion(completion, manifest)
            with self.assertRaisesRegex(ValueError, "inference server lifecycle"):
                analyze_guardian(
                    repo=REPO,
                    protocol=fixture.protocol,
                    authorization=fixture.authorization,
                    execution_lock=fixture.execution,
                    manifest_paths=fixture.condition_paths,
                    verify_git=False,
                )
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture(Path(tmp), passing=("rerank-p025",))
            completion = fixture.condition_paths[0]
            manifest = json.loads(completion.read_text())
            launch_path = Path(manifest["inputs"]["launch"]["path"])
            launch = json.loads(launch_path.read_text())
            launch["evaluatorArgs"][0] = "scripts/not-the-frozen-evaluator.mjs"
            write_json(launch_path, launch)
            manifest["inputs"]["launch"] = record(launch_path)
            write_completion(completion, manifest)
            with self.assertRaisesRegex(ValueError, "launch evaluator argv"):
                analyze_guardian(
                    repo=REPO,
                    protocol=fixture.protocol,
                    authorization=fixture.authorization,
                    execution_lock=fixture.execution,
                    manifest_paths=fixture.condition_paths,
                    verify_git=False,
                )

    def test_missing_condition_and_k0_execution_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture(Path(tmp), passing=("rerank-p025",))
            with self.assertRaisesRegex(ValueError, "one raw plus every authorized arm"):
                analyze_guardian(
                    repo=REPO,
                    protocol=fixture.protocol,
                    authorization=fixture.authorization,
                    execution_lock=fixture.execution,
                    manifest_paths=fixture.condition_paths[:-1],
                    verify_git=False,
                )
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture(Path(tmp))
            with self.assertRaisesRegex(ValueError, "K=0 forbids"):
                analyze_guardian(
                    repo=REPO,
                    protocol=fixture.protocol,
                    authorization=fixture.authorization,
                    execution_lock=fixture.protocol,
                    manifest_paths=[],
                    verify_git=False,
                )

    def test_authorization_later_flag_and_phase2_rank_tampering_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture = Fixture(
                root,
                passing=("rerank-p025", "rerank-p050"),
                phase2_win={"rerank-p025": 4.0, "rerank-p050": 6.0},
            )
            bad = copy.deepcopy(fixture.authorization.value)
            bad["authorization"]["hiddenSeedsOpen"] = True
            bad_path = write_json(root / "bad-auth-flags.json", bad)
            with self.assertRaisesRegex(ValueError, "hiddenSeedsOpen"):
                analyze_guardian(
                    repo=REPO,
                    protocol=fixture.protocol,
                    authorization=load_json(bad_path, "bad authorization"),
                    execution_lock=fixture.execution,
                    manifest_paths=fixture.condition_paths,
                    verify_git=False,
                )
            bad = copy.deepcopy(fixture.authorization.value)
            bad["phase2RankedArms"] = ["rerank-p025", "rerank-p050"]
            bad["phase2Leader"] = "rerank-p025"
            bad_path = write_json(root / "bad-auth-rank.json", bad)
            with self.assertRaisesRegex(ValueError, "ranking"):
                analyze_guardian(
                    repo=REPO,
                    protocol=fixture.protocol,
                    authorization=load_json(bad_path, "bad authorization"),
                    execution_lock=fixture.execution,
                    manifest_paths=fixture.condition_paths,
                    verify_git=False,
                )

    def test_retry_requires_outcome_blind_empty_attempt1(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            execution_path = write_json(root / "execution.json", {"schemaVersion": "fixture"})
            execution = load_json(execution_path, "execution")
            failure_files = {}
            for name in (
                "launch",
                "resourceSnapshot",
                "launchPid",
                "exitCode",
                "inferLog",
                "stdout",
                "stderr",
            ):
                failure_files[name] = record(
                    write_text(root / "attempt-1" / f"{name}.txt", "fixture\n")
                )
            failure_path = write_json(
                root / "attempt-1" / "failure.json",
                {
                    "schemaVersion": "arc-v34-guardian-attempt-failure-v1",
                    "condition": "rerank-p025",
                    "attempt": 1,
                    "reasonCode": "server-start",
                    "exitCode": 90,
                    "runtimeError": True,
                    "reportExists": False,
                    "replayReportExists": False,
                    "outcomesInspected": False,
                    "sourceCommit": "f" * 40,
                    "guardianExecutionLockSha256": execution.sha256,
                    "files": failure_files,
                },
            )
            justification = {
                "schemaVersion": "arc-v34-guardian-retry-justification-v1",
                "condition": "rerank-p025",
                "attempt": 2,
                "reason": "infrastructure server socket failed before launch",
                "reasonCode": "server-start",
                "infrastructureAttributed": True,
                "identicalSeedRetry": True,
                "outcomesInspected": False,
                "attempt1ReportExisted": False,
                "attempt1ReplayReportExisted": False,
                "sourceCommit": "f" * 40,
                "guardianExecutionLockSha256": execution.sha256,
                "seed0": SEED0,
                "games": GAMES,
                "seedMax": SEED_MAX,
                "failureEvidence": record(failure_path),
            }
            path = write_json(root / "retry.json", justification)
            validate_retry_justification(
                load_json(path, "retry"),
                arm="rerank-p025",
                source_commit="f" * 40,
                execution_lock=execution,
                repo=REPO,
            )
            bad = copy.deepcopy(justification)
            bad["reason"] = "retry because the outcome score was weak"
            bad_path = write_json(root / "retry-outcome.json", bad)
            with self.assertRaisesRegex(ValueError, "outcome-blind"):
                validate_retry_justification(
                    load_json(bad_path, "bad retry"),
                    arm="rerank-p025",
                    source_commit="f" * 40,
                    execution_lock=execution,
                    repo=REPO,
                )
            write_json(root / "attempt-1" / "report.json", {})
            with self.assertRaisesRegex(ValueError, "report.json exists"):
                validate_retry_justification(
                    load_json(path, "retry"),
                    arm="rerank-p025",
                    source_commit="f" * 40,
                    execution_lock=execution,
                    repo=REPO,
                )


if __name__ == "__main__":
    unittest.main()
