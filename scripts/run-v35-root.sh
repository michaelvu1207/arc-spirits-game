#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v35-weco-recursive-autoresearch"
PROTOCOL="$EXPERIMENT/phase1-protocol.json"
LOCK="$EXPERIMENT/artifacts/phase1-source-lock.json"
LEAGUE_ROOT="${1:?league root required}"
TARGET_GEN="${2:-1}"
SCRATCH_BASE="${ARC_V35_TRAINING_SCRATCH:-/dev/shm/arc-v35-training}"
LEASE="${ARC_V35_GPU7_LEASE:-$ROOT/.leases/arc-v35-gpu7}"
GPU_UUID="GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0"
CHILD_PID=""
LEASE_HELD=0

cd "$ROOT"
node scripts/lock-v35-phase1.mjs verify "$LOCK"
LEAGUE_ROOT="$(cd "$(dirname "$LEAGUE_ROOT")" && pwd)/$(basename "$LEAGUE_ROOT")"
case "$LEAGUE_ROOT" in
  "$EXPERIMENT"/league/rep-*/*) ;;
  *) echo "root outside V35 Phase 1 experiment" >&2; exit 2 ;;
esac
[[ "$TARGET_GEN" =~ ^[0-9]+$ ]] && (( TARGET_GEN >= 1 && TARGET_GEN <= 12 )) || {
  echo "target generation must be in 1..12" >&2
  exit 2
}
RELATIVE="${LEAGUE_ROOT#"$EXPERIMENT/league/"}"
SCRATCH="$SCRATCH_BASE/$RELATIVE"
mkdir -p "$SCRATCH/data" "$LEAGUE_ROOT/artifacts" "$(dirname "$LEASE")"
if [[ ! -e "$LEAGUE_ROOT/data" ]]; then
  ln -s "$SCRATCH/data" "$LEAGUE_ROOT/data"
fi
test -L "$LEAGUE_ROOT/data"
test "$(readlink -f "$LEAGUE_ROOT/data")" = "$(readlink -f "$SCRATCH/data")"

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [[ -n "$CHILD_PID" ]] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill -TERM -- "-$CHILD_PID" 2>/dev/null || kill -TERM "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
  fi
  CHILD_PID=""
  if (( LEASE_HELD == 1 )); then
    rm -rf "$LEASE"
    LEASE_HELD=0
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

gpu_line() {
  nvidia-smi --query-gpu=index,uuid,memory.used,utilization.gpu \
    --format=csv,noheader,nounits | awk -F', *' '$1 == 7 {print $1","$2","$3","$4}'
}

assert_gpu_empty() {
  local line index uuid memory utilization
  line="$(gpu_line)"
  IFS=, read -r index uuid memory utilization <<< "$line"
  [[ "$index" == "7" && "$uuid" == "$GPU_UUID" ]] || {
    echo "GPU 7 identity mismatch: $line" >&2
    return 1
  }
  (( memory == 0 && utilization == 0 )) || {
    echo "GPU 7 is not empty: $line" >&2
    return 1
  }
}

available_bytes() {
  df -PB1 "$1" | awk 'NR==2 {print $4}'
}

acquire_generation_lease() {
  local gen="$1" data_available shm_available ram_available
  if ! mkdir "$LEASE" 2>/dev/null; then
    echo "GPU 7 lease already exists: $LEASE" >&2
    return 1
  fi
  LEASE_HELD=1
  assert_gpu_empty
  data_available="$(available_bytes /data/share8)"
  shm_available="$(available_bytes /dev/shm)"
  ram_available="$(( $(awk '/^MemAvailable:/ {print $2}' /proc/meminfo) * 1024 ))"
  (( data_available >= 4294967296 )) || { echo "/data/share8 below 4 GiB floor" >&2; return 1; }
  (( shm_available >= 34359738368 )) || { echo "/dev/shm below 32 GiB floor" >&2; return 1; }
  (( ram_available >= 68719476736 )) || { echo "RAM below 64 GiB floor" >&2; return 1; }
  node -e '
    const fs=require("fs");
    const [out,root,gen,gpu,data,shm,ram]=process.argv.slice(1);
    fs.writeFileSync(out, JSON.stringify({
      schemaVersion:"arc-v35-gpu7-lease-v1", root, generation:Number(gen), pid:process.ppid,
      acquiredAt:new Date().toISOString(), gpuLine:gpu,
      availableBytes:{dataShare:Number(data),shm:Number(shm),ram:Number(ram)}
    }, null, 2)+"\n");
  ' "$LEASE/owner.json" "$LEAGUE_ROOT" "$gen" "$(gpu_line)" "$data_available" "$shm_available" "$ram_available"
}

release_generation_lease() {
  local tries=0
  CHILD_PID=""
  while (( tries < 10 )); do
    if assert_gpu_empty 2>/dev/null; then break; fi
    sleep 1
    tries=$((tries + 1))
  done
  assert_gpu_empty
  rm -rf "$LEASE"
  LEASE_HELD=0
}

write_environment_manifest() {
  local gen="$1"
  local out="$LEAGUE_ROOT/artifacts/gen${gen}-environment.json"
  CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=7 PYTHONHASHSEED=0 \
    CUBLAS_WORKSPACE_CONFIG=:4096:8 PYTHONPATH=ml \
    ml/.venv/bin/python - "$out" "$LEAGUE_ROOT" "$gen" "$(gpu_line)" <<'PY'
import hashlib
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

import torch

out, root, generation, gpu_line = sys.argv[1:]
def digest(path: str) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()
payload = {
    "schemaVersion": "arc-v35-generation-environment-v1",
    "root": root,
    "generation": int(generation),
    "gpuLine": gpu_line,
    "python": platform.python_version(),
    "torch": torch.__version__,
    "torchCuda": torch.version.cuda,
    "cudaAvailable": torch.cuda.is_available(),
    "visibleDeviceCount": torch.cuda.device_count(),
    "visibleDeviceName": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    "cudnn": torch.backends.cudnn.version(),
    "node": subprocess.check_output(["node", "--version"], text=True).strip(),
    "npm": subprocess.check_output(["npm", "--version"], text=True).strip(),
    "kernel": platform.release(),
    "determinism": {
        key: os.environ.get(key)
        for key in ("CUDA_DEVICE_ORDER", "CUDA_VISIBLE_DEVICES", "PYTHONHASHSEED", "CUBLAS_WORKSPACE_CONFIG")
    },
    "hashes": {
        path: digest(path)
        for path in ("package-lock.json", "ml/requirements.txt", "ml/catalog.json", "ml/train.py", "ml/ppo.py")
    },
}
if payload["cudaAvailable"] is not True or payload["visibleDeviceCount"] != 1:
    raise SystemExit("GPU visibility contract failed")
Path(out).write_text(json.dumps(payload, indent=2) + "\n")
PY
}

finalize_generation() {
  local gen="$1" audit="$LEAGUE_ROOT/artifacts/gen${gen}-audit.json"
  local data_root="$LEAGUE_ROOT/data/gen$gen"
  if [[ ! -e "$audit" ]]; then
    test -d "$data_root"
    CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=7 PYTHONHASHSEED=0 \
      CUBLAS_WORKSPACE_CONFIG=:4096:8 PYTHONPATH=ml nice -n 10 \
      ml/.venv/bin/python ml/audit_v35_generation.py \
      --root "$LEAGUE_ROOT" --gen "$gen" --protocol "$PROTOCOL" --out "$audit"
    cp "$data_root/main-0/train.log" "$LEAGUE_ROOT/artifacts/gen${gen}-train.log"
    cp "$data_root/main-0/meta.json" "$LEAGUE_ROOT/artifacts/gen${gen}-train-meta.json"
    if [[ -f "$data_root/main-0_eval/meta.json" ]]; then
      cp "$data_root/main-0_eval/meta.json" "$LEAGUE_ROOT/artifacts/gen${gen}-eval-meta.json"
    fi
  fi
  test "$(node -e 'const a=require(process.argv[1]);process.stdout.write(String(a.valid))' "$audit")" = "true"
  rm -rf "$data_root"
}

if [[ ! -f "$LEAGUE_ROOT/state.json" ]]; then
  node scripts/run-league.mjs init --root "$LEAGUE_ROOT"
fi

while :; do
  CURRENT="$(node -e 'const s=require(process.argv[1]);process.stdout.write(String(s.gen))' "$LEAGUE_ROOT/state.json")"
  (( CURRENT >= TARGET_GEN )) && break
  GEN=$((CURRENT + 1))
  test ! -e "$LEAGUE_ROOT/artifacts/gen${GEN}-audit.json"
  acquire_generation_lease "$GEN"
  write_environment_manifest "$GEN"
  setsid env CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=7 PYTHONHASHSEED=0 \
    CUBLAS_WORKSPACE_CONFIG=:4096:8 ARC_ROOT="$ROOT" nice -n 10 \
    node scripts/run-league.mjs run --root "$LEAGUE_ROOT" --gens 1 &
  CHILD_PID=$!
  if ! wait "$CHILD_PID"; then
    CHILD_PID=""
    echo "V35 generation failed; no automatic retry is authorized" >&2
    exit 1
  fi
  CHILD_PID=""
  finalize_generation "$GEN"
  release_generation_lease
done

printf 'V35 root complete root=%s gen=%s\n' "$LEAGUE_ROOT" "$TARGET_GEN"
