#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v32-onpolicy-solo"
ANCHOR="$ROOT/ml/experiments/v30-strategic-tail-fidelity/artifacts/arms/strategic-cvar10-c025/checkpoint.pt"
CATALOG="$ROOT/ml/catalogs/live-20260713-5f4ad348.json"
SCRATCH="${ARC_V32_CRITIC_SCRATCH:-/dev/shm/arc-v32-critic}"
TRAIN="$SCRATCH/train"
VALIDATION="$SCRATCH/validation"
OUT="$EXPERIMENT/shared-critic/checkpoint.pt"
GPU="${V32_GPU:-7}"
STAGE="${1:-all}"

cd "$ROOT"
node scripts/lock-v32-inputs.mjs verify "$EXPERIMENT/artifacts/critic-lock.json"
WORKERS="$(node -e "const p=require('./ml/experiments/v32-onpolicy-solo/protocol.json'); if(!p.systemsBenchmark.result?.selectedWorkers)process.exit(2); process.stdout.write(String(p.systemsBenchmark.result.selectedWorkers))")"
mkdir -p "$SCRATCH" "$EXPERIMENT/shared-critic"
df -Pk "$SCRATCH" | awk 'NR==2 && $4 < 32*1024*1024 {exit 1}'

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
  local weights="$1" tag="$2"
  stop_server
  SOCKET="$SCRATCH/$tag.sock"
  rm -f "$SOCKET"
  env CUDA_VISIBLE_DEVICES="$GPU" nice -n 10 ml/.venv/bin/python ml/infer_server.py \
    --weights "$weights" --socket "$SOCKET" --device cuda --window-ms 2 --max-batch 512 \
    --stats-interval 5 > "$EXPERIMENT/shared-critic/$tag-server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 120); do
    [[ -S "$SOCKET" ]] && break
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  test -S "$SOCKET"
}
generate() {
  local out="$1" seed0="$2" games="$3" weights="$4" tag="$5"
  test ! -e "$out/meta.json"
  mkdir -p "$out"
  start_server "$weights" "$tag"
  env TMPDIR="$SCRATCH" nice -n 10 node scripts/run-actor-pool.mjs \
    --games "$games" --workers "$WORKERS" --seed0 "$seed0" --seats 1 --max-rounds 30 \
    --catalog "$CATALOG" --infer-socket "$SOCKET" --out "$out" --selection hybrid \
    --sample --temperature 0.55 --neural-seats Red --record-seats Red \
    --max-status-level 2 --shuffle-guardians --guardian-schedule absolute-balanced \
    --gamma 0.999 --obs-version 2 --policy-obs-version 2
  stop_server
}
train_critic() {
  test -f "$TRAIN/meta.json"
  test ! -e "$OUT"
  env CUDA_VISIBLE_DEVICES="$GPU" nice -n 10 /usr/bin/time -v \
    ml/.venv/bin/python ml/train.py --data "$TRAIN" --out "$OUT" --mode ppo --model v2 \
      --init-from "$ANCHOR" --epochs 4 --batch-size 512 --lr 0.0003 \
      --policy-coef 0 --value-coef 0.5 --entropy-coef 0 --kl-ref-coef 0 \
      --placement-coef 0 --farm-value-coef 0 --reward-pick-coef 0 --route-mode-coef 0 \
      --reach30-value-coef 1 --gamma 0.999 --gae-lambda 0.95 \
      --strategic-mc-coef 0 --solo-strategic-mc-coef 0 --solo-outcome-coef 0 \
      --solo-reach30-coef 0 --strategic-outcome-coef 0 --solo-terminal-objective resolved \
      --win-bonus 0 --all-fallen-loss 0 --max-grad-norm 1 --seed 946005120 \
      --v2-critic-only > "$EXPERIMENT/shared-critic/train.log" 2>&1
}
audit_critic() {
  test -f "$VALIDATION/meta.json"
  test -f "$OUT"
  env CUDA_VISIBLE_DEVICES="$GPU" nice -n 10 ml/.venv/bin/python ml/audit_v32_critic.py \
    --base "$ANCHOR" --critic "$OUT" --validation "$VALIDATION" \
    --seed0 946004096 --games 1024 --out "$EXPERIMENT/shared-critic/audit.json"
}

case "$STAGE" in
  generate-train) generate "$TRAIN" 946000000 4096 "$ANCHOR" train ;;
  train) train_critic ;;
  generate-validation) generate "$VALIDATION" 946004096 1024 "$OUT" validation ;;
  audit) audit_critic ;;
  all)
    generate "$TRAIN" 946000000 4096 "$ANCHOR" train
    train_critic
    generate "$VALIDATION" 946004096 1024 "$OUT" validation
    audit_critic
    ;;
  *) echo "usage: $0 [all|generate-train|train|generate-validation|audit]" >&2; exit 2 ;;
esac
