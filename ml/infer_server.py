"""
Batched GPU inference server for the Arc Spirits candidate scorer.

Holds one CandidateScorer loaded from an arc-cand-scorer-v1 JSON weights file
and serves scoring requests over a Unix domain socket, coalescing rows from
concurrent connections into single forward passes.

Framing:  4-byte little-endian length prefix + JSON payload.
Request:  {"id": <any>, "obs": [B x obs_dim], "cands": [B x C_i x act_dim],
           "want": ["logits", "value"]}          (want optional, default both;
                                                  cands may be ragged per row)
          Extra want keys: "farm_value" -> [B], "route_mode" -> [B] (raw logit;
          sigmoid is applied client-side), "reward_pick" -> ragged [B x C_i].
          Aux heads are served only when the weights file carries them.
          Handshake: {"id": <any>, "want": ["info"]} needs no obs/cands and
          returns {"id", "info": {format, obs_dim, act_dim, device, weights,
          aux: {farm_value, route_mode, reward_pick}}}.
Response: {"id": <same>, "logits": [B x C_i], "value": [B], ...}
          logits are raw masked scores (softmax NOT applied), ragged like cands.
          On a bad request: {"id": <same>, "error": "<message>"}.

Batching: requests queue into a shared buffer; the batcher waits up to
--window-ms after the first pending request (or until --max-batch rows) and
runs one padded/masked forward for everything collected, then answers each
connection separately. The forward runs in a worker thread so the event loop
keeps reading sockets during compute.

Signals:  SIGHUP reloads --weights in place (checkpoint swap mid-training);
          SIGINT/SIGTERM shut down cleanly and unlink the socket.
Stats:    once per second (when active) a line to stderr with reqs, rows,
          batches, avg batch size, forwards/s.

Usage:
  ml/.venv/bin/python ml/infer_server.py \
      --weights src/lib/play/ml/policy-weights.json \
      --socket /tmp/arc-infer.sock
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import struct
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).parent))
from model import CandidateScorer, build_model, get_device

from train import hidden_sizes_from_checkpoint, load_json_weights_into


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------

MAX_FRAME_BYTES = 256 * 1024 * 1024


def encode_frame(obj: dict) -> bytes:
    data = json.dumps(obj, separators=(",", ":")).encode()
    return struct.pack("<I", len(data)) + data


async def read_frame(reader: asyncio.StreamReader) -> dict:
    header = await reader.readexactly(4)
    (length,) = struct.unpack("<I", header)
    if length > MAX_FRAME_BYTES:
        raise ValueError(f"frame of {length} bytes exceeds limit")
    return json.loads(await reader.readexactly(length))


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

AUX_HEADS = ("farm_value", "route_mode", "reward_pick")


def load_scorer(
    weights_path: Path, device: torch.device
) -> tuple[CandidateScorer, int, int, dict[str, bool]]:
    with open(weights_path) as f:
        payload = json.load(f)
    if payload.get("format") != "arc-cand-scorer-v1":
        raise ValueError(f"{weights_path}: unexpected format {payload.get('format')!r}")
    obs_dim = int(payload["obs_dim"])
    act_dim = int(payload["act_dim"])
    hidden = hidden_sizes_from_checkpoint(weights_path)
    model = build_model(
        obs_dim,
        act_dim,
        device,
        trunk_hidden=hidden[0] if hidden else None,
        value_hidden=hidden[1] if hidden else None,
    )
    if not load_json_weights_into(model, weights_path):
        raise ValueError(f"{weights_path}: weights do not fit the rebuilt architecture")
    model.eval()
    # Aux heads exist on every model instance, but only ones present in the
    # checkpoint have real weights (the rest are random init — never serve those).
    aux = {k: bool(payload.get(k)) for k in AUX_HEADS}
    return model, obs_dim, act_dim, aux


def resolve_device(spec: str) -> torch.device:
    if spec == "auto":
        return get_device()  # cuda > mps > cpu, ARC_DEVICE override honored
    return torch.device(spec)


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------

VALID_WANT = {"logits", "value", "info", *AUX_HEADS}


@dataclass
class _Job:
    obs: np.ndarray                       # (B, obs_dim) float32
    cands: list[np.ndarray]               # B x (C_i, act_dim) float32
    want: frozenset[str]
    future: asyncio.Future = field(repr=False)  # -> dict of want-key -> per-row lists

    @property
    def n_rows(self) -> int:
        return len(self.cands)


class InferServer:
    def __init__(
        self,
        weights_path: Path,
        device: torch.device,
        window_s: float,
        max_batch_rows: int,
        stats_interval: float,
    ) -> None:
        self.weights_path = weights_path
        self.device = device
        self.window_s = window_s
        self.max_batch_rows = max_batch_rows
        self.stats_interval = stats_interval
        self.model, self.obs_dim, self.act_dim, self.aux = load_scorer(weights_path, device)
        self.queue: asyncio.Queue[_Job] = asyncio.Queue()
        self.n_reqs = 0
        self.n_rows = 0
        self.n_batches = 0

    # -- request parsing ----------------------------------------------------

    def parse_want(self, msg: dict) -> frozenset[str]:
        want_raw = msg.get("want")
        if want_raw is None:
            return frozenset(("logits", "value"))
        if not isinstance(want_raw, list) or not want_raw:
            raise ValueError("want must be a non-empty list")
        want = frozenset(str(w) for w in want_raw)
        unknown = want - VALID_WANT
        if unknown:
            raise ValueError(f"unknown want keys {sorted(unknown)}; valid: {sorted(VALID_WANT)}")
        for head in AUX_HEADS:
            if head in want and not self.aux.get(head):
                raise ValueError(f"{head} head not present in {self.weights_path.name}")
        return want

    def make_job(self, msg: dict, want: frozenset[str]) -> _Job:
        obs_raw = msg.get("obs")
        cands_raw = msg.get("cands")
        if not isinstance(obs_raw, list) or not isinstance(cands_raw, list):
            raise ValueError("obs and cands must be lists")
        if len(obs_raw) != len(cands_raw):
            raise ValueError(f"obs has {len(obs_raw)} rows but cands has {len(cands_raw)}")
        loop = asyncio.get_running_loop()
        if len(obs_raw) == 0:
            return _Job(
                obs=np.zeros((0, self.obs_dim), dtype=np.float32),
                cands=[],
                want=want,
                future=loop.create_future(),
            )
        obs = np.asarray(obs_raw, dtype=np.float32)
        if obs.ndim != 2 or obs.shape[1] != self.obs_dim:
            raise ValueError(f"obs must be [B x {self.obs_dim}], got shape {obs.shape}")
        cands: list[np.ndarray] = []
        for i, row in enumerate(cands_raw):
            c = np.asarray(row, dtype=np.float32)
            if c.ndim != 2 or c.shape[0] < 1 or c.shape[1] != self.act_dim:
                raise ValueError(
                    f"cands[{i}] must be [C_i x {self.act_dim}] with C_i >= 1, got shape {c.shape}"
                )
            cands.append(c)
        return _Job(obs=obs, cands=cands, want=want, future=loop.create_future())

    # -- batched forward ----------------------------------------------------

    def _forward(self, jobs: list[_Job]) -> list[dict[str, list]]:
        """Pad all rows of all jobs into one masked forward; runs in a worker thread."""
        model = self.model  # snapshot so a SIGHUP swap mid-forward is harmless
        all_obs = np.concatenate([j.obs for j in jobs], axis=0)
        all_cands = [c for j in jobs for c in j.cands]
        n = len(all_cands)
        max_c = max(c.shape[0] for c in all_cands)
        cands = np.zeros((n, max_c, self.act_dim), dtype=np.float32)
        mask = np.zeros((n, max_c), dtype=bool)
        for i, c in enumerate(all_cands):
            cands[i, : c.shape[0]] = c
            mask[i, : c.shape[0]] = True

        wanted = frozenset().union(*(j.want for j in jobs))
        flat: dict[str, np.ndarray] = {}
        with torch.no_grad():
            obs_t = torch.from_numpy(all_obs).to(self.device)
            cands_t = torch.from_numpy(cands).to(self.device)
            mask_t = torch.from_numpy(mask).to(self.device)
            logits_t, _, value_t = model(obs_t, cands_t, mask_t)
            flat["logits"] = logits_t.cpu().numpy()
            flat["value"] = value_t.cpu().numpy()
            # Aux heads only when some job in the batch asked for them.
            if "farm_value" in wanted:
                flat["farm_value"] = model.farm_value(obs_t).cpu().numpy()
            if "route_mode" in wanted:
                flat["route_mode"] = model.route_mode_logits(obs_t).cpu().numpy()
            if "reward_pick" in wanted:
                flat["reward_pick"] = model.reward_pick_logits(obs_t, cands_t, mask_t).cpu().numpy()

        out: list[dict[str, list]] = []
        row = 0
        for j in jobs:
            res: dict[str, list] = {}
            for key in j.want:
                if key not in flat:
                    continue
                if key in ("logits", "reward_pick"):  # ragged per-candidate outputs
                    res[key] = [
                        flat[key][row + i, : c.shape[0]].tolist()
                        for i, c in enumerate(j.cands)
                    ]
                else:  # per-row scalars
                    res[key] = flat[key][row : row + j.n_rows].tolist()
            out.append(res)
            row += j.n_rows
        return out

    async def batcher(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            jobs = [await self.queue.get()]
            rows = jobs[0].n_rows
            deadline = loop.time() + self.window_s
            while rows < self.max_batch_rows:
                timeout = deadline - loop.time()
                if timeout <= 0:
                    break
                try:
                    job = await asyncio.wait_for(self.queue.get(), timeout)
                except asyncio.TimeoutError:
                    break
                jobs.append(job)
                rows += job.n_rows

            try:
                results = await loop.run_in_executor(None, self._forward, jobs)
            except Exception as e:  # noqa: BLE001 — fail the batch, keep serving
                for j in jobs:
                    if not j.future.done():
                        j.future.set_exception(RuntimeError(f"forward failed: {e}"))
                continue
            self.n_batches += 1
            self.n_rows += rows
            self.n_reqs += len(jobs)
            for j, res in zip(jobs, results):
                if not j.future.done():
                    j.future.set_result(res)

    # -- connections ----------------------------------------------------------

    async def handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            while True:
                try:
                    msg = await read_frame(reader)
                except (asyncio.IncompleteReadError, ConnectionResetError):
                    break
                req_id = msg.get("id") if isinstance(msg, dict) else None
                try:
                    want = self.parse_want(msg if isinstance(msg, dict) else {})
                    if "info" in want:
                        result: dict[str, object] = {
                            "info": {
                                "format": "arc-cand-scorer-v1",
                                "obs_dim": self.obs_dim,
                                "act_dim": self.act_dim,
                                "device": str(self.device),
                                "weights": str(self.weights_path),
                                "aux": dict(self.aux),
                            }
                        }
                    else:
                        job = self.make_job(msg, want)
                        if job.n_rows == 0:
                            result = {key: [] for key in want}
                        else:
                            await self.queue.put(job)
                            result = await job.future
                except Exception as e:  # noqa: BLE001 — per-request errors go to the client
                    writer.write(encode_frame({"id": req_id, "error": str(e)}))
                    await writer.drain()
                    continue
                writer.write(encode_frame({"id": req_id, **result}))
                await writer.drain()
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:  # noqa: BLE001
                pass

    # -- stats / reload -------------------------------------------------------

    async def stats_loop(self) -> None:
        if self.stats_interval <= 0:
            return
        while True:
            r0, w0, b0 = self.n_reqs, self.n_rows, self.n_batches
            t0 = time.monotonic()
            await asyncio.sleep(self.stats_interval)
            dt = time.monotonic() - t0
            reqs, rows, batches = self.n_reqs - r0, self.n_rows - w0, self.n_batches - b0
            if batches:
                print(
                    f"[infer] reqs={reqs} rows={rows} batches={batches} "
                    f"avg_batch={rows / batches:.1f} forwards/s={batches / dt:.1f}",
                    file=sys.stderr,
                    flush=True,
                )

    def reload_weights(self) -> None:
        try:
            model, obs_dim, act_dim, aux = load_scorer(self.weights_path, self.device)
        except Exception as e:  # noqa: BLE001 — keep serving the old model
            print(f"[infer] SIGHUP reload FAILED, keeping old weights: {e}",
                  file=sys.stderr, flush=True)
            return
        self.model, self.obs_dim, self.act_dim, self.aux = model, obs_dim, act_dim, aux
        print(f"[infer] reloaded weights from {self.weights_path}", file=sys.stderr, flush=True)


async def serve(args: argparse.Namespace) -> None:
    device = resolve_device(args.device)
    server = InferServer(
        weights_path=args.weights,
        device=device,
        window_s=args.window_ms / 1000.0,
        max_batch_rows=args.max_batch,
        stats_interval=args.stats_interval,
    )
    sock_path = Path(args.socket)
    if sock_path.exists():
        sock_path.unlink()
    sock_path.parent.mkdir(parents=True, exist_ok=True)

    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    loop.add_signal_handler(signal.SIGHUP, server.reload_weights)
    loop.add_signal_handler(signal.SIGINT, stop.set)
    loop.add_signal_handler(signal.SIGTERM, stop.set)

    tasks = [asyncio.create_task(server.batcher()), asyncio.create_task(server.stats_loop())]
    unix_server = await asyncio.start_unix_server(server.handle_connection, path=str(sock_path))
    print(
        f"[infer] serving {args.weights} (obs_dim={server.obs_dim}, act_dim={server.act_dim}) "
        f"on {sock_path} device={device} window={args.window_ms}ms max_batch={args.max_batch}",
        file=sys.stderr,
        flush=True,
    )
    try:
        await stop.wait()
    finally:
        unix_server.close()
        await unix_server.wait_closed()
        for t in tasks:
            t.cancel()
        if sock_path.exists():
            sock_path.unlink()
        print("[infer] shut down", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Client (used by tests and callers-in-progress; the TS side speaks the same frames)
# ---------------------------------------------------------------------------

class InferClient:
    """Minimal async client: one connection, sequential request/response."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._reader = reader
        self._writer = writer
        self._next_id = 0

    @classmethod
    async def connect(cls, socket_path: str | Path) -> "InferClient":
        reader, writer = await asyncio.open_unix_connection(str(socket_path))
        return cls(reader, writer)

    async def info(self) -> dict:
        return await self.request(None, None, want=["info"])

    async def request(self, obs, cands, want: list[str] | None = None, req_id=None) -> dict:
        if req_id is None:
            self._next_id += 1
            req_id = self._next_id
        msg = {"id": req_id}
        if obs is not None:
            msg["obs"] = obs
        if cands is not None:
            msg["cands"] = cands
        if want is not None:
            msg["want"] = want
        self._writer.write(encode_frame(msg))
        await self._writer.drain()
        resp = await read_frame(self._reader)
        if resp.get("id") != req_id:
            raise RuntimeError(f"response id {resp.get('id')!r} != request id {req_id!r}")
        return resp

    async def close(self) -> None:
        self._writer.close()
        try:
            await self._writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Batched inference server for the candidate scorer")
    p.add_argument("--weights", type=Path, default=Path("src/lib/play/ml/policy-weights.json"),
                   help="arc-cand-scorer-v1 JSON weights file (reloaded on SIGHUP)")
    p.add_argument("--socket", type=str, default="/tmp/arc-infer.sock",
                   help="Unix domain socket path to listen on")
    p.add_argument("--device", type=str, default="auto",
                   help="auto (cuda > mps > cpu, honors ARC_DEVICE) or an explicit torch device")
    p.add_argument("--window-ms", type=float, default=2.0,
                   help="Batch collection window after the first pending request")
    p.add_argument("--max-batch", type=int, default=512,
                   help="Flush the batch once this many rows are collected")
    p.add_argument("--stats-interval", type=float, default=1.0,
                   help="Seconds between stats lines on stderr (0 disables)")
    return p.parse_args()


if __name__ == "__main__":
    asyncio.run(serve(parse_args()))
