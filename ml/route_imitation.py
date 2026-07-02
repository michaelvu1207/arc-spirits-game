"""
Heldout imitation diagnostic for route-critical counterfactual data.

This is not a champion-training script. It answers one narrower proof question:
can the current obs/action contract and candidate scorer imitate oracle labels
on heldout farm/build route states?
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset, Subset

sys.path.insert(0, str(Path(__file__).parent))
from model import build_model, get_device, load_dims_from_meta
from train import DecisionDataset, collate_fn


def chosen_signature(dataset: DecisionDataset, idx: int) -> str:
    chosen = dataset.chosen_list[idx]
    cands = dataset.cands_list[idx]
    if chosen < 0 or chosen >= len(cands):
        return "<bad-chosen>"
    # Rounded action vector signature: stable across runs without duplicating TS vocab.
    return ",".join(f"{float(x):.4g}" for x in cands[chosen])


def stratified_split(
    dataset: DecisionDataset,
    val_frac: float,
    seed: int,
) -> tuple[list[int], list[int], dict[str, int], dict[str, int]]:
    rng = random.Random(seed)
    by_label: dict[str, list[int]] = defaultdict(list)
    for idx in range(len(dataset)):
        by_label[chosen_signature(dataset, idx)].append(idx)

    train: list[int] = []
    val: list[int] = []
    for label, indices in by_label.items():
        rng.shuffle(indices)
        if len(indices) <= 1:
            train.extend(indices)
            continue
        n_val = max(1, int(round(len(indices) * val_frac)))
        n_val = min(n_val, len(indices) - 1)
        val.extend(indices[:n_val])
        train.extend(indices[n_val:])

    rng.shuffle(train)
    rng.shuffle(val)
    train_counts = Counter(chosen_signature(dataset, idx) for idx in train)
    val_counts = Counter(chosen_signature(dataset, idx) for idx in val)
    return train, val, dict(train_counts), dict(val_counts)


def label_summary(counts: dict[str, int], max_items: int = 12) -> list[dict[str, Any]]:
    return [
        {"signature": sig, "count": count}
        for sig, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:max_items]
    ]


def majority_accuracy(counts: dict[str, int]) -> float:
    total = sum(counts.values())
    return (max(counts.values()) / total) if total > 0 else 0.0


@torch.no_grad()
def evaluate(model: torch.nn.Module, loader: DataLoader, device: torch.device) -> dict[str, float]:
    model.eval()
    total = 0
    top1 = 0
    top3 = 0
    total_loss = 0.0
    total_target_prob = 0.0
    total_entropy = 0.0

    for obs, cands, mask, chosen, _rets, pi, *_rest in loader:
        obs = obs.to(device)
        cands = cands.to(device)
        mask = mask.to(device)
        chosen = chosen.to(device)
        pi = pi.to(device)

        logits, probs, _value = model(obs, cands, mask)
        log_probs = F.log_softmax(logits, dim=-1)
        loss = -(pi * log_probs).sum(dim=-1)
        pred = logits.argmax(dim=-1)
        k = min(3, logits.shape[-1])
        top = torch.topk(logits, k=k, dim=-1).indices
        target_prob = probs.gather(1, chosen.unsqueeze(1)).squeeze(1)
        entropy = -(probs * log_probs).masked_fill(~mask, 0).sum(dim=-1)

        batch = int(chosen.shape[0])
        total += batch
        top1 += int((pred == chosen).sum().item())
        top3 += int((top == chosen.unsqueeze(1)).any(dim=1).sum().item())
        total_loss += float(loss.sum().item())
        total_target_prob += float(target_prob.sum().item())
        total_entropy += float(entropy.sum().item())

    denom = max(1, total)
    return {
        "n": total,
        "loss": total_loss / denom,
        "top1": top1 / denom,
        "top3": top3 / denom,
        "targetProb": total_target_prob / denom,
        "entropy": total_entropy / denom,
    }


def train_route_imitation(args: argparse.Namespace) -> dict[str, Any]:
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    random.seed(args.seed)

    data = Path(args.data)
    dataset = DecisionDataset(data)
    obs_dim, act_dim = load_dims_from_meta(data)
    train_idx, val_idx, train_counts, val_counts = stratified_split(dataset, args.val_frac, args.seed)
    if not train_idx or not val_idx:
        raise ValueError("route imitation needs both train and validation rows")

    device = get_device()
    model = build_model(obs_dim, act_dim, device)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    train_loader = DataLoader(
        Subset(dataset, train_idx),
        batch_size=args.batch_size,
        shuffle=True,
        collate_fn=collate_fn,
        drop_last=False,
    )
    eval_train_loader = DataLoader(
        Subset(dataset, train_idx),
        batch_size=args.batch_size,
        shuffle=False,
        collate_fn=collate_fn,
        drop_last=False,
    )
    val_loader = DataLoader(
        Subset(dataset, val_idx),
        batch_size=args.batch_size,
        shuffle=False,
        collate_fn=collate_fn,
        drop_last=False,
    )

    history: list[dict[str, Any]] = []
    best_val_top1 = -math.inf
    best: dict[str, Any] | None = None
    for epoch in range(1, args.epochs + 1):
        model.train()
        for obs, cands, mask, _chosen, _rets, pi, *_rest in train_loader:
            obs = obs.to(device)
            cands = cands.to(device)
            mask = mask.to(device)
            pi = pi.to(device)
            logits, _probs, _value = model(obs, cands, mask)
            log_probs = F.log_softmax(logits, dim=-1)
            loss = -(pi * log_probs).sum(dim=-1).mean()
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

        if epoch == 1 or epoch == args.epochs or epoch % args.report_every == 0:
            train_metrics = evaluate(model, eval_train_loader, device)
            val_metrics = evaluate(model, val_loader, device)
            row = {"epoch": epoch, "train": train_metrics, "val": val_metrics}
            history.append(row)
            if val_metrics["top1"] > best_val_top1:
                best_val_top1 = val_metrics["top1"]
                best = row
            print(
                f"[route-imitation] epoch={epoch} "
                f"train_top1={train_metrics['top1']:.3f} val_top1={val_metrics['top1']:.3f} "
                f"val_top3={val_metrics['top3']:.3f} val_loss={val_metrics['loss']:.4f}"
            )

    final_train = evaluate(model, eval_train_loader, device)
    final_val = evaluate(model, val_loader, device)
    if final_val["top1"] > best_val_top1:
        best = {"epoch": args.epochs, "train": final_train, "val": final_val}
        best_val_top1 = final_val["top1"]

    summary = {
        "data": str(data),
        "device": str(device),
        "obs_dim": obs_dim,
        "act_dim": act_dim,
        "samples": len(dataset),
        "train_samples": len(train_idx),
        "val_samples": len(val_idx),
        "val_frac": args.val_frac,
        "seed": args.seed,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "lr": args.lr,
        "weight_decay": args.weight_decay,
        "train_label_counts": label_summary(train_counts),
        "val_label_counts": label_summary(val_counts),
        "train_majority_top1": majority_accuracy(train_counts),
        "val_majority_top1": majority_accuracy(val_counts),
        "final": {"train": final_train, "val": final_val},
        "best": best,
        "history": history,
        "pass": (
            final_val["top1"] >= args.min_val_top1
            and final_val["top3"] >= args.min_val_top3
            and final_train["top1"] >= args.min_train_top1
        ),
        "thresholds": {
            "min_val_top1": args.min_val_top1,
            "min_val_top3": args.min_val_top3,
            "min_train_top1": args.min_train_top1,
        },
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary, indent=2) + "\n")
    print(f"[route-imitation] DONE -> {args.out}")
    print(json.dumps({
        "pass": summary["pass"],
        "final_train_top1": final_train["top1"],
        "final_val_top1": final_val["top1"],
        "final_val_top3": final_val["top3"],
        "val_majority_top1": summary["val_majority_top1"],
    }))
    if not summary["pass"] and not args.allow_fail:
        raise SystemExit(1)
    return summary


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Heldout route-Q imitation diagnostic")
    p.add_argument("--data", type=Path, required=True, help="Directory containing route-Q *.jsonl and optional meta.json")
    p.add_argument("--out", type=Path, default=Path("ml/route_imitation_summary.json"))
    p.add_argument("--epochs", type=int, default=120)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight-decay", type=float, default=1e-5)
    p.add_argument("--val-frac", type=float, default=0.25)
    p.add_argument("--seed", type=int, default=20260628)
    p.add_argument("--report-every", type=int, default=20)
    p.add_argument("--min-val-top1", type=float, default=0.6)
    p.add_argument("--min-val-top3", type=float, default=0.9)
    p.add_argument("--min-train-top1", type=float, default=0.8)
    p.add_argument(
        "--allow-fail",
        action="store_true",
        help="Write the pass/fail summary but exit 0 so higher-level diagnostic suites can emit a final verdict.",
    )
    return p.parse_args()


if __name__ == "__main__":
    train_route_imitation(parse_args())
