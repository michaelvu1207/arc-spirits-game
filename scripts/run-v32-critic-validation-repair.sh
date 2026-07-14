#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v32-onpolicy-solo"
ANCHOR="$ROOT/ml/experiments/v30-strategic-tail-fidelity/artifacts/arms/strategic-cvar10-c025/checkpoint.pt"
CATALOG="$ROOT/ml/catalogs/live-20260713-5f4ad348.json"
SCRATCH="${ARC_V32_CRITIC_SCRATCH:-/dev/shm/arc-v32-critic}"
FAILED="$SCRATCH/validation-missing-reach30pred"
VALIDATION="$SCRATCH/validation"
OUT="$EXPERIMENT/shared-critic/checkpoint.pt"
LOCK="$EXPERIMENT/artifacts/critic-telemetry-repair-lock.json"
GPU="${V32_GPU:-7}"
STAGE="${1:-all}"

cd "$ROOT"
node scripts/lock-v32-inputs.mjs verify "$LOCK"
WORKERS="$(node -e "const p=require('./ml/experiments/v32-onpolicy-solo/protocol.json'); process.stdout.write(String(p.systemsBenchmark.result.selectedWorkers))")"
mkdir -p "$SCRATCH" "$EXPERIMENT/shared-critic"
df -Pk "$SCRATCH" | awk 'NR==2 && $4 < 16*1024*1024 {exit 1}'

SERVER_PID=""
SOCKET=""
stop_server() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}
trap stop_server EXIT INT TERM
start_server() {
  stop_server
  SOCKET="$SCRATCH/validation-repair.sock"
  rm -f "$SOCKET"
  env CUDA_VISIBLE_DEVICES="$GPU" nice -n 10 ml/.venv/bin/python ml/infer_server.py \
    --weights "$OUT" --socket "$SOCKET" --device cuda --window-ms 2 --max-batch 512 \
    --stats-interval 5 > "$EXPERIMENT/shared-critic/validation-repair-server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 120); do
    [[ -S "$SOCKET" ]] && break
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  test -S "$SOCKET"
}
archive_failed() {
  test -f "$VALIDATION/meta.json"
  test ! -e "$FAILED"
  mv "$VALIDATION" "$FAILED"
}
generate() {
  test -f "$FAILED/meta.json"
  test ! -e "$VALIDATION/meta.json"
  mkdir -p "$VALIDATION"
  start_server
  env TMPDIR="$SCRATCH" nice -n 10 node scripts/run-actor-pool.mjs \
    --games 1024 --workers "$WORKERS" --seed0 946004096 --seats 1 --max-rounds 30 \
    --catalog "$CATALOG" --infer-socket "$SOCKET" --out "$VALIDATION" --selection hybrid \
    --sample --temperature 0.55 --neural-seats Red --record-seats Red \
    --max-status-level 2 --shuffle-guardians --guardian-schedule absolute-balanced \
    --gamma 0.999 --obs-version 2 --policy-obs-version 2
  stop_server
}
audit_replay() {
  test -f "$FAILED/meta.json"
  test -f "$VALIDATION/meta.json"
  nice -n 10 ml/.venv/bin/python ml/audit_v32_validation_replay.py \
    --before "$FAILED" --after "$VALIDATION" \
    --out "$EXPERIMENT/shared-critic/validation-replay-audit.json"
}
audit_critic() {
  test -f "$EXPERIMENT/shared-critic/validation-replay-audit.json"
  env CUDA_VISIBLE_DEVICES="$GPU" nice -n 10 ml/.venv/bin/python ml/audit_v32_critic.py \
    --base "$ANCHOR" --critic "$OUT" --validation "$VALIDATION" \
    --seed0 946004096 --games 1024 --out "$EXPERIMENT/shared-critic/audit.json"
}

case "$STAGE" in
  archive) archive_failed ;;
  generate) generate ;;
  replay-audit) audit_replay ;;
  critic-audit) audit_critic ;;
  all)
    archive_failed
    generate
    audit_replay
    audit_critic
    ;;
  *) echo "usage: $0 [all|archive|generate|replay-audit|critic-audit]" >&2; exit 2 ;;
esac
