#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN_ID="${RUN_ID:-target-quality-traceq-$(date -u +%Y%m%dT%H%M%SZ)}"

export RUN_ID
export GPU="${GPU:-4}"
export MIN_FREE_MB="${MIN_FREE_MB:-2048}"
export SYNC="${SYNC:-1}"
export TIMEOUT="${TIMEOUT:-90m}"

export WEIGHTS="${WEIGHTS:-ml/meta_runs/scorefloor-carry-successlane-20260701Tremote/resilient_goodbuilder_policy.json}"
export NAV_WEIGHTS="${NAV_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/nav_build_policy.json}"
export NAV_GATE="${NAV_GATE:-good-nonfallen-score-floor}"
export MICRO_WEIGHTS="${MICRO_WEIGHTS:-ml/meta_runs/nonfallen-hp4-conversion-scorefloor-cashrestore-20260701Tremote/nonfallen_hp4_conversion_policy.json}"
export MICRO_GATE="${MICRO_GATE:-good-builder-hp4-conversion-overlay}"
export SCALE_NAV_WEIGHTS="${SCALE_NAV_WEIGHTS:-}"
export PATCH_NAV_WEIGHTS="${PATCH_NAV_WEIGHTS:-}"
export PATCH2_NAV_WEIGHTS="${PATCH2_NAV_WEIGHTS:-}"

export GAMES="${GAMES:-8}"
export MAX_WINDOWS="${MAX_WINDOWS:-32}"
export ITERS="${ITERS:-32}"
export PLANNER_HORIZON="${PLANNER_HORIZON:-16}"
export HORIZONS="${HORIZONS:-4,8,12}"
export LABEL_HORIZON="${LABEL_HORIZON:-8}"
export MIN_ROUND="${MIN_ROUND:-6}"
export MIN_PLAYER_VP="${MIN_PLAYER_VP:-12}"
export MAX_PLAYER_VP="${MAX_PLAYER_VP:-28}"
export MIN_MONSTER_HP="${MIN_MONSTER_HP:-4}"
export MAX_CLEAN_KILL_PROB="${MAX_CLEAN_KILL_PROB:-1}"
SOURCE_DESTINATION_RAW="${SOURCE_DESTINATION-Arcane Abyss}"
case "$(echo "$SOURCE_DESTINATION_RAW" | tr '[:upper:]' '[:lower:]')" in
  all|any|none|off)
    export SOURCE_DESTINATION=""
    ;;
  *)
    export SOURCE_DESTINATION="$SOURCE_DESTINATION_RAW"
    ;;
esac
export SCRIPTS="${SCRIPTS:-policy,expose-floral,expose-tidal,expose-cyber,expose-lantern,abyss-probe}"
export MAX_STATUS_LEVEL="${MAX_STATUS_LEVEL:-2}"

export LABEL_VP_THRESHOLD="${LABEL_VP_THRESHOLD:--1}"
export LABEL_SCORE_THRESHOLD="${LABEL_SCORE_THRESHOLD:-0.1}"
export SCORE_VP_WEIGHT="${SCORE_VP_WEIGHT:-0.5}"
export SCORE_REACH30_BONUS="${SCORE_REACH30_BONUS:-4}"
export SCORE_EXPOSURE_WINDOW_WEIGHT="${SCORE_EXPOSURE_WINDOW_WEIGHT:-0}"
export SCORE_EXPOSURE_VP_WEIGHT="${SCORE_EXPOSURE_VP_WEIGHT:-0}"
export SCORE_EXPOSURE_BEST_VP_WEIGHT="${SCORE_EXPOSURE_BEST_VP_WEIGHT:-0}"
export EXPOSURE_MIN_VP="${EXPOSURE_MIN_VP:-12}"
export EXPOSURE_MIN_MONSTER_HP="${EXPOSURE_MIN_MONSTER_HP:-4}"
export REQUIRE_EXPOSURE_DELTA="${REQUIRE_EXPOSURE_DELTA:-0}"
export SCORE_TARGET_QUALITY_WINDOW_WEIGHT="${SCORE_TARGET_QUALITY_WINDOW_WEIGHT:-5}"
export SCORE_TARGET_QUALITY_VP_WEIGHT="${SCORE_TARGET_QUALITY_VP_WEIGHT:-0.2}"
export SCORE_TARGET_QUALITY_BEST_VP_WEIGHT="${SCORE_TARGET_QUALITY_BEST_VP_WEIGHT:-0.6}"
export TARGET_QUALITY_MIN_VP="${TARGET_QUALITY_MIN_VP:-18}"
export REQUIRE_TARGET_QUALITY_DELTA="${REQUIRE_TARGET_QUALITY_DELTA:-1}"

export TRAIN="${TRAIN:-0}"
export MIN_TRAIN_SAMPLES="${MIN_TRAIN_SAMPLES:-12}"
export TRAIN_INIT_WEIGHTS="${TRAIN_INIT_WEIGHTS:-$NAV_WEIGHTS}"
export TRAIN_EPOCHS="${TRAIN_EPOCHS:-16}"

echo "== target-quality TraceQ =="
echo "run_id=$RUN_ID gpu=$GPU min_free_mb=$MIN_FREE_MB"
echo "target_quality_min_vp=$TARGET_QUALITY_MIN_VP require_delta=$REQUIRE_TARGET_QUALITY_DELTA scripts=$SCRIPTS"
echo "weights=$WEIGHTS"
echo "nav_weights=$NAV_WEIGHTS nav_gate=$NAV_GATE"
echo "micro_weights=$MICRO_WEIGHTS micro_gate=$MICRO_GATE"

bash scripts/run-arc-tracestateq-fullcontrol.sh

OUT_DIR="ml/meta_runs/$RUN_ID"
node --input-type=module - "$OUT_DIR" <<'NODE'
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const outDir = process.argv[2];
const summaryPath = `${outDir}/summary.json`;
if (!existsSync(summaryPath)) {
  process.exit(0);
}
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const compact = {
  outDir,
  windows: summary.windows,
  corrections: summary.corrections,
  samples: summary.samples,
  correctionPct: summary.correctionPct,
  avgDeltaVp: summary.avgDeltaVp,
  avgCorrectionDeltaVp: summary.avgCorrectionDeltaVp,
  exposureWindowDelta: summary.exposureWindowDelta,
  targetQualityWindowDelta: summary.targetQualityWindowDelta,
  avgDeltaTargetQualityVp: summary.avgDeltaTargetQualityVp,
  avgCorrectionDeltaTargetQualityVp: summary.avgCorrectionDeltaTargetQualityVp,
  avgDeltaBestTargetQualityVp: summary.avgDeltaBestTargetQualityVp,
  navigationSampleDestinations: summary.navigationSampleDestinations,
  correctionScripts: summary.correctionScripts,
  bestRows: (summary.bestRows ?? []).map((row) => ({
    id: row.id,
    round: row.round,
    vp: row.playerVp,
    monsterHp: row.monsterHp,
    sourceDestination: row.sourceDestination,
    bestScript: row.bestScript,
    deltaScore: row.traceQDeltaScore,
    deltaVp: row.traceQDeltaVp,
    deltaExposureWindows: row.traceQDeltaExposureWindows,
    deltaTargetQualityWindows: row.traceQDeltaTargetQualityWindows,
    deltaTargetQualityVp: row.traceQDeltaTargetQualityVp,
    deltaBestTargetQualityVp: row.traceQDeltaBestTargetQualityVp
  }))
};
writeFileSync(`${outDir}/compact_summary.json`, JSON.stringify(compact, null, 2) + '\n');
console.log(JSON.stringify(compact, null, 2));
NODE

echo "DONE -> $OUT_DIR/compact_summary.json"
