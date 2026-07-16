#!/usr/bin/env python3
"""Run exactly one P30 evaluation attempt with a fresh inference server."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

from analyze_v35_p30_long_horizon import (
    EVALUATION_RECEIPT_SCHEMA,
    REPO_ROOT,
    read_json_object,
    resolve_artifact,
    sha256,
    validate_initial_policy_artifacts,
    validate_protocol,
    validate_root_materialization,
)
from audit_v35_p30_generation import source_identity
from v35_p30_authorized_execution import process_record
from v35_p30_crypto import atomic_write_exclusive, canonical_json, sha256_file


SCHEMA = "arc-v35-p30-evaluation-inner-execution-v1"
GPU_UUID = "GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0"


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def open_exclusive(path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)


def wait_for_socket(path: Path, process: subprocess.Popen, seconds: int = 120) -> int:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.is_socket():
            return path.stat().st_ino
        if process.poll() is not None:
            break
        time.sleep(0.25)
    raise RuntimeError("inference server did not reach a connectable socket")


def isolated_command(
    *,
    backend: Path,
    argv: list[str],
    env: dict[str, str],
    output_dir: Path,
    socket_dir: Path,
    candidate: bool,
) -> list[str]:
    command = [
        str(backend),
        "--die-with-parent",
        "--new-session",
        "--unshare-pid",
        "--unshare-uts",
        "--unshare-ipc",
        "--unshare-cgroup-try",
        "--unshare-net",
        "--cap-drop",
        "ALL",
        "--clearenv",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
    ]
    for path in ("/bin", "/etc", "/lib", "/lib64", "/sys", "/usr", str(REPO_ROOT)):
        if Path(path).exists():
            command.extend(("--ro-bind", path, path))
    for parent in (Path("/dev/shm"), Path("/dev/shm/a35")):
        command.extend(("--dir", str(parent)))
    if candidate:
        command.extend(("--bind", str(socket_dir), str(socket_dir)))
        for device in (
            "/dev/nvidia7",
            "/dev/nvidiactl",
            "/dev/nvidia-uvm",
            "/dev/nvidia-uvm-tools",
        ):
            if Path(device).exists():
                command.extend(("--dev-bind", device, device))
    else:
        command.extend(("--ro-bind", str(socket_dir), str(socket_dir)))
        command.extend(("--bind", str(output_dir), str(output_dir)))
    command.extend(("--tmpfs", "/tmp"))
    for key, value in sorted(env.items()):
        command.extend(("--setenv", key, value))
    command.extend(("--chdir", str(REPO_ROOT), "--", *argv))
    return command


def run(
    *,
    protocol_path: Path,
    root: Path,
    role: str,
    attempt_token: str,
    output_dir: Path,
    socket_path: Path,
) -> dict[str, Any]:
    protocol_path = protocol_path.resolve()
    root = root.resolve()
    output_dir = output_dir.resolve()
    socket_path = socket_path.resolve()
    if len(os.fsencode(socket_path)) > 107:
        raise ValueError("inference socket exceeds Linux AF_UNIX pathname limit")
    if role not in ("primary", "replay"):
        raise ValueError("role must be primary or replay")
    if len(attempt_token) != 64 or any(character not in "0123456789abcdef" for character in attempt_token):
        raise ValueError("attempt token must be 32 random bytes encoded as lowercase hex")
    protocol = read_json_object(protocol_path, "P30 protocol")
    validate_protocol(protocol, require_authorized=True)
    validate_initial_policy_artifacts(protocol, protocol_path=protocol_path)
    source_commit, source_contract_sha256 = source_identity(protocol, protocol_path)
    backend = Path(protocol["executionTrust"]["bubblewrapPath"])
    if sha256_file(backend) != protocol["executionTrust"]["bubblewrapSha256"]:
        raise ValueError("nested evaluation isolation backend differs from protocol trust")
    binding_path = root / "v35-binding.json"
    config_path = root / "config.json"
    binding = read_json_object(binding_path, "P30 root binding")
    validate_root_materialization(
        config_path=config_path,
        binding_path=binding_path,
        protocol=protocol,
        protocol_path=protocol_path,
        replicate=binding.get("replicate"),
        arm=binding.get("arm"),
    )
    generation = protocol["seedSchedule"]["maxGeneration"]
    checkpoint = root / "checkpoints" / f"main-0-gen{generation}.pt"
    checkpoint_manifest = checkpoint.with_suffix(".manifest.json")
    audit_path = root / "artifacts" / f"gen{generation}-audit.json"
    audit = read_json_object(audit_path, "P30 endpoint audit")
    if (
        audit.get("valid") is not True
        or audit.get("checkpointSha256") != sha256_file(checkpoint)
        or audit.get("manifestSha256") != sha256_file(checkpoint_manifest)
        or audit.get("sourceCommit") != source_commit
        or audit.get("sourceContractSha256") != source_contract_sha256
        or audit.get("protocolSha256") != sha256(protocol_path)
    ):
        raise ValueError("P30 endpoint is not bound to its final generation audit")
    catalog = resolve_artifact(protocol["catalog"]["path"], anchor=REPO_ROOT, label="catalog")
    python = REPO_ROOT / "ml/.venv/bin/python"
    node = Path("/usr/bin/node")
    report_path = output_dir / "report.json"
    evaluator_stdout_path = output_dir / "evaluator.stdout"
    evaluator_stderr_path = output_dir / "evaluator.stderr"
    evaluator_exit_path = output_dir / "evaluator.exit-code"
    server_stdout_path = output_dir / "server.stdout"
    server_stderr_path = output_dir / "server.stderr"
    server_exit_path = output_dir / "server.exit-code"
    inner_path = output_dir / "inner-execution.json"
    legacy_receipt_path = output_dir / "legacy-receipt.json"
    for path in (
        report_path,
        evaluator_stdout_path,
        evaluator_stderr_path,
        evaluator_exit_path,
        server_stdout_path,
        server_stderr_path,
        server_exit_path,
        inner_path,
        legacy_receipt_path,
        socket_path,
    ):
        if path.exists():
            raise FileExistsError(path)
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
    evaluator_env = {**server_env, "CUDA_VISIBLE_DEVICES": "", "TMPDIR": str(output_dir)}
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
        binding["replicate"],
        "--arm",
        binding["arm"],
        "--config-sha256",
        sha256(config_path),
        "--binding-sha256",
        sha256(binding_path),
        "--root-identity",
        str(root),
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
        str(report_path),
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
    launcher_env = {"PATH": "/usr/bin:/bin"}
    server_stdout_fd = open_exclusive(server_stdout_path)
    server_stderr_fd = open_exclusive(server_stderr_path)
    server_started = utc_now()
    server = subprocess.Popen(
        server_command,
        cwd=REPO_ROOT,
        env=launcher_env,
        stdin=subprocess.DEVNULL,
        stdout=server_stdout_fd,
        stderr=server_stderr_fd,
        start_new_session=True,
    )
    server_record = process_record(server.pid)
    evaluator = None
    evaluator_started = None
    evaluator_finished = None
    evaluator_record: dict[str, Any] | None = None
    socket_inode = None
    evaluator_exit = 98
    server_exit = 98
    try:
        socket_inode = wait_for_socket(socket_path, server)
        evaluator_stdout_fd = open_exclusive(evaluator_stdout_path)
        evaluator_stderr_fd = open_exclusive(evaluator_stderr_path)
        evaluator_started = utc_now()
        try:
            evaluator = subprocess.Popen(
                evaluator_command,
                cwd=REPO_ROOT,
                env=launcher_env,
                stdin=subprocess.DEVNULL,
                stdout=evaluator_stdout_fd,
                stderr=evaluator_stderr_fd,
                start_new_session=True,
            )
            evaluator_record = process_record(evaluator.pid)
            evaluator_exit = evaluator.wait()
            evaluator_finished = utc_now()
        finally:
            os.close(evaluator_stdout_fd)
            os.close(evaluator_stderr_fd)
    finally:
        if server.poll() is None:
            os.killpg(server.pid, signal.SIGTERM)
        try:
            server_exit = server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            if server.poll() is None:
                os.killpg(server.pid, signal.SIGKILL)
            server_exit = server.wait(timeout=10)
        server_finished = utc_now()
        os.close(server_stdout_fd)
        os.close(server_stderr_fd)
        socket_path.unlink(missing_ok=True)
    atomic_write_exclusive(evaluator_exit_path, f"{evaluator_exit}\n".encode("ascii"))
    atomic_write_exclusive(server_exit_path, f"{server_exit}\n".encode("ascii"))
    if evaluator_exit != 0 or not report_path.is_file():
        raise RuntimeError("P30 evaluator failed")
    if evaluator_stdout_path.stat().st_size != 0:
        raise RuntimeError("P30 evaluator leaked outcome-bearing stdout")
    if evaluator_stderr_path.stat().st_size != 0:
        raise RuntimeError("P30 evaluator leaked outcome-bearing stderr")
    label = f"rep-{binding['replicate']}-{binding['arm']}"
    legacy_receipt = {
        "schemaVersion": EVALUATION_RECEIPT_SCHEMA,
        "valid": True,
        "attemptId": f"{label}:{role}:attempt-{'1' if role == 'primary' else '2'}",
        "role": role,
        "label": label,
        "replicate": binding["replicate"],
        "arm": binding["arm"],
        "malformedEpisodes": 0,
        "startedAtUtc": evaluator_started,
        "finishedAtUtc": evaluator_finished,
        "execution": {
            "cwd": str(REPO_ROOT),
            "argv": evaluator_argv,
            "env": {"CUDA_VISIBLE_DEVICES": ""},
            "inferenceSocket": str(socket_path),
        },
        "contract": {
            "sourceCommit": source_commit,
            "catalogSha256": protocol["catalog"]["sha256"],
            "checkpointSha256": sha256_file(checkpoint),
            "seed0": protocol["seedSchedule"]["commonPublicBase"],
            "games": protocol["seedSchedule"]["commonPublicGames"],
            "maxRounds": protocol["training"]["maxRounds"],
            "maxStatusLevel": protocol["training"]["soloMaxStatusLevel"],
            "workers": protocol["training"]["workers"],
            "policyObsVersion": protocol["initialPolicy"]["policyObsVersion"],
            "sample": protocol["training"]["sample"],
            "temperature": protocol["training"]["temperature"],
            "includeGames": True,
            "includeReplayHashes": True,
            "configSha256": sha256(config_path),
            "bindingSha256": sha256(binding_path),
            "root": str(root),
        },
        "artifacts": {
            "checkpoint": {"path": str(checkpoint), "sha256": sha256_file(checkpoint)},
            "report": {"path": str(report_path), "sha256": sha256_file(report_path)},
            "stdout": {"path": str(evaluator_stdout_path), "sha256": sha256_file(evaluator_stdout_path)},
            "stderr": {"path": str(evaluator_stderr_path), "sha256": sha256_file(evaluator_stderr_path)},
            "exitCode": {"path": str(evaluator_exit_path), "sha256": sha256_file(evaluator_exit_path)},
            "serverLog": {"path": str(server_stdout_path), "sha256": sha256_file(server_stdout_path)},
        },
    }
    atomic_write_exclusive(legacy_receipt_path, canonical_json(legacy_receipt) + b"\n")
    payload = {
        "schemaVersion": SCHEMA,
        "valid": True,
        "promotionEligible": False,
        "role": role,
        "attemptToken": attempt_token,
        "protocolSha256": sha256(protocol_path),
        "sourceCommit": source_commit,
        "sourceContractSha256": source_contract_sha256,
        "root": str(root),
        "replicate": binding["replicate"],
        "arm": binding["arm"],
        "configSha256": sha256(config_path),
        "bindingSha256": sha256(binding_path),
        "checkpointSha256": sha256_file(checkpoint),
        "checkpointManifestSha256": sha256_file(checkpoint_manifest),
        "generationAuditSha256": sha256_file(audit_path),
        "socketPath": str(socket_path),
        "socketInode": socket_inode,
        "server": {
            "argv": server_command,
            "env": server_env,
            "startedAtUtc": server_started,
            "finishedAtUtc": server_finished,
            "process": server_record,
            "exitCode": server_exit,
            "stdout": {"path": str(server_stdout_path), "sha256": sha256_file(server_stdout_path)},
            "stderr": {"path": str(server_stderr_path), "sha256": sha256_file(server_stderr_path)},
        },
        "evaluator": {
            "argv": evaluator_command,
            "env": evaluator_env,
            "startedAtUtc": evaluator_started,
            "finishedAtUtc": evaluator_finished,
            "process": evaluator_record,
            "exitCode": evaluator_exit,
            "stdout": {"path": str(evaluator_stdout_path), "sha256": sha256_file(evaluator_stdout_path)},
            "stderr": {"path": str(evaluator_stderr_path), "sha256": sha256_file(evaluator_stderr_path)},
        },
        "report": {"path": str(report_path), "sha256": sha256_file(report_path)},
        "legacyReceipt": {"path": str(legacy_receipt_path), "sha256": sha256_file(legacy_receipt_path)},
    }
    atomic_write_exclusive(inner_path, canonical_json(payload) + b"\n")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--role", choices=("primary", "replay"), required=True)
    parser.add_argument("--attempt-token", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--socket", type=Path, required=True)
    args = parser.parse_args()
    run(
        protocol_path=args.protocol,
        root=args.root,
        role=args.role,
        attempt_token=args.attempt_token,
        output_dir=args.output_dir,
        socket_path=args.socket,
    )


if __name__ == "__main__":
    main()
