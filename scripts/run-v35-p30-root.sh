#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v35-weco-recursive-autoresearch/p30-long-horizon"
PROTOCOL="${ARC_V35_P30_PROTOCOL:-$EXPERIMENT/protocol.json}"
LEAGUE_ROOT="${1:?league root required}"
TARGET_GEN="${2:-8}"
SCRATCH_BASE="${ARC_V35_P30_SCRATCH:-/dev/shm/arc-v35-p30-training}"
LEASE="$ROOT/.leases/arc-v35-gpu7"
GPU_UUID="GPU-53f5407a-8e21-a269-7afb-df395cb9b7e0"
CHILD_PID=""
LEASE_HELD=0

cd "$ROOT"

verify_protocol_and_source() {
  PYTHONPATH=ml ml/.venv/bin/python - "$PROTOCOL" <<'PY'
import sys
from pathlib import Path

from analyze_v35_p30_long_horizon import (
    read_json_object,
    validate_initial_policy_artifacts,
    validate_protocol,
)
from audit_v35_p30_generation import source_identity

protocol_path = Path(sys.argv[1]).resolve()
protocol = read_json_object(protocol_path, "P30 protocol")
validate_protocol(protocol, require_authorized=True)
validate_initial_policy_artifacts(protocol, protocol_path=protocol_path)
source_identity(protocol, protocol_path)
PY
}

verify_protocol_and_source
MAX_GENERATION="$(node -e '
  const p=require(process.argv[1]);
  process.stdout.write(String(p.seedSchedule.maxGeneration));
' "$PROTOCOL")"
LEAGUE_ROOT="$(cd "$(dirname "$LEAGUE_ROOT")" && pwd)/$(basename "$LEAGUE_ROOT")"
case "$LEAGUE_ROOT" in
  "$EXPERIMENT"/league/rep-*/*) ;;
  *) echo "root outside the authorized V35 P30 experiment" >&2; exit 2 ;;
esac
PYTHONPATH=ml ml/.venv/bin/python - "$PROTOCOL" "$LEAGUE_ROOT" <<'PY'
import sys
from pathlib import Path

from analyze_v35_p30_long_horizon import (
    read_json_object,
    validate_root_materialization,
)

protocol_path = Path(sys.argv[1]).resolve()
root = Path(sys.argv[2]).resolve()
binding = read_json_object(root / "v35-binding.json", "P30 root binding")
protocol = read_json_object(protocol_path, "P30 protocol")
validate_root_materialization(
    config_path=root / "config.json",
    binding_path=root / "v35-binding.json",
    protocol=protocol,
    protocol_path=protocol_path,
    replicate=binding.get("replicate"),
    arm=binding.get("arm"),
)
PY
[[ "$TARGET_GEN" =~ ^[0-9]+$ ]] && (( TARGET_GEN >= 1 && TARGET_GEN <= MAX_GENERATION )) || {
  echo "target generation must be in 1..$MAX_GENERATION" >&2
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
  local rc=$? tries=0
  trap - EXIT INT TERM
  if [[ -n "$CHILD_PID" ]] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill -TERM -- "-$CHILD_PID" 2>/dev/null || kill -TERM "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
  fi
  CHILD_PID=""
  if (( LEASE_HELD == 1 )); then
    while (( tries < 10 )); do
      if assert_gpu_empty 2>/dev/null; then break; fi
      sleep 1
      tries=$((tries + 1))
    done
    if assert_gpu_empty 2>/dev/null; then
      rm -rf "$LEASE"
      LEASE_HELD=0
    else
      echo "GPU 7 is not empty after cleanup; preserving the internal lease at $LEASE" >&2
    fi
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
  verify_protocol_and_source
  if [[ "${ARC_V35_P30_EXTERNAL_LEASE:-0}" == "1" ]]; then
    test -f "$LEASE/owner.json"
    [[ "${ARC_V35_P30_AUTH_TOKEN:-}" =~ ^[0-9a-f]{64}$ ]]
    node - "$LEASE/owner.json" "$ARC_V35_P30_AUTH_TOKEN" "$LEAGUE_ROOT" "$gen" "$GPU_UUID" <<'NODE'
const fs = require('fs');
const [path, token, root, generation, gpuUuid] = process.argv.slice(2);
const owner = JSON.parse(fs.readFileSync(path, 'utf8'));
if (
  owner.schemaVersion !== 'arc-v35-p30-external-gpu7-lease-v1' ||
  owner.tokenId !== token ||
  owner.root !== root ||
  owner.generation !== Number(generation) ||
  owner.gpuUuid !== gpuUuid ||
  !/^[0-9a-f]{64}$/.test(owner.authorizationSha256) ||
  !/^[0-9a-f]{64}$/.test(owner.subjectSha256)
) {
  throw new Error('external GPU7 lease identity differs from the signed generation');
}
NODE
  else
    if ! mkdir "$LEASE" 2>/dev/null; then
      echo "GPU 7 lease already exists: $LEASE" >&2
      return 1
    fi
    LEASE_HELD=1
  fi
  assert_gpu_empty
  data_available="$(available_bytes /data/share8)"
  shm_available="$(available_bytes /dev/shm)"
  ram_available="$(( $(awk '/^MemAvailable:/ {print $2}' /proc/meminfo) * 1024 ))"
  (( data_available >= 6442450944 )) || { echo "/data/share8 below 6 GiB floor" >&2; return 1; }
  (( shm_available >= 34359738368 )) || { echo "/dev/shm below 32 GiB floor" >&2; return 1; }
  (( ram_available >= 68719476736 )) || { echo "RAM below 64 GiB floor" >&2; return 1; }
  if [[ "${ARC_V35_P30_EXTERNAL_LEASE:-0}" != "1" ]]; then
    node -e '
      const fs=require("fs");
      const [out,root,gen,gpu,data,shm,ram,protocol]=process.argv.slice(1);
      fs.writeFileSync(out, JSON.stringify({
        schemaVersion:"arc-v35-p30-gpu7-lease-v1", root, generation:Number(gen),
        pid:process.ppid, acquiredAt:new Date().toISOString(), gpuLine:gpu, protocol,
        availableBytes:{dataShare:Number(data),shm:Number(shm),ram:Number(ram)}
      }, null, 2)+"\n");
    ' "$LEASE/owner.json" "$LEAGUE_ROOT" "$gen" "$(gpu_line)" \
      "$data_available" "$shm_available" "$ram_available" "$PROTOCOL"
  fi
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
  if [[ "${ARC_V35_P30_EXTERNAL_LEASE:-0}" != "1" ]]; then
    rm -rf "$LEASE"
    LEASE_HELD=0
  fi
}

write_environment_manifest() {
  local gen="$1"
  local out="$LEAGUE_ROOT/artifacts/gen${gen}-environment.json"
  test ! -e "$out"
  CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES="$GPU_UUID" PYTHONHASHSEED=0 \
    CUBLAS_WORKSPACE_CONFIG=:4096:8 PYTHONPATH=ml \
    ml/.venv/bin/python - "$out" "$LEAGUE_ROOT" "$gen" "$(gpu_line)" "$PROTOCOL" <<'PY'
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

import torch

from analyze_v35_p30_long_horizon import REPO_ROOT, read_json_object, resolve_artifact, sha256

out, root, generation, gpu_line, protocol_name = sys.argv[1:]
protocol_path = Path(protocol_name).resolve()
protocol = read_json_object(protocol_path, "P30 protocol")
source_path = resolve_artifact(
    protocol["sourceContract"]["artifact"],
    anchor=REPO_ROOT,
    label="P30 source contract",
)
payload = {
    "schemaVersion": "arc-v35-p30-generation-environment-v1",
    "root": root,
    "generation": int(generation),
    "authorizationTokenId": os.environ.get("ARC_V35_P30_AUTH_TOKEN"),
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
        for key in (
            "CUDA_DEVICE_ORDER",
            "CUDA_VISIBLE_DEVICES",
            "PYTHONHASHSEED",
            "CUBLAS_WORKSPACE_CONFIG",
        )
    },
    "protocol": {"path": str(protocol_path), "sha256": sha256(protocol_path)},
    "sourceContract": {"path": str(source_path), "sha256": sha256(source_path)},
}
if payload["cudaAvailable"] is not True or payload["visibleDeviceCount"] != 1:
    raise SystemExit("GPU visibility contract failed")
Path(out).write_text(json.dumps(payload, indent=2) + "\n")
PY
}

finalize_generation() {
  local gen="$1"
  local audit="$LEAGUE_ROOT/artifacts/gen${gen}-audit.json"
  local data_root="$LEAGUE_ROOT/data/gen$gen"
  local failure_marker="$LEAGUE_ROOT/artifacts/gen${gen}-audit-failed.txt"
  test ! -e "$failure_marker"
  if [[ ! -e "$audit" ]]; then
    test -d "$data_root"
    if ! CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES="$GPU_UUID" PYTHONHASHSEED=0 \
      CUBLAS_WORKSPACE_CONFIG=:4096:8 PYTHONPATH=ml nice -n 10 \
        ml/.venv/bin/python ml/audit_v35_p30_generation.py \
        --root "$LEAGUE_ROOT" --gen "$gen" --protocol "$PROTOCOL" --out "$audit" --quiet; then
      printf 'V35 P30 generation %s audit failed; retry forbidden\n' "$gen" > "$failure_marker"
      return 1
    fi
    cp "$data_root/main-0/train.log" "$LEAGUE_ROOT/artifacts/gen${gen}-train.log"
    cp "$data_root/main-0/meta.json" "$LEAGUE_ROOT/artifacts/gen${gen}-train-meta.json"
    if [[ -f "$data_root/main-0_eval/meta.json" ]]; then
      cp "$data_root/main-0_eval/meta.json" "$LEAGUE_ROOT/artifacts/gen${gen}-eval-meta.json"
    fi
  fi
  test "$(node -e 'const a=require(process.argv[1]);process.stdout.write(String(a.valid))' "$audit")" = "true"
  rm -rf "$data_root"
}

verify_input_checkpoint() {
  local gen="$1" checkpoint expected actual previous audit
  if (( gen == 1 )); then
    checkpoint="$(node -e 'const p=require(process.argv[1]);process.stdout.write(p.initialPolicy.path)' "$PROTOCOL")"
    expected="$(node -e 'const p=require(process.argv[1]);process.stdout.write(p.initialPolicy.sha256)' "$PROTOCOL")"
  else
    previous=$((gen - 1))
    checkpoint="$LEAGUE_ROOT/checkpoints/main-0-gen${previous}.pt"
    audit="$LEAGUE_ROOT/artifacts/gen${previous}-audit.json"
    test -f "$audit"
    expected="$(node -e 'const a=require(process.argv[1]);process.stdout.write(a.checkpointSha256)' "$audit")"
  fi
  test -f "$checkpoint"
  actual="$(sha256sum "$checkpoint" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || {
    echo "input checkpoint hash mismatch for generation $gen" >&2
    return 1
  }
}

if [[ ! -f "$LEAGUE_ROOT/state.json" ]]; then
  node scripts/run-league.mjs init --root "$LEAGUE_ROOT"
fi

while :; do
  CURRENT="$(node -e 'const s=require(process.argv[1]);process.stdout.write(String(s.gen))' "$LEAGUE_ROOT/state.json")"
  for (( COMPLETED=1; COMPLETED<=CURRENT; COMPLETED++ )); do
    if [[ ! -e "$LEAGUE_ROOT/artifacts/gen${COMPLETED}-audit.json" ]]; then
      echo "completed generation $COMPLETED lacks its prospective audit; this campaign instance is permanently closed" >&2
      exit 1
    elif [[ -d "$LEAGUE_ROOT/data/gen$COMPLETED" ]]; then
      rm -rf "$LEAGUE_ROOT/data/gen$COMPLETED"
    fi
  done
  (( CURRENT >= TARGET_GEN )) && break
  GEN=$((CURRENT + 1))
  if [[ -d "$LEAGUE_ROOT/data/gen$GEN" ]]; then
    echo "partial generation $GEN permanently closes this campaign instance; in-place resume is forbidden" >&2
    exit 1
  fi
  verify_input_checkpoint "$GEN"
  test ! -e "$LEAGUE_ROOT/artifacts/gen${GEN}-audit.json"
  acquire_generation_lease "$GEN"
  write_environment_manifest "$GEN"
  setsid env CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES="$GPU_UUID" PYTHONHASHSEED=0 \
    CUBLAS_WORKSPACE_CONFIG=:4096:8 ARC_ROOT="$ROOT" nice -n 10 \
    node scripts/run-league.mjs run --root "$LEAGUE_ROOT" --gens 1 &
  CHILD_PID=$!
  if ! wait "$CHILD_PID"; then
    CHILD_PID=""
    echo "V35 P30 generation failed; no automatic retry is authorized" >&2
    exit 1
  fi
  CHILD_PID=""
  finalize_generation "$GEN"
  release_generation_lease
done

printf 'V35 P30 root complete root=%s gen=%s\n' "$LEAGUE_ROOT" "$TARGET_GEN"
