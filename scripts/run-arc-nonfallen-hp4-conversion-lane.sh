#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN_ID="${RUN_ID:-nonfallen-hp4-conversion-fixed-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="ml/meta_runs/$RUN_ID"
DATA_DIR="$OUT_DIR/data"
TRAIN_DIR="$OUT_DIR/train"
LOG_DIR="$OUT_DIR/logs"

GPU="${GPU:-4}"
MIN_FREE_MB="${MIN_FREE_MB:-10000}"

TRACE_GAMES="${TRACE_GAMES:-8}"
TRACE_MAX_WINDOWS="${TRACE_MAX_WINDOWS:-48}"
TRACE_ITERS="${TRACE_ITERS:-32}"
TRACE_PLANNER_HORIZON="${TRACE_PLANNER_HORIZON:-20}"
TRACE_HORIZONS="${TRACE_HORIZONS:-4,8,12}"
TRACE_LABEL_HORIZON="${TRACE_LABEL_HORIZON:-8}"
TRACE_PROGRESS_EVERY="${TRACE_PROGRESS_EVERY:-1}"
TRACE_MIN_ROUND="${TRACE_MIN_ROUND:-5}"
TRACE_MIN_PLAYER_VP="${TRACE_MIN_PLAYER_VP:-6}"
TRACE_MAX_PLAYER_VP="${TRACE_MAX_PLAYER_VP:-20}"
TRACE_MIN_MONSTER_HP="${TRACE_MIN_MONSTER_HP:-4}"
TRACE_MAX_CLEAN_KILL_PROB="${TRACE_MAX_CLEAN_KILL_PROB:-0.5}"
TRACE_MAX_FIREPOWER_KILL_PROB="${TRACE_MAX_FIREPOWER_KILL_PROB:-}"
TRACE_LABEL_SCORE_THRESHOLD="${TRACE_LABEL_SCORE_THRESHOLD:-0.25}"
TRACE_LABEL_VP_THRESHOLD="${TRACE_LABEL_VP_THRESHOLD:-0}"
TRACE_LABEL_STATUS_TOLERANCE="${TRACE_LABEL_STATUS_TOLERANCE:-2}"
TRACE_SAMPLE_MODE="${TRACE_SAMPLE_MODE:-both}"
TRACE_FULL_SAMPLE_TYPES="${TRACE_FULL_SAMPLE_TYPES:-resolveLocationInteraction,spawnHandSpirit,takeSpirit,replaceSpirit,startCombat,resolveMonsterReward,resolveDecision,resolveAwakenReward}"
TRACE_SCRIPTS="${TRACE_SCRIPTS:-policy,abyss-probe,restore-loop,max-barrier-loop,damage-assembly,hp4-survival-oracle,fixed-reentry}"
TRACE_MICRO_GATE="${TRACE_MICRO_GATE:-good-builder-hp4-scorefloor-oracle}"

TRAIN="${TRAIN:-1}"
MIN_TRAIN_SAMPLES="${MIN_TRAIN_SAMPLES:-32}"
TRAIN_SAMPLE_FILTER="${TRAIN_SAMPLE_FILTER:-all}"
TRAIN_EPOCHS="${TRAIN_EPOCHS:-8}"
TRAIN_BATCH="${TRAIN_BATCH:-512}"
TRAIN_LR="${TRAIN_LR:-0.001}"
TRAIN_VALUE_COEF="${TRAIN_VALUE_COEF:-0.5}"

EVAL_GAMES="${EVAL_GAMES:-8}"
EVAL_ITERS="${EVAL_ITERS:-64}"
EVAL_HORIZON="${EVAL_HORIZON:-24}"
EVAL_PROGRESS_EVERY="${EVAL_PROGRESS_EVERY:-2}"

TARGET_WEIGHTS="${TARGET_WEIGHTS:-ml/meta_runs/allseat-goodbuilder-medium-20260630Tgoal/allseat_goodbuilder_policy.json}"
TARGET_NAV_WEIGHTS="${TARGET_NAV_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/nav_build_policy.json}"
TARGET_NAV_GATE="${TARGET_NAV_GATE:-good-nonfallen-score-floor}"
TARGET_STATUS_CAP="${TARGET_STATUS_CAP:-2}"
TARGET_FORBID_TYPES="${TARGET_FORBID_TYPES:-initiatePvp}"
TARGET_FIELD_MODE="${TARGET_FIELD_MODE:-cloned}"
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

TRAINED_WEIGHTS="$OUT_DIR/nonfallen_hp4_conversion_policy.json"
TARGET_STACK="$OUT_DIR/nonfallen_hp4_conversion_targets.json"
MIXED_STACK="$OUT_DIR/nonfallen_hp4_conversion_mixed.json"

mkdir -p "$OUT_DIR" "$DATA_DIR" "$TRAIN_DIR" "$LOG_DIR"

echo "== non-Fallen HP4 conversion lane =="
echo "run_id=$RUN_ID out_dir=$OUT_DIR"
echo "trace_games=$TRACE_GAMES max_windows=$TRACE_MAX_WINDOWS train=$TRAIN eval_games=$EVAL_GAMES"
echo "train_sample_filter=$TRAIN_SAMPLE_FILTER min_train_samples=$MIN_TRAIN_SAMPLES"
echo "target_weights=$TARGET_WEIGHTS nav_gate=$TARGET_NAV_GATE trace_micro_gate=$TRACE_MICRO_GATE status_cap=$TARGET_STATUS_CAP field_mode=$TARGET_FIELD_MODE"

if command -v nvidia-smi >/dev/null 2>&1; then
  free_mb="$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  used_mb="$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  echo "gpu=$GPU free_mb=${free_mb:-unknown} used_mb=${used_mb:-unknown} min_free_mb=$MIN_FREE_MB"
  if [[ -n "${free_mb:-}" && "$free_mb" -lt "$MIN_FREE_MB" ]]; then
    echo "refusing HP4 conversion lane: GPU $GPU has ${free_mb}MB free, below MIN_FREE_MB=$MIN_FREE_MB" >&2
    exit 3
  fi
fi

echo "== collect fixed-boundary TraceQ HP4 conversion samples =="
env \
  TRACEQ=1 \
  TRACEQ_GAMES="$TRACE_GAMES" \
  TRACEQ_MAX_WINDOWS="$TRACE_MAX_WINDOWS" \
  TRACEQ_ITERS="$TRACE_ITERS" \
  TRACEQ_PLANNER_HORIZON="$TRACE_PLANNER_HORIZON" \
  TRACEQ_HORIZONS="$TRACE_HORIZONS" \
  TRACEQ_LABEL_HORIZON="$TRACE_LABEL_HORIZON" \
  TRACEQ_PROGRESS_EVERY="$TRACE_PROGRESS_EVERY" \
  TRACEQ_WEIGHTS="$TARGET_WEIGHTS" \
  TRACEQ_PATCH_NAV_WEIGHTS= \
  TRACEQ_PATCH_NAV_GATE=all \
  TRACEQ_PATCH2_NAV_WEIGHTS= \
  TRACEQ_PATCH2_NAV_GATE=all \
  TRACEQ_SCALE_NAV_WEIGHTS= \
  TRACEQ_SCALE_NAV_GATE=all \
  TRACEQ_NAV_WEIGHTS="$TARGET_NAV_WEIGHTS" \
  TRACEQ_NAV_GATE="$TARGET_NAV_GATE" \
  TRACEQ_MICRO_WEIGHTS="$TARGET_WEIGHTS" \
  TRACEQ_MICRO_GATE="$TRACE_MICRO_GATE" \
  TRACEQ_FORBID_TYPES="$TARGET_FORBID_TYPES" \
  TRACEQ_MAX_STATUS_LEVEL="$TARGET_STATUS_CAP" \
  TRACEQ_PRESERVE_ROUTE_FIREPOWER=1 \
  TRACEQ_PRESERVE_ROUTE_SURVIVAL=1 \
  TRACEQ_MIN_SOURCE_VP=0 \
  TRACEQ_MAX_SOURCE_VP=24 \
  TRACEQ_MIN_PLAYER_VP="$TRACE_MIN_PLAYER_VP" \
  TRACEQ_MAX_PLAYER_VP="$TRACE_MAX_PLAYER_VP" \
  TRACEQ_MIN_ROUND="$TRACE_MIN_ROUND" \
  TRACEQ_MIN_MONSTER_HP="$TRACE_MIN_MONSTER_HP" \
  TRACEQ_MAX_CLEAN_KILL_PROB="$TRACE_MAX_CLEAN_KILL_PROB" \
  TRACEQ_MAX_FIREPOWER_KILL_PROB="$TRACE_MAX_FIREPOWER_KILL_PROB" \
  TRACEQ_SCRIPTS="$TRACE_SCRIPTS" \
  TRACEQ_SAMPLE_MODE="$TRACE_SAMPLE_MODE" \
  TRACEQ_FULL_SAMPLE_TYPES="$TRACE_FULL_SAMPLE_TYPES" \
  TRACEQ_POSITIVE_ONLY_DATA=1 \
  TRACEQ_LABEL_SCORE_THRESHOLD="$TRACE_LABEL_SCORE_THRESHOLD" \
  TRACEQ_LABEL_VP_THRESHOLD="$TRACE_LABEL_VP_THRESHOLD" \
  TRACEQ_LABEL_STATUS_TOLERANCE="$TRACE_LABEL_STATUS_TOLERANCE" \
  TRACEQ_SCORE_REACH30_BONUS=12 \
  TRACEQ_SCORE_VP_WEIGHT=1 \
  TRACEQ_SCORE_KILL_WEIGHT=0.5 \
  TRACEQ_SCORE_CLEAN_OPPORTUNITY_WEIGHT=2 \
  TRACEQ_SCORE_FIREPOWER_OPPORTUNITY_WEIGHT=0.5 \
  TRACEQ_SCORE_EXPECTED_ATTACK_WEIGHT=1.2 \
  TRACEQ_SCORE_ATTACK_DICE_WEIGHT=0.8 \
  TRACEQ_SCORE_SPIRIT_ANIMAL_WEIGHT=0.8 \
  TRACEQ_SCORE_CULTIVATOR_WEIGHT=0.4 \
  TRACEQ_SCORE_BARRIER_WEIGHT=0.4 \
  TRACEQ_SCORE_CURRENT_BARRIER_WEIGHT=1 \
  TRACEQ_SCORE_STATUS_PENALTY=2 \
  TRACEQ_OUT="$OUT_DIR/tracestateq.json" \
  TRACEQ_SUMMARY="$OUT_DIR/traceq_summary.json" \
  TRACEQ_DATA_OUT="$DATA_DIR/traceq.jsonl" \
  npx vitest run src/lib/play/ml/_tracestatecounterfactual.test.ts --disable-console-intercept \
  2>&1 | tee "$LOG_DIR/traceq.log"

sample_count=0
if [[ -f "$DATA_DIR/traceq.jsonl" ]]; then
  sample_count="$(wc -l < "$DATA_DIR/traceq.jsonl" | tr -d ' ')"
fi
echo "traceq_samples=$sample_count" | tee "$LOG_DIR/samples.log"

if [[ "$TRAIN" == "1" ]]; then
  cp "$DATA_DIR/traceq.jsonl" "$TRAIN_DIR/traceq.samples.jsonl"
  if [[ "$TRAIN_SAMPLE_FILTER" != "all" ]]; then
    node --input-type=module - "$TRAIN_SAMPLE_FILTER" "$DATA_DIR/traceq.jsonl" "$TRAIN_DIR/traceq.samples.jsonl" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [filter, input, output] = process.argv.slice(2);
const commandVocab = [
  'lockNavigation',
  'selectNavigationDestination',
  'resolveLocationInteraction',
  'endLocationActions',
  'spawnHandSpirit',
  'discardHandDraws',
  'redrawHandDraws',
  'startCombat',
  'resolveMonsterReward',
  'initiatePvp',
  'passEncounter',
  'takeSpirit',
  'replaceSpirit',
  'absorbSpirit',
  'refillMarket',
  'awakenSpirit',
  'manualAwaken',
  'resolveDecision',
  'placeAugmentOnSpirit',
  'resolveAwakenReward',
  'discardSpirit',
  'discardRune',
  'commitBenefits',
  'commitAwakening',
  'commitCleanup',
  'commitRound',
  'flipSpirit',
  'forceAdvancePhase'
];
const commandSlots = commandVocab.length;
const actionParamSlots = 12;
const effectOffset = commandSlots + actionParamSlots;

function chosenAction(sample) {
  const action = sample.cands?.[sample.chosen];
  if (!Array.isArray(action)) return undefined;
  const commandIndex = action.slice(0, commandSlots).findIndex((value) => value === 1);
  const type = commandVocab[commandIndex];
  return {
    type,
    deltaVp: action[effectOffset + 1] ?? 0,
    deltaDice: action[effectOffset + 2] ?? 0,
    deltaBarrier: action[effectOffset + 3] ?? 0,
    deltaPendingRewardVp: action[effectOffset + 7] ?? 0,
    monsterProgress: action[effectOffset + 10] ?? 0
  };
}

function keep(sample) {
  const action = chosenAction(sample);
  if (!action?.type) return false;
  if (filter === 'cash-reentry') {
    return action.type === 'lockNavigation' || action.type === 'startCombat' || action.type === 'resolveMonsterReward';
  }
  if (filter === 'cash-restore-reentry') {
    return (
      action.type === 'lockNavigation' ||
      action.type === 'startCombat' ||
      action.type === 'resolveMonsterReward' ||
      (action.type === 'resolveLocationInteraction' && action.deltaBarrier > 0)
    );
  }
  if (filter === 'combat-reward') {
    return action.type === 'startCombat' || action.type === 'resolveMonsterReward';
  }
  if (filter === 'progress-only') {
    return (
      action.deltaVp > 0 ||
      action.deltaPendingRewardVp > 0 ||
      action.monsterProgress > 0 ||
      action.deltaDice > 0 ||
      action.deltaBarrier > 0
    );
  }
  throw new Error(`unknown TRAIN_SAMPLE_FILTER=${filter}`);
}

const lines = readFileSync(input, 'utf8').split('\n').filter((line) => line.trim());
const kept = [];
for (const line of lines) {
  const sample = JSON.parse(line);
  if (keep(sample)) kept.push(JSON.stringify(sample));
}
writeFileSync(output, kept.join('\n') + (kept.length ? '\n' : ''));
console.log(`filtered TraceQ samples: ${kept.length}/${lines.length} (${filter})`);
NODE
  fi
  train_sample_count=0
  if [[ -f "$TRAIN_DIR/traceq.samples.jsonl" ]]; then
    train_sample_count="$(wc -l < "$TRAIN_DIR/traceq.samples.jsonl" | tr -d ' ')"
  fi
  if [[ "$train_sample_count" -lt "$MIN_TRAIN_SAMPLES" ]]; then
    echo "refusing train: train_samples=$train_sample_count < MIN_TRAIN_SAMPLES=$MIN_TRAIN_SAMPLES (raw_samples=$sample_count filter=$TRAIN_SAMPLE_FILTER)" >&2
    exit 4
  fi
  echo "== train fixed-boundary HP4 conversion overlay =="
  CUDA_VISIBLE_DEVICES="$GPU" \
    ml/.venv/bin/python ml/train.py \
    --data "$TRAIN_DIR" \
    --out "$TRAINED_WEIGHTS" \
    --init-from "$TARGET_WEIGHTS" \
    --mode alphazero \
    --epochs "$TRAIN_EPOCHS" \
    --batch-size "$TRAIN_BATCH" \
    --lr "$TRAIN_LR" \
    --value-coef "$TRAIN_VALUE_COEF" \
    2>&1 | tee "$LOG_DIR/train.log"
else
  TRAINED_WEIGHTS="${TRAINED_WEIGHTS_OVERRIDE:-$TARGET_WEIGHTS}"
fi

node --input-type=module - "$TRAINED_WEIGHTS" "$TARGET_WEIGHTS" "$TARGET_NAV_WEIGHTS" "$TARGET_NAV_GATE" "$TARGET_STATUS_CAP" "$TARGET_FORBID_TYPES" "$TARGET_FIELD_MODE" "$SUPPORT_A_WEIGHTS" "$SUPPORT_B_WEIGHTS" "$SUPPORT_NAV_WEIGHTS" "$SUPPORT_NAV_GATE" "$TARGET_STACK" "$MIXED_STACK" <<'NODE'
import { writeFileSync } from 'node:fs';

const [
  microWeights,
  baseWeights,
  navWeights,
  navigationPolicyGate,
  statusCapRaw,
  forbidCsv,
  fieldMode,
  supportAWeights,
  supportBWeights,
  supportNavWeights,
  supportNavGate,
  targetOut,
  mixedOut
] = process.argv.slice(2);
const forbidTypes = forbidCsv.split(',').map((s) => s.trim()).filter(Boolean);
const target = (suffix = '') => ({
  name: `nonfallen-hp4-fixed-overlay${suffix}`,
  weights: baseWeights,
  microWeights,
  microPolicyGate: 'good-builder-hp4-conversion-overlay',
  navWeights,
  navigationPolicyGate,
  maxStatusLevel: Number(statusCapRaw),
  forbidTypes,
  preserveRouteFirepower: true,
  preserveRouteSurvival: true,
  goodTargetActionDiscipline: true
});
const support = (name, weights) => ({
  name,
  weights,
  navWeights: supportNavWeights,
  navigationPolicyGate: supportNavGate,
  maxStatusLevel: Number(statusCapRaw),
  forbidTypes,
  preserveRouteFirepower: true,
  preserveRouteSurvival: true,
  goodTargetActionDiscipline: true
});
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
const supportA = support('nonfallen-noncontest-support-a', supportAWeights);
const supportB = support('nonfallen-noncontest-support-b', supportBWeights);
const targetStack = fieldMode === 'scorefloor-carry-support'
  ? [target(''), supportA, supportB]
  : [target('-a'), target('-b'), target('-c')];
const mixedStack = fieldMode === 'scorefloor-carry-support'
  ? [currentHunter, status2Hunter, target(''), supportA]
  : [currentHunter, status2Hunter, target('-a'), target('-b')];
writeFileSync(targetOut, JSON.stringify(targetStack, null, 2) + '\n');
writeFileSync(mixedOut, JSON.stringify(mixedStack, null, 2) + '\n');
NODE

run_target_eval() {
  local out="$1"
  env \
    AZEVAL=1 \
    AZEVAL_GAMES="$EVAL_GAMES" \
    AZEVAL_ITERS="$EVAL_ITERS" \
    AZEVAL_HORIZON="$EVAL_HORIZON" \
    AZEVAL_PROGRESS_EVERY="$EVAL_PROGRESS_EVERY" \
    AZEVAL_CONTROL=full \
    AZEVAL_FULL_SELECTION=value \
    AZEVAL_VALUEW=1 \
    AZEVAL_WEIGHTS="$TARGET_WEIGHTS" \
    AZEVAL_MICRO_WEIGHTS="$TRAINED_WEIGHTS" \
    AZEVAL_MICRO_GATE=good-builder-hp4-conversion-overlay \
    AZEVAL_NAV_WEIGHTS="$TARGET_NAV_WEIGHTS" \
    AZEVAL_NAV_GATE="$TARGET_NAV_GATE" \
    AZEVAL_MAX_STATUS_LEVEL="$TARGET_STATUS_CAP" \
    AZEVAL_FORBID_TYPES="$TARGET_FORBID_TYPES" \
    AZEVAL_HARD_CONSTRAINTS=1 \
    AZEVAL_PRESERVE_ROUTE_FIREPOWER=1 \
    AZEVAL_PRESERVE_ROUTE_SURVIVAL=1 \
    AZEVAL_GOOD_TARGET_ACTION_DISCIPLINE=1 \
    AZEVAL_NEURAL_FIELD=1 \
    AZEVAL_NEURAL_FIELD_STACKS_FILE="$TARGET_STACK" \
    AZEVAL_OUT="$out" \
    npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
    2>&1 | tee "$LOG_DIR/$(basename "$out" .json).log"
}

run_hunter_eval() {
  local stack="$1"
  local out="$2"
  env \
    ARC_PVP_REBUILD_MIN_ROUND=14 \
    ARC_PVP_REBUILD_SKIP_TARGET_VP=12 \
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
    2>&1 | tee "$LOG_DIR/$(basename "$out" .json).log"
}

echo "== eval fixed overlay target field =="
run_target_eval "$OUT_DIR/target_field.json"

echo "== eval hunter vs fixed overlay targets =="
run_hunter_eval "$TARGET_STACK" "$OUT_DIR/hunter_vs_target.json"

echo "== eval mixed hunter/fixed-overlay league =="
run_hunter_eval "$MIXED_STACK" "$OUT_DIR/hunter_vs_mixed.json"

node --input-type=module - "$OUT_DIR" "$sample_count" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const [outDir, sampleCountRaw] = process.argv.slice(2);
const read = (name) => JSON.parse(readFileSync(`${outDir}/${name}`, 'utf8'));
const traceq = read('traceq_summary.json');
const target = read('target_field.json');
const hunterTarget = read('hunter_vs_target.json');
const hunterMixed = read('hunter_vs_mixed.json');
const metric = (row) => ({
  vp: row.planner_VP_avg,
  winPct: row.planner_win_pct,
  reach30Pct: row.planner_reach30_pct,
  status: row.planner_status_avg,
  maxStatus: row.planner_max_status,
  statusCapViolations: row.planner_status_cap_violations,
  fieldBestVp: row.field_bestVP_avg,
  kills: row.planner_monster_kills_per_game,
  abyssNavs: row.planner_abyss_navs_per_game,
  pvpVp: row.planner_pvp_vp_per_game,
  pvpAttacks: row.planner_pvp_attacks_per_game,
  hp4PvpVp: row.planner_pvp_hard_monster_vp_per_game,
  hp4PvpAttacks: row.planner_pvp_hard_monster_attacks_per_game,
  goodPivotVp: row.planner_pvp_good_target_pivot_vp_per_game,
  goodPivotAttacks: row.planner_pvp_good_target_pivot_attacks_per_game,
  goodPivotBestTargetVp: row.planner_pvp_good_target_pivot_best_target_vp,
  highValueWindows: row.planner_pvp_high_value_opportunities_per_game,
  roleStats: row.roleStats
});
const summary = {
  outDir,
  targetFieldMode: process.env.TARGET_FIELD_MODE ?? 'cloned',
  generatedAt: new Date().toISOString(),
  traceq: {
    windows: traceq.windows,
    corrections: traceq.corrections,
    correctionPct: traceq.correctionPct,
    samples: Number(sampleCountRaw),
    avgDeltaVp: traceq.avgDeltaVp,
    avgCorrectionDeltaVp: traceq.avgCorrectionDeltaVp,
    navigationSampleDestinations: traceq.navigationSampleDestinations,
    correctionScripts: traceq.correctionScripts,
    bestScripts: traceq.bestScripts
  },
  targetField: metric(target),
  hunterVsTarget: metric(hunterTarget),
  hunterVsMixed: metric(hunterMixed),
  baselines: {
    fixedDualTargetVp: 12.0,
    fixedDualMixedVp: 18.38,
    fixedDualMixedHp4PvpVp: 9.75,
    fixedDualMixedGoodPivotVp: 1.13,
    fixedDualMixedBestGoodTarget: 16,
    valuableGoodTargetVp: 18,
    hp4PickOracleTargetVp: 10.25
  }
};
summary.verdict = {
  generatedSamples: summary.traceq.samples >= 32,
  traceqFoundCorrections: summary.traceq.corrections > 0,
  targetBeatsHp4PickOracle: summary.targetField.vp > summary.baselines.hp4PickOracleTargetVp,
  targetImprovesFixedDualTarget: summary.targetField.vp > summary.baselines.fixedDualTargetVp,
  mixedImprovesFixedDualVp: summary.hunterVsMixed.vp > summary.baselines.fixedDualMixedVp,
  mixedImprovesFixedDualHp4Pvp: summary.hunterVsMixed.hp4PvpVp > summary.baselines.fixedDualMixedHp4PvpVp,
  mixedImprovesFixedDualGoodPivot: summary.hunterVsMixed.goodPivotVp > summary.baselines.fixedDualMixedGoodPivotVp,
  mixedFindsValuableGood: summary.hunterVsMixed.goodPivotBestTargetVp >= summary.baselines.valuableGoodTargetVp,
  candidateKeepsNonFallen: summary.targetField.maxStatus <= 2 && summary.targetField.statusCapViolations === 0,
  promotable: false
};
writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
NODE

echo "DONE -> $OUT_DIR/summary.json"
