"""
Distill the v2 set-transformer teacher into the live TS-format v1 net.

The live TypeScript bot (src/lib/play/ml/net.ts) can only run the fixed-MLP
`arc-cand-scorer-v1` JSON format on current v1 187-float observations. A transformer
cannot be exported to that format, so v2 knowledge reaches production via
distillation: a frozen EntityCandidateScorer teacher (arc-entity-scorer-v2 .pt)
supervises a fresh CandidateScorer student (ml/model.py), and the student is
exported with train.py's export_weights to arc-cand-scorer-v1 JSON.

PAIRED rows per the pinned contract (docs/encoder-v2.md §"PINNED DATA
CONTRACT") — both encodings of the SAME decision on one row:

    {"obs":   [187 floats],           # v1 summary (student input)
     "obsV2": [<flat v2 floats>],     # arc-obs-v2 flat (teacher input)
     "cands": [[52]...],
     "chosen": i, "ret": r, ...}      # chosen/ret optional (hard-label mixing)

meta.json: {"obs_dim": 187, "act_dim": 52, "obs_version": 2,
"obs_v2": <obsV2Meta(catalog) block>}.
The teacher checkpoint's stored obs header must match meta.obs_v2's — a
mismatch means the encodings drifted apart and distillation would be garbage.

Losses:
    KL(teacher_T || student_T) * T^2            (policy, temperature T)
  + value_coef * MSE(value_s, value_t)          (value matching)
  + hard_coef  * CE(student, chosen)            (optional ground-truth anchor)

Usage:
    ml/.venv/bin/python ml/distill.py \
        --data ml/data_v2_paired --teacher ml/weights/v2_bc.pt \
        --out ml/weights/policy_distilled.json --epochs 6
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
from model import CandidateScorer, build_model, get_device
from model_v2 import load_checkpoint
from obs_v2 import ObsV2Spec
from train import export_weights


class PairedDataset(Dataset):
    """Decisions carrying both v1 obs (student) and flat v2 obs (teacher)."""

    def __init__(self, data_dir: Path, obs_dim: int, spec: ObsV2Spec) -> None:
        self.obs_list: list[np.ndarray] = []
        self.obs_v2_list: list[np.ndarray] = []
        self.cands_list: list[np.ndarray] = []
        self.chosen_list: list[int] = []
        skipped = 0

        jsonl_files = sorted(p for p in data_dir.rglob("*.jsonl") if p.is_file())
        if not jsonl_files:
            raise FileNotFoundError(f"No *.jsonl files found in {data_dir}")
        for fpath in jsonl_files:
            with open(fpath) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec: dict[str, Any] = json.loads(line)
                        obs = np.asarray(rec["obs"], dtype=np.float32)
                        obs_v2 = np.asarray(rec["obsV2"], dtype=np.float32)
                        cands = np.asarray(rec["cands"], dtype=np.float32)
                    except (json.JSONDecodeError, KeyError, ValueError, TypeError):
                        skipped += 1
                        continue
                    if obs.shape != (obs_dim,) or obs_v2.shape != (spec.flat_length,) or cands.ndim != 2:
                        skipped += 1
                        continue
                    chosen = rec.get("chosen")
                    self.obs_list.append(obs)
                    self.obs_v2_list.append(obs_v2)
                    self.cands_list.append(cands)
                    self.chosen_list.append(int(chosen) if isinstance(chosen, int) and 0 <= chosen < cands.shape[0] else -1)
        if not self.obs_list:
            raise ValueError(f"{data_dir}: no usable paired rows (skipped {skipped})")
        if skipped:
            print(f"dataset: kept {len(self.obs_list)} paired rows, skipped {skipped}")

    def __len__(self) -> int:
        return len(self.obs_list)

    def __getitem__(self, i: int):
        return self.obs_list[i], self.obs_v2_list[i], self.cands_list[i], self.chosen_list[i]


def collate(batch):
    obs = torch.from_numpy(np.stack([b[0] for b in batch]))
    obs_v2 = torch.from_numpy(np.stack([b[1] for b in batch]))
    max_c = max(b[2].shape[0] for b in batch)
    act_dim = batch[0][2].shape[1]
    cands = torch.zeros(len(batch), max_c, act_dim)
    mask = torch.zeros(len(batch), max_c, dtype=torch.bool)
    for i, (_, _, c, _) in enumerate(batch):
        cands[i, : c.shape[0]] = torch.from_numpy(c)
        mask[i, : c.shape[0]] = True
    chosen = torch.tensor([b[3] for b in batch], dtype=torch.long)
    return obs, obs_v2, cands, mask, chosen


def distill_loss(
    s_logits: torch.Tensor,
    t_logits: torch.Tensor,
    mask: torch.Tensor,
    temperature: float,
) -> torch.Tensor:
    """Masked temperature-scaled KL(teacher || student), scaled by T^2."""
    t = temperature
    # Both logit sets carry -1e9 on padded slots; dividing by T keeps them
    # effectively -inf, so pad probabilities vanish on both sides.
    t_prob = F.softmax(t_logits / t, dim=-1)
    s_logp = F.log_softmax(s_logits / t, dim=-1)
    kl = (t_prob * (torch.log(t_prob.clamp_min(1e-12)) - s_logp)).masked_fill(~mask, 0.0)
    return kl.sum(dim=-1).mean() * (t * t)


def distill(
    data_dir: Path,
    teacher_path: Path,
    out_json: Path,
    epochs: int = 6,
    batch_size: int = 64,
    lr: float = 1e-3,
    temperature: float = 2.0,
    value_coef: float = 0.5,
    hard_coef: float = 0.0,
    trunk_hidden: tuple[int, ...] | None = None,
    value_hidden: tuple[int, ...] | None = None,
    seed: int = 0,
    max_grad_norm: float = 1.0,
    device: torch.device | None = None,
) -> dict:
    """Distill teacher -> fresh v1 student, export arc-cand-scorer-v1 JSON."""
    if device is None:
        device = get_device()

    meta_path = data_dir / "meta.json"
    with open(meta_path) as f:
        meta = json.load(f)
    obs_dim, act_dim = int(meta["obs_dim"]), int(meta["act_dim"])
    if "obs_v2" not in meta:
        raise ValueError(f"{meta_path}: paired distill datasets require an obs_v2 block")
    if "obs_version" in meta and int(meta["obs_version"]) != 2:
        raise ValueError(f"{meta_path}: obs_version {meta['obs_version']} != 2")
    spec = ObsV2Spec.from_meta(meta["obs_v2"])

    teacher = load_checkpoint(teacher_path, device=device, spec=spec).eval()
    for p in teacher.parameters():
        p.requires_grad_(False)
    if teacher.act_dim != act_dim:
        raise ValueError(f"teacher act_dim {teacher.act_dim} != dataset act_dim {act_dim}")

    ds = PairedDataset(data_dir, obs_dim, spec)
    gen = torch.Generator().manual_seed(seed)
    dl = DataLoader(ds, batch_size=batch_size, shuffle=True, collate_fn=collate, generator=gen)

    torch.manual_seed(seed)
    student: CandidateScorer = build_model(obs_dim, act_dim, device, trunk_hidden, value_hidden).train()
    opt = torch.optim.Adam(student.parameters(), lr=lr)

    stats: dict = {"epochs": [], "samples": len(ds), "teacher": str(teacher_path)}
    for epoch in range(epochs):
        tot_kl = tot_v = tot_agree = n = 0.0
        for obs, obs_v2, cands, mask, chosen in dl:
            obs, obs_v2 = obs.to(device), obs_v2.to(device)
            cands, mask, chosen = cands.to(device), mask.to(device), chosen.to(device)
            with torch.no_grad():
                t_logits, _, t_value = teacher(obs_v2, cands, mask)
            s_logits, _, s_value = student(obs, cands, mask)
            loss = distill_loss(s_logits, t_logits, mask, temperature)
            kl_item = loss.item()
            loss = loss + value_coef * F.mse_loss(s_value, t_value)
            if hard_coef > 0:
                has_label = chosen >= 0
                if bool(has_label.any()):
                    loss = loss + hard_coef * F.cross_entropy(s_logits[has_label], chosen[has_label])
            opt.zero_grad()
            loss.backward()
            if max_grad_norm > 0:
                torch.nn.utils.clip_grad_norm_(student.parameters(), max_grad_norm)
            opt.step()
            b = obs.shape[0]
            tot_kl += kl_item * b
            tot_v += F.mse_loss(s_value.detach(), t_value).item() * b
            tot_agree += (s_logits.argmax(dim=-1) == t_logits.argmax(dim=-1)).float().sum().item()
            n += b
        ep = {"kl": tot_kl / n, "value_mse": tot_v / n, "top1_agree": tot_agree / n}
        stats["epochs"].append(ep)
        print(
            f"epoch {epoch + 1}/{epochs}  kl={ep['kl']:.4f}  "
            f"top1_agree={ep['top1_agree']:.3f}  vmse={ep['value_mse']:.4f}"
        )

    student.eval()
    # export_weights carries the finite-weights guard (train.py): a diverged
    # student raises here instead of shipping a NaN JSON.
    export_weights(student, obs_dim, act_dim, out_json)
    stats["out"] = str(out_json)
    print(f"arc-cand-scorer-v1 weights exported: {out_json}")
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, required=True, help="paired v1+v2 dataset dir")
    ap.add_argument("--teacher", type=Path, required=True, help="arc-entity-scorer-v2 .pt checkpoint")
    ap.add_argument("--out", type=Path, required=True, help="output arc-cand-scorer-v1 policy JSON")
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--batch-size", type=int, default=64)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--temperature", type=float, default=2.0)
    ap.add_argument("--value-coef", type=float, default=0.5)
    ap.add_argument("--hard-coef", type=float, default=0.0, help="CE weight on recorded chosen actions")
    ap.add_argument("--hidden", type=str, default=None, help='student trunk widths, e.g. "384,384"')
    ap.add_argument("--value-hidden", type=str, default=None, help='student value widths, e.g. "128"')
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--max-grad-norm", type=float, default=1.0,
                    help="Gradient clipping (clip_grad_norm_); 0 disables")
    ap.add_argument("--device", type=str, default=None)
    a = ap.parse_args()
    parse_h = lambda s: tuple(int(x) for x in s.split(",") if x.strip()) if s else None  # noqa: E731
    distill(
        a.data,
        a.teacher,
        a.out,
        epochs=a.epochs,
        batch_size=a.batch_size,
        lr=a.lr,
        temperature=a.temperature,
        value_coef=a.value_coef,
        hard_coef=a.hard_coef,
        trunk_hidden=parse_h(a.hidden),
        value_hidden=parse_h(a.value_hidden),
        seed=a.seed,
        max_grad_norm=a.max_grad_norm,
        device=torch.device(a.device) if a.device else None,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
