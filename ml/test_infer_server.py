"""
End-to-end tests for the batched inference server (infer_server.py).

Spawns the server as a subprocess on a temp socket with the live weights
(src/lib/play/ml/policy-weights.json), then checks correctness against a
direct in-process forward, concurrent-client behavior, and throughput.

Run with pytest if available, or directly (the venv has no pytest):
  ml/.venv/bin/python ml/test_infer_server.py
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import torch

from infer_server import InferClient, load_scorer

ML_DIR = Path(__file__).parent
REPO_ROOT = ML_DIR.parent
LIVE_WEIGHTS = REPO_ROOT / "src" / "lib" / "play" / "ml" / "policy-weights.json"
PYTHON = str(ML_DIR / ".venv" / "bin" / "python")


class ServerProc:
    """Spawn infer_server.py on a temp socket and wait until it accepts connections."""

    def __init__(self, device: str = "cpu", window_ms: float = 2.0, max_batch: int = 512):
        self.dir = tempfile.TemporaryDirectory()
        self.socket_path = str(Path(self.dir.name) / "infer.sock")
        self.log_path = Path(self.dir.name) / "server.log"
        self.log_file = open(self.log_path, "w")
        self.proc = subprocess.Popen(
            [
                PYTHON, str(ML_DIR / "infer_server.py"),
                "--weights", str(LIVE_WEIGHTS),
                "--socket", self.socket_path,
                "--device", device,
                "--window-ms", str(window_ms),
                "--max-batch", str(max_batch),
            ],
            stdout=self.log_file,
            stderr=self.log_file,
            cwd=str(REPO_ROOT),
        )

    async def wait_ready(self, timeout: float = 30.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"server exited early:\n{self.log_path.read_text()}")
            if os.path.exists(self.socket_path):
                try:
                    client = await InferClient.connect(self.socket_path)
                    await client.close()
                    return
                except OSError:
                    pass
            await asyncio.sleep(0.1)
        raise TimeoutError(f"server not ready in {timeout}s:\n{self.log_path.read_text()}")

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.log_file.close()
        self.dir.cleanup()


def _random_request(rng: np.random.Generator, obs_dim: int, act_dim: int,
                    max_rows: int = 6, max_cands: int = 8):
    B = int(rng.integers(1, max_rows + 1))
    obs = rng.standard_normal((B, obs_dim)).astype(np.float32)
    cands = [
        rng.standard_normal((int(rng.integers(1, max_cands + 1)), act_dim)).astype(np.float32)
        for _ in range(B)
    ]
    return obs, cands


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_correctness_matches_in_process_forward():
    model, obs_dim, act_dim = load_scorer(LIVE_WEIGHTS, torch.device("cpu"))
    rng = np.random.default_rng(0)
    server = ServerProc(device="cpu")

    async def run():
        await server.wait_ready()
        client = await InferClient.connect(server.socket_path)
        max_logit_diff = max_value_diff = 0.0
        for _ in range(20):
            obs, cands = _random_request(rng, obs_dim, act_dim)
            resp = await client.request(
                [o.tolist() for o in obs], [c.tolist() for c in cands]
            )
            assert "error" not in resp, resp
            with torch.no_grad():
                for i in range(len(cands)):
                    logits_t, _, value_t = model.score_single(
                        torch.from_numpy(obs[i]), torch.from_numpy(cands[i])
                    )
                    ref_logits = logits_t.squeeze(0).numpy()
                    got = np.array(resp["logits"][i], dtype=np.float32)
                    assert got.shape == ref_logits.shape, (got.shape, ref_logits.shape)
                    max_logit_diff = max(max_logit_diff, float(np.abs(got - ref_logits).max()))
                    max_value_diff = max(
                        max_value_diff, abs(float(resp["value"][i]) - float(value_t.squeeze()))
                    )
        await client.close()
        return max_logit_diff, max_value_diff

    try:
        max_logit_diff, max_value_diff = asyncio.run(run())
    finally:
        server.stop()
    print(f"correctness: max_logit_diff={max_logit_diff:.2e} max_value_diff={max_value_diff:.2e}")
    assert max_logit_diff < 1e-5, max_logit_diff
    assert max_value_diff < 1e-5, max_value_diff


def test_want_field_and_bad_request_error():
    _, obs_dim, act_dim = load_scorer(LIVE_WEIGHTS, torch.device("cpu"))
    rng = np.random.default_rng(1)
    server = ServerProc(device="cpu")

    async def run():
        await server.wait_ready()
        client = await InferClient.connect(server.socket_path)
        obs, cands = _random_request(rng, obs_dim, act_dim)
        resp = await client.request(
            [o.tolist() for o in obs], [c.tolist() for c in cands], want=["value"]
        )
        assert "value" in resp and "logits" not in resp, resp.keys()
        # Wrong act_dim must produce a per-request error, and the connection survives.
        bad = await client.request([[0.0] * obs_dim], [[[0.0] * (act_dim + 1)]])
        assert "error" in bad, bad
        ok = await client.request(
            [o.tolist() for o in obs], [c.tolist() for c in cands]
        )
        assert "error" not in ok and len(ok["value"]) == len(cands)
        await client.close()

    try:
        asyncio.run(run())
    finally:
        server.stop()


def test_concurrent_clients_no_drops():
    _, obs_dim, act_dim = load_scorer(LIVE_WEIGHTS, torch.device("cpu"))
    server = ServerProc(device="cpu")
    n_clients, n_requests = 8, 200

    async def one_client(ci: int) -> int:
        rng = np.random.default_rng(100 + ci)
        client = await InferClient.connect(server.socket_path)
        done = 0
        for ri in range(n_requests):
            B = int(rng.integers(1, 5))
            obs = rng.standard_normal((B, obs_dim)).tolist()
            cands = [
                rng.standard_normal((int(rng.integers(1, 7)), act_dim)).tolist()
                for _ in range(B)
            ]
            # InferClient.request raises on a mismatched response id.
            resp = await client.request(obs, cands, req_id=f"c{ci}-r{ri}")
            assert "error" not in resp, resp
            assert len(resp["logits"]) == B and len(resp["value"]) == B
            for row_logits, row_cands in zip(resp["logits"], cands):
                assert len(row_logits) == len(row_cands)
            done += 1
        await client.close()
        return done

    async def run():
        await server.wait_ready()
        results = await asyncio.gather(*(one_client(i) for i in range(n_clients)))
        return results

    try:
        results = asyncio.run(run())
    finally:
        server.stop()
    assert results == [n_requests] * n_clients, results
    print(f"concurrency: {n_clients} clients x {n_requests} requests, all ids matched")


def test_sighup_reload_keeps_serving():
    _, obs_dim, act_dim = load_scorer(LIVE_WEIGHTS, torch.device("cpu"))
    rng = np.random.default_rng(7)
    server = ServerProc(device="cpu")

    async def run():
        await server.wait_ready()
        client = await InferClient.connect(server.socket_path)
        obs, cands = _random_request(rng, obs_dim, act_dim)
        obs_l = [o.tolist() for o in obs]
        cands_l = [c.tolist() for c in cands]
        before = await client.request(obs_l, cands_l)

        server.proc.send_signal(signal.SIGHUP)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if "reloaded weights" in server.log_path.read_text():
                break
            await asyncio.sleep(0.1)
        else:
            raise TimeoutError(f"no reload log line:\n{server.log_path.read_text()}")

        after = await client.request(obs_l, cands_l)
        await client.close()
        return before, after

    try:
        before, after = asyncio.run(run())
    finally:
        server.stop()
    # Same weights file -> identical outputs after the swap.
    assert np.allclose(
        np.concatenate([np.asarray(r) for r in before["logits"]]),
        np.concatenate([np.asarray(r) for r in after["logits"]]),
    )
    assert np.allclose(before["value"], after["value"])


def test_throughput_report():
    """Not an assertion-heavy test: measures rows/s on the auto-selected device."""
    _, obs_dim, act_dim = load_scorer(LIVE_WEIGHTS, torch.device("cpu"))
    device = "auto"  # mps on this Mac if available, else cpu
    server = ServerProc(device=device)
    rows_per_req = 32
    n_cands = 6

    def make_payload(rng: np.random.Generator):
        obs = rng.standard_normal((rows_per_req, obs_dim)).tolist()
        cands = [
            rng.standard_normal((n_cands, act_dim)).tolist() for _ in range(rows_per_req)
        ]
        return obs, cands

    async def closed_loop(ci: int, n_reqs: int) -> int:
        rng = np.random.default_rng(200 + ci)
        obs, cands = make_payload(rng)
        client = await InferClient.connect(server.socket_path)
        for _ in range(n_reqs):
            resp = await client.request(obs, cands)
            assert "error" not in resp
        await client.close()
        return n_reqs * rows_per_req

    async def run():
        await server.wait_ready()
        # warmup (first forward compiles kernels / warms the device)
        await closed_loop(99, 5)

        t0 = time.monotonic()
        rows = await closed_loop(0, 100)
        single = rows / (time.monotonic() - t0)

        t0 = time.monotonic()
        totals = await asyncio.gather(*(closed_loop(i, 50) for i in range(8)))
        eight = sum(totals) / (time.monotonic() - t0)
        return single, eight

    try:
        single, eight = asyncio.run(run())
        log_tail = "\n".join(
            Path(server.log_path).read_text().strip().splitlines()[-4:]
        )
    finally:
        server.stop()
    print(f"throughput (device={device}, {rows_per_req} rows/req, {n_cands} cands/row):")
    print(f"  single client: {single:,.0f} rows/s")
    print(f"  8 clients:     {eight:,.0f} rows/s")
    print(f"  server log tail:\n{log_tail}")
    assert single > 0 and eight > 0


def main() -> int:
    if not LIVE_WEIGHTS.exists():
        print(f"live weights not found: {LIVE_WEIGHTS}")
        return 1
    meta = json.loads(LIVE_WEIGHTS.read_text())
    print(f"live weights: obs_dim={meta['obs_dim']} act_dim={meta['act_dim']}\n")
    tests = [
        test_correctness_matches_in_process_forward,
        test_want_field_and_bad_request_error,
        test_concurrent_clients_no_drops,
        test_sighup_reload_keeps_serving,
        test_throughput_report,
    ]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"PASS {fn.__name__}\n")
        except Exception:
            failed += 1
            print(f"FAIL {fn.__name__}")
            traceback.print_exc()
    print(f"{len(tests) - failed}/{len(tests)} tests passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
