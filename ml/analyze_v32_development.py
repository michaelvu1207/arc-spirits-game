#!/usr/bin/env python3
"""Fail-closed analysis of the frozen V32 solo development block."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Iterable

import numpy as np

from analyze_terminal_credit import interval_from_draws
from compare_paired_solo import load_report
from freeze_v32_development import (
    verify_authorization as verify_development_authorization,
    verify_freeze as verify_development_freeze,
    write_freeze as write_immutable_json,
)


REPLICATES = ("a", "b", "c")
TREATMENTS = ("round-reweighted", "p30-credit025")
CONTROL = "control-uniform"
COMPARATORS = ("v23", "v30", "shared-critic")
REPORT_SCHEMA = "arc-v32-development-reports-v1"
FREEZE_SCHEMA = "arc-v32-development-freeze-v1"
ANALYSIS_SCHEMA = "arc-v32-development-analysis-v1"
BOOTSTRAP_SAMPLES = 10_000
BOOTSTRAP_SEED = 320_949
SIMULTANEOUS_CONFIDENCE = 0.975


def endpoint_label(replicate: str, arm: str) -> str:
    return f"rep-{replicate}-{arm}"


ENDPOINT_LABELS = tuple(
    endpoint_label(replicate, arm)
    for replicate in REPLICATES
    for arm in (CONTROL, *TREATMENTS)
)
REPORT_LABELS = (*COMPARATORS, *ENDPOINT_LABELS)


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


def records_by_label(value: Any, *, field: str) -> dict[str, dict[str, Any]]:
    if isinstance(value, dict):
        if not all(isinstance(label, str) and isinstance(row, dict) for label, row in value.items()):
            raise ValueError(f"{field} must map labels to objects")
        return value
    if isinstance(value, list):
        rows: dict[str, dict[str, Any]] = {}
        for row in value:
            if not isinstance(row, dict) or not isinstance(row.get("label"), str):
                raise ValueError(f"{field} list entries require a label")
            label = row["label"]
            if label in rows:
                raise ValueError(f"{field} contains duplicate label {label}")
            rows[label] = row
        return rows
    raise ValueError(f"{field} must be an object or list")


def resolve_artifact(raw: Any, manifest_path: Path) -> Path:
    if not isinstance(raw, str) or not raw:
        raise ValueError("artifact path must be a non-empty string")
    path = Path(raw).expanduser()
    if path.is_absolute():
        return path
    cwd_path = (Path.cwd() / path).resolve()
    if cwd_path.exists():
        return cwd_path
    return (manifest_path.parent / path).resolve()


def verified_json_artifact(entry: dict[str, Any], manifest_path: Path, *, label: str) -> tuple[Path, dict[str, Any]]:
    path = resolve_artifact(entry.get("path"), manifest_path)
    expected = entry.get("sha256")
    if not is_sha256(expected) or not path.is_file() or sha256(path) != expected:
        raise ValueError(f"{label}: missing or hash-invalid artifact")
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label}: invalid JSON artifact") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label}: JSON artifact must be an object")
    return path, value


def validate_freeze(freeze: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    if freeze.get("schemaVersion") != FREEZE_SCHEMA:
        raise ValueError("unexpected development-freeze schema")
    if freeze.get("valid") is not True or freeze.get("immutable") is not True:
        raise ValueError("development freeze is not valid and immutable")
    if freeze.get("outcomeBlindEndpointSelection") is not True:
        raise ValueError("endpoint selection was not outcome blind")
    if freeze.get("screenLock", {}).get("verified") is not True:
        raise ValueError("screen lock was not verified")
    generation = freeze.get("endpointGeneration")
    if generation not in (8, 12):
        raise ValueError("development freeze has an invalid endpoint generation")
    selected_manipulation = freeze.get("manipulation", {}).get("selected", {})
    generation_manipulation = freeze.get("manipulation", {}).get(f"gen{generation}", {})
    if (
        generation_manipulation.get("passed") is not True
        or selected_manipulation.get("path") != generation_manipulation.get("path")
        or selected_manipulation.get("sha256") != generation_manipulation.get("sha256")
    ):
        raise ValueError("selected endpoint did not pass the manipulation audit")

    policies = records_by_label(freeze.get("policies"), field="policies")
    if set(policies) != set(REPORT_LABELS):
        raise ValueError("freeze policies do not contain the exact 12-policy catalog")
    for label, policy in policies.items():
        if not is_sha256(policy.get("weightsSha256")):
            raise ValueError(f"{label}: frozen policy lacks a valid weights hash")
        expected_obs = 1 if label == "v23" else 2
        if policy.get("policyObsVersion") != expected_obs:
            raise ValueError(f"{label}: frozen policy observation version is wrong")

    roots = records_by_label(freeze.get("roots"), field="roots")
    if set(roots) != set(ENDPOINT_LABELS):
        raise ValueError("freeze roots do not contain all nine endpoints")
    for label, root in roots.items():
        if root.get("history", {}).get("rows") != generation:
            raise ValueError(f"{label}: incomplete endpoint history")
        audits = root.get("generationAudits")
        if not isinstance(audits, list) or len(audits) != generation:
            raise ValueError(f"{label}: incomplete generation-audit inventory")
        endpoint = root.get("endpoint", {})
        checkpoint = endpoint.get("checkpoint", {})
        manifest = endpoint.get("manifest", {})
        if checkpoint.get("sha256") != policies[label]["weightsSha256"]:
            raise ValueError(f"{label}: endpoint/policy checkpoint hash mismatch")
        if not is_sha256(manifest.get("sha256")):
            raise ValueError(f"{label}: missing endpoint manifest hash")

    representatives = freeze.get("representatives")
    if not isinstance(representatives, dict) or set(representatives) != set(TREATMENTS):
        raise ValueError("freeze lacks the exact treatment representative map")
    for treatment, representative in representatives.items():
        if not isinstance(representative, dict):
            raise ValueError(f"{treatment}: malformed representative")
        replicate = representative.get("selectedReplicate")
        treatment_label = endpoint_label(replicate, treatment) if replicate in REPLICATES else None
        control_label = endpoint_label(replicate, CONTROL) if replicate in REPLICATES else None
        if (
            representative.get("treatmentPolicyLabel") != treatment_label
            or representative.get("controlPolicyLabel") != control_label
            or representative.get("checkpointSha256") != policies.get(treatment_label, {}).get("weightsSha256")
            or representative.get("matchedControlSha256") != policies.get(control_label, {}).get("weightsSha256")
        ):
            raise ValueError(f"{treatment}: representative does not match frozen policies")
    return policies, representatives


def validate_authorization(
    authorization: dict[str, Any], *, freeze_sha256: str, source_contract_sha256: str
) -> None:
    if (
        authorization.get("schemaVersion") != "arc-v32-development-authorization-v1"
        or authorization.get("valid") is not True
        or authorization.get("immutable") is not True
    ):
        raise ValueError("development authorization is not valid and immutable")
    seed_authorization = authorization.get("authorization", {})
    if seed_authorization.get("developmentSeedsOpen") is not True:
        raise ValueError("development seeds were not authorized")
    if seed_authorization.get("hiddenSeedsOpen") is not False:
        raise ValueError("hidden seeds must remain closed")
    if (
        seed_authorization.get("authorizedSeedMin") != 949000000
        or seed_authorization.get("authorizedSeedMax") != 949004095
    ):
        raise ValueError("development authorization has the wrong seed block")
    authorized_freeze = authorization.get("freeze", {})
    if authorized_freeze.get("sha256") != freeze_sha256:
        raise ValueError("authorization refers to a different development freeze")
    if (
        authorization.get("sourceContractSha256") != source_contract_sha256
        or seed_authorization.get("sourceContractSha256") != source_contract_sha256
    ):
        raise ValueError("authorization source contract differs")


def validate_row(row: dict[str, Any], *, label: str, seed: int) -> None:
    if type(row.get("trueWin")) is not bool or type(row.get("stalled")) is not bool:
        raise ValueError(f"{label}: seed {seed} has invalid outcome flags")
    if not isinstance(row.get("guardian"), str) or not row["guardian"]:
        raise ValueError(f"{label}: seed {seed} has no guardian")
    for field in ("finalVP", "post15VpPerRound"):
        value = row.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{label}: seed {seed} has invalid {field}")
    finish = row.get("first30Round")
    if finish is not None and (
        isinstance(finish, bool)
        or not isinstance(finish, (int, float))
        or not math.isfinite(finish)
        or finish < 1
        or finish > 30
    ):
        raise ValueError(f"{label}: seed {seed} has invalid first30Round")
    expected_win = float(row["finalVP"]) >= 30 and not row["stalled"]
    if row["trueWin"] != expected_win:
        raise ValueError(f"{label}: seed {seed} trueWin disagrees with score/stall")


def validate_reports(
    reports: dict[str, dict[str, Any]],
    *,
    seed0: int,
    games: int,
    catalog_sha256: str,
    source_contract_sha256: str,
    expected_weights: dict[str, str],
    expected_obs_versions: dict[str, int],
) -> dict[str, dict[int, dict[str, Any]]]:
    if set(reports) != set(REPORT_LABELS):
        raise ValueError("reports do not contain the exact 12-policy catalog")
    if set(expected_weights) != set(REPORT_LABELS) or set(expected_obs_versions) != set(REPORT_LABELS):
        raise ValueError("expected policy provenance does not cover every report")
    expected_seeds = set(range(seed0, seed0 + games))
    indexed: dict[str, dict[int, dict[str, Any]]] = {}
    for label in REPORT_LABELS:
        report = reports[label]
        if report.get("schemaVersion") != "solo-heldout-v2":
            raise ValueError(f"{label}: unexpected report schema")
        if (
            report.get("seed0") != seed0
            or report.get("games") != games
            or report.get("maxRounds") != 30
            or report.get("maxStatusLevel") != 2
            or report.get("catalogSha256") != catalog_sha256
            or report.get("sourceCommit") != source_contract_sha256
            or report.get("weightsSha256") != expected_weights[label]
        ):
            raise ValueError(f"{label}: report provenance/contract mismatch")
        decode = report.get("decode")
        obs = expected_obs_versions[label]
        expected_decode = {
            "policyObsVersion": obs,
            **({"inferenceSocket": decode.get("inferenceSocket")} if obs == 2 and isinstance(decode, dict) else {}),
            "learnMonsterRewardChoices": False,
            "sample": True,
            "temperature": 0.55,
        }
        if not isinstance(decode, dict) or decode != expected_decode:
            raise ValueError(f"{label}: decode contract is not exact")
        if obs == 2 and (not isinstance(decode.get("inferenceSocket"), str) or not decode["inferenceSocket"]):
            raise ValueError(f"{label}: obs-v2 report lacks binary inference transport")
        rows = report.get("perGame")
        if not isinstance(rows, list) or len(rows) != games:
            raise ValueError(f"{label}: wrong per-game row count")
        by_seed: dict[int, dict[str, Any]] = {}
        for row in rows:
            if not isinstance(row, dict) or type(row.get("seed")) is not int:
                raise ValueError(f"{label}: malformed per-game seed")
            seed = row["seed"]
            if seed in by_seed:
                raise ValueError(f"{label}: duplicate per-game seed")
            validate_row(row, label=label, seed=seed)
            by_seed[seed] = row
        if set(by_seed) != expected_seeds:
            raise ValueError(f"{label}: per-game seed set differs from the frozen block")
        wins = sum(row["trueWin"] for row in rows)
        stalls = sum(row["stalled"] for row in rows)
        if report.get("trueWins") != wins or report.get("stalls") != stalls:
            raise ValueError(f"{label}: outcome aggregate differs from per-game rows")
        if not math.isclose(report.get("trueWinRate", math.nan), wins / games, abs_tol=1e-15, rel_tol=0):
            raise ValueError(f"{label}: win-rate aggregate differs from per-game rows")
        if not math.isclose(report.get("stallRate", math.nan), stalls / games, abs_tol=1e-15, rel_tol=0):
            raise ValueError(f"{label}: stall-rate aggregate differs from per-game rows")
        indexed[label] = by_seed
    reference = indexed["v23"]
    for seed in expected_seeds:
        guardian = reference[seed]["guardian"]
        if any(rows[seed]["guardian"] != guardian for rows in indexed.values()):
            raise ValueError(f"seed {seed}: guardian assignment differs across reports")
    counts: dict[str, int] = {}
    for row in reference.values():
        counts[row["guardian"]] = counts.get(row["guardian"], 0) + 1
    if len(counts) < 2 or max(counts.values()) - min(counts.values()) > 1:
        raise ValueError("guardian schedule is not balanced")
    return indexed


def _metric(row: dict[str, Any], name: str) -> float:
    if name == "win":
        return float(row["trueWin"])
    if name == "finish":
        return float(row["first30Round"] if row["first30Round"] is not None else 31)
    return float(row[name])


METRICS = {
    "win": "win",
    "finalVP": "finalVP",
    "post15VpPerRound": "post15VpPerRound",
    "censoredFirst30Round": "finish",
}


def comparison_arrays(
    indexed: dict[str, dict[int, dict[str, Any]]],
    *,
    treatment: str,
    baseline: str,
) -> dict[str, np.ndarray]:
    seeds = sorted(indexed["v23"])
    values = {name: np.empty(len(seeds), dtype=np.float64) for name in METRICS}
    for index, seed in enumerate(seeds):
        for name, source in METRICS.items():
            deltas = []
            for replicate in REPLICATES:
                treatment_row = indexed[endpoint_label(replicate, treatment)][seed]
                baseline_row = (
                    indexed[endpoint_label(replicate, CONTROL)][seed]
                    if baseline == "control"
                    else indexed[baseline][seed]
                )
                deltas.append(_metric(treatment_row, source) - _metric(baseline_row, source))
            values[name][index] = float(np.mean(deltas))
    return values


def representative_arrays(
    indexed: dict[str, dict[int, dict[str, Any]]],
    *,
    treatment: str,
    replicate: str,
    baseline: str,
) -> dict[str, np.ndarray]:
    seeds = sorted(indexed["v23"])
    treatment_rows = indexed[endpoint_label(replicate, treatment)]
    baseline_rows = indexed[endpoint_label(replicate, CONTROL)] if baseline == "control" else indexed[baseline]
    return {
        name: np.asarray(
            [_metric(treatment_rows[seed], source) - _metric(baseline_rows[seed], source) for seed in seeds],
            dtype=np.float64,
        )
        for name, source in METRICS.items()
    }


def bootstrap_family(
    contrasts: dict[str, np.ndarray], *, samples: int, seed: int
) -> dict[str, dict[str, float]]:
    sizes = {values.size for values in contrasts.values()}
    if set(contrasts) != set(TREATMENTS) or len(sizes) != 1 or next(iter(sizes), 0) <= 0:
        raise ValueError("bootstrap family requires two equal non-empty seed-cluster vectors")
    size = next(iter(sizes))
    rng = np.random.default_rng(seed)
    draws = {label: np.empty(samples, dtype=np.float64) for label in TREATMENTS}
    for start in range(0, samples, 256):
        count = min(256, samples - start)
        indices = rng.integers(0, size, size=(count, size))
        for label in TREATMENTS:
            draws[label][start : start + count] = contrasts[label][indices].mean(axis=1)
    return {
        label: {
            "confidence": SIMULTANEOUS_CONFIDENCE,
            "familySize": 2,
            **interval_from_draws(draws[label], SIMULTANEOUS_CONFIDENCE),
        }
        for label in TREATMENTS
    }


def summarize_comparison(
    arrays: dict[str, np.ndarray], indexed: dict[str, dict[int, dict[str, Any]]]
) -> dict[str, Any]:
    seeds = sorted(indexed["v23"])
    guardians = sorted({indexed["v23"][seed]["guardian"] for seed in seeds})
    guardian_deltas = {
        guardian: float(np.mean([arrays["win"][i] for i, seed in enumerate(seeds) if indexed["v23"][seed]["guardian"] == guardian]))
        for guardian in guardians
    }
    return {
        "winRateDelta": float(arrays["win"].mean()),
        "finalVpDelta": float(arrays["finalVP"].mean()),
        "post15VpPerRoundDelta": float(arrays["post15VpPerRound"].mean()),
        "censoredFirst30RoundDelta": float(arrays["censoredFirst30Round"].mean()),
        "guardianWinRateDelta": guardian_deltas,
    }


def pooled_guardian_deltas(
    primary_arrays: dict[str, np.ndarray],
    primary_indexed: dict[str, dict[int, dict[str, Any]]],
    followup_arrays: dict[str, np.ndarray],
    followup_indexed: dict[str, dict[int, dict[str, Any]]],
) -> tuple[dict[str, float], dict[str, int]]:
    primary_seeds = sorted(primary_indexed["v23"])
    followup_seeds = sorted(followup_indexed["v23"])
    primary_guardians = {primary_indexed["v23"][seed]["guardian"] for seed in primary_seeds}
    followup_guardians = {followup_indexed["v23"][seed]["guardian"] for seed in followup_seeds}
    if primary_guardians != followup_guardians:
        raise ValueError("guardian follow-up changed the guardian catalog")
    deltas: dict[str, float] = {}
    counts: dict[str, int] = {}
    for guardian in sorted(primary_guardians):
        values = [
            primary_arrays["win"][index]
            for index, seed in enumerate(primary_seeds)
            if primary_indexed["v23"][seed]["guardian"] == guardian
        ] + [
            followup_arrays["win"][index]
            for index, seed in enumerate(followup_seeds)
            if followup_indexed["v23"][seed]["guardian"] == guardian
        ]
        if not values:
            raise ValueError(f"guardian follow-up has no rows for {guardian}")
        deltas[guardian] = float(np.mean(values))
        counts[guardian] = len(values)
    return deltas, counts


def late_gate(summary: dict[str, Any]) -> bool:
    return (
        summary["finalVpDelta"] >= 0
        and summary["post15VpPerRoundDelta"] >= 0
        and summary["censoredFirst30RoundDelta"] <= 0
    )


def guardian_flags(*summaries: tuple[str, dict[str, Any]]) -> list[dict[str, Any]]:
    flags = []
    for comparison, summary in summaries:
        for guardian, delta in summary["guardianWinRateDelta"].items():
            if delta < -0.05:
                flags.append({"comparison": comparison, "guardian": guardian, "winRateDelta": delta})
    return flags


def analyze_development(
    reports: dict[str, dict[str, Any]],
    *,
    seed0: int,
    games: int,
    catalog_sha256: str,
    source_contract_sha256: str,
    expected_weights: dict[str, str],
    expected_obs_versions: dict[str, int],
    representatives: dict[str, dict[str, Any]],
    frozen_integrity: bool,
    report_sha256: dict[str, str] | None = None,
    guardian_followup_reports: dict[str, dict[str, Any]] | None = None,
    guardian_followup_report_sha256: dict[str, str] | None = None,
    bootstrap_samples: int = BOOTSTRAP_SAMPLES,
    bootstrap_seed: int = BOOTSTRAP_SEED,
) -> dict[str, Any]:
    if not frozen_integrity:
        raise ValueError("frozen endpoint integrity/calibration/trust/manipulation gates failed")
    if bootstrap_samples <= 0:
        raise ValueError("bootstrap_samples must be positive")
    if not isinstance(representatives, dict) or set(representatives) != set(TREATMENTS):
        raise ValueError("representatives must cover the exact two treatment families")
    for treatment, representative in representatives.items():
        if not isinstance(representative, dict) or representative.get("selectedReplicate") not in REPLICATES:
            raise ValueError(f"{treatment}: invalid frozen representative")
    indexed = validate_reports(
        reports,
        seed0=seed0,
        games=games,
        catalog_sha256=catalog_sha256,
        source_contract_sha256=source_contract_sha256,
        expected_weights=expected_weights,
        expected_obs_versions=expected_obs_versions,
    )
    followup_indexed = None
    if guardian_followup_reports is not None:
        followup_indexed = validate_reports(
            guardian_followup_reports,
            seed0=949100000,
            games=8192,
            catalog_sha256=catalog_sha256,
            source_contract_sha256=source_contract_sha256,
            expected_weights=expected_weights,
            expected_obs_versions=expected_obs_versions,
        )
    causal_arrays = {
        treatment: comparison_arrays(indexed, treatment=treatment, baseline="control")
        for treatment in TREATMENTS
    }
    v23_arrays = {
        treatment: comparison_arrays(indexed, treatment=treatment, baseline="v23")
        for treatment in TREATMENTS
    }
    followup_causal_arrays = (
        {
            treatment: comparison_arrays(followup_indexed, treatment=treatment, baseline="control")
            for treatment in TREATMENTS
        }
        if followup_indexed is not None
        else None
    )
    followup_v23_arrays = (
        {
            treatment: comparison_arrays(followup_indexed, treatment=treatment, baseline="v23")
            for treatment in TREATMENTS
        }
        if followup_indexed is not None
        else None
    )
    causal_intervals = bootstrap_family(
        {treatment: causal_arrays[treatment]["win"] for treatment in TREATMENTS},
        samples=bootstrap_samples,
        seed=bootstrap_seed,
    )
    v23_intervals = bootstrap_family(
        {treatment: v23_arrays[treatment]["win"] for treatment in TREATMENTS},
        samples=bootstrap_samples,
        seed=bootstrap_seed,
    )
    all_zero_stalls = all(report["stalls"] == 0 for report in reports.values())
    if guardian_followup_reports is not None and any(
        report["stalls"] != 0 for report in guardian_followup_reports.values()
    ):
        raise ValueError("guardian follow-up contains a stalled report")
    mechanisms: dict[str, Any] = {}
    pending: list[str] = []
    followup_applied: list[str] = []
    for treatment in TREATMENTS:
        causal = summarize_comparison(causal_arrays[treatment], indexed)
        v23 = summarize_comparison(v23_arrays[treatment], indexed)
        causal["winRateDeltaBootstrapSimultaneous"] = causal_intervals[treatment]
        v23["winRateDeltaBootstrapSimultaneous"] = v23_intervals[treatment]
        replicate_effects = {
            replicate: float(
                representative_arrays(
                    indexed, treatment=treatment, replicate=replicate, baseline="control"
                )["win"].mean()
            )
            for replicate in REPLICATES
        }
        aggregate_flags_initial = guardian_flags(("matched-control", causal), ("v23", v23))
        aggregate_without_guardian = {
            "causalWinPoint": causal["winRateDelta"] >= 0.03,
            "causalWinInterval": causal_intervals[treatment]["lower"] > 0,
            "replicateStability": sum(value > 0 for value in replicate_effects.values()) >= 2
            and min(replicate_effects.values()) >= -0.01,
            "v23WinPoint": v23["winRateDelta"] >= 0.03,
            "v23WinInterval": v23_intervals[treatment]["lower"] > 0,
            "lateVsControl": late_gate(causal),
            "lateVsV23": late_gate(v23),
            "zeroStalls": all_zero_stalls,
            "frozenIntegrityCalibrationTrustManipulation": True,
        }
        replicate = representatives[treatment]["selectedReplicate"]
        rep_causal = summarize_comparison(
            representative_arrays(indexed, treatment=treatment, replicate=replicate, baseline="control"), indexed
        )
        rep_v23 = summarize_comparison(
            representative_arrays(indexed, treatment=treatment, replicate=replicate, baseline="v23"), indexed
        )
        representative_flags_initial = guardian_flags(("matched-control", rep_causal), ("v23", rep_v23))
        representative_without_guardian = {
            "causalWinPoint": rep_causal["winRateDelta"] >= 0.03,
            "v23WinPoint": rep_v23["winRateDelta"] >= 0.03,
            "lateVsControl": late_gate(rep_causal),
            "lateVsV23": late_gate(rep_v23),
            "zeroStalls": all_zero_stalls,
        }
        otherwise_eligible = all(aggregate_without_guardian.values()) and all(
            representative_without_guardian.values()
        )
        followup_trigger = otherwise_eligible and bool(
            aggregate_flags_initial or representative_flags_initial
        )
        aggregate_flags = aggregate_flags_initial
        representative_flags = representative_flags_initial
        followup_required = followup_trigger and followup_indexed is None
        followup_used = False
        if followup_required:
            pending.append(treatment)
        elif followup_trigger:
            assert followup_indexed is not None
            assert followup_causal_arrays is not None and followup_v23_arrays is not None
            causal_guardians, causal_counts = pooled_guardian_deltas(
                causal_arrays[treatment], indexed,
                followup_causal_arrays[treatment], followup_indexed,
            )
            v23_guardians, v23_counts = pooled_guardian_deltas(
                v23_arrays[treatment], indexed,
                followup_v23_arrays[treatment], followup_indexed,
            )
            followup_rep_causal_arrays = representative_arrays(
                followup_indexed, treatment=treatment, replicate=replicate, baseline="control"
            )
            followup_rep_v23_arrays = representative_arrays(
                followup_indexed, treatment=treatment, replicate=replicate, baseline="v23"
            )
            rep_causal_guardians, rep_causal_counts = pooled_guardian_deltas(
                representative_arrays(indexed, treatment=treatment, replicate=replicate, baseline="control"),
                indexed,
                followup_rep_causal_arrays,
                followup_indexed,
            )
            rep_v23_guardians, rep_v23_counts = pooled_guardian_deltas(
                representative_arrays(indexed, treatment=treatment, replicate=replicate, baseline="v23"),
                indexed,
                followup_rep_v23_arrays,
                followup_indexed,
            )
            causal["guardianWinRateDelta"] = causal_guardians
            causal["guardianPooledGames"] = causal_counts
            v23["guardianWinRateDelta"] = v23_guardians
            v23["guardianPooledGames"] = v23_counts
            rep_causal["guardianWinRateDelta"] = rep_causal_guardians
            rep_causal["guardianPooledGames"] = rep_causal_counts
            rep_v23["guardianWinRateDelta"] = rep_v23_guardians
            rep_v23["guardianPooledGames"] = rep_v23_counts
            aggregate_flags = guardian_flags(("matched-control", causal), ("v23", v23))
            representative_flags = guardian_flags(("matched-control", rep_causal), ("v23", rep_v23))
            followup_used = True
            followup_applied.append(treatment)
        aggregate_gates = {
            **aggregate_without_guardian,
            "guardian": not aggregate_flags,
        }
        representative_gates = {
            **representative_without_guardian,
            "guardian": not representative_flags,
        }
        eligible = all(aggregate_gates.values()) and all(representative_gates.values())
        treatment_win_rate = float(
            np.mean(
                [
                    reports[endpoint_label(replicate_id, treatment)]["trueWinRate"]
                    for replicate_id in REPLICATES
                ]
            )
        )
        mechanisms[treatment] = {
            "aggregate": {
                "causalVsMatchedControls": causal,
                "strengthVsV23": v23,
                "replicateCausalWinRateDeltas": replicate_effects,
                "equalReplicateMeanWinRate": treatment_win_rate,
                "gates": aggregate_gates,
                "guardianFlags": aggregate_flags,
                "guardianFlagsInitial": aggregate_flags_initial,
            },
            "representative": {
                "selectedReplicate": replicate,
                "treatmentPolicyLabel": endpoint_label(replicate, treatment),
                "controlPolicyLabel": endpoint_label(replicate, CONTROL),
                "causalVsMatchedControl": rep_causal,
                "strengthVsV23": rep_v23,
                "gates": representative_gates,
                "guardianFlags": representative_flags,
                "guardianFlagsInitial": representative_flags_initial,
            },
            "guardianFollowupRequired": followup_required,
            "guardianFollowupApplied": followup_used,
            "eligible": eligible,
        }

    if followup_indexed is not None and not followup_applied:
        raise ValueError("guardian follow-up was supplied without an eligible flagged mechanism")

    winner = None
    decision_status = "no-eligible-mechanism"
    if pending:
        decision_status = "guardian-followup-required"
    else:
        eligible = [treatment for treatment in TREATMENTS if mechanisms[treatment]["eligible"]]
        if len(eligible) == 1:
            winner = eligible[0]
        elif len(eligible) == 2:
            round_rate = mechanisms["round-reweighted"]["aggregate"]["equalReplicateMeanWinRate"]
            p30_rate = mechanisms["p30-credit025"]["aggregate"]["equalReplicateMeanWinRate"]
            if abs(round_rate - p30_rate) < 0.01:
                winner = "round-reweighted"
            else:
                winner = "round-reweighted" if round_rate > p30_rate else "p30-credit025"
        if winner is not None:
            decision_status = (
                "winner-frozen-after-guardian-followup"
                if followup_applied
                else "winner-frozen"
            )

    return {
        "schemaVersion": ANALYSIS_SCHEMA,
        "valid": True,
        "seed0": seed0,
        "games": games,
        "bootstrap": {
            "samples": bootstrap_samples,
            "seed": bootstrap_seed,
            "unit": "complete seed cluster containing all three matched replicate pairs",
            "families": {
                "treatmentVsMatchedControl": {
                    "comparisons": list(TREATMENTS),
                    "familySize": 2,
                    "intervalConfidence": SIMULTANEOUS_CONFIDENCE,
                },
                "treatmentVsV23": {
                    "comparisons": list(TREATMENTS),
                    "familySize": 2,
                    "intervalConfidence": SIMULTANEOUS_CONFIDENCE,
                },
            },
        },
        "provenance": {
            "catalogSha256": catalog_sha256,
            "sourceContractSha256": source_contract_sha256,
            "weightsSha256": expected_weights,
            **({"reportSha256": report_sha256} if report_sha256 is not None else {}),
            **(
                {"guardianFollowupReportSha256": guardian_followup_report_sha256}
                if guardian_followup_report_sha256 is not None
                else {}
            ),
            "frozenIntegrityCalibrationTrustManipulation": True,
        },
        "mechanisms": mechanisms,
        "guardianFollowupRequired": bool(pending),
        "guardianFollowupMechanisms": pending,
        "guardianFollowupApplied": bool(followup_applied),
        "guardianFollowupAppliedMechanisms": followup_applied,
        **(
            {"guardianFollowupSeed0": 949100000, "guardianFollowupGames": 8192}
            if followup_applied
            else {}
        ),
        "winner": winner,
        "decisionStatus": decision_status,
        "bindingLatencyMayRun": winner is not None,
        "hiddenSeedsMayOpen": False,
    }


def load_cli_inputs(
    freeze_path: Path, evaluation_manifest_path: Path
) -> tuple[dict[str, Any], dict[str, dict[str, Any]], dict[str, Any]]:
    freeze_path = freeze_path.resolve()
    evaluation_manifest_path = evaluation_manifest_path.resolve()
    freeze = verify_development_freeze(freeze_path)
    policies, representatives = validate_freeze(freeze)
    sidecar = evaluation_manifest_path.with_suffix(evaluation_manifest_path.suffix + ".sha256")
    if not sidecar.is_file():
        raise ValueError("development report-manifest sidecar is missing")
    sidecar_fields = sidecar.read_text().strip().split()
    if (
        len(sidecar_fields) != 2
        or sidecar_fields[0] != sha256(evaluation_manifest_path)
        or sidecar_fields[1] != evaluation_manifest_path.name
    ):
        raise ValueError("development report-manifest sidecar mismatch")
    evaluation = json.loads(evaluation_manifest_path.read_text())
    if evaluation.get("schemaVersion") != REPORT_SCHEMA or evaluation.get("valid") is not True:
        raise ValueError("development report manifest is not valid")
    freeze_sha = sha256(freeze_path)
    if evaluation.get("freeze", {}).get("sha256") != freeze_sha:
        raise ValueError("development reports refer to a different freeze")
    authorization_path, authorization = verified_json_artifact(
        evaluation.get("authorization", {}), evaluation_manifest_path, label="development authorization"
    )
    source_contract = evaluation.get("sourceContractSha256")
    if not is_sha256(source_contract):
        raise ValueError("development reports lack a valid source contract hash")
    if source_contract != freeze.get("authorization", {}).get("sourceContractSha256"):
        raise ValueError("development reports differ from the frozen source contract")
    verified_authorization = verify_development_authorization(authorization_path, freeze_path)
    if verified_authorization != authorization:
        raise ValueError("development authorization changed while loading")
    validate_authorization(
        authorization,
        freeze_sha256=freeze_sha,
        source_contract_sha256=source_contract,
    )
    contract = freeze.get("developmentContract", {})
    if evaluation.get("seed0") != contract.get("seed0") or evaluation.get("games") != contract.get("games"):
        raise ValueError("development reports differ from the frozen seed block")
    entries = records_by_label(evaluation.get("reports"), field="reports")
    if set(entries) != set(REPORT_LABELS):
        raise ValueError("development report manifest lacks the exact 12 reports")
    reports: dict[str, dict[str, Any]] = {}
    report_hashes: dict[str, str] = {}
    for label, entry in entries.items():
        path = resolve_artifact(entry.get("path"), evaluation_manifest_path)
        expected_sha = entry.get("sha256")
        if not is_sha256(expected_sha) or not path.is_file() or sha256(path) != expected_sha:
            raise ValueError(f"{label}: report is missing or hash-invalid")
        if (
            entry.get("weightsSha256") != policies[label]["weightsSha256"]
            or entry.get("policyObsVersion") != policies[label]["policyObsVersion"]
            or entry.get("exitCode") != 0
            or entry.get("attempt") not in (1, 2)
            or entry.get("stalls") != 0
        ):
            raise ValueError(f"{label}: report manifest provenance/status mismatch")
        reports[label] = load_report(path)
        report_hashes[label] = expected_sha
    metadata = {
        "policies": policies,
        "representatives": representatives,
        "freezeSha256": freeze_sha,
        "authorizationPath": str(authorization_path),
        "authorizationSha256": evaluation["authorization"]["sha256"],
        "sourceContractSha256": source_contract,
        "catalogSha256": freeze["catalog"]["sha256"],
        "seed0": contract["seed0"],
        "games": contract["games"],
        "reportSha256": report_hashes,
    }
    return reports, policies, metadata


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--freeze", type=Path, required=True)
    parser.add_argument("--evaluation-manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise FileExistsError(f"refusing to overwrite development decision: {args.out}")
    reports, policies, metadata = load_cli_inputs(args.freeze, args.evaluation_manifest)
    freeze = json.loads(args.freeze.read_text())
    result = analyze_development(
        reports,
        seed0=metadata["seed0"],
        games=metadata["games"],
        catalog_sha256=metadata["catalogSha256"],
        source_contract_sha256=metadata["sourceContractSha256"],
        expected_weights={label: policy["weightsSha256"] for label, policy in policies.items()},
        expected_obs_versions={label: policy["policyObsVersion"] for label, policy in policies.items()},
        representatives=freeze["representatives"],
        frozen_integrity=True,
        report_sha256=metadata["reportSha256"],
    )
    result["provenance"].update(
        {
            "developmentFreezeSha256": metadata["freezeSha256"],
            "developmentAuthorizationSha256": metadata["authorizationSha256"],
        }
    )
    write_immutable_json(args.out, result)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
