#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN_ID="${RUN_ID:-pvp-pivot-curriculum-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="ml/meta_runs/$RUN_ID"
DATA_DIR="$OUT_DIR/data"
TRAIN_DIR="$OUT_DIR/train"
LOG_DIR="$OUT_DIR/logs"

GPU="${GPU:-4}"
MIN_FREE_MB="${MIN_FREE_MB:-10000}"

CURRICULUM_GAMES="${CURRICULUM_GAMES:-8}"
CURRICULUM_SEATS="${CURRICULUM_SEATS:-4}"
CURRICULUM_MAX_ROUNDS="${CURRICULUM_MAX_ROUNDS:-30}"
CURRICULUM_PROFILES="${CURRICULUM_PROFILES:-pvphunter,medium,cultivator,survivor}"
CURRICULUM_RECORD_PROFILE="${CURRICULUM_RECORD_PROFILE:-pvphunter}"
CURRICULUM_MIN_DESCEND_ROUND="${CURRICULUM_MIN_DESCEND_ROUND:-6}"
CURRICULUM_PIVOT_MIN_ROUND="${CURRICULUM_PIVOT_MIN_ROUND:-10}"
CURRICULUM_PIVOT_MIN_VP="${CURRICULUM_PIVOT_MIN_VP:-18}"
CURRICULUM_PIVOT_MONSTER_HP="${CURRICULUM_PIVOT_MONSTER_HP:-4}"
CURRICULUM_PRESERVE_FARM_VP="${CURRICULUM_PRESERVE_FARM_VP:-2}"
CURRICULUM_PREDICTIVE_HUNT="${CURRICULUM_PREDICTIVE_HUNT:-1}"
CURRICULUM_CONTRAST_FARM_RETURN="${CURRICULUM_CONTRAST_FARM_RETURN:-1}"
CURRICULUM_POLICY_WEIGHT="${CURRICULUM_POLICY_WEIGHT:-4}"
MIN_CURRICULUM_SAMPLES="${MIN_CURRICULUM_SAMPLES:-64}"

TRAIN="${TRAIN:-1}"
TRAIN_SAMPLE_FILTER="${TRAIN_SAMPLE_FILTER:-all}"
MIN_TRAIN_SAMPLES="${MIN_TRAIN_SAMPLES:-$MIN_CURRICULUM_SAMPLES}"
TRAIN_EPOCHS="${TRAIN_EPOCHS:-12}"
TRAIN_BATCH="${TRAIN_BATCH:-512}"
TRAIN_LR="${TRAIN_LR:-0.0007}"
TRAIN_VALUE_COEF="${TRAIN_VALUE_COEF:-0.5}"
TRAIN_ROUTE_MODE_COEF="${TRAIN_ROUTE_MODE_COEF:-0.35}"
TRAIN_FARM_VALUE_COEF="${TRAIN_FARM_VALUE_COEF:-0.15}"
TRAIN_REWARD_PICK_COEF="${TRAIN_REWARD_PICK_COEF:-0.1}"

EVAL_GAMES="${EVAL_GAMES:-8}"
EVAL_ITERS="${EVAL_ITERS:-64}"
EVAL_HORIZON="${EVAL_HORIZON:-24}"
EVAL_PROGRESS_EVERY="${EVAL_PROGRESS_EVERY:-2}"

BASE_WEIGHTS="${BASE_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/best_policy.full.json}"
BASE_PATCH_WEIGHTS="${BASE_PATCH_WEIGHTS:-ml/meta_runs/pvp-route-mode-20260630T124558Z/pvp_route_mode_head_policy.json}"
BASE_MICRO_WEIGHTS="${BASE_MICRO_WEIGHTS:-$BASE_PATCH_WEIGHTS}"
PVP_PATCH_GATE="${PVP_PATCH_GATE:-pvp-predictive-mode-hunt-fallback-rebuild-pivot}"
PVP_MICRO_GATE="${PVP_MICRO_GATE:-pvp-pivot-encounter-force}"
PVP_ORACLE="${PVP_ORACLE:-status2-conversion-descend}"
ROLE_STACK="${ROLE_STACK:-ml/stacks/league-current-goodbuilder-scorefloor-conversion-hunter.json}"

TARGET_WEIGHTS="${TARGET_WEIGHTS:-ml/meta_runs/allseat-goodbuilder-medium-20260630Tgoal/allseat_goodbuilder_policy.json}"
TARGET_NAV_WEIGHTS="${TARGET_NAV_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/nav_build_policy.json}"
TARGET_NAV_GATE="${TARGET_NAV_GATE:-good-nonfallen-score-floor}"
TARGET_MICRO_WEIGHTS="${TARGET_MICRO_WEIGHTS:-ml/meta_runs/nonfallen-hp4-conversion-scorefloor-cashrestore-20260701Tremote/nonfallen_hp4_conversion_policy.json}"
TARGET_MICRO_GATE="${TARGET_MICRO_GATE:-good-builder-hp4-conversion-overlay}"
TARGET_STATUS_CAP="${TARGET_STATUS_CAP:-2}"
TARGET_FORBID_TYPES="${TARGET_FORBID_TYPES:-initiatePvp}"

ARC_PVP_REBUILD_MIN_ROUND="${ARC_PVP_REBUILD_MIN_ROUND:-14}"
ARC_PVP_REBUILD_SKIP_TARGET_VP="${ARC_PVP_REBUILD_SKIP_TARGET_VP:-12}"
ARC_PVP_GOOD_TARGET_PIVOT_MIN_TARGET_VP="${ARC_PVP_GOOD_TARGET_PIVOT_MIN_TARGET_VP:-9}"
ARC_PVP_STATUS2_DESCEND_MIN_TARGET_VP="${ARC_PVP_STATUS2_DESCEND_MIN_TARGET_VP:-9}"
ARC_PVP_FORCE_HIGH_VALUE_TARGET_VP="${ARC_PVP_FORCE_HIGH_VALUE_TARGET_VP:-18}"
ARC_PVP_LOW_TAIL_HUNT_MAX_VP="${ARC_PVP_LOW_TAIL_HUNT_MAX_VP:-24}"
ARC_PVP_LOW_TAIL_HUNT_MIN_ROUND="${ARC_PVP_LOW_TAIL_HUNT_MIN_ROUND:-10}"
ARC_PVP_LOW_TAIL_HUNT_MIN_MONSTER_HP="${ARC_PVP_LOW_TAIL_HUNT_MIN_MONSTER_HP:-4}"
ARC_PVP_LOW_TAIL_HUNT_MIN_TARGET_VP="${ARC_PVP_LOW_TAIL_HUNT_MIN_TARGET_VP:-0}"

TRAINED_WEIGHTS="$OUT_DIR/pvp_pivot_policy.json"
CURRICULUM_OUT="$DATA_DIR/pvp_pivot_curriculum.jsonl"
CURRICULUM_SUMMARY="$OUT_DIR/pvp_pivot_curriculum_summary.json"
TARGET_STACK="$OUT_DIR/scorefloor_target_stack.json"

export \
  BASE_WEIGHTS \
  BASE_PATCH_WEIGHTS \
  BASE_MICRO_WEIGHTS \
  PVP_PATCH_GATE \
  PVP_MICRO_GATE \
  PVP_ORACLE \
  ROLE_STACK \
  TARGET_WEIGHTS \
  TARGET_NAV_WEIGHTS \
  TARGET_NAV_GATE \
  TARGET_MICRO_WEIGHTS \
  TARGET_MICRO_GATE \
  TARGET_STATUS_CAP \
  TARGET_FORBID_TYPES \
  EVAL_GAMES \
  EVAL_ITERS \
  EVAL_HORIZON

mkdir -p "$OUT_DIR" "$DATA_DIR" "$TRAIN_DIR" "$LOG_DIR"

echo "== Arc PvP pivot curriculum lane =="
echo "run_id=$RUN_ID out_dir=$OUT_DIR"
echo "curriculum_games=$CURRICULUM_GAMES train=$TRAIN train_sample_filter=$TRAIN_SAMPLE_FILTER eval_games=$EVAL_GAMES gpu=$GPU"
echo "base_weights=$BASE_WEIGHTS patch_gate=$PVP_PATCH_GATE micro_gate=$PVP_MICRO_GATE oracle=$PVP_ORACLE"

if command -v nvidia-smi >/dev/null 2>&1; then
  free_mb="$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  used_mb="$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  echo "gpu=$GPU free_mb=${free_mb:-unknown} used_mb=${used_mb:-unknown} min_free_mb=$MIN_FREE_MB"
  if [[ -n "${free_mb:-}" && "$free_mb" -lt "$MIN_FREE_MB" ]]; then
    echo "refusing PvP pivot lane: GPU $GPU has ${free_mb}MB free, below MIN_FREE_MB=$MIN_FREE_MB" >&2
    exit 3
  fi
fi

echo "== generate focused PvP pivot curriculum =="
env \
  PVPPIVOTCURRICULUM=1 \
  PVPPIVOTCURRICULUM_GAMES="$CURRICULUM_GAMES" \
  PVPPIVOTCURRICULUM_SEATS="$CURRICULUM_SEATS" \
  PVPPIVOTCURRICULUM_MAXROUNDS="$CURRICULUM_MAX_ROUNDS" \
  PVPPIVOTCURRICULUM_PROFILES="$CURRICULUM_PROFILES" \
  PVPPIVOTCURRICULUM_RECORD_PROFILE="$CURRICULUM_RECORD_PROFILE" \
  PVPPIVOTCURRICULUM_MIN_DESCEND_ROUND="$CURRICULUM_MIN_DESCEND_ROUND" \
  PVPPIVOTCURRICULUM_PIVOT_MIN_ROUND="$CURRICULUM_PIVOT_MIN_ROUND" \
  PVPPIVOTCURRICULUM_PIVOT_MIN_VP="$CURRICULUM_PIVOT_MIN_VP" \
  PVPPIVOTCURRICULUM_PIVOT_MONSTER_HP="$CURRICULUM_PIVOT_MONSTER_HP" \
  PVPPIVOTCURRICULUM_PRESERVE_FARM_VP="$CURRICULUM_PRESERVE_FARM_VP" \
  PVPPIVOTCURRICULUM_PREDICTIVE_HUNT="$CURRICULUM_PREDICTIVE_HUNT" \
  PVPPIVOTCURRICULUM_CONTRAST_FARM_RETURN="$CURRICULUM_CONTRAST_FARM_RETURN" \
  PVPPIVOTCURRICULUM_POLICY_WEIGHT="$CURRICULUM_POLICY_WEIGHT" \
  PVPPIVOTCURRICULUM_DATA_DIR="$DATA_DIR" \
  PVPPIVOTCURRICULUM_OUT="$CURRICULUM_OUT" \
  PVPPIVOTCURRICULUM_SUMMARY="$CURRICULUM_SUMMARY" \
  npx vitest run src/lib/play/ml/_pvppivotcurriculum.test.ts --disable-console-intercept \
  2>&1 | tee "$LOG_DIR/pvp_pivot_curriculum.log"

sample_count=0
if [[ -f "$CURRICULUM_OUT" ]]; then
  sample_count="$(wc -l < "$CURRICULUM_OUT" | tr -d ' ')"
fi
echo "pvp_pivot_samples=$sample_count" | tee "$LOG_DIR/samples.log"
if [[ "$sample_count" -lt "$MIN_CURRICULUM_SAMPLES" ]]; then
  echo "refusing train: samples=$sample_count < MIN_CURRICULUM_SAMPLES=$MIN_CURRICULUM_SAMPLES" >&2
  exit 4
fi

if [[ "$TRAIN" == "1" ]]; then
  TRAIN_CURRICULUM_OUT="$TRAIN_DIR/pvp_pivot_curriculum.jsonl"
  cp "$DATA_DIR/meta.json" "$TRAIN_DIR/meta.json"
  node --input-type=module - "$CURRICULUM_OUT" "$TRAIN_CURRICULUM_OUT" "$TRAIN_DIR/meta.json" "$TRAIN_SAMPLE_FILTER" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output, metaPath, filter] = process.argv.slice(2);
const keepByFilter = (kind) => {
  switch (filter) {
    case 'all':
      return true;
    case 'hunt-attack':
      return kind === 'pvp-hunt-nav' || kind === 'pvp-predictive-hunt-nav' || kind === 'pvp-attack';
    case 'hunt-attack-farmreturn':
      return kind === 'pvp-hunt-nav' || kind === 'pvp-predictive-hunt-nav' || kind === 'pvp-attack' || kind === 'pvp-farm-return-nav';
    case 'late-only':
      return kind === 'pvp-descend-nav' || kind === 'pvp-descend-combat' || kind === 'pvp-farm-return-nav' || kind === 'pvp-hunt-nav' || kind === 'pvp-predictive-hunt-nav' || kind === 'pvp-attack';
    case 'no-build':
      return kind !== 'pvp-build-nav';
    default:
      throw new Error(`unknown TRAIN_SAMPLE_FILTER=${filter}`);
  }
};

let raw = 0;
let kept = 0;
const byKind = {};
const lines = [];
for (const line of readFileSync(input, 'utf8').split(/\n/)) {
  if (!line.trim()) continue;
  raw++;
  const rec = JSON.parse(line);
  const kind = typeof rec.teacherKind === 'string' ? rec.teacherKind : 'unknown';
  if (!keepByFilter(kind)) continue;
  kept++;
  byKind[kind] = (byKind[kind] ?? 0) + 1;
  lines.push(JSON.stringify(rec));
}
writeFileSync(output, lines.length ? `${lines.join('\n')}\n` : '');

const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
meta.samples = kept;
meta.trainFilter = { name: filter, rawSamples: raw, keptSamples: kept, byKind };
writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
console.log(JSON.stringify(meta.trainFilter));
NODE
  train_sample_count="$(wc -l < "$TRAIN_CURRICULUM_OUT" | tr -d ' ')"
  echo "pvp_pivot_train_samples=$train_sample_count filter=$TRAIN_SAMPLE_FILTER min=$MIN_TRAIN_SAMPLES" | tee "$LOG_DIR/train_samples.log"
  if [[ "$train_sample_count" -lt "$MIN_TRAIN_SAMPLES" ]]; then
    echo "refusing train: filtered_samples=$train_sample_count < MIN_TRAIN_SAMPLES=$MIN_TRAIN_SAMPLES" >&2
    exit 5
  fi
  export TRAIN_SAMPLE_FILTER TRAIN_SAMPLE_COUNT="$train_sample_count"
  echo "== train PvP pivot candidate =="
  CUDA_VISIBLE_DEVICES="$GPU" \
    ml/.venv/bin/python ml/train.py \
    --data "$TRAIN_DIR" \
    --out "$TRAINED_WEIGHTS" \
    --init-from "$BASE_WEIGHTS" \
    --mode alphazero \
    --epochs "$TRAIN_EPOCHS" \
    --batch-size "$TRAIN_BATCH" \
    --lr "$TRAIN_LR" \
    --value-coef "$TRAIN_VALUE_COEF" \
    --route-mode-coef "$TRAIN_ROUTE_MODE_COEF" \
    --farm-value-coef "$TRAIN_FARM_VALUE_COEF" \
    --reward-pick-coef "$TRAIN_REWARD_PICK_COEF" \
    2>&1 | tee "$LOG_DIR/train.log"
else
  TRAINED_WEIGHTS="${TRAINED_WEIGHTS_OVERRIDE:-$BASE_WEIGHTS}"
  export TRAIN_SAMPLE_FILTER TRAIN_SAMPLE_COUNT=0
fi

node --input-type=module - "$TARGET_STACK" <<'NODE'
import { writeFileSync } from 'node:fs';

const [out] = process.argv.slice(2);
const forbidTypes = (process.env.TARGET_FORBID_TYPES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const target = (name) => ({
  name,
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
});
writeFileSync(out, JSON.stringify([target('scorefloor-target-a'), target('scorefloor-target-b'), target('scorefloor-target-c')], null, 2) + '\n');
NODE

run_eval() {
  local label="$1"
  local weights="$2"
  local patch_weights="$3"
  local micro_weights="$4"
  local stack="$5"
  local out="$OUT_DIR/${label}.json"
  echo "== eval: $label =="
  env \
    CUDA_VISIBLE_DEVICES="$GPU" \
    ARC_PVP_REBUILD_MIN_ROUND="$ARC_PVP_REBUILD_MIN_ROUND" \
    ARC_PVP_REBUILD_SKIP_TARGET_VP="$ARC_PVP_REBUILD_SKIP_TARGET_VP" \
    ARC_PVP_GOOD_TARGET_PIVOT_MIN_TARGET_VP="$ARC_PVP_GOOD_TARGET_PIVOT_MIN_TARGET_VP" \
    ARC_PVP_STATUS2_DESCEND_MIN_TARGET_VP="$ARC_PVP_STATUS2_DESCEND_MIN_TARGET_VP" \
    ARC_PVP_FORCE_HIGH_VALUE_TARGET_VP="$ARC_PVP_FORCE_HIGH_VALUE_TARGET_VP" \
    ARC_PVP_LOW_TAIL_HUNT_MAX_VP="$ARC_PVP_LOW_TAIL_HUNT_MAX_VP" \
    ARC_PVP_LOW_TAIL_HUNT_MIN_ROUND="$ARC_PVP_LOW_TAIL_HUNT_MIN_ROUND" \
    ARC_PVP_LOW_TAIL_HUNT_MIN_MONSTER_HP="$ARC_PVP_LOW_TAIL_HUNT_MIN_MONSTER_HP" \
    ARC_PVP_LOW_TAIL_HUNT_MIN_TARGET_VP="$ARC_PVP_LOW_TAIL_HUNT_MIN_TARGET_VP" \
    AZEVAL=1 \
    AZEVAL_GAMES="$EVAL_GAMES" \
    AZEVAL_ITERS="$EVAL_ITERS" \
    AZEVAL_HORIZON="$EVAL_HORIZON" \
    AZEVAL_PROGRESS_EVERY="$EVAL_PROGRESS_EVERY" \
    AZEVAL_CONTROL=full \
    AZEVAL_FULL_SELECTION=value \
    AZEVAL_VALUEW=1 \
    AZEVAL_WEIGHTS="$weights" \
    AZEVAL_PATCH_NAV_WEIGHTS="$patch_weights" \
    AZEVAL_PATCH_NAV_GATE="$PVP_PATCH_GATE" \
    AZEVAL_MICRO_WEIGHTS="$micro_weights" \
    AZEVAL_MICRO_GATE="$PVP_MICRO_GATE" \
    AZEVAL_PVP_PIVOT_ORACLE="$PVP_ORACLE" \
    AZEVAL_PLANNER_ROLE_NAME="$label" \
    AZEVAL_NEURAL_FIELD=1 \
    AZEVAL_NEURAL_FIELD_STACKS_FILE="$stack" \
    AZEVAL_OUT="$out" \
    npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
    2>&1 | tee "$LOG_DIR/${label}.log"
}

run_eval "baseline_vs_role_stack" "$BASE_WEIGHTS" "$BASE_PATCH_WEIGHTS" "$BASE_MICRO_WEIGHTS" "$ROLE_STACK"
run_eval "candidate_vs_role_stack" "$TRAINED_WEIGHTS" "$TRAINED_WEIGHTS" "$TRAINED_WEIGHTS" "$ROLE_STACK"
run_eval "baseline_vs_scorefloor_targets" "$BASE_WEIGHTS" "$BASE_PATCH_WEIGHTS" "$BASE_MICRO_WEIGHTS" "$TARGET_STACK"
run_eval "candidate_vs_scorefloor_targets" "$TRAINED_WEIGHTS" "$TRAINED_WEIGHTS" "$TRAINED_WEIGHTS" "$TARGET_STACK"

node --input-type=module - "$OUT_DIR" "$TRAINED_WEIGHTS" "$CURRICULUM_SUMMARY" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [outDir, trainedWeights, curriculumSummaryPath] = process.argv.slice(2);
const read = (name) => JSON.parse(readFileSync(`${outDir}/${name}.json`, 'utf8'));
const curriculum = JSON.parse(readFileSync(curriculumSummaryPath, 'utf8'));
const metric = (row) => ({
  vp: row.planner_VP_avg,
  winPct: row.planner_win_pct,
  reach30Pct: row.planner_reach30_pct,
  status: row.planner_status_avg,
  maxStatus: row.planner_max_status,
  kills: row.planner_monster_kills_per_game,
  abyssNavs: row.planner_abyss_navs_per_game,
  pvpVp: row.planner_pvp_vp_per_game,
  pvpAttacks: row.planner_pvp_attacks_per_game,
  pvpTargetVp: row.planner_pvp_target_vp_per_game,
  pvpBestTargetVp: row.planner_pvp_best_target_vp,
  highValueWindows: row.planner_pvp_high_value_opportunities_per_game,
  missedPvpPct: row.planner_missed_pvp_opportunity_pct,
  hp4PvpVp: row.planner_pvp_hard_monster_vp_per_game,
  hp4PvpAttacks: row.planner_pvp_hard_monster_attacks_per_game,
  missedHp4PvpPct: row.planner_missed_pvp_hard_monster_opportunity_pct,
  goodPivotVp: row.planner_pvp_good_target_pivot_vp_per_game,
  goodPivotAttacks: row.planner_pvp_good_target_pivot_attacks_per_game,
  goodPivotBestTargetVp: row.planner_pvp_good_target_pivot_best_target_vp,
  missedGoodPivotPct: row.planner_missed_pvp_good_target_pivot_opportunity_pct,
  fieldBestVp: row.field_bestVP_avg,
  roleStats: row.roleStats
});
const baselineRole = read('baseline_vs_role_stack');
const candidateRole = read('candidate_vs_role_stack');
const baselineTargets = read('baseline_vs_scorefloor_targets');
const candidateTargets = read('candidate_vs_scorefloor_targets');
const summary = {
  generatedAt: new Date().toISOString(),
  outDir,
  trainedWeights,
  curriculum,
  config: {
    baseWeights: process.env.BASE_WEIGHTS,
    basePatchWeights: process.env.BASE_PATCH_WEIGHTS,
	    pvpPatchGate: process.env.PVP_PATCH_GATE,
	    pvpMicroGate: process.env.PVP_MICRO_GATE,
	    pvpOracle: process.env.PVP_ORACLE,
	    trainSampleFilter: process.env.TRAIN_SAMPLE_FILTER,
	    trainSamples: Number(process.env.TRAIN_SAMPLE_COUNT ?? 0),
	    roleStack: process.env.ROLE_STACK,
    evalGames: Number(process.env.EVAL_GAMES),
    evalIters: Number(process.env.EVAL_ITERS),
    evalHorizon: Number(process.env.EVAL_HORIZON)
  },
  baselineVsRoleStack: metric(baselineRole),
  candidateVsRoleStack: metric(candidateRole),
  baselineVsScorefloorTargets: metric(baselineTargets),
  candidateVsScorefloorTargets: metric(candidateTargets),
  deltas: {
    roleVp: +(candidateRole.planner_VP_avg - baselineRole.planner_VP_avg).toFixed(2),
    rolePvpVp: +(candidateRole.planner_pvp_vp_per_game - baselineRole.planner_pvp_vp_per_game).toFixed(2),
    roleGoodPivotVp: +(candidateRole.planner_pvp_good_target_pivot_vp_per_game - baselineRole.planner_pvp_good_target_pivot_vp_per_game).toFixed(2),
    roleBestTargetVp: +(candidateRole.planner_pvp_best_target_vp - baselineRole.planner_pvp_best_target_vp).toFixed(2),
    targetVp: +(candidateTargets.planner_VP_avg - baselineTargets.planner_VP_avg).toFixed(2),
    targetPvpVp: +(candidateTargets.planner_pvp_vp_per_game - baselineTargets.planner_pvp_vp_per_game).toFixed(2),
    targetGoodPivotVp: +(candidateTargets.planner_pvp_good_target_pivot_vp_per_game - baselineTargets.planner_pvp_good_target_pivot_vp_per_game).toFixed(2),
    targetBestTargetVp: +(candidateTargets.planner_pvp_best_target_vp - baselineTargets.planner_pvp_best_target_vp).toFixed(2)
  },
  verdict: {
    generatedSamples: curriculum.totalSamples > 0,
    generatedDescend: (curriculum.row.descendNavSamples ?? 0) + (curriculum.row.descendCombatSamples ?? 0) > 0,
    generatedHunt: (curriculum.row.huntNavSamples ?? 0) + (curriculum.row.predictiveHuntNavSamples ?? 0) > 0,
    generatedAttack: (curriculum.row.pvpAttackSamples ?? 0) > 0,
    roleImprovesVp: candidateRole.planner_VP_avg > baselineRole.planner_VP_avg,
    roleImprovesPvp: candidateRole.planner_pvp_vp_per_game > baselineRole.planner_pvp_vp_per_game,
    targetImprovesPvp: candidateTargets.planner_pvp_vp_per_game > baselineTargets.planner_pvp_vp_per_game,
    candidateMissesFewPvp: (candidateTargets.planner_missed_pvp_opportunity_pct ?? 100) <= 25,
    findsValuableGoodTarget: Math.max(candidateTargets.planner_pvp_best_target_vp ?? 0, candidateRole.planner_pvp_best_target_vp ?? 0) >= 12,
    promotable: false
  }
};
summary.verdict.promotable =
  summary.verdict.generatedSamples &&
  summary.verdict.generatedDescend &&
  summary.verdict.generatedHunt &&
  summary.verdict.generatedAttack &&
  summary.verdict.roleImprovesVp &&
  summary.verdict.roleImprovesPvp &&
  summary.verdict.targetImprovesPvp &&
  summary.verdict.candidateMissesFewPvp &&
  summary.verdict.findsValuableGoodTarget;
writeFileSync(`${outDir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE

echo "DONE -> $OUT_DIR/summary.json"
