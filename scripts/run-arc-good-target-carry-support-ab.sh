#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN_ID="${RUN_ID:-good-target-carry-support-ab-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="ml/meta_runs/$RUN_ID"
LOG_DIR="$OUT_DIR/logs"
GPU="${GPU:-4}"
MIN_FREE_MB="${MIN_FREE_MB:-10000}"
GAMES="${GAMES:-8}"
ITERS="${ITERS:-64}"
HORIZON="${HORIZON:-24}"
PROGRESS_EVERY="${PROGRESS_EVERY:-2}"
CASES_RAW="${CASES:-single,dual}"
RUN_TARGET="${RUN_TARGET:-1}"
RUN_HUNTER="${RUN_HUNTER:-1}"
RUN_MIXED="${RUN_MIXED:-1}"

TARGET_WEIGHTS="${TARGET_WEIGHTS:-ml/meta_runs/allseat-goodbuilder-medium-20260630Tgoal/allseat_goodbuilder_policy.json}"
TARGET_NAV_WEIGHTS="${TARGET_NAV_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/nav_build_policy.json}"
TARGET_NAV_GATE="${TARGET_NAV_GATE:-good-nonfallen-score-floor}"
TARGET_MICRO_WEIGHTS="${TARGET_MICRO_WEIGHTS:-$TARGET_WEIGHTS}"
TARGET_MICRO_GATE="${TARGET_MICRO_GATE:-good-builder-hp4-scorefloor-oracle}"
TARGET_STATUS_CAP="${TARGET_STATUS_CAP:-2}"
TARGET_FORBID_TYPES="${TARGET_FORBID_TYPES:-initiatePvp}"

HUNTER_WEIGHTS="${HUNTER_WEIGHTS:-ml/meta_runs/damage-contract-bootstrap-20260629T190011Z/best_policy.full.json}"
HUNTER_PATCH_WEIGHTS="${HUNTER_PATCH_WEIGHTS:-ml/meta_runs/pvp-route-mode-20260630T124558Z/pvp_route_mode_head_policy.json}"
HUNTER_MICRO_WEIGHTS="${HUNTER_MICRO_WEIGHTS:-$HUNTER_PATCH_WEIGHTS}"
HUNTER_PATCH_GATE="${HUNTER_PATCH_GATE:-pvp-predictive-mode-hunt-fallback-rebuild-pivot}"
HUNTER_MICRO_GATE="${HUNTER_MICRO_GATE:-pvp-pivot-encounter-force}"
HUNTER_PVP_ORACLE="${HUNTER_PVP_ORACLE:-status2-conversion-descend}"
HUNTER_ROLE_NAME="${HUNTER_ROLE_NAME:-status2-conversion-descend-hunter}"

SINGLE_TARGET_STACK="${SINGLE_TARGET_STACK:-ml/stacks/neural-field-good-scorefloor-carry-support-targets.json}"
SINGLE_MIXED_STACK="${SINGLE_MIXED_STACK:-ml/stacks/league-current-scorefloor-carry-support-hunter.json}"
DUAL_TARGET_STACK="${DUAL_TARGET_STACK:-ml/stacks/neural-field-good-scorefloor-dual-carry-support-targets.json}"
DUAL_MIXED_STACK="${DUAL_MIXED_STACK:-ml/stacks/league-current-scorefloor-dual-carry-support-hunter.json}"

mkdir -p "$OUT_DIR" "$LOG_DIR"

echo "== Good target carry/support A/B =="
echo "run_id=$RUN_ID games=$GAMES iters=$ITERS horizon=$HORIZON cases=$CASES_RAW"
echo "target_weights=$TARGET_WEIGHTS target_nav_gate=$TARGET_NAV_GATE target_micro_gate=$TARGET_MICRO_GATE hunter_gate=$HUNTER_PATCH_GATE"

if command -v nvidia-smi >/dev/null 2>&1; then
  free_mb="$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  used_mb="$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  echo "gpu=$GPU free_mb=${free_mb:-unknown} used_mb=${used_mb:-unknown} min_free_mb=$MIN_FREE_MB"
  if [[ -n "${free_mb:-}" && "$free_mb" -lt "$MIN_FREE_MB" ]]; then
    echo "refusing carry/support A/B: GPU $GPU has ${free_mb}MB free, below MIN_FREE_MB=$MIN_FREE_MB" >&2
    exit 3
  fi
fi

target_stack_for_case() {
  case "$1" in
    single) echo "$SINGLE_TARGET_STACK" ;;
    dual) echo "$DUAL_TARGET_STACK" ;;
    *) echo "unknown carry/support case: $1" >&2; exit 2 ;;
  esac
}

mixed_stack_for_case() {
  case "$1" in
    single) echo "$SINGLE_MIXED_STACK" ;;
    dual) echo "$DUAL_MIXED_STACK" ;;
    *) echo "unknown carry/support case: $1" >&2; exit 2 ;;
  esac
}

run_target_eval() {
  local label="$1"
  local stack="$2"
  local out="$OUT_DIR/${label}_target_field.json"
  echo "== target field: $label =="
  env \
    CUDA_VISIBLE_DEVICES="$GPU" \
    AZEVAL=1 \
    AZEVAL_GAMES="$GAMES" \
    AZEVAL_ITERS="$ITERS" \
    AZEVAL_HORIZON="$HORIZON" \
    AZEVAL_PROGRESS_EVERY="$PROGRESS_EVERY" \
    AZEVAL_CONTROL=full \
    AZEVAL_FULL_SELECTION=value \
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
    AZEVAL_NEURAL_FIELD=1 \
    AZEVAL_NEURAL_FIELD_STACKS_FILE="$stack" \
    AZEVAL_OUT="$out" \
    npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept \
    2>&1 | tee "$LOG_DIR/${label}_target_field.log"
}

run_hunter_eval() {
  local label="$1"
  local stack="$2"
  local suffix="$3"
  local out="$OUT_DIR/${label}_${suffix}.json"
  echo "== hunter $suffix: $label =="
  env \
    CUDA_VISIBLE_DEVICES="$GPU" \
    ARC_PVP_REBUILD_MIN_ROUND=14 \
    ARC_PVP_REBUILD_SKIP_TARGET_VP=12 \
    AZEVAL=1 \
    AZEVAL_GAMES="$GAMES" \
    AZEVAL_ITERS="$ITERS" \
    AZEVAL_HORIZON="$HORIZON" \
    AZEVAL_PROGRESS_EVERY="$PROGRESS_EVERY" \
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
    2>&1 | tee "$LOG_DIR/${label}_${suffix}.log"
}

IFS=',' read -r -a CASES_LIST <<< "$CASES_RAW"
for raw_case in "${CASES_LIST[@]}"; do
  label="$(echo "$raw_case" | xargs)"
  [[ -z "$label" ]] && continue
  target_stack="$(target_stack_for_case "$label")"
  mixed_stack="$(mixed_stack_for_case "$label")"
  [[ "$RUN_TARGET" == "1" ]] && run_target_eval "$label" "$target_stack"
  [[ "$RUN_HUNTER" == "1" ]] && run_hunter_eval "$label" "$target_stack" "hunter_vs_target"
  [[ "$RUN_MIXED" == "1" ]] && run_hunter_eval "$label" "$mixed_stack" "hunter_vs_mixed"
done

node --input-type=module - "$OUT_DIR" "$CASES_RAW" <<'NODE'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [outDir, casesRaw] = process.argv.slice(2);
const cases = casesRaw.split(',').map((s) => s.trim()).filter(Boolean);
const read = (name) => {
  const path = join(outDir, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};
const metric = (row) => row ? ({
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
  goodPivotVp: row.planner_pvp_good_target_pivot_vp_per_game,
  goodPivotAttacks: row.planner_pvp_good_target_pivot_attacks_per_game,
  goodPivotBestTargetVp: row.planner_pvp_good_target_pivot_best_target_vp,
  highValueWindows: row.planner_pvp_high_value_opportunities_per_game,
  missedGoodPivotPct: row.planner_missed_pvp_good_target_pivot_opportunity_pct,
  roleStats: row.roleStats
}) : null;

const rows = cases.map((label) => {
  const targetField = metric(read(`${label}_target_field.json`));
  const hunterVsTarget = metric(read(`${label}_hunter_vs_target.json`));
  const hunterVsMixed = metric(read(`${label}_hunter_vs_mixed.json`));
  return {
    label,
    targetField,
    hunterVsTarget,
    hunterVsMixed,
    verdict: {
      targetBeatsHp4PickBaseline: (targetField?.vp ?? 0) > 10.25,
      targetCreatesGoodCarry: (targetField?.fieldBestVp ?? 0) >= 15,
      hunterTargetHasGoodPivot: (hunterVsTarget?.goodPivotVp ?? 0) > 0,
      hunterTargetFindsValuableGood: (hunterVsTarget?.goodPivotBestTargetVp ?? 0) >= 18,
      hunterTargetBeatsAcceptedHp4Pvp: (hunterVsTarget?.hp4PvpVp ?? 0) >= 14.81,
      mixedHasGoodPivot: (hunterVsMixed?.goodPivotVp ?? 0) > 0,
      mixedFindsValuableGood: (hunterVsMixed?.goodPivotBestTargetVp ?? 0) >= 18,
      promotable:
        (targetField?.vp ?? 0) > 10.25 &&
        (hunterVsTarget?.hp4PvpVp ?? 0) >= 14.81 &&
        (hunterVsTarget?.goodPivotBestTargetVp ?? 0) >= 18 &&
        (hunterVsMixed?.goodPivotVp ?? 0) > 0 &&
        (hunterVsMixed?.goodPivotBestTargetVp ?? 0) >= 18
    }
  };
});

const bestByHunterTarget = [...rows].sort((a, b) =>
  ((b.hunterVsTarget?.hp4PvpVp ?? 0) - (a.hunterVsTarget?.hp4PvpVp ?? 0)) ||
  ((b.hunterVsTarget?.goodPivotBestTargetVp ?? 0) - (a.hunterVsTarget?.goodPivotBestTargetVp ?? 0)) ||
  ((b.targetField?.fieldBestVp ?? 0) - (a.targetField?.fieldBestVp ?? 0))
)[0] ?? null;

const summary = {
  generatedAt: new Date().toISOString(),
  outDir,
  cases: rows,
  bestByHunterTarget: bestByHunterTarget?.label ?? null,
  promotionCandidate: rows.some((row) => row.verdict.promotable),
  baselines: {
    hp4PickTargetOnlyVp: 10.25,
    disciplinedDirectVp: 21.94,
    acceptedHunterHp4PvpVp: 14.81,
    valuableGoodTargetVp: 18
  }
};
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE

echo "DONE -> $OUT_DIR/summary.json"
