#!/usr/bin/env python3
"""Trusted GPU-7-only SimForge backend for V35 public/selection evaluation.

The proposal controller remains local. This module leases exactly physical GPU 7, verifies the
current rules/evaluator/checkpoint hashes, runs one short-lived v2 inference server plus the trusted
Node simulator, returns the report to the local trusted scorer, and releases the lease in a trap.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import shlex
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .core import Candidate, canonical_sha256
from .evaluator import BackendRun, EvaluationRequest

DEFAULT_HOST = "ubuntu@216.151.21.122"
DEFAULT_ROOT = "/data/share8/michaelvuaprilexperimentation/arc-bot"
GPU7_UUID = "GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0"


@dataclass(frozen=True)
class SimForgeStatus:
    gpu7_memory_mib: int
    gpu7_utilization_percent: int
    disk_available_kib: int
    load_one: float
    lease_present: bool


class SimForgeGPU7Backend:
    def __init__(
        self,
        *,
        host: str = DEFAULT_HOST,
        remote_root: str = DEFAULT_ROOT,
        checkpoint: str = "ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt",
        checkpoint_sha256: str,
        evaluator_sha256: str,
        infer_server_sha256: str,
        catalog_sha256: str,
        workers: int = 24,
        timeout_seconds: float = 1800,
        max_status_level: int = 3,
    ):
        for label, digest in (
            ("checkpoint", checkpoint_sha256),
            ("evaluator", evaluator_sha256),
            ("infer server", infer_server_sha256),
            ("catalog", catalog_sha256),
        ):
            if not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError(f"{label} hash is invalid")
        if workers < 1 or workers > 64 or timeout_seconds <= 0 or max_status_level not in {0, 1, 2, 3}:
            raise ValueError("invalid remote backend resource limits")
        self.host = host
        self.remote_root = remote_root
        self.checkpoint = checkpoint
        self.checkpoint_sha256 = checkpoint_sha256
        self.evaluator_sha256 = evaluator_sha256
        self.infer_server_sha256 = infer_server_sha256
        self.catalog_sha256 = catalog_sha256
        self.workers = workers
        self.timeout_seconds = timeout_seconds
        self.max_status_level = max_status_level

    def _ssh(self, remote_command: str, *, input_bytes: bytes | None = None, timeout: float = 30) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            [
                "ssh",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                self.host,
                remote_command,
            ],
            input=input_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )

    def status(self) -> SimForgeStatus:
        command = f"""set -eu
line=$(nvidia-smi --id=7 --query-gpu=uuid,memory.used,utilization.gpu --format=csv,noheader,nounits)
avail=$(df -Pk {self.remote_root} | awk 'NR==2 {{print $4}}')
load=$(cut -d' ' -f1 /proc/loadavg)
if test -e {self.remote_root}/ml/autoresearch/v35/leases/gpu7; then lease=1; else lease=0; fi
printf '%s|%s|%s|%s|%s\\n' "$line" "$avail" "$load" "$lease" "$(id -u)"
"""
        completed = self._ssh(command)
        if completed.returncode != 0:
            raise RuntimeError("SimForge status probe failed")
        fields = completed.stdout.decode().strip().replace(", ", "|").split("|")
        if len(fields) != 7 or fields[0] != GPU7_UUID:
            raise RuntimeError("SimForge GPU-7 identity/status response is invalid")
        return SimForgeStatus(
            gpu7_memory_mib=int(fields[1]),
            gpu7_utilization_percent=int(fields[2]),
            disk_available_kib=int(fields[3]),
            load_one=float(fields[4]),
            lease_present=fields[5] == "1",
        )

    @staticmethod
    def _remote_script() -> bytes:
        # All positional arguments originate from the exact validated Candidate schema.
        return b"""#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$1"; LEASE_ID="$2"; GAMES="$3"; SEED0="$4"; WORKERS="$5"; MAX_STATUS="$6"
CHECKPOINT="$7"; CHECKPOINT_SHA="$8"; EVALUATOR_SHA="$9"; INFER_SHA="${10}"; CATALOG_SHA="${11}"
shift 11
LEASE_PARENT="$ROOT/ml/autoresearch/v35/leases"
LEASE="$LEASE_PARENT/gpu7"
SCRATCH="/dev/shm/arc-v35-${LEASE_ID}"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 100); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.1; done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -d "$SCRATCH" && "$SCRATCH" == /dev/shm/arc-v35-* ]]; then rm -rf -- "$SCRATCH"; fi
  if [[ -f "$LEASE/owner" ]] && [[ "$(cat "$LEASE/owner")" == "$LEASE_ID" ]]; then
    rm -f -- "$LEASE/owner" && rmdir -- "$LEASE" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM
test ! -L "$LEASE_PARENT"
mkdir -p "$LEASE_PARENT"
if ! mkdir "$LEASE" 2>/dev/null; then echo 'gpu7 lease already exists' >&2; exit 73; fi
printf '%s' "$LEASE_ID" > "$LEASE/owner"
line=$(nvidia-smi --id=7 --query-gpu=uuid,memory.used,utilization.gpu --format=csv,noheader,nounits)
IFS=', ' read -r GPU_UUID GPU_MEM GPU_UTIL <<< "$line"
[[ "$GPU_UUID" == 'GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0' ]]
[[ "$GPU_MEM" == 0 && "$GPU_UTIL" == 0 ]]
[[ $(df -Pk "$ROOT" | awk 'NR==2 {print $4}') -ge 4194304 ]]
[[ $(sha256sum "$ROOT/$CHECKPOINT" | awk '{print $1}') == "$CHECKPOINT_SHA" ]]
[[ $(sha256sum "$ROOT/scripts/evaluate-solo-checkpoint.mjs" | awk '{print $1}') == "$EVALUATOR_SHA" ]]
[[ $(sha256sum "$ROOT/ml/infer_server.py" | awk '{print $1}') == "$INFER_SHA" ]]
[[ $(sha256sum "$ROOT/ml/catalog.json" | awk '{print $1}') == "$CATALOG_SHA" ]]
mkdir "$SCRATCH"
SOCKET="$SCRATCH/infer.sock"
CUDA_VISIBLE_DEVICES=7 nice -n 19 "$ROOT/ml/.venv/bin/python" "$ROOT/ml/infer_server.py" \
  --weights "$ROOT/$CHECKPOINT" --socket "$SOCKET" --device cuda:0 \
  --window-ms 2 --max-batch 512 --stats-interval 5 >"$SCRATCH/infer.log" 2>&1 &
SERVER_PID=$!
ready=0
for _ in $(seq 1 120); do
  if [[ -S "$SOCKET" ]]; then ready=1; break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 1
done
[[ "$ready" == 1 ]]
cd "$ROOT"
/usr/bin/time -f '%U %S' -o "$SCRATCH/time.txt" env ARC_INFER_WIRE=binary TMPDIR="$SCRATCH" \
  nice -n 19 node scripts/evaluate-solo-checkpoint.mjs \
  --weights "$CHECKPOINT" --catalog ml/catalog.json --infer-socket "$SOCKET" \
  --policy-obs-version 2 --games "$GAMES" --workers "$WORKERS" --seed0 "$SEED0" \
  --max-rounds 30 --max-status-level "$MAX_STATUS" --include-games --out "$SCRATCH/report.json" \
  "$@" >"$SCRATCH/evaluator.stdout" 2>"$SCRATCH/evaluator.stderr"
kill -TERM "$SERVER_PID"
wait "$SERVER_PID"
SERVER_PID=""
python3 - "$SCRATCH/report.json" "$SCRATCH/time.txt" "$SCRATCH/infer.log" <<'PY'
import hashlib,json,sys
report=json.load(open(sys.argv[1]))
user,system=map(float,open(sys.argv[2]).read().split())
infer=report.get('inference') or {}
payload={'schemaVersion':'arc-v35-simforge-envelope-v1','report':report,
         'cpuSeconds':user+system,
         'inferLogSha256':hashlib.sha256(open(sys.argv[3],'rb').read()).hexdigest()}
print(json.dumps(payload,separators=(',',':')))
PY
"""

    def run(self, request: EvaluationRequest) -> BackendRun:
        if request.tier == "final":
            raise RuntimeError("final_tier_closed")
        status = self.status()
        if status.lease_present or status.gpu7_memory_mib != 0 or status.gpu7_utilization_percent != 0:
            raise RuntimeError("GPU 7 is not safely claimable")
        if status.disk_available_kib < 4 * 1024 * 1024:
            raise RuntimeError("SimForge disk headroom is below the immutable 4 GiB floor")
        lease_id = f"{request.campaign}-{secrets.token_hex(8)}"
        args = [
            self.remote_root,
            lease_id,
            str(request.games),
            str(request.seed0),
            str(self.workers),
            str(self.max_status_level),
            self.checkpoint,
            self.checkpoint_sha256,
            self.evaluator_sha256,
            self.infer_server_sha256,
            self.catalog_sha256,
            *request.candidate.evaluator_args(),
        ]
        remote_command = "bash -s -- " + " ".join(shlex.quote(arg) for arg in args)
        started = time.monotonic()
        completed = self._ssh(
            remote_command,
            input_bytes=self._remote_script(),
            timeout=self.timeout_seconds,
        )
        wall_seconds = time.monotonic() - started
        if completed.returncode != 0:
            raise RuntimeError(
                f"SimForge V35 evaluation failed with exit {completed.returncode}; "
                "remote stdout/stderr retained only as hashes"
            )
        try:
            envelope = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError("SimForge V35 response was not the trusted envelope") from error
        if envelope.get("schemaVersion") != "arc-v35-simforge-envelope-v1":
            raise RuntimeError("SimForge V35 envelope schema mismatch")
        report = envelope.get("report")
        if not isinstance(report, dict):
            raise RuntimeError("SimForge V35 envelope report is invalid")
        inference = report.get("inference")
        if not isinstance(inference, dict) or inference.get("weightsSha256") != self.checkpoint_sha256:
            raise RuntimeError("SimForge served checkpoint identity mismatch")
        post_status = self.status()
        if post_status.lease_present or post_status.gpu7_memory_mib != 0:
            raise RuntimeError("GPU 7 was not fully released after evaluation")
        return BackendRun(
            report=report,
            stdout_sha256=hashlib.sha256(completed.stdout).hexdigest(),
            stderr_sha256=hashlib.sha256(completed.stderr).hexdigest(),
            wall_seconds=wall_seconds,
            cpu_seconds=float(envelope["cpuSeconds"]),
            gpu_seconds=wall_seconds,
            backend="trusted-simforge-gpu7-v2",
        )


def current_hashes(repo_root: Path) -> Mapping[str, str]:
    root = repo_root.resolve(strict=True)
    paths = {
        "evaluator": root / "scripts" / "evaluate-solo-checkpoint.mjs",
        "inferServer": root / "ml" / "infer_server.py",
        "catalog": root / "ml" / "catalog.json",
    }
    return {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in paths.items()}
