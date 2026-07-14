"""
Entity-level set-transformer policy/value network for Arc Spirits (model v2).

Consumes flat `arc-obs-v2` observations (see ml/obs_v2.py and docs/encoder-v2.md)
and append-only v1 candidate-action vectors (act_dim comes from the dataset). The forward contract is EXACTLY
CandidateScorer's (ml/model.py), so train.py can consume it behind a --model v2
flag later:

    forward(obs_flat, cands, mask, option=None) -> (logits, probs, value)
      obs_flat: (batch, flat_len=3419)   # raw flattened obs, header included
      cands:    (batch, max_cands, act_dim)
      mask:     (batch, max_cands) bool  # True = valid candidate
      logits:   (batch, max_cands)       # padded slots at -1e9
      probs:    (batch, max_cands)
      value:    (batch,)

Architecture (BOT_TAKEOVER_PLAN.md M2):
  - obs_v2 parse: flat -> per-family token tensors + pad masks (header-driven).
  - Per-family Linear embed to a shared d_model + learned family-type embedding.
    No positional encodings: tokens are a SET (slot/seat identity are features),
    so within-family token order is a no-op by construction.
  - Pre-LN TransformerEncoder (default 3 layers, 4 heads, 4x FF) over the
    64-token sequence (1 global + 6 seats + 42 spirits + 6 market + 8 runes +
    1 monster) with key_padding_mask from the pad masks. The global token is
    always real, so every query row has at least one valid key.
  - State embedding: attention pooling with a single learned query over the
    encoder output (pads masked out).
  - Candidate head: embed each 52-float candidate to d_model, score an MLP on
    [cand_emb, state_emb, cand_emb * state_emb].
  - Value head on state_emb; optional 20/25/30-round reach-30 critic; aux heads mirror
    CandidateScorer's API:
    farm_value(obs), route_mode_logits(obs), reward_pick_logits(obs, cands, mask),
    plus placement_logits(obs) — per-seat final-placement prediction read from
    each REAL seat token's encoder output (pad seats masked to 0).

Checkpoint convention — `arc-entity-scorer-v2`:
  A transformer cannot be exported to the TS-side `arc-cand-scorer-v1` JSON
  (that format is a fixed MLP layer list). v2 checkpoints are torch .pt files:

      save_checkpoint(model, "weights/v2.pt")
        -> weights/v2.pt          torch.save({"format": "arc-entity-scorer-v2",
                                              "config": {...}, "state_dict": ...})
        -> weights/v2.manifest.json  {format, obs_version, obs_flat_len, act_dim,
                                      d_model, layers, heads, params}
      model = load_checkpoint("weights/v2.pt")

  The inference server (ml/infer_server.py) loads the .pt for v2 policies; the
  manifest is the cheap format/shape probe for tooling that must not import
  torch. The obs-v2 flat header is stored in config and re-validated on load,
  so a checkpoint can never be silently applied to a different obs layout.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F

from obs_v2 import ObsV2Spec

CHECKPOINT_FORMAT = "arc-entity-scorer-v2"


def _mlp(in_dim: int, hidden: int, out_dim: int) -> nn.Sequential:
    return nn.Sequential(nn.Linear(in_dim, hidden), nn.GELU(), nn.Linear(hidden, out_dim))


class AttentionPool(nn.Module):
    """Single learned query attending over the token set (pads masked out)."""

    def __init__(self, d_model: int) -> None:
        super().__init__()
        self.query = nn.Parameter(torch.zeros(1, 1, d_model))
        nn.init.normal_(self.query, std=0.02)
        self.key = nn.Linear(d_model, d_model)
        self.value = nn.Linear(d_model, d_model)

    def forward(self, tokens: torch.Tensor, pad_mask: torch.Tensor) -> torch.Tensor:
        # tokens: (B, T, d), pad_mask: (B, T) True = PAD.
        scores = torch.einsum("bqd,btd->bqt", self.query.expand(tokens.shape[0], -1, -1), self.key(tokens))
        scores = scores / math.sqrt(tokens.shape[-1])
        scores = scores.masked_fill(pad_mask.unsqueeze(1), float("-inf"))
        attn = torch.softmax(scores, dim=-1)
        return torch.einsum("bqt,btd->bqd", attn, self.value(tokens)).squeeze(1)


class EntityCandidateScorer(nn.Module):
    """
    Set-transformer candidate scorer over arc-obs-v2 entity tokens.

    Drop-in interface match for CandidateScorer (ml/model.py): forward/score_single
    signatures and the aux-head methods are identical; only obs_dim differs
    (flat v2 length instead of the current 199-float summary).
    """

    def __init__(
        self,
        spec: ObsV2Spec,
        act_dim: int,
        d_model: int = 128,
        layers: int = 3,
        heads: int = 4,
        ff_mult: int = 4,
        dropout: float = 0.0,
        reach30_horizons: tuple[int, ...] = (),
    ) -> None:
        super().__init__()
        self.spec = spec
        self.obs_dim = spec.flat_length  # CandidateScorer parity: the flat input width
        self.act_dim = act_dim
        self.d_model = d_model
        self.layers = layers
        self.heads = heads
        self.ff_mult = ff_mult
        # PPO's low-level model contract is option-aware. Entity v2 deliberately
        # has no high-level option conditioning, but it must still advertise the
        # zero-width capability and accept the empty tensors emitted by PPO.
        self.option_dim = 0
        normalized_horizons = tuple(int(h) for h in reach30_horizons)
        if (
            any(h <= 0 for h in normalized_horizons)
            or tuple(sorted(set(normalized_horizons))) != normalized_horizons
        ):
            raise ValueError("reach30_horizons must be strictly increasing positive integers")
        self.reach30_horizons = normalized_horizons
        self.reach30_horizon: int | None = (
            normalized_horizons[-1] if normalized_horizons else None
        )
        self.reach30_trained = False

        self.family_names = [f.name for f in spec.families]
        self.family_embed = nn.ModuleDict(
            {f.name: nn.Linear(f.dim, d_model) for f in spec.families}
        )
        # One learned type vector per family, added to every token of that family.
        self.type_embed = nn.Embedding(len(spec.families), d_model)

        layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=heads,
            dim_feedforward=ff_mult * d_model,
            dropout=dropout,
            activation="gelu",
            batch_first=True,
            norm_first=True,  # pre-LN
        )
        # Nested-tensor fast path is incompatible with pre-LN anyway; disable it
        # explicitly so eval numerics never depend on the batch's mask pattern.
        self.encoder = nn.TransformerEncoder(
            layer, num_layers=layers, norm=nn.LayerNorm(d_model), enable_nested_tensor=False
        )
        self.pool = AttentionPool(d_model)

        self.cand_embed = nn.Linear(act_dim, d_model)
        self.score_head = _mlp(3 * d_model, d_model, 1)
        self.value_head = _mlp(d_model, d_model, 1)
        self.reach30_head: nn.Module | None = (
            _mlp(d_model, d_model // 2, len(normalized_horizons))
            if normalized_horizons
            else None
        )

        # Aux heads (kept optional-cost: tiny). Names mirror CandidateScorer.
        self.farm_value_head = _mlp(d_model, d_model // 2, 1)
        self.route_mode_head = _mlp(d_model, d_model // 2, 1)
        self.reward_pick_head = _mlp(3 * d_model, d_model, 1)
        # Per-seat final placement: read from each seat token's output embedding.
        self.placement_head = _mlp(d_model, d_model // 2, 1)

        # Cached token-index bookkeeping: payload order = family order.
        offsets: dict[str, tuple[int, int]] = {}
        off = 0
        for f in spec.families:
            offsets[f.name] = (off, off + f.cap)
            off += f.cap
        self._token_slices = offsets
        self.num_tokens = off

    def enable_reach30_horizons(self, horizons: tuple[int, ...]) -> None:
        """Add the multi-horizon solo critic to a legacy v2 warm start.

        Old v2 checkpoints predate this auxiliary head. Their policy/value
        tensors remain loadable bit-for-bit; the new head is initialized only
        when a trainer explicitly requests reach-30 supervision.
        """
        normalized = tuple(int(h) for h in horizons)
        if any(h <= 0 for h in normalized) or tuple(sorted(set(normalized))) != normalized:
            raise ValueError("reach30 horizons must be strictly increasing positive integers")
        if self.reach30_head is not None:
            if normalized != self.reach30_horizons:
                raise ValueError(
                    f"checkpoint reach30 horizons {self.reach30_horizons} != requested {normalized}"
                )
            return
        if not normalized:
            raise ValueError("at least one reach30 horizon is required")
        head = _mlp(self.d_model, self.d_model // 2, len(normalized))
        reference = next(self.parameters())
        self.reach30_head = head.to(device=reference.device, dtype=reference.dtype)
        self.reach30_horizons = normalized
        self.reach30_horizon = normalized[-1]
        self.reach30_trained = False

    def _check_option(self, option: torch.Tensor | None) -> None:
        if option is not None and option.numel() != 0:
            raise ValueError("entity v2 does not support non-empty high-level option conditioning")

    # ── encoding ────────────────────────────────────────────────────────────

    def encode_state(self, obs_flat: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """
        obs_flat: (B, flat_len) or (flat_len,) raw flattened v2 obs.
        Returns (state_emb (B, d), token_out (B, T, d), pad_mask (B, T) True=PAD).
        """
        if obs_flat.dim() == 1:
            obs_flat = obs_flat.unsqueeze(0)
        tokens, masks = self.spec.unflatten(obs_flat, validate_header=True, dtype=torch.float32)

        embedded = []
        pad = []
        for i, name in enumerate(self.family_names):
            fam = tokens[name].to(self.cand_embed.weight.dtype)
            e = self.family_embed[name](fam) + self.type_embed.weight[i]
            embedded.append(e)
            pad.append(masks[name] < 0.5)
        x = torch.cat(embedded, dim=1)          # (B, T, d)
        pad_mask = torch.cat(pad, dim=1)        # (B, T) True = PAD
        out = self.encoder(x, src_key_padding_mask=pad_mask)
        state = self.pool(out, pad_mask)
        return state, out, pad_mask

    def _score_candidates(
        self, head: nn.Module, state: torch.Tensor, cands: torch.Tensor, mask: torch.Tensor
    ) -> torch.Tensor:
        cand_emb = self.cand_embed(cands)                       # (B, C, d)
        state_exp = state.unsqueeze(1).expand_as(cand_emb)      # (B, C, d)
        joint = torch.cat([cand_emb, state_exp, cand_emb * state_exp], dim=-1)
        logits = head(joint).squeeze(-1)                        # (B, C)
        return logits.masked_fill(~mask, -1e9)

    # ── CandidateScorer contract ────────────────────────────────────────────

    def forward(
        self,
        obs: torch.Tensor,   # (batch, flat_len)
        cands: torch.Tensor,  # (batch, max_cands, act_dim)
        mask: torch.Tensor,   # (batch, max_cands) — True = valid, False = padded
        option: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        self._check_option(option)
        state, _, _ = self.encode_state(obs)
        logits_masked = self._score_candidates(self.score_head, state, cands, mask)
        probs = F.softmax(logits_masked, dim=-1)
        value = self.value_head(state).squeeze(-1)
        return logits_masked, probs, value

    def score_single(
        self, obs: torch.Tensor, cands: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """Inference convenience for variable-length cands (no padding needed)."""
        if obs.dim() == 1:
            obs = obs.unsqueeze(0)
        if cands.dim() == 2:
            cands = cands.unsqueeze(0)
        mask = torch.ones(cands.shape[0], cands.shape[1], dtype=torch.bool, device=cands.device)
        return self.forward(obs, cands, mask)

    # ── aux heads (API-parity with CandidateScorer + v2 placement aux) ──────

    def farm_value(
        self, obs: torch.Tensor, option: torch.Tensor | None = None
    ) -> torch.Tensor:
        self._check_option(option)
        state, _, _ = self.encode_state(obs)
        return self.farm_value_head(state).squeeze(-1)

    def route_mode_logits(
        self, obs: torch.Tensor, option: torch.Tensor | None = None
    ) -> torch.Tensor:
        self._check_option(option)
        state, _, _ = self.encode_state(obs)
        return self.route_mode_head(state).squeeze(-1)

    def reward_pick_logits(
        self,
        obs: torch.Tensor,
        cands: torch.Tensor,
        mask: torch.Tensor,
        option: torch.Tensor | None = None,
    ) -> torch.Tensor:
        self._check_option(option)
        state, _, _ = self.encode_state(obs)
        return self._score_candidates(self.reward_pick_head, state, cands, mask)

    def reach30_all_logits(
        self, obs: torch.Tensor, option: torch.Tensor | None = None
    ) -> torch.Tensor:
        """P(reach 30 VP by each configured horizon), shape ``(batch, H)``."""
        self._check_option(option)
        if self.reach30_head is None:
            raise ValueError("reach30 logits requested from a v2 model without the auxiliary head")
        state, _, _ = self.encode_state(obs)
        return self.reach30_head(state)

    def reach30_logits(
        self, obs: torch.Tensor, option: torch.Tensor | None = None
    ) -> torch.Tensor:
        """Wire-compatible scalar logit for the checkpoint's primary (latest) horizon."""
        return self.reach30_all_logits(obs, option)[:, -1]

    def placement_logits(self, obs: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """
        Per-opponent placement aux: a scalar per seat token predicting that
        seat's final placement (regression/rank target chosen by the trainer).
        Returns (pred (B, seats_cap), seat_mask (B, seats_cap) True = real seat).
        """
        _, token_out, pad_mask = self.encode_state(obs)
        lo, hi = self._token_slices["seat"]
        seat_out = token_out[:, lo:hi]
        seat_real = ~pad_mask[:, lo:hi]
        pred = self.placement_head(seat_out).squeeze(-1)
        return pred.masked_fill(~seat_real, 0.0), seat_real

    def param_count(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def config(self) -> dict:
        return {
            "obs_flat_header": self.spec.header,
            "obs_flat_len": self.spec.flat_length,
            "act_dim": self.act_dim,
            "d_model": self.d_model,
            "layers": self.layers,
            "heads": self.heads,
            "ff_mult": self.ff_mult,
            "reach30_horizons": list(self.reach30_horizons),
            "reach30_trained": bool(self.reach30_trained),
        }


# ── build / save / load ──────────────────────────────────────────────────────

def build_model_v2(
    spec: ObsV2Spec,
    act_dim: int,
    device: Optional[torch.device] = None,
    d_model: int = 128,
    layers: int = 3,
    heads: int = 4,
    ff_mult: int = 4,
    reach30_horizons: tuple[int, ...] = (),
    seed: Optional[int] = 0,
) -> EntityCandidateScorer:
    """Build with seed-stable init (pass seed=None to inherit global RNG state)."""
    if seed is not None:
        torch.manual_seed(seed)
    model = EntityCandidateScorer(
        spec,
        act_dim,
        d_model=d_model,
        layers=layers,
        heads=heads,
        ff_mult=ff_mult,
        reach30_horizons=reach30_horizons,
    )
    model = model.float()
    if device is not None:
        model = model.to(device)
    return model


def save_checkpoint(model: EntityCandidateScorer, path: str | Path) -> Path:
    """Write the arc-entity-scorer-v2 .pt checkpoint + sibling manifest JSON."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "format": CHECKPOINT_FORMAT,
        "config": model.config(),
        "state_dict": {k: v.detach().cpu() for k, v in model.state_dict().items()},
    }
    torch.save(payload, path)
    manifest = {
        "format": CHECKPOINT_FORMAT,
        "obs_version": 2,
        "obs_flat_len": model.spec.flat_length,
        "act_dim": model.act_dim,
        "d_model": model.d_model,
        "layers": model.layers,
        "heads": model.heads,
        "reach30_horizons": list(model.reach30_horizons),
        "reach30_trained": bool(model.reach30_trained),
        "params": model.param_count(),
    }
    manifest_path = path.with_suffix(".manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    return manifest_path


def load_checkpoint(
    path: str | Path,
    device: Optional[torch.device] = None,
    spec: Optional[ObsV2Spec] = None,
) -> EntityCandidateScorer:
    """
    Load an arc-entity-scorer-v2 checkpoint. If `spec` is given (e.g. from the
    dataset's meta.json) it must match the checkpoint's stored obs header —
    a mismatch means the data layout changed and the weights are invalid.
    """
    payload = torch.load(Path(path), map_location="cpu", weights_only=True)
    if payload.get("format") != CHECKPOINT_FORMAT:
        raise ValueError(f"{path}: format {payload.get('format')!r} != {CHECKPOINT_FORMAT!r}")
    cfg = payload["config"]
    ckpt_spec = ObsV2Spec.from_header(cfg["obs_flat_header"])
    if spec is not None and spec.header != ckpt_spec.header:
        raise ValueError(f"{path}: checkpoint obs header {ckpt_spec.header} != dataset header {spec.header}")
    model = EntityCandidateScorer(
        ckpt_spec,
        act_dim=int(cfg["act_dim"]),
        d_model=int(cfg["d_model"]),
        layers=int(cfg["layers"]),
        heads=int(cfg["heads"]),
        ff_mult=int(cfg["ff_mult"]),
        reach30_horizons=tuple(int(h) for h in cfg.get("reach30_horizons", ())),
    )
    model.load_state_dict(payload["state_dict"])
    model.reach30_trained = bool(cfg.get("reach30_trained", False))
    model = model.float()
    if device is not None:
        model = model.to(device)
    return model
