/**
 * Route-execution counterfactual diagnostic.
 *
 * Navigation route-Q can say "go build", but it still inherits the current
 * policy's row choices once the bot reaches a Spirit World location. This gate
 * branches legal location-row actions and labels the row/choice that creates
 * the best future clean monster route from normal legal starts.
 *
 * Opt in:
 *
 *   ROUTEEXECQ=1 ROUTEEXECQ_GAMES=1 \
 *     npx vitest run src/lib/play/ml/_routeexecutioncounterfactual.test.ts --disable-console-intercept
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
	buildLocationInteractions,
	type CostRequirement,
	type GainEffect,
	type LocationInteraction
} from '../locationInteractions';
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
	type FullActionProbeContext,
	type MicroPolicyGate,
	type NavigationPolicyGate
} from './selfplay';
import { BALANCED_SHAPING, buildPotential, vpOf } from './shaping';

const RUN = process.env.ROUTEEXECQ === '1';
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
const GOOD_TARGET_CONTROLLED_CORRUPT_FARM =
	(process.env.ARC_GOOD_TARGET_CONTROLLED_CORRUPT_FARM ?? process.env.ROUTEEXECQ_GOOD_TARGET_CONTROLLED_CORRUPT_FARM ?? '0') === '1';
const GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP =
	process.env.ARC_GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP !== undefined
		? parseFloat(process.env.ARC_GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP)
		: process.env.ROUTEEXECQ_GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP !== undefined
			? parseFloat(process.env.ROUTEEXECQ_GOOD_TARGET_CONTROLLED_CORRUPT_MAX_VP)
			: Number.POSITIVE_INFINITY;
const GOOD_TARGET_EXPOSE_AFTER_VP =
	process.env.ARC_GOOD_TARGET_EXPOSE_AFTER_VP !== undefined
		? parseFloat(process.env.ARC_GOOD_TARGET_EXPOSE_AFTER_VP)
		: process.env.ROUTEEXECQ_GOOD_TARGET_EXPOSE_AFTER_VP !== undefined
			? parseFloat(process.env.ROUTEEXECQ_GOOD_TARGET_EXPOSE_AFTER_VP)
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
const GOOD_BUILDER_HP4_CONVERSION_ACTION_TYPES = new Set<GameCommand['type']>([
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
	'discardHandDraws',
	'startCombat',
	'resolveMonsterReward'
]);
type RolloutPolicy = 'policy' | 'breakpoint-oracle';
type BranchScope = 'location' | 'full';

interface Config {
	games: number;
	seatsN: number;
	maxRounds: number;
	maxWindows: number;
	cleanThreshold: number;
	firepowerThreshold: number;
	selectHorizon: number;
	horizons: number[];
	labelHorizon: number;
	labelScoreThreshold: number;
	labelVpThreshold: number;
	labelStatusTolerance: number;
	positiveOnlyData: boolean;
	minPlayerVp: number;
	maxPlayerVp?: number;
	minRound: number;
	maxRound?: number;
	destinationFilter?: Set<string>;
	minMonsterHp: number;
	maxMonsterHp?: number;
	minCleanKillProb: number;
	maxCleanKillProb?: number;
	minFirepowerKillProb: number;
	maxFirepowerKillProb?: number;
	minExpectedAttack: number;
	minAttackDice: number;
	minSpiritAnimal: number;
	minCultivator: number;
	minMaxBarrier: number;
	scoreVpWeight: number;
	scoreCleanOpportunityWeight: number;
	scoreFirepowerOpportunityWeight: number;
	scoreExpectedAttackWeight: number;
	scoreAttackDiceWeight: number;
	scoreSpiritAnimalWeight: number;
	scoreCultivatorWeight: number;
	scoreBarrierWeight: number;
	scoreCurrentBarrierWeight: number;
	scoreKillWeight: number;
	scoreReach30Bonus: number;
	scoreStatusPenalty: number;
	dataOut?: string;
	branchScope: BranchScope;
	branchTypes?: Set<GameCommand['type']>;
	profiles: string[];
	out: string;
	summaryOut: string;
	forbidTypes?: Set<GameCommand['type']>;
	maxStatusLevel?: number;
	plannerPolicy?: NeuralPolicy;
	patchNavigationPolicy?: NeuralPolicy;
	patchNavigationPolicyGate: NavigationPolicyGate;
	patch2NavigationPolicy?: NeuralPolicy;
	patch2NavigationPolicyGate: NavigationPolicyGate;
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
	allPlannerSeats: boolean;
	rolloutPolicy: RolloutPolicy;
	sourceFullSelection: FullActionSelection;
	rolloutFullSelection: FullActionSelection;
	plannerWeights?: string;
	patchNavWeights?: string;
	patch2NavWeights?: string;
	navWeights?: string;
	scaleNavWeights?: string;
	microWeights?: string;
}

interface RouteSnapshot {
	vp: number;
	status: number;
	kills: number;
	cleanCombatOpportunities: number;
	firepowerCombatOpportunities: number;
	maxExpectedAttack: number;
	maxBarrier: number;
	maxCurrentBarrier: number;
	maxAttackDice: number;
	maxSpiritAnimal: number;
	maxCultivator: number;
	round: number;
}

interface RouteBranchMetrics {
	action: string;
	destination: string;
	finalVp: number;
	finalStatus: number;
	kills: number;
	combats: number;
	combatOpportunities: number;
	cleanCombatOpportunities: number;
	firepowerCombatOpportunities: number;
	maxExpectedAttack: number;
	maxBarrier: number;
	maxCurrentBarrier: number;
	maxAttackDice: number;
	maxSpiritAnimal: number;
	maxCultivator: number;
	maxHealer: number;
	maxCleanKillProb: number;
	maxFirepowerKillProb: number;
	rounds: number;
	snapshots: Record<string, RouteSnapshot>;
}

interface RouteWindowRow {
	id: string;
	game: number;
	seat: SeatColor;
	round: number;
	destination: string;
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
	legalActions: number;
	heuristicAction: string;
	bestAction: string;
	sourceWasBest: boolean;
	sourceScore: number;
	bestScore: number;
	routeExecQDeltaScore: number;
	routeExecQDeltaVp: number;
	routeExecQDeltaStatus: number;
	routeExecQDeltaReach30: number;
	routeExecCorrection: boolean;
	bestScoreDelta: number;
	bestVpDelta: number;
	bestStatusDelta: number;
	bestReach30Delta: number;
	bestCleanOpportunityDelta: number;
	bestFirepowerOpportunityDelta: number;
	bestExpectedAttackDelta: number;
	bestBarrierDelta: number;
	bestSpiritAnimalDelta: number;
	branches: RouteBranchMetrics[];
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

function parseBranchScope(raw: string | undefined): BranchScope {
	return raw === 'full' ? 'full' : 'location';
}

function parseFullActionSelection(raw: string | undefined, fallback: FullActionSelection): FullActionSelection {
	if (raw === 'policy' || raw === 'hybrid' || raw === 'value' || raw === 'lookahead') return raw;
	return fallback;
}

function parseHorizons(raw: string | undefined): number[] {
	const values = (raw ?? '3,6,10')
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

function parseDestinationFilter(raw: string | undefined): Set<string> | undefined {
	if (!raw?.trim()) return undefined;
	const values = raw.split(',')
		.map((s) => s.trim().replace(/_/g, ' '))
		.filter(Boolean);
	return values.length ? new Set(values) : undefined;
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

function clamp01(x: number): number {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

function costRequirementLabel(cost: CostRequirement): string {
	switch (cost.match) {
		case 'origin': return cost.originName;
		case 'specialRune': return cost.runeName;
		case 'anyRelic': return 'anyRelic';
		case 'anyBasic': return 'anyBasic';
	}
}

function gainEffectLabel(gain: GainEffect): string {
	switch (gain.type) {
		case 'action': return gain.action;
		case 'restoreBarrier': return 'restoreBarrier';
		case 'rune': return gain.rune.name.replace(/\s+/g, '');
		case 'vp': return `${gain.amount}VP`;
		case 'chooseRune': {
			const options = gain.options.map((o) => o.name.replace(/\s+/g, '')).slice(0, 3).join('/');
			return options ? `chooseRune:${options}` : 'chooseRune';
		}
	}
}

function locationInteractionLabel(interaction: LocationInteraction): string {
	const cost = interaction.cost.length > 0
		? interaction.cost.map(costRequirementLabel).join('+')
		: 'free';
	const gains = interaction.gains.length > 0
		? interaction.gains.map(gainEffectLabel).join('+')
		: 'none';
	return `${interaction.kind}:${cost}->${gains}`;
}

function commandLabel(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, cmd: GameCommand): string {
	const player = state.players[seat];
	if (cmd.type === 'spawnHandSpirit') {
		const draw = player?.handDraws?.find((h) => h.guid === cmd.guid);
		const slot = cmd.slotIndex === undefined ? '' : `:slot${cmd.slotIndex}`;
		return `spawnHandSpirit:${draw?.name ?? cmd.guid}${slot}`;
	}
	if (cmd.type === 'resolveMonsterReward') {
		const picks = cmd.picks.join('/');
		const choices = cmd.choices?.length ? `:choices=${cmd.choices.join('/')}` : '';
		return `resolveMonsterReward:${picks}${choices}`;
	}
	if (cmd.type === 'takeSpirit') {
		const spiritId = state.market?.[cmd.marketIndex]?.spiritId ?? '<empty>';
		const spiritName = catalog.spirits.find((s) => s.id === spiritId)?.name ?? spiritId;
		const slot = cmd.slotIndex === undefined ? '' : `:slot${cmd.slotIndex}`;
		return `takeSpirit:${cmd.marketIndex}:${spiritName}${slot}`;
	}
	if (cmd.type === 'replaceSpirit') {
		const spiritId = state.market?.[cmd.marketIndex]?.spiritId ?? '<empty>';
		const spiritName = catalog.spirits.find((s) => s.id === spiritId)?.name ?? spiritId;
		const oldName = player?.spirits?.[cmd.slotIndex]?.name ?? `slot${cmd.slotIndex}`;
		return `replaceSpirit:${cmd.marketIndex}:${spiritName}->${oldName}`;
	}
	if (cmd.type === 'absorbSpirit') return `absorbSpirit:${player?.spirits?.[cmd.slotIndex]?.name ?? cmd.slotIndex}`;
	if (cmd.type === 'attachRuneToSpirit') {
		const runeName = player?.mats?.find((m) => {
			const runtimeRuneId = (m as { runeId?: string }).runeId;
			return runtimeRuneId === cmd.runeId || m.guid === cmd.runeId || m.id === cmd.runeId;
		})?.name ?? cmd.runeId;
		const spiritName = player?.spirits?.[cmd.spiritSlotIndex]?.name ?? `slot${cmd.spiritSlotIndex}`;
		return `attachRuneToSpirit:${runeName}->${spiritName}`;
	}
	if (cmd.type === 'detachRuneFromSpirit') {
		const spiritName = player?.spirits?.[cmd.spiritSlotIndex]?.name ?? `slot${cmd.spiritSlotIndex}`;
		return `detachRuneFromSpirit:${cmd.runeId}->${spiritName}`;
	}
	if (cmd.type === 'awakenSpirit') return `awakenSpirit:${player?.spirits?.[cmd.slotIndex]?.name ?? cmd.slotIndex}`;
	if (cmd.type === 'manualAwaken') return `manualAwaken:${player?.spirits?.[cmd.slotIndex]?.name ?? cmd.slotIndex}`;
	if (cmd.type === 'resolveDecision') return `resolveDecision:${cmd.decisionId}:${cmd.optionId}`;
	if (cmd.type === 'placeAugmentOnSpirit') {
		const aug = player?.unplacedAugments?.[cmd.augmentIndex];
		const spiritName = player?.spirits?.[cmd.spiritSlotIndex]?.name ?? `slot${cmd.spiritSlotIndex}`;
		const className = cmd.className ? `:${cmd.className}` : '';
		return `placeAugmentOnSpirit:${aug?.name ?? cmd.augmentRuneId}${className}->${spiritName}`;
	}
	if (cmd.type === 'resolveAwakenReward') {
		const tainted = cmd.taintedMaxBarrier === undefined ? '' : `:taintedBarrier${cmd.taintedMaxBarrier}`;
		const relics = cmd.relicPicks?.length ? `:relics=${cmd.relicPicks.join('/')}` : '';
		return `resolveAwakenReward${tainted}${relics}`;
	}
	if (cmd.type !== 'resolveLocationInteraction') return cmd.type;
	const destination = state.players[seat]?.navigationDestination ?? '<none>';
	const loc = (catalog.locations ?? []).find((l) => l.name === destination);
	const interaction = buildLocationInteractions(loc?.rewardRows).find((it) => it.rowIndex === cmd.rowIndex);
	const choices = cmd.choices?.length ? `:choices=${cmd.choices.join('/')}` : '';
	return `${destination}:row${cmd.rowIndex}:${interaction ? locationInteractionLabel(interaction) : 'unknown'}${choices}`;
}

function setupGame(catalog: PlayCatalog, seed: number, seatsN: number): { state: PublicGameState; seats: SeatColor[] } {
	const n = Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
	const seats = SEAT_COLORS.slice(0, n) as SeatColor[];
	const guardianNames = catalog.guardians.map((g) => g.name).slice(0, n);
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	let state = createLobbyState({ roomCode: 'REXQ', guardianNames });
	const expectOk = (r: ReturnType<typeof applyGameCommand>, label: string): void => {
		if (!r.ok) throw new Error(`${label}: ${r.error.code} ${r.error.message}`);
		state = r.state;
	};
	seats.forEach((seat, i) => {
		const memberId = `bot-${seat}`;
		expectOk(
			applyGameCommand(
				state,
				{ memberId, displayName: seat, role: 'player', seatColor: null },
				{ type: 'claimSeat', seatColor: seat },
				catalog
			),
			`claimSeat ${seat}`
		);
		expectOk(
			applyGameCommand(
				state,
				{ memberId, displayName: seat, role: 'player', seatColor: seat },
				{ type: 'selectGuardian', guardianName: guardianNames[i] },
				catalog
			),
			`selectGuardian ${seat}`
		);
	});
	expectOk(applyGameCommand(state, host, { type: 'startGame', seed }, catalog), 'startGame');
	return { state, seats };
}

function filterTargetPlan(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	plan: GameCommand[],
	cfg: Config
): GameCommand[] {
	if (!cfg.forbidTypes?.size && cfg.maxStatusLevel === undefined) return plan;
	const out: GameCommand[] = [];
	let probeState = state;
	for (const cmd of plan) {
		if (cfg.forbidTypes?.has(cmd.type)) continue;
		const probe = applyGameCommand(probeState, botActorFor(probeState, seat), cmd, catalog);
		if (!probe.ok) continue;
		if (cfg.maxStatusLevel !== undefined && (probe.state.players[seat]?.statusLevel ?? 0) > cfg.maxStatusLevel) {
			continue;
		}
		out.push(cmd);
		probeState = probe.state;
	}
	return out;
}

function legalLocationBranches(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, cfg: Config): LegalAction[] {
	return legalActionsWithNext(state, seat, catalog)
		.filter((x) => x.cmd.type === 'resolveLocationInteraction')
		.filter((x) => {
			if (cfg.forbidTypes?.has(x.cmd.type)) return false;
			return cfg.maxStatusLevel === undefined || (x.next.players[seat]?.statusLevel ?? 0) <= cfg.maxStatusLevel;
		});
}

function branchActionsForScope(withNext: LegalAction[], cfg: Config): LegalAction[] {
	const scoped = cfg.branchScope === 'location'
		? withNext.filter((x) => x.cmd.type === 'resolveLocationInteraction')
		: withNext;
	if (!cfg.branchTypes?.size) return scoped;
	return scoped.filter((x) => cfg.branchTypes?.has(x.cmd.type));
}

function combatReadyButNeedsRestore(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, cfg: Config): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) !== 0) return false;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	if (cleanProb >= cfg.cleanThreshold) return false;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	const attack = expectedAttack(player);
	const damageReady = firepowerProb >= cfg.firepowerThreshold || (monsterHp > 0 && attack >= monsterHp - 0.01);
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

function appendDestination(destinations: NavigationDestination[], destination: NavigationDestination): void {
	if (!destinations.includes(destination)) destinations.push(destination);
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
	const farm = evaluateFarmValue(state, seat, catalog, { threshold: cfg.cleanThreshold });
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
		clean >= cfg.cleanThreshold ||
		(
			canSpendCorruptionAndRemainGood &&
			(corrupt >= cfg.cleanThreshold || firepower >= cfg.firepowerThreshold || attack >= monsterHp - 0.01)
		);
	const nearDamage =
		clean >= cfg.cleanThreshold * 0.65 ||
		(
			canSpendCorruptionAndRemainGood &&
			(corrupt >= cfg.cleanThreshold * 0.65 || firepower >= cfg.firepowerThreshold * 0.65 || attack >= monsterHp - 0.75)
		);
	if (farm.rewardVp >= 3 && controlledOpportunityVp >= 2 && lives >= 2 && monsterHp <= 2 && nearDamage && vp < 24) return true;
	const efficientHp4Farm =
		controlledOpportunityVp >= 2 &&
		monsterHp <= 4 &&
		(vp < 18 || farm.rewardVp >= 3 || lives >= 2) &&
		nearDamage;
	if (efficientHp4Farm && vp < 24) return true;
	const reliablePrePivotHardFarm =
		vp < 21 &&
		monsterHp <= 5 &&
		(damageReady || clean >= cfg.cleanThreshold * 0.65 || firepower >= cfg.firepowerThreshold * 0.65);
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
	const needsDamage = monsterHp > 0 && attack < monsterHp + 0.5 && firepower < cfg.firepowerThreshold && clean < cfg.cleanThreshold;
	const needsRestore = survivalTarget > 0 && maxBarrier >= survivalTarget && barrier < survivalTarget;
	const needsMaxBarrier = survivalTarget > 0 && maxBarrier < survivalTarget && (counts.Cultivator ?? 0) >= 2;
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

function shouldUseNavigationGate(
	gate: NavigationPolicyGate,
	policy: NeuralPolicy | undefined,
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): boolean {
	if (!policy) return false;
	if (gate === 'all') return true;
	if (gate === 'good-nonfallen-farm-build' || gate === 'good-nonfallen-farm-target-pivot') {
		const player = state.players[seat];
		return !!player && !!state.monster && (cfg.maxStatusLevel === undefined || (player.statusLevel ?? 0) <= cfg.maxStatusLevel);
	}
	if (gate === 'midroute-scaling') {
		const player = state.players[seat];
		if (!player || (player.statusLevel ?? 0) !== 0) return false;
		const farm = evaluateFarmValue(state, seat, catalog, { threshold: cfg.cleanThreshold });
		if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
		return state.round >= 4 && (player.victoryPoints ?? 0) >= 6;
	}
		if (gate === 'route-option-scaling') {
		const player = state.players[seat];
		if (!player || !state.monster || (player.statusLevel ?? 0) !== 0) return false;
		const farm = evaluateFarmValue(state, seat, catalog, { threshold: cfg.cleanThreshold });
		if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
		const vp = player.victoryPoints ?? 0;
		if (state.round < 8 || vp < 10 || vp >= 24) return false;
		const counts = awakenedClassCounts(player);
		const attackDice = player.attackDice?.length ?? 0;
		const attack = expectedAttack(player);
		const monsterHp = state.monster.maxHp ?? state.monster.hp ?? 0;
		const firepowerProb = firepowerKillProbability(state, seat, catalog);
		const needsDamage = monsterHp > 0 && (firepowerProb < cfg.cleanThreshold || attack < monsterHp + 1);
		if (needsDamage) return true;
		if (combatReadyButNeedsRestore(state, seat, catalog, cfg)) return true;
		if ((player.barrier ?? 0) < (player.maxBarrier ?? 0)) return false;
		if (state.round % 3 !== 0) return false;
			const underScaled =
			attackDice < 2 ||
			attack < 5 ||
			(counts.Cultivator ?? 0) < 2 ||
			(player.maxBarrier ?? 0) < 6;
			return needsDamage || underScaled;
		}
		if (gate === 'clean-farm-q') {
			const player = state.players[seat];
			if (!player || (player.statusLevel ?? 0) !== 0) return false;
			const farm = evaluateFarmValue(state, seat, catalog, { threshold: cfg.cleanThreshold });
			return farm.valid && farm.farmable && farm.opportunityVp >= 1;
		}
		if (gate === 'hp2-survival-deficit') {
		const player = state.players[seat];
		const monster = state.monster;
		if (!player || !monster || (player.statusLevel ?? 0) !== 0) return false;
		const vp = player.victoryPoints ?? 0;
		const monsterHp = monster.maxHp ?? monster.hp ?? 0;
		if (state.round < 6 || state.round > 18 || vp < 9 || vp > 18 || Math.abs(monsterHp - 2) > 0.01) {
			return false;
		}
		const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
		if (cleanProb >= cfg.cleanThreshold) return false;
		const firepowerProb = firepowerKillProbability(state, seat, catalog);
		if (expectedAttack(player) >= 3.25) return false;
		return firepowerProb >= cfg.firepowerThreshold && combatReadyButNeedsRestore(state, seat, catalog, cfg);
	}
	if (gate === 'hp4-first-wall') {
		const player = state.players[seat];
		const monster = state.monster;
		if (!player || !monster || (player.statusLevel ?? 0) !== 0) return false;
		const vp = player.victoryPoints ?? 0;
		const monsterHp = monster.maxHp ?? monster.hp ?? 0;
		if (state.round < 9 || state.round > 22 || vp < 12 || vp > 22 || monsterHp < 4 || monsterHp > 5) return false;
		const farm = evaluateFarmValue(state, seat, catalog, { threshold: cfg.cleanThreshold });
		if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
		const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
		if (cleanProb >= cfg.cleanThreshold) return false;
		const firepowerProb = firepowerKillProbability(state, seat, catalog);
		const monsterDamage = monster.damage ?? 0;
		const survivalTarget = monsterDamage + 1;
		const barrier = player.barrier ?? 0;
		const maxBarrier = player.maxBarrier ?? 0;
		const attack = expectedAttack(player);
		return firepowerProb >= 0.35 ||
			attack >= monsterHp - 0.75 ||
			(survivalTarget > 0 && (barrier < survivalTarget || maxBarrier < survivalTarget + 1));
	}
	if (gate === 'route-closer') {
		const player = state.players[seat];
		if (!player || !state.monster || (player.statusLevel ?? 0) !== 0) return false;
		const farm = evaluateFarmValue(state, seat, catalog, { threshold: cfg.cleanThreshold });
		if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
		const vp = player.victoryPoints ?? 0;
		const monsterHp = state.monster.maxHp ?? state.monster.hp ?? 0;
		if (state.round < 12 || vp < 15 || vp >= 30 || monsterHp < 4) return false;
		const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
		if (cleanProb >= cfg.cleanThreshold) return false;
		const monsterDamage = state.monster.damage ?? 0;
		const attack = expectedAttack(player);
		const firepowerProb = firepowerKillProbability(state, seat, catalog);
		const survivalTarget = monsterDamage + 1;
		const maxBarrier = player.maxBarrier ?? 0;
		const barrier = player.barrier ?? 0;
		const damageDeficit = monsterHp > 0 && (firepowerProb < cfg.firepowerThreshold || attack < monsterHp + 0.5);
		const maxBarrierDeficit = survivalTarget > 0 && maxBarrier < survivalTarget;
		const restoreDeficit = survivalTarget > 0 && maxBarrier >= survivalTarget && barrier < survivalTarget;
		return damageDeficit || maxBarrierDeficit || restoreDeficit;
	}
	if (gate === 'route-finish-loop') {
		return routeCloserRestoreFinishState(state, seat, catalog, cfg);
	}
	if (gate === 'survival-rebuild') {
		const player = state.players[seat];
		if (!player || !state.monster || (player.statusLevel ?? 0) !== 0) return false;
		const farm = evaluateFarmValue(state, seat, catalog, { threshold: cfg.cleanThreshold });
		if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
		const monsterHp = state.monster.maxHp ?? state.monster.hp ?? 0;
		const monsterDamage = state.monster.damage ?? 0;
		const vp = player.victoryPoints ?? 0;
		if (state.round < 5 || vp < 9 || monsterHp < 2) return false;
		const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
		if (cleanProb >= cfg.cleanThreshold) return false;
		const attack = expectedAttack(player);
		const firepowerProb = firepowerKillProbability(state, seat, catalog);
		const barrierDeficit = (player.barrier ?? 0) < Math.min(player.maxBarrier ?? 0, monsterDamage + 1);
		const maxBarrierDeficit = (player.maxBarrier ?? 0) < monsterDamage + 2;
		const damageDeficit = attack < monsterHp + 0.5 || firepowerProb < cfg.firepowerThreshold;
		return monsterHp >= 4 || barrierDeficit || maxBarrierDeficit || damageDeficit;
	}
	const player = state.players[seat];
	if (!player || !state.monster || (player.statusLevel ?? 0) !== 0) return false;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	return firepowerProb >= cfg.firepowerThreshold && cleanProb < cfg.cleanThreshold;
}

function routeCloserFullActionState(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, cfg: Config): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) !== 0) return false;
	const vp = player.victoryPoints ?? 0;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	if (state.round < 12 || vp < 15 || vp >= 30 || monsterHp < 4) return false;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold: cfg.cleanThreshold });
	if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	if (cleanProb >= cfg.cleanThreshold) return false;
	const monsterDamage = monster.damage ?? 0;
	const attack = expectedAttack(player);
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	const survivalTarget = monsterDamage + 1;
	const maxBarrier = player.maxBarrier ?? 0;
	const barrier = player.barrier ?? 0;
	const damageDeficit = monsterHp > 0 && (
		attack < monsterHp + 0.5 ||
		firepowerProb < cfg.firepowerThreshold
	);
	const maxBarrierDeficit = survivalTarget > 0 && maxBarrier < survivalTarget;
	const restoreDeficit = survivalTarget > 0 && maxBarrier >= survivalTarget && barrier < survivalTarget;
	return damageDeficit || maxBarrierDeficit || restoreDeficit;
}

function routeCloserRestoreFinishState(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, cfg: Config): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || (player.statusLevel ?? 0) !== 0) return false;
	const vp = player.victoryPoints ?? 0;
	const monsterHp = monster.maxHp ?? monster.hp ?? 0;
	if (state.round < 16 || vp < 24 || vp >= VP_TO_WIN || monsterHp < 4 || monsterHp > 10) return false;
	const farm = evaluateFarmValue(state, seat, catalog, { threshold: cfg.cleanThreshold });
	const finishOpportunity = farm.valid &&
		farm.rewardVp > 0 &&
		vp + farm.rewardVp * Math.max(1, farm.livesRemaining) >= VP_TO_WIN;
	if (!finishOpportunity) return false;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	const survivalTarget = (monster.damage ?? 0) + 1;
	const maxBarrier = player.maxBarrier ?? 0;
	const barrier = player.barrier ?? 0;
	if (survivalTarget <= 0 || maxBarrier < survivalTarget) return false;
	const restoreDeficit = barrier < survivalTarget;
	const currentSurvivalReady = barrier >= survivalTarget;
	const enoughFirepower = cleanProb >= cfg.cleanThreshold || firepowerProb >= cfg.firepowerThreshold;
	return restoreDeficit || (currentSurvivalReady && enoughFirepower);
}

function navigationRootDestinationsForGate(
	gate: NavigationPolicyGate,
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): NavigationDestination[] | undefined {
	if (gate === 'good-nonfallen-farm-build' || gate === 'good-nonfallen-farm-target-pivot') {
		return goodTargetPivotDestinations(state, seat, catalog, cfg);
	}
	if (gate === 'unsafe-firepower-build-option') {
		return combatReadyButNeedsRestore(state, seat, catalog, cfg)
			? RESTORE_OPTION_DESTINATIONS
			: BUILD_OPTION_DESTINATIONS;
	}
	if (gate === 'route-option-scaling') {
		return combatReadyButNeedsRestore(state, seat, catalog, cfg)
			? RESTORE_OPTION_DESTINATIONS
			: SCALING_OPTION_DESTINATIONS;
	}
	if (gate === 'hp2-survival-deficit') {
		return RESTORE_OPTION_DESTINATIONS;
	}
	if (gate === 'hp4-first-wall') {
		return ['Arcane Abyss', 'Lantern Canyon', 'Floral Patch'];
	}
	if (gate === 'route-closer') {
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
			firepowerProb < cfg.firepowerThreshold
		);
		if (damageDeficit) return CLOSER_DAMAGE_DESTINATIONS;
		if (survivalTarget > 0 && maxBarrier < survivalTarget) return CLOSER_MAX_BARRIER_DESTINATIONS;
		if (survivalTarget > 0 && barrier < survivalTarget) return CLOSER_RESTORE_DESTINATIONS;
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
		const enoughFirepower =
			cleanProb >= cfg.cleanThreshold ||
			firepowerProb >= cfg.firepowerThreshold ||
			attack >= monsterHp - 0.01;
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
		const damageDeficit = monsterHp > 0 && (
			attack < monsterHp + 0.5 ||
			firepowerProb < cfg.firepowerThreshold
		);
		return damageDeficit
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
): { priorPolicy: NeuralPolicy; rootDestinations?: NavigationDestination[] } | null {
	const candidates: Array<[NeuralPolicy | undefined, NavigationPolicyGate]> = [
		[cfg.patchNavigationPolicy, cfg.patchNavigationPolicyGate],
		[cfg.patch2NavigationPolicy, cfg.patch2NavigationPolicyGate],
		[cfg.navigationPolicy, cfg.navigationPolicyGate],
		[cfg.scalingNavigationPolicy, cfg.scalingNavigationPolicyGate]
	];
	for (const [policy, gate] of candidates) {
		if (!policy || !shouldUseNavigationGate(gate, policy, state, seat, catalog, cfg)) continue;
		return {
			priorPolicy: policy,
			rootDestinations: navigationRootDestinationsForGate(gate, state, seat, catalog, cfg)
		};
	}
	return cfg.plannerPolicy ? { priorPolicy: cfg.plannerPolicy } : null;
}

function plannerNavigationCommand(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config,
	seed: number
): GameCommand | null {
	if (!cfg.plannerPolicy || state.phase !== 'navigation') return null;
	const selection = navigationSelection(state, seat, catalog, cfg);
	if (!selection) return null;
	const result = neuralPlanNavigation(state, seat, catalog, cfg.plannerPolicy, {
		iterations: cfg.plannerIterations,
		horizon: cfg.plannerHorizon,
		valueWeight: cfg.plannerValueWeight,
		c: 1.5,
		priorPolicy: selection.priorPolicy,
		rootDestinations: selection.rootDestinations,
		seed
	});
	if (!result) return null;
	let best = 0;
	for (let i = 1; i < result.visits.length; i++) {
		if (result.visits[i] > result.visits[best]) best = i;
	}
	return { type: 'lockNavigation', destination: result.destinations[best] };
}

function recordBuild(metrics: RouteBranchMetrics, state: PublicGameState, seat: SeatColor): void {
	const player = state.players[seat];
	if (!player) return;
	const counts = awakenedClassCounts(player);
	metrics.maxExpectedAttack = Math.max(metrics.maxExpectedAttack, expectedAttack(player));
	metrics.maxBarrier = Math.max(metrics.maxBarrier, player.maxBarrier ?? 0);
	metrics.maxCurrentBarrier = Math.max(metrics.maxCurrentBarrier, player.barrier ?? 0);
	metrics.maxAttackDice = Math.max(metrics.maxAttackDice, player.attackDice?.length ?? 0);
	metrics.maxSpiritAnimal = Math.max(metrics.maxSpiritAnimal, counts['Spirit Animal'] ?? 0);
	metrics.maxCultivator = Math.max(metrics.maxCultivator, counts.Cultivator ?? 0);
	metrics.maxHealer = Math.max(metrics.maxHealer, counts.Healer ?? 0);
}

function newBranchMetrics(action: string, destination: string, state: PublicGameState, seat: SeatColor, startRound: number): RouteBranchMetrics {
	const player = state.players[seat];
	const metrics: RouteBranchMetrics = {
		action,
		destination,
		finalVp: player?.victoryPoints ?? 0,
		finalStatus: player?.statusLevel ?? 0,
		kills: 0,
		combats: 0,
		combatOpportunities: 0,
		cleanCombatOpportunities: 0,
		firepowerCombatOpportunities: 0,
		maxExpectedAttack: 0,
		maxBarrier: player?.maxBarrier ?? 0,
		maxCurrentBarrier: player?.barrier ?? 0,
		maxAttackDice: player?.attackDice?.length ?? 0,
		maxSpiritAnimal: 0,
		maxCultivator: 0,
		maxHealer: 0,
		maxCleanKillProb: 0,
		maxFirepowerKillProb: 0,
		rounds: state.round - startRound,
		snapshots: {}
	};
	recordBuild(metrics, state, seat);
	return metrics;
}

function snapshot(metrics: RouteBranchMetrics, state: PublicGameState, seat: SeatColor, key: number): void {
	const player = state.players[seat];
	metrics.snapshots[String(key)] = {
		vp: player?.victoryPoints ?? 0,
		status: player?.statusLevel ?? 0,
		kills: metrics.kills,
		cleanCombatOpportunities: metrics.cleanCombatOpportunities,
		firepowerCombatOpportunities: metrics.firepowerCombatOpportunities,
		maxExpectedAttack: metrics.maxExpectedAttack,
		maxBarrier: metrics.maxBarrier,
		maxCurrentBarrier: metrics.maxCurrentBarrier,
		maxAttackDice: metrics.maxAttackDice,
		maxSpiritAnimal: metrics.maxSpiritAnimal,
		maxCultivator: metrics.maxCultivator,
		round: state.round
	};
}

function recordCombatOpportunity(
	metrics: RouteBranchMetrics,
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cfg: Config
): void {
	const legalCombat = legalActionsWithNext(state, seat, catalog).some((x) => x.cmd.type === 'startCombat');
	if (!legalCombat) return;
	const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
	const firepowerProb = firepowerKillProbability(state, seat, catalog);
	metrics.combatOpportunities++;
	metrics.maxCleanKillProb = Math.max(metrics.maxCleanKillProb, cleanProb);
	metrics.maxFirepowerKillProb = Math.max(metrics.maxFirepowerKillProb, firepowerProb);
	if (cleanProb >= cfg.cleanThreshold) metrics.cleanCombatOpportunities++;
	if (firepowerProb >= cfg.firepowerThreshold) metrics.firepowerCombatOpportunities++;
}

function microDecisionSet(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
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
		(gate === 'route-closer-full' && routeCloserFullActionState(state, seat, catalog, cfg)) ||
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
		cfg.firepowerThreshold
	);
	if (withNext.length === 0) return null;
	if (cfg.rolloutPolicy === 'breakpoint-oracle') {
		return chooseRouteBreakpointOracleAction(state, seat, catalog, withNext, {
			cleanThreshold: cfg.cleanThreshold,
			firepowerThreshold: cfg.firepowerThreshold
		});
	}
	if (cfg.microPolicyGate === 'route-closer-oracle' && routeCloserFullActionState(state, seat, catalog, cfg)) {
		return chooseRouteBreakpointOracleAction(state, seat, catalog, withNext, {
			cleanThreshold: cfg.cleanThreshold,
			firepowerThreshold: cfg.firepowerThreshold
		});
	}
	if (cfg.microPolicyGate === 'route-finish-oracle' && routeCloserRestoreFinishState(state, seat, catalog, cfg)) {
		return chooseRouteFinishLoopOracleAction(state, seat, catalog, withNext, {
			cleanThreshold: cfg.cleanThreshold,
			firepowerThreshold: cfg.firepowerThreshold
		});
	}
	if (!cfg.plannerPolicy) return null;
	if (cfg.microPolicyGate === 'good-builder-hp4-conversion-oracle') {
		const mainDecision = chooseFullActionDecision(
			cfg.plannerPolicy,
			state,
			seat,
			withNext,
			catalog,
			cfg.rolloutFullSelection,
			ROLLOUT_FULL_LOOKAHEAD_DEPTH,
			ROLLOUT_FULL_LOOKAHEAD_BEAM,
			ROLLOUT_FULL_LOOKAHEAD_ROOT_BEAM,
			ROLLOUT_FULL_TARGET_TEMPERATURE,
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
			const scoreOpts = {
				cleanThreshold: cfg.cleanThreshold,
				firepowerThreshold: cfg.firepowerThreshold
			};
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
			if (oracleScore >= mainScore) return withNext[oracleIdx] ?? null;
		}
		return withNext[mainDecision.idx] ?? null;
	}
	if (cfg.microPolicyGate === 'good-builder-hp4-conversion-overlay' && cfg.microPolicy) {
		const mainDecision = chooseFullActionDecision(
			cfg.plannerPolicy,
			state,
			seat,
			withNext,
			catalog,
			cfg.rolloutFullSelection,
			ROLLOUT_FULL_LOOKAHEAD_DEPTH,
			ROLLOUT_FULL_LOOKAHEAD_BEAM,
			ROLLOUT_FULL_LOOKAHEAD_ROOT_BEAM,
			ROLLOUT_FULL_TARGET_TEMPERATURE,
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
				ROLLOUT_FULL_LOOKAHEAD_DEPTH,
				ROLLOUT_FULL_LOOKAHEAD_BEAM,
				ROLLOUT_FULL_LOOKAHEAD_ROOT_BEAM,
				ROLLOUT_FULL_TARGET_TEMPERATURE,
				false,
				1,
				rng
			);
			const overlayIdx = indexMap[overlayDecision.idx] ?? mainDecision.idx;
			const scoreOpts = {
				cleanThreshold: cfg.cleanThreshold,
				firepowerThreshold: cfg.firepowerThreshold
			};
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
			if (overlayScore >= mainScore) return withNext[overlayIdx] ?? null;
		}
		return withNext[mainDecision.idx] ?? null;
	}
	const decisionSet = microDecisionSet(state, seat, catalog, withNext, cfg);
	if (!decisionSet) return null;
		const decision = chooseFullActionDecision(
			decisionSet.policy,
		state,
		seat,
		decisionSet.withNext,
		catalog,
			cfg.rolloutFullSelection,
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
	action: string,
	destination: string,
	startRound: number,
	horizons: number[]
): RouteBranchMetrics {
	let state = initial;
	const maxHorizon = Math.max(...horizons);
	const rng = seededBotRandom(seed);
	const fullActionRng = createRng((seed ^ 0x7eec0de) >>> 0 || 1);
	const metrics = newBranchMetrics(action, destination, state, seat, startRound);
	const actionCounter = new Map<string, number>();
	let ticks = 0;
	while (state.status === 'active' && state.round < startRound + maxHorizon && ticks++ < MAX_TICKS) {
		let progressed = false;
		for (const activeSeat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, activeSeat)) continue;
			const key = `${activeSeat}:${state.round}:${state.phase}`;
			const used = actionCounter.get(key) ?? 0;
			if (used >= MAX_ACTIONS_PER_PHASE) continue;
			if (activeSeat === seat) recordCombatOpportunity(metrics, state, seat, catalog, cfg);
			if (activeSeat === seat && state.phase === 'navigation') {
				const nav = plannerNavigationCommand(
					state,
					activeSeat,
					catalog,
					cfg,
					15_300_000 + seed + state.round * 31 + ticks
				);
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
						for (const h of horizons) {
							if (state.round >= startRound + h && metrics.snapshots[String(h)] === undefined) {
								snapshot(metrics, state, seat, h);
							}
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
				for (const h of horizons) {
					if (state.round >= startRound + h && metrics.snapshots[String(h)] === undefined) {
						snapshot(metrics, state, seat, h);
					}
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
	for (const h of horizons) {
		if (metrics.snapshots[String(h)] === undefined) snapshot(metrics, state, seat, h);
	}
	metrics.finalVp = state.players[seat]?.victoryPoints ?? 0;
	metrics.finalStatus = state.players[seat]?.statusLevel ?? 0;
	metrics.rounds = state.round - startRound;
	return metrics;
}

function snapAt(metrics: RouteBranchMetrics, horizon: number): RouteSnapshot {
	return metrics.snapshots[String(horizon)] ?? {
		vp: metrics.finalVp,
		status: metrics.finalStatus,
		kills: metrics.kills,
		cleanCombatOpportunities: metrics.cleanCombatOpportunities,
		firepowerCombatOpportunities: metrics.firepowerCombatOpportunities,
		maxExpectedAttack: metrics.maxExpectedAttack,
		maxBarrier: metrics.maxBarrier,
		maxCurrentBarrier: metrics.maxCurrentBarrier,
		maxAttackDice: metrics.maxAttackDice,
		maxSpiritAnimal: metrics.maxSpiritAnimal,
		maxCultivator: metrics.maxCultivator,
		round: 0
	};
}

function reached30(metrics: RouteBranchMetrics, horizon: number): boolean {
	return snapAt(metrics, horizon).vp >= VP_TO_WIN;
}

function branchScore(metrics: RouteBranchMetrics, horizon: number, cfg: Config): number {
	const snap = snapAt(metrics, horizon);
	return (
		snap.vp * cfg.scoreVpWeight +
		snap.cleanCombatOpportunities * cfg.scoreCleanOpportunityWeight +
		snap.firepowerCombatOpportunities * cfg.scoreFirepowerOpportunityWeight +
		snap.maxExpectedAttack * cfg.scoreExpectedAttackWeight +
		snap.maxAttackDice * cfg.scoreAttackDiceWeight +
		snap.maxSpiritAnimal * cfg.scoreSpiritAnimalWeight +
		snap.maxCultivator * cfg.scoreCultivatorWeight +
		snap.maxBarrier * cfg.scoreBarrierWeight +
		snap.maxCurrentBarrier * cfg.scoreCurrentBarrierWeight +
		snap.kills * cfg.scoreKillWeight +
		(reached30(metrics, horizon) ? cfg.scoreReach30Bonus : 0) -
		snap.status * cfg.scoreStatusPenalty
	);
}

interface PlayerWindowBuild {
	vp: number;
	status: number;
	expectedAttack: number;
	maxBarrier: number;
	currentBarrier: number;
	attackDice: number;
	spiritAnimal: number;
	cultivator: number;
}

function playerWindowBuild(state: PublicGameState, seat: SeatColor): PlayerWindowBuild {
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
			cultivator: 0
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

function routeWindowMatches(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, cfg: Config): boolean {
	return routeWindowRejectReason(state, seat, catalog, cfg) === null;
}

function routeWindowRejectReason(state: PublicGameState, seat: SeatColor, catalog: PlayCatalog, cfg: Config): string | null {
	const destination = state.players[seat]?.navigationDestination ?? '<none>';
	if (cfg.destinationFilter && !cfg.destinationFilter.has(destination)) return 'destination';
	const build = playerWindowBuild(state, seat);
	if (cfg.maxStatusLevel !== undefined && build.status > cfg.maxStatusLevel) return 'maxStatusLevel';
	if (build.vp < cfg.minPlayerVp) return 'minPlayerVp';
	if (cfg.maxPlayerVp !== undefined && build.vp > cfg.maxPlayerVp) return 'maxPlayerVp';
	if (state.round < cfg.minRound) return 'minRound';
	if (cfg.maxRound !== undefined && state.round > cfg.maxRound) return 'maxRound';
	const monster = monsterWindowSignal(state, seat, catalog);
	if (monster.monsterHp < cfg.minMonsterHp) return 'minMonsterHp';
	if (cfg.maxMonsterHp !== undefined && monster.monsterHp > cfg.maxMonsterHp) return 'maxMonsterHp';
	if (monster.cleanKillProb < cfg.minCleanKillProb) return 'minCleanKillProb';
	if (cfg.maxCleanKillProb !== undefined && monster.cleanKillProb > cfg.maxCleanKillProb) return 'maxCleanKillProb';
	if (monster.firepowerKillProb < cfg.minFirepowerKillProb) return 'minFirepowerKillProb';
	if (cfg.maxFirepowerKillProb !== undefined && monster.firepowerKillProb > cfg.maxFirepowerKillProb) return 'maxFirepowerKillProb';
	if (build.expectedAttack < cfg.minExpectedAttack) return 'minExpectedAttack';
	if (build.attackDice < cfg.minAttackDice) return 'minAttackDice';
	if (build.spiritAnimal < cfg.minSpiritAnimal) return 'minSpiritAnimal';
	if (build.cultivator < cfg.minCultivator) return 'minCultivator';
	if (build.maxBarrier < cfg.minMaxBarrier) return 'minMaxBarrier';
	return null;
}

function heuristicLocationBranch(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	rng: BotRandom,
	profile: BotProfile,
	branches: LegalAction[]
): LegalAction {
	const plan = planBotPhaseActions(state, seat, catalog, rng, profile);
	const row = plan.find((cmd) => cmd.type === 'resolveLocationInteraction');
	if (row) {
		const match = branches.find((x) => commandMatches(x.cmd, row));
		if (match) return match;
	}
	return branches[0];
}

function recordLocationSample(
	samples: Sample[],
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	chosenIdx: number,
	chosenMetrics: RouteBranchMetrics,
	labelHorizon: number
): void {
	if (withNext.length <= 1 || chosenIdx < 0) return;
	const chosenSnap = snapAt(chosenMetrics, labelHorizon);
	samples.push({
		obs: encodeObs(state, seat),
		cands: withNext.map((x) => encodeAction(state, seat, x.cmd, x.next, catalog)),
		chosen: chosenIdx,
		pi: withNext.map((_, i) => (i === chosenIdx ? 1 : 0)),
		ret: clamp01(Math.max(vpOf(state.players[seat]), chosenSnap.vp) / VP_TO_WIN),
		seat,
		vp: vpOf(state.players[seat]),
		phi: buildPotential(state.players[seat], BALANCED_SHAPING),
		kill: 0,
		...sampleAuxTargets(state, seat, catalog, withNext)
	});
}

function addCount(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

function topN(counts: Record<string, number>, n: number): Record<string, number> {
	return Object.fromEntries(
		Object.entries(counts)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, n)
	);
}

function countCorrections(collector: CollectorState): number {
	return collector.rows.filter((r) => r.routeExecCorrection).length;
}

function logProgress(cfg: Config, collector: CollectorState, gamesDone: number, gamesTotal: number): void {
	if (cfg.progressEvery <= 0 || gamesDone % cfg.progressEvery !== 0) return;
	/* eslint-disable no-console */
	console.log(
		`[routeexecq] progress games=${gamesDone}/${gamesTotal} windows=${collector.rows.length}/${collector.maxWindows ?? '?'} ` +
		`corrections=${countCorrections(collector)} scanned=${collector.scannedLocationWindows} filtered=${collector.skippedWindowFilter}`
	);
	/* eslint-enable no-console */
}

interface CollectorState {
	rows: RouteWindowRow[];
	samples: Sample[];
	sourceGames: number;
	sourceVpSum: number;
	sourceMaxVp: number;
	sourceReach30: number;
	scannedLocationWindows: number;
	skippedWindowFilter: number;
	skippedWindowReasons: Record<string, number>;
	filteredMaxPlayerVp: number;
	filteredMaxRound: number;
	filteredMaxMonsterHp: number;
	filteredMaxExpectedAttack: number;
	filteredMaxBarrier: number;
	filteredMaxSpiritAnimal: number;
	skippedSingleAction: number;
	bestActionCounts: Record<string, number>;
	sourceActionCounts: Record<string, number>;
	destinationCounts: Record<string, number>;
	maxWindows?: number;
}

function recordRouteExecutionWindow(
	source: {
		state: PublicGameState;
		seat: SeatColor;
		catalog: PlayCatalog;
		branches: LegalAction[];
		sourceAction: LegalAction;
		sourceLabel: string;
		gameIndex: number;
		profileBySeat: Record<string, BotProfile>;
	},
	cfg: Config,
	collector: CollectorState
): void {
	collector.scannedLocationWindows++;
	const rejectReason = routeWindowRejectReason(source.state, source.seat, source.catalog, cfg);
	if (rejectReason) {
		const build = playerWindowBuild(source.state, source.seat);
		const monster = monsterWindowSignal(source.state, source.seat, source.catalog);
		collector.skippedWindowFilter++;
		addCount(collector.skippedWindowReasons, rejectReason);
		collector.filteredMaxPlayerVp = Math.max(collector.filteredMaxPlayerVp, build.vp);
		collector.filteredMaxRound = Math.max(collector.filteredMaxRound, source.state.round);
		collector.filteredMaxMonsterHp = Math.max(collector.filteredMaxMonsterHp, monster.monsterHp);
		collector.filteredMaxExpectedAttack = Math.max(collector.filteredMaxExpectedAttack, build.expectedAttack);
		collector.filteredMaxBarrier = Math.max(collector.filteredMaxBarrier, build.maxBarrier);
		collector.filteredMaxSpiritAnimal = Math.max(collector.filteredMaxSpiritAnimal, build.spiritAnimal);
		return;
	}
	if (source.branches.length < 2) {
		collector.skippedSingleAction++;
		return;
	}
	const destination = source.state.players[source.seat]?.navigationDestination ?? '<none>';
	addCount(collector.destinationCounts, destination);
	const windowIndex = collector.rows.length;
	const metrics = source.branches.map((branch, i) => rolloutBranch(
		branch.next,
		source.seat,
		source.catalog,
		source.profileBySeat,
		cfg,
		14_300_000 + source.gameIndex * 10_000 + windowIndex * 100 + i,
		commandLabel(source.state, source.seat, source.catalog, branch.cmd),
		destination,
		source.state.round,
		cfg.horizons
	));
	let bestIdx = 0;
	for (let i = 1; i < metrics.length; i++) {
		if (branchScore(metrics[i], cfg.selectHorizon, cfg) > branchScore(metrics[bestIdx], cfg.selectHorizon, cfg)) {
			bestIdx = i;
		}
	}
	const sourceBranchIdx = source.branches.findIndex((x) => commandMatches(x.cmd, source.sourceAction.cmd));
	const sourceMetrics = sourceBranchIdx >= 0
		? metrics[sourceBranchIdx]
		: rolloutBranch(
			source.sourceAction.next,
			source.seat,
			source.catalog,
			source.profileBySeat,
			cfg,
			17_300_000 + source.gameIndex * 10_000 + windowIndex,
			source.sourceLabel,
			destination,
			source.state.round,
			cfg.horizons
		);
	const bestMetrics = metrics[bestIdx];
	const bestSnap = snapAt(bestMetrics, cfg.labelHorizon);
	const sourceSnap = snapAt(sourceMetrics, cfg.labelHorizon);
	const bestScore = branchScore(bestMetrics, cfg.labelHorizon, cfg);
	const sourceScore = branchScore(sourceMetrics, cfg.labelHorizon, cfg);
	const scoreDelta = +(bestScore - sourceScore).toFixed(2);
	const vpDelta = +(bestSnap.vp - sourceSnap.vp).toFixed(2);
	const statusDelta = +(bestSnap.status - sourceSnap.status).toFixed(2);
	const reach30Delta = (
		(reached30(bestMetrics, cfg.labelHorizon) ? 1 : 0) -
		(reached30(sourceMetrics, cfg.labelHorizon) ? 1 : 0)
	);
	const bestBranch = source.branches[bestIdx];
	const sourceWasBest = sourceBranchIdx === bestIdx ||
		(bestBranch ? commandMatches(source.sourceAction.cmd, bestBranch.cmd) : false);
	const routeExecCorrection = !sourceWasBest &&
		scoreDelta >= cfg.labelScoreThreshold &&
		vpDelta >= cfg.labelVpThreshold &&
		statusDelta <= cfg.labelStatusTolerance;
		const bestAction = bestMetrics.action;
		const build = playerWindowBuild(source.state, source.seat);
		const monster = monsterWindowSignal(source.state, source.seat, source.catalog);
		addCount(collector.bestActionCounts, bestAction);
	addCount(collector.sourceActionCounts, source.sourceLabel);
	collector.rows.push({
		id: `g${source.gameIndex}-${source.seat}-r${source.state.round}-${windowIndex}`,
		game: source.gameIndex,
		seat: source.seat,
		round: source.state.round,
		destination,
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
			legalActions: source.branches.length,
		heuristicAction: source.sourceLabel,
		bestAction,
		sourceWasBest,
		sourceScore: +sourceScore.toFixed(2),
		bestScore: +bestScore.toFixed(2),
		routeExecQDeltaScore: scoreDelta,
		routeExecQDeltaVp: vpDelta,
		routeExecQDeltaStatus: statusDelta,
		routeExecQDeltaReach30: reach30Delta,
		routeExecCorrection,
		bestScoreDelta: scoreDelta,
		bestVpDelta: vpDelta,
		bestStatusDelta: statusDelta,
		bestReach30Delta: reach30Delta,
		bestCleanOpportunityDelta: +(bestSnap.cleanCombatOpportunities - sourceSnap.cleanCombatOpportunities).toFixed(2),
		bestFirepowerOpportunityDelta: +(bestSnap.firepowerCombatOpportunities - sourceSnap.firepowerCombatOpportunities).toFixed(2),
		bestExpectedAttackDelta: +(bestSnap.maxExpectedAttack - sourceSnap.maxExpectedAttack).toFixed(2),
		bestBarrierDelta: +(bestSnap.maxBarrier - sourceSnap.maxBarrier).toFixed(2),
		bestSpiritAnimalDelta: +(bestSnap.maxSpiritAnimal - sourceSnap.maxSpiritAnimal).toFixed(2),
		branches: metrics
	});
	if (cfg.dataOut && (!cfg.positiveOnlyData || routeExecCorrection)) {
		recordLocationSample(
			collector.samples,
			source.state,
			source.seat,
			source.catalog,
			source.branches,
			bestIdx,
			bestMetrics,
			cfg.labelHorizon
		);
	}
}

describe('route execution counterfactual diagnostics', () => {
	(RUN ? it : it.skip)(
		'branches location-row decisions into future clean route value',
		async () => {
			const horizons = parseHorizons(process.env.ROUTEEXECQ_HORIZONS);
				const plannerWeights = process.env.ROUTEEXECQ_WEIGHTS;
				const patchNavWeights = process.env.ROUTEEXECQ_PATCH_NAV_WEIGHTS;
				const patch2NavWeights = process.env.ROUTEEXECQ_PATCH2_NAV_WEIGHTS;
				const navWeights = process.env.ROUTEEXECQ_NAV_WEIGHTS;
				const scaleNavWeights = process.env.ROUTEEXECQ_SCALE_NAV_WEIGHTS;
				const microWeights = process.env.ROUTEEXECQ_MICRO_WEIGHTS;
				const rawNavGate = process.env.ROUTEEXECQ_NAV_GATE;
				const rawScaleNavGate = process.env.ROUTEEXECQ_SCALE_NAV_GATE;
				const patchNavigationPolicyGate = parseNavigationPolicyGate(process.env.ROUTEEXECQ_PATCH_NAV_GATE, 'all');
				const patch2NavigationPolicyGate = parseNavigationPolicyGate(process.env.ROUTEEXECQ_PATCH2_NAV_GATE, 'all');
				const navigationPolicyGate = parseNavigationPolicyGate(rawNavGate, 'all');
				const scalingNavigationPolicyGate = parseNavigationPolicyGate(rawScaleNavGate, 'route-option-scaling');
			const microPolicyGate = parseMicroPolicyGate(process.env.ROUTEEXECQ_MICRO_GATE);
			const cfg: Config = {
				games: parseInt(process.env.ROUTEEXECQ_GAMES ?? '4', 10),
				seatsN: parseInt(process.env.ROUTEEXECQ_SEATS ?? '4', 10),
				maxRounds: parseInt(process.env.ROUTEEXECQ_MAXROUNDS ?? '30', 10),
				maxWindows: parseInt(process.env.ROUTEEXECQ_MAX_WINDOWS ?? '80', 10),
				cleanThreshold: parseFloat(process.env.ROUTEEXECQ_CLEAN_THRESHOLD ?? '0.5'),
				firepowerThreshold: parseFloat(process.env.ROUTEEXECQ_FIREPOWER_THRESHOLD ?? '0.5'),
				selectHorizon: parseInt(process.env.ROUTEEXECQ_SELECT_HORIZON ?? '6', 10),
				horizons,
				labelHorizon: parseInt(process.env.ROUTEEXECQ_LABEL_HORIZON ?? String(horizons.includes(10) ? 10 : horizons[horizons.length - 1]), 10),
				labelScoreThreshold: parseFloat(process.env.ROUTEEXECQ_LABEL_SCORE_THRESHOLD ?? '0.25'),
				labelVpThreshold: parseFloat(process.env.ROUTEEXECQ_LABEL_VP_THRESHOLD ?? '0'),
				labelStatusTolerance: parseFloat(process.env.ROUTEEXECQ_LABEL_STATUS_TOLERANCE ?? '0'),
				positiveOnlyData: process.env.ROUTEEXECQ_POSITIVE_ONLY_DATA === '1',
				minPlayerVp: parseFloat(process.env.ROUTEEXECQ_MIN_PLAYER_VP ?? '0'),
				maxPlayerVp: parseOptionalNumber(process.env.ROUTEEXECQ_MAX_PLAYER_VP),
					minRound: parseInt(process.env.ROUTEEXECQ_MIN_ROUND ?? '0', 10),
					maxRound: parseOptionalNumber(process.env.ROUTEEXECQ_MAX_ROUND),
					destinationFilter: parseDestinationFilter(process.env.ROUTEEXECQ_DESTINATIONS),
					minMonsterHp: parseFloat(process.env.ROUTEEXECQ_MIN_MONSTER_HP ?? '0'),
					maxMonsterHp: parseOptionalNumber(process.env.ROUTEEXECQ_MAX_MONSTER_HP),
					minCleanKillProb: parseFloat(process.env.ROUTEEXECQ_MIN_CLEAN_KILL_PROB ?? '0'),
					maxCleanKillProb: parseOptionalNumber(process.env.ROUTEEXECQ_MAX_CLEAN_KILL_PROB),
					minFirepowerKillProb: parseFloat(process.env.ROUTEEXECQ_MIN_FIREPOWER_KILL_PROB ?? '0'),
					maxFirepowerKillProb: parseOptionalNumber(process.env.ROUTEEXECQ_MAX_FIREPOWER_KILL_PROB),
					minExpectedAttack: parseFloat(process.env.ROUTEEXECQ_MIN_EXPECTED_ATTACK ?? '0'),
				minAttackDice: parseInt(process.env.ROUTEEXECQ_MIN_ATTACK_DICE ?? '0', 10),
				minSpiritAnimal: parseInt(process.env.ROUTEEXECQ_MIN_SPIRIT_ANIMAL ?? '0', 10),
				minCultivator: parseInt(process.env.ROUTEEXECQ_MIN_CULTIVATOR ?? '0', 10),
				minMaxBarrier: parseInt(process.env.ROUTEEXECQ_MIN_MAX_BARRIER ?? '0', 10),
				scoreVpWeight: parseFloat(process.env.ROUTEEXECQ_SCORE_VP_WEIGHT ?? '1'),
				scoreCleanOpportunityWeight: parseFloat(process.env.ROUTEEXECQ_SCORE_CLEAN_OPPORTUNITY_WEIGHT ?? '2'),
				scoreFirepowerOpportunityWeight: parseFloat(process.env.ROUTEEXECQ_SCORE_FIREPOWER_OPPORTUNITY_WEIGHT ?? '0.25'),
				scoreExpectedAttackWeight: parseFloat(process.env.ROUTEEXECQ_SCORE_EXPECTED_ATTACK_WEIGHT ?? '0.8'),
				scoreAttackDiceWeight: parseFloat(process.env.ROUTEEXECQ_SCORE_ATTACK_DICE_WEIGHT ?? '0.4'),
				scoreSpiritAnimalWeight: parseFloat(process.env.ROUTEEXECQ_SCORE_SPIRIT_ANIMAL_WEIGHT ?? '0.5'),
				scoreCultivatorWeight: parseFloat(process.env.ROUTEEXECQ_SCORE_CULTIVATOR_WEIGHT ?? '0'),
				scoreBarrierWeight: parseFloat(process.env.ROUTEEXECQ_SCORE_BARRIER_WEIGHT ?? '0.2'),
				scoreCurrentBarrierWeight: parseFloat(process.env.ROUTEEXECQ_SCORE_CURRENT_BARRIER_WEIGHT ?? '0'),
				scoreKillWeight: parseFloat(process.env.ROUTEEXECQ_SCORE_KILL_WEIGHT ?? '0'),
				scoreReach30Bonus: parseFloat(process.env.ROUTEEXECQ_SCORE_REACH30_BONUS ?? '0'),
				scoreStatusPenalty: parseFloat(process.env.ROUTEEXECQ_SCORE_STATUS_PENALTY ?? '2'),
				dataOut: process.env.ROUTEEXECQ_DATA_OUT,
				branchScope: parseBranchScope(process.env.ROUTEEXECQ_BRANCH_SCOPE),
				branchTypes: parseForbidTypes(process.env.ROUTEEXECQ_BRANCH_TYPES),
				profiles: (process.env.ROUTEEXECQ_PROFILES ?? 'paragon,farmer,farmer2,hard')
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean),
				out: process.env.ROUTEEXECQ_OUT ?? mlPath('routeexecq_counterfactual.json'),
				summaryOut: process.env.ROUTEEXECQ_SUMMARY ?? mlPath('routeexecq_counterfactual_summary.json'),
				forbidTypes: parseForbidTypes(process.env.ROUTEEXECQ_FORBID_TYPES ?? 'initiatePvp'),
				maxStatusLevel: parseOptionalStatusLevel(process.env.ROUTEEXECQ_MAX_STATUS_LEVEL, 0),
					plannerPolicy: plannerWeights ? loadPolicyForEval(plannerWeights) : undefined,
					patchNavigationPolicy: patchNavWeights ? loadPolicyForEval(patchNavWeights) : undefined,
					patchNavigationPolicyGate,
					patch2NavigationPolicy: patch2NavWeights ? loadPolicyForEval(patch2NavWeights) : undefined,
					patch2NavigationPolicyGate,
					navigationPolicy: navWeights ? loadPolicyForEval(navWeights) : undefined,
					scalingNavigationPolicy: scaleNavWeights ? loadPolicyForEval(scaleNavWeights) : undefined,
					microPolicy: microWeights ? loadPolicyForEval(microWeights) : undefined,
					microPolicyGate,
					navigationPolicyGate,
						scalingNavigationPolicyGate,
					preserveRouteFirepower: process.env.ROUTEEXECQ_PRESERVE_ROUTE_FIREPOWER === '1',
					preserveRouteSurvival: process.env.ROUTEEXECQ_PRESERVE_ROUTE_SURVIVAL === '1',
					plannerIterations: parseInt(process.env.ROUTEEXECQ_ITERS ?? '32', 10),
				plannerHorizon: parseInt(process.env.ROUTEEXECQ_PLANNER_HORIZON ?? '16', 10),
				plannerValueWeight: parseFloat(process.env.ROUTEEXECQ_VALUEW ?? '1'),
						progressEvery: parseInt(process.env.ROUTEEXECQ_PROGRESS_EVERY ?? '0', 10),
				source: process.env.ROUTEEXECQ_SOURCE === 'full-control' ? 'full-control' : 'heuristic',
					sourceSeedBase: parseInt(process.env.ROUTEEXECQ_SOURCE_SEED_BASE ?? '6500000', 10),
						plannerProfile: process.env.ROUTEEXECQ_PLANNER_PROFILE ?? 'cultivator',
						allPlannerSeats: (process.env.ROUTEEXECQ_ALL_PLANNER_SEATS ?? '0') === '1',
						rolloutPolicy: process.env.ROUTEEXECQ_ROLLOUT_POLICY === 'breakpoint-oracle' ? 'breakpoint-oracle' : 'policy',
						sourceFullSelection: parseFullActionSelection(process.env.ROUTEEXECQ_FULL_SELECTION, 'lookahead'),
						rolloutFullSelection: parseFullActionSelection(process.env.ROUTEEXECQ_ROLLOUT_FULL_SELECTION, ROLLOUT_FULL_SELECTION),
						plannerWeights,
					patchNavWeights,
					patch2NavWeights,
					navWeights,
					scaleNavWeights,
					microWeights
				};
			const catalog = await loadOrSnapshotCatalog();
			if (cfg.dataOut) {
				mkdirSync(dirname(cfg.dataOut), { recursive: true });
				writeFileSync(cfg.dataOut, '');
			}
				const collector: CollectorState = {
					rows: [],
					samples: [],
					sourceGames: 0,
					sourceVpSum: 0,
					sourceMaxVp: 0,
					sourceReach30: 0,
					scannedLocationWindows: 0,
				skippedWindowFilter: 0,
				skippedWindowReasons: {},
				filteredMaxPlayerVp: 0,
				filteredMaxRound: 0,
				filteredMaxMonsterHp: 0,
				filteredMaxExpectedAttack: 0,
				filteredMaxBarrier: 0,
				filteredMaxSpiritAnimal: 0,
				skippedSingleAction: 0,
				bestActionCounts: {},
				sourceActionCounts: {},
				destinationCounts: {},
				maxWindows: cfg.maxWindows
			};

			if (cfg.source === 'full-control') {
				if (!cfg.plannerPolicy) throw new Error('ROUTEEXECQ_SOURCE=full-control requires ROUTEEXECQ_WEIGHTS');
				const n = Math.min(cfg.seatsN, SEAT_COLORS.length, catalog.guardians.length);
				const seatList = SEAT_COLORS.slice(0, n) as SeatColor[];
				for (let g = 0; g < cfg.games && collector.rows.length < cfg.maxWindows; g++) {
					const plannerSeat = seatList[g % n];
					const profiles = seatList.map((seat, i) => {
						if (seat === plannerSeat) return profileFor(cfg.plannerProfile);
						return profileFor(cfg.profiles[(g + i) % cfg.profiles.length]);
					});
					const profileBySeat: Record<string, BotProfile> = Object.fromEntries(
						seatList.map((seat, i) => [seat, profiles[i]])
					);
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
						plannerSeats: cfg.allPlannerSeats ? seatList : [plannerSeat],
						recordSeats: [],
						planner: {
							iterations: cfg.plannerIterations,
							horizon: cfg.plannerHorizon,
							valueWeight: cfg.plannerValueWeight,
							c: 1.5
						},
							maxRounds: cfg.maxRounds,
							control: 'full',
							fullSelection: cfg.sourceFullSelection,
							fullLookaheadDepth: 2,
						fullLookaheadBeam: 8,
						fullLookaheadRootBeam: 24,
						fullTargetTemperature: 0.25,
							forbidTypes: cfg.forbidTypes,
							maxStatusLevel: cfg.maxStatusLevel,
							hardConstraints: true,
							preserveRouteFirepower: cfg.preserveRouteFirepower,
							preserveRouteSurvival: cfg.preserveRouteSurvival,
							fullActionProbe: (ctx: FullActionProbeContext) => {
								if (collector.rows.length >= cfg.maxWindows) return;
								if (
									cfg.maxStatusLevel !== undefined &&
									(ctx.state.players[ctx.seat]?.statusLevel ?? 0) > cfg.maxStatusLevel
								) return;
								if (cfg.branchScope === 'location' && ctx.state.phase !== 'location') return;
								const branches = branchActionsForScope(ctx.withNext, cfg);
								if (branches.length === 0) return;
							const sourceAction = ctx.withNext[ctx.chosenIndex] ?? branches[0];
							recordRouteExecutionWindow(
								{
									state: ctx.state,
									seat: ctx.seat,
									catalog: ctx.catalog,
									branches,
									sourceAction,
									sourceLabel: commandLabel(ctx.state, ctx.seat, ctx.catalog, sourceAction.cmd),
									gameIndex: g,
									profileBySeat
								},
								cfg,
								collector
							);
						}
					});
					const sourceVp = result.finalVP[plannerSeat] ?? 0;
					collector.sourceGames++;
					collector.sourceVpSum += sourceVp;
					collector.sourceMaxVp = Math.max(collector.sourceMaxVp, sourceVp);
					if (sourceVp >= VP_TO_WIN) collector.sourceReach30++;
					logProgress(cfg, collector, g + 1, cfg.games);
				}
			} else {
				for (let g = 0; g < cfg.games && collector.rows.length < cfg.maxWindows; g++) {
					const setup = setupGame(catalog, cfg.sourceSeedBase + g, cfg.seatsN);
					let state = setup.state;
					const seats = setup.seats;
					const profileBySeat: Record<string, BotProfile> = Object.fromEntries(
						seats.map((seat, i) => [seat, profileFor(cfg.profiles[i % cfg.profiles.length])])
					);
					const rng = seededBotRandom(73_000_000 + g);
					let ticks = 0;
						while (state.status === 'active' && state.round <= cfg.maxRounds && collector.rows.length < cfg.maxWindows) {
						if (++ticks > MAX_TICKS) break;
						let progressed = false;
						for (const seat of state.activeSeats) {
							if (!botSeatNeedsToAct(state, seat)) continue;
								if (
									state.phase === 'location' &&
									(cfg.maxStatusLevel === undefined || (state.players[seat]?.statusLevel ?? 0) <= cfg.maxStatusLevel)
								) {
								const branches = legalLocationBranches(state, seat, catalog, cfg);
								if (branches.length > 0) {
									const heuristic = heuristicLocationBranch(state, seat, catalog, rng, profileBySeat[seat], branches);
									recordRouteExecutionWindow(
										{
											state,
											seat,
											catalog,
											branches,
											sourceAction: heuristic,
											sourceLabel: commandLabel(state, seat, catalog, heuristic.cmd),
											gameIndex: g,
											profileBySeat
										},
										cfg,
										collector
									);
								}
							}

						if (state.phase === 'navigation') {
							const nav = plannerNavigationCommand(
								state,
								seat,
								catalog,
								cfg,
									16_300_000 + g * 10_000 + state.round * 100 + collector.rows.length
								);
							if (nav) {
								const r = applyGameCommand(state, botActorFor(state, seat), nav, catalog, { mutate: true });
								if (r.ok) {
									state = r.state;
									progressed = true;
								}
								if (state.status !== 'active' || collector.rows.length >= cfg.maxWindows) break;
								continue;
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
					logProgress(cfg, collector, g + 1, cfg.games);
				}
			}

			const avg = (pick: (row: RouteWindowRow) => number): number =>
				+(collector.rows.reduce((sum, row) => sum + pick(row), 0) / Math.max(1, collector.rows.length)).toFixed(2);
			const sourceWasBestRows = collector.rows.filter((r) => r.sourceWasBest);
			const correctionRows = collector.rows.filter((r) => r.routeExecCorrection);
			const summary = {
				mode: 'route-execution-counterfactual',
				config: {
					games: cfg.games,
					seats: Math.min(cfg.seatsN, SEAT_COLORS.length, catalog.guardians.length),
					maxRounds: cfg.maxRounds,
					maxWindows: cfg.maxWindows,
					cleanThreshold: cfg.cleanThreshold,
					firepowerThreshold: cfg.firepowerThreshold,
					selectHorizon: cfg.selectHorizon,
					horizons: cfg.horizons,
					labelHorizon: cfg.labelHorizon,
					labelScoreThreshold: cfg.labelScoreThreshold,
					labelVpThreshold: cfg.labelVpThreshold,
					labelStatusTolerance: cfg.labelStatusTolerance,
					positiveOnlyData: cfg.positiveOnlyData,
					branchScope: cfg.branchScope,
					branchTypes: cfg.branchTypes ? [...cfg.branchTypes] : undefined,
					windowFilters: {
						minPlayerVp: cfg.minPlayerVp,
						maxPlayerVp: cfg.maxPlayerVp,
							minRound: cfg.minRound,
							maxRound: cfg.maxRound,
							destinations: cfg.destinationFilter ? [...cfg.destinationFilter] : undefined,
							minMonsterHp: cfg.minMonsterHp,
							maxMonsterHp: cfg.maxMonsterHp,
							minCleanKillProb: cfg.minCleanKillProb,
							maxCleanKillProb: cfg.maxCleanKillProb,
							minFirepowerKillProb: cfg.minFirepowerKillProb,
							maxFirepowerKillProb: cfg.maxFirepowerKillProb,
							minExpectedAttack: cfg.minExpectedAttack,
						minAttackDice: cfg.minAttackDice,
						minSpiritAnimal: cfg.minSpiritAnimal,
						minCultivator: cfg.minCultivator,
						minMaxBarrier: cfg.minMaxBarrier
					},
					scoreWeights: {
						vp: cfg.scoreVpWeight,
						cleanOpportunity: cfg.scoreCleanOpportunityWeight,
						firepowerOpportunity: cfg.scoreFirepowerOpportunityWeight,
						expectedAttack: cfg.scoreExpectedAttackWeight,
						attackDice: cfg.scoreAttackDiceWeight,
						spiritAnimal: cfg.scoreSpiritAnimalWeight,
						cultivator: cfg.scoreCultivatorWeight,
						barrier: cfg.scoreBarrierWeight,
						currentBarrier: cfg.scoreCurrentBarrierWeight,
						kill: cfg.scoreKillWeight,
						reach30Bonus: cfg.scoreReach30Bonus,
						statusPenalty: cfg.scoreStatusPenalty
					},
						dataOut: cfg.dataOut,
						source: cfg.source,
						sourceSeedBase: cfg.sourceSeedBase,
						plannerProfile: cfg.plannerProfile,
						allPlannerSeats: cfg.allPlannerSeats,
								rolloutPolicy: cfg.rolloutPolicy,
								sourceFullSelection: cfg.sourceFullSelection,
								rolloutFullSelection: cfg.rolloutFullSelection,
							profiles: cfg.profiles,
						forbidTypes: [...(cfg.forbidTypes ?? [])],
					maxStatusLevel: cfg.maxStatusLevel,
						plannerWeights: cfg.plannerWeights,
						patchNavWeights: cfg.patchNavWeights,
						patchNavigationPolicyGate: cfg.patchNavigationPolicyGate,
						patch2NavWeights: cfg.patch2NavWeights,
						patch2NavigationPolicyGate: cfg.patch2NavigationPolicyGate,
						navWeights: cfg.navWeights,
						scaleNavWeights: cfg.scaleNavWeights,
						microWeights: cfg.microWeights,
						microPolicyGate: cfg.microPolicyGate,
						navigationPolicyGate: cfg.navigationPolicyGate,
						scalingNavigationPolicyGate: cfg.scalingNavigationPolicyGate,
						preserveRouteFirepower: cfg.preserveRouteFirepower,
						preserveRouteSurvival: cfg.preserveRouteSurvival,
						plannerIterations: cfg.plannerIterations,
					plannerHorizon: cfg.plannerHorizon,
					plannerValueWeight: cfg.plannerValueWeight,
					progressEvery: cfg.progressEvery
				},
				scannedLocationWindows: collector.scannedLocationWindows,
				windows: collector.rows.length,
				sourceGames: collector.sourceGames,
				sourceVpAvg: +(collector.sourceVpSum / Math.max(1, collector.sourceGames)).toFixed(2),
				sourceMaxVp: +collector.sourceMaxVp.toFixed(2),
				sourceReach30Pct: +((100 * collector.sourceReach30) / Math.max(1, collector.sourceGames)).toFixed(1),
				skippedWindowFilter: collector.skippedWindowFilter,
				skippedWindowReasons: topN(collector.skippedWindowReasons, 20),
				filteredMaxima: {
					playerVp: +collector.filteredMaxPlayerVp.toFixed(2),
					round: collector.filteredMaxRound,
					monsterHp: +collector.filteredMaxMonsterHp.toFixed(2),
					expectedAttack: +collector.filteredMaxExpectedAttack.toFixed(2),
					maxBarrier: +collector.filteredMaxBarrier.toFixed(2),
					spiritAnimal: +collector.filteredMaxSpiritAnimal.toFixed(2)
				},
				skippedSingleAction: collector.skippedSingleAction,
				dataSamples: collector.samples.length,
				sourceWasBest: sourceWasBestRows.length,
				sourceWasBestPct: +((100 * sourceWasBestRows.length) / Math.max(1, collector.rows.length)).toFixed(1),
				routeExecCorrections: correctionRows.length,
				routeExecCorrectionPct: +((100 * correctionRows.length) / Math.max(1, collector.rows.length)).toFixed(1),
				avgRouteExecQDeltaScore: avg((r) => r.routeExecQDeltaScore),
				avgRouteExecQDeltaVp: avg((r) => r.routeExecQDeltaVp),
				avgRouteExecQDeltaStatus: avg((r) => r.routeExecQDeltaStatus),
				avgRouteExecQDeltaReach30: avg((r) => r.routeExecQDeltaReach30),
				avgWindowPlayerVp: avg((r) => r.playerVp),
				avgWindowPlayerExpectedAttack: avg((r) => r.playerExpectedAttack),
				avgWindowPlayerMaxBarrier: avg((r) => r.playerMaxBarrier),
					avgWindowPlayerAttackDice: avg((r) => r.playerAttackDice),
					avgWindowPlayerSpiritAnimal: avg((r) => r.playerSpiritAnimal),
					avgWindowPlayerCultivator: avg((r) => r.playerCultivator),
					avgWindowMonsterHp: avg((r) => r.monsterHp),
					avgWindowCleanKillProb: avg((r) => r.cleanKillProb),
					avgWindowFirepowerKillProb: avg((r) => r.firepowerKillProb),
					avgBestScoreDelta: avg((r) => r.bestScoreDelta),
				avgBestVpDelta: avg((r) => r.bestVpDelta),
				avgBestStatusDelta: avg((r) => r.bestStatusDelta),
				avgBestReach30Delta: avg((r) => r.bestReach30Delta),
				avgBestCleanOpportunityDelta: avg((r) => r.bestCleanOpportunityDelta),
				avgBestFirepowerOpportunityDelta: avg((r) => r.bestFirepowerOpportunityDelta),
				avgBestExpectedAttackDelta: avg((r) => r.bestExpectedAttackDelta),
				avgBestBarrierDelta: avg((r) => r.bestBarrierDelta),
				avgBestSpiritAnimalDelta: avg((r) => r.bestSpiritAnimalDelta),
				destinations: topN(collector.destinationCounts, 12),
				bestActions: topN(collector.bestActionCounts, 20),
				sourceActions: topN(collector.sourceActionCounts, 20),
				correctionBestActions: topN(correctionRows.reduce<Record<string, number>>((acc, r) => {
					addCount(acc, r.bestAction);
					return acc;
				}, {}), 20),
				correctionSourceActions: topN(correctionRows.reduce<Record<string, number>>((acc, r) => {
					addCount(acc, r.heuristicAction);
					return acc;
				}, {}), 20),
				heuristicActions: topN(collector.sourceActionCounts, 20)
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
						mode: 'route-execution-counterfactual',
							source: cfg.source,
							source_seed_base: cfg.sourceSeedBase,
							planner_profile: cfg.plannerProfile,
							all_planner_seats: cfg.allPlannerSeats,
							branch_scope: cfg.branchScope,
							branch_types: cfg.branchTypes ? [...cfg.branchTypes] : undefined,
							rollout_policy: cfg.rolloutPolicy,
							planner_weights: cfg.plannerWeights,
							patch_nav_weights: cfg.patchNavWeights,
							patch_navigation_policy_gate: cfg.patchNavigationPolicyGate,
							patch2_nav_weights: cfg.patch2NavWeights,
							patch2_navigation_policy_gate: cfg.patch2NavigationPolicyGate,
							nav_weights: cfg.navWeights,
							scale_nav_weights: cfg.scaleNavWeights,
							micro_weights: cfg.microWeights,
							micro_policy_gate: cfg.microPolicyGate,
							navigation_policy_gate: cfg.navigationPolicyGate,
							scaling_navigation_policy_gate: cfg.scalingNavigationPolicyGate,
							preserve_route_firepower: cfg.preserveRouteFirepower,
							preserve_route_survival: cfg.preserveRouteSurvival,
							positive_only_data: cfg.positiveOnlyData,
						label_score_threshold: cfg.labelScoreThreshold,
						label_vp_threshold: cfg.labelVpThreshold,
						label_status_tolerance: cfg.labelStatusTolerance,
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
							},
						score_weights: {
							vp: cfg.scoreVpWeight,
							clean_opportunity: cfg.scoreCleanOpportunityWeight,
							firepower_opportunity: cfg.scoreFirepowerOpportunityWeight,
							expected_attack: cfg.scoreExpectedAttackWeight,
							attack_dice: cfg.scoreAttackDiceWeight,
							spirit_animal: cfg.scoreSpiritAnimalWeight,
							cultivator: cfg.scoreCultivatorWeight,
							barrier: cfg.scoreBarrierWeight,
							current_barrier: cfg.scoreCurrentBarrierWeight,
							kill: cfg.scoreKillWeight,
							reach30_bonus: cfg.scoreReach30Bonus,
							status_penalty: cfg.scoreStatusPenalty
						}
					}, null, 2)}\n`
				);
			}
			/* eslint-disable no-console */
			console.log(
				`\n[routeexecq] windows=${collector.rows.length}/${collector.scannedLocationWindows} ` +
				`filtered=${summary.skippedWindowFilter} ` +
				`corrections=${summary.routeExecCorrections} avgScoreDelta=${summary.avgBestScoreDelta} ` +
				`avgCleanDelta=${summary.avgBestCleanOpportunityDelta} avgAttackDelta=${summary.avgBestExpectedAttackDelta}`
			);
			console.log(`[routeexecq] destinations=${JSON.stringify(summary.destinations)}`);
			console.log(`[routeexecq] bestActions=${JSON.stringify(summary.bestActions)}`);
			if (cfg.dataOut) console.log(`[routeexecq] samples=${collector.samples.length} -> ${cfg.dataOut}`);
			console.log(`[routeexecq] DONE -> ${cfg.out}`);
			/* eslint-enable no-console */
		},
		60 * 60 * 1000
	);
});
