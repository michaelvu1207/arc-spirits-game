/**
 * AlphaZero EVAL. Pits the planner bot (current weights, neural ISMCTS navigation) as one seat,
 * rotated across seats, against a heuristic field (default includes the corruption line `pvphunter`).
 * Reports the planner's win% / VP / corruption status vs the field — the "definitively best?" gate.
 * A pass = planner wins the arena AND does it via the monster/economy line (low status), not corruption.
 *
 *   AZEVAL=1 AZEVAL_GAMES=40 AZEVAL_ITERS=160 AZEVAL_VALUEW=1 AZEVAL_FIELD=pvphunter,medium,cultivator \
 *     npx vitest run src/lib/play/ml/_azeval.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { profileFor } from '../server/botPolicy';
import { SEAT_COLORS, type GameCommand, type SeatColor } from '../types';
import { playPlannerSelfPlayGame, type MicroPolicyGate, type NavigationPolicyGate, type PvpPivotOracle } from './selfplay';
import { ACT_DIM, OBS_DIM } from './encode';
import { appendSamples, loadOrSnapshotCatalog, loadPolicyForEval, mlPath } from './nodeIo';
import type { Sample } from './driver';
import type { NeuralPolicy } from './net';

const RUN = process.env.AZEVAL === '1';

function parseCommandTypeSet(raw: string | undefined): Set<GameCommand['type']> | undefined {
	if (!raw) return undefined;
	const types = raw.split(',').map((s) => s.trim()).filter(Boolean) as GameCommand['type'][];
	return types.length > 0 ? new Set(types) : undefined;
}

function parseForbidTypes(): Set<GameCommand['type']> | undefined {
	const raw = process.env.AZEVAL_FORBID_TYPES ?? process.env.AZ_FORBID_TYPES ?? process.env.AZ_FORBID;
	return parseCommandTypeSet(raw);
}

function parseNavigationPolicyGate(raw: string | undefined, fallback: NavigationPolicyGate): NavigationPolicyGate {
	if (
		raw === 'unsafe-firepower' ||
			raw === 'unsafe-firepower-build-option' ||
			raw === 'midroute-scaling' ||
			raw === 'route-option-scaling' ||
			raw === 'clean-farm-q' ||
			raw === 'pure-farm-build' ||
				raw === 'good-nonfallen-farm-build' ||
					raw === 'good-nonfallen-farm-target-pivot' ||
					raw === 'good-nonfallen-farm-target-evade' ||
					raw === 'good-target-exposure' ||
					raw === 'good-target-rendezvous-exposure' ||
					raw === 'good-nonfallen-score-floor' ||
				raw === 'good-builder-oracle' ||
				raw === 'good-builder-farmer-oracle' ||
				raw === 'good-builder-support-oracle' ||
				raw === 'good-builder-noncontest-support-oracle' ||
			raw === 'hp2-survival-deficit' ||
		raw === 'hp4-first-wall' ||
		raw === 'route-closer' ||
		raw === 'route-finish-loop' ||
		raw === 'survival-rebuild' ||
		raw === 'pvp-pivot' ||
		raw === 'pvp-predictive-pivot' ||
		raw === 'pvp-predictive-mode-pivot' ||
		raw === 'pvp-predictive-mode-hunt-fallback-pivot' ||
		raw === 'pvp-predictive-mode-hunt-fallback-rebuild-pivot' ||
		raw === 'pvp-predictive-flex-pivot' ||
		raw === 'pvp-predictive-value-pivot' ||
		raw === 'pvp-predictive-finish-pivot' ||
		raw === 'pvp-good-target-value-pivot'
	) {
		return raw;
	}
	return fallback;
}

function parseMicroPolicyGate(raw: string | undefined, fallback: MicroPolicyGate): MicroPolicyGate {
	if (
		raw === 'abyss-round' ||
		raw === 'abyss-farm-actions' ||
		raw === 'abyss-reward-actions' ||
		raw === 'abyss-farm-overlay' ||
		raw === 'good-builder-oracle' ||
		raw === 'good-builder-farmer-oracle' ||
		raw === 'good-builder-support-oracle' ||
		raw === 'good-builder-hp4-oracle' ||
		raw === 'good-builder-hp4-pick-oracle' ||
		raw === 'good-builder-hp4-conversion-overlay' ||
		raw === 'good-builder-hp4-conversion-oracle' ||
		raw === 'good-builder-hp4-scorefloor-oracle' ||
		raw === 'good-builder-score-pick-oracle' ||
		raw === 'good-builder-score-conversion-oracle' ||
		raw === 'location-interactions' ||
		raw === 'route-closer-full' ||
		raw === 'route-closer-oracle' ||
		raw === 'route-finish-oracle' ||
		raw === 'pvp-pivot' ||
		raw === 'pvp-pivot-encounter-force' ||
		raw === 'pvp-high-value-encounter-force'
	) {
		return raw;
	}
	return fallback;
}

function parsePvpPivotOracle(raw: string | undefined): PvpPivotOracle {
	return raw === 'fallen-hunt' ||
		raw === 'late-descend-hunt' ||
		raw === 'fallen-predictive-hunt' ||
		raw === 'late-descend-predictive-hunt' ||
		raw === 'status2-conversion-descend' ||
		raw === 'status2-target-descend'
		? raw
		: 'off';
}

interface NeuralFieldStackSpec {
	name?: string;
	weights?: string;
	policy?: string;
	microWeights?: string;
	microPolicyGate?: string;
	navWeights?: string;
	navigationPolicyGate?: string;
	patchNavWeights?: string;
	patchNavigationPolicyGate?: string;
	patch2NavWeights?: string;
	patch2NavigationPolicyGate?: string;
	scaleNavWeights?: string;
	scalingNavigationPolicyGate?: string;
	maxStatusLevel?: number | null;
	forbidTypes?: string[] | string;
	preserveRouteFirepower?: boolean | string | number;
	preserveRouteSurvival?: boolean | string | number;
	abyssRouteDiscipline?: boolean | string | number;
	goodTargetActionDiscipline?: boolean | string | number;
	pvpPivotOracle?: string;
}

interface LoadedNeuralFieldStack {
	name: string;
	weights: string;
	policy: NeuralPolicy;
	microWeights?: string;
	microPolicy?: NeuralPolicy;
	microPolicyGate?: MicroPolicyGate;
	navWeights?: string;
	navigationPolicy?: NeuralPolicy;
	navigationPolicyGate?: NavigationPolicyGate;
	patchNavWeights?: string;
	patchNavigationPolicy?: NeuralPolicy;
	patchNavigationPolicyGate?: NavigationPolicyGate;
	patch2NavWeights?: string;
	patch2NavigationPolicy?: NeuralPolicy;
	patch2NavigationPolicyGate?: NavigationPolicyGate;
	scaleNavWeights?: string;
	scalingNavigationPolicy?: NeuralPolicy;
	scalingNavigationPolicyGate?: NavigationPolicyGate;
	maxStatusLevel?: number;
	forbidTypes?: Set<GameCommand['type']>;
	preserveRouteFirepower?: boolean;
	preserveRouteSurvival?: boolean;
	abyssRouteDiscipline?: boolean;
	goodTargetActionDiscipline?: boolean;
	pvpPivotOracle?: PvpPivotOracle;
}

function parseBoolean(value: boolean | string | number | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value !== 0;
	const normalized = value.trim().toLowerCase();
	if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
	if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
	return undefined;
}

function parseStackForbidTypes(raw: string[] | string | undefined): Set<GameCommand['type']> | undefined {
	if (Array.isArray(raw)) {
		return raw.length > 0 ? new Set(raw as GameCommand['type'][]) : undefined;
	}
	return parseCommandTypeSet(raw);
}

function loadNeuralFieldStackSpecs(): NeuralFieldStackSpec[] {
	const file = process.env.AZEVAL_NEURAL_FIELD_STACKS_FILE ?? process.env.AZ_NEURAL_FIELD_STACKS_FILE;
	const raw = file
		? readFileSync(file, 'utf8')
		: process.env.AZEVAL_NEURAL_FIELD_STACKS_JSON ?? process.env.AZ_NEURAL_FIELD_STACKS_JSON;
	if (!raw) return [];
	const parsed = JSON.parse(raw) as NeuralFieldStackSpec[] | { stacks?: NeuralFieldStackSpec[] };
	if (Array.isArray(parsed)) return parsed;
	return parsed.stacks ?? [];
}

function loadNeuralFieldStack(spec: NeuralFieldStackSpec, index: number): LoadedNeuralFieldStack {
	const weights = spec.weights ?? spec.policy;
	if (!weights) throw new Error(`neural field stack ${index} is missing weights`);
	const microWeights = spec.microWeights;
	const navWeights = spec.navWeights;
	const patchNavWeights = spec.patchNavWeights;
	const patch2NavWeights = spec.patch2NavWeights;
	const scaleNavWeights = spec.scaleNavWeights;
	return {
		name: spec.name ?? `stack${index + 1}`,
		weights,
		policy: loadPolicyForEval(weights),
		microWeights,
		microPolicy: microWeights ? loadPolicyForEval(microWeights) : undefined,
		microPolicyGate: parseMicroPolicyGate(spec.microPolicyGate, 'all'),
		navWeights,
		navigationPolicy: navWeights ? loadPolicyForEval(navWeights) : undefined,
		navigationPolicyGate: parseNavigationPolicyGate(spec.navigationPolicyGate, 'all'),
		patchNavWeights,
		patchNavigationPolicy: patchNavWeights ? loadPolicyForEval(patchNavWeights) : undefined,
		patchNavigationPolicyGate: parseNavigationPolicyGate(spec.patchNavigationPolicyGate, 'all'),
		patch2NavWeights,
		patch2NavigationPolicy: patch2NavWeights ? loadPolicyForEval(patch2NavWeights) : undefined,
		patch2NavigationPolicyGate: parseNavigationPolicyGate(spec.patch2NavigationPolicyGate, 'all'),
		scaleNavWeights,
		scalingNavigationPolicy: scaleNavWeights ? loadPolicyForEval(scaleNavWeights) : undefined,
		scalingNavigationPolicyGate: parseNavigationPolicyGate(spec.scalingNavigationPolicyGate, 'route-option-scaling'),
		maxStatusLevel: spec.maxStatusLevel === null || spec.maxStatusLevel === undefined ? undefined : spec.maxStatusLevel,
		forbidTypes: parseStackForbidTypes(spec.forbidTypes),
			preserveRouteFirepower: parseBoolean(spec.preserveRouteFirepower),
			preserveRouteSurvival: parseBoolean(spec.preserveRouteSurvival),
			abyssRouteDiscipline: parseBoolean(spec.abyssRouteDiscipline),
			goodTargetActionDiscipline: parseBoolean(spec.goodTargetActionDiscipline),
			pvpPivotOracle: parsePvpPivotOracle(spec.pvpPivotOracle)
		};
	}

function topN(counts: Record<string, number>, n: number): Record<string, number> {
	return Object.fromEntries(
		Object.entries(counts)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, n)
	);
}

function topNPerGame(counts: Record<string, number>, games: number, n: number): Record<string, number> {
	return Object.fromEntries(
		Object.entries(topN(counts, n)).map(([key, count]) => [key, +(count / games).toFixed(2)])
	);
}

describe('AlphaZero planner eval', () => {
	(RUN ? it : it.skip)(
		'planner vs heuristic field — win% + VP + corruption',
		async () => {
			const games = parseInt(process.env.AZEVAL_GAMES ?? '40', 10);
			const iterations = parseInt(process.env.AZEVAL_ITERS ?? '160', 10);
			const horizon = parseInt(process.env.AZEVAL_HORIZON ?? process.env.AZ_HORIZON ?? '30', 10);
			const valueWeight = parseFloat(process.env.AZEVAL_VALUEW ?? '1');
			const seatsN = parseInt(process.env.AZEVAL_SEATS ?? '4', 10);
			const progressEvery = Math.max(0, parseInt(process.env.AZEVAL_PROGRESS_EVERY ?? '0', 10));
			const field = (process.env.AZEVAL_FIELD ?? 'pvphunter,medium,cultivator,survivor')
				.split(',').map((s) => s.trim()).filter(Boolean);
			const plannerProfile = process.env.AZEVAL_PLANNER_PROFILE ?? 'cultivator';
			const plannerRoleName = process.env.AZEVAL_PLANNER_ROLE_NAME ?? 'planner';
			const forceDest = process.env.AZEVAL_FORCE_DEST || undefined;
			const control = process.env.AZEVAL_CONTROL === 'full' || process.env.AZ_CONTROL === 'full' ? 'full' : 'navigation';
			const fullSelection = process.env.AZEVAL_FULL_SELECTION === 'policy' || process.env.AZEVAL_FULL_SELECTION === 'hybrid' || process.env.AZEVAL_FULL_SELECTION === 'lookahead'
				? process.env.AZEVAL_FULL_SELECTION
				: process.env.AZ_FULL_SELECTION === 'policy' || process.env.AZ_FULL_SELECTION === 'hybrid' || process.env.AZ_FULL_SELECTION === 'lookahead'
					? process.env.AZ_FULL_SELECTION
					: 'value';
			const fullLookaheadDepth = parseInt(process.env.AZEVAL_FULL_LOOKAHEAD_DEPTH ?? process.env.AZ_FULL_LOOKAHEAD_DEPTH ?? process.env.AZ_LOOKAHEAD_DEPTH ?? '2', 10);
			const fullLookaheadBeam = parseInt(process.env.AZEVAL_FULL_LOOKAHEAD_BEAM ?? process.env.AZ_FULL_LOOKAHEAD_BEAM ?? process.env.AZ_LOOKAHEAD_BEAM ?? '8', 10);
			const fullLookaheadRootBeam = parseInt(process.env.AZEVAL_FULL_LOOKAHEAD_ROOT_BEAM ?? process.env.AZ_FULL_LOOKAHEAD_ROOT_BEAM ?? process.env.AZ_LOOKAHEAD_ROOT_BEAM ?? '24', 10);
			const fullTargetTemperature = parseFloat(process.env.AZEVAL_FULL_TARGET_TEMP ?? process.env.AZ_FULL_TARGET_TEMP ?? process.env.AZ_TARGET_TEMP ?? '0.25');
			const farmNavigationOracle = (process.env.AZEVAL_FARM_NAV_ORACLE ?? process.env.AZ_FARM_NAV_ORACLE) === 'force' ? 'force' : 'off';
			const rawPvpPivotOracle = process.env.AZEVAL_PVP_PIVOT_ORACLE ?? process.env.AZ_PVP_PIVOT_ORACLE;
			const pvpPivotOracle = parsePvpPivotOracle(rawPvpPivotOracle);
			const farmNavigationThreshold = parseFloat(process.env.AZEVAL_FARM_NAV_THRESHOLD ?? process.env.AZ_FARM_NAV_THRESHOLD ?? '0.5');
			const routeModeThreshold = parseFloat(process.env.AZEVAL_ROUTE_MODE_THRESHOLD ?? process.env.AZ_ROUTE_MODE_THRESHOLD ?? '0.5');
			const farmValueBonus = parseFloat(process.env.AZEVAL_FARM_VALUE_BONUS ?? process.env.AZ_FARM_VALUE_BONUS ?? '0');
			const farmValueThreshold = parseFloat(process.env.AZEVAL_FARM_VALUE_THRESHOLD ?? process.env.AZ_FARM_VALUE_THRESHOLD ?? '0');
			const rawFarmValueSource = process.env.AZEVAL_FARM_VALUE_SOURCE ?? process.env.AZ_FARM_VALUE_SOURCE;
			const farmValueSource =
				rawFarmValueSource === 'head' || rawFarmValueSource === 'max' || rawFarmValueSource === 'sum'
					? rawFarmValueSource
					: 'heuristic';
			const farmValueMinMonsterHpRaw = process.env.AZEVAL_FARM_VALUE_MIN_MONSTER_HP ?? process.env.AZ_FARM_VALUE_MIN_MONSTER_HP;
			const farmValueMaxMonsterHpRaw = process.env.AZEVAL_FARM_VALUE_MAX_MONSTER_HP ?? process.env.AZ_FARM_VALUE_MAX_MONSTER_HP;
			const farmValueMaxStatusRaw = process.env.AZEVAL_FARM_VALUE_MAX_STATUS_LEVEL ?? process.env.AZ_FARM_VALUE_MAX_STATUS_LEVEL;
			const farmValueMinMonsterHp = farmValueMinMonsterHpRaw ? parseFloat(farmValueMinMonsterHpRaw) : undefined;
			const farmValueMaxMonsterHp = farmValueMaxMonsterHpRaw ? parseFloat(farmValueMaxMonsterHpRaw) : undefined;
			const farmValueMaxStatusLevel = farmValueMaxStatusRaw ? parseInt(farmValueMaxStatusRaw, 10) : undefined;
			const forbidTypes = parseForbidTypes();
			const maxStatusLevel = process.env.AZEVAL_MAX_STATUS_LEVEL
				? parseInt(process.env.AZEVAL_MAX_STATUS_LEVEL, 10)
				: process.env.AZ_MAX_STATUS_LEVEL
					? parseInt(process.env.AZ_MAX_STATUS_LEVEL, 10)
					: undefined;
			const hardConstraints =
				(process.env.AZEVAL_HARD_CONSTRAINTS ?? process.env.AZ_HARD_CONSTRAINTS ?? (maxStatusLevel !== undefined ? '1' : '0')) === '1';
			const neuralField = (process.env.AZEVAL_NEURAL_FIELD ?? process.env.AZ_NEURAL_FIELD ?? '0') === '1';
			const neuralFieldSharedStack =
				(process.env.AZEVAL_NEURAL_FIELD_SHARED_STACK ?? process.env.AZ_NEURAL_FIELD_SHARED_STACK ?? '0') === '1';
			const neuralFieldOpponentMaxStatusRaw =
				process.env.AZEVAL_NEURAL_FIELD_OPP_MAX_STATUS_LEVEL ?? process.env.AZ_NEURAL_FIELD_OPP_MAX_STATUS_LEVEL;
			const neuralFieldOpponentMaxStatusLevel =
				neuralFieldOpponentMaxStatusRaw === undefined || neuralFieldOpponentMaxStatusRaw === ''
					? undefined
					: parseInt(neuralFieldOpponentMaxStatusRaw, 10);
			const neuralFieldOpponentForbidTypes = parseCommandTypeSet(
				process.env.AZEVAL_NEURAL_FIELD_OPP_FORBID_TYPES ?? process.env.AZ_NEURAL_FIELD_OPP_FORBID_TYPES
			);
			const preserveRouteFirepower =
				(process.env.AZEVAL_PRESERVE_ROUTE_FIREPOWER ?? process.env.AZ_PRESERVE_ROUTE_FIREPOWER ?? '0') === '1';
			const preserveRouteSurvival =
				(process.env.AZEVAL_PRESERVE_ROUTE_SURVIVAL ?? process.env.AZ_PRESERVE_ROUTE_SURVIVAL ?? '0') === '1';
			const abyssRouteDiscipline =
				(process.env.AZEVAL_ABYSS_ROUTE_DISCIPLINE ?? process.env.AZ_ABYSS_ROUTE_DISCIPLINE ?? '0') === '1';
			const goodTargetActionDiscipline =
				(process.env.AZEVAL_GOOD_TARGET_ACTION_DISCIPLINE ?? process.env.AZ_GOOD_TARGET_ACTION_DISCIPLINE ?? '0') === '1';
			const traceEnabled = (process.env.AZEVAL_TRACE ?? process.env.AZ_TRACE ?? '0') === '1';
			const traceAllSeats = (process.env.AZEVAL_TRACE_ALL_SEATS ?? process.env.AZ_TRACE_ALL_SEATS ?? '0') === '1';
			const traceMinVp = parseFloat(process.env.AZEVAL_TRACE_MIN_VP ?? process.env.AZ_TRACE_MIN_VP ?? '20');
			const traceMaxVpRaw = process.env.AZEVAL_TRACE_MAX_VP ?? process.env.AZ_TRACE_MAX_VP;
			const traceMaxVp = traceMaxVpRaw === undefined || traceMaxVpRaw === ''
				? Number.POSITIVE_INFINITY
				: parseFloat(traceMaxVpRaw);
			const traceOut = process.env.AZEVAL_TRACE_OUT ?? process.env.AZ_TRACE_OUT;
			const routeSampleDir = process.env.AZEVAL_ROUTE_SAMPLE_DIR ?? process.env.AZ_ROUTE_SAMPLE_DIR;
			const routeSampleReset = (process.env.AZEVAL_ROUTE_SAMPLE_RESET ?? process.env.AZ_ROUTE_SAMPLE_RESET ?? '0') === '1';
			const routeSampleAllSeats =
				(process.env.AZEVAL_ROUTE_SAMPLE_ALL_SEATS ?? process.env.AZ_ROUTE_SAMPLE_ALL_SEATS ?? '0') === '1';
			const routeSampleMaxStatusRaw =
				process.env.AZEVAL_ROUTE_SAMPLE_MAX_STATUS_LEVEL ?? process.env.AZ_ROUTE_SAMPLE_MAX_STATUS_LEVEL;
			const routeSampleMaxStatusLevel =
				routeSampleMaxStatusRaw === undefined || routeSampleMaxStatusRaw === ''
					? undefined
					: parseInt(routeSampleMaxStatusRaw, 10);
			const routeSampleMinDecisionVp = parseFloat(process.env.AZEVAL_ROUTE_SAMPLE_MIN_DECISION_VP ?? process.env.AZ_ROUTE_SAMPLE_MIN_DECISION_VP ?? '18');
			const routeSampleMaxDecisionVpRaw = process.env.AZEVAL_ROUTE_SAMPLE_MAX_DECISION_VP ?? process.env.AZ_ROUTE_SAMPLE_MAX_DECISION_VP;
			const routeSampleMaxDecisionVp = routeSampleMaxDecisionVpRaw === undefined || routeSampleMaxDecisionVpRaw === ''
				? Number.POSITIVE_INFINITY
				: parseFloat(routeSampleMaxDecisionVpRaw);
			const routeSampleSuccessVp = parseFloat(process.env.AZEVAL_ROUTE_SAMPLE_SUCCESS_VP ?? process.env.AZ_ROUTE_SAMPLE_SUCCESS_VP ?? '30');
			const routeSampleNearMinVp = parseFloat(process.env.AZEVAL_ROUTE_SAMPLE_NEAR_MIN_VP ?? process.env.AZ_ROUTE_SAMPLE_NEAR_MIN_VP ?? '28');
			const routeSampleLowMaxVpRaw = process.env.AZEVAL_ROUTE_SAMPLE_LOW_MAX_VP ?? process.env.AZ_ROUTE_SAMPLE_LOW_MAX_VP;
			const parsedRouteSampleLowMaxVp = routeSampleLowMaxVpRaw === undefined || routeSampleLowMaxVpRaw === ''
				? NaN
				: parseFloat(routeSampleLowMaxVpRaw);
			const routeSampleLowMaxVp = Number.isFinite(parsedRouteSampleLowMaxVp) ? parsedRouteSampleLowMaxVp : null;
			const routeSampleLowMinDecisionVpRaw =
				process.env.AZEVAL_ROUTE_SAMPLE_LOW_MIN_DECISION_VP ?? process.env.AZ_ROUTE_SAMPLE_LOW_MIN_DECISION_VP;
			const parsedRouteSampleLowMinDecisionVp =
				routeSampleLowMinDecisionVpRaw === undefined || routeSampleLowMinDecisionVpRaw === ''
					? routeSampleMinDecisionVp
					: parseFloat(routeSampleLowMinDecisionVpRaw);
			const routeSampleLowMinDecisionVp = Number.isFinite(parsedRouteSampleLowMinDecisionVp)
				? parsedRouteSampleLowMinDecisionVp
				: routeSampleMinDecisionVp;
			const routeSampleLowMaxDecisionVpRaw =
				process.env.AZEVAL_ROUTE_SAMPLE_LOW_MAX_DECISION_VP ?? process.env.AZ_ROUTE_SAMPLE_LOW_MAX_DECISION_VP;
			const parsedRouteSampleLowMaxDecisionVp = routeSampleLowMaxDecisionVpRaw === undefined || routeSampleLowMaxDecisionVpRaw === ''
				? routeSampleMaxDecisionVp
				: parseFloat(routeSampleLowMaxDecisionVpRaw);
			const routeSampleLowMaxDecisionVp = Number.isFinite(parsedRouteSampleLowMaxDecisionVp)
				? parsedRouteSampleLowMaxDecisionVp
				: routeSampleMaxDecisionVp;
			const parsedRouteSampleLowPolicyWeight = parseFloat(
				process.env.AZEVAL_ROUTE_SAMPLE_LOW_POLICY_WEIGHT ?? process.env.AZ_ROUTE_SAMPLE_LOW_POLICY_WEIGHT ?? '0'
			);
			const routeSampleLowPolicyWeight = Number.isFinite(parsedRouteSampleLowPolicyWeight)
				? Math.max(0, parsedRouteSampleLowPolicyWeight)
				: 0;
			const routeSampleRoleRegexRaw =
				process.env.AZEVAL_ROUTE_SAMPLE_ROLE_REGEX ?? process.env.AZ_ROUTE_SAMPLE_ROLE_REGEX ?? '';
			const routeSampleRoleRegex = routeSampleRoleRegexRaw ? new RegExp(routeSampleRoleRegexRaw) : null;
			const routeSampleMaxConcededShareRaw =
				process.env.AZEVAL_ROUTE_SAMPLE_MAX_CONCEDED_SHARE ?? process.env.AZ_ROUTE_SAMPLE_MAX_CONCEDED_SHARE;
			const parsedRouteSampleMaxConcededShare =
				routeSampleMaxConcededShareRaw === undefined || routeSampleMaxConcededShareRaw === ''
					? NaN
					: parseFloat(routeSampleMaxConcededShareRaw);
			const routeSampleMaxConcededShare = Number.isFinite(parsedRouteSampleMaxConcededShare)
				? parsedRouteSampleMaxConcededShare
				: null;
			const parsedRouteSamplePressurePenalty = parseFloat(
				process.env.AZEVAL_ROUTE_SAMPLE_PRESSURE_PENALTY ?? process.env.AZ_ROUTE_SAMPLE_PRESSURE_PENALTY ?? '0'
			);
			const routeSamplePressurePenalty = Number.isFinite(parsedRouteSamplePressurePenalty)
				? Math.max(0, parsedRouteSamplePressurePenalty)
				: 0;
			const parsedRouteSamplePressureScale = parseFloat(
				process.env.AZEVAL_ROUTE_SAMPLE_PRESSURE_SCALE ?? process.env.AZ_ROUTE_SAMPLE_PRESSURE_SCALE ?? '30'
			);
			const routeSamplePressureScale =
				Number.isFinite(parsedRouteSamplePressureScale) && parsedRouteSamplePressureScale > 0
					? parsedRouteSamplePressureScale
					: 30;
			const routeSamplePressureFailLowTail =
				(process.env.AZEVAL_ROUTE_SAMPLE_PRESSURE_FAIL_LOW_TAIL ??
					process.env.AZ_ROUTE_SAMPLE_PRESSURE_FAIL_LOW_TAIL ??
					'0') === '1';

			const catalog = await loadOrSnapshotCatalog();
			const policy = loadPolicyForEval(process.env.AZEVAL_WEIGHTS ?? mlPath('weights', 'policy.json'));
			const patchNavWeights = process.env.AZEVAL_PATCH_NAV_WEIGHTS ?? process.env.AZ_PATCH_NAV_WEIGHTS;
			const patchNavigationPolicy = patchNavWeights ? loadPolicyForEval(patchNavWeights) : undefined;
			const rawPatchNavGate = process.env.AZEVAL_PATCH_NAV_GATE ?? process.env.AZ_PATCH_NAV_GATE;
			const patchNavigationPolicyGate = parseNavigationPolicyGate(rawPatchNavGate, 'all');
			const patch2NavWeights = process.env.AZEVAL_PATCH2_NAV_WEIGHTS ?? process.env.AZ_PATCH2_NAV_WEIGHTS;
			const patch2NavigationPolicy = patch2NavWeights ? loadPolicyForEval(patch2NavWeights) : undefined;
			const rawPatch2NavGate = process.env.AZEVAL_PATCH2_NAV_GATE ?? process.env.AZ_PATCH2_NAV_GATE;
			const patch2NavigationPolicyGate = parseNavigationPolicyGate(rawPatch2NavGate, 'all');
			const navWeights = process.env.AZEVAL_NAV_WEIGHTS ?? process.env.AZ_NAV_WEIGHTS;
			const navigationPolicy = navWeights ? loadPolicyForEval(navWeights) : undefined;
			const rawNavGate = process.env.AZEVAL_NAV_GATE ?? process.env.AZ_NAV_GATE;
			const navigationPolicyGate = parseNavigationPolicyGate(rawNavGate, 'all');
			const scaleNavWeights = process.env.AZEVAL_SCALE_NAV_WEIGHTS ?? process.env.AZ_SCALE_NAV_WEIGHTS;
			const scalingNavigationPolicy = scaleNavWeights ? loadPolicyForEval(scaleNavWeights) : undefined;
			const rawScaleNavGate = process.env.AZEVAL_SCALE_NAV_GATE ?? process.env.AZ_SCALE_NAV_GATE;
			const scalingNavigationPolicyGate = parseNavigationPolicyGate(rawScaleNavGate, 'route-option-scaling');
			const microWeights = process.env.AZEVAL_MICRO_WEIGHTS ?? process.env.AZ_MICRO_WEIGHTS;
			const microPolicy = microWeights ? loadPolicyForEval(microWeights) : undefined;
			const routeCloserMicroWeights = process.env.AZEVAL_ROUTE_CLOSER_MICRO_WEIGHTS ?? process.env.AZ_ROUTE_CLOSER_MICRO_WEIGHTS;
			const routeCloserMicroPolicy = routeCloserMicroWeights ? loadPolicyForEval(routeCloserMicroWeights) : undefined;
			const neuralFieldWeightPaths = (process.env.AZEVAL_NEURAL_FIELD_WEIGHTS ?? process.env.AZ_NEURAL_FIELD_WEIGHTS ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			const neuralFieldPolicies = neuralFieldWeightPaths.map((path) => loadPolicyForEval(path));
			const neuralFieldStacks = loadNeuralFieldStackSpecs().map(loadNeuralFieldStack);
			const routeFinishOracle =
				(process.env.AZEVAL_ROUTE_FINISH_ORACLE ?? process.env.AZ_ROUTE_FINISH_ORACLE ?? '0') === '1';
			const rawMicroGate = process.env.AZEVAL_MICRO_GATE ?? process.env.AZ_MICRO_GATE;
			const microPolicyGate = parseMicroPolicyGate(rawMicroGate, 'all');
			const out = process.env.AZEVAL_OUT ?? mlPath('azeval_result.json');
			const n = Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
			const seatList = SEAT_COLORS.slice(0, n) as SeatColor[];

			let pWins = 0, pVP = 0, pStatus = 0, pRounds = 0;
			let pKills = 0, pAbyss = 0, pNavigationPriorUses = 0, pCombat = 0, pReach30 = 0;
			let pFarmPriorApplications = 0, pFarmPriorAbyssChoices = 0, pFarmPriorScoreSum = 0, pFarmPriorBonusSum = 0, pFarmPriorMaxScore = 0;
			let pPvpAttacks = 0, pPvpVp = 0;
			let pPvpTargetCombats = 0, pPvpAggressorsFaced = 0, pPvpVpConcededShare = 0;
			let pPvpOpportunities = 0, pMissedPvpOpportunities = 0;
			let pPvpTargetVp = 0, pPvpBestTargetVp = 0, pPvpHighValueOpportunities = 0;
			let pPvpHardMonsterOpportunities = 0, pMissedPvpHardMonsterOpportunities = 0;
			let pPvpHardMonsterAttacks = 0, pPvpHardMonsterVp = 0;
			let pPvpHardMonsterTargetVp = 0, pPvpHardMonsterBestTargetVp = 0;
			let pPvpGoodTargetPivotOpportunities = 0, pMissedPvpGoodTargetPivotOpportunities = 0;
			let pPvpGoodTargetPivotAttacks = 0, pPvpGoodTargetPivotVp = 0;
			let pPvpGoodTargetPivotTargetVp = 0, pPvpGoodTargetPivotBestTargetVp = 0;
			let pPvpPivotOracleUses = 0;
			let pCombatOpps = 0, pCleanCombatOpps = 0, pFirepowerCombatOpps = 0, pCorruptOnlyCombatOpps = 0;
			let pMissedCleanCombatOpps = 0, pMissedFirepowerCombatOpps = 0;
			let pMaxExpectedAttack = 0, pMaxBarrier = 0, pMaxCurrentBarrier = 0, pMaxAttackDice = 0;
			let pMaxSpiritAnimal = 0, pMaxCultivator = 0, pMaxHealer = 0;
			let pMaxCleanKillProb = 0, pMaxFirepowerKillProb = 0;
			let pMaxStatus = 0, pStatusCapViolations = 0;
			let pStatusCapViolationEvents = 0;
			let pOwnStatusCapViolationEvents = 0;
			let pExternalStatusCapViolationEvents = 0;
			let pDeadlineStatusCapViolationEvents = 0;
			const statusCapViolationSources: Record<string, number> = {};
			let pFarmableNavs = 0, pMissedFarmableNavs = 0, pBossFarmableNavs = 0, pMissedBossFarmableNavs = 0;
			let pFarmOpportunityVp = 0, pMissedFarmOpportunityVp = 0, pMaxFarmOpportunityVp = 0;
			// Best heuristic-field opponent each game (for context).
			let fieldBestVP = 0;
			const fieldWinsByName: Record<string, number> = {};
			const decisionTypes: Record<string, number> = {};
			const navigationDestinations: Record<string, number> = {};
				const locationInteractions: Record<string, number> = {};
				const gameSummaries: Array<{
					game: number;
					plannerSeat: SeatColor;
					winnerSeat: SeatColor | null;
					winnerName: string;
					plannerVp: number;
					plannerStatus: number;
					rounds: number;
					finalVP: Record<string, number>;
					finalStatus: Record<string, number>;
					seatNames: Record<string, string>;
					seatStats: Record<string, {
						vp: number;
						status: number;
						kills: number;
						pvpVp: number;
						pvpAttacks: number;
						pvpTargetCombats: number;
						pvpAggressorsFaced: number;
						pvpVpConcededShare: number;
						pvpBestTargetVp: number;
						pvpPivotOracleUses: number;
						maxExpectedAttack: number;
						maxSpiritAnimal: number;
					}>;
				}> = [];
				const tracedGames: unknown[] = [];
			let routeSuccessGames = 0;
			let routeNearMissGames = 0;
			let routeLowTailGames = 0;
			let routePressureFailGames = 0;
			let routeSuccessSamples = 0;
			let routeNearMissSamples = 0;
			let routeLowTailSamples = 0;
			let routePressureFailSamples = 0;
			if (routeSampleDir && routeSampleReset) {
				rmSync(routeSampleDir, { recursive: true, force: true });
			}
			const startedAt = Date.now();

			for (let g = 0; g < games; g++) {
				const plannerSeat = seatList[g % n];
				if (progressEvery > 0 && (g === 0 || g % progressEvery === 0)) {
					/* eslint-disable-next-line no-console */
					console.log(`[azeval] progress ${g}/${games} nextSeat=${plannerSeat}`);
				}
				// Fill the OTHER seats from the field (rotated), planner seat gets a placeholder profile
				// (its navigation is overridden by the planner; within-round uses 'medium').
				const profiles = seatList.map((s, i) => {
					if (s === plannerSeat) return profileFor(plannerProfile);
					return profileFor(field[(g + i) % field.length]);
				});
				const neuralFieldSeatPolicies: Partial<Record<SeatColor, typeof policy>> = {};
				const neuralFieldSeatMicroPolicies: Partial<Record<SeatColor, typeof policy>> = {};
				const neuralFieldSeatMicroPolicyGates: Partial<Record<SeatColor, MicroPolicyGate>> = {};
				const neuralFieldSeatNavigationPolicies: Partial<Record<SeatColor, typeof policy>> = {};
				const neuralFieldSeatNavigationPolicyGates: Partial<Record<SeatColor, NavigationPolicyGate>> = {};
				const neuralFieldSeatPatchNavigationPolicies: Partial<Record<SeatColor, typeof policy>> = {};
				const neuralFieldSeatPatchNavigationPolicyGates: Partial<Record<SeatColor, NavigationPolicyGate>> = {};
				const neuralFieldSeatPatch2NavigationPolicies: Partial<Record<SeatColor, typeof policy>> = {};
				const neuralFieldSeatPatch2NavigationPolicyGates: Partial<Record<SeatColor, NavigationPolicyGate>> = {};
				const neuralFieldSeatScalingNavigationPolicies: Partial<Record<SeatColor, typeof policy>> = {};
				const neuralFieldSeatScalingNavigationPolicyGates: Partial<Record<SeatColor, NavigationPolicyGate>> = {};
				const neuralFieldMaxStatusBySeat: Partial<Record<SeatColor, number>> = {};
				const neuralFieldForbidBySeat: Partial<Record<SeatColor, Set<GameCommand['type']>>> = {};
				const neuralFieldPreserveFirepowerBySeat: Partial<Record<SeatColor, boolean>> = {};
				const neuralFieldPreserveSurvivalBySeat: Partial<Record<SeatColor, boolean>> = {};
				const neuralFieldAbyssDisciplineBySeat: Partial<Record<SeatColor, boolean>> = {};
				const neuralFieldGoodTargetDisciplineBySeat: Partial<Record<SeatColor, boolean>> = {};
				const neuralFieldPvpPivotOracleBySeat: Partial<Record<SeatColor, PvpPivotOracle>> = {};
				const neuralFieldNameBySeat: Partial<Record<SeatColor, string>> = {};
				if (neuralField) {
					for (let i = 0; i < seatList.length; i++) {
						const s = seatList[i];
						if (s === plannerSeat) continue;
						const opponentStack = neuralFieldStacks.length > 0
							? neuralFieldStacks[(g + i) % neuralFieldStacks.length]
							: undefined;
						if (opponentStack) {
							neuralFieldNameBySeat[s] = opponentStack.name;
							neuralFieldSeatPolicies[s] = opponentStack.policy;
							if (opponentStack.microPolicy) neuralFieldSeatMicroPolicies[s] = opponentStack.microPolicy;
							if (opponentStack.microPolicyGate) neuralFieldSeatMicroPolicyGates[s] = opponentStack.microPolicyGate;
							if (opponentStack.navigationPolicy) neuralFieldSeatNavigationPolicies[s] = opponentStack.navigationPolicy;
							if (opponentStack.navigationPolicyGate) neuralFieldSeatNavigationPolicyGates[s] = opponentStack.navigationPolicyGate;
							if (opponentStack.patchNavigationPolicy) neuralFieldSeatPatchNavigationPolicies[s] = opponentStack.patchNavigationPolicy;
							if (opponentStack.patchNavigationPolicyGate) neuralFieldSeatPatchNavigationPolicyGates[s] = opponentStack.patchNavigationPolicyGate;
							if (opponentStack.patch2NavigationPolicy) neuralFieldSeatPatch2NavigationPolicies[s] = opponentStack.patch2NavigationPolicy;
							if (opponentStack.patch2NavigationPolicyGate) neuralFieldSeatPatch2NavigationPolicyGates[s] = opponentStack.patch2NavigationPolicyGate;
							if (opponentStack.scalingNavigationPolicy) neuralFieldSeatScalingNavigationPolicies[s] = opponentStack.scalingNavigationPolicy;
							if (opponentStack.scalingNavigationPolicyGate) neuralFieldSeatScalingNavigationPolicyGates[s] = opponentStack.scalingNavigationPolicyGate;
							if (opponentStack.maxStatusLevel !== undefined) neuralFieldMaxStatusBySeat[s] = opponentStack.maxStatusLevel;
							else if (neuralFieldOpponentMaxStatusLevel !== undefined) neuralFieldMaxStatusBySeat[s] = neuralFieldOpponentMaxStatusLevel;
							if (opponentStack.forbidTypes?.size) neuralFieldForbidBySeat[s] = opponentStack.forbidTypes;
							else if (neuralFieldOpponentForbidTypes?.size) neuralFieldForbidBySeat[s] = neuralFieldOpponentForbidTypes;
							if (opponentStack.preserveRouteFirepower !== undefined) neuralFieldPreserveFirepowerBySeat[s] = opponentStack.preserveRouteFirepower;
							if (opponentStack.preserveRouteSurvival !== undefined) neuralFieldPreserveSurvivalBySeat[s] = opponentStack.preserveRouteSurvival;
							if (opponentStack.abyssRouteDiscipline !== undefined) neuralFieldAbyssDisciplineBySeat[s] = opponentStack.abyssRouteDiscipline;
							if (opponentStack.goodTargetActionDiscipline !== undefined) neuralFieldGoodTargetDisciplineBySeat[s] = opponentStack.goodTargetActionDiscipline;
							if (opponentStack.pvpPivotOracle && opponentStack.pvpPivotOracle !== 'off') neuralFieldPvpPivotOracleBySeat[s] = opponentStack.pvpPivotOracle;
						} else {
							const opponentPolicy = neuralFieldPolicies.length > 0
								? neuralFieldPolicies[(g + i) % neuralFieldPolicies.length]
								: policy;
							neuralFieldNameBySeat[s] = neuralFieldWeightPaths.length > 0
								? neuralFieldWeightPaths[(g + i) % neuralFieldWeightPaths.length]
								: 'target-policy';
							neuralFieldSeatPolicies[s] = opponentPolicy;
							if (neuralFieldOpponentMaxStatusLevel !== undefined) {
								neuralFieldMaxStatusBySeat[s] = neuralFieldOpponentMaxStatusLevel;
							}
							if (neuralFieldOpponentForbidTypes?.size) {
								neuralFieldForbidBySeat[s] = neuralFieldOpponentForbidTypes;
							}
						}
					}
					if (pvpPivotOracle !== 'off') {
						neuralFieldPvpPivotOracleBySeat[plannerSeat] = pvpPivotOracle;
					}
				}
				const r = playPlannerSelfPlayGame(catalog, {
					seed: 6_500_000 + g,
					profiles,
					policy,
					patchNavigationPolicy,
					patchNavigationPolicyGate,
					patch2NavigationPolicy,
					patch2NavigationPolicyGate,
					navigationPolicy,
					navigationPolicyGate,
					scalingNavigationPolicy,
					scalingNavigationPolicyGate,
					microPolicy,
					microPolicyGate,
					routeCloserMicroPolicy,
					routeFinishOracle,
					seatPolicies: neuralField ? neuralFieldSeatPolicies : undefined,
					seatMicroPolicies: neuralField ? neuralFieldSeatMicroPolicies : undefined,
					seatMicroPolicyGates: neuralField ? neuralFieldSeatMicroPolicyGates : undefined,
					seatNavigationPolicies: neuralField ? neuralFieldSeatNavigationPolicies : undefined,
					seatNavigationPolicyGates: neuralField ? neuralFieldSeatNavigationPolicyGates : undefined,
					seatPatchNavigationPolicies: neuralField ? neuralFieldSeatPatchNavigationPolicies : undefined,
					seatPatchNavigationPolicyGates: neuralField ? neuralFieldSeatPatchNavigationPolicyGates : undefined,
					seatPatch2NavigationPolicies: neuralField ? neuralFieldSeatPatch2NavigationPolicies : undefined,
					seatPatch2NavigationPolicyGates: neuralField ? neuralFieldSeatPatch2NavigationPolicyGates : undefined,
					seatScalingNavigationPolicies: neuralField ? neuralFieldSeatScalingNavigationPolicies : undefined,
					seatScalingNavigationPolicyGates: neuralField ? neuralFieldSeatScalingNavigationPolicyGates : undefined,
					patchNavigationSeats: neuralField && !neuralFieldSharedStack ? [plannerSeat] : undefined,
					patch2NavigationSeats: neuralField && !neuralFieldSharedStack ? [plannerSeat] : undefined,
					microPolicySeats: neuralField && !neuralFieldSharedStack ? [plannerSeat] : undefined,
					plannerSeats: neuralField ? seatList : [plannerSeat],
					recordSeats: (routeSampleAllSeats || traceAllSeats) && neuralField ? seatList : [plannerSeat],
					planner: {
						iterations,
						horizon,
						valueWeight,
						c: 1.5,
						farmValueBonus,
						farmValueThreshold,
						farmValueSource,
						farmValueMinMonsterHp,
						farmValueMaxMonsterHp,
						farmValueMaxStatusLevel
					},
					maxRounds: 30,
					sampleMoves: false,
					forceDest,
					control,
					fullSelection,
					fullLookaheadDepth,
					fullLookaheadBeam,
					fullLookaheadRootBeam,
					fullTargetTemperature,
					farmNavigationOracle,
					pvpPivotOracle: neuralField ? 'off' : pvpPivotOracle,
					pvpPivotOracleBySeat: neuralField ? neuralFieldPvpPivotOracleBySeat : undefined,
					farmNavigationThreshold,
					routeModeThreshold,
					forbidTypes,
					forbidTypesBySeat: neuralField ? neuralFieldForbidBySeat : undefined,
					maxStatusLevel,
					maxStatusLevelBySeat: neuralField ? neuralFieldMaxStatusBySeat : undefined,
					hardConstraints,
					preserveRouteFirepower,
					preserveRouteFirepowerBySeat: neuralField ? neuralFieldPreserveFirepowerBySeat : undefined,
					preserveRouteSurvival,
					preserveRouteSurvivalBySeat: neuralField ? neuralFieldPreserveSurvivalBySeat : undefined,
					abyssRouteDiscipline,
					abyssRouteDisciplineBySeat: neuralField ? neuralFieldAbyssDisciplineBySeat : undefined,
					goodTargetActionDiscipline,
					goodTargetActionDisciplineBySeat: neuralField ? neuralFieldGoodTargetDisciplineBySeat : undefined,
					tracePlannerActions: traceEnabled
				});
					const fp = r.finalState.players[plannerSeat];
					if (r.winnerSeat === plannerSeat) pWins++;
					const vp = r.finalVP[plannerSeat] ?? 0;
					const seatNames: Record<string, string> = {};
					const finalStatus: Record<string, number> = {};
					const seatStats: Record<string, {
						vp: number;
						status: number;
						kills: number;
						pvpVp: number;
						pvpAttacks: number;
						pvpTargetCombats: number;
						pvpAggressorsFaced: number;
						pvpVpConcededShare: number;
						pvpBestTargetVp: number;
						pvpPivotOracleUses: number;
						maxExpectedAttack: number;
						maxSpiritAnimal: number;
					}> = {};
					for (let i = 0; i < seatList.length; i++) {
						const s = seatList[i];
						seatNames[s] = s === plannerSeat
							? plannerRoleName
							: neuralFieldNameBySeat[s] ?? field[(g + i) % field.length];
						finalStatus[s] = r.finalState.players[s]?.statusLevel ?? 0;
						const stats = r.plannerStats[s];
						seatStats[s] = {
							vp: r.finalVP[s] ?? 0,
							status: finalStatus[s],
							kills: stats?.kills ?? 0,
							pvpVp: stats?.pvpVp ?? 0,
							pvpAttacks: stats?.pvpAttacks ?? 0,
							pvpTargetCombats: stats?.pvpTargetCombats ?? 0,
							pvpAggressorsFaced: stats?.pvpAggressorsFaced ?? 0,
							pvpVpConcededShare: +(stats?.pvpVpConcededShare ?? 0).toFixed(2),
							pvpBestTargetVp: stats?.pvpBestTargetVp ?? 0,
							pvpPivotOracleUses: stats?.pvpPivotOracleUses ?? 0,
							maxExpectedAttack: +(stats?.maxExpectedAttack ?? 0).toFixed(2),
							maxSpiritAnimal: +(stats?.maxSpiritAnimal ?? 0).toFixed(2)
						};
					}
					gameSummaries.push({
						game: g,
						plannerSeat,
						winnerSeat: r.winnerSeat,
						winnerName: r.winnerSeat ? seatNames[r.winnerSeat] ?? r.winnerSeat : 'none',
						plannerVp: vp,
						plannerStatus: fp?.statusLevel ?? 0,
						rounds: r.rounds,
						finalVP: r.finalVP,
						finalStatus,
						seatNames,
						seatStats
					});
					pVP += vp;
				if (vp >= 30) pReach30++;
				if (routeSampleDir) {
					const sampledSeats = routeSampleAllSeats && neuralField ? seatList : [plannerSeat];
					for (const sampledSeat of sampledSeats) {
						const sampledRole = seatNames[sampledSeat] ?? sampledSeat;
						if (routeSampleRoleRegex && !routeSampleRoleRegex.test(sampledRole)) continue;
						const sampledVp = r.finalVP[sampledSeat] ?? 0;
						const sampledStatus = r.finalState.players[sampledSeat]?.statusLevel ?? 0;
						if (routeSampleMaxStatusLevel !== undefined && sampledStatus > routeSampleMaxStatusLevel) continue;
						const sampledStats = r.plannerStats[sampledSeat];
						const sampledConcededShare = sampledStats?.pvpVpConcededShare ?? 0;
						const pressureOk =
							routeSampleMaxConcededShare === null || sampledConcededShare <= routeSampleMaxConcededShare;
						const withTargetPressure = (samples: Sample[], policyWeight?: number): Sample[] => {
							if (routeSamplePressurePenalty <= 0 && policyWeight === undefined) return samples;
							return samples.map((sample) => {
								const ret = routeSamplePressurePenalty > 0
									? Math.max(0, Math.min(1, sample.ret - routeSamplePressurePenalty * (sampledConcededShare / routeSamplePressureScale)))
									: sample.ret;
								return {
									...sample,
									ret,
									...(policyWeight !== undefined ? { policyWeight } : {})
								};
							});
						};
						const rawRouteSamples = r.samples.filter((sample) => (
							sample.seat === sampledSeat &&
							sample.vp >= routeSampleMinDecisionVp &&
							sample.vp <= routeSampleMaxDecisionVp
						));
						const routeSamples = withTargetPressure(rawRouteSamples);
						const rawLowTailSamples = r.samples.filter((sample) => (
							sample.seat === sampledSeat &&
							sample.vp >= routeSampleLowMinDecisionVp &&
							sample.vp <= routeSampleLowMaxDecisionVp
						));
						const lowTailSamplesForScore = routeSampleLowMaxVp !== null && sampledVp <= routeSampleLowMaxVp
							? withTargetPressure(rawLowTailSamples, routeSampleLowPolicyWeight)
							: [];
						const pressureFailSamplesForGame =
							!pressureOk && routeSamplePressureFailLowTail && (
								routeSampleLowMaxVp === null || sampledVp > routeSampleLowMaxVp
							)
								? withTargetPressure(rawRouteSamples.length > 0 ? rawRouteSamples : rawLowTailSamples, routeSampleLowPolicyWeight)
								: [];
						if (!pressureOk) {
							routePressureFailGames++;
							routePressureFailSamples += pressureFailSamplesForGame.length;
						}
						const routeLowTailSamplesForGame = [
							...lowTailSamplesForScore,
							...pressureFailSamplesForGame
						];
						if (pressureOk && sampledVp >= routeSampleSuccessVp) {
							routeSuccessGames++;
							routeSuccessSamples += routeSamples.length;
							appendSamples(`${routeSampleDir}/success/samples.jsonl`, routeSamples, g);
							appendSamples(`${routeSampleDir}/contrast/samples.jsonl`, routeSamples, g);
						} else if (pressureOk && sampledVp >= routeSampleNearMinVp && sampledVp < routeSampleSuccessVp) {
							routeNearMissGames++;
							routeNearMissSamples += routeSamples.length;
							appendSamples(`${routeSampleDir}/near_miss/samples.jsonl`, routeSamples, g);
							appendSamples(`${routeSampleDir}/contrast/samples.jsonl`, routeSamples, g);
						}
						if (routeLowTailSamplesForGame.length > 0) {
							routeLowTailGames++;
							routeLowTailSamples += routeLowTailSamplesForGame.length;
							appendSamples(`${routeSampleDir}/low_tail/samples.jsonl`, routeLowTailSamplesForGame, g);
						}
					}
				}
				if (traceEnabled && vp >= traceMinVp && vp <= traceMaxVp) {
					const tracedSeats = traceAllSeats && neuralField ? seatList : [plannerSeat];
						tracedGames.push({
							game: g,
							plannerSeat,
							tracedSeats,
							seatNames,
							vp,
							status: fp?.statusLevel ?? 0,
							rounds: r.rounds,
						winnerSeat: r.winnerSeat,
						finalVP: r.finalVP,
						plannerStats: r.plannerStats[plannerSeat],
						plannerStatsBySeat: traceAllSeats && neuralField ? r.plannerStats : undefined,
						trace: r.plannerTrace.filter((event) => tracedSeats.includes(event.seat))
					});
				}
				pStatus += fp?.statusLevel ?? 0;
				pRounds += r.rounds;
				const ps = r.plannerStats[plannerSeat];
				if (ps) {
					pKills += ps.kills;
					pAbyss += ps.abyss;
					pNavigationPriorUses += ps.navigationPriorUses;
					pFarmPriorApplications += ps.farmPriorApplications;
					pFarmPriorAbyssChoices += ps.farmPriorAbyssChoices;
					pFarmPriorScoreSum += ps.farmPriorScoreSum;
					pFarmPriorBonusSum += ps.farmPriorBonusSum;
					pFarmPriorMaxScore = Math.max(pFarmPriorMaxScore, ps.farmPriorMaxScore);
					pPvpAttacks += ps.pvpAttacks;
					pPvpVp += ps.pvpVp;
					pPvpTargetCombats += ps.pvpTargetCombats;
					pPvpAggressorsFaced += ps.pvpAggressorsFaced;
					pPvpVpConcededShare += ps.pvpVpConcededShare;
					pPvpOpportunities += ps.pvpOpportunities;
					pMissedPvpOpportunities += ps.missedPvpOpportunities;
					pPvpTargetVp += ps.pvpTargetVp;
					pPvpBestTargetVp = Math.max(pPvpBestTargetVp, ps.pvpBestTargetVp);
					pPvpHighValueOpportunities += ps.pvpHighValueOpportunities;
					pPvpHardMonsterOpportunities += ps.pvpHardMonsterOpportunities;
					pMissedPvpHardMonsterOpportunities += ps.missedPvpHardMonsterOpportunities;
					pPvpHardMonsterAttacks += ps.pvpHardMonsterAttacks;
					pPvpHardMonsterVp += ps.pvpHardMonsterVp;
					pPvpHardMonsterTargetVp += ps.pvpHardMonsterTargetVp;
					pPvpHardMonsterBestTargetVp = Math.max(pPvpHardMonsterBestTargetVp, ps.pvpHardMonsterBestTargetVp);
					pPvpGoodTargetPivotOpportunities += ps.pvpGoodTargetPivotOpportunities;
					pMissedPvpGoodTargetPivotOpportunities += ps.missedPvpGoodTargetPivotOpportunities;
					pPvpGoodTargetPivotAttacks += ps.pvpGoodTargetPivotAttacks;
					pPvpGoodTargetPivotVp += ps.pvpGoodTargetPivotVp;
					pPvpGoodTargetPivotTargetVp += ps.pvpGoodTargetPivotTargetVp;
					pPvpGoodTargetPivotBestTargetVp = Math.max(pPvpGoodTargetPivotBestTargetVp, ps.pvpGoodTargetPivotBestTargetVp);
					pPvpPivotOracleUses += ps.pvpPivotOracleUses;
					for (const [destination, count] of Object.entries(ps.navigationDestinations)) {
						navigationDestinations[destination] = (navigationDestinations[destination] ?? 0) + count;
					}
					for (const [interaction, count] of Object.entries(ps.locationInteractions)) {
						locationInteractions[interaction] = (locationInteractions[interaction] ?? 0) + count;
					}
					pCombat += ps.combat;
					pCombatOpps += ps.combatOpportunities;
					pCleanCombatOpps += ps.cleanCombatOpportunities;
					pFirepowerCombatOpps += ps.firepowerCombatOpportunities;
					pCorruptOnlyCombatOpps += ps.corruptOnlyCombatOpportunities;
					pMissedCleanCombatOpps += ps.missedCleanCombatOpportunities;
					pMissedFirepowerCombatOpps += ps.missedFirepowerCombatOpportunities;
					pMaxExpectedAttack += ps.maxExpectedAttack;
					pMaxBarrier += ps.maxBarrier;
					pMaxCurrentBarrier += ps.maxCurrentBarrier;
					pMaxAttackDice += ps.maxAttackDice;
					pMaxSpiritAnimal += ps.maxSpiritAnimal;
					pMaxCultivator += ps.maxCultivator;
					pMaxHealer += ps.maxHealer;
					pMaxCleanKillProb = Math.max(pMaxCleanKillProb, ps.maxCleanKillProb);
					pMaxFirepowerKillProb = Math.max(pMaxFirepowerKillProb, ps.maxFirepowerKillProb);
					pMaxStatus = Math.max(pMaxStatus, ps.maxStatusLevel);
					pStatusCapViolations += ps.statusCapViolations;
					pStatusCapViolationEvents += ps.statusCapViolationEvents;
					pOwnStatusCapViolationEvents += ps.ownStatusCapViolationEvents;
					pExternalStatusCapViolationEvents += ps.externalStatusCapViolationEvents;
					pDeadlineStatusCapViolationEvents += ps.deadlineStatusCapViolationEvents;
					for (const [source, count] of Object.entries(ps.statusCapViolationSources)) {
						statusCapViolationSources[source] = (statusCapViolationSources[source] ?? 0) + count;
					}
					pFarmableNavs += ps.farmableNavs;
					pMissedFarmableNavs += ps.missedFarmableNavs;
					pBossFarmableNavs += ps.bossFarmableNavs;
					pMissedBossFarmableNavs += ps.missedBossFarmableNavs;
					pFarmOpportunityVp += ps.farmOpportunityVp;
					pMissedFarmOpportunityVp += ps.missedFarmOpportunityVp;
					pMaxFarmOpportunityVp = Math.max(pMaxFarmOpportunityVp, ps.maxFarmOpportunityVp);
				}
				for (const [type, count] of Object.entries(r.decisionTypes)) {
					decisionTypes[type] = (decisionTypes[type] ?? 0) + count;
				}
				if (progressEvery > 0 && ((g + 1) % progressEvery === 0 || g + 1 === games)) {
					/* eslint-disable-next-line no-console */
					console.log(
						`[azeval] progress ${g + 1}/${games} ` +
						`seat=${plannerSeat} vp=${vp} status=${fp?.statusLevel ?? 0} rounds=${r.rounds} ` +
						`elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`
					);
				}
				// field stats
				let bestVP = 0;
				for (const s of seatList) {
					if (s === plannerSeat) continue;
					const vp = r.finalVP[s] ?? 0;
					if (vp > bestVP) bestVP = vp;
				}
				fieldBestVP += bestVP;
				if (r.winnerSeat && r.winnerSeat !== plannerSeat) {
					const idx = seatList.indexOf(r.winnerSeat);
					const nm = neuralFieldNameBySeat[r.winnerSeat] ?? field[(g + idx) % field.length];
					fieldWinsByName[nm] = (fieldWinsByName[nm] ?? 0) + 1;
				}
				}

				const roleBuckets: Record<string, {
					seats: number;
					wins: number;
					vp: number;
					status: number;
					kills: number;
					pvpVp: number;
					pvpAttacks: number;
					pvpTargetCombats: number;
					pvpAggressorsFaced: number;
					pvpVpConcededShare: number;
					maxExpectedAttack: number;
					maxSpiritAnimal: number;
					pvpPivotOracleUses: number;
				}> = {};
				for (const game of gameSummaries) {
					for (const [seat, stats] of Object.entries(game.seatStats)) {
						const role = game.seatNames[seat] ?? seat;
						const bucket = roleBuckets[role] ?? {
							seats: 0,
							wins: 0,
							vp: 0,
							status: 0,
							kills: 0,
							pvpVp: 0,
							pvpAttacks: 0,
							pvpTargetCombats: 0,
							pvpAggressorsFaced: 0,
							pvpVpConcededShare: 0,
							maxExpectedAttack: 0,
							maxSpiritAnimal: 0,
							pvpPivotOracleUses: 0
						};
						bucket.seats++;
						if (game.winnerSeat === seat) bucket.wins++;
						bucket.vp += stats.vp;
						bucket.status += stats.status;
						bucket.kills += stats.kills;
						bucket.pvpVp += stats.pvpVp;
						bucket.pvpAttacks += stats.pvpAttacks;
						bucket.pvpTargetCombats += stats.pvpTargetCombats;
						bucket.pvpAggressorsFaced += stats.pvpAggressorsFaced;
						bucket.pvpVpConcededShare += stats.pvpVpConcededShare;
						bucket.maxExpectedAttack += stats.maxExpectedAttack;
						bucket.maxSpiritAnimal += stats.maxSpiritAnimal;
						bucket.pvpPivotOracleUses += stats.pvpPivotOracleUses;
						roleBuckets[role] = bucket;
					}
				}
				const roleStats = Object.fromEntries(
					Object.entries(roleBuckets)
						.sort((a, b) => (b[1].vp / Math.max(1, b[1].seats)) - (a[1].vp / Math.max(1, a[1].seats)))
						.map(([role, bucket]) => [role, {
							seats: bucket.seats,
							win_pct: +((100 * bucket.wins) / Math.max(1, bucket.seats)).toFixed(1),
							VP_avg: +(bucket.vp / Math.max(1, bucket.seats)).toFixed(2),
							status_avg: +(bucket.status / Math.max(1, bucket.seats)).toFixed(2),
							kills_per_seat: +(bucket.kills / Math.max(1, bucket.seats)).toFixed(2),
							pvp_vp_per_seat: +(bucket.pvpVp / Math.max(1, bucket.seats)).toFixed(2),
							pvp_attacks_per_seat: +(bucket.pvpAttacks / Math.max(1, bucket.seats)).toFixed(2),
							pvp_target_combats_per_seat: +(bucket.pvpTargetCombats / Math.max(1, bucket.seats)).toFixed(2),
							pvp_aggressors_faced_per_seat: +(bucket.pvpAggressorsFaced / Math.max(1, bucket.seats)).toFixed(2),
							pvp_vp_conceded_share_per_seat: +(bucket.pvpVpConcededShare / Math.max(1, bucket.seats)).toFixed(2),
							max_expected_attack_avg: +(bucket.maxExpectedAttack / Math.max(1, bucket.seats)).toFixed(2),
							max_spirit_animal_avg: +(bucket.maxSpiritAnimal / Math.max(1, bucket.seats)).toFixed(2),
							pvp_pivot_oracle_uses_per_seat: +(bucket.pvpPivotOracleUses / Math.max(1, bucket.seats)).toFixed(2)
						}])
				);

				const row = {
				games,
				iterations,
				horizon,
				valueWeight,
				control,
				fullSelection,
				fullLookaheadDepth,
				fullLookaheadBeam,
				fullLookaheadRootBeam,
				fullTargetTemperature,
				farmNavigationOracle,
					pvpPivotOracle,
					plannerRoleName,
					farmNavigationThreshold,
				routeModeThreshold,
				farmValueBonus,
				farmValueThreshold,
				farmValueSource,
				farmValueMinMonsterHp,
				farmValueMaxMonsterHp,
				farmValueMaxStatusLevel,
					weights: process.env.AZEVAL_WEIGHTS ?? mlPath('weights', 'policy.json'),
					patchNavWeights,
					patchNavigationPolicyGate,
					patch2NavWeights,
					patch2NavigationPolicyGate,
					navWeights,
				navigationPolicyGate,
				scaleNavWeights,
				scalingNavigationPolicyGate,
				microWeights,
				microPolicyGate,
				routeCloserMicroWeights,
				routeFinishOracle,
				forbidTypes: [...(forbidTypes ?? [])],
				maxStatusLevel,
				hardConstraints,
				neuralField,
				neuralFieldSharedStack,
				traceAllSeats,
				neuralFieldWeights: neuralFieldWeightPaths,
				neuralFieldStacks: neuralFieldStacks.map((stack) => ({
					name: stack.name,
					weights: stack.weights,
					microWeights: stack.microWeights,
					microPolicyGate: stack.microPolicyGate,
					navWeights: stack.navWeights,
					navigationPolicyGate: stack.navigationPolicyGate,
					patchNavWeights: stack.patchNavWeights,
					patchNavigationPolicyGate: stack.patchNavigationPolicyGate,
					patch2NavWeights: stack.patch2NavWeights,
					patch2NavigationPolicyGate: stack.patch2NavigationPolicyGate,
					scaleNavWeights: stack.scaleNavWeights,
					scalingNavigationPolicyGate: stack.scalingNavigationPolicyGate,
					maxStatusLevel: stack.maxStatusLevel,
					forbidTypes: [...(stack.forbidTypes ?? [])],
						preserveRouteFirepower: stack.preserveRouteFirepower,
						preserveRouteSurvival: stack.preserveRouteSurvival,
						abyssRouteDiscipline: stack.abyssRouteDiscipline,
						goodTargetActionDiscipline: stack.goodTargetActionDiscipline,
						pvpPivotOracle: stack.pvpPivotOracle
					})),
					gameSummaries,
					roleStats,
					neuralFieldOpponentMaxStatusLevel,
				neuralFieldOpponentForbidTypes: [...(neuralFieldOpponentForbidTypes ?? [])],
				preserveRouteFirepower,
				preserveRouteSurvival,
				abyssRouteDiscipline,
				goodTargetActionDiscipline,
				planner_win_pct: +((100 * pWins) / games).toFixed(1),
				planner_VP_avg: +(pVP / games).toFixed(2),
				planner_status_avg: +(pStatus / games).toFixed(2),
				planner_max_status: pMaxStatus,
				planner_status_cap_violations: pStatusCapViolations,
				planner_status_cap_violation_events: pStatusCapViolationEvents,
				planner_own_status_cap_violation_events: pOwnStatusCapViolationEvents,
				planner_external_status_cap_violation_events: pExternalStatusCapViolationEvents,
				planner_deadline_status_cap_violation_events: pDeadlineStatusCapViolationEvents,
				planner_status_cap_violation_sources: topN(statusCapViolationSources, 20),
				planner_rounds_avg: +(pRounds / games).toFixed(1),
				planner_reach30_pct: +((100 * pReach30) / games).toFixed(1),
				planner_monster_kills_per_game: +(pKills / games).toFixed(2),
				planner_monster_combats_per_game: +(pCombat / games).toFixed(2),
				planner_pvp_attacks_per_game: +(pPvpAttacks / games).toFixed(2),
				planner_pvp_vp_per_game: +(pPvpVp / games).toFixed(2),
				planner_pvp_target_combats_per_game: +(pPvpTargetCombats / games).toFixed(2),
				planner_pvp_aggressors_faced_per_game: +(pPvpAggressorsFaced / games).toFixed(2),
				planner_pvp_vp_conceded_share_per_game: +(pPvpVpConcededShare / games).toFixed(2),
				planner_pvp_opportunities_per_game: +(pPvpOpportunities / games).toFixed(2),
				planner_missed_pvp_opportunities_per_game: +(pMissedPvpOpportunities / games).toFixed(2),
				planner_missed_pvp_opportunity_pct: +((100 * pMissedPvpOpportunities) / Math.max(1, pPvpOpportunities)).toFixed(1),
				planner_pvp_target_vp_per_game: +(pPvpTargetVp / games).toFixed(2),
				planner_pvp_best_target_vp: +pPvpBestTargetVp.toFixed(2),
				planner_pvp_high_value_opportunities_per_game: +(pPvpHighValueOpportunities / games).toFixed(2),
				planner_pvp_hard_monster_opportunities_per_game: +(pPvpHardMonsterOpportunities / games).toFixed(2),
				planner_missed_pvp_hard_monster_opportunities_per_game: +(pMissedPvpHardMonsterOpportunities / games).toFixed(2),
				planner_missed_pvp_hard_monster_opportunity_pct: +((100 * pMissedPvpHardMonsterOpportunities) / Math.max(1, pPvpHardMonsterOpportunities)).toFixed(1),
				planner_pvp_hard_monster_attacks_per_game: +(pPvpHardMonsterAttacks / games).toFixed(2),
				planner_pvp_hard_monster_vp_per_game: +(pPvpHardMonsterVp / games).toFixed(2),
				planner_pvp_hard_monster_target_vp_per_game: +(pPvpHardMonsterTargetVp / games).toFixed(2),
				planner_pvp_hard_monster_best_target_vp: +pPvpHardMonsterBestTargetVp.toFixed(2),
				planner_pvp_good_target_pivot_opportunities_per_game: +(pPvpGoodTargetPivotOpportunities / games).toFixed(2),
				planner_missed_pvp_good_target_pivot_opportunities_per_game: +(pMissedPvpGoodTargetPivotOpportunities / games).toFixed(2),
				planner_missed_pvp_good_target_pivot_opportunity_pct: +((100 * pMissedPvpGoodTargetPivotOpportunities) / Math.max(1, pPvpGoodTargetPivotOpportunities)).toFixed(1),
				planner_pvp_good_target_pivot_attacks_per_game: +(pPvpGoodTargetPivotAttacks / games).toFixed(2),
				planner_pvp_good_target_pivot_vp_per_game: +(pPvpGoodTargetPivotVp / games).toFixed(2),
				planner_pvp_good_target_pivot_target_vp_per_game: +(pPvpGoodTargetPivotTargetVp / games).toFixed(2),
				planner_pvp_good_target_pivot_best_target_vp: +pPvpGoodTargetPivotBestTargetVp.toFixed(2),
				planner_pvp_pivot_oracle_uses_per_game: +(pPvpPivotOracleUses / games).toFixed(2),
				planner_abyss_navs_per_game: +(pAbyss / games).toFixed(2),
				planner_navigation_prior_uses_per_game: +(pNavigationPriorUses / games).toFixed(2),
				planner_farm_prior_applications_per_game: +(pFarmPriorApplications / games).toFixed(2),
				planner_farm_prior_abyss_choices_per_game: +(pFarmPriorAbyssChoices / games).toFixed(2),
				planner_farm_prior_abyss_choice_pct: +((100 * pFarmPriorAbyssChoices) / Math.max(1, pFarmPriorApplications)).toFixed(1),
				planner_farm_prior_avg_score: +(pFarmPriorScoreSum / Math.max(1, pFarmPriorApplications)).toFixed(3),
				planner_farm_prior_avg_bonus: +(pFarmPriorBonusSum / Math.max(1, pFarmPriorApplications)).toFixed(3),
				planner_farm_prior_max_score: +pFarmPriorMaxScore.toFixed(3),
				planner_navigation_destinations_per_game: topNPerGame(navigationDestinations, games, 12),
				planner_location_interactions_per_game: topNPerGame(locationInteractions, games, 24),
				planner_combat_opportunities_per_game: +(pCombatOpps / games).toFixed(2),
				planner_clean_combat_opportunities_per_game: +(pCleanCombatOpps / games).toFixed(2),
				planner_firepower_combat_opportunities_per_game: +(pFirepowerCombatOpps / games).toFixed(2),
				planner_corrupt_only_combat_opportunities_per_game: +(pCorruptOnlyCombatOpps / games).toFixed(2),
				planner_missed_clean_combat_opportunities_per_game: +(pMissedCleanCombatOpps / games).toFixed(2),
				planner_missed_clean_combat_opportunity_pct: +((100 * pMissedCleanCombatOpps) / Math.max(1, pCleanCombatOpps)).toFixed(1),
				planner_missed_firepower_combat_opportunities_per_game: +(pMissedFirepowerCombatOpps / games).toFixed(2),
				planner_missed_firepower_combat_opportunity_pct: +((100 * pMissedFirepowerCombatOpps) / Math.max(1, pFirepowerCombatOpps)).toFixed(1),
				planner_max_clean_kill_prob: +pMaxCleanKillProb.toFixed(3),
				planner_max_firepower_kill_prob: +pMaxFirepowerKillProb.toFixed(3),
				planner_max_expected_attack_avg: +(pMaxExpectedAttack / games).toFixed(2),
				planner_max_barrier_avg: +(pMaxBarrier / games).toFixed(2),
				planner_max_current_barrier_avg: +(pMaxCurrentBarrier / games).toFixed(2),
				planner_max_attack_dice_avg: +(pMaxAttackDice / games).toFixed(2),
				planner_max_spirit_animal_avg: +(pMaxSpiritAnimal / games).toFixed(2),
				planner_max_cultivator_avg: +(pMaxCultivator / games).toFixed(2),
				planner_max_healer_avg: +(pMaxHealer / games).toFixed(2),
				planner_farmable_navs_per_game: +(pFarmableNavs / games).toFixed(2),
				planner_missed_farmable_navs_per_game: +(pMissedFarmableNavs / games).toFixed(2),
				planner_missed_farmable_nav_pct: +((100 * pMissedFarmableNavs) / Math.max(1, pFarmableNavs)).toFixed(1),
				planner_farm_opportunity_vp_per_game: +(pFarmOpportunityVp / games).toFixed(2),
				planner_missed_farm_opportunity_vp_per_game: +(pMissedFarmOpportunityVp / games).toFixed(2),
				planner_missed_farm_opportunity_vp_pct: +((100 * pMissedFarmOpportunityVp) / Math.max(1e-9, pFarmOpportunityVp)).toFixed(1),
				planner_max_farm_opportunity_vp: +pMaxFarmOpportunityVp.toFixed(2),
				planner_boss_farmable_navs_per_game: +(pBossFarmableNavs / games).toFixed(2),
				planner_missed_boss_farmable_navs_per_game: +(pMissedBossFarmableNavs / games).toFixed(2),
				planner_missed_boss_farmable_nav_pct: +((100 * pMissedBossFarmableNavs) / Math.max(1, pBossFarmableNavs)).toFixed(1),
				field_bestVP_avg: +(fieldBestVP / games).toFixed(2),
				field_wins_by_profile: fieldWinsByName,
				decision_types: topN(decisionTypes, 20),
				elapsed_ms: Date.now() - startedAt,
				field,
				route_sample_dir: routeSampleDir,
				route_sample_all_seats: routeSampleAllSeats,
				route_sample_max_status_level: routeSampleMaxStatusLevel,
				route_sample_min_decision_vp: routeSampleMinDecisionVp,
				route_sample_max_decision_vp: Number.isFinite(routeSampleMaxDecisionVp) ? routeSampleMaxDecisionVp : null,
				route_sample_success_vp: routeSampleSuccessVp,
				route_sample_near_min_vp: routeSampleNearMinVp,
				route_sample_low_max_vp: routeSampleLowMaxVp,
				route_sample_low_min_decision_vp: routeSampleLowMinDecisionVp,
				route_sample_low_max_decision_vp: Number.isFinite(routeSampleLowMaxDecisionVp) ? routeSampleLowMaxDecisionVp : null,
				route_sample_low_policy_weight: routeSampleLowPolicyWeight,
				route_sample_role_regex: routeSampleRoleRegexRaw || null,
				route_sample_max_conceded_share: routeSampleMaxConcededShare,
				route_sample_pressure_penalty: routeSamplePressurePenalty,
				route_sample_pressure_scale: routeSamplePressureScale,
				route_sample_pressure_fail_low_tail: routeSamplePressureFailLowTail,
				route_success_games: routeSuccessGames,
				route_near_miss_games: routeNearMissGames,
				route_low_tail_games: routeLowTailGames,
				route_pressure_fail_games: routePressureFailGames,
				route_success_samples: routeSuccessSamples,
				route_near_miss_samples: routeNearMissSamples,
				route_low_tail_samples: routeLowTailSamples,
				route_pressure_fail_samples: routePressureFailSamples,
				route_contrast_samples: routeSuccessSamples + routeNearMissSamples
			};
			/* eslint-disable no-console */
			console.log(`\n[azeval] planner vs [${field.join(',')}], ${games} games, ${iterations} iters, horizon=${horizon}, valueW=${valueWeight}${neuralField ? ' neuralField=1' : ''}`);
			console.log(`[azeval] PLANNER win%=${row.planner_win_pct} VP=${row.planner_VP_avg} status=${row.planner_status_avg} maxStatus=${row.planner_max_status} capViol=${row.planner_status_cap_violations} (0=Pure,3=Fallen) rounds=${row.planner_rounds_avg}`);
			console.log(`[azeval] STATUS-CAP events=${row.planner_status_cap_violation_events} own=${row.planner_own_status_cap_violation_events} external=${row.planner_external_status_cap_violation_events} deadline=${row.planner_deadline_status_cap_violation_events}`);
			console.log(`[azeval] FARMING kills/g=${(pKills / games).toFixed(2)} combats/g=${(pCombat / games).toFixed(2)} abyssNavs/g=${(pAbyss / games).toFixed(2)} reach30%=${((100 * pReach30) / games).toFixed(0)}`);
			console.log(`[azeval] PVP attacks/g=${row.planner_pvp_attacks_per_game} vp/g=${row.planner_pvp_vp_per_game} legal/g=${row.planner_pvp_opportunities_per_game} missed=${row.planner_missed_pvp_opportunity_pct}% targetVP/g=${row.planner_pvp_target_vp_per_game} bestTarget=${row.planner_pvp_best_target_vp} highValue/g=${row.planner_pvp_high_value_opportunities_per_game} pivotOracle/g=${row.planner_pvp_pivot_oracle_uses_per_game}`);
			console.log(`[azeval] PVP-HP4+ attacks/g=${row.planner_pvp_hard_monster_attacks_per_game} vp/g=${row.planner_pvp_hard_monster_vp_per_game} legal/g=${row.planner_pvp_hard_monster_opportunities_per_game} missed=${row.planner_missed_pvp_hard_monster_opportunity_pct}% targetVP/g=${row.planner_pvp_hard_monster_target_vp_per_game} bestTarget=${row.planner_pvp_hard_monster_best_target_vp}`);
			console.log(`[azeval] PVP-GOOD-PIVOT attacks/g=${row.planner_pvp_good_target_pivot_attacks_per_game} vp/g=${row.planner_pvp_good_target_pivot_vp_per_game} legal/g=${row.planner_pvp_good_target_pivot_opportunities_per_game} missed=${row.planner_missed_pvp_good_target_pivot_opportunity_pct}% targetVP/g=${row.planner_pvp_good_target_pivot_target_vp_per_game} bestTarget=${row.planner_pvp_good_target_pivot_best_target_vp}`);
			console.log(`[azeval] COMBAT-OPP legal/g=${row.planner_combat_opportunities_per_game} clean/g=${row.planner_clean_combat_opportunities_per_game} firepower/g=${row.planner_firepower_combat_opportunities_per_game} corruptOnly/g=${row.planner_corrupt_only_combat_opportunities_per_game} missedClean=${row.planner_missed_clean_combat_opportunity_pct}%`);
			console.log(`[azeval] BUILD maxAttack=${row.planner_max_expected_attack_avg} maxBarrier=${row.planner_max_barrier_avg} maxDice=${row.planner_max_attack_dice_avg} spiritAnimal=${row.planner_max_spirit_animal_avg} cultivator=${row.planner_max_cultivator_avg}`);
			console.log(`[azeval] CLEAN-FARM navs/g=${row.planner_farmable_navs_per_game} missed=${row.planner_missed_farmable_nav_pct}% oracle=${farmNavigationOracle}`);
			console.log(`[azeval] FARM-PRIOR apps/g=${row.planner_farm_prior_applications_per_game} abyssChoices/g=${row.planner_farm_prior_abyss_choices_per_game} abyssChoicePct=${row.planner_farm_prior_abyss_choice_pct}% avgScore=${row.planner_farm_prior_avg_score} avgBonus=${row.planner_farm_prior_avg_bonus} maxScore=${row.planner_farm_prior_max_score}`);
			console.log(`[azeval] NAV-DEST ${JSON.stringify(row.planner_navigation_destinations_per_game)}`);
			console.log(`[azeval] LOC-ROWS ${JSON.stringify(row.planner_location_interactions_per_game)}`);
			console.log(`[azeval] FIELD best-opponent VP=${row.field_bestVP_avg}  field wins: ${JSON.stringify(fieldWinsByName)}`);
			const cleanRoutePass =
				row.planner_win_pct >= 50 &&
				row.planner_status_avg < 1.5 &&
				(maxStatusLevel === undefined || (row.planner_max_status <= maxStatusLevel && row.planner_status_cap_violations === 0)) &&
				row.planner_VP_avg >= 10 &&
				row.planner_monster_kills_per_game >= 3;
			console.log(`[azeval] VERDICT: ${cleanRoutePass ? 'PASS - meaningful economy/monster route' : 'not yet'}`);
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, JSON.stringify(row, null, 2));
			if (traceEnabled) {
				const tracePayload = {
					out,
					traceMinVp,
					traceMaxVp: Number.isFinite(traceMaxVp) ? traceMaxVp : null,
					games: tracedGames.length,
					tracedGames
				};
				const target = traceOut ?? out.replace(/\.json$/, '.trace.json');
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, JSON.stringify(tracePayload, null, 2));
				console.log(`[azeval] TRACE -> ${target} games=${tracedGames.length} minVp=${traceMinVp} maxVp=${Number.isFinite(traceMaxVp) ? traceMaxVp : 'inf'}`);
			}
			if (routeSampleDir) {
				const writeRouteSampleMeta = (
					subdir: 'success' | 'near_miss' | 'contrast' | 'low_tail',
					samples: number,
					gameCount: number
				): void => {
					const dir = `${routeSampleDir}/${subdir}`;
					mkdirSync(dir, { recursive: true });
					writeFileSync(`${dir}/meta.json`, JSON.stringify({
						obs_dim: OBS_DIM,
						act_dim: ACT_DIM,
						samples,
						games: gameCount,
						mode: `azeval-route-${subdir}`,
						parent: routeSampleDir,
						min_decision_vp: routeSampleMinDecisionVp,
						max_decision_vp: Number.isFinite(routeSampleMaxDecisionVp) ? routeSampleMaxDecisionVp : null,
						success_vp: routeSampleSuccessVp,
						near_min_vp: routeSampleNearMinVp,
						low_max_vp: routeSampleLowMaxVp,
						low_min_decision_vp: routeSampleLowMinDecisionVp,
						low_max_decision_vp: Number.isFinite(routeSampleLowMaxDecisionVp) ? routeSampleLowMaxDecisionVp : null,
						policy_weight: subdir === 'low_tail' ? routeSampleLowPolicyWeight : 1,
						role_regex: routeSampleRoleRegexRaw || null,
						max_conceded_share: routeSampleMaxConcededShare,
						pressure_penalty: routeSamplePressurePenalty,
						pressure_scale: routeSamplePressureScale,
						pressure_fail_low_tail: routeSamplePressureFailLowTail,
						out
					}, null, 2));
				};
				mkdirSync(routeSampleDir, { recursive: true });
				writeFileSync(`${routeSampleDir}/meta.json`, JSON.stringify({
					obs_dim: OBS_DIM,
					act_dim: ACT_DIM,
					mode: 'azeval-route-success-contrast',
					games,
					success_games: routeSuccessGames,
					near_miss_games: routeNearMissGames,
					low_tail_games: routeLowTailGames,
					success_samples: routeSuccessSamples,
					near_miss_samples: routeNearMissSamples,
					low_tail_samples: routeLowTailSamples,
					contrast_samples: routeSuccessSamples + routeNearMissSamples,
					min_decision_vp: routeSampleMinDecisionVp,
					max_decision_vp: Number.isFinite(routeSampleMaxDecisionVp) ? routeSampleMaxDecisionVp : null,
					success_vp: routeSampleSuccessVp,
					near_min_vp: routeSampleNearMinVp,
					low_max_vp: routeSampleLowMaxVp,
					low_min_decision_vp: routeSampleLowMinDecisionVp,
					low_max_decision_vp: Number.isFinite(routeSampleLowMaxDecisionVp) ? routeSampleLowMaxDecisionVp : null,
					low_policy_weight: routeSampleLowPolicyWeight,
					role_regex: routeSampleRoleRegexRaw || null,
					max_conceded_share: routeSampleMaxConcededShare,
					pressure_penalty: routeSamplePressurePenalty,
					pressure_scale: routeSamplePressureScale,
					pressure_fail_low_tail: routeSamplePressureFailLowTail,
					pressure_fail_games: routePressureFailGames,
					pressure_fail_samples: routePressureFailSamples,
					out
				}, null, 2));
				writeRouteSampleMeta('success', routeSuccessSamples, routeSuccessGames);
				writeRouteSampleMeta('near_miss', routeNearMissSamples, routeNearMissGames);
				writeRouteSampleMeta('contrast', routeSuccessSamples + routeNearMissSamples, routeSuccessGames + routeNearMissGames);
				writeRouteSampleMeta('low_tail', routeLowTailSamples, routeLowTailGames);
				console.log(`[azeval] ROUTE-SAMPLES success=${routeSuccessSamples} near=${routeNearMissSamples} low=${routeLowTailSamples} pressureFail=${routePressureFailSamples} -> ${routeSampleDir}`);
			}
			console.log(`[azeval] DONE -> ${out}`);
			/* eslint-enable no-console */
		},
		2 * 60 * 60 * 1000
	);
});
