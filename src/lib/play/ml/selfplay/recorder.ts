/**
 * Self-play RECORDING: the Sample/planner-stat/trace accumulation split out of the
 * playPlannerSelfPlayGame loop, plus the planner trace/status types and the pure label helpers
 * that render commands into trace keys. Closure bodies are verbatim from the original loop-local
 * record* family; reads of the loop's reassigned `state` variable go through `getState()`.
 */

import {
	computeKillProbability,
	firepowerKillProbability,
	legalDestinations
} from '../../server/botPolicy';
import { expectedAttack } from '../../combat';
import { awakenedClassCounts } from '../../effects/apply';
import {
	buildLocationInteractions,
	type CostRequirement,
	type GainEffect,
	type LocationInteraction
} from '../../locationInteractions';
import type {
	GameCommand,
	NavigationDestination,
	PlayCatalog,
	PublicGameState,
	SeatColor
} from '../../types';
import { encodeObs, encodeAction } from '../encode';
import type { NeuralPolicy } from '../net';
import type { LegalAction } from '../actions';
import { sampleAuxTargets } from '../auxTargets';
import { evaluateFarmValue } from '../farmValue';
import type { Sample } from '../driver';
import {
	bestGoodTargetVp,
	fallenCanContinueAbyssFarm,
	fallenRebuildDestinations,
	predictedGoodTargetDestinations,
	pvpEncounterTargets,
	routeModeHuntProbability,
	visiblePvpHuntDestinations,
	type CombatOpportunityFlags,
	type NavigationPolicyGate,
	type PvpOpportunityInfo
} from './gates';

export interface PlannerFarmStats {
	abyss: number;
	navigationPriorUses: number;
	farmPriorApplications: number;
	farmPriorAbyssChoices: number;
	farmPriorScoreSum: number;
	farmPriorBonusSum: number;
	farmPriorMaxScore: number;
	navigationDestinations: Record<string, number>;
	locationInteractions: Record<string, number>;
	combat: number;
	kills: number;
	pvpAttacks: number;
	pvpVp: number;
	pvpTargetCombats: number;
	pvpAggressorsFaced: number;
	pvpVpConcededShare: number;
	pvpOpportunities: number;
	missedPvpOpportunities: number;
	pvpTargetVp: number;
	pvpBestTargetVp: number;
	pvpHighValueOpportunities: number;
	pvpHardMonsterOpportunities: number;
	missedPvpHardMonsterOpportunities: number;
	pvpHardMonsterAttacks: number;
	pvpHardMonsterVp: number;
	pvpHardMonsterTargetVp: number;
	pvpHardMonsterBestTargetVp: number;
	pvpGoodTargetPivotOpportunities: number;
	missedPvpGoodTargetPivotOpportunities: number;
	pvpGoodTargetPivotAttacks: number;
	pvpGoodTargetPivotVp: number;
	pvpGoodTargetPivotTargetVp: number;
	pvpGoodTargetPivotBestTargetVp: number;
	pvpPivotOracleUses: number;
	combatOpportunities: number;
	cleanCombatOpportunities: number;
	firepowerCombatOpportunities: number;
	corruptOnlyCombatOpportunities: number;
	missedCleanCombatOpportunities: number;
	missedFirepowerCombatOpportunities: number;
	maxCleanKillProb: number;
	maxFirepowerKillProb: number;
	maxExpectedAttack: number;
	maxBarrier: number;
	maxCurrentBarrier: number;
	maxAttackDice: number;
	maxSpiritAnimal: number;
	maxCultivator: number;
	maxHealer: number;
	maxStatusLevel: number;
	lastStatusLevel: number;
	statusCapViolations: number;
	statusCapViolationEvents: number;
	ownStatusCapViolationEvents: number;
	externalStatusCapViolationEvents: number;
	deadlineStatusCapViolationEvents: number;
	statusCapViolationSources: Record<string, number>;
	farmableNavs: number;
	missedFarmableNavs: number;
	bossFarmableNavs: number;
	missedBossFarmableNavs: number;
	farmOpportunityVp: number;
	missedFarmOpportunityVp: number;
	maxFarmOpportunityVp: number;
}
export interface PlannerStatusSource {
	kind: 'command' | 'deadline';
	actorSeat?: SeatColor;
	cmdType?: string;
}

export interface StatusCapTransitionAttribution {
	events: number;
	ownEvents: number;
	externalEvents: number;
	deadlineEvents: number;
	sources: Record<string, number>;
}

export interface PlannerTraceEvent {
	seat: SeatColor;
	round: number;
	phase: PublicGameState['phase'];
	source: 'navigation' | 'full' | 'heuristic' | 'force';
	command: string;
	vp: number;
	status: number;
	barrier: number;
	maxBarrier: number;
	expectedAttack: number;
	attackDice: number;
	spiritAnimal: number;
	cultivator: number;
	navigationDestination: string | null;
	monsterHp?: number;
	monsterMaxHp?: number;
	monsterDamage?: number;
	monsterLives?: number;
	rewardVp?: number;
	cleanKillProb?: number;
	firepowerKillProb?: number;
	farmable?: boolean;
	farmOpportunityVp?: number;
	usedNavigationPrior?: boolean;
	activeNavigationGate?: NavigationPolicyGate;
	rootDestinations?: string[];
	routeModeHuntProb?: number | null;
	routeModeThreshold?: number;
	bestGoodTargetVp?: number;
	visiblePvpDestinations?: string[];
	predictedPvpDestinations?: string[];
	fallenCanContinueAbyssFarm?: boolean;
	fallenRebuildRootDestinations?: string[];
	farmPriorApplied?: boolean;
	farmPriorScore?: number;
	farmPriorBonus?: number;
	pvpOpportunity?: boolean;
	pvpTargetCount?: number;
	pvpTargetVp?: number;
	pvpBestTargetVp?: number;
	pvpTargets?: string[];
	pvpHardMonsterWindow?: boolean;
	pvpGoodTargetPivotWindow?: boolean;
	combatOpportunity?: boolean;
	cleanCombatOpportunity?: boolean;
	firepowerCombatOpportunity?: boolean;
}

export function statusCapTransitionAttribution(
	seat: SeatColor,
	previousStatus: number,
	status: number,
	maxStatusLevel: number | undefined,
	source?: PlannerStatusSource
): StatusCapTransitionAttribution {
	const result: StatusCapTransitionAttribution = {
		events: 0,
		ownEvents: 0,
		externalEvents: 0,
		deadlineEvents: 0,
		sources: {}
	};
	if (maxStatusLevel === undefined || status <= maxStatusLevel || status <= previousStatus) {
		return result;
	}
	const crossedLevels = status - Math.max(previousStatus, maxStatusLevel);
	if (crossedLevels <= 0) return result;
	const sourceKind =
		source?.kind === 'deadline'
			? 'deadline'
			: source?.actorSeat === seat
				? 'own'
				: source?.actorSeat
					? 'external'
					: 'unknown';
	result.events = crossedLevels;
	if (sourceKind === 'own') result.ownEvents = crossedLevels;
	else if (sourceKind === 'external') result.externalEvents = crossedLevels;
	else if (sourceKind === 'deadline') result.deadlineEvents = crossedLevels;
	const sourceKey = `${sourceKind}:${source?.actorSeat ?? 'none'}:${source?.cmdType ?? 'unknown'}`;
	result.sources[sourceKey] = crossedLevels;
	return result;
}

export function oneHot(n: number, idx: number): number[] {
	return Array.from({ length: n }, (_, i) => (i === idx ? 1 : 0));
}

function addCount(counts: Record<string, number>, key: string, amount = 1): void {
	counts[key] = (counts[key] ?? 0) + amount;
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
		case 'rune': return gain.rune.name;
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

function locationInteractionKey(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cmd: Extract<GameCommand, { type: 'resolveLocationInteraction' }>
): string {
	const destination = state.players[seat]?.navigationDestination ?? '<none>';
	const loc = (catalog.locations ?? []).find((l) => l.name === destination);
	const interaction = buildLocationInteractions(loc?.rewardRows).find((it) => it.rowIndex === cmd.rowIndex);
	const label = interaction ? locationInteractionLabel(interaction) : 'unknown';
	return `${destination}:row${cmd.rowIndex}:${label}`;
}

function commandTraceLabel(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	cmd: GameCommand
): string {
	if (cmd.type === 'lockNavigation') return `lockNavigation:${cmd.destination}`;
	if (cmd.type === 'resolveLocationInteraction') return locationInteractionKey(state, seat, catalog, cmd);
	if (cmd.type === 'resolveMonsterReward') {
		const picks = cmd.picks.join(',');
		const choices = (cmd.choices ?? []).join(',');
		return choices ? `resolveMonsterReward:picks=${picks}:choices=${choices}` : `resolveMonsterReward:picks=${picks}`;
	}
	return cmd.type;
}

/** Everything the self-play loop's record* closures need from the surrounding game context. */
export interface SelfPlayRecorderDeps {
	catalog: PlayCatalog;
	/** Reads the loop's CURRENT (reassigned) game state at call time. */
	getState: () => PublicGameState;
	plannerSeats: ReadonlySet<SeatColor>;
	recordSeats: ReadonlySet<SeatColor>;
	maxStatusLevelForSeat: (seat: SeatColor) => number | undefined;
	farmNavigationThreshold: number;
	routeModeThreshold: number;
	tracePlannerActions: boolean;
}

/**
 * Factory for the self-play loop's sample/stat/trace recording closures. Owns the mutable
 * accumulators (samples, per-seat planner stats, decision histograms, planner trace) that
 * playPlannerSelfPlayGame drains into its SelfPlayResult. Must be created AFTER startGame so
 * the per-seat stat baselines read the post-setup player states.
 */
export function createSelfPlayRecorder(deps: SelfPlayRecorderDeps) {
	const {
		catalog,
		getState,
		plannerSeats,
		recordSeats,
		maxStatusLevelForSeat,
		farmNavigationThreshold,
		routeModeThreshold,
		tracePlannerActions
	} = deps;
	const initialState = getState();
	const samples: Sample[] = [];
	// Per-planner-seat behavior counters — diagnose monster-FARMING: how many rounds it navigates to
	// the Abyss, how many monster combats it starts, and how many kills land. Under-farming shows up
	// here (few combats/kills) vs the optimal "fight every round" line.
	const pstat: Record<string, PlannerFarmStats> = {};
	for (const s of plannerSeats) {
		pstat[s] = {
			abyss: 0,
			navigationPriorUses: 0,
			farmPriorApplications: 0,
			farmPriorAbyssChoices: 0,
			farmPriorScoreSum: 0,
			farmPriorBonusSum: 0,
			farmPriorMaxScore: 0,
			navigationDestinations: {},
			locationInteractions: {},
			combat: 0,
			kills: 0,
			pvpAttacks: 0,
			pvpVp: 0,
			pvpTargetCombats: 0,
			pvpAggressorsFaced: 0,
			pvpVpConcededShare: 0,
			pvpOpportunities: 0,
			missedPvpOpportunities: 0,
			pvpTargetVp: 0,
			pvpBestTargetVp: 0,
			pvpHighValueOpportunities: 0,
			pvpHardMonsterOpportunities: 0,
			missedPvpHardMonsterOpportunities: 0,
			pvpHardMonsterAttacks: 0,
			pvpHardMonsterVp: 0,
			pvpHardMonsterTargetVp: 0,
			pvpHardMonsterBestTargetVp: 0,
			pvpGoodTargetPivotOpportunities: 0,
			missedPvpGoodTargetPivotOpportunities: 0,
			pvpGoodTargetPivotAttacks: 0,
			pvpGoodTargetPivotVp: 0,
			pvpGoodTargetPivotTargetVp: 0,
			pvpGoodTargetPivotBestTargetVp: 0,
			pvpPivotOracleUses: 0,
			combatOpportunities: 0,
			cleanCombatOpportunities: 0,
			firepowerCombatOpportunities: 0,
			corruptOnlyCombatOpportunities: 0,
			missedCleanCombatOpportunities: 0,
			missedFirepowerCombatOpportunities: 0,
			maxCleanKillProb: 0,
			maxFirepowerKillProb: 0,
			maxExpectedAttack: 0,
			maxBarrier: initialState.players[s]?.maxBarrier ?? 0,
			maxCurrentBarrier: initialState.players[s]?.barrier ?? 0,
			maxAttackDice: initialState.players[s]?.attackDice?.length ?? 0,
			maxSpiritAnimal: 0,
			maxCultivator: 0,
			maxHealer: 0,
			farmableNavs: 0,
			missedFarmableNavs: 0,
			bossFarmableNavs: 0,
			missedBossFarmableNavs: 0,
			farmOpportunityVp: 0,
			missedFarmOpportunityVp: 0,
			maxFarmOpportunityVp: 0,
			maxStatusLevel: initialState.players[s]?.statusLevel ?? 0,
			lastStatusLevel: initialState.players[s]?.statusLevel ?? 0,
			statusCapViolations: 0,
			statusCapViolationEvents: 0,
			ownStatusCapViolationEvents: 0,
			externalStatusCapViolationEvents: 0,
			deadlineStatusCapViolationEvents: 0,
			statusCapViolationSources: {}
		};
	}
	const seenPvpCombatIds = new Set<string>();
		const recordResolvedPvpCombats = (): void => {
			const state = getState();
			for (const combat of state.combats ?? []) {
				if (combat.kind !== 'pvp' || seenPvpCombatIds.has(combat.id)) continue;
				seenPvpCombatIds.add(combat.id);
				const evilSides = combat.sides.filter((side) => side.side === 'evil');
				const goodSides = combat.sides.filter((side) => side.side === 'good');
				for (const side of combat.sides) {
					const stat = pstat[side.seat];
					if (!stat) continue;
					if (side.side === 'evil') {
						stat.pvpVp += 3;
					} else if (side.side === 'good') {
						stat.pvpTargetCombats++;
						stat.pvpAggressorsFaced += evilSides.length;
						stat.pvpVpConcededShare += goodSides.length > 0 ? (3 * evilSides.length) / goodSides.length : 0;
					}
				}
			}
		};
		const recordBuildSnapshot = (seat: SeatColor): void => {
			const state = getState();
			const stat = pstat[seat];
			const player = state.players[seat];
		if (!stat || !player) return;
		const counts = awakenedClassCounts(player);
		stat.maxExpectedAttack = Math.max(stat.maxExpectedAttack, expectedAttack(player));
		stat.maxBarrier = Math.max(stat.maxBarrier, player.maxBarrier ?? 0);
		stat.maxCurrentBarrier = Math.max(stat.maxCurrentBarrier, player.barrier ?? 0);
		stat.maxAttackDice = Math.max(stat.maxAttackDice, player.attackDice?.length ?? 0);
		stat.maxSpiritAnimal = Math.max(stat.maxSpiritAnimal, counts['Spirit Animal'] ?? 0);
		stat.maxCultivator = Math.max(stat.maxCultivator, counts.Cultivator ?? 0);
		stat.maxHealer = Math.max(stat.maxHealer, counts.Healer ?? 0);
	};
	const recordPlannerStatus = (seat: SeatColor, source?: PlannerStatusSource): void => {
		const state = getState();
		const stat = pstat[seat];
		if (!stat) return;
		recordBuildSnapshot(seat);
		const status = state.players[seat]?.statusLevel ?? 0;
		const previousStatus = stat.lastStatusLevel ?? 0;
		stat.maxStatusLevel = Math.max(stat.maxStatusLevel, status);
		const cap = maxStatusLevelForSeat(seat);
		if (cap !== undefined && status > cap) {
			stat.statusCapViolations++;
			const attribution = statusCapTransitionAttribution(seat, previousStatus, status, cap, source);
			stat.statusCapViolationEvents += attribution.events;
			stat.ownStatusCapViolationEvents += attribution.ownEvents;
			stat.externalStatusCapViolationEvents += attribution.externalEvents;
			stat.deadlineStatusCapViolationEvents += attribution.deadlineEvents;
			for (const [sourceKey, count] of Object.entries(attribution.sources)) {
				stat.statusCapViolationSources[sourceKey] = (stat.statusCapViolationSources[sourceKey] ?? 0) + count;
			}
		}
		stat.lastStatusLevel = status;
	};
	const recordAllPlannerStatus = (source?: PlannerStatusSource): void => {
		for (const s of plannerSeats) recordPlannerStatus(s, source);
	};
	for (const s of plannerSeats) recordBuildSnapshot(s);
	const recordFarmNavigation = (
		seat: SeatColor,
		flags: { farmable: boolean; bossFarmable: boolean; farmOpportunityVp: number },
		destination: string | undefined
		): void => {
		const stat = pstat[seat];
		if (!stat) return;
		if (destination) addCount(stat.navigationDestinations, destination);
		const goesAbyss = destination === 'Arcane Abyss';
		stat.maxFarmOpportunityVp = Math.max(stat.maxFarmOpportunityVp, flags.farmOpportunityVp);
		if (flags.farmable) {
			stat.farmableNavs++;
			stat.farmOpportunityVp += flags.farmOpportunityVp;
			if (!goesAbyss) stat.missedFarmableNavs++;
			if (!goesAbyss) stat.missedFarmOpportunityVp += flags.farmOpportunityVp;
		}
		if (flags.bossFarmable) {
			stat.bossFarmableNavs++;
			if (!goesAbyss) stat.missedBossFarmableNavs++;
		}
	};
	const recordLocationInteraction = (seat: SeatColor, cmd: GameCommand): void => {
		const state = getState();
		const stat = pstat[seat];
		if (!stat || cmd.type !== 'resolveLocationInteraction') return;
		addCount(stat.locationInteractions, locationInteractionKey(state, seat, catalog, cmd));
	};
	const recordCombatOpportunity = (seat: SeatColor, withNext: LegalAction[]): CombatOpportunityFlags => {
		const state = getState();
		const stat = pstat[seat];
		if (!stat) return { legalCombat: false, clean: false, firepower: false, corruptOnly: false };
		const legalCombat = withNext.some((x) => x.cmd.type === 'startCombat');
		if (!legalCombat) return { legalCombat: false, clean: false, firepower: false, corruptOnly: false };

		const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
		const corruptProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: true });
		const firepowerProb = firepowerKillProbability(state, seat, catalog);
		const clean = cleanProb >= 0.5;
		const firepower = firepowerProb >= 0.5;
		const corruptOnly = !clean && corruptProb >= 0.5;
		stat.combatOpportunities++;
		stat.maxCleanKillProb = Math.max(stat.maxCleanKillProb, cleanProb);
		stat.maxFirepowerKillProb = Math.max(stat.maxFirepowerKillProb, firepowerProb);
		if (clean) stat.cleanCombatOpportunities++;
		if (firepower) stat.firepowerCombatOpportunities++;
		if (corruptOnly) stat.corruptOnlyCombatOpportunities++;
		return { legalCombat: true, clean, firepower, corruptOnly };
	};
	const recordPvpOpportunity = (seat: SeatColor, withNext: LegalAction[]): PvpOpportunityInfo => {
		const state = getState();
		const stat = pstat[seat];
		if (!stat) return pvpEncounterTargets(state, seat, false);
		const legalPvp = withNext.some((x) => x.cmd.type === 'initiatePvp');
		const opportunity = pvpEncounterTargets(state, seat, legalPvp);
		if (legalPvp) {
			stat.pvpOpportunities++;
			stat.pvpTargetVp += opportunity.targetVp;
			stat.pvpBestTargetVp = Math.max(stat.pvpBestTargetVp, opportunity.bestTargetVp);
			if (opportunity.bestTargetVp >= 12) stat.pvpHighValueOpportunities++;
			if (opportunity.hardMonsterWindow) {
				stat.pvpHardMonsterOpportunities++;
				stat.pvpHardMonsterTargetVp += opportunity.targetVp;
				stat.pvpHardMonsterBestTargetVp = Math.max(stat.pvpHardMonsterBestTargetVp, opportunity.bestTargetVp);
			}
			if (opportunity.goodTargetPivotWindow) {
				stat.pvpGoodTargetPivotOpportunities++;
				stat.pvpGoodTargetPivotTargetVp += opportunity.targetVp;
				stat.pvpGoodTargetPivotBestTargetVp = Math.max(stat.pvpGoodTargetPivotBestTargetVp, opportunity.bestTargetVp);
			}
		}
		return opportunity;
	};
	const decisionTypes: Record<string, number> = {};
	const decisionTypesBySeat: Record<string, Record<string, number>> = {};
	const plannerTrace: PlannerTraceEvent[] = [];
	const countDecision = (seat: SeatColor, cmd: GameCommand): void => {
		decisionTypes[cmd.type] = (decisionTypes[cmd.type] ?? 0) + 1;
		const bySeat = decisionTypesBySeat[seat] ?? {};
		bySeat[cmd.type] = (bySeat[cmd.type] ?? 0) + 1;
		decisionTypesBySeat[seat] = bySeat;
	};
	const recordTrace = (
		seat: SeatColor,
		source: PlannerTraceEvent['source'],
		cmd: GameCommand,
		extra: Partial<PlannerTraceEvent> = {}
	): void => {
		const state = getState();
		if (!tracePlannerActions) return;
		const player = state.players[seat];
		if (!player) return;
		const counts = awakenedClassCounts(player);
		const monster = state.monster;
		const farm = monster ? evaluateFarmValue(state, seat, catalog, { threshold: farmNavigationThreshold }) : null;
		plannerTrace.push({
			seat,
			round: state.round,
			phase: state.phase,
			source,
			command: commandTraceLabel(state, seat, catalog, cmd),
			vp: player.victoryPoints ?? 0,
			status: player.statusLevel ?? 0,
			barrier: player.barrier ?? 0,
			maxBarrier: player.maxBarrier ?? 0,
			expectedAttack: +expectedAttack(player).toFixed(2),
			attackDice: player.attackDice?.length ?? 0,
			spiritAnimal: counts['Spirit Animal'] ?? 0,
			cultivator: counts.Cultivator ?? 0,
			navigationDestination: player.navigationDestination,
			monsterHp: monster?.hp,
			monsterMaxHp: monster?.maxHp,
			monsterDamage: monster?.damage,
			monsterLives: monster?.livesRemaining,
			rewardVp: farm?.rewardVp,
			cleanKillProb: monster ? +computeKillProbability(state, seat, catalog, { allowCorruptKill: false }).toFixed(3) : undefined,
			firepowerKillProb: monster ? +firepowerKillProbability(state, seat, catalog).toFixed(3) : undefined,
			farmable: farm?.valid ? farm.farmable : undefined,
			farmOpportunityVp: farm?.valid ? +farm.opportunityVp.toFixed(2) : undefined,
			...extra
		});
	};
	const navigationTraceContext = (
		seat: SeatColor,
		policy?: NeuralPolicy,
		activeGate?: NavigationPolicyGate,
		rootDestinations?: NavigationDestination[]
	): Partial<PlannerTraceEvent> => {
		const state = getState();
		const player = state.players[seat];
		const fallen = (player?.statusLevel ?? 0) >= 3;
		return {
			activeNavigationGate: activeGate,
			rootDestinations: rootDestinations ? [...rootDestinations] : undefined,
			routeModeHuntProb: fallen ? routeModeHuntProbability(policy, state, seat, catalog) : undefined,
			routeModeThreshold: fallen ? routeModeThreshold : undefined,
			bestGoodTargetVp: fallen ? bestGoodTargetVp(state, seat) : undefined,
			visiblePvpDestinations: fallen ? visiblePvpHuntDestinations(state, seat) : undefined,
			predictedPvpDestinations: fallen
				? predictedGoodTargetDestinations(state, seat, catalog, farmNavigationThreshold)
				: undefined,
			fallenCanContinueAbyssFarm: fallen
				? fallenCanContinueAbyssFarm(state, seat, catalog, farmNavigationThreshold)
				: undefined,
			fallenRebuildRootDestinations: fallen
				? fallenRebuildDestinations(state, seat, catalog, farmNavigationThreshold)
				: undefined
		};
	};
	const recordForcedNavigationSample = (
		seat: SeatColor,
		destination: NavigationDestination,
		policyWeight = 4
	): void => {
		const state = getState();
		if (!recordSeats.has(seat)) return;
		const destinations = legalDestinations(state, seat, catalog) as NavigationDestination[];
		const idx = destinations.indexOf(destination);
		if (idx < 0 || destinations.length <= 1) return;
		const cmd: GameCommand = { type: 'lockNavigation', destination };
		samples.push({
			obs: encodeObs(state, seat, catalog),
			cands: destinations.map((d) =>
				encodeAction(state, seat, { type: 'lockNavigation', destination: d }, undefined, catalog)
			),
			chosen: idx,
			pi: oneHot(destinations.length, idx),
			ret: 0,
			seat,
			vp: state.players[seat]?.victoryPoints ?? 0,
			phi: 0,
			kill: 0,
			policyWeight,
			...sampleAuxTargets(state, seat, catalog)
		});
		countDecision(seat, cmd);
	};
	return {
		samples,
		pstat,
		decisionTypes,
		decisionTypesBySeat,
		plannerTrace,
		recordResolvedPvpCombats,
		recordBuildSnapshot,
		recordPlannerStatus,
		recordAllPlannerStatus,
		recordFarmNavigation,
		recordLocationInteraction,
		recordCombatOpportunity,
		recordPvpOpportunity,
		countDecision,
		recordTrace,
		navigationTraceContext,
		recordForcedNavigationSample
	};
}
