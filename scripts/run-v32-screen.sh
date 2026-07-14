#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v32-onpolicy-solo"
SCRIPT="$ROOT/scripts/run-v32-screen.sh"
MODE="${1:---launch}"

cd "$ROOT"
if [[ "$MODE" == "--launch" ]]; then
  if [[ -f "$EXPERIMENT/artifacts/screen-orchestrator.pid" ]]; then
    OLD_PID="$(cat "$EXPERIMENT/artifacts/screen-orchestrator.pid")"
    if kill -0 "$OLD_PID" 2>/dev/null; then
      printf 'V32 screen orchestrator is already running pid=%s\n' "$OLD_PID" >&2
      exit 1
    fi
    mv "$EXPERIMENT/artifacts/screen-orchestrator.pid" \
      "$EXPERIMENT/artifacts/screen-orchestrator.pid.stale-$(date +%s)"
  fi
  if [[ -f "$EXPERIMENT/artifacts/screen-orchestrator.log" ]]; then
    mv "$EXPERIMENT/artifacts/screen-orchestrator.log" \
      "$EXPERIMENT/artifacts/screen-orchestrator.log.previous-$(date +%s)"
  fi
  nohup env ARC_ROOT="$ROOT" "$SCRIPT" --orchestrate \
    > "$EXPERIMENT/artifacts/screen-orchestrator.log" 2>&1 < /dev/null &
  printf '%s\n' "$!" > "$EXPERIMENT/artifacts/screen-orchestrator.pid"
  printf 'V32 screen orchestrator pid=%s\n' "$!"
  exit 0
fi
[[ "$MODE" == "--orchestrate" ]] || { echo "usage: $0 [--launch|--orchestrate]" >&2; exit 2; }
node scripts/lock-v32-inputs.mjs verify "$EXPERIMENT/artifacts/screen-lock.json"

run_wave() {
  local target_gen="$1"
  shift
  local -a specs=("$@") pids=() names=()
  for spec in "${specs[@]}"; do
    IFS=: read -r rep arm gpu <<< "$spec"
    local league="$EXPERIMENT/league/rep-$rep/$arm"
    local log="$league/orchestrator.log"
    env CUDA_VISIBLE_DEVICES="$gpu" ARC_ROOT="$ROOT" nice -n 10 \
      "$ROOT/scripts/run-v32-root.sh" "$league" "$target_gen" > "$log" 2>&1 &
    pids+=("$!")
    names+=("$rep/$arm")
  done
  local failed=0
  for index in "${!pids[@]}"; do
    if ! wait "${pids[$index]}"; then
      printf 'FAILED %s\n' "${names[$index]}" >&2
      failed=1
    fi
  done
  (( failed == 0 ))
}

run_all_waves() {
  local target_gen="$1"
  # The isolated-host optimum is 24 workers/root. Cap each wave at four roots
  # (96 actor threads) so the 128-core host retains headroom for CARLA and system
  # services; GPU 4 is intentionally never touched.
  run_wave "$target_gen" \
    a:control-uniform:5 a:round-reweighted:6 a:p30-credit025:7 \
    b:control-uniform:0
  run_wave "$target_gen" \
    b:round-reweighted:5 b:p30-credit025:6 \
    c:control-uniform:7 c:round-reweighted:0
  run_wave "$target_gen" c:p30-credit025:5
}
audit_manipulation() {
  local generation="$1"
  local out="$EXPERIMENT/artifacts/manipulation-gen${generation}.json"
  env CUDA_VISIBLE_DEVICES=7 PYTHONPATH=ml nice -n 10 ml/.venv/bin/python \
    ml/audit_v32_manipulation.py --experiment "$EXPERIMENT" \
    --validation /dev/shm/arc-v32-critic/validation --generation "$generation" --out "$out"
  node -e "const a=require(process.argv[1]);process.exit(a.manipulation.passed?0:1)" "$out"
}

run_all_waves 8
if audit_manipulation 8; then
  printf 'V32 nine-arm screen complete with eligible generation-8 endpoint\n'
else
  printf 'V32 generation 8 is outcome-blind inconclusive-underdosed; extending every root to generation 12\n'
  run_all_waves 12
  if audit_manipulation 12; then
    printf 'V32 nine-arm screen complete with eligible generation-12 endpoint\n'
  else
    printf 'V32 screen rejected: manipulation still failed at generation 12\n' >&2
    exit 1
  fi
fi
