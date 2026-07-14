#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v33-strategic-search"
CHECKPOINT="$ROOT/ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt"
CATALOG="$ROOT/ml/catalogs/live-20260713-5f4ad348.json"
GPU="${1:-7}"
SCRATCH="${ARC_V33_SCRATCH:-/dev/shm/arc-v33-search}"
SOCKET="$SCRATCH/systems-infer.sock"

cd "$ROOT"
case "$GPU" in 0|5|6|7) ;; *) echo "V33 systems GPU must be one of 0,5,6,7" >&2; exit 2 ;; esac
test -f "$EXPERIMENT/artifacts/source-lock.json"
node scripts/verify-v33-source-lock.mjs "$EXPERIMENT/artifacts/source-lock.json" >/dev/null
node scripts/validate-v33-protocol.mjs >/dev/null
test "$(sha256sum "$CHECKPOINT" | awk '{print $1}')" = "aeb254c20367029696da1e6ca823b96187191140056d646a7c2d3d47ec4e567b"
test "$(sha256sum "$CATALOG" | awk '{print $1}')" = "5f4ad348f6c7add612c736df0f3e00b7d4c821758e0561049f2e550e798c6e2e"
mkdir -p "$EXPERIMENT/artifacts" "$SCRATCH/tmp"
test ! -d "$EXPERIMENT/artifacts/preflight"
for file in determinization-audit.json systems-raw.json systems-search-s16-h4.json systems-search-s16-h6.json systems-search-s32-h6.json systems-latency-one-search-s16-h4.json systems-latency-one-search-s16-h6.json systems-latency-one-search-s32-h6.json systems-eligibility.json phase2-authorization.json; do
  test ! -e "$EXPERIMENT/artifacts/$file"
done
df -Pk "$SCRATCH" | awk 'NR==2 && $4 < 16*1024*1024 {exit 1}'

bash scripts/run-v33-preflight.sh "$EXPERIMENT/artifacts/preflight"

{
  date --iso-8601=seconds
  nproc
  cat /proc/loadavg
  free -h
  df -h /data/share8 /dev/shm
  nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader
} > "$EXPERIMENT/artifacts/systems-preflight.txt"

node scripts/check-v33-determinization.mjs --samples 100000 --seed0 956000000 \
  --out "$EXPERIMENT/artifacts/determinization-audit.json" >/dev/null

rm -f "$SOCKET"
env CUDA_VISIBLE_DEVICES="$GPU" nice -n 10 ml/.venv/bin/python ml/infer_server.py \
  --weights "$CHECKPOINT" --socket "$SOCKET" --device cuda --window-ms 2 --max-batch 512 \
  --stats-interval 5 > "$EXPERIMENT/artifacts/systems-infer.log" 2>&1 &
SERVER_PID=$!
(
  while kill -0 "$SERVER_PID" 2>/dev/null; do
    date --iso-8601=seconds
    cat /proc/loadavg
    nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu --format=csv,noheader
    sleep 5
  done
) > "$EXPERIMENT/artifacts/systems-resources.log" 2>&1 &
MONITOR_PID=$!
cleanup() {
  kill "$SERVER_PID" "$MONITOR_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  wait "$MONITOR_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
for _ in $(seq 1 120); do
  [[ -S "$SOCKET" ]] && break
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 1
done
test -S "$SOCKET"

COMMON=(
  --games 256 --repeats 1 --workers 4,8,12,16,24
  --seed0 953900000 --shuffle-seed 9539 --seats 1 --max-rounds 30
  --max-status-level 2 --guardian-schedule absolute-balanced
  --catalog "$CATALOG" --infer-socket "$SOCKET" --selection hybrid
  --sample --temperature 0.55 --neural-seats Red --no-record
  --obs-version 1 --policy-obs-version 2
)
env ARC_INFER_WIRE=binary TMPDIR="$SCRATCH/tmp" nice -n 10 node scripts/benchmark-actor-workers.mjs \
  "${COMMON[@]}" --report "$EXPERIMENT/artifacts/systems-raw.json"
for spec in "search-s16-h4:16:4" "search-s16-h6:16:6" "search-s32-h6:32:6"; do
  IFS=: read -r name sims horizon <<< "$spec"
  env ARC_INFER_WIRE=binary TMPDIR="$SCRATCH/tmp" nice -n 10 node scripts/benchmark-actor-workers.mjs \
    "${COMMON[@]}" --search-sims "$sims" --search-horizon "$horizon" \
    --search-objective solo-reach30 --search-rollout policy --search-frac 1 \
    --search-value-weight 0.5 --search-nav-temperature 0 \
    --report "$EXPERIMENT/artifacts/systems-$name.json"
  env ARC_INFER_WIRE=binary TMPDIR="$SCRATCH/tmp" nice -n 10 node scripts/benchmark-actor-workers.mjs \
    --games 64 --repeats 1 --workers 1 --seed0 953900000 --shuffle-seed 9539 \
    --seats 1 --max-rounds 30 --max-status-level 2 --guardian-schedule absolute-balanced \
    --catalog "$CATALOG" --infer-socket "$SOCKET" --selection hybrid --sample --temperature 0.55 \
    --neural-seats Red --no-record --obs-version 1 --policy-obs-version 2 \
    --search-sims "$sims" --search-horizon "$horizon" --search-objective solo-reach30 \
    --search-rollout policy --search-frac 1 --search-value-weight 0.5 --search-nav-temperature 0 \
    --report "$EXPERIMENT/artifacts/systems-latency-one-$name.json"
done

cleanup
trap - EXIT INT TERM
{
  date --iso-8601=seconds
  cat /proc/loadavg
  free -h
  df -h /data/share8 /dev/shm
  nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu --format=csv,noheader
} > "$EXPERIMENT/artifacts/systems-postflight.txt"
node scripts/record-v33-systems.mjs > "$EXPERIMENT/artifacts/systems-record.stdout"
