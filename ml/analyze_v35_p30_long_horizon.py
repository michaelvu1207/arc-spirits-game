#!/usr/bin/env python3
"""Fail-closed paired analyzer for the review-gated V35 P30 dose screen."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
from typing import Any, Mapping

import numpy as np


SCHEMA = "arc-v35-p30-long-horizon-analysis-v1"
PROTOCOL_SCHEMA = "arc-v35-p30-long-horizon-protocol-v1"
INPUT_SCHEMA = "arc-v35-p30-development-input-v1"
INPUT_AUTH_SCHEMA = "arc-v35-p30-analysis-authorization-v1"
REPORT_SCHEMA = "solo-heldout-v2"
SOURCE_LOCK_SCHEMA = "arc-v35-p30-source-lock-v1"
REPLICATES = ("a", "b", "c")
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
        return path
    cwd_path = (Path.cwd() / path).resolve()
    return cwd_path if cwd_path.exists() else (anchor / path).resolve()


def finite(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label} must be finite")
    return result


def validate_protocol(protocol: Mapping[str, Any], *, require_authorized: bool = True) -> None:
    if protocol.get("schemaVersion") != PROTOCOL_SCHEMA:
        raise ValueError("unexpected P30 protocol schema")
    if protocol.get("promotionEligible") is not False:
        raise ValueError("P30 development protocol must remain promotion-ineligible")
    if not is_git_commit(protocol.get("implementationBaseCommit")):
        raise ValueError("P30 implementation base commit is invalid")
    initial_policy = protocol.get("initialPolicy")
    if not isinstance(initial_policy, dict) or {
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
        {"id": "a", "trainBase": 967100000, "evalBase": 967500000},
        {"id": "b", "trainBase": 967200000, "evalBase": 967600000},
        {"id": "c", "trainBase": 967300000, "evalBase": 967700000},
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
        "sample": True,
        "temperature": 0.55,
        "strategicDecisionScope": "engine-cycle",
        "guardianSchedule": "absolute-balanced",
        "workers": 24,
    }:
        raise ValueError("P30 safety-critical training contract changed")
    runtime = protocol.get("runtime")
    if not isinstance(runtime, dict) or {
        "physicalGpu": runtime.get("physicalGpu"),
        "gpuUuid": runtime.get("gpuUuid"),
        "forbiddenGpus": runtime.get("forbiddenGpus"),
        "maxConcurrentRoots": runtime.get("maxConcurrentRoots"),
    } != {
        "physicalGpu": 7,
        "gpuUuid": "GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0",
        "forbiddenGpus": [4, 5, 6],
        "maxConcurrentRoots": 1,
    }:
        raise ValueError("P30 GPU allocation contract changed")
    review = protocol.get("review")
    if not isinstance(review, dict):
        raise ValueError("P30 protocol lacks a review record")
    if require_authorized and (
        protocol.get("status") != "authorized"
        or protocol.get("authorized") is not True
        or review.get("verdict") != "ACCEPT"
        or not isinstance(review.get("artifact"), str)
        or not is_sha256(review.get("sha256"))
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
        or bootstrap.get("method") != "crossed-paired-replicate-and-common-seed-diagnostic"
        or bootstrap.get("draws") != 20000
        or bootstrap.get("seed") != 35153040
    ):
        raise ValueError("P30 diagnostic bootstrap changed")
    decision = analysis.get("decisionInference")
    if decision != {"method": "paired-training-replicate-t", "degreesOfFreedom": 2, "oneSided": True}:
        raise ValueError("P30 decision inference changed")
    if analysis.get("expectedGuardianCount") != 10:
        raise ValueError("P30 guardian registry size changed")
    if analysis.get("minimumPositiveReplicates") != 2:
        raise ValueError("P30 replicate consistency requirement changed")
    if finite(analysis.get("minimumReplicateTrueWinGain"), "minimumReplicateTrueWinGain") != -0.01:
        raise ValueError("P30 replicate floor changed")
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


def paired_replicate_t(values: np.ndarray) -> dict[str, Any]:
    """One-sided paired t inference over the three independently trained replicate pairs.

    Evaluation seeds are a fixed common public block. The inferential unit is therefore
    the training replicate, not each of the 4,096 correlated game rows. For df=2 the
    Student-t survival function has a closed form, avoiding an undeclared SciPy runtime.
    """
    if values.ndim != 2 or values.shape[0] != len(REPLICATES) or values.shape[1] < 1:
        raise ValueError("paired t inference requires replicate-by-seed values")
    replicate_points = values.mean(axis=1)
    point = float(replicate_points.mean())
    standard_error = float(replicate_points.std(ddof=1) / math.sqrt(len(REPLICATES)))
    if standard_error == 0:
        statistic = None
        one_sided_p = 0.0 if point > 0 else (1.0 if point < 0 else 0.5)
        lower = upper = point
    else:
        statistic = point / standard_error
        one_sided_p = 0.5 - statistic / (2.0 * math.sqrt(statistic * statistic + 2.0))
        critical = 2.919985580353724
        lower = point - critical * standard_error
        upper = point + critical * standard_error
    return {
        "point": point,
        "replicatePoints": [float(value) for value in replicate_points],
        "standardError": standard_error,
        "tStatistic": None if statistic is None else float(statistic),
        "degreesOfFreedom": 2,
        "oneSidedP": min(max(float(one_sided_p), 0.0), 1.0),
        "lower95": float(lower),
        "upper95": float(upper),
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
        raise ValueError("analysis requires the exact nine replicate-arm endpoints")
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
            decision_summary = paired_replicate_t(matrix)
            draws = hierarchical_draws(
                matrix,
                draws=draws_count,
                seed=bootstrap_seed + treatment_index * 1000 + metric_index,
            )
            metrics[metric] = {
                **decision_summary,
                "diagnosticCrossedBootstrapQ05": float(np.quantile(draws, 0.05)),
                "diagnosticCrossedBootstrapQ95": float(np.quantile(draws, 0.95)),
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
                **paired_replicate_t(matrix),
                "diagnosticCrossedBootstrapQ05": float(np.quantile(draws, 0.05)),
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
            comparison["metrics"][metric]["holmAdjustedP"] <= alpha
            and comparison["metrics"][metric]["lower95"] > 0
            for metric in PRIMARY
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
                and min(comparison["metrics"]["trueWinRate"]["replicatePoints"])
                >= finite(
                    analysis["minimumReplicateTrueWinGain"],
                    "minimumReplicateTrueWinGain",
                )
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
            "malformedEpisodes": True,
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


def load_inputs(
    protocol_path: Path, manifest_path: Path, authorization_path: Path
) -> tuple[dict[str, Any], dict[str, dict[int, dict[str, Any]]], dict[str, dict[str, Any]]]:
    protocol = json.loads(protocol_path.read_text())
    validate_protocol(protocol, require_authorized=True)
    review_path = resolve_artifact(
        protocol["review"]["artifact"], anchor=protocol_path.parent, label="Fable review"
    )
    if not review_path.is_file() or sha256(review_path) != protocol["review"]["sha256"]:
        raise ValueError("Fable review artifact is missing or hash-invalid")
    review_lines = [line.strip() for line in review_path.read_text().splitlines() if line.strip()]
    if not review_lines or review_lines[-1] != "VERDICT: ACCEPT":
        raise ValueError("Fable review artifact does not end in an ACCEPT verdict")
    source_contract = protocol["sourceContract"]
    source_lock_path = resolve_artifact(
        source_contract["artifact"], anchor=protocol_path.parent, label="source contract"
    )
    if not source_lock_path.is_file() or sha256(source_lock_path) != source_contract["sha256"]:
        raise ValueError("P30 source contract is missing or hash-invalid")
    source_lock = json.loads(source_lock_path.read_text())
    if (
        not isinstance(source_lock, dict)
        or source_lock.get("schemaVersion") != SOURCE_LOCK_SCHEMA
        or source_lock.get("authorized") is not True
        or source_lock.get("immutable") is not True
        or source_lock.get("promotionEligible") is not False
        or not is_git_commit(source_lock.get("implementationCommit"))
    ):
        raise ValueError("P30 source contract is not an immutable development-only lock")
    source_files = source_lock.get("files")
    required_source_files = {
        "packageLock",
        "mlRequirements",
        "runRoot",
        "leagueRunner",
        "leagueManager",
        "trainer",
        "ppo",
        "evaluator",
        "inferenceServer",
        "actorPool",
        "guardianSchedule",
        "generationAuditor",
        "analyzer",
        "analyzerTests",
    }
    if not isinstance(source_files, dict) or not required_source_files.issubset(source_files):
        raise ValueError("P30 source-contract file registry changed")
    for label, entry in source_files.items():
        if not isinstance(entry, dict) or not is_sha256(entry.get("sha256")):
            raise ValueError(f"P30 source contract has malformed {label} binding")
        bound_path = resolve_artifact(entry.get("path"), anchor=source_lock_path.parent, label=label)
        if not bound_path.is_file() or sha256(bound_path) != entry["sha256"]:
            raise ValueError(f"P30 source contract has hash-invalid {label}")

    authorization = json.loads(authorization_path.read_text())
    if (
        not isinstance(authorization, dict)
        or authorization.get("schemaVersion") != INPUT_AUTH_SCHEMA
        or authorization.get("authorized") is not True
        or authorization.get("immutable") is not True
        or authorization.get("outcomesInspected") is not False
        or authorization.get("promotionEligible") is not False
        or authorization.get("privateEvaluationAuthorized") is not False
        or authorization.get("protocolSha256") != sha256(protocol_path)
        or authorization.get("inputManifestSha256") != sha256(manifest_path)
        or authorization.get("sourceContractSha256") != source_contract["sha256"]
    ):
        raise ValueError("P30 analysis authorization is invalid or hash-unbound")
    bound_manifest_path = resolve_artifact(
        authorization.get("inputManifestPath"),
        anchor=authorization_path.parent,
        label="authorized input manifest",
    )
    if bound_manifest_path.resolve() != manifest_path.resolve():
        raise ValueError("P30 analysis authorization names a different input manifest")
    files = authorization.get("files")
    if not isinstance(files, dict) or set(files) != {"analyzer", "analyzerTests"}:
        raise ValueError("P30 analysis authorization file registry changed")
    for label, entry in files.items():
        if not isinstance(entry, dict) or not is_sha256(entry.get("sha256")):
            raise ValueError(f"P30 analysis authorization has malformed {label} binding")
        bound_path = resolve_artifact(
            entry.get("path"), anchor=authorization_path.parent, label=label
        )
        if not bound_path.is_file() or sha256(bound_path) != entry["sha256"]:
            raise ValueError(f"P30 analysis authorization has hash-invalid {label}")
    analyzer_path = Path(__file__).resolve()
    authorized_analyzer = resolve_artifact(
        files["analyzer"]["path"], anchor=authorization_path.parent, label="analyzer"
    )
    if analyzer_path != authorized_analyzer.resolve():
        raise ValueError("executing analyzer differs from the authorized analyzer path")

    manifest = json.loads(manifest_path.read_text())
    if (
        manifest.get("schemaVersion") != INPUT_SCHEMA
        or manifest.get("valid") is not True
        or manifest.get("immutable") is not True
        or manifest.get("protocolSha256") != sha256(protocol_path)
    ):
        raise ValueError("development input manifest is not valid and protocol-bound")
    source_commit = manifest.get("sourceCommit")
    if source_commit != source_contract["sha256"]:
        raise ValueError("development input source contract is invalid")
    if manifest.get("replayIntegrityVerified") is not True or manifest.get("outcomesInspected") is not False:
        raise ValueError("development input replay integrity is not verified")
    catalog_path = resolve_artifact(
        protocol["catalog"]["path"], anchor=protocol_path.parent, label="catalog"
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
            ("checkpointPath", "weightsSha256"),
            ("checkpointManifestPath", "checkpointManifestSha256"),
            ("configPath", "configSha256"),
            ("bindingPath", "bindingSha256"),
            ("exitCodePath", "exitCodeSha256"),
            ("evaluatorStdoutPath", "evaluatorStdoutSha256"),
            ("evaluatorStderrPath", "evaluatorStderrSha256"),
            ("serverLogPath", "serverLogSha256"),
            ("replayReportPath", "replayReportSha256"),
            ("replayExitCodePath", "replayExitCodeSha256"),
            ("replayEvaluatorStdoutPath", "replayEvaluatorStdoutSha256"),
            ("replayEvaluatorStderrPath", "replayEvaluatorStderrSha256"),
            ("replayServerLogPath", "replayServerLogSha256"),
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
        if artifacts["exitCodePath"].read_text() != "0\n":
            raise ValueError(f"{label}: evaluator exit code is not exactly zero")
        if artifacts["evaluatorStderrPath"].stat().st_size != 0:
            raise ValueError(f"{label}: evaluator stderr is non-empty")
        if artifacts["evaluatorStdoutPath"].read_bytes() != path.read_bytes():
            raise ValueError(f"{label}: evaluator stdout differs from its report artifact")
        if artifacts["replayExitCodePath"].read_text() != "0\n":
            raise ValueError(f"{label}: replay evaluator exit code is not exactly zero")
        if artifacts["replayEvaluatorStderrPath"].stat().st_size != 0:
            raise ValueError(f"{label}: replay evaluator stderr is non-empty")
        if artifacts["replayEvaluatorStdoutPath"].read_bytes() != artifacts["replayReportPath"].read_bytes():
            raise ValueError(f"{label}: replay evaluator stdout differs from its report artifact")
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
        )
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
        )
        if (
            replay_indexed != primary_indexed
            or replay_report.get("replayHashes") != report.get("replayHashes")
        ):
            raise ValueError(f"{label}: deterministic replay differs from the primary evaluation")
        indexed[label] = primary_indexed
        by_label[label] = report
    if set(by_label) != expected_labels:
        raise ValueError("development input does not contain the exact nine reports")
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
    args = parser.parse_args()
    protocol, indexed, reports = load_inputs(args.protocol, args.manifest, args.authorization)
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
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
