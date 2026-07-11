"""End-to-end Arc Spirits v1 learner/model-size benchmark.

This benchmarks the work a real PPO minibatch performs: ragged candidate
collation, host-to-device transfer, all active heads, backward, gradient
clipping, optimizer update, and the strict finite-parameter guard.  It can use
synthetic rows or an actual replay directory and can compare random minibatches
against power-of-two candidate-count bucketing.

Examples:
  ml/.venv/bin/python ml/benchmark_model_sizes.py --steps 5 --warmup 2
  CUDA_VISIBLE_DEVICES=7 ml/.venv/bin/python ml/benchmark_model_sizes.py \
      --widths 64,128,256,512 --batches 256,1024,2048,4096 \
      --replay ml/league_v14b/data/gen120/main-0 \
      --bucketing random,bucketed --precision fp32 \
      --out /tmp/arc-model-batches-a100.json

The throughput result is only a systems gate. Playing strength still requires
fixed-seed league, held-out gauntlet, heuristic-field, and human evaluation.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import numpy as np
import torch
import torch.nn.functional as F

from model import CandidateScorer, get_device, model_parameters_are_finite


def csv_ints(raw: str) -> list[int]:
    values = [int(value.strip()) for value in raw.split(",") if value.strip()]
    if not values or any(value <= 0 for value in values):
        raise argparse.ArgumentTypeError("expected positive comma-separated integers")
    return values


def csv_strings(raw: str) -> list[str]:
    values = [value.strip() for value in raw.split(",") if value.strip()]
    if not values:
        raise argparse.ArgumentTypeError("expected a non-empty comma-separated list")
    return values


def sync(device: torch.device) -> None:
    if device.type == "cuda":
        torch.cuda.synchronize(device)
    elif device.type == "mps":
        torch.mps.synchronize()


def precision_modes(device: torch.device, requested: str) -> list[str]:
    if requested != "auto":
        return [requested]
    return ["fp32", "tf32", "bf16"] if device.type == "cuda" else ["fp32"]


def set_precision(mode: str, device: torch.device) -> None:
    if device.type != "cuda":
        if mode != "fp32":
            raise ValueError(f"{mode} is only supported by this benchmark on CUDA")
        return
    torch.set_float32_matmul_precision("high" if mode == "tf32" else "highest")


def autocast_context(mode: str, device: torch.device):
    if mode == "bf16":
        return torch.autocast(device_type="cuda", dtype=torch.bfloat16)
    return nullcontext()


@dataclass(frozen=True)
class ReplayRow:
    obs: np.ndarray
    cands: np.ndarray
    chosen: int


@dataclass
class DeviceBatch:
    obs: torch.Tensor
    cands: torch.Tensor
    mask: torch.Tensor
    chosen: torch.Tensor
    value_target: torch.Tensor
    farm_target: torch.Tensor
    route_target: torch.Tensor
    placement: torch.Tensor
    valid_candidates: int
    padded_candidates: int


def replay_files(path: Path) -> Iterable[Path]:
    if path.is_file():
        yield path
        return
    for file in sorted(path.rglob("*.jsonl")):
        if not file.name.startswith("games-"):
            yield file


def load_replay(path: Path, obs_dim: int, act_dim: int, max_rows: int) -> list[ReplayRow]:
    rows: list[ReplayRow] = []
    for file in replay_files(path):
        with file.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue
                obs = raw.get("obs")
                cands = raw.get("cands")
                chosen = raw.get("chosen")
                if (
                    not isinstance(obs, list)
                    or len(obs) != obs_dim
                    or not isinstance(cands, list)
                    or not cands
                    or not isinstance(chosen, int)
                    or chosen < 0
                    or chosen >= len(cands)
                    or any(not isinstance(cand, list) or len(cand) != act_dim for cand in cands)
                ):
                    continue
                rows.append(
                    ReplayRow(
                        obs=np.asarray(obs, dtype=np.float32),
                        cands=np.asarray(cands, dtype=np.float32),
                        chosen=chosen,
                    )
                )
                if max_rows > 0 and len(rows) >= max_rows:
                    return rows
    if not rows:
        raise ValueError(f"no valid obs/cands/chosen rows found under {path}")
    return rows


def synthetic_candidate_count(rng: np.random.Generator, maximum: int, index: int) -> int:
    if maximum <= 2:
        return maximum
    # Approximate the measured v14 replay shape (median 5, p90 7, p99 11),
    # with exactly one rare maximum-width row in the synthetic population.
    if index == 0:
        return maximum
    draw = rng.random()
    if draw < 0.50:
        count = int(rng.integers(3, 6))
    elif draw < 0.90:
        count = int(rng.integers(5, 8))
    elif draw < 0.99:
        count = int(rng.integers(8, 12))
    else:
        count = int(rng.integers(12, max(13, maximum + 1)))
    return max(1, min(maximum, count))


def make_synthetic_rows(
    population: int,
    maximum_candidates: int,
    obs_dim: int,
    act_dim: int,
    seed: int,
) -> list[ReplayRow]:
    rng = np.random.default_rng(seed)
    rows: list[ReplayRow] = []
    for index in range(population):
        count = synthetic_candidate_count(rng, maximum_candidates, index)
        rows.append(
            ReplayRow(
                obs=rng.standard_normal(obs_dim, dtype=np.float32),
                cands=rng.standard_normal((count, act_dim), dtype=np.float32),
                chosen=int(rng.integers(0, count)),
            )
        )
    return rows


def bucket_key(candidate_count: int) -> int:
    return 1 << max(0, math.ceil(math.log2(max(1, candidate_count))))


class BatchSource:
    def __init__(
        self,
        rows: list[ReplayRow],
        batch_size: int,
        bucketing: str,
        device: torch.device,
        seed: int,
    ) -> None:
        self.rows = rows
        self.batch_size = batch_size
        self.device = device
        rng = np.random.default_rng(seed)
        if bucketing == "bucketed":
            buckets: dict[int, list[int]] = {}
            for index, row in enumerate(rows):
                buckets.setdefault(bucket_key(len(row.cands)), []).append(index)
            ordered: list[int] = []
            for key in sorted(buckets):
                members = np.asarray(buckets[key], dtype=np.int64)
                rng.shuffle(members)
                ordered.extend(int(index) for index in members)
            self.order = np.asarray(ordered, dtype=np.int64)
        elif bucketing == "random":
            self.order = rng.permutation(len(rows))
        else:
            raise ValueError(f"unknown bucketing mode: {bucketing}")
        self.offset = 0

    def next(self) -> DeviceBatch:
        if self.offset + self.batch_size > len(self.order):
            self.offset = 0
        indices = self.order[self.offset : self.offset + self.batch_size]
        self.offset += self.batch_size
        if len(indices) < self.batch_size:
            missing = self.batch_size - len(indices)
            indices = np.concatenate([indices, self.order[:missing]])
            self.offset = missing

        selected = [self.rows[int(index)] for index in indices]
        max_candidates = max(len(row.cands) for row in selected)
        obs_dim = selected[0].obs.shape[0]
        act_dim = selected[0].cands.shape[1]
        obs = np.empty((self.batch_size, obs_dim), dtype=np.float32)
        cands = np.zeros((self.batch_size, max_candidates, act_dim), dtype=np.float32)
        mask = np.zeros((self.batch_size, max_candidates), dtype=bool)
        chosen = np.empty(self.batch_size, dtype=np.int64)
        valid_candidates = 0
        for output_index, row in enumerate(selected):
            count = len(row.cands)
            obs[output_index] = row.obs
            cands[output_index, :count] = row.cands
            mask[output_index, :count] = True
            chosen[output_index] = row.chosen
            valid_candidates += count

        # Deterministic, finite targets. Their values do not affect systems timing.
        value_target = np.tanh(obs[:, 0]).astype(np.float32, copy=False)
        farm_target = (1.0 / (1.0 + np.exp(-obs[:, 1]))).astype(np.float32, copy=False)
        route_target = (obs[:, 2] > 0).astype(np.float32, copy=False)
        placement = (np.arange(self.batch_size, dtype=np.int64) % 4).astype(np.int64)

        def to_device(array: np.ndarray) -> torch.Tensor:
            # Mirrors PPO's current torch.from_numpy(...).to(device) path. Deliberately
            # not pinned so this benchmark catches the value of a future pinned-tensor A/B.
            return torch.from_numpy(array).to(self.device)

        return DeviceBatch(
            obs=to_device(obs),
            cands=to_device(cands),
            mask=to_device(mask),
            chosen=to_device(chosen),
            value_target=to_device(value_target),
            farm_target=to_device(farm_target),
            route_target=to_device(route_target),
            placement=to_device(placement),
            valid_candidates=valid_candidates,
            padded_candidates=self.batch_size * max_candidates,
        )


def parameters_are_finite(model: CandidateScorer, mode: str) -> bool:
    if mode == "none":
        return True
    if mode == "flat":
        return model_parameters_are_finite(model)
    if mode == "sequential":
        return all(bool(torch.isfinite(parameter).all().item()) for parameter in model.parameters())
    raise ValueError(f"unknown finite-check mode: {mode}")


def train_step(
    model: CandidateScorer,
    optimizer: torch.optim.Optimizer,
    batch: DeviceBatch,
    precision: str,
    finite_check: str,
    max_grad_norm: float,
) -> torch.Tensor:
    optimizer.zero_grad(set_to_none=True)
    with autocast_context(precision, batch.obs.device):
        logits, _, value = model(batch.obs, batch.cands, batch.mask)
        policy_loss = F.cross_entropy(logits, batch.chosen)
        value_loss = F.mse_loss(value, batch.value_target)
        farm_loss = F.mse_loss(model.farm_value(batch.obs), batch.farm_target)
        reward_loss = F.cross_entropy(
            model.reward_pick_logits(batch.obs, batch.cands, batch.mask), batch.chosen
        )
        route_loss = F.binary_cross_entropy_with_logits(
            model.route_mode_logits(batch.obs), batch.route_target
        )
        placement_loss = F.cross_entropy(model.placement_head_logits(batch.obs), batch.placement)
        loss = (
            policy_loss
            + 0.5 * value_loss
            + 0.25 * farm_loss
            + 0.25 * reward_loss
            + 0.1 * route_loss
            + 0.3 * placement_loss
        )
    loss.backward()
    if max_grad_norm > 0:
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_grad_norm)
    optimizer.step()
    if not parameters_are_finite(model, finite_check):
        raise FloatingPointError("model became non-finite")
    return loss.detach()


def run_case(
    *,
    width: int,
    batch_size: int,
    rows: list[ReplayRow],
    bucketing: str,
    obs_dim: int,
    act_dim: int,
    warmup: int,
    steps: int,
    precision: str,
    finite_check: str,
    max_grad_norm: float,
    device: torch.device,
    seed: int,
) -> dict:
    set_precision(precision, device)
    value_width = max(64, width // 2)
    model = CandidateScorer(
        obs_dim,
        act_dim,
        trunk_hidden=(width, width),
        value_hidden=(value_width,),
    ).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    source = BatchSource(rows, batch_size, bucketing, device, seed)

    loss = torch.zeros((), device=device)
    for _ in range(warmup):
        loss = train_step(
            model,
            optimizer,
            source.next(),
            precision,
            finite_check,
            max_grad_norm,
        )
    sync(device)
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats(device)
    valid_candidates = padded_candidates = 0
    started = time.perf_counter()
    for _ in range(steps):
        device_batch = source.next()
        valid_candidates += device_batch.valid_candidates
        padded_candidates += device_batch.padded_candidates
        loss = train_step(
            model,
            optimizer,
            device_batch,
            precision,
            finite_check,
            max_grad_norm,
        )
    sync(device)
    elapsed = time.perf_counter() - started
    parameters = sum(parameter.numel() for parameter in model.parameters())
    return {
        "width": width,
        "valueWidth": value_width,
        "batch": batch_size,
        "bucketing": bucketing,
        "precision": precision,
        "finiteCheck": finite_check,
        "maxGradNorm": max_grad_norm,
        "parameters": parameters,
        "millisecondsPerStep": 1000 * elapsed / steps,
        "rowsPerSecond": batch_size * steps / elapsed,
        "validCandidateScoresPerSecond": valid_candidates / elapsed,
        "paddedCandidateScoresPerSecond": padded_candidates / elapsed,
        "paddingEfficiency": valid_candidates / padded_candidates,
        "meanValidCandidates": valid_candidates / (batch_size * steps),
        "meanPaddedCandidates": padded_candidates / (batch_size * steps),
        "peakDeviceMemoryBytes": (
            torch.cuda.max_memory_allocated(device) if device.type == "cuda" else None
        ),
        "finalLoss": float(loss.float().cpu()),
    }


def candidate_summary(rows: list[ReplayRow]) -> dict:
    counts = np.asarray([len(row.cands) for row in rows], dtype=np.int64)
    return {
        "rows": len(rows),
        "mean": float(counts.mean()),
        "p50": float(np.quantile(counts, 0.50)),
        "p90": float(np.quantile(counts, 0.90)),
        "p99": float(np.quantile(counts, 0.99)),
        "max": int(counts.max()),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark Arc Spirits v1 learner/model sizes")
    parser.add_argument("--widths", type=csv_ints, default=csv_ints("64,128,256,512"))
    parser.add_argument("--batches", type=csv_ints, default=csv_ints("256,1024,4096"))
    parser.add_argument(
        "--candidates",
        type=csv_ints,
        default=csv_ints("6,12,68"),
        help="synthetic maximum candidate counts; ignored with --replay",
    )
    parser.add_argument("--replay", type=Path, default=None)
    parser.add_argument("--max-replay-rows", type=int, default=0)
    parser.add_argument(
        "--bucketing", type=csv_strings, default=csv_strings("random,bucketed")
    )
    parser.add_argument("--obs-dim", type=int, default=83)
    parser.add_argument("--act-dim", type=int, default=52)
    parser.add_argument("--warmup", type=int, default=8)
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument(
        "--precision", choices=("auto", "fp32", "tf32", "bf16"), default="auto"
    )
    parser.add_argument(
        "--finite-check", choices=("flat", "sequential", "none"), default="flat"
    )
    parser.add_argument("--max-grad-norm", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=710)
    parser.add_argument("--device", default=None, help="cpu, mps, cuda, or cuda:N")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    for mode in args.bucketing:
        if mode not in {"random", "bucketed"}:
            parser.error(f"unknown --bucketing mode: {mode}")
    if args.steps <= 0 or args.warmup < 0:
        parser.error("--steps must be positive and --warmup non-negative")
    device = torch.device(args.device) if args.device else get_device()

    if args.replay:
        datasets = [
            (
                "replay",
                load_replay(args.replay, args.obs_dim, args.act_dim, args.max_replay_rows),
            )
        ]
    else:
        population = max(max(args.batches) * 2, 8192)
        datasets = [
            (
                f"synthetic-max-{candidate_max}",
                make_synthetic_rows(
                    population,
                    candidate_max,
                    args.obs_dim,
                    args.act_dim,
                    args.seed + candidate_max,
                ),
            )
            for candidate_max in args.candidates
        ]

    result_rows: list[dict] = []
    dataset_summaries = {name: candidate_summary(rows) for name, rows in datasets}
    for dataset_name, replay_rows in datasets:
        for precision in precision_modes(device, args.precision):
            for width in args.widths:
                for batch_size in args.batches:
                    if batch_size > len(replay_rows):
                        print(
                            f"skip dataset={dataset_name} batch={batch_size}: "
                            f"only {len(replay_rows)} rows"
                        )
                        continue
                    for bucketing in args.bucketing:
                        try:
                            row = run_case(
                                width=width,
                                batch_size=batch_size,
                                rows=replay_rows,
                                bucketing=bucketing,
                                obs_dim=args.obs_dim,
                                act_dim=args.act_dim,
                                warmup=args.warmup,
                                steps=args.steps,
                                precision=precision,
                                finite_check=args.finite_check,
                                max_grad_norm=args.max_grad_norm,
                                device=device,
                                seed=args.seed + width + batch_size,
                            )
                        except RuntimeError as error:
                            if "out of memory" not in str(error).lower():
                                raise
                            row = {
                                "width": width,
                                "batch": batch_size,
                                "bucketing": bucketing,
                                "precision": precision,
                                "error": "out of memory",
                            }
                            if device.type == "cuda":
                                torch.cuda.empty_cache()
                        row["dataset"] = dataset_name
                        result_rows.append(row)
                        rate = row.get("rowsPerSecond")
                        padding = row.get("paddingEfficiency")
                        print(
                            f"dataset={dataset_name:<18} width={width:>3} "
                            f"batch={batch_size:>5} bucket={bucketing:<8} "
                            f"precision={precision:<4} "
                            + (
                                f"rows/s={rate:,.0f} padding={100 * padding:.1f}%"
                                if rate is not None
                                else str(row["error"])
                            )
                        )

    report = {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "torch": torch.__version__,
        "device": str(device),
        "deviceName": (
            torch.cuda.get_device_name(device) if device.type == "cuda" else str(device)
        ),
        "obsDim": args.obs_dim,
        "actDim": args.act_dim,
        "replay": str(args.replay) if args.replay else None,
        "finiteCheck": args.finite_check,
        "maxGradNorm": args.max_grad_norm,
        "datasets": dataset_summaries,
        "rows": result_rows,
    }
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2) + "\n")
        print(f"wrote {args.out}")
    else:
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
