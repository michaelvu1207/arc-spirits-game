#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SCRIPT="$ROOT/scripts/run-v31-development-eval.sh"
EXPERIMENT="$ROOT/ml/experiments/v31-terminal-credit"
DEVELOPMENT="$EXPERIMENT/development"
CATALOG="ml/catalogs/live-20260713-5f4ad348.json"
SOURCE_COMMIT="bce8bf2"

evaluate_args() {
  printf '%s\n' \
    --catalog "$CATALOG" --source-commit "$SOURCE_COMMIT" \
    --games 4096 --workers 4 --seed0 944000000 \
    --max-rounds 30 --max-status-level 2 \
    --sample --temperature 0.55 --include-games
}

v1_worker() {
  local arm="$1" weights="$2"
  local arm_dir="$DEVELOPMENT/$arm"
  cd "$ROOT"
  mapfile -t shared < <(evaluate_args)
  set +e
  nice -n 10 node scripts/evaluate-solo-checkpoint.mjs \
    --weights "$weights" --policy-obs-version 1 \
    "${shared[@]}" --out "ml/experiments/v31-terminal-credit/development/$arm/report.json"
  local code=$?
  set -e
  printf '%s\n' "$code" > "$arm_dir/exit-code"
  exit "$code"
}

v2_worker() {
  local arm="$1" gpu="$2" weights="$3"
  local arm_dir="$DEVELOPMENT/$arm"
  local socket="/tmp/arc-v31-development-$arm-$$.sock"
  cd "$ROOT"
  env CUDA_VISIBLE_DEVICES="$gpu" nice -n 10 ml/.venv/bin/python ml/infer_server.py \
    --weights "$weights" --socket "$socket" --device cuda \
    --window-ms 2 --max-batch 512 --stats-interval 5 \
    > "$arm_dir/server.log" 2>&1 &
  local server_pid=$!
  cleanup() {
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM
  for _ in $(seq 1 60); do
    [[ -S "$socket" ]] && break
    kill -0 "$server_pid" 2>/dev/null || break
    sleep 1
  done
  if [[ ! -S "$socket" ]]; then
    printf 'inference server did not become ready\n' >&2
    printf '98\n' > "$arm_dir/exit-code"
    exit 98
  fi
  mapfile -t shared < <(evaluate_args)
  set +e
  nice -n 10 node scripts/evaluate-solo-checkpoint.mjs \
    --weights "$weights" --infer-socket "$socket" --policy-obs-version 2 \
    "${shared[@]}" --out "ml/experiments/v31-terminal-credit/development/$arm/report.json"
  local code=$?
  set -e
  printf '%s\n' "$code" > "$arm_dir/exit-code"
  exit "$code"
}

chain_v2_worker() {
  local arm="$1" dependency="$2" gpu="$3" weights="$4"
  local arm_dir="$DEVELOPMENT/$arm"
  while [[ ! -f "$DEVELOPMENT/$dependency/exit-code" ]]; do
    sleep 15
  done
  if [[ "$(cat "$DEVELOPMENT/$dependency/exit-code")" != "0" ]]; then
    printf 'dependency %s failed\n' "$dependency" >&2
    printf '99\n' > "$arm_dir/exit-code"
    exit 99
  fi
  v2_worker "$arm" "$gpu" "$weights"
}

if [[ "${1:-}" == "--v1-worker" ]]; then
  shift
  v1_worker "$@"
fi
if [[ "${1:-}" == "--v2-worker" ]]; then
  shift
  v2_worker "$@"
fi
if [[ "${1:-}" == "--chain-v2-worker" ]]; then
  shift
  chain_v2_worker "$@"
fi

cd "$ROOT"
declare -A WEIGHTS=(
  [v23]="ml/warmstart/v24/v23-control-gen5-obs199-act104.json"
  [v30]="ml/experiments/v30-strategic-tail-fidelity/artifacts/arms/strategic-cvar10-c025/checkpoint.pt"
  [anchor]="ml/experiments/v31-terminal-credit/arms/anchor-only/checkpoint.pt"
  [strategic-pg-0p1]="ml/experiments/v31-terminal-credit/arms/strategic-pg-0p1/checkpoint.pt"
  [strategic-pg-0p3]="ml/experiments/v31-terminal-credit/arms/strategic-pg-0p3/checkpoint.pt"
  [strategic-pg-0p6]="ml/experiments/v31-terminal-credit/arms/strategic-pg-0p6/checkpoint.pt"
)
for arm in "${!WEIGHTS[@]}"; do
  test -f "${WEIGHTS[$arm]}"
  if [[ "$arm" != "v23" ]]; then
    test -f "${WEIGHTS[$arm]%.pt}.manifest.json"
  fi
done

launch() {
  local mode="$1" arm="$2"
  shift 2
  local arm_dir="$DEVELOPMENT/$arm"
  if [[ -e "$arm_dir/run.log" || -e "$arm_dir/report.json" || -e "$arm_dir/exit-code" ]]; then
    printf 'refusing to reuse development directory: %s\n' "$arm_dir" >&2
    return 1
  fi
  mkdir -p "$arm_dir"
  nohup env ARC_ROOT="$ROOT" "$SCRIPT" "$mode" "$arm" "$@" \
    > "$arm_dir/run.log" 2>&1 < /dev/null &
  local pid=$!
  printf '%s\n' "$pid" > "$arm_dir/launch-pid"
  printf '%s pid=%s\n' "$arm" "$pid"
}

launch --v1-worker v23 "${WEIGHTS[v23]}"
launch --v2-worker v30 0 "${WEIGHTS[v30]}"
launch --v2-worker anchor 1 "${WEIGHTS[anchor]}"
launch --v2-worker strategic-pg-0p1 2 "${WEIGHTS[strategic-pg-0p1]}"
launch --v2-worker strategic-pg-0p3 3 "${WEIGHTS[strategic-pg-0p3]}"
launch --chain-v2-worker strategic-pg-0p6 v30 0 "${WEIGHTS[strategic-pg-0p6]}"
