#!/usr/bin/env python3
"""Exact-stack, fresh-server CUDA determinism preflight for P30."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
from pathlib import Path
from typing import Any

from analyze_v35_p30_long_horizon import (
    REPO_ROOT,
    read_json_object,
    resolve_artifact,
    sha256,
    validate_initial_policy_artifacts,
    validate_protocol,
)
from audit_v35_p30_generation import source_identity
from run_v35_p30_evaluation_attempt import (
    GPU_UUID,
    isolated_command,
    open_exclusive,
    wait_for_socket,
)
from v35_p30_crypto import (
    atomic_write_exclusive,
    canonical_json,
    read_regular_nofollow,
    sha256_bytes,
    sha256_file,
)


SCHEMA = "arc-v35-p30-cuda-determinism-preflight-v1"


def _prepare_attempt_output_dir(output_dir: Path) -> None:
    """Accept the empty directory prepared by the execution supervisor only."""

    if output_dir.exists():
        if output_dir.is_symlink() or not output_dir.is_dir():
            raise ValueError("P30 CUDA attempt output path is not a plain directory")
        if next(output_dir.iterdir(), None) is not None:
            raise FileExistsError("P30 CUDA attempt output directory is not empty")
        return
    output_dir.mkdir(parents=True, exist_ok=False)


def _run_attempt(
    *,
    protocol: dict[str, Any],
    protocol_path: Path,
    source_commit: str,
    checkpoint: Path,
    output_dir: Path,
    socket_path: Path,
    label: str,
) -> dict[str, Any]:
    _prepare_attempt_output_dir(output_dir)
    socket_path.unlink(missing_ok=True)
    backend = Path(protocol["executionTrust"]["bubblewrapPath"])
    catalog = resolve_artifact(
        protocol["catalog"]["path"], anchor=REPO_ROOT, label="catalog"
    )
    python = REPO_ROOT / "ml/.venv/bin/python"
    node = Path("/usr/bin/node")
    report = output_dir / "report.json"
    evaluator_stdout = output_dir / "evaluator.stdout"
    evaluator_stderr = output_dir / "evaluator.stderr"
    server_stdout = output_dir / "server.stdout"
    server_stderr = output_dir / "server.stderr"
    server_env = {
        "ARC_INFER_WIRE": "binary",
        "CUBLAS_WORKSPACE_CONFIG": ":4096:8",
        "CUDA_DEVICE_ORDER": "PCI_BUS_ID",
        "CUDA_VISIBLE_DEVICES": GPU_UUID,
        "HOME": "/tmp",
        "NVIDIA_TF32_OVERRIDE": "0",
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "PYTHONHASHSEED": "0",
        "TMPDIR": "/tmp",
        "TORCH_ALLOW_TF32_CUBLAS_OVERRIDE": "0",
    }
    evaluator_env = {
        **server_env,
        "CUDA_VISIBLE_DEVICES": "",
        "TMPDIR": str(output_dir),
    }
    server_argv = [
        str(python),
        "ml/infer_server.py",
        "--weights",
        str(checkpoint),
        "--socket",
        str(socket_path),
        "--device",
        "cuda:0",
        "--window-ms",
        "2",
        "--max-batch",
        "512",
        "--stats-interval",
        "5",
    ]
    identity_sha = sha256_bytes(
        canonical_json(
            {
                "protocol": sha256(protocol_path),
                "source": protocol["sourceContract"]["sha256"],
                "checkpoint": sha256_file(checkpoint),
            }
        )
    )
    evaluator_argv = [
        str(node),
        "scripts/evaluate-solo-checkpoint.mjs",
        "--weights",
        str(checkpoint),
        "--infer-socket",
        str(socket_path),
        "--policy-obs-version",
        str(protocol["initialPolicy"]["policyObsVersion"]),
        "--catalog",
        str(catalog),
        "--source-commit",
        source_commit,
        "--experiment",
        protocol["experiment"],
        "--replicate",
        "phase0",
        "--arm",
        "cuda-determinism",
        "--config-sha256",
        identity_sha,
        "--binding-sha256",
        identity_sha,
        "--root-identity",
        str(output_dir.parent),
        "--games",
        str(protocol["seedSchedule"]["commonPublicGames"]),
        "--workers",
        str(protocol["training"]["workers"]),
        "--seed0",
        str(protocol["seedSchedule"]["commonPublicBase"]),
        "--max-rounds",
        str(protocol["training"]["maxRounds"]),
        "--max-status-level",
        str(protocol["training"]["soloMaxStatusLevel"]),
        "--sample",
        "--temperature",
        str(protocol["training"]["temperature"]),
        "--include-games",
        "--include-replay-hashes",
        "--quiet",
        "--out",
        str(report),
    ]
    server_command = isolated_command(
        backend=backend,
        argv=server_argv,
        env=server_env,
        output_dir=output_dir,
        socket_dir=socket_path.parent,
        candidate=True,
    )
    evaluator_command = isolated_command(
        backend=backend,
        argv=evaluator_argv,
        env=evaluator_env,
        output_dir=output_dir,
        socket_dir=socket_path.parent,
        candidate=False,
    )
    server_out_fd = open_exclusive(server_stdout)
    server_err_fd = open_exclusive(server_stderr)
    server = subprocess.Popen(
        server_command,
        cwd=REPO_ROOT,
        env={"PATH": "/usr/bin:/bin"},
        stdin=subprocess.DEVNULL,
        stdout=server_out_fd,
        stderr=server_err_fd,
        start_new_session=True,
    )
    evaluator_exit = 98
    server_exit = 98
    socket_inode = None
    try:
        socket_inode = wait_for_socket(socket_path, server)
        evaluator_out_fd = open_exclusive(evaluator_stdout)
        evaluator_err_fd = open_exclusive(evaluator_stderr)
        try:
            evaluator = subprocess.Popen(
                evaluator_command,
                cwd=REPO_ROOT,
                env={"PATH": "/usr/bin:/bin"},
                stdin=subprocess.DEVNULL,
                stdout=evaluator_out_fd,
                stderr=evaluator_err_fd,
                start_new_session=True,
            )
            evaluator_exit = evaluator.wait()
        finally:
            os.close(evaluator_out_fd)
            os.close(evaluator_err_fd)
    finally:
        if server.poll() is None:
            os.killpg(server.pid, signal.SIGTERM)
        try:
            server_exit = server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            if server.poll() is None:
                os.killpg(server.pid, signal.SIGKILL)
            server_exit = server.wait(timeout=10)
        os.close(server_out_fd)
        os.close(server_err_fd)
        socket_path.unlink(missing_ok=True)
    if (
        evaluator_exit != 0
        or not report.is_file()
        or evaluator_stdout.stat().st_size != 0
        or evaluator_stderr.stat().st_size != 0
    ):
        raise RuntimeError(f"P30 CUDA determinism {label} attempt failed")
    return {
        "label": label,
        "report": {"path": str(report), "sha256": sha256_file(report)},
        "socketInode": socket_inode,
        "serverExitCode": server_exit,
        "evaluatorExitCode": evaluator_exit,
        "serverArgvSha256": sha256_bytes(canonical_json(server_argv)),
        "evaluatorArgvSha256": sha256_bytes(canonical_json(evaluator_argv)),
        "serverEnvironment": server_env,
        "evaluatorEnvironment": evaluator_env,
    }


def run(*, protocol_path: Path, output_root: Path, socket_root: Path) -> None:
    protocol_path = protocol_path.resolve()
    output_root = output_root.resolve()
    socket_root = socket_root.resolve()
    protocol = read_json_object(protocol_path, "P30 protocol")
    validate_protocol(protocol, require_authorized=True)
    validate_initial_policy_artifacts(protocol, protocol_path=protocol_path)
    source_commit, source_contract_sha = source_identity(protocol, protocol_path)
    checkpoint = resolve_artifact(
        protocol["initialPolicy"]["path"],
        anchor=REPO_ROOT,
        label="initial checkpoint",
    )
    output_root.mkdir(parents=True, exist_ok=True)
    socket_root.mkdir(parents=True, exist_ok=True)
    primary = _run_attempt(
        protocol=protocol,
        protocol_path=protocol_path,
        source_commit=source_commit,
        checkpoint=checkpoint,
        output_dir=output_root / "primary",
        socket_path=socket_root / "p30d-primary.sock",
        label="primary",
    )
    replay = _run_attempt(
        protocol=protocol,
        protocol_path=protocol_path,
        source_commit=source_commit,
        checkpoint=checkpoint,
        output_dir=output_root / "replay",
        socket_path=socket_root / "p30d-replay.sock",
        label="replay",
    )
    primary_report = json.loads(
        read_regular_nofollow(Path(primary["report"]["path"])).decode("utf-8")
    )
    replay_report = json.loads(
        read_regular_nofollow(Path(replay["report"]["path"])).decode("utf-8")
    )
    primary_games = primary_report.get("perGame")
    replay_games = replay_report.get("perGame")
    primary_hashes = primary_report.get("replayHashes")
    replay_hashes = replay_report.get("replayHashes")
    if (
        not isinstance(primary_games, list)
        or len(primary_games) != protocol["seedSchedule"]["commonPublicGames"]
        or primary_games != replay_games
        or not isinstance(primary_hashes, list)
        or primary_hashes != replay_hashes
        or primary["socketInode"] == replay["socketInode"]
    ):
        raise RuntimeError("P30 exact CUDA primary/replay determinism failed")
    report_path = output_root / "report.json"
    payload = {
        "schemaVersion": SCHEMA,
        "valid": True,
        "immutable": True,
        "promotionEligible": False,
        "outcomesInspected": False,
        "protocolSha256": sha256(protocol_path),
        "sourceContractSha256": source_contract_sha,
        "checkpointSha256": sha256_file(checkpoint),
        "games": len(primary_games),
        "workers": protocol["training"]["workers"],
        "physicalGpuUuid": GPU_UUID,
        "freshServerSocketsDistinct": True,
        "perGameSha256": sha256_bytes(canonical_json(primary_games)),
        "replayHashesSha256": sha256_bytes(canonical_json(primary_hashes)),
        "diagnosticCodes": [
            "FRESH_CUDA_SERVERS",
            "EXACT_PER_GAME_MATCH",
            "EXACT_REPLAY_HASH_MATCH",
            "PRODUCTION_BATCH_AND_CONCURRENCY_MATCH",
        ],
        "primary": primary,
        "replay": replay,
    }
    atomic_write_exclusive(report_path, canonical_json(payload) + b"\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--socket-root", type=Path, required=True)
    args = parser.parse_args()
    run(
        protocol_path=args.protocol,
        output_root=args.output_root,
        socket_root=args.socket_root,
    )


if __name__ == "__main__":
    main()
