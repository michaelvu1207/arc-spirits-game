#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SCRIPT="$ROOT/scripts/run-v31-terminal-credit.sh"
EXPERIMENT="$ROOT/ml/experiments/v31-terminal-credit"
ANCHOR="ml/experiments/v30-strategic-tail-fidelity/artifacts/arms/strategic-cvar10-c025/checkpoint.pt"
ANCHOR_SHA="c47a63ac7c4a74624294e5af49494e00812c97736db4a085f2fdad0deafa8a06"

verify_shared_inputs() {
  cd "$ROOT"
  local observed
  observed="$(sha256sum "$ANCHOR" | awk '{print $1}')"
  if [[ "$observed" != "$ANCHOR_SHA" ]]; then
    printf 'anchor hash mismatch: %s != %s\n' "$observed" "$ANCHOR_SHA" >&2
    return 1
  fi
  test -f ml/experiments/v30-strategic-tail-fidelity/data/train-merged/meta.json
  test -f ml/experiments/v30-strategic-tail-fidelity/data/validation/meta.json
  local free_kib
  free_kib="$(df -Pk "$ROOT" | awk 'NR == 2 {print $4}')"
  if (( free_kib < 5 * 1024 * 1024 )); then
    printf 'V31 requires at least 5 GiB free; found %s KiB\n' "$free_kib" >&2
    return 1
  fi
}

preflight() {
  verify_shared_inputs
  cd "$ROOT"
  local artifacts="$EXPERIMENT/artifacts"
  local unused="$artifacts/preflight-unused.pt"
  if [[ -e "$artifacts/preflight.json" || -e "$unused" ]]; then
    printf 'refusing to overwrite V31 preflight artifacts\n' >&2
    return 1
  fi
  mkdir -p "$artifacts"
  env CUDA_VISIBLE_DEVICES=0 nice -n 10 ml/.venv/bin/python ml/outcome_distill_v2.py \
    --data ml/experiments/v30-strategic-tail-fidelity/data/train-merged \
    --val-data ml/experiments/v30-strategic-tail-fidelity/data/validation \
    --teacher ml/warmstart/v24/v23-control-gen5-obs199-act104.json \
    --out "$unused" \
    --stats-out ml/experiments/v31-terminal-credit/artifacts/preflight.json \
    --outcome-reference "$ANCHOR" --outcome-behavior-ratio-cap 2 \
    --batch-size 512 --expected-temperature 0.55 \
    --teacher-logp-tolerance 0.001 --audit-only --device cuda
  test ! -e "$unused"
}

worker() {
  local arm="$1" gpu="$2" outcome_coef="$3"
  local arm_dir="$EXPERIMENT/arms/$arm"
  cd "$ROOT"
  set +e
  env CUDA_VISIBLE_DEVICES="$gpu" nice -n 10 /usr/bin/time -v \
    ml/.venv/bin/python ml/outcome_distill_v2.py \
      --data ml/experiments/v30-strategic-tail-fidelity/data/train-merged \
      --val-data ml/experiments/v30-strategic-tail-fidelity/data/validation \
      --teacher ml/warmstart/v24/v23-control-gen5-obs199-act104.json \
      --init "$ANCHOR" --outcome-reference "$ANCHOR" \
      --out "ml/experiments/v31-terminal-credit/arms/$arm/checkpoint.pt" \
      --stats-out "ml/experiments/v31-terminal-credit/arms/$arm/stats.json" \
      --epochs 2 --batch-size 512 --lr 0.00005 \
      --teacher-kl-coef 1 --strategic-tail-fraction 0.10 --strategic-tail-coef 0.25 \
      --value-coef 0 --reach30-coef 0 --outcome-pg-coef "$outcome_coef" \
      --clip-epsilon 0.2 --outcome-behavior-ratio-cap 2 \
      --seed 310100 --max-grad-norm 1 --expected-temperature 0.55 \
      --teacher-logp-tolerance 0.001 \
      --val-select-seed0 948000000 --val-select-games 256 \
      --max-mean-kl 0.05 --max-p99-kl 0.5 \
      --max-strategic-mean-kl 0.05 --max-strategic-p99-kl 0.4 \
      --min-top1-agreement 0.88 --min-strategic-top1-agreement 0.88 \
      --device cuda
  local code=$?
  set -e
  printf '%s\n' "$code" > "$arm_dir/exit-code"
  exit "$code"
}

if [[ "${1:-}" == "--preflight" ]]; then
  preflight
  exit 0
fi

if [[ "${1:-}" == "--worker" ]]; then
  shift
  worker "$@"
fi

verify_shared_inputs
test -f "$EXPERIMENT/artifacts/preflight.json"

launch() {
  local arm="$1" gpu="$2" outcome_coef="$3"
  local arm_dir="$EXPERIMENT/arms/$arm"
  if [[ -e "$arm_dir/train.log" || -e "$arm_dir/stats.json" || -e "$arm_dir/exit-code" ]]; then
    printf 'refusing to reuse arm directory: %s\n' "$arm_dir" >&2
    return 1
  fi
  mkdir -p "$arm_dir"
  nohup env ARC_ROOT="$ROOT" "$SCRIPT" --worker "$arm" "$gpu" "$outcome_coef" \
    > "$arm_dir/train.log" 2>&1 < /dev/null &
  local pid=$!
  printf '%s\n' "$pid" > "$arm_dir/launch-pid"
  printf '%s gpu=%s outcome_coef=%s pid=%s\n' "$arm" "$gpu" "$outcome_coef" "$pid"
}

launch anchor-only 0 0.0
launch strategic-pg-0p1 1 0.1
launch strategic-pg-0p3 2 0.3
launch strategic-pg-0p6 3 0.6
