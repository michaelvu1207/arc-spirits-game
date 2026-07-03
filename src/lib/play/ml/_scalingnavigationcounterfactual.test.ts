/**
 * Scaling-navigation counterfactual diagnostic.
 *
 * Route-exec says the clean bot's late row choices are mostly already coherent,
 * but it reaches too few high-ceiling states. This harness branches navigation
 * destinations from clean mid-route states and asks which destination creates
 * the best long-horizon damage/barrier/reach30 trajectory.
 *
 * Opt in:
 *
 *   SCALEQ=1 SCALEQ_GAMES=1 \
 *     npx vitest run src/lib/play/ml/_scalingnavigationcounterfactual.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../runtime';
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
	type GameActor,
	type GameCommand,
	type NavigationDestination,
	type PlayCatalog,
	type PublicGameState,
	type SeatColor
} from '../types';
import { commandMatches, legalActionsWithNext, type LegalAction } from './actions';
import { sampleAuxTargets } from './auxTargets';
import type { Sample } from './driver';
import { ACT_DIM, encodeAction, encodeObs, OBS_DIM } from './encode';
import { evaluateFarmValue } from './farmValue';
import type { NeuralPolicy } from './net';
import { appendSamples, loadOrSnapshotCatalog, loadPolicyForEval, mlPath } from './nodeIo';
import { neuralPlanNavigation } from './planner';
import { chooseRouteBreakpointOracleAction } from './routeBreakpointOracle';
import {
	chooseFullActionDecision,
	filterPlannerActions,
	playPlannerSelfPlayGame,
	type FullActionSelection,
	type MicroPolicyGate,
	type NavigationPolicyGate,
	type NavigationProbeContext
} from './selfplay';
import { BALANCED_SHAPING, buildPotential, vpOf } from './shaping';

const RUN = process.env.SCALEQ === '1';
const MAX_TICKS = 80_000;
const MAX_ACTIONS_PER_PHASE = 30;
const ROLLOUT_FULL_SELECTION: FullActionSelection = 'lookahead';
const ROLLOUT_FULL_LOOKAHEAD_DEPTH = 2;
const ROLLOUT_FULL_LOOKAHEAD_BEAM = 8;
const ROLLOUT_FULL_LOOKAHEAD_ROOT_BEAM = 24;
const ROLLOUT_FULL_TARGET_TEMPERATURE = 0.25;
const BUILD_OPTION_DESTINATIONS: NavigationDestination[] = ['Lantern Canyon', 'Floral Patch', 'Cyber City', 'Tidal Cove'];
const SCALING_OPTION_DESTINATIONS: NavigationDestination[] = ['Tidal Cove', 'Cyber City', 'Lantern Canyon'];
const RESTORE_OPTION_DESTINATIONS: NavigationDestination[] = ['Lantern Canyon', 'Floral Patch'];
const CLOSER_DAMAGE_DESTINATIONS: NavigationDestination[] = ['Tidal Cove', 'Cyber City', 'Lantern Canyon'];
const CLOSER_MAX_BARRIER_DESTINATIONS: NavigationDestination[] = ['Floral Patch', 'Lantern Canyon', 'Cyber City'];
const CLOSER_RESTORE_DESTINATIONS: NavigationDestination[] = ['Lantern Canyon', 'Floral Patch'];
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
type RolloutPolicy = 'policy' | 'breakpoint-oracle';

interface Config {
	games: number;
	seatsN: number;
	maxRounds: number;
	maxWindows: number;
	horizons: number[];
	selectHorizon: number;
	labelHorizon: number;
	labelScoreThreshold: number;
	labelVpThreshold: number;
	labelStatusTolerance: number;
	positiveOnlyData: boolean;
	minPlayerVp: number;
	maxPlayerVp?: number;
	minRound: number;
	maxRound?: number;
	minMonsterHp: number;
	maxMonsterHp?: number;
	minCleanKillProb: number;
	maxCleanKillProb?: number;
	minFirepowerKillProb: number;
	maxFirepowerKillProb?: number;
	destinationFilter?: Set<string>;
	scoreReach30Bonus: number;
	scoreVpWeight: number;
	scoreKillWeight: number;
	scoreCleanOpportunityWeight: number;
	scoreExpectedAttackWeight: number;
	scoreAttackDiceWeight: number;
	scoreSpiritAnimalWeight: number;
	scoreCultivatorWeight: number;
	scoreBarrierWeight: number;
	scoreStatusPenalty: number;
	dataOut?: string;
	profiles: string[];
	out: string;
	summaryOut: string;
	forbidTypes?: Set<GameCommand['type']>;
	maxStatusLevel?: number;
	plannerPolicy?: NeuralPolicy;
	navigationPolicy?: NeuralPolicy;
	scalingNavigationPolicy?: NeuralPolicy;
	microPolicy?: NeuralPolicy;
	microPolicyGate: MicroPolicyGate;
	navigationPolicyGate: NavigationPolicyGate;
	scalingNavigationPolicyGate: NavigationPolicyGate;
	preserveRouteFirepower: boolean;
	preserveRouteSurvival: boolean;
	plannerIterations: number;
	plannerHorizon: number;
	plannerValueWeight: number;
	progressEvery: number;
	source: 'heuristic' | 'full-control';
	sourceSeedBase: number;
	plannerProfile: string;
	rolloutPolicy: RolloutPolicy;
	plannerWeights?: string;
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
	cleanCombatOpportunities: number;
	firepowerCombatOpportunities: number;
	round: number;
}

interface BranchMetrics {
	action: string;
	destination: string;
	finalVp: number;
	finalStatus: number;
	kills: number;
	combats: number;
	cleanCombatOpportunities: number;
	firepowerCombatOpportunities: number;
	maxExpectedAttack: number;
	maxBarrier: number;
	maxCurrentBarrier: number;
	maxAttackDice: number;
	maxSpiritAnimal: number;
	maxCultivator: number;
	rounds: number;
	snapshots: Record<string, BuildSnapshot>;
}

interface WindowRow {
	id: string;
	game: number;
	seat: SeatColor;
	round: number;
	playerVp: number;
	playerStatus: number;
	playerExpectedAttack: number;
	playerMaxBarrier: number;
	playerAttackDice: number;
	playerSpiritAnimal: number;
	playerCultivator: number;
	monsterHp: number;
	monsterDamage: number;
	monsterLives: number;
	cleanKillProb: number;
	firepowerKillProb: number;
	legalDestinations: number;
	sourceDestination: string;
	bestDestination: string;
	sourceWasBest: boolean;
	sourceScore: number;
	bestScore: number;
	scalingQDeltaScore: number;
	scalingQDeltaVp: number;
	scalingQDeltaStatus: number;
	scalingQDeltaReach30: number;
	scalingCorrection: boolean;
	branches: BranchMetrics[];
}

function seededBotRandom(seed: number): BotRandom {
	const rng = createRng(seed);
	return {
		int: (maxExclusive: number) => nextInt(rng, maxExclusive),
		chance: () => nextInt(rng, 2) === 0
	};
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

function parseDestinationFilter(raw: string | undefined): Set<string> | undefined {
	if (!raw?.trim()) return undefined;
	const values = raw.split(',')
		.map((s) => s.trim().replace(/_/g, ' '))
		.filter(Boolean);
	return values.length ? new Set(values) : undefined;
}

function clamp01(x: number): number {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

function destinationOf(cmd: GameCommand): string {
	return cmd.type === 'lockNavigation' ? cmd.destination : '<none>';
}

function commandLabel(cmd: GameCommand): string {
	return cmd.type === 'lockNavigation' ? `lockNavigation:${cmd.destination}` : cmd.type;
}

function buildOf(state: PublicGameState, seat: SeatColor): Omit<BuildSnapshot, 'kills' | 'cleanCombatOpportunities' | 'firepowerCombatOpportunities' | 'round'> {
	const player = state.players[seat];
	if (!player) {
		return { vp: 0, status: 0, expectedAttack: 0, maxBarrier: 0, currentBarrier: 0, attackDice: 0, spiritAnimal: 0, cultivator: 0 };
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
		cultivator: counts.Cultivator ?? 0
	};
}

interface MonsterWindowSignal {
	monsterHp: number;
	monsterDamage: number;
	monsterLives: number;
	cleanKillProb: number;
	firepowerKillProb: number;
}

function monsterWindowSignal(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog): MonsterWindowSignal {
	const monster = state.monster;
	if (!monster) {
		return {
			monsterHp: 0,
			monsterDamage: 0,
			monsterLives: 0,
			cleanKillProb: 0,
			firepowerKillProb: 0
		};
	}
	return {
		monsterHp: monster.maxHp ?? monster.hp ?? 0,
		monsterDamage: monster.damage ?? 0,
		monsterLives: monster.livesRemaining ?? 0,
		cleanKillProb: computeKillProbability(state, seat, catalog, { allowCorruptKill: false }),
		firepowerKillProb: firepowerKillProbability(state, seat, catalog)
	};
}

function setupGame(catalog: PlayCatalog, seed: number, seatsN: number): { state: PublicGameState; seats: SeatColor[] } {
	const n = Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
	const seats = SEAT_COLORS.slice(0, n) as SeatColor[];
	const guardianNames = catalog.guardians.map((g) => g.name).slice(0, n);
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	let state = createLobbyState({ roomCode: 'SCLQ', guardianNames });
	const expectOk = (r: ReturnType<typeof applyGameCommand>, label: string): void => {
		if (!r.ok) throw new Error(`${label}: ${r.error.code} ${r.error.message}`);
		state = r.state;
	};
	seats.forEach((seat, i) => {
		const memberId = `bot-${seat}`;
		expectOk(applyGameCommand(state, { memberId, displayName: seat, role: 'player', seatColor: null }, { type: 'claimSeat', seatColor: seat }, catalog), `claimSeat ${seat}`);
		expectOk(applyGameCommand(state, { memberId, displayName: seat, role: 'player', seatColor: seat }, { type: 'selectGuardian', guardianName: guardianNames[i] }, catalog), `selectGuardian ${seat}`);
	});
	expectOk(applyGameCommand(state, host, { type: 'startGame', seed }, catalog), 'startGame');
	return { state, seats };
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

function legalNavigationBranches(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, cfg: Config, destinations?: string[]): LegalAction[] {
	const allowed = destinations ? new Set(destinations) : undefined;
	return legalActionsWithNext(state, seat, catalog)
		.filter((x) => x.cmd.type === 'lockNavigation')
		.filter((x) => !allowed || allowed.has((x.cmd as Extract<GameCommand, { type: 'lockNavigation' }>).destination))
		.filter((x) => !cfg.destinationFilter || cfg.destinationFilter.has((x.cmd as Extract<GameCommand, { type: 'lockNavigation' }>).destination))
		.filter((x) => cfg.maxStatusLevel === undefined || (x.next.players[seat]?.statusLevel ?? 0) <= cfg.maxStatusLevel);
}

function windowMatches(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, cfg: Config): boolean {
	const build = buildOf(state, seat);
	if (build.status !== 0) return false;
	if (build.vp < cfg.minPlayerVp) return false;
	if (cfg.maxPlayerVp !== undefined && build.vp > cfg.maxPlayerVp) return false;
	if (state.round < cfg.minRound) return false;
	if (cfg.maxRound !== undefined && state.round > cfg.maxRound) return false;
	const monster = monsterWindowSignal(state, seat, catalog);
	if (monster.monsterHp < cfg.minMonsterHp) return false;
	if (cfg.maxMonsterHp !== undefined && monster.monsterHp > cfg.maxMonsterHp) return false;
	if (monster.cleanKillProb < cfg.minCleanKillProb) return false;
	if (cfg.maxCleanKillProb !== undefined && monster.cleanKillProb > cfg.maxCleanKillProb) return false;
	if (monster.firepowerKillProb < cfg.minFirepowerKillProb) return false;
	if (cfg.maxFirepowerKillProb !== undefined && monster.firepowerKillProb > cfg.maxFirepowerKillProb) return false;
	return true;
}

function shouldUseNavigationPrior(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, cfg: Config): boolean {
	if (!cfg.navigationPolicy) return false;
	if (cfg.navigationPolicyGate === 'all') return true;
	if (cfg.navigationPolicyGate === 'midroute-scaling') {
		const player = state.players[seat];
		if (!player || (player.statusLevel ?? 0) !== 0) return false;
		const farm = evaluateFarmValue(state, seat, catalog, { threshold: 0.5 });
		if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
		return state.round >= 4 && (player.victoryPoints ?? 0) >= 6;
	}
		if (cfg.navigationPolicyGate === 'route-option-scaling') {
		const player = state.players[seat];
		if (!player || !state.monster || (player.statusLevel ?? 0) !== 0) return false;
		const farm = evaluateFarmValue(state, seat, catalog, { threshold: 0.5 });
		if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
		const vp = player.victoryPoints ?? 0;
		if (state.round < 8 || vp < 10 || vp >= 24) return false;
		const counts = awakenedClassCounts(player);
		const attackDice = player.attackDice?.length ?? 0;
		const attack = expectedAttack(player);
		const monsterHp = state.monster.maxHp ?? state.monster.hp ?? 0;
		const firepowerProb = firepowerKillProbability(state, seat, catalog);
		const needsDamage = monsterHp > 0 && (firepowerProb < 0.5 || attack < monsterHp + 1);
		if (needsDamage) return true;
		if (combatReadyButNeedsRestore(state, seat, catalog)) return true;
		if ((player.barrier ?? 0) < (player.maxBarrier ?? 0)) return false;
		if (state.round % 3 !== 0) return false;
		const underScaled =
			attackDice < 2 ||
			attack < 5 ||
			(counts.Cultivator ?? 0) < 2 ||
			(player.maxBarrier ?? 0) < 6;
			return needsDamage || underScaled;
		}
		if (cfg.navigationPolicyGate === 'clean-farm-q') {
			const player = state.players[seat];
			if (!player || (player.statusLevel ?? 0) !== 0) return false;
			const farm = evaluateFarmValue(state, seat, catalog, { threshold: 0.5 });
			return farm.valid && farm.farmable && farm.opportunityVp >= 1;
		}
		if (cfg.navigationPolicyGate === 'hp2-survival-deficit') {
		const player = state.players[seat];
		const monster = state.monster;
		if (!player || !monster || (player.statusLevel ?? 0) !== 0) return false;
		const vp = player.victoryPoints ?? 0;
		const monsterHp = monster.maxHp ?? monster.hp ?? 0;
		if (state.round < 6 || state.round > 18 || vp < 9 || vp > 18 || Math.abs(monsterHp - 2) > 0.01) {
			return false;
		}
		const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
		if (cleanProb >= 0.5) return false;
		const firepowerProb = firepowerKillProbability(state, seat, catalog);
		if (expectedAttack(player) >= 3.25) return false;
		return firepowerProb >= 0.5 && combatReadyButNeedsRestore(state, seat, catalog);
	}
	if (cfg.navigationPolicyGate === 'route-closer') {
		const player = state.players[seat];
		if (!player || !state.monster || (player.statusLevel ?? 0) !== 0) return false;
		const farm = evaluateFarmValue(state, seat, catalog, { threshold: 0.5 });
		if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
		const vp = player.victoryPoints ?? 0;
		const monsterHp = state.monster.maxHp ?? state.monster.hp ?? 0;
		if (state.round < 12 || vp < 15 || vp >= 30 || monsterHp < 4) return false;
		const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
		if (cleanProb >= 0.5) return false;
		const monsterDamage = state.monster.damage ?? 0;
		const attack = expectedAttack(player);
		const firepowerProb = firepowerKillProbability(state, seat, catalog);
		const survivalTarget = monsterDamage + 1;
		const maxBarrier = player.maxBarrier ?? 0;
		const barrier = player.barrier ?? 0;
		const damageDeficit = monsterHp > 0 && (firepowerProb < 0.5 || attack < monsterHp + 0.5);
		const maxBarrierDeficit = survivalTarget > 0 && maxBarrier < survivalTarget;
		const restoreDeficit = survivalTarget > 0 && maxBarrier >= survivalTarget && barrier < survivalTarget;
		return damageDeficit || maxBarrierDeficit || restoreDeficit;
	}
	if (cfg.navigationPolicyGate === 'survival-rebuild') {
		const player = state.players[seat];
		if (!player || !state.monster || (player.statusLevel ?? 0) !== 0) return false;
		const farm = evaluateFarmValue(state, seat, catalog, { threshold: 0.5 });
		if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
		const monsterHp = state.monster.maxHp ?? state.monster.hp ?? 0;
		const monsterDamage = state.monster.damage ?? 0;
		const vp = player.victoryPoints ?? 0;
		if (state.round < 5 || vp < 9 || monsterHp < 2) return false;
		const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
		if (cleanProb >= 0.5) return false;
		const attack = expectedAttack(player);
		const firepowerProb = firepowerKillProbability(state, seat, catalog);
		const barrierDeficit = (player.barrier ?? 0) < Math.min(player.maxBarrier ?? 0, monsterDamage + 1);
		const maxBarrierDeficit = (player.maxBarrier ?? 0) < monsterDamage + 2;
		const damageDeficit = attack < monsterHp + 0.5 || firepowerProb < 0.5;
		return monsterHp >= 4 || barrierDeficit || maxBarrierDeficit || damageDeficit;
	}
	const player = state.players[seat];
	if (!player || !state.monster || (player.statusLevel ?? 0) !== 0) return false;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	return firepowerProb >= 0.5 && cleanProb < 0.5;
}

function combatReadyButNeedsRestore(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) !== 0) return false;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	if (cleanProb >= 0.5) return false;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const damageReady = firepowerProb >= 0.5 || (monsterHp > 0 && attack >= monsterHp - 0.01);
	if (!damageReady) return false;
	const survivalTarget = (monster.damage ?? 0) + 1;
	if (survivalTarget <= 0) return false;
	const maxBarrier = player.maxBarrier ?? 0;
	const barrier = player.barrier ?? 0;
	const currentBarrierDeficit = maxBarrier >= survivalTarget && barrier < survivalTarget;
	const counts = awakenedClassCounts(player);
	const maxBarrierDeficitWithEngine = maxBarrier < survivalTarget && (counts.Cultivator ?? 0) >= 2;
	return currentBarrierDeficit || maxBarrierDeficitWithEngine;
}

function navigationRootDestinations(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): NavigationDestination[] | undefined {
	if (!shouldUseNavigationPrior(state, seat, catalog, cfg)) return undefined;
	if (cfg.navigationPolicyGate === 'unsafe-firepower-build-option') {
		return combatReadyButNeedsRestore(state, seat, catalog)
			? RESTORE_OPTION_DESTINATIONS
			: BUILD_OPTION_DESTINATIONS;
	}
	if (cfg.navigationPolicyGate === 'route-option-scaling') {
		return combatReadyButNeedsRestore(state, seat, catalog)
			? RESTORE_OPTION_DESTINATIONS
			: SCALING_OPTION_DESTINATIONS;
	}
	if (cfg.navigationPolicyGate === 'hp2-survival-deficit') {
		return RESTORE_OPTION_DESTINATIONS;
	}
	if (cfg.navigationPolicyGate === 'route-closer') {
		const player = state.players[seat];
		const monster = state.monster;
		if (!player || !monster) return CLOSER_DAMAGE_DESTINATIONS;
		const monsterHp = monster.maxHp ?? monster.hp ?? 0;
		const monsterDamage = monster.damage ?? 0;
		const attack = expectedAttack(player);
		const firepowerProb = firepowerKillProbability(state, seat, catalog);
		const survivalTarget = monsterDamage + 1;
		const maxBarrier = player.maxBarrier ?? 0;
		const barrier = player.barrier ?? 0;
		const damageDeficit = monsterHp > 0 && (
			attack < monsterHp + 0.5 ||
			firepowerProb < 0.5
		);
		if (damageDeficit) return CLOSER_DAMAGE_DESTINATIONS;
		if (survivalTarget > 0 && maxBarrier < survivalTarget) return CLOSER_MAX_BARRIER_DESTINATIONS;
		if (survivalTarget > 0 && barrier < survivalTarget) return CLOSER_RESTORE_DESTINATIONS;
		return CLOSER_RESTORE_DESTINATIONS;
	}
	if (cfg.navigationPolicyGate === 'survival-rebuild') {
		const player = state.players[seat];
		const monster = state.monster;
		if (!player || !monster) return BUILD_OPTION_DESTINATIONS;
		const monsterHp = monster.maxHp ?? monster.hp ?? 0;
		const attack = expectedAttack(player);
		const firepowerProb = firepowerKillProbability(state, seat, catalog);
		const damageDeficit = monsterHp > 0 && (
			attack < monsterHp + 0.5 ||
			firepowerProb < 0.5
		);
		return damageDeficit
			? ['Cyber City', 'Tidal Cove', 'Lantern Canyon']
			: ['Floral Patch', 'Lantern Canyon'];
	}
	return undefined;
}

function plannerNavigationCommand(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, cfg: Config, seed: number): GameCommand | null {
	if (!cfg.plannerPolicy || state.phase !== 'navigation') return null;
	const priorPolicy = shouldUseNavigationPrior(state, seat, catalog, cfg) ? cfg.navigationPolicy : cfg.plannerPolicy;
	const result = neuralPlanNavigation(state, seat, catalog, cfg.plannerPolicy, {
		iterations: cfg.plannerIterations,
		horizon: cfg.plannerHorizon,
		valueWeight: cfg.plannerValueWeight,
		c: 1.5,
		priorPolicy,
		rootDestinations: navigationRootDestinations(state, seat, catalog, cfg),
		seed
	});
	if (!result) return null;
	let best = 0;
	for (let i = 1; i < result.visits.length; i++) if (result.visits[i] > result.visits[best]) best = i;
	return { type: 'lockNavigation', destination: result.destinations[best] };
}

function newMetrics(action: GameCommand, state: PublicGameState, seat: SeatColor, startRound: number): BranchMetrics {
	const build = buildOf(state, seat);
	return {
		action: commandLabel(action),
		destination: destinationOf(action),
		finalVp: build.vp,
		finalStatus: build.status,
		kills: 0,
		combats: 0,
		cleanCombatOpportunities: 0,
		firepowerCombatOpportunities: 0,
		maxExpectedAttack: build.expectedAttack,
		maxBarrier: build.maxBarrier,
		maxCurrentBarrier: build.currentBarrier,
		maxAttackDice: build.attackDice,
		maxSpiritAnimal: build.spiritAnimal,
		maxCultivator: build.cultivator,
		rounds: state.round - startRound,
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
		cleanCombatOpportunities: metrics.cleanCombatOpportunities,
		firepowerCombatOpportunities: metrics.firepowerCombatOpportunities,
		round: state.round
	};
}

function recordCombatOpportunity(metrics: BranchMetrics, state: PublicGameState, seat: SeatColor, catalog: PlayCatalog): void {
	if (!legalActionsWithNext(state, seat, catalog).some((x) => x.cmd.type === 'startCombat')) return;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	if (cleanProb >= 0.5) metrics.cleanCombatOpportunities++;
	if (firepowerProb >= 0.5) metrics.firepowerCombatOpportunities++;
}

function microDecisionSet(
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[],
	cfg: Config
): { policy: NeuralPolicy; withNext: LegalAction[]; indexMap?: number[] } | null {
	if (!cfg.plannerPolicy) return null;
	const gate = cfg.microPolicyGate;
	const navDestination = state.players[seat]?.navigationDestination;
	const abyssScopedGate = gate === 'abyss-round' ||
		gate === 'abyss-farm-actions' ||
		gate === 'abyss-reward-actions' ||
		gate === 'abyss-farm-overlay';
	const useMicro = !!cfg.microPolicy && (
		gate === 'all' ||
		(gate === 'location-interactions' && state.phase === 'location') ||
		(abyssScopedGate && navDestination === 'Arcane Abyss')
	);
	if (!useMicro || !cfg.microPolicy || gate === 'abyss-farm-overlay') {
		return { policy: cfg.plannerPolicy, withNext };
	}
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
	return filtered.length > 0
		? { policy: cfg.microPolicy, withNext: filtered, indexMap }
		: { policy: cfg.plannerPolicy, withNext };
}

function chooseTargetFullControlAction(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config,
	rng: ReturnType<typeof createRng>
): LegalAction | null {
	if (cfg.rolloutPolicy !== 'breakpoint-oracle' && (cfg.source !== 'full-control' || !cfg.plannerPolicy)) return null;
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
	if (cfg.rolloutPolicy === 'breakpoint-oracle') {
		return chooseRouteBreakpointOracleAction(state, seat, catalog, withNext, {
			cleanThreshold: 0.5,
			firepowerThreshold: 0.5
		});
	}
	if (!cfg.plannerPolicy) return null;
	const decisionSet = microDecisionSet(state, seat, withNext, cfg);
	if (!decisionSet) return null;
	const decision = chooseFullActionDecision(
		decisionSet.policy,
		state,
		seat,
		decisionSet.withNext,
		catalog,
		ROLLOUT_FULL_SELECTION,
		ROLLOUT_FULL_LOOKAHEAD_DEPTH,
		ROLLOUT_FULL_LOOKAHEAD_BEAM,
		ROLLOUT_FULL_LOOKAHEAD_ROOT_BEAM,
		ROLLOUT_FULL_TARGET_TEMPERATURE,
		false,
		1,
		rng
	);
	const idx = decisionSet.indexMap?.[decision.idx] ?? decision.idx;
	return withNext[idx] ?? null;
}

function rolloutBranch(
	initial: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	profileBySeat: Record<string, BotProfile>,
	cfg: Config,
	seed: number,
	action: GameCommand,
	startRound: number
): BranchMetrics {
	let state = initial;
	const maxHorizon = Math.max(...cfg.horizons);
	const rng = seededBotRandom(seed);
	const fullActionRng = createRng((seed ^ 0x5ca1ab1e) >>> 0 || 1);
	const metrics = newMetrics(action, state, seat, startRound);
	const actionCounter = new Map<string, number>();
	let ticks = 0;
	while (state.status === 'active' && state.round < startRound + maxHorizon && ticks++ < MAX_TICKS) {
		let progressed = false;
		for (const activeSeat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, activeSeat)) continue;
			const key = `${activeSeat}:${state.round}:${state.phase}`;
			const used = actionCounter.get(key) ?? 0;
			if (used >= MAX_ACTIONS_PER_PHASE) continue;
			if (activeSeat === seat) recordCombatOpportunity(metrics, state, seat, catalog);
			if (activeSeat === seat && state.phase === 'navigation') {
				const nav = plannerNavigationCommand(state, activeSeat, catalog, cfg, 19_300_000 + seed + state.round * 31 + ticks);
				if (nav) {
					const r = applyGameCommand(state, botActorFor(state, activeSeat), nav, catalog, { mutate: true });
					if (r.ok) {
						state = r.state;
						progressed = true;
						actionCounter.set(key, used + 1);
						recordBuild(metrics, state, seat);
					}
					if (state.status !== 'active' || state.round >= startRound + maxHorizon) break;
						continue;
					}
				}
				if (activeSeat === seat) {
					const chosen = chooseTargetFullControlAction(state, activeSeat, catalog, cfg, fullActionRng);
					if (chosen) {
						state = chosen.next;
						progressed = true;
						actionCounter.set(key, used + 1);
						recordBuild(metrics, state, seat);
						if (chosen.cmd.type === 'startCombat') {
							metrics.combats++;
							const combat = state.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === seat);
							if (combat?.killed) metrics.kills++;
						}
						for (const h of cfg.horizons) {
							if (state.round >= startRound + h && metrics.snapshots[String(h)] === undefined) snapshot(metrics, state, seat, h);
						}
						if (state.status !== 'active' || state.round >= startRound + maxHorizon) break;
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
					if (cmd.type === 'startCombat') {
						metrics.combats++;
						const combat = state.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === seat);
						if (combat?.killed) metrics.kills++;
					}
				}
				for (const h of cfg.horizons) {
					if (state.round >= startRound + h && metrics.snapshots[String(h)] === undefined) snapshot(metrics, state, seat, h);
				}
				if (state.status !== 'active' || state.round >= startRound + maxHorizon) break;
			}
			if (state.status !== 'active' || state.round >= startRound + maxHorizon) break;
		}
		if (state.status !== 'active' || state.round >= startRound + maxHorizon) break;
		if (!progressed) {
			const sig = `${state.phase}:${state.round}`;
			applyDeadlineAdvance(state, catalog);
			recordBuild(metrics, state, seat);
			if (`${state.phase}:${state.round}` === sig) break;
		}
	}
	for (const h of cfg.horizons) if (metrics.snapshots[String(h)] === undefined) snapshot(metrics, state, seat, h);
	metrics.finalVp = state.players[seat]?.victoryPoints ?? 0;
	metrics.finalStatus = state.players[seat]?.statusLevel ?? 0;
	metrics.rounds = state.round - startRound;
	return metrics;
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
		cleanCombatOpportunities: metrics.cleanCombatOpportunities,
		firepowerCombatOpportunities: metrics.firepowerCombatOpportunities,
		round: 0
	};
}

function branchScore(metrics: BranchMetrics, horizon: number, cfg: Config): number {
	const snap = snapAt(metrics, horizon);
	return (
		snap.vp * cfg.scoreVpWeight +
		snap.kills * cfg.scoreKillWeight +
		snap.cleanCombatOpportunities * cfg.scoreCleanOpportunityWeight +
		snap.expectedAttack * cfg.scoreExpectedAttackWeight +
		snap.attackDice * cfg.scoreAttackDiceWeight +
		snap.spiritAnimal * cfg.scoreSpiritAnimalWeight +
		snap.cultivator * cfg.scoreCultivatorWeight +
		snap.maxBarrier * cfg.scoreBarrierWeight +
		(snap.vp >= VP_TO_WIN ? cfg.scoreReach30Bonus : 0) -
		snap.status * cfg.scoreStatusPenalty
	);
}

function recordSample(samples: Sample[], state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, branches: LegalAction[], chosenIdx: number, chosenMetrics: BranchMetrics, labelHorizon: number): void {
	if (branches.length <= 1 || chosenIdx < 0) return;
	const chosenSnap = snapAt(chosenMetrics, labelHorizon);
	samples.push({
		obs: encodeObs(state, seat, catalog),
		cands: branches.map((x) => encodeAction(state, seat, x.cmd, x.next, catalog)),
		chosen: chosenIdx,
		pi: branches.map((_, i) => (i === chosenIdx ? 1 : 0)),
		ret: clamp01(Math.max(vpOf(state.players[seat]), chosenSnap.vp) / VP_TO_WIN),
		seat,
		vp: vpOf(state.players[seat]),
		phi: buildPotential(state.players[seat], BALANCED_SHAPING),
		kill: 0,
		...sampleAuxTargets(state, seat, catalog, branches)
	});
}

function addCount(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

function topN(counts: Record<string, number>, n: number): Record<string, number> {
	return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n));
}

interface Collector {
	rows: WindowRow[];
	samples: Sample[];
	sourceGames: number;
	sourceVpSum: number;
	sourceMaxVp: number;
	sourceReach30: number;
	scanned: number;
	filtered: number;
	skippedSingleAction: number;
	bestDestinations: Record<string, number>;
	sourceDestinations: Record<string, number>;
	correctionBestDestinations: Record<string, number>;
}

function recordWindow(
	source: {
		state: PublicGameState;
		seat: SeatColor;
		catalog: PlayCatalog;
		branches: LegalAction[];
		sourceAction: LegalAction;
		gameIndex: number;
		profileBySeat: Record<string, BotProfile>;
	},
	cfg: Config,
	collector: Collector
): void {
	collector.scanned++;
	if (!windowMatches(source.state, source.seat, source.catalog, cfg)) {
		collector.filtered++;
		return;
	}
	if (source.branches.length < 2) {
		collector.skippedSingleAction++;
		return;
	}
	const windowIndex = collector.rows.length;
	const metrics = source.branches.map((branch, i) => rolloutBranch(
		branch.next,
		source.seat,
		source.catalog,
		source.profileBySeat,
		cfg,
		21_300_000 + source.gameIndex * 10_000 + windowIndex * 100 + i,
		branch.cmd,
		source.state.round
	));
	let bestIdx = 0;
	for (let i = 1; i < metrics.length; i++) {
		if (branchScore(metrics[i], cfg.selectHorizon, cfg) > branchScore(metrics[bestIdx], cfg.selectHorizon, cfg)) bestIdx = i;
	}
	const sourceIdx = source.branches.findIndex((x) => commandMatches(x.cmd, source.sourceAction.cmd));
	const sourceMetrics = sourceIdx >= 0 ? metrics[sourceIdx] : metrics[0];
	const bestMetrics = metrics[bestIdx];
	const bestSnap = snapAt(bestMetrics, cfg.labelHorizon);
	const sourceSnap = snapAt(sourceMetrics, cfg.labelHorizon);
	const bestScore = branchScore(bestMetrics, cfg.labelHorizon, cfg);
	const sourceScore = branchScore(sourceMetrics, cfg.labelHorizon, cfg);
	const sourceDestination = destinationOf(source.sourceAction.cmd);
	const bestDestination = destinationOf(source.branches[bestIdx].cmd);
	const sourceWasBest = sourceIdx === bestIdx || sourceDestination === bestDestination;
	const scoreDelta = +(bestScore - sourceScore).toFixed(2);
	const vpDelta = +(bestSnap.vp - sourceSnap.vp).toFixed(2);
	const statusDelta = +(bestSnap.status - sourceSnap.status).toFixed(2);
	const reach30Delta = (bestSnap.vp >= VP_TO_WIN ? 1 : 0) - (sourceSnap.vp >= VP_TO_WIN ? 1 : 0);
	const scalingCorrection = !sourceWasBest &&
		scoreDelta >= cfg.labelScoreThreshold &&
		vpDelta >= cfg.labelVpThreshold &&
		statusDelta <= cfg.labelStatusTolerance;
	const build = buildOf(source.state, source.seat);
	const monster = monsterWindowSignal(source.state, source.seat, source.catalog);
	addCount(collector.bestDestinations, bestDestination);
	addCount(collector.sourceDestinations, sourceDestination);
	if (scalingCorrection) addCount(collector.correctionBestDestinations, bestDestination);
	collector.rows.push({
		id: `g${source.gameIndex}-${source.seat}-r${source.state.round}-${windowIndex}`,
		game: source.gameIndex,
		seat: source.seat,
		round: source.state.round,
		playerVp: build.vp,
		playerStatus: build.status,
		playerExpectedAttack: +build.expectedAttack.toFixed(2),
			playerMaxBarrier: build.maxBarrier,
			playerAttackDice: build.attackDice,
			playerSpiritAnimal: build.spiritAnimal,
			playerCultivator: build.cultivator,
			monsterHp: monster.monsterHp,
			monsterDamage: monster.monsterDamage,
			monsterLives: monster.monsterLives,
			cleanKillProb: +monster.cleanKillProb.toFixed(3),
			firepowerKillProb: +monster.firepowerKillProb.toFixed(3),
			legalDestinations: source.branches.length,
		sourceDestination,
		bestDestination,
		sourceWasBest,
		sourceScore: +sourceScore.toFixed(2),
		bestScore: +bestScore.toFixed(2),
		scalingQDeltaScore: scoreDelta,
		scalingQDeltaVp: vpDelta,
		scalingQDeltaStatus: statusDelta,
		scalingQDeltaReach30: reach30Delta,
		scalingCorrection,
		branches: metrics
	});
	if (cfg.dataOut && (!cfg.positiveOnlyData || scalingCorrection)) {
		recordSample(collector.samples, source.state, source.seat, source.catalog, source.branches, bestIdx, bestMetrics, cfg.labelHorizon);
	}
}

function heuristicNavigationBranch(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, rng: BotRandom, profile: BotProfile, branches: LegalAction[]): LegalAction {
	const plan = planBotPhaseActions(state, seat, catalog, rng, profile);
	const nav = plan.find((cmd) => cmd.type === 'lockNavigation');
	if (nav) {
		const match = branches.find((x) => commandMatches(x.cmd, nav));
		if (match) return match;
	}
	return branches[0];
}

describe('scaling navigation counterfactual diagnostics', () => {
	(RUN ? it : it.skip)(
		'branches clean mid-route navigation windows into long-horizon scaling value',
		async () => {
			const horizons = parseHorizons(process.env.SCALEQ_HORIZONS);
				const plannerWeights = process.env.SCALEQ_WEIGHTS;
				const navWeights = process.env.SCALEQ_NAV_WEIGHTS;
				const scaleNavWeights = process.env.SCALEQ_SCALE_NAV_WEIGHTS;
				const microWeights = process.env.SCALEQ_MICRO_WEIGHTS;
				const rawMicroGate = process.env.SCALEQ_MICRO_GATE;
				const rawScaleNavGate = process.env.SCALEQ_SCALE_NAV_GATE;
			const cfg: Config = {
				games: parseInt(process.env.SCALEQ_GAMES ?? '4', 10),
				seatsN: parseInt(process.env.SCALEQ_SEATS ?? '4', 10),
				maxRounds: parseInt(process.env.SCALEQ_MAXROUNDS ?? '30', 10),
				maxWindows: parseInt(process.env.SCALEQ_MAX_WINDOWS ?? '80', 10),
				horizons,
				selectHorizon: parseInt(process.env.SCALEQ_SELECT_HORIZON ?? '12', 10),
				labelHorizon: parseInt(process.env.SCALEQ_LABEL_HORIZON ?? String(horizons[horizons.length - 1]), 10),
				labelScoreThreshold: parseFloat(process.env.SCALEQ_LABEL_SCORE_THRESHOLD ?? '0.5'),
				labelVpThreshold: parseFloat(process.env.SCALEQ_LABEL_VP_THRESHOLD ?? '0'),
				labelStatusTolerance: parseFloat(process.env.SCALEQ_LABEL_STATUS_TOLERANCE ?? '0'),
					positiveOnlyData: process.env.SCALEQ_POSITIVE_ONLY_DATA === '1',
					minPlayerVp: parseFloat(process.env.SCALEQ_MIN_PLAYER_VP ?? '6'),
					maxPlayerVp: parseOptionalNumber(process.env.SCALEQ_MAX_PLAYER_VP),
					minRound: parseInt(process.env.SCALEQ_MIN_ROUND ?? '4', 10),
					maxRound: parseOptionalNumber(process.env.SCALEQ_MAX_ROUND),
					minMonsterHp: parseFloat(process.env.SCALEQ_MIN_MONSTER_HP ?? '0'),
					maxMonsterHp: parseOptionalNumber(process.env.SCALEQ_MAX_MONSTER_HP),
					minCleanKillProb: parseFloat(process.env.SCALEQ_MIN_CLEAN_KILL_PROB ?? '0'),
					maxCleanKillProb: parseOptionalNumber(process.env.SCALEQ_MAX_CLEAN_KILL_PROB),
					minFirepowerKillProb: parseFloat(process.env.SCALEQ_MIN_FIREPOWER_KILL_PROB ?? '0'),
					maxFirepowerKillProb: parseOptionalNumber(process.env.SCALEQ_MAX_FIREPOWER_KILL_PROB),
					destinationFilter: parseDestinationFilter(process.env.SCALEQ_DESTINATIONS),
				scoreReach30Bonus: parseFloat(process.env.SCALEQ_SCORE_REACH30_BONUS ?? '12'),
				scoreVpWeight: parseFloat(process.env.SCALEQ_SCORE_VP_WEIGHT ?? '1'),
				scoreKillWeight: parseFloat(process.env.SCALEQ_SCORE_KILL_WEIGHT ?? '0.5'),
				scoreCleanOpportunityWeight: parseFloat(process.env.SCALEQ_SCORE_CLEAN_OPPORTUNITY_WEIGHT ?? '2'),
				scoreExpectedAttackWeight: parseFloat(process.env.SCALEQ_SCORE_EXPECTED_ATTACK_WEIGHT ?? '1.2'),
				scoreAttackDiceWeight: parseFloat(process.env.SCALEQ_SCORE_ATTACK_DICE_WEIGHT ?? '0.8'),
				scoreSpiritAnimalWeight: parseFloat(process.env.SCALEQ_SCORE_SPIRIT_ANIMAL_WEIGHT ?? '0.8'),
				scoreCultivatorWeight: parseFloat(process.env.SCALEQ_SCORE_CULTIVATOR_WEIGHT ?? '0.2'),
				scoreBarrierWeight: parseFloat(process.env.SCALEQ_SCORE_BARRIER_WEIGHT ?? '0.3'),
				scoreStatusPenalty: parseFloat(process.env.SCALEQ_SCORE_STATUS_PENALTY ?? '2'),
				dataOut: process.env.SCALEQ_DATA_OUT,
				profiles: (process.env.SCALEQ_PROFILES ?? 'paragon,farmer,farmer2,hard').split(',').map((s) => s.trim()).filter(Boolean),
				out: process.env.SCALEQ_OUT ?? mlPath('scalingq_counterfactual.json'),
				summaryOut: process.env.SCALEQ_SUMMARY ?? mlPath('scalingq_counterfactual_summary.json'),
				forbidTypes: parseForbidTypes(process.env.SCALEQ_FORBID_TYPES ?? 'initiatePvp'),
				maxStatusLevel: process.env.SCALEQ_MAX_STATUS_LEVEL ? parseInt(process.env.SCALEQ_MAX_STATUS_LEVEL, 10) : 0,
					plannerPolicy: plannerWeights ? loadPolicyForEval(plannerWeights) : undefined,
					navigationPolicy: navWeights ? loadPolicyForEval(navWeights) : undefined,
					scalingNavigationPolicy: scaleNavWeights ? loadPolicyForEval(scaleNavWeights) : undefined,
					microPolicy: microWeights ? loadPolicyForEval(microWeights) : undefined,
					microPolicyGate: rawMicroGate === 'location-interactions' ? 'location-interactions' : 'all',
						navigationPolicyGate: process.env.SCALEQ_NAV_GATE === 'unsafe-firepower' || process.env.SCALEQ_NAV_GATE === 'unsafe-firepower-build-option' || process.env.SCALEQ_NAV_GATE === 'midroute-scaling' || process.env.SCALEQ_NAV_GATE === 'route-option-scaling' || process.env.SCALEQ_NAV_GATE === 'clean-farm-q' || process.env.SCALEQ_NAV_GATE === 'good-nonfallen-score-floor' || process.env.SCALEQ_NAV_GATE === 'hp2-survival-deficit' || process.env.SCALEQ_NAV_GATE === 'route-closer' || process.env.SCALEQ_NAV_GATE === 'survival-rebuild'
							? process.env.SCALEQ_NAV_GATE
							: 'all',
						scalingNavigationPolicyGate: rawScaleNavGate === 'unsafe-firepower' || rawScaleNavGate === 'unsafe-firepower-build-option' || rawScaleNavGate === 'midroute-scaling' || rawScaleNavGate === 'route-option-scaling' || rawScaleNavGate === 'clean-farm-q' || rawScaleNavGate === 'good-nonfallen-score-floor' || rawScaleNavGate === 'hp2-survival-deficit' || rawScaleNavGate === 'route-closer' || rawScaleNavGate === 'survival-rebuild'
							? rawScaleNavGate
							: 'route-option-scaling',
					preserveRouteFirepower: process.env.SCALEQ_PRESERVE_ROUTE_FIREPOWER === '1',
					preserveRouteSurvival: process.env.SCALEQ_PRESERVE_ROUTE_SURVIVAL === '1',
					plannerIterations: parseInt(process.env.SCALEQ_ITERS ?? '16', 10),
				plannerHorizon: parseInt(process.env.SCALEQ_PLANNER_HORIZON ?? '16', 10),
				plannerValueWeight: parseFloat(process.env.SCALEQ_VALUEW ?? '1'),
				progressEvery: parseInt(process.env.SCALEQ_PROGRESS_EVERY ?? '0', 10),
				source: process.env.SCALEQ_SOURCE === 'full-control' ? 'full-control' : 'heuristic',
					sourceSeedBase: parseInt(process.env.SCALEQ_SOURCE_SEED_BASE ?? '6500000', 10),
					plannerProfile: process.env.SCALEQ_PLANNER_PROFILE ?? 'cultivator',
					rolloutPolicy: process.env.SCALEQ_ROLLOUT_POLICY === 'breakpoint-oracle' ? 'breakpoint-oracle' : 'policy',
					plannerWeights,
					navWeights,
					scaleNavWeights,
					microWeights
				};
			const catalog = await loadOrSnapshotCatalog();
			if (cfg.dataOut) {
				mkdirSync(dirname(cfg.dataOut), { recursive: true });
				writeFileSync(cfg.dataOut, '');
			}
			const collector: Collector = {
				rows: [],
				samples: [],
				sourceGames: 0,
				sourceVpSum: 0,
				sourceMaxVp: 0,
				sourceReach30: 0,
				scanned: 0,
				filtered: 0,
				skippedSingleAction: 0,
				bestDestinations: {},
				sourceDestinations: {},
				correctionBestDestinations: {}
			};

			if (cfg.source === 'full-control') {
				if (!cfg.plannerPolicy) throw new Error('SCALEQ_SOURCE=full-control requires SCALEQ_WEIGHTS');
				const n = Math.min(cfg.seatsN, SEAT_COLORS.length, catalog.guardians.length);
				const seatList = SEAT_COLORS.slice(0, n) as SeatColor[];
				for (let g = 0; g < cfg.games && collector.rows.length < cfg.maxWindows; g++) {
					const plannerSeat = seatList[g % n];
					const profiles = seatList.map((seat, i) => {
						if (seat === plannerSeat) return profileFor(cfg.plannerProfile);
						return profileFor(cfg.profiles[(g + i) % cfg.profiles.length]);
					});
					const profileBySeat = Object.fromEntries(seatList.map((seat, i) => [seat, profiles[i]])) as Record<string, BotProfile>;
					const result = playPlannerSelfPlayGame(catalog, {
						seed: cfg.sourceSeedBase + g,
						profiles,
							policy: cfg.plannerPolicy,
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
						fullSelection: 'lookahead',
						fullLookaheadDepth: 2,
						fullLookaheadBeam: 8,
						fullLookaheadRootBeam: 24,
						fullTargetTemperature: 0.25,
							forbidTypes: cfg.forbidTypes,
							maxStatusLevel: cfg.maxStatusLevel,
							hardConstraints: true,
							preserveRouteFirepower: cfg.preserveRouteFirepower,
							preserveRouteSurvival: cfg.preserveRouteSurvival,
							navigationProbe: (ctx: NavigationProbeContext) => {
							if (collector.rows.length >= cfg.maxWindows) return;
								const branches = legalNavigationBranches(ctx.state, ctx.seat, ctx.catalog, cfg, ctx.destinations);
								if (branches.length === 0) return;
								const chosenDestination = ctx.destinations[ctx.chosenIndex];
								const sourceAction = branches.find((x) => x.cmd.type === 'lockNavigation' && x.cmd.destination === chosenDestination) ?? branches[0];
								recordWindow({ state: ctx.state, seat: ctx.seat, catalog: ctx.catalog, branches, sourceAction, gameIndex: g, profileBySeat }, cfg, collector);
							}
					});
					const sourceVp = result.finalVP[plannerSeat] ?? 0;
					collector.sourceGames++;
					collector.sourceVpSum += sourceVp;
					collector.sourceMaxVp = Math.max(collector.sourceMaxVp, sourceVp);
					if (sourceVp >= VP_TO_WIN) collector.sourceReach30++;
					if (cfg.progressEvery > 0 && (g + 1) % cfg.progressEvery === 0) {
						console.log(`[scalingq] progress games=${g + 1}/${cfg.games} windows=${collector.rows.length}/${cfg.maxWindows} corrections=${collector.rows.filter((r) => r.scalingCorrection).length} scanned=${collector.scanned} filtered=${collector.filtered}`);
					}
				}
			} else {
				for (let g = 0; g < cfg.games && collector.rows.length < cfg.maxWindows; g++) {
					const setup = setupGame(catalog, cfg.sourceSeedBase + g, cfg.seatsN);
					let state = setup.state;
					const seats = setup.seats;
					const profileBySeat = Object.fromEntries(seats.map((seat, i) => [seat, profileFor(cfg.profiles[i % cfg.profiles.length])])) as Record<string, BotProfile>;
					const rng = seededBotRandom(93_000_000 + g);
					let ticks = 0;
					while (state.status === 'active' && state.round <= cfg.maxRounds && collector.rows.length < cfg.maxWindows) {
						if (++ticks > MAX_TICKS) break;
						let progressed = false;
						for (const seat of state.activeSeats) {
							if (!botSeatNeedsToAct(state, seat)) continue;
							if (state.phase === 'navigation') {
								const branches = legalNavigationBranches(state, seat, catalog, cfg);
								if (branches.length > 0) {
									const sourceAction = heuristicNavigationBranch(state, seat, catalog, rng, profileBySeat[seat], branches);
									recordWindow({ state, seat, catalog, branches, sourceAction, gameIndex: g, profileBySeat }, cfg, collector);
								}
							}
							const plan = planBotPhaseActions(state, seat, catalog, rng, profileBySeat[seat]);
							for (const cmd of plan) {
								const r = applyGameCommand(state, botActorFor(state, seat), cmd, catalog, { mutate: true });
								if (!r.ok) break;
								state = r.state;
								progressed = true;
								if (state.status !== 'active') break;
							}
							if (state.status !== 'active' || collector.rows.length >= cfg.maxWindows) break;
						}
						if (state.status !== 'active' || collector.rows.length >= cfg.maxWindows) break;
						if (!progressed) {
							const sig = `${state.phase}:${state.round}`;
							applyDeadlineAdvance(state, catalog);
							if (`${state.phase}:${state.round}` === sig) break;
						}
					}
				}
			}

			const avg = (pick: (row: WindowRow) => number): number =>
				+(collector.rows.reduce((sum, row) => sum + pick(row), 0) / Math.max(1, collector.rows.length)).toFixed(2);
			const corrections = collector.rows.filter((r) => r.scalingCorrection);
			const summary = {
				mode: 'scaling-navigation-counterfactual',
				config: {
					games: cfg.games,
					seats: Math.min(cfg.seatsN, SEAT_COLORS.length, catalog.guardians.length),
					maxWindows: cfg.maxWindows,
					horizons: cfg.horizons,
					labelHorizon: cfg.labelHorizon,
						labelScoreThreshold: cfg.labelScoreThreshold,
						positiveOnlyData: cfg.positiveOnlyData,
						minPlayerVp: cfg.minPlayerVp,
						maxPlayerVp: cfg.maxPlayerVp,
						minRound: cfg.minRound,
						maxRound: cfg.maxRound,
						minMonsterHp: cfg.minMonsterHp,
						maxMonsterHp: cfg.maxMonsterHp,
						minCleanKillProb: cfg.minCleanKillProb,
						maxCleanKillProb: cfg.maxCleanKillProb,
						minFirepowerKillProb: cfg.minFirepowerKillProb,
						maxFirepowerKillProb: cfg.maxFirepowerKillProb,
						destinations: cfg.destinationFilter ? [...cfg.destinationFilter] : undefined,
					scoreReach30Bonus: cfg.scoreReach30Bonus,
					source: cfg.source,
						sourceSeedBase: cfg.sourceSeedBase,
						plannerProfile: cfg.plannerProfile,
						rolloutPolicy: cfg.rolloutPolicy,
						plannerWeights: cfg.plannerWeights,
						navWeights: cfg.navWeights,
						scaleNavWeights: cfg.scaleNavWeights,
						microWeights: cfg.microWeights,
						microPolicyGate: cfg.microPolicyGate,
						navigationPolicyGate: cfg.navigationPolicyGate,
						scalingNavigationPolicyGate: cfg.scalingNavigationPolicyGate,
						preserveRouteFirepower: cfg.preserveRouteFirepower,
						preserveRouteSurvival: cfg.preserveRouteSurvival
					},
				scanned: collector.scanned,
				windows: collector.rows.length,
				sourceGames: collector.sourceGames,
				sourceVpAvg: +(collector.sourceVpSum / Math.max(1, collector.sourceGames)).toFixed(2),
				sourceMaxVp: +collector.sourceMaxVp.toFixed(2),
				sourceReach30Pct: +((100 * collector.sourceReach30) / Math.max(1, collector.sourceGames)).toFixed(1),
				filtered: collector.filtered,
				skippedSingleAction: collector.skippedSingleAction,
				dataSamples: collector.samples.length,
				scalingCorrections: corrections.length,
				scalingCorrectionPct: +((100 * corrections.length) / Math.max(1, collector.rows.length)).toFixed(1),
				sourceWasBestPct: +((100 * collector.rows.filter((r) => r.sourceWasBest).length) / Math.max(1, collector.rows.length)).toFixed(1),
				avgScalingQDeltaScore: avg((r) => r.scalingQDeltaScore),
				avgScalingQDeltaVp: avg((r) => r.scalingQDeltaVp),
				avgScalingQDeltaReach30: avg((r) => r.scalingQDeltaReach30),
				avgWindowPlayerVp: avg((r) => r.playerVp),
				avgWindowPlayerExpectedAttack: avg((r) => r.playerExpectedAttack),
				avgWindowPlayerMaxBarrier: avg((r) => r.playerMaxBarrier),
					avgWindowPlayerAttackDice: avg((r) => r.playerAttackDice),
					avgWindowPlayerSpiritAnimal: avg((r) => r.playerSpiritAnimal),
					avgWindowPlayerCultivator: avg((r) => r.playerCultivator),
					avgWindowMonsterHp: avg((r) => r.monsterHp),
					avgWindowCleanKillProb: avg((r) => r.cleanKillProb),
					avgWindowFirepowerKillProb: avg((r) => r.firepowerKillProb),
					sourceDestinations: topN(collector.sourceDestinations, 12),
				bestDestinations: topN(collector.bestDestinations, 12),
				correctionBestDestinations: topN(collector.correctionBestDestinations, 12)
			};
			mkdirSync(dirname(cfg.out), { recursive: true });
			mkdirSync(dirname(cfg.summaryOut), { recursive: true });
			writeFileSync(cfg.out, `${JSON.stringify({ summary, rows: collector.rows }, null, 2)}\n`);
			writeFileSync(cfg.summaryOut, `${JSON.stringify(summary, null, 2)}\n`);
			if (cfg.dataOut) {
				appendSamples(cfg.dataOut, collector.samples, 0);
					writeFileSync(
						`${dirname(cfg.dataOut)}/meta.json`,
						`${JSON.stringify({
							obs_dim: OBS_DIM,
							act_dim: ACT_DIM,
							samples: collector.samples.length,
							games: cfg.games,
							mode: 'scaling-navigation-counterfactual',
							source: cfg.source,
							source_seed_base: cfg.sourceSeedBase,
							planner_profile: cfg.plannerProfile,
							rollout_policy: cfg.rolloutPolicy,
							planner_weights: cfg.plannerWeights,
							nav_weights: cfg.navWeights,
							scale_nav_weights: cfg.scaleNavWeights,
							micro_weights: cfg.microWeights,
							micro_policy_gate: cfg.microPolicyGate,
							navigation_policy_gate: cfg.navigationPolicyGate,
							scaling_navigation_policy_gate: cfg.scalingNavigationPolicyGate,
							preserve_route_firepower: cfg.preserveRouteFirepower,
							preserve_route_survival: cfg.preserveRouteSurvival,
							label_score_threshold: cfg.labelScoreThreshold,
							label_vp_threshold: cfg.labelVpThreshold,
							label_status_tolerance: cfg.labelStatusTolerance,
							positive_only_data: cfg.positiveOnlyData,
							window_filters: {
								min_player_vp: cfg.minPlayerVp,
								max_player_vp: cfg.maxPlayerVp,
								min_round: cfg.minRound,
								max_round: cfg.maxRound,
								destinations: cfg.destinationFilter ? [...cfg.destinationFilter] : undefined,
								min_monster_hp: cfg.minMonsterHp,
								max_monster_hp: cfg.maxMonsterHp,
								min_clean_kill_prob: cfg.minCleanKillProb,
								max_clean_kill_prob: cfg.maxCleanKillProb,
								min_firepower_kill_prob: cfg.minFirepowerKillProb,
								max_firepower_kill_prob: cfg.maxFirepowerKillProb
							}
						}, null, 2)}\n`
					);
			}
			console.log(`\n[scalingq] windows=${collector.rows.length}/${collector.scanned} filtered=${collector.filtered} corrections=${summary.scalingCorrections} avgScoreDelta=${summary.avgScalingQDeltaScore}`);
			console.log(`[scalingq] bestDest=${JSON.stringify(summary.bestDestinations)}`);
			if (cfg.dataOut) console.log(`[scalingq] samples=${collector.samples.length} -> ${cfg.dataOut}`);
			console.log(`[scalingq] DONE -> ${cfg.out}`);
		},
		60 * 60 * 1000
	);
});
