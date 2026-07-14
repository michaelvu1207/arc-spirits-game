#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v33-strategic-search"
ARTIFACTS="$EXPERIMENT/artifacts"
CHECKPOINT="$ROOT/ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt"
CATALOG="$ROOT/ml/catalogs/live-20260713-5f4ad348.json"
SCRATCH="${ARC_V33_SCRATCH:-/dev/shm/arc-v33-search}"

cd "$ROOT"
test -f "$ARTIFACTS/source-lock.json"
test -f "$ARTIFACTS/systems-eligibility.json"
test -f "$ARTIFACTS/phase2-authorization.json"
node scripts/verify-v33-source-lock.mjs "$ARTIFACTS/source-lock.json" >/dev/null
node scripts/validate-v33-protocol.mjs >/dev/null
SOURCE_COMMIT="$(node -e "const x=require('$ARTIFACTS/source-lock.json');process.stdout.write(x.implementationCommit)")"
mapfile -t SEARCH_ARMS < <(node -e "const x=require('$ARTIFACTS/phase2-authorization.json');for(const a of x.eligibleSearchArms)console.log(a)")
ARMS=(raw "${SEARCH_ARMS[@]}")
GPUS=(5 6 7 0)
test "${#ARMS[@]}" -le 4
mkdir -p "$SCRATCH/phase2" "$ARTIFACTS/phase2"

total_workers=0
for arm in "${ARMS[@]}"; do
  workers="$(node -e "const x=require('$ARTIFACTS/systems-eligibility.json');const a=x.arms.find(v=>v.id==='$arm');if(!a||!a.operationallyEligible)process.exit(2);process.stdout.write(String(a.selectedWorkers))")"
  total_workers=$((total_workers + workers))
  test ! -e "$ARTIFACTS/phase2/$arm.json"
done
test "$total_workers" -le 96

{
  date --iso-8601=seconds
  cat /proc/loadavg
  free -h
  df -h /data/share8 /dev/shm
  nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader
} > "$ARTIFACTS/phase2/preflight.txt"

run_arm() {
  local arm="$1" gpu="$2" workers="$3" dir="$SCRATCH/phase2/$arm"
  local socket="$dir/infer.sock" server_pid
  mkdir -p "$dir/tmp"
  rm -f "$socket"
  env CUDA_VISIBLE_DEVICES="$gpu" nice -n 10 ml/.venv/bin/python ml/infer_server.py \
    --weights "$CHECKPOINT" --socket "$socket" --device cuda --window-ms 2 --max-batch 512 \
    --stats-interval 5 > "$ARTIFACTS/phase2/$arm-infer.log" 2>&1 &
  server_pid=$!
  trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT INT TERM
  for _ in $(seq 1 120); do
    [[ -S "$socket" ]] && break
    kill -0 "$server_pid" 2>/dev/null || break
    sleep 1
  done
  test -S "$socket"
  search_args=()
  if [[ "$arm" != raw ]]; then
    read -r sims horizon < <(node -e "const p=require('./ml/experiments/v33-strategic-search/protocol.json');const a=p.systems.arms.find(v=>v.id==='$arm');console.log(a.sims+' '+a.horizonRounds)")
    search_args=(--search-sims "$sims" --search-horizon "$horizon" --search-objective solo-reach30 --search-rollout policy --search-frac 1 --search-value-weight 0.5 --search-nav-temperature 0)
  fi
  env ARC_INFER_WIRE=binary TMPDIR="$dir/tmp" nice -n 10 node scripts/evaluate-solo-checkpoint.mjs \
    --weights "$CHECKPOINT" --catalog "$CATALOG" --source-commit "$SOURCE_COMMIT" \
    --infer-socket "$socket" --policy-obs-version 2 --games 4096 --workers "$workers" \
    --seed0 952000000 --max-rounds 30 --max-status-level 2 --sample --temperature 0.55 \
    --include-games "${search_args[@]}" --out "$ARTIFACTS/phase2/$arm.json" \
    > "$ARTIFACTS/phase2/$arm.stdout" 2> "$ARTIFACTS/phase2/$arm.stderr"
}

pids=()
for index in "${!ARMS[@]}"; do
  arm="${ARMS[$index]}"
  workers="$(node -e "const x=require('$ARTIFACTS/systems-eligibility.json');const a=x.arms.find(v=>v.id==='$arm');process.stdout.write(String(a.selectedWorkers))")"
  run_arm "$arm" "${GPUS[$index]}" "$workers" &
  pids+=("$!")
done
status=0
set +e
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
set -e
test "$status" -eq 0

report_args=(--report "raw=$ARTIFACTS/phase2/raw.json")
for arm in "${SEARCH_ARMS[@]}"; do report_args+=(--report "$arm=$ARTIFACTS/phase2/$arm.json"); done
ml/.venv/bin/python -m ml.analyze_v33_search \
  --repo "$ROOT" --protocol "$EXPERIMENT/protocol.json" \
  --source-lock "$ARTIFACTS/source-lock.json" --authorization "$ARTIFACTS/phase2-authorization.json" \
  --systems "$ARTIFACTS/systems-eligibility.json" "${report_args[@]}" \
  --out "$ARTIFACTS/phase2-analysis-initial.json" > "$ARTIFACTS/phase2-analysis.stdout"
chmod 0444 "$ARTIFACTS"/phase2/*.json "$ARTIFACTS/phase2-analysis-initial.json"
{
  date --iso-8601=seconds
  cat /proc/loadavg
  free -h
  df -h /data/share8 /dev/shm
  nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu --format=csv,noheader
} > "$ARTIFACTS/phase2/postflight.txt"
