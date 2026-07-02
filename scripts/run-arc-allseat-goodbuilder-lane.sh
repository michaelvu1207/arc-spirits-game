#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN_ID="${RUN_ID:-allseat-goodbuilder-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="ml/meta_runs/$RUN_ID"
SAMPLE_DIR="$OUT_DIR/samples"
CONTRAST_DIR="$SAMPLE_DIR/contrast"
TRAIN_DIR="$SAMPLE_DIR/train"
LOG_DIR="$OUT_DIR/logs"

GPU="${GPU:-4}"
MIN_FREE_MB="${MIN_FREE_MB:-10000}"
MINE_GAMES="${MINE_GAMES:-24}"
MINE_ITERS="${MINE_ITERS:-24}"
MINE_HORIZON="${MINE_HORIZON:-16}"
MINE_VALUEW="${MINE_VALUEW:-1}"
MINE_MIN_DECISION_VP="${MINE_MIN_DECISION_VP:-4}"
MINE_NEAR_MIN_VP="${MINE_NEAR_MIN_VP:-8}"
MINE_SUCCESS_VP="${MINE_SUCCESS_VP:-12}"
MINE_MAX_STATUS_LEVEL="${MINE_MAX_STATUS_LEVEL:-}"
MINE_LOW_MAX_VP="${MINE_LOW_MAX_VP:-}"
MINE_LOW_MIN_DECISION_VP="${MINE_LOW_MIN_DECISION_VP:-$MINE_MIN_DECISION_VP}"
MINE_LOW_MAX_DECISION_VP="${MINE_LOW_MAX_DECISION_VP:-}"
MINE_LOW_POLICY_WEIGHT="${MINE_LOW_POLICY_WEIGHT:-0}"
EPOCHS="${EPOCHS:-8}"
BATCH="${BATCH:-4096}"
EVAL_GAMES="${EVAL_GAMES:-8}"
EVAL_ITERS="${EVAL_ITERS:-24}"
EVAL_HORIZON="${EVAL_HORIZON:-16}"

BASE_WEIGHTS="${BASE_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/best_policy.full.json}"
PURE_NAV_WEIGHTS="${PURE_NAV_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/nav_build_policy.json}"
PURE_NAV_GATE="${PURE_NAV_GATE:-pure-farm-build}"
TARGET_STATUS_CAP="${TARGET_STATUS_CAP:-0}"
TARGET_FORBID_TYPES="${TARGET_FORBID_TYPES:-initiatePvp}"
TARGET_ACTION_DISCIPLINE="${TARGET_ACTION_DISCIPLINE:-0}"
HUNTER_PATCH_WEIGHTS="${HUNTER_PATCH_WEIGHTS:-ml/meta_runs/pvp-route-mode-20260630T124558Z/pvp_route_mode_head_policy.json}"
HUNTER_MICRO_WEIGHTS="${HUNTER_MICRO_WEIGHTS:-$HUNTER_PATCH_WEIGHTS}"
HUNTER_PATCH_GATE="${HUNTER_PATCH_GATE:-pvp-predictive-mode-hunt-fallback-pivot}"
BASE_GOOD_STACK="${BASE_GOOD_STACK:-ml/stacks/neural-field-good-builders.json}"

TRAINED_WEIGHTS="$OUT_DIR/allseat_goodbuilder_policy.json"
TRAINED_STACK="$OUT_DIR/allseat_goodbuilder_stack.json"
MIXED_STACK="$OUT_DIR/mixed_goodbuilder_stack.json"

mkdir -p "$SAMPLE_DIR" "$LOG_DIR"

write_trained_stack() {
  local out="$1"
  node --input-type=module - "$TRAINED_WEIGHTS" "$PURE_NAV_WEIGHTS" "$PURE_NAV_GATE" "$TARGET_STATUS_CAP" "$TARGET_FORBID_TYPES" "$TARGET_ACTION_DISCIPLINE" "$out" <<'NODE'
import { writeFileSync } from 'node:fs';

const [weights, navWeights, navigationPolicyGate, statusCap, forbidCsv, actionDiscipline, out] = process.argv.slice(2);
const forbidTypes = forbidCsv.split(',').map((s) => s.trim()).filter(Boolean);
writeFileSync(out, JSON.stringify([
  {
    name: 'allseat-goodbuilder-trained',
    weights,
    navWeights,
    navigationPolicyGate,
    maxStatusLevel: Number(statusCap),
    forbidTypes,
    preserveRouteFirepower: true,
    preserveRouteSurvival: true,
    goodTargetActionDiscipline: actionDiscipline === '1'
  }
], null, 2));
NODE
}

write_mixed_stack() {
  local out="$1"
  node --input-type=module - "$BASE_GOOD_STACK" "$TRAINED_WEIGHTS" "$PURE_NAV_WEIGHTS" "$PURE_NAV_GATE" "$TARGET_STATUS_CAP" "$TARGET_FORBID_TYPES" "$TARGET_ACTION_DISCIPLINE" "$out" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [baseStackPath, weights, navWeights, navigationPolicyGate, statusCap, forbidCsv, actionDiscipline, out] = process.argv.slice(2);
const base = JSON.parse(readFileSync(baseStackPath, 'utf8'));
const firstBase = Array.isArray(base) && base.length > 0 ? base[0] : null;
const forbidTypes = forbidCsv.split(',').map((s) => s.trim()).filter(Boolean);
const trained = {
  name: 'allseat-goodbuilder-trained',
  weights,
  navWeights,
  navigationPolicyGate,
  maxStatusLevel: Number(statusCap),
  forbidTypes,
  preserveRouteFirepower: true,
  preserveRouteSurvival: true,
  goodTargetActionDiscipline: actionDiscipline === '1'
};
writeFileSync(out, JSON.stringify(firstBase ? [firstBase, trained] : [trained], null, 2));
NODE
}

run_hunter_eval() {
  local label="$1"
  local stack="$2"
  local out="$3"
  env \
    AZEVAL=1 \
    AZEVAL_GAMES="$EVAL_GAMES" \
    AZEVAL_ITERS="$EVAL_ITERS" \
    AZEVAL_HORIZON="$EVAL_HORIZON" \
    AZEVAL_CONTROL=full \
    AZEVAL_FULL_SELECTION=value \
    AZEVAL_VALUEW=1 \
    AZEVAL_WEIGHTS="$BASE_WEIGHTS" \
    AZEVAL_PATCH_NAV_WEIGHTS="$HUNTER_PATCH_WEIGHTS" \
    AZEVAL_PATCH_NAV_GATE="$HUNTER_PATCH_GATE" \
    AZEVAL_MICRO_WEIGHTS="$HUNTER_MICRO_WEIGHTS" \
    AZEVAL_MICRO_GATE=pvp-pivot-encounter-force \
    AZEVAL_NEURAL_FIELD=1 \
    AZEVAL_NEURAL_FIELD_STACKS_FILE="$stack" \
    AZEVAL_OUT="$out" \
    npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
    2>&1 | tee "$LOG_DIR/$label.log"
}

run_target_eval() {
  local label="$1"
  local weights="$2"
  local stack="$3"
  local out="$4"
  env \
    AZEVAL=1 \
    AZEVAL_GAMES="$EVAL_GAMES" \
    AZEVAL_ITERS="$EVAL_ITERS" \
    AZEVAL_HORIZON="$EVAL_HORIZON" \
    AZEVAL_CONTROL=full \
    AZEVAL_FULL_SELECTION=value \
    AZEVAL_VALUEW=1 \
    AZEVAL_WEIGHTS="$weights" \
    AZEVAL_NAV_WEIGHTS="$PURE_NAV_WEIGHTS" \
    AZEVAL_NAV_GATE="$PURE_NAV_GATE" \
    AZEVAL_MAX_STATUS_LEVEL="$TARGET_STATUS_CAP" \
    AZEVAL_FORBID_TYPES="$TARGET_FORBID_TYPES" \
    AZEVAL_HARD_CONSTRAINTS=1 \
    AZEVAL_PRESERVE_ROUTE_FIREPOWER=1 \
    AZEVAL_PRESERVE_ROUTE_SURVIVAL=1 \
    AZEVAL_GOOD_TARGET_ACTION_DISCIPLINE="$TARGET_ACTION_DISCIPLINE" \
    AZEVAL_NEURAL_FIELD=1 \
    AZEVAL_NEURAL_FIELD_STACKS_FILE="$stack" \
    AZEVAL_OUT="$out" \
    npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
    2>&1 | tee "$LOG_DIR/$label.log"
}

echo "== all-seat Good-builder lane =="
echo "run_id=$RUN_ID"
echo "gpu=$GPU min_free_mb=$MIN_FREE_MB mine_games=$MINE_GAMES mine_iters=$MINE_ITERS mine_horizon=$MINE_HORIZON eval_games=$EVAL_GAMES"
echo "base_weights=$BASE_WEIGHTS"
echo "hunter_patch=$HUNTER_PATCH_WEIGHTS"
echo "hunter_patch_gate=$HUNTER_PATCH_GATE"
echo "base_good_stack=$BASE_GOOD_STACK"
echo "target_nav_gate=$PURE_NAV_GATE target_status_cap=$TARGET_STATUS_CAP target_forbid_types=$TARGET_FORBID_TYPES target_action_discipline=$TARGET_ACTION_DISCIPLINE"
echo "out_dir=$OUT_DIR"

if command -v nvidia-smi >/dev/null 2>&1; then
  free_mb="$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  used_mb="$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  echo "gpu=$GPU free_mb=${free_mb:-unknown} used_mb=${used_mb:-unknown} min_free_mb=$MIN_FREE_MB"
  if [[ -n "${free_mb:-}" && "$free_mb" -lt "$MIN_FREE_MB" ]]; then
    echo "refusing Good-builder lane: GPU $GPU has ${free_mb}MB free, below MIN_FREE_MB=$MIN_FREE_MB" >&2
    exit 3
  fi
fi

echo "== mine all-seat shared-stack samples =="
mine_status_env=()
if [[ -n "$MINE_MAX_STATUS_LEVEL" ]]; then
  mine_status_env+=(AZEVAL_ROUTE_SAMPLE_MAX_STATUS_LEVEL="$MINE_MAX_STATUS_LEVEL")
fi

env \
  "${mine_status_env[@]}" \
  AZEVAL=1 \
  AZEVAL_GAMES="$MINE_GAMES" \
  AZEVAL_ITERS="$MINE_ITERS" \
  AZEVAL_HORIZON="$MINE_HORIZON" \
  AZEVAL_CONTROL=full \
  AZEVAL_FULL_SELECTION=value \
  AZEVAL_VALUEW="$MINE_VALUEW" \
  AZEVAL_WEIGHTS="$BASE_WEIGHTS" \
  AZEVAL_PATCH_NAV_WEIGHTS="$HUNTER_PATCH_WEIGHTS" \
  AZEVAL_PATCH_NAV_GATE="$HUNTER_PATCH_GATE" \
  AZEVAL_MICRO_WEIGHTS="$HUNTER_MICRO_WEIGHTS" \
  AZEVAL_MICRO_GATE=pvp-pivot-encounter-force \
  AZEVAL_NEURAL_FIELD=1 \
  AZEVAL_NEURAL_FIELD_SHARED_STACK=1 \
  AZEVAL_ROUTE_SAMPLE_DIR="$SAMPLE_DIR" \
  AZEVAL_ROUTE_SAMPLE_RESET=1 \
  AZEVAL_ROUTE_SAMPLE_ALL_SEATS=1 \
  AZEVAL_ROUTE_SAMPLE_MIN_DECISION_VP="$MINE_MIN_DECISION_VP" \
  AZEVAL_ROUTE_SAMPLE_NEAR_MIN_VP="$MINE_NEAR_MIN_VP" \
  AZEVAL_ROUTE_SAMPLE_SUCCESS_VP="$MINE_SUCCESS_VP" \
  AZEVAL_ROUTE_SAMPLE_LOW_MAX_VP="$MINE_LOW_MAX_VP" \
  AZEVAL_ROUTE_SAMPLE_LOW_MIN_DECISION_VP="$MINE_LOW_MIN_DECISION_VP" \
  AZEVAL_ROUTE_SAMPLE_LOW_MAX_DECISION_VP="$MINE_LOW_MAX_DECISION_VP" \
  AZEVAL_ROUTE_SAMPLE_LOW_POLICY_WEIGHT="$MINE_LOW_POLICY_WEIGHT" \
  AZEVAL_OUT="$OUT_DIR/mining_eval.json" \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
  2>&1 | tee "$LOG_DIR/mine.log"

if [[ ! -s "$CONTRAST_DIR/samples.jsonl" ]]; then
  echo "No contrast samples produced at $CONTRAST_DIR/samples.jsonl" >&2
  exit 2
fi

rm -rf "$TRAIN_DIR"
mkdir -p "$TRAIN_DIR"
cp "$CONTRAST_DIR/samples.jsonl" "$TRAIN_DIR/contrast.samples.jsonl"
if [[ -s "$SAMPLE_DIR/low_tail/samples.jsonl" ]]; then
  cp "$SAMPLE_DIR/low_tail/samples.jsonl" "$TRAIN_DIR/low_tail.samples.jsonl"
fi

echo "== train all-seat Good-builder candidate =="
CUDA_VISIBLE_DEVICES="$GPU" \
  ml/.venv/bin/python ml/train.py \
  --data "$TRAIN_DIR" \
  --out "$TRAINED_WEIGHTS" \
  --init-from "$BASE_WEIGHTS" \
  --mode alphazero \
  --epochs "$EPOCHS" \
  --batch-size "$BATCH" \
  --value-coef 0.5 \
  2>&1 | tee "$LOG_DIR/train.log"

write_trained_stack "$TRAINED_STACK"
write_mixed_stack "$MIXED_STACK"

echo "== eval trained policy as shared unrestricted stack =="
env \
  AZEVAL=1 \
  AZEVAL_GAMES="$EVAL_GAMES" \
  AZEVAL_ITERS="$EVAL_ITERS" \
  AZEVAL_HORIZON="$EVAL_HORIZON" \
  AZEVAL_CONTROL=full \
  AZEVAL_FULL_SELECTION=value \
  AZEVAL_VALUEW=1 \
  AZEVAL_WEIGHTS="$TRAINED_WEIGHTS" \
  AZEVAL_PATCH_NAV_WEIGHTS="$HUNTER_PATCH_WEIGHTS" \
  AZEVAL_PATCH_NAV_GATE="$HUNTER_PATCH_GATE" \
  AZEVAL_MICRO_WEIGHTS="$HUNTER_MICRO_WEIGHTS" \
  AZEVAL_MICRO_GATE=pvp-pivot-encounter-force \
  AZEVAL_NEURAL_FIELD=1 \
  AZEVAL_NEURAL_FIELD_SHARED_STACK=1 \
  AZEVAL_OUT="$OUT_DIR/trained_shared_stack.json" \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
  2>&1 | tee "$LOG_DIR/trained_shared_stack.log"

echo "== eval baseline target field under capped Good contract =="
run_target_eval "baseline_target_field" "$BASE_WEIGHTS" "$BASE_GOOD_STACK" "$OUT_DIR/baseline_target_field.json"

echo "== eval trained target field under capped Good contract =="
run_target_eval "trained_target_field" "$TRAINED_WEIGHTS" "$TRAINED_STACK" "$OUT_DIR/trained_target_field.json"

echo "== hunter vs baseline Good-builder field =="
run_hunter_eval "hunter_vs_baseline_good" "$BASE_GOOD_STACK" "$OUT_DIR/hunter_vs_baseline_good.json"

echo "== hunter vs trained Good-builder field =="
run_hunter_eval "hunter_vs_trained_good" "$TRAINED_STACK" "$OUT_DIR/hunter_vs_trained_good.json"

echo "== hunter vs mixed Good-builder field =="
run_hunter_eval "hunter_vs_mixed_good" "$MIXED_STACK" "$OUT_DIR/hunter_vs_mixed_good.json"

node --input-type=module - "$OUT_DIR" "$PURE_NAV_GATE" "$TARGET_STATUS_CAP" "$TARGET_FORBID_TYPES" "$BASE_GOOD_STACK" "$TARGET_ACTION_DISCIPLINE" <<'NODE'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const outDir = process.argv[2];
const navigationPolicyGate = process.argv[3];
const targetStatusCap = Number(process.argv[4]);
const targetForbidTypes = process.argv[5].split(',').map((s) => s.trim()).filter(Boolean);
const baseGoodStack = process.argv[6];
const targetActionDiscipline = process.argv[7] === '1';
const read = (name) => JSON.parse(readFileSync(`${outDir}/${name}`, 'utf8'));
const readOptional = (name) => existsSync(`${outDir}/${name}`) ? read(name) : null;
const metric = (row) => ({
  vp: row.planner_VP_avg,
  winPct: row.planner_win_pct,
  reach30Pct: row.planner_reach30_pct,
  status: row.planner_status_avg,
  maxStatus: row.planner_max_status,
  statusCapViolations: row.planner_status_cap_violations,
  ownStatusCapViolationEvents: row.planner_own_status_cap_violation_events,
  externalStatusCapViolationEvents: row.planner_external_status_cap_violation_events,
  fieldBestVp: row.field_bestVP_avg,
  pvpVp: row.planner_pvp_vp_per_game,
  pvpAttacks: row.planner_pvp_attacks_per_game,
  pvpTargetVp: row.planner_pvp_target_vp_per_game,
  pvpBestTargetVp: row.planner_pvp_best_target_vp,
  pvpHighValueOpportunities: row.planner_pvp_high_value_opportunities_per_game,
  missedPvpPct: row.planner_missed_pvp_opportunity_pct,
  hp4PvpVp: row.planner_pvp_hard_monster_vp_per_game,
  hp4PvpAttacks: row.planner_pvp_hard_monster_attacks_per_game,
  hp4PvpBestTargetVp: row.planner_pvp_hard_monster_best_target_vp,
  missedHp4PvpPct: row.planner_missed_pvp_hard_monster_opportunity_pct,
  goodPivotVp: row.planner_pvp_good_target_pivot_vp_per_game,
  goodPivotAttacks: row.planner_pvp_good_target_pivot_attacks_per_game,
  goodPivotBestTargetVp: row.planner_pvp_good_target_pivot_best_target_vp,
  missedGoodPivotPct: row.planner_missed_pvp_good_target_pivot_opportunity_pct,
  abyssNavs: row.planner_abyss_navs_per_game,
  monsterKills: row.planner_monster_kills_per_game
});
const mining = read('mining_eval.json');
const trainedShared = read('trained_shared_stack.json');
const baselineTarget = readOptional('baseline_target_field.json');
const trainedTarget = readOptional('trained_target_field.json');
const hunterBaseline = read('hunter_vs_baseline_good.json');
const hunterTrained = read('hunter_vs_trained_good.json');
const hunterMixed = read('hunter_vs_mixed_good.json');
const contrastMeta = read('samples/contrast/meta.json');
const lowTailMeta = readOptional('samples/low_tail/meta.json');
const trainSamples = readOptional('samples/train/meta.json');
const summary = {
  outDir,
  contrastData: {
    samples: contrastMeta.samples,
    games: contrastMeta.games,
    successGames: mining.route_success_games,
    nearMissGames: mining.route_near_miss_games,
    successSamples: mining.route_success_samples,
    nearMissSamples: mining.route_near_miss_samples,
    lowTailGames: mining.route_low_tail_games,
    lowTailSamples: mining.route_low_tail_samples,
    minDecisionVp: mining.route_sample_min_decision_vp,
    successVp: mining.route_sample_success_vp,
    nearMinVp: mining.route_sample_near_min_vp,
    lowMaxVp: mining.route_sample_low_max_vp,
    lowPolicyWeight: mining.route_sample_low_policy_weight,
    maxStatusLevel: mining.route_sample_max_status_level ?? null
  },
  trainingData: {
    contrastSamples: contrastMeta.samples,
    lowTailSamples: lowTailMeta?.samples ?? 0,
    lowPolicyWeight: lowTailMeta?.policy_weight ?? null,
    trainMeta: trainSamples
  },
  targetContract: {
    navigationPolicyGate,
    statusCap: targetStatusCap,
    forbidTypes: targetForbidTypes,
    targetActionDiscipline,
    baseGoodStack
  },
  miningSharedStack: metric(mining),
  trainedSharedStack: metric(trainedShared),
  baselineTargetField: baselineTarget ? metric(baselineTarget) : null,
  trainedTargetField: trainedTarget ? metric(trainedTarget) : null,
  hunterVsBaselineGood: metric(hunterBaseline),
  hunterVsTrainedGood: metric(hunterTrained),
  hunterVsMixedGood: metric(hunterMixed),
  verdict: {
    trainedGoodImprovesFieldBest: hunterTrained.field_bestVP_avg > hunterBaseline.field_bestVP_avg,
    trainedGoodImprovesHighValueTargets: hunterTrained.planner_pvp_high_value_opportunities_per_game > hunterBaseline.planner_pvp_high_value_opportunities_per_game,
    trainedGoodImprovesPvpVp: hunterTrained.planner_pvp_vp_per_game > hunterBaseline.planner_pvp_vp_per_game,
    trainedGoodImprovesReach30: hunterTrained.planner_reach30_pct > hunterBaseline.planner_reach30_pct,
    trainedGoodImprovesHunterVp: hunterTrained.planner_VP_avg > hunterBaseline.planner_VP_avg,
    mixedImprovesPvpVp: hunterMixed.planner_pvp_vp_per_game > hunterBaseline.planner_pvp_vp_per_game,
    mixedImprovesReach30: hunterMixed.planner_reach30_pct > hunterBaseline.planner_reach30_pct,
    mixedImprovesHunterVp: hunterMixed.planner_VP_avg > hunterBaseline.planner_VP_avg,
    trainedGoodRespectsStatusCap:
      trainedTarget !== null &&
      trainedTarget.planner_max_status <= targetStatusCap &&
      trainedTarget.planner_status_cap_violations === 0,
    trainedGoodImprovesOwnFieldBest:
      baselineTarget !== null &&
      trainedTarget !== null &&
      trainedTarget.field_bestVP_avg > baselineTarget.field_bestVP_avg,
    trainedGoodImprovesOwnVp:
      baselineTarget !== null &&
      trainedTarget !== null &&
      trainedTarget.planner_VP_avg > baselineTarget.planner_VP_avg,
    farmToPvpPivotEvidence:
      hunterTrained.planner_pvp_vp_per_game > hunterBaseline.planner_pvp_vp_per_game &&
      hunterTrained.planner_pvp_high_value_opportunities_per_game > hunterBaseline.planner_pvp_high_value_opportunities_per_game &&
      hunterTrained.planner_pvp_hard_monster_vp_per_game > 0,
    promotable: false
  }
};
writeFileSync(`${outDir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE

echo "DONE $OUT_DIR"
