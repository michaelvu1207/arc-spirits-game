#!/usr/bin/env python3
"""Validate V32's policy-identical reach-30 critic warm-up on held-out games."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import torch

from model_v2 import load_checkpoint
from ppo import behavior_reach30_metrics, load_trajectory_buffer, parse_placement_rewards


CRITIC_PREFIXES = ("value_head.", "reach30_head.")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def audit_games(data: Path, seed0: int, games: int) -> dict[str, int]:
    expected = set(range(seed0, seed0 + games))
    seen: set[int] = set()
    stalls = 0
    summaries = sorted(data.rglob("games-*.jsonl"))
    if not summaries:
        raise ValueError(f"no game summaries found below {data}")
    for summary_path in summaries:
        with summary_path.open() as handle:
            for line_number, line in enumerate(handle, 1):
                row = json.loads(line)
                seed = int(row["seed"])
                if seed in seen:
                    raise ValueError(f"{summary_path}:{line_number}: duplicate seed {seed}")
                seen.add(seed)
                stalls += int(bool(row.get("stalled")))
    if seen != expected:
        raise ValueError(
            f"validation seed mismatch: missing={sorted(expected-seen)[:10]} "
            f"extra={sorted(seen-expected)[:10]}"
        )
    if stalls:
        raise ValueError(f"validation contains {stalls} stalled games")
    return {"count": len(seen), "min": min(seen), "max": max(seen), "stalls": stalls}


def policy_parameter_audit(base, critic) -> tuple[int, list[str]]:
    base_state = base.state_dict()
    critic_state = critic.state_dict()
    mismatches: list[str] = []
    compared = 0
    for name, base_value in base_state.items():
        if name.startswith(CRITIC_PREFIXES):
            continue
        compared += 1
        critic_value = critic_state.get(name)
        if critic_value is None or not torch.equal(base_value.cpu(), critic_value.cpu()):
            mismatches.append(name)
    extra_noncritic = sorted(
        name
        for name in critic_state.keys() - base_state.keys()
        if not name.startswith(CRITIC_PREFIXES)
    )
    mismatches.extend(extra_noncritic)
    if mismatches:
        raise ValueError(f"critic warm-up changed policy parameters: {mismatches[:10]}")
    return compared, mismatches


def policy_logit_audit(base, critic, data: Path, device: torch.device, limit: int) -> dict:
    rows: list[dict] = []
    for shard in sorted(data.rglob("shard-*.jsonl")):
        with shard.open() as handle:
            for line in handle:
                row = json.loads(line)
                if int(row.get("policyMask", 0)) != 1:
                    continue
                rows.append(row)
                if len(rows) >= limit:
                    break
        if len(rows) >= limit:
            break
    if not rows:
        raise ValueError("no policy rows available for policy-logit audit")
    base.to(device).eval()
    critic.to(device).eval()
    max_error = 0.0
    batch_size = 256
    with torch.no_grad():
        for start in range(0, len(rows), batch_size):
            batch = rows[start : start + batch_size]
            max_cands = max(len(row["cands"]) for row in batch)
            act_dim = len(batch[0]["cands"][0])
            obs = np.asarray([row["obsV2"] for row in batch], dtype=np.float32)
            cands = np.zeros((len(batch), max_cands, act_dim), dtype=np.float32)
            mask = np.zeros((len(batch), max_cands), dtype=bool)
            for index, row in enumerate(batch):
                values = np.asarray(row["cands"], dtype=np.float32)
                cands[index, : len(values)] = values
                mask[index, : len(values)] = True
            tensors = (
                torch.from_numpy(obs).to(device),
                torch.from_numpy(cands).to(device),
                torch.from_numpy(mask).to(device),
            )
            base_logits = base(*tensors)[0]
            critic_logits = critic(*tensors)[0]
            finite = tensors[2]
            max_error = max(
                max_error,
                float((base_logits[finite] - critic_logits[finite]).abs().max().item()),
            )
    return {"rows": len(rows), "maxAbsDiff": max_error}


def audit(args: argparse.Namespace) -> dict:
    base_path = args.base.resolve()
    critic_path = args.critic.resolve()
    validation = args.validation.resolve()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    base = load_checkpoint(base_path, torch.device("cpu"))
    critic = load_checkpoint(critic_path, torch.device("cpu"))
    compared, _ = policy_parameter_audit(base, critic)
    if not critic.reach30_trained or critic.reach30_horizon != 30:
        raise ValueError(
            f"critic is not actor-ready: trained={critic.reach30_trained} "
            f"horizon={critic.reach30_horizon}"
        )
    if tuple(critic.reach30_horizons) != (20, 25, 30):
        raise ValueError(f"unexpected reach30 horizons {critic.reach30_horizons}")
    game_audit = audit_games(validation, args.seed0, args.games)
    buffer = load_trajectory_buffer(
        validation,
        gamma=0.999,
        gae_lambda=0.95,
        placement_rewards=parse_placement_rewards("1.0,0.3,-0.3,-1.0"),
        obs_key="obsV2",
    )
    calibration = behavior_reach30_metrics(buffer)
    if not all(math.isfinite(value) for value in calibration.values()):
        raise ValueError(f"non-finite behavior calibration: {calibration}")
    if calibration["auc"] < args.auc_min:
        raise ValueError(f"round-30 AUC {calibration['auc']:.6f} below {args.auc_min:.6f}")
    if calibration["ece"] > args.ece_max:
        raise ValueError(f"round-30 ECE {calibration['ece']:.6f} above {args.ece_max:.6f}")
    if calibration["brier"] > calibration["constant_brier"]:
        raise ValueError(f"critic Brier score is worse than constant: {calibration}")
    logit = policy_logit_audit(base, critic, validation, device, args.logit_rows)
    if logit["maxAbsDiff"] > args.logit_max_abs_diff:
        raise ValueError(f"policy logit mismatch: {logit}")
    for name, tensor in critic.state_dict().items():
        if not bool(torch.isfinite(tensor).all()):
            raise ValueError(f"non-finite critic tensor {name}")
    return {
        "schemaVersion": "arc-v32-critic-audit-v1",
        "valid": True,
        "base": {"path": str(base_path), "sha256": sha256(base_path)},
        "critic": {"path": str(critic_path), "sha256": sha256(critic_path)},
        "validation": game_audit,
        "policyParametersComparedExact": compared,
        "policyLogits": logit,
        "behaviorReach30Calibration": calibration,
        "reach30Horizons": list(critic.reach30_horizons),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--critic", type=Path, required=True)
    parser.add_argument("--validation", type=Path, required=True)
    parser.add_argument("--seed0", type=int, required=True)
    parser.add_argument("--games", type=int, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--auc-min", type=float, default=0.70)
    parser.add_argument("--ece-max", type=float, default=0.10)
    parser.add_argument("--logit-max-abs-diff", type=float, default=1e-6)
    parser.add_argument("--logit-rows", type=int, default=8192)
    args = parser.parse_args()
    result = audit(args)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.out.with_suffix(args.out.suffix + ".tmp")
    temporary.write_text(json.dumps(result, indent=2) + "\n")
    temporary.replace(args.out)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
