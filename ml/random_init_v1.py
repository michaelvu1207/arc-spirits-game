#!/usr/bin/env python3
"""
Mint a RANDOM-INIT arc-cand-scorer-v1 checkpoint (valid TS-loadable JSON).

Why this exists: PPO needs an acting policy that emits logpOld/vPred from the
very first game, so a truly FRESH league lane cannot start from "no checkpoint"
(the manager's fallback plays a heuristic bootstrap generation, which pollutes
a from-scratch rediscovery claim with teacher behavior). A random net is the
honest zero-knowledge starting point: it plays (uniformly badly), records real
PPO fields, and everything it ever learns comes from the league.

Deterministic given --seed (CPU init, no data touched). Reuses model.py's
CandidateScorer and train.py's export_weights so the output is byte-for-byte
the same format every trained checkpoint uses (net.ts loadPolicyWeights
validates trunk/value shapes and dims).

Usage:
    ml/.venv/bin/python ml/random_init_v1.py --out ml/weights/random-42.json --seed 42
    # widths default to model.py's ladder defaults (ARC_HIDDEN/ARC_VALUE_HIDDEN
    # env or 128,128 / 64); override explicitly:
    ml/.venv/bin/python ml/random_init_v1.py --out r.json --seed 7 --trunk 384,384 --value-hidden 128
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).parent))
from model import build_model  # noqa: E402
from train import export_weights  # noqa: E402


def parse_widths(s: str | None) -> tuple[int, ...] | None:
    if not s:
        return None
    return tuple(int(x) for x in s.split(",") if x.strip())


def main() -> None:
    p = argparse.ArgumentParser(description="Mint a random-init arc-cand-scorer-v1 JSON checkpoint")
    p.add_argument("--out", type=Path, required=True, help="output policy JSON path")
    p.add_argument("--seed", type=int, required=True, help="init seed (deterministic output)")
    p.add_argument("--obs-dim", type=int, default=62)
    p.add_argument("--act-dim", type=int, default=52)
    p.add_argument("--trunk", type=str, default=None, help='trunk widths, e.g. "128,128"')
    p.add_argument("--value-hidden", type=str, default=None, help='value-head widths, e.g. "64"')
    args = p.parse_args()

    if args.out.suffix != ".json":
        raise SystemExit(f"--out {args.out} must be a .json (arc-cand-scorer-v1 is the TS JSON format)")

    torch.manual_seed(args.seed)
    # CPU init keeps the draw identical across machines/devices.
    model = build_model(
        args.obs_dim,
        args.act_dim,
        device=torch.device("cpu"),
        trunk_hidden=parse_widths(args.trunk),
        value_hidden=parse_widths(args.value_hidden),
    )
    export_weights(model, args.obs_dim, args.act_dim, args.out)
    n_params = sum(t.numel() for t in model.parameters())
    print(f"random-init checkpoint: {args.out} (seed={args.seed}, params={n_params})")


if __name__ == "__main__":
    main()
