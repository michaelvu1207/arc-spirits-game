#!/usr/bin/env python3
"""Reproduce the conservative public-data power calibration for the P30 screen."""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
from pathlib import Path
from typing import Any, Mapping

import numpy as np

from v35_p30_statistics import conservative_sign_flip_tolerance


SCHEMA = "arc-v35-p30-power-calibration-v1"
PRIOR_REPLICATES = tuple("abc")
ARMS = ("control-uniform", "p30-credit025", "late-reweighted")
METRICS = ("trueWinRate", "lateGameScore", "postRound15Vp")
TARGET_REPLICATES = 18
FAMILY_SIZE = 6
FAMILYWISE_ALPHA = 0.05
WORST_CASE_ALPHA = FAMILYWISE_ALPHA / FAMILY_SIZE
SIMULATIONS = 20_000
SENSITIVITY_SIMULATIONS = 5_000
RNG_SEED = 35_153_047
REQUIRED_JOINT_LOWER_BOUND = 0.8
SIMULTANEOUS_ENDPOINT_ONE_SIDED_95_Z = 2.128045234184984
MINIMUM_WIN_GAIN = 0.03
MINIMUM_POSITIVE_REPLICATES = 13
REPLICATE_FLOOR = -0.01
MAXIMUM_REPLICATES_BELOW_FLOOR = 2
PLANNING_TARGETS = {
    "trueWinRate": 0.04,
    "lateGameScore": 0.025,
    "postRound15Vp": 0.10,
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def finite(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be numeric")
    result = float(value)
    if not np.isfinite(result):
        raise ValueError(f"{label} must be finite")
    return result


def late_score(row: Mapping[str, Any]) -> float:
    vp_growth = min(max(finite(row["post15VpPerRound"], "post15") / 3.0, 0.0), 1.0)
    engine_growth = min(
        max(
            (
                finite(row["finalAttackDice"], "dice") / 8.0
                + finite(row["finalSpirits"], "spirits") / 8.0
                + finite(row["finalMaxBarrier"], "barrier") / 8.0
            )
            / 3.0,
            0.0,
        ),
        1.0,
    )
    return 0.6 * float(bool(row["trueWin"])) + 0.25 * vp_growth + 0.15 * engine_growth


def metrics(row: Mapping[str, Any]) -> np.ndarray:
    return np.asarray(
        [
            float(bool(row["trueWin"])),
            late_score(row),
            finite(row["post15VpPerRound"], "post15"),
        ],
        dtype=np.float64,
    )


def load_reports(repo: Path) -> tuple[dict[str, Mapping[str, Any]], dict[str, str]]:
    experiment = repo / "ml/experiments/v35-weco-recursive-autoresearch"
    manifest_path = experiment / "artifacts/phase1-development-reports.json"
    manifest = json.loads(manifest_path.read_text())
    if (
        manifest.get("schemaVersion") != "arc-v35-phase1-development-reports-v1"
        or manifest.get("complete") is not True
    ):
        raise ValueError("Phase 1 public report manifest is invalid")
    reports: dict[str, Mapping[str, Any]] = {}
    hashes: dict[str, str] = {}
    for replicate in PRIOR_REPLICATES:
        for arm in ARMS:
            label = f"rep-{replicate}-{arm}"
            path = experiment / "development" / label / "attempt-1/report.json"
            expected = manifest["reports"][label]["sha256"]
            actual = sha256(path)
            if actual != expected:
                raise ValueError(f"{label}: public report hash changed")
            value = json.loads(path.read_text())
            if value.get("games") != 4096 or value.get("seed0") != 969030000 or value.get("stalls") != 0:
                raise ValueError(f"{label}: public report contract changed")
            reports[label] = value
            hashes[label] = actual
    return reports, hashes


def replicate_effects(
    reports: Mapping[str, Mapping[str, Any]], treatment: str
) -> np.ndarray:
    result = []
    for replicate in PRIOR_REPLICATES:
        control_rows = {
            row["seed"]: row for row in reports[f"rep-{replicate}-control-uniform"]["perGame"]
        }
        treatment_rows = {
            row["seed"]: row for row in reports[f"rep-{replicate}-{treatment}"]["perGame"]
        }
        if set(control_rows) != set(treatment_rows) or len(control_rows) != 4096:
            raise ValueError(f"replicate {replicate}: paired public seed coverage changed")
        result.append(
            np.mean(
                [metrics(treatment_rows[seed]) - metrics(control_rows[seed]) for seed in sorted(control_rows)],
                axis=0,
            )
        )
    return np.asarray(result, dtype=np.float64)


def one_sided_95_sd_factor_df2() -> float:
    # For df=2, chi-square CDF is 1-exp(-x/2), so q_0.05=-2*log(0.95).
    chi_square_q05 = -2.0 * math.log(0.95)
    return math.sqrt(2.0 / chi_square_q05)


def exact_primary_eligibility_power(
    *,
    metric: str,
    mean: float,
    standard_deviation: float,
    rng: np.random.Generator,
    simulations: int = SIMULATIONS,
) -> float:
    signs = np.asarray(
        tuple(itertools.product((-1.0, 1.0), repeat=TARGET_REPLICATES)),
        dtype=np.float64,
    )
    passed = 0
    chunk = 20
    for start in range(0, simulations, chunk):
        count = min(chunk, simulations - start)
        samples = rng.normal(mean, standard_deviation, size=(count, TARGET_REPLICATES))
        observed = samples.mean(axis=1)
        permuted = samples @ signs.T / TARGET_REPLICATES
        tolerance = conservative_sign_flip_tolerance(samples, axis=1)
        p_values = np.mean(permuted >= observed[:, None] - tolerance[:, None], axis=1)
        eligible = p_values <= WORST_CASE_ALPHA
        if metric == "trueWinRate":
            eligible &= observed >= MINIMUM_WIN_GAIN
            eligible &= np.count_nonzero(samples > 0, axis=1) >= MINIMUM_POSITIVE_REPLICATES
            eligible &= (
                np.count_nonzero(samples < REPLICATE_FLOOR, axis=1)
                <= MAXIMUM_REPLICATES_BELOW_FLOOR
            )
        passed += int(np.count_nonzero(eligible))
    return passed / simulations


def simultaneous_wilson_lower_95(success_rate: float, trials: int) -> float:
    z = SIMULTANEOUS_ENDPOINT_ONE_SIDED_95_Z
    denominator = 1.0 + z**2 / trials
    center = (success_rate + z**2 / (2.0 * trials)) / denominator
    radius = (
        z
        * math.sqrt(
            success_rate * (1.0 - success_rate) / trials
            + z**2 / (4.0 * trials**2)
        )
        / denominator
    )
    return center - radius


def build(repo: Path) -> dict[str, Any]:
    experiment = repo / "ml/experiments/v35-weco-recursive-autoresearch"
    analysis_path = experiment / "artifacts/phase1-development-analysis.json"
    reports_manifest_path = experiment / "artifacts/phase1-development-reports.json"
    reports, report_hashes = load_reports(repo)
    effects = {
        treatment: replicate_effects(reports, treatment)
        for treatment in ("p30-credit025", "late-reweighted")
    }
    observed: dict[str, Any] = {}
    for treatment, values in effects.items():
        observed[treatment] = {
            metric: {
                "replicateEffects": [float(value) for value in values[:, index]],
                "mean": float(values[:, index].mean()),
                "sampleStandardDeviation": float(values[:, index].std(ddof=1)),
            }
            for index, metric in enumerate(METRICS)
        }
    prior_max_sd = {
        metric: max(
            observed["p30-credit025"][metric]["sampleStandardDeviation"],
            observed["late-reweighted"][metric]["sampleStandardDeviation"],
        )
        for metric in METRICS
    }
    sd_factor = one_sided_95_sd_factor_df2()
    sensitivity_sd = {metric: prior_max_sd[metric] * sd_factor for metric in METRICS}
    rng = np.random.default_rng(RNG_SEED)
    powers = {
        metric: exact_primary_eligibility_power(
            metric=metric,
            mean=PLANNING_TARGETS[metric],
            standard_deviation=sensitivity_sd[metric],
            rng=rng,
        )
        for metric in METRICS
    }
    simultaneous_power_lower_95 = {
        metric: simultaneous_wilson_lower_95(value, SIMULATIONS)
        for metric, value in powers.items()
    }
    joint_point_lower_bound = max(0.0, 1.0 - sum(1.0 - value for value in powers.values()))
    joint_monte_carlo_lower_95 = max(
        0.0, 1.0 - sum(1.0 - value for value in simultaneous_power_lower_95.values())
    )
    adequate = joint_monte_carlo_lower_95 >= REQUIRED_JOINT_LOWER_BOUND
    smaller_effect_sensitivity: dict[str, Any] = {}
    for fraction in (0.75, 0.5):
        sensitivity_rng = np.random.default_rng(RNG_SEED + int(fraction * 1000))
        fraction_powers = {
            metric: exact_primary_eligibility_power(
                metric=metric,
                mean=PLANNING_TARGETS[metric] * fraction,
                standard_deviation=sensitivity_sd[metric],
                rng=sensitivity_rng,
                simulations=SENSITIVITY_SIMULATIONS,
            )
            for metric in METRICS
        }
        smaller_effect_sensitivity[str(fraction)] = {
            "effectFraction": fraction,
            "targetEffects": {
                metric: PLANNING_TARGETS[metric] * fraction for metric in METRICS
            },
            "samples": SENSITIVITY_SIMULATIONS,
            "seed": RNG_SEED + int(fraction * 1000),
            "powerByPrimaryEndpoint": fraction_powers,
            "bonferroniJointPrimaryEligibilityPowerPointLowerBound": max(
                0.0,
                1.0 - sum(1.0 - value for value in fraction_powers.values()),
            ),
            "powerClaimed": False,
        }
    return {
        "schemaVersion": SCHEMA,
        "valid": True,
        "developmentOnly": True,
        "promotionEligible": False,
        "scope": {
            "claim": "primary-efficacy-eligibility-power-only",
            "fullSelectorPowerClaimed": False,
            "safetyGatePowerClaimed": False,
            "conditionalAlternative": "Any one treatment arm attains the complete planning-target vector; the other arm may be arbitrary.",
        },
        "inputs": {
            "phase1DevelopmentAnalysis": {
                "path": str(analysis_path.relative_to(repo)),
                "sha256": sha256(analysis_path),
            },
            "phase1DevelopmentReports": {
                "path": str(reports_manifest_path.relative_to(repo)),
                "sha256": sha256(reports_manifest_path),
            },
            "reportSha256": report_hashes,
        },
        "observedPublicReplicateEffects": observed,
        "planningAlternative": {
            "minimumMeaningfulTargetEffects": PLANNING_TARGETS,
            "priorMaximumSampleStandardDeviations": prior_max_sd,
            "standardDeviationSensitivity": {
                "method": "each-metric-one-sided-95-percent-upper-bound-from-df2-prior-maximum",
                "factor": sd_factor,
                "values": sensitivity_sd,
                "simultaneousCoverageClaimed": False,
            },
        },
        "test": {
            "method": "exact-paired-replicate-sign-flip",
            "nullAssumption": "paired replicate effects are independent and sign-exchangeable under the null",
            "replicates": TARGET_REPLICATES,
            "enumerations": 2**TARGET_REPLICATES,
            "familywiseAlpha": FAMILYWISE_ALPHA,
            "worstCasePerEndpointAlpha": WORST_CASE_ALPHA,
            "familySize": FAMILY_SIZE,
            "primaryEligibilityGates": {
                "minimumTrueWinPointGain": MINIMUM_WIN_GAIN,
                "minimumPositiveReplicates": MINIMUM_POSITIVE_REPLICATES,
                "replicateFloor": REPLICATE_FLOOR,
                "maximumReplicatesBelowFloor": MAXIMUM_REPLICATES_BELOW_FLOOR,
            },
        },
        "simulation": {
            "distribution": "normal-replicate-effect-sensitivity-model",
            "samples": SIMULATIONS,
            "seed": RNG_SEED,
            "powerByPrimaryEndpoint": powers,
            "endpointMonteCarloBound": {
                "method": "one-sided-Wilson-with-Bonferroni-simultaneous-endpoint-coverage",
                "familywiseAlpha": 0.05,
                "endpointAlpha": 0.05 / len(METRICS),
                "z": SIMULTANEOUS_ENDPOINT_ONE_SIDED_95_Z,
            },
            "powerSimultaneousFamilywise95MonteCarloLowerByPrimaryEndpoint": simultaneous_power_lower_95,
            "bonferroniJointPrimaryEligibilityPowerPointLowerBound": joint_point_lower_bound,
            "bonferroniJointPrimaryEligibilityPowerSimultaneousMonteCarloLower95": joint_monte_carlo_lower_95,
            "requiredJointLowerBound": REQUIRED_JOINT_LOWER_BOUND,
            "adequateForPrimaryEfficacy": adequate,
            "smallerEffectSensitivity": smaller_effect_sensitivity,
        },
        "limitations": [
            "This is design calibration from already-open public Phase 1 data, not evidence that a P30 treatment works.",
            "The deliberately severe variance sensitivity multiplies each maximum prior SD by its df=2 one-sided 95% upper-bound factor.",
            "Power is claimed only for the exact primary efficacy family and hard win-effect/replicate-consistency gates under the stated planning alternative.",
            "Guardian, non-regression, stall, malformed-episode, latency, fresh-public, private, and promotion gates are safety filters and have no power claim.",
            "Fresh public and private confirmations remain mandatory even if the development screen selects an arm.",
            "The 75% and 50% planning-effect simulations are diagnostic sensitivity curves only; they carry no adequacy or promotion claim.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    value = build(args.repo.resolve())
    payload = json.dumps(value, indent=2, allow_nan=False) + "\n"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(payload)
    print(payload, end="")


if __name__ == "__main__":
    main()
