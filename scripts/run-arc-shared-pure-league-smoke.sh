#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN_ID="${RUN_ID:-shared-pure-league-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="ml/meta_runs/$RUN_ID"
DATA_DIR="$OUT_DIR/data"
LOG_DIR="$OUT_DIR/logs"

GPU="${GPU:-4}"
GEN_GAMES="${GEN_GAMES:-24}"
GEN_ITERS="${GEN_ITERS:-24}"
GEN_HORIZON="${GEN_HORIZON:-16}"
GEN_VALUEW="${GEN_VALUEW:-1}"
GEN_SAMPLE="${GEN_SAMPLE:-0}"
GEN_TEMP="${GEN_TEMP:-0.9}"
GEN_PROGRESS_EVERY="${GEN_PROGRESS_EVERY:-4}"
EPOCHS="${EPOCHS:-6}"
BATCH="${BATCH:-4096}"
EVAL_GAMES="${EVAL_GAMES:-8}"
EVAL_ITERS="${EVAL_ITERS:-32}"
EVAL_HORIZON="${EVAL_HORIZON:-18}"

BASE_WEIGHTS="${BASE_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/best_policy.full.json}"
PURE_NAV_WEIGHTS="${PURE_NAV_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/nav_build_policy.json}"
PURE_NAV_GATE="${PURE_NAV_GATE:-pure-farm-build}"
HUNTER_PATCH_WEIGHTS="${HUNTER_PATCH_WEIGHTS:-ml/meta_runs/pvp-route-mode-20260630T124558Z/pvp_route_mode_head_policy.json}"
HUNTER_MICRO_WEIGHTS="${HUNTER_MICRO_WEIGHTS:-$HUNTER_PATCH_WEIGHTS}"

TRAINED_WEIGHTS="$OUT_DIR/pure_shared_policy.json"
BASE_STACK="$OUT_DIR/goodbuilder_base_stack.json"
TRAINED_STACK="$OUT_DIR/goodbuilder_trained_stack.json"

mkdir -p "$DATA_DIR" "$LOG_DIR"

write_stack() {
  local name="$1"
  local weights="$2"
  local out="$3"
  node --input-type=module - "$name" "$weights" "$PURE_NAV_WEIGHTS" "$PURE_NAV_GATE" "$out" <<'NODE'
import { writeFileSync } from 'node:fs';

const [name, weights, navWeights, navigationPolicyGate, out] = process.argv.slice(2);
writeFileSync(out, JSON.stringify([
  {
    name,
    weights,
    navWeights,
    navigationPolicyGate,
    maxStatusLevel: 0,
    forbidTypes: ['initiatePvp'],
    preserveRouteFirepower: true,
    preserveRouteSurvival: true
  }
], null, 2));
NODE
}

write_stack "pure-base-navbuild" "$BASE_WEIGHTS" "$BASE_STACK"

echo "== shared Pure league smoke =="
echo "run_id=$RUN_ID"
echo "gpu=$GPU gen_games=$GEN_GAMES gen_iters=$GEN_ITERS horizon=$GEN_HORIZON valueW=$GEN_VALUEW sample=$GEN_SAMPLE eval_games=$EVAL_GAMES"
echo "base_weights=$BASE_WEIGHTS"
echo "pure_nav_weights=$PURE_NAV_WEIGHTS"
echo "pure_nav_gate=$PURE_NAV_GATE"
echo "out_dir=$OUT_DIR"

echo "== baseline Pure mirror =="
env \
  AZEVAL=1 \
  AZEVAL_GAMES="$EVAL_GAMES" \
  AZEVAL_ITERS="$EVAL_ITERS" \
  AZEVAL_HORIZON="$EVAL_HORIZON" \
  AZEVAL_CONTROL=full \
  AZEVAL_FULL_SELECTION=value \
  AZEVAL_VALUEW=1 \
  AZEVAL_WEIGHTS="$BASE_WEIGHTS" \
  AZEVAL_NAV_WEIGHTS="$PURE_NAV_WEIGHTS" \
  AZEVAL_NAV_GATE="$PURE_NAV_GATE" \
  AZEVAL_MAX_STATUS_LEVEL=0 \
  AZEVAL_FORBID_TYPES=initiatePvp \
  AZEVAL_HARD_CONSTRAINTS=1 \
  AZEVAL_PRESERVE_ROUTE_FIREPOWER=1 \
  AZEVAL_PRESERVE_ROUTE_SURVIVAL=1 \
  AZEVAL_NEURAL_FIELD=1 \
  AZEVAL_NEURAL_FIELD_STACKS_FILE="$BASE_STACK" \
  AZEVAL_OUT="$OUT_DIR/baseline_pure_mirror.json" \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
  2>&1 | tee "$LOG_DIR/baseline_pure_mirror.log"

echo "== hunter vs baseline Pure field =="
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
  AZEVAL_PATCH_NAV_GATE=pvp-predictive-mode-hunt-fallback-pivot \
  AZEVAL_MICRO_WEIGHTS="$HUNTER_MICRO_WEIGHTS" \
  AZEVAL_MICRO_GATE=pvp-pivot-encounter-force \
  AZEVAL_NEURAL_FIELD=1 \
  AZEVAL_NEURAL_FIELD_STACKS_FILE="$BASE_STACK" \
  AZEVAL_OUT="$OUT_DIR/hunter_vs_base_pure_field.json" \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
  2>&1 | tee "$LOG_DIR/hunter_vs_base_pure_field.log"

echo "== generate shared Pure data =="
env \
  ML_META_PATH="$DATA_DIR/meta.json" \
  AZ=1 \
  AZ_GAMES="$GEN_GAMES" \
  AZ_ITERS="$GEN_ITERS" \
  AZ_HORIZON="$GEN_HORIZON" \
  AZ_VALUEW="$GEN_VALUEW" \
  AZ_PROGRESS_EVERY="$GEN_PROGRESS_EVERY" \
  AZ_SEATS=4 \
  AZ_PLANNER_SEATS=all \
  AZ_CONTROL=full \
  AZ_FULL_SELECTION=value \
  AZ_SAMPLE="$GEN_SAMPLE" \
  AZ_TEMP="$GEN_TEMP" \
  AZ_WEIGHTS="$BASE_WEIGHTS" \
  AZ_NAV_WEIGHTS="$PURE_NAV_WEIGHTS" \
  AZ_NAV_GATE="$PURE_NAV_GATE" \
  AZ_MAX_STATUS_LEVEL=0 \
  AZ_FORBID_TYPES=initiatePvp \
  AZ_HARD_CONSTRAINTS=1 \
  AZ_PRESERVE_ROUTE_FIREPOWER=1 \
  AZ_PRESERVE_ROUTE_SURVIVAL=1 \
  AZ_OUT="$DATA_DIR/samples.jsonl" \
  npx vitest run src/lib/play/ml/_azgen.test.ts --disable-console-intercept \
  2>&1 | tee "$LOG_DIR/azgen.log"

echo "== train shared Pure policy =="
CUDA_VISIBLE_DEVICES="$GPU" \
  ml/.venv/bin/python ml/train.py \
  --data "$DATA_DIR" \
  --out "$TRAINED_WEIGHTS" \
  --init-from "$BASE_WEIGHTS" \
  --mode alphazero \
  --epochs "$EPOCHS" \
  --batch-size "$BATCH" \
  --value-coef 0.5 \
  2>&1 | tee "$LOG_DIR/train.log"

write_stack "pure-shared-trained" "$TRAINED_WEIGHTS" "$TRAINED_STACK"

echo "== trained Pure mirror =="
env \
  AZEVAL=1 \
  AZEVAL_GAMES="$EVAL_GAMES" \
  AZEVAL_ITERS="$EVAL_ITERS" \
  AZEVAL_HORIZON="$EVAL_HORIZON" \
  AZEVAL_CONTROL=full \
  AZEVAL_FULL_SELECTION=value \
  AZEVAL_VALUEW=1 \
  AZEVAL_WEIGHTS="$TRAINED_WEIGHTS" \
  AZEVAL_NAV_WEIGHTS="$PURE_NAV_WEIGHTS" \
  AZEVAL_NAV_GATE="$PURE_NAV_GATE" \
  AZEVAL_MAX_STATUS_LEVEL=0 \
  AZEVAL_FORBID_TYPES=initiatePvp \
  AZEVAL_HARD_CONSTRAINTS=1 \
  AZEVAL_PRESERVE_ROUTE_FIREPOWER=1 \
  AZEVAL_PRESERVE_ROUTE_SURVIVAL=1 \
  AZEVAL_NEURAL_FIELD=1 \
  AZEVAL_NEURAL_FIELD_STACKS_FILE="$TRAINED_STACK" \
  AZEVAL_OUT="$OUT_DIR/trained_pure_mirror.json" \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
  2>&1 | tee "$LOG_DIR/trained_pure_mirror.log"

echo "== hunter vs trained Pure field =="
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
  AZEVAL_PATCH_NAV_GATE=pvp-predictive-mode-hunt-fallback-pivot \
  AZEVAL_MICRO_WEIGHTS="$HUNTER_MICRO_WEIGHTS" \
  AZEVAL_MICRO_GATE=pvp-pivot-encounter-force \
  AZEVAL_NEURAL_FIELD=1 \
  AZEVAL_NEURAL_FIELD_STACKS_FILE="$TRAINED_STACK" \
  AZEVAL_OUT="$OUT_DIR/hunter_vs_trained_pure_field.json" \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
  2>&1 | tee "$LOG_DIR/hunter_vs_trained_pure_field.log"

node --input-type=module - "$OUT_DIR" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const outDir = process.argv[2];
const read = (name) => JSON.parse(readFileSync(`${outDir}/${name}`, 'utf8'));
const baseline = read('baseline_pure_mirror.json');
const trained = read('trained_pure_mirror.json');
const hunterBase = read('hunter_vs_base_pure_field.json');
const hunter = read('hunter_vs_trained_pure_field.json');
const generated = read('data/meta.json');
const summary = {
  outDir,
  generatedData: {
    samples: generated.samples,
    games: generated.games,
    plannerVp: generated.plannerVP_avg,
    missedFarmableNavPct: generated.missedFarmableNavPct,
    valueWeight: generated.valueWeight,
    sample: generated.sample ?? null,
    navigationPolicyGate: generated.navigationPolicyGate
  },
  baselinePureMirror: {
    vp: baseline.planner_VP_avg,
    winPct: baseline.planner_win_pct,
    reach30Pct: baseline.planner_reach30_pct,
    fieldBestVp: baseline.field_bestVP_avg
  },
  trainedPureMirror: {
    vp: trained.planner_VP_avg,
    winPct: trained.planner_win_pct,
    reach30Pct: trained.planner_reach30_pct,
    fieldBestVp: trained.field_bestVP_avg
  },
  hunterVsBasePureField: {
    vp: hunterBase.planner_VP_avg,
    winPct: hunterBase.planner_win_pct,
    reach30Pct: hunterBase.planner_reach30_pct,
    pvpAttacks: hunterBase.planner_pvp_attacks_per_game,
    pvpVp: hunterBase.planner_pvp_vp_per_game,
    pvpOpportunities: hunterBase.planner_pvp_opportunities_per_game,
    missedPvpPct: hunterBase.planner_missed_pvp_opportunity_pct,
    pvpTargetVp: hunterBase.planner_pvp_target_vp_per_game,
    pvpBestTargetVp: hunterBase.planner_pvp_best_target_vp,
    pvpHighValueOpportunities: hunterBase.planner_pvp_high_value_opportunities_per_game,
    fieldBestVp: hunterBase.field_bestVP_avg
  },
  hunterVsTrainedPureField: {
    vp: hunter.planner_VP_avg,
    winPct: hunter.planner_win_pct,
    reach30Pct: hunter.planner_reach30_pct,
    pvpAttacks: hunter.planner_pvp_attacks_per_game,
    pvpVp: hunter.planner_pvp_vp_per_game,
    pvpOpportunities: hunter.planner_pvp_opportunities_per_game,
    missedPvpPct: hunter.planner_missed_pvp_opportunity_pct,
    pvpTargetVp: hunter.planner_pvp_target_vp_per_game,
    pvpBestTargetVp: hunter.planner_pvp_best_target_vp,
    pvpHighValueOpportunities: hunter.planner_pvp_high_value_opportunities_per_game,
    fieldBestVp: hunter.field_bestVP_avg
  }
};
writeFileSync(`${outDir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE

echo "DONE $OUT_DIR"
