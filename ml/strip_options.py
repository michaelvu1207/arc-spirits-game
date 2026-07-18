#!/usr/bin/env python3
"""Strip a causally inactive V23 option suffix from a v1 JSON checkpoint.

This conversion is deliberately fail-closed: every option-conditioned column in
every low-level head must be exactly zero. Only then are the option columns and
the two high-level option heads removed. The resulting option_dim=0 checkpoint
has exactly the same low-level outputs and can be passed to expand_obs_dim.py to
zero-expand V24's appended action features.
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


def _parameter_count(checkpoint: dict) -> int:
    total = 0
    for name in LOW_LEVEL_HEADS:
        for layer in checkpoint.get(name, []):
            W, b = layer["W"], layer["b"]
            total += len(W) * len(W[0]) + len(b)
    return total


def strip_options(checkpoint: dict) -> dict:
    if checkpoint.get("format") != "arc-cand-scorer-v1":
        raise ValueError("source must be an arc-cand-scorer-v1 checkpoint")
    raw_dim = checkpoint.get("option_dim")
    if (
        isinstance(raw_dim, bool)
        or not isinstance(raw_dim, (int, float))
        or not float(raw_dim).is_integer()
        or int(raw_dim) <= 0
    ):
        raise ValueError("source checkpoint must declare a positive integer option_dim")
    option_dim = int(raw_dim)
    obs_dim = int(checkpoint.get("obs_dim", 0))
    act_dim = int(checkpoint.get("act_dim", 0))
    if obs_dim <= 0 or act_dim <= 0:
        raise ValueError("source checkpoint has invalid obs_dim or act_dim")
    if not isinstance(checkpoint.get("option"), list) or not isinstance(
        checkpoint.get("option_value"), list
    ):
        raise ValueError("option-enabled source is missing option or option_value heads")

    out = copy.deepcopy(checkpoint)
    for name in LOW_LEVEL_HEADS:
        layers = out.get(name)
        if layers is None:
            continue
        if not isinstance(layers, list) or not layers or not layers[0].get("W"):
            raise ValueError(f"malformed {name} head")
        width = len(layers[0]["W"][0])
        if width <= option_dim:
            raise ValueError(f"{name}[0] is too narrow for option_dim={option_dim}")
        if width - option_dim not in (obs_dim, obs_dim + act_dim):
            raise ValueError(
                f"{name}[0] input excluding options is neither obs_dim nor obs_dim+act_dim"
            )
        for row in layers[0]["W"]:
            if len(row) != width:
                raise ValueError(f"{name}[0] has ragged rows")
            tail = row[-option_dim:]
            if any(value != 0 for value in tail):
                raise ValueError(f"{name} has nonzero option influence; refusing to strip")
            del row[-option_dim:]

    out.pop("option_dim", None)
    out.pop("option", None)
    out.pop("option_value", None)
    aux = out.get("aux_heads")
    if isinstance(aux, dict):
        aux.pop("option", None)
        aux.pop("option_value", None)
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
    option_dim = int(old["option_dim"])
    obs_dim = int(old["obs_dim"])
    act_dim = int(old["act_dim"])
    rng = np.random.default_rng(seed)
    max_abs = 0.0
    for _ in range(samples):
        obs = rng.standard_normal(obs_dim)
        cand = rng.standard_normal(act_dim)
        option = rng.standard_normal(option_dim)
        for name in LOW_LEVEL_HEADS:
            if name not in old or name not in new:
                continue
            new_width = len(new[name][0]["W"][0])
            base = obs if new_width == obs_dim else np.concatenate([obs, cand])
            old_input = np.concatenate([base, option])
            delta = np.max(np.abs(_mlp(old_input, old[name]) - _mlp(base, new[name])))
            max_abs = max(max_abs, float(delta))
    if max_abs > 1e-9:
        raise AssertionError(f"option-strip parity failed: max |delta|={max_abs:.3e}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--in", dest="input", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--no-verify", action="store_true")
    args = parser.parse_args()
    checkpoint = json.loads(args.input.read_text())
    stripped = strip_options(checkpoint)
    if not args.no_verify:
        verify_parity(checkpoint, stripped)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(stripped))
    print(
        f"stripped option_dim {checkpoint['option_dim']} -> 0 with exact low-level parity; "
        f"wrote {args.out}"
    )


if __name__ == "__main__":
    main()
