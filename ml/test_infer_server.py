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
import shutil
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

from model import build_model
from infer_server import (
    InferClient,
    decode_binary_response,
    encode_binary_request,
    encode_frame,
    frame_bytes,
    load_scorer,
    read_payload,
)
from train import export_weights

ML_DIR = Path(__file__).parent
REPO_ROOT = ML_DIR.parent
LIVE_WEIGHTS = REPO_ROOT / "src" / "lib" / "play" / "ml" / "policy-weights.json"
V2_FIXTURE = ML_DIR / "data_fixtures" / "obsv2_fixture.json"
PYTHON = str(ML_DIR / ".venv" / "bin" / "python")

_v2_fixture_cache: dict | None = None


def v2_fixture() -> dict:
    global _v2_fixture_cache
    if _v2_fixture_cache is None:
        _v2_fixture_cache = json.loads(V2_FIXTURE.read_text())
    return _v2_fixture_cache


def make_v2_checkpoint(out_dir: Path, name: str = "v2.pt") -> Path:
    """Fresh-init default-size v2 checkpoint saved via the official convention."""
    from model_v2 import build_model_v2, save_checkpoint
    from obs_v2 import ObsV2Spec

    spec = ObsV2Spec.from_meta(v2_fixture()["meta"])
    model = build_model_v2(spec, 52, torch.device("cpu"), seed=0)
    path = Path(out_dir) / name
    save_checkpoint(model, path)
    return path


def make_v1_reach30_checkpoint(out_dir: Path, name: str = "p30.json") -> Path:
    """Small v1 fixture whose optional reach-30 head is explicitly trained/advertised."""
    path = Path(out_dir) / name
    torch.manual_seed(17)
    model = build_model(7, 5, torch.device("cpu"), trunk_hidden=(8,), value_hidden=(4,))
    model.reach30_trained = True
    model.reach30_horizon = 35
    with torch.no_grad():
        # Keep the fixture deterministic and make the auxiliary output easy to distinguish.
        model.reach30_head[-1].bias.fill_(0.375)
    export_weights(model, 7, 5, path)
    return path


def v2_obs_pool() -> np.ndarray:
    """Real arc-obs-v2 rows: random floats would fail the embedded-header check."""
    return np.asarray(v2_fixture()["flat"], dtype=np.float32)


class ServerProc:
    """Spawn infer_server.py on a temp socket and wait until it accepts connections."""

    def __init__(self, device: str = "cpu", window_ms: float = 2.0, max_batch: int = 512,
                 weights: Path | str | None = None):
        self.dir = tempfile.TemporaryDirectory()
        self.socket_path = str(Path(self.dir.name) / "infer.sock")
        self.log_path = Path(self.dir.name) / "server.log"
        self.log_file = open(self.log_path, "w")
        self.proc = subprocess.Popen(
            [
                PYTHON, str(ML_DIR / "infer_server.py"),
                "--weights", str(weights if weights is not None else LIVE_WEIGHTS),
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
    model, obs_dim, act_dim, _aux, _fmt = load_scorer(LIVE_WEIGHTS, torch.device("cpu"))
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
    # Batched GEMM and one-row GEMV can accumulate float32 products in a different
    # order. This bounds the numerical difference without requiring bit identity.
    assert max_logit_diff < 5e-5, max_logit_diff
    assert max_value_diff < 5e-5, max_value_diff


def test_want_field_and_bad_request_error():
    _, obs_dim, act_dim, _aux, _fmt = load_scorer(LIVE_WEIGHTS, torch.device("cpu"))
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
    _, obs_dim, act_dim, _aux, _fmt = load_scorer(LIVE_WEIGHTS, torch.device("cpu"))
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
    _, obs_dim, act_dim, _aux, _fmt = load_scorer(LIVE_WEIGHTS, torch.device("cpu"))
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


def test_info_handshake_and_aux_heads():
    model, obs_dim, act_dim, aux, _fmt = load_scorer(LIVE_WEIGHTS, torch.device("cpu"))
    rng = np.random.default_rng(11)
    server = ServerProc(device="cpu")

    async def run():
        await server.wait_ready()
        client = await InferClient.connect(server.socket_path)
        info = (await client.info())["info"]
        assert info["obs_dim"] == obs_dim and info["act_dim"] == act_dim, info
        assert info["aux"] == aux, (info["aux"], aux)

        obs, cands = _random_request(rng, obs_dim, act_dim)
        obs_l = [o.tolist() for o in obs]
        cands_l = [c.tolist() for c in cands]
        available = [h for h, ok in aux.items() if ok]
        missing = [h for h, ok in aux.items() if not ok]

        if available:
            resp = await client.request(obs_l, cands_l, want=available)
            assert "error" not in resp, resp
            with torch.no_grad():
                obs_t = torch.from_numpy(obs)
                if "farm_value" in available:
                    ref = model.farm_value(obs_t).numpy()
                    assert np.allclose(resp["farm_value"], ref, atol=1e-5)
                if "route_mode" in available:
                    ref = model.route_mode_logits(obs_t).numpy()
                    assert np.allclose(resp["route_mode"], ref, atol=1e-5)
                if "reward_pick" in available:
                    for i, c in enumerate(cands):
                        logits = model.reward_pick_logits(
                            obs_t[i : i + 1],
                            torch.from_numpy(c).unsqueeze(0),
                            torch.ones(1, c.shape[0], dtype=torch.bool),
                        ).squeeze(0).numpy()
                        assert np.allclose(resp["reward_pick"][i], logits, atol=1e-5)
                if "reach30" in available:
                    ref = model.reach30_logits(obs_t).numpy()
                    assert np.allclose(resp["reach30"], ref, atol=1e-5)
        # A head the checkpoint doesn't carry must be refused, not served from random init.
        if missing:
            resp = await client.request(obs_l, cands_l, want=[missing[0]])
            assert "error" in resp and "not present" in resp["error"], resp
        await client.close()
        return available, missing

    try:
        available, missing = asyncio.run(run())
    finally:
        server.stop()
    print(f"aux heads: served={available} refused={missing}")


def _assert_same_response(json_resp: dict, bin_resp: dict, keys: list[str]) -> None:
    for k in keys:
        if k in ("logits", "reward_pick"):
            for jr, br in zip(json_resp[k], bin_resp[k]):
                assert np.allclose(
                    np.asarray(jr, np.float32), np.asarray(br, np.float32), atol=1e-6
                ), k
        else:
            assert np.allclose(
                np.asarray(json_resp[k], np.float32), np.asarray(bin_resp[k], np.float32), atol=1e-6
            ), k


def test_binary_matches_json_and_malformed_frame():
    _, obs_dim, act_dim, aux, _fmt = load_scorer(LIVE_WEIGHTS, torch.device("cpu"))
    rng = np.random.default_rng(51)
    server = ServerProc(device="cpu")
    want = ["logits", "value"] + [h for h, ok in aux.items() if ok]

    async def run():
        await server.wait_ready()
        client = await InferClient.connect(server.socket_path)
        for _ in range(10):
            obs, cands = _random_request(rng, obs_dim, act_dim)
            obs_l = [o.tolist() for o in obs]
            cands_l = [c.tolist() for c in cands]
            j = await client.request(obs_l, cands_l, want=want)
            b = await client.request_binary(obs, cands, want=want)
            assert "error" not in j and "error" not in b, (j.get("error"), b.get("error"))
            _assert_same_response(j, b, want)

        # Malformed binary frame: errors THIS request; the connection survives.
        client._writer.write(frame_bytes(b"\xb1garbage"))
        await client._writer.drain()
        err = decode_binary_response(await read_payload(client._reader))
        assert "error" in err, err
        ok = await client.request_binary(obs, cands)
        assert "error" not in ok and len(ok["value"]) == len(cands)
        # Unavailable aux head over binary want bits -> per-request error.
        missing = [h for h, has in aux.items() if not has]
        if missing:
            bad = await client.request_binary(obs, cands, want=[missing[0]])
            assert "error" in bad and "not present" in bad["error"], bad
        await client.close()

    try:
        asyncio.run(run())
    finally:
        server.stop()
    print(f"binary==json on v1 for want={want}")


def test_reach30_head_json_binary_and_capability():
    with tempfile.TemporaryDirectory() as td:
        ckpt = make_v1_reach30_checkpoint(Path(td))
        model, obs_dim, act_dim, aux, fmt = load_scorer(ckpt, torch.device("cpu"))
        assert fmt == "arc-cand-scorer-v1" and aux["reach30"] is True
        rng = np.random.default_rng(57)
        obs, cands = _random_request(rng, obs_dim, act_dim)
        server = ServerProc(device="cpu", weights=ckpt)

        async def run():
            await server.wait_ready()
            client = await InferClient.connect(server.socket_path)
            info = (await client.info())["info"]
            assert info["aux"]["reach30"] is True, info
            assert info["reach30_horizon"] == 35, info
            json_resp = await client.request(
                obs.tolist(), [c.tolist() for c in cands], want=["reach30"]
            )
            binary_resp = await client.request_binary(obs, cands, want=["reach30"])
            assert "error" not in json_resp and "error" not in binary_resp
            _assert_same_response(json_resp, binary_resp, ["reach30"])
            with torch.no_grad():
                expected = model.reach30_logits(torch.from_numpy(obs)).numpy()
            assert np.allclose(json_resp["reach30"], expected, atol=1e-6)
            await client.close()

        try:
            asyncio.run(run())
        finally:
            server.stop()


def test_binary_and_json_clients_mixed():
    _, obs_dim, act_dim, _aux, _fmt = load_scorer(LIVE_WEIGHTS, torch.device("cpu"))
    server = ServerProc(device="cpu")
    n_each, n_requests = 4, 50

    async def one_client(ci: int, binary: bool) -> int:
        rng = np.random.default_rng(300 + ci)
        client = await InferClient.connect(server.socket_path)
        for ri in range(n_requests):
            obs, cands = _random_request(rng, obs_dim, act_dim, max_rows=4, max_cands=6)
            if binary:
                resp = await client.request_binary(obs, cands, req_id=f"b{ci}-{ri}")
            else:
                resp = await client.request(
                    [o.tolist() for o in obs], [c.tolist() for c in cands], req_id=f"j{ci}-{ri}"
                )
            assert "error" not in resp, resp
            assert len(resp["logits"]) == len(cands) and len(resp["value"]) == len(cands)
        await client.close()
        return n_requests

    async def run():
        await server.wait_ready()
        jobs = [one_client(i, binary=False) for i in range(n_each)]
        jobs += [one_client(i, binary=True) for i in range(n_each)]
        return await asyncio.gather(*jobs)

    try:
        results = asyncio.run(run())
    finally:
        server.stop()
    assert results == [n_requests] * (2 * n_each), results
    print(f"mixed clients: {n_each} JSON + {n_each} binary x {n_requests} requests, all clean")


def test_v2_correctness_handshake_and_aux():
    with tempfile.TemporaryDirectory() as td:
        ckpt = make_v2_checkpoint(Path(td))
        model, obs_dim, act_dim, aux, fmt = load_scorer(ckpt, torch.device("cpu"))
        assert fmt == "arc-entity-scorer-v2" and obs_dim == 3419 and act_dim == 52
        assert aux == {
            "farm_value": True,
            "route_mode": True,
            "reward_pick": True,
            "reach30": False,
        }
        pool = v2_obs_pool()
        rng = np.random.default_rng(21)
        server = ServerProc(device="cpu", weights=ckpt)

        async def run():
            await server.wait_ready()
            client = await InferClient.connect(server.socket_path)
            info = (await client.info())["info"]
            assert info["format"] == "arc-entity-scorer-v2", info
            assert info["obs_dim"] == 3419 and info["act_dim"] == 52, info
            assert info["aux"] == aux, info
            assert info["reach30_horizon"] is None, info

            max_ld = max_vd = 0.0
            obs = cands = None
            for _ in range(10):
                B = int(rng.integers(1, 5))
                obs = pool[rng.integers(0, pool.shape[0], size=B)]
                cands = [
                    rng.standard_normal((int(rng.integers(1, 9)), act_dim)).astype(np.float32)
                    for _ in range(B)
                ]
                resp = await client.request(
                    obs.tolist(), [c.tolist() for c in cands],
                    want=["logits", "value", "farm_value", "route_mode", "reward_pick"],
                )
                assert "error" not in resp, resp
                with torch.no_grad():
                    obs_t = torch.from_numpy(obs)
                    assert np.allclose(resp["farm_value"], model.farm_value(obs_t).numpy(), atol=1e-5)
                    assert np.allclose(resp["route_mode"], model.route_mode_logits(obs_t).numpy(), atol=1e-5)
                    for i in range(B):
                        logits_t, _, value_t = model.score_single(
                            torch.from_numpy(obs[i]), torch.from_numpy(cands[i])
                        )
                        ref = logits_t.squeeze(0).numpy()
                        got = np.asarray(resp["logits"][i], dtype=np.float32)
                        assert got.shape == ref.shape
                        max_ld = max(max_ld, float(np.abs(got - ref).max()))
                        max_vd = max(max_vd, abs(float(resp["value"][i]) - float(value_t.squeeze())))
                        rp_ref = model.reward_pick_logits(
                            obs_t[i : i + 1],
                            torch.from_numpy(cands[i]).unsqueeze(0),
                            torch.ones(1, cands[i].shape[0], dtype=torch.bool),
                        ).squeeze(0).numpy()
                        assert np.allclose(resp["reward_pick"][i], rp_ref, atol=1e-5)

            # The placement head is NOT exposed over the wire.
            bad = await client.request(obs.tolist(), [c.tolist() for c in cands], want=["placement"])
            assert "error" in bad and "unknown want" in bad["error"], bad
            # Rows without the arc-obs-v2 header fail per-request; connection survives.
            junk = await client.request(
                np.zeros((1, 3419), dtype=np.float32).tolist(),
                [np.zeros((2, act_dim), dtype=np.float32).tolist()],
            )
            assert "error" in junk and "header" in junk["error"], junk
            ok = await client.request(obs[:1].tolist(), [cands[0].tolist()])
            assert "error" not in ok
            await client.close()
            return max_ld, max_vd

        try:
            max_ld, max_vd = asyncio.run(run())
        finally:
            server.stop()
    print(f"v2 correctness: max_logit_diff={max_ld:.2e} max_value_diff={max_vd:.2e}")
    assert max_ld < 1e-5, max_ld
    assert max_vd < 1e-5, max_vd


def test_sighup_swaps_v1_to_v2():
    """A fixed --weights path swaps formats across SIGHUP (manifest is the probe)."""
    with tempfile.TemporaryDirectory() as td:
        current = Path(td) / "current"  # extensionless pointer path
        shutil.copyfile(LIVE_WEIGHTS, current)
        server = ServerProc(device="cpu", weights=current)
        pool = v2_obs_pool()
        rng = np.random.default_rng(31)

        async def run():
            await server.wait_ready()
            client = await InferClient.connect(server.socket_path)
            info1 = (await client.info())["info"]
            live_obs_dim = int(json.loads(current.read_text())["obs_dim"])
            live_act_dim = int(json.loads(current.read_text())["act_dim"])
            assert (
                info1["format"] == "arc-cand-scorer-v1"
                and info1["obs_dim"] == live_obs_dim
            ), info1
            r1 = await client.request(
                rng.standard_normal((1, live_obs_dim)).tolist(),
                [rng.standard_normal((3, live_act_dim)).tolist()],
            )
            assert "error" not in r1

            # Replace the SAME path with a v2 checkpoint (+ sibling manifest), then SIGHUP.
            from model_v2 import build_model_v2, save_checkpoint
            from obs_v2 import ObsV2Spec

            spec = ObsV2Spec.from_meta(v2_fixture()["meta"])
            save_checkpoint(build_model_v2(spec, 52, torch.device("cpu"), seed=0), current)
            server.proc.send_signal(signal.SIGHUP)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if "reloaded weights" in server.log_path.read_text():
                    break
                await asyncio.sleep(0.1)
            else:
                raise TimeoutError(f"no reload log line:\n{server.log_path.read_text()}")

            info2 = (await client.info())["info"]
            assert info2["format"] == "arc-entity-scorer-v2" and info2["obs_dim"] == 3419, info2
            assert info2["aux"] == {
                "farm_value": True,
                "route_mode": True,
                "reward_pick": True,
                "reach30": False,
            }
            ok = await client.request(pool[:1].tolist(), [rng.standard_normal((3, 52)).tolist()])
            assert "error" not in ok and len(ok["logits"][0]) == 3, ok
            stale = await client.request(
                rng.standard_normal((1, live_obs_dim)).tolist(),
                [rng.standard_normal((3, live_act_dim)).tolist()],
            )
            assert "error" in stale, stale  # old-format rows are refused after the swap
            await client.close()

        try:
            asyncio.run(run())
        finally:
            server.stop()


def test_v2_throughput_report():
    """v2 transformer at realistic decision shapes (B=32 rows, C=30 cands) on auto
    device: JSON vs binary framing, single client and 8 clients, plus the
    bytes-per-request comparison for the TS client."""
    with tempfile.TemporaryDirectory() as td:
        ckpt = make_v2_checkpoint(Path(td))
        server = ServerProc(device="auto", weights=ckpt)
        pool = v2_obs_pool()
        rng = np.random.default_rng(41)
        rows_per_req, n_cands = 32, 30
        obs_arr = pool[rng.integers(0, pool.shape[0], size=rows_per_req)]
        cand_arrs = [rng.standard_normal((n_cands, 52)).astype(np.float32) for _ in range(rows_per_req)]
        obs = obs_arr.tolist()
        cands = [c.tolist() for c in cand_arrs]

        json_bytes = len(encode_frame({"id": 1, "obs": obs, "cands": cands}))
        bin_bytes = len(frame_bytes(encode_binary_request("1", obs_arr, cand_arrs, 0)))

        async def closed_loop(binary: bool, n_reqs: int) -> int:
            client = await InferClient.connect(server.socket_path)
            for _ in range(n_reqs):
                if binary:
                    resp = await client.request_binary(obs_arr, cand_arrs)
                else:
                    resp = await client.request(obs, cands)
                assert "error" not in resp
            await client.close()
            return n_reqs * rows_per_req

        async def measure(binary: bool) -> tuple[float, float]:
            t0 = time.monotonic()
            rows = await closed_loop(binary, 20)
            single = rows / (time.monotonic() - t0)
            t0 = time.monotonic()
            totals = await asyncio.gather(*(closed_loop(binary, 8) for _ in range(8)))
            eight = sum(totals) / (time.monotonic() - t0)
            return single, eight

        async def run():
            await server.wait_ready()
            await closed_loop(False, 3)  # warmup (device kernels + first forwards)
            json_nums = await measure(binary=False)
            bin_nums = await measure(binary=True)
            # Sanity: both framings return the same scores for the same inputs.
            client = await InferClient.connect(server.socket_path)
            j = await client.request(obs, cands)
            b = await client.request_binary(obs_arr, cand_arrs)
            _assert_same_response(j, b, ["logits", "value"])
            await client.close()
            return json_nums, bin_nums

        try:
            (json_single, json_eight), (bin_single, bin_eight) = asyncio.run(run())
            log_tail = "\n".join(server.log_path.read_text().strip().splitlines()[-3:])
        finally:
            server.stop()
    print(f"v2 throughput (auto device, {rows_per_req} rows/req, {n_cands} cands/row):")
    print(f"  request size: JSON {json_bytes:,} B vs binary {bin_bytes:,} B "
          f"({json_bytes / bin_bytes:.1f}x smaller)")
    print(f"  JSON   single: {json_single:,.0f} rows/s | 8 clients: {json_eight:,.0f} rows/s")
    print(f"  binary single: {bin_single:,.0f} rows/s | 8 clients: {bin_eight:,.0f} rows/s")
    print(f"  speedup: single {bin_single / json_single:.2f}x | 8-client {bin_eight / json_eight:.2f}x")
    print(f"  server log tail:\n{log_tail}")
    assert bin_single > 0 and bin_eight > 0 and json_single > 0 and json_eight > 0


def test_throughput_report():
    """Not an assertion-heavy test: measures rows/s on the auto-selected device."""
    _, obs_dim, act_dim, _aux, _fmt = load_scorer(LIVE_WEIGHTS, torch.device("cpu"))
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
        test_info_handshake_and_aux_heads,
        test_binary_matches_json_and_malformed_frame,
        test_reach30_head_json_binary_and_capability,
        test_binary_and_json_clients_mixed,
        test_v2_correctness_handshake_and_aux,
        test_sighup_swaps_v1_to_v2,
        test_throughput_report,
        test_v2_throughput_report,
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
