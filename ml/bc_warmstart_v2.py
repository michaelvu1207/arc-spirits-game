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
        skipped = 0
        skipped_no_v2 = 0

        jsonl_files = sorted(p for p in data_dir.rglob("*.jsonl") if p.is_file())
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

    def __len__(self) -> int:
        return len(self.obs_list)

    def __getitem__(self, i: int):
        return self.obs_list[i], self.cands_list[i], self.chosen_list[i], self.ret_list[i]


def collate(batch) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    obs = torch.from_numpy(np.stack([b[0] for b in batch]))
    max_c = max(b[1].shape[0] for b in batch)
    act_dim = batch[0][1].shape[1]
    cands = torch.zeros(len(batch), max_c, act_dim)
    mask = torch.zeros(len(batch), max_c, dtype=torch.bool)
    for i, (_, c, _, _) in enumerate(batch):
        cands[i, : c.shape[0]] = torch.from_numpy(c)
        mask[i, : c.shape[0]] = True
    chosen = torch.tensor([b[2] for b in batch], dtype=torch.long)
    ret = torch.tensor([b[3] for b in batch], dtype=torch.float32)
    return obs, cands, mask, chosen, ret


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
    device: torch.device | None = None,
    model: EntityCandidateScorer | None = None,
) -> dict:
    """BC warm start; returns per-epoch stats. Pass `model` to continue training."""
    if device is None:
        device = get_device()
    spec, act_dim = load_spec_for_dataset(data_dir)
    ds = DecisionDatasetV2(data_dir, spec)
    gen = torch.Generator().manual_seed(seed)
    dl = DataLoader(ds, batch_size=batch_size, shuffle=True, collate_fn=collate, generator=gen)

    if model is None:
        model = build_model_v2(spec, act_dim, device=device, d_model=d_model, layers=layers, heads=heads, seed=seed)
    model = model.to(device).train()
    opt = torch.optim.Adam(model.parameters(), lr=lr)

    stats: dict = {"epochs": [], "samples": len(ds)}
    for epoch in range(epochs):
        tot_ce = tot_v = tot_acc = n = 0.0
        for obs, cands, mask, chosen, ret in dl:
            obs, cands, mask = obs.to(device), cands.to(device), mask.to(device)
            chosen, ret = chosen.to(device), ret.to(device)
            logits, _, value = model(obs, cands, mask)
            ce = F.cross_entropy(logits, chosen)
            v_loss = F.mse_loss(value, ret)
            loss = ce + value_coef * v_loss
            opt.zero_grad()
            loss.backward()
            opt.step()
            b = obs.shape[0]
            tot_ce += ce.item() * b
            tot_v += v_loss.item() * b
            tot_acc += (logits.argmax(dim=-1) == chosen).float().sum().item()
            n += b
        ep = {"ce": tot_ce / n, "value_mse": tot_v / n, "acc": tot_acc / n}
        stats["epochs"].append(ep)
        print(f"epoch {epoch + 1}/{epochs}  ce={ep['ce']:.4f}  acc={ep['acc']:.3f}  vmse={ep['value_mse']:.4f}")

    model.eval()
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
    ap.add_argument("--device", type=str, default=None, help="cpu / cuda / mps (default: auto)")
    a = ap.parse_args()
    train_bc(
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
        device=torch.device(a.device) if a.device else None,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
