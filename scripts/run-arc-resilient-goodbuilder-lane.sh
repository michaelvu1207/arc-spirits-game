#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN_ID="${RUN_ID:-resilient-goodbuilder-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="ml/meta_runs/$RUN_ID"
SAMPLE_DIR="$OUT_DIR/samples"
TRAIN_DIR="$SAMPLE_DIR/train"
LOG_DIR="$OUT_DIR/logs"

GPU="${GPU:-4}"
MIN_FREE_MB="${MIN_FREE_MB:-10000}"
MINE_GAMES="${MINE_GAMES:-24}"
MINE_ITERS="${MINE_ITERS:-48}"
MINE_HORIZON="${MINE_HORIZON:-24}"
MINE_ROLE_REGEX="${MINE_ROLE_REGEX:-goodbuilder|target}"
MINE_MAX_STATUS_LEVEL="${MINE_MAX_STATUS_LEVEL:-2}"
MINE_MIN_DECISION_VP="${MINE_MIN_DECISION_VP:-4}"
MINE_NEAR_MIN_VP="${MINE_NEAR_MIN_VP:-6}"
MINE_SUCCESS_VP="${MINE_SUCCESS_VP:-10}"
MINE_LOW_MAX_VP="${MINE_LOW_MAX_VP:-5}"
MINE_LOW_MIN_DECISION_VP="${MINE_LOW_MIN_DECISION_VP:-2}"
MINE_LOW_POLICY_WEIGHT="${MINE_LOW_POLICY_WEIGHT:-0}"
MINE_MAX_CONCEDED_SHARE="${MINE_MAX_CONCEDED_SHARE:-8}"
MINE_PRESSURE_PENALTY="${MINE_PRESSURE_PENALTY:-0.75}"
MINE_PRESSURE_SCALE="${MINE_PRESSURE_SCALE:-30}"
MINE_PRESSURE_FAIL_LOW_TAIL="${MINE_PRESSURE_FAIL_LOW_TAIL:-1}"
MINE_PROGRESS_EVERY="${MINE_PROGRESS_EVERY:-4}"

EPOCHS="${EPOCHS:-8}"
BATCH="${BATCH:-4096}"
EVAL_GAMES="${EVAL_GAMES:-12}"
EVAL_ITERS="${EVAL_ITERS:-64}"
EVAL_HORIZON="${EVAL_HORIZON:-24}"
EVAL_PROGRESS_EVERY="${EVAL_PROGRESS_EVERY:-4}"

SOURCE_STACK="${SOURCE_STACK:-ml/stacks/league-current-disciplined-nonfallen-goodbuilder-status2-hunter.json}"
INIT_WEIGHTS="${INIT_WEIGHTS:-ml/meta_runs/allseat-goodbuilder-medium-20260630Tgoal/allseat_goodbuilder_policy.json}"
BASE_WEIGHTS="${BASE_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/best_policy.full.json}"
TARGET_NAV_WEIGHTS="${TARGET_NAV_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/nav_build_policy.json}"
TARGET_NAV_GATE="${TARGET_NAV_GATE:-good-nonfallen-farm-target-pivot}"
TARGET_MICRO_WEIGHTS="${TARGET_MICRO_WEIGHTS:-$INIT_WEIGHTS}"
TARGET_MICRO_GATE="${TARGET_MICRO_GATE:-all}"
TARGET_STATUS_CAP="${TARGET_STATUS_CAP:-2}"
TARGET_FORBID_TYPES="${TARGET_FORBID_TYPES:-initiatePvp}"
TARGET_ACTION_DISCIPLINE="${TARGET_ACTION_DISCIPLINE:-1}"
TRAINED_SUPPORT_MODE="${TRAINED_SUPPORT_MODE:-none}"
SUPPORT_A_WEIGHTS="${SUPPORT_A_WEIGHTS:-$INIT_WEIGHTS}"
SUPPORT_B_WEIGHTS="${SUPPORT_B_WEIGHTS:-$BASE_WEIGHTS}"
SUPPORT_NAV_WEIGHTS="${SUPPORT_NAV_WEIGHTS:-$TARGET_NAV_WEIGHTS}"
SUPPORT_NAV_GATE="${SUPPORT_NAV_GATE:-good-builder-noncontest-support-oracle}"

HUNTER_WEIGHTS="${HUNTER_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/best_policy.full.json}"
HUNTER_PATCH_WEIGHTS="${HUNTER_PATCH_WEIGHTS:-ml/meta_runs/pvp-route-mode-20260630T124558Z/pvp_route_mode_head_policy.json}"
HUNTER_MICRO_WEIGHTS="${HUNTER_MICRO_WEIGHTS:-$HUNTER_PATCH_WEIGHTS}"
HUNTER_PATCH_GATE="${HUNTER_PATCH_GATE:-pvp-predictive-mode-hunt-fallback-rebuild-pivot}"
HUNTER_MICRO_GATE="${HUNTER_MICRO_GATE:-pvp-pivot-encounter-force}"
HUNTER_PVP_ORACLE="${HUNTER_PVP_ORACLE:-status2-conversion-descend}"
HUNTER_ROLE_NAME="${HUNTER_ROLE_NAME:-status2-conversion-descend-hunter}"

MINE_WEIGHTS="${MINE_WEIGHTS:-$BASE_WEIGHTS}"
MINE_NAV_WEIGHTS="${MINE_NAV_WEIGHTS:-}"
MINE_NAV_GATE="${MINE_NAV_GATE:-all}"
MINE_MICRO_WEIGHTS="${MINE_MICRO_WEIGHTS:-$HUNTER_MICRO_WEIGHTS}"
MINE_MICRO_GATE="${MINE_MICRO_GATE:-$HUNTER_MICRO_GATE}"
MINE_PATCH_NAV_WEIGHTS="${MINE_PATCH_NAV_WEIGHTS:-$HUNTER_PATCH_WEIGHTS}"
MINE_PATCH_NAV_GATE="${MINE_PATCH_NAV_GATE:-$HUNTER_PATCH_GATE}"
MINE_PLANNER_ROLE_NAME="${MINE_PLANNER_ROLE_NAME:-planner}"
MINE_MAX_STATUS_LEVEL_FOR_PLANNER="${MINE_MAX_STATUS_LEVEL_FOR_PLANNER:-}"
MINE_FORBID_TYPES_FOR_PLANNER="${MINE_FORBID_TYPES_FOR_PLANNER:-}"
MINE_HARD_CONSTRAINTS="${MINE_HARD_CONSTRAINTS:-0}"
MINE_PRESERVE_ROUTE_FIREPOWER="${MINE_PRESERVE_ROUTE_FIREPOWER:-0}"
MINE_PRESERVE_ROUTE_SURVIVAL="${MINE_PRESERVE_ROUTE_SURVIVAL:-0}"
MINE_GOOD_TARGET_ACTION_DISCIPLINE="${MINE_GOOD_TARGET_ACTION_DISCIPLINE:-0}"
MIN_SUCCESS_SAMPLES="${MIN_SUCCESS_SAMPLES:-0}"

TRAINED_WEIGHTS="$OUT_DIR/resilient_goodbuilder_policy.json"
TRAINED_STACK="$OUT_DIR/resilient_goodbuilder_stack.json"
MIXED_STACK="$OUT_DIR/resilient_goodbuilder_mixed_stack.json"

mkdir -p "$SAMPLE_DIR" "$LOG_DIR"

echo "== resilient Good-builder lane =="
echo "run_id=$RUN_ID out_dir=$OUT_DIR"
echo "source_stack=$SOURCE_STACK role_regex=$MINE_ROLE_REGEX max_status=$MINE_MAX_STATUS_LEVEL"
echo "mine_games=$MINE_GAMES mine_iters=$MINE_ITERS mine_horizon=$MINE_HORIZON eval_games=$EVAL_GAMES"
echo "target_pressure max_conceded_share=$MINE_MAX_CONCEDED_SHARE penalty=$MINE_PRESSURE_PENALTY scale=$MINE_PRESSURE_SCALE fail_low_tail=$MINE_PRESSURE_FAIL_LOW_TAIL"
echo "target_nav_gate=$TARGET_NAV_GATE target_micro_gate=$TARGET_MICRO_GATE action_discipline=$TARGET_ACTION_DISCIPLINE"
echo "mine_weights=$MINE_WEIGHTS mine_nav_gate=$MINE_NAV_GATE mine_micro_gate=$MINE_MICRO_GATE mine_role=$MINE_PLANNER_ROLE_NAME"
echo "trained_support_mode=$TRAINED_SUPPORT_MODE support_nav_gate=$SUPPORT_NAV_GATE"

if command -v nvidia-smi >/dev/null 2>&1; then
  free_mb="$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  used_mb="$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  echo "gpu=$GPU free_mb=${free_mb:-unknown} used_mb=${used_mb:-unknown} min_free_mb=$MIN_FREE_MB"
  if [[ -n "${free_mb:-}" && "$free_mb" -lt "$MIN_FREE_MB" ]]; then
    echo "refusing resilient Good-builder lane: GPU $GPU has ${free_mb}MB free, below MIN_FREE_MB=$MIN_FREE_MB" >&2
    exit 3
  fi
fi

echo "== mine target-role samples under hunter pressure =="
env \
  CUDA_VISIBLE_DEVICES="$GPU" \
  AZEVAL=1 \
  AZEVAL_GAMES="$MINE_GAMES" \
  AZEVAL_ITERS="$MINE_ITERS" \
  AZEVAL_HORIZON="$MINE_HORIZON" \
  AZEVAL_PROGRESS_EVERY="$MINE_PROGRESS_EVERY" \
  AZEVAL_CONTROL=full \
  AZEVAL_FULL_SELECTION=value \
  AZEVAL_VALUEW=1 \
  AZEVAL_WEIGHTS="$MINE_WEIGHTS" \
  AZEVAL_NAV_WEIGHTS="$MINE_NAV_WEIGHTS" \
  AZEVAL_NAV_GATE="$MINE_NAV_GATE" \
  AZEVAL_PATCH_NAV_WEIGHTS="$MINE_PATCH_NAV_WEIGHTS" \
  AZEVAL_PATCH_NAV_GATE="$MINE_PATCH_NAV_GATE" \
  AZEVAL_MICRO_WEIGHTS="$MINE_MICRO_WEIGHTS" \
  AZEVAL_MICRO_GATE="$MINE_MICRO_GATE" \
  AZEVAL_PLANNER_ROLE_NAME="$MINE_PLANNER_ROLE_NAME" \
  AZEVAL_MAX_STATUS_LEVEL="$MINE_MAX_STATUS_LEVEL_FOR_PLANNER" \
  AZEVAL_FORBID_TYPES="$MINE_FORBID_TYPES_FOR_PLANNER" \
  AZEVAL_HARD_CONSTRAINTS="$MINE_HARD_CONSTRAINTS" \
  AZEVAL_PRESERVE_ROUTE_FIREPOWER="$MINE_PRESERVE_ROUTE_FIREPOWER" \
  AZEVAL_PRESERVE_ROUTE_SURVIVAL="$MINE_PRESERVE_ROUTE_SURVIVAL" \
  AZEVAL_GOOD_TARGET_ACTION_DISCIPLINE="$MINE_GOOD_TARGET_ACTION_DISCIPLINE" \
  AZEVAL_NEURAL_FIELD=1 \
  AZEVAL_NEURAL_FIELD_STACKS_FILE="$SOURCE_STACK" \
  AZEVAL_ROUTE_SAMPLE_DIR="$SAMPLE_DIR" \
  AZEVAL_ROUTE_SAMPLE_RESET=1 \
  AZEVAL_ROUTE_SAMPLE_ALL_SEATS=1 \
  AZEVAL_ROUTE_SAMPLE_ROLE_REGEX="$MINE_ROLE_REGEX" \
  AZEVAL_ROUTE_SAMPLE_MAX_STATUS_LEVEL="$MINE_MAX_STATUS_LEVEL" \
  AZEVAL_ROUTE_SAMPLE_MIN_DECISION_VP="$MINE_MIN_DECISION_VP" \
  AZEVAL_ROUTE_SAMPLE_NEAR_MIN_VP="$MINE_NEAR_MIN_VP" \
  AZEVAL_ROUTE_SAMPLE_SUCCESS_VP="$MINE_SUCCESS_VP" \
  AZEVAL_ROUTE_SAMPLE_LOW_MAX_VP="$MINE_LOW_MAX_VP" \
  AZEVAL_ROUTE_SAMPLE_LOW_MIN_DECISION_VP="$MINE_LOW_MIN_DECISION_VP" \
  AZEVAL_ROUTE_SAMPLE_LOW_POLICY_WEIGHT="$MINE_LOW_POLICY_WEIGHT" \
  AZEVAL_ROUTE_SAMPLE_MAX_CONCEDED_SHARE="$MINE_MAX_CONCEDED_SHARE" \
  AZEVAL_ROUTE_SAMPLE_PRESSURE_PENALTY="$MINE_PRESSURE_PENALTY" \
  AZEVAL_ROUTE_SAMPLE_PRESSURE_SCALE="$MINE_PRESSURE_SCALE" \
  AZEVAL_ROUTE_SAMPLE_PRESSURE_FAIL_LOW_TAIL="$MINE_PRESSURE_FAIL_LOW_TAIL" \
  AZEVAL_OUT="$OUT_DIR/mining_eval.json" \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
  2>&1 | tee "$LOG_DIR/mine.log"

if [[ ! -s "$SAMPLE_DIR/contrast/samples.jsonl" ]]; then
  echo "No contrast samples produced at $SAMPLE_DIR/contrast/samples.jsonl" >&2
  exit 2
fi
success_samples="$(
  node --input-type=module - "$SAMPLE_DIR/meta.json" <<'NODE'
import { readFileSync } from 'node:fs';
const [metaPath] = process.argv.slice(2);
try {
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  console.log(Number(meta.success_samples ?? 0));
} catch {
  console.log(0);
}
NODE
)"
if [[ "$MIN_SUCCESS_SAMPLES" -gt 0 && "$success_samples" -lt "$MIN_SUCCESS_SAMPLES" ]]; then
  echo "refusing train: success_samples=$success_samples < MIN_SUCCESS_SAMPLES=$MIN_SUCCESS_SAMPLES" >&2
  exit 4
fi

rm -rf "$TRAIN_DIR"
mkdir -p "$TRAIN_DIR"
cp "$SAMPLE_DIR/contrast/samples.jsonl" "$TRAIN_DIR/contrast.samples.jsonl"
if [[ -s "$SAMPLE_DIR/low_tail/samples.jsonl" ]]; then
  cp "$SAMPLE_DIR/low_tail/samples.jsonl" "$TRAIN_DIR/low_tail.samples.jsonl"
fi

echo "== train resilient Good-builder candidate =="
CUDA_VISIBLE_DEVICES="$GPU" \
  ml/.venv/bin/python ml/train.py \
  --data "$TRAIN_DIR" \
  --out "$TRAINED_WEIGHTS" \
  --init-from "$INIT_WEIGHTS" \
  --mode alphazero \
  --epochs "$EPOCHS" \
  --batch-size "$BATCH" \
  --value-coef 0.5 \
  2>&1 | tee "$LOG_DIR/train.log"

node --input-type=module - "$TRAINED_WEIGHTS" "$TARGET_NAV_WEIGHTS" "$TARGET_NAV_GATE" "$TARGET_MICRO_WEIGHTS" "$TARGET_MICRO_GATE" "$TARGET_STATUS_CAP" "$TARGET_FORBID_TYPES" "$TARGET_ACTION_DISCIPLINE" "$TRAINED_SUPPORT_MODE" "$SUPPORT_A_WEIGHTS" "$SUPPORT_B_WEIGHTS" "$SUPPORT_NAV_WEIGHTS" "$SUPPORT_NAV_GATE" "$TRAINED_STACK" "$MIXED_STACK" <<'NODE'
import { writeFileSync } from 'node:fs';

const [
  weights,
  navWeights,
  navigationPolicyGate,
  microWeights,
  microPolicyGate,
  statusCapRaw,
  forbidCsv,
  actionDisciplineRaw,
  supportMode,
  supportAWeights,
  supportBWeights,
  supportNavWeights,
  supportNavGate,
  trainedOut,
  mixedOut
] = process.argv.slice(2);
const forbidTypes = forbidCsv.split(',').map((s) => s.trim()).filter(Boolean);
const target = {
  name: 'resilient-goodbuilder-candidate',
  weights,
  navWeights,
  navigationPolicyGate,
  ...(microPolicyGate && microPolicyGate !== 'all' ? { microWeights, microPolicyGate } : {}),
  maxStatusLevel: Number(statusCapRaw),
  forbidTypes,
  preserveRouteFirepower: true,
  preserveRouteSurvival: true,
  goodTargetActionDiscipline: actionDisciplineRaw === '1'
};
const support = (name, supportWeights) => ({
  name,
  weights: supportWeights,
  navWeights: supportNavWeights,
  navigationPolicyGate: supportNavGate,
  maxStatusLevel: Number(statusCapRaw),
  forbidTypes,
  preserveRouteFirepower: true,
  preserveRouteSurvival: true,
  goodTargetActionDiscipline: actionDisciplineRaw === '1'
});
const supports = supportMode === 'scorefloor-carry-support'
  ? [
      support('nonfallen-noncontest-support-a', supportAWeights),
      support('nonfallen-noncontest-support-b', supportBWeights)
    ]
  : [];
const currentHunter = {
  name: 'current-champion-hunter',
  weights: 'ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/best_policy.full.json',
  patchNavWeights: 'ml/meta_runs/pvp-route-mode-20260630T124558Z/pvp_route_mode_head_policy.json',
  patchNavigationPolicyGate: 'pvp-predictive-mode-hunt-fallback-rebuild-pivot',
  microWeights: 'ml/meta_runs/pvp-route-mode-20260630T124558Z/pvp_route_mode_head_policy.json',
  microPolicyGate: 'pvp-pivot-encounter-force'
};
const status2Hunter = {
  ...currentHunter,
  name: 'status2-conversion-descend-hunter',
  pvpPivotOracle: 'status2-conversion-descend'
};
writeFileSync(trainedOut, JSON.stringify([target, ...supports], null, 2) + '\n');
writeFileSync(
  mixedOut,
  JSON.stringify(
    supportMode === 'scorefloor-carry-support'
      ? [currentHunter, status2Hunter, target, supports[0] ?? target]
      : [currentHunter, status2Hunter, target, target],
    null,
    2
  ) + '\n'
);
NODE

run_target_eval() {
  local label="$1"
  local weights="$2"
  local stack="$3"
  local out="$4"
  env \
    CUDA_VISIBLE_DEVICES="$GPU" \
    AZEVAL=1 \
    AZEVAL_GAMES="$EVAL_GAMES" \
    AZEVAL_ITERS="$EVAL_ITERS" \
    AZEVAL_HORIZON="$EVAL_HORIZON" \
    AZEVAL_PROGRESS_EVERY="$EVAL_PROGRESS_EVERY" \
    AZEVAL_CONTROL=full \
    AZEVAL_FULL_SELECTION=value \
    AZEVAL_VALUEW=1 \
    AZEVAL_WEIGHTS="$weights" \
    AZEVAL_NAV_WEIGHTS="$TARGET_NAV_WEIGHTS" \
    AZEVAL_NAV_GATE="$TARGET_NAV_GATE" \
    AZEVAL_MICRO_WEIGHTS="$TARGET_MICRO_WEIGHTS" \
    AZEVAL_MICRO_GATE="$TARGET_MICRO_GATE" \
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

run_hunter_eval() {
  local label="$1"
  local stack="$2"
  local out="$3"
  env \
    CUDA_VISIBLE_DEVICES="$GPU" \
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
    2>&1 | tee "$LOG_DIR/$label.log"
}

echo "== eval baseline target stack under hunter pressure =="
run_hunter_eval "hunter_vs_source_stack" "$SOURCE_STACK" "$OUT_DIR/hunter_vs_source_stack.json"

echo "== eval trained target candidate own-score =="
run_target_eval "trained_target_field" "$TRAINED_WEIGHTS" "$TRAINED_STACK" "$OUT_DIR/trained_target_field.json"

echo "== eval hunter vs trained target candidate =="
run_hunter_eval "hunter_vs_trained_target" "$TRAINED_STACK" "$OUT_DIR/hunter_vs_trained_target.json"

echo "== eval mixed hunter/target league =="
run_hunter_eval "hunter_vs_mixed_candidate_stack" "$MIXED_STACK" "$OUT_DIR/hunter_vs_mixed_candidate_stack.json"

node --input-type=module - "$OUT_DIR" "$SOURCE_STACK" "$TRAINED_STACK" "$MIXED_STACK" "$MINE_ROLE_REGEX" <<'NODE'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [outDir, sourceStack, trainedStack, mixedStack, roleRegex] = process.argv.slice(2);
const read = (name) => JSON.parse(readFileSync(`${outDir}/${name}`, 'utf8'));
const readOptional = (name) => existsSync(`${outDir}/${name}`) ? read(name) : null;
const metric = (row) => ({
  vp: row.planner_VP_avg,
  winPct: row.planner_win_pct,
  reach30Pct: row.planner_reach30_pct,
  fieldBestVp: row.field_bestVP_avg,
  pvpVp: row.planner_pvp_vp_per_game,
  pvpAttacks: row.planner_pvp_attacks_per_game,
  pvpTargetVp: row.planner_pvp_target_vp_per_game,
  pvpBestTargetVp: row.planner_pvp_best_target_vp,
  pvpHighValueOpportunities: row.planner_pvp_high_value_opportunities_per_game,
  hardMonsterPvpVp: row.planner_pvp_hard_monster_vp_per_game,
  hardMonsterPvpAttacks: row.planner_pvp_hard_monster_attacks_per_game,
  hardMonsterPvpOpportunities: row.planner_pvp_hard_monster_opportunities_per_game,
  missedHardMonsterPvpPct: row.planner_missed_pvp_hard_monster_opportunity_pct,
  goodPivotVp: row.planner_pvp_good_target_pivot_vp_per_game,
  goodPivotAttacks: row.planner_pvp_good_target_pivot_attacks_per_game,
  goodPivotOpportunities: row.planner_pvp_good_target_pivot_opportunities_per_game,
  goodPivotBestTargetVp: row.planner_pvp_good_target_pivot_best_target_vp,
  missedGoodPivotPct: row.planner_missed_pvp_good_target_pivot_opportunity_pct,
  targetCombats: row.planner_pvp_target_combats_per_game,
  vpConcededShare: row.planner_pvp_vp_conceded_share_per_game,
  missedPvpPct: row.planner_missed_pvp_opportunity_pct,
  statusCapViolations: row.planner_status_cap_violations,
  roleStats: row.roleStats
});
const mining = read('mining_eval.json');
const contrastMeta = read('samples/contrast/meta.json');
const lowTailMeta = readOptional('samples/low_tail/meta.json');
const hunterSource = read('hunter_vs_source_stack.json');
const trainedTarget = read('trained_target_field.json');
const hunterTrained = read('hunter_vs_trained_target.json');
const hunterMixed = read('hunter_vs_mixed_candidate_stack.json');
const hunterTrainedCandidate = hunterTrained.roleStats?.['resilient-goodbuilder-candidate'] ?? null;
const hunterMixedCandidate = hunterMixed.roleStats?.['resilient-goodbuilder-candidate'] ?? null;
const summary = {
  outDir,
  sourceStack,
  trainedStack,
  mixedStack,
  roleRegex,
  contrastData: {
    samples: contrastMeta.samples,
    games: contrastMeta.games,
    successGames: mining.route_success_games,
    nearMissGames: mining.route_near_miss_games,
    lowTailGames: mining.route_low_tail_games,
    pressureFailGames: mining.route_pressure_fail_games,
    successSamples: mining.route_success_samples,
    nearMissSamples: mining.route_near_miss_samples,
    lowTailSamples: mining.route_low_tail_samples,
    pressureFailSamples: mining.route_pressure_fail_samples,
    maxConcededShare: mining.route_sample_max_conceded_share,
    pressurePenalty: mining.route_sample_pressure_penalty,
    pressureScale: mining.route_sample_pressure_scale,
    pressureFailLowTail: mining.route_sample_pressure_fail_low_tail,
    lowTailMeta
  },
  mining: metric(mining),
  hunterVsSourceStack: metric(hunterSource),
  trainedTargetField: metric(trainedTarget),
  hunterVsTrainedTarget: metric(hunterTrained),
  hunterVsMixedCandidateStack: metric(hunterMixed),
  trainedCandidateUnderHunterPressure: hunterTrainedCandidate,
  trainedCandidateUnderMixedPressure: hunterMixedCandidate,
  verdict: {
    trainedTargetImprovesOwnVp: trainedTarget.planner_VP_avg > 7.83,
    trainedTargetImprovesOwnFieldBest: trainedTarget.field_bestVP_avg > 7.83,
    trainedTargetKeepsStatusCap: trainedTarget.planner_max_status <= 2 && trainedTarget.planner_status_cap_violations === 0,
    trainedTargetCreatesHighValueWindows:
      hunterTrained.planner_pvp_high_value_opportunities_per_game > hunterSource.planner_pvp_high_value_opportunities_per_game,
    trainedTargetResistsFarming:
      (hunterTrainedCandidate?.pvp_vp_conceded_share_per_seat ?? Infinity) <
      8.46,
    trainedTargetResistsMixedFarming:
      (hunterMixedCandidate?.pvp_vp_conceded_share_per_seat ?? Infinity) <
      8.46,
    promotable: false
  }
};
writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
NODE

echo "DONE $OUT_DIR"
