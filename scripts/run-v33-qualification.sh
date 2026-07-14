#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 2 ]]; then
  echo "usage: run-v33-qualification.sh development|hidden PHASE2_ANALYSIS [DEVELOPMENT_ANALYSIS]" >&2
  exit 2
fi
STAGE="$1"
PHASE2_ANALYSIS="$2"
PRIOR_DEVELOPMENT="${3:-}"
case "$STAGE" in development|hidden) ;; *) echo "invalid stage" >&2; exit 2 ;; esac

ROOT="${ARC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXPERIMENT="$ROOT/ml/experiments/v33-strategic-search"
ARTIFACTS="$EXPERIMENT/artifacts"
CHECKPOINT="$ROOT/ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt"
V23="$ROOT/ml/warmstart/v24/v23-control-gen5-obs199-act104.json"
CATALOG="$ROOT/ml/catalogs/live-20260713-5f4ad348.json"
SCRATCH="${ARC_V33_SCRATCH:-/dev/shm/arc-v33-search}/qualification-$STAGE"
OUT="$ARTIFACTS/qualification-$STAGE"
cd "$ROOT"

node scripts/verify-v33-source-lock.mjs "$ARTIFACTS/source-lock.json" >/dev/null
test -f "$PHASE2_ANALYSIS"
SELECTED="$(node -e "const x=require('$PHASE2_ANALYSIS');if(!x.selectedArm||!x.authorizationResult.phase3DevelopmentSeedsOpen)process.exit(2);process.stdout.write(x.selectedArm)")"
if [[ "$STAGE" = hidden ]]; then
  test -n "$PRIOR_DEVELOPMENT"
  test "$(node -e "const x=require('$PRIOR_DEVELOPMENT');process.stdout.write(String(x.authorizationResult.hiddenSeedsOpen))")" = true
fi
read -r SEED0 GAMES < <(node -e "const p=require('./ml/experiments/v33-strategic-search/protocol.json');const b=p.phase3['$STAGE'];console.log(b.seed0+' '+b.games)")
read -r SIMS HORIZON < <(node -e "const p=require('./ml/experiments/v33-strategic-search/protocol.json');const a=p.systems.arms.find(v=>v.id==='$SELECTED');console.log(a.sims+' '+a.horizonRounds)")
SELECTED_WORKERS="$(node -e "const x=require('$ARTIFACTS/systems-eligibility.json');process.stdout.write(String(x.arms.find(v=>v.id==='$SELECTED').selectedWorkers))")"
RAW_WORKERS="$(node -e "const x=require('$ARTIFACTS/systems-eligibility.json');process.stdout.write(String(x.arms.find(v=>v.id==='raw').selectedWorkers))")"
V23_WORKERS=24
test $((SELECTED_WORKERS + RAW_WORKERS + V23_WORKERS)) -le 96
test ! -d "$OUT"
mkdir -p "$OUT" "$SCRATCH/selected/tmp" "$SCRATCH/raw/tmp" "$SCRATCH/v23/tmp"
SOURCE_COMMIT="$(node -e "const x=require('$ARTIFACTS/source-lock.json');process.stdout.write(x.implementationCommit)")"

run_v2() {
  local label="$1" gpu="$2" workers="$3" socket="$SCRATCH/$label/infer.sock" server_pid
  shift 3
  rm -f "$socket"
  env CUDA_VISIBLE_DEVICES="$gpu" nice -n 10 ml/.venv/bin/python ml/infer_server.py \
    --weights "$CHECKPOINT" --socket "$socket" --device cuda --window-ms 2 --max-batch 512 \
    --stats-interval 5 > "$OUT/$label-infer.log" 2>&1 &
  server_pid=$!
  trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT INT TERM
  for _ in $(seq 1 120); do [[ -S "$socket" ]] && break; kill -0 "$server_pid" 2>/dev/null || break; sleep 1; done
  test -S "$socket"
  env ARC_INFER_WIRE=binary TMPDIR="$SCRATCH/$label/tmp" nice -n 10 node scripts/evaluate-solo-checkpoint.mjs \
    --weights "$CHECKPOINT" --catalog "$CATALOG" --source-commit "$SOURCE_COMMIT" \
    --infer-socket "$socket" --policy-obs-version 2 --games "$GAMES" --workers "$workers" \
    --seed0 "$SEED0" --max-rounds 30 --max-status-level 2 --sample --temperature 0.55 \
    --include-games "$@" --out "$OUT/$label.json" > "$OUT/$label.stdout" 2> "$OUT/$label.stderr"
}

run_v2 selected 5 "$SELECTED_WORKERS" --search-sims "$SIMS" --search-horizon "$HORIZON" \
  --search-objective solo-reach30 --search-rollout policy --search-frac 1 \
  --search-value-weight 0.5 --search-nav-temperature 0 & p_selected=$!
run_v2 raw 6 "$RAW_WORKERS" & p_raw=$!
env TMPDIR="$SCRATCH/v23/tmp" nice -n 10 node scripts/evaluate-solo-checkpoint.mjs \
  --weights "$V23" --catalog "$CATALOG" --source-commit "$SOURCE_COMMIT" \
  --policy-obs-version 1 --games "$GAMES" --workers "$V23_WORKERS" --seed0 "$SEED0" \
  --max-rounds 30 --max-status-level 2 --sample --temperature 0.55 --include-games \
  --out "$OUT/v23.json" > "$OUT/v23.stdout" 2> "$OUT/v23.stderr" & p_v23=$!

status=0; set +e
for pid in "$p_selected" "$p_raw" "$p_v23"; do wait "$pid" || status=1; done
set -e; test "$status" -eq 0

prior_args=()
if [[ "$STAGE" = hidden ]]; then prior_args=(--prior-development "$PRIOR_DEVELOPMENT"); fi
ml/.venv/bin/python -m ml.analyze_v33_qualification --stage "$STAGE" --repo "$ROOT" \
  --protocol "$EXPERIMENT/protocol.json" --source-lock "$ARTIFACTS/source-lock.json" \
  --phase2-analysis "$PHASE2_ANALYSIS" "${prior_args[@]}" \
  --selected "$OUT/selected.json" --raw "$OUT/raw.json" --v23 "$OUT/v23.json" \
  --out "$ARTIFACTS/qualification-$STAGE-analysis.json" \
  > "$ARTIFACTS/qualification-$STAGE-analysis.stdout"
chmod 0444 "$OUT"/*.json "$ARTIFACTS/qualification-$STAGE-analysis.json"
