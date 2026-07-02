#!/usr/bin/env bash
set -euo pipefail

HOST="${ARC_BOT_GPU_HOST:-ubuntu@216.151.21.122}"
REMOTE_DIR="${ARC_BOT_REMOTE_DIR:-/data/share8/michaelvuaprilexperimentation/arc-bot}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="${RUN_ID:-clean-route-proof-suite-$(date -u +%Y%m%dT%H%M%SZ)}"

SYNC="${SYNC:-1}"
ROUTE_GPU="${ROUTE_GPU:-6}"
FARMQ_GPU="${FARMQ_GPU:-7}"
MIN_FREE_MB="${MIN_FREE_MB:-1024}"

WEIGHTS="${WEIGHTS:-ml/meta_runs/aux-head-act52-medium-20260627T222453Z/best_policy.json}"
PATCH_NAV_WEIGHTS="${PATCH_NAV_WEIGHTS:-ml/meta_runs/scalingq-hp2-survivaldeficit-160w-20260628T161431Z/best_policy.json}"
PATCH_NAV_GATE="${PATCH_NAV_GATE:-hp2-survival-deficit}"
PATCH2_NAV_WEIGHTS="${PATCH2_NAV_WEIGHTS:-}"
PATCH2_NAV_GATE="${PATCH2_NAV_GATE:-all}"
NAV_WEIGHTS="${NAV_WEIGHTS:-ml/meta_runs/routeq-nav-specialist-20260628T0305Z/best_policy.json}"
NAV_GATE="${NAV_GATE:-unsafe-firepower-build-option}"
SCALE_NAV_WEIGHTS="${SCALE_NAV_WEIGHTS:-ml/meta_runs/scaleq-nav-20260628T0650Z/best_policy.json}"
SCALE_NAV_GATE="${SCALE_NAV_GATE:-route-option-scaling}"
MICRO_WEIGHTS="${MICRO_WEIGHTS:-ml/meta_runs/routeexecq-fullcontrol-micro-20260628T0600Z/best_policy.json}"
MICRO_GATE="${MICRO_GATE:-location-interactions}"
ROUTE_CLOSER_MICRO_WEIGHTS="${ROUTE_CLOSER_MICRO_WEIGHTS:-}"

ROUTE_GAMES="${ROUTE_GAMES:-32}"
ROUTE_ITERS="${ROUTE_ITERS:-64}"
ROUTE_HORIZON="${ROUTE_HORIZON:-24}"
ROUTE_VARIANTS="${ROUTE_VARIANTS:-strict-pure,tainted-tolerance,no-pvp-corruption,strict-pure-farm-oracle,strict-pure-oracle-bonus,strict-pure-no-pvphunter}"
ROUTE_TIMEOUT="${ROUTE_TIMEOUT:-45m}"
TRACE="${TRACE:-1}"
TRACE_MIN_VP="${TRACE_MIN_VP:-0}"
TRACE_MAX_VP="${TRACE_MAX_VP:-}"
PRESERVE_ROUTE_FIREPOWER="${PRESERVE_ROUTE_FIREPOWER:-1}"
PRESERVE_ROUTE_SURVIVAL="${PRESERVE_ROUTE_SURVIVAL:-1}"

FARMQ_GAMES="${FARMQ_GAMES:-16}"
FARMQ_MAX_WINDOWS="${FARMQ_MAX_WINDOWS:-256}"
FARMQ_HORIZONS="${FARMQ_HORIZONS:-3,6,10,15}"
FARMQ_SELECT_HORIZON="${FARMQ_SELECT_HORIZON:-6}"
FARMQ_LABEL_HORIZON="${FARMQ_LABEL_HORIZON:-10}"
FARMQ_LABEL_VP_THRESHOLD="${FARMQ_LABEL_VP_THRESHOLD:-0.5}"
FARMQ_PROFILES="${FARMQ_PROFILES:-paragon,farmer,farmer2,hard}"
FARMQ_FORBID_TYPES="${FARMQ_FORBID_TYPES:-initiatePvp}"
FARMQ_MAX_STATUS_LEVEL="${FARMQ_MAX_STATUS_LEVEL:-0}"
FARMQ_TIMEOUT="${FARMQ_TIMEOUT:-90m}"

IMITATION_EPOCHS="${IMITATION_EPOCHS:-160}"
IMITATION_BATCH="${IMITATION_BATCH:-32}"
MIN_FARMQ_ROWS="${MIN_FARMQ_ROWS:-24}"
MIN_ROUTE_VP="${MIN_ROUTE_VP:-12}"

if [[ "$SYNC" == "1" ]]; then
  (cd "$ROOT_DIR" && npm run bot:gpu:sync)
fi

route_status=0
(
  cd "$ROOT_DIR"
  RUN_ID="$RUN_ID" \
  GPU="$ROUTE_GPU" \
  WEIGHTS="$WEIGHTS" \
  PATCH_NAV_WEIGHTS="$PATCH_NAV_WEIGHTS" \
  PATCH_NAV_GATE="$PATCH_NAV_GATE" \
  PATCH2_NAV_WEIGHTS="$PATCH2_NAV_WEIGHTS" \
  PATCH2_NAV_GATE="$PATCH2_NAV_GATE" \
  NAV_WEIGHTS="$NAV_WEIGHTS" \
  NAV_GATE="$NAV_GATE" \
  SCALE_NAV_WEIGHTS="$SCALE_NAV_WEIGHTS" \
  SCALE_NAV_GATE="$SCALE_NAV_GATE" \
  MICRO_WEIGHTS="$MICRO_WEIGHTS" \
  MICRO_GATE="$MICRO_GATE" \
  ROUTE_CLOSER_MICRO_WEIGHTS="$ROUTE_CLOSER_MICRO_WEIGHTS" \
  GAMES="$ROUTE_GAMES" \
  ITERS="$ROUTE_ITERS" \
  HORIZON="$ROUTE_HORIZON" \
  MIN_FREE_MB="$MIN_FREE_MB" \
  VARIANTS="$ROUTE_VARIANTS" \
  RESUME="${RESUME:-1}" \
  VARIANT_TIMEOUT="$ROUTE_TIMEOUT" \
  TRACE="$TRACE" \
  TRACE_MIN_VP="$TRACE_MIN_VP" \
  TRACE_MAX_VP="$TRACE_MAX_VP" \
  PRESERVE_ROUTE_FIREPOWER="$PRESERVE_ROUTE_FIREPOWER" \
  PRESERVE_ROUTE_SURVIVAL="$PRESERVE_ROUTE_SURVIVAL" \
  npm run bot:route-proof
) || route_status=$?

set +e
ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" \
  REMOTE_DIR="$REMOTE_DIR" \
  RUN_ID="$RUN_ID" \
  FARMQ_GPU="$FARMQ_GPU" \
  MIN_FREE_MB="$MIN_FREE_MB" \
  FARMQ_GAMES="$FARMQ_GAMES" \
  FARMQ_MAX_WINDOWS="$FARMQ_MAX_WINDOWS" \
  FARMQ_HORIZONS="$FARMQ_HORIZONS" \
  FARMQ_SELECT_HORIZON="$FARMQ_SELECT_HORIZON" \
  FARMQ_LABEL_HORIZON="$FARMQ_LABEL_HORIZON" \
  FARMQ_LABEL_VP_THRESHOLD="$FARMQ_LABEL_VP_THRESHOLD" \
  FARMQ_PROFILES="$FARMQ_PROFILES" \
  FARMQ_FORBID_TYPES="$FARMQ_FORBID_TYPES" \
  FARMQ_MAX_STATUS_LEVEL="$FARMQ_MAX_STATUS_LEVEL" \
  FARMQ_TIMEOUT="$FARMQ_TIMEOUT" \
  IMITATION_EPOCHS="$IMITATION_EPOCHS" \
  IMITATION_BATCH="$IMITATION_BATCH" \
  MIN_FARMQ_ROWS="$MIN_FARMQ_ROWS" \
  MIN_ROUTE_VP="$MIN_ROUTE_VP" \
  bash -s <<'REMOTE'
set -euo pipefail

cd "$REMOTE_DIR"
if test -s "$HOME/.nvm/nvm.sh"; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null
fi

if command -v nvidia-smi >/dev/null 2>&1; then
  free_mb="$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits -i "$FARMQ_GPU" | head -n 1 | tr -dc '0-9')"
  used_mb="$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i "$FARMQ_GPU" | head -n 1 | tr -dc '0-9')"
  echo "gpu=$FARMQ_GPU free_mb=${free_mb:-unknown} used_mb=${used_mb:-unknown} min_free_mb=$MIN_FREE_MB"
  if [[ -n "${free_mb:-}" && "$free_mb" -lt "$MIN_FREE_MB" ]]; then
    echo "refusing clean-route proof suite: GPU $FARMQ_GPU has ${free_mb}MB free, below MIN_FREE_MB=$MIN_FREE_MB" >&2
    exit 2
  fi
fi

OUT_DIR="ml/meta_runs/$RUN_ID"
FARMQ_DIR="$OUT_DIR/farmq"
DATA_DIR="$OUT_DIR/data/farmq"
mkdir -p "$FARMQ_DIR" "$DATA_DIR" "$OUT_DIR/logs"

cat > "$OUT_DIR/clean-route-suite-config.json" <<JSON
{
  "run_id": "$RUN_ID",
  "mode": "clean-route-proof-suite",
  "farmq_gpu": "$FARMQ_GPU",
  "min_free_mb": $MIN_FREE_MB,
  "farmq_games": $FARMQ_GAMES,
  "farmq_max_windows": $FARMQ_MAX_WINDOWS,
  "farmq_horizons": "$FARMQ_HORIZONS",
  "farmq_select_horizon": $FARMQ_SELECT_HORIZON,
  "farmq_label_horizon": $FARMQ_LABEL_HORIZON,
  "farmq_label_vp_threshold": $FARMQ_LABEL_VP_THRESHOLD,
  "farmq_profiles": "$FARMQ_PROFILES",
  "farmq_forbid_types": "$FARMQ_FORBID_TYPES",
  "farmq_max_status_level": "$FARMQ_MAX_STATUS_LEVEL",
  "imitation_epochs": $IMITATION_EPOCHS,
  "imitation_batch": $IMITATION_BATCH,
  "min_farmq_rows": $MIN_FARMQ_ROWS,
  "min_route_vp": $MIN_ROUTE_VP
}
JSON

timeout "$FARMQ_TIMEOUT" env \
  CUDA_VISIBLE_DEVICES="$FARMQ_GPU" \
  FARMQ=1 \
  FARMQ_GAMES="$FARMQ_GAMES" \
  FARMQ_MAX_WINDOWS="$FARMQ_MAX_WINDOWS" \
  FARMQ_HORIZONS="$FARMQ_HORIZONS" \
  FARMQ_SELECT_HORIZON="$FARMQ_SELECT_HORIZON" \
  FARMQ_LABEL_HORIZON="$FARMQ_LABEL_HORIZON" \
  FARMQ_LABEL_VP_THRESHOLD="$FARMQ_LABEL_VP_THRESHOLD" \
  FARMQ_PROFILES="$FARMQ_PROFILES" \
  FARMQ_FORBID_TYPES="$FARMQ_FORBID_TYPES" \
  FARMQ_MAX_STATUS_LEVEL="$FARMQ_MAX_STATUS_LEVEL" \
  FARMQ_DATA_OUT="$DATA_DIR/farmq.jsonl" \
  FARMQ_OUT="$FARMQ_DIR/windows.json" \
  FARMQ_SUMMARY="$FARMQ_DIR/summary.json" \
  npx vitest run src/lib/play/ml/_farmcounterfactual.test.ts --disable-console-intercept \
  2>&1 | tee "$OUT_DIR/logs/farmq.log"

farmq_rows="$(wc -l < "$DATA_DIR/farmq.jsonl" | tr -d ' ')"
audit_status=0
imitation_status=0
if [[ "$farmq_rows" -lt "$MIN_FARMQ_ROWS" ]]; then
  echo "skipping contract audit and imitation: farm-Q rows=$farmq_rows < MIN_FARMQ_ROWS=$MIN_FARMQ_ROWS" >&2
  audit_status=3
  imitation_status=3
else
  set +e
  env \
    CONTRACTAUDIT=1 \
    CONTRACTAUDIT_DATA="$DATA_DIR/farmq.jsonl" \
    CONTRACTAUDIT_OUT="$OUT_DIR/contract_audit_summary.json" \
    CONTRACTAUDIT_MIN_ROWS="$MIN_FARMQ_ROWS" \
    CONTRACTAUDIT_MIN_LABELS=2 \
    npx vitest run src/lib/play/ml/_contractaudit.test.ts --disable-console-intercept \
    2>&1 | tee "$OUT_DIR/logs/contract_audit.log"
  audit_status=${PIPESTATUS[0]}

  CUDA_VISIBLE_DEVICES="$FARMQ_GPU" ml/.venv/bin/python ml/route_imitation.py \
    --data "$DATA_DIR" \
    --out "$OUT_DIR/route_imitation_summary.json" \
    --epochs "$IMITATION_EPOCHS" \
    --batch-size "$IMITATION_BATCH" \
    --allow-fail \
    2>&1 | tee "$OUT_DIR/logs/route_imitation.log"
  imitation_status=${PIPESTATUS[0]}
  set -e
fi
export FARMQ_ROWS="$farmq_rows"
export CONTRACTAUDIT_STATUS="$audit_status"
export ROUTE_IMITATION_STATUS="$imitation_status"

node --input-type=module <<'NODE'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const runId = process.env.RUN_ID;
const outDir = `ml/meta_runs/${runId}`;
const minRouteVp = Number(process.env.MIN_ROUTE_VP ?? 12);
const minFarmqRows = Number(process.env.MIN_FARMQ_ROWS ?? 24);
const farmqRows = Number(process.env.FARMQ_ROWS ?? 0);
const contractAuditStatus = Number(process.env.CONTRACTAUDIT_STATUS ?? 0);
const routeImitationStatus = Number(process.env.ROUTE_IMITATION_STATUS ?? 0);
const read = (path) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
const routeProof = read(`${outDir}/summary.json`);
const farmq = read(`${outDir}/farmq/summary.json`);
const contract = read(`${outDir}/contract_audit_summary.json`);
const imitation = read(`${outDir}/route_imitation_summary.json`);

const row = (name) => routeProof?.rows?.find((r) => r.name === name) ?? null;
const strict = row('strict-pure');
const noHunter = row('strict-pure-no-pvphunter');
const tier = (r) => {
  if (!r || r.failed) return { cleanFarmSkill: false, cleanRoute: false, cleanCompetitiveRoute: false };
  const clean = (r.planner_own_status_cap_violation_events ?? 0) === 0 && (r.planner_status_avg ?? Infinity) <= 0.05;
  const farmMissOk = (r.planner_missed_farm_opportunity_vp_pct ?? 100) < 40;
  const cleanFarmSkill =
    clean &&
    (r.planner_VP_avg ?? 0) >= 8 &&
    (r.planner_monster_kills_per_game ?? 0) >= 3 &&
    farmMissOk;
  const cleanRoute =
    cleanFarmSkill &&
    (r.planner_VP_avg ?? 0) >= minRouteVp &&
    (r.planner_monster_kills_per_game ?? 0) >= 4 &&
    (r.planner_missed_farm_opportunity_vp_pct ?? 100) < 30;
  const cleanCompetitiveRoute =
    cleanRoute &&
    (r.planner_reach30_pct ?? 0) >= 15 &&
    (r.planner_win_pct ?? 0) >= 25 &&
    (r.planner_VP_avg ?? 0) >= 16;
  return { cleanFarmSkill, cleanRoute, cleanCompetitiveRoute };
};
const strictTiers = tier(strict);
const noHunterTiers = tier(noHunter);
const farmqHasSignal =
  farmqRows >= minFarmqRows &&
  (farmq?.windows ?? 0) > 0 &&
  (farmq?.farmNowCorrect ?? 0) > 0 &&
  (farmq?.farmNowCorrect ?? 0) < (farmq?.windows ?? 0);
const contractPass =
  contract &&
  contract.badObsDim === 0 &&
  contract.badActDim === 0 &&
  contract.exactConflictCount === 0 &&
  contract.nearConflictCount === 0;
const imitationPass = imitation?.pass === true;
const routePositive = strictTiers.cleanRoute || noHunterTiers.cleanRoute;
const trainingVerdict =
  routePositive && farmqHasSignal && contractPass && imitationPass
    ? 'clean-specialist-training-allowed'
    : 'diagnose-before-training';

const summary = {
  run_id: runId,
  generated_at: new Date().toISOString(),
  route_proof: {
    summary: `${outDir}/summary.json`,
    strict_pure: strict ? {
      avg_vp: strict.planner_VP_avg,
      win_pct: strict.planner_win_pct,
      reach30_pct: strict.planner_reach30_pct,
      status_avg: strict.planner_status_avg,
      max_status: strict.planner_max_status,
      own_status_cap_events: strict.planner_own_status_cap_violation_events,
      external_status_cap_events: strict.planner_external_status_cap_violation_events,
      kills_per_game: strict.planner_monster_kills_per_game,
      missed_farm_vp_pct: strict.planner_missed_farm_opportunity_vp_pct,
      tiers: strictTiers
    } : null,
    strict_pure_no_pvphunter: noHunter ? {
      avg_vp: noHunter.planner_VP_avg,
      win_pct: noHunter.planner_win_pct,
      reach30_pct: noHunter.planner_reach30_pct,
      status_avg: noHunter.planner_status_avg,
      max_status: noHunter.planner_max_status,
      own_status_cap_events: noHunter.planner_own_status_cap_violation_events,
      external_status_cap_events: noHunter.planner_external_status_cap_violation_events,
      kills_per_game: noHunter.planner_monster_kills_per_game,
      missed_farm_vp_pct: noHunter.planner_missed_farm_opportunity_vp_pct,
      tiers: noHunterTiers
    } : null,
    interpretation: routeProof?.interpretation ?? null,
    deltas: routeProof?.deltas ?? null
  },
  farm_counterfactual: farmq ? {
    summary: `${outDir}/farmq/summary.json`,
    rows: farmqRows,
    min_rows: minFarmqRows,
    windows: farmq.windows,
    farm_now_correct: farmq.farmNowCorrect,
    farm_now_pct: farmq.farmNowPct,
    avg_delta_vp: farmq.avgFarmQDeltaVp,
    avg_delta_status: farmq.avgFarmQDeltaStatus,
    avg_delta_reward_vp: farmq.avgFarmQDeltaRewardVp,
    avg_delta_pvp_vp: farmq.avgFarmQDeltaPvpVp,
    avg_delta_monster_lives_consumed: farmq.avgFarmQDeltaMonsterLivesConsumed,
    avg_delta_race_margin: farmq.avgFarmQDeltaRaceMargin,
    avg_delta_reach30: farmq.avgFarmQDeltaReach30,
    avg_delta_pvp_exposure: farmq.avgFarmQDeltaPvpExposure,
    by_horizon: farmq.byHorizon,
    has_selective_signal: farmqHasSignal
  } : {
    rows: farmqRows,
    min_rows: minFarmqRows,
    has_selective_signal: false
  },
  contract_audit: contract ? {
    summary: `${outDir}/contract_audit_summary.json`,
    exit_status: contractAuditStatus,
    rows: contract.rows,
    obs_dim: contract.obsDim,
    act_dim: contract.actDim,
    exact_conflicts: contract.exactConflictCount,
    near_conflicts: contract.nearConflictCount,
    min_different_label_distance: contract.minDifferentLabelDistance,
    pass: contractPass
  } : {
    exit_status: contractAuditStatus,
    pass: false
  },
  route_imitation: imitation ? {
    summary: `${outDir}/route_imitation_summary.json`,
    exit_status: routeImitationStatus,
    samples: imitation.samples,
    train_top1: imitation.final?.train?.top1,
    val_top1: imitation.final?.val?.top1,
    val_top3: imitation.final?.val?.top3,
    val_majority_top1: imitation.val_majority_top1,
    pass: imitationPass
  } : {
    exit_status: routeImitationStatus,
    pass: false
  },
  verdict: {
    route_positive: routePositive,
    farmq_has_selective_signal: farmqHasSignal,
    contract_pass: Boolean(contractPass),
    imitation_pass: imitationPass,
    training: trainingVerdict
  },
  artifacts: {
    route_proof_summary: `${outDir}/summary.json`,
    farmq_windows: `${outDir}/farmq/windows.json`,
    farmq_summary: `${outDir}/farmq/summary.json`,
    farmq_data: `${outDir}/data/farmq/farmq.jsonl`,
    contract_audit: `${outDir}/contract_audit_summary.json`,
    route_imitation: `${outDir}/route_imitation_summary.json`
  }
};

writeFileSync(`${outDir}/clean_route_suite_summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE

echo "DONE: $OUT_DIR/clean_route_suite_summary.json"
REMOTE
diag_status=$?
set -e

LOCAL_OUT_DIR="$ROOT_DIR/ml/meta_runs/$RUN_ID"
mkdir -p "$LOCAL_OUT_DIR"
rsync_status=0
rsync -az "$HOST:$REMOTE_DIR/ml/meta_runs/$RUN_ID/" "$LOCAL_OUT_DIR/" || rsync_status=$?
echo "$LOCAL_OUT_DIR"

if [[ "$route_status" -ne 0 ]]; then
  exit "$route_status"
fi
if [[ "$diag_status" -ne 0 ]]; then
  exit "$diag_status"
fi
exit "$rsync_status"
