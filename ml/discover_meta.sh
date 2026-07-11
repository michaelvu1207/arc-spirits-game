#!/usr/bin/env bash
# AlphaZero meta-discovery loop for Arc Spirits.
#
# One command launches:
#   all-seat neural MCTS self-play -> AlphaZero pi/value training -> all-seat meta fingerprint -> repeat
#
# Defaults intentionally avoid heuristic opponents, prior weights, candidate-score/AWR training, and
# named strategy profiles. The current game driver still uses the existing within-round action executor
# after AZ chooses navigation; MICRO_PROFILE=random keeps that executor strategy-neutral until the
# planner is expanded to every command type.
#
# A100 quick start:
#   CUDA_VISIBLE_DEVICES=0 OUTER=20 GAMES=400 SHARDS=12 MCTS=200 bash ml/discover_meta.sh
#
# Local smoke:
#   RUN_ID=smoke OUTER=1 GAMES=1 SHARDS=1 MCTS=4 EPOCHS=1 META_GAMES=1 META_MCTS=4 bash ml/discover_meta.sh
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

set +u
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi
set -u

if [ -z "${CUDA_VISIBLE_DEVICES:-}" ] && command -v nvidia-smi >/dev/null 2>&1; then
  export CUDA_VISIBLE_DEVICES=0
fi

if [ -x "${PYTHON:-}" ]; then
  PY="$PYTHON"
elif [ -x "ml/.venv/bin/python" ]; then
  PY="ml/.venv/bin/python"
else
  PY="${PYTHON:-python3}"
fi

RUN_ID=${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
OUTER=${OUTER:-${AZ_OUTER:-20}}
GAMES=${GAMES:-${AZ_GAMES:-400}}
SHARDS=${SHARDS:-${AZ_SHARDS:-8}}
MCTS=${MCTS:-${AZ_MCTS:-200}}
HORIZON=${HORIZON:-${AZ_HORIZON:-30}}
EPOCHS=${EPOCHS:-${AZ_EPOCHS:-8}}
WINDOW=${WINDOW:-${AZ_WINDOW:-5}}
SEATS=${SEATS:-${AZ_SEATS:-4}}
BATCH=${BATCH:-512}
LR=${LR:-0.001}
VALUE_COEF=${VALUE_COEF:-0.5}
FARM_VALUE_COEF=${FARM_VALUE_COEF:-${AZ_FARM_VALUE_COEF:-0}}
REWARD_PICK_COEF=${REWARD_PICK_COEF:-${AZ_REWARD_PICK_COEF:-0}}
VALUEW=${VALUEW:-${AZ_VALUEW:-1}}
TEMP=${TEMP:-1}
HIDDEN=${ARC_HIDDEN:-256,256}
VHIDDEN=${ARC_VALUE_HIDDEN:-128}
MICRO_PROFILE=${MICRO_PROFILE:-${AZ_PLANNER_PROFILE:-random}}
AZ_CONTROL=${AZ_CONTROL:-navigation}
AZ_FULL_SELECTION=${AZ_FULL_SELECTION:-value}
AZ_FULL_LOOKAHEAD_DEPTH=${AZ_FULL_LOOKAHEAD_DEPTH:-${AZ_LOOKAHEAD_DEPTH:-2}}
AZ_FULL_LOOKAHEAD_BEAM=${AZ_FULL_LOOKAHEAD_BEAM:-${AZ_LOOKAHEAD_BEAM:-8}}
AZ_FULL_LOOKAHEAD_ROOT_BEAM=${AZ_FULL_LOOKAHEAD_ROOT_BEAM:-${AZ_LOOKAHEAD_ROOT_BEAM:-24}}
AZ_FULL_TARGET_TEMP=${AZ_FULL_TARGET_TEMP:-${AZ_TARGET_TEMP:-0.25}}
AZ_MICRO_WEIGHTS=${AZ_MICRO_WEIGHTS:-}
AZ_MICRO_GATE=${AZ_MICRO_GATE:-all}
AZ_FORBID_TYPES=${AZ_FORBID_TYPES:-${AZ_FORBID:-}}
AZ_MAX_STATUS_LEVEL=${AZ_MAX_STATUS_LEVEL:-}
AZ_POLICY_POOL=${AZ_POLICY_POOL:-${AZ_OPPONENT_WEIGHTS:-}}
AZ_POLICY_POOL_MIX=${AZ_POLICY_POOL_MIX:-1}
META_GAMES=${META_GAMES:-32}
META_MCTS=${META_MCTS:-$MCTS}
META_TEMP=${META_TEMP:-0.25}
BENCH_EVERY=${BENCH_EVERY:-0}
BENCH_FIELD=${BENCH_FIELD:-pvphunter,medium,cultivator,survivor}

RUN_DIR="ml/meta_runs/$RUN_ID"
DATA="$RUN_DIR/data"
WEIGHTS="$RUN_DIR/weights/policy.json"
CHECKPOINTS="$RUN_DIR/checkpoints"
LOGS="$RUN_DIR/logs"
META_DIR="$RUN_DIR/meta"
mkdir -p "$DATA" "$CHECKPOINTS" "$LOGS" "$META_DIR" "$(dirname "$WEIGHTS")" ml/meta_runs
(cd ml/meta_runs && ln -sfn "$RUN_ID" latest)

if [ -n "${INIT_WEIGHTS:-}" ]; then
  cp "$INIT_WEIGHTS" "$WEIGHTS"
  echo "[discover_meta] initialized weights from $INIT_WEIGHTS"
fi

cat > "$RUN_DIR/config.json" <<JSON
{
  "run_id": "$RUN_ID",
  "outer": $OUTER,
  "games": $GAMES,
  "shards": $SHARDS,
  "mcts": $MCTS,
  "horizon": $HORIZON,
  "epochs": $EPOCHS,
  "window": $WINDOW,
  "seats": $SEATS,
  "valueWeight": $VALUEW,
  "microProfile": "$MICRO_PROFILE",
  "control": "$AZ_CONTROL",
  "fullSelection": "$AZ_FULL_SELECTION",
  "fullLookaheadDepth": $AZ_FULL_LOOKAHEAD_DEPTH,
  "fullLookaheadBeam": $AZ_FULL_LOOKAHEAD_BEAM,
  "fullLookaheadRootBeam": $AZ_FULL_LOOKAHEAD_ROOT_BEAM,
  "fullTargetTemperature": $AZ_FULL_TARGET_TEMP,
  "microWeights": "$AZ_MICRO_WEIGHTS",
  "microGate": "$AZ_MICRO_GATE",
  "forbidTypes": "$AZ_FORBID_TYPES",
  "maxStatusLevel": "${AZ_MAX_STATUS_LEVEL:-}",
  "policyPool": "$AZ_POLICY_POOL",
  "policyPoolMix": $AZ_POLICY_POOL_MIX,
  "farmValueCoef": $FARM_VALUE_COEF,
  "rewardPickCoef": $REWARD_PICK_COEF,
  "hidden": "$HIDDEN",
  "valueHidden": "$VHIDDEN",
  "benchEvery": $BENCH_EVERY
}
JSON

echo "[discover_meta] run=$RUN_ID node=$(node -v 2>/dev/null) python=$($PY --version 2>&1)"
echo "[discover_meta] data=$DATA weights=$WEIGHTS latest=ml/meta_runs/latest"
echo "[discover_meta] all planner seats, alphazero mode, control=$AZ_CONTROL, fullSelection=$AZ_FULL_SELECTION, targetTemp=$AZ_FULL_TARGET_TEMP, lookaheadDepth=$AZ_FULL_LOOKAHEAD_DEPTH, valueW=$VALUEW, farmValueCoef=$FARM_VALUE_COEF, rewardPickCoef=$REWARD_PICK_COEF, microWeights=${AZ_MICRO_WEIGHTS:-<none>}, microGate=$AZ_MICRO_GATE, forbidTypes=${AZ_FORBID_TYPES:-<none>}, maxStatusLevel=${AZ_MAX_STATUS_LEVEL:-<none>}, policyPool=${AZ_POLICY_POOL:-<none>}, policyPoolMix=$AZ_POLICY_POOL_MIX, heuristic benchmark every $BENCH_EVERY iteration(s)"

if [ "${DISCOVER_DRY_RUN:-0}" = "1" ]; then
  echo "[discover_meta] dry run only"
  exit 0
fi

write_training_meta() {
  local samples="$1"
  local iter="$2"
  local obs_dim act_dim
  read -r obs_dim act_dim < <(node scripts/read-ml-sample-dims.mjs "$DATA")
  cat > "$DATA/meta.json" <<JSON
{
  "obs_dim": $obs_dim,
  "act_dim": $act_dim,
  "samples": $samples,
  "iter": $iter,
  "mode": "alphazero",
  "plannerSeatMode": "$([ -n "$AZ_POLICY_POOL" ] && printf 'policy-pool' || printf 'all')",
  "recordSeatMode": "$([ -n "$AZ_POLICY_POOL" ] && { node -e "process.stdout.write(Number(process.argv[1]) >= 1 ? 'one-learner' : 'mixed-self-and-learner')" "$AZ_POLICY_POOL_MIX"; } || printf 'all')",
  "policyPool": "$AZ_POLICY_POOL",
  "policyPoolMix": $AZ_POLICY_POOL_MIX,
  "farmValueCoef": $FARM_VALUE_COEF,
  "rewardPickCoef": $REWARD_PICK_COEF,
  "auxTargets": ["farmValue", "rewardPi"],
  "microWeights": "$AZ_MICRO_WEIGHTS",
  "microGate": "$AZ_MICRO_GATE"
}
JSON
}

maybe_promote_best() {
  local meta_file="$1"
  local iter="$2"
  local score
  score=$(node -e "const fs=require('fs'); const x=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(Number(x.meta_score ?? -1e9));" "$meta_file")
  local best="-1000000000"
  [ -f "$RUN_DIR/best_score" ] && best=$(cat "$RUN_DIR/best_score")
  if node -e "process.exit(Number(process.argv[1]) > Number(process.argv[2]) ? 0 : 1)" "$score" "$best"; then
    echo "$score" > "$RUN_DIR/best_score"
    cp "$WEIGHTS" "$RUN_DIR/best_policy.json"
    cp "$meta_file" "$RUN_DIR/best_meta.json"
    echo "[discover_meta] promoted iter $iter as best meta_score=$score"
  fi
}

for it in $(seq 1 "$OUTER"); do
  echo ""
  echo "========== META ITERATION $it / $OUTER =========="

  per=$(( (GAMES + SHARDS - 1) / SHARDS ))
  echo "[discover_meta] self-play: $SHARDS shard(s) x $per game(s), MCTS=$MCTS, all planner seats"
  pids=()
  for s in $(seq 0 $((SHARDS - 1))); do
    (
      AZ=1 \
      AZ_PLANNER_SEATS=all \
      AZ_GAMES=$per \
      AZ_ITERS=$MCTS \
      AZ_HORIZON=$HORIZON \
      AZ_VALUEW=$VALUEW \
      AZ_SEATS=$SEATS \
      AZ_SAMPLE=1 \
      AZ_TEMP=$TEMP \
      AZ_ITER=$it \
      AZ_SEED0=$((4000000 + it * 1000000 + s * 100000)) \
      AZ_PLANNER_PROFILE="$MICRO_PROFILE" \
      AZ_CONTROL="$AZ_CONTROL" \
      AZ_FULL_SELECTION="$AZ_FULL_SELECTION" \
      AZ_FULL_LOOKAHEAD_DEPTH="$AZ_FULL_LOOKAHEAD_DEPTH" \
      AZ_FULL_LOOKAHEAD_BEAM="$AZ_FULL_LOOKAHEAD_BEAM" \
      AZ_FULL_LOOKAHEAD_ROOT_BEAM="$AZ_FULL_LOOKAHEAD_ROOT_BEAM" \
      AZ_FULL_TARGET_TEMP="$AZ_FULL_TARGET_TEMP" \
      AZ_MICRO_WEIGHTS="$AZ_MICRO_WEIGHTS" \
      AZ_MICRO_GATE="$AZ_MICRO_GATE" \
      AZ_FORBID_TYPES="$AZ_FORBID_TYPES" \
      AZ_MAX_STATUS_LEVEL="$AZ_MAX_STATUS_LEVEL" \
      AZ_POLICY_POOL="$AZ_POLICY_POOL" \
      AZ_POLICY_POOL_MIX="$AZ_POLICY_POOL_MIX" \
      AZ_OUT="$DATA/iter${it}_shard${s}.jsonl" \
      AZ_WEIGHTS="$WEIGHTS" \
      npx vitest run src/lib/play/ml/_azgen.test.ts --disable-console-intercept
    ) > "$LOGS/gen_it${it}_s${s}.log" 2>&1 &
    pids+=($!)
  done
  for p in "${pids[@]}"; do
    wait "$p"
  done

  iter_samples=$(wc -l "$DATA"/iter${it}_shard*.jsonl | awk 'END { print $1 + 0 }')
  total_samples=$(cat "$DATA"/*.jsonl 2>/dev/null | wc -l | awk '{ print $1 + 0 }')
  echo "[discover_meta] generated iter_samples=$iter_samples replay_samples=$total_samples"
  write_training_meta "$total_samples" "$it"

  old=$((it - WINDOW))
  if [ "$old" -ge 1 ]; then
    rm -f "$DATA"/iter${old}_shard*.jsonl
  fi

  train_args=(--data "$DATA" --out "$WEIGHTS" --mode alphazero --epochs "$EPOCHS" --batch-size "$BATCH" --lr "$LR" --value-coef "$VALUE_COEF" --farm-value-coef "$FARM_VALUE_COEF" --reward-pick-coef "$REWARD_PICK_COEF")
  if [ "${NO_WARM_START:-0}" = "1" ]; then
    train_args+=(--no-warm-start)
  fi

  echo "[discover_meta] train: epochs=$EPOCHS batch=$BATCH hidden=$HIDDEN value_hidden=$VHIDDEN farmValueCoef=$FARM_VALUE_COEF rewardPickCoef=$REWARD_PICK_COEF"
  ARC_HIDDEN="$HIDDEN" ARC_VALUE_HIDDEN="$VHIDDEN" "$PY" ml/train.py "${train_args[@]}" 2>&1 | tee "$LOGS/train_it${it}.log"

  cp "$WEIGHTS" "$CHECKPOINTS/az_meta_iter${it}.json"

  meta_file="$META_DIR/meta_iter${it}.json"
  echo "[discover_meta] meta eval: games=$META_GAMES MCTS=$META_MCTS"
  AZMETA=1 \
  AZMETA_GAMES=$META_GAMES \
  AZMETA_ITERS=$META_MCTS \
  AZMETA_HORIZON=$HORIZON \
  AZMETA_VALUEW=$VALUEW \
  AZMETA_SEATS=$SEATS \
  AZMETA_TEMP=$META_TEMP \
  AZMETA_PROFILE="$MICRO_PROFILE" \
  AZMETA_CONTROL="$AZ_CONTROL" \
  AZMETA_FULL_SELECTION="$AZ_FULL_SELECTION" \
  AZMETA_FULL_LOOKAHEAD_DEPTH="$AZ_FULL_LOOKAHEAD_DEPTH" \
  AZMETA_FULL_LOOKAHEAD_BEAM="$AZ_FULL_LOOKAHEAD_BEAM" \
  AZMETA_FULL_LOOKAHEAD_ROOT_BEAM="$AZ_FULL_LOOKAHEAD_ROOT_BEAM" \
  AZMETA_FULL_TARGET_TEMP="$AZ_FULL_TARGET_TEMP" \
  AZMETA_MICRO_WEIGHTS="$AZ_MICRO_WEIGHTS" \
  AZMETA_MICRO_GATE="$AZ_MICRO_GATE" \
  AZMETA_FORBID_TYPES="$AZ_FORBID_TYPES" \
  AZMETA_MAX_STATUS_LEVEL="$AZ_MAX_STATUS_LEVEL" \
  AZMETA_WEIGHTS="$WEIGHTS" \
  AZMETA_OUT="$meta_file" \
  npx vitest run src/lib/play/ml/_azmeta.test.ts --disable-console-intercept 2>&1 | tee "$LOGS/meta_it${it}.log"
  cp "$meta_file" "$RUN_DIR/latest_meta.json"
  maybe_promote_best "$meta_file" "$it"

  if [ "$BENCH_EVERY" -gt 0 ] && [ $((it % BENCH_EVERY)) -eq 0 ]; then
    echo "[discover_meta] optional benchmark vs [$BENCH_FIELD]"
    AZEVAL=1 \
    AZEVAL_GAMES=${BENCH_GAMES:-24} \
    AZEVAL_ITERS=${BENCH_MCTS:-$MCTS} \
    AZEVAL_VALUEW=$VALUEW \
    AZEVAL_FIELD="$BENCH_FIELD" \
    AZEVAL_PLANNER_PROFILE="$MICRO_PROFILE" \
    AZEVAL_CONTROL="$AZ_CONTROL" \
    AZEVAL_FULL_SELECTION="$AZ_FULL_SELECTION" \
    AZEVAL_FULL_LOOKAHEAD_DEPTH="$AZ_FULL_LOOKAHEAD_DEPTH" \
    AZEVAL_FULL_LOOKAHEAD_BEAM="$AZ_FULL_LOOKAHEAD_BEAM" \
    AZEVAL_FULL_LOOKAHEAD_ROOT_BEAM="$AZ_FULL_LOOKAHEAD_ROOT_BEAM" \
    AZEVAL_FULL_TARGET_TEMP="$AZ_FULL_TARGET_TEMP" \
    AZEVAL_MICRO_WEIGHTS="$AZ_MICRO_WEIGHTS" \
    AZEVAL_MICRO_GATE="$AZ_MICRO_GATE" \
    AZEVAL_FORBID_TYPES="$AZ_FORBID_TYPES" \
    AZEVAL_MAX_STATUS_LEVEL="$AZ_MAX_STATUS_LEVEL" \
    AZEVAL_WEIGHTS="$WEIGHTS" \
    npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept 2>&1 | tee "$LOGS/bench_it${it}.log"
    cp ml/azeval_result.json "$META_DIR/bench_iter${it}.json"
  fi

  echo "[discover_meta] iteration $it complete checkpoint=$CHECKPOINTS/az_meta_iter${it}.json"
done

echo ""
echo "[discover_meta] done"
echo "[discover_meta] best weights: $RUN_DIR/best_policy.json"
echo "[discover_meta] best meta:    $RUN_DIR/best_meta.json"
echo "[discover_meta] latest run:   ml/meta_runs/latest"
