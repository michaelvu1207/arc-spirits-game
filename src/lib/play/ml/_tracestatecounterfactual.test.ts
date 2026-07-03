/**
 * Trace-state counterfactual prover.
 *
 * This is narrower than the generic HP4 collectors. It captures exact navigation
 * states reached by the current clean-route stack, then replays deliberate
 * scripted continuations from those same states:
 *
 * - policy: current stack continuation
 * - abyss-probe: force immediate Abyss re-entry when legal
 * - restore-loop: restore current barrier before re-entry
 * - max-barrier-loop: build max barrier/Cultivator before re-entry
 * - damage-assembly: build attack/firepower before re-entry
 * - hp4-survival-oracle: sequence damage, max barrier/Cultivator, restore, then re-enter
 * - finish-line-oracle: from VP 24-29, finish/restore/build only if the current monster lives can reach 30 VP
 * - fixed-reentry: build for N navigation decisions, then re-enter Abyss
 * - expose-* scripts: force a non-Abyss destination to test Good-target exposure labels
 *
 * Opt in:
 *
 *   TRACEQ=1 npx vitest run src/lib/play/ml/_tracestatecounterfactual.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { applyDeadlineAdvance, applyGameCommand } from '../runtime';
import { createRng, nextInt } from '../rng';
import { expectedAttack } from '../combat';
import { awakenedClassCounts } from '../effects/apply';
import {
	botActorFor,
	botSeatNeedsToAct,
	computeKillProbability,
	firepowerKillProbability,
	planBotPhaseActions,
	profileFor,
	type BotProfile,
	type BotRandom
} from '../server/botPolicy';
import {
	SEAT_COLORS,
	VP_TO_WIN,
	type GameCommand,
	type NavigationDestination,
	type PlayCatalog,
	type PublicGameState,
	type SeatColor
} from '../types';
import { commandMatches, legalActionsWithNext, type LegalAction } from './actions';
import { sampleAuxTargets } from './auxTargets';
import type { Sample } from './driver';
import { encodeAction, encodeObs } from './encode';
import { evaluateFarmValue } from './farmValue';
import { buildLocationInteractions, type GainEffect, type LocationInteraction } from '../locationInteractions';
import type { NeuralPolicy } from './net';
import { appendSamples, loadOrSnapshotCatalog, loadPolicyForEval, mlPath } from './nodeIo';
import { neuralPlanNavigation } from './planner';
import {
	chooseRouteBreakpointOracleAction,
	chooseRouteFinishLoopOracleAction,
	routeBreakpointActionScore
} from './routeBreakpointOracle';
import {
	chooseFullActionDecision,
	filterPlannerActions,
	playPlannerSelfPlayGame,
	type FullActionSelection,
	type MicroPolicyGate,
	type NavigationPolicyGate,
	type NavigationProbeContext
} from './selfplay';

const RUN = process.env.TRACEQ === '1';
const MAX_TICKS = 80_000;
const MAX_ACTIONS_PER_PHASE = 30;
const FULL_SELECTION: FullActionSelection = 'lookahead';
const FULL_LOOKAHEAD_DEPTH = 2;
const FULL_LOOKAHEAD_BEAM = 8;
const FULL_LOOKAHEAD_ROOT_BEAM = 24;
const FULL_TARGET_TEMPERATURE = 0.25;
const BUILD_OPTION_DESTINATIONS: NavigationDestination[] = ['Lantern Canyon', 'Floral Patch', 'Cyber City', 'Tidal Cove'];
const SCALING_OPTION_DESTINATIONS: NavigationDestination[] = ['Tidal Cove', 'Cyber City', 'Lantern Canyon'];
const RESTORE_OPTION_DESTINATIONS: NavigationDestination[] = ['Lantern Canyon', 'Floral Patch'];
const CLOSER_DAMAGE_DESTINATIONS: NavigationDestination[] = ['Tidal Cove', 'Cyber City', 'Lantern Canyon'];
const CLOSER_MAX_BARRIER_DESTINATIONS: NavigationDestination[] = ['Floral Patch', 'Lantern Canyon', 'Cyber City'];
const CLOSER_RESTORE_DESTINATIONS: NavigationDestination[] = ['Lantern Canyon', 'Floral Patch'];
const GOOD_TARGET_CONTROLLED_CORRUPT_FARM =
	(process.env.ARC_GOOD_TARGET_CONTROLLED_CORRUPT_FARM ?? process.env.TRACEQ_GOOD_TARGET_CONTROLLED_CORRUPT_FARM ?? '0') === '1';
const GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP =
	process.env.ARC_GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP !== undefined
		? parseFloat(process.env.ARC_GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP)
		: process.env.TRACEQ_GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP !== undefined
			? parseFloat(process.env.TRACEQ_GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP)
			: Number.POSITIVE_INFINITY;
const GOOD_TARGET_EXPOSE_AFTER_VP =
	process.env.ARC_GOOD_TARGET_EXPOSE_AFTER_VP !== undefined
		? parseFloat(process.env.ARC_GOOD_TARGET_EXPOSE_AFTER_VP)
		: process.env.TRACEQ_GOOD_TARGET_EXPOSE_AFTER_VP !== undefined
			? parseFloat(process.env.TRACEQ_GOOD_TARGET_EXPOSE_AFTER_VP)
			: Number.POSITIVE_INFINITY;
const FARM_ACTION_TYPES = new Set<GameCommand['type']>([
	'startCombat',
	'resolveMonsterReward',
	'spawnHandSpirit',
	'discardHandDraws',
	'redrawHandDraws'
]);
const REWARD_ACTION_TYPES = new Set<GameCommand['type']>([
	'resolveMonsterReward',
	'spawnHandSpirit',
	'discardHandDraws',
	'redrawHandDraws'
]);
const GOOD_BUILDER_HP4_PICK_ACTION_TYPES = new Set<GameCommand['type']>([
	'resolveLocationInteraction',
	'spawnHandSpirit',
	'takeSpirit',
	'replaceSpirit',
	'awakenSpirit',
	'manualAwaken',
	'resolveAwakenReward',
	'resolveDecision',
	'attachRuneToSpirit',
	'placeAugmentOnSpirit',
	'redrawHandDraws',
	'discardHandDraws'
]);
const GOOD_BUILDER_HP4_CONVERSION_ACTION_TYPES = new Set<GameCommand['type']>([
	...GOOD_BUILDER_HP4_PICK_ACTION_TYPES,
	'startCombat',
	'resolveMonsterReward'
]);

type RolloutPolicy = 'policy' | 'breakpoint-oracle';
type TraceScript =
	| 'policy'
	| 'abyss-probe'
	| 'restore-loop'
	| 'max-barrier-loop'
	| 'damage-assembly'
	| 'hp4-survival-oracle'
	| 'finish-line-oracle'
	| 'fixed-reentry'
	| 'expose-floral'
	| 'expose-tidal'
	| 'expose-cyber'
	| 'expose-lantern';
type TraceSampleMode = 'navigation' | 'full' | 'both';

interface Config {
	games: number;
	seatsN: number;
	maxRounds: number;
	maxWindows: number;
	horizons: number[];
	labelHorizon: number;
	minSourceVp: number;
	maxSourceVp: number;
	minPlayerVp: number;
	maxPlayerVp: number;
	minRound: number;
	maxRound?: number;
	sourceDestination?: string;
	minMonsterHp: number;
	maxMonsterHp?: number;
	minCleanKillProb: number;
	maxCleanKillProb?: number;
	minFirepowerKillProb: number;
	maxFirepowerKillProb?: number;
	reentryBuildSteps: number;
	scoreReach30Bonus: number;
	scoreVpWeight: number;
	scoreKillWeight: number;
	scoreCleanOpportunityWeight: number;
	scoreFirepowerOpportunityWeight: number;
	scoreExpectedAttackWeight: number;
	scoreAttackDiceWeight: number;
	scoreSpiritAnimalWeight: number;
	scoreCultivatorWeight: number;
	scoreBarrierWeight: number;
	scoreCurrentBarrierWeight: number;
	scoreExposureWindowWeight: number;
	scoreExposureVpWeight: number;
	scoreExposureBestVpWeight: number;
	scoreTargetQualityWindowWeight: number;
	scoreTargetQualityVpWeight: number;
	scoreTargetQualityBestVpWeight: number;
	exposureMinVp: number;
	exposureMinMonsterHp: number;
	targetQualityMinVp: number;
	requireExposureDelta: boolean;
	requireTargetQualityDelta: boolean;
	scoreStatusPenalty: number;
	labelScoreThreshold: number;
	labelVpThreshold: number;
	labelStatusTolerance: number;
	dataOut?: string;
	positiveOnlyData: boolean;
	sampleMode: TraceSampleMode;
	fullSampleTypes?: Set<GameCommand['type']>;
	profiles: string[];
	out: string;
	summaryOut: string;
	forbidTypes?: Set<GameCommand['type']>;
	maxStatusLevel?: number;
	plannerPolicy: NeuralPolicy;
	patchNavigationPolicy?: NeuralPolicy;
	patchNavigationPolicyGate: NavigationPolicyGate;
	patch2NavigationPolicy?: NeuralPolicy;
	patch2NavigationPolicyGate: NavigationPolicyGate;
	navigationPolicy?: NeuralPolicy;
	navigationPolicyGate: NavigationPolicyGate;
	scalingNavigationPolicy?: NeuralPolicy;
	scalingNavigationPolicyGate: NavigationPolicyGate;
	microPolicy?: NeuralPolicy;
	microPolicyGate: MicroPolicyGate;
	preserveRouteFirepower: boolean;
	preserveRouteSurvival: boolean;
	plannerIterations: number;
	plannerHorizon: number;
	plannerValueWeight: number;
	progressEvery: number;
	sourceSeedBase: number;
	plannerProfile: string;
	rolloutPolicy: RolloutPolicy;
	sourceFullSelection: FullActionSelection;
	rolloutFullSelection: FullActionSelection;
	routeFinishOracle: boolean;
	scripts: TraceScript[];
	weights: string;
	patchNavWeights?: string;
	patch2NavWeights?: string;
	navWeights?: string;
	scaleNavWeights?: string;
	microWeights?: string;
}

interface BuildSnapshot {
	vp: number;
	status: number;
	expectedAttack: number;
	maxBarrier: number;
	currentBarrier: number;
	attackDice: number;
	spiritAnimal: number;
	cultivator: number;
	kills: number;
	combats: number;
	cleanCombatOpportunities: number;
	firepowerCombatOpportunities: number;
	exposedGoodTargetWindows: number;
	exposedGoodTargetVp: number;
	bestExposedGoodTargetVp: number;
	valuableGoodTargetWindows: number;
	valuableGoodTargetVp: number;
	bestValuableGoodTargetVp: number;
	round: number;
}

interface BranchMetrics {
	script: TraceScript;
	finalVp: number;
	finalStatus: number;
	kills: number;
	combats: number;
	cleanCombatOpportunities: number;
	firepowerCombatOpportunities: number;
	exposedGoodTargetWindows: number;
	exposedGoodTargetVp: number;
	bestExposedGoodTargetVp: number;
	valuableGoodTargetWindows: number;
	valuableGoodTargetVp: number;
	bestValuableGoodTargetVp: number;
	maxExpectedAttack: number;
	maxBarrier: number;
	maxCurrentBarrier: number;
	maxAttackDice: number;
	maxSpiritAnimal: number;
	maxCultivator: number;
	rounds: number;
	navigationDecisions: number;
	requestedHorizon: number;
	rolloutEndRound: number;
	cappedByMaxRounds: boolean;
	snapshots: Record<string, BuildSnapshot>;
}

interface TraceBranch {
	metrics: BranchMetrics;
	fullSamples: Sample[];
	fullSampleTypes: Record<string, number>;
}

interface FullActionDecisionTrace {
	chosen: LegalAction;
	withNext: LegalAction[];
	chosenIdx: number;
	pi: number[];
}

interface CapturedWindow {
	state: PublicGameState;
	seat: SeatColor;
	catalog: PlayCatalog;
	game: number;
	round: number;
	sourceDestination: string;
	legalDestinations: string[];
	profileBySeat: Record<string, BotProfile>;
}

interface WindowRow {
	id: string;
	game: number;
	seat: SeatColor;
	sourceFinalVp: number;
	round: number;
	playerVp: number;
	playerStatus: number;
	playerExpectedAttack: number;
	playerMaxBarrier: number;
	playerCurrentBarrier: number;
	playerAttackDice: number;
	playerSpiritAnimal: number;
	playerCultivator: number;
	monsterHp: number;
	monsterDamage: number;
	monsterLives: number;
	cleanKillProb: number;
	firepowerKillProb: number;
	sourceDestination: string;
	legalDestinations: string[];
	bestScript: TraceScript;
	policyScore: number;
	bestScore: number;
	traceQDeltaScore: number;
	traceQDeltaVp: number;
	traceQDeltaStatus: number;
	traceQDeltaReach30: number;
	traceQDeltaExposureWindows: number;
	traceQDeltaExposureVp: number;
	traceQDeltaBestExposureVp: number;
	traceQDeltaTargetQualityWindows: number;
	traceQDeltaTargetQualityVp: number;
	traceQDeltaBestTargetQualityVp: number;
	traceCorrection: boolean;
	branches: BranchMetrics[];
}

interface NavigationSampleResult {
	recorded: boolean;
	destination?: NavigationDestination;
	skipReason?: string;
}

function seededBotRandom(seed: number): BotRandom {
	const rng = createRng(seed);
	return {
		int: (maxExclusive: number) => nextInt(rng, maxExclusive),
		chance: () => nextInt(rng, 2) === 0
	};
}

function cloneState(state: PublicGameState): PublicGameState {
	return JSON.parse(JSON.stringify(state)) as PublicGameState;
}

function parseForbidTypes(raw: string | undefined): Set<GameCommand['type']> | undefined {
	if (!raw?.trim()) return undefined;
	const types = raw.split(',').map((s) => s.trim()).filter(Boolean) as GameCommand['type'][];
	return types.length ? new Set(types) : undefined;
}

function parseHorizons(raw: string | undefined): number[] {
	const values = (raw ?? '6,12,18')
		.split(',')
		.map((s) => parseInt(s.trim(), 10))
		.filter((n) => Number.isFinite(n) && n > 0);
	return [...new Set(values)].sort((a, b) => a - b);
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === '') return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

function parseOptionalStatusLevel(raw: string | undefined, fallback: number | undefined): number | undefined {
	if (raw === undefined) return fallback;
	const normalized = raw.trim().toLowerCase();
	if (!normalized || normalized === 'any' || normalized === 'none' || normalized === 'off') return undefined;
	const n = parseInt(normalized, 10);
	return Number.isFinite(n) ? n : fallback;
}

function parseFullActionSelection(raw: string | undefined, fallback: FullActionSelection): FullActionSelection {
	if (raw === 'policy' || raw === 'hybrid' || raw === 'value' || raw === 'lookahead') return raw;
	return fallback;
}

function parseNavigationPolicyGate(raw: string | undefined, fallback: NavigationPolicyGate): NavigationPolicyGate {
	if (
		raw === 'all' ||
		raw === 'unsafe-firepower' ||
		raw === 'unsafe-firepower-build-option' ||
		raw === 'midroute-scaling' ||
		raw === 'route-option-scaling' ||
		raw === 'clean-farm-q' ||
		raw === 'hp2-survival-deficit' ||
		raw === 'hp4-first-wall' ||
		raw === 'route-closer' ||
		raw === 'route-finish-loop' ||
			raw === 'survival-rebuild' ||
				raw === 'good-nonfallen-farm-build' ||
					raw === 'good-nonfallen-farm-target-pivot' ||
					raw === 'good-nonfallen-farm-target-evade' ||
					raw === 'good-target-exposure' ||
					raw === 'good-target-rendezvous-exposure' ||
					raw === 'good-nonfallen-score-floor' ||
			raw === 'good-builder-noncontest-support-oracle' ||
			raw === 'pvp-predictive-mode-pivot' ||
		raw === 'pvp-predictive-mode-hunt-fallback-pivot' ||
		raw === 'pvp-predictive-mode-hunt-fallback-rebuild-pivot' ||
		raw === 'pvp-good-target-value-pivot'
	) {
		return raw;
	}
	return fallback;
}

function parseMicroPolicyGate(raw: string | undefined): MicroPolicyGate {
	if (
		raw === 'abyss-round' ||
		raw === 'abyss-farm-actions' ||
		raw === 'abyss-reward-actions' ||
		raw === 'abyss-farm-overlay' ||
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
	return 'all';
}

function parseScripts(raw: string | undefined): TraceScript[] {
	const allowed = new Set<TraceScript>([
		'policy',
		'abyss-probe',
		'restore-loop',
		'max-barrier-loop',
		'damage-assembly',
		'hp4-survival-oracle',
		'finish-line-oracle',
		'fixed-reentry',
		'expose-floral',
		'expose-tidal',
		'expose-cyber',
		'expose-lantern'
	]);
	const scripts = (raw ?? 'policy,abyss-probe,restore-loop,max-barrier-loop,damage-assembly,hp4-survival-oracle,finish-line-oracle,fixed-reentry')
		.split(',')
		.map((s) => s.trim())
		.filter((s): s is TraceScript => allowed.has(s as TraceScript));
	return scripts.includes('policy') ? scripts : ['policy', ...scripts];
}

function parseSampleMode(raw: string | undefined): TraceSampleMode {
	return raw === 'full' || raw === 'both' ? raw : 'navigation';
}

function buildOf(state: PublicGameState, seat: SeatColor): Omit<BuildSnapshot, 'kills' | 'combats' | 'cleanCombatOpportunities' | 'firepowerCombatOpportunities' | 'round'> {
	const player = state.players[seat];
	if (!player) {
		return {
			vp: 0,
			status: 0,
			expectedAttack: 0,
			maxBarrier: 0,
			currentBarrier: 0,
			attackDice: 0,
			spiritAnimal: 0,
			cultivator: 0,
			exposedGoodTargetWindows: 0,
			exposedGoodTargetVp: 0,
			bestExposedGoodTargetVp: 0,
			valuableGoodTargetWindows: 0,
			valuableGoodTargetVp: 0,
			bestValuableGoodTargetVp: 0
		};
	}
	const counts = awakenedClassCounts(player);
	return {
		vp: player.victoryPoints ?? 0,
		status: player.statusLevel ?? 0,
		expectedAttack: expectedAttack(player),
		maxBarrier: player.maxBarrier ?? 0,
		currentBarrier: player.barrier ?? 0,
		attackDice: player.attackDice?.length ?? 0,
		spiritAnimal: counts['Spirit Animal'] ?? 0,
		cultivator: counts.Cultivator ?? 0,
		exposedGoodTargetWindows: 0,
		exposedGoodTargetVp: 0,
		bestExposedGoodTargetVp: 0,
		valuableGoodTargetWindows: 0,
		valuableGoodTargetVp: 0,
		bestValuableGoodTargetVp: 0
	};
}

function monsterSignal(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog): {
	monsterHp: number;
	monsterDamage: number;
	monsterLives: number;
	cleanKillProb: number;
	firepowerKillProb: number;
} {
	const monster = state.monster;
	if (!monster) {
		return { monsterHp: 0, monsterDamage: 0, monsterLives: 0, cleanKillProb: 0, firepowerKillProb: 0 };
	}
	return {
		monsterHp: monster.maxHp ?? monster.hp ?? 0,
		monsterDamage: monster.damage ?? 0,
		monsterLives: monster.livesRemaining ?? 0,
		cleanKillProb: computeKillProbability(state, seat, catalog, { allowCorruptKill: false }),
		firepowerKillProb: firepowerKillProbability(state, seat, catalog)
	};
}

function combatReadyButNeedsRestore(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, threshold = 0.5): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) !== 0) return false;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	if (cleanProb >= threshold) return false;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const damageReady = firepowerProb >= threshold || (monsterHp > 0 && attack >= monsterHp - 0.01);
	if (!damageReady) return false;
	const survivalTarget = (monster.damage ?? 0) + 1;
	if (survivalTarget <= 0) return false;
	const maxBarrier = player.maxBarrier ?? 0;
	const barrier = player.barrier ?? 0;
	const counts = awakenedClassCounts(player);
	return (maxBarrier >= survivalTarget && barrier < survivalTarget) ||
		(maxBarrier < survivalTarget && (counts.Cultivator ?? 0) >= 2);
}

function appendDestination(destinations: NavigationDestination[], destination: NavigationDestination): void {
	if (!destinations.includes(destination)) destinations.push(destination);
}

function pendingAugmentClassCounts(
	player: PublicGameState['players'][SeatColor] | undefined,
	catalog: PlayCatalog
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const augment of player?.unplacedAugments ?? []) {
		const className = augment.classId
			? catalog.classes.find((entry) => entry.id === augment.classId)?.name
			: undefined;
		if (className) out[className] = (out[className] ?? 0) + 1;
	}
	return out;
}

function heldRelicCount(player: PublicGameState['players'][SeatColor] | undefined): number {
	return (player?.mats ?? []).filter((slot) => slot.hasRune && slot.type === 'relic').length;
}

function locationInteractionForAction(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	action: LegalAction
): LocationInteraction | undefined {
	if (action.cmd.type !== 'resolveLocationInteraction') return undefined;
	const destination = state.players[seat]?.navigationDestination;
	if (!destination) return undefined;
	const rowIndex = action.cmd.rowIndex;
	return buildLocationInteractions((catalog.locations ?? []).find((loc) => loc.name === destination)?.rewardRows)
		.find((it) => it.rowIndex === rowIndex);
}

function runeClassName(rune: { classId?: string | null }, catalog: PlayCatalog): string | undefined {
	return rune.classId ? catalog.classes.find((entry) => entry.id === rune.classId)?.name : undefined;
}

function gainCanGrantClass(gain: GainEffect, catalog: PlayCatalog, className: string): boolean {
	if (gain.type === 'rune') return runeClassName(gain.rune, catalog) === className;
	if (gain.type === 'chooseRune') return gain.options.some((option) => runeClassName(option, catalog) === className);
	return false;
}

function interactionCanGrantClass(
	interaction: LocationInteraction | undefined,
	catalog: PlayCatalog,
	className: string
): boolean {
	return !!interaction?.gains.some((gain) => gainCanGrantClass(gain, catalog, className));
}

function interactionCostsRelic(interaction: LocationInteraction | undefined): boolean {
	return !!interaction?.cost.some((cost) => cost.match === 'anyRelic' || cost.match === 'specialRune');
}

function hp4ConversionNeed(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
): {
	active: boolean;
	needCultivatorTicket: boolean;
	needCultivate: boolean;
	cultivatorProgress: number;
	hasRelic: boolean;
} {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster) {
		return { active: false, needCultivatorTicket: false, needCultivate: false, cultivatorProgress: 0, hasRelic: false };
	}
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const survivalTarget = (monster.damage ?? 0) + 1;
	const counts = awakenedClassCounts(player);
	const pending = pendingAugmentClassCounts(player, catalog);
	const cultivatorProgress = (counts.Cultivator ?? 0) + (pending.Cultivator ?? 0);
	const maxBarrier = player.maxBarrier ?? 0;
	const vp = player.victoryPoints ?? 0;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold: 0.5 });
	const active =
		farm.valid &&
		farm.rewardVp > 0 &&
		vp >= 3 &&
		monsterHp >= 4 &&
		monsterHp <= 5 &&
		survivalTarget > 0 &&
		maxBarrier < survivalTarget;
	return {
		active,
		needCultivatorTicket: active && cultivatorProgress < 2,
		needCultivate: active && (counts.Cultivator ?? 0) >= 2,
		cultivatorProgress,
		hasRelic: heldRelicCount(player) > 0
	};
}

function shouldGoodTargetContinueAbyssFarm(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	const status = player?.statusLevel ?? 0;
	if (!player || !monster || status > 2) return false;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold: 0.5 });
	if (!farm.valid || farm.rewardVp <= 0) return false;
	if (!GOOD_TARGET_CONTROLLED_CORRUPT_FARM && !farm.farmable) return false;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const vp = player.victoryPoints ?? 0;
	if (vp >= GOOD_TARGET_EXPOSE_AFTER_VP) return false;
	const lives = Math.max(1, farm.livesRemaining ?? monster.livesRemaining ?? 1);
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const corrupt = computeKillProbability(state, seat, catalog, { allowCorruptKill: true });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const canSpendCorruptionAndRemainGood =
		GOOD_TARGET_CONTROLLED_CORRUPT_FARM &&
		status < 2 &&
		vp < GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP;
	const controlledKillProbability = Math.max(
		clean,
		canSpendCorruptionAndRemainGood ? corrupt : 0,
		canSpendCorruptionAndRemainGood ? firepower : 0,
		canSpendCorruptionAndRemainGood && attack >= monsterHp - 0.01 ? 1 : 0
	);
	const controlledOpportunityVp = controlledKillProbability * farm.rewardVp;
	const damageReady =
		clean >= 0.5 ||
		(
			canSpendCorruptionAndRemainGood &&
			(corrupt >= 0.5 || firepower >= 0.5 || attack >= monsterHp - 0.01)
		);
	const nearDamage =
		clean >= 0.325 ||
		(
			canSpendCorruptionAndRemainGood &&
			(corrupt >= 0.325 || firepower >= 0.325 || attack >= monsterHp - 0.75)
		);
	if (farm.rewardVp >= 3 && controlledOpportunityVp >= 2 && lives >= 2 && monsterHp <= 2 && nearDamage && vp < 24) return true;
	const efficientHp4Farm =
		controlledOpportunityVp >= 2 &&
		monsterHp <= 4 &&
		(vp < 18 || farm.rewardVp >= 3 || lives >= 2) &&
		nearDamage;
	if (efficientHp4Farm && vp < 24) return true;
	const reliablePrePivotHardFarm = vp < 21 && monsterHp <= 5 && (damageReady || clean >= 0.325 || firepower >= 0.325);
	if (reliablePrePivotHardFarm) return true;
	return vp + farm.rewardVp * lives >= VP_TO_WIN && (damageReady || nearDamage);
}

function goodTargetPivotDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): NavigationDestination[] {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster) return ['Tidal Cove', 'Cyber City', 'Lantern Canyon', 'Floral Patch'];
	if ((player.statusLevel ?? 0) > 2) return ['Floral Patch', 'Tidal Cove', 'Cyber City', 'Lantern Canyon'];
	if (shouldGoodTargetContinueAbyssFarm(state, seat, catalog, cfg)) return ['Arcane Abyss'];
	const destinations: NavigationDestination[] = [];
	const counts = awakenedClassCounts(player);
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const survivalTarget = (monster.damage ?? 0) + 1;
	const barrier = player.barrier ?? 0;
	const maxBarrier = player.maxBarrier ?? 0;
	const clean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepower = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const needsDamage = monsterHp > 0 && attack < monsterHp + 0.5 && firepower < 0.5 && clean < 0.5;
	const needsRestore = survivalTarget > 0 && maxBarrier >= survivalTarget && barrier < survivalTarget;
	const needsMaxBarrier = survivalTarget > 0 && maxBarrier < survivalTarget && (counts.Cultivator ?? 0) >= 2;
	const conversion = hp4ConversionNeed(state, seat, catalog);
	if (conversion.needCultivatorTicket) return conversion.hasRelic ? ['Tidal Cove'] : ['Tidal Cove', 'Cyber City'];
	if (conversion.needCultivate) return ['Lantern Canyon', 'Tidal Cove', 'Cyber City'];
	if ((player.victoryPoints ?? 0) >= 18 || ((counts.Healer ?? 0) > 0 && maxBarrier >= 8)) appendDestination(destinations, 'Floral Patch');
	if (needsRestore) {
		appendDestination(destinations, 'Floral Patch');
		appendDestination(destinations, 'Lantern Canyon');
	}
	if (needsMaxBarrier) appendDestination(destinations, 'Lantern Canyon');
	if (needsDamage || (player.attackDice?.length ?? 0) < 2 || player.spirits.length < 6 || (counts['Spirit Animal'] ?? 0) < 2) {
		appendDestination(destinations, 'Tidal Cove');
		appendDestination(destinations, 'Cyber City');
	}
	appendDestination(destinations, 'Floral Patch');
	appendDestination(destinations, 'Tidal Cove');
	appendDestination(destinations, 'Cyber City');
	appendDestination(destinations, 'Lantern Canyon');
	return destinations;
}

function isRouteCloserRestoreFinishState(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, threshold = 0.5): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) !== 0) return false;
	const vp = player.victoryPoints ?? 0;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	if (state.round < 16 || vp < 24 || vp >= 30 || monsterHp < 4 || monsterHp > 10) return false;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold });
	const finishOpportunity = farm.valid &&
		farm.rewardVp > 0 &&
		vp + farm.rewardVp * Math.max(1, farm.livesRemaining) >= 30;
	if (!finishOpportunity) return false;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	const survivalTarget = (monster.damage ?? 0) + 1;
	const maxBarrier = player.maxBarrier ?? 0;
	const barrier = player.barrier ?? 0;
	if (survivalTarget <= 0 || maxBarrier < survivalTarget) return false;
	const restoreDeficit = barrier < survivalTarget;
	const currentSurvivalReady = barrier >= survivalTarget;
	const enoughFirepower = cleanProb >= threshold || firepowerProb >= threshold;
	return restoreDeficit || (currentSurvivalReady && enoughFirepower);
}

function shouldUseGate(
	gate: NavigationPolicyGate,
	policy: NeuralPolicy | undefined,
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): boolean {
	if (!policy) return false;
	if (gate === 'all') return true;
	const player = state.players[seat];
	const monster = state.monster;
	if (gate === 'good-nonfallen-farm-build' || gate === 'good-nonfallen-farm-target-pivot') {
		return !!player && !!monster && (cfg.maxStatusLevel === undefined || (player.statusLevel ?? 0) <= cfg.maxStatusLevel);
	}
	if (gate === 'good-target-exposure' || gate === 'good-target-rendezvous-exposure') {
		if (!player || !monster) return false;
		const status = player.statusLevel ?? 0;
		if (status > 2 || (cfg.maxStatusLevel !== undefined && status > cfg.maxStatusLevel)) return false;
		const vp = player.victoryPoints ?? 0;
		const monsterHp = monster.maxHp ?? monster.hp ?? 0;
		if (state.round < 6 || vp < 12 || vp > 28 || monsterHp < 4) return false;
		const farm = evaluateFarmValue(state, seat, catalog, { threshold: 0.5 });
		return !(farm.valid && farm.farmable && farm.opportunityVp >= 2 && monsterHp <= 2 && vp < 24);
	}
	if (!player || !monster || (player.statusLevel ?? 0) !== 0) return false;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	if (gate === 'unsafe-firepower' || gate === 'unsafe-firepower-build-option') {
		return firepowerProb >= 0.5 && cleanProb < 0.5;
	}
	const farm = evaluateFarmValue(state, seat, catalog, { threshold: 0.5 });
	if (
		farm.valid &&
		farm.farmable &&
		farm.opportunityVp > 0 &&
		gate !== 'clean-farm-q' &&
		gate !== 'route-finish-loop'
	) return false;
	const vp = player.victoryPoints ?? 0;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const monsterDamage = monster.damage ?? 0;
	const attack = expectedAttack(player);
	if (gate === 'midroute-scaling') return state.round >= 4 && vp >= 6;
	if (gate === 'clean-farm-q') return farm.valid && farm.farmable && farm.opportunityVp >= 1;
	if (gate === 'hp2-survival-deficit') {
		if (state.round < 6 || state.round > 18 || vp < 9 || vp > 18 || Math.abs(monsterHp - 2) > 0.01) return false;
		return cleanProb < 0.5 && firepowerProb >= 0.5 && expectedAttack(player) < 3.25 && combatReadyButNeedsRestore(state, seat, catalog);
	}
	if (gate === 'hp4-first-wall') {
		if (state.round < 9 || state.round > 22 || vp < 12 || vp > 22 || monsterHp < 4 || monsterHp > 5) return false;
		const farm = evaluateFarmValue(state, seat, catalog, { threshold: 0.5 });
		if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
		if (cleanProb >= 0.5) return false;
		const survivalTarget = monsterDamage + 1;
		const barrier = player.barrier ?? 0;
		const maxBarrier = player.maxBarrier ?? 0;
		return firepowerProb >= 0.35 ||
			attack >= monsterHp - 0.75 ||
			(survivalTarget > 0 && (barrier < survivalTarget || maxBarrier < survivalTarget + 1));
	}
	if (gate === 'route-option-scaling') {
		if (state.round < 8 || vp < 10 || vp >= 24) return false;
		const counts = awakenedClassCounts(player);
		const attackDice = player.attackDice?.length ?? 0;
		const needsDamage = monsterHp > 0 && (firepowerProb < 0.5 || attack < monsterHp + 1);
		if (needsDamage || combatReadyButNeedsRestore(state, seat, catalog)) return true;
		if ((player.barrier ?? 0) < (player.maxBarrier ?? 0) || state.round % 3 !== 0) return false;
		return attackDice < 2 || attack < 5 || (counts.Cultivator ?? 0) < 2 || (player.maxBarrier ?? 0) < 6;
	}
	if (gate === 'route-closer') {
		if (state.round < 12 || vp < 15 || vp >= 30 || monsterHp < 4 || cleanProb >= 0.5) return false;
		const survivalTarget = monsterDamage + 1;
		return attack < monsterHp + 0.5 ||
			firepowerProb < 0.5 ||
			(survivalTarget > 0 && (player.maxBarrier ?? 0) < survivalTarget) ||
			(survivalTarget > 0 && (player.barrier ?? 0) < survivalTarget);
	}
	if (gate === 'route-finish-loop') return isRouteCloserRestoreFinishState(state, seat, catalog);
	if (gate === 'survival-rebuild') {
		if (state.round < 5 || vp < 9 || monsterHp < 2 || cleanProb >= 0.5) return false;
		const maxBarrierDeficit = (player.maxBarrier ?? 0) < monsterDamage + 2;
		const barrierDeficit = (player.barrier ?? 0) < Math.min(player.maxBarrier ?? 0, monsterDamage + 1);
		const damageDeficit = attack < monsterHp + 0.5 || firepowerProb < 0.5;
		return monsterHp >= 4 || barrierDeficit || maxBarrierDeficit || damageDeficit;
	}
	return false;
}

function rootDestinationsForGate(
	gate: NavigationPolicyGate,
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): NavigationDestination[] | undefined {
	if (gate === 'good-nonfallen-farm-build' || gate === 'good-nonfallen-farm-target-pivot') {
		return goodTargetPivotDestinations(state, seat, catalog, cfg);
	}
	if (gate === 'good-target-exposure') {
		return ['Lantern Canyon', 'Floral Patch', 'Tidal Cove', 'Cyber City', 'Arcane Abyss'];
	}
	if (gate === 'good-target-rendezvous-exposure') {
		return ['Floral Patch', 'Tidal Cove', 'Cyber City', 'Lantern Canyon', 'Arcane Abyss'];
	}
	if (gate === 'unsafe-firepower-build-option') {
		return combatReadyButNeedsRestore(state, seat, catalog) ? RESTORE_OPTION_DESTINATIONS : BUILD_OPTION_DESTINATIONS;
	}
	if (gate === 'route-option-scaling') {
		return combatReadyButNeedsRestore(state, seat, catalog) ? RESTORE_OPTION_DESTINATIONS : SCALING_OPTION_DESTINATIONS;
	}
	if (gate === 'hp2-survival-deficit') return RESTORE_OPTION_DESTINATIONS;
	if (gate === 'hp4-first-wall') return ['Arcane Abyss', 'Lantern Canyon', 'Floral Patch'];
	if (gate === 'route-closer') {
		const player = state.players[seat];
		const monster = state.monster;
		if (!player || !monster) return CLOSER_DAMAGE_DESTINATIONS;
		const monsterHp = monster.maxHp ?? monster.hp ?? 0;
		const monsterDamage = monster.damage ?? 0;
		const attack = expectedAttack(player);
		const firepowerProb = firepowerKillProbability(state, seat, catalog);
		const survivalTarget = monsterDamage + 1;
		if (monsterHp > 0 && (attack < monsterHp + 0.5 || firepowerProb < 0.5)) return CLOSER_DAMAGE_DESTINATIONS;
		if (survivalTarget > 0 && (player.maxBarrier ?? 0) < survivalTarget) return CLOSER_MAX_BARRIER_DESTINATIONS;
		return CLOSER_RESTORE_DESTINATIONS;
	}
	if (gate === 'route-finish-loop') {
		const player = state.players[seat];
		const monster = state.monster;
		if (!player || !monster) return CLOSER_RESTORE_DESTINATIONS;
		const monsterHp = monster.maxHp ?? monster.hp ?? 0;
		const survivalTarget = (monster.damage ?? 0) + 1;
		const barrier = player.barrier ?? 0;
		const maxBarrier = player.maxBarrier ?? 0;
		const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
		const firepowerProb = firepowerKillProbability(state, seat, catalog);
		const attack = expectedAttack(player);
		const enoughFirepower = cleanProb >= 0.5 || firepowerProb >= 0.5 || attack >= monsterHp - 0.01;
		if (survivalTarget > 0 && maxBarrier >= survivalTarget && barrier < survivalTarget) return ['Lantern Canyon'];
		if ((survivalTarget <= 0 || barrier >= survivalTarget) && enoughFirepower) return ['Arcane Abyss'];
		return CLOSER_DAMAGE_DESTINATIONS;
	}
	if (gate === 'survival-rebuild') {
		const player = state.players[seat];
		const monster = state.monster;
		if (!player || !monster) return BUILD_OPTION_DESTINATIONS;
		const monsterHp = monster.maxHp ?? monster.hp ?? 0;
		const attack = expectedAttack(player);
		const firepowerProb = firepowerKillProbability(state, seat, catalog);
		return monsterHp > 0 && (attack < monsterHp + 0.5 || firepowerProb < 0.5)
			? ['Cyber City', 'Tidal Cove', 'Lantern Canyon']
			: ['Floral Patch', 'Lantern Canyon'];
	}
	return undefined;
}

function navigationSelection(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): { policy: NeuralPolicy; rootDestinations?: NavigationDestination[] } {
	const ordered: Array<[NeuralPolicy | undefined, NavigationPolicyGate]> = [
		[cfg.patchNavigationPolicy, cfg.patchNavigationPolicyGate],
		[cfg.patch2NavigationPolicy, cfg.patch2NavigationPolicyGate],
		[cfg.navigationPolicy, cfg.navigationPolicyGate],
		[cfg.scalingNavigationPolicy, cfg.scalingNavigationPolicyGate]
	];
	for (const [policy, gate] of ordered) {
		if (shouldUseGate(gate, policy, state, seat, catalog, cfg)) {
			return { policy: policy ?? cfg.plannerPolicy, rootDestinations: rootDestinationsForGate(gate, state, seat, catalog, cfg) };
		}
	}
	return { policy: cfg.plannerPolicy };
}

function plannerNavigationCommand(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config,
	seed: number
): GameCommand | null {
	if (state.phase !== 'navigation') return null;
	const nav = navigationSelection(state, seat, catalog, cfg);
	const result = neuralPlanNavigation(state, seat, catalog, cfg.plannerPolicy, {
		iterations: cfg.plannerIterations,
		horizon: cfg.plannerHorizon,
		valueWeight: cfg.plannerValueWeight,
		c: 1.5,
		priorPolicy: nav.policy,
		rootDestinations: nav.rootDestinations,
		seed
	});
	if (!result) return null;
	let best = 0;
	for (let i = 1; i < result.visits.length; i++) if (result.visits[i] > result.visits[best]) best = i;
	return { type: 'lockNavigation', destination: result.destinations[best] };
}

function firstLegalDestination(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, destinations: NavigationDestination[]): GameCommand | null {
	const branches = legalActionsWithNext(state, seat, catalog).filter((x) => x.cmd.type === 'lockNavigation');
	for (const destination of destinations) {
		const match = branches.find((x) => x.cmd.type === 'lockNavigation' && x.cmd.destination === destination);
		if (match) return match.cmd;
	}
	return null;
}

function hp4SurvivalOracleNavigation(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config,
	seed: number
): GameCommand | null {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster) return plannerNavigationCommand(state, seat, catalog, cfg, seed);
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const monsterDamage = monster.damage ?? 0;
	const survivalTarget = monsterDamage + 1;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const counts = awakenedClassCounts(player);
	const maxBarrier = player.maxBarrier ?? 0;
	const currentBarrier = player.barrier ?? 0;
	const cultivator = counts.Cultivator ?? 0;
	const attackDice = player.attackDice?.length ?? 0;
	const conversion = hp4ConversionNeed(state, seat, catalog);
	const abyss = firstLegalDestination(state, seat, catalog, ['Arcane Abyss']);
	const cleanReady = cleanProb >= 0.5;
	const firepowerReady = firepowerProb >= 0.5 || (monsterHp > 0 && attack >= monsterHp - 0.01);
	const repeatSurvivalTarget = survivalTarget > 0 ? survivalTarget + (monsterHp >= 4 ? 1 : 0) : 0;
	const needsDamage = monsterHp > 0 && (!firepowerReady || attack < monsterHp + 0.25 || (monsterHp >= 4 && attackDice < 2));
	const needsMaxBarrier = repeatSurvivalTarget > 0 && (maxBarrier < repeatSurvivalTarget || (monsterHp >= 4 && cultivator < 2));
	const needsRestore = survivalTarget > 0 && maxBarrier >= survivalTarget && currentBarrier < survivalTarget;
	const needsBufferRestore = repeatSurvivalTarget > 0 && maxBarrier >= repeatSurvivalTarget && currentBarrier < repeatSurvivalTarget;

	if (cleanReady && (!needsBufferRestore || currentBarrier >= survivalTarget)) {
		return abyss ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	if (conversion.needCultivatorTicket) {
		return firstLegalDestination(
			state,
			seat,
			catalog,
			conversion.hasRelic ? ['Tidal Cove'] : ['Tidal Cove', 'Cyber City']
		) ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	if (conversion.needCultivate) {
		return firstLegalDestination(state, seat, catalog, ['Lantern Canyon', 'Tidal Cove', 'Cyber City']) ??
			plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	if (needsMaxBarrier && cultivator >= 2) {
		return firstLegalDestination(state, seat, catalog, ['Lantern Canyon', 'Tidal Cove', 'Cyber City']) ??
			plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	if (needsDamage) {
		return firstLegalDestination(state, seat, catalog, CLOSER_DAMAGE_DESTINATIONS) ??
			plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	if (needsMaxBarrier) {
		return firstLegalDestination(state, seat, catalog, CLOSER_MAX_BARRIER_DESTINATIONS) ??
			plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	if (needsRestore || needsBufferRestore) {
		return firstLegalDestination(state, seat, catalog, CLOSER_RESTORE_DESTINATIONS) ??
			abyss ??
			plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	if (firepowerReady || cleanProb >= 0.35 || firepowerProb >= 0.35) {
		return abyss ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	return firstLegalDestination(state, seat, catalog, BUILD_OPTION_DESTINATIONS) ??
		plannerNavigationCommand(state, seat, catalog, cfg, seed);
}

function finishLineOracleNavigation(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config,
	seed: number
): GameCommand | null {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster) return plannerNavigationCommand(state, seat, catalog, cfg, seed);
	const vp = player.victoryPoints ?? 0;
	if (state.round < 16 || vp < 24 || vp >= VP_TO_WIN) {
		return hp4SurvivalOracleNavigation(state, seat, catalog, cfg, seed);
	}
	const farm = evaluateFarmValue(state, seat, catalog, { threshold: 0.5 });
	const livesRemaining = Math.max(1, farm.livesRemaining ?? monster.livesRemaining ?? 1);
	const finishOpportunity =
		farm.valid &&
		farm.rewardVp > 0 &&
		vp + farm.rewardVp * livesRemaining >= VP_TO_WIN;
	if (!finishOpportunity) {
		return hp4SurvivalOracleNavigation(state, seat, catalog, cfg, seed);
	}

	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const survivalTarget = (monster.damage ?? 0) + 1;
	const maxBarrier = player.maxBarrier ?? 0;
	const currentBarrier = player.barrier ?? 0;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const cleanReady = cleanProb >= 0.5;
	const damageReady = cleanReady || firepowerProb >= 0.5 || (monsterHp > 0 && attack >= monsterHp - 0.01);
	const survivalReady = survivalTarget <= 0 || currentBarrier >= survivalTarget;
	const canRestore = survivalTarget > 0 && maxBarrier >= survivalTarget;
	const abyss = firstLegalDestination(state, seat, catalog, ['Arcane Abyss']);

	if (damageReady && survivalReady) {
		return abyss ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	if (canRestore && !survivalReady) {
		const largeDeficit = survivalTarget - currentBarrier >= 3;
		const restoreOrder: NavigationDestination[] = largeDeficit && state.round <= cfg.maxRounds - 2
			? ['Floral Patch', 'Lantern Canyon']
			: ['Lantern Canyon', 'Floral Patch'];
		return firstLegalDestination(state, seat, catalog, restoreOrder) ??
			abyss ??
			plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	if (survivalTarget > 0 && maxBarrier < survivalTarget) {
		return firstLegalDestination(state, seat, catalog, CLOSER_MAX_BARRIER_DESTINATIONS) ??
			plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	if (!damageReady) {
		return firstLegalDestination(state, seat, catalog, CLOSER_DAMAGE_DESTINATIONS) ??
			plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	return abyss ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
}

function scriptedNavigationCommand(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config,
	script: TraceScript,
	navigationDecisions: number,
	seed: number
): GameCommand | null {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster) return plannerNavigationCommand(state, seat, catalog, cfg, seed);
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const monsterDamage = monster.damage ?? 0;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const survivalTarget = monsterDamage + 1;
	const needsRestore = survivalTarget > 0 && (player.maxBarrier ?? 0) >= survivalTarget && (player.barrier ?? 0) < survivalTarget;
	const needsMaxBarrier = survivalTarget > 0 && (player.maxBarrier ?? 0) < survivalTarget + 1;
	const needsDamage = monsterHp > 0 && (firepowerProb < 0.5 || attack < monsterHp + 0.5);
	const abyss = firstLegalDestination(state, seat, catalog, ['Arcane Abyss']);
	if (script === 'policy') return plannerNavigationCommand(state, seat, catalog, cfg, seed);
	if (script === 'abyss-probe') return abyss ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
	if (script === 'expose-floral') {
		return firstLegalDestination(state, seat, catalog, ['Floral Patch']) ??
			plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	if (script === 'expose-tidal') {
		return firstLegalDestination(state, seat, catalog, ['Tidal Cove']) ??
			plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	if (script === 'expose-cyber') {
		return firstLegalDestination(state, seat, catalog, ['Cyber City']) ??
			plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	if (script === 'expose-lantern') {
		return firstLegalDestination(state, seat, catalog, ['Lantern Canyon']) ??
			plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	if (script === 'restore-loop') {
		if (needsRestore) return firstLegalDestination(state, seat, catalog, RESTORE_OPTION_DESTINATIONS) ?? abyss;
		if (cleanProb >= 0.35 || firepowerProb >= 0.35) return abyss ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
		return plannerNavigationCommand(state, seat, catalog, cfg, seed);
		}
		if (script === 'max-barrier-loop') {
			const counts = awakenedClassCounts(player);
			const conversion = hp4ConversionNeed(state, seat, catalog);
			if (conversion.needCultivatorTicket) {
				return firstLegalDestination(
					state,
					seat,
					catalog,
					conversion.hasRelic ? ['Tidal Cove'] : ['Tidal Cove', 'Cyber City']
				) ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
			}
			if (conversion.needCultivate) {
				return firstLegalDestination(state, seat, catalog, ['Lantern Canyon', 'Tidal Cove', 'Cyber City']) ??
					plannerNavigationCommand(state, seat, catalog, cfg, seed);
			}
			if (needsMaxBarrier || (counts.Cultivator ?? 0) < 2) {
				const destinations: NavigationDestination[] = (counts.Cultivator ?? 0) >= 2
					? ['Lantern Canyon', 'Tidal Cove', 'Cyber City']
					: ['Tidal Cove', 'Cyber City'];
				return firstLegalDestination(state, seat, catalog, destinations) ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
			}
			return abyss ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
		}
	if (script === 'damage-assembly') {
		if (needsDamage) {
			return firstLegalDestination(state, seat, catalog, CLOSER_DAMAGE_DESTINATIONS) ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
		}
		return abyss ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	if (script === 'hp4-survival-oracle') {
		return hp4SurvivalOracleNavigation(state, seat, catalog, cfg, seed);
	}
	if (script === 'finish-line-oracle') {
		return finishLineOracleNavigation(state, seat, catalog, cfg, seed);
	}
	if (script === 'fixed-reentry') {
		if (navigationDecisions >= cfg.reentryBuildSteps) return abyss ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
		if (needsDamage) return firstLegalDestination(state, seat, catalog, CLOSER_DAMAGE_DESTINATIONS) ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
		if (needsRestore) return firstLegalDestination(state, seat, catalog, CLOSER_RESTORE_DESTINATIONS) ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
		if (needsMaxBarrier) return firstLegalDestination(state, seat, catalog, CLOSER_MAX_BARRIER_DESTINATIONS) ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
		return firstLegalDestination(state, seat, catalog, BUILD_OPTION_DESTINATIONS) ?? plannerNavigationCommand(state, seat, catalog, cfg, seed);
	}
	return plannerNavigationCommand(state, seat, catalog, cfg, seed);
}

function filterTargetPlan(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, plan: GameCommand[], cfg: Config): GameCommand[] {
	if (!cfg.forbidTypes?.size && cfg.maxStatusLevel === undefined) return plan;
	const out: GameCommand[] = [];
	let probeState = state;
	for (const cmd of plan) {
		if (cfg.forbidTypes?.has(cmd.type)) continue;
		const probe = applyGameCommand(probeState, botActorFor(probeState, seat), cmd, catalog);
		if (!probe.ok) continue;
		if (cfg.maxStatusLevel !== undefined && (probe.state.players[seat]?.statusLevel ?? 0) > cfg.maxStatusLevel) continue;
		out.push(cmd);
		probeState = probe.state;
	}
	return out;
}

function microDecisionSet(
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[],
	cfg: Config
): { policy: NeuralPolicy; withNext: LegalAction[]; indexMap?: number[] } {
	const gate = cfg.microPolicyGate;
	const navDestination = state.players[seat]?.navigationDestination;
	const abyssScoped = gate === 'abyss-round' || gate === 'abyss-farm-actions' || gate === 'abyss-reward-actions' || gate === 'abyss-farm-overlay';
	const useMicro = !!cfg.microPolicy && (
		gate === 'all' ||
		(gate === 'location-interactions' && state.phase === 'location') ||
		(abyssScoped && navDestination === 'Arcane Abyss')
	);
	if (!useMicro || !cfg.microPolicy || gate === 'abyss-farm-overlay') return { policy: cfg.plannerPolicy, withNext };
	if (gate !== 'abyss-farm-actions' && gate !== 'abyss-reward-actions' && gate !== 'location-interactions') {
		return { policy: cfg.microPolicy, withNext };
	}
	const allowedTypes = gate === 'abyss-reward-actions'
		? REWARD_ACTION_TYPES
		: gate === 'location-interactions'
			? new Set<GameCommand['type']>(['resolveLocationInteraction'])
			: FARM_ACTION_TYPES;
	const indexMap: number[] = [];
	const filtered: LegalAction[] = [];
	for (let i = 0; i < withNext.length; i++) {
		if (!allowedTypes.has(withNext[i].cmd.type)) continue;
		indexMap.push(i);
		filtered.push(withNext[i]);
	}
	return filtered.length > 0 ? { policy: cfg.microPolicy, withNext: filtered, indexMap } : { policy: cfg.plannerPolicy, withNext };
}

function cultivatorProgress(
	player: PublicGameState['players'][SeatColor] | undefined,
	catalog: PlayCatalog
): number {
	if (!player) return 0;
	const counts = awakenedClassCounts(player);
	const pending = pendingAugmentClassCounts(player, catalog);
	return (counts.Cultivator ?? 0) + (pending.Cultivator ?? 0);
}

function chooseHp4ConversionOracleAction(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[]
): { action: LegalAction; index: number } | null {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster) return null;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	if (monsterHp < 4 || monsterHp > 5) return null;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold: 0.5 });
	if (!farm.valid || farm.rewardVp <= 0 || (player.victoryPoints ?? 0) < 3) return null;

	const survivalTarget = (monster.damage ?? 0) + 1;
	const beforeBarrier = player.barrier ?? 0;
	const beforeMaxBarrier = player.maxBarrier ?? 0;
	const beforeRelics = heldRelicCount(player);
	const beforeCultivatorProgress = cultivatorProgress(player, catalog);
	const beforeClean = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const beforeFirepower = firepowerKillProbability(state, seat, catalog);
	const beforeAttack = expectedAttack(player);
	const damageReady = beforeClean >= 0.5 || beforeFirepower >= 0.5 || beforeAttack >= monsterHp - 0.01;
	const survivalReady = survivalTarget <= 0 || beforeBarrier >= survivalTarget;
	const needsCultivatorTicket =
		survivalTarget > 0 &&
		beforeMaxBarrier < survivalTarget &&
		beforeCultivatorProgress < 2;
	const needsCultivate =
		survivalTarget > 0 &&
		beforeMaxBarrier < survivalTarget &&
		(awakenedClassCounts(player).Cultivator ?? 0) >= 2;
	const needsRestore =
		survivalTarget > 0 &&
		beforeMaxBarrier >= survivalTarget &&
		beforeBarrier < survivalTarget;

	if (!needsCultivatorTicket && !needsCultivate && !needsRestore && !(damageReady && survivalReady)) return null;

	let best: { action: LegalAction; index: number; score: number } | null = null;
	for (let index = 0; index < withNext.length; index++) {
		const action = withNext[index];
		const after = action.next.players[seat];
		if (!after) continue;
		let score = routeBreakpointActionScore(state, seat, catalog, action, {
			cleanThreshold: 0.5,
			firepowerThreshold: 0.5
		});
		const afterCultivatorProgress = cultivatorProgress(after, catalog);
		const cultivatorDelta = afterCultivatorProgress - beforeCultivatorProgress;
		const afterRelics = heldRelicCount(after);
		const afterBarrier = after.barrier ?? 0;
		const afterMaxBarrier = after.maxBarrier ?? 0;
		const interaction = locationInteractionForAction(state, seat, catalog, action);
		const vpDelta = (after.victoryPoints ?? 0) - (player.victoryPoints ?? 0);

		if (vpDelta > 0) score += 12_000 + vpDelta * 12_000;
		if (action.cmd.type === 'resolveMonsterReward') score += 20_000;
		if (action.cmd.type === 'startCombat') {
			const killed = action.next.combats.some((combat) => (
				combat.kind === 'monster' &&
				combat.sides[0]?.seat === seat &&
				combat.killed
			));
			score += killed && damageReady && survivalReady ? 35_000 : -18_000;
		}

		if (needsCultivatorTicket) {
			if (cultivatorDelta > 0) score += 70_000 + cultivatorDelta * 20_000;
			if (interactionCanGrantClass(interaction, catalog, 'Cultivator')) score += 25_000;
			if (interactionCostsRelic(interaction) && afterRelics < beforeRelics && cultivatorDelta <= 0) score -= 80_000;
			if (action.cmd.type === 'placeAugmentOnSpirit' && cultivatorDelta > 0) score += 50_000;
			if (action.cmd.type === 'spawnHandSpirit' && cultivatorDelta > 0) score += 25_000;
		}

		if (needsCultivate) {
			if (interaction && afterMaxBarrier > beforeMaxBarrier) score += 65_000 + (afterMaxBarrier - beforeMaxBarrier) * 15_000;
			if (action.cmd.type === 'resolveLocationInteraction' && afterMaxBarrier <= beforeMaxBarrier) score -= 12_000;
		}

		if (needsRestore) {
			if (afterBarrier > beforeBarrier) score += 40_000 + (afterBarrier - beforeBarrier) * 8_000;
			if (action.cmd.type === 'resolveLocationInteraction' && afterBarrier <= beforeBarrier) score -= 8_000;
		}

		if (damageReady && survivalReady && action.cmd.type !== 'startCombat' && action.cmd.type !== 'resolveMonsterReward') {
			score -= 5_000;
		}

		if (!best || score > best.score) best = { action, index, score };
	}
	return best ? { action: best.action, index: best.index } : null;
}

function chooseTargetFullControlAction(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config,
	rng: ReturnType<typeof createRng>
): FullActionDecisionTrace | null {
	const unfilteredWithNext = legalActionsWithNext(state, seat, catalog);
	const withNext = filterPlannerActions(
		state,
		catalog,
		unfilteredWithNext,
		seat,
		cfg.forbidTypes,
		cfg.maxStatusLevel,
		true,
		cfg.preserveRouteFirepower,
		cfg.preserveRouteSurvival,
		0.5
	);
	if (withNext.length === 0) return null;
	const hp4ConversionChoice = chooseHp4ConversionOracleAction(state, seat, catalog, withNext);
	if (hp4ConversionChoice) {
		return {
			chosen: hp4ConversionChoice.action,
			withNext,
			chosenIdx: hp4ConversionChoice.index,
			pi: withNext.map((_, i) => (i === hp4ConversionChoice.index ? 1 : 0))
		};
	}
	if (cfg.rolloutPolicy === 'breakpoint-oracle') {
		const chosen = chooseRouteBreakpointOracleAction(state, seat, catalog, withNext, {
			cleanThreshold: 0.5,
			firepowerThreshold: 0.5
		});
		const chosenIdx = chosen ? withNext.indexOf(chosen) : 0;
		const idx = chosenIdx >= 0 ? chosenIdx : 0;
		return {
			chosen: withNext[idx],
			withNext,
			chosenIdx: idx,
			pi: withNext.map((_, i) => (i === idx ? 1 : 0))
		};
	}
	if (
		(cfg.routeFinishOracle || cfg.microPolicyGate === 'route-finish-oracle') &&
		isRouteCloserRestoreFinishState(state, seat, catalog)
	) {
		const chosen = chooseRouteFinishLoopOracleAction(state, seat, catalog, withNext, {
			cleanThreshold: 0.5,
			firepowerThreshold: 0.5
		});
		const chosenIdx = chosen ? withNext.indexOf(chosen) : 0;
		const idx = chosenIdx >= 0 ? chosenIdx : 0;
		return {
			chosen: withNext[idx],
			withNext,
			chosenIdx: idx,
			pi: withNext.map((_, i) => (i === idx ? 1 : 0))
		};
	}
	if (cfg.microPolicyGate === 'good-builder-hp4-oracle') {
		const chosen = chooseRouteBreakpointOracleAction(state, seat, catalog, withNext, {
			cleanThreshold: 0.5,
			firepowerThreshold: 0.5
		});
		const chosenIdx = chosen ? withNext.indexOf(chosen) : 0;
		const idx = chosenIdx >= 0 ? chosenIdx : 0;
		return {
			chosen: withNext[idx],
			withNext,
			chosenIdx: idx,
			pi: withNext.map((_, i) => (i === idx ? 1 : 0))
		};
	}
	if (cfg.microPolicyGate === 'good-builder-hp4-pick-oracle') {
		const filtered: { action: LegalAction; index: number }[] = [];
		for (let i = 0; i < withNext.length; i++) {
			if (GOOD_BUILDER_HP4_PICK_ACTION_TYPES.has(withNext[i].cmd.type)) {
				filtered.push({ action: withNext[i], index: i });
			}
		}
		if (filtered.length > 0) {
			const chosen = chooseRouteBreakpointOracleAction(
				state,
				seat,
				catalog,
				filtered.map((x) => x.action),
				{
					cleanThreshold: 0.5,
					firepowerThreshold: 0.5
				}
			);
			const idx = chosen
				? filtered.find((x) => x.action === chosen)?.index ?? filtered[0].index
				: filtered[0].index;
			return {
				chosen: withNext[idx],
				withNext,
				chosenIdx: idx,
				pi: withNext.map((_, i) => (i === idx ? 1 : 0))
			};
		}
	}
	if (cfg.microPolicyGate === 'good-builder-hp4-conversion-oracle' && cfg.plannerPolicy) {
		const mainDecision = chooseFullActionDecision(
			cfg.plannerPolicy,
			state,
			seat,
			withNext,
			catalog,
			cfg.rolloutFullSelection,
			FULL_LOOKAHEAD_DEPTH,
			FULL_LOOKAHEAD_BEAM,
			FULL_LOOKAHEAD_ROOT_BEAM,
			FULL_TARGET_TEMPERATURE,
			false,
			1,
			rng
		);
		const indexMap: number[] = [];
		const conversionActions: LegalAction[] = [];
		for (let i = 0; i < withNext.length; i++) {
			if (!GOOD_BUILDER_HP4_CONVERSION_ACTION_TYPES.has(withNext[i].cmd.type)) continue;
			indexMap.push(i);
			conversionActions.push(withNext[i]);
		}
		if (conversionActions.length > 0) {
			const scoreOpts = { cleanThreshold: 0.5, firepowerThreshold: 0.5 };
			const chosen = chooseRouteBreakpointOracleAction(
				state,
				seat,
				catalog,
				conversionActions,
				scoreOpts
			);
			const localIdx = chosen ? conversionActions.indexOf(chosen) : -1;
			const oracleIdx = localIdx >= 0 ? indexMap[localIdx] : indexMap[0];
			const mainScore = routeBreakpointActionScore(
				state,
				seat,
				catalog,
				withNext[mainDecision.idx],
				scoreOpts
			);
			const oracleScore = routeBreakpointActionScore(
				state,
				seat,
				catalog,
				withNext[oracleIdx],
				scoreOpts
			);
			if (oracleScore >= mainScore) {
				return {
					chosen: withNext[oracleIdx],
					withNext,
					chosenIdx: oracleIdx,
					pi: withNext.map((_, i) => (i === oracleIdx ? 1 : 0))
				};
			}
		}
		return {
			chosen: withNext[mainDecision.idx],
			withNext,
			chosenIdx: mainDecision.idx,
			pi: mainDecision.pi
		};
	}
	if (cfg.microPolicyGate === 'good-builder-hp4-conversion-overlay' && cfg.microPolicy) {
		const mainDecision = chooseFullActionDecision(
			cfg.plannerPolicy,
			state,
			seat,
			withNext,
			catalog,
			cfg.rolloutFullSelection,
			FULL_LOOKAHEAD_DEPTH,
			FULL_LOOKAHEAD_BEAM,
			FULL_LOOKAHEAD_ROOT_BEAM,
			FULL_TARGET_TEMPERATURE,
			false,
			1,
			rng
		);
		const indexMap: number[] = [];
		const conversionActions: LegalAction[] = [];
		for (let i = 0; i < withNext.length; i++) {
			if (!GOOD_BUILDER_HP4_CONVERSION_ACTION_TYPES.has(withNext[i].cmd.type)) continue;
			indexMap.push(i);
			conversionActions.push(withNext[i]);
		}
		if (conversionActions.length > 0) {
			const overlayDecision = chooseFullActionDecision(
				cfg.microPolicy,
				state,
				seat,
				conversionActions,
				catalog,
				cfg.rolloutFullSelection,
				FULL_LOOKAHEAD_DEPTH,
				FULL_LOOKAHEAD_BEAM,
				FULL_LOOKAHEAD_ROOT_BEAM,
				FULL_TARGET_TEMPERATURE,
				false,
				1,
				rng
			);
			const overlayIdx = indexMap[overlayDecision.idx] ?? mainDecision.idx;
			const scoreOpts = { cleanThreshold: 0.5, firepowerThreshold: 0.5 };
			const mainScore = routeBreakpointActionScore(
				state,
				seat,
				catalog,
				withNext[mainDecision.idx],
				scoreOpts
			);
			const overlayScore = routeBreakpointActionScore(
				state,
				seat,
				catalog,
				withNext[overlayIdx],
				scoreOpts
			);
			if (overlayScore >= mainScore) {
				return {
					chosen: withNext[overlayIdx],
					withNext,
					chosenIdx: overlayIdx,
					pi: withNext.map((_, i) => {
						const local = indexMap.indexOf(i);
						return local >= 0 ? (overlayDecision.pi[local] ?? 0) : 0;
					})
				};
			}
		}
		return {
			chosen: withNext[mainDecision.idx],
			withNext,
			chosenIdx: mainDecision.idx,
			pi: mainDecision.pi
		};
	}
	const decisionSet = microDecisionSet(state, seat, withNext, cfg);
		const decision = chooseFullActionDecision(
		decisionSet.policy,
		state,
		seat,
		decisionSet.withNext,
		catalog,
		cfg.rolloutFullSelection,
		FULL_LOOKAHEAD_DEPTH,
		FULL_LOOKAHEAD_BEAM,
		FULL_LOOKAHEAD_ROOT_BEAM,
		FULL_TARGET_TEMPERATURE,
		false,
		1,
		rng
	);
	const chosen = decisionSet.withNext[decision.idx];
	if (!chosen) return null;
	return {
		chosen,
		withNext: decisionSet.withNext,
		chosenIdx: decision.idx,
		pi: decision.pi
	};
}

function newMetrics(script: TraceScript, state: PublicGameState, seat: SeatColor, startRound: number): BranchMetrics {
	const build = buildOf(state, seat);
	return {
		script,
		finalVp: build.vp,
		finalStatus: build.status,
		kills: 0,
		combats: 0,
		cleanCombatOpportunities: 0,
		firepowerCombatOpportunities: 0,
		exposedGoodTargetWindows: 0,
		exposedGoodTargetVp: 0,
		bestExposedGoodTargetVp: 0,
		valuableGoodTargetWindows: 0,
		valuableGoodTargetVp: 0,
		bestValuableGoodTargetVp: 0,
		maxExpectedAttack: build.expectedAttack,
		maxBarrier: build.maxBarrier,
		maxCurrentBarrier: build.currentBarrier,
		maxAttackDice: build.attackDice,
		maxSpiritAnimal: build.spiritAnimal,
		maxCultivator: build.cultivator,
		rounds: state.round - startRound,
		navigationDecisions: 0,
		requestedHorizon: 0,
		rolloutEndRound: state.round,
		cappedByMaxRounds: false,
		snapshots: {}
	};
}

function recordBuild(metrics: BranchMetrics, state: PublicGameState, seat: SeatColor): void {
	const build = buildOf(state, seat);
	metrics.maxExpectedAttack = Math.max(metrics.maxExpectedAttack, build.expectedAttack);
	metrics.maxBarrier = Math.max(metrics.maxBarrier, build.maxBarrier);
	metrics.maxCurrentBarrier = Math.max(metrics.maxCurrentBarrier, build.currentBarrier);
	metrics.maxAttackDice = Math.max(metrics.maxAttackDice, build.attackDice);
	metrics.maxSpiritAnimal = Math.max(metrics.maxSpiritAnimal, build.spiritAnimal);
	metrics.maxCultivator = Math.max(metrics.maxCultivator, build.cultivator);
}

function snapshot(metrics: BranchMetrics, state: PublicGameState, seat: SeatColor, key: number): void {
	const build = buildOf(state, seat);
	metrics.snapshots[String(key)] = {
		...build,
		kills: metrics.kills,
		combats: metrics.combats,
		cleanCombatOpportunities: metrics.cleanCombatOpportunities,
		firepowerCombatOpportunities: metrics.firepowerCombatOpportunities,
		exposedGoodTargetWindows: metrics.exposedGoodTargetWindows,
		exposedGoodTargetVp: metrics.exposedGoodTargetVp,
		bestExposedGoodTargetVp: metrics.bestExposedGoodTargetVp,
		valuableGoodTargetWindows: metrics.valuableGoodTargetWindows,
		valuableGoodTargetVp: metrics.valuableGoodTargetVp,
		bestValuableGoodTargetVp: metrics.bestValuableGoodTargetVp,
		round: state.round
	};
}

function recordTargetExposure(
	metrics: BranchMetrics,
	state: PublicGameState,
	seat: SeatColor,
	cfg: Config,
	seen: Set<string>
): void {
	const player = state.players[seat];
	const destination = player?.navigationDestination;
	const monsterHp = state.monster?.maxHp ?? state.monster?.hp ?? 0;
	const vp = player?.victoryPoints ?? 0;
	if (
		!player ||
		!destination ||
		destination === 'Arcane Abyss' ||
		(player.statusLevel ?? 0) >= 3 ||
		vp < cfg.exposureMinVp ||
		monsterHp < cfg.exposureMinMonsterHp
	) {
		return;
	}
	const key = `${state.round}:${destination}:${vp}`;
	if (seen.has(key)) return;
	seen.add(key);
	metrics.exposedGoodTargetWindows++;
	metrics.exposedGoodTargetVp += vp;
	metrics.bestExposedGoodTargetVp = Math.max(metrics.bestExposedGoodTargetVp, vp);
	if (vp >= cfg.targetQualityMinVp) {
		metrics.valuableGoodTargetWindows++;
		metrics.valuableGoodTargetVp += vp;
		metrics.bestValuableGoodTargetVp = Math.max(metrics.bestValuableGoodTargetVp, vp);
	}
}

function recordCombatOpportunity(metrics: BranchMetrics, state: PublicGameState, seat: SeatColor, catalog: PlayCatalog): void {
	if (!legalActionsWithNext(state, seat, catalog).some((x) => x.cmd.type === 'startCombat')) return;
	if (computeKillProbability(state, seat, catalog, { allowCorruptKill: false }) >= 0.5) metrics.cleanCombatOpportunities++;
	if (firepowerKillProbability(state, seat, catalog) >= 0.5) metrics.firepowerCombatOpportunities++;
}

function rolloutScript(
	initial: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	profileBySeat: Record<string, BotProfile>,
	cfg: Config,
	seed: number,
	script: TraceScript,
	startRound: number
): TraceBranch {
	let state = cloneState(initial);
	const maxHorizon = Math.max(...cfg.horizons);
	const rolloutEndRound = Math.min(cfg.maxRounds, startRound + maxHorizon);
	const rng = seededBotRandom(seed);
	const fullActionRng = createRng((seed ^ 0x51a7e123) >>> 0 || 1);
	const metrics = newMetrics(script, state, seat, startRound);
	metrics.requestedHorizon = maxHorizon;
	metrics.rolloutEndRound = rolloutEndRound;
	metrics.cappedByMaxRounds = rolloutEndRound < startRound + maxHorizon;
	const fullSamples: Sample[] = [];
	const fullSampleTypes: Record<string, number> = {};
	const actionCounter = new Map<string, number>();
	const exposureKeys = new Set<string>();
	let ticks = 0;
	while (state.status === 'active' && state.round < rolloutEndRound && ticks++ < MAX_TICKS) {
		let progressed = false;
		for (const activeSeat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, activeSeat)) continue;
			const key = `${activeSeat}:${state.round}:${state.phase}`;
			const used = actionCounter.get(key) ?? 0;
			if (used >= MAX_ACTIONS_PER_PHASE) continue;
			if (activeSeat === seat) recordCombatOpportunity(metrics, state, seat, catalog);
			if (activeSeat === seat && state.phase === 'navigation') {
				const nav = scriptedNavigationCommand(
					state,
					activeSeat,
					catalog,
					cfg,
					script,
					metrics.navigationDecisions,
					32_100_000 + seed + state.round * 31 + ticks
				);
				if (nav) {
					const r = applyGameCommand(state, botActorFor(state, activeSeat), nav, catalog, { mutate: true });
					if (r.ok) {
						state = r.state;
						progressed = true;
						actionCounter.set(key, used + 1);
						metrics.navigationDecisions++;
						recordBuild(metrics, state, seat);
						recordTargetExposure(metrics, state, seat, cfg, exposureKeys);
					}
					if (state.status !== 'active' || state.round >= rolloutEndRound) break;
					continue;
				}
			}
			if (activeSeat === seat) {
				const decision = chooseTargetFullControlAction(state, activeSeat, catalog, cfg, fullActionRng);
				if (decision) {
					const chosen = decision.chosen;
					if (
						decision.withNext.length > 1 &&
						(!cfg.fullSampleTypes?.size || cfg.fullSampleTypes.has(chosen.cmd.type))
					) {
							fullSamples.push({
								obs: encodeObs(state, activeSeat, catalog),
								cands: decision.withNext.map((x) => encodeAction(state, activeSeat, x.cmd, x.next, catalog)),
								chosen: decision.chosenIdx,
							pi: decision.pi,
							ret: 0,
							seat: activeSeat,
							vp: state.players[activeSeat]?.victoryPoints ?? 0,
							phi: 0,
							kill: chosen.cmd.type === 'resolveMonsterReward' ? 1 : 0,
							...sampleAuxTargets(state, activeSeat, catalog, decision.withNext)
						});
						addCount(fullSampleTypes, chosen.cmd.type);
					}
					state = chosen.next;
					progressed = true;
					actionCounter.set(key, used + 1);
					recordBuild(metrics, state, seat);
					recordTargetExposure(metrics, state, seat, cfg, exposureKeys);
					if (chosen.cmd.type === 'startCombat') {
						metrics.combats++;
						const combat = state.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === seat);
						if (combat?.killed) metrics.kills++;
					}
					for (const h of cfg.horizons) {
						if (state.round >= startRound + h && metrics.snapshots[String(h)] === undefined) snapshot(metrics, state, seat, h);
					}
					if (state.status !== 'active' || state.round >= rolloutEndRound) break;
					continue;
				}
			}
			let plan = planBotPhaseActions(state, activeSeat, catalog, rng, profileBySeat[activeSeat]);
			if (activeSeat === seat) plan = filterTargetPlan(state, activeSeat, catalog, plan, cfg);
			for (const cmd of plan) {
				const r = applyGameCommand(state, botActorFor(state, activeSeat), cmd, catalog, { mutate: true });
				if (!r.ok) break;
				state = r.state;
				progressed = true;
				actionCounter.set(key, used + 1);
				if (activeSeat === seat) {
					recordBuild(metrics, state, seat);
					recordTargetExposure(metrics, state, seat, cfg, exposureKeys);
					if (cmd.type === 'startCombat') {
						metrics.combats++;
						const combat = state.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === seat);
						if (combat?.killed) metrics.kills++;
					}
				}
				for (const h of cfg.horizons) {
					if (state.round >= startRound + h && metrics.snapshots[String(h)] === undefined) snapshot(metrics, state, seat, h);
				}
				if (state.status !== 'active' || state.round >= rolloutEndRound) break;
			}
			if (state.status !== 'active' || state.round >= rolloutEndRound) break;
		}
		if (state.status !== 'active' || state.round >= rolloutEndRound) break;
		if (!progressed) {
			const sig = `${state.phase}:${state.round}`;
			applyDeadlineAdvance(state, catalog);
			recordBuild(metrics, state, seat);
			recordTargetExposure(metrics, state, seat, cfg, exposureKeys);
			if (`${state.phase}:${state.round}` === sig) break;
		}
	}
	for (const h of cfg.horizons) if (metrics.snapshots[String(h)] === undefined) snapshot(metrics, state, seat, h);
	metrics.finalVp = state.players[seat]?.victoryPoints ?? 0;
	metrics.finalStatus = state.players[seat]?.statusLevel ?? 0;
	metrics.rounds = state.round - startRound;
	const finalRet = clamp01(Math.max(initial.players[seat]?.victoryPoints ?? 0, metrics.finalVp) / VP_TO_WIN);
	for (const sample of fullSamples) sample.ret = finalRet;
	return { metrics, fullSamples, fullSampleTypes };
}

function snapAt(metrics: BranchMetrics, horizon: number): BuildSnapshot {
	return metrics.snapshots[String(horizon)] ?? {
		vp: metrics.finalVp,
		status: metrics.finalStatus,
		expectedAttack: metrics.maxExpectedAttack,
		maxBarrier: metrics.maxBarrier,
		currentBarrier: metrics.maxCurrentBarrier,
		attackDice: metrics.maxAttackDice,
		spiritAnimal: metrics.maxSpiritAnimal,
		cultivator: metrics.maxCultivator,
		kills: metrics.kills,
		combats: metrics.combats,
		cleanCombatOpportunities: metrics.cleanCombatOpportunities,
		firepowerCombatOpportunities: metrics.firepowerCombatOpportunities,
		exposedGoodTargetWindows: metrics.exposedGoodTargetWindows,
		exposedGoodTargetVp: metrics.exposedGoodTargetVp,
		bestExposedGoodTargetVp: metrics.bestExposedGoodTargetVp,
		valuableGoodTargetWindows: metrics.valuableGoodTargetWindows,
		valuableGoodTargetVp: metrics.valuableGoodTargetVp,
		bestValuableGoodTargetVp: metrics.bestValuableGoodTargetVp,
		round: 0
	};
}

function branchScore(metrics: BranchMetrics, horizon: number, cfg: Config): number {
	const snap = snapAt(metrics, horizon);
	return (
		snap.vp * cfg.scoreVpWeight +
		snap.kills * cfg.scoreKillWeight +
		snap.cleanCombatOpportunities * cfg.scoreCleanOpportunityWeight +
		snap.firepowerCombatOpportunities * cfg.scoreFirepowerOpportunityWeight +
		snap.expectedAttack * cfg.scoreExpectedAttackWeight +
		snap.attackDice * cfg.scoreAttackDiceWeight +
		snap.spiritAnimal * cfg.scoreSpiritAnimalWeight +
		snap.cultivator * cfg.scoreCultivatorWeight +
		snap.maxBarrier * cfg.scoreBarrierWeight +
		snap.currentBarrier * cfg.scoreCurrentBarrierWeight +
		snap.exposedGoodTargetWindows * cfg.scoreExposureWindowWeight +
		snap.exposedGoodTargetVp * cfg.scoreExposureVpWeight +
		snap.bestExposedGoodTargetVp * cfg.scoreExposureBestVpWeight +
		snap.valuableGoodTargetWindows * cfg.scoreTargetQualityWindowWeight +
		snap.valuableGoodTargetVp * cfg.scoreTargetQualityVpWeight +
		snap.bestValuableGoodTargetVp * cfg.scoreTargetQualityBestVpWeight +
		(snap.vp >= VP_TO_WIN ? cfg.scoreReach30Bonus : 0) -
		snap.status * cfg.scoreStatusPenalty
	);
}

function windowMatches(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, cfg: Config): boolean {
	if (state.phase !== 'navigation') return false;
	const build = buildOf(state, seat);
	if (cfg.maxStatusLevel !== undefined && build.status > cfg.maxStatusLevel) return false;
	if (build.vp < cfg.minPlayerVp || build.vp > cfg.maxPlayerVp) return false;
	if (state.round < cfg.minRound) return false;
	if (cfg.maxRound !== undefined && state.round > cfg.maxRound) return false;
	const monster = monsterSignal(state, seat, catalog);
	if (monster.monsterHp < cfg.minMonsterHp) return false;
	if (cfg.maxMonsterHp !== undefined && monster.monsterHp > cfg.maxMonsterHp) return false;
	if (monster.cleanKillProb < cfg.minCleanKillProb) return false;
	if (cfg.maxCleanKillProb !== undefined && monster.cleanKillProb > cfg.maxCleanKillProb) return false;
	if (monster.firepowerKillProb < cfg.minFirepowerKillProb) return false;
	if (cfg.maxFirepowerKillProb !== undefined && monster.firepowerKillProb > cfg.maxFirepowerKillProb) return false;
	return true;
}

function addCount(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

function topN(counts: Record<string, number>, n: number): Record<string, number> {
	return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n));
}

function legalDestinationStrings(ctx: NavigationProbeContext): string[] {
	return ctx.destinations.map((d) => String(d));
}

function clamp01(x: number): number {
	return Math.max(0, Math.min(1, x));
}

function legalNavigationBranches(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, cfg: Config): LegalAction[] {
	if (state.phase !== 'navigation') return [];
	return filterPlannerActions(
		state,
		catalog,
		legalActionsWithNext(state, seat, catalog).filter((x) => x.cmd.type === 'lockNavigation'),
		seat,
		cfg.forbidTypes,
		cfg.maxStatusLevel,
		true,
		cfg.preserveRouteFirepower,
		cfg.preserveRouteSurvival,
		0.5
	);
}

function recordNavigationSample(
	samples: Sample[],
	window: CapturedWindow,
	cfg: Config,
	bestScript: TraceScript,
	bestMetrics: BranchMetrics
): NavigationSampleResult {
	const branches = legalNavigationBranches(window.state, window.seat, window.catalog, cfg);
	if (branches.length <= 1) return { recorded: false, skipReason: 'too-few-branches' };
	const target = scriptedNavigationCommand(
		window.state,
		window.seat,
		window.catalog,
		cfg,
		bestScript,
		0,
		52_200_000 + window.game * 997 + window.round
	);
	if (!target) return { recorded: false, skipReason: 'no-script-target' };
	if (target.type !== 'lockNavigation') return { recorded: false, skipReason: `non-navigation-target:${target.type}` };
	const chosen = branches.findIndex((x) => commandMatches(x.cmd, target));
	if (chosen < 0) return { recorded: false, skipReason: `target-not-in-filtered-branches:${target.destination}` };
	const snap = snapAt(bestMetrics, cfg.labelHorizon);
	const currentVp = window.state.players[window.seat]?.victoryPoints ?? 0;
	samples.push({
		obs: encodeObs(window.state, window.seat, window.catalog),
		cands: branches.map((branch) => encodeAction(window.state, window.seat, branch.cmd, branch.next, window.catalog)),
		chosen,
		pi: branches.map((_, i) => (i === chosen ? 1 : 0)),
		ret: clamp01(Math.max(currentVp, snap.vp) / VP_TO_WIN),
		seat: window.seat,
		vp: currentVp,
		phi: 0,
		kill: 0,
		...sampleAuxTargets(window.state, window.seat, window.catalog, branches)
	});
	return { recorded: true, destination: target.destination };
}

function recordWindow(
	window: CapturedWindow,
	cfg: Config,
	sourceFinalVp: number,
	rows: WindowRow[],
	bestScripts: Record<string, number>,
	correctionScripts: Record<string, number>,
	fullSampleTypes: Record<string, number>,
	navigationSampleDestinations: Record<string, number>,
	navigationSampleSkips: Record<string, number>,
	samples: Sample[]
): void {
	const branches = cfg.scripts.map((script, i) => rolloutScript(
		window.state,
		window.seat,
		window.catalog,
		window.profileBySeat,
		cfg,
		41_300_000 + window.game * 10_000 + rows.length * 100 + i,
		script,
		window.round
	));
	const metrics = branches.map((branch) => branch.metrics);
	let policyIdx = Math.max(0, cfg.scripts.indexOf('policy'));
	let bestIdx = policyIdx;
	for (let i = 0; i < metrics.length; i++) {
		if (branchScore(metrics[i], cfg.labelHorizon, cfg) > branchScore(metrics[bestIdx], cfg.labelHorizon, cfg)) bestIdx = i;
	}
	const policyMetrics = metrics[policyIdx] ?? metrics[0];
	if (cfg.scripts[policyIdx] !== 'policy') policyIdx = 0;
	const bestMetrics = metrics[bestIdx];
	const policySnap = snapAt(policyMetrics, cfg.labelHorizon);
	const bestSnap = snapAt(bestMetrics, cfg.labelHorizon);
	const policyScore = branchScore(policyMetrics, cfg.labelHorizon, cfg);
	const bestScore = branchScore(bestMetrics, cfg.labelHorizon, cfg);
	const scoreDelta = +(bestScore - policyScore).toFixed(2);
	const vpDelta = +(bestSnap.vp - policySnap.vp).toFixed(2);
	const statusDelta = +(bestSnap.status - policySnap.status).toFixed(2);
	const reach30Delta = (bestSnap.vp >= VP_TO_WIN ? 1 : 0) - (policySnap.vp >= VP_TO_WIN ? 1 : 0);
	const exposureWindowDelta = bestSnap.exposedGoodTargetWindows - policySnap.exposedGoodTargetWindows;
	const exposureVpDelta = +(bestSnap.exposedGoodTargetVp - policySnap.exposedGoodTargetVp).toFixed(2);
	const exposureBestVpDelta = +(bestSnap.bestExposedGoodTargetVp - policySnap.bestExposedGoodTargetVp).toFixed(2);
	const targetQualityWindowDelta = bestSnap.valuableGoodTargetWindows - policySnap.valuableGoodTargetWindows;
	const targetQualityVpDelta = +(bestSnap.valuableGoodTargetVp - policySnap.valuableGoodTargetVp).toFixed(2);
	const targetQualityBestVpDelta = +(bestSnap.bestValuableGoodTargetVp - policySnap.bestValuableGoodTargetVp).toFixed(2);
	const bestScript = metrics[bestIdx].script;
	const exposureDeltaPositive =
		exposureWindowDelta > 0 ||
		exposureVpDelta > 0 ||
		exposureBestVpDelta > 0;
	const targetQualityDeltaPositive =
		targetQualityWindowDelta > 0 ||
		targetQualityVpDelta > 0 ||
		targetQualityBestVpDelta > 0;
	const traceCorrection =
		bestScript !== 'policy' &&
		scoreDelta >= cfg.labelScoreThreshold &&
		vpDelta >= cfg.labelVpThreshold &&
		statusDelta <= cfg.labelStatusTolerance &&
		(!cfg.requireExposureDelta || exposureDeltaPositive) &&
		(!cfg.requireTargetQualityDelta || targetQualityDeltaPositive);
	const build = buildOf(window.state, window.seat);
	const monster = monsterSignal(window.state, window.seat, window.catalog);
	addCount(bestScripts, bestScript);
	if (traceCorrection) addCount(correctionScripts, bestScript);
	if (cfg.dataOut && (!cfg.positiveOnlyData || traceCorrection) && (cfg.sampleMode === 'navigation' || cfg.sampleMode === 'both')) {
		const sampleResult = recordNavigationSample(samples, window, cfg, bestScript, bestMetrics);
		if (sampleResult.recorded && sampleResult.destination) {
			addCount(navigationSampleDestinations, sampleResult.destination);
		} else {
			addCount(navigationSampleSkips, sampleResult.skipReason ?? 'unknown');
		}
	}
	if (cfg.dataOut && traceCorrection && (cfg.sampleMode === 'full' || cfg.sampleMode === 'both')) {
		const bestFullSamples = branches[bestIdx]?.fullSamples ?? [];
		samples.push(...bestFullSamples);
		for (const [type, count] of Object.entries(branches[bestIdx]?.fullSampleTypes ?? {})) {
			fullSampleTypes[type] = (fullSampleTypes[type] ?? 0) + count;
		}
	}
	rows.push({
		id: `g${window.game}-${window.seat}-r${window.round}-${rows.length}`,
		game: window.game,
		seat: window.seat,
		sourceFinalVp,
		round: window.round,
		playerVp: build.vp,
		playerStatus: build.status,
		playerExpectedAttack: +build.expectedAttack.toFixed(2),
		playerMaxBarrier: build.maxBarrier,
		playerCurrentBarrier: build.currentBarrier,
		playerAttackDice: build.attackDice,
		playerSpiritAnimal: build.spiritAnimal,
		playerCultivator: build.cultivator,
		monsterHp: monster.monsterHp,
		monsterDamage: monster.monsterDamage,
		monsterLives: monster.monsterLives,
		cleanKillProb: +monster.cleanKillProb.toFixed(3),
		firepowerKillProb: +monster.firepowerKillProb.toFixed(3),
		sourceDestination: window.sourceDestination,
		legalDestinations: window.legalDestinations,
		bestScript,
		policyScore: +policyScore.toFixed(2),
		bestScore: +bestScore.toFixed(2),
		traceQDeltaScore: scoreDelta,
		traceQDeltaVp: vpDelta,
		traceQDeltaStatus: statusDelta,
		traceQDeltaReach30: reach30Delta,
		traceQDeltaExposureWindows: exposureWindowDelta,
		traceQDeltaExposureVp: exposureVpDelta,
		traceQDeltaBestExposureVp: exposureBestVpDelta,
		traceQDeltaTargetQualityWindows: targetQualityWindowDelta,
		traceQDeltaTargetQualityVp: targetQualityVpDelta,
		traceQDeltaBestTargetQualityVp: targetQualityBestVpDelta,
		traceCorrection,
		branches: metrics
	});
}

describe('trace-state counterfactual prover', () => {
	(RUN ? it : it.skip)(
		'replays scripted HP4 continuations from exact current-stack navigation states',
		async () => {
			const horizons = parseHorizons(process.env.TRACEQ_HORIZONS);
			const weights = process.env.TRACEQ_WEIGHTS ?? 'ml/meta_runs/aux-head-act52-medium-20260627T222453Z/best_policy.json';
			const patchNavWeights = process.env.TRACEQ_PATCH_NAV_WEIGHTS ?? 'ml/meta_runs/scalingq-hp2-survivaldeficit-160w-20260628T161431Z/best_policy.json';
			const patch2NavWeights = process.env.TRACEQ_PATCH2_NAV_WEIGHTS;
			const navWeights = process.env.TRACEQ_NAV_WEIGHTS ?? 'ml/meta_runs/routeq-nav-specialist-20260628T0305Z/best_policy.json';
			const scaleNavWeights = process.env.TRACEQ_SCALE_NAV_WEIGHTS ?? 'ml/meta_runs/scaleq-nav-20260628T0650Z/best_policy.json';
			const microWeights = process.env.TRACEQ_MICRO_WEIGHTS ?? 'ml/meta_runs/routeexecq-fullcontrol-micro-20260628T0600Z/best_policy.json';
			const cfg: Config = {
				games: parseInt(process.env.TRACEQ_GAMES ?? '4', 10),
				seatsN: parseInt(process.env.TRACEQ_SEATS ?? '4', 10),
				maxRounds: parseInt(process.env.TRACEQ_MAXROUNDS ?? '30', 10),
				maxWindows: parseInt(process.env.TRACEQ_MAX_WINDOWS ?? '24', 10),
				horizons,
				labelHorizon: parseInt(process.env.TRACEQ_LABEL_HORIZON ?? String(horizons[horizons.length - 1]), 10),
				minSourceVp: parseFloat(process.env.TRACEQ_MIN_SOURCE_VP ?? '0'),
				maxSourceVp: parseFloat(process.env.TRACEQ_MAX_SOURCE_VP ?? '24'),
				minPlayerVp: parseFloat(process.env.TRACEQ_MIN_PLAYER_VP ?? '9'),
				maxPlayerVp: parseFloat(process.env.TRACEQ_MAX_PLAYER_VP ?? '24'),
				minRound: parseInt(process.env.TRACEQ_MIN_ROUND ?? '8', 10),
				maxRound: parseOptionalNumber(process.env.TRACEQ_MAX_ROUND),
				sourceDestination: process.env.TRACEQ_SOURCE_DESTINATION?.trim() || undefined,
				minMonsterHp: parseFloat(process.env.TRACEQ_MIN_MONSTER_HP ?? '4'),
				maxMonsterHp: parseOptionalNumber(process.env.TRACEQ_MAX_MONSTER_HP),
				minCleanKillProb: parseFloat(process.env.TRACEQ_MIN_CLEAN_KILL_PROB ?? '0'),
				maxCleanKillProb: parseOptionalNumber(process.env.TRACEQ_MAX_CLEAN_KILL_PROB ?? '0.5'),
				minFirepowerKillProb: parseFloat(process.env.TRACEQ_MIN_FIREPOWER_KILL_PROB ?? '0'),
				maxFirepowerKillProb: parseOptionalNumber(process.env.TRACEQ_MAX_FIREPOWER_KILL_PROB),
				reentryBuildSteps: parseInt(process.env.TRACEQ_REENTRY_BUILD_STEPS ?? '2', 10),
				scoreReach30Bonus: parseFloat(process.env.TRACEQ_SCORE_REACH30_BONUS ?? '12'),
				scoreVpWeight: parseFloat(process.env.TRACEQ_SCORE_VP_WEIGHT ?? '1'),
				scoreKillWeight: parseFloat(process.env.TRACEQ_SCORE_KILL_WEIGHT ?? '0.5'),
				scoreCleanOpportunityWeight: parseFloat(process.env.TRACEQ_SCORE_CLEAN_OPPORTUNITY_WEIGHT ?? '2'),
				scoreFirepowerOpportunityWeight: parseFloat(process.env.TRACEQ_SCORE_FIREPOWER_OPPORTUNITY_WEIGHT ?? '0.5'),
				scoreExpectedAttackWeight: parseFloat(process.env.TRACEQ_SCORE_EXPECTED_ATTACK_WEIGHT ?? '1.2'),
				scoreAttackDiceWeight: parseFloat(process.env.TRACEQ_SCORE_ATTACK_DICE_WEIGHT ?? '0.8'),
				scoreSpiritAnimalWeight: parseFloat(process.env.TRACEQ_SCORE_SPIRIT_ANIMAL_WEIGHT ?? '0.8'),
				scoreCultivatorWeight: parseFloat(process.env.TRACEQ_SCORE_CULTIVATOR_WEIGHT ?? '0.4'),
				scoreBarrierWeight: parseFloat(process.env.TRACEQ_SCORE_BARRIER_WEIGHT ?? '0.4'),
				scoreCurrentBarrierWeight: parseFloat(process.env.TRACEQ_SCORE_CURRENT_BARRIER_WEIGHT ?? '1'),
				scoreExposureWindowWeight: parseFloat(process.env.TRACEQ_SCORE_EXPOSURE_WINDOW_WEIGHT ?? '0'),
				scoreExposureVpWeight: parseFloat(process.env.TRACEQ_SCORE_EXPOSURE_VP_WEIGHT ?? '0'),
				scoreExposureBestVpWeight: parseFloat(process.env.TRACEQ_SCORE_EXPOSURE_BEST_VP_WEIGHT ?? '0'),
				scoreTargetQualityWindowWeight: parseFloat(process.env.TRACEQ_SCORE_TARGET_QUALITY_WINDOW_WEIGHT ?? '0'),
				scoreTargetQualityVpWeight: parseFloat(process.env.TRACEQ_SCORE_TARGET_QUALITY_VP_WEIGHT ?? '0'),
				scoreTargetQualityBestVpWeight: parseFloat(process.env.TRACEQ_SCORE_TARGET_QUALITY_BEST_VP_WEIGHT ?? '0'),
				exposureMinVp: parseFloat(process.env.TRACEQ_EXPOSURE_MIN_VP ?? '12'),
				exposureMinMonsterHp: parseFloat(process.env.TRACEQ_EXPOSURE_MIN_MONSTER_HP ?? '4'),
				targetQualityMinVp: parseFloat(process.env.TRACEQ_TARGET_QUALITY_MIN_VP ?? '18'),
				requireExposureDelta: (process.env.TRACEQ_REQUIRE_EXPOSURE_DELTA ?? '0') === '1',
				requireTargetQualityDelta: (process.env.TRACEQ_REQUIRE_TARGET_QUALITY_DELTA ?? '0') === '1',
				scoreStatusPenalty: parseFloat(process.env.TRACEQ_SCORE_STATUS_PENALTY ?? '2'),
				labelScoreThreshold: parseFloat(process.env.TRACEQ_LABEL_SCORE_THRESHOLD ?? '0.5'),
				labelVpThreshold: parseFloat(process.env.TRACEQ_LABEL_VP_THRESHOLD ?? '0.5'),
				labelStatusTolerance: parseFloat(process.env.TRACEQ_LABEL_STATUS_TOLERANCE ?? '0'),
				profiles: (process.env.TRACEQ_PROFILES ?? 'pvphunter,medium,cultivator,survivor').split(',').map((s) => s.trim()).filter(Boolean),
				out: process.env.TRACEQ_OUT ?? mlPath('trace_state_counterfactual.json'),
				summaryOut: process.env.TRACEQ_SUMMARY ?? mlPath('trace_state_counterfactual_summary.json'),
				dataOut: process.env.TRACEQ_DATA_OUT,
				positiveOnlyData: (process.env.TRACEQ_POSITIVE_ONLY_DATA ?? '1') === '1',
				sampleMode: parseSampleMode(process.env.TRACEQ_SAMPLE_MODE),
				fullSampleTypes: parseForbidTypes(process.env.TRACEQ_FULL_SAMPLE_TYPES),
				forbidTypes: parseForbidTypes(process.env.TRACEQ_FORBID_TYPES ?? 'initiatePvp'),
				maxStatusLevel: parseOptionalStatusLevel(process.env.TRACEQ_MAX_STATUS_LEVEL, 0),
				plannerPolicy: loadPolicyForEval(weights),
				patchNavigationPolicy: patchNavWeights ? loadPolicyForEval(patchNavWeights) : undefined,
				patchNavigationPolicyGate: parseNavigationPolicyGate(process.env.TRACEQ_PATCH_NAV_GATE ?? 'hp2-survival-deficit', 'hp2-survival-deficit'),
				patch2NavigationPolicy: patch2NavWeights ? loadPolicyForEval(patch2NavWeights) : undefined,
				patch2NavigationPolicyGate: parseNavigationPolicyGate(process.env.TRACEQ_PATCH2_NAV_GATE, 'all'),
				navigationPolicy: navWeights ? loadPolicyForEval(navWeights) : undefined,
				navigationPolicyGate: parseNavigationPolicyGate(process.env.TRACEQ_NAV_GATE ?? 'unsafe-firepower-build-option', 'unsafe-firepower-build-option'),
				scalingNavigationPolicy: scaleNavWeights ? loadPolicyForEval(scaleNavWeights) : undefined,
				scalingNavigationPolicyGate: parseNavigationPolicyGate(process.env.TRACEQ_SCALE_NAV_GATE ?? 'route-option-scaling', 'route-option-scaling'),
				microPolicy: microWeights ? loadPolicyForEval(microWeights) : undefined,
				microPolicyGate: parseMicroPolicyGate(process.env.TRACEQ_MICRO_GATE ?? 'location-interactions'),
				preserveRouteFirepower: (process.env.TRACEQ_PRESERVE_ROUTE_FIREPOWER ?? '1') === '1',
				preserveRouteSurvival: (process.env.TRACEQ_PRESERVE_ROUTE_SURVIVAL ?? '1') === '1',
				plannerIterations: parseInt(process.env.TRACEQ_ITERS ?? '64', 10),
				plannerHorizon: parseInt(process.env.TRACEQ_PLANNER_HORIZON ?? '24', 10),
				plannerValueWeight: parseFloat(process.env.TRACEQ_VALUEW ?? '1'),
				progressEvery: parseInt(process.env.TRACEQ_PROGRESS_EVERY ?? '0', 10),
				sourceSeedBase: parseInt(process.env.TRACEQ_SOURCE_SEED_BASE ?? '6500000', 10),
					plannerProfile: process.env.TRACEQ_PLANNER_PROFILE ?? 'cultivator',
					rolloutPolicy: process.env.TRACEQ_ROLLOUT_POLICY === 'breakpoint-oracle' ? 'breakpoint-oracle' : 'policy',
					sourceFullSelection: parseFullActionSelection(process.env.TRACEQ_FULL_SELECTION, FULL_SELECTION),
					rolloutFullSelection: parseFullActionSelection(process.env.TRACEQ_ROLLOUT_FULL_SELECTION, FULL_SELECTION),
					routeFinishOracle: (process.env.TRACEQ_ROUTE_FINISH_ORACLE ?? '0') === '1',
				scripts: parseScripts(process.env.TRACEQ_SCRIPTS),
				weights,
				patchNavWeights,
				patch2NavWeights,
				navWeights,
				scaleNavWeights,
				microWeights
			};
			const catalog = await loadOrSnapshotCatalog();
			const n = Math.min(cfg.seatsN, SEAT_COLORS.length, catalog.guardians.length);
			const seatList = SEAT_COLORS.slice(0, n) as SeatColor[];
			const rows: WindowRow[] = [];
				const samples: Sample[] = [];
				const bestScripts: Record<string, number> = {};
				const correctionScripts: Record<string, number> = {};
				const fullSampleTypes: Record<string, number> = {};
				const navigationSampleDestinations: Record<string, number> = {};
				const navigationSampleSkips: Record<string, number> = {};
			let sourceGames = 0;
			let sourceVpSum = 0;
			let sourceReach30 = 0;
			let captured = 0;
			let skippedSourceVp = 0;
			let scannedWindows = 0;
			let filteredWindows = 0;
			if (cfg.dataOut) {
				mkdirSync(dirname(cfg.dataOut), { recursive: true });
				writeFileSync(cfg.dataOut, '');
			}

			for (let g = 0; g < cfg.games && rows.length < cfg.maxWindows; g++) {
				const plannerSeat = seatList[g % n];
				const profiles = seatList.map((seat, i) => {
					if (seat === plannerSeat) return profileFor(cfg.plannerProfile);
					return profileFor(cfg.profiles[(g + i) % cfg.profiles.length]);
				});
				const profileBySeat = Object.fromEntries(seatList.map((seat, i) => [seat, profiles[i]])) as Record<string, BotProfile>;
				const gameWindows: CapturedWindow[] = [];
				const result = playPlannerSelfPlayGame(catalog, {
					seed: cfg.sourceSeedBase + g,
					profiles,
					policy: cfg.plannerPolicy,
					patchNavigationPolicy: cfg.patchNavigationPolicy,
					patchNavigationPolicyGate: cfg.patchNavigationPolicyGate,
					patch2NavigationPolicy: cfg.patch2NavigationPolicy,
					patch2NavigationPolicyGate: cfg.patch2NavigationPolicyGate,
					navigationPolicy: cfg.navigationPolicy,
					navigationPolicyGate: cfg.navigationPolicyGate,
					scalingNavigationPolicy: cfg.scalingNavigationPolicy,
					scalingNavigationPolicyGate: cfg.scalingNavigationPolicyGate,
					microPolicy: cfg.microPolicy,
					microPolicyGate: cfg.microPolicyGate,
					plannerSeats: [plannerSeat],
					recordSeats: [],
					planner: { iterations: cfg.plannerIterations, horizon: cfg.plannerHorizon, valueWeight: cfg.plannerValueWeight, c: 1.5 },
					maxRounds: cfg.maxRounds,
					control: 'full',
					fullSelection: cfg.sourceFullSelection,
					fullLookaheadDepth: FULL_LOOKAHEAD_DEPTH,
					fullLookaheadBeam: FULL_LOOKAHEAD_BEAM,
					fullLookaheadRootBeam: FULL_LOOKAHEAD_ROOT_BEAM,
					fullTargetTemperature: FULL_TARGET_TEMPERATURE,
					forbidTypes: cfg.forbidTypes,
					maxStatusLevel: cfg.maxStatusLevel,
					hardConstraints: true,
					preserveRouteFirepower: cfg.preserveRouteFirepower,
					preserveRouteSurvival: cfg.preserveRouteSurvival,
					navigationProbe: (ctx: NavigationProbeContext) => {
						scannedWindows++;
						if (gameWindows.length + rows.length >= cfg.maxWindows) return;
						const sourceDestination = String(ctx.destinations[ctx.chosenIndex] ?? '<none>');
						if (cfg.sourceDestination && sourceDestination !== cfg.sourceDestination) {
							filteredWindows++;
							return;
						}
						if (!windowMatches(ctx.state, ctx.seat, ctx.catalog, cfg)) {
							filteredWindows++;
							return;
						}
						gameWindows.push({
							state: cloneState(ctx.state),
							seat: ctx.seat,
							catalog: ctx.catalog,
							game: g,
							round: ctx.state.round,
							sourceDestination,
							legalDestinations: legalDestinationStrings(ctx),
							profileBySeat
						});
					}
				});
				sourceGames++;
				const sourceVp = result.finalVP[plannerSeat] ?? 0;
				sourceVpSum += sourceVp;
				if (sourceVp >= VP_TO_WIN) sourceReach30++;
				if (sourceVp < cfg.minSourceVp || sourceVp > cfg.maxSourceVp) {
					skippedSourceVp += gameWindows.length;
					continue;
				}
				for (const window of gameWindows) {
					if (rows.length >= cfg.maxWindows) break;
					captured++;
						recordWindow(
							window,
							cfg,
							sourceVp,
							rows,
							bestScripts,
							correctionScripts,
							fullSampleTypes,
							navigationSampleDestinations,
							navigationSampleSkips,
							samples
						);
				}
				if (cfg.progressEvery > 0 && (g + 1) % cfg.progressEvery === 0) {
					/* eslint-disable-next-line no-console */
					console.log(`[traceq] progress games=${g + 1}/${cfg.games} rows=${rows.length}/${cfg.maxWindows} sourceVp=${sourceVp}`);
				}
			}

			const corrections = rows.filter((r) => r.traceCorrection);
			const avg = (xs: number[]) => xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : 0;
			const summary = {
				generatedAt: new Date().toISOString(),
				config: {
					games: cfg.games,
					maxRounds: cfg.maxRounds,
					branchRolloutsCapAtMaxRounds: true,
					maxWindows: cfg.maxWindows,
					horizons: cfg.horizons,
					labelHorizon: cfg.labelHorizon,
					minSourceVp: cfg.minSourceVp,
					maxSourceVp: cfg.maxSourceVp,
					minPlayerVp: cfg.minPlayerVp,
					maxPlayerVp: cfg.maxPlayerVp,
					minRound: cfg.minRound,
					sourceDestination: cfg.sourceDestination,
					minMonsterHp: cfg.minMonsterHp,
					maxCleanKillProb: cfg.maxCleanKillProb,
					maxFirepowerKillProb: cfg.maxFirepowerKillProb,
					reentryBuildSteps: cfg.reentryBuildSteps,
					rolloutPolicy: cfg.rolloutPolicy,
					routeFinishOracle: cfg.routeFinishOracle,
					scripts: cfg.scripts,
					weights: cfg.weights,
					patchNavWeights: cfg.patchNavWeights,
					patchNavigationPolicyGate: cfg.patchNavigationPolicyGate,
					patch2NavWeights: cfg.patch2NavWeights,
					patch2NavigationPolicyGate: cfg.patch2NavigationPolicyGate,
					navWeights: cfg.navWeights,
					navigationPolicyGate: cfg.navigationPolicyGate,
					scaleNavWeights: cfg.scaleNavWeights,
					scalingNavigationPolicyGate: cfg.scalingNavigationPolicyGate,
					microWeights: cfg.microWeights,
					microPolicyGate: cfg.microPolicyGate,
					dataOut: cfg.dataOut,
					positiveOnlyData: cfg.positiveOnlyData,
					sampleMode: cfg.sampleMode,
					fullSampleTypes: cfg.fullSampleTypes ? [...cfg.fullSampleTypes] : undefined,
					forbidTypes: cfg.forbidTypes ? [...cfg.forbidTypes] : undefined,
					maxStatusLevel: cfg.maxStatusLevel,
					labelScoreThreshold: cfg.labelScoreThreshold,
					labelVpThreshold: cfg.labelVpThreshold,
					labelStatusTolerance: cfg.labelStatusTolerance,
					exposureMinVp: cfg.exposureMinVp,
					exposureMinMonsterHp: cfg.exposureMinMonsterHp,
					targetQualityMinVp: cfg.targetQualityMinVp,
					requireExposureDelta: cfg.requireExposureDelta,
					requireTargetQualityDelta: cfg.requireTargetQualityDelta,
					scoreExposureWindowWeight: cfg.scoreExposureWindowWeight,
					scoreExposureVpWeight: cfg.scoreExposureVpWeight,
					scoreExposureBestVpWeight: cfg.scoreExposureBestVpWeight,
					scoreTargetQualityWindowWeight: cfg.scoreTargetQualityWindowWeight,
					scoreTargetQualityVpWeight: cfg.scoreTargetQualityVpWeight,
					scoreTargetQualityBestVpWeight: cfg.scoreTargetQualityBestVpWeight,
					scoreStatusPenalty: cfg.scoreStatusPenalty
				},
				sourceGames,
				sourceVpAvg: +avg(rows.map((r) => r.sourceFinalVp)).toFixed(2),
				allSourceVpAvg: +(sourceVpSum / Math.max(1, sourceGames)).toFixed(2),
				sourceReach30Pct: +((100 * sourceReach30) / Math.max(1, sourceGames)).toFixed(1),
				scannedWindows,
				filteredWindows,
				capturedWindows: captured,
				skippedSourceVp,
					windows: rows.length,
					samples: samples.length,
					navigationSampleDestinations: topN(navigationSampleDestinations, 10),
					navigationSampleSkips: topN(navigationSampleSkips, 10),
					corrections: corrections.length,
				correctionPct: +((100 * corrections.length) / Math.max(1, rows.length)).toFixed(1),
				roundCappedBranches: rows.reduce((sum, r) => sum + r.branches.filter((b) => b.cappedByMaxRounds).length, 0),
				roundCappedWindows: rows.filter((r) => r.branches.some((b) => b.cappedByMaxRounds)).length,
				labelRoundCappedWindows: rows.filter((r) => {
					const labelRound = r.round + cfg.labelHorizon;
					return r.branches.some((b) => b.cappedByMaxRounds && (b.snapshots[String(cfg.labelHorizon)]?.round ?? b.rolloutEndRound) < labelRound);
				}).length,
				avgDeltaScore: +avg(rows.map((r) => r.traceQDeltaScore)).toFixed(2),
				avgDeltaVp: +avg(rows.map((r) => r.traceQDeltaVp)).toFixed(2),
				avgCorrectionDeltaVp: +avg(corrections.map((r) => r.traceQDeltaVp)).toFixed(2),
				reach30Delta: rows.reduce((sum, r) => sum + r.traceQDeltaReach30, 0),
				exposureWindowDelta: rows.reduce((sum, r) => sum + r.traceQDeltaExposureWindows, 0),
				avgDeltaExposureVp: +avg(rows.map((r) => r.traceQDeltaExposureVp)).toFixed(2),
				avgCorrectionDeltaExposureVp: +avg(corrections.map((r) => r.traceQDeltaExposureVp)).toFixed(2),
				avgDeltaBestExposureVp: +avg(rows.map((r) => r.traceQDeltaBestExposureVp)).toFixed(2),
				targetQualityWindowDelta: rows.reduce((sum, r) => sum + r.traceQDeltaTargetQualityWindows, 0),
				avgDeltaTargetQualityVp: +avg(rows.map((r) => r.traceQDeltaTargetQualityVp)).toFixed(2),
				avgCorrectionDeltaTargetQualityVp: +avg(corrections.map((r) => r.traceQDeltaTargetQualityVp)).toFixed(2),
				avgDeltaBestTargetQualityVp: +avg(rows.map((r) => r.traceQDeltaBestTargetQualityVp)).toFixed(2),
				bestScripts: topN(bestScripts, 12),
				correctionScripts: topN(correctionScripts, 12),
				fullSampleTypes: topN(fullSampleTypes, 20),
				bestRows: [...rows].sort((a, b) => b.traceQDeltaVp - a.traceQDeltaVp || b.traceQDeltaScore - a.traceQDeltaScore).slice(0, 12)
			};
			mkdirSync(dirname(cfg.out), { recursive: true });
			writeFileSync(cfg.out, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
			mkdirSync(dirname(cfg.summaryOut), { recursive: true });
			writeFileSync(cfg.summaryOut, `${JSON.stringify(summary, null, 2)}\n`);
			if (cfg.dataOut && samples.length > 0) appendSamples(cfg.dataOut, samples, 0);
			/* eslint-disable no-console */
			console.log(`[traceq] windows=${rows.length} corrections=${corrections.length} samples=${samples.length} avgDeltaVp=${summary.avgDeltaVp} correctionDeltaVp=${summary.avgCorrectionDeltaVp} reach30Delta=${summary.reach30Delta}`);
			console.log(`[traceq] bestScripts=${JSON.stringify(summary.bestScripts)} corrections=${JSON.stringify(summary.correctionScripts)}`);
			console.log(`[traceq] DONE -> ${cfg.summaryOut}`);
			/* eslint-enable no-console */
		},
		2 * 60 * 60 * 1000
	);
});
