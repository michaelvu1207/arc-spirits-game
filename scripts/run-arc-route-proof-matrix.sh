#!/usr/bin/env bash
set -euo pipefail

HOST="${ARC_BOT_GPU_HOST:-ubuntu@216.151.21.122}"
REMOTE_DIR="${ARC_BOT_REMOTE_DIR:-/data/share8/michaelvuaprilexperimentation/arc-bot}"
RUN_ID="${RUN_ID:-route-proof-$(date -u +%Y%m%dT%H%M%SZ)}"
GPU="${GPU:-6}"
MIN_FREE_MB="${MIN_FREE_MB:-1024}"
WEIGHTS="${WEIGHTS:-ml/meta_runs/aux-head-act52-medium-20260627T222453Z/best_policy.json}"
PATCH_NAV_WEIGHTS="${PATCH_NAV_WEIGHTS:-}"
PATCH_NAV_GATE="${PATCH_NAV_GATE:-hp2-survival-deficit}"
PATCH2_NAV_WEIGHTS="${PATCH2_NAV_WEIGHTS:-}"
PATCH2_NAV_GATE="${PATCH2_NAV_GATE:-all}"
NAV_WEIGHTS="${NAV_WEIGHTS:-}"
NAV_GATE="${NAV_GATE:-unsafe-firepower-build-option}"
SCALE_NAV_WEIGHTS="${SCALE_NAV_WEIGHTS:-}"
SCALE_NAV_GATE="${SCALE_NAV_GATE:-route-option-scaling}"
MICRO_WEIGHTS="${MICRO_WEIGHTS:-}"
MICRO_GATE="${MICRO_GATE:-all}"
ROUTE_CLOSER_MICRO_WEIGHTS="${ROUTE_CLOSER_MICRO_WEIGHTS:-}"
ROUTE_FINISH_ORACLE="${ROUTE_FINISH_ORACLE:-0}"
GAMES="${GAMES:-32}"
ITERS="${ITERS:-64}"
HORIZON="${HORIZON:-24}"
VALUEW="${VALUEW:-1}"
FIELD="${FIELD:-pvphunter,medium,cultivator,survivor}"
ALT_FIELD="${ALT_FIELD:-medium,cultivator,survivor,hard}"
CONTROL="${CONTROL:-full}"
FULL_SELECTION="${FULL_SELECTION:-lookahead}"
LOOKAHEAD_DEPTH="${LOOKAHEAD_DEPTH:-2}"
LOOKAHEAD_BEAM="${LOOKAHEAD_BEAM:-8}"
LOOKAHEAD_ROOT_BEAM="${LOOKAHEAD_ROOT_BEAM:-24}"
TARGET_TEMP="${TARGET_TEMP:-0.25}"
VARIANTS="${VARIANTS:-strict-pure,tainted-tolerance,no-pvp-corruption,strict-pure-farm-oracle,strict-pure-oracle-bonus,strict-pure-no-pvphunter}"
RESUME="${RESUME:-1}"
VARIANT_TIMEOUT="${VARIANT_TIMEOUT:-45m}"
PROGRESS_EVERY="${PROGRESS_EVERY:-1}"
TRACE="${TRACE:-0}"
TRACE_MIN_VP="${TRACE_MIN_VP:-20}"
TRACE_MAX_VP="${TRACE_MAX_VP:-}"
ROUTE_SAMPLE_EXPORT="${ROUTE_SAMPLE_EXPORT:-0}"
ROUTE_SAMPLE_MIN_DECISION_VP="${ROUTE_SAMPLE_MIN_DECISION_VP:-18}"
ROUTE_SAMPLE_MAX_DECISION_VP="${ROUTE_SAMPLE_MAX_DECISION_VP:-}"
ROUTE_SAMPLE_SUCCESS_VP="${ROUTE_SAMPLE_SUCCESS_VP:-30}"
ROUTE_SAMPLE_NEAR_MIN_VP="${ROUTE_SAMPLE_NEAR_MIN_VP:-28}"
ROUTE_SAMPLE_LOW_MAX_VP="${ROUTE_SAMPLE_LOW_MAX_VP:-}"
ROUTE_SAMPLE_LOW_MIN_DECISION_VP="${ROUTE_SAMPLE_LOW_MIN_DECISION_VP:-}"
ROUTE_SAMPLE_LOW_MAX_DECISION_VP="${ROUTE_SAMPLE_LOW_MAX_DECISION_VP:-}"
ROUTE_SAMPLE_LOW_POLICY_WEIGHT="${ROUTE_SAMPLE_LOW_POLICY_WEIGHT:-0}"
PRESERVE_ROUTE_FIREPOWER="${PRESERVE_ROUTE_FIREPOWER:-0}"
PRESERVE_ROUTE_SURVIVAL="${PRESERVE_ROUTE_SURVIVAL:-0}"

set +e
ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" \
  REMOTE_DIR="$REMOTE_DIR" \
  RUN_ID="$RUN_ID" \
  GPU="$GPU" \
  MIN_FREE_MB="$MIN_FREE_MB" \
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
  ROUTE_FINISH_ORACLE="$ROUTE_FINISH_ORACLE" \
  GAMES="$GAMES" \
  ITERS="$ITERS" \
  HORIZON="$HORIZON" \
  VALUEW="$VALUEW" \
  FIELD="$FIELD" \
  ALT_FIELD="$ALT_FIELD" \
  CONTROL="$CONTROL" \
  FULL_SELECTION="$FULL_SELECTION" \
  LOOKAHEAD_DEPTH="$LOOKAHEAD_DEPTH" \
  LOOKAHEAD_BEAM="$LOOKAHEAD_BEAM" \
  LOOKAHEAD_ROOT_BEAM="$LOOKAHEAD_ROOT_BEAM" \
  TARGET_TEMP="$TARGET_TEMP" \
  VARIANTS="$VARIANTS" \
  RESUME="$RESUME" \
  VARIANT_TIMEOUT="$VARIANT_TIMEOUT" \
  PROGRESS_EVERY="$PROGRESS_EVERY" \
  TRACE="$TRACE" \
  TRACE_MIN_VP="$TRACE_MIN_VP" \
  TRACE_MAX_VP="$TRACE_MAX_VP" \
  ROUTE_SAMPLE_EXPORT="$ROUTE_SAMPLE_EXPORT" \
  ROUTE_SAMPLE_MIN_DECISION_VP="$ROUTE_SAMPLE_MIN_DECISION_VP" \
  ROUTE_SAMPLE_MAX_DECISION_VP="$ROUTE_SAMPLE_MAX_DECISION_VP" \
  ROUTE_SAMPLE_SUCCESS_VP="$ROUTE_SAMPLE_SUCCESS_VP" \
  ROUTE_SAMPLE_NEAR_MIN_VP="$ROUTE_SAMPLE_NEAR_MIN_VP" \
  ROUTE_SAMPLE_LOW_MAX_VP="$ROUTE_SAMPLE_LOW_MAX_VP" \
  ROUTE_SAMPLE_LOW_MIN_DECISION_VP="$ROUTE_SAMPLE_LOW_MIN_DECISION_VP" \
  ROUTE_SAMPLE_LOW_MAX_DECISION_VP="$ROUTE_SAMPLE_LOW_MAX_DECISION_VP" \
  ROUTE_SAMPLE_LOW_POLICY_WEIGHT="$ROUTE_SAMPLE_LOW_POLICY_WEIGHT" \
  PRESERVE_ROUTE_FIREPOWER="$PRESERVE_ROUTE_FIREPOWER" \
  PRESERVE_ROUTE_SURVIVAL="$PRESERVE_ROUTE_SURVIVAL" \
  bash -s <<'REMOTE'
set -euo pipefail

cd "$REMOTE_DIR"
if test -s "$HOME/.nvm/nvm.sh"; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null
fi

if command -v nvidia-smi >/dev/null 2>&1; then
  free_mb="$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  used_mb="$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i "$GPU" | head -n 1 | tr -dc '0-9')"
  echo "gpu=$GPU free_mb=${free_mb:-unknown} used_mb=${used_mb:-unknown} min_free_mb=$MIN_FREE_MB"
  if [[ -n "${free_mb:-}" && "$free_mb" -lt "$MIN_FREE_MB" ]]; then
    echo "refusing route-proof matrix: GPU $GPU has ${free_mb}MB free, below MIN_FREE_MB=$MIN_FREE_MB" >&2
    exit 2
  fi
fi

OUT_DIR="ml/meta_runs/$RUN_ID"
mkdir -p "$OUT_DIR/route-proof" "$OUT_DIR/logs"

cat > "$OUT_DIR/config.json" <<JSON
{
  "run_id": "$RUN_ID",
  "mode": "route-proof-matrix",
  "weights": "$WEIGHTS",
  "patch_nav_weights": "$PATCH_NAV_WEIGHTS",
  "patch_nav_gate": "$PATCH_NAV_GATE",
  "patch2_nav_weights": "$PATCH2_NAV_WEIGHTS",
  "patch2_nav_gate": "$PATCH2_NAV_GATE",
  "nav_weights": "$NAV_WEIGHTS",
  "nav_gate": "$NAV_GATE",
  "scale_nav_weights": "$SCALE_NAV_WEIGHTS",
  "scale_nav_gate": "$SCALE_NAV_GATE",
  "micro_weights": "$MICRO_WEIGHTS",
  "micro_gate": "$MICRO_GATE",
  "route_closer_micro_weights": "$ROUTE_CLOSER_MICRO_WEIGHTS",
  "route_finish_oracle": "$ROUTE_FINISH_ORACLE",
  "gpu": "$GPU",
  "min_free_mb": $MIN_FREE_MB,
  "games": $GAMES,
  "iters": $ITERS,
  "horizon": $HORIZON,
  "value_weight": $VALUEW,
  "field": "$FIELD",
  "alt_field": "$ALT_FIELD",
  "control": "$CONTROL",
  "full_selection": "$FULL_SELECTION",
  "lookahead_depth": $LOOKAHEAD_DEPTH,
  "lookahead_beam": $LOOKAHEAD_BEAM,
  "lookahead_root_beam": $LOOKAHEAD_ROOT_BEAM,
  "target_temp": $TARGET_TEMP,
  "variants": "$VARIANTS",
  "resume": "$RESUME",
  "variant_timeout": "$VARIANT_TIMEOUT",
  "progress_every": $PROGRESS_EVERY,
  "trace": "$TRACE",
  "trace_min_vp": $TRACE_MIN_VP,
  "trace_max_vp": ${TRACE_MAX_VP:-null},
  "route_sample_export": "$ROUTE_SAMPLE_EXPORT",
  "route_sample_min_decision_vp": $ROUTE_SAMPLE_MIN_DECISION_VP,
  "route_sample_max_decision_vp": ${ROUTE_SAMPLE_MAX_DECISION_VP:-null},
  "route_sample_success_vp": $ROUTE_SAMPLE_SUCCESS_VP,
  "route_sample_near_min_vp": $ROUTE_SAMPLE_NEAR_MIN_VP,
  "route_sample_low_max_vp": ${ROUTE_SAMPLE_LOW_MAX_VP:-null},
  "route_sample_low_min_decision_vp": ${ROUTE_SAMPLE_LOW_MIN_DECISION_VP:-null},
  "route_sample_low_max_decision_vp": ${ROUTE_SAMPLE_LOW_MAX_DECISION_VP:-null},
  "route_sample_low_policy_weight": $ROUTE_SAMPLE_LOW_POLICY_WEIGHT,
  "preserve_route_firepower": "$PRESERVE_ROUTE_FIREPOWER",
  "preserve_route_survival": "$PRESERVE_ROUTE_SURVIVAL"
}
JSON

variant_selected() {
  case ",$VARIANTS," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

run_variant() {
  local name="$1"
  local max_status="$2"
  local oracle="$3"
  local farm_bonus="$4"
  local field="$5"
  local out="$OUT_DIR/route-proof/${name}.json"
  if ! variant_selected "$name"; then
    echo "skip route-proof:$name (not in VARIANTS=$VARIANTS)"
    return 0
  fi
  if [[ "$RESUME" == "1" && -s "$out" ]]; then
    echo "skip route-proof:$name (existing $out; RESUME=1)"
    return 0
  fi
  echo ""
  echo "== route-proof:$name max_status=$max_status oracle=$oracle farm_bonus=$farm_bonus field=$field =="
  local route_sample_dir=""
  if [[ "$ROUTE_SAMPLE_EXPORT" == "1" ]]; then
    route_sample_dir="$OUT_DIR/route-proof/${name}.data"
  fi
  local status=0
  set +e
  timeout "$VARIANT_TIMEOUT" env \
    CUDA_VISIBLE_DEVICES="$GPU" \
    AZEVAL=1 \
    AZEVAL_GAMES="$GAMES" \
    AZEVAL_ITERS="$ITERS" \
    AZEVAL_HORIZON="$HORIZON" \
    AZEVAL_VALUEW="$VALUEW" \
    AZEVAL_WEIGHTS="$WEIGHTS" \
    AZEVAL_PATCH_NAV_WEIGHTS="$PATCH_NAV_WEIGHTS" \
    AZEVAL_PATCH_NAV_GATE="$PATCH_NAV_GATE" \
    AZEVAL_PATCH2_NAV_WEIGHTS="$PATCH2_NAV_WEIGHTS" \
    AZEVAL_PATCH2_NAV_GATE="$PATCH2_NAV_GATE" \
    AZEVAL_NAV_WEIGHTS="$NAV_WEIGHTS" \
    AZEVAL_NAV_GATE="$NAV_GATE" \
    AZEVAL_SCALE_NAV_WEIGHTS="$SCALE_NAV_WEIGHTS" \
    AZEVAL_SCALE_NAV_GATE="$SCALE_NAV_GATE" \
    AZEVAL_MICRO_WEIGHTS="$MICRO_WEIGHTS" \
    AZEVAL_MICRO_GATE="$MICRO_GATE" \
    AZEVAL_ROUTE_CLOSER_MICRO_WEIGHTS="$ROUTE_CLOSER_MICRO_WEIGHTS" \
    AZEVAL_ROUTE_FINISH_ORACLE="$ROUTE_FINISH_ORACLE" \
    AZEVAL_CONTROL="$CONTROL" \
    AZEVAL_FULL_SELECTION="$FULL_SELECTION" \
    AZEVAL_FULL_LOOKAHEAD_DEPTH="$LOOKAHEAD_DEPTH" \
    AZEVAL_FULL_LOOKAHEAD_BEAM="$LOOKAHEAD_BEAM" \
    AZEVAL_FULL_LOOKAHEAD_ROOT_BEAM="$LOOKAHEAD_ROOT_BEAM" \
    AZEVAL_FULL_TARGET_TEMP="$TARGET_TEMP" \
    AZEVAL_FORBID_TYPES="initiatePvp" \
    AZEVAL_MAX_STATUS_LEVEL="$max_status" \
    AZEVAL_HARD_CONSTRAINTS=1 \
    AZEVAL_FARM_NAV_ORACLE="$oracle" \
    AZEVAL_FARM_VALUE_BONUS="$farm_bonus" \
    AZEVAL_FIELD="$field" \
    AZEVAL_OUT="$out" \
    AZEVAL_PROGRESS_EVERY="$PROGRESS_EVERY" \
    AZEVAL_TRACE="$TRACE" \
    AZEVAL_TRACE_MIN_VP="$TRACE_MIN_VP" \
    AZEVAL_TRACE_MAX_VP="$TRACE_MAX_VP" \
    AZEVAL_TRACE_OUT="$OUT_DIR/route-proof/${name}.trace.json" \
    AZEVAL_ROUTE_SAMPLE_DIR="$route_sample_dir" \
    AZEVAL_ROUTE_SAMPLE_RESET=1 \
    AZEVAL_ROUTE_SAMPLE_MIN_DECISION_VP="$ROUTE_SAMPLE_MIN_DECISION_VP" \
    AZEVAL_ROUTE_SAMPLE_MAX_DECISION_VP="$ROUTE_SAMPLE_MAX_DECISION_VP" \
    AZEVAL_ROUTE_SAMPLE_SUCCESS_VP="$ROUTE_SAMPLE_SUCCESS_VP" \
    AZEVAL_ROUTE_SAMPLE_NEAR_MIN_VP="$ROUTE_SAMPLE_NEAR_MIN_VP" \
    AZEVAL_ROUTE_SAMPLE_LOW_MAX_VP="$ROUTE_SAMPLE_LOW_MAX_VP" \
    AZEVAL_ROUTE_SAMPLE_LOW_MIN_DECISION_VP="$ROUTE_SAMPLE_LOW_MIN_DECISION_VP" \
    AZEVAL_ROUTE_SAMPLE_LOW_MAX_DECISION_VP="$ROUTE_SAMPLE_LOW_MAX_DECISION_VP" \
    AZEVAL_ROUTE_SAMPLE_LOW_POLICY_WEIGHT="$ROUTE_SAMPLE_LOW_POLICY_WEIGHT" \
    AZEVAL_PRESERVE_ROUTE_FIREPOWER="$PRESERVE_ROUTE_FIREPOWER" \
    AZEVAL_PRESERVE_ROUTE_SURVIVAL="$PRESERVE_ROUTE_SURVIVAL" \
    npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept 2>&1 | tee "$OUT_DIR/logs/${name}.log"
  status=${PIPESTATUS[0]}
  set -e
  if [[ "$status" -ne 0 ]]; then
    echo "route-proof:$name failed with status=$status; writing diagnostic row and continuing" >&2
    node --input-type=module - "$out" "$name" "$status" "$max_status" "$oracle" "$farm_bonus" "$field" <<'VARIANT_JSON'
import { writeFileSync } from 'node:fs';
const [out, name, status, maxStatusLevel, farmNavigationOracle, farmValueBonus, field] = process.argv.slice(2);
writeFileSync(out, `${JSON.stringify({
  name,
  failed: true,
  exit_status: Number(status),
  maxStatusLevel: Number(maxStatusLevel),
  farmNavigationOracle,
  farmValueBonus: Number(farmValueBonus),
  field,
  error: 'route-proof variant failed or timed out before producing an AZEVAL row'
}, null, 2)}\n`);
VARIANT_JSON
  fi
  return 0
}

run_variant strict-pure 0 off 0 "$FIELD"
run_variant tainted-tolerance 1 off 0 "$FIELD"
run_variant no-pvp-corruption 3 off 0 "$FIELD"
run_variant strict-pure-farm-oracle 0 force 0 "$FIELD"
run_variant strict-pure-oracle-bonus 0 force 20 "$FIELD"
run_variant strict-pure-no-pvphunter 0 off 0 "$ALT_FIELD"

node --input-type=module <<'NODE'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const runId = process.env.RUN_ID;
const dir = `ml/meta_runs/${runId}/route-proof`;
const variantOrder = (process.env.VARIANTS ?? '').split(',').filter(Boolean);
const rows = readdirSync(dir)
	.filter((name) => name.endsWith('.json') && !name.endsWith('.trace.json'))
	.map((name) => {
		const row = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8'));
		return {
      name: name.replace(/\.json$/, ''),
      failed: row.failed === true,
      exit_status: row.exit_status,
      error: row.error,
      planner_VP_avg: row.planner_VP_avg,
      planner_win_pct: row.planner_win_pct,
      planner_reach30_pct: row.planner_reach30_pct,
      planner_status_avg: row.planner_status_avg,
      planner_max_status: row.planner_max_status,
      planner_status_cap_violations: row.planner_status_cap_violations,
      planner_status_cap_violation_events: row.planner_status_cap_violation_events,
      planner_own_status_cap_violation_events: row.planner_own_status_cap_violation_events,
      planner_external_status_cap_violation_events: row.planner_external_status_cap_violation_events,
      planner_deadline_status_cap_violation_events: row.planner_deadline_status_cap_violation_events,
      planner_status_cap_violation_sources: row.planner_status_cap_violation_sources,
      planner_monster_kills_per_game: row.planner_monster_kills_per_game,
      planner_monster_combats_per_game: row.planner_monster_combats_per_game,
      planner_abyss_navs_per_game: row.planner_abyss_navs_per_game,
      planner_navigation_prior_uses_per_game: row.planner_navigation_prior_uses_per_game,
      planner_navigation_destinations_per_game: row.planner_navigation_destinations_per_game,
      planner_location_interactions_per_game: row.planner_location_interactions_per_game,
      planner_combat_opportunities_per_game: row.planner_combat_opportunities_per_game,
      planner_clean_combat_opportunities_per_game: row.planner_clean_combat_opportunities_per_game,
      planner_firepower_combat_opportunities_per_game: row.planner_firepower_combat_opportunities_per_game,
      planner_corrupt_only_combat_opportunities_per_game: row.planner_corrupt_only_combat_opportunities_per_game,
      planner_missed_clean_combat_opportunity_pct: row.planner_missed_clean_combat_opportunity_pct,
      planner_missed_firepower_combat_opportunity_pct: row.planner_missed_firepower_combat_opportunity_pct,
      planner_max_clean_kill_prob: row.planner_max_clean_kill_prob,
      planner_max_firepower_kill_prob: row.planner_max_firepower_kill_prob,
      planner_max_expected_attack_avg: row.planner_max_expected_attack_avg,
      planner_max_barrier_avg: row.planner_max_barrier_avg,
      planner_max_current_barrier_avg: row.planner_max_current_barrier_avg,
      planner_max_attack_dice_avg: row.planner_max_attack_dice_avg,
      planner_max_spirit_animal_avg: row.planner_max_spirit_animal_avg,
      planner_max_cultivator_avg: row.planner_max_cultivator_avg,
      planner_max_healer_avg: row.planner_max_healer_avg,
      planner_farm_opportunity_vp_per_game: row.planner_farm_opportunity_vp_per_game,
      planner_missed_farm_opportunity_vp_pct: row.planner_missed_farm_opportunity_vp_pct,
      field_bestVP_avg: row.field_bestVP_avg,
	      maxStatusLevel: row.maxStatusLevel,
	      farmNavigationOracle: row.farmNavigationOracle,
	      farmValueBonus: row.farmValueBonus,
	      weights: row.weights,
	      patchNavWeights: row.patchNavWeights,
	      patchNavigationPolicyGate: row.patchNavigationPolicyGate,
	      patch2NavWeights: row.patch2NavWeights,
	      patch2NavigationPolicyGate: row.patch2NavigationPolicyGate,
	      navWeights: row.navWeights,
	      navigationPolicyGate: row.navigationPolicyGate,
	      scaleNavWeights: row.scaleNavWeights,
      scalingNavigationPolicyGate: row.scalingNavigationPolicyGate,
      microWeights: row.microWeights,
      microPolicyGate: row.microPolicyGate,
      routeCloserMicroWeights: row.routeCloserMicroWeights,
      routeFinishOracle: row.routeFinishOracle,
      preserveRouteFirepower: row.preserveRouteFirepower,
      preserveRouteSurvival: row.preserveRouteSurvival,
      route_sample_dir: row.route_sample_dir,
      route_success_games: row.route_success_games,
      route_near_miss_games: row.route_near_miss_games,
      route_low_tail_games: row.route_low_tail_games,
      route_success_samples: row.route_success_samples,
      route_near_miss_samples: row.route_near_miss_samples,
      route_low_tail_samples: row.route_low_tail_samples,
      route_contrast_samples: row.route_contrast_samples,
			field: row.field
		};
	})
	.sort((a, b) => {
		const ai = variantOrder.indexOf(a.name);
		const bi = variantOrder.indexOf(b.name);
		if (ai >= 0 || bi >= 0) return (ai >= 0 ? ai : 9999) - (bi >= 0 ? bi : 9999);
		return a.name.localeCompare(b.name);
	});
const byName = (name) => rows.find((r) => r.name === name);
const strictPure = byName('strict-pure');
const tainted = byName('tainted-tolerance');
const noPvpCorruption = byName('no-pvp-corruption');
const farmOracle = byName('strict-pure-farm-oracle');
const oracleBonus = byName('strict-pure-oracle-bonus');
const noPvpHunter = byName('strict-pure-no-pvphunter');
const diff = (a, b) => (a && b ? +(a.planner_VP_avg - b.planner_VP_avg).toFixed(2) : null);
const summary = {
	run_id: runId,
	generated_at: new Date().toISOString(),
  weights: process.env.WEIGHTS,
  patch_nav_weights: process.env.PATCH_NAV_WEIGHTS,
  patch_nav_gate: process.env.PATCH_NAV_GATE,
  nav_weights: process.env.NAV_WEIGHTS,
  nav_gate: process.env.NAV_GATE,
  scale_nav_weights: process.env.SCALE_NAV_WEIGHTS,
  scale_nav_gate: process.env.SCALE_NAV_GATE,
  micro_weights: process.env.MICRO_WEIGHTS,
  micro_gate: process.env.MICRO_GATE,
  route_closer_micro_weights: process.env.ROUTE_CLOSER_MICRO_WEIGHTS,
  route_finish_oracle: process.env.ROUTE_FINISH_ORACLE,
  trace: process.env.TRACE,
  trace_min_vp: Number(process.env.TRACE_MIN_VP),
  trace_max_vp: process.env.TRACE_MAX_VP ? Number(process.env.TRACE_MAX_VP) : null,
  route_sample_export: process.env.ROUTE_SAMPLE_EXPORT,
  route_sample_min_decision_vp: Number(process.env.ROUTE_SAMPLE_MIN_DECISION_VP),
  route_sample_max_decision_vp: process.env.ROUTE_SAMPLE_MAX_DECISION_VP ? Number(process.env.ROUTE_SAMPLE_MAX_DECISION_VP) : null,
  route_sample_success_vp: Number(process.env.ROUTE_SAMPLE_SUCCESS_VP),
  route_sample_near_min_vp: Number(process.env.ROUTE_SAMPLE_NEAR_MIN_VP),
  route_sample_low_max_vp: process.env.ROUTE_SAMPLE_LOW_MAX_VP ? Number(process.env.ROUTE_SAMPLE_LOW_MAX_VP) : null,
  route_sample_low_min_decision_vp: process.env.ROUTE_SAMPLE_LOW_MIN_DECISION_VP ? Number(process.env.ROUTE_SAMPLE_LOW_MIN_DECISION_VP) : null,
  route_sample_low_max_decision_vp: process.env.ROUTE_SAMPLE_LOW_MAX_DECISION_VP ? Number(process.env.ROUTE_SAMPLE_LOW_MAX_DECISION_VP) : null,
  route_sample_low_policy_weight: Number(process.env.ROUTE_SAMPLE_LOW_POLICY_WEIGHT),
  preserve_route_firepower: process.env.PRESERVE_ROUTE_FIREPOWER,
  preserve_route_survival: process.env.PRESERVE_ROUTE_SURVIVAL,
  games: Number(process.env.GAMES),
	iters: Number(process.env.ITERS),
	horizon: Number(process.env.HORIZON),
	rows,
	interpretation: {
		strict_pure_reaches_10_vp: (
			(strictPure?.planner_VP_avg ?? 0) >= 10 &&
			(strictPure?.planner_max_status ?? Infinity) <= 0 &&
			(strictPure?.planner_status_cap_violations ?? Infinity) === 0
		),
		strict_pure_owned_clean_reaches_10_vp: (
			(strictPure?.planner_VP_avg ?? 0) >= 10 &&
			(strictPure?.planner_own_status_cap_violation_events ?? Infinity) === 0
		),
		strict_pure_external_corruption_pressure: (
			(strictPure?.planner_external_status_cap_violation_events ?? 0) > 0
		),
		no_pvphunter_strict_pure_reaches_10_vp: (
			(noPvpHunter?.planner_VP_avg ?? 0) >= 10 &&
			(noPvpHunter?.planner_max_status ?? Infinity) <= 0 &&
			(noPvpHunter?.planner_status_cap_violations ?? Infinity) === 0
		),
		no_pvphunter_strict_pure_owned_clean_reaches_10_vp: (
			(noPvpHunter?.planner_VP_avg ?? 0) >= 10 &&
			(noPvpHunter?.planner_own_status_cap_violation_events ?? Infinity) === 0
		),
		oracle_strict_pure_reaches_10_vp: (
			(farmOracle?.planner_VP_avg ?? 0) >= 10 &&
			(farmOracle?.planner_max_status ?? Infinity) <= 0 &&
			(farmOracle?.planner_status_cap_violations ?? Infinity) === 0
		),
		tainted_tolerance_stays_within_cap: (
			(tainted?.planner_max_status ?? Infinity) <= 1 &&
			(tainted?.planner_status_cap_violations ?? Infinity) === 0
		),
		corruption_unlocks_no_pvp: (
			(noPvpCorruption?.planner_VP_avg ?? 0) -
			(strictPure?.planner_VP_avg ?? 0)
		) >= 4
	},
	deltas: {
		farm_oracle_vs_strict_pure_vp: diff(farmOracle, strictPure),
		oracle_bonus_vs_farm_oracle_vp: diff(oracleBonus, farmOracle),
		no_pvphunter_vs_strict_pure_vp: diff(noPvpHunter, strictPure),
		tainted_vs_strict_pure_vp: diff(tainted, strictPure),
		no_pvp_corruption_vs_strict_pure_vp: diff(noPvpCorruption, strictPure)
	}
};
writeFileSync(`ml/meta_runs/${runId}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
NODE

echo "DONE: $OUT_DIR/summary.json"
REMOTE
status=$?
set -e

LOCAL_OUT_DIR="ml/meta_runs/$RUN_ID"
mkdir -p "$LOCAL_OUT_DIR"
rsync_status=0
rsync -az "$HOST:$REMOTE_DIR/ml/meta_runs/$RUN_ID/" "$LOCAL_OUT_DIR/" || rsync_status=$?
analysis_status=0
if [[ "$rsync_status" -eq 0 ]]; then
  shopt -s nullglob
  for trace in "$LOCAL_OUT_DIR"/route-proof/*.trace.json; do
    node scripts/analyze-route-trace.mjs --out "${trace%.trace.json}.trace-analysis.json" "$trace" || analysis_status=$?
  done
  shopt -u nullglob
fi
echo "$LOCAL_OUT_DIR"
if [[ "$status" -ne 0 ]]; then
  exit "$status"
fi
if [[ "$analysis_status" -ne 0 ]]; then
  exit "$analysis_status"
fi
exit "$rsync_status"
