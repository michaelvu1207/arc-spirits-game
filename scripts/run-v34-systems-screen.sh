#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v34-latency-first-expert-iteration"
ARTIFACTS="$EXPERIMENT/artifacts"
CHECKPOINT="$ROOT/ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt"
CATALOG="$ROOT/ml/catalogs/live-20260713-5f4ad348.json"
SCRATCH="${ARC_V34_SCRATCH:-/dev/shm/arc-v34}"
GPU="${1:-0}"
SOCKET="$SCRATCH/systems-infer.sock"
cd "$ROOT"
case "$GPU" in 0|5|6|7) ;; *) echo "V34 systems GPU must be 0,5,6,7" >&2; exit 2 ;; esac
node scripts/verify-v34-source-lock.mjs "$ARTIFACTS/source-lock.json" >/dev/null
node scripts/validate-v34-protocol.mjs >/dev/null
node scripts/verify-v34-authorization-chain.mjs systems >/dev/null
test "$(node -e "const x=require('$ARTIFACTS/systems-authorization.json');process.stdout.write(String(x.authorization.systemsSeedsOpen))")" = true
test ! -e "$ARTIFACTS/systems-eligibility.json"
test ! -e "$ARTIFACTS/phase2-authorization.json"
mkdir -p "$ARTIFACTS/systems/stages" "$SCRATCH/tmp"
df -Pk "$SCRATCH" | awk 'NR==2 && $4 < 16*1024*1024 {exit 1}'
{
  date --iso-8601=seconds
  cat /proc/loadavg
  free -h
  df -h /data/share8 /dev/shm
  nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader
} > "$ARTIFACTS/systems/preflight.txt"

rm -f "$SOCKET"
env CUDA_VISIBLE_DEVICES="$GPU" nice -n 19 ml/.venv/bin/python ml/infer_server.py \
  --weights "$CHECKPOINT" --socket "$SOCKET" --device cuda --window-ms 2 --max-batch 512 \
  --stats-interval 5 > "$ARTIFACTS/systems/infer.log" 2>&1 &
SERVER_PID=$!
(
  while kill -0 "$SERVER_PID" 2>/dev/null; do
    date --iso-8601=seconds
    cat /proc/loadavg
    nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu --format=csv,noheader
    sleep 5
  done
) > "$ARTIFACTS/systems/resources.log" 2>&1 &
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
PROTOCOL_SHA="$(sha256sum "$EXPERIMENT/protocol.json" | awk '{print $1}')"
mapfile -t ARMS < <(node -e "const x=require('$ARTIFACTS/systems-authorization.json');for(const arm of x.enabledCandidateArms)console.log(arm)")

completed_stage_result() {
  local arm="$1" stage="$2" base="$ARTIFACTS/systems/stages/$1/$2" report attempt parsed
  for attempt in 1 2; do
    report="$base/attempt-$attempt/stage-report.json"
    [[ -f "$report" ]] || continue
    if ! parsed="$(node -e '
      const crypto = require("node:crypto");
      const fs = require("node:fs");
      const [reportPath, arm, stage, protocolSha] = process.argv.slice(1);
      const sha = (path) => crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
      const row = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      if (row.schemaVersion !== "arc-v34-systems-stage-v1" || row.arm !== arm || row.stage !== stage ||
          row.strengthUse !== false || row.outcomesLoaded !== false ||
          row.inputs?.protocol?.sha256 !== protocolSha || sha(row.inputs.protocol.path) !== protocolSha ||
          sha(row.inputs.benchmark.path) !== row.inputs.benchmark.sha256 ||
          sha(row.inputs.progress.path) !== row.inputs.progress.sha256) {
        throw new Error(`invalid completed V34 systems stage ${arm}/${stage}`);
      }
      process.stdout.write(row.eligible === true ? "eligible" : "rejected");
    ' "$report" "$arm" "$stage" "$PROTOCOL_SHA")"; then
      return 2
    fi
    printf '%s' "$parsed"
    return 0
  done
  printf 'missing'
}

run_stage() {
  local arm="$1" stage="$2" games="$3" workers="$4"
  local base="$ARTIFACTS/systems/stages/$arm/$stage" attempt=1 dir status
  if ! status="$(completed_stage_result "$arm" "$stage")"; then return 2; fi
  case "$status" in
    eligible|rejected) STAGE_RESULT="$status"; return 0 ;;
    missing) ;;
    *) echo "invalid V34 completed-stage result: $status" >&2; return 2 ;;
  esac
  if [[ -d "$base/attempt-1" ]]; then attempt=2; fi
  if [[ -d "$base/attempt-2" ]]; then
    echo "V34 systems retry exhausted without an immutable report: $arm/$stage" >&2
    return 2
  fi
  dir="$base/attempt-$attempt"
  test ! -e "$dir"
  mkdir -p "$dir" "$SCRATCH/tmp/$arm-$stage-a$attempt"
  local arm_args=()
  case "$arm" in
    rerank-p025) arm_args=(--rerank-policy-weight 0.25) ;;
    rerank-p050) arm_args=(--rerank-policy-weight 0.5) ;;
    rerank-p075) arm_args=(--rerank-policy-weight 0.75) ;;
    rerank-p100) arm_args=(--rerank-policy-weight 1) ;;
    heuristic-s4-h2) arm_args=(--search-sims 4 --search-horizon 2 --search-objective solo-reach30 --search-rollout heuristic --search-frac 1 --search-value-weight 0.5 --search-nav-temperature 0) ;;
    heuristic-s8-h3) arm_args=(--search-sims 8 --search-horizon 3 --search-objective solo-reach30 --search-rollout heuristic --search-frac 1 --search-value-weight 0.5 --search-nav-temperature 0) ;;
    *) echo "unknown V34 arm $arm" >&2; return 2 ;;
  esac
  env ARC_INFER_WIRE=binary TMPDIR="$SCRATCH/tmp/$arm-$stage-a$attempt" nice -n 19 \
    node scripts/benchmark-actor-workers.mjs \
    --games "$games" --repeats 1 --workers "$workers" --seed0 957900000 --shuffle-seed 9579 \
    --seats 1 --max-rounds 30 --max-status-level 2 --guardian-schedule absolute-balanced \
    --weights "$CHECKPOINT" --catalog "$CATALOG" --infer-socket "$SOCKET" \
    --selection hybrid --sample --temperature 0.55 --neural-seats Red --no-record \
    --no-game-summaries \
    --obs-version 1 --policy-obs-version 2 "${arm_args[@]}" \
    --label "$arm/$stage" --config-hash "$PROTOCOL_SHA" \
    --progress "$dir/progress.jsonl" --report "$dir/benchmark.json" \
    > "$dir/benchmark.stdout" 2> "$dir/benchmark.stderr"
  node scripts/record-v34-systems-stage.mjs --arm "$arm" --stage "$stage" \
    --benchmark "$dir/benchmark.json" --progress "$dir/progress.jsonl" \
    --out "$dir/stage-report.json" > "$dir/record.stdout"
  if ! STAGE_RESULT="$(completed_stage_result "$arm" "$stage")"; then return 2; fi
  case "$STAGE_RESULT" in
    eligible|rejected) ;;
    *) echo "V34 stage recorder produced no valid immutable result: $arm/$stage" >&2; return 2 ;;
  esac
}

for arm in "${ARMS[@]}"; do
  run_stage "$arm" smoke 4 1
  if [[ "$STAGE_RESULT" = rejected ]]; then continue; fi
  run_stage "$arm" binding-w1 64 1
  if [[ "$STAGE_RESULT" = rejected ]]; then continue; fi
  run_stage "$arm" binding-w8 64 8
  if [[ "$STAGE_RESULT" = rejected ]]; then continue; fi
  for workers in 4 8 12 16 24; do
    run_stage "$arm" "throughput-w$workers" 128 "$workers"
    if [[ "$STAGE_RESULT" = rejected ]]; then break; fi
  done
done

cleanup
trap - EXIT INT TERM
{
  date --iso-8601=seconds
  cat /proc/loadavg
  free -h
  df -h /data/share8 /dev/shm
  nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader
} > "$ARTIFACTS/systems/postflight.txt"
node scripts/record-v34-systems-eligibility.mjs > "$ARTIFACTS/systems/eligibility.stdout"
