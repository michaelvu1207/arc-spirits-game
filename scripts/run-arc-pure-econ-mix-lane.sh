#!/usr/bin/env bash
set -euo pipefail

HOST="${ARC_BOT_GPU_HOST:-ubuntu@216.151.21.122}"
REMOTE_DIR="${ARC_BOT_REMOTE_DIR:-/data/share8/michaelvuaprilexperimentation/arc-bot}"
RUN_ID="${RUN_ID:-pure-econ-mix-$(date -u +%Y%m%dT%H%M%SZ)}"
GPU="${GPU:-5}"

INIT_WEIGHTS="${INIT_WEIGHTS:-ml/meta_runs/aux-head-act52-medium-20260627T222453Z/best_policy.json}"
CLEAN_GAMES="${CLEAN_GAMES:-32}"
AZ_GAMES="${AZ_GAMES:-32}"
AZ_ITERS="${AZ_ITERS:-24}"
AZ_HORIZON="${AZ_HORIZON:-16}"
AZ_VALUEW="${AZ_VALUEW:-1}"
AZ_SAMPLE="${AZ_SAMPLE:-1}"
AZ_TEMP="${AZ_TEMP:-1}"
AZ_CONTROL="${AZ_CONTROL:-full}"
AZ_FULL_SELECTION="${AZ_FULL_SELECTION:-value}"
AZ_FULL_LOOKAHEAD_DEPTH="${AZ_FULL_LOOKAHEAD_DEPTH:-2}"
AZ_FULL_LOOKAHEAD_BEAM="${AZ_FULL_LOOKAHEAD_BEAM:-8}"
AZ_FULL_LOOKAHEAD_ROOT_BEAM="${AZ_FULL_LOOKAHEAD_ROOT_BEAM:-24}"
AZ_FULL_TARGET_TEMP="${AZ_FULL_TARGET_TEMP:-0.25}"
PURE_FORBID_TYPES="${PURE_FORBID_TYPES:-initiatePvp}"
PURE_MAX_STATUS_LEVEL="${PURE_MAX_STATUS_LEVEL:-0}"
FARM_NAV_ORACLE="${FARM_NAV_ORACLE:-force}"
FARM_NAV_THRESHOLD="${FARM_NAV_THRESHOLD:-0.5}"

EPOCHS="${EPOCHS:-4}"
BATCH="${BATCH:-256}"
LR="${LR:-0.00002}"
VALUE_COEF="${VALUE_COEF:-0.25}"
FARM_VALUE_COEF="${FARM_VALUE_COEF:-0.25}"
REWARD_PICK_COEF="${REWARD_PICK_COEF:-0.25}"
ARC_HIDDEN="${ARC_HIDDEN:-256,256}"
ARC_VALUE_HIDDEN="${ARC_VALUE_HIDDEN:-128}"

set +e
ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" \
  REMOTE_DIR="$REMOTE_DIR" \
  RUN_ID="$RUN_ID" \
  GPU="$GPU" \
  INIT_WEIGHTS="$INIT_WEIGHTS" \
  CLEAN_GAMES="$CLEAN_GAMES" \
  AZ_GAMES="$AZ_GAMES" \
  AZ_ITERS="$AZ_ITERS" \
  AZ_HORIZON="$AZ_HORIZON" \
  AZ_VALUEW="$AZ_VALUEW" \
  AZ_SAMPLE="$AZ_SAMPLE" \
  AZ_TEMP="$AZ_TEMP" \
  AZ_CONTROL="$AZ_CONTROL" \
  AZ_FULL_SELECTION="$AZ_FULL_SELECTION" \
  AZ_FULL_LOOKAHEAD_DEPTH="$AZ_FULL_LOOKAHEAD_DEPTH" \
  AZ_FULL_LOOKAHEAD_BEAM="$AZ_FULL_LOOKAHEAD_BEAM" \
  AZ_FULL_LOOKAHEAD_ROOT_BEAM="$AZ_FULL_LOOKAHEAD_ROOT_BEAM" \
  AZ_FULL_TARGET_TEMP="$AZ_FULL_TARGET_TEMP" \
  PURE_FORBID_TYPES="$PURE_FORBID_TYPES" \
  PURE_MAX_STATUS_LEVEL="$PURE_MAX_STATUS_LEVEL" \
  FARM_NAV_ORACLE="$FARM_NAV_ORACLE" \
  FARM_NAV_THRESHOLD="$FARM_NAV_THRESHOLD" \
  EPOCHS="$EPOCHS" \
  BATCH="$BATCH" \
  LR="$LR" \
  VALUE_COEF="$VALUE_COEF" \
  FARM_VALUE_COEF="$FARM_VALUE_COEF" \
  REWARD_PICK_COEF="$REWARD_PICK_COEF" \
  ARC_HIDDEN="$ARC_HIDDEN" \
  ARC_VALUE_HIDDEN="$ARC_VALUE_HIDDEN" \
  bash -s <<'REMOTE'
set -euo pipefail

cd "$REMOTE_DIR"
if test -s "$HOME/.nvm/nvm.sh"; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null
fi

if [ -x "${PYTHON:-}" ]; then
  PY="$PYTHON"
elif [ -x "ml/.venv/bin/python" ]; then
  PY="ml/.venv/bin/python"
else
  PY="${PYTHON:-python3}"
fi

RUN_DIR="ml/meta_runs/$RUN_ID"
DATA="$RUN_DIR/data"
LOGS="$RUN_DIR/logs"
WEIGHTS="$RUN_DIR/weights/policy.json"
mkdir -p "$DATA" "$LOGS" "$(dirname "$WEIGHTS")"
rm -f "$DATA"/*.jsonl "$DATA"/*.json

cp "$INIT_WEIGHTS" "$WEIGHTS"

cat > "$RUN_DIR/config.json" <<JSON
{
  "run_id": "$RUN_ID",
  "mode": "pure-economy-mixed-lane",
  "init_weights": "$INIT_WEIGHTS",
  "gpu": "$GPU",
  "clean_games": $CLEAN_GAMES,
  "az_games": $AZ_GAMES,
  "az_iters": $AZ_ITERS,
  "az_horizon": $AZ_HORIZON,
  "az_control": "$AZ_CONTROL",
  "az_full_selection": "$AZ_FULL_SELECTION",
  "pure_forbid_types": "$PURE_FORBID_TYPES",
  "pure_max_status_level": "$PURE_MAX_STATUS_LEVEL",
  "farm_nav_oracle": "$FARM_NAV_ORACLE",
  "farm_nav_threshold": $FARM_NAV_THRESHOLD,
  "epochs": $EPOCHS,
  "batch": $BATCH,
  "lr": $LR,
  "value_coef": $VALUE_COEF,
  "farm_value_coef": $FARM_VALUE_COEF,
  "reward_pick_coef": $REWARD_PICK_COEF,
  "hidden": "$ARC_HIDDEN",
  "value_hidden": "$ARC_VALUE_HIDDEN"
}
JSON

echo "== arc pure/economy mixed lane =="
echo "workspace=$PWD"
echo "run_id=$RUN_ID"
echo "init_weights=$INIT_WEIGHTS"
echo "weights=$WEIGHTS"
echo "data=$DATA"
echo "gpu=$GPU"

CLEANFARMCURRICULUM=1 \
  CLEANFARMCURRICULUM_GAMES="$CLEAN_GAMES" \
  CLEANFARMCURRICULUM_SEATS=4 \
  CLEANFARMCURRICULUM_PROFILES=paragon,farmer,farmer2,hard \
  CLEANFARMCURRICULUM_DATA_DIR="$DATA" \
  CLEANFARMCURRICULUM_OUT="$DATA/cleanfarm_curriculum.jsonl" \
  CLEANFARMCURRICULUM_SUMMARY="$RUN_DIR/cleanfarm_curriculum_summary.json" \
  npx vitest run src/lib/play/ml/_cleanfarmcurriculum.test.ts --disable-console-intercept 2>&1 | tee "$LOGS/cleanfarm_curriculum.log"

AZ=1 \
  AZ_PLANNER_SEATS=all \
  AZ_GAMES="$AZ_GAMES" \
  AZ_ITERS="$AZ_ITERS" \
  AZ_HORIZON="$AZ_HORIZON" \
  AZ_VALUEW="$AZ_VALUEW" \
  AZ_SEATS=4 \
  AZ_SAMPLE="$AZ_SAMPLE" \
  AZ_TEMP="$AZ_TEMP" \
  AZ_CONTROL="$AZ_CONTROL" \
  AZ_FULL_SELECTION="$AZ_FULL_SELECTION" \
  AZ_FULL_LOOKAHEAD_DEPTH="$AZ_FULL_LOOKAHEAD_DEPTH" \
  AZ_FULL_LOOKAHEAD_BEAM="$AZ_FULL_LOOKAHEAD_BEAM" \
  AZ_FULL_LOOKAHEAD_ROOT_BEAM="$AZ_FULL_LOOKAHEAD_ROOT_BEAM" \
  AZ_FULL_TARGET_TEMP="$AZ_FULL_TARGET_TEMP" \
  AZ_FORBID_TYPES="$PURE_FORBID_TYPES" \
  AZ_MAX_STATUS_LEVEL="$PURE_MAX_STATUS_LEVEL" \
  AZ_FARM_NAV_ORACLE="$FARM_NAV_ORACLE" \
  AZ_FARM_NAV_THRESHOLD="$FARM_NAV_THRESHOLD" \
  AZ_WEIGHTS="$WEIGHTS" \
  AZ_OUT="$DATA/pure_az.jsonl" \
  ML_META_PATH="$RUN_DIR/pure_az_meta.json" \
  npx vitest run src/lib/play/ml/_azgen.test.ts --disable-console-intercept 2>&1 | tee "$LOGS/pure_azgen.log"

clean_samples=$(wc -l < "$DATA/cleanfarm_curriculum.jsonl" | awk '{ print $1 + 0 }')
az_samples=$(wc -l < "$DATA/pure_az.jsonl" | awk '{ print $1 + 0 }')
total_samples=$((clean_samples + az_samples))
cat > "$DATA/meta.json" <<JSON
{
  "obs_dim": 62,
  "act_dim": 52,
  "samples": $total_samples,
  "mode": "pure-economy-mixed-lane",
  "cleanFarmCurriculumSamples": $clean_samples,
  "pureAzSamples": $az_samples,
  "auxTargets": ["farmValue", "rewardPi"],
  "forbidTypes": "$PURE_FORBID_TYPES",
  "maxStatusLevel": "$PURE_MAX_STATUS_LEVEL",
  "farmNavOracle": "$FARM_NAV_ORACLE"
}
JSON

echo "[pure-econ] train samples=$total_samples clean=$clean_samples pure_az=$az_samples"
CUDA_VISIBLE_DEVICES="$GPU" \
  ARC_HIDDEN="$ARC_HIDDEN" \
  ARC_VALUE_HIDDEN="$ARC_VALUE_HIDDEN" \
  "$PY" ml/train.py \
    --data "$DATA" \
    --out "$WEIGHTS" \
    --mode alphazero \
    --epochs "$EPOCHS" \
    --batch-size "$BATCH" \
    --lr "$LR" \
    --value-coef "$VALUE_COEF" \
    --farm-value-coef "$FARM_VALUE_COEF" \
    --reward-pick-coef "$REWARD_PICK_COEF" 2>&1 | tee "$LOGS/train.log"

cp "$WEIGHTS" "$RUN_DIR/best_policy.json"
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
const run = process.env.RUN_ID;
const weights = JSON.parse(readFileSync(`ml/meta_runs/${run}/weights/policy.json`, 'utf8'));
console.log(JSON.stringify({
  run_id: run,
  weights: `ml/meta_runs/${run}/weights/policy.json`,
  obs_dim: weights.obs_dim,
  act_dim: weights.act_dim,
  trunk_hidden: weights.trunk_hidden,
  value_hidden: weights.value_hidden,
  has_farm_value: Boolean(weights.farm_value),
  has_reward_pick: Boolean(weights.reward_pick),
  params: weights.params
}, null, 2));
NODE

echo "DONE: $RUN_DIR"
REMOTE
status=$?
set -e

LOCAL_OUT_DIR="ml/meta_runs/$RUN_ID"
mkdir -p "$LOCAL_OUT_DIR"
rsync_status=0
rsync -az "$HOST:$REMOTE_DIR/ml/meta_runs/$RUN_ID/" "$LOCAL_OUT_DIR/" || rsync_status=$?
echo "$LOCAL_OUT_DIR"
if [[ "$status" -ne 0 ]]; then
  exit "$status"
fi
exit "$rsync_status"
