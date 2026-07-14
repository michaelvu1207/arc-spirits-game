#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v32-onpolicy-solo"
ANCHOR="$ROOT/ml/experiments/v30-strategic-tail-fidelity/artifacts/arms/strategic-cvar10-c025/checkpoint.pt"
CATALOG="$ROOT/ml/catalogs/live-20260713-5f4ad348.json"
GPU="${1:-7}"
SCRATCH="${ARC_V32_BENCH_SCRATCH:-/dev/shm/arc-v32-systems-benchmark}"
SOCKET="$SCRATCH/infer.sock"
REPORT="$EXPERIMENT/artifacts/systems-benchmark.json"

cd "$ROOT"
test ! -e "$REPORT"
mkdir -p "$SCRATCH/tmp" "$EXPERIMENT/artifacts"
test "$(sha256sum "$ANCHOR" | awk '{print $1}')" = "c47a63ac7c4a74624294e5af49494e00812c97736db4a085f2fdad0deafa8a06"
test "$(sha256sum "$CATALOG" | awk '{print $1}')" = "5f4ad348f6c7add612c736df0f3e00b7d4c821758e0561049f2e550e798c6e2e"
df -Pk "$SCRATCH" | awk 'NR==2 && $4 < 16*1024*1024 {exit 1}'

{
  date --iso-8601=seconds
  nproc
  cat /proc/loadavg
  df -h /data/share8 /dev/shm
  nvidia-smi --query-gpu=index,name,memory.used,utilization.gpu --format=csv,noheader
} > "$EXPERIMENT/artifacts/systems-preflight.txt"

rm -f "$SOCKET"
env CUDA_VISIBLE_DEVICES="$GPU" nice -n 10 ml/.venv/bin/python ml/infer_server.py \
  --weights "$ANCHOR" --socket "$SOCKET" --device cuda --window-ms 2 --max-batch 512 \
  --stats-interval 5 > "$EXPERIMENT/artifacts/systems-infer.log" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
for _ in $(seq 1 120); do
  [[ -S "$SOCKET" ]] && break
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 1
done
test -S "$SOCKET"

env TMPDIR="$SCRATCH/tmp" nice -n 10 node scripts/benchmark-actor-workers.mjs \
  --games 128 --repeats 2 --workers 4,8,12,16,24 \
  --seed0 951900000 --shuffle-seed 9519 --seats 1 --max-rounds 30 \
  --max-status-level 2 --shuffle-guardians --guardian-schedule absolute-balanced --gamma 0.999 \
  --catalog "$CATALOG" --infer-socket "$SOCKET" --selection hybrid \
  --sample --temperature 0.55 --neural-seats Red --record-seats Red \
  --obs-version 2 --policy-obs-version 2 --report "$REPORT"

{
  date --iso-8601=seconds
  cat /proc/loadavg
  nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv,noheader
} > "$EXPERIMENT/artifacts/systems-postflight.txt"
