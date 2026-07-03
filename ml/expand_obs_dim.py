#!/usr/bin/env python3
"""Dims-preserving warm-start surgery: expand an arc-cand-scorer-v1 JSON checkpoint
from OLD obs_dim to NEW obs_dim by inserting ZERO input columns for the appended
observation features.

obs v1.2 appends features at the END of the obs vector (encode.ts OBS_DIM 77 -> 83).
In every head's FIRST Linear the obs block is the leading `obs_dim` input columns
(trunk/reward_pick then concatenate the `act_dim` action columns after it; value/
farm_value/route_mode/placement are obs-only). So the insertion index is ALWAYS the
OLD obs_dim, for every head. New columns are zero => the net's outputs are byte-identical
to the original on any obs whose new features are appended after the old ones. That is a
TRUE warm start: gen-1 eval should be as strong as the source champion immediately.

Only the first Linear of each head changes (its input width); deeper layers are untouched.
`obs_dim` in the meta is bumped to NEW. Run with --verify (default) to prove logit/value
parity via an independent numpy forward pass before writing.

Usage:
  python ml/expand_obs_dim.py --in ml/champions/ladder3/main-0-gen60.json \
      --out ml/warmstart/ladder4-main0-obs83.json --new-obs-dim 83
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

import numpy as np

# Heads whose first Linear takes the obs block as its leading input columns.
HEADS = ["trunk", "value", "farm_value", "route_mode", "reward_pick", "placement"]


def insert_zero_cols(W: list[list[float]], at: int, n: int) -> list[list[float]]:
    """Insert `n` zero columns into row-major weight matrix W (out x in) at column `at`."""
    return [row[:at] + [0.0] * n + row[at:] for row in W]


def expand_checkpoint(ckpt: dict, new_obs_dim: int) -> dict:
    old_obs_dim = int(ckpt["obs_dim"])
    act_dim = int(ckpt["act_dim"])
    n_new = new_obs_dim - old_obs_dim
    if n_new < 0:
        raise ValueError(f"new_obs_dim {new_obs_dim} < old obs_dim {old_obs_dim}")
    if n_new == 0:
        return copy.deepcopy(ckpt)

    out = copy.deepcopy(ckpt)
    for head in HEADS:
        layers = out.get(head)
        if not isinstance(layers, list) or not layers:
            continue
        first = layers[0]
        in_width = len(first["W"][0])
        # Sanity: the first layer's input is either obs-only or obs+act; obs leads either way.
        expected = {old_obs_dim, old_obs_dim + act_dim}
        if in_width not in expected:
            raise ValueError(
                f"{head}[0] input width {in_width} is neither obs_dim ({old_obs_dim}) "
                f"nor obs_dim+act_dim ({old_obs_dim + act_dim})"
            )
        first["W"] = insert_zero_cols(first["W"], old_obs_dim, n_new)
    out["obs_dim"] = new_obs_dim
    return out


# ── Independent numpy forward pass (mirrors net.ts: ReLU between layers, none last) ──
def _mlp(x: np.ndarray, layers: list[dict]) -> np.ndarray:
    h = x
    for i, layer in enumerate(layers):
        W = np.asarray(layer["W"], dtype=np.float64)  # out x in
        b = np.asarray(layer["b"], dtype=np.float64)
        h = W @ h + b
        if i < len(layers) - 1:
            h = np.maximum(h, 0.0)
    return h


def verify_parity(old: dict, new: dict, n_samples: int = 8, seed: int = 0) -> None:
    """Assert the expanded net produces IDENTICAL logits/value to the source, where the new
    obs features are zeros inserted at the old obs boundary (their real gen-1 encoded value)."""
    rng = np.random.default_rng(seed)
    old_obs = int(old["obs_dim"])
    new_obs = int(new["obs_dim"])
    act = int(old["act_dim"])
    n_new = new_obs - old_obs
    max_abs = 0.0
    for _ in range(n_samples):
        obs = rng.standard_normal(old_obs)
        cand = rng.standard_normal(act)
        # obs padded exactly how encodeObs appends: old features, then the new features (=0 warm).
        obs_new = np.concatenate([obs, np.zeros(n_new)])

        # trunk: input is concat(obs, cand).
        o_trunk = _mlp(np.concatenate([obs, cand]), old["trunk"])
        n_trunk = _mlp(np.concatenate([obs_new, cand]), new["trunk"])
        max_abs = max(max_abs, float(np.max(np.abs(o_trunk - n_trunk))))
        # value: obs-only.
        o_val = _mlp(obs, old["value"])
        n_val = _mlp(obs_new, new["value"])
        max_abs = max(max_abs, float(np.max(np.abs(o_val - n_val))))
        # optional heads present on both.
        for head in ["farm_value", "route_mode", "placement"]:
            if head in old and head in new:
                max_abs = max(max_abs, float(np.max(np.abs(_mlp(obs, old[head]) - _mlp(obs_new, new[head])))))
        if "reward_pick" in old and "reward_pick" in new:
            o_rp = _mlp(np.concatenate([obs, cand]), old["reward_pick"])
            n_rp = _mlp(np.concatenate([obs_new, cand]), new["reward_pick"])
            max_abs = max(max_abs, float(np.max(np.abs(o_rp - n_rp))))
    if max_abs > 1e-9:
        raise AssertionError(f"warm-start parity FAILED: max |Δ| = {max_abs:.3e} (expected 0)")
    print(f"parity OK: max |Δ output| = {max_abs:.3e} over {n_samples} random samples")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--in", dest="inp", required=True, type=Path)
    ap.add_argument("--out", dest="out", required=True, type=Path)
    ap.add_argument("--new-obs-dim", type=int, default=83)
    ap.add_argument("--no-verify", action="store_true", help="skip the numpy parity self-check")
    args = ap.parse_args()

    with open(args.inp) as f:
        ckpt = json.load(f)
    old_obs = int(ckpt["obs_dim"])
    expanded = expand_checkpoint(ckpt, args.new_obs_dim)
    if not args.no_verify:
        verify_parity(ckpt, expanded)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(expanded, f)
    # Report the shape change for the operator log.
    t_in = len(expanded["trunk"][0]["W"][0])
    v_in = len(expanded["value"][0]["W"][0])
    print(
        f"expanded obs_dim {old_obs} -> {args.new_obs_dim} "
        f"(trunk first-layer in {t_in}, value first-layer in {v_in}); wrote {args.out}"
    )


if __name__ == "__main__":
    main()
