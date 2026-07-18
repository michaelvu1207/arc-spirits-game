"""
Behavior-cloning warm start for the v2 set-transformer (EntityCandidateScorer).

Trains ml/model_v2.py on the PINNED v2 row shape (docs/encoder-v2.md
§"PINNED DATA CONTRACT"): every row always carries the v1 `obs` (62 floats,
ignored here) and, when recorded at obs_version 2, an `obsV2` FLAT arc-obs-v2
array — that is what this trainer consumes:

    {"obs": [62 floats], "obsV2": [<flat v2, e.g. 3419 floats>],
     "cands": [[52]...], "chosen": i, "ret": r, ...}   # pi/farmValue/... ignored

Dataset meta contract (meta.json in the data dir):

    {"obs_dim": 62, "act_dim": 52, "obs_version": 2,
     "obs_v2": <obsV2Meta(catalog) block>}

The parser is built via ObsV2Spec.from_meta(meta["obs_v2"]) — the flat length
comes from that block, NOT from meta.obs_dim (which is always the v1 width).
Datasets without an obs_v2 block, or declaring obs_version != 2, are refused;
rows lacking obsV2 (v1-only rows mixed in) are skipped and counted. Every kept
row's embedded flat header is still validated during parsing.

Losses (warm start = imitation + value regression):
    CE(chosen | masked softmax over candidate logits) + value_coef * MSE(value, ret)

Output: an `arc-entity-scorer-v2` .pt checkpoint + manifest (model_v2.py
save_checkpoint) — NOT the TS arc-cand-scorer-v1 JSON; use ml/distill.py to get
a live-net-compatible export.

Usage:
    ml/.venv/bin/python ml/bc_warmstart_v2.py \
        --data ml/data_v2_champion --out ml/weights/v2_bc.pt --epochs 6
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

sys.path.insert(0, str(Path(__file__).parent))
from model import get_device
from model_v2 import EntityCandidateScorer, build_model_v2, save_checkpoint
from obs_v2 import ObsV2Spec
from ppo import binary_ece, reach30_multihorizon_minibatch_loss
from train import assert_finite_weights, v2_reach30_horizons


def load_spec_for_dataset(data_dir: Path) -> tuple[ObsV2Spec, int]:
    """Resolve the obs-v2 spec + act_dim for a dataset, refusing mismatches."""
    meta_path = data_dir / "meta.json"
    if not meta_path.exists():
        raise FileNotFoundError(f"{data_dir}: v2 datasets require meta.json")
    with open(meta_path) as f:
        meta = json.load(f)
    act_dim = int(meta["act_dim"])
    if "obs_v2" not in meta:
        raise ValueError(f"{meta_path}: v2 training requires an obs_v2 block (pinned contract)")
    if "obs_version" in meta and int(meta["obs_version"]) != 2:
        raise ValueError(f"{meta_path}: obs_version {meta['obs_version']} != 2")
    spec = ObsV2Spec.from_meta(meta["obs_v2"])
    return spec, act_dim


class DecisionDatasetV2(Dataset):
    """JSONL decisions with flat-v2 obs. Padding happens at collation time."""

    def __init__(self, data_dir: Path, spec: ObsV2Spec) -> None:
        self.spec = spec
        self.obs_list: list[np.ndarray] = []
        self.cands_list: list[np.ndarray] = []
        self.chosen_list: list[int] = []
        self.ret_list: list[float] = []
        self.game_id_list: list[str | None] = []
        outcomes: dict[str, tuple[float, int, int]] = {}
        skipped = 0
        skipped_no_v2 = 0

        jsonl_files = sorted(
            p for p in data_dir.rglob("*.jsonl")
            if p.is_file() and not p.name.startswith("games-")
        )
        if not jsonl_files:
            raise FileNotFoundError(f"No *.jsonl files found in {data_dir}")
        for fpath in jsonl_files:
            with open(fpath) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:  # tolerate a partial trailing line during concurrent appends
                        rec: dict[str, Any] = json.loads(line)
                        if "obsV2" not in rec:  # v1-only row mixed into the dataset
                            skipped_no_v2 += 1
                            continue
                        obs = np.asarray(rec["obsV2"], dtype=np.float32)
                        cands = np.asarray(rec["cands"], dtype=np.float32)
                        chosen = int(rec["chosen"])
                        ret = float(rec.get("ret", 0.0))
                        game_id = rec.get("gameId") if isinstance(rec.get("gameId"), str) else None
                        raw_target = rec.get("reach30Target")
                        if raw_target is not None:
                            if game_id is None or raw_target not in (0, 1, False, True):
                                raise ValueError("malformed reach30Target/gameId")
                            horizon = int(rec["reach30Horizon"])
                            finish_round = int(rec.get("endRound", 0))
                            if horizon <= 0 or (bool(raw_target) and finish_round <= 0):
                                raise ValueError("malformed reach30 horizon/finish round")
                            outcome = (float(bool(raw_target)), horizon, finish_round)
                            if game_id in outcomes and outcomes[game_id] != outcome:
                                raise ValueError("inconsistent reach30 outcome within game")
                            outcomes[game_id] = outcome
                    except (json.JSONDecodeError, KeyError, ValueError, TypeError):
                        skipped += 1
                        continue
                    if obs.shape != (spec.flat_length,) or cands.ndim != 2 or not (0 <= chosen < cands.shape[0]):
                        skipped += 1
                        continue
                    self.obs_list.append(obs)
                    self.cands_list.append(cands)
                    self.chosen_list.append(chosen)
                    self.ret_list.append(ret)
                    self.game_id_list.append(game_id)
        self.skipped_no_v2 = skipped_no_v2
        if not self.obs_list:
            raise ValueError(
                f"{data_dir}: no usable v2 rows (skipped {skipped} malformed, {skipped_no_v2} without obsV2)"
            )
        if skipped or skipped_no_v2:
            print(
                f"dataset: kept {len(self.obs_list)} rows, skipped {skipped} malformed, "
                f"{skipped_no_v2} without obsV2"
            )
        counts = Counter(game_id for game_id in self.game_id_list if game_id is not None)
        labelled_horizons = {outcome[1] for outcome in outcomes.values()}
        if len(labelled_horizons) > 1:
            raise ValueError(f"BC data mixes reach30 horizons {sorted(labelled_horizons)}")
        self.reach30_horizon = next(iter(labelled_horizons), None)
        self.reach30_target = np.zeros(len(self.obs_list), dtype=np.float32)
        self.reach30_mask = np.zeros(len(self.obs_list), dtype=bool)
        self.reach30_finish_round = np.zeros(len(self.obs_list), dtype=np.int64)
        self.reach30_weight = np.zeros(len(self.obs_list), dtype=np.float32)
        for index, game_id in enumerate(self.game_id_list):
            if game_id is None or game_id not in outcomes:
                continue
            target, _horizon, finish_round = outcomes[game_id]
            self.reach30_target[index] = target
            self.reach30_mask[index] = True
            self.reach30_finish_round[index] = finish_round if target else 0
            self.reach30_weight[index] = 1.0 / counts[game_id]

    def __len__(self) -> int:
        return len(self.obs_list)

    def __getitem__(self, i: int):
        return (
            self.obs_list[i],
            self.cands_list[i],
            self.chosen_list[i],
            self.ret_list[i],
            self.reach30_target[i],
            self.reach30_mask[i],
            self.reach30_finish_round[i],
            self.reach30_weight[i],
        )


def collate(batch) -> tuple[torch.Tensor, ...]:
    obs = torch.from_numpy(np.stack([b[0] for b in batch]))
    max_c = max(b[1].shape[0] for b in batch)
    act_dim = batch[0][1].shape[1]
    cands = torch.zeros(len(batch), max_c, act_dim)
    mask = torch.zeros(len(batch), max_c, dtype=torch.bool)
    for i, sample in enumerate(batch):
        c = sample[1]
        cands[i, : c.shape[0]] = torch.from_numpy(c)
        mask[i, : c.shape[0]] = True
    chosen = torch.tensor([b[2] for b in batch], dtype=torch.long)
    ret = torch.tensor([b[3] for b in batch], dtype=torch.float32)
    # Normalize NumPy scalar subclasses explicitly. Some supported PyTorch
    # releases accept numpy.bool_ here and others raise TypeError.
    reach30_target = torch.tensor([float(b[4]) for b in batch], dtype=torch.float32)
    reach30_mask = torch.tensor([bool(b[5]) for b in batch], dtype=torch.bool)
    reach30_finish_round = torch.tensor([int(b[6]) for b in batch], dtype=torch.int64)
    reach30_weight = torch.tensor([float(b[7]) for b in batch], dtype=torch.float32)
    return (
        obs,
        cands,
        mask,
        chosen,
        ret,
        reach30_target,
        reach30_mask,
        reach30_finish_round,
        reach30_weight,
    )


def _evaluate(model, dl, device, horizons: tuple[int, ...] = ()) -> dict:
    model.eval()
    tot_ce = tot_v = tot_acc = n = 0.0
    reach_weighted = reach_weight = 0.0
    reach_scores: list[np.ndarray] = []
    reach_targets: list[np.ndarray] = []
    reach_weights: list[np.ndarray] = []
    with torch.no_grad():
        for (
            obs, cands, mask, chosen, ret,
            reach_target, reach_mask, finish_round, row_weight,
        ) in dl:
            obs, cands, mask = obs.to(device), cands.to(device), mask.to(device)
            chosen, ret = chosen.to(device), ret.to(device)
            logits, _, value = model(obs, cands, mask)
            b = obs.shape[0]
            tot_ce += F.cross_entropy(logits, chosen).item() * b
            tot_v += F.mse_loss(value, ret).item() * b
            tot_acc += (logits.argmax(dim=-1) == chosen).float().sum().item()
            n += b
            if horizons and bool(reach_mask.any()):
                reach_logits = model.reach30_all_logits(obs)
                horizon_tensor = torch.tensor(horizons, dtype=finish_round.dtype, device=device)
                nested = (
                    (reach_target.to(device) > 0.5).unsqueeze(1)
                    & (finish_round.to(device).unsqueeze(1) <= horizon_tensor.unsqueeze(0))
                ).to(reach_logits.dtype)
                per = F.binary_cross_entropy_with_logits(
                    reach_logits, nested, reduction="none"
                ).mean(dim=1)
                weights = row_weight.to(device) * reach_mask.to(device)
                reach_weighted += float((per * weights).sum().item())
                reach_weight += float(weights.sum().item())
                selected = reach_mask.cpu().numpy()
                reach_scores.append(torch.sigmoid(reach_logits).cpu().numpy()[selected])
                reach_targets.append(nested.cpu().numpy()[selected])
                reach_weights.append(row_weight.cpu().numpy()[selected])
    model.train()
    result = {"ce": tot_ce / n, "value_mse": tot_v / n, "acc": tot_acc / n}
    if horizons:
        result["reach30_nll"] = reach_weighted / reach_weight if reach_weight else 0.0
        by_horizon = {}
        if reach_scores:
            scores = np.concatenate(reach_scores).astype(np.float64)
            targets = np.concatenate(reach_targets).astype(np.float64)
            weights = np.concatenate(reach_weights).astype(np.float64)
            clipped = np.clip(scores, 1e-7, 1.0 - 1e-7)
            for column, horizon in enumerate(horizons):
                target = targets[:, column]
                score = scores[:, column]
                by_horizon[str(horizon)] = {
                    "nll": float(np.average(
                        -(target * np.log(clipped[:, column]) + (1 - target) * np.log(1 - clipped[:, column])),
                        weights=weights,
                    )),
                    "brier": float(np.average((score - target) ** 2, weights=weights)),
                    "ece": binary_ece(target, score, weights=weights),
                }
        result["reach30_by_horizon"] = by_horizon
    return result


def train_bc(
    data_dir: Path,
    out_path: Path,
    epochs: int = 6,
    batch_size: int = 64,
    lr: float = 3e-4,
    value_coef: float = 0.5,
    d_model: int = 128,
    layers: int = 3,
    heads: int = 4,
    seed: int = 0,
    val_frac: float = 0.0,
    val_data_dir: Path | None = None,
    reach30_coef: float = 0.0,
    max_grad_norm: float = 1.0,
    device: torch.device | None = None,
    model: EntityCandidateScorer | None = None,
) -> dict:
    """
    BC warm start; returns per-epoch stats. Pass `model` to continue training.
    With val_frac > 0, a seeded held-out split is scored every epoch and the
    checkpoint written at the end is the BEST-val-CE epoch, not the last one.
    """
    if device is None:
        device = get_device()
    spec, act_dim = load_spec_for_dataset(data_dir)
    ds = DecisionDatasetV2(data_dir, spec)
    if val_data_dir is not None and val_frac > 0:
        raise ValueError("use either val_data_dir or val_frac, not both")
    if reach30_coef < 0:
        raise ValueError("reach30_coef must be nonnegative")
    horizons = v2_reach30_horizons(ds.reach30_horizon) if reach30_coef > 0 else ()
    if reach30_coef > 0 and not horizons:
        raise ValueError("reach30_coef requires labelled solo objective episodes")
    if reach30_coef > 0 and val_frac > 0:
        raise ValueError(
            "reach30 training requires a disjoint val_data_dir or val_frac=0; "
            "row-level splitting breaks equal-episode weights"
        )
    gen = torch.Generator().manual_seed(seed)

    val_dl = None
    train_ds: Dataset = ds
    if val_data_dir is not None:
        val_spec, val_act_dim = load_spec_for_dataset(val_data_dir)
        if val_spec.header != spec.header or val_act_dim != act_dim:
            raise ValueError("validation data observation/action schema differs from training data")
        val_ds = DecisionDatasetV2(val_data_dir, val_spec)
        if horizons and val_ds.reach30_horizon != ds.reach30_horizon:
            raise ValueError("validation reach30 horizon differs from training data")
        val_dl = DataLoader(val_ds, batch_size=batch_size, shuffle=False, collate_fn=collate)
    elif val_frac > 0:
        n_val = max(1, int(len(ds) * val_frac))
        perm = torch.randperm(len(ds), generator=torch.Generator().manual_seed(seed + 1)).tolist()
        train_ds = torch.utils.data.Subset(ds, perm[n_val:])
        val_ds = torch.utils.data.Subset(ds, perm[:n_val])
        val_dl = DataLoader(val_ds, batch_size=batch_size, shuffle=False, collate_fn=collate)
    dl = DataLoader(train_ds, batch_size=batch_size, shuffle=True, collate_fn=collate, generator=gen)

    if model is None:
        model = build_model_v2(
            spec,
            act_dim,
            device=device,
            d_model=d_model,
            layers=layers,
            heads=heads,
            reach30_horizons=horizons,
            seed=seed,
        )
    elif horizons:
        model.enable_reach30_horizons(horizons)
    model = model.to(device).train()
    opt = torch.optim.Adam(model.parameters(), lr=lr)

    stats: dict = {"epochs": [], "samples": len(ds), "train_samples": len(train_ds)}
    if val_data_dir is not None:
        stats["val_samples"] = len(val_ds)
        stats["val_data"] = str(val_data_dir)
    reach_total_weight = float(ds.reach30_weight.sum())
    best_val_ce = float("inf")
    best_state: dict | None = None
    best_epoch = -1
    for epoch in range(epochs):
        tot_ce = tot_v = tot_acc = tot_reach = n = 0.0
        reach_updated = False
        for (
            obs, cands, mask, chosen, ret,
            reach_target, reach_mask, finish_round, row_weight,
        ) in dl:
            obs, cands, mask = obs.to(device), cands.to(device), mask.to(device)
            chosen, ret = chosen.to(device), ret.to(device)
            logits, _, value = model(obs, cands, mask)
            ce = F.cross_entropy(logits, chosen)
            v_loss = F.mse_loss(value, ret)
            reach_loss = torch.zeros((), dtype=torch.float32, device=device)
            if horizons and bool(reach_mask.any()):
                reach_loss = reach30_multihorizon_minibatch_loss(
                    model.reach30_all_logits(obs),
                    reach_target.to(device),
                    reach_mask.to(device),
                    row_weight.to(device),
                    finish_round.to(device),
                    horizons,
                    total_rows=len(train_ds),
                    total_episode_weight=reach_total_weight,
                )
                reach_updated = True
            loss = ce + value_coef * v_loss + reach30_coef * reach_loss
            opt.zero_grad()
            loss.backward()
            if max_grad_norm > 0:
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_grad_norm)
            opt.step()
            b = obs.shape[0]
            tot_ce += ce.item() * b
            tot_v += v_loss.item() * b
            tot_acc += (logits.argmax(dim=-1) == chosen).float().sum().item()
            tot_reach += reach_loss.item() * b
            n += b
        if reach_updated:
            model.reach30_trained = True
            model.reach30_horizon = ds.reach30_horizon
        ep = {
            "ce": tot_ce / n,
            "value_mse": tot_v / n,
            "acc": tot_acc / n,
            "reach30_loss": tot_reach / n,
        }
        line = (
            f"epoch {epoch + 1}/{epochs}  ce={ep['ce']:.4f}  acc={ep['acc']:.3f} "
            f"vmse={ep['value_mse']:.4f}  reach30={ep['reach30_loss']:.4f}"
        )
        if val_dl is not None:
            val = _evaluate(model, val_dl, device, horizons)
            ep["val_ce"], ep["val_acc"], ep["val_value_mse"] = val["ce"], val["acc"], val["value_mse"]
            line += f"  val_ce={val['ce']:.4f}  val_acc={val['acc']:.3f}"
            if horizons:
                ep["val_reach30_nll"] = val["reach30_nll"]
                ep["val_reach30_by_horizon"] = val["reach30_by_horizon"]
                line += f"  val_reach30={val['reach30_nll']:.4f}"
            if val["ce"] < best_val_ce:
                best_val_ce = val["ce"]
                best_epoch = epoch
                best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        stats["epochs"].append(ep)
        print(line, flush=True)

    if best_state is not None:
        model.load_state_dict(best_state)
        model = model.to(device)
        stats["best_epoch"] = best_epoch + 1
        stats["best_val_ce"] = best_val_ce
        print(f"restored best epoch {best_epoch + 1} (val_ce={best_val_ce:.4f})")
    model.eval()
    # Same guard as train.py's export paths: a diverged run must raise here,
    # never write a NaN checkpoint (the fair-rules league shipped one at gen 13).
    assert_finite_weights(model, "bc_warmstart_v2 save_checkpoint")
    manifest = save_checkpoint(model, out_path)
    stats["out"] = str(out_path)
    stats["manifest"] = str(manifest)
    print(f"checkpoint written: {out_path}")
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True, help="output .pt checkpoint path")
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--batch-size", type=int, default=64)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--value-coef", type=float, default=0.5)
    ap.add_argument("--d-model", type=int, default=128)
    ap.add_argument("--layers", type=int, default=3)
    ap.add_argument("--heads", type=int, default=4)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--val-frac", type=float, default=0.0, help="held-out fraction; best-val epoch is saved")
    ap.add_argument("--val-data", type=Path, default=None,
                    help="disjoint validation dataset; preferred over row-level --val-frac")
    ap.add_argument("--reach30-coef", type=float, default=0.0,
                    help="equal-episode 20/25/30-round objective-critic loss")
    ap.add_argument("--max-grad-norm", type=float, default=1.0,
                    help="Gradient clipping (clip_grad_norm_); 0 disables")
    ap.add_argument("--device", type=str, default=None, help="cpu / cuda / mps (default: auto)")
    ap.add_argument("--stats-out", type=Path, default=None, help="optional JSON file for the training curves")
    a = ap.parse_args()
    stats = train_bc(
        a.data,
        a.out,
        epochs=a.epochs,
        batch_size=a.batch_size,
        lr=a.lr,
        value_coef=a.value_coef,
        d_model=a.d_model,
        layers=a.layers,
        heads=a.heads,
        seed=a.seed,
        val_frac=a.val_frac,
        val_data_dir=a.val_data,
        reach30_coef=a.reach30_coef,
        max_grad_norm=a.max_grad_norm,
        device=torch.device(a.device) if a.device else None,
    )
    if a.stats_out is not None:
        a.stats_out.parent.mkdir(parents=True, exist_ok=True)
        with open(a.stats_out, "w") as f:
            json.dump(stats, f, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
