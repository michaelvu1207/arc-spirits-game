"""
Candidate-scoring policy + value network for Arc Spirits bot training.

Architecture:
  - Trunk (candidate scorer): concat(obs, cand_feat) -> 128 -> 128 -> 1 (logit per candidate)
  - Value head: obs -> 64 -> 1 (state value estimate)
  - Farm-value head: obs -> 64 -> 1 (auxiliary state target for clean farm opportunity)
  - Reward-pick head: concat(obs, cand_feat) -> 128 -> 128 -> 1 (auxiliary candidate target for reward picks)
  - Route-mode head: obs -> 64 -> 1 (auxiliary Fallen route mode target: hunt vs return Abyss)

Policy: softmax over per-candidate logits (with padding mask).
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F


def get_device() -> torch.device:
    # Honor an explicit override (e.g. CUDA_VISIBLE_DEVICES already scopes which GPU);
    # ARC_DEVICE lets a launcher force cuda/cuda:N/mps/cpu.
    import os

    forced = os.environ.get("ARC_DEVICE")
    if forced:
        return torch.device(forced)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


class CandidateScorer(nn.Module):
    """
    Scores each candidate action given the obs context.

    Input: obs (batch, obs_dim), cands (batch, max_cands, act_dim), mask (batch, max_cands)
    Output:
      - logits (batch, max_cands): raw scores before softmax
      - probs (batch, max_cands): softmax probabilities (masked)
      - value (batch,): state value estimate from value head
    """

    def __init__(self, obs_dim: int, act_dim: int, trunk_hidden=(128, 128), value_hidden=(64,)) -> None:
        super().__init__()
        self.obs_dim = obs_dim
        self.act_dim = act_dim
        self.trunk_hidden = tuple(int(h) for h in trunk_hidden)
        self.value_hidden = tuple(int(h) for h in value_hidden)

        def mlp(in_dim: int, hidden, out_dim: int) -> nn.Sequential:
            dims = [in_dim, *hidden, out_dim]
            layers: list[nn.Module] = []
            for i in range(len(dims) - 1):
                layers.append(nn.Linear(dims[i], dims[i + 1]))
                if i < len(dims) - 2:
                    layers.append(nn.ReLU())
            return nn.Sequential(*layers)

        # Candidate scorer: concat(obs, cand) -> trunk_hidden... -> 1.  Value: obs -> value_hidden... -> 1.
        self.trunk = mlp(obs_dim + act_dim, self.trunk_hidden, 1)
        self.value_head = mlp(obs_dim, self.value_hidden, 1)
        self.farm_value_head = mlp(obs_dim, self.value_hidden, 1)
        self.route_mode_head = mlp(obs_dim, self.value_hidden, 1)
        self.reward_pick_head = mlp(obs_dim + act_dim, self.trunk_hidden, 1)
        # KataGo-style outcome aux: 4-way final-placement logits from the obs.
        # Distinct name from model_v2's placement_logits — the v2 aux loss has a
        # different contract (per-seat-token scalar) and must not activate here.
        self.placement_head = mlp(obs_dim, self.value_hidden, 4)

    def forward(
        self,
        obs: torch.Tensor,           # (batch, obs_dim)
        cands: torch.Tensor,          # (batch, max_cands, act_dim)
        mask: torch.Tensor,           # (batch, max_cands) — True = valid, False = padded
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        batch, max_cands, _ = cands.shape

        # Expand obs to match each candidate: (batch, max_cands, obs_dim)
        obs_exp = obs.unsqueeze(1).expand(-1, max_cands, -1)

        # Concatenate obs + cand features: (batch, max_cands, obs_dim+act_dim)
        trunk_in = torch.cat([obs_exp, cands], dim=-1)

        # Score each candidate: (batch, max_cands)
        logits = self.trunk(trunk_in).squeeze(-1)

        # Apply padding mask: set padded positions to large negative before softmax
        logits_masked = logits.masked_fill(~mask, -1e9)

        probs = F.softmax(logits_masked, dim=-1)

        # Value estimate from obs only: (batch,)
        value = self.value_head(obs).squeeze(-1)

        return logits_masked, probs, value

    def placement_head_logits(self, obs: torch.Tensor) -> torch.Tensor:
        """(B, 4) final-placement logits (CE target: placement-1)."""
        return self.placement_head(obs)

    def farm_value(self, obs: torch.Tensor) -> torch.Tensor:
        """Auxiliary farm-value prediction from obs only: (batch,)."""
        return self.farm_value_head(obs).squeeze(-1)

    def route_mode_logits(self, obs: torch.Tensor) -> torch.Tensor:
        """Auxiliary Fallen route-mode logits from obs only: (batch,)."""
        return self.route_mode_head(obs).squeeze(-1)

    def reward_pick_logits(
        self,
        obs: torch.Tensor,
        cands: torch.Tensor,
        mask: torch.Tensor,
    ) -> torch.Tensor:
        """Auxiliary reward-pick logits over candidates, masked like the main policy logits."""
        batch, max_cands, _ = cands.shape
        obs_exp = obs.unsqueeze(1).expand(-1, max_cands, -1)
        trunk_in = torch.cat([obs_exp, cands], dim=-1)
        logits = self.reward_pick_head(trunk_in).squeeze(-1)
        return logits.masked_fill(~mask, -1e9)

    def score_single(
        self, obs: torch.Tensor, cands: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """
        Convenience wrapper for inference with variable-length cands (no padding needed).
        obs: (obs_dim,) or (1, obs_dim)
        cands: (n_cands, act_dim) or (1, n_cands, act_dim)
        """
        if obs.dim() == 1:
            obs = obs.unsqueeze(0)
        if cands.dim() == 2:
            cands = cands.unsqueeze(0)
        mask = torch.ones(cands.shape[0], cands.shape[1], dtype=torch.bool, device=cands.device)
        return self.forward(obs, cands, mask)


def build_model(
    obs_dim: int,
    act_dim: int,
    device: Optional[torch.device] = None,
    trunk_hidden: Optional[tuple[int, ...]] = None,
    value_hidden: Optional[tuple[int, ...]] = None,
) -> CandidateScorer:
    """Build and return a CandidateScorer on the target device."""
    if device is None:
        device = get_device()
    # Size is set by env so one trainer can produce the whole ladder:
    #   ARC_HIDDEN="384,384"  ARC_VALUE_HIDDEN="128"
    th = trunk_hidden or tuple(int(x) for x in os.environ.get("ARC_HIDDEN", "128,128").split(",") if x.strip())
    vh = value_hidden or tuple(int(x) for x in os.environ.get("ARC_VALUE_HIDDEN", "64").split(",") if x.strip())
    model = CandidateScorer(obs_dim, act_dim, th, vh).float().to(device)
    return model


def load_dims_from_meta(data_dir: str | Path) -> tuple[int, int]:
    """Read obs_dim and act_dim from meta.json, falling back to first data line."""
    data_dir = Path(data_dir)
    meta_path = data_dir / "meta.json"
    if meta_path.exists():
        with open(meta_path) as f:
            meta = json.load(f)
        return int(meta["obs_dim"]), int(meta["act_dim"])

    # Fallback: infer from first JSONL line. Skip the actor pool's games-*.jsonl
    # per-game summaries (no obs/cands keys — games-0.jsonl sorts before shard-0.jsonl).
    jsonl_files = sorted(p for p in data_dir.glob("*.jsonl") if not p.name.startswith("games-"))
    if not jsonl_files:
        raise FileNotFoundError(f"No meta.json or *.jsonl in {data_dir}")
    with open(jsonl_files[0]) as f:
        first = json.loads(f.readline())
    obs_dim = len(first["obs"])
    act_dim = len(first["cands"][0])
    return obs_dim, act_dim
