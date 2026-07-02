#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN_ID="${RUN_ID:-target-exposure-traceq-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="ml/meta_runs/$RUN_ID"
LOG_DIR="$OUT_DIR/logs"

GAMES="${GAMES:-8}"
MAX_WINDOWS="${MAX_WINDOWS:-24}"
ITERS="${ITERS:-16}"
PLANNER_HORIZON="${PLANNER_HORIZON:-12}"
HORIZONS="${HORIZONS:-4,8,12}"
LABEL_HORIZON="${LABEL_HORIZON:-8}"
MIN_ROUND="${MIN_ROUND:-6}"
MIN_PLAYER_VP="${MIN_PLAYER_VP:-12}"
MAX_PLAYER_VP="${MAX_PLAYER_VP:-28}"
MIN_MONSTER_HP="${MIN_MONSTER_HP:-4}"
SOURCE_DESTINATION="${SOURCE_DESTINATION:-Arcane Abyss}"
LABEL_VP_THRESHOLD="${LABEL_VP_THRESHOLD:--1}"
LABEL_SCORE_THRESHOLD="${LABEL_SCORE_THRESHOLD:-0.1}"
EXPOSURE_MIN_VP="${EXPOSURE_MIN_VP:-12}"
EXPOSURE_MIN_MONSTER_HP="${EXPOSURE_MIN_MONSTER_HP:-4}"
EXPOSURE_WINDOW_WEIGHT="${EXPOSURE_WINDOW_WEIGHT:-3}"
EXPOSURE_VP_WEIGHT="${EXPOSURE_VP_WEIGHT:-0.1}"
EXPOSURE_BEST_VP_WEIGHT="${EXPOSURE_BEST_VP_WEIGHT:-0.2}"

WEIGHTS="${WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/best_policy.full.json}"
NAV_WEIGHTS="${NAV_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/nav_build_policy.json}"
NAV_GATE="${NAV_GATE:-good-nonfallen-farm-target-pivot}"
MICRO_WEIGHTS="${MICRO_WEIGHTS:-$WEIGHTS}"
MICRO_GATE="${MICRO_GATE:-location-interactions}"
MAX_STATUS_LEVEL="${MAX_STATUS_LEVEL:-2}"
SCRIPTS="${SCRIPTS:-policy,expose-floral,expose-tidal,expose-cyber,expose-lantern,abyss-probe}"

mkdir -p "$OUT_DIR" "$LOG_DIR"

echo "== target exposure TraceQ =="
echo "run_id=$RUN_ID out_dir=$OUT_DIR"
echo "games=$GAMES max_windows=$MAX_WINDOWS iters=$ITERS horizon=$PLANNER_HORIZON source='$SOURCE_DESTINATION'"
echo "vp_window=$MIN_PLAYER_VP-$MAX_PLAYER_VP monster_hp>=$MIN_MONSTER_HP label_vp_threshold=$LABEL_VP_THRESHOLD"

env \
  TRACEQ=1 \
  TRACEQ_GAMES="$GAMES" \
  TRACEQ_MAX_WINDOWS="$MAX_WINDOWS" \
  TRACEQ_ITERS="$ITERS" \
  TRACEQ_PLANNER_HORIZON="$PLANNER_HORIZON" \
  TRACEQ_HORIZONS="$HORIZONS" \
  TRACEQ_LABEL_HORIZON="$LABEL_HORIZON" \
  TRACEQ_WEIGHTS="$WEIGHTS" \
  TRACEQ_PATCH_NAV_WEIGHTS= \
  TRACEQ_PATCH2_NAV_WEIGHTS= \
  TRACEQ_SCALE_NAV_WEIGHTS= \
  TRACEQ_NAV_WEIGHTS="$NAV_WEIGHTS" \
  TRACEQ_NAV_GATE="$NAV_GATE" \
  TRACEQ_MICRO_WEIGHTS="$MICRO_WEIGHTS" \
  TRACEQ_MICRO_GATE="$MICRO_GATE" \
  TRACEQ_MAX_STATUS_LEVEL="$MAX_STATUS_LEVEL" \
  TRACEQ_MIN_SOURCE_VP=0 \
  TRACEQ_MAX_SOURCE_VP=30 \
  TRACEQ_MIN_PLAYER_VP="$MIN_PLAYER_VP" \
  TRACEQ_MAX_PLAYER_VP="$MAX_PLAYER_VP" \
  TRACEQ_MIN_MONSTER_HP="$MIN_MONSTER_HP" \
  TRACEQ_MAX_CLEAN_KILL_PROB=1 \
  TRACEQ_MIN_ROUND="$MIN_ROUND" \
  TRACEQ_SOURCE_DESTINATION="$SOURCE_DESTINATION" \
  TRACEQ_SCRIPTS="$SCRIPTS" \
  TRACEQ_SCORE_EXPOSURE_WINDOW_WEIGHT="$EXPOSURE_WINDOW_WEIGHT" \
  TRACEQ_SCORE_EXPOSURE_VP_WEIGHT="$EXPOSURE_VP_WEIGHT" \
  TRACEQ_SCORE_EXPOSURE_BEST_VP_WEIGHT="$EXPOSURE_BEST_VP_WEIGHT" \
  TRACEQ_EXPOSURE_MIN_VP="$EXPOSURE_MIN_VP" \
  TRACEQ_EXPOSURE_MIN_MONSTER_HP="$EXPOSURE_MIN_MONSTER_HP" \
  TRACEQ_REQUIRE_EXPOSURE_DELTA=1 \
  TRACEQ_LABEL_VP_THRESHOLD="$LABEL_VP_THRESHOLD" \
  TRACEQ_LABEL_SCORE_THRESHOLD="$LABEL_SCORE_THRESHOLD" \
  TRACEQ_DATA_OUT="$OUT_DIR/samples.jsonl" \
  TRACEQ_OUT="$OUT_DIR/traceq.json" \
  TRACEQ_SUMMARY="$OUT_DIR/summary.json" \
  npx vitest run src/lib/play/ml/_tracestatecounterfactual.test.ts --disable-console-intercept \
  2>&1 | tee "$LOG_DIR/traceq.log"

node --input-type=module - "$OUT_DIR" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const outDir = process.argv[2];
const summary = JSON.parse(readFileSync(`${outDir}/summary.json`, 'utf8'));
const compact = {
  outDir,
  windows: summary.windows,
  corrections: summary.corrections,
  samples: summary.samples,
  correctionPct: summary.correctionPct,
  avgDeltaVp: summary.avgDeltaVp,
  avgCorrectionDeltaVp: summary.avgCorrectionDeltaVp,
  exposureWindowDelta: summary.exposureWindowDelta,
  avgCorrectionDeltaExposureVp: summary.avgCorrectionDeltaExposureVp,
  navigationSampleDestinations: summary.navigationSampleDestinations,
  correctionScripts: summary.correctionScripts,
  bestRows: summary.bestRows.map((row) => ({
    id: row.id,
    round: row.round,
    vp: row.playerVp,
    sourceDestination: row.sourceDestination,
    bestScript: row.bestScript,
    deltaScore: row.traceQDeltaScore,
    deltaVp: row.traceQDeltaVp,
    deltaExposureWindows: row.traceQDeltaExposureWindows,
    deltaExposureVp: row.traceQDeltaExposureVp,
    deltaBestExposureVp: row.traceQDeltaBestExposureVp
  }))
};
writeFileSync(`${outDir}/compact_summary.json`, JSON.stringify(compact, null, 2) + '\n');
console.log(JSON.stringify(compact, null, 2));
NODE

echo "DONE -> $OUT_DIR/compact_summary.json"
