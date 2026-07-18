#!/usr/bin/env python3
"""Outcome-blind V35 treatment-movement audit on frozen critic-validation states."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import torch

from audit_v32_manipulation import (
    BANDS,
    load_probe,
    mean_equal_game,
    padded_batch,
    round_band,
    sha256,
    weighted_signal_stats,
)
from model_v2 import load_checkpoint


ARMS = ("control-uniform", "late-reweighted", "p30-credit025")
REPLICATES = ("a", "b", "c")


def tree_commitment(path: Path) -> dict[str, int | str]:
    digest = hashlib.sha256()
    files = 0
    total_bytes = 0
    for file in sorted(item for item in path.rglob("*") if item.is_file()):
        relative = file.relative_to(path).as_posix().encode()
        file_digest = sha256(file).encode()
        size = file.stat().st_size
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(size.to_bytes(8, "big"))
        digest.update(file_digest)
        files += 1
        total_bytes += size
    return {"sha256": digest.hexdigest(), "files": files, "bytes": total_bytes}


def evaluate_gates(models: dict[str, dict[str, dict]], *, min_kl: float, ratio: float) -> dict:
    movement_passes: dict[str, list[str]] = {}
    for arm in ("late-reweighted", "p30-credit025"):
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
        treatment = models[replicate]["late-reweighted"]
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
    validation_lock = json.loads(args.validation_lock.read_text())
    if validation_lock.get("schemaVersion") != "arc-v35-validation-lock-v1":
        raise ValueError("wrong validation-lock schema")
    if str(validation) != validation_lock["path"]:
        raise ValueError("validation path differs from frozen lock")
    actual_validation_commitment = tree_commitment(validation)
    if actual_validation_commitment != validation_lock["treeCommitment"]:
        raise ValueError("validation tree commitment mismatch")
    for entry in (validation_lock["v32CriticAudit"], validation_lock["v32ValidationReplayAudit"]):
        if sha256(Path(entry["path"])) != entry["sha256"]:
            raise ValueError(f"validation provenance mismatch for {entry['path']}")
    protocol_path = experiment / "phase1-protocol.json"
    protocol = json.loads(protocol_path.read_text())
    if protocol.get("schemaVersion") != "arc-v35-phase1-protocol-v1":
        raise ValueError("wrong V35 protocol schema")
    if args.generation not in (
        int(protocol["endpoints"]["initialEndpointGeneration"]),
        int(protocol["endpoints"]["outcomeBlindExtensionGeneration"]),
    ):
        raise ValueError("generation is not a registered V35 endpoint")
    base_path = Path(protocol["initialPolicy"]["path"]).resolve()
    if sha256(base_path) != protocol["initialPolicy"]["sha256"]:
        raise ValueError("base checkpoint hash mismatch")
    rows, probe = load_probe(validation, args.rows_per_game_band)
    device = torch.device(args.device)
    base = load_checkpoint(base_path, device).eval()
    checkpoints: dict[str, dict[str, tuple[Path, Any]]] = {}
    for replicate in REPLICATES:
        checkpoints[replicate] = {}
        for arm in ARMS:
            root = experiment / "league" / f"rep-{replicate}" / arm
            path = root / "checkpoints" / f"main-0-gen{args.generation}.pt"
            audit_path = root / "artifacts" / f"gen{args.generation}-audit.json"
            if not path.exists() or not audit_path.exists():
                raise FileNotFoundError(path if not path.exists() else audit_path)
            generation_audit = json.loads(audit_path.read_text())
            if generation_audit.get("valid") is not True or generation_audit.get("checkpointSha256") != sha256(path):
                raise ValueError(f"endpoint audit/checkpoint mismatch for {replicate}/{arm}")
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
                    endpoint_logp = torch.log_softmax(
                        model(obs, cands, mask)[0] / args.temperature, dim=-1
                    )
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
            result_models[replicate][arm] = {
                "path": raw["path"],
                "sha256": raw["sha256"],
                "kl": {
                    "overall": mean_equal_game(raw["allKlRows"]),
                    **{band: mean_equal_game(raw["klRows"][band]) for band in BANDS},
                },
                "reach30Signal": weighted_signal_stats(
                    raw["signalRows"], np.asarray(raw["signalDeltas"])
                ),
            }
    gates = evaluate_gates(result_models, min_kl=args.min_mean_kl, ratio=args.late_early_ratio)
    return {
        "schemaVersion": "arc-v35-manipulation-audit-v1",
        "valid": True,
        "generation": args.generation,
        "performanceOutcomesInspected": False,
        "protocol": str(protocol_path),
        "protocolSha256": sha256(protocol_path),
        "endpointRule": "generation 8 unless movement fails, then all nine roots continue unchanged to generation 12",
        "base": {"path": str(base_path), "sha256": sha256(base_path)},
        "validation": str(validation),
        "validationLock": str(args.validation_lock),
        "validationCommitment": actual_validation_commitment,
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
        "promotionEligible": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--experiment", type=Path, required=True)
    parser.add_argument("--validation", type=Path, required=True)
    parser.add_argument(
        "--validation-lock",
        type=Path,
        default=Path("ml/experiments/v35-weco-recursive-autoresearch/artifacts/phase1-validation-lock.json"),
    )
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
    print(
        json.dumps(
            {
                "generation": result["generation"],
                "manipulation": result["manipulation"],
                "disposition": result["disposition"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
