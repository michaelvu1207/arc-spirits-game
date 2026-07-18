#!/usr/bin/env python3
"""Outcome-blind V32 treatment-movement audit on frozen critic-validation states."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import torch

from model_v2 import load_checkpoint


ARMS = ("control-uniform", "round-reweighted", "p30-credit025")
REPLICATES = ("a", "b", "c")
BANDS = ("1-8", "9-18", "19-30")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def round_band(round_number: int) -> str:
    return "1-8" if round_number <= 8 else "9-18" if round_number <= 18 else "19-30"


def load_probe(validation: Path, rows_per_game_band: int) -> tuple[list[dict], dict[str, Any]]:
    shards = sorted(validation.glob("shard-*.jsonl"))
    if not shards:
        raise ValueError(f"no validation shards below {validation}")
    selected: list[dict] = []
    general_counts: dict[tuple[str, str], int] = defaultdict(int)
    strategic_counts: dict[tuple[str, str], int] = defaultdict(int)
    targets: dict[str, int] = {}
    all_games: set[str] = set()
    policy_rows = 0
    for path in shards:
        with path.open() as handle:
            for line_number, line in enumerate(handle, 1):
                row = json.loads(line)
                game_id = str(row.get("gameId", ""))
                if not game_id:
                    raise ValueError(f"{path}:{line_number}: missing gameId")
                all_games.add(game_id)
                if row.get("reach30Target") is not None:
                    target = int(row["reach30Target"])
                    if target not in (0, 1) or (game_id in targets and targets[game_id] != target):
                        raise ValueError(f"{path}:{line_number}: inconsistent reach30 target")
                    targets[game_id] = target
                if int(row.get("policyMask", 0)) != 1:
                    continue
                policy_rows += 1
                round_number = int(row.get("round", 0))
                if not 1 <= round_number <= 30:
                    raise ValueError(f"{path}:{line_number}: invalid round {round_number}")
                if row.get("reach30Pred") is None:
                    raise ValueError(f"{path}:{line_number}: missing reach30Pred")
                band = round_band(round_number)
                key = (game_id, band)
                take_general = general_counts[key] < rows_per_game_band
                take_strategic = bool(row.get("strategic")) and strategic_counts[key] < rows_per_game_band
                if take_general or take_strategic:
                    selected.append(row)
                if take_general:
                    general_counts[key] += 1
                if take_strategic:
                    strategic_counts[key] += 1
    if targets.keys() != all_games:
        raise ValueError(
            f"validation target coverage mismatch: games={len(all_games)} targets={len(targets)}"
        )
    if len(all_games) != 1024:
        raise ValueError(f"expected 1024 frozen validation games, got {len(all_games)}")
    for row in selected:
        row["_reach30Target"] = targets[str(row["gameId"])]
    return selected, {
        "validationGames": len(all_games),
        "validationPolicyRows": policy_rows,
        "selectedRows": len(selected),
        "selectedStrategicRows": sum(int(bool(row.get("strategic"))) for row in selected),
        "rowsPerGameBandPerStratum": rows_per_game_band,
    }


def padded_batch(rows: list[dict], device: torch.device) -> tuple[torch.Tensor, ...]:
    max_cands = max(len(row["cands"]) for row in rows)
    act_dim = len(rows[0]["cands"][0])
    obs = np.asarray([row["obsV2"] for row in rows], dtype=np.float32)
    cands = np.zeros((len(rows), max_cands, act_dim), dtype=np.float32)
    mask = np.zeros((len(rows), max_cands), dtype=bool)
    chosen = np.zeros(len(rows), dtype=np.int64)
    for index, row in enumerate(rows):
        values = np.asarray(row["cands"], dtype=np.float32)
        support = np.asarray(row["behaviorMask"], dtype=bool)
        if len(support) != len(values) or not support[int(row["chosen"])]:
            raise ValueError(f"invalid behavior support for {row['gameId']}:{row['stepIdx']}")
        cands[index, : len(values)] = values
        mask[index, : len(values)] = support
        chosen[index] = int(row["chosen"])
    return (
        torch.from_numpy(obs).to(device),
        torch.from_numpy(cands).to(device),
        torch.from_numpy(mask).to(device),
        torch.from_numpy(chosen).to(device),
    )


def mean_equal_game(values: list[tuple[str, float]]) -> float:
    by_game: dict[str, list[float]] = defaultdict(list)
    for game_id, value in values:
        by_game[game_id].append(value)
    return float(np.mean([np.mean(game_values) for game_values in by_game.values()]))


def weighted_signal_stats(rows: list[dict], deltas: np.ndarray) -> dict[str, float | int]:
    entries: list[tuple[str, float, float]] = []
    per_game_counts: dict[str, int] = defaultdict(int)
    for row, delta in zip(rows, deltas):
        if not bool(row.get("strategic")):
            continue
        game_id = str(row["gameId"])
        residual = float(row["_reach30Target"]) - float(row["reach30Pred"])
        entries.append((game_id, residual, float(delta)))
        per_game_counts[game_id] += 1
    if not entries:
        raise ValueError("manipulation probe has no strategic policy rows")
    weights = np.asarray([1.0 / per_game_counts[game_id] for game_id, _, _ in entries])
    weights /= weights.sum()
    residual = np.asarray([value for _, value, _ in entries], dtype=np.float64)
    delta = np.asarray([value for _, _, value in entries], dtype=np.float64)
    residual_mean = float(np.sum(weights * residual))
    residual_std = math.sqrt(float(np.sum(weights * np.square(residual - residual_mean))))
    if residual_std < 1e-12:
        raise ValueError("reach30 residual has zero weighted variance")
    z = (residual - residual_mean) / residual_std
    delta_mean = float(np.sum(weights * delta))
    covariance = float(np.sum(weights * z * (delta - delta_mean)))
    delta_std = math.sqrt(float(np.sum(weights * np.square(delta - delta_mean))))
    correlation = covariance / delta_std if delta_std > 1e-12 else 0.0
    return {
        "rows": len(entries),
        "games": len(per_game_counts),
        "standardizedResidualChosenLogpCovariance": covariance,
        "correlation": correlation,
    }


def evaluate_gates(models: dict[str, dict[str, dict]], *, min_kl: float, ratio: float) -> dict:
    movement_passes: dict[str, list[str]] = {}
    for arm in ("round-reweighted", "p30-credit025"):
        movement_passes[arm] = [
            replicate
            for replicate in REPLICATES
            if models[replicate][arm]["kl"]["overall"] >= min_kl
        ]
    round_ratio: dict[str, float] = {}
    round_ratio_passes: list[str] = []
    p30_covariance_passes: list[str] = []
    p30_excess_covariance: dict[str, float] = {}
    for replicate in REPLICATES:
        control = models[replicate]["control-uniform"]
        treatment = models[replicate]["round-reweighted"]
        control_ratio = control["kl"]["19-30"] / max(control["kl"]["1-8"], 1e-12)
        treatment_ratio = treatment["kl"]["19-30"] / max(treatment["kl"]["1-8"], 1e-12)
        multiplier = treatment_ratio / max(control_ratio, 1e-12)
        round_ratio[replicate] = multiplier
        if multiplier >= ratio:
            round_ratio_passes.append(replicate)
        p30_cov = models[replicate]["p30-credit025"]["reach30Signal"][
            "standardizedResidualChosenLogpCovariance"
        ]
        control_cov = control["reach30Signal"]["standardizedResidualChosenLogpCovariance"]
        p30_excess_covariance[replicate] = p30_cov - control_cov
        if p30_cov > 0:
            p30_covariance_passes.append(replicate)
    checks = {
        "movement": {
            arm: {"passingReplicates": reps, "passed": len(reps) >= 2}
            for arm, reps in movement_passes.items()
        },
        "roundLateEarlyVsControl": {
            "multipliers": round_ratio,
            "passingReplicates": round_ratio_passes,
            "passed": len(round_ratio_passes) >= 2,
        },
        "p30PositiveCovariance": {
            "passingReplicates": p30_covariance_passes,
            "excessVsControl": p30_excess_covariance,
            "passed": len(p30_covariance_passes) >= 2,
        },
    }
    passed = all(entry["passed"] for entry in checks["movement"].values()) and checks[
        "roundLateEarlyVsControl"
    ]["passed"] and checks["p30PositiveCovariance"]["passed"]
    return {"passed": passed, "checks": checks}


def audit(args: argparse.Namespace) -> dict[str, Any]:
    experiment = args.experiment.resolve()
    validation = args.validation.resolve()
    base_path = experiment / "shared-critic" / "checkpoint.pt"
    rows, probe = load_probe(validation, args.rows_per_game_band)
    device = torch.device(args.device)
    base = load_checkpoint(base_path, device).eval()
    checkpoints: dict[str, dict[str, tuple[Path, Any]]] = {}
    for replicate in REPLICATES:
        checkpoints[replicate] = {}
        for arm in ARMS:
            path = experiment / "league" / f"rep-{replicate}" / arm / "checkpoints" / f"main-0-gen{args.generation}.pt"
            if not path.exists():
                raise FileNotFoundError(path)
            checkpoints[replicate][arm] = (path, load_checkpoint(path, device).eval())
    model_metrics: dict[str, dict[str, dict[str, Any]]] = {
        replicate: {
            arm: {
                "path": str(checkpoints[replicate][arm][0]),
                "sha256": sha256(checkpoints[replicate][arm][0]),
                "klRows": {band: [] for band in BANDS},
                "allKlRows": [],
                "signalRows": [],
                "signalDeltas": [],
            }
            for arm in ARMS
        }
        for replicate in REPLICATES
    }
    with torch.no_grad():
        for start in range(0, len(rows), args.batch_size):
            batch_rows = rows[start : start + args.batch_size]
            obs, cands, mask, chosen = padded_batch(batch_rows, device)
            base_logits = base(obs, cands, mask)[0] / args.temperature
            base_logp = torch.log_softmax(base_logits, dim=-1)
            base_probs = torch.softmax(base_logits, dim=-1)
            base_chosen = base_logp.gather(1, chosen[:, None]).squeeze(1)
            for replicate in REPLICATES:
                for arm in ARMS:
                    metrics = model_metrics[replicate][arm]
                    model = checkpoints[replicate][arm][1]
                    endpoint_logp = torch.log_softmax(model(obs, cands, mask)[0] / args.temperature, dim=-1)
                    kl = torch.sum(base_probs * (base_logp - endpoint_logp), dim=-1).cpu().numpy()
                    delta = (
                        endpoint_logp.gather(1, chosen[:, None]).squeeze(1) - base_chosen
                    ).cpu().numpy()
                    for row, row_kl in zip(batch_rows, kl):
                        game_id = str(row["gameId"])
                        band = round_band(int(row["round"]))
                        metrics["allKlRows"].append((game_id, float(row_kl)))
                        metrics["klRows"][band].append((game_id, float(row_kl)))
                    metrics["signalRows"].extend(batch_rows)
                    metrics["signalDeltas"].extend(float(value) for value in delta)
    result_models: dict[str, dict[str, dict]] = {}
    for replicate in REPLICATES:
        result_models[replicate] = {}
        for arm in ARMS:
            raw = model_metrics[replicate][arm]
            signal = weighted_signal_stats(raw["signalRows"], np.asarray(raw["signalDeltas"]))
            result_models[replicate][arm] = {
                "path": raw["path"],
                "sha256": raw["sha256"],
                "kl": {
                    "overall": mean_equal_game(raw["allKlRows"]),
                    **{band: mean_equal_game(raw["klRows"][band]) for band in BANDS},
                },
                "reach30Signal": signal,
            }
    gates = evaluate_gates(result_models, min_kl=args.min_mean_kl, ratio=args.late_early_ratio)
    return {
        "schemaVersion": "arc-v32-manipulation-audit-v1",
        "valid": True,
        "generation": args.generation,
        "performanceOutcomesInspected": False,
        "endpointRule": "generation 8 unless movement fails, then all roots continue unchanged to generation 12",
        "base": {"path": str(base_path), "sha256": sha256(base_path)},
        "validation": str(validation),
        "temperature": args.temperature,
        "probe": probe,
        "thresholds": {
            "treatmentMeanKl": args.min_mean_kl,
            "replicatesRequired": 2,
            "roundLateEarlyRatioVsControl": args.late_early_ratio,
            "p30Covariance": "strictly positive",
        },
        "models": result_models,
        "manipulation": gates,
        "disposition": "eligible-endpoint" if gates["passed"] else "inconclusive-underdosed",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--experiment", type=Path, required=True)
    parser.add_argument("--validation", type=Path, required=True)
    parser.add_argument("--generation", type=int, choices=(8, 12), required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--temperature", type=float, default=0.55)
    parser.add_argument("--rows-per-game-band", type=int, default=2)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--min-mean-kl", type=float, default=0.005)
    parser.add_argument("--late-early-ratio", type=float, default=1.25)
    args = parser.parse_args()
    result = audit(args)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.out.with_suffix(args.out.suffix + ".tmp")
    temporary.write_text(json.dumps(result, indent=2) + "\n")
    temporary.replace(args.out)
    print(json.dumps({
        "generation": result["generation"],
        "manipulation": result["manipulation"],
        "disposition": result["disposition"],
    }, indent=2))


if __name__ == "__main__":
    main()
