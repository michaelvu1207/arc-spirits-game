#!/usr/bin/env bash
set -euo pipefail

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v33-strategic-search"
ARTIFACTS="$EXPERIMENT/artifacts"
CHECKPOINT="$ROOT/ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt"
CATALOG="$ROOT/ml/catalogs/live-20260713-5f4ad348.json"
SCRATCH="${ARC_V33_SCRATCH:-/dev/shm/arc-v33-search}"
cd "$ROOT"

node scripts/verify-v33-source-lock.mjs "$ARTIFACTS/source-lock.json" >/dev/null
test "$(node -e "const x=require('$ARTIFACTS/phase2-analysis-initial.json');process.stdout.write(String(x.guardianConfirmationRequired))")" = true
test ! -d "$ARTIFACTS/guardian-confirmation"
SOURCE_COMMIT="$(node -e "const x=require('$ARTIFACTS/source-lock.json');process.stdout.write(x.implementationCommit)")"
mapfile -t SEARCH_ARMS < <(node -e "const x=require('$ARTIFACTS/phase2-authorization.json');for(const a of x.eligibleSearchArms)console.log(a)")
ARMS=(raw "${SEARCH_ARMS[@]}")
GPUS=(5 6 7 0)
mkdir -p "$ARTIFACTS/guardian-confirmation" "$SCRATCH/guardian"

run_arm() {
  local arm="$1" gpu="$2" workers="$3" dir="$SCRATCH/guardian/$arm" socket server_pid
  socket="$dir/infer.sock"
  mkdir -p "$dir/tmp"
  rm -f "$socket"
  env CUDA_VISIBLE_DEVICES="$gpu" nice -n 10 ml/.venv/bin/python ml/infer_server.py \
    --weights "$CHECKPOINT" --socket "$socket" --device cuda --window-ms 2 --max-batch 512 \
    --stats-interval 5 > "$ARTIFACTS/guardian-confirmation/$arm-infer.log" 2>&1 &
  server_pid=$!
  trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT INT TERM
  for _ in $(seq 1 120); do [[ -S "$socket" ]] && break; kill -0 "$server_pid" 2>/dev/null || break; sleep 1; done
  test -S "$socket"
  search_args=()
  if [[ "$arm" != raw ]]; then
    read -r sims horizon < <(node -e "const p=require('./ml/experiments/v33-strategic-search/protocol.json');const a=p.systems.arms.find(v=>v.id==='$arm');console.log(a.sims+' '+a.horizonRounds)")
    search_args=(--search-sims "$sims" --search-horizon "$horizon" --search-objective solo-reach30 --search-rollout policy --search-frac 1 --search-value-weight 0.5 --search-nav-temperature 0)
  fi
  env ARC_INFER_WIRE=binary TMPDIR="$dir/tmp" nice -n 10 node scripts/evaluate-solo-checkpoint.mjs \
    --weights "$CHECKPOINT" --catalog "$CATALOG" --source-commit "$SOURCE_COMMIT" \
    --infer-socket "$socket" --policy-obs-version 2 --games 8192 --workers "$workers" \
    --seed0 952300000 --max-rounds 30 --max-status-level 2 --sample --temperature 0.55 \
    --include-games "${search_args[@]}" --out "$ARTIFACTS/guardian-confirmation/$arm.json" \
    > "$ARTIFACTS/guardian-confirmation/$arm.stdout" 2> "$ARTIFACTS/guardian-confirmation/$arm.stderr"
}

pids=()
for index in "${!ARMS[@]}"; do
  arm="${ARMS[$index]}"
  workers="$(node -e "const x=require('$ARTIFACTS/systems-eligibility.json');const a=x.arms.find(v=>v.id==='$arm');process.stdout.write(String(a.selectedWorkers))")"
  run_arm "$arm" "${GPUS[$index]}" "$workers" & pids+=("$!")
done
status=0; set +e
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
set -e; test "$status" -eq 0

args=(--report "raw=$ARTIFACTS/phase2/raw.json" --guardian-report "raw=$ARTIFACTS/guardian-confirmation/raw.json")
for arm in "${SEARCH_ARMS[@]}"; do
  args+=(--report "$arm=$ARTIFACTS/phase2/$arm.json" --guardian-report "$arm=$ARTIFACTS/guardian-confirmation/$arm.json")
done
ml/.venv/bin/python -m ml.analyze_v33_search --repo "$ROOT" --protocol "$EXPERIMENT/protocol.json" \
  --source-lock "$ARTIFACTS/source-lock.json" --authorization "$ARTIFACTS/phase2-authorization.json" \
  --systems "$ARTIFACTS/systems-eligibility.json" "${args[@]}" \
  --out "$ARTIFACTS/phase2-analysis-confirmed.json" > "$ARTIFACTS/phase2-analysis-confirmed.stdout"
chmod 0444 "$ARTIFACTS"/guardian-confirmation/*.json "$ARTIFACTS/phase2-analysis-confirmed.json"
