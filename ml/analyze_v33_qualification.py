#!/usr/bin/env python3
"""Frozen V33 development/hidden solo qualification analyzer."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from ml.analyze_v33_search import (
    guardian_deltas,
    load_json,
    paired_bootstrap,
    paired_vectors,
    require,
    sha256,
    verify_source_lock,
)


def validate(
    report: dict[str, Any],
    *,
    label: str,
    protocol: dict[str, Any],
    source_lock: dict[str, Any],
    seed0: int,
    games: int,
    selected_arm: dict[str, Any],
) -> list[dict[str, Any]]:
    require(report.get("schemaVersion") == "solo-heldout-v2", f"{label}: schema")
    require(report.get("seed0") == seed0 and report.get("games") == games, f"{label}: seed design")
    require(report.get("sourceCommit") == source_lock["implementationCommit"], f"{label}: source")
    require(report.get("maxRounds") == 30 and report.get("maxStatusLevel") == 2, f"{label}: game contract")
    require(report.get("catalogSha256") == protocol["catalog"]["sha256"], f"{label}: catalog")
    expected_weights = (
        protocol["v23Comparator"]["sha256"] if label == "v23" else protocol["policy"]["sha256"]
    )
    require(report.get("weightsSha256") == expected_weights, f"{label}: weights")
    if label != "v23":
        inference = report.get("inference", {})
        require(
            inference.get("weightsSha256") == protocol["policy"]["sha256"]
            and inference.get("format") == protocol["policy"]["format"]
            and inference.get("wire") == protocol["commonDecode"]["inferenceWire"],
            f"{label}: served checkpoint/wire provenance",
        )
    decode = report.get("decode", {})
    require(
        decode.get("sample") is True
        and decode.get("temperature") == 0.55
        and decode.get("learnMonsterRewardChoices") is False,
        f"{label}: common decode",
    )
    if label == "v23":
        require(decode.get("policyObsVersion") == 1 and "inferenceSocket" not in decode, "v23 decode")
        require("search" not in decode, "v23 unexpectedly searched")
    elif label == "raw":
        require(decode.get("policyObsVersion") == 2 and isinstance(decode.get("inferenceSocket"), str), "raw decode")
        require("search" not in decode, "raw unexpectedly searched")
    else:
        require(decode.get("policyObsVersion") == 2 and isinstance(decode.get("inferenceSocket"), str), "selected decode")
        require(
            decode.get("search")
            == {
                "sims": selected_arm["sims"],
                "objective": "solo-reach30",
                "horizonRounds": selected_arm["horizonRounds"],
                "frac": 1,
                "valueWeight": 0.5,
                "rollout": "policy",
                "navTemperature": 0,
            },
            "selected search decode",
        )
    rows = report.get("perGame")
    require(isinstance(rows, list) and len(rows) == games, f"{label}: row coverage")
    rows = sorted(rows, key=lambda row: row["seed"])
    require([row["seed"] for row in rows] == list(range(seed0, seed0 + games)), f"{label}: seeds")
    require(all(row.get("stalled") is False for row in rows), f"{label}: stall")
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=["development", "hidden"], required=True)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--source-lock", type=Path, required=True)
    parser.add_argument("--phase2-analysis", type=Path, required=True)
    parser.add_argument("--prior-development", type=Path)
    parser.add_argument("--selected", type=Path, required=True)
    parser.add_argument("--raw", type=Path, required=True)
    parser.add_argument("--v23", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    protocol = load_json(args.protocol)
    source_lock = load_json(args.source_lock)
    phase2 = load_json(args.phase2_analysis)
    verify_source_lock(args.repo.resolve(), source_lock)
    require(phase2.get("schemaVersion") == "arc-v33-phase2-analysis-v1", "phase2 schema")
    require(
        phase2.get("sourceLock", {}).get("sha256") == sha256(args.source_lock),
        "phase2 source-lock hash mismatch",
    )
    selected_id = phase2.get("selectedArm")
    require(isinstance(selected_id, str), "phase2 did not freeze one selected arm")
    require(phase2.get("authorizationResult", {}).get("phase3DevelopmentSeedsOpen") is True, "development not authorized")
    selected_arm = next(arm for arm in protocol["systems"]["arms"] if arm["id"] == selected_id)
    phase2_selected = phase2.get("analyses", {}).get(selected_id, {})
    require(phase2_selected.get("gate", {}).get("eligible") is True, "phase2 selected arm was not eligible")
    binding_latency_passed = all(
        phase2_selected.get("gate", {}).get("checks", {}).get(name) is True
        for name in ("singleConcurrencyLatency", "eightConcurrencyLatency")
    )
    require(binding_latency_passed, "selected arm lacks binding latency evidence")
    block = protocol["phase3"][args.stage]
    if args.stage == "hidden":
        require(args.prior_development is not None, "hidden requires prior development analysis")
        prior = load_json(args.prior_development)
        require(prior.get("schemaVersion") == "arc-v33-qualification-analysis-v1", "prior schema")
        require(prior.get("stage") == "development", "prior is not development")
        require(prior.get("selectedArm") == selected_id, "selected arm changed")
        require(
            prior.get("sourceLock", {}).get("sha256") == sha256(args.source_lock),
            "prior source-lock hash mismatch",
        )
        require(prior.get("authorizationResult", {}).get("hiddenSeedsOpen") is True, "hidden not authorized")
    reports = {
        "selected": load_json(args.selected),
        "raw": load_json(args.raw),
        "v23": load_json(args.v23),
    }
    rows = {
        label: validate(
            report,
            label=label,
            protocol=protocol,
            source_lock=source_lock,
            seed0=block["seed0"],
            games=block["games"],
            selected_arm=selected_arm,
        )
        for label, report in reports.items()
    }
    contrasts = {
        comparator: paired_vectors(rows[comparator], rows["selected"])
        for comparator in ("raw", "v23")
    }
    intervals = paired_bootstrap(
        contrasts,
        draws=protocol["phase3"]["bootstrapDraws"],
        rng_seed=protocol["phase3"][
            "bootstrapRngSeed" if args.stage == "development" else "hiddenBootstrapRngSeed"
        ],
        interval_confidence=protocol["phase3"]["simultaneousConfidence"],
    )
    guardians = {
        comparator: guardian_deltas(rows[comparator], rows["selected"])
        for comparator in ("raw", "v23")
    }
    checks: dict[str, bool] = {
        "absoluteTrueWinRate": (
            reports["selected"]["trueWinRate"]
            >= protocol["phase3"]["gates"]["absoluteTrueWinRateMin"]
        ),
        "zeroStalls": all(report["stalls"] == 0 for report in reports.values()),
    }
    for comparator in ("raw", "v23"):
        interval = intervals[comparator]
        checks[f"winGainVs{comparator}"] = interval["trueWin"]["mean"] * 100 >= 3
        checks[f"winLowerVs{comparator}"] = interval["trueWin"]["lower"] > 0
        checks[f"finalVpVs{comparator}"] = (
            interval["finalVP"]["mean"] >= protocol["phase3"]["gates"]["finalVpPointDeltaMin"]
        )
        checks[f"post15Vs{comparator}"] = (
            interval["post15"]["mean"]
            >= protocol["phase3"]["gates"]["post15VpPerRoundPointDeltaMin"]
        )
        checks[f"censoredRoundVs{comparator}"] = (
            interval["censoredRound"]["mean"]
            <= protocol["phase3"]["gates"]["censoredFirst30RoundPointDeltaMax"]
        )
        checks[f"guardianVs{comparator}"] = (
            min(guardians[comparator].values())
            >= protocol["phase3"]["gates"]["guardianPointDeltaMin"]
        )
    checks["bindingLatencyCarriedForward"] = binding_latency_passed
    passed = all(checks.values())
    result = {
        "schemaVersion": "arc-v33-qualification-analysis-v1",
        "stage": args.stage,
        "selectedArm": selected_id,
        "sourceLock": {"path": str(args.source_lock), "sha256": sha256(args.source_lock)},
        "phase2Analysis": {"path": str(args.phase2_analysis), "sha256": sha256(args.phase2_analysis)},
        **(
            {
                "priorDevelopment": {
                    "path": str(args.prior_development),
                    "sha256": sha256(args.prior_development),
                }
            }
            if args.prior_development is not None
            else {}
        ),
        "reports": {
            "selected": {"path": str(args.selected), "sha256": sha256(args.selected)},
            "raw": {"path": str(args.raw), "sha256": sha256(args.raw)},
            "v23": {"path": str(args.v23), "sha256": sha256(args.v23)},
        },
        "selectedTrueWinRate": reports["selected"]["trueWinRate"],
        "paired": intervals,
        "guardianPointDeltas": guardians,
        "checks": checks,
        "passed": passed,
        "authorizationResult": {
            "hiddenSeedsOpen": args.stage == "development" and passed,
            "multiplayerQualificationOpen": args.stage == "hidden" and passed,
            "productionPromotionOpen": False,
        },
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
