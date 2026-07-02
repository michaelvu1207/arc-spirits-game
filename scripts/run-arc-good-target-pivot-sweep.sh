#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN_ID="${RUN_ID:-good-target-pivot-sweep-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="ml/meta_runs/$RUN_ID"
LOG_DIR="$OUT_DIR/logs"
GPU="${GPU:-4}"
DIRECT_GAMES="${DIRECT_GAMES:-8}"
DIRECT_ITERS="${DIRECT_ITERS:-64}"
HUNTER_GAMES="${HUNTER_GAMES:-8}"
HUNTER_ITERS="${HUNTER_ITERS:-64}"
HUNTER_HORIZON="${HUNTER_HORIZON:-24}"
RUN_DIRECT="${RUN_DIRECT:-1}"
RUN_HUNTER="${RUN_HUNTER:-1}"

TARGET_WEIGHTS="${TARGET_WEIGHTS:-ml/meta_runs/allseat-goodbuilder-medium-20260630Tgoal/allseat_goodbuilder_policy.json}"
TARGET_NAV_WEIGHTS="${TARGET_NAV_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/nav_build_policy.json}"
TARGET_NAV_GATE="${TARGET_NAV_GATE:-good-nonfallen-farm-target-pivot}"
TARGET_STATUS_CAP="${TARGET_STATUS_CAP:-2}"
TARGET_FORBID_TYPES="${TARGET_FORBID_TYPES:-initiatePvp}"
TARGET_ACTION_DISCIPLINE="${TARGET_ACTION_DISCIPLINE:-0}"
TARGET_STACK="${TARGET_STACK:-ml/stacks/neural-field-good-nonfallen-pivot-targets.json}"
EFFECTIVE_TARGET_STACK="$TARGET_STACK"

HUNTER_WEIGHTS="${HUNTER_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/best_policy.full.json}"
HUNTER_PATCH_WEIGHTS="${HUNTER_PATCH_WEIGHTS:-ml/meta_runs/pvp-route-mode-20260630T124558Z/pvp_route_mode_head_policy.json}"
HUNTER_MICRO_WEIGHTS="${HUNTER_MICRO_WEIGHTS:-$HUNTER_PATCH_WEIGHTS}"
HUNTER_PATCH_GATE="${HUNTER_PATCH_GATE:-pvp-predictive-mode-hunt-fallback-pivot}"
HUNTER_MICRO_GATE="${HUNTER_MICRO_GATE:-pvp-pivot-encounter-force}"

mkdir -p "$OUT_DIR" "$LOG_DIR"

if [[ "$TARGET_ACTION_DISCIPLINE" == "1" ]]; then
  EFFECTIVE_TARGET_STACK="$OUT_DIR/target_stack.good_target_action_discipline.json"
  node --input-type=module - "$TARGET_STACK" "$EFFECTIVE_TARGET_STACK" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [stackPath, outPath] = process.argv.slice(2);
const stack = JSON.parse(readFileSync(stackPath, 'utf8'));
const rows = Array.isArray(stack) ? stack : stack.stacks ?? [];
for (const row of rows) row.goodTargetActionDiscipline = true;
writeFileSync(outPath, JSON.stringify(rows, null, 2) + '\n');
NODE
fi

case_env() {
  local label="$1"
  case "$label" in
    default)
      echo ""
      ;;
    controlled)
      echo "ARC_GOOD_TARGET_CONTROLLED_CORRUPT_FARM=1"
      ;;
    controlled-cap12)
      echo "ARC_GOOD_TARGET_CONTROLLED_CORRUPT_FARM=1 ARC_GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP=12"
      ;;
    controlled-expose12)
      echo "ARC_GOOD_TARGET_CONTROLLED_CORRUPT_FARM=1 ARC_GOOD_TARGET_EXPOSE_AFTER_VP=12"
      ;;
    controlled-expose15)
      echo "ARC_GOOD_TARGET_CONTROLLED_CORRUPT_FARM=1 ARC_GOOD_TARGET_EXPOSE_AFTER_VP=15"
      ;;
    expose15)
      echo "ARC_GOOD_TARGET_EXPOSE_AFTER_VP=15"
      ;;
    expose18)
      echo "ARC_GOOD_TARGET_EXPOSE_AFTER_VP=18"
      ;;
    expose21)
      echo "ARC_GOOD_TARGET_EXPOSE_AFTER_VP=21"
      ;;
    expose24)
      echo "ARC_GOOD_TARGET_EXPOSE_AFTER_VP=24"
      ;;
    *)
      echo "unknown sweep label: $label" >&2
      exit 2
      ;;
  esac
}

run_direct() {
  local label="$1"
  local envs="$2"
  echo "== direct target: $label =="
  # shellcheck disable=SC2086
  env $envs \
    CUDA_VISIBLE_DEVICES="$GPU" \
    AZEVAL=1 \
    AZEVAL_GAMES="$DIRECT_GAMES" \
    AZEVAL_ITERS="$DIRECT_ITERS" \
    AZEVAL_CONTROL=full \
    AZEVAL_FULL_SELECTION=value \
    AZEVAL_WEIGHTS="$TARGET_WEIGHTS" \
    AZEVAL_NAV_WEIGHTS="$TARGET_NAV_WEIGHTS" \
    AZEVAL_NAV_GATE="$TARGET_NAV_GATE" \
    AZEVAL_MAX_STATUS_LEVEL="$TARGET_STATUS_CAP" \
    AZEVAL_FORBID_TYPES="$TARGET_FORBID_TYPES" \
    AZEVAL_PRESERVE_ROUTE_FIREPOWER=1 \
    AZEVAL_PRESERVE_ROUTE_SURVIVAL=1 \
    AZEVAL_GOOD_TARGET_ACTION_DISCIPLINE="$TARGET_ACTION_DISCIPLINE" \
    AZEVAL_OUT="$OUT_DIR/direct_${label}.json" \
    npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
    2>&1 | tee "$LOG_DIR/direct_${label}.log"
}

run_hunter() {
  local label="$1"
  local envs="$2"
  echo "== hunter vs target field: $label =="
  # shellcheck disable=SC2086
  env $envs \
    CUDA_VISIBLE_DEVICES="$GPU" \
    AZEVAL=1 \
    AZEVAL_GAMES="$HUNTER_GAMES" \
    AZEVAL_ITERS="$HUNTER_ITERS" \
    AZEVAL_HORIZON="$HUNTER_HORIZON" \
    AZEVAL_CONTROL=full \
    AZEVAL_FULL_SELECTION=value \
    AZEVAL_VALUEW=1 \
    AZEVAL_WEIGHTS="$HUNTER_WEIGHTS" \
    AZEVAL_PATCH_NAV_WEIGHTS="$HUNTER_PATCH_WEIGHTS" \
    AZEVAL_PATCH_NAV_GATE="$HUNTER_PATCH_GATE" \
    AZEVAL_MICRO_WEIGHTS="$HUNTER_MICRO_WEIGHTS" \
    AZEVAL_MICRO_GATE="$HUNTER_MICRO_GATE" \
    AZEVAL_NEURAL_FIELD=1 \
    AZEVAL_NEURAL_FIELD_STACKS_FILE="$EFFECTIVE_TARGET_STACK" \
    AZEVAL_OUT="$OUT_DIR/hunter_${label}.json" \
    npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
    2>&1 | tee "$LOG_DIR/hunter_${label}.log"
}

LABELS_RAW="${SWEEP_LABELS:-default,controlled,controlled-cap12,controlled-expose12,controlled-expose15,expose15,expose18}"
IFS=',' read -r -a LABELS <<< "$LABELS_RAW"

echo "== good target pivot sweep =="
echo "run_id=$RUN_ID out_dir=$OUT_DIR gpu=$GPU labels=$LABELS_RAW target_action_discipline=$TARGET_ACTION_DISCIPLINE"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits -i "$GPU" || true
fi

for label in "${LABELS[@]}"; do
  label="$(echo "$label" | xargs)"
  [[ -z "$label" ]] && continue
  envs="$(case_env "$label")"
  if [[ "$RUN_DIRECT" == "1" ]]; then run_direct "$label" "$envs"; fi
  if [[ "$RUN_HUNTER" == "1" ]]; then run_hunter "$label" "$envs"; fi
done

node --input-type=module - "$OUT_DIR" "$LABELS_RAW" "$TARGET_ACTION_DISCIPLINE" <<'NODE'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [outDir, labelsRaw, targetActionDisciplineRaw] = process.argv.slice(2);
const labels = labelsRaw.split(',').map((s) => s.trim()).filter(Boolean);

function read(name) {
  const path = join(outDir, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function direct(row) {
  if (!row) return null;
  return {
    vp: row.planner_VP_avg,
    status: row.planner_status_avg,
    maxStatus: row.planner_max_status,
    statusCapViolations: row.planner_status_cap_violations,
    kills: row.planner_monster_kills_per_game,
    abyssNavs: row.planner_abyss_navs_per_game,
    missedFarmablePct: row.planner_missed_farmable_nav_pct,
    fieldBestVp: row.field_bestVP_avg
  };
}

function hunter(row) {
  if (!row) return null;
  return {
    vp: row.planner_VP_avg,
    reach30Pct: row.planner_reach30_pct,
    pvpVp: row.planner_pvp_vp_per_game,
    hp4PvpVp: row.planner_pvp_hard_monster_vp_per_game,
    goodPivotVp: row.planner_pvp_good_target_pivot_vp_per_game,
    goodPivotAttacks: row.planner_pvp_good_target_pivot_attacks_per_game,
    goodPivotOpportunities: row.planner_pvp_good_target_pivot_opportunities_per_game,
    goodPivotMissedPct: row.planner_missed_pvp_good_target_pivot_opportunity_pct,
    goodPivotTargetVp: row.planner_pvp_good_target_pivot_target_vp_per_game,
    goodPivotBestTarget: row.planner_pvp_good_target_pivot_best_target_vp,
    pvpAttacks: row.planner_pvp_attacks_per_game,
    pvpTargetVp: row.planner_pvp_target_vp_per_game,
    pvpBestTarget: row.planner_pvp_best_target_vp,
    pvpHighValueWindows: row.planner_pvp_high_value_opportunities_per_game,
    missedPvpPct: row.planner_missed_pvp_opportunity_pct,
    fieldBestVp: row.field_bestVP_avg
  };
}

const cases = labels.map((label) => ({
  label,
  direct: direct(read(`direct_${label}.json`)),
  hunter: hunter(read(`hunter_${label}.json`))
}));

const bestHunter = cases
  .filter((x) => x.hunter)
  .sort((a, b) =>
    (b.hunter.hp4PvpVp - a.hunter.hp4PvpVp) ||
    (b.hunter.vp - a.hunter.vp) ||
    (b.hunter.pvpBestTarget - a.hunter.pvpBestTarget)
  )[0] ?? null;

const summary = {
  generatedAt: new Date().toISOString(),
  outDir,
  labels,
  targetActionDiscipline: targetActionDisciplineRaw === '1',
  cases,
  acceptedBaseline: {
    hunterVp: 26.44,
    hunterHp4PvpVp: 14.81,
    hunterBestTarget: 18,
    hunterHighValueWindows: 1.13,
    directVp: 11.69
  },
  bestHunterLabel: bestHunter?.label ?? null,
  bestHunter,
  promotionCandidate: !!bestHunter?.hunter &&
    bestHunter.hunter.vp > 26.44 &&
    bestHunter.hunter.hp4PvpVp >= 14.81 &&
    bestHunter.hunter.goodPivotVp > 0 &&
    bestHunter.hunter.goodPivotBestTarget >= 18
};

writeFileSync(join(outDir, 'sweep_summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
NODE

echo "DONE -> $OUT_DIR/sweep_summary.json"
