#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN_ID="${RUN_ID:-role-portfolio-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="ml/meta_runs/$RUN_ID"
LOG_DIR="$OUT_DIR/logs"

GPU="${GPU:-4}"
MIN_FREE_MB="${MIN_FREE_MB:-10000}"
GAMES="${GAMES:-8}"
ITERS="${ITERS:-64}"
HORIZON="${HORIZON:-24}"
PROGRESS_EVERY="${PROGRESS_EVERY:-2}"
FULL_SELECTION="${FULL_SELECTION:-value}"
LOOKAHEAD_DEPTH="${LOOKAHEAD_DEPTH:-2}"
LOOKAHEAD_BEAM="${LOOKAHEAD_BEAM:-8}"
LOOKAHEAD_ROOT_BEAM="${LOOKAHEAD_ROOT_BEAM:-24}"
TARGET_TEMP="${TARGET_TEMP:-0.25}"
ROLES_RAW="${ROLES:-current,conversion,target,pure}"
STACK="${STACK:-ml/stacks/league-current-goodbuilder-scorefloor-conversion-hunter.json}"

HUNTER_WEIGHTS="${HUNTER_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/best_policy.full.json}"
HUNTER_PATCH_WEIGHTS="${HUNTER_PATCH_WEIGHTS:-ml/meta_runs/pvp-route-mode-20260630T124558Z/pvp_route_mode_head_policy.json}"
HUNTER_MICRO_WEIGHTS="${HUNTER_MICRO_WEIGHTS:-$HUNTER_PATCH_WEIGHTS}"
HUNTER_PATCH_GATE="${HUNTER_PATCH_GATE:-pvp-predictive-mode-hunt-fallback-rebuild-pivot}"
HUNTER_MICRO_GATE="${HUNTER_MICRO_GATE:-pvp-pivot-encounter-force}"
HUNTER_REBUILD_MIN_ROUND="${HUNTER_REBUILD_MIN_ROUND:-14}"
HUNTER_REBUILD_SKIP_TARGET_VP="${HUNTER_REBUILD_SKIP_TARGET_VP:-12}"
HUNTER_GOOD_TARGET_PIVOT_MIN_TARGET_VP="${HUNTER_GOOD_TARGET_PIVOT_MIN_TARGET_VP:-12}"
HUNTER_STATUS2_DESCEND_MIN_TARGET_VP="${HUNTER_STATUS2_DESCEND_MIN_TARGET_VP:-9}"
HUNTER_FORCE_HIGH_VALUE_TARGET_VP="${HUNTER_FORCE_HIGH_VALUE_TARGET_VP:-18}"
HUNTER_LOW_TAIL_HUNT_MAX_VP="${HUNTER_LOW_TAIL_HUNT_MAX_VP:-}"
HUNTER_LOW_TAIL_HUNT_MIN_ROUND="${HUNTER_LOW_TAIL_HUNT_MIN_ROUND:-}"
HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP="${HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP:-}"
HUNTER_LOW_TAIL_HUNT_MIN_TARGET_VP="${HUNTER_LOW_TAIL_HUNT_MIN_TARGET_VP:-}"

TARGET_WEIGHTS="${TARGET_WEIGHTS:-ml/meta_runs/allseat-goodbuilder-medium-20260630Tgoal/allseat_goodbuilder_policy.json}"
TARGET_NAV_WEIGHTS="${TARGET_NAV_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/nav_build_policy.json}"
TARGET_NAV_GATE="${TARGET_NAV_GATE:-good-nonfallen-score-floor}"
TARGET_MICRO_WEIGHTS="${TARGET_MICRO_WEIGHTS:-$TARGET_WEIGHTS}"
TARGET_MICRO_GATE="${TARGET_MICRO_GATE:-good-builder-hp4-scorefloor-oracle}"
TARGET_STATUS_CAP="${TARGET_STATUS_CAP:-2}"
TARGET_FORBID_TYPES="${TARGET_FORBID_TYPES:-initiatePvp}"
TARGET_CONTROLLED_CORRUPT_FARM="${TARGET_CONTROLLED_CORRUPT_FARM:-0}"
TARGET_CONTROLLED_CORRUPT_MAX_VP="${TARGET_CONTROLLED_CORRUPT_MAX_VP:-18}"
TARGET_ROUTE_FINISH_ORACLE="${TARGET_ROUTE_FINISH_ORACLE:-0}"

PURE_WEIGHTS="${PURE_WEIGHTS:-$HUNTER_WEIGHTS}"
PURE_NAV_WEIGHTS="${PURE_NAV_WEIGHTS:-$TARGET_NAV_WEIGHTS}"
PURE_NAV_GATE="${PURE_NAV_GATE:-good-nonfallen-score-floor}"
PURE_MICRO_WEIGHTS="${PURE_MICRO_WEIGHTS:-$PURE_WEIGHTS}"
PURE_MICRO_GATE="${PURE_MICRO_GATE:-good-builder-hp4-scorefloor-oracle}"
PURE_STATUS_CAP="${PURE_STATUS_CAP:-0}"
PURE_FORBID_TYPES="${PURE_FORBID_TYPES:-initiatePvp}"
PURE_CONTROLLED_CORRUPT_FARM="${PURE_CONTROLLED_CORRUPT_FARM:-0}"
PURE_CONTROLLED_CORRUPT_MAX_VP="${PURE_CONTROLLED_CORRUPT_MAX_VP:-18}"
PURE_ROUTE_FINISH_ORACLE="${PURE_ROUTE_FINISH_ORACLE:-0}"

PORTFOLIO_MIN_FLOOR_VP="${PORTFOLIO_MIN_FLOOR_VP:-15}"
PORTFOLIO_EXPLOIT_GAP_VP="${PORTFOLIO_EXPLOIT_GAP_VP:-6}"
PORTFOLIO_MAX_CONCEDED_SHARE="${PORTFOLIO_MAX_CONCEDED_SHARE:-8}"
PROMOTION_MIN_BEST_VP="${PROMOTION_MIN_BEST_VP:-30}"
PROMOTION_MIN_BEST_REACH30="${PROMOTION_MIN_BEST_REACH30:-80}"
PROMOTION_MAX_MISSED_PVP_PCT="${PROMOTION_MAX_MISSED_PVP_PCT:-0}"

mkdir -p "$OUT_DIR" "$LOG_DIR"

echo "== Arc role portfolio eval =="
echo "run_id=$RUN_ID out_dir=$OUT_DIR"
echo "stack=$STACK roles=$ROLES_RAW games=$GAMES iters=$ITERS horizon=$HORIZON gpu=$GPU"
echo "full_selection=$FULL_SELECTION lookahead_depth=$LOOKAHEAD_DEPTH lookahead_beam=$LOOKAHEAD_BEAM lookahead_root_beam=$LOOKAHEAD_ROOT_BEAM"
echo "hunter_patch_gate=$HUNTER_PATCH_GATE hunter_micro_gate=$HUNTER_MICRO_GATE hunter_min_target_vp=$HUNTER_GOOD_TARGET_PIVOT_MIN_TARGET_VP"
echo "hunter_low_tail_max_vp=${HUNTER_LOW_TAIL_HUNT_MAX_VP:-off} hunter_low_tail_min_round=${HUNTER_LOW_TAIL_HUNT_MIN_ROUND:-default} hunter_low_tail_min_monster_hp=${HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP:-default}"

if [[ ! -s "$STACK" ]]; then
  echo "missing stack manifest: $STACK" >&2
  exit 2
fi

cat > "$OUT_DIR/config.json" <<JSON
{
  "run_id": "$RUN_ID",
  "stack": "$STACK",
  "roles": "$ROLES_RAW",
  "gpu": "$GPU",
  "games": "$GAMES",
  "iters": "$ITERS",
  "horizon": "$HORIZON",
  "full_selection": "$FULL_SELECTION",
  "lookahead_depth": "$LOOKAHEAD_DEPTH",
  "lookahead_beam": "$LOOKAHEAD_BEAM",
  "lookahead_root_beam": "$LOOKAHEAD_ROOT_BEAM",
  "target_temp": "$TARGET_TEMP",
  "hunter_weights": "$HUNTER_WEIGHTS",
  "hunter_patch_weights": "$HUNTER_PATCH_WEIGHTS",
  "hunter_micro_weights": "$HUNTER_MICRO_WEIGHTS",
  "hunter_patch_gate": "$HUNTER_PATCH_GATE",
  "hunter_micro_gate": "$HUNTER_MICRO_GATE",
  "hunter_rebuild_min_round": "$HUNTER_REBUILD_MIN_ROUND",
  "hunter_rebuild_skip_target_vp": "$HUNTER_REBUILD_SKIP_TARGET_VP",
  "hunter_good_target_pivot_min_target_vp": "$HUNTER_GOOD_TARGET_PIVOT_MIN_TARGET_VP",
  "hunter_status2_descend_min_target_vp": "$HUNTER_STATUS2_DESCEND_MIN_TARGET_VP",
  "hunter_force_high_value_target_vp": "$HUNTER_FORCE_HIGH_VALUE_TARGET_VP",
  "hunter_low_tail_hunt_max_vp": "$HUNTER_LOW_TAIL_HUNT_MAX_VP",
  "hunter_low_tail_hunt_min_round": "$HUNTER_LOW_TAIL_HUNT_MIN_ROUND",
  "hunter_low_tail_hunt_min_monster_hp": "$HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP",
  "hunter_low_tail_hunt_min_target_vp": "$HUNTER_LOW_TAIL_HUNT_MIN_TARGET_VP",
  "target_controlled_corrupt_farm": "$TARGET_CONTROLLED_CORRUPT_FARM",
  "target_controlled_corrupt_max_vp": "$TARGET_CONTROLLED_CORRUPT_MAX_VP",
  "target_route_finish_oracle": "$TARGET_ROUTE_FINISH_ORACLE",
  "pure_controlled_corrupt_farm": "$PURE_CONTROLLED_CORRUPT_FARM",
  "pure_controlled_corrupt_max_vp": "$PURE_CONTROLLED_CORRUPT_MAX_VP",
  "pure_route_finish_oracle": "$PURE_ROUTE_FINISH_ORACLE"
}
JSON

if command -v nvidia-smi >/dev/null 2>&1; then
  free_mb="$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  used_mb="$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  echo "gpu=$GPU free_mb=${free_mb:-unknown} used_mb=${used_mb:-unknown} min_free_mb=$MIN_FREE_MB"
  if [[ -n "${free_mb:-}" && "$free_mb" -lt "$MIN_FREE_MB" ]]; then
    echo "refusing role portfolio eval: GPU $GPU has ${free_mb}MB free, below MIN_FREE_MB=$MIN_FREE_MB" >&2
    exit 3
  fi
fi

run_eval() {
  local role="$1"
  local out="$OUT_DIR/${role}.json"
  echo "== role: $role =="
  case "$role" in
	    current)
	      env \
	        ARC_PVP_REBUILD_MIN_ROUND="$HUNTER_REBUILD_MIN_ROUND" \
	        ARC_PVP_REBUILD_SKIP_TARGET_VP="$HUNTER_REBUILD_SKIP_TARGET_VP" \
	        ARC_PVP_GOOD_TARGET_PIVOT_MIN_TARGET_VP="$HUNTER_GOOD_TARGET_PIVOT_MIN_TARGET_VP" \
	        ARC_PVP_STATUS2_DESCEND_MIN_TARGET_VP="$HUNTER_STATUS2_DESCEND_MIN_TARGET_VP" \
	        ARC_PVP_FORCE_HIGH_VALUE_TARGET_VP="$HUNTER_FORCE_HIGH_VALUE_TARGET_VP" \
	        ARC_PVP_LOW_TAIL_HUNT_MAX_VP="$HUNTER_LOW_TAIL_HUNT_MAX_VP" \
	        ARC_PVP_LOW_TAIL_HUNT_MIN_ROUND="$HUNTER_LOW_TAIL_HUNT_MIN_ROUND" \
	        ARC_PVP_LOW_TAIL_HUNT_MIN_MONSTER_HP="$HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP" \
	        ARC_PVP_LOW_TAIL_HUNT_MIN_TARGET_VP="$HUNTER_LOW_TAIL_HUNT_MIN_TARGET_VP" \
	        CUDA_VISIBLE_DEVICES="$GPU" \
        AZEVAL=1 \
        AZEVAL_GAMES="$GAMES" \
        AZEVAL_ITERS="$ITERS" \
        AZEVAL_HORIZON="$HORIZON" \
        AZEVAL_PROGRESS_EVERY="$PROGRESS_EVERY" \
        AZEVAL_CONTROL=full \
        AZEVAL_FULL_SELECTION="$FULL_SELECTION" \
        AZEVAL_FULL_LOOKAHEAD_DEPTH="$LOOKAHEAD_DEPTH" \
        AZEVAL_FULL_LOOKAHEAD_BEAM="$LOOKAHEAD_BEAM" \
        AZEVAL_FULL_LOOKAHEAD_ROOT_BEAM="$LOOKAHEAD_ROOT_BEAM" \
        AZEVAL_FULL_TARGET_TEMP="$TARGET_TEMP" \
        AZEVAL_VALUEW=1 \
        AZEVAL_WEIGHTS="$HUNTER_WEIGHTS" \
        AZEVAL_PATCH_NAV_WEIGHTS="$HUNTER_PATCH_WEIGHTS" \
        AZEVAL_PATCH_NAV_GATE="$HUNTER_PATCH_GATE" \
        AZEVAL_MICRO_WEIGHTS="$HUNTER_MICRO_WEIGHTS" \
        AZEVAL_MICRO_GATE="$HUNTER_MICRO_GATE" \
        AZEVAL_PLANNER_ROLE_NAME="current-champion-hunter" \
        AZEVAL_NEURAL_FIELD=1 \
        AZEVAL_NEURAL_FIELD_STACKS_FILE="$STACK" \
        AZEVAL_OUT="$out" \
        npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
        2>&1 | tee "$LOG_DIR/${role}.log"
      ;;
	    conversion)
	      env \
	        ARC_PVP_REBUILD_MIN_ROUND="$HUNTER_REBUILD_MIN_ROUND" \
	        ARC_PVP_REBUILD_SKIP_TARGET_VP="$HUNTER_REBUILD_SKIP_TARGET_VP" \
	        ARC_PVP_GOOD_TARGET_PIVOT_MIN_TARGET_VP="$HUNTER_GOOD_TARGET_PIVOT_MIN_TARGET_VP" \
	        ARC_PVP_STATUS2_DESCEND_MIN_TARGET_VP="$HUNTER_STATUS2_DESCEND_MIN_TARGET_VP" \
	        ARC_PVP_FORCE_HIGH_VALUE_TARGET_VP="$HUNTER_FORCE_HIGH_VALUE_TARGET_VP" \
	        ARC_PVP_LOW_TAIL_HUNT_MAX_VP="$HUNTER_LOW_TAIL_HUNT_MAX_VP" \
	        ARC_PVP_LOW_TAIL_HUNT_MIN_ROUND="$HUNTER_LOW_TAIL_HUNT_MIN_ROUND" \
	        ARC_PVP_LOW_TAIL_HUNT_MIN_MONSTER_HP="$HUNTER_LOW_TAIL_HUNT_MIN_MONSTER_HP" \
	        ARC_PVP_LOW_TAIL_HUNT_MIN_TARGET_VP="$HUNTER_LOW_TAIL_HUNT_MIN_TARGET_VP" \
	        CUDA_VISIBLE_DEVICES="$GPU" \
        AZEVAL=1 \
        AZEVAL_GAMES="$GAMES" \
        AZEVAL_ITERS="$ITERS" \
        AZEVAL_HORIZON="$HORIZON" \
        AZEVAL_PROGRESS_EVERY="$PROGRESS_EVERY" \
        AZEVAL_CONTROL=full \
        AZEVAL_FULL_SELECTION="$FULL_SELECTION" \
        AZEVAL_FULL_LOOKAHEAD_DEPTH="$LOOKAHEAD_DEPTH" \
        AZEVAL_FULL_LOOKAHEAD_BEAM="$LOOKAHEAD_BEAM" \
        AZEVAL_FULL_LOOKAHEAD_ROOT_BEAM="$LOOKAHEAD_ROOT_BEAM" \
        AZEVAL_FULL_TARGET_TEMP="$TARGET_TEMP" \
        AZEVAL_VALUEW=1 \
        AZEVAL_WEIGHTS="$HUNTER_WEIGHTS" \
        AZEVAL_PATCH_NAV_WEIGHTS="$HUNTER_PATCH_WEIGHTS" \
        AZEVAL_PATCH_NAV_GATE="$HUNTER_PATCH_GATE" \
        AZEVAL_MICRO_WEIGHTS="$HUNTER_MICRO_WEIGHTS" \
        AZEVAL_MICRO_GATE="$HUNTER_MICRO_GATE" \
        AZEVAL_PVP_PIVOT_ORACLE=status2-conversion-descend \
        AZEVAL_PLANNER_ROLE_NAME="status2-conversion-descend-hunter" \
        AZEVAL_NEURAL_FIELD=1 \
        AZEVAL_NEURAL_FIELD_STACKS_FILE="$STACK" \
        AZEVAL_OUT="$out" \
        npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
        2>&1 | tee "$LOG_DIR/${role}.log"
      ;;
    target)
      env \
        ARC_GOOD_TARGET_CONTROLLED_CORRUPT_FARM="$TARGET_CONTROLLED_CORRUPT_FARM" \
        ARC_GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP="$TARGET_CONTROLLED_CORRUPT_MAX_VP" \
        CUDA_VISIBLE_DEVICES="$GPU" \
        AZEVAL=1 \
        AZEVAL_GAMES="$GAMES" \
        AZEVAL_ITERS="$ITERS" \
        AZEVAL_HORIZON="$HORIZON" \
        AZEVAL_PROGRESS_EVERY="$PROGRESS_EVERY" \
        AZEVAL_CONTROL=full \
        AZEVAL_FULL_SELECTION="$FULL_SELECTION" \
        AZEVAL_FULL_LOOKAHEAD_DEPTH="$LOOKAHEAD_DEPTH" \
        AZEVAL_FULL_LOOKAHEAD_BEAM="$LOOKAHEAD_BEAM" \
        AZEVAL_FULL_LOOKAHEAD_ROOT_BEAM="$LOOKAHEAD_ROOT_BEAM" \
        AZEVAL_FULL_TARGET_TEMP="$TARGET_TEMP" \
        AZEVAL_VALUEW=1 \
        AZEVAL_WEIGHTS="$TARGET_WEIGHTS" \
	        AZEVAL_NAV_WEIGHTS="$TARGET_NAV_WEIGHTS" \
	        AZEVAL_NAV_GATE="$TARGET_NAV_GATE" \
	        AZEVAL_MICRO_WEIGHTS="$TARGET_MICRO_WEIGHTS" \
	        AZEVAL_MICRO_GATE="$TARGET_MICRO_GATE" \
	        AZEVAL_MAX_STATUS_LEVEL="$TARGET_STATUS_CAP" \
        AZEVAL_FORBID_TYPES="$TARGET_FORBID_TYPES" \
        AZEVAL_HARD_CONSTRAINTS=1 \
        AZEVAL_PRESERVE_ROUTE_FIREPOWER=1 \
        AZEVAL_PRESERVE_ROUTE_SURVIVAL=1 \
        AZEVAL_GOOD_TARGET_ACTION_DISCIPLINE=1 \
        AZEVAL_ROUTE_FINISH_ORACLE="$TARGET_ROUTE_FINISH_ORACLE" \
        AZEVAL_PLANNER_ROLE_NAME="good-nonfallen-scorefloor-target" \
        AZEVAL_NEURAL_FIELD=1 \
        AZEVAL_NEURAL_FIELD_STACKS_FILE="$STACK" \
        AZEVAL_OUT="$out" \
        npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
        2>&1 | tee "$LOG_DIR/${role}.log"
      ;;
    pure)
      env \
        ARC_GOOD_TARGET_CONTROLLED_CORRUPT_FARM="$PURE_CONTROLLED_CORRUPT_FARM" \
        ARC_GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP="$PURE_CONTROLLED_CORRUPT_MAX_VP" \
        CUDA_VISIBLE_DEVICES="$GPU" \
        AZEVAL=1 \
        AZEVAL_GAMES="$GAMES" \
        AZEVAL_ITERS="$ITERS" \
        AZEVAL_HORIZON="$HORIZON" \
        AZEVAL_PROGRESS_EVERY="$PROGRESS_EVERY" \
        AZEVAL_CONTROL=full \
        AZEVAL_FULL_SELECTION="$FULL_SELECTION" \
        AZEVAL_FULL_LOOKAHEAD_DEPTH="$LOOKAHEAD_DEPTH" \
        AZEVAL_FULL_LOOKAHEAD_BEAM="$LOOKAHEAD_BEAM" \
        AZEVAL_FULL_LOOKAHEAD_ROOT_BEAM="$LOOKAHEAD_ROOT_BEAM" \
        AZEVAL_FULL_TARGET_TEMP="$TARGET_TEMP" \
        AZEVAL_VALUEW=1 \
        AZEVAL_WEIGHTS="$PURE_WEIGHTS" \
	        AZEVAL_NAV_WEIGHTS="$PURE_NAV_WEIGHTS" \
	        AZEVAL_NAV_GATE="$PURE_NAV_GATE" \
	        AZEVAL_MICRO_WEIGHTS="$PURE_MICRO_WEIGHTS" \
	        AZEVAL_MICRO_GATE="$PURE_MICRO_GATE" \
	        AZEVAL_MAX_STATUS_LEVEL="$PURE_STATUS_CAP" \
        AZEVAL_FORBID_TYPES="$PURE_FORBID_TYPES" \
        AZEVAL_HARD_CONSTRAINTS=1 \
        AZEVAL_PRESERVE_ROUTE_FIREPOWER=1 \
        AZEVAL_PRESERVE_ROUTE_SURVIVAL=1 \
        AZEVAL_ROUTE_FINISH_ORACLE="$PURE_ROUTE_FINISH_ORACLE" \
        AZEVAL_PLANNER_ROLE_NAME="pure-scorefloor-farmer" \
        AZEVAL_NEURAL_FIELD=1 \
        AZEVAL_NEURAL_FIELD_STACKS_FILE="$STACK" \
        AZEVAL_OUT="$out" \
        npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
        2>&1 | tee "$LOG_DIR/${role}.log"
      ;;
    *)
      echo "unknown portfolio role: $role" >&2
      exit 2
      ;;
  esac
}

IFS=',' read -r -a ROLES_LIST <<< "$ROLES_RAW"
for raw_role in "${ROLES_LIST[@]}"; do
  role="$(echo "$raw_role" | xargs)"
  [[ -z "$role" ]] && continue
  run_eval "$role"
done

node --input-type=module - "$OUT_DIR" "$ROLES_RAW" "$STACK" \
  "$PORTFOLIO_MIN_FLOOR_VP" "$PORTFOLIO_EXPLOIT_GAP_VP" \
  "$PORTFOLIO_MAX_CONCEDED_SHARE" "$PROMOTION_MIN_BEST_VP" \
  "$PROMOTION_MIN_BEST_REACH30" "$PROMOTION_MAX_MISSED_PVP_PCT" <<'NODE'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [
  outDir,
  rolesRaw,
  stack,
  floorVpRaw,
  exploitGapRaw,
  maxConcededShareRaw,
  minBestVpRaw,
  minBestReach30Raw,
  maxMissedPvpRaw
] = process.argv.slice(2);

const roles = rolesRaw.split(',').map((s) => s.trim()).filter(Boolean);
const floorVp = Number(floorVpRaw);
const exploitGap = Number(exploitGapRaw);
const maxConcededShare = Number(maxConcededShareRaw);
const minBestVp = Number(minBestVpRaw);
const minBestReach30 = Number(minBestReach30Raw);
const maxMissedPvp = Number(maxMissedPvpRaw);

const read = (role) => {
  const path = join(outDir, `${role}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};

const metric = (role, row) => row ? ({
  role,
  vp: row.planner_VP_avg,
  winPct: row.planner_win_pct,
  reach30Pct: row.planner_reach30_pct,
  status: row.planner_status_avg,
  maxStatus: row.planner_max_status,
  fieldBestVp: row.field_bestVP_avg,
  kills: row.planner_monster_kills_per_game,
  abyssNavs: row.planner_abyss_navs_per_game,
  pvpVp: row.planner_pvp_vp_per_game,
  pvpAttacks: row.planner_pvp_attacks_per_game,
  missedPvpPct: row.planner_missed_pvp_opportunity_pct,
  hp4PvpVp: row.planner_pvp_hard_monster_vp_per_game,
  hp4PvpAttacks: row.planner_pvp_hard_monster_attacks_per_game,
  missedHp4PvpPct: row.planner_missed_pvp_hard_monster_opportunity_pct,
  goodPivotVp: row.planner_pvp_good_target_pivot_vp_per_game,
  goodPivotBestTargetVp: row.planner_pvp_good_target_pivot_best_target_vp,
  pvpTargetVp: row.planner_pvp_target_vp_per_game,
  pvpBestTargetVp: row.planner_pvp_best_target_vp,
  pvpPivotOracleUses: row.planner_pvp_pivot_oracle_uses_per_game,
  roleStats: row.roleStats
}) : null;

const results = roles
  .map((role) => metric(role, read(role)))
  .filter(Boolean);

const byVp = [...results].sort((a, b) => b.vp - a.vp || b.reach30Pct - a.reach30Pct);
const best = byVp[0] ?? null;
const worst = [...results].sort((a, b) => a.vp - b.vp || a.reach30Pct - b.reach30Pct)[0] ?? null;
const exploitGapVp = best && worst ? +(best.vp - worst.vp).toFixed(2) : null;
const weakPlannerRoles = results.filter((row) => row.vp < floorVp).map((row) => row.role);
const conversion = results.find((row) => row.role === 'conversion') ?? null;

const fieldBuckets = {};
for (const row of results) {
  for (const [role, stats] of Object.entries(row.roleStats ?? {})) {
    const seats = Number(stats.seats ?? 0);
    if (!Number.isFinite(seats) || seats <= 0) continue;
    const bucket = fieldBuckets[role] ?? {
      seats: 0,
      wins: 0,
      vp: 0,
      status: 0,
      pvpVp: 0,
      pvpTargetCombats: 0,
      pvpAggressorsFaced: 0,
      concededShare: 0,
      maxExpectedAttack: 0,
      maxSpiritAnimal: 0
    };
    bucket.seats += seats;
    bucket.wins += (Number(stats.win_pct ?? 0) / 100) * seats;
    bucket.vp += Number(stats.VP_avg ?? 0) * seats;
    bucket.status += Number(stats.status_avg ?? 0) * seats;
    bucket.pvpVp += Number(stats.pvp_vp_per_seat ?? 0) * seats;
    bucket.pvpTargetCombats += Number(stats.pvp_target_combats_per_seat ?? 0) * seats;
    bucket.pvpAggressorsFaced += Number(stats.pvp_aggressors_faced_per_seat ?? 0) * seats;
    bucket.concededShare += Number(stats.pvp_vp_conceded_share_per_seat ?? 0) * seats;
    bucket.maxExpectedAttack += Number(stats.max_expected_attack_avg ?? 0) * seats;
    bucket.maxSpiritAnimal += Number(stats.max_spirit_animal_avg ?? 0) * seats;
    fieldBuckets[role] = bucket;
  }
}

const fieldRoleSummary = Object.fromEntries(
  Object.entries(fieldBuckets)
    .sort((a, b) => (b[1].vp / Math.max(1, b[1].seats)) - (a[1].vp / Math.max(1, a[1].seats)))
    .map(([role, bucket]) => {
      const seats = Math.max(1, bucket.seats);
      return [role, {
        seats: bucket.seats,
        win_pct: +((100 * bucket.wins) / seats).toFixed(1),
        VP_avg: +(bucket.vp / seats).toFixed(2),
        status_avg: +(bucket.status / seats).toFixed(2),
        pvp_vp_per_seat: +(bucket.pvpVp / seats).toFixed(2),
        pvp_target_combats_per_seat: +(bucket.pvpTargetCombats / seats).toFixed(2),
        pvp_aggressors_faced_per_seat: +(bucket.pvpAggressorsFaced / seats).toFixed(2),
        pvp_vp_conceded_share_per_seat: +(bucket.concededShare / seats).toFixed(2),
        max_expected_attack_avg: +(bucket.maxExpectedAttack / seats).toFixed(2),
        max_spirit_animal_avg: +(bucket.maxSpiritAnimal / seats).toFixed(2)
      }];
    })
);

const weakFieldRoles = Object.entries(fieldRoleSummary)
  .filter(([, stats]) => stats.VP_avg < floorVp)
  .map(([role]) => role);
const overExposedFieldRoles = Object.entries(fieldRoleSummary)
  .filter(([, stats]) => stats.pvp_vp_conceded_share_per_seat > maxConcededShare)
  .map(([role]) => role);

const verdict = {
  hasStrongRole: !!best && best.vp >= minBestVp && best.reach30Pct >= minBestReach30,
  farmToPvpConversionPresent: !!conversion && conversion.hp4PvpVp > 0 && conversion.missedPvpPct <= maxMissedPvp,
  noWeakPlannerRoleBelowFloor: weakPlannerRoles.length === 0,
  noWeakStackRoleBelowFloor: weakFieldRoles.length === 0,
  noOverExposedStackRole: overExposedFieldRoles.length === 0,
  exploitGapClosed: exploitGapVp !== null && exploitGapVp <= exploitGap,
  solvedPortfolio:
    !!best &&
    best.vp >= minBestVp &&
    best.reach30Pct >= minBestReach30 &&
    weakPlannerRoles.length === 0 &&
    weakFieldRoles.length === 0 &&
    overExposedFieldRoles.length === 0 &&
    exploitGapVp !== null &&
    exploitGapVp <= exploitGap &&
    (!conversion || (conversion.hp4PvpVp > 0 && conversion.missedPvpPct <= maxMissedPvp))
};

const summary = {
  generatedAt: new Date().toISOString(),
  outDir,
  stack,
  roles,
  thresholds: {
    floorVp,
    exploitGap,
    maxConcededShare,
    minBestVp,
    minBestReach30,
    maxMissedPvp
  },
  bestRole: best,
  worstRole: worst,
  exploitGapVp,
  weakPlannerRoles,
  fieldRoleSummary,
  weakFieldRoles,
  overExposedFieldRoles,
  results,
  verdict
};

writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE

echo "DONE -> $OUT_DIR/summary.json"
