"""
Batched GPU inference server for the Arc Spirits candidate scorer.

Serves scoring requests over a Unix domain socket, coalescing rows from
concurrent connections into single forward passes. --weights accepts either:
  - arc-cand-scorer-v1 JSON (CandidateScorer MLP; obs_dim is read from the file —
    77 for obs v1.1, whatever the encoder currently emits), or
  - arc-entity-scorer-v2 .pt with a sibling .manifest.json (EntityCandidateScorer
    set-transformer; obs rows = the flat arc-obs-v2 arrays, 3419 floats for the
    frozen catalog). The manifest is the format probe, so SIGHUP can swap a
    fixed --weights path between v1 and v2 checkpoints; the info handshake
    reports the active format/obs_dim so RemotePolicy self-configures.
    The v2 placement head has a different per-seat regression contract and is
    intentionally not exposed as the v1 4-way placement distribution.

Framing:  4-byte little-endian length prefix + payload. The payload is JSON
          (starts with '{') or a binary frame (first byte 0xB1) — see the
          "Binary framing" block below; connections may mix both freely.
Request:  {"id": <any>, "obs": [B x obs_dim], "cands": [B x C_i x act_dim],
           "want": ["logits", "value"]}          (want optional, default both;
                                                  cands may be ragged per row)
          Extra want keys: "farm_value" -> [B], "route_mode" -> [B] (raw logit;
          sigmoid is applied client-side), "reward_pick" -> ragged [B x C_i],
          "placement" -> [B x 4] raw logits, "reach30" -> [B] raw logits.
          Aux heads are served only when the weights file carries them.
          Handshake: {"id": <any>, "want": ["info"]} needs no obs/cands and
          returns {"id", "info": {format, obs_dim, act_dim, device, weights,
          aux: {farm_value, route_mode, reward_pick, placement, reach30}}}.
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
from collections import Counter
import json
import math
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


def frame_bytes(payload: bytes) -> bytes:
    return struct.pack("<I", len(payload)) + payload


def encode_frame(obj: dict) -> bytes:
    return frame_bytes(json.dumps(obj, separators=(",", ":")).encode())


async def read_payload(reader: asyncio.StreamReader) -> bytes:
    header = await reader.readexactly(4)
    (length,) = struct.unpack("<I", header)
    if length > MAX_FRAME_BYTES:
        raise ValueError(f"frame of {length} bytes exceeds limit")
    return await reader.readexactly(length)


async def read_frame(reader: asyncio.StreamReader) -> dict:
    return json.loads(await read_payload(reader))


# ---------------------------------------------------------------------------
# Binary framing (v1)
# ---------------------------------------------------------------------------
# Same outer length prefix as JSON; the first PAYLOAD byte disambiguates
# (JSON always starts with '{' = 0x7B, binary requests with 0xB1). No
# negotiation round-trip; scoring only — the info handshake stays JSON.
# All integers little-endian, floats little-endian f32. Bump the magic bytes
# for any layout change.
#
# Request  = [0xB1 u8][want u8][id_len u32][B u32][obs_dim u32][act_dim u32]
#            [C_i u32 x B][id utf8][obs f32 x B*obs_dim]
#            [cands f32 x sum(C_i)*act_dim, row-major per row]
# Response = [0xB2 u8][flags u8][id_len u32][id utf8] then
#            if flags & 0x80 (error): [msg_len u32][msg utf8]
#            else: [B u32][C_i u32 x B] + one section per set flag bit, in
#            BIN_SECTION_ORDER: logits f32 x sum(C_i), value f32 x B,
#            farm_value f32 x B, route_mode f32 x B, reward_pick f32 x sum(C_i),
#            reach30 f32 x B, placement f32 x B*4
# want bitmask: 1=logits 2=value 4=farm_value 8=route_mode 16=reward_pick
#               32=reach30 64=placement;
# 0 = default (logits|value). Binary ids are UTF-8 strings, echoed verbatim.

BIN_MAGIC_REQUEST = 0xB1
BIN_MAGIC_RESPONSE = 0xB2
BIN_ERROR_FLAG = 0x80
BIN_WANT_BITS = {
    "logits": 1, "value": 2, "farm_value": 4, "route_mode": 8,
    "reward_pick": 16, "reach30": 32, "placement": 64,
}
BIN_SECTION_ORDER = (
    "logits", "value", "farm_value", "route_mode", "reward_pick", "reach30", "placement"
)
_BIN_REQ_HEADER = struct.Struct("<BBIIII")  # magic, want, id_len, B, obs_dim, act_dim


def want_from_bits(bits: int) -> frozenset[str]:
    if bits == 0:
        return frozenset(("logits", "value"))
    unknown = bits & ~sum(BIN_WANT_BITS.values())
    if unknown:
        raise ValueError(f"unknown want bits 0x{unknown:02x}")
    return frozenset(k for k, b in BIN_WANT_BITS.items() if bits & b)


def encode_binary_request(
    req_id: str, obs: np.ndarray, cands: list[np.ndarray], want_bits: int = 0
) -> bytes:
    obs = np.ascontiguousarray(obs, dtype="<f4")
    idb = str(req_id).encode()
    act_dim = cands[0].shape[1] if cands else 0
    parts = [
        _BIN_REQ_HEADER.pack(BIN_MAGIC_REQUEST, want_bits, len(idb),
                             obs.shape[0], obs.shape[1] if obs.ndim == 2 else 0, act_dim),
        np.asarray([c.shape[0] for c in cands], dtype="<u4").tobytes(),
        idb,
        obs.tobytes(),
    ]
    parts += [np.ascontiguousarray(c, dtype="<f4").tobytes() for c in cands]
    return b"".join(parts)


def decode_binary_request(payload: bytes) -> tuple[str, np.ndarray, list[np.ndarray], int]:
    """Returns (req_id, obs (B,obs_dim) f32, cands list of (C_i,act_dim) f32, want_bits)."""
    if len(payload) < _BIN_REQ_HEADER.size:
        raise ValueError("binary request truncated (header)")
    _magic, want_bits, id_len, B, obs_dim, act_dim = _BIN_REQ_HEADER.unpack_from(payload, 0)
    if id_len > len(payload) or B > 10_000_000:
        raise ValueError("binary request header out of range")
    off = _BIN_REQ_HEADER.size
    counts = np.frombuffer(payload, dtype="<u4", count=B, offset=off)
    off += 4 * B
    req_id = payload[off : off + id_len].decode("utf-8")
    off += id_len
    obs = np.frombuffer(payload, dtype="<f4", count=B * obs_dim, offset=off)
    obs = obs.reshape(B, obs_dim).copy()  # copy: frombuffer views are read-only
    off += 4 * B * obs_dim
    cands: list[np.ndarray] = []
    for c in counts.tolist():
        n = int(c) * act_dim
        cands.append(
            np.frombuffer(payload, dtype="<f4", count=n, offset=off).reshape(int(c), act_dim).copy()
        )
        off += 4 * n
    if off != len(payload):
        raise ValueError(f"binary request length mismatch: parsed {off} of {len(payload)} bytes")
    return req_id, obs, cands, want_bits


def encode_binary_response(req_id: str, result: dict[str, list], counts: list[int]) -> bytes:
    idb = str(req_id).encode()
    flags = sum(BIN_WANT_BITS[k] for k in BIN_SECTION_ORDER if k in result)
    parts = [
        struct.pack("<BBI", BIN_MAGIC_RESPONSE, flags, len(idb)),
        idb,
        struct.pack("<I", len(counts)),
        np.asarray(counts, dtype="<u4").tobytes(),
    ]
    for k in BIN_SECTION_ORDER:
        if k not in result:
            continue
        if k in ("logits", "reward_pick"):
            flat = [x for row in result[k] for x in row]
            parts.append(np.asarray(flat, dtype="<f4").tobytes())
        elif k == "placement":
            arr = np.asarray(result[k], dtype="<f4")
            if arr.shape != (len(counts), 4):
                raise ValueError(f"placement response must be [B x 4], got {arr.shape}")
            parts.append(arr.tobytes())
        else:
            parts.append(np.asarray(result[k], dtype="<f4").tobytes())
    return b"".join(parts)


def encode_binary_error(req_id: str, message: str) -> bytes:
    idb = str(req_id).encode()
    msg = message.encode()
    return b"".join([
        struct.pack("<BBI", BIN_MAGIC_RESPONSE, BIN_ERROR_FLAG, len(idb)),
        idb,
        struct.pack("<I", len(msg)),
        msg,
    ])


def decode_binary_response(payload: bytes) -> dict:
    """Decodes to the SAME shape as a JSON response dict ({"id", sections} or {"id","error"})."""
    if len(payload) < 6 or payload[0] != BIN_MAGIC_RESPONSE:
        raise ValueError("not a binary response frame")
    flags = payload[1]
    (id_len,) = struct.unpack_from("<I", payload, 2)
    off = 6
    req_id = payload[off : off + id_len].decode("utf-8")
    off += id_len
    if flags & BIN_ERROR_FLAG:
        (msg_len,) = struct.unpack_from("<I", payload, off)
        off += 4
        return {"id": req_id, "error": payload[off : off + msg_len].decode("utf-8")}
    (B,) = struct.unpack_from("<I", payload, off)
    off += 4
    counts = np.frombuffer(payload, dtype="<u4", count=B, offset=off).tolist()
    off += 4 * B
    total = int(sum(counts))
    out: dict = {"id": req_id}
    for k in BIN_SECTION_ORDER:
        if not (flags & BIN_WANT_BITS[k]):
            continue
        n = total if k in ("logits", "reward_pick") else B * 4 if k == "placement" else B
        arr = np.frombuffer(payload, dtype="<f4", count=n, offset=off)
        off += 4 * n
        if k in ("logits", "reward_pick"):
            rows, i = [], 0
            for c in counts:
                rows.append(arr[i : i + c].tolist())
                i += c
            out[k] = rows
        elif k == "placement":
            out[k] = arr.reshape(B, 4).tolist()
        else:
            out[k] = arr.tolist()
    return out


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

AUX_HEADS = ("farm_value", "route_mode", "reward_pick", "placement", "reach30")
FORMAT_V1 = "arc-cand-scorer-v1"
FORMAT_V2 = "arc-entity-scorer-v2"


def load_scorer(
    weights_path: Path, device: torch.device
) -> tuple[torch.nn.Module, int, int, dict[str, bool], str]:
    """Load a checkpoint of either format.

    Returns (model, obs_dim, act_dim, aux availability, format string). The
    format probe is the sibling .manifest.json (v2), falling back to v1 JSON —
    content-based, so a fixed --weights path can swap formats across SIGHUPs.
    """
    weights_path = Path(weights_path)
    manifest_path = weights_path.with_suffix(".manifest.json")
    manifest = None
    if manifest_path.exists():
        with open(manifest_path) as f:
            manifest = json.load(f)
    if manifest is not None and manifest.get("format") == FORMAT_V2:
        from model_v2 import load_checkpoint  # lazy: v1-only deployments never pay for it

        model = load_checkpoint(weights_path, device)
        model.eval()
        obs_dim = model.obs_dim  # = spec.flat_length
        if int(manifest.get("obs_flat_len", obs_dim)) != obs_dim:
            raise ValueError(
                f"{manifest_path.name}: obs_flat_len {manifest.get('obs_flat_len')} "
                f"!= checkpoint flat length {obs_dim}"
            )
        # v2 checkpoints carry the legacy auxiliary heads. New checkpoints may
        # additionally expose a trained multi-horizon solo critic; old v2 files
        # remain valid and fail closed for that request.
        # v2's placement head predicts one ordinal score per seat token. It is not
        # the v1 head's four-class ego-placement distribution, so fail closed for
        # the wire-level `placement` request rather than silently changing meaning.
        aux = {k: k != "placement" for k in AUX_HEADS}
        aux["reach30"] = bool(getattr(model, "reach30_trained", False))
        return model, obs_dim, model.act_dim, aux, FORMAT_V2
    if weights_path.suffix == ".pt":
        raise ValueError(
            f"{weights_path}: .pt checkpoint without a valid sibling "
            f"{manifest_path.name} (format {FORMAT_V2!r})"
        )

    with open(weights_path) as f:
        payload = json.load(f)
    if payload.get("format") != FORMAT_V1:
        raise ValueError(f"{weights_path}: unexpected format {payload.get('format')!r}")
    raw_option_dim = payload.get("option_dim", 0)
    if (
        isinstance(raw_option_dim, bool)
        or not isinstance(raw_option_dim, (int, float))
        or not float(raw_option_dim).is_integer()
        or int(raw_option_dim) < 0
    ):
        raise ValueError(f"{weights_path}: malformed option_dim {raw_option_dim!r}")
    if int(raw_option_dim) != 0:
        raise ValueError(
            f"{weights_path}: option-enabled checkpoints require in-process actors; "
            "the inference wire has no persistent round-option context"
        )
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
    return model, obs_dim, act_dim, aux, FORMAT_V1


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
        self.model, self.obs_dim, self.act_dim, self.aux, self.model_format = load_scorer(
            weights_path, device
        )
        self.reach30_horizon = getattr(self.model, "reach30_horizon", None)
        self._v2_header = self._expected_header()
        self.queue: asyncio.Queue[_Job] = asyncio.Queue()
        self.n_reqs = 0
        self.n_rows = 0
        self.n_batches = 0
        self.batch_row_counts: Counter[int] = Counter()

    def _expected_header(self) -> np.ndarray | None:
        """For v2, the arc-obs-v2 header every obs row must start with."""
        if self.model_format != FORMAT_V2:
            return None
        return np.asarray(self.model.spec.header, dtype=np.float32)

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
        self.check_aux_available(want)
        return want

    def check_aux_available(self, want: frozenset[str]) -> None:
        for head in AUX_HEADS:
            if head in want and not self.aux.get(head):
                raise ValueError(f"{head} head not present in {self.weights_path.name}")

    def make_job(self, msg: dict, want: frozenset[str]) -> _Job:
        obs_raw = msg.get("obs")
        cands_raw = msg.get("cands")
        if not isinstance(obs_raw, list) or not isinstance(cands_raw, list):
            raise ValueError("obs and cands must be lists")
        obs = np.asarray(obs_raw, dtype=np.float32) if obs_raw else np.zeros((0, self.obs_dim), dtype=np.float32)
        cands = [np.asarray(row, dtype=np.float32) for row in cands_raw]
        return self.job_from_arrays(obs, cands, want)

    def job_from_arrays(
        self, obs: np.ndarray, cands: list[np.ndarray], want: frozenset[str]
    ) -> _Job:
        """Shared validation for the JSON and binary paths (arrays already f32)."""
        loop = asyncio.get_running_loop()
        if obs.shape[0] != len(cands):
            raise ValueError(f"obs has {obs.shape[0]} rows but cands has {len(cands)}")
        if len(cands) == 0:
            return _Job(
                obs=np.zeros((0, self.obs_dim), dtype=np.float32),
                cands=[],
                want=want,
                future=loop.create_future(),
            )
        if obs.ndim != 2 or obs.shape[1] != self.obs_dim:
            raise ValueError(f"obs must be [B x {self.obs_dim}], got shape {obs.shape}")
        if self._v2_header is not None:
            # Validate the embedded arc-obs-v2 header up front so a bad row fails
            # THIS request instead of the whole coalesced batch inside forward.
            hlen = self._v2_header.shape[0]
            if not bool((obs[:, :hlen] == self._v2_header).all()):
                raise ValueError(
                    "obs rows do not carry the arc-obs-v2 header this checkpoint "
                    f"expects ({self.model_format}, obs_dim={self.obs_dim})"
                )
        for i, c in enumerate(cands):
            if c.ndim != 2 or c.shape[0] < 1 or c.shape[1] != self.act_dim:
                raise ValueError(
                    f"cands[{i}] must be [C_i x {self.act_dim}] with C_i >= 1, got shape {c.shape}"
                )
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
            if "placement" in wanted:
                flat["placement"] = model.placement_head_logits(obs_t).cpu().numpy()
            if "reach30" in wanted:
                flat["reach30"] = model.reach30_logits(obs_t).cpu().numpy()

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
                elif key == "placement":
                    res[key] = flat[key][row : row + j.n_rows].tolist()
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
            self.batch_row_counts[rows] += 1
            for j, res in zip(jobs, results):
                if not j.future.done():
                    j.future.set_result(res)

    # -- connections ----------------------------------------------------------

    async def handle_binary(self, payload: bytes, writer: asyncio.StreamWriter) -> None:
        req_id = ""
        try:
            req_id, obs, cands, want_bits = decode_binary_request(payload)
            want = want_from_bits(want_bits)
            self.check_aux_available(want)
            job = self.job_from_arrays(obs, cands, want)
            if job.n_rows == 0:
                result: dict[str, list] = {key: [] for key in want}
            else:
                await self.queue.put(job)
                result = await job.future
            writer.write(frame_bytes(
                encode_binary_response(req_id, result, [c.shape[0] for c in cands])
            ))
        except Exception as e:  # noqa: BLE001 — per-request errors go to the client
            writer.write(frame_bytes(encode_binary_error(req_id, str(e))))
        await writer.drain()

    async def handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            while True:
                try:
                    payload = await read_payload(reader)
                except (asyncio.IncompleteReadError, ConnectionResetError):
                    break
                if payload[:1] == bytes((BIN_MAGIC_REQUEST,)):
                    await self.handle_binary(payload, writer)
                    continue
                msg = json.loads(payload)
                req_id = msg.get("id") if isinstance(msg, dict) else None
                try:
                    want = self.parse_want(msg if isinstance(msg, dict) else {})
                    if "info" in want:
                        result: dict[str, object] = {
                            "info": {
                                "format": self.model_format,
                                "obs_dim": self.obs_dim,
                                "act_dim": self.act_dim,
                                "device": str(self.device),
                                "weights": str(self.weights_path),
                                "aux": dict(self.aux),
                                "reach30_horizon": self.reach30_horizon,
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
            batch_counts0 = self.batch_row_counts.copy()
            t0 = time.monotonic()
            await asyncio.sleep(self.stats_interval)
            dt = time.monotonic() - t0
            reqs, rows, batches = self.n_reqs - r0, self.n_rows - w0, self.n_batches - b0
            if batches:
                batch_counts = self.batch_row_counts - batch_counts0

                def hist_percentile(q: float) -> int:
                    target = max(1, math.ceil(q * sum(batch_counts.values())))
                    seen = 0
                    for size, count in sorted(batch_counts.items()):
                        seen += count
                        if seen >= target:
                            return size
                    return max(batch_counts)

                print(
                    f"[infer] reqs={reqs} rows={rows} batches={batches} "
                    f"avg_batch={rows / batches:.1f} "
                    f"batch_p50={hist_percentile(0.50)} "
                    f"batch_p95={hist_percentile(0.95)} "
                    f"batch_min={min(batch_counts)} batch_max={max(batch_counts)} "
                    f"forwards/s={batches / dt:.1f}",
                    file=sys.stderr,
                    flush=True,
                )

    def reload_weights(self) -> None:
        try:
            model, obs_dim, act_dim, aux, fmt = load_scorer(self.weights_path, self.device)
        except Exception as e:  # noqa: BLE001 — keep serving the old model
            print(f"[infer] SIGHUP reload FAILED, keeping old weights: {e}",
                  file=sys.stderr, flush=True)
            return
        self.model, self.obs_dim, self.act_dim, self.aux, self.model_format = (
            model, obs_dim, act_dim, aux, fmt
        )
        self.reach30_horizon = getattr(model, "reach30_horizon", None)
        self._v2_header = self._expected_header()
        print(
            f"[infer] reloaded weights from {self.weights_path} "
            f"({self.model_format}, obs_dim={obs_dim})",
            file=sys.stderr, flush=True,
        )


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
        f"[infer] serving {args.weights} ({server.model_format}, "
        f"obs_dim={server.obs_dim}, act_dim={server.act_dim}) "
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

    async def request_binary(self, obs, cands, want: list[str] | None = None, req_id=None) -> dict:
        """Binary-framed request; returns the same dict shape as request()."""
        if req_id is None:
            self._next_id += 1
            req_id = self._next_id
        bits = 0 if want is None else sum(BIN_WANT_BITS[w] for w in want)
        obs_arr = np.asarray(obs, dtype=np.float32)
        cand_arrs = [np.asarray(c, dtype=np.float32) for c in cands]
        self._writer.write(frame_bytes(encode_binary_request(str(req_id), obs_arr, cand_arrs, bits)))
        await self._writer.drain()
        resp = decode_binary_response(await read_payload(self._reader))
        if resp.get("id") != str(req_id):
            raise RuntimeError(f"response id {resp.get('id')!r} != request id {req_id!r}")
        return resp

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
                   help="arc-cand-scorer-v1 JSON or arc-entity-scorer-v2 .pt (+ sibling "
                        ".manifest.json) checkpoint; reloaded and re-probed on SIGHUP")
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
