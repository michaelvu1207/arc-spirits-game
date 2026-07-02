#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST="${ARC_BOT_GPU_HOST:-ubuntu@216.151.21.122}"
REMOTE_DIR="${ARC_BOT_REMOTE_DIR:-/data/share8/michaelvuaprilexperimentation/arc-bot}"
RUN_ID="${RUN_ID:-target-quality-patch-lane-$(date -u +%Y%m%dT%H%M%SZ)}"
TRACE_RUN_ID="${TRACE_RUN_ID:-${RUN_ID}-traceq}"
OUT_DIR="ml/meta_runs/$RUN_ID"

GPU="${GPU:-4}"
MIN_FREE_MB="${MIN_FREE_MB:-4096}"

TRACE_GAMES="${TRACE_GAMES:-8}"
TRACE_MAX_WINDOWS="${TRACE_MAX_WINDOWS:-32}"
TRACE_ITERS="${TRACE_ITERS:-32}"
TRACE_PLANNER_HORIZON="${TRACE_PLANNER_HORIZON:-16}"
TRACE_SOURCE_DESTINATION="${TRACE_SOURCE_DESTINATION:-all}"
TRACE_MIN_TRAIN_SAMPLES="${TRACE_MIN_TRAIN_SAMPLES:-12}"
TRACE_TRAIN_EPOCHS="${TRACE_TRAIN_EPOCHS:-16}"
TRACE_TRAIN_BATCH="${TRACE_TRAIN_BATCH:-64}"
SKIP_TRACE="${SKIP_TRACE:-0}"

EVAL_GAMES="${EVAL_GAMES:-8}"
EVAL_ITERS="${EVAL_ITERS:-48}"
EVAL_HORIZON="${EVAL_HORIZON:-24}"
EVAL_PROGRESS_EVERY="${EVAL_PROGRESS_EVERY:-2}"
TIMEOUT="${TIMEOUT:-90m}"
EXPOSURE_GATE_MIN_VP="${EXPOSURE_GATE_MIN_VP:-18}"
EXPOSURE_GATE_MAX_VP="${EXPOSURE_GATE_MAX_VP:-28}"
EXPOSURE_GATE_MIN_ROUND="${EXPOSURE_GATE_MIN_ROUND:-6}"
EXPOSURE_GATE_MIN_MONSTER_HP="${EXPOSURE_GATE_MIN_MONSTER_HP:-4}"
EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP="${EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP:-}"
EXPOSURE_GATE_MAX_REMAINING_FARM_VP="${EXPOSURE_GATE_MAX_REMAINING_FARM_VP:-}"
EXPOSURE_GATE_PRESERVE_FARM_REWARD_VP="${EXPOSURE_GATE_PRESERVE_FARM_REWARD_VP:-}"
EXPOSURE_GATE_PRESERVE_FARM_UNTIL_VP="${EXPOSURE_GATE_PRESERVE_FARM_UNTIL_VP:-}"

TARGET_WEIGHTS="${TARGET_WEIGHTS:-ml/meta_runs/scorefloor-carry-successlane-20260701Tremote/resilient_goodbuilder_policy.json}"
TARGET_NAV_WEIGHTS="${TARGET_NAV_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/nav_build_policy.json}"
TARGET_NAV_GATE="${TARGET_NAV_GATE:-good-nonfallen-score-floor}"
TARGET_PATCH_NAV_GATE="${TARGET_PATCH_NAV_GATE:-good-target-exposure}"
TARGET_MICRO_WEIGHTS="${TARGET_MICRO_WEIGHTS:-ml/meta_runs/nonfallen-hp4-conversion-scorefloor-cashrestore-20260701Tremote/nonfallen_hp4_conversion_policy.json}"
TARGET_MICRO_GATE="${TARGET_MICRO_GATE:-good-builder-hp4-conversion-overlay}"
TARGET_STATUS_CAP="${TARGET_STATUS_CAP:-2}"
TARGET_FORBID_TYPES="${TARGET_FORBID_TYPES:-initiatePvp}"

SUPPORT_A_WEIGHTS="${SUPPORT_A_WEIGHTS:-ml/meta_runs/allseat-goodbuilder-medium-20260630Tgoal/allseat_goodbuilder_policy.json}"
SUPPORT_B_WEIGHTS="${SUPPORT_B_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/best_policy.full.json}"
SUPPORT_NAV_WEIGHTS="${SUPPORT_NAV_WEIGHTS:-$TARGET_NAV_WEIGHTS}"
SUPPORT_NAV_GATE="${SUPPORT_NAV_GATE:-good-builder-noncontest-support-oracle}"

HUNTER_WEIGHTS="${HUNTER_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/best_policy.full.json}"
HUNTER_PATCH_WEIGHTS="${HUNTER_PATCH_WEIGHTS:-ml/meta_runs/pvp-route-mode-20260630T124558Z/pvp_route_mode_head_policy.json}"
HUNTER_MICRO_WEIGHTS="${HUNTER_MICRO_WEIGHTS:-$HUNTER_PATCH_WEIGHTS}"
HUNTER_PATCH_GATE="${HUNTER_PATCH_GATE:-pvp-predictive-mode-hunt-fallback-rebuild-pivot}"
HUNTER_MICRO_GATE="${HUNTER_MICRO_GATE:-pvp-pivot-encounter-force}"
HUNTER_PVP_ORACLE="${HUNTER_PVP_ORACLE:-status2-conversion-descend}"
HUNTER_ROLE_NAME="${HUNTER_ROLE_NAME:-status2-conversion-descend-hunter}"
HUNTER_REBUILD_MIN_ROUND="${HUNTER_REBUILD_MIN_ROUND:-14}"
HUNTER_REBUILD_SKIP_TARGET_VP="${HUNTER_REBUILD_SKIP_TARGET_VP:-12}"
HUNTER_GOOD_TARGET_PIVOT_MIN_TARGET_VP="${HUNTER_GOOD_TARGET_PIVOT_MIN_TARGET_VP:-12}"
HUNTER_STATUS2_DESCEND_MIN_TARGET_VP="${HUNTER_STATUS2_DESCEND_MIN_TARGET_VP:-9}"
HUNTER_FORCE_HIGH_VALUE_TARGET_VP="${HUNTER_FORCE_HIGH_VALUE_TARGET_VP:-18}"
HUNTER_LOW_TAIL_HUNT_MAX_VP="${HUNTER_LOW_TAIL_HUNT_MAX_VP:-}"
HUNTER_LOW_TAIL_HUNT_MIN_ROUND="${HUNTER_LOW_TAIL_HUNT_MIN_ROUND:-}"
HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP="${HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP:-}"
HUNTER_LOW_TAIL_HUNT_MIN_TARGET_VP="${HUNTER_LOW_TAIL_HUNT_MIN_TARGET_VP:-}"
MIXED_FIELD_MODE="${MIXED_FIELD_MODE:-candidate-support}"

mkdir -p "$OUT_DIR"

echo "== target-quality patch lane =="
echo "run_id=$RUN_ID trace_run_id=$TRACE_RUN_ID gpu=$GPU"
echo "trace_games=$TRACE_GAMES trace_windows=$TRACE_MAX_WINDOWS source_destination=$TRACE_SOURCE_DESTINATION min_train_samples=$TRACE_MIN_TRAIN_SAMPLES"
echo "eval_games=$EVAL_GAMES eval_iters=$EVAL_ITERS target_patch_gate=$TARGET_PATCH_NAV_GATE exposure_gate_min_vp=$EXPOSURE_GATE_MIN_VP max_farm_ev=${EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP:-off} mixed_field_mode=$MIXED_FIELD_MODE"
echo "hunter_micro_gate=$HUNTER_MICRO_GATE hunter_oracle=$HUNTER_PVP_ORACLE hunter_min_target_vp=$HUNTER_GOOD_TARGET_PIVOT_MIN_TARGET_VP hunter_status2_min_target_vp=$HUNTER_STATUS2_DESCEND_MIN_TARGET_VP"
echo "hunter_low_tail_max_vp=${HUNTER_LOW_TAIL_HUNT_MAX_VP:-off} hunter_low_tail_min_round=${HUNTER_LOW_TAIL_HUNT_MIN_ROUND:-default} hunter_low_tail_min_monster_hp=${HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP:-default}"

if [[ "$SKIP_TRACE" != "1" ]]; then
  RUN_ID="$TRACE_RUN_ID" \
  GPU="$GPU" \
  MIN_FREE_MB="$MIN_FREE_MB" \
  GAMES="$TRACE_GAMES" \
  MAX_WINDOWS="$TRACE_MAX_WINDOWS" \
  ITERS="$TRACE_ITERS" \
  PLANNER_HORIZON="$TRACE_PLANNER_HORIZON" \
  SOURCE_DESTINATION="$TRACE_SOURCE_DESTINATION" \
  TRAIN=1 \
  MIN_TRAIN_SAMPLES="$TRACE_MIN_TRAIN_SAMPLES" \
  TRAIN_INIT_WEIGHTS="$TARGET_NAV_WEIGHTS" \
  TRAIN_EPOCHS="$TRACE_TRAIN_EPOCHS" \
  TRAIN_BATCH="$TRACE_TRAIN_BATCH" \
  npm run bot:target-quality-traceq
else
  echo "skip_trace=1 using existing trace run $TRACE_RUN_ID"
fi

TRAINED_NAV="ml/meta_runs/$TRACE_RUN_ID/best_policy.json"
if [[ ! -s "$TRAINED_NAV" ]]; then
  echo "target-quality patch training did not produce $TRAINED_NAV" >&2
  exit 2
fi

npm run bot:gpu:sync

REMOTE_OUT_DIR="ml/meta_runs/$RUN_ID"
ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" \
  REMOTE_DIR="$REMOTE_DIR" \
  RUN_ID="$RUN_ID" \
  TRACE_RUN_ID="$TRACE_RUN_ID" \
  GPU="$GPU" \
  MIN_FREE_MB="$MIN_FREE_MB" \
  TIMEOUT="$TIMEOUT" \
  EVAL_GAMES="$EVAL_GAMES" \
  EVAL_ITERS="$EVAL_ITERS" \
  EVAL_HORIZON="$EVAL_HORIZON" \
  EVAL_PROGRESS_EVERY="$EVAL_PROGRESS_EVERY" \
  EXPOSURE_GATE_MIN_VP="$EXPOSURE_GATE_MIN_VP" \
  EXPOSURE_GATE_MAX_VP="$EXPOSURE_GATE_MAX_VP" \
  EXPOSURE_GATE_MIN_ROUND="$EXPOSURE_GATE_MIN_ROUND" \
  EXPOSURE_GATE_MIN_MONSTER_HP="$EXPOSURE_GATE_MIN_MONSTER_HP" \
  EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP="$EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP" \
  EXPOSURE_GATE_MAX_REMAINING_FARM_VP="$EXPOSURE_GATE_MAX_REMAINING_FARM_VP" \
  EXPOSURE_GATE_PRESERVE_FARM_REWARD_VP="$EXPOSURE_GATE_PRESERVE_FARM_REWARD_VP" \
  EXPOSURE_GATE_PRESERVE_FARM_UNTIL_VP="$EXPOSURE_GATE_PRESERVE_FARM_UNTIL_VP" \
  TARGET_WEIGHTS="$TARGET_WEIGHTS" \
  TARGET_NAV_WEIGHTS="$TARGET_NAV_WEIGHTS" \
  TARGET_NAV_GATE="$TARGET_NAV_GATE" \
  TARGET_PATCH_NAV_WEIGHTS="$TRAINED_NAV" \
  TARGET_PATCH_NAV_GATE="$TARGET_PATCH_NAV_GATE" \
  TARGET_MICRO_WEIGHTS="$TARGET_MICRO_WEIGHTS" \
  TARGET_MICRO_GATE="$TARGET_MICRO_GATE" \
  TARGET_STATUS_CAP="$TARGET_STATUS_CAP" \
  TARGET_FORBID_TYPES="$TARGET_FORBID_TYPES" \
  SUPPORT_A_WEIGHTS="$SUPPORT_A_WEIGHTS" \
  SUPPORT_B_WEIGHTS="$SUPPORT_B_WEIGHTS" \
  SUPPORT_NAV_WEIGHTS="$SUPPORT_NAV_WEIGHTS" \
  SUPPORT_NAV_GATE="$SUPPORT_NAV_GATE" \
  HUNTER_WEIGHTS="$HUNTER_WEIGHTS" \
  HUNTER_PATCH_WEIGHTS="$HUNTER_PATCH_WEIGHTS" \
  HUNTER_MICRO_WEIGHTS="$HUNTER_MICRO_WEIGHTS" \
  HUNTER_PATCH_GATE="$HUNTER_PATCH_GATE" \
  HUNTER_MICRO_GATE="$HUNTER_MICRO_GATE" \
  HUNTER_PVP_ORACLE="$HUNTER_PVP_ORACLE" \
  HUNTER_ROLE_NAME="$HUNTER_ROLE_NAME" \
  HUNTER_REBUILD_MIN_ROUND="$HUNTER_REBUILD_MIN_ROUND" \
  HUNTER_REBUILD_SKIP_TARGET_VP="$HUNTER_REBUILD_SKIP_TARGET_VP" \
  HUNTER_GOOD_TARGET_PIVOT_MIN_TARGET_VP="$HUNTER_GOOD_TARGET_PIVOT_MIN_TARGET_VP" \
  HUNTER_STATUS2_DESCEND_MIN_TARGET_VP="$HUNTER_STATUS2_DESCEND_MIN_TARGET_VP" \
  HUNTER_FORCE_HIGH_VALUE_TARGET_VP="$HUNTER_FORCE_HIGH_VALUE_TARGET_VP" \
  HUNTER_LOW_TAIL_HUNT_MAX_VP="$HUNTER_LOW_TAIL_HUNT_MAX_VP" \
  HUNTER_LOW_TAIL_HUNT_MIN_ROUND="$HUNTER_LOW_TAIL_HUNT_MIN_ROUND" \
  HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP="$HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP" \
  HUNTER_LOW_TAIL_HUNT_MIN_TARGET_VP="$HUNTER_LOW_TAIL_HUNT_MIN_TARGET_VP" \
  MIXED_FIELD_MODE="$MIXED_FIELD_MODE" \
  bash -s <<'REMOTE'
set -euo pipefail

cd "$REMOTE_DIR"
if test -s "$HOME/.nvm/nvm.sh"; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null
fi

if command -v nvidia-smi >/dev/null 2>&1; then
  free_mb="$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  used_mb="$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  echo "gpu=$GPU free_mb=${free_mb:-unknown} used_mb=${used_mb:-unknown} min_free_mb=$MIN_FREE_MB"
  if [[ -n "${free_mb:-}" && "$free_mb" -lt "$MIN_FREE_MB" ]]; then
    echo "refusing target-quality patch eval: GPU $GPU has ${free_mb}MB free, below MIN_FREE_MB=$MIN_FREE_MB" >&2
    exit 3
  fi
fi

OUT_DIR="ml/meta_runs/$RUN_ID"
LOG_DIR="$OUT_DIR/logs"
BASELINE_TARGET_STACK="$OUT_DIR/baseline_target_stack.json"
CANDIDATE_TARGET_STACK="$OUT_DIR/candidate_target_stack.json"
CANDIDATE_MIXED_STACK="$OUT_DIR/candidate_mixed_stack.json"
mkdir -p "$OUT_DIR" "$LOG_DIR"

cat > "$OUT_DIR/config.json" <<JSON
{
  "run_id": "$RUN_ID",
  "trace_run_id": "$TRACE_RUN_ID",
  "gpu": "$GPU",
  "target_weights": "$TARGET_WEIGHTS",
  "target_nav_weights": "$TARGET_NAV_WEIGHTS",
  "target_nav_gate": "$TARGET_NAV_GATE",
  "target_patch_nav_weights": "$TARGET_PATCH_NAV_WEIGHTS",
  "target_patch_nav_gate": "$TARGET_PATCH_NAV_GATE",
  "exposure_gate_min_vp": $EXPOSURE_GATE_MIN_VP,
  "exposure_gate_max_vp": $EXPOSURE_GATE_MAX_VP,
  "exposure_gate_min_round": $EXPOSURE_GATE_MIN_ROUND,
  "exposure_gate_min_monster_hp": $EXPOSURE_GATE_MIN_MONSTER_HP,
  "exposure_gate_max_farm_opportunity_vp": "$EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP",
  "exposure_gate_max_remaining_farm_vp": "$EXPOSURE_GATE_MAX_REMAINING_FARM_VP",
  "exposure_gate_preserve_farm_reward_vp": "$EXPOSURE_GATE_PRESERVE_FARM_REWARD_VP",
  "exposure_gate_preserve_farm_until_vp": "$EXPOSURE_GATE_PRESERVE_FARM_UNTIL_VP",
  "target_micro_weights": "$TARGET_MICRO_WEIGHTS",
  "target_micro_gate": "$TARGET_MICRO_GATE",
  "mixed_field_mode": "$MIXED_FIELD_MODE",
  "hunter_patch_gate": "$HUNTER_PATCH_GATE",
  "hunter_micro_gate": "$HUNTER_MICRO_GATE",
  "hunter_pvp_oracle": "$HUNTER_PVP_ORACLE",
  "hunter_rebuild_min_round": $HUNTER_REBUILD_MIN_ROUND,
  "hunter_rebuild_skip_target_vp": $HUNTER_REBUILD_SKIP_TARGET_VP,
  "hunter_good_target_pivot_min_target_vp": $HUNTER_GOOD_TARGET_PIVOT_MIN_TARGET_VP,
  "hunter_status2_descend_min_target_vp": $HUNTER_STATUS2_DESCEND_MIN_TARGET_VP,
  "hunter_force_high_value_target_vp": $HUNTER_FORCE_HIGH_VALUE_TARGET_VP,
  "hunter_low_tail_hunt_max_vp": "$HUNTER_LOW_TAIL_HUNT_MAX_VP",
  "hunter_low_tail_hunt_min_round": "$HUNTER_LOW_TAIL_HUNT_MIN_ROUND",
  "hunter_low_tail_hunt_min_monster_hp": "$HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP",
  "hunter_low_tail_hunt_min_target_vp": "$HUNTER_LOW_TAIL_HUNT_MIN_TARGET_VP",
  "eval_games": $EVAL_GAMES,
  "eval_iters": $EVAL_ITERS,
  "eval_horizon": $EVAL_HORIZON
}
JSON

node --input-type=module - "$BASELINE_TARGET_STACK" "$CANDIDATE_TARGET_STACK" "$CANDIDATE_MIXED_STACK" <<'NODE'
import { writeFileSync } from 'node:fs';

const [baselineOut, candidateOut, mixedOut] = process.argv.slice(2);
const forbidTypes = process.env.TARGET_FORBID_TYPES.split(',').map((s) => s.trim()).filter(Boolean);
const targetBase = {
  weights: process.env.TARGET_WEIGHTS,
  navWeights: process.env.TARGET_NAV_WEIGHTS,
  navigationPolicyGate: process.env.TARGET_NAV_GATE,
  microWeights: process.env.TARGET_MICRO_WEIGHTS,
  microPolicyGate: process.env.TARGET_MICRO_GATE,
  maxStatusLevel: Number(process.env.TARGET_STATUS_CAP),
  forbidTypes,
  preserveRouteFirepower: true,
  preserveRouteSurvival: true,
  goodTargetActionDiscipline: true
};
const candidate = {
  name: 'target-quality-navpatch-carry',
  ...targetBase,
  patchNavWeights: process.env.TARGET_PATCH_NAV_WEIGHTS,
  patchNavigationPolicyGate: process.env.TARGET_PATCH_NAV_GATE
};
const candidateB = {
  ...candidate,
  name: 'target-quality-navpatch-carry-b'
};
const baseline = {
  name: 'scorefloor-hp4-carry-baseline',
  ...targetBase
};
const baselineB = {
  ...baseline,
  name: 'scorefloor-hp4-carry-baseline-b'
};
const support = (name, weights) => ({
  name,
  weights,
  navWeights: process.env.SUPPORT_NAV_WEIGHTS,
  navigationPolicyGate: process.env.SUPPORT_NAV_GATE,
  maxStatusLevel: Number(process.env.TARGET_STATUS_CAP),
  forbidTypes,
  preserveRouteFirepower: true,
  preserveRouteSurvival: true,
  goodTargetActionDiscipline: true
});
const supportA = support('nonfallen-noncontest-support-a', process.env.SUPPORT_A_WEIGHTS);
const supportB = support('nonfallen-noncontest-support-b', process.env.SUPPORT_B_WEIGHTS);
const hunterBase = {
  weights: process.env.HUNTER_WEIGHTS,
  patchNavWeights: process.env.HUNTER_PATCH_WEIGHTS,
  patchNavigationPolicyGate: process.env.HUNTER_PATCH_GATE,
  microWeights: process.env.HUNTER_MICRO_WEIGHTS,
  microPolicyGate: process.env.HUNTER_MICRO_GATE
};
const currentHunter = { name: 'current-champion-hunter', ...hunterBase };
const conversionHunter = {
  name: process.env.HUNTER_ROLE_NAME,
  ...hunterBase,
  pvpPivotOracle: process.env.HUNTER_PVP_ORACLE
};
const mixedMode = process.env.MIXED_FIELD_MODE ?? 'candidate-support';
const mixedStack =
  mixedMode === 'candidate-support'
    ? [currentHunter, conversionHunter, candidate, supportA]
    : mixedMode === 'candidate-baseline-carry'
      ? [currentHunter, conversionHunter, candidate, baselineB]
      : mixedMode === 'candidate-clone-carry'
        ? [currentHunter, conversionHunter, candidate, candidateB]
        : mixedMode === 'single-hunter-baseline-carry'
          ? [candidate, baselineB, supportA]
          : mixedMode === 'single-hunter-clone-carry'
            ? [candidate, candidateB, supportA]
        : (() => {
            throw new Error(`Unknown MIXED_FIELD_MODE=${mixedMode}`);
          })();
writeFileSync(baselineOut, JSON.stringify([baseline, supportA, supportB], null, 2) + '\n');
writeFileSync(candidateOut, JSON.stringify([candidate, supportA, supportB], null, 2) + '\n');
writeFileSync(mixedOut, JSON.stringify(mixedStack, null, 2) + '\n');
NODE

run_target_eval() {
  local label="$1"
  local patch_weight="$2"
  local stack="$3"
  local out="$OUT_DIR/${label}.json"
  echo "== target eval: $label =="
  timeout "$TIMEOUT" env \
    CUDA_VISIBLE_DEVICES="$GPU" \
    ARC_GOOD_TARGET_EXPOSURE_GATE_MIN_VP="$EXPOSURE_GATE_MIN_VP" \
    ARC_GOOD_TARGET_EXPOSURE_GATE_MAX_VP="$EXPOSURE_GATE_MAX_VP" \
    ARC_GOOD_TARGET_EXPOSURE_GATE_MIN_ROUND="$EXPOSURE_GATE_MIN_ROUND" \
    ARC_GOOD_TARGET_EXPOSURE_GATE_MIN_MONSTER_HP="$EXPOSURE_GATE_MIN_MONSTER_HP" \
    ARC_GOOD_TARGET_EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP="$EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP" \
    ARC_GOOD_TARGET_EXPOSURE_GATE_MAX_REMAINING_FARM_VP="$EXPOSURE_GATE_MAX_REMAINING_FARM_VP" \
    ARC_GOOD_TARGET_EXPOSURE_GATE_PRESERVE_FARM_REWARD_VP="$EXPOSURE_GATE_PRESERVE_FARM_REWARD_VP" \
    ARC_GOOD_TARGET_EXPOSURE_GATE_PRESERVE_FARM_UNTIL_VP="$EXPOSURE_GATE_PRESERVE_FARM_UNTIL_VP" \
    AZEVAL=1 \
    AZEVAL_GAMES="$EVAL_GAMES" \
    AZEVAL_ITERS="$EVAL_ITERS" \
    AZEVAL_HORIZON="$EVAL_HORIZON" \
    AZEVAL_PROGRESS_EVERY="$EVAL_PROGRESS_EVERY" \
    AZEVAL_CONTROL=full \
    AZEVAL_FULL_SELECTION=value \
    AZEVAL_VALUEW=1 \
    AZEVAL_WEIGHTS="$TARGET_WEIGHTS" \
    AZEVAL_NAV_WEIGHTS="$TARGET_NAV_WEIGHTS" \
    AZEVAL_NAV_GATE="$TARGET_NAV_GATE" \
    AZEVAL_PATCH_NAV_WEIGHTS="$patch_weight" \
    AZEVAL_PATCH_NAV_GATE="$TARGET_PATCH_NAV_GATE" \
    AZEVAL_MICRO_WEIGHTS="$TARGET_MICRO_WEIGHTS" \
    AZEVAL_MICRO_GATE="$TARGET_MICRO_GATE" \
    AZEVAL_MAX_STATUS_LEVEL="$TARGET_STATUS_CAP" \
    AZEVAL_FORBID_TYPES="$TARGET_FORBID_TYPES" \
    AZEVAL_HARD_CONSTRAINTS=1 \
    AZEVAL_PRESERVE_ROUTE_FIREPOWER=1 \
    AZEVAL_PRESERVE_ROUTE_SURVIVAL=1 \
    AZEVAL_GOOD_TARGET_ACTION_DISCIPLINE=1 \
    AZEVAL_PLANNER_ROLE_NAME="$label" \
    AZEVAL_NEURAL_FIELD=1 \
    AZEVAL_NEURAL_FIELD_STACKS_FILE="$stack" \
    AZEVAL_OUT="$out" \
    npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
    2>&1 | tee "$LOG_DIR/${label}.log"
}

run_hunter_eval() {
  local label="$1"
  local stack="$2"
  local out="$OUT_DIR/${label}.json"
  echo "== hunter eval: $label =="
  timeout "$TIMEOUT" env \
    CUDA_VISIBLE_DEVICES="$GPU" \
    ARC_PVP_REBUILD_MIN_ROUND="$HUNTER_REBUILD_MIN_ROUND" \
    ARC_PVP_REBUILD_SKIP_TARGET_VP="$HUNTER_REBUILD_SKIP_TARGET_VP" \
	    ARC_PVP_GOOD_TARGET_PIVOT_MIN_TARGET_VP="$HUNTER_GOOD_TARGET_PIVOT_MIN_TARGET_VP" \
	    ARC_PVP_STATUS2_DESCEND_MIN_TARGET_VP="$HUNTER_STATUS2_DESCEND_MIN_TARGET_VP" \
	    ARC_PVP_FORCE_HIGH_VALUE_TARGET_VP="$HUNTER_FORCE_HIGH_VALUE_TARGET_VP" \
	    ARC_PVP_LOW_TAIL_HUNT_MAX_VP="$HUNTER_LOW_TAIL_HUNT_MAX_VP" \
	    ARC_PVP_LOW_TAIL_HUNT_MIN_ROUND="$HUNTER_LOW_TAIL_HUNT_MIN_ROUND" \
	    ARC_PVP_LOW_TAIL_HUNT_MIN_MONSTER_HP="$HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP" \
	    ARC_PVP_LOW_TAIL_HUNT_MIN_TARGET_VP="$HUNTER_LOW_TAIL_HUNT_MIN_TARGET_VP" \
	    ARC_GOOD_TARGET_EXPOSURE_GATE_MIN_VP="$EXPOSURE_GATE_MIN_VP" \
	    ARC_GOOD_TARGET_EXPOSURE_GATE_MAX_VP="$EXPOSURE_GATE_MAX_VP" \
	    ARC_GOOD_TARGET_EXPOSURE_GATE_MIN_ROUND="$EXPOSURE_GATE_MIN_ROUND" \
    ARC_GOOD_TARGET_EXPOSURE_GATE_MIN_MONSTER_HP="$EXPOSURE_GATE_MIN_MONSTER_HP" \
    ARC_GOOD_TARGET_EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP="$EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP" \
    ARC_GOOD_TARGET_EXPOSURE_GATE_MAX_REMAINING_FARM_VP="$EXPOSURE_GATE_MAX_REMAINING_FARM_VP" \
    ARC_GOOD_TARGET_EXPOSURE_GATE_PRESERVE_FARM_REWARD_VP="$EXPOSURE_GATE_PRESERVE_FARM_REWARD_VP" \
    ARC_GOOD_TARGET_EXPOSURE_GATE_PRESERVE_FARM_UNTIL_VP="$EXPOSURE_GATE_PRESERVE_FARM_UNTIL_VP" \
    AZEVAL=1 \
    AZEVAL_GAMES="$EVAL_GAMES" \
    AZEVAL_ITERS="$EVAL_ITERS" \
    AZEVAL_HORIZON="$EVAL_HORIZON" \
    AZEVAL_PROGRESS_EVERY="$EVAL_PROGRESS_EVERY" \
    AZEVAL_CONTROL=full \
    AZEVAL_FULL_SELECTION=value \
    AZEVAL_VALUEW=1 \
    AZEVAL_WEIGHTS="$HUNTER_WEIGHTS" \
    AZEVAL_PATCH_NAV_WEIGHTS="$HUNTER_PATCH_WEIGHTS" \
    AZEVAL_PATCH_NAV_GATE="$HUNTER_PATCH_GATE" \
    AZEVAL_MICRO_WEIGHTS="$HUNTER_MICRO_WEIGHTS" \
    AZEVAL_MICRO_GATE="$HUNTER_MICRO_GATE" \
    AZEVAL_PVP_PIVOT_ORACLE="$HUNTER_PVP_ORACLE" \
    AZEVAL_PLANNER_ROLE_NAME="$HUNTER_ROLE_NAME" \
    AZEVAL_NEURAL_FIELD=1 \
    AZEVAL_NEURAL_FIELD_STACKS_FILE="$stack" \
    AZEVAL_OUT="$out" \
    npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
    2>&1 | tee "$LOG_DIR/${label}.log"
}

run_target_eval "baseline_target_field" "" "$BASELINE_TARGET_STACK"
run_target_eval "candidate_target_field" "$TARGET_PATCH_NAV_WEIGHTS" "$CANDIDATE_TARGET_STACK"
run_hunter_eval "hunter_vs_baseline_target" "$BASELINE_TARGET_STACK"
run_hunter_eval "hunter_vs_candidate_target" "$CANDIDATE_TARGET_STACK"
run_hunter_eval "hunter_vs_candidate_mixed" "$CANDIDATE_MIXED_STACK"

node --input-type=module - "$OUT_DIR" "$BASELINE_TARGET_STACK" "$CANDIDATE_TARGET_STACK" "$CANDIDATE_MIXED_STACK" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [outDir, baselineTargetStack, candidateTargetStack, candidateMixedStack] = process.argv.slice(2);
const read = (name) => JSON.parse(readFileSync(`${outDir}/${name}.json`, 'utf8'));
const metric = (row) => ({
  vp: row.planner_VP_avg,
  winPct: row.planner_win_pct,
  reach30Pct: row.planner_reach30_pct,
  status: row.planner_status_avg,
  maxStatus: row.planner_max_status,
  statusCapViolations: row.planner_status_cap_violations,
  fieldBestVp: row.field_bestVP_avg,
  kills: row.planner_monster_kills_per_game,
  pvpVp: row.planner_pvp_vp_per_game,
  pvpAttacks: row.planner_pvp_attacks_per_game,
  highValueWindows: row.planner_pvp_high_value_opportunities_per_game,
  hp4PvpVp: row.planner_pvp_hard_monster_vp_per_game,
  goodPivotVp: row.planner_pvp_good_target_pivot_vp_per_game,
  goodPivotAttacks: row.planner_pvp_good_target_pivot_attacks_per_game,
  goodPivotOpportunities: row.planner_pvp_good_target_pivot_opportunities_per_game,
  goodPivotBestTargetVp: row.planner_pvp_good_target_pivot_best_target_vp,
  missedGoodPivotPct: row.planner_missed_pvp_good_target_pivot_opportunity_pct,
  pvpBestTargetVp: row.planner_pvp_best_target_vp,
  roleStats: row.roleStats
});
const baselineTarget = read('baseline_target_field');
const candidateTarget = read('candidate_target_field');
const hunterBaseline = read('hunter_vs_baseline_target');
const hunterCandidate = read('hunter_vs_candidate_target');
const hunterMixed = read('hunter_vs_candidate_mixed');
const summary = {
  generatedAt: new Date().toISOString(),
  outDir,
  baselineTargetStack,
  candidateTargetStack,
  candidateMixedStack,
  traceRunId: process.env.TRACE_RUN_ID,
  trainedPatch: process.env.TARGET_PATCH_NAV_WEIGHTS,
  mixedFieldMode: process.env.MIXED_FIELD_MODE,
  hunterGate: {
    patchGate: process.env.HUNTER_PATCH_GATE,
    microGate: process.env.HUNTER_MICRO_GATE,
    pvpOracle: process.env.HUNTER_PVP_ORACLE,
    rebuildMinRound: Number(process.env.HUNTER_REBUILD_MIN_ROUND),
	    rebuildSkipTargetVp: Number(process.env.HUNTER_REBUILD_SKIP_TARGET_VP),
	    goodTargetPivotMinTargetVp: Number(process.env.HUNTER_GOOD_TARGET_PIVOT_MIN_TARGET_VP),
	    status2DescendMinTargetVp: Number(process.env.HUNTER_STATUS2_DESCEND_MIN_TARGET_VP),
	    forceHighValueTargetVp: Number(process.env.HUNTER_FORCE_HIGH_VALUE_TARGET_VP),
	    lowTailHuntMaxVp: process.env.HUNTER_LOW_TAIL_HUNT_MAX_VP === '' ? null : Number(process.env.HUNTER_LOW_TAIL_HUNT_MAX_VP),
	    lowTailHuntMinRound: process.env.HUNTER_LOW_TAIL_HUNT_MIN_ROUND === '' ? null : Number(process.env.HUNTER_LOW_TAIL_HUNT_MIN_ROUND),
	    lowTailHuntMinMonsterHp: process.env.HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP === '' ? null : Number(process.env.HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP),
	    lowTailHuntMinTargetVp: process.env.HUNTER_LOW_TAIL_HUNT_MIN_TARGET_VP === '' ? null : Number(process.env.HUNTER_LOW_TAIL_HUNT_MIN_TARGET_VP)
	  },
  exposureGate: {
    minVp: Number(process.env.EXPOSURE_GATE_MIN_VP),
    maxVp: Number(process.env.EXPOSURE_GATE_MAX_VP),
    minRound: Number(process.env.EXPOSURE_GATE_MIN_ROUND),
    minMonsterHp: Number(process.env.EXPOSURE_GATE_MIN_MONSTER_HP),
    maxFarmOpportunityVp: process.env.EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP === '' ? null : Number(process.env.EXPOSURE_GATE_MAX_FARM_OPPORTUNITY_VP),
    maxRemainingFarmVp: process.env.EXPOSURE_GATE_MAX_REMAINING_FARM_VP === '' ? null : Number(process.env.EXPOSURE_GATE_MAX_REMAINING_FARM_VP),
    preserveFarmRewardVp: process.env.EXPOSURE_GATE_PRESERVE_FARM_REWARD_VP === '' ? null : Number(process.env.EXPOSURE_GATE_PRESERVE_FARM_REWARD_VP),
    preserveFarmUntilVp: process.env.EXPOSURE_GATE_PRESERVE_FARM_UNTIL_VP === '' ? null : Number(process.env.EXPOSURE_GATE_PRESERVE_FARM_UNTIL_VP)
  },
  baselineTargetField: metric(baselineTarget),
  candidateTargetField: metric(candidateTarget),
  hunterVsBaselineTarget: metric(hunterBaseline),
  hunterVsCandidateTarget: metric(hunterCandidate),
  hunterVsCandidateMixed: metric(hunterMixed),
  deltas: {
    targetVp: +(candidateTarget.planner_VP_avg - baselineTarget.planner_VP_avg).toFixed(2),
    targetFieldBestVp: +(candidateTarget.field_bestVP_avg - baselineTarget.field_bestVP_avg).toFixed(2),
    hunterDirectVp: +(hunterCandidate.planner_VP_avg - hunterBaseline.planner_VP_avg).toFixed(2),
    hunterDirectGoodPivotVp: +(hunterCandidate.planner_pvp_good_target_pivot_vp_per_game - hunterBaseline.planner_pvp_good_target_pivot_vp_per_game).toFixed(2),
    hunterDirectBestGoodTargetVp: +(hunterCandidate.planner_pvp_good_target_pivot_best_target_vp - hunterBaseline.planner_pvp_good_target_pivot_best_target_vp).toFixed(2)
  },
  verdict: {
    preservesTargetVp: candidateTarget.planner_VP_avg >= baselineTarget.planner_VP_avg - 0.5,
    preservesStatusCap: candidateTarget.planner_max_status <= Number(process.env.TARGET_STATUS_CAP) && candidateTarget.planner_status_cap_violations === 0,
    improvesDirectGoodPivot:
      hunterCandidate.planner_pvp_good_target_pivot_vp_per_game > hunterBaseline.planner_pvp_good_target_pivot_vp_per_game ||
      hunterCandidate.planner_pvp_good_target_pivot_best_target_vp > hunterBaseline.planner_pvp_good_target_pivot_best_target_vp,
    mixedFindsValuableGood: hunterMixed.planner_pvp_good_target_pivot_best_target_vp >= 18,
    mixedImprovesGoodPivot: hunterMixed.planner_pvp_good_target_pivot_vp_per_game > hunterBaseline.planner_pvp_good_target_pivot_vp_per_game,
    promotable: false
  }
};
summary.verdict.promotable =
  summary.verdict.preservesTargetVp &&
  summary.verdict.preservesStatusCap &&
  summary.verdict.improvesDirectGoodPivot &&
  summary.verdict.mixedFindsValuableGood &&
  summary.verdict.mixedImprovesGoodPivot;
writeFileSync(`${outDir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE

echo "DONE: $OUT_DIR/summary.json"
REMOTE

mkdir -p "$OUT_DIR"
rsync -az "$HOST:$REMOTE_DIR/$REMOTE_OUT_DIR/" "$OUT_DIR/"
echo "DONE -> $OUT_DIR/summary.json"
