#!/usr/bin/env python3
"""Fail-closed post-generation audit for the V32 on-policy league screen."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path

import numpy as np
import torch

from model_v2 import load_checkpoint
from ppo import behavior_log_probs


PPO_LINE = re.compile(
    r"^PPO epoch (?P<epoch>\d+)/(?:\d+).*?approx_kl=(?P<kl>[0-9.eE+-]+) \| "
    r"clip_frac=(?P<clip>[0-9.eE+-]+) \| "
    r"round_weighted_kl=(?P<weighted_kl>[0-9.eE+-]+) \| "
    r"round_weighted_clip_frac=(?P<weighted_clip>[0-9.eE+-]+).*?"
    r"optimizer_steps=(?P<steps>\d+)$"
)
CALIBRATION_LINE = re.compile(r"^Behavior reach30 calibration \| (?P<body>.*)$")
CREDIT_LINE = re.compile(
    r"solo outcome coef=(?P<outcome>[0-9.eE+-]+), "
    r"reach30 coef=(?P<reach>[0-9.eE+-]+), reach30 horizon=(?P<horizon>[^,]+), .*?"
    r"applied=(?P<outcome_applied>\d+)/(?P<reach_applied>\d+);"
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_key_values(body: str) -> dict[str, float]:
    result: dict[str, float] = {}
    for item in body.split():
        key, value = item.split("=", 1)
        result[key] = float(value)
    return result


def flush_logp_batch(model, device, rows: list[dict]) -> float:
    if not rows:
        return 0.0
    max_cands = max(len(row["cands"]) for row in rows)
    act_dim = len(rows[0]["cands"][0])
    obs = np.asarray([row["obsV2"] for row in rows], dtype=np.float32)
    cands = np.zeros((len(rows), max_cands, act_dim), dtype=np.float32)
    mask = np.zeros((len(rows), max_cands), dtype=bool)
    chosen = np.zeros(len(rows), dtype=np.int64)
    temperature = np.zeros(len(rows), dtype=np.float32)
    old = np.zeros(len(rows), dtype=np.float32)
    for index, row in enumerate(rows):
        candidate_rows = np.asarray(row["cands"], dtype=np.float32)
        support = np.asarray(row["behaviorMask"], dtype=bool)
        cands[index, : len(candidate_rows)] = candidate_rows
        mask[index, : len(candidate_rows)] = support
        chosen[index] = int(row["chosen"])
        temperature[index] = float(row["behaviorTemperature"])
        old[index] = float(row["logpOld"])
    with torch.no_grad():
        logits, _, _ = model(
            torch.from_numpy(obs).to(device),
            torch.from_numpy(cands).to(device),
            torch.from_numpy(mask).to(device),
        )
        reconstructed = behavior_log_probs(
            logits,
            torch.from_numpy(mask).to(device),
            torch.from_numpy(temperature).to(device),
        ).gather(1, torch.from_numpy(chosen).to(device)[:, None]).squeeze(1)
    return float(np.max(np.abs(reconstructed.cpu().numpy() - old)))


def audit(args: argparse.Namespace) -> dict:
    root = args.root.resolve()
    config = json.loads((root / "config.json").read_text())
    schedule = config["seedSchedule"]
    if args.gen < 1 or args.gen > int(schedule["maxGeneration"]):
        raise ValueError("generation is outside the frozen seed schedule")
    lane = root / "data" / f"gen{args.gen}" / "main-0"
    train_log_path = lane / "train.log"
    checkpoint = root / "checkpoints" / f"main-0-gen{args.gen}.pt"
    manifest = checkpoint.with_suffix(".manifest.json")
    for required in (lane / "meta.json", train_log_path, checkpoint, manifest):
        if not required.exists():
            raise FileNotFoundError(required)

    expected_seed0 = int(schedule["trainBase"]) + (args.gen - 1) * int(schedule["trainStride"])
    expected_seeds = set(range(expected_seed0, expected_seed0 + int(config["gamesPerGen"])))
    seen_seeds: set[int] = set()
    stalls = 0
    for summary_path in sorted(lane.glob("m-*/games-*.jsonl")):
        with summary_path.open() as handle:
            for line in handle:
                summary = json.loads(line)
                seed = int(summary["seed"])
                if seed in seen_seeds:
                    raise ValueError(f"duplicate game seed {seed}")
                seen_seeds.add(seed)
                stalls += int(bool(summary.get("stalled")))
    if seen_seeds != expected_seeds:
        missing = sorted(expected_seeds - seen_seeds)[:10]
        extra = sorted(seen_seeds - expected_seeds)[:10]
        raise ValueError(f"training seed mismatch; missing={missing} extra={extra}")
    if stalls:
        raise ValueError(f"generation contains {stalls} stalled games")

    expected_eval_seed0 = int(schedule["evalBase"]) + (args.gen - 1) * int(schedule["evalStride"])
    expected_eval_seeds = set(range(expected_eval_seed0, expected_eval_seed0 + int(config["evalGames"])))
    seen_eval_seeds: set[int] = set()
    eval_stalls = 0
    eval_lane = root / "data" / f"gen{args.gen}" / "main-0_eval"
    for summary_path in sorted(eval_lane.glob("games-*.jsonl")):
        with summary_path.open() as handle:
            for line in handle:
                summary = json.loads(line)
                seed = int(summary["seed"])
                if seed in seen_eval_seeds:
                    raise ValueError(f"duplicate evaluation seed {seed}")
                seen_eval_seeds.add(seed)
                eval_stalls += int(bool(summary.get("stalled")))
    if seen_eval_seeds != expected_eval_seeds:
        raise ValueError(
            f"evaluation seed mismatch; missing={sorted(expected_eval_seeds-seen_eval_seeds)[:10]} "
            f"extra={sorted(seen_eval_seeds-expected_eval_seeds)[:10]}"
        )
    if eval_stalls:
        raise ValueError(f"evaluation contains {eval_stalls} stalled games")

    behavior_checkpoint = (
        Path(config["laneInit"]["main-0"])
        if args.gen == 1
        else root / "checkpoints" / f"main-0-gen{args.gen - 1}.pt"
    )
    if not behavior_checkpoint.is_absolute():
        behavior_checkpoint = (Path.cwd() / behavior_checkpoint).resolve()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    behavior_model = load_checkpoint(behavior_checkpoint, device)
    behavior_model.eval()
    policy_rows = 0
    total_rows = 0
    round_counts = {"1-8": 0, "9-18": 0, "19-30": 0}
    policy_round_counts = {"1-8": 0, "9-18": 0, "19-30": 0}
    max_logp_error = 0.0
    batch: list[dict] = []
    for shard in sorted(lane.glob("m-*/shard-*.jsonl")):
        with shard.open() as handle:
            for line_number, line in enumerate(handle, 1):
                row = json.loads(line)
                total_rows += 1
                if "round" not in row or not isinstance(row["round"], int) or row["round"] < 1:
                    raise ValueError(f"{shard}:{line_number}: missing/invalid public round")
                round_index = int(row["round"])
                band = "1-8" if round_index <= 8 else "9-18" if round_index <= 18 else "19-30"
                round_counts[band] += 1
                if len(row.get("obsV2", [])) != int(behavior_model.spec.flat_length):
                    raise ValueError(f"{shard}:{line_number}: invalid obsV2 length")
                if int(row.get("policyMask", 0)) != 1:
                    continue
                policy_rows += 1
                policy_round_counts[band] += 1
                temperature = float(row.get("behaviorTemperature", float("nan")))
                if not math.isfinite(temperature) or abs(temperature - 0.55) > 1e-7:
                    raise ValueError(f"{shard}:{line_number}: behavior temperature is not 0.55")
                support = row.get("behaviorMask")
                chosen = int(row["chosen"])
                if not isinstance(support, list) or chosen >= len(support) or support[chosen] != 1:
                    raise ValueError(f"{shard}:{line_number}: chosen action outside behavior support")
                batch.append(row)
                if len(batch) >= args.batch_size:
                    max_logp_error = max(max_logp_error, flush_logp_batch(behavior_model, device, batch))
                    batch.clear()
    max_logp_error = max(max_logp_error, flush_logp_batch(behavior_model, device, batch))
    if max_logp_error > args.max_logp_error:
        raise ValueError(
            f"behavior chosen-logp reconstruction error {max_logp_error} exceeds {args.max_logp_error}"
        )
    if total_rows < int(config["train"]["ppoRowsPerEpoch"]):
        raise ValueError("rollout has fewer rows than the fixed PPO budget")

    log = train_log_path.read_text()
    if "malformed episode(s) rejected" not in log or "0 malformed episode(s) rejected" not in log:
        raise ValueError("trainer did not report zero malformed episodes")
    if "0 malformed row(s)" not in log:
        raise ValueError("trainer did not report zero malformed rows")
    epoch_metrics = []
    calibration = None
    credit = None
    for line in log.splitlines():
        match = PPO_LINE.match(line)
        if match:
            metric = {
                "epoch": int(match.group("epoch")),
                "approxKl": float(match.group("kl")),
                "clipFraction": float(match.group("clip")),
                "roundWeightedKl": float(match.group("weighted_kl")),
                "roundWeightedClipFraction": float(match.group("weighted_clip")),
                "optimizerSteps": int(match.group("steps")),
            }
            epoch_metrics.append(metric)
        calibration_match = CALIBRATION_LINE.match(line)
        if calibration_match:
            calibration = parse_key_values(calibration_match.group("body"))
        credit_match = CREDIT_LINE.search(line)
        if credit_match:
            credit = {
                "soloOutcomeCoef": float(credit_match.group("outcome")),
                "soloReach30Coef": float(credit_match.group("reach")),
                "reach30Horizon": credit_match.group("horizon"),
                "soloOutcomeApplied": int(credit_match.group("outcome_applied")),
                "soloReach30Applied": int(credit_match.group("reach_applied")),
            }
    if len(epoch_metrics) != int(config["train"]["epochs"]):
        raise ValueError(f"expected {config['train']['epochs']} PPO epoch metrics, got {len(epoch_metrics)}")
    for metric in epoch_metrics:
        if metric["optimizerSteps"] != args.optimizer_steps:
            raise ValueError(f"optimizer-step mismatch: {metric}")
        if metric["approxKl"] > args.max_approx_kl:
            raise ValueError(f"approximate KL gate failed: {metric}")
        if metric["clipFraction"] > args.max_clip_fraction:
            raise ValueError(f"clip-fraction gate failed: {metric}")
        if metric["roundWeightedKl"] > args.max_approx_kl:
            raise ValueError(f"round-weighted approximate KL gate failed: {metric}")
        if metric["roundWeightedClipFraction"] > args.max_clip_fraction:
            raise ValueError(f"round-weighted clip-fraction gate failed: {metric}")
    if calibration is None or calibration.get("ece", float("inf")) > args.max_ece:
        raise ValueError(f"behavior calibration gate failed: {calibration}")
    extra_args = config["train"].get("extraArgs", [])
    try:
        reach_at = len(extra_args) - 1 - list(reversed(extra_args)).index("--solo-reach30-coef")
        configured_reach = float(extra_args[reach_at + 1])
    except (ValueError, IndexError) as exc:
        raise ValueError("missing configured --solo-reach30-coef") from exc
    if credit is None or abs(credit["soloReach30Coef"] - configured_reach) > 1e-12:
        raise ValueError(f"solo reach30 credit telemetry mismatch: {credit}")
    if credit["reach30Horizon"] != "30":
        raise ValueError(f"unexpected reach30 credit horizon: {credit}")
    if configured_reach > 0 and credit["soloReach30Applied"] <= 0:
        raise ValueError(f"reach30 treatment had no applied strategic rows: {credit}")
    if configured_reach == 0 and credit["soloReach30Applied"] != 0:
        raise ValueError(f"reach30 control unexpectedly applied credit: {credit}")

    bands = None
    if "--ppo-round-policy-bands" in extra_args:
        at = len(extra_args) - 1 - list(reversed(extra_args)).index("--ppo-round-policy-bands")
        bands = [
            [int(upper), float(weight)]
            for upper, weight in (item.split(":", 1) for item in extra_args[at + 1].split(","))
        ]
    band_counts = [policy_round_counts[key] for key in ("1-8", "9-18", "19-30")]
    band_weights = [1.0, 1.0, 1.0] if bands is None else [entry[1] for entry in bands]
    weighted_total = sum(count * weight for count, weight in zip(band_counts, band_weights))
    effective_policy_share = {
        key: (count * weight / weighted_total if weighted_total else 0.0)
        for key, count, weight in zip(
            ("1-8", "9-18", "19-30"), band_counts, band_weights
        )
    }

    trained = load_checkpoint(checkpoint, torch.device("cpu"))
    for name, tensor in trained.state_dict().items():
        if not bool(torch.isfinite(tensor).all()):
            raise ValueError(f"non-finite checkpoint tensor {name}")
    manifest_data = json.loads(manifest.read_text())
    if manifest_data.get("format") != "arc-entity-scorer-v2":
        raise ValueError("unexpected checkpoint format")
    return {
        "schemaVersion": "arc-v32-generation-audit-v1",
        "valid": True,
        "root": str(root),
        "generation": args.gen,
        "trainingSeeds": {"min": min(seen_seeds), "max": max(seen_seeds), "count": len(seen_seeds)},
        "games": len(seen_seeds),
        "stalls": stalls,
        "evaluationSeeds": {
            "min": min(seen_eval_seeds),
            "max": max(seen_eval_seeds),
            "count": len(seen_eval_seeds),
        },
        "evaluationStalls": eval_stalls,
        "rows": total_rows,
        "policyRows": policy_rows,
        "roundCounts": round_counts,
        "policyRoundCounts": policy_round_counts,
        "behaviorCheckpoint": str(behavior_checkpoint),
        "behaviorCheckpointSha256": sha256(behavior_checkpoint),
        "behaviorLogpMaxAbsError": max_logp_error,
        "behaviorReach30Calibration": calibration,
        "soloReach30Credit": credit,
        "roundPolicyBands": bands,
        "effectivePolicyWeightShare": effective_policy_share,
        "epochMetrics": epoch_metrics,
        "checkpoint": str(checkpoint),
        "checkpointSha256": sha256(checkpoint),
        "manifestSha256": sha256(manifest),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--gen", type=int, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--max-approx-kl", type=float, default=0.02)
    parser.add_argument("--max-clip-fraction", type=float, default=0.20)
    parser.add_argument("--max-ece", type=float, default=0.10)
    parser.add_argument("--max-logp-error", type=float, default=0.001)
    parser.add_argument("--optimizer-steps", type=int, default=196)
    parser.add_argument("--batch-size", type=int, default=512)
    args = parser.parse_args()
    result = audit(args)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.out.with_suffix(args.out.suffix + ".tmp")
    temporary.write_text(json.dumps(result, indent=2) + "\n")
    temporary.replace(args.out)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
