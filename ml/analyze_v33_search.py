#!/usr/bin/env python3
"""Fail-closed paired analyzer for the frozen V33 strategic-search screen."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
from typing import Any

import numpy as np


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    require(isinstance(value, dict), f"{path}: expected object")
    return value


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def finite(value: Any, label: str) -> float:
    require(isinstance(value, (int, float)) and math.isfinite(float(value)), f"{label}: not finite")
    return float(value)


def paired_vectors(raw: list[dict[str, Any]], treatment: list[dict[str, Any]]) -> dict[str, np.ndarray]:
    require(len(raw) == len(treatment) and len(raw) > 0, "paired rows must be nonempty and equal")
    vectors: dict[str, list[float]] = {"trueWin": [], "finalVP": [], "post15": [], "censoredRound": []}
    for index, (base, arm) in enumerate(zip(raw, treatment, strict=True)):
        require(base["seed"] == arm["seed"], f"seed mismatch at row {index}")
        vectors["trueWin"].append(float(bool(arm["trueWin"])) - float(bool(base["trueWin"])))
        vectors["finalVP"].append(finite(arm["finalVP"], "arm finalVP") - finite(base["finalVP"], "raw finalVP"))
        vectors["post15"].append(
            finite(arm["post15VpPerRound"], "arm post15")
            - finite(base["post15VpPerRound"], "raw post15")
        )
        base_round = 31 if base.get("first30Round") is None else finite(base["first30Round"], "raw first30")
        arm_round = 31 if arm.get("first30Round") is None else finite(arm["first30Round"], "arm first30")
        vectors["censoredRound"].append(arm_round - base_round)
    return {key: np.asarray(value, dtype=np.float64) for key, value in vectors.items()}


def paired_bootstrap(
    contrasts: dict[str, dict[str, np.ndarray]],
    *,
    draws: int,
    rng_seed: int,
    interval_confidence: float,
) -> dict[str, dict[str, dict[str, float]]]:
    require(contrasts and draws > 0, "bootstrap requires contrasts and draws")
    first = next(iter(contrasts.values()))
    n = len(next(iter(first.values())))
    require(n > 0, "bootstrap vectors empty")
    for arm, metrics in contrasts.items():
        for name, vector in metrics.items():
            require(len(vector) == n and np.isfinite(vector).all(), f"{arm}/{name}: malformed vector")
    samples = {
        arm: {name: np.empty(draws, dtype=np.float64) for name in metrics}
        for arm, metrics in contrasts.items()
    }
    rng = np.random.default_rng(rng_seed)
    chunk = 200
    for start in range(0, draws, chunk):
        stop = min(draws, start + chunk)
        indices = rng.integers(0, n, size=(stop - start, n), endpoint=False)
        for arm, metrics in contrasts.items():
            for name, vector in metrics.items():
                samples[arm][name][start:stop] = vector[indices].mean(axis=1)
    alpha = 1.0 - interval_confidence
    result: dict[str, dict[str, dict[str, float]]] = {}
    for arm, metrics in contrasts.items():
        result[arm] = {}
        for name, vector in metrics.items():
            result[arm][name] = {
                "mean": float(vector.mean()),
                "lower": float(np.quantile(samples[arm][name], alpha / 2)),
                "upper": float(np.quantile(samples[arm][name], 1 - alpha / 2)),
            }
    return result


def guardian_deltas(raw: list[dict[str, Any]], arm: list[dict[str, Any]]) -> dict[str, float]:
    raw_by: dict[str, list[int]] = {}
    arm_by: dict[str, list[int]] = {}
    for base, treatment in zip(raw, arm, strict=True):
        require(base["guardian"] == treatment["guardian"], "paired guardian mismatch")
        guardian = str(base["guardian"])
        raw_by.setdefault(guardian, []).append(int(bool(base["trueWin"])))
        arm_by.setdefault(guardian, []).append(int(bool(treatment["trueWin"])))
    require(raw_by.keys() == arm_by.keys() and raw_by, "guardian coverage mismatch")
    return {
        guardian: 100.0 * (float(np.mean(arm_by[guardian])) - float(np.mean(raw_by[guardian])))
        for guardian in sorted(raw_by)
    }


def gate_contrast(
    interval: dict[str, dict[str, float]],
    guardians: dict[str, float],
    latency: dict[str, float],
    *,
    stalls: int,
    integrity_pass: bool = True,
) -> dict[str, Any]:
    checks = {
        "pairedWinGain": interval["trueWin"]["mean"] * 100 >= 3,
        "pairedWinLower": interval["trueWin"]["lower"] > 0,
        "finalVpNonRegression": interval["finalVP"]["mean"] >= 0,
        "post15NonRegression": interval["post15"]["mean"] >= 0,
        "censoredRoundNonRegression": interval["censoredRound"]["mean"] <= 0,
        "zeroStalls": stalls == 0,
        "singleConcurrencyLatency": finite(latency["single"], "single latency") <= 1000,
        "eightConcurrencyLatency": finite(latency["eight"], "eight latency") <= 2000,
        "informationSafetyEvidence": integrity_pass,
        "replayEvidence": integrity_pass,
        "zeroServingErrors": integrity_pass,
        "provenanceVerified": integrity_pass,
    }
    non_guardian_pass = all(checks.values())
    guardian_min = min(guardians.values())
    guardian_pass = guardian_min >= -5
    return {
        "checks": checks,
        "nonGuardianPass": non_guardian_pass,
        "guardianMinPointDelta": guardian_min,
        "guardianPass": guardian_pass,
        "guardianConfirmationRequired": non_guardian_pass and not guardian_pass,
        "eligible": non_guardian_pass and guardian_pass,
    }


def verify_source_lock(repo: Path, source_lock: dict[str, Any]) -> None:
    require(source_lock.get("schemaVersion") == "arc-v33-source-lock-v1", "source lock schema")
    for name, expected in source_lock.get("files", {}).items():
        path = repo / name
        require(path.is_file() and sha256(path) == expected, f"source lock mismatch: {name}")
    if repo.joinpath(".git").exists():
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
        require(head == source_lock.get("implementationCommit"), "source lock commit differs from HEAD")


def validate_report(
    report: dict[str, Any],
    *,
    protocol: dict[str, Any],
    source_lock: dict[str, Any],
    arm: dict[str, Any],
    seed0: int,
    games: int,
) -> list[dict[str, Any]]:
    label = arm["id"]
    require(report.get("schemaVersion") == "solo-heldout-v2", f"{label}: report schema")
    require(report.get("seed0") == seed0 and report.get("games") == games, f"{label}: seed design")
    require(report.get("catalogSha256") == protocol["catalog"]["sha256"], f"{label}: catalog hash")
    require(report.get("weightsSha256") == protocol["policy"]["sha256"], f"{label}: policy hash")
    inference = report.get("inference", {})
    require(
        inference.get("weightsSha256") == protocol["policy"]["sha256"]
        and inference.get("format") == protocol["policy"]["format"]
        and inference.get("wire") == protocol["commonDecode"]["inferenceWire"],
        f"{label}: served checkpoint/wire provenance",
    )
    require(report.get("sourceCommit") == source_lock["implementationCommit"], f"{label}: source commit")
    require(report.get("maxRounds") == 30 and report.get("maxStatusLevel") == 2, f"{label}: game contract")
    decode = report.get("decode", {})
    require(
        decode.get("policyObsVersion") == 2
        and isinstance(decode.get("inferenceSocket"), str)
        and decode.get("sample") is True
        and decode.get("temperature") == 0.55
        and decode.get("learnMonsterRewardChoices") is False,
        f"{label}: decode contract",
    )
    if arm["sims"] == 0:
        require("search" not in decode, "raw report unexpectedly searched")
    else:
        expected = {
            "sims": arm["sims"],
            "objective": "solo-reach30",
            "horizonRounds": arm["horizonRounds"],
            "frac": 1,
            "valueWeight": 0.5,
            "rollout": "policy",
            "navTemperature": 0,
        }
        require(decode.get("search") == expected, f"{label}: search contract")
        telemetry = report.get("performance", {}).get("search", {})
        require(
            int(telemetry.get("decisions", 0)) > 0
            and int(telemetry.get("simulations", -1)) == int(telemetry["decisions"]) * arm["sims"],
            f"{label}: simulation telemetry",
        )
    rows = report.get("perGame")
    require(isinstance(rows, list) and len(rows) == games, f"{label}: per-game coverage")
    rows = sorted(rows, key=lambda row: row["seed"])
    require([row["seed"] for row in rows] == list(range(seed0, seed0 + games)), f"{label}: exact seeds")
    require(all(row.get("stalled") is False for row in rows), f"{label}: stalled game")
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--source-lock", type=Path, required=True)
    parser.add_argument("--authorization", type=Path, required=True)
    parser.add_argument("--systems", type=Path, required=True)
    parser.add_argument("--report", action="append", required=True, help="ARM=PATH")
    parser.add_argument("--guardian-report", action="append", default=[], help="ARM=PATH")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    repo = args.repo.resolve()
    protocol = load_json(args.protocol)
    source_lock = load_json(args.source_lock)
    authorization = load_json(args.authorization)
    systems = load_json(args.systems)
    verify_source_lock(repo, source_lock)
    require(authorization.get("schemaVersion") == "arc-v33-phase2-authorization-v1", "authorization schema")
    require(authorization.get("authorization", {}).get("phase2SeedsOpen") is True, "phase2 not authorized")
    require(authorization["sourceLock"]["sha256"] == sha256(args.source_lock), "authorization source lock hash")
    require(authorization["systemsEligibility"]["sha256"] == sha256(args.systems), "authorization systems hash")
    eligible_ids = authorization["eligibleSearchArms"]
    require(eligible_ids == systems["eligibleSearchArms"] and eligible_ids, "eligible arm mismatch")
    preflight_record = systems.get("preflight", {})
    preflight_path = repo / preflight_record.get("path", "")
    require(
        preflight_path.is_file()
        and sha256(preflight_path) == preflight_record.get("sha256")
        and load_json(preflight_path).get("passed") is True,
        "frozen integrity preflight evidence mismatch",
    )
    arm_map = {arm["id"]: arm for arm in protocol["systems"]["arms"]}
    report_paths: dict[str, Path] = {}
    for item in args.report:
        label, separator, raw_path = item.partition("=")
        require(bool(separator) and label not in report_paths, f"invalid duplicate --report {item}")
        report_paths[label] = Path(raw_path)
    require(set(report_paths) == {"raw", *eligible_ids}, "report set must be raw plus every eligible arm")
    rows: dict[str, list[dict[str, Any]]] = {}
    reports: dict[str, dict[str, Any]] = {}
    for label, report_path in report_paths.items():
        reports[label] = load_json(report_path)
        rows[label] = validate_report(
            reports[label],
            protocol=protocol,
            source_lock=source_lock,
            arm=arm_map[label],
            seed0=protocol["phase2"]["seed0"],
            games=protocol["phase2"]["games"],
        )
    contrasts = {label: paired_vectors(rows["raw"], rows[label]) for label in eligible_ids}
    intervals = paired_bootstrap(
        contrasts,
        draws=protocol["phase2"]["bootstrap"]["draws"],
        rng_seed=protocol["phase2"]["bootstrap"]["rngSeed"],
        interval_confidence=protocol["phase2"]["simultaneousConfidence"],
    )
    system_by = {arm["id"]: arm for arm in systems["arms"]}
    analyses: dict[str, Any] = {}
    for label in eligible_ids:
        guardians = guardian_deltas(rows["raw"], rows[label])
        latency = {
            "single": system_by[label]["singleConcurrentSearchDecisionP95Ms"],
            "eight": system_by[label]["eightConcurrentSearchDecisionP95Ms"],
        }
        analyses[label] = {
            "dose": arm_map[label],
            "paired": intervals[label],
            "guardianPointDeltas": guardians,
            "latencyMs": latency,
            "gate": gate_contrast(
                intervals[label], guardians, latency, stalls=int(reports[label]["stalls"])
            ),
        }
    pending_guardian = [
        label for label, analysis in analyses.items() if analysis["gate"]["guardianConfirmationRequired"]
    ]
    guardian_report_paths: dict[str, Path] = {}
    guardian_rows: dict[str, list[dict[str, Any]]] = {}
    for item in args.guardian_report:
        label, separator, raw_path = item.partition("=")
        require(bool(separator) and label not in guardian_report_paths, f"invalid guardian report {item}")
        guardian_report_paths[label] = Path(raw_path)
    if guardian_report_paths:
        require(bool(pending_guardian), "guardian reports supplied without the frozen trigger")
        require(
            set(guardian_report_paths) == {"raw", *eligible_ids},
            "guardian report set must be raw plus every frozen phase2 arm",
        )
        confirmation = protocol["guardianConfirmation"]
        for label, report_path in guardian_report_paths.items():
            guardian_report = load_json(report_path)
            guardian_rows[label] = validate_report(
                guardian_report,
                protocol=protocol,
                source_lock=source_lock,
                arm=arm_map[label],
                seed0=confirmation["seed0"],
                games=confirmation["games"],
            )
        for label in eligible_ids:
            pooled = guardian_deltas(
                rows["raw"] + guardian_rows["raw"], rows[label] + guardian_rows[label]
            )
            latency = analyses[label]["latencyMs"]
            analyses[label]["guardianPointDeltas"] = pooled
            analyses[label]["gate"] = gate_contrast(
                intervals[label], pooled, latency, stalls=int(reports[label]["stalls"])
            )
        pending_guardian = []
    eligible = [label for label, analysis in analyses.items() if analysis["gate"]["eligible"]]
    selected = None
    if eligible and not pending_guardian:
        selected = sorted(
            eligible,
            key=lambda label: (
                -round(analyses[label]["paired"]["trueWin"]["mean"] * 100, 12),
                arm_map[label]["sims"],
                arm_map[label]["horizonRounds"],
            ),
        )[0]
        best = max(analyses[label]["paired"]["trueWin"]["mean"] * 100 for label in eligible)
        tied = [
            label
            for label in eligible
            if best - analyses[label]["paired"]["trueWin"]["mean"] * 100 < 1
        ]
        selected = min(tied, key=lambda label: (arm_map[label]["sims"], arm_map[label]["horizonRounds"]))
    result = {
        "schemaVersion": "arc-v33-phase2-analysis-v1",
        "sourceLock": {"path": str(args.source_lock), "sha256": sha256(args.source_lock)},
        "authorization": {"path": str(args.authorization), "sha256": sha256(args.authorization)},
        "systems": {"path": str(args.systems), "sha256": sha256(args.systems)},
        "reports": {label: {"path": str(path), "sha256": sha256(path)} for label, path in report_paths.items()},
        "guardianConfirmationReports": {
            label: {"path": str(path), "sha256": sha256(path)}
            for label, path in guardian_report_paths.items()
        },
        "guardianConfirmationUsed": bool(guardian_report_paths),
        "familySize": protocol["phase2"]["familySize"],
        "intervalConfidence": protocol["phase2"]["simultaneousConfidence"],
        "bootstrapDraws": protocol["phase2"]["bootstrap"]["draws"],
        "analyses": analyses,
        "guardianConfirmationRequired": bool(pending_guardian),
        "guardianConfirmationArms": pending_guardian,
        "selectedArm": selected,
        "authorizationResult": {
            "phase3DevelopmentSeedsOpen": selected is not None,
            "hiddenSeedsOpen": False,
            "expertIterationSeedsOpen": False,
            "productionPromotionOpen": False,
        },
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
