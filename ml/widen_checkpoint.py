#!/usr/bin/env python3
"""Function-preserving Net2Wider surgery for arc-cand-scorer-v1 checkpoints.

Duplicate hidden ReLU units and divide their outgoing weights among the duplicates,
so every policy/value/auxiliary output is numerically identical before fine-tuning.
This lets a trained 128x128 policy continue as 256x256 rather than restarting.

Usage:
  python ml/widen_checkpoint.py --in checkpoint.json --out checkpoint-wide.json \
      --hidden 256,256 --value-hidden 128
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

import numpy as np

CANDIDATE_HEADS = ("trunk", "reward_pick")
OBS_HEADS = ("value", "farm_value", "route_mode", "placement")


def parse_widths(raw: str) -> tuple[int, ...]:
    widths = tuple(int(part) for part in raw.split(",") if part.strip())
    if not widths or any(width <= 0 for width in widths):
        raise argparse.ArgumentTypeError("widths must be positive comma-separated integers")
    return widths


def hidden_widths(layers: list[dict]) -> tuple[int, ...]:
    return tuple(len(layer["W"]) for layer in layers[:-1])


def widen_mlp(
    layers: list[dict],
    target_widths: tuple[int, ...],
    *,
    symmetry_epsilon: float = 0.0,
    seed: int = 0,
) -> list[dict]:
    if len(layers) != len(target_widths) + 1:
        raise ValueError(
            f"target has {len(target_widths)} hidden layers but checkpoint MLP has {len(layers) - 1}"
        )
    if symmetry_epsilon < 0:
        raise ValueError("symmetry_epsilon must be non-negative")
    out = copy.deepcopy(layers)
    rng = np.random.default_rng(seed)
    for index, target in enumerate(target_widths):
        layer = out[index]
        next_layer = out[index + 1]
        W = np.asarray(layer["W"], dtype=np.float64)
        b = np.asarray(layer["b"], dtype=np.float64)
        next_W = np.asarray(next_layer["W"], dtype=np.float64)
        old_width = W.shape[0]
        if target < old_width:
            raise ValueError(f"cannot narrow hidden layer {index}: {old_width} -> {target}")
        if next_W.shape[1] != old_width:
            raise ValueError(
                f"layer {index + 1} input {next_W.shape[1]} does not match hidden width {old_width}"
            )
        if target == old_width:
            continue

        # First old_width units retain their index; extras duplicate old units in
        # deterministic round-robin order. Dividing every duplicate's outgoing
        # column by its multiplicity preserves the next pre-activation exactly.
        source = np.concatenate(
            [np.arange(old_width), np.arange(target - old_width) % old_width]
        )
        multiplicity = np.bincount(source, minlength=old_width)
        widened_W = W[source, :]
        widened_b = b[source]
        widened_next_W = next_W[:, source] / multiplicity[source][None, :]

        # Equal duplicates receive identical gradients forever in a deterministic
        # ReLU MLP. Break that symmetry in the outgoing columns while keeping the
        # columns for each source unit zero-sum around their Net2Wider value. The
        # represented function therefore stays unchanged, but the duplicate units
        # receive different upstream gradients on the first optimizer step.
        if symmetry_epsilon > 0:
            for old_index in range(old_width):
                positions = np.flatnonzero(source == old_index)
                if len(positions) < 2:
                    continue
                scale = np.maximum(np.abs(next_W[:, old_index]), 1e-3)
                offsets = rng.standard_normal((next_W.shape[0], len(positions)))
                offsets -= offsets.mean(axis=1, keepdims=True)
                max_abs = np.max(np.abs(offsets), axis=1, keepdims=True)
                offsets /= np.maximum(max_abs, 1.0)
                offsets *= symmetry_epsilon * scale[:, None]
                # Force the last offset to be the negative sum of the preceding
                # offsets, minimizing accumulated floating-point parity error.
                offsets[:, -1] = -offsets[:, :-1].sum(axis=1)
                widened_next_W[:, positions] += offsets

        layer["W"] = widened_W.tolist()
        layer["b"] = widened_b.tolist()
        next_layer["W"] = widened_next_W.tolist()
    return out


def widen_checkpoint(
    checkpoint: dict,
    trunk_widths: tuple[int, ...],
    value_widths: tuple[int, ...],
    *,
    symmetry_epsilon: float = 0.0,
    seed: int = 0,
) -> dict:
    if checkpoint.get("format") != "arc-cand-scorer-v1":
        raise ValueError(f"unsupported checkpoint format {checkpoint.get('format')!r}")
    out = copy.deepcopy(checkpoint)
    for head_index, head in enumerate(CANDIDATE_HEADS):
        layers = out.get(head)
        if isinstance(layers, list) and layers:
            out[head] = widen_mlp(
                layers,
                trunk_widths,
                symmetry_epsilon=symmetry_epsilon,
                seed=seed + head_index * 1009,
            )
    for head_index, head in enumerate(OBS_HEADS):
        layers = out.get(head)
        if isinstance(layers, list) and layers:
            out[head] = widen_mlp(
                layers,
                value_widths,
                symmetry_epsilon=symmetry_epsilon,
                seed=seed + 100_000 + head_index * 1009,
            )
    out["trunk_hidden"] = list(trunk_widths)
    out["value_hidden"] = list(value_widths)
    out["net2wider"] = {
        "symmetry_epsilon": symmetry_epsilon,
        "seed": seed,
        "function_preserving": True,
    }
    out["params"] = parameter_count(out)
    return out


def mlp(x: np.ndarray, layers: list[dict]) -> np.ndarray:
    h = x
    for index, layer in enumerate(layers):
        h = np.asarray(layer["W"], dtype=np.float64) @ h + np.asarray(
            layer["b"], dtype=np.float64
        )
        if index < len(layers) - 1:
            h = np.maximum(h, 0.0)
    return h


def verify_parity(old: dict, new: dict, samples: int = 32, seed: int = 0) -> float:
    rng = np.random.default_rng(seed)
    obs_dim = int(old["obs_dim"])
    act_dim = int(old["act_dim"])
    max_abs = 0.0
    for _ in range(samples):
        obs = rng.standard_normal(obs_dim)
        action = rng.standard_normal(act_dim)
        candidate = np.concatenate([obs, action])
        for head in CANDIDATE_HEADS:
            if isinstance(old.get(head), list) and isinstance(new.get(head), list):
                max_abs = max(
                    max_abs,
                    float(np.max(np.abs(mlp(candidate, old[head]) - mlp(candidate, new[head])))),
                )
        for head in OBS_HEADS:
            if isinstance(old.get(head), list) and isinstance(new.get(head), list):
                max_abs = max(
                    max_abs,
                    float(np.max(np.abs(mlp(obs, old[head]) - mlp(obs, new[head])))),
                )
    if max_abs > 1e-9:
        raise AssertionError(f"Net2Wider parity failed: max |delta|={max_abs:.3e}")
    return max_abs


def parameter_count(checkpoint: dict) -> int:
    total = 0
    for head in (*CANDIDATE_HEADS, *OBS_HEADS):
        for layer in checkpoint.get(head) or []:
            W = layer["W"]
            total += len(W) * len(W[0]) + len(layer["b"])
    return total


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--in", dest="input", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--hidden", type=parse_widths, required=True)
    parser.add_argument("--value-hidden", type=parse_widths, required=True)
    parser.add_argument(
        "--symmetry-epsilon",
        type=float,
        default=1e-3,
        help="zero-sum outgoing-weight asymmetry for duplicated units (default: 1e-3)",
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--no-verify", action="store_true")
    args = parser.parse_args()

    with args.input.open() as handle:
        old = json.load(handle)
    widened = widen_checkpoint(
        old,
        args.hidden,
        args.value_hidden,
        symmetry_epsilon=args.symmetry_epsilon,
        seed=args.seed,
    )
    max_abs = 0.0 if args.no_verify else verify_parity(old, widened)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as handle:
        json.dump(widened, handle)
    print(
        f"widened trunk {hidden_widths(old['trunk'])} -> {args.hidden}, "
        f"value {hidden_widths(old['value'])} -> {args.value_hidden}; "
        f"params {parameter_count(old):,} -> {parameter_count(widened):,}; "
        f"parity max |delta|={max_abs:.3e}; wrote {args.out}"
    )


if __name__ == "__main__":
    main()
