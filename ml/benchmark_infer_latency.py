"""Benchmark the production binary inference wire with fixed realistic shapes.

The server is intentionally external so the benchmark measures the exact model,
GPU, batching window, and memory footprint selected by the caller.  Observations
and candidate encodings come from real actor rows; short legal candidate lists
are repeated only to make compute shape identical across model variants.

Example (server already listening on /tmp/v27.sock):

    ml/.venv/bin/python ml/benchmark_infer_latency.py \
      --socket /tmp/v27.sock --data ml/experiments/v27-entity-live/validation \
      --rows 32 --candidates 30 --clients 8 --warmup 20 --requests 200 \
      --out ml/experiments/v27-entity-live/latency-d128.json
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from infer_server import (  # noqa: E402
    InferClient,
    encode_binary_request,
    frame_bytes,
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fixed_candidates(candidates: np.ndarray, count: int) -> np.ndarray:
    """Return exactly count valid-shaped candidates without inventing encodings."""
    if candidates.ndim != 2 or candidates.shape[0] == 0:
        raise ValueError("candidate matrix must be nonempty and rank two")
    repeats = math.ceil(count / candidates.shape[0])
    return np.concatenate([candidates] * repeats, axis=0)[:count].copy()


def load_payloads(
    data_dir: Path,
    *,
    clients: int,
    rows_per_request: int,
    candidates_per_row: int,
) -> list[tuple[np.ndarray, list[np.ndarray]]]:
    needed = clients * rows_per_request
    observations: list[np.ndarray] = []
    candidates: list[np.ndarray] = []
    paths = sorted(
        path for path in data_dir.rglob("shard-*.jsonl") if path.is_file()
    )
    if not paths:
        raise FileNotFoundError(f"{data_dir}: no shard-*.jsonl files")
    obs_dim = act_dim = None
    for path in paths:
        with open(path) as handle:
            for line_number, line in enumerate(handle, 1):
                try:
                    record = json.loads(line)
                    obs = np.asarray(record["obsV2"], dtype=np.float32)
                    cands = np.asarray(record["cands"], dtype=np.float32)
                    if obs.ndim != 1 or cands.ndim != 2 or cands.shape[0] == 0:
                        raise ValueError("bad row rank/support")
                    if obs_dim is None:
                        obs_dim, act_dim = obs.shape[0], cands.shape[1]
                    if obs.shape != (obs_dim,) or cands.shape[1] != act_dim:
                        raise ValueError("mixed observation/action dimensions")
                except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                    raise ValueError(f"{path}:{line_number}: {exc}") from exc
                observations.append(obs)
                candidates.append(fixed_candidates(cands, candidates_per_row))
                if len(observations) == needed:
                    break
        if len(observations) == needed:
            break
    if len(observations) < needed:
        raise ValueError(f"{data_dir}: need {needed} valid rows, found {len(observations)}")
    payloads = []
    for client in range(clients):
        start = client * rows_per_request
        end = start + rows_per_request
        payloads.append((np.stack(observations[start:end]), candidates[start:end]))
    return payloads


def percentiles(samples_ms: list[float]) -> dict[str, float]:
    if not samples_ms:
        raise ValueError("no latency samples")
    values = np.asarray(samples_ms, dtype=np.float64)
    return {
        "min": float(values.min()),
        "p50": float(np.percentile(values, 50)),
        "p95": float(np.percentile(values, 95)),
        "p99": float(np.percentile(values, 99)),
        "max": float(values.max()),
        "mean": float(values.mean()),
    }


async def run_benchmark(args: argparse.Namespace) -> dict:
    payloads = load_payloads(
        args.data,
        clients=args.clients,
        rows_per_request=args.rows,
        candidates_per_row=args.candidates,
    )
    clients = [await InferClient.connect(args.socket) for _ in range(args.clients)]
    try:
        info = (await clients[0].info()).get("info", {})
        obs_dim = payloads[0][0].shape[1]
        act_dim = payloads[0][1][0].shape[1]
        if info.get("obs_dim") != obs_dim or info.get("act_dim") != act_dim:
            raise ValueError(
                f"server dimensions {(info.get('obs_dim'), info.get('act_dim'))} "
                f"!= payload dimensions {(obs_dim, act_dim)}"
            )

        async def request_once(index: int, *, measured: bool) -> float | None:
            obs, cands = payloads[index]
            started = time.perf_counter_ns()
            response = await clients[index].request_binary(obs, cands)
            elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000
            if "error" in response:
                raise RuntimeError(f"client {index}: {response['error']}")
            if len(response.get("logits", [])) != args.rows:
                raise RuntimeError(f"client {index}: truncated response")
            return elapsed_ms if measured else None

        for _ in range(args.warmup):
            await asyncio.gather(
                *(request_once(index, measured=False) for index in range(args.clients))
            )

        per_client: list[list[float]] = [[] for _ in range(args.clients)]

        async def measured_client(index: int) -> None:
            for _ in range(args.requests):
                latency = await request_once(index, measured=True)
                assert latency is not None
                per_client[index].append(latency)

        started = time.perf_counter()
        await asyncio.gather(*(measured_client(index) for index in range(args.clients)))
        wall_seconds = time.perf_counter() - started
    finally:
        await asyncio.gather(*(client.close() for client in clients))

    samples = [latency for client_samples in per_client for latency in client_samples]
    request_latency = percentiles(samples)
    total_requests = args.clients * args.requests
    total_rows = total_requests * args.rows
    obs0, cands0 = payloads[0]
    request_bytes = len(frame_bytes(encode_binary_request("1", obs0, cands0, 0)))
    return {
        "schemaVersion": "arc-infer-latency-v1",
        "socket": str(args.socket),
        "data": str(args.data),
        "server": info,
        "protocol": {
            "wire": "binary",
            "rowsPerRequest": args.rows,
            "candidatesPerRow": args.candidates,
            "clients": args.clients,
            "warmupRequestsPerClient": args.warmup,
            "measuredRequestsPerClient": args.requests,
            "requestBytes": request_bytes,
        },
        "measurement": {
            "requests": total_requests,
            "rows": total_rows,
            "wallSeconds": wall_seconds,
            "requestsPerSecond": total_requests / wall_seconds,
            "rowsPerSecond": total_rows / wall_seconds,
            "requestLatencyMs": request_latency,
            "perRowEquivalentLatencyMs": {
                key: value / args.rows for key, value in request_latency.items()
            },
            "perClientRequestLatencyMs": [percentiles(values) for values in per_client],
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--rows", type=int, default=32)
    parser.add_argument("--candidates", type=int, default=30)
    parser.add_argument("--clients", type=int, default=8)
    parser.add_argument("--warmup", type=int, default=20)
    parser.add_argument("--requests", type=int, default=200)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    for name in ("rows", "candidates", "clients", "warmup", "requests"):
        if getattr(args, name) <= 0:
            parser.error(f"--{name} must be positive")
    return args


def main() -> int:
    args = parse_args()
    result = asyncio.run(run_benchmark(args))
    rendered = json.dumps(result, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered)
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
