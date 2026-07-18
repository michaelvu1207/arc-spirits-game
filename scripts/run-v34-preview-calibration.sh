#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v34-latency-first-expert-iteration"
ARTIFACTS="$EXPERIMENT/artifacts"
CHECKPOINT="$ROOT/ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt"
CATALOG="$ROOT/ml/catalogs/live-20260713-5f4ad348.json"
SCRATCH="${ARC_V34_SCRATCH:-/dev/shm/arc-v34}"
GPU="${1:-0}"
SOCKET="$SCRATCH/preview-infer.sock"
DATA="$SCRATCH/preview-calibration-data"
cd "$ROOT"
case "$GPU" in 0|5|6|7) ;; *) echo "V34 preview GPU must be 0,5,6,7" >&2; exit 2 ;; esac
node scripts/verify-v34-source-lock.mjs "$ARTIFACTS/source-lock.json" >/dev/null
node scripts/validate-v34-protocol.mjs >/dev/null
node scripts/verify-v34-authorization-chain.mjs preview >/dev/null
test "$(node -e "const x=require('$ARTIFACTS/source-lock.json');process.stdout.write(String(x.authorization.previewCalibrationSeedsOpen))")" = true
test "$(node -e "const x=require('$ARTIFACTS/preflight/result.json');process.stdout.write(String(x.passed))")" = true
for file in preview-calibration-collection.json preview-calibration.json systems-authorization.json; do
  test ! -e "$ARTIFACTS/$file"
done
mkdir -p "$ARTIFACTS" "$SCRATCH/tmp"
test ! -e "$DATA" || test -z "$(find "$DATA" -mindepth 1 -maxdepth 1 -print -quit)"
df -Pk "$SCRATCH" | awk 'NR==2 && $4 < 16*1024*1024 {exit 1}'
{
  date --iso-8601=seconds
  cat /proc/loadavg
  free -h
  df -h /data/share8 /dev/shm
  nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader
} > "$ARTIFACTS/preview-calibration-preflight.txt"

rm -f "$SOCKET"
env CUDA_VISIBLE_DEVICES="$GPU" nice -n 19 ml/.venv/bin/python ml/infer_server.py \
  --weights "$CHECKPOINT" --socket "$SOCKET" --device cuda --window-ms 2 --max-batch 512 \
  --stats-interval 5 > "$ARTIFACTS/preview-calibration-infer.log" 2>&1 &
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

env ARC_INFER_WIRE=binary TMPDIR="$SCRATCH/tmp" nice -n 19 \
  node scripts/collect-v34-preview-calibration.mjs \
  --weights "$CHECKPOINT" --catalog "$CATALOG" --infer-socket "$SOCKET" \
  --seed0 957800000 --games 4096 --workers 24 --data-dir "$DATA" \
  --progress "$ARTIFACTS/preview-calibration-progress.jsonl" \
  --out "$ARTIFACTS/preview-calibration-collection.json" \
  > "$ARTIFACTS/preview-calibration-collector.stdout" \
  2> "$ARTIFACTS/preview-calibration-collector.stderr"

mapfile -t PREVIEW_FILES < <(find "$DATA" -maxdepth 1 -type f -name 'preview-audit-*.jsonl' | sort)
test "${#PREVIEW_FILES[@]}" -gt 0
ANALYZE_ARGS=()
for file in "${PREVIEW_FILES[@]}"; do ANALYZE_ARGS+=(--input "$file"); done
ml/.venv/bin/python -m ml.analyze_v34_preview_calibration \
  "${ANALYZE_ARGS[@]}" --seed0 957800000 --games 4096 \
  --out "$ARTIFACTS/preview-calibration.json" \
  > "$ARTIFACTS/preview-calibration-analysis.stdout"
node scripts/record-v34-systems-authorization.mjs \
  > "$ARTIFACTS/systems-authorization.stdout"
rm -rf "$DATA"
cleanup
trap - EXIT INT TERM
{
  date --iso-8601=seconds
  cat /proc/loadavg
  free -h
  df -h /data/share8 /dev/shm
  nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu --format=csv,noheader
} > "$ARTIFACTS/preview-calibration-postflight.txt"
