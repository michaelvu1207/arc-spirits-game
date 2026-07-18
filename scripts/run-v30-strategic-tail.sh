#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SCRIPT="$ROOT/scripts/run-v30-strategic-tail.sh"
EXPERIMENT="$ROOT/ml/experiments/v30-strategic-tail-fidelity"

worker() {
  local arm="$1" gpu="$2" tail_fraction="$3" tail_coef="$4"
  local arm_dir="$EXPERIMENT/arms/$arm"
  local -a tail_args=()
  if [[ "$tail_fraction" != "none" ]]; then
    tail_args=(--strategic-tail-fraction "$tail_fraction" --strategic-tail-coef "$tail_coef")
  fi
  cd "$ROOT"
  set +e
  CUDA_VISIBLE_DEVICES="$gpu" nice -n 5 /usr/bin/time -v \
    ml/.venv/bin/python ml/outcome_distill_v2.py \
      --data ml/experiments/v30-strategic-tail-fidelity/data/train-merged \
      --val-data ml/experiments/v30-strategic-tail-fidelity/data/validation \
      --teacher ml/warmstart/v24/v23-control-gen5-obs199-act104.json \
      --init ml/experiments/v29-distill-fidelity/arms/d128-policy-only-continue24-lr1e4/checkpoint.pt \
      --out "ml/experiments/v30-strategic-tail-fidelity/arms/$arm/checkpoint.pt" \
      --stats-out "ml/experiments/v30-strategic-tail-fidelity/arms/$arm/stats.json" \
      --epochs 12 --batch-size 512 --lr 0.00005 \
      --teacher-kl-coef 1 --value-coef 0 --reach30-coef 0 --outcome-pg-coef 0 \
      --seed 300100 --max-grad-norm 1 --expected-temperature 0.55 \
      --teacher-logp-tolerance 0.001 --select-best-teacher-kl \
      --val-select-seed0 948000000 --val-select-games 256 \
      --early-stop-patience 4 --early-stop-min-delta 0.002 --early-stop-min-epochs 4 \
      --selection-metric strategicTeacherKlCvar05 \
      "${tail_args[@]}" --device cuda
  local code=$?
  set -e
  printf '%s\n' "$code" > "$arm_dir/exit-code"
  exit "$code"
}

if [[ "${1:-}" == "--worker" ]]; then
  shift
  worker "$@"
fi

launch() {
  local arm="$1" gpu="$2" tail_fraction="$3" tail_coef="$4"
  local arm_dir="$EXPERIMENT/arms/$arm"
  if [[ -e "$arm_dir/train.log" || -e "$arm_dir/stats.json" || -e "$arm_dir/exit-code" ]]; then
    printf 'refusing to reuse arm directory: %s\n' "$arm_dir" >&2
    return 1
  fi
  mkdir -p "$arm_dir"
  nohup env ARC_ROOT="$ROOT" "$SCRIPT" --worker \
    "$arm" "$gpu" "$tail_fraction" "$tail_coef" \
    > "$arm_dir/train.log" 2>&1 < /dev/null &
  local pid=$!
  printf '%s\n' "$pid" > "$arm_dir/launch-pid"
  printf '%s gpu=%s pid=%s\n' "$arm" "$gpu" "$pid"
}

launch mean-control 0 none 0
launch strategic-cvar10-c025 1 0.10 0.25
launch strategic-cvar10-c050 2 0.10 0.50
launch strategic-cvar05-c025 3 0.05 0.25
