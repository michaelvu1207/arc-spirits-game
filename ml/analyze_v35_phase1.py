#!/usr/bin/env python3
"""Fail-closed analysis of the frozen V35 Phase 1 public development block."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np


REPLICATES = ("a", "b", "c")
CONTROL = "control-uniform"
TREATMENTS = ("late-reweighted", "p30-credit025")
SEED0 = 969_030_000
GAMES = 4_096
BOOTSTRAP_SAMPLES = 10_000
BOOTSTRAP_SEED = 350_969
SIMULTANEOUS_CONFIDENCE = 0.975


def label(replicate: str, arm: str) -> str:
    return f"rep-{replicate}-{arm}"


POLICY_LABELS = ("base",) + tuple(
    label(replicate, arm)
    for replicate in REPLICATES
    for arm in (CONTROL, *TREATMENTS)
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def finite(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{field} must be finite")
    return float(value)


def validate_authorization(value: dict[str, Any]) -> None:
    if value.get("schemaVersion") != "arc-v35-phase1-development-authorization-v1":
        raise ValueError("unexpected V35 development authorization schema")
    if value.get("authorized") is not True or value.get("immutable") is not True:
        raise ValueError("V35 development authorization is not open and immutable")
    if value.get("promotionEligible") is not False or value.get("privateSeedsOpen") is not False:
        raise ValueError("V35 development authorization opened a forbidden gate")
    contract = value.get("contract", {})
    expected_contract = {
        "seed0": SEED0,
        "seedMax": SEED0 + GAMES - 1,
        "games": GAMES,
        "maxRounds": 30,
        "maxStatusLevel": 2,
        "sample": True,
        "temperature": 0.55,
        "workers": 24,
    }
    if any(contract.get(key) != expected for key, expected in expected_contract.items()):
        raise ValueError("V35 development contract differs from the frozen contract")
    expected_analysis = {
        "bootstrapSamples": BOOTSTRAP_SAMPLES,
        "bootstrapSeed": BOOTSTRAP_SEED,
        "simultaneousConfidence": SIMULTANEOUS_CONFIDENCE,
        "familySize": 2,
        "minimumWinGain": 0.03,
        "minimumReplicateWinGain": -0.01,
        "minimumPositiveReplicates": 2,
        "guardianFloor": -0.05,
        "tieThreshold": 0.01,
        "tiePreference": "late-reweighted",
    }
    analysis = value.get("analysis", {})
    if any(analysis.get(key) != expected for key, expected in expected_analysis.items()):
        raise ValueError("V35 development analysis constants differ")
    policies = value.get("policies")
    if not isinstance(policies, dict) or set(policies) != set(POLICY_LABELS):
        raise ValueError("V35 development authorization has the wrong policy catalog")
    if tuple(value.get("policyOrder", ())) != POLICY_LABELS:
        raise ValueError("V35 development authorization has the wrong policy order")
    representatives = value.get("representatives")
    if not isinstance(representatives, dict) or set(representatives) != set(TREATMENTS):
        raise ValueError("V35 development authorization has the wrong representatives")
    for treatment, row in representatives.items():
        replicate = row.get("selectedReplicate")
        if replicate not in REPLICATES:
            raise ValueError(f"{treatment}: invalid representative replicate")
        if row.get("treatmentLabel") != label(replicate, treatment):
            raise ValueError(f"{treatment}: representative treatment label mismatch")
        if row.get("controlLabel") != label(replicate, CONTROL):
            raise ValueError(f"{treatment}: representative control label mismatch")
        if row.get("checkpointSha256") != policies[row["treatmentLabel"]].get("weightsSha256"):
            raise ValueError(f"{treatment}: representative checkpoint hash mismatch")
        if row.get("matchedControlSha256") != policies[row["controlLabel"]].get("weightsSha256"):
            raise ValueError(f"{treatment}: representative control hash mismatch")


def load_reports(
    authorization_path: Path, authorization: dict[str, Any], manifest_path: Path
) -> dict[str, dict[str, Any]]:
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("schemaVersion") != "arc-v35-phase1-development-reports-v1":
        raise ValueError("unexpected V35 report-manifest schema")
    if manifest.get("complete") is not True or manifest.get("outcomesInspected") is not False:
        raise ValueError("V35 report manifest is incomplete or outcome-inspected")
    if manifest.get("authorizationSha256") != sha256(authorization_path):
        raise ValueError("V35 report manifest refers to a different authorization")
    entries = manifest.get("reports")
    if not isinstance(entries, dict) or set(entries) != set(POLICY_LABELS):
        raise ValueError("V35 report manifest has the wrong report catalog")
    reports: dict[str, dict[str, Any]] = {}
    for policy_label, entry in entries.items():
        path = Path(entry.get("path", ""))
        if not path.is_absolute():
            path = (Path.cwd() / path).resolve()
        if not path.is_file() or sha256(path) != entry.get("sha256"):
            raise ValueError(f"{policy_label}: missing or hash-invalid report")
        report = json.loads(path.read_text())
        validate_report(policy_label, report, authorization)
        reports[policy_label] = report
    return reports


def validate_report(policy_label: str, report: dict[str, Any], authorization: dict[str, Any]) -> None:
    policy = authorization["policies"][policy_label]
    contract = authorization["contract"]
    if report.get("schemaVersion") != "solo-heldout-v2":
        raise ValueError(f"{policy_label}: wrong report schema")
    expected = {
        "seed0": SEED0,
        "games": GAMES,
        "maxRounds": 30,
        "maxStatusLevel": 2,
        "catalogSha256": authorization["catalogSha256"],
        "sourceCommit": authorization["sourceContractSha256"],
        "weightsSha256": policy["weightsSha256"],
    }
    if any(report.get(key) != value for key, value in expected.items()):
        raise ValueError(f"{policy_label}: report provenance or game contract mismatch")
    decode = report.get("decode", {})
    if (
        decode.get("policyObsVersion") != 2
        or decode.get("sample") is not True
        or finite(decode.get("temperature"), "temperature") != 0.55
        or decode.get("learnMonsterRewardChoices") is not False
        or "search" in decode
        or "rerank" in decode
    ):
        raise ValueError(f"{policy_label}: decode contract mismatch")
    inference = report.get("inference", {})
    if inference.get("weightsSha256") != policy["weightsSha256"]:
        raise ValueError(f"{policy_label}: inference served the wrong checkpoint")
    if int(report.get("stalls", -1)) != 0:
        raise ValueError(f"{policy_label}: report contains stalls")
    if report.get("performance", {}).get("workers") != contract["workers"]:
        raise ValueError(f"{policy_label}: worker count mismatch")
    rows = report.get("perGame")
    if not isinstance(rows, list) or len(rows) != GAMES:
        raise ValueError(f"{policy_label}: incomplete per-game data")
    seeds: set[int] = set()
    for row in rows:
        seed = row.get("seed")
        if not isinstance(seed, int) or seed in seeds:
            raise ValueError(f"{policy_label}: duplicate or malformed seed")
        seeds.add(seed)
        if type(row.get("trueWin")) is not bool or type(row.get("stalled")) is not bool:
            raise ValueError(f"{policy_label}: malformed outcome flags")
        if row["stalled"]:
            raise ValueError(f"{policy_label}: stalled game")
        final_vp = finite(row.get("finalVP"), "finalVP")
        if row["trueWin"] != (final_vp >= 30):
            raise ValueError(f"{policy_label}: true-win flag mismatch")
        finite(row.get("post15VpPerRound"), "post15VpPerRound")
        finish = row.get("first30Round")
        if finish is not None and not 1 <= finite(finish, "first30Round") <= 30:
            raise ValueError(f"{policy_label}: invalid first30Round")
        if not isinstance(row.get("guardian"), str) or not row["guardian"]:
            raise ValueError(f"{policy_label}: missing guardian")
    if seeds != set(range(SEED0, SEED0 + GAMES)):
        raise ValueError(f"{policy_label}: report has the wrong seed block")


def rows_by_seed(report: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return {int(row["seed"]): row for row in report["perGame"]}


def arrays(report: dict[str, Any]) -> dict[str, np.ndarray]:
    rows = rows_by_seed(report)
    ordered = [rows[seed] for seed in range(SEED0, SEED0 + GAMES)]
    return {
        "win": np.asarray([float(row["trueWin"]) for row in ordered], dtype=np.float64),
        "vp": np.asarray([float(row["finalVP"]) for row in ordered], dtype=np.float64),
        "post15": np.asarray([float(row["post15VpPerRound"]) for row in ordered], dtype=np.float64),
        "finish": np.asarray([float(row.get("first30Round") or 31) for row in ordered], dtype=np.float64),
        "guardian": np.asarray([str(row["guardian"]) for row in ordered], dtype=object),
    }


def bootstrap_interval(values: np.ndarray, seed: int) -> dict[str, float]:
    if values.shape != (GAMES,) or not np.isfinite(values).all():
        raise ValueError("bootstrap values have the wrong shape or are non-finite")
    rng = np.random.default_rng(seed)
    draws = np.empty(BOOTSTRAP_SAMPLES, dtype=np.float64)
    offset = 0
    while offset < BOOTSTRAP_SAMPLES:
        count = min(256, BOOTSTRAP_SAMPLES - offset)
        indices = rng.integers(0, GAMES, size=(count, GAMES))
        draws[offset : offset + count] = values[indices].mean(axis=1)
        offset += count
    alpha = 1.0 - SIMULTANEOUS_CONFIDENCE
    return {
        "confidence": SIMULTANEOUS_CONFIDENCE,
        "lower": float(np.quantile(draws, alpha / 2)),
        "upper": float(np.quantile(draws, 1 - alpha / 2)),
    }


def metric_effects(
    data: dict[str, dict[str, np.ndarray]], treatment: str, metric: str
) -> tuple[np.ndarray, dict[str, float]]:
    by_replicate = {
        replicate: data[label(replicate, treatment)][metric] - data[label(replicate, CONTROL)][metric]
        for replicate in REPLICATES
    }
    aggregate = np.mean(np.stack(list(by_replicate.values())), axis=0)
    return aggregate, {replicate: float(values.mean()) for replicate, values in by_replicate.items()}


def guardian_point_effects(
    data: dict[str, dict[str, np.ndarray]], treatment: str, representative: str | None = None
) -> dict[str, float]:
    guardians = data["base"]["guardian"]
    names = sorted(set(guardians.tolist()))
    effects: dict[str, float] = {}
    for guardian in names:
        mask = guardians == guardian
        if representative is None:
            rows = [
                data[label(replicate, treatment)]["win"][mask]
                - data[label(replicate, CONTROL)]["win"][mask]
                for replicate in REPLICATES
            ]
            effects[guardian] = float(np.mean(np.stack(rows), axis=0).mean())
        else:
            effects[guardian] = float(
                (
                    data[label(representative, treatment)]["win"][mask]
                    - data[label(representative, CONTROL)]["win"][mask]
                ).mean()
            )
    return effects


def analyze(authorization_path: Path, reports_path: Path) -> dict[str, Any]:
    authorization = json.loads(authorization_path.read_text())
    validate_authorization(authorization)
    reports = load_reports(authorization_path, authorization, reports_path)
    data = {policy_label: arrays(report) for policy_label, report in reports.items()}
    base_guardians = data["base"]["guardian"]
    if any(not np.array_equal(values["guardian"], base_guardians) for values in data.values()):
        raise ValueError("guardian assignment differs across common-seed reports")
    base_win_rate = float(data["base"]["win"].mean())
    mechanisms: dict[str, Any] = {}
    for treatment_index, treatment in enumerate(TREATMENTS):
        metric_rows: dict[str, Any] = {}
        replicate_win_effects: dict[str, float] = {}
        for metric_index, metric in enumerate(("win", "vp", "post15", "finish")):
            effect, by_replicate = metric_effects(data, treatment, metric)
            if metric == "win":
                replicate_win_effects = by_replicate
            metric_rows[metric] = {
                "meanEffect": float(effect.mean()),
                "simultaneousInterval": bootstrap_interval(
                    effect, BOOTSTRAP_SEED ^ (treatment_index << 12) ^ (metric_index * 0x9E37)
                ),
            }
        raw_treatment_win_rate = float(
            np.mean([data[label(replicate, treatment)]["win"].mean() for replicate in REPLICATES])
        )
        guardian_effects = guardian_point_effects(data, treatment)
        aggregate_gates = {
            "winGainAtLeast3Points": metric_rows["win"]["meanEffect"] >= 0.03,
            "winLowerBoundPositive": metric_rows["win"]["simultaneousInterval"]["lower"] > 0,
            "atLeastTwoPositiveReplicates": sum(value > 0 for value in replicate_win_effects.values()) >= 2,
            "noReplicateBelowMinus1Point": min(replicate_win_effects.values()) >= -0.01,
            "rawWinNoWorseThanBase": raw_treatment_win_rate >= base_win_rate,
            "finalVpLowerBoundPositive": metric_rows["vp"]["simultaneousInterval"]["lower"] > 0,
            "post15LowerBoundPositive": metric_rows["post15"]["simultaneousInterval"]["lower"] > 0,
            "finishUpperBoundNonpositive": metric_rows["finish"]["simultaneousInterval"]["upper"] <= 0,
            "guardianFloor": min(guardian_effects.values()) >= -0.05,
            "zeroStalls": True,
        }
        representative = authorization["representatives"][treatment]["selectedReplicate"]
        rep_treatment = data[label(representative, treatment)]
        rep_control = data[label(representative, CONTROL)]
        representative_effects = {
            metric: float((rep_treatment[metric] - rep_control[metric]).mean())
            for metric in ("win", "vp", "post15", "finish")
        }
        representative_guardians = guardian_point_effects(data, treatment, representative)
        representative_gates = {
            "winGainAtLeast3Points": representative_effects["win"] >= 0.03,
            "rawWinNoWorseThanBase": float(rep_treatment["win"].mean()) >= base_win_rate,
            "finalVpNonnegative": representative_effects["vp"] >= 0,
            "post15Nonnegative": representative_effects["post15"] >= 0,
            "finishNonpositive": representative_effects["finish"] <= 0,
            "guardianFloor": min(representative_guardians.values()) >= -0.05,
            "zeroStalls": True,
        }
        mechanisms[treatment] = {
            "rawTreatmentWinRate": raw_treatment_win_rate,
            "baseWinRate": base_win_rate,
            "replicateWinEffects": replicate_win_effects,
            "metrics": metric_rows,
            "guardianWinEffects": guardian_effects,
            "aggregateGates": aggregate_gates,
            "aggregatePassed": all(aggregate_gates.values()),
            "representative": {
                "replicate": representative,
                "treatmentLabel": label(representative, treatment),
                "controlLabel": label(representative, CONTROL),
                "effects": representative_effects,
                "guardianWinEffects": representative_guardians,
                "gates": representative_gates,
                "passed": all(representative_gates.values()),
            },
        }
        mechanisms[treatment]["eligible"] = (
            mechanisms[treatment]["aggregatePassed"]
            and mechanisms[treatment]["representative"]["passed"]
        )

    eligible = [treatment for treatment in TREATMENTS if mechanisms[treatment]["eligible"]]
    selected: str | None = None
    selection_reason = "no-eligible-mechanism"
    if len(eligible) == 1:
        selected = eligible[0]
        selection_reason = "sole-eligible-mechanism"
    elif len(eligible) == 2:
        difference = abs(
            mechanisms[eligible[0]]["rawTreatmentWinRate"]
            - mechanisms[eligible[1]]["rawTreatmentWinRate"]
        )
        if difference < 0.01:
            selected = "late-reweighted"
            selection_reason = "aggregate-win-rate-tie-under-1-point"
        else:
            selected = max(eligible, key=lambda treatment: mechanisms[treatment]["rawTreatmentWinRate"])
            selection_reason = "higher-aggregate-win-rate"
    return {
        "schemaVersion": "arc-v35-phase1-development-analysis-v1",
        "valid": True,
        "authorization": {"path": str(authorization_path), "sha256": sha256(authorization_path)},
        "reports": {"path": str(reports_path), "sha256": sha256(reports_path)},
        "contract": authorization["contract"],
        "bootstrap": {
            "samples": BOOTSTRAP_SAMPLES,
            "seed": BOOTSTRAP_SEED,
            "simultaneousConfidence": SIMULTANEOUS_CONFIDENCE,
            "familySize": 2,
            "cluster": "complete common seed with all three replicate pairs",
        },
        "mechanisms": mechanisms,
        "selection": {
            "eligibleMechanisms": eligible,
            "selectedMechanism": selected,
            "reason": selection_reason,
            "selectedRepresentative": None if selected is None else authorization["representatives"][selected],
            "privateConfirmationAuthorized": selected is not None,
        },
        "promotionEligible": False,
        "remainingGates": [
            "fresh-private-solo-confirmation",
            "status3-unrestricted-solo",
            "multiplayer-gauntlets",
            "exploitability",
            "hidden-information-and-fairness",
            "latency-and-load",
            "catalog-and-replay-regression",
            "Michael-blinded-games",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--authorization", type=Path, required=True)
    parser.add_argument("--reports", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise FileExistsError(f"refusing to overwrite V35 analysis: {args.out}")
    result = analyze(args.authorization.resolve(), args.reports.resolve())
    temporary = args.out.with_suffix(args.out.suffix + ".tmp")
    temporary.write_text(json.dumps(result, indent=2) + "\n")
    temporary.replace(args.out)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
