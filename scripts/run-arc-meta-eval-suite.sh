#!/usr/bin/env bash
set -euo pipefail

HOST="${ARC_BOT_GPU_HOST:-ubuntu@216.151.21.122}"
REMOTE_DIR="${ARC_BOT_REMOTE_DIR:-/data/share8/michaelvuaprilexperimentation/arc-bot}"
RUN_ID="${RUN_ID:-meta-eval-$(date -u +%Y%m%dT%H%M%SZ)}"

META_GPU="${META_GPU:-6}"
SAMPLED_GPU="${SAMPLED_GPU:-6}"
ARENA_GPU="${ARENA_GPU:-7}"

META_GAMES="${META_GAMES:-24}"
META_ITERS="${META_ITERS:-160}"
ARENA_GAMES="${ARENA_GAMES:-40}"
ARENA_ITERS="${ARENA_ITERS:-160}"
FORCED_GAMES="${FORCED_GAMES:-${META_GAMES}}"
FORCED_ITERS="${FORCED_ITERS:-${META_ITERS}}"
WEIGHTS="${WEIGHTS:-ml/weights/policy-smoke.json}"
PATCH_NAV_WEIGHTS="${PATCH_NAV_WEIGHTS:-${AZ_PATCH_NAV_WEIGHTS:-}}"
PATCH_NAV_GATE="${PATCH_NAV_GATE:-${AZ_PATCH_NAV_GATE:-all}}"
PATCH2_NAV_WEIGHTS="${PATCH2_NAV_WEIGHTS:-${AZ_PATCH2_NAV_WEIGHTS:-}}"
PATCH2_NAV_GATE="${PATCH2_NAV_GATE:-${AZ_PATCH2_NAV_GATE:-all}}"
MICRO_WEIGHTS="${MICRO_WEIGHTS:-${AZ_MICRO_WEIGHTS:-}}"
MICRO_GATE="${MICRO_GATE:-${AZ_MICRO_GATE:-all}}"
ROUTE_CLOSER_MICRO_WEIGHTS="${ROUTE_CLOSER_MICRO_WEIGHTS:-${AZ_ROUTE_CLOSER_MICRO_WEIGHTS:-}}"
PVP_PIVOT_ORACLE="${PVP_PIVOT_ORACLE:-${AZ_PVP_PIVOT_ORACLE:-off}}"
CONTROL="${CONTROL:-${AZ_CONTROL:-full}}"
FULL_SELECTION="${FULL_SELECTION:-${AZ_FULL_SELECTION:-value}}"
FULL_LOOKAHEAD_DEPTH="${FULL_LOOKAHEAD_DEPTH:-${AZ_FULL_LOOKAHEAD_DEPTH:-${AZ_LOOKAHEAD_DEPTH:-2}}}"
FULL_LOOKAHEAD_BEAM="${FULL_LOOKAHEAD_BEAM:-${AZ_FULL_LOOKAHEAD_BEAM:-${AZ_LOOKAHEAD_BEAM:-8}}}"
FULL_LOOKAHEAD_ROOT_BEAM="${FULL_LOOKAHEAD_ROOT_BEAM:-${AZ_FULL_LOOKAHEAD_ROOT_BEAM:-${AZ_LOOKAHEAD_ROOT_BEAM:-24}}}"
FULL_TARGET_TEMP="${FULL_TARGET_TEMP:-${AZ_FULL_TARGET_TEMP:-${AZ_TARGET_TEMP:-0.25}}}"
FARM_VALUE_BONUS="${FARM_VALUE_BONUS:-${AZ_FARM_VALUE_BONUS:-0}}"
FARM_VALUE_THRESHOLD="${FARM_VALUE_THRESHOLD:-${AZ_FARM_VALUE_THRESHOLD:-0}}"
FORBID_TYPES="${FORBID_TYPES:-${AZ_FORBID_TYPES:-${AZ_FORBID:-}}}"
MAX_STATUS_LEVEL="${MAX_STATUS_LEVEL:-${AZ_MAX_STATUS_LEVEL:-}}"
PURE_FORBID_TYPES="${PURE_FORBID_TYPES:-${FORBID_TYPES:+$FORBID_TYPES,}initiatePvp}"
PURE_MAX_STATUS_LEVEL="${PURE_MAX_STATUS_LEVEL:-0}"
ALLOW_NAVIGATION_EVAL="${ALLOW_NAVIGATION_EVAL:-0}"
SHARED_META_MIN_AVG_VP="${SHARED_META_MIN_AVG_VP:-18}"
SAMPLED_META_MIN_AVG_VP="${SAMPLED_META_MIN_AVG_VP:-15}"
SHARED_META_MIN_REACH30_PCT="${SHARED_META_MIN_REACH30_PCT:-10}"

if [[ "$CONTROL" != "full" && "$ALLOW_NAVIGATION_EVAL" != "1" ]]; then
  echo "CONTROL=$CONTROL is navigation-only evidence. Set CONTROL=full, or ALLOW_NAVIGATION_EVAL=1 for a historical diagnostic." >&2
  exit 2
fi

set +e
ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" \
  REMOTE_DIR="$REMOTE_DIR" \
  RUN_ID="$RUN_ID" \
  META_GPU="$META_GPU" \
  SAMPLED_GPU="$SAMPLED_GPU" \
  ARENA_GPU="$ARENA_GPU" \
  META_GAMES="$META_GAMES" \
  META_ITERS="$META_ITERS" \
  ARENA_GAMES="$ARENA_GAMES" \
  ARENA_ITERS="$ARENA_ITERS" \
  FORCED_GAMES="$FORCED_GAMES" \
  FORCED_ITERS="$FORCED_ITERS" \
  WEIGHTS="$WEIGHTS" \
  PATCH_NAV_WEIGHTS="$PATCH_NAV_WEIGHTS" \
  PATCH_NAV_GATE="$PATCH_NAV_GATE" \
  PATCH2_NAV_WEIGHTS="$PATCH2_NAV_WEIGHTS" \
  PATCH2_NAV_GATE="$PATCH2_NAV_GATE" \
  MICRO_WEIGHTS="$MICRO_WEIGHTS" \
  MICRO_GATE="$MICRO_GATE" \
  ROUTE_CLOSER_MICRO_WEIGHTS="$ROUTE_CLOSER_MICRO_WEIGHTS" \
  PVP_PIVOT_ORACLE="$PVP_PIVOT_ORACLE" \
  CONTROL="$CONTROL" \
  FULL_SELECTION="$FULL_SELECTION" \
  FULL_LOOKAHEAD_DEPTH="$FULL_LOOKAHEAD_DEPTH" \
  FULL_LOOKAHEAD_BEAM="$FULL_LOOKAHEAD_BEAM" \
  FULL_LOOKAHEAD_ROOT_BEAM="$FULL_LOOKAHEAD_ROOT_BEAM" \
  FULL_TARGET_TEMP="$FULL_TARGET_TEMP" \
  FARM_VALUE_BONUS="$FARM_VALUE_BONUS" \
  FARM_VALUE_THRESHOLD="$FARM_VALUE_THRESHOLD" \
  FORBID_TYPES="$FORBID_TYPES" \
  MAX_STATUS_LEVEL="$MAX_STATUS_LEVEL" \
  PURE_FORBID_TYPES="$PURE_FORBID_TYPES" \
  PURE_MAX_STATUS_LEVEL="$PURE_MAX_STATUS_LEVEL" \
  SHARED_META_MIN_AVG_VP="$SHARED_META_MIN_AVG_VP" \
  SAMPLED_META_MIN_AVG_VP="$SAMPLED_META_MIN_AVG_VP" \
  SHARED_META_MIN_REACH30_PCT="$SHARED_META_MIN_REACH30_PCT" \
  bash -s <<'REMOTE'
set -euo pipefail

cd "$REMOTE_DIR"
if test -s "$HOME/.nvm/nvm.sh"; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null
fi

OUT_DIR="ml/meta_runs/$RUN_ID"
mkdir -p "$OUT_DIR/meta" "$OUT_DIR/arena" "$OUT_DIR/forced"

echo "== arc meta eval suite =="
echo "host=$(hostname)"
echo "workspace=$PWD"
echo "run_id=$RUN_ID"
echo "weights=$WEIGHTS"
echo "patch_nav_weights=${PATCH_NAV_WEIGHTS:-<none>}"
echo "patch_nav_gate=$PATCH_NAV_GATE"
echo "patch2_nav_weights=${PATCH2_NAV_WEIGHTS:-<none>}"
echo "patch2_nav_gate=$PATCH2_NAV_GATE"
echo "micro_weights=${MICRO_WEIGHTS:-<none>}"
echo "micro_gate=$MICRO_GATE"
echo "route_closer_micro_weights=${ROUTE_CLOSER_MICRO_WEIGHTS:-<none>}"
echo "pvp_pivot_oracle=$PVP_PIVOT_ORACLE"
echo "control=$CONTROL full_selection=$FULL_SELECTION target_temp=$FULL_TARGET_TEMP lookahead_depth=$FULL_LOOKAHEAD_DEPTH"
echo "farm_value_bonus=$FARM_VALUE_BONUS farm_value_threshold=$FARM_VALUE_THRESHOLD"
echo "forbid_types=${FORBID_TYPES:-<none>}"
echo "max_status_level=${MAX_STATUS_LEVEL:-<none>}"
echo "pure_forbid_types=${PURE_FORBID_TYPES:-<none>}"
echo "pure_max_status_level=${PURE_MAX_STATUS_LEVEL:-<none>}"
echo "shared_meta_thresholds deterministic_avg>=$SHARED_META_MIN_AVG_VP sampled_avg>=$SAMPLED_META_MIN_AVG_VP reach30>=$SHARED_META_MIN_REACH30_PCT"
echo "deterministic_gpu=$META_GPU sampled_gpu=$SAMPLED_GPU arena_gpu=$ARENA_GPU"

CUDA_VISIBLE_DEVICES="$META_GPU" \
  AZMETA=1 \
  AZMETA_GAMES="$META_GAMES" \
  AZMETA_ITERS="$META_ITERS" \
  AZMETA_CONTROL="$CONTROL" \
  AZMETA_FULL_SELECTION="$FULL_SELECTION" \
  AZMETA_FULL_LOOKAHEAD_DEPTH="$FULL_LOOKAHEAD_DEPTH" \
  AZMETA_FULL_LOOKAHEAD_BEAM="$FULL_LOOKAHEAD_BEAM" \
  AZMETA_FULL_LOOKAHEAD_ROOT_BEAM="$FULL_LOOKAHEAD_ROOT_BEAM" \
  AZMETA_FULL_TARGET_TEMP="$FULL_TARGET_TEMP" \
  AZMETA_FARM_VALUE_BONUS="$FARM_VALUE_BONUS" \
  AZMETA_FARM_VALUE_THRESHOLD="$FARM_VALUE_THRESHOLD" \
  AZMETA_FORBID_TYPES="$FORBID_TYPES" \
  AZMETA_MAX_STATUS_LEVEL="$MAX_STATUS_LEVEL" \
  AZMETA_WEIGHTS="$WEIGHTS" \
  AZMETA_PATCH_NAV_WEIGHTS="$PATCH_NAV_WEIGHTS" \
  AZMETA_PATCH_NAV_GATE="$PATCH_NAV_GATE" \
  AZMETA_PATCH2_NAV_WEIGHTS="$PATCH2_NAV_WEIGHTS" \
  AZMETA_PATCH2_NAV_GATE="$PATCH2_NAV_GATE" \
  AZMETA_MICRO_WEIGHTS="$MICRO_WEIGHTS" \
  AZMETA_MICRO_GATE="$MICRO_GATE" \
  AZMETA_ROUTE_CLOSER_MICRO_WEIGHTS="$ROUTE_CLOSER_MICRO_WEIGHTS" \
  AZMETA_PVP_PIVOT_ORACLE="$PVP_PIVOT_ORACLE" \
  AZMETA_OUT="$OUT_DIR/meta/policy_meta.json" \
  npx vitest run src/lib/play/ml/_azmeta.test.ts --disable-console-intercept

CUDA_VISIBLE_DEVICES="$SAMPLED_GPU" \
  AZMETA=1 \
  AZMETA_GAMES="$META_GAMES" \
  AZMETA_ITERS="$META_ITERS" \
  AZMETA_CONTROL="$CONTROL" \
  AZMETA_FULL_SELECTION="$FULL_SELECTION" \
  AZMETA_FULL_LOOKAHEAD_DEPTH="$FULL_LOOKAHEAD_DEPTH" \
  AZMETA_FULL_LOOKAHEAD_BEAM="$FULL_LOOKAHEAD_BEAM" \
  AZMETA_FULL_LOOKAHEAD_ROOT_BEAM="$FULL_LOOKAHEAD_ROOT_BEAM" \
  AZMETA_FULL_TARGET_TEMP="$FULL_TARGET_TEMP" \
  AZMETA_FARM_VALUE_BONUS="$FARM_VALUE_BONUS" \
  AZMETA_FARM_VALUE_THRESHOLD="$FARM_VALUE_THRESHOLD" \
  AZMETA_FORBID_TYPES="$FORBID_TYPES" \
  AZMETA_MAX_STATUS_LEVEL="$MAX_STATUS_LEVEL" \
  AZMETA_SAMPLE=1 \
  AZMETA_TEMP=0.5 \
  AZMETA_WEIGHTS="$WEIGHTS" \
  AZMETA_PATCH_NAV_WEIGHTS="$PATCH_NAV_WEIGHTS" \
  AZMETA_PATCH_NAV_GATE="$PATCH_NAV_GATE" \
  AZMETA_PATCH2_NAV_WEIGHTS="$PATCH2_NAV_WEIGHTS" \
  AZMETA_PATCH2_NAV_GATE="$PATCH2_NAV_GATE" \
  AZMETA_MICRO_WEIGHTS="$MICRO_WEIGHTS" \
  AZMETA_MICRO_GATE="$MICRO_GATE" \
  AZMETA_ROUTE_CLOSER_MICRO_WEIGHTS="$ROUTE_CLOSER_MICRO_WEIGHTS" \
  AZMETA_PVP_PIVOT_ORACLE="$PVP_PIVOT_ORACLE" \
  AZMETA_OUT="$OUT_DIR/meta/policy_meta_sampled.json" \
  npx vitest run src/lib/play/ml/_azmeta.test.ts --disable-console-intercept

CUDA_VISIBLE_DEVICES="$ARENA_GPU" \
  AZEVAL=1 \
  AZEVAL_GAMES="$ARENA_GAMES" \
  AZEVAL_ITERS="$ARENA_ITERS" \
  AZEVAL_CONTROL="$CONTROL" \
  AZEVAL_FULL_SELECTION="$FULL_SELECTION" \
  AZEVAL_FULL_LOOKAHEAD_DEPTH="$FULL_LOOKAHEAD_DEPTH" \
  AZEVAL_FULL_LOOKAHEAD_BEAM="$FULL_LOOKAHEAD_BEAM" \
  AZEVAL_FULL_LOOKAHEAD_ROOT_BEAM="$FULL_LOOKAHEAD_ROOT_BEAM" \
  AZEVAL_FULL_TARGET_TEMP="$FULL_TARGET_TEMP" \
  AZEVAL_FARM_VALUE_BONUS="$FARM_VALUE_BONUS" \
  AZEVAL_FARM_VALUE_THRESHOLD="$FARM_VALUE_THRESHOLD" \
  AZEVAL_FORBID_TYPES="$FORBID_TYPES" \
  AZEVAL_MAX_STATUS_LEVEL="$MAX_STATUS_LEVEL" \
  AZEVAL_WEIGHTS="$WEIGHTS" \
  AZEVAL_PATCH_NAV_WEIGHTS="$PATCH_NAV_WEIGHTS" \
  AZEVAL_PATCH_NAV_GATE="$PATCH_NAV_GATE" \
  AZEVAL_PATCH2_NAV_WEIGHTS="$PATCH2_NAV_WEIGHTS" \
  AZEVAL_PATCH2_NAV_GATE="$PATCH2_NAV_GATE" \
  AZEVAL_MICRO_WEIGHTS="$MICRO_WEIGHTS" \
  AZEVAL_MICRO_GATE="$MICRO_GATE" \
  AZEVAL_ROUTE_CLOSER_MICRO_WEIGHTS="$ROUTE_CLOSER_MICRO_WEIGHTS" \
  AZEVAL_PVP_PIVOT_ORACLE="$PVP_PIVOT_ORACLE" \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept
cp ml/azeval_result.json "$OUT_DIR/arena/policy_vs_heuristic_field.json"

CUDA_VISIBLE_DEVICES="$ARENA_GPU" \
  AZEVAL=1 \
  AZEVAL_GAMES="$FORCED_GAMES" \
  AZEVAL_ITERS="$FORCED_ITERS" \
  AZEVAL_CONTROL="$CONTROL" \
  AZEVAL_FULL_SELECTION="$FULL_SELECTION" \
  AZEVAL_FULL_LOOKAHEAD_DEPTH="$FULL_LOOKAHEAD_DEPTH" \
  AZEVAL_FULL_LOOKAHEAD_BEAM="$FULL_LOOKAHEAD_BEAM" \
  AZEVAL_FULL_LOOKAHEAD_ROOT_BEAM="$FULL_LOOKAHEAD_ROOT_BEAM" \
  AZEVAL_FULL_TARGET_TEMP="$FULL_TARGET_TEMP" \
  AZEVAL_FARM_VALUE_BONUS="$FARM_VALUE_BONUS" \
  AZEVAL_FARM_VALUE_THRESHOLD="$FARM_VALUE_THRESHOLD" \
  AZEVAL_FORBID_TYPES="$FORBID_TYPES" \
  AZEVAL_MAX_STATUS_LEVEL="$MAX_STATUS_LEVEL" \
  AZEVAL_FORCE_DEST="Arcane Abyss" \
  AZEVAL_WEIGHTS="$WEIGHTS" \
  AZEVAL_PATCH_NAV_WEIGHTS="$PATCH_NAV_WEIGHTS" \
  AZEVAL_PATCH_NAV_GATE="$PATCH_NAV_GATE" \
  AZEVAL_PATCH2_NAV_WEIGHTS="$PATCH2_NAV_WEIGHTS" \
  AZEVAL_PATCH2_NAV_GATE="$PATCH2_NAV_GATE" \
  AZEVAL_MICRO_WEIGHTS="$MICRO_WEIGHTS" \
  AZEVAL_MICRO_GATE="$MICRO_GATE" \
  AZEVAL_ROUTE_CLOSER_MICRO_WEIGHTS="$ROUTE_CLOSER_MICRO_WEIGHTS" \
  AZEVAL_PVP_PIVOT_ORACLE="$PVP_PIVOT_ORACLE" \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept
cp ml/azeval_result.json "$OUT_DIR/forced/policy_forced_abyss.json"

CUDA_VISIBLE_DEVICES="$ARENA_GPU" \
  AZEVAL=1 \
  AZEVAL_GAMES="$FORCED_GAMES" \
  AZEVAL_ITERS="$FORCED_ITERS" \
  AZEVAL_CONTROL="$CONTROL" \
  AZEVAL_FULL_SELECTION="$FULL_SELECTION" \
  AZEVAL_FULL_LOOKAHEAD_DEPTH="$FULL_LOOKAHEAD_DEPTH" \
  AZEVAL_FULL_LOOKAHEAD_BEAM="$FULL_LOOKAHEAD_BEAM" \
  AZEVAL_FULL_LOOKAHEAD_ROOT_BEAM="$FULL_LOOKAHEAD_ROOT_BEAM" \
  AZEVAL_FULL_TARGET_TEMP="$FULL_TARGET_TEMP" \
  AZEVAL_FARM_VALUE_BONUS="$FARM_VALUE_BONUS" \
  AZEVAL_FARM_VALUE_THRESHOLD="$FARM_VALUE_THRESHOLD" \
  AZEVAL_FORBID_TYPES="$PURE_FORBID_TYPES" \
  AZEVAL_MAX_STATUS_LEVEL="$PURE_MAX_STATUS_LEVEL" \
  AZEVAL_FORCE_DEST="Arcane Abyss" \
  AZEVAL_WEIGHTS="$WEIGHTS" \
  AZEVAL_PATCH_NAV_WEIGHTS="$PATCH_NAV_WEIGHTS" \
  AZEVAL_PATCH_NAV_GATE="$PATCH_NAV_GATE" \
  AZEVAL_PATCH2_NAV_WEIGHTS="$PATCH2_NAV_WEIGHTS" \
  AZEVAL_PATCH2_NAV_GATE="$PATCH2_NAV_GATE" \
  AZEVAL_MICRO_WEIGHTS="$MICRO_WEIGHTS" \
  AZEVAL_MICRO_GATE="$MICRO_GATE" \
  AZEVAL_ROUTE_CLOSER_MICRO_WEIGHTS="$ROUTE_CLOSER_MICRO_WEIGHTS" \
  AZEVAL_PVP_PIVOT_ORACLE="$PVP_PIVOT_ORACLE" \
  npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept
cp ml/azeval_result.json "$OUT_DIR/forced/policy_forced_abyss_pure.json"

node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const runId = process.env.RUN_ID;
const outDir = `ml/meta_runs/${runId}`;
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const deterministic = read(`${outDir}/meta/policy_meta.json`);
const sampled = read(`${outDir}/meta/policy_meta_sampled.json`);
const arena = read(`${outDir}/arena/policy_vs_heuristic_field.json`);
const forcedAbyss = read(`${outDir}/forced/policy_forced_abyss.json`);
const forcedAbyssPure = read(`${outDir}/forced/policy_forced_abyss_pure.json`);
const weights = read(process.env.WEIGHTS);
const farmOpportunityOk = (row) =>
  (row.farm_opportunity_vp_per_seat_game ?? 0) < 1 ||
  (row.missed_farm_opportunity_vp_pct ?? 100) <= 50;
const plannerFarmOpportunityOk = (row) =>
  (row.planner_farm_opportunity_vp_per_game ?? 0) < 1 ||
  (row.planner_missed_farm_opportunity_vp_pct ?? 100) <= 50;
const sharedMetaMinAvgVp = Number(process.env.SHARED_META_MIN_AVG_VP || 18);
const sampledMetaMinAvgVp = Number(process.env.SAMPLED_META_MIN_AVG_VP || 15);
const sharedMetaMinReach30Pct = Number(process.env.SHARED_META_MIN_REACH30_PCT || 10);
const forbidTypes = (process.env.FORBID_TYPES || '').split(',').map((s) => s.trim()).filter(Boolean);
const maxStatusLevel = process.env.MAX_STATUS_LEVEL === '' ? null : Number(process.env.MAX_STATUS_LEVEL);
const unrestrictedRules =
  !forbidTypes.includes('initiatePvp') &&
  (maxStatusLevel === null || maxStatusLevel >= 3);
const farmToPvpOk = (row) => {
  if (!unrestrictedRules) return true;
  const pvpVp = row.planner_pvp_vp_per_game ?? 0;
  const pvpAttacks = row.planner_pvp_attacks_per_game ?? 0;
  const targetVp = row.planner_pvp_target_vp_per_game ?? 0;
  const missed = row.planner_missed_pvp_opportunity_pct ?? 100;
  const missedHard = row.planner_missed_pvp_hard_monster_opportunity_pct ?? 100;
  const highValueWindows = row.planner_pvp_high_value_opportunities_per_game ?? 0;
  return (
    pvpVp > 0 &&
    pvpAttacks > 0 &&
    targetVp > 0 &&
    missed <= 25 &&
    (highValueWindows <= 0 || missedHard <= 25)
  );
};
const sharedMetaOk =
  deterministic.avg_vp >= sharedMetaMinAvgVp &&
  sampled.avg_vp >= sampledMetaMinAvgVp &&
  deterministic.reach30_pct >= sharedMetaMinReach30Pct &&
  sampled.reach30_pct >= sharedMetaMinReach30Pct &&
  farmOpportunityOk(deterministic) &&
  farmOpportunityOk(sampled);
const arenaOk =
  arena.planner_win_pct >= 50 &&
  plannerFarmOpportunityOk(arena) &&
  farmToPvpOk(arena);

const summary = {
  run_id: runId,
  weights: process.env.WEIGHTS,
  patch_nav_weights: process.env.PATCH_NAV_WEIGHTS || null,
  patch_nav_gate: process.env.PATCH_NAV_GATE,
  patch2_nav_weights: process.env.PATCH2_NAV_WEIGHTS || null,
  patch2_nav_gate: process.env.PATCH2_NAV_GATE,
  micro_weights: process.env.MICRO_WEIGHTS || null,
  micro_gate: process.env.MICRO_GATE,
  route_closer_micro_weights: process.env.ROUTE_CLOSER_MICRO_WEIGHTS || null,
  pvp_pivot_oracle: process.env.PVP_PIVOT_ORACLE,
  weight_dims: { obs_dim: weights.obs_dim, act_dim: weights.act_dim },
  control: process.env.CONTROL,
  full_selection: process.env.FULL_SELECTION,
  full_lookahead_depth: Number(process.env.FULL_LOOKAHEAD_DEPTH),
  full_lookahead_beam: Number(process.env.FULL_LOOKAHEAD_BEAM),
  full_lookahead_root_beam: Number(process.env.FULL_LOOKAHEAD_ROOT_BEAM),
  full_target_temp: Number(process.env.FULL_TARGET_TEMP),
  farm_value_bonus: Number(process.env.FARM_VALUE_BONUS),
  farm_value_threshold: Number(process.env.FARM_VALUE_THRESHOLD),
  forbid_types: forbidTypes,
  max_status_level: maxStatusLevel,
  unrestricted_rules: unrestrictedRules,
  generated_at: new Date().toISOString(),
  deterministic_meta: {
    avg_vp: deterministic.avg_vp,
    reach30_pct: deterministic.reach30_pct,
    avg_status: deterministic.avg_status,
    inferred_strategy: deterministic.inferred_strategy,
    farm_opportunity_vp_per_seat_game: deterministic.farm_opportunity_vp_per_seat_game,
    missed_farm_opportunity_vp_per_seat_game: deterministic.missed_farm_opportunity_vp_per_seat_game,
    missed_farm_opportunity_vp_pct: deterministic.missed_farm_opportunity_vp_pct,
    missed_farmable_nav_pct: deterministic.missed_farmable_nav_pct,
    meta_score: deterministic.meta_score
  },
  sampled_meta: {
    avg_vp: sampled.avg_vp,
    reach30_pct: sampled.reach30_pct,
    avg_status: sampled.avg_status,
    inferred_strategy: sampled.inferred_strategy,
    farm_opportunity_vp_per_seat_game: sampled.farm_opportunity_vp_per_seat_game,
    missed_farm_opportunity_vp_per_seat_game: sampled.missed_farm_opportunity_vp_per_seat_game,
    missed_farm_opportunity_vp_pct: sampled.missed_farm_opportunity_vp_pct,
    missed_farmable_nav_pct: sampled.missed_farmable_nav_pct,
    meta_score: sampled.meta_score
  },
  arena: {
    planner_win_pct: arena.planner_win_pct,
    planner_VP_avg: arena.planner_VP_avg,
    planner_status_avg: arena.planner_status_avg,
    planner_farm_opportunity_vp_per_game: arena.planner_farm_opportunity_vp_per_game,
    planner_missed_farm_opportunity_vp_per_game: arena.planner_missed_farm_opportunity_vp_per_game,
    planner_missed_farm_opportunity_vp_pct: arena.planner_missed_farm_opportunity_vp_pct,
    planner_missed_farmable_nav_pct: arena.planner_missed_farmable_nav_pct,
    planner_pvp_attacks_per_game: arena.planner_pvp_attacks_per_game,
    planner_pvp_vp_per_game: arena.planner_pvp_vp_per_game,
    planner_pvp_target_vp_per_game: arena.planner_pvp_target_vp_per_game,
    planner_pvp_best_target_vp: arena.planner_pvp_best_target_vp,
    planner_pvp_high_value_opportunities_per_game: arena.planner_pvp_high_value_opportunities_per_game,
    planner_missed_pvp_opportunity_pct: arena.planner_missed_pvp_opportunity_pct,
    planner_pvp_hard_monster_attacks_per_game: arena.planner_pvp_hard_monster_attacks_per_game,
    planner_pvp_hard_monster_vp_per_game: arena.planner_pvp_hard_monster_vp_per_game,
    planner_missed_pvp_hard_monster_opportunity_pct: arena.planner_missed_pvp_hard_monster_opportunity_pct,
    planner_pvp_good_target_pivot_attacks_per_game: arena.planner_pvp_good_target_pivot_attacks_per_game,
    planner_pvp_good_target_pivot_vp_per_game: arena.planner_pvp_good_target_pivot_vp_per_game,
    planner_pvp_good_target_pivot_best_target_vp: arena.planner_pvp_good_target_pivot_best_target_vp,
    planner_missed_pvp_good_target_pivot_opportunity_pct: arena.planner_missed_pvp_good_target_pivot_opportunity_pct,
    field_bestVP_avg: arena.field_bestVP_avg,
    field_wins_by_profile: arena.field_wins_by_profile
  },
  forced_abyss: {
    planner_win_pct: forcedAbyss.planner_win_pct,
    planner_VP_avg: forcedAbyss.planner_VP_avg,
    planner_status_avg: forcedAbyss.planner_status_avg,
    planner_monster_kills_per_game: forcedAbyss.planner_monster_kills_per_game,
    planner_monster_combats_per_game: forcedAbyss.planner_monster_combats_per_game,
    planner_farm_opportunity_vp_per_game: forcedAbyss.planner_farm_opportunity_vp_per_game,
    planner_missed_farm_opportunity_vp_per_game: forcedAbyss.planner_missed_farm_opportunity_vp_per_game,
    planner_missed_farm_opportunity_vp_pct: forcedAbyss.planner_missed_farm_opportunity_vp_pct,
    planner_missed_farmable_nav_pct: forcedAbyss.planner_missed_farmable_nav_pct,
    field_bestVP_avg: forcedAbyss.field_bestVP_avg
  },
  forced_abyss_pure: {
    planner_win_pct: forcedAbyssPure.planner_win_pct,
    planner_VP_avg: forcedAbyssPure.planner_VP_avg,
    planner_status_avg: forcedAbyssPure.planner_status_avg,
    planner_monster_kills_per_game: forcedAbyssPure.planner_monster_kills_per_game,
    planner_monster_combats_per_game: forcedAbyssPure.planner_monster_combats_per_game,
    planner_farm_opportunity_vp_per_game: forcedAbyssPure.planner_farm_opportunity_vp_per_game,
    planner_missed_farm_opportunity_vp_per_game: forcedAbyssPure.planner_missed_farm_opportunity_vp_per_game,
    planner_missed_farm_opportunity_vp_pct: forcedAbyssPure.planner_missed_farm_opportunity_vp_pct,
    planner_missed_farmable_nav_pct: forcedAbyssPure.planner_missed_farmable_nav_pct,
    field_bestVP_avg: forcedAbyssPure.field_bestVP_avg
  },
  artifacts: {
    deterministic_meta: `${outDir}/meta/policy_meta.json`,
    sampled_meta: `${outDir}/meta/policy_meta_sampled.json`,
    arena: `${outDir}/arena/policy_vs_heuristic_field.json`,
    forced_abyss: `${outDir}/forced/policy_forced_abyss.json`,
    forced_abyss_pure: `${outDir}/forced/policy_forced_abyss_pure.json`
  },
  farm_to_pvp_contract: {
    required: unrestrictedRules,
    ok: farmToPvpOk(arena),
    note: unrestrictedRules
      ? 'Unrestricted candidates must farm efficient monster lives, then take legal PvP when player-target EV is better.'
      : 'Pure/no-PvP or status-capped diagnostic run; PvP pivot is not required for this verdict.'
  },
  shared_meta_contract: {
    ok: sharedMetaOk,
    deterministic_min_avg_vp: sharedMetaMinAvgVp,
    sampled_min_avg_vp: sampledMetaMinAvgVp,
    min_reach30_pct: sharedMetaMinReach30Pct,
    note: 'Candidate promotion requires retained-field strength plus robust all-seat/shared-policy play; beating weak heuristic targets alone is not enough.'
  },
  arena_contract: {
    ok: arenaOk,
    note: 'Retained heuristic-field arena contract. Useful regression gate, but not sufficient by itself for a solved meta.'
  },
  verdict:
    sharedMetaOk &&
    arenaOk &&
    (!unrestrictedRules ? arena.planner_status_avg < 1.5 : true) &&
    forcedAbyss.planner_monster_kills_per_game > 0 &&
    forcedAbyssPure.planner_status_avg <= 0.25
      ? 'candidate'
      : 'not-yet'
};

writeFileSync(`${outDir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE

echo "DONE: $OUT_DIR/summary.json"
REMOTE
status=$?
set -e

LOCAL_OUT_DIR="ml/meta_runs/$RUN_ID"
mkdir -p "$LOCAL_OUT_DIR/weights"
rsync_status=0
rsync -az "$HOST:$REMOTE_DIR/ml/meta_runs/$RUN_ID/" "$LOCAL_OUT_DIR/" || rsync_status=$?
if [[ "$WEIGHTS" = /* ]]; then
  rsync -az "$HOST:$WEIGHTS" "$LOCAL_OUT_DIR/weights/eval_policy.json" || true
else
  rsync -az "$HOST:$REMOTE_DIR/$WEIGHTS" "$LOCAL_OUT_DIR/weights/eval_policy.json" || true
fi

manifest_status=0
if [[ -s "$LOCAL_OUT_DIR/summary.json" ]]; then
  MANIFEST_WEIGHTS="$LOCAL_OUT_DIR/weights/eval_policy.json"
  if [[ ! -s "$MANIFEST_WEIGHTS" ]]; then
    MANIFEST_WEIGHTS="$WEIGHTS"
  fi
  node scripts/write-bot-baseline-manifest.mjs \
    --run-id "$RUN_ID" \
    --label "$RUN_ID" \
    --weights "$MANIFEST_WEIGHTS" \
    --eval-summary "$LOCAL_OUT_DIR/summary.json" \
    --out "$LOCAL_OUT_DIR/baseline-manifest.json" \
    --notes "strict full-control meta evaluation suite" || manifest_status=$?
else
  echo "warning: no local summary at $LOCAL_OUT_DIR/summary.json; skipping baseline manifest" >&2
fi
if [[ "$status" -ne 0 ]]; then
  exit "$status"
fi
if [[ "$rsync_status" -ne 0 ]]; then
  exit "$rsync_status"
fi
exit "$manifest_status"
