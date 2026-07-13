"""
Training script for the Arc Spirits candidate-scoring policy + value network.

Usage:
  ml/.venv/bin/python ml/train.py \
      --data ml/data \
      --out ml/weights/policy.json \
      --epochs 8 \
      --beta 1.0

Losses:
  - Policy: cross-entropy of chosen action under masked softmax,
            weighted by AWR weight w = clamp(exp(beta*(ret - baseline)), 0, 20)
  - Value:  MSE(value(obs), ret)
  - Optional auxiliary heads:
      farm_value(obs) -> clean farm opportunity scalar
      reward_pick(obs, cand) -> reward-pick policy target
      route_mode(obs) -> Fallen route mode scalar (1=hunt Good player, 0=return Abyss)
  - Total:  policy_loss + value_coef * value_loss + optional auxiliary losses

--mode ppo trains on the trajectory JSONL format (rows carrying
gameId/stepIdx/rStep/done/logpOld/vPred/placement on top of the usual fields)
with clipped-surrogate PPO + GAE; see ppo.py. Old-format rows without those
fields still train under awr/alphazero, and trajectory rows still load here.

--model v2 trains the entity set-transformer (ml/model_v2.py) instead of the
v1 MLP, on the PAIRED-ROW contract (authoritative, see bc_warmstart_v2.py):
rows keep `obs` = the current 83-float v1 summary AND carry the flat arc-obs-v2 array
(3419 floats for the frozen catalog) under `obsV2`. --model v2 reads obsV2 and
skips rows without it (counted); the layout is resolved from meta.json's
"obs_v2" obsV2Meta block or the row's self-describing header. v2 checkpoints
are .pt + manifest (arc-entity-scorer-v2), never the TS JSON export: --out and
--init-from must be .pt for v2 and .json for v1. All modes (awr/alphazero/ppo)
work on v2; rows with `placement` additionally train the v2 placement aux head
(--placement-coef).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

# Add ml/ parent to path so we can import model regardless of cwd
sys.path.insert(0, str(Path(__file__).parent))
from model import (
    CandidateScorer,
    build_model,
    get_device,
    load_dims_from_meta,
    model_parameters_are_finite,
)


# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------

def sample_files(data_dir: Path) -> list[Path]:
    """All *.jsonl sample shards, excluding the actor pool's games-*.jsonl
    per-game summaries (no obs/cands keys — they'd crash header inference)."""
    return sorted(
        p for p in data_dir.rglob("*.jsonl")
        if p.is_file() and not p.name.startswith("games-")
    )


class DecisionDataset(Dataset):
    """
    Stores all decisions from JSONL files as numpy arrays.
    Padding is done at collation time (per-batch).

    obs_key selects which field feeds the model: "obs" (current v1 83-float summary)
    or "obsV2" (flat arc-obs-v2, paired-row contract). Rows lacking obs_key
    are skipped and counted (v1-only rows mixed into a v2 dataset).
    """

    def __init__(self, data_dir: Path, obs_key: str = "obs") -> None:
        self.obs_list: list[np.ndarray] = []
        self.cands_list: list[np.ndarray] = []  # variable-length lists of cand vecs
        self.chosen_list: list[int] = []
        self.ret_list: list[float] = []
        self.pi_list: list[np.ndarray] = []  # per-sample target distribution over cands (AlphaZero)
        self.farm_value_list: list[float] = []
        self.farm_value_mask: list[bool] = []
        self.reward_pi_list: list[np.ndarray] = []
        self.reward_pi_mask: list[bool] = []
        self.policy_weight_list: list[float] = []
        self.route_mode_list: list[float] = []
        self.route_mode_mask: list[bool] = []
        self.placement_list: list[int] = []
        self.placement_mask: list[bool] = []
        self.n_with_pi = 0
        self.n_with_farm_value = 0
        self.n_with_reward_pi = 0
        self.n_with_route_mode = 0
        self.n_with_placement = 0
        self.n_value_only = 0
        self.n_missing_obs = 0

        jsonl_files = sample_files(data_dir)
        if not jsonl_files:
            raise FileNotFoundError(f"No *.jsonl files found in {data_dir}")

        for fpath in jsonl_files:
            with open(fpath) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:  # tolerate a partial last line if a file is being appended concurrently
                        rec: dict[str, Any] = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(rec, dict):
                        continue
                    if obs_key not in rec:
                        self.n_missing_obs += 1
                        continue
                    try:
                        obs = np.array(rec[obs_key], dtype=np.float32)
                        cands = np.array(rec["cands"], dtype=np.float32)  # (n_cands, act_dim)
                        chosen = int(rec["chosen"])
                        ret = float(rec["ret"])
                    except (KeyError, ValueError, TypeError):
                        continue
                    n = cands.shape[0]
                    # AlphaZero policy target: the recorded MCTS visit distribution `pi` (search-improved).
                    # Fallback when absent: a one-hot on the chosen action (= behavior cloning of that move).
                    pi = rec.get("pi")
                    if isinstance(pi, list) and len(pi) == n:
                        pi_arr = np.array(pi, dtype=np.float32)
                        s = float(pi_arr.sum())
                        pi_arr = pi_arr / s if s > 0 else np.full(n, 1.0 / n, dtype=np.float32)
                        self.n_with_pi += 1
                    else:
                        pi_arr = np.zeros(n, dtype=np.float32)
                        pi_arr[min(max(chosen, 0), n - 1)] = 1.0

                    farm_raw = rec.get("farmValue", rec.get("farm_value"))
                    if isinstance(farm_raw, (int, float)) and math.isfinite(float(farm_raw)):
                        farm_value = float(np.clip(float(farm_raw), 0.0, 1.0))
                        has_farm_value = True
                        self.n_with_farm_value += 1
                    else:
                        farm_value = 0.0
                        has_farm_value = False

                    reward_pi = rec.get("rewardPi", rec.get("reward_pi"))
                    if isinstance(reward_pi, list) and len(reward_pi) == n:
                        reward_pi_arr = np.array(reward_pi, dtype=np.float32)
                        s2 = float(reward_pi_arr.sum())
                        if s2 > 0:
                            reward_pi_arr = reward_pi_arr / s2
                            has_reward_pi = True
                            self.n_with_reward_pi += 1
                        else:
                            reward_pi_arr = np.zeros(n, dtype=np.float32)
                            has_reward_pi = False
                    else:
                        reward_pi_arr = np.zeros(n, dtype=np.float32)
                        has_reward_pi = False
                    policy_weight_raw = rec.get("policyWeight", rec.get("policy_weight", 1.0))
                    try:
                        policy_weight = float(policy_weight_raw)
                    except (TypeError, ValueError):
                        policy_weight = 1.0
                    if not math.isfinite(policy_weight):
                        policy_weight = 1.0
                    policy_weight = float(np.clip(policy_weight, 0.0, 20.0))
                    route_raw = rec.get("routeMode", rec.get("route_mode"))
                    if isinstance(route_raw, (int, float)) and math.isfinite(float(route_raw)):
                        route_mode = float(np.clip(float(route_raw), 0.0, 1.0))
                        has_route_mode = True
                        self.n_with_route_mode += 1
                    else:
                        route_mode = 0.0
                        has_route_mode = False
                    placement_raw = rec.get("placement")
                    if (
                        isinstance(placement_raw, (int, float))
                        and not isinstance(placement_raw, bool)
                        and float(placement_raw).is_integer()
                        and 1 <= int(placement_raw) <= 4
                    ):
                        placement = int(placement_raw)
                        has_placement = True
                        self.n_with_placement += 1
                    else:
                        placement = 0
                        has_placement = False
                    if policy_weight == 0.0:
                        self.n_value_only += 1
                    self.obs_list.append(obs)
                    self.cands_list.append(cands)
                    self.chosen_list.append(chosen)
                    self.ret_list.append(ret)
                    self.pi_list.append(pi_arr)
                    self.farm_value_list.append(farm_value)
                    self.farm_value_mask.append(has_farm_value)
                    self.reward_pi_list.append(reward_pi_arr)
                    self.reward_pi_mask.append(has_reward_pi)
                    self.policy_weight_list.append(policy_weight)
                    self.route_mode_list.append(route_mode)
                    self.route_mode_mask.append(has_route_mode)
                    self.placement_list.append(placement)
                    self.placement_mask.append(has_placement)

        if not self.obs_list:
            raise ValueError(f"No samples loaded from {data_dir}")

        print(
            f"Loaded {len(self.obs_list)} samples from {len(jsonl_files)} file(s) "
            f"({self.n_with_pi} with MCTS pi targets, "
            f"{self.n_with_farm_value} with farmValue, {self.n_with_reward_pi} with rewardPi, "
            f"{self.n_with_route_mode} with routeMode, "
            f"{self.n_with_placement} with placement, "
            f"{self.n_value_only} value-only, "
            f"{self.n_missing_obs} skipped without {obs_key!r})"
        )

    def __len__(self) -> int:
        return len(self.obs_list)

    def __getitem__(self, idx: int) -> tuple:
        return (
            self.obs_list[idx],
            self.cands_list[idx],
            self.chosen_list[idx],
            self.ret_list[idx],
            self.pi_list[idx],
            self.farm_value_list[idx],
            self.farm_value_mask[idx],
            self.reward_pi_list[idx],
            self.reward_pi_mask[idx],
            self.policy_weight_list[idx],
            self.route_mode_list[idx],
            self.route_mode_mask[idx],
            self.placement_list[idx],
            self.placement_mask[idx],
        )


def collate_fn(batch: list[tuple]) -> tuple[torch.Tensor, ...]:
    """
    Pad cands (and the pi targets) to the maximum number of candidates in the batch.
    Returns: obs, cands_padded, mask, chosen, rets, pi_padded
    """
    obs_list, cands_list, chosen_list, ret_list, pi_list, farm_value_list, farm_mask_list, reward_pi_list, reward_mask_list, policy_weight_list, route_mode_list, route_mask_list, placement_list, placement_mask_list = zip(*batch)

    obs = torch.from_numpy(np.stack(obs_list))  # (B, obs_dim)
    max_cands = max(c.shape[0] for c in cands_list)
    act_dim = cands_list[0].shape[1]

    B = len(cands_list)
    cands_padded = np.zeros((B, max_cands, act_dim), dtype=np.float32)
    pi_padded = np.zeros((B, max_cands), dtype=np.float32)
    reward_pi_padded = np.zeros((B, max_cands), dtype=np.float32)
    mask = np.zeros((B, max_cands), dtype=bool)

    for i, c in enumerate(cands_list):
        n = c.shape[0]
        cands_padded[i, :n] = c
        pi_padded[i, :n] = pi_list[i]
        reward_pi_padded[i, :n] = reward_pi_list[i]
        mask[i, :n] = True

    cands_t = torch.from_numpy(cands_padded)          # (B, max_cands, act_dim)
    mask_t = torch.from_numpy(mask)                   # (B, max_cands)
    chosen_t = torch.tensor(chosen_list, dtype=torch.long)  # (B,)
    rets_t = torch.tensor(ret_list, dtype=torch.float32)    # (B,)
    pi_t = torch.from_numpy(pi_padded)                # (B, max_cands)
    farm_t = torch.tensor(farm_value_list, dtype=torch.float32)  # (B,)
    farm_mask_t = torch.tensor(farm_mask_list, dtype=torch.bool)  # (B,)
    reward_pi_t = torch.from_numpy(reward_pi_padded)  # (B, max_cands)
    reward_mask_t = torch.tensor(reward_mask_list, dtype=torch.bool)  # (B,)
    policy_weight_t = torch.tensor(policy_weight_list, dtype=torch.float32)  # (B,)
    route_mode_t = torch.tensor(route_mode_list, dtype=torch.float32)  # (B,)
    route_mask_t = torch.tensor(route_mask_list, dtype=torch.bool)  # (B,)
    placement_t = torch.tensor(placement_list, dtype=torch.long)  # (B,) 0 = unknown
    placement_mask_t = torch.tensor(placement_mask_list, dtype=torch.bool)  # (B,)

    return obs, cands_t, mask_t, chosen_t, rets_t, pi_t, farm_t, farm_mask_t, reward_pi_t, reward_mask_t, policy_weight_t, route_mode_t, route_mask_t, placement_t, placement_mask_t


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def compute_baseline(dataset: DecisionDataset) -> float:
    """Running mean of ret over the entire dataset."""
    return float(np.mean(dataset.ret_list))


def load_json_weights_into(model: CandidateScorer, path: Path) -> bool:
    """Warm-start: load a previously exported policy.json into `model` (same architecture).
    Returns True on success. Lets each AlphaZero iteration CONTINUE from the last net (monotonic
    improvement) instead of retraining from scratch, which keeps valueW=1.0 search stable."""
    try:
        with open(path) as f:
            w = json.load(f)
        if int(w.get("obs_dim", -1)) != model.obs_dim or int(w.get("act_dim", -1)) != model.act_dim:
            return False
        trunk_linears = [m for m in model.trunk if isinstance(m, torch.nn.Linear)]
        value_linears = [m for m in model.value_head if isinstance(m, torch.nn.Linear)]
        farm_value_linears = [m for m in model.farm_value_head if isinstance(m, torch.nn.Linear)]
        route_mode_linears = [m for m in model.route_mode_head if isinstance(m, torch.nn.Linear)]
        reward_pick_linears = [m for m in model.reward_pick_head if isinstance(m, torch.nn.Linear)]
        if len(trunk_linears) != len(w["trunk"]) or len(value_linears) != len(w["value"]):
            return False
        with torch.no_grad():
            for lin, d in zip(trunk_linears, w["trunk"]):
                W = torch.tensor(d["W"], dtype=torch.float32)
                b = torch.tensor(d["b"], dtype=torch.float32)
                if lin.weight.shape != W.shape:
                    return False
                lin.weight.copy_(W)
                lin.bias.copy_(b)
            for lin, d in zip(value_linears, w["value"]):
                W = torch.tensor(d["W"], dtype=torch.float32)
                b = torch.tensor(d["b"], dtype=torch.float32)
                if lin.weight.shape != W.shape:
                    return False
                lin.weight.copy_(W)
                lin.bias.copy_(b)
            # Optional heads: absent in older checkpoints — leave their random init
            # (they train up from PPO aux losses) rather than failing the warm start.
            placement_linears = [m for m in model.placement_head if isinstance(m, torch.nn.Linear)]
            if "placement" in w and len(placement_linears) == len(w["placement"]):
                for lin, d in zip(placement_linears, w["placement"]):
                    W = torch.tensor(d["W"], dtype=torch.float32)
                    b = torch.tensor(d["b"], dtype=torch.float32)
                    if lin.weight.shape == W.shape:
                        lin.weight.copy_(W)
                        lin.bias.copy_(b)
            if "farm_value" in w and len(farm_value_linears) == len(w["farm_value"]):
                for lin, d in zip(farm_value_linears, w["farm_value"]):
                    W = torch.tensor(d["W"], dtype=torch.float32)
                    b = torch.tensor(d["b"], dtype=torch.float32)
                    if lin.weight.shape != W.shape:
                        break
                    lin.weight.copy_(W)
                    lin.bias.copy_(b)
            if "route_mode" in w and len(route_mode_linears) == len(w["route_mode"]):
                for lin, d in zip(route_mode_linears, w["route_mode"]):
                    W = torch.tensor(d["W"], dtype=torch.float32)
                    b = torch.tensor(d["b"], dtype=torch.float32)
                    if lin.weight.shape != W.shape:
                        break
                    lin.weight.copy_(W)
                    lin.bias.copy_(b)
            if "reward_pick" in w and len(reward_pick_linears) == len(w["reward_pick"]):
                for lin, d in zip(reward_pick_linears, w["reward_pick"]):
                    W = torch.tensor(d["W"], dtype=torch.float32)
                    b = torch.tensor(d["b"], dtype=torch.float32)
                    if lin.weight.shape != W.shape:
                        break
                    lin.weight.copy_(W)
                    lin.bias.copy_(b)
        return True
    except Exception as e:  # noqa: BLE001 — warm-start is best-effort
        print(f"warm-start skipped: {e}")
        return False


def hidden_sizes_from_checkpoint(path: Path) -> tuple[tuple[int, ...], tuple[int, ...]] | None:
    """Infer model widths from an exported checkpoint."""
    try:
        with open(path) as f:
            w = json.load(f)
        trunk = w.get("trunk")
        value = w.get("value")
        if not isinstance(trunk, list) or not isinstance(value, list):
            return None
        trunk_hidden = tuple(len(layer["W"]) for layer in trunk[:-1] if isinstance(layer.get("W"), list))
        value_hidden = tuple(len(layer["W"]) for layer in value[:-1] if isinstance(layer.get("W"), list))
        return trunk_hidden, value_hidden
    except Exception as e:  # noqa: BLE001 — architecture inference is best-effort
        print(f"checkpoint architecture inference skipped: {e}")
        return None


def parse_hidden_sizes(spec: str) -> tuple[int, ...]:
    """Argparse type for comma-separated positive MLP widths."""
    try:
        widths = tuple(int(part.strip()) for part in spec.split(",") if part.strip())
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"hidden widths must be comma-separated integers, got {spec!r}"
        ) from exc
    if not widths or any(width <= 0 for width in widths):
        raise argparse.ArgumentTypeError(
            f"hidden widths must be one or more positive integers, got {spec!r}"
        )
    return widths


def build_policy_model(
    obs_dim: int,
    act_dim: int,
    device: torch.device,
    out_path: Path,
    init_from: Path | None,
    warm_start: bool,
    trunk_hidden: tuple[int, ...] | None = None,
    value_hidden: tuple[int, ...] | None = None,
) -> CandidateScorer:
    """Build v1, then optionally warm-start it.

    Explicit widths win over checkpoint inference and ARC_HIDDEN defaults. If they
    differ from a warm-start checkpoint, loading is visibly skipped as an
    architecture mismatch; this is intentional for controlled size sweeps.
    """
    init_path = init_from if init_from is not None else (out_path if out_path.exists() else None)
    inferred_hidden = hidden_sizes_from_checkpoint(init_path) if init_path is not None else None
    resolved_trunk = trunk_hidden if trunk_hidden is not None else (
        inferred_hidden[0] if inferred_hidden else None
    )
    resolved_value = value_hidden if value_hidden is not None else (
        inferred_hidden[1] if inferred_hidden else None
    )
    model = build_model(
        obs_dim,
        act_dim,
        device,
        trunk_hidden=resolved_trunk,
        value_hidden=resolved_value,
    )
    print(
        f"v1 architecture: trunk={model.trunk_hidden}, value={model.value_hidden} "
        f"(explicit trunk={trunk_hidden is not None}, value={value_hidden is not None})"
    )
    if warm_start and init_path is not None and init_path.exists():
        # load_json_weights_into is intentionally best-effort and may discover a
        # deeper-layer mismatch after copying an earlier layer. Restore the fresh
        # initialization on any mismatch so a size-sweep run is never a silent
        # partially warm-started hybrid.
        fresh_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        ok = load_json_weights_into(model, init_path)
        if not ok:
            model.load_state_dict(fresh_state)
        print(f"warm-start from {init_path}: {'OK' if ok else 'skipped (mismatch)'}")
    return model


# ---------------------------------------------------------------------------
# Model v2 (entity set-transformer, arc-entity-scorer-v2 checkpoints)
# ---------------------------------------------------------------------------

def check_out_format(model_version: str, out_path: Path, init_from: Path | None) -> None:
    """v2 checkpoints are .pt (+ manifest); the TS JSON export is v1-only."""
    if model_version == "v2":
        if out_path.suffix != ".pt":
            raise ValueError(
                f"--model v2 writes arc-entity-scorer-v2 .pt checkpoints; --out {out_path} "
                "must end in .pt (the arc-cand-scorer-v1 JSON export cannot hold a transformer)"
            )
        if init_from is not None and init_from.suffix != ".pt":
            raise ValueError(f"--model v2 --init-from {init_from} must be a .pt checkpoint")
    else:
        if out_path.suffix == ".pt":
            raise ValueError(
                f"--model v1 exports arc-cand-scorer-v1 JSON; --out {out_path} is a .pt "
                "(did you mean --model v2?)"
            )
        if init_from is not None and init_from.suffix == ".pt":
            raise ValueError(f"--model v1 --init-from {init_from} is a .pt (did you mean --model v2?)")


def resolve_v2_spec(data_dir: Path) -> tuple["ObsV2Spec", int]:  # noqa: F821 — lazy import
    """
    Resolve the arc-obs-v2 layout + act_dim for a dataset directory.
    Preference order: meta.json `obs_v2` sub-object (the convention used by
    bc_warmstart_v2.py) > meta.json that IS an obsV2Meta blob (flatHeader at top
    level) > the self-describing header of the first row carrying `obsV2`.
    """
    from obs_v2 import ObsV2Spec

    meta: dict[str, Any] = {}
    meta_path = data_dir / "meta.json"
    if meta_path.exists():
        with open(meta_path) as f:
            meta = json.load(f)

    spec = None
    if isinstance(meta.get("obs_v2"), dict):
        spec = ObsV2Spec.from_meta(meta["obs_v2"])
    elif "flatHeader" in meta:
        spec = ObsV2Spec.from_meta(meta)
    act_dim = meta.get("act_dim")

    if spec is None or act_dim is None:
        for fpath in sample_files(data_dir):
            with open(fpath) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(rec, dict):
                        continue
                    if act_dim is None and isinstance(rec.get("cands"), list) and rec["cands"]:
                        act_dim = len(rec["cands"][0])
                    if spec is None and "obsV2" in rec:
                        spec = ObsV2Spec.from_flat(rec["obsV2"])
                    if spec is not None and act_dim is not None:
                        break
            if spec is not None and act_dim is not None:
                break
        if spec is None:
            raise ValueError(
                f"{data_dir}: no meta.json obs_v2 block and no rows carrying obsV2 — "
                "cannot resolve the arc-obs-v2 layout"
            )
        if act_dim is None:
            raise ValueError(f"{data_dir}: could not resolve act_dim from meta.json or data rows")
    return spec, int(act_dim)


def build_policy_model_v2(
    data_dir: Path,
    device: torch.device,
    out_path: Path,
    init_from: Path | None,
    warm_start: bool,
    d_model: int,
    layers: int,
    heads: int,
):
    """v2 counterpart of build_policy_model: EntityCandidateScorer with .pt warm start.
    On resume the architecture comes from the checkpoint config; the d_model/layers/
    heads flags only shape a fresh model."""
    from model_v2 import build_model_v2, load_checkpoint

    spec, act_dim = resolve_v2_spec(data_dir)
    init_path = init_from if init_from is not None else (out_path if out_path.exists() else None)
    if warm_start and init_path is not None and Path(init_path).exists():
        try:
            model = load_checkpoint(init_path, device, spec=spec)
            print(f"warm-start from {init_path}: OK (architecture from checkpoint)")
            return model, spec, act_dim
        except Exception as e:  # noqa: BLE001
            if init_from is not None:
                raise  # an explicit --init-from that doesn't load is an error, not a fallback
            print(f"warm-start skipped: {e}")
    # seed=None: don't let build_model_v2's convenience seeding stomp the global
    # RNG mid-run (it would also freeze the DataLoader shuffle order).
    model = build_model_v2(
        spec, act_dim, device, d_model=d_model, layers=layers, heads=heads, seed=None
    )
    return model, spec, act_dim


# ---------------------------------------------------------------------------
# Divergence guards (PPO/AWR explosions must never reach a checkpoint on disk)
# ---------------------------------------------------------------------------

def model_is_finite(model: torch.nn.Module) -> bool:
    return model_parameters_are_finite(model)


def snapshot_state(model: torch.nn.Module) -> dict:
    """CPU copy of the state dict — the rolling restore point for the NaN guard."""
    return {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}


def assert_finite_weights(model: torch.nn.Module, context: str) -> None:
    """A corrupt checkpoint must never reach disk (a NaN-weights JSON crashed
    the fair-rules league's actors at gen 13)."""
    for name, t in model.state_dict().items():
        if not torch.isfinite(t).all():
            raise ValueError(
                f"{context}: non-finite values in parameter {name!r} — refusing to "
                "write a corrupt checkpoint. Training diverged; lower --lr or keep "
                "--max-grad-norm enabled."
            )


def train(
    data_dir: Path,
    out_path: Path,
    epochs: int = 8,
    beta: float = 1.0,
    batch_size: int = 256,
    lr: float = 1e-3,
    mode: str = "awr",
    policy_coef: float = 1.0,
    value_coef: float = 0.5,
    farm_value_coef: float = 0.0,
    reward_pick_coef: float = 0.0,
    route_mode_coef: float = 0.0,
    warm_start: bool = True,
    init_from: Path | None = None,
    gamma: float = 0.997,
    gae_lambda: float = 0.95,
    clip_eps: float = 0.2,
    entropy_coef: float = 0.01,
    entropy_anneal: bool = False,
    value_clip_eps: float = 0.0,
    target_kl: float | None = None,
    kl_ref_coef: float = 0.0,
    lr_schedule: str = "const",
    placement_rewards: str = "1.0,0.3,-0.3,-1.0",
    win_bonus: float = 0.0,
    win_bonus_halflife: float = 0.0,
    all_fallen_loss: float = 0.0,
    strategic_mc_coef: float = 0.0,
    strategic_mc_gamma: float = 1.0,
    strategic_outcome_coef: float = 0.0,
    model_version: str = "v1",
    hidden: tuple[int, ...] | None = None,
    value_hidden: tuple[int, ...] | None = None,
    placement_coef: float = 0.1,
    v2_d_model: int = 128,
    v2_layers: int = 3,
    v2_heads: int = 4,
    max_grad_norm: float = 1.0,
) -> list[dict]:
    """Train and export; returns per-epoch metric dicts (used by tests)."""
    device = get_device()
    print(f"Device: {device}  mode={mode}  model={model_version}")
    check_out_format(model_version, out_path, init_from)
    if model_version != "v1" and (hidden is not None or value_hidden is not None):
        raise ValueError("--hidden/--value-hidden configure only --model v1; use --v2-* for v2")
    # Both models expose placement auxiliaries with different contracts: v1 has
    # a 4-way CE head; v2 has per-seat-token ordinal regression.
    effective_placement_coef = placement_coef
    # Paired-row contract: v2 reads the flat arc-obs-v2 array from `obsV2`;
    # `obs` stays the current v1 83-float summary for the v1 net / distillation.
    obs_key = "obsV2" if model_version == "v2" else "obs"

    def export_model(model, obs_dim: int, act_dim: int) -> None:
        if model_version == "v2":
            from model_v2 import save_checkpoint

            # save_checkpoint lives in model_v2.py (not this file's to change);
            # the guard sits in front of it so no trainer path can write NaNs.
            assert_finite_weights(model, "save_checkpoint")
            manifest = save_checkpoint(model, out_path)
            print(f"\nCheckpoint written: {out_path} (+ {manifest.name})")
        else:
            export_weights(model, obs_dim, act_dim, out_path)
            print(f"\nWeights exported to: {out_path}")

    if mode == "ppo":
        from ppo import load_trajectory_buffer, parse_placement_rewards, train_ppo

        buffer = load_trajectory_buffer(
            data_dir,
            gamma=gamma,
            gae_lambda=gae_lambda,
            placement_rewards=parse_placement_rewards(placement_rewards),
            win_bonus=win_bonus,
            win_bonus_halflife=win_bonus_halflife,
            all_fallen_loss=all_fallen_loss,
            strategic_mc_coef=strategic_mc_coef,
            strategic_mc_gamma=strategic_mc_gamma,
            strategic_outcome_coef=strategic_outcome_coef,
            obs_key=obs_key,
        )
        if model_version == "v2":
            model, spec, act_dim = build_policy_model_v2(
                data_dir, device, out_path, init_from, warm_start, v2_d_model, v2_layers, v2_heads
            )
            obs_dim = spec.flat_length
        else:
            obs_dim, act_dim = load_dims_from_meta(data_dir)
            model = build_policy_model(
                obs_dim,
                act_dim,
                device,
                out_path,
                init_from,
                warm_start,
                trunk_hidden=hidden,
                value_hidden=value_hidden,
            )
        print(f"obs_dim={obs_dim}, act_dim={act_dim}")
        history = train_ppo(
            model,
            buffer,
            device,
            epochs=epochs,
            batch_size=batch_size,
            lr=lr,
            clip_eps=clip_eps,
            policy_coef=policy_coef,
            value_coef=value_coef,
            farm_value_coef=farm_value_coef,
            reward_pick_coef=reward_pick_coef,
            route_mode_coef=route_mode_coef,
            entropy_coef=entropy_coef,
            entropy_anneal=entropy_anneal,
            value_clip_eps=value_clip_eps,
            target_kl=target_kl,
            kl_ref_coef=kl_ref_coef,
            lr_schedule=lr_schedule,
            placement_coef=effective_placement_coef,
            max_grad_norm=max_grad_norm,
        )
        export_model(model, obs_dim, act_dim)
        return history

    # Load data
    dataset = DecisionDataset(data_dir, obs_key=obs_key)
    baseline = compute_baseline(dataset)
    print(f"Baseline return (mean ret): {baseline:.4f}")

    if model_version == "v2":
        model, spec, act_dim = build_policy_model_v2(
            data_dir, device, out_path, init_from, warm_start, v2_d_model, v2_layers, v2_heads
        )
        obs_dim = spec.flat_length
    else:
        obs_dim, act_dim = load_dims_from_meta(data_dir)
        model = build_policy_model(
            obs_dim,
            act_dim,
            device,
            out_path,
            init_from,
            warm_start,
            trunk_hidden=hidden,
            value_hidden=value_hidden,
        )
    print(f"obs_dim={obs_dim}, act_dim={act_dim}")

    loader = DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=True,
        collate_fn=collate_fn,
        drop_last=False,
    )

    if effective_placement_coef > 0:
        from ppo import placement_aux_loss, placement_aux_loss_v1

    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    history: list[dict] = []
    # Rolling restore point: refreshed at every finite epoch boundary, so a
    # mid-epoch divergence loses at most one epoch instead of the whole run.
    last_finite = snapshot_state(model)
    halted = False

    for epoch in range(1, epochs + 1):
        model.train()
        total_policy_loss = 0.0
        total_value_loss = 0.0
        total_farm_value_loss = 0.0
        total_reward_pick_loss = 0.0
        total_route_mode_loss = 0.0
        total_placement_loss = 0.0
        total_samples = 0
        correct = 0

        for obs, cands, mask, chosen, rets, pi, farm_value, farm_mask, reward_pi, reward_mask, policy_weight, route_mode, route_mask, placement, placement_mask in loader:
            obs = obs.to(device)
            cands = cands.to(device)
            mask = mask.to(device)
            chosen = chosen.to(device)
            rets = rets.to(device)
            pi = pi.to(device)
            farm_value = farm_value.to(device)
            farm_mask = farm_mask.to(device)
            reward_pi = reward_pi.to(device)
            reward_mask = reward_mask.to(device)
            policy_weight = policy_weight.to(device)
            route_mode = route_mode.to(device)
            route_mask = route_mask.to(device)
            placement = placement.to(device)
            placement_mask = placement_mask.to(device)

            logits, probs, value = model(obs, cands, mask)
            log_probs = F.log_softmax(logits, dim=-1)  # (B, max_cands), padded = -inf → 0 prob

            if mode == "alphazero":
                # Policy loss = cross-entropy to the MCTS visit distribution π (the search-improved
                # target). H(π, p) = -Σ_a π_a log p_a, summed over candidates, meaned over the batch.
                # Padded candidates have π=0 so they contribute nothing.
                policy_loss = (policy_weight * (-(pi * log_probs).sum(dim=-1))).mean()
            else:
                # AWR: advantage-weighted cross-entropy on the chosen action.
                with torch.no_grad():
                    awr_w = torch.exp(beta * (rets - baseline)).clamp(0.0, 20.0)
                chosen_log_prob = log_probs.gather(1, chosen.unsqueeze(1)).squeeze(1)
                policy_loss = -(policy_weight * awr_w * chosen_log_prob).mean()

            # --- Value loss: MSE to the (outcome / return) target ---
            value_loss = F.mse_loss(value, rets)

            farm_loss = torch.zeros((), dtype=torch.float32, device=device)
            if farm_value_coef > 0 and farm_mask.any():
                pred_farm = model.farm_value(obs)
                farm_loss = F.mse_loss(pred_farm[farm_mask], farm_value[farm_mask])

            reward_loss = torch.zeros((), dtype=torch.float32, device=device)
            if reward_pick_coef > 0 and reward_mask.any():
                reward_logits = model.reward_pick_logits(obs, cands, mask)
                reward_log_probs = F.log_softmax(reward_logits, dim=-1)
                per = -(reward_pi * reward_log_probs).sum(dim=-1)
                reward_loss = per[reward_mask].mean()

            route_loss = torch.zeros((), dtype=torch.float32, device=device)
            if route_mode_coef > 0 and route_mask.any():
                route_logits = model.route_mode_logits(obs)
                route_loss = F.binary_cross_entropy_with_logits(route_logits[route_mask], route_mode[route_mask])

            placement_loss = torch.zeros((), dtype=torch.float32, device=device)
            if effective_placement_coef > 0 and placement_mask.any():
                # v1 (4-way CE) vs v2 (per-seat-token regression). Dispatch on the
                # public prediction method: v2 also owns a module named placement_head.
                if hasattr(model, "placement_head_logits"):
                    placement_loss = placement_aux_loss_v1(model, obs, placement, placement_mask)
                elif hasattr(model, "placement_logits"):
                    placement_loss = placement_aux_loss(model, obs, placement, placement_mask)

            # --- Total ---
            loss = (
                policy_coef * policy_loss
                + value_coef * value_loss
                + farm_value_coef * farm_loss
                + reward_pick_coef * reward_loss
                + route_mode_coef * route_loss
                + effective_placement_coef * placement_loss
            )

            optimizer.zero_grad()
            loss.backward()
            if max_grad_norm > 0:
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_grad_norm)
            optimizer.step()
            if not model_is_finite(model):
                print(
                    f"WARNING: non-finite weights after a step in epoch {epoch} — "
                    "halting and restoring the last finite snapshot",
                    file=sys.stderr,
                )
                model.load_state_dict(last_finite)
                halted = True
                break

            # Accuracy: argmax of logits (among valid candidates)
            # Zero out invalid candidates by setting logits to -inf before argmax
            pred = logits.argmax(dim=-1)  # (B,)
            correct += (pred == chosen).sum().item()
            total_samples += len(chosen)

            total_policy_loss += policy_loss.item() * len(chosen)
            total_value_loss += value_loss.item() * len(chosen)
            total_farm_value_loss += farm_loss.item() * len(chosen)
            total_reward_pick_loss += reward_loss.item() * len(chosen)
            total_route_mode_loss += route_loss.item() * len(chosen)
            total_placement_loss += placement_loss.item() * len(chosen)

        if halted:
            break
        avg_policy = total_policy_loss / total_samples
        avg_value = total_value_loss / total_samples
        avg_farm = total_farm_value_loss / total_samples
        avg_reward = total_reward_pick_loss / total_samples
        avg_route = total_route_mode_loss / total_samples
        avg_placement = total_placement_loss / total_samples
        accuracy = correct / total_samples

        print(
            f"Epoch {epoch}/{epochs} | "
            f"policy_loss={avg_policy:.4f} | "
            f"value_loss={avg_value:.4f} | "
            f"farm_value_loss={avg_farm:.4f} | "
            f"reward_pick_loss={avg_reward:.4f} | "
            f"route_mode_loss={avg_route:.4f} | "
            f"placement_loss={avg_placement:.4f} | "
            f"top1_acc={accuracy:.3f}"
        )
        history.append({
            "policy_loss": avg_policy,
            "value_loss": avg_value,
            "farm_value_loss": avg_farm,
            "reward_pick_loss": avg_reward,
            "route_mode_loss": avg_route,
            "placement_loss": avg_placement,
            "top1_acc": accuracy,
        })
        last_finite = snapshot_state(model)

    export_model(model, obs_dim, act_dim)
    return history


# ---------------------------------------------------------------------------
# Weight export
# ---------------------------------------------------------------------------

def _linear_to_dict(layer: torch.nn.Linear) -> dict:
    """Serialize a Linear layer to W (out x in list-of-lists) and b (list)."""
    W = layer.weight.detach().cpu().float().tolist()  # out_features x in_features
    b = layer.bias.detach().cpu().float().tolist()    # out_features
    return {"W": W, "b": b}


def export_weights(
    model: CandidateScorer,
    obs_dim: int,
    act_dim: int,
    out_path: Path,
) -> None:
    """Export model weights to the TS-consumable JSON format."""
    assert_finite_weights(model, "export_weights")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Trunk: Sequential with Linear(trunk_in,128), ReLU, Linear(128,128), ReLU, Linear(128,1)
    # Extract only the Linear layers (indices 0, 2, 4)
    trunk_linears = [
        _linear_to_dict(layer)
        for layer in model.trunk
        if isinstance(layer, torch.nn.Linear)
    ]

    # Value/farm heads: Sequential with Linear(obs_dim,64), ReLU, Linear(64,1)
    value_linears = [
        _linear_to_dict(layer)
        for layer in model.value_head
        if isinstance(layer, torch.nn.Linear)
    ]
    farm_value_linears = [
        _linear_to_dict(layer)
        for layer in model.farm_value_head
        if isinstance(layer, torch.nn.Linear)
    ]
    route_mode_linears = [
        _linear_to_dict(layer)
        for layer in model.route_mode_head
        if isinstance(layer, torch.nn.Linear)
    ]
    reward_pick_linears = [
        _linear_to_dict(layer)
        for layer in model.reward_pick_head
        if isinstance(layer, torch.nn.Linear)
    ]
    placement_linears = [
        _linear_to_dict(layer)
        for layer in model.placement_head
        if isinstance(layer, torch.nn.Linear)
    ]
    all_linears = (
        trunk_linears + value_linears + farm_value_linears + route_mode_linears
        + reward_pick_linears + placement_linears
    )

    payload = {
        "format": "arc-cand-scorer-v1",
        "obs_dim": obs_dim,
        "act_dim": act_dim,
        "trunk": trunk_linears,
        # Hidden widths = out-features of every trunk Linear except the final scorer (self-describing).
        "trunk_hidden": [len(l["W"]) for l in trunk_linears[:-1]],
        "value_hidden": [len(l["W"]) for l in value_linears[:-1]],
        "value": value_linears,
        "farm_value": farm_value_linears,
        "route_mode": route_mode_linears,
        "reward_pick": reward_pick_linears,
        "placement": placement_linears,
        "aux_heads": {
            "farm_value": "obs -> scalar clean farm opportunity target",
            "reward_pick": "obs + candidate -> reward-pick target logits",
            "route_mode": "obs -> Fallen route mode logit, sigmoid=probability to hunt Good player",
            "placement": "obs -> 4-way final-placement logits (KataGo outcome aux)"
        },
        "params": sum(len(l["W"]) * len(l["W"][0]) + len(l["b"]) for l in all_linears),
    }

    with open(out_path, "w") as f:
        json.dump(payload, f)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train Arc Spirits candidate scorer")
    p.add_argument("--data", type=Path, default=Path("ml/data"), help="Directory with *.jsonl files")
    p.add_argument("--out", type=Path, default=Path("ml/weights/policy.json"), help="Output JSON path")
    p.add_argument("--epochs", type=int, default=8)
    p.add_argument("--beta", type=float, default=1.0, help="AWR temperature (0=behavior cloning)")
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--mode", choices=["awr", "alphazero", "ppo"], default="awr",
                   help="awr = advantage-weighted CE on chosen; alphazero = cross-entropy to MCTS pi; "
                        "ppo = clipped PPO on trajectory rows (gameId/stepIdx/rStep/done/logpOld/vPred)")
    p.add_argument("--value-coef", type=float, default=0.5, help="Weight on the value-head MSE loss")
    p.add_argument("--policy-coef", type=float, default=1.0, help="Weight on the main policy loss")
    p.add_argument("--farm-value-coef", type=float, default=0.0,
                   help="Weight on the auxiliary clean farm-value MSE loss")
    p.add_argument("--reward-pick-coef", type=float, default=0.0,
                   help="Weight on the auxiliary reward-pick policy cross-entropy loss")
    p.add_argument("--route-mode-coef", type=float, default=0.0,
                   help="Weight on the auxiliary Fallen route-mode BCE loss")
    # PPO flags (used only with --mode ppo). --epochs is the K passes over the
    # rollout buffer; --batch-size the minibatch size; --policy-coef/--value-coef
    # weight the surrogate and value losses as in the other modes.
    # gamma alone has a long horizon, but ordinary GAE policy credit also carries
    # lambda (default gamma*lambda ~= 0.947). --strategic-mc-coef selectively restores
    # complete-game credit on route/engine/conversion rows without applying noisy
    # Monte Carlo targets to every tactical decision.
    p.add_argument("--gamma", type=float, default=0.997, help="PPO discount factor")
    p.add_argument("--gae-lambda", type=float, default=0.95, help="GAE lambda")
    p.add_argument("--strategic-mc-coef", type=float, default=0.0,
                   help="Blend [0,1] from ordinary GAE toward full-episode Monte Carlo "
                        "advantages/value targets on rows marked strategic; 0 preserves PPO")
    p.add_argument("--strategic-mc-gamma", type=float, default=1.0,
                   help="Discount for strategic full-episode Monte Carlo returns (default 1)")
    p.add_argument("--strategic-outcome-coef", type=float, default=0.0,
                   help="Blend [0,1] from GAE toward pure final-placement advantage on strategic "
                        "rows, baselined by recorded placementProbs; excludes dense/build rewards")
    p.add_argument("--clip-eps", type=float, default=0.2, help="PPO surrogate clip epsilon")
    p.add_argument("--entropy-coef", type=float, default=0.01, help="PPO entropy bonus coefficient")
    p.add_argument("--entropy-anneal", action="store_true",
                   help="Linearly anneal the entropy coefficient to 0 over the epochs")
    p.add_argument("--value-clip-eps", type=float, default=0.0,
                   help=">0 enables PPO value clipping against the recorded vPred")
    p.add_argument("--kl-ref-coef", type=float, default=0.0,
                   help="KL(new||warm-start reference) penalty coefficient (piKL anchor; 0=off)")
    p.add_argument("--lr-schedule", choices=["const", "cosine"], default="const",
                   help="LR schedule across PPO epochs (cosine decays to 0.1*lr)")
    p.add_argument("--target-kl", type=float, default=None,
                   help="Early-stop the PPO epochs when approx KL(old||new) exceeds this")
    p.add_argument("--win-bonus", type=float, default=0.0,
                   help="Extra terminal reward on TRUE 30-VP wins (driver `won` rows; "
                        "distinguishes winning the game from out-placing the field)")
    p.add_argument("--win-bonus-halflife", type=float, default=0.0,
                   help="Tempo decay for --win-bonus (0=off): the bonus is multiplied by "
                        "0.5**(max(0,endRound-12)/R), so a round-12-or-earlier win pays full "
                        "and every R rounds later halves it (R=8: round 20 -> 0.5x, 28 -> 0.25x)")
    p.add_argument("--placement-rewards", type=str, default="1.0,0.3,-0.3,-1.0",
                   help="Terminal reward for placements 1-4, added to rStep on the done row")
    p.add_argument("--all-fallen-loss", type=float, default=0.0,
                   help="Terminal LOSS (negative) for EVERY seat when a game ends via the all-Fallen "
                        "collapse (no 30-VP finish); REPLACES the placement reward on those games so "
                        "racing to mutual Fallen pays nothing. 0=off (normal placement). Driver stamps "
                        "the allFallen flag on done rows.")
    # Model v2 (entity set-transformer) flags. --out/--init-from must be .pt for
    # v2; the arc-cand-scorer-v1 JSON export stays v1-only.
    p.add_argument("--model", dest="model_version", choices=["v1", "v2"], default="v1",
                   help="v1 = CandidateScorer MLP (JSON export); v2 = EntityCandidateScorer "
                        "set-transformer on flat arc-obs-v2 rows (.pt + manifest checkpoints)")
    p.add_argument(
        "--hidden",
        type=parse_hidden_sizes,
        default=None,
        help="v1 trunk hidden widths, comma-separated (for example 256,256). Explicit values "
             "override checkpoint-inferred and ARC_HIDDEN widths; a mismatched warm start is skipped.",
    )
    p.add_argument(
        "--value-hidden",
        type=parse_hidden_sizes,
        default=None,
        help="v1 value/aux hidden widths, comma-separated (for example 128). Explicit values "
             "override checkpoint-inferred and ARC_VALUE_HIDDEN widths.",
    )
    p.add_argument("--placement-coef", type=float, default=0.1,
                   help="Weight on the v2 placement aux loss (rows with `placement`; v1 ignores)")
    p.add_argument("--v2-d-model", type=int, default=128, help="v2 width (fresh models only)")
    p.add_argument("--v2-layers", type=int, default=3, help="v2 encoder layers (fresh models only)")
    p.add_argument("--v2-heads", type=int, default=4, help="v2 attention heads (fresh models only)")
    p.add_argument("--max-grad-norm", type=float, default=1.0,
                   help="Gradient clipping (clip_grad_norm_) in all modes; 0 disables")
    p.add_argument("--init-from", type=Path, default=None,
                   help="Optional checkpoint to warm-start from while exporting to --out")
    p.add_argument("--no-warm-start", dest="warm_start", action="store_false",
                   help="Train from scratch instead of continuing from the existing out_path weights")
    p.set_defaults(warm_start=True)
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    train(
        data_dir=args.data,
        out_path=args.out,
        epochs=args.epochs,
        beta=args.beta,
        batch_size=args.batch_size,
        lr=args.lr,
        mode=args.mode,
        policy_coef=args.policy_coef,
        value_coef=args.value_coef,
        farm_value_coef=args.farm_value_coef,
        reward_pick_coef=args.reward_pick_coef,
        route_mode_coef=args.route_mode_coef,
        warm_start=args.warm_start,
        init_from=args.init_from,
        gamma=args.gamma,
        gae_lambda=args.gae_lambda,
        clip_eps=args.clip_eps,
        entropy_coef=args.entropy_coef,
        entropy_anneal=args.entropy_anneal,
        value_clip_eps=args.value_clip_eps,
        target_kl=args.target_kl,
        kl_ref_coef=args.kl_ref_coef,
        lr_schedule=args.lr_schedule,
        placement_rewards=args.placement_rewards,
        win_bonus=args.win_bonus,
        win_bonus_halflife=args.win_bonus_halflife,
        all_fallen_loss=args.all_fallen_loss,
        strategic_mc_coef=args.strategic_mc_coef,
        strategic_mc_gamma=args.strategic_mc_gamma,
        strategic_outcome_coef=args.strategic_outcome_coef,
        model_version=args.model_version,
        hidden=args.hidden,
        value_hidden=args.value_hidden,
        placement_coef=args.placement_coef,
        v2_d_model=args.v2_d_model,
        v2_layers=args.v2_layers,
        v2_heads=args.v2_heads,
        max_grad_norm=args.max_grad_norm,
    )
