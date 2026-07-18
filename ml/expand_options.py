#!/usr/bin/env python3
"""Expand a legacy v1 checkpoint into the V23 four-option architecture.

All option-conditioned low-level columns are appended as exact zeros.  The
high-level option head reuses the old value representation but has zero final
logits, while option_value is an independent clone of the old value head.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

import numpy as np

LOW_LEVEL_HEADS = (
    "trunk",
    "value",
    "farm_value",
    "route_mode",
    "reach30",
    "reward_pick",
    "placement",
)


def _append_zero_cols(layer: dict, count: int) -> None:
    layer["W"] = [list(row) + [0.0] * count for row in layer["W"]]


def _parameter_count(checkpoint: dict) -> int:
    total = 0
    for name in (*LOW_LEVEL_HEADS, "option", "option_value"):
        for layer in checkpoint.get(name, []):
            W, b = layer["W"], layer["b"]
            total += len(W) * len(W[0]) + len(b)
    return total


def expand_options(checkpoint: dict, option_dim: int = 4) -> dict:
    if option_dim != 4:
        raise ValueError("V23 checkpoint contract requires option_dim=4")
    raw_existing = checkpoint.get("option_dim", 0)
    if isinstance(raw_existing, bool) or not isinstance(raw_existing, (int, float)):
        raise ValueError("source checkpoint has malformed option_dim")
    if int(raw_existing) != 0 or "option" in checkpoint or "option_value" in checkpoint:
        raise ValueError("source checkpoint is already option-enabled or malformed")
    if checkpoint.get("format") != "arc-cand-scorer-v1":
        raise ValueError("source must be an arc-cand-scorer-v1 checkpoint")
    obs_dim = int(checkpoint["obs_dim"])
    value = checkpoint.get("value")
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError("V23 option head requires a one-hidden-layer value head")
    hidden = len(value[0]["W"])
    if hidden < 1 or len(value[0]["W"][0]) != obs_dim:
        raise ValueError("V23 option head requires a positive one-hidden-layer value architecture")
    if len(value[1]["W"]) != 1 or len(value[1]["W"][0]) != hidden:
        raise ValueError("V23 option head requires value architecture obs -> H -> 1")

    out = copy.deepcopy(checkpoint)
    for name in LOW_LEVEL_HEADS:
        layers = out.get(name)
        if layers is None:
            continue
        if not isinstance(layers, list) or not layers:
            raise ValueError(f"malformed {name} head")
        _append_zero_cols(layers[0], option_dim)

    # Independent parameter copies: the numeric warm start may match, but the
    # exported networks never share tensors/objects.
    option_first = copy.deepcopy(checkpoint["value"][0])
    option_final = {
        "W": [[0.0] * hidden for _ in range(option_dim)],
        "b": [0.0] * option_dim,
    }
    out["option_dim"] = option_dim
    out["option"] = [option_first, option_final]
    out["option_value"] = copy.deepcopy(checkpoint["value"])
    out.setdefault("aux_heads", {})["option"] = "obs -> persistent round-option logits"
    out["aux_heads"]["option_value"] = "obs -> SMDP round-start value"
    out["params"] = _parameter_count(out)
    return out


def _mlp(x: np.ndarray, layers: list[dict]) -> np.ndarray:
    value = x
    for index, layer in enumerate(layers):
        value = np.asarray(layer["W"], dtype=np.float64) @ value + np.asarray(
            layer["b"], dtype=np.float64
        )
        if index + 1 < len(layers):
            value = np.maximum(value, 0.0)
    return value


def verify_parity(old: dict, new: dict, samples: int = 16, seed: int = 0) -> None:
    option_dim = int(new["option_dim"])
    rng = np.random.default_rng(seed)
    max_abs = 0.0
    for _ in range(samples):
        obs = rng.standard_normal(int(old["obs_dim"]))
        cand = rng.standard_normal(int(old["act_dim"]))
        option = np.zeros(option_dim, dtype=np.float64)
        for name in LOW_LEVEL_HEADS:
            if name not in old or name not in new:
                continue
            old_width = len(old[name][0]["W"][0])
            old_input = obs if old_width == len(obs) else np.concatenate([obs, cand])
            new_input = np.concatenate([old_input, option])
            delta = np.max(np.abs(_mlp(old_input, old[name]) - _mlp(new_input, new[name])))
            max_abs = max(max_abs, float(delta))
        if not np.array_equal(_mlp(obs, new["option"]), np.zeros(option_dim)):
            raise AssertionError("expanded option head is not exactly uniform-logit initialized")
        max_abs = max(
            max_abs,
            float(np.max(np.abs(_mlp(obs, old["value"]) - _mlp(obs, new["option_value"])))),
        )
    for name in LOW_LEVEL_HEADS:
        if name in new:
            tail = np.asarray(new[name][0]["W"], dtype=np.float64)[:, -option_dim:]
            if np.count_nonzero(tail):
                raise AssertionError(f"{name} option columns are not exact zeros")
    if max_abs > 1e-9:
        raise AssertionError(f"option expansion parity failed: max |delta|={max_abs:.3e}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--in", dest="input", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--no-verify", action="store_true")
    args = parser.parse_args()
    checkpoint = json.loads(args.input.read_text())
    expanded = expand_options(checkpoint)
    if not args.no_verify:
        verify_parity(checkpoint, expanded)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(expanded))
    print(f"expanded option_dim 0 -> 4 with exact low-level parity; wrote {args.out}")


if __name__ == "__main__":
    main()
