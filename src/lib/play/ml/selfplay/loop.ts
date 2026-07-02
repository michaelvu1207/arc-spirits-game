/**
 * The AlphaZero self-play LOOP: playPlannerSelfPlayGame plus its options/result types and the
 * planner action selection/filtering entry points. Strategy-gate predicates live in ./gates
 * (archived hand-crafted benchmark opponents); sample/stat/trace accumulation lives in ./recorder.
 */

import { applyGameCommand, applyDeadlineAdvance, createLobbyState } from '../../runtime';
import { createRng, nextInt, type RngState } from '../../rng';
import {
	planBotPhaseActions,
	botActorFor,
	botSeatNeedsToAct,
	computeKillProbability,
	firepowerKillProbability,
	profileFor,
	legalDestinations,
	type BotProfile,
	type BotRandom
} from '../../server/botPolicy';
import { expectedAttack } from '../../combat';
import { awakenedClassCounts } from '../../effects/apply';
import {
	SEAT_COLORS,
	isEvilAlignment,
	type GameActor,
	type GameCommand,
	type NavigationDestination,
	type PlayCatalog,
	type PublicGameState,
	type SeatColor
} from '../../types';
import { encodeObs, encodeAction } from '../encode';
import type { NeuralPolicy } from '../net';
import { neuralPlanNavigation, type PlanOptions } from '../planner';
import { legalActionsWithNext, type LegalAction } from '../actions';
import { sampleAuxTargets } from '../auxTargets';
import { hybridIndex, lookaheadIndex, policyIndexWithProgressGuard, scoreByLookahead, scoresToPolicyTarget, scoreByValue, valueGuidedIndex } from '../neuralBot';
import { evaluateFarmValue } from '../farmValue';
import {
	chooseRouteBreakpointOracleAction,
	chooseRouteFinishLoopOracleAction
} from '../routeBreakpointOracle';
import type { Sample } from '../driver';
import {
	clamp01,
	FARM_ACTION_TYPES,
	REWARD_ACTION_TYPES,
	GOOD_BUILDER_HP4_PICK_ACTION_TYPES,
	GOOD_BUILDER_SCORE_PICK_ACTION_TYPES,
	GOOD_BUILDER_HP4_CONVERSION_ACTION_TYPES,
	GOOD_BUILDER_HP4_SCOREFLOOR_ACTION_TYPES,
	GOOD_BUILDER_SCORE_CONVERSION_ACTION_TYPES,
	PVP_FORCE_HIGH_VALUE_TARGET_VP,
	abyssFarmPayoffScore,
	chooseGoodBuilderHp4ScoreFloorOracleAction,
	chooseGoodBuilderOracleAction,
	cleanFarmableFlags,
	combatReadyButNeedsRestore,
	fallenPredictedHuntDestinationsWithFallback,
	fallenPredictedHuntDestinationsWithFallbackAndRebuild,
	fallenRebuildDestinations,
	filterAbyssRouteDisciplineActions,
	filterConstrainedPlan,
	filterGoodTargetActionDisciplineActions,
	goodBuilderFarmerOracleDestinations,
	goodBuilderHp4ScoreFloorActionScore,
	goodBuilderNoncontestSupportDestinations,
	goodBuilderOracleDestinations,
	goodBuilderSupportOracleDestinations,
	goodNonfallenFarmBuildDestinations,
	goodNonfallenFarmTargetEvadeDestinations,
	goodNonfallenFarmTargetPivotDestinations,
	goodNonfallenScoreFloorDestinations,
	goodTargetExposureDestinations,
	goodTargetRendezvousExposureDestinations,
	goodTargetValuePivotDestinations,
	isGoodBuilderHp4ConversionOverlayAction,
	isGoodBuilderHp4ConversionOverlayState,
	isGoodTargetExposureNavigationState,
	isPvpPivotState,
	isRouteCloserFullActionState,
	isRouteCloserRestoreFinishState,
	nearFinishNavigationOracleDestination,
	predictedGoodTargetDestinations,
	preservesRouteFirepower,
	preservesRouteHandDrawOpportunity,
	preservesRouteSurvival,
	pvpEncounterTargets,
	pvpHuntOrAbyssDestinations,
	pvpLateDescendOracleDestination,
	pvpPivotOracleDestination,
	pvpStatus2ConversionDescendOracleDestination,
	pvpStatus2TargetDescendOracleDestination,
	routeModeHuntProbability,
	shouldFallenRebuildRoute,
	shouldForceHardMonsterPvpAttack,
	shouldGoodTargetLowTailHunt,
	shouldGoodTargetValuePivotDescend,
	shouldGoodTargetValuePivotHunt,
	shouldPredictivePvpFinishHunt,
	shouldPredictivePvpHunt,
	shouldPredictivePvpValueHunt,
	visiblePvpHuntDestinations,
	type FarmNavigationOracle,
	type MicroPolicyGate,
	type NavigationPolicyGate,
	type PvpPivotOracle
} from './gates';
import {
	createSelfPlayRecorder,
	oneHot,
	type PlannerFarmStats,
	type PlannerTraceEvent
} from './recorder';

const MAX_TICKS = 50_000;
const MAX_FULL_ACTIONS_PER_PHASE = 30;
type PlannerControl = 'navigation' | 'full';
export type FullActionSelection = 'value' | 'policy' | 'hybrid' | 'lookahead';

export interface SelfPlayOptions {
	seed: number;
	/** One profile per seat (within-round execution + opponent play). */
	profiles: BotProfile[];
	/** The net guiding the planner's value/priors. */
	policy: NeuralPolicy;
	/** Optional policy used only for non-navigation full-control actions. */
	microPolicy?: NeuralPolicy;
	/** Where the optional non-navigation micro policy is allowed to replace the main policy. */
	microPolicyGate?: MicroPolicyGate;
	/** Optional full-action specialist for late route-closer states, layered above `microPolicy`. */
	routeCloserMicroPolicy?: NeuralPolicy;
	/** Diagnostic legal-action oracle for late finish loops, layered above `microPolicy`. */
	routeFinishOracle?: boolean;
	/** Optional policy used only for navigation priors; value/full-command behavior stays on `policy`. */
	navigationPolicy?: NeuralPolicy;
	/** Where the optional navigation prior is allowed to replace the main policy prior. */
	navigationPolicyGate?: NavigationPolicyGate;
	/** Optional highest-priority navigation patch for narrow trace-proven states. */
	patchNavigationPolicy?: NeuralPolicy;
	/** Where the optional patch navigation prior is allowed. */
	patchNavigationPolicyGate?: NavigationPolicyGate;
	/** Seats allowed to use `patchNavigationPolicy`. Defaults to every planner seat. */
	patchNavigationSeats?: SeatColor[];
	/** Optional second navigation patch, checked after `patchNavigationPolicy` and before route-Q. */
	patch2NavigationPolicy?: NeuralPolicy;
	/** Where the optional second patch navigation prior is allowed. */
	patch2NavigationPolicyGate?: NavigationPolicyGate;
	/** Seats allowed to use `patch2NavigationPolicy`. Defaults to every planner seat. */
	patch2NavigationSeats?: SeatColor[];
	/** Optional second navigation prior for sparse route-scaling options. */
	scalingNavigationPolicy?: NeuralPolicy;
	/** Where the optional scaling navigation prior is allowed. Defaults to `route-option-scaling`. */
	scalingNavigationPolicyGate?: NavigationPolicyGate;
	/** Optional per-seat policy overrides for checkpoint-vs-checkpoint evaluation. */
	seatPolicies?: Partial<Record<SeatColor, NeuralPolicy>>;
	/** Optional per-seat non-navigation policy overrides. Defaults to `seatPolicies` when set. */
	seatMicroPolicies?: Partial<Record<SeatColor, NeuralPolicy>>;
	/** Optional per-seat non-navigation policy gates. Defaults to `all` for seat micro policies. */
	seatMicroPolicyGates?: Partial<Record<SeatColor, MicroPolicyGate>>;
	/** Optional per-seat navigation-prior policy overrides. Defaults to `navigationPolicy` / seat policy. */
	seatNavigationPolicies?: Partial<Record<SeatColor, NeuralPolicy>>;
	/** Optional per-seat navigation-prior gates. Defaults to the global navigation gate. */
	seatNavigationPolicyGates?: Partial<Record<SeatColor, NavigationPolicyGate>>;
	/** Optional per-seat highest-priority navigation patches. */
	seatPatchNavigationPolicies?: Partial<Record<SeatColor, NeuralPolicy>>;
	/** Optional per-seat highest-priority navigation patch gates. */
	seatPatchNavigationPolicyGates?: Partial<Record<SeatColor, NavigationPolicyGate>>;
	/** Optional per-seat second navigation patches. */
	seatPatch2NavigationPolicies?: Partial<Record<SeatColor, NeuralPolicy>>;
	/** Optional per-seat second navigation patch gates. */
	seatPatch2NavigationPolicyGates?: Partial<Record<SeatColor, NavigationPolicyGate>>;
	/** Optional per-seat scaling navigation policies. */
	seatScalingNavigationPolicies?: Partial<Record<SeatColor, NeuralPolicy>>;
	/** Optional per-seat scaling navigation gates. */
	seatScalingNavigationPolicyGates?: Partial<Record<SeatColor, NavigationPolicyGate>>;
	/** Seats allowed to use the global `microPolicy`. Defaults to every planner seat. */
	microPolicySeats?: SeatColor[];
	/** Per-seat command bans for neural-field evals. Falls back to `forbidTypes`. */
	forbidTypesBySeat?: Partial<Record<SeatColor, Set<GameCommand['type']>>>;
	/** Per-seat status caps for neural-field evals. Falls back to `maxStatusLevel`. */
	maxStatusLevelBySeat?: Partial<Record<SeatColor, number>>;
	/** Per-seat firepower preservation constraints. Falls back to `preserveRouteFirepower`. */
	preserveRouteFirepowerBySeat?: Partial<Record<SeatColor, boolean>>;
	/** Per-seat survival preservation constraints. Falls back to `preserveRouteSurvival`. */
	preserveRouteSurvivalBySeat?: Partial<Record<SeatColor, boolean>>;
	/** Per-seat Abyss discipline constraints. Falls back to `abyssRouteDiscipline`. */
	abyssRouteDisciplineBySeat?: Partial<Record<SeatColor, boolean>>;
	/** Per-seat Good target discipline constraints. Falls back to `goodTargetActionDiscipline`. */
	goodTargetActionDisciplineBySeat?: Partial<Record<SeatColor, boolean>>;
	/** Seats that plan their navigation by ISMCTS (default: all). */
	plannerSeats?: SeatColor[];
	/** Planner seats whose decisions should be emitted as training samples. Defaults to plannerSeats. */
	recordSeats?: SeatColor[];
	planner?: PlanOptions;
	maxRounds?: number;
	/** Sample the move ∝ visits^(1/τ) for exploration (else argmax). */
	sampleMoves?: boolean;
	temperature?: number;
	guardianNames?: string[];
	/** Diagnostic: force planner seats to lock this destination every round (when legal), bypassing
	 *  the planner search — used to measure the always-Abyss farming ceiling vs the user's claim. */
	forceDest?: string;
	/**
	 * `navigation` preserves the original AlphaZero loop: MCTS owns only navigation and
	 * delegates all other decisions to the profile executor. `full` keeps navigation MCTS,
	 * but lets planner seats choose every other legal command with the neural candidate policy.
	 */
	control?: PlannerControl;
	/** Selection policy for non-navigation full-control actions. */
	fullSelection?: FullActionSelection;
	/** Depth/beam controls for `fullSelection=lookahead`. */
	fullLookaheadDepth?: number;
	fullLookaheadBeam?: number;
	fullLookaheadRootBeam?: number;
	/** Temperature for soft full-command policy targets written to `pi`. */
	fullTargetTemperature?: number;
	/**
	 * Curriculum/eval oracle for the specific clean-farm miss: when `force`, planner
	 * navigation locks Arcane Abyss only from a clean farmable state. Off by default
	 * and not used by live bots.
	 */
	farmNavigationOracle?: FarmNavigationOracle;
	/**
	 * Diagnostic oracle for the missing farm-to-PvP pivot: once the planner is Fallen,
	 * force a Spirit World hunt destination instead of staying in Arcane Abyss.
	 */
	pvpPivotOracle?: PvpPivotOracle;
	pvpPivotOracleBySeat?: Partial<Record<SeatColor, PvpPivotOracle>>;
	/** Clean kill-probability threshold used by farmNavigationOracle and diagnostics. */
	farmNavigationThreshold?: number;
	/** Probability cutoff for optional route_mode head. Default 0.5: >= hunts, < returns Abyss. */
	routeModeThreshold?: number;
	/**
	 * Command types removed from planner-seat legal actions. This is an eval/training
	 * ablation knob, not a game rule: if filtering would leave zero legal moves, the
	 * unfiltered legal set is retained so the simulation cannot softlock.
	 */
	forbidTypes?: Set<GameCommand['type']>;
	/**
	 * Maximum allowed planner-seat status level after a candidate action. Useful for
	 * Pure-only / non-corruption ablations. If every action violates the cap, the
	 * unfiltered legal set is retained so forced states cannot softlock.
	 */
	maxStatusLevel?: number;
	/**
	 * When true, `forbidTypes` / `maxStatusLevel` are hard proof constraints:
	 * if every legal action violates them, the planner seat yields/stalls instead
	 * of falling back to an unconstrained action. Use for route-proof diagnostics.
	 */
	hardConstraints?: boolean;
	/**
	 * Diagnostic route-proof guard: reject planner actions that destroy current
	 * monster firepower when they do not immediately score the monster route.
	 */
	preserveRouteFirepower?: boolean;
	/**
	 * Diagnostic route-proof guard: reject optional planner actions that spend the
	 * damage/barrier/Cultivator setup needed to convert HP-4+ Abyss rungs.
	 */
	preserveRouteSurvival?: boolean;
	/**
	 * Diagnostic route discipline: while a planner seat is on the Abyss farm route,
	 * prefer immediate clean payoff actions and avoid voluntary cleanup discards that
	 * shed the damage engine.
	 */
	abyssRouteDiscipline?: boolean;
	/**
	 * Diagnostic Good-target guard: reject optional non-scoring maintenance actions
	 * that pull non-Fallen target seats into Lantern/Cursed/Floral loops instead of
	 * building damage or converting the monster route.
	 */
	goodTargetActionDiscipline?: boolean;
	/**
	 * Diagnostic hook for full-control planner decisions. It observes the exact
	 * candidate set and selected index from the self-play/eval loop without
	 * changing gameplay. Used by counterfactual data collectors.
	 */
	fullActionProbe?: (ctx: FullActionProbeContext) => void;
	/**
	 * Diagnostic hook for planner navigation decisions. It observes the exact
	 * MCTS destination set and selected index without changing gameplay.
	 */
	navigationProbe?: (ctx: NavigationProbeContext) => void;
	/** When true, return a compact trace of planner-seat decisions for diagnostics. */
	tracePlannerActions?: boolean;
}

export interface FullActionProbeContext {
	state: PublicGameState;
	seat: SeatColor;
	catalog: PlayCatalog;
	withNext: LegalAction[];
	chosenIndex: number;
	pi: number[];
	decisionType: GameCommand['type'];
}

export interface NavigationProbeContext {
	state: PublicGameState;
	seat: SeatColor;
	catalog: PlayCatalog;
	destinations: string[];
	visits: number[];
	pi: number[];
	chosenIndex: number;
	farmable: boolean;
	bossFarmable: boolean;
	farmOpportunityVp: number;
	usedNavigationPrior: boolean;
	farmPriorApplied: boolean;
	farmPriorScore: number;
	farmPriorBonus: number;
}

export interface SelfPlayResult {
	samples: Sample[];
	finalVP: Record<string, number>;
	winnerSeat: SeatColor | null;
	rounds: number;
	finished: boolean;
	finalState: PublicGameState;
	/** Per-planner-seat monster-farming counters: Abyss navigations, combats started, kills landed. */
	plannerStats: Record<string, PlannerFarmStats>;
	/** Chosen command-type histogram for recorded planner decisions. */
	decisionTypes: Record<string, number>;
	/** Chosen command-type histogram by planner seat. */
	decisionTypesBySeat: Record<string, Record<string, number>>;
	/** Optional compact planner-seat action trace. Empty unless tracePlannerActions is enabled. */
	plannerTrace: PlannerTraceEvent[];
}

/** PURE VP outcome ∈ [0,1] for `seat` at game end = normalized victory points — the value target.
 *  Strategy-agnostic VP maximization; consistent with the planner's leaf so V(obs) estimates the
 *  same quantity the search backs up. */
function outcomeFor(state: PublicGameState, seat: SeatColor): number {
	const p = state.players[seat];
	if (!p) return 0;
	return clamp01(p.victoryPoints / 30);
}

/** Sample an index ∝ visits^(1/τ); argmax when !sample or τ→0. */
function chooseIndex(visits: number[], sample: boolean, temperature: number, rng: RngState): number {
	if (!sample || temperature <= 1e-3) {
		let best = 0;
		for (let i = 1; i < visits.length; i++) if (visits[i] > visits[best]) best = i;
		return best;
	}
	const pw = visits.map((v) => Math.pow(Math.max(0, v), 1 / temperature));
	const sum = pw.reduce((a, b) => a + b, 0) || 1;
	let r = (nextInt(rng, 1_000_000) / 1_000_000) * sum;
	for (let i = 0; i < pw.length; i++) {
		r -= pw[i];
		if (r <= 0) return i;
	}
	return pw.length - 1;
}

export function chooseFullActionDecision(
	policy: NeuralPolicy,
	state: PublicGameState,
	seat: SeatColor,
	withNext: LegalAction[],
	catalog: PlayCatalog,
	selection: FullActionSelection,
	lookaheadDepth: number,
	lookaheadBeam: number,
	lookaheadRootBeam: number,
	targetTemperature: number,
	sample: boolean,
	temperature: number,
	rng: RngState
): { idx: number; pi: number[] } {
	if (withNext.length <= 1) return { idx: 0, pi: [1] };
	const rand = (): number => nextInt(rng, 1_000_000) / 1_000_000;
	const obs = encodeObs(state, seat);
	const cands = withNext.map((x) => encodeAction(state, seat, x.cmd, x.next, catalog));
	if (selection === 'policy') {
		return {
			idx: policyIndexWithProgressGuard(policy, state, seat, withNext, { sample, temperature, rand }, catalog),
			pi: policy.probs(obs, cands, targetTemperature)
		};
	}
	if (selection === 'hybrid') {
		const idx = hybridIndex(policy, state, seat, withNext, { sample, temperature, rand }, catalog);
		return { idx, pi: oneHot(withNext.length, idx) };
	}
	if (selection === 'lookahead') {
		const scores = scoreByLookahead(policy, state, seat, withNext, catalog, {
			depth: lookaheadDepth,
			beam: lookaheadBeam,
			rootBeam: lookaheadRootBeam
		});
		return {
			idx: lookaheadIndex(policy, state, seat, withNext, catalog, {
				depth: lookaheadDepth,
				beam: lookaheadBeam,
				rootBeam: lookaheadRootBeam,
				sample,
				temperature,
				rand
			}),
			pi: scoresToPolicyTarget(scores, targetTemperature)
		};
	}
	const scores = scoreByValue(policy, state, seat, withNext, catalog);
	return {
		idx: valueGuidedIndex(policy, state, seat, withNext, { sample, temperature, rand }, catalog),
		pi: scoresToPolicyTarget(scores, targetTemperature)
	};
}

export function filterPlannerActions(
	state: PublicGameState,
	catalog: PlayCatalog,
	withNext: LegalAction[],
	seat: SeatColor,
	forbidTypes?: Set<GameCommand['type']>,
	maxStatusLevel?: number,
	hardConstraints = false,
	preserveRouteFirepower = false,
	preserveRouteSurvival = false,
	firepowerThreshold = 0.5,
	abyssRouteDiscipline = false,
	goodTargetActionDiscipline = false
): LegalAction[] {
	if (
		!forbidTypes?.size &&
		maxStatusLevel === undefined &&
		!preserveRouteFirepower &&
		!preserveRouteSurvival &&
		!abyssRouteDiscipline &&
		!goodTargetActionDiscipline
	) return withNext;
	let filtered = withNext.filter((x) => {
		if (forbidTypes?.has(x.cmd.type)) return false;
		if (maxStatusLevel !== undefined && (x.next.players[seat]?.statusLevel ?? 0) > maxStatusLevel) {
			return false;
		}
		if (preserveRouteFirepower && !preservesRouteFirepower(state, seat, catalog, x, firepowerThreshold)) {
			return false;
		}
		if (preserveRouteSurvival && !preservesRouteSurvival(state, seat, catalog, x, firepowerThreshold)) {
			return false;
		}
		if ((preserveRouteFirepower || preserveRouteSurvival) && !preservesRouteHandDrawOpportunity(state, seat, catalog, x, withNext, firepowerThreshold)) {
			return false;
		}
		return true;
	});
	if (abyssRouteDiscipline) {
		filtered = filterAbyssRouteDisciplineActions(
			state,
			seat,
			catalog,
			filtered,
			firepowerThreshold
		);
	}
	if (goodTargetActionDiscipline) {
		filtered = filterGoodTargetActionDisciplineActions(
			state,
			seat,
			catalog,
			filtered,
			firepowerThreshold
		);
	}
	return filtered.length > 0 || hardConstraints ? filtered : withNext;
}

export function playPlannerSelfPlayGame(catalog: PlayCatalog, opts: SelfPlayOptions): SelfPlayResult {
	const profiles = opts.profiles;
	const n = Math.min(profiles.length, SEAT_COLORS.length, catalog.guardians.length);
	const seats = SEAT_COLORS.slice(0, n) as SeatColor[];
	const guardianNames = (opts.guardianNames ?? catalog.guardians.map((g) => g.name)).slice(0, n);
	const plannerSeats = new Set<SeatColor>(opts.plannerSeats ?? seats);
	const recordSeats = new Set<SeatColor>(opts.recordSeats ?? [...plannerSeats]);
	const control = opts.control ?? 'navigation';
	const fullSelection = opts.fullSelection ?? 'value';
	const fullLookaheadDepth = Math.max(0, opts.fullLookaheadDepth ?? 2);
	const fullLookaheadBeam = Math.max(1, opts.fullLookaheadBeam ?? 8);
	const fullLookaheadRootBeam = Math.max(1, opts.fullLookaheadRootBeam ?? 24);
	const fullTargetTemperature = Math.max(1e-3, opts.fullTargetTemperature ?? 0.25);
	const farmNavigationOracle = opts.farmNavigationOracle ?? 'off';
	const pvpPivotOracle = opts.pvpPivotOracle ?? 'off';
	const pvpPivotOracleForSeat = (seat: SeatColor): PvpPivotOracle =>
		opts.pvpPivotOracleBySeat?.[seat] ?? pvpPivotOracle;
	const farmNavigationThreshold = clamp01(opts.farmNavigationThreshold ?? 0.5);
	const routeModeThreshold = clamp01(opts.routeModeThreshold ?? 0.5);
	const maxRounds = opts.maxRounds ?? 30;
	const policyForSeat = (seat: SeatColor): NeuralPolicy => opts.seatPolicies?.[seat] ?? opts.policy;
	const seatEnabled = (enabledSeats: SeatColor[] | undefined, seat: SeatColor): boolean =>
		enabledSeats === undefined || enabledSeats.includes(seat);
	const forbidTypesForSeat = (seat: SeatColor): Set<GameCommand['type']> | undefined =>
		opts.forbidTypesBySeat?.[seat] ?? opts.forbidTypes;
	const maxStatusLevelForSeat = (seat: SeatColor): number | undefined =>
		opts.maxStatusLevelBySeat?.[seat] ?? opts.maxStatusLevel;
	const preserveRouteFirepowerForSeat = (seat: SeatColor): boolean =>
		opts.preserveRouteFirepowerBySeat?.[seat] ?? opts.preserveRouteFirepower ?? false;
	const preserveRouteSurvivalForSeat = (seat: SeatColor): boolean =>
		opts.preserveRouteSurvivalBySeat?.[seat] ?? opts.preserveRouteSurvival ?? false;
	const abyssRouteDisciplineForSeat = (seat: SeatColor): boolean =>
		opts.abyssRouteDisciplineBySeat?.[seat] ?? opts.abyssRouteDiscipline ?? false;
	const goodTargetActionDisciplineForSeat = (seat: SeatColor): boolean =>
		opts.goodTargetActionDisciplineBySeat?.[seat] ?? opts.goodTargetActionDiscipline ?? false;
	const navigationPolicyGate = opts.navigationPolicyGate ?? 'all';
	const scalingNavigationPolicyGate = opts.scalingNavigationPolicyGate ?? 'route-option-scaling';
	const buildOptionDestinations: NavigationDestination[] = ['Lantern Canyon', 'Floral Patch', 'Cyber City', 'Tidal Cove'];
	const scalingOptionDestinations: NavigationDestination[] = ['Tidal Cove', 'Cyber City', 'Lantern Canyon'];
	const restoreOptionDestinations: NavigationDestination[] = ['Lantern Canyon', 'Floral Patch'];
	const hp4FirstWallDestinations: NavigationDestination[] = ['Arcane Abyss', 'Lantern Canyon', 'Floral Patch'];
	const closerDamageDestinations: NavigationDestination[] = ['Tidal Cove', 'Cyber City', 'Lantern Canyon'];
	const closerMaxBarrierDestinations: NavigationDestination[] = ['Floral Patch', 'Lantern Canyon', 'Cyber City'];
	const closerRestoreDestinations: NavigationDestination[] = ['Lantern Canyon', 'Floral Patch'];
	const survivalRebuildDestinations: NavigationDestination[] = ['Floral Patch', 'Lantern Canyon', 'Cyber City', 'Tidal Cove'];
	const survivalDamageDestinations: NavigationDestination[] = ['Cyber City', 'Tidal Cove', 'Lantern Canyon'];
	const survivalRestoreDestinations: NavigationDestination[] = ['Floral Patch', 'Lantern Canyon'];
	const pureDamageBuildDestinations: NavigationDestination[] = ['Tidal Cove', 'Cyber City'];
	const pureEconomyBuildDestinations: NavigationDestination[] = ['Lantern Canyon', 'Tidal Cove', 'Cyber City'];
	const fallenHuntMemory: Record<string, {
		lastDestination?: NavigationDestination;
		lastPvpVp: number;
		dryStreak: number;
		lastChoiceRound: number;
		lastCheckedRound: number;
	}> = {};
	const shouldUseNavigationPolicyGate = (
		gate: NavigationPolicyGate,
		policy: NeuralPolicy | undefined,
		state: PublicGameState,
		seat: SeatColor
	): boolean => {
		if (!policy) return false;
		if (gate === 'all') return true;
		if (gate === 'unsafe-firepower' || gate === 'unsafe-firepower-build-option') {
			const player = state.players[seat];
			if (!player || !state.monster || (player.statusLevel ?? 0) !== 0) return false;
			const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
			const firepowerProb = firepowerKillProbability(state, seat, catalog);
			return firepowerProb >= farmNavigationThreshold && cleanProb < farmNavigationThreshold;
		}
		if (gate === 'midroute-scaling') {
			const player = state.players[seat];
			if (!player || (player.statusLevel ?? 0) !== 0) return false;
			const farm = evaluateFarmValue(state, seat, catalog, { threshold: farmNavigationThreshold });
			if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
			return state.round >= 4 && (player.victoryPoints ?? 0) >= 6;
		}
		if (gate === 'route-option-scaling') {
			const player = state.players[seat];
			if (!player || !state.monster || (player.statusLevel ?? 0) !== 0) return false;
			const farm = evaluateFarmValue(state, seat, catalog, { threshold: farmNavigationThreshold });
			if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
			const vp = player.victoryPoints ?? 0;
			if (state.round < 8 || vp < 10 || vp >= 24) return false;
			const counts = awakenedClassCounts(player);
			const attackDice = player.attackDice?.length ?? 0;
			const attack = expectedAttack(player);
			const monsterHp = state.monster.maxHp ?? state.monster.hp ?? 0;
			const firepowerProb = firepowerKillProbability(state, seat, catalog);
			const needsDamage = monsterHp > 0 && (firepowerProb < farmNavigationThreshold || attack < monsterHp + 1);
			if (needsDamage) return true;
			if (combatReadyButNeedsRestore(state, seat, catalog, farmNavigationThreshold)) return true;
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
				const farm = evaluateFarmValue(state, seat, catalog, { threshold: farmNavigationThreshold });
				return farm.valid && farm.farmable && farm.opportunityVp >= 1;
			}
			if (gate === 'pure-farm-build') {
				const player = state.players[seat];
				return !!player && (player.statusLevel ?? 0) === 0 && !!state.monster;
			}
			if (gate === 'good-nonfallen-farm-build') {
				const player = state.players[seat];
				return !!player && !isEvilAlignment(player.statusLevel ?? 0) && !!state.monster;
			}
			if (gate === 'good-nonfallen-farm-target-pivot') {
				const player = state.players[seat];
				return !!player && !isEvilAlignment(player.statusLevel ?? 0) && !!state.monster;
			}
			if (gate === 'good-target-exposure' || gate === 'good-target-rendezvous-exposure') {
				return isGoodTargetExposureNavigationState(state, seat, catalog, farmNavigationThreshold);
			}
				if (gate === 'good-nonfallen-farm-target-evade') {
					const player = state.players[seat];
					return !!player && !isEvilAlignment(player.statusLevel ?? 0) && !!state.monster;
				}
				if (gate === 'good-nonfallen-score-floor') {
					const player = state.players[seat];
					return !!player && !isEvilAlignment(player.statusLevel ?? 0) && !!state.monster;
				}
				if (gate === 'good-builder-oracle') {
					const player = state.players[seat];
					return !!player && (player.statusLevel ?? 0) === 0;
				}
			if (
				gate === 'good-builder-farmer-oracle' ||
				gate === 'good-builder-support-oracle' ||
				gate === 'good-builder-noncontest-support-oracle'
			) {
				const player = state.players[seat];
				return !!player && !isEvilAlignment(player.statusLevel ?? 0);
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
			if (cleanProb >= farmNavigationThreshold) return false;
			const firepowerProb = firepowerKillProbability(state, seat, catalog);
			if (expectedAttack(player) >= 3.25) return false;
			return firepowerProb >= farmNavigationThreshold &&
				combatReadyButNeedsRestore(state, seat, catalog, farmNavigationThreshold);
		}
		if (gate === 'hp4-first-wall') {
			const player = state.players[seat];
			const monster = state.monster;
			if (!player || !monster || (player.statusLevel ?? 0) !== 0) return false;
			const vp = player.victoryPoints ?? 0;
			const monsterHp = monster.maxHp ?? monster.hp ?? 0;
			if (state.round < 9 || state.round > 22 || vp < 12 || vp > 22 || monsterHp < 4 || monsterHp > 5) return false;
			const farm = evaluateFarmValue(state, seat, catalog, { threshold: farmNavigationThreshold });
			if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
			const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
			if (cleanProb >= farmNavigationThreshold) return false;
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
			const farm = evaluateFarmValue(state, seat, catalog, { threshold: farmNavigationThreshold });
			if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
			const vp = player.victoryPoints ?? 0;
			const monsterHp = state.monster.maxHp ?? state.monster.hp ?? 0;
			if (state.round < 12 || vp < 15 || vp >= 30 || monsterHp < 4) return false;
			const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
			if (cleanProb >= farmNavigationThreshold) return false;
			const monsterDamage = state.monster.damage ?? 0;
			const attack = expectedAttack(player);
			const firepowerProb = firepowerKillProbability(state, seat, catalog);
			const survivalTarget = monsterDamage + 1;
			const maxBarrier = player.maxBarrier ?? 0;
			const barrier = player.barrier ?? 0;
			const damageDeficit = monsterHp > 0 && (
				attack < monsterHp + 0.5 ||
				firepowerProb < farmNavigationThreshold
			);
			const maxBarrierDeficit = survivalTarget > 0 && maxBarrier < survivalTarget;
			const restoreDeficit = survivalTarget > 0 && maxBarrier >= survivalTarget && barrier < survivalTarget;
			return damageDeficit || maxBarrierDeficit || restoreDeficit;
		}
		if (gate === 'route-finish-loop') {
			return isRouteCloserRestoreFinishState(state, seat, catalog, farmNavigationThreshold);
		}
		if (gate === 'survival-rebuild') {
			const player = state.players[seat];
			if (!player || !state.monster || (player.statusLevel ?? 0) !== 0) return false;
			const farm = evaluateFarmValue(state, seat, catalog, { threshold: farmNavigationThreshold });
			if (farm.valid && farm.farmable && farm.opportunityVp > 0) return false;
			const monsterHp = state.monster.maxHp ?? state.monster.hp ?? 0;
			const monsterDamage = state.monster.damage ?? 0;
			const vp = player.victoryPoints ?? 0;
			if (state.round < 5 || vp < 9 || monsterHp < 2) return false;
			const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
			if (cleanProb >= farmNavigationThreshold) return false;
			const attack = expectedAttack(player);
			const firepowerProb = firepowerKillProbability(state, seat, catalog);
			const barrierDeficit = (player.barrier ?? 0) < Math.min(player.maxBarrier ?? 0, monsterDamage + 1);
			const maxBarrierDeficit = (player.maxBarrier ?? 0) < monsterDamage + 2;
			const damageDeficit = attack < monsterHp + 0.5 || firepowerProb < farmNavigationThreshold;
			return monsterHp >= 4 || barrierDeficit || maxBarrierDeficit || damageDeficit;
		}
		if (gate === 'pvp-pivot') {
			return isPvpPivotState(state, seat, catalog, farmNavigationThreshold);
		}
		if (gate === 'pvp-predictive-pivot') {
			return isPvpPivotState(state, seat, catalog, farmNavigationThreshold) ||
				shouldPredictivePvpHunt(state, seat, catalog, farmNavigationThreshold);
		}
			if (gate === 'pvp-predictive-mode-pivot') {
				return isPvpPivotState(state, seat, catalog, farmNavigationThreshold) ||
					shouldPredictivePvpHunt(state, seat, catalog, farmNavigationThreshold);
			}
			if (gate === 'pvp-predictive-mode-hunt-fallback-pivot') {
				return isPvpPivotState(state, seat, catalog, farmNavigationThreshold) ||
					shouldPredictivePvpHunt(state, seat, catalog, farmNavigationThreshold);
			}
			if (gate === 'pvp-predictive-mode-hunt-fallback-rebuild-pivot') {
				return isPvpPivotState(state, seat, catalog, farmNavigationThreshold) ||
					shouldPredictivePvpHunt(state, seat, catalog, farmNavigationThreshold) ||
					shouldFallenRebuildRoute(state, seat, catalog, farmNavigationThreshold);
			}
			if (gate === 'pvp-predictive-flex-pivot') {
				return isPvpPivotState(state, seat, catalog, farmNavigationThreshold) ||
					shouldPredictivePvpHunt(state, seat, catalog, farmNavigationThreshold);
			}
		if (gate === 'pvp-predictive-value-pivot') {
			const player = state.players[seat];
			if ((player?.statusLevel ?? 0) >= 3) {
				return shouldPredictivePvpValueHunt(state, seat, catalog, farmNavigationThreshold);
			}
			return isPvpPivotState(state, seat, catalog, farmNavigationThreshold);
		}
		if (gate === 'pvp-predictive-finish-pivot') {
			const player = state.players[seat];
			if ((player?.statusLevel ?? 0) >= 3) {
				return shouldPredictivePvpFinishHunt(state, seat, catalog, farmNavigationThreshold);
			}
			return isPvpPivotState(state, seat, catalog, farmNavigationThreshold);
		}
		if (gate === 'pvp-good-target-value-pivot') {
			const player = state.players[seat];
			if ((player?.statusLevel ?? 0) >= 3) {
				return shouldGoodTargetValuePivotHunt(state, seat, catalog, farmNavigationThreshold);
			}
			return shouldGoodTargetValuePivotDescend(state, seat, catalog, farmNavigationThreshold);
		}
		return false;
	};
	const rootDestinationsForGate = (
		gate: NavigationPolicyGate,
		state: PublicGameState,
		seat: SeatColor,
		policy?: NeuralPolicy
	): NavigationDestination[] | undefined => {
		if (gate === 'unsafe-firepower-build-option') {
			return combatReadyButNeedsRestore(state, seat, catalog, farmNavigationThreshold)
				? restoreOptionDestinations
				: buildOptionDestinations;
		}
		if (gate === 'route-option-scaling') {
			return combatReadyButNeedsRestore(state, seat, catalog, farmNavigationThreshold)
				? restoreOptionDestinations
				: scalingOptionDestinations;
		}
		if (gate === 'hp2-survival-deficit') {
			return restoreOptionDestinations;
		}
		if (gate === 'pure-farm-build') {
			const player = state.players[seat];
			const monster = state.monster;
			if (!player || !monster) return pureEconomyBuildDestinations;
			const farm = evaluateFarmValue(state, seat, catalog, { threshold: farmNavigationThreshold });
			if (farm.valid && farm.farmable && farm.opportunityVp >= 1) return ['Arcane Abyss'];
			if (combatReadyButNeedsRestore(state, seat, catalog, farmNavigationThreshold)) return restoreOptionDestinations;
			const monsterHp = monster.maxHp ?? monster.hp ?? 0;
			const attack = expectedAttack(player);
			const firepowerProb = firepowerKillProbability(state, seat, catalog);
			const counts = awakenedClassCounts(player);
			const needsDamage = attack < monsterHp + 0.5 || firepowerProb < farmNavigationThreshold;
			const spiritAnimal = counts['Spirit Animal'] ?? 0;
			if (needsDamage || spiritAnimal < 2 || (player.attackDice?.length ?? 0) < 2) return pureDamageBuildDestinations;
			if ((player.maxBarrier ?? 0) < (monster.damage ?? 0) + 2) return pureEconomyBuildDestinations;
			return scalingOptionDestinations;
		}
			if (gate === 'good-nonfallen-farm-build') {
				return goodNonfallenFarmBuildDestinations(state, seat, catalog, farmNavigationThreshold);
			}
			if (gate === 'good-nonfallen-farm-target-pivot') {
				return goodNonfallenFarmTargetPivotDestinations(state, seat, catalog, farmNavigationThreshold);
			}
			if (gate === 'good-target-exposure') {
				return goodTargetExposureDestinations(state, seat, catalog);
			}
			if (gate === 'good-target-rendezvous-exposure') {
				return goodTargetRendezvousExposureDestinations(state, seat, catalog, farmNavigationThreshold);
			}
				if (gate === 'good-nonfallen-farm-target-evade') {
					return goodNonfallenFarmTargetEvadeDestinations(state, seat, catalog, farmNavigationThreshold);
				}
				if (gate === 'good-nonfallen-score-floor') {
					return goodNonfallenScoreFloorDestinations(state, seat, catalog, farmNavigationThreshold);
				}
				if (gate === 'good-builder-oracle') {
					return goodBuilderOracleDestinations(state, seat, catalog, farmNavigationThreshold);
				}
		if (gate === 'good-builder-farmer-oracle') {
			return goodBuilderFarmerOracleDestinations(state, seat, catalog, farmNavigationThreshold);
		}
		if (gate === 'good-builder-support-oracle') {
			return goodBuilderSupportOracleDestinations(state, seat, catalog, farmNavigationThreshold);
		}
		if (gate === 'good-builder-noncontest-support-oracle') {
			return goodBuilderNoncontestSupportDestinations(state, seat, catalog, farmNavigationThreshold);
		}
		if (gate === 'hp4-first-wall') {
			return hp4FirstWallDestinations;
		}
		if (gate === 'route-closer') {
			const player = state.players[seat];
			const monster = state.monster;
			if (!player || !monster) return closerDamageDestinations;
			const monsterHp = monster.maxHp ?? monster.hp ?? 0;
			const monsterDamage = monster.damage ?? 0;
			const attack = expectedAttack(player);
			const firepowerProb = firepowerKillProbability(state, seat, catalog);
			const survivalTarget = monsterDamage + 1;
			const maxBarrier = player.maxBarrier ?? 0;
			const barrier = player.barrier ?? 0;
			const damageDeficit = monsterHp > 0 && (
				attack < monsterHp + 0.5 ||
				firepowerProb < farmNavigationThreshold
			);
			if (damageDeficit) return closerDamageDestinations;
			if (survivalTarget > 0 && maxBarrier < survivalTarget) return closerMaxBarrierDestinations;
			if (survivalTarget > 0 && barrier < survivalTarget) return closerRestoreDestinations;
			return closerRestoreDestinations;
		}
		if (gate === 'route-finish-loop') {
			const player = state.players[seat];
			const monster = state.monster;
			if (!player || !monster) return closerRestoreDestinations;
			const monsterHp = monster.maxHp ?? monster.hp ?? 0;
			const monsterDamage = monster.damage ?? 0;
			const survivalTarget = monsterDamage + 1;
			const barrier = player.barrier ?? 0;
			const maxBarrier = player.maxBarrier ?? 0;
			const cleanProb = computeKillProbability(state, seat, catalog, { allowCorruptKill: false });
			const firepowerProb = firepowerKillProbability(state, seat, catalog);
			const attack = expectedAttack(player);
			const enoughFirepower =
				cleanProb >= farmNavigationThreshold ||
				firepowerProb >= farmNavigationThreshold ||
				attack >= monsterHp - 0.01;
			if (survivalTarget > 0 && maxBarrier >= survivalTarget && barrier < survivalTarget) {
				return ['Lantern Canyon'];
			}
			if ((survivalTarget <= 0 || barrier >= survivalTarget) && enoughFirepower) {
				return ['Arcane Abyss'];
			}
			return closerDamageDestinations;
		}
		if (gate === 'survival-rebuild') {
			const player = state.players[seat];
			const monster = state.monster;
			if (!player || !monster) return survivalRebuildDestinations;
			const monsterHp = monster.maxHp ?? monster.hp ?? 0;
			const attack = expectedAttack(player);
			const firepowerProb = firepowerKillProbability(state, seat, catalog);
			const damageDeficit = monsterHp > 0 && (
				attack < monsterHp + 0.5 ||
				firepowerProb < farmNavigationThreshold
			);
			return damageDeficit ? survivalDamageDestinations : survivalRestoreDestinations;
		}
		if (gate === 'pvp-pivot') {
			const player = state.players[seat];
			if ((player?.statusLevel ?? 0) >= 3) return visiblePvpHuntDestinations(state, seat);
			return ['Arcane Abyss', 'Lantern Canyon', 'Tidal Cove', 'Floral Patch'];
		}
		if (gate === 'pvp-predictive-pivot') {
			const player = state.players[seat];
			if ((player?.statusLevel ?? 0) >= 3) {
				const visible = visiblePvpHuntDestinations(state, seat);
				return visible.length > 0
					? visible
					: predictedGoodTargetDestinations(state, seat, catalog, farmNavigationThreshold);
			}
			return ['Arcane Abyss', 'Lantern Canyon', 'Tidal Cove', 'Floral Patch'];
		}
			if (gate === 'pvp-predictive-mode-pivot') {
				const player = state.players[seat];
				if ((player?.statusLevel ?? 0) >= 3) {
					const huntProb = routeModeHuntProbability(policy, state, seat);
					if (huntProb !== null && huntProb < routeModeThreshold) return ['Arcane Abyss'];
				const visible = visiblePvpHuntDestinations(state, seat);
				return visible.length > 0
					? visible
					: predictedGoodTargetDestinations(state, seat, catalog, farmNavigationThreshold);
				}
				return ['Arcane Abyss', 'Lantern Canyon', 'Tidal Cove', 'Floral Patch'];
			}
			if (
				gate === 'pvp-predictive-mode-hunt-fallback-pivot' ||
				gate === 'pvp-predictive-mode-hunt-fallback-rebuild-pivot'
			) {
				const player = state.players[seat];
				if ((player?.statusLevel ?? 0) >= 3) {
					const huntProb = routeModeHuntProbability(policy, state, seat);
					if (huntProb !== null && huntProb < routeModeThreshold) {
						return gate === 'pvp-predictive-mode-hunt-fallback-rebuild-pivot'
							? fallenRebuildDestinations(state, seat, catalog, farmNavigationThreshold)
							: ['Arcane Abyss'];
					}
					const memory = fallenHuntMemory[seat];
					return gate === 'pvp-predictive-mode-hunt-fallback-rebuild-pivot'
						? fallenPredictedHuntDestinationsWithFallbackAndRebuild(
							state,
							seat,
							catalog,
							farmNavigationThreshold,
							memory?.dryStreak ?? 0,
							memory?.lastDestination
						)
						: fallenPredictedHuntDestinationsWithFallback(
							state,
							seat,
							catalog,
							farmNavigationThreshold,
							memory?.dryStreak ?? 0,
							memory?.lastDestination
						);
				}
				return ['Arcane Abyss', 'Lantern Canyon', 'Tidal Cove', 'Floral Patch'];
			}
			if (gate === 'pvp-predictive-flex-pivot') {
				const player = state.players[seat];
				if ((player?.statusLevel ?? 0) >= 3) {
					return pvpHuntOrAbyssDestinations(state, seat, catalog, farmNavigationThreshold);
			}
			return ['Arcane Abyss', 'Lantern Canyon', 'Tidal Cove', 'Floral Patch'];
		}
		if (gate === 'pvp-predictive-value-pivot') {
			const player = state.players[seat];
			if ((player?.statusLevel ?? 0) >= 3) {
				const visible = visiblePvpHuntDestinations(state, seat);
				return visible.length > 0
					? visible
					: predictedGoodTargetDestinations(state, seat, catalog, farmNavigationThreshold);
			}
			return ['Arcane Abyss', 'Lantern Canyon', 'Tidal Cove', 'Floral Patch'];
		}
		if (gate === 'pvp-predictive-finish-pivot') {
			const player = state.players[seat];
			if ((player?.statusLevel ?? 0) >= 3) {
				const visible = visiblePvpHuntDestinations(state, seat);
				return visible.length > 0
					? visible
					: predictedGoodTargetDestinations(state, seat, catalog, farmNavigationThreshold);
			}
			return ['Arcane Abyss', 'Lantern Canyon', 'Tidal Cove', 'Floral Patch'];
		}
			if (gate === 'pvp-good-target-value-pivot') {
				const player = state.players[seat];
				if ((player?.statusLevel ?? 0) >= 3) {
					const memory = fallenHuntMemory[seat];
					const lowTailHunt = shouldGoodTargetLowTailHunt(state, seat, catalog, farmNavigationThreshold);
					const hunt = goodTargetValuePivotDestinations(
						state,
						seat,
						catalog,
						farmNavigationThreshold,
						memory?.dryStreak ?? 0,
						memory?.lastDestination,
						lowTailHunt
					);
					return hunt.length > 0 ? hunt : ['Arcane Abyss'];
				}
				return ['Arcane Abyss'];
		}
		return undefined;
	};
	const navigationSelectionForSeat = (
		state: PublicGameState,
		seat: SeatColor
	): { policy: NeuralPolicy; rootDestinations?: NavigationDestination[]; activeGate?: NavigationPolicyGate } => {
		const seatPatchPolicy = opts.seatPatchNavigationPolicies?.[seat];
		const patchPolicy = seatPatchPolicy ?? opts.patchNavigationPolicy;
		const patchGate = opts.seatPatchNavigationPolicyGates?.[seat] ?? opts.patchNavigationPolicyGate ?? 'all';
		if (
			(seatPatchPolicy || seatEnabled(opts.patchNavigationSeats, seat)) &&
			shouldUseNavigationPolicyGate(patchGate, patchPolicy, state, seat)
		) {
			return {
				policy: patchPolicy ?? policyForSeat(seat),
				rootDestinations: rootDestinationsForGate(patchGate, state, seat, patchPolicy ?? policyForSeat(seat)),
				activeGate: patchGate
			};
		}
		const seatPatch2Policy = opts.seatPatch2NavigationPolicies?.[seat];
		const patch2Policy = seatPatch2Policy ?? opts.patch2NavigationPolicy;
		const patch2Gate = opts.seatPatch2NavigationPolicyGates?.[seat] ?? opts.patch2NavigationPolicyGate ?? 'all';
		if (
			(seatPatch2Policy || seatEnabled(opts.patch2NavigationSeats, seat)) &&
			shouldUseNavigationPolicyGate(patch2Gate, patch2Policy, state, seat)
		) {
			return {
				policy: patch2Policy ?? policyForSeat(seat),
				rootDestinations: rootDestinationsForGate(patch2Gate, state, seat, patch2Policy ?? policyForSeat(seat)),
				activeGate: patch2Gate
			};
		}
		const primary = opts.seatNavigationPolicies?.[seat] ?? opts.navigationPolicy;
		const primaryGate = opts.seatNavigationPolicyGates?.[seat] ?? navigationPolicyGate;
		if (shouldUseNavigationPolicyGate(primaryGate, primary, state, seat)) {
			return {
				policy: primary ?? policyForSeat(seat),
				rootDestinations: rootDestinationsForGate(primaryGate, state, seat, primary ?? policyForSeat(seat)),
				activeGate: primaryGate
			};
		}
		const scalingPolicy = opts.seatScalingNavigationPolicies?.[seat] ?? opts.scalingNavigationPolicy;
		const scalingGate = opts.seatScalingNavigationPolicyGates?.[seat] ?? scalingNavigationPolicyGate;
		if (shouldUseNavigationPolicyGate(scalingGate, scalingPolicy, state, seat)) {
			return {
				policy: scalingPolicy ?? policyForSeat(seat),
				rootDestinations: rootDestinationsForGate(scalingGate, state, seat, scalingPolicy ?? policyForSeat(seat)),
				activeGate: scalingGate
			};
		}
		return { policy: policyForSeat(seat) };
	};
	const microPolicyGate = opts.microPolicyGate ?? 'all';
	const shouldUseMicroPolicyGate = (
		gate: MicroPolicyGate,
		state: PublicGameState,
		seat: SeatColor
	): boolean => {
		if (gate === 'all') return true;
		if (gate === 'good-builder-oracle') return (state.players[seat]?.statusLevel ?? 0) === 0;
		if (gate === 'good-builder-hp4-oracle' || gate === 'good-builder-hp4-pick-oracle') {
			const player = state.players[seat];
			return !!player && !isEvilAlignment(player.statusLevel ?? 0) && !!state.monster;
		}
			if (
				gate === 'good-builder-hp4-conversion-oracle' ||
				gate === 'good-builder-hp4-scorefloor-oracle'
			) {
				const player = state.players[seat];
				const hp = state.monster?.maxHp ?? state.monster?.hp ?? 0;
				return !!player && !isEvilAlignment(player.statusLevel ?? 0) && hp >= 4;
			}
			if (gate === 'good-builder-hp4-conversion-overlay') {
				return isGoodBuilderHp4ConversionOverlayState(state, seat);
			}
		if (gate === 'good-builder-score-pick-oracle' || gate === 'good-builder-score-conversion-oracle') {
			const player = state.players[seat];
			return !!player && !isEvilAlignment(player.statusLevel ?? 0) && !!state.monster;
		}
		if (gate === 'good-builder-farmer-oracle' || gate === 'good-builder-support-oracle') {
			return (state.players[seat]?.statusLevel ?? 0) === 0;
		}
		if (gate === 'location-interactions') return state.phase === 'location';
			if (
				gate === 'pvp-pivot' ||
				gate === 'pvp-pivot-encounter-force' ||
				gate === 'pvp-high-value-encounter-force'
			) {
				if (
					gate === 'pvp-pivot-encounter-force' &&
					shouldForceHardMonsterPvpAttack(state, seat, pvpEncounterTargets(state, seat, true))
				) {
					return true;
				}
				return isPvpPivotState(state, seat, catalog, farmNavigationThreshold);
			}
		if (gate === 'route-closer-full') {
			return isRouteCloserFullActionState(state, seat, catalog, farmNavigationThreshold);
		}
		if (gate === 'route-closer-oracle' || gate === 'route-finish-oracle') return false;
		return state.players[seat]?.navigationDestination === 'Arcane Abyss';
	};
	const seatMicroPolicyGateForSeat = (seat: SeatColor): MicroPolicyGate =>
		opts.seatMicroPolicyGates?.[seat] ?? 'all';
	const useSeatMicroPolicy = (state: PublicGameState, seat: SeatColor): boolean => {
		if (!opts.seatMicroPolicies?.[seat]) return false;
		return shouldUseMicroPolicyGate(seatMicroPolicyGateForSeat(seat), state, seat);
	};
	const useGlobalMicroPolicy = (state: PublicGameState, seat: SeatColor): boolean => {
		if (!opts.microPolicy) return false;
		if (!seatEnabled(opts.microPolicySeats, seat)) return false;
		return shouldUseMicroPolicyGate(microPolicyGate, state, seat);
	};
	const microPolicyForSeat = (state: PublicGameState, seat: SeatColor): NeuralPolicy => {
		const seatMicroPolicy = opts.seatMicroPolicies?.[seat];
		if (seatMicroPolicy && useSeatMicroPolicy(state, seat)) return seatMicroPolicy;
		if (opts.routeCloserMicroPolicy && isRouteCloserRestoreFinishState(state, seat, catalog, farmNavigationThreshold)) {
			return opts.routeCloserMicroPolicy;
		}
		return opts.seatPolicies?.[seat] ??
			(useGlobalMicroPolicy(state, seat) ? opts.microPolicy! : opts.policy);
	};
	const activeMicroGateForSeat = (state: PublicGameState, seat: SeatColor, policy: NeuralPolicy): MicroPolicyGate | undefined => {
		const seatMicroPolicy = opts.seatMicroPolicies?.[seat];
		if (seatMicroPolicy && policy === seatMicroPolicy && useSeatMicroPolicy(state, seat)) {
			return seatMicroPolicyGateForSeat(seat);
		}
		if (opts.microPolicy && policy === opts.microPolicy && useGlobalMicroPolicy(state, seat)) {
			return microPolicyGate;
		}
		return undefined;
	};
	const microDecisionSet = (state: PublicGameState, seat: SeatColor, withNext: LegalAction[]): {
		policy: NeuralPolicy;
		withNext: LegalAction[];
		indexMap?: number[];
	} => {
		const policy = microPolicyForSeat(state, seat);
		const activeMicroGate = activeMicroGateForSeat(state, seat, policy);
		if (
			!activeMicroGate ||
			(
				activeMicroGate !== 'abyss-farm-actions' &&
				activeMicroGate !== 'abyss-reward-actions' &&
				activeMicroGate !== 'location-interactions' &&
				activeMicroGate !== 'pvp-pivot' &&
				activeMicroGate !== 'pvp-pivot-encounter-force' &&
				activeMicroGate !== 'pvp-high-value-encounter-force'
			)
		) {
			return { policy, withNext };
		}
		const allowedTypes = activeMicroGate === 'abyss-reward-actions'
			? REWARD_ACTION_TYPES
			: activeMicroGate === 'location-interactions'
				? new Set<GameCommand['type']>(['resolveLocationInteraction'])
				: activeMicroGate === 'pvp-pivot' ||
						activeMicroGate === 'pvp-pivot-encounter-force' ||
						activeMicroGate === 'pvp-high-value-encounter-force'
					? new Set<GameCommand['type']>([
						'takeSpirit',
						'replaceSpirit',
						'spawnHandSpirit',
						'resolveLocationInteraction',
						'startCombat',
						'initiatePvp',
						'passEncounter'
					])
					: FARM_ACTION_TYPES;
		const indexMap: number[] = [];
		const filtered: LegalAction[] = [];
		for (let i = 0; i < withNext.length; i++) {
			if (!allowedTypes.has(withNext[i].cmd.type)) continue;
			indexMap.push(i);
			filtered.push(withNext[i]);
		}
		return filtered.length > 0
			? { policy, withNext: filtered, indexMap }
			: { policy: policyForSeat(seat), withNext };
	};
	const moveRng = createRng((opts.seed ^ 0x2545f491) >>> 0 || 1);
	const heurRng: BotRandom = {
		int: (m: number) => nextInt(moveRng, m),
		chance: () => nextInt(moveRng, 2) === 0
	};
	const chooseArbitratedFullActionDecision = (
		state: PublicGameState,
		seat: SeatColor,
		withNext: LegalAction[]
	): { idx: number; pi: number[] } => {
		if (opts.routeFinishOracle && isRouteCloserRestoreFinishState(state, seat, catalog, farmNavigationThreshold)) {
			const chosen = chooseRouteFinishLoopOracleAction(state, seat, catalog, withNext, {
				cleanThreshold: farmNavigationThreshold,
				firepowerThreshold: farmNavigationThreshold
			});
			const idx = Math.max(0, chosen ? withNext.indexOf(chosen) : 0);
			return { idx, pi: oneHot(withNext.length, idx) };
		}
		if (microPolicyGate === 'route-closer-oracle' && isRouteCloserFullActionState(state, seat, catalog, farmNavigationThreshold)) {
			const chosen = chooseRouteBreakpointOracleAction(state, seat, catalog, withNext, {
				cleanThreshold: farmNavigationThreshold,
				firepowerThreshold: farmNavigationThreshold
			});
			const idx = Math.max(0, chosen ? withNext.indexOf(chosen) : 0);
			return { idx, pi: oneHot(withNext.length, idx) };
		}
		if (microPolicyGate === 'route-finish-oracle' && isRouteCloserRestoreFinishState(state, seat, catalog, farmNavigationThreshold)) {
			const chosen = chooseRouteFinishLoopOracleAction(state, seat, catalog, withNext, {
				cleanThreshold: farmNavigationThreshold,
				firepowerThreshold: farmNavigationThreshold
			});
			const idx = Math.max(0, chosen ? withNext.indexOf(chosen) : 0);
			return { idx, pi: oneHot(withNext.length, idx) };
		}
			const arbitrationPolicy = microPolicyForSeat(state, seat);
			const activeMicroGate = activeMicroGateForSeat(state, seat, arbitrationPolicy);
			const hardMonsterPvpIdx = withNext.findIndex((x) => x.cmd.type === 'initiatePvp');
			if (
				hardMonsterPvpIdx >= 0 &&
				shouldForceHardMonsterPvpAttack(state, seat, pvpEncounterTargets(state, seat, true))
			) {
				return { idx: hardMonsterPvpIdx, pi: oneHot(withNext.length, hardMonsterPvpIdx) };
			}
			if (activeMicroGate === 'pvp-pivot-encounter-force') {
				const idx = withNext.findIndex((x) => x.cmd.type === 'initiatePvp');
				if (idx >= 0) return { idx, pi: oneHot(withNext.length, idx) };
		}
		if (activeMicroGate === 'pvp-high-value-encounter-force') {
			const attackIdx = withNext.findIndex((x) => x.cmd.type === 'initiatePvp');
			if (attackIdx >= 0) {
				const opportunity = pvpEncounterTargets(state, seat, true);
				if (opportunity.bestTargetVp >= PVP_FORCE_HIGH_VALUE_TARGET_VP) {
					return { idx: attackIdx, pi: oneHot(withNext.length, attackIdx) };
				}
				const passIdx = withNext.findIndex((x) => x.cmd.type === 'passEncounter');
				if (passIdx >= 0) return { idx: passIdx, pi: oneHot(withNext.length, passIdx) };
			}
		}
		if (activeMicroGate === 'good-builder-oracle') {
			const chosen = chooseGoodBuilderOracleAction(state, seat, catalog, withNext, farmNavigationThreshold);
			const idx = Math.max(0, chosen ? withNext.indexOf(chosen) : 0);
			return { idx, pi: oneHot(withNext.length, idx) };
		}
		if (activeMicroGate === 'good-builder-hp4-oracle') {
			const chosen = chooseRouteBreakpointOracleAction(state, seat, catalog, withNext, {
				cleanThreshold: farmNavigationThreshold,
				firepowerThreshold: farmNavigationThreshold
			});
			const idx = Math.max(0, chosen ? withNext.indexOf(chosen) : 0);
			return { idx, pi: oneHot(withNext.length, idx) };
		}
		if (activeMicroGate === 'good-builder-hp4-pick-oracle') {
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
						cleanThreshold: farmNavigationThreshold,
						firepowerThreshold: farmNavigationThreshold
					}
				);
				const idx = chosen
					? filtered.find((x) => x.action === chosen)?.index ?? filtered[0].index
					: filtered[0].index;
				return { idx, pi: oneHot(withNext.length, idx) };
			}
		}
		if (activeMicroGate === 'good-builder-score-pick-oracle') {
			const filtered: { action: LegalAction; index: number }[] = [];
			for (let i = 0; i < withNext.length; i++) {
				if (GOOD_BUILDER_SCORE_PICK_ACTION_TYPES.has(withNext[i].cmd.type)) {
					filtered.push({ action: withNext[i], index: i });
				}
			}
			if (filtered.length > 0) {
				const chosen = chooseGoodBuilderOracleAction(
					state,
					seat,
					catalog,
					filtered.map((x) => x.action),
					farmNavigationThreshold
				);
				const idx = chosen
					? filtered.find((x) => x.action === chosen)?.index ?? filtered[0].index
					: filtered[0].index;
				return { idx, pi: oneHot(withNext.length, idx) };
			}
		}
			if (activeMicroGate === 'good-builder-score-conversion-oracle') {
				const filtered: { action: LegalAction; index: number }[] = [];
				for (let i = 0; i < withNext.length; i++) {
					if (GOOD_BUILDER_SCORE_CONVERSION_ACTION_TYPES.has(withNext[i].cmd.type)) {
						filtered.push({ action: withNext[i], index: i });
				}
			}
			if (filtered.length > 0) {
				const chosen = chooseGoodBuilderOracleAction(
					state,
					seat,
					catalog,
					filtered.map((x) => x.action),
					farmNavigationThreshold
				);
				const idx = chosen
					? filtered.find((x) => x.action === chosen)?.index ?? filtered[0].index
					: filtered[0].index;
					return { idx, pi: oneHot(withNext.length, idx) };
				}
			}
			if (activeMicroGate === 'good-builder-hp4-scorefloor-oracle') {
				const filtered: { action: LegalAction; index: number }[] = [];
				for (let i = 0; i < withNext.length; i++) {
					if (GOOD_BUILDER_HP4_SCOREFLOOR_ACTION_TYPES.has(withNext[i].cmd.type)) {
						filtered.push({ action: withNext[i], index: i });
					}
				}
				if (filtered.length > 0) {
					const chosen = chooseGoodBuilderHp4ScoreFloorOracleAction(
						state,
						seat,
						catalog,
						filtered.map((x) => x.action),
						farmNavigationThreshold
					);
					const idx = chosen
						? filtered.find((x) => x.action === chosen)?.index ?? filtered[0].index
						: filtered[0].index;
					return { idx, pi: oneHot(withNext.length, idx) };
				}
			}
			if (activeMicroGate === 'good-builder-hp4-conversion-overlay') {
				const mainDecision = chooseFullActionDecision(
				policyForSeat(seat),
				state,
				seat,
				withNext,
				catalog,
				fullSelection,
				fullLookaheadDepth,
				fullLookaheadBeam,
				fullLookaheadRootBeam,
				fullTargetTemperature,
				opts.sampleMoves ?? false,
				opts.temperature ?? 1,
				moveRng
			);
			const indexMap: number[] = [];
			const conversionActions: LegalAction[] = [];
			for (let i = 0; i < withNext.length; i++) {
				if (!GOOD_BUILDER_HP4_CONVERSION_ACTION_TYPES.has(withNext[i].cmd.type)) continue;
				indexMap.push(i);
				conversionActions.push(withNext[i]);
			}
			if (conversionActions.length === 0) return mainDecision;
			const overlayDecision = chooseFullActionDecision(
				arbitrationPolicy,
				state,
				seat,
				conversionActions,
				catalog,
				fullSelection,
				fullLookaheadDepth,
				fullLookaheadBeam,
				fullLookaheadRootBeam,
				fullTargetTemperature,
				opts.sampleMoves ?? false,
				opts.temperature ?? 1,
				moveRng
			);
			const overlayIdx = indexMap[overlayDecision.idx] ?? mainDecision.idx;
				const scoreOpts = {
					cleanThreshold: farmNavigationThreshold,
					firepowerThreshold: farmNavigationThreshold
				};
				const mainScore = goodBuilderHp4ScoreFloorActionScore(
					state,
					seat,
					catalog,
					withNext[mainDecision.idx],
					scoreOpts.cleanThreshold
				);
				const overlayScore = goodBuilderHp4ScoreFloorActionScore(
					state,
					seat,
					catalog,
					withNext[overlayIdx],
					scoreOpts.cleanThreshold
				);
				if (overlayScore < mainScore) return mainDecision;
			return {
				idx: overlayIdx,
				pi: withNext.map((_, i) => {
					const local = indexMap.indexOf(i);
					return local >= 0 ? (overlayDecision.pi[local] ?? 0) : 0;
				})
				};
			}
			if (activeMicroGate === 'good-builder-hp4-conversion-oracle') {
				const mainDecision = chooseFullActionDecision(
					policyForSeat(seat),
					state,
					seat,
					withNext,
					catalog,
					fullSelection,
					fullLookaheadDepth,
					fullLookaheadBeam,
					fullLookaheadRootBeam,
					fullTargetTemperature,
					opts.sampleMoves ?? false,
					opts.temperature ?? 1,
					moveRng
				);
				const indexMap: number[] = [];
				const conversionActions: LegalAction[] = [];
				for (let i = 0; i < withNext.length; i++) {
					if (!isGoodBuilderHp4ConversionOverlayAction(state, seat, withNext[i])) continue;
					indexMap.push(i);
					conversionActions.push(withNext[i]);
				}
				if (conversionActions.length === 0) return mainDecision;
				const scoreOpts = {
					cleanThreshold: farmNavigationThreshold,
					firepowerThreshold: farmNavigationThreshold
				};
					const chosen = chooseGoodBuilderHp4ScoreFloorOracleAction(
						state,
						seat,
						catalog,
						conversionActions,
						scoreOpts.cleanThreshold
					);
					const localIdx = chosen ? conversionActions.indexOf(chosen) : -1;
					const oracleIdx = localIdx >= 0 ? indexMap[localIdx] : indexMap[0];
					const mainScore = goodBuilderHp4ScoreFloorActionScore(
						state,
						seat,
						catalog,
						withNext[mainDecision.idx],
						scoreOpts.cleanThreshold
					);
					const oracleScore = goodBuilderHp4ScoreFloorActionScore(
						state,
						seat,
						catalog,
						withNext[oracleIdx],
						scoreOpts.cleanThreshold
					);
				if (oracleScore < mainScore) return mainDecision;
				return { idx: oracleIdx, pi: oneHot(withNext.length, oracleIdx) };
			}
			if (activeMicroGate === 'good-builder-farmer-oracle' || activeMicroGate === 'good-builder-support-oracle') {
				const chosen = chooseGoodBuilderOracleAction(state, seat, catalog, withNext, farmNavigationThreshold);
			const idx = Math.max(0, chosen ? withNext.indexOf(chosen) : 0);
			return { idx, pi: oneHot(withNext.length, idx) };
		}

		if (activeMicroGate !== 'abyss-farm-overlay') {
			const decisionSet = microDecisionSet(state, seat, withNext);
			const decision = chooseFullActionDecision(
				decisionSet.policy,
				state,
				seat,
				decisionSet.withNext,
				catalog,
				fullSelection,
				fullLookaheadDepth,
				fullLookaheadBeam,
				fullLookaheadRootBeam,
				fullTargetTemperature,
				opts.sampleMoves ?? false,
				opts.temperature ?? 1,
				moveRng
			);
			const idx = decisionSet.indexMap?.[decision.idx] ?? decision.idx;
			const pi = decisionSet.indexMap
				? withNext.map((_, i) => {
					const local = decisionSet.indexMap!.indexOf(i);
					return local >= 0 ? (decision.pi[local] ?? 0) : 0;
				})
				: decision.pi;
			return { idx, pi };
		}

		const mainDecision = chooseFullActionDecision(
			policyForSeat(seat),
			state,
			seat,
			withNext,
			catalog,
			fullSelection,
			fullLookaheadDepth,
			fullLookaheadBeam,
			fullLookaheadRootBeam,
			fullTargetTemperature,
			opts.sampleMoves ?? false,
			opts.temperature ?? 1,
			moveRng
		);
		if (!activeMicroGate || state.players[seat]?.navigationDestination !== 'Arcane Abyss') {
			return mainDecision;
		}

		const indexMap: number[] = [];
		const payoffActions: LegalAction[] = [];
		for (let i = 0; i < withNext.length; i++) {
			if (abyssFarmPayoffScore(state, seat, withNext[i]) <= 0) continue;
			indexMap.push(i);
			payoffActions.push(withNext[i]);
		}
		if (payoffActions.length === 0) return mainDecision;

		const overlayDecision = chooseFullActionDecision(
			arbitrationPolicy,
			state,
			seat,
			payoffActions,
			catalog,
			fullSelection,
			fullLookaheadDepth,
			fullLookaheadBeam,
			fullLookaheadRootBeam,
			fullTargetTemperature,
			opts.sampleMoves ?? false,
			opts.temperature ?? 1,
			moveRng
		);
		const overlayIdx = indexMap[overlayDecision.idx] ?? mainDecision.idx;
		const overlayPayoff = abyssFarmPayoffScore(state, seat, withNext[overlayIdx]);
		const mainPayoff = abyssFarmPayoffScore(state, seat, withNext[mainDecision.idx]);
		if (overlayPayoff <= 0 || overlayPayoff < mainPayoff) return mainDecision;

		return {
			idx: overlayIdx,
			pi: withNext.map((_, i) => {
				const local = indexMap.indexOf(i);
				return local >= 0 ? (overlayDecision.pi[local] ?? 0) : 0;
			})
			};
		};

	let state = createLobbyState({ roomCode: 'AZSP', guardianNames });
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	const profileBySeat: Record<string, BotProfile> = {};
	const expectOk = (r: ReturnType<typeof applyGameCommand>): void => {
		if (!r.ok) throw new Error(`setup: ${r.error.code} ${r.error.message}`);
		state = r.state;
	};
	seats.forEach((seat, i) => {
		profileBySeat[seat] = profiles[i] ?? profileFor('medium');
		const memberId = `bot-${seat}`;
		expectOk(applyGameCommand(state, { memberId, displayName: seat, role: 'player', seatColor: null }, { type: 'claimSeat', seatColor: seat }, catalog));
		expectOk(applyGameCommand(state, { memberId, displayName: seat, role: 'player', seatColor: seat }, { type: 'selectGuardian', guardianName: guardianNames[i] }, catalog));
	});
	expectOk(applyGameCommand(state, host, { type: 'startGame', seed: opts.seed }, catalog));

	// Per-planner-seat behavior counters — diagnose monster-FARMING: how many rounds it navigates to
	// the Abyss, how many monster combats it starts, and how many kills land. Under-farming shows up
	// here (few combats/kills) vs the optimal "fight every round" line. The recorder owns every
	// sample/stat/trace accumulator; navigation-gate memory (fallenHuntMemory) stays in this loop.
	const {
		samples,
		pstat,
		decisionTypes,
		decisionTypesBySeat,
		plannerTrace,
		recordResolvedPvpCombats,
		recordBuildSnapshot,
		recordAllPlannerStatus,
		recordFarmNavigation,
		recordLocationInteraction,
		recordCombatOpportunity,
		recordPvpOpportunity,
		countDecision,
		recordTrace,
		navigationTraceContext,
		recordForcedNavigationSample
	} = createSelfPlayRecorder({
		catalog,
		getState: () => state,
		plannerSeats,
		recordSeats,
		maxStatusLevelForSeat,
		farmNavigationThreshold,
		routeModeThreshold,
		tracePlannerActions: opts.tracePlannerActions ?? false
	});
		const updateFallenHuntMemoryBeforeNavigation = (seat: SeatColor): void => {
			const mem = fallenHuntMemory[seat] ?? {
				lastPvpVp: 0,
				dryStreak: 0,
				lastChoiceRound: -1,
				lastCheckedRound: -1
			};
			fallenHuntMemory[seat] = mem;
			const player = state.players[seat];
			if (!player || (player.statusLevel ?? 0) < 3) {
				mem.lastDestination = undefined;
				mem.lastPvpVp = pstat[seat]?.pvpVp ?? 0;
				mem.dryStreak = 0;
				mem.lastCheckedRound = state.round;
				return;
			}
			if (mem.lastChoiceRound >= 0 && mem.lastChoiceRound < state.round && mem.lastCheckedRound !== state.round) {
				const pvpVp = pstat[seat]?.pvpVp ?? 0;
				if (mem.lastDestination && mem.lastDestination !== 'Arcane Abyss' && pvpVp <= mem.lastPvpVp) {
					mem.dryStreak += 1;
				} else {
					mem.dryStreak = 0;
				}
				mem.lastPvpVp = pvpVp;
				mem.lastCheckedRound = state.round;
			}
		};
		const noteNavigationChoice = (seat: SeatColor, destination: NavigationDestination): void => {
			const mem = fallenHuntMemory[seat] ?? {
				lastPvpVp: 0,
				dryStreak: 0,
				lastChoiceRound: -1,
				lastCheckedRound: -1
			};
			fallenHuntMemory[seat] = mem;
			if ((state.players[seat]?.statusLevel ?? 0) < 3 || destination === 'Arcane Abyss') {
				mem.dryStreak = 0;
			}
			mem.lastDestination = destination;
			mem.lastPvpVp = pstat[seat]?.pvpVp ?? 0;
			mem.lastChoiceRound = state.round;
			mem.lastCheckedRound = state.round;
		};
	for (const s of plannerSeats) recordBuildSnapshot(s);
	const fullActionCounter = new Map<string, number>();
	let ticks = 0;
	while (state.status === 'active' && state.round <= maxRounds) {
		if (++ticks > MAX_TICKS) break;
		let progressed = false;
		for (const seat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, seat)) continue;

				// Planner steers the navigation decision for planner seats; record the search target.
				if (plannerSeats.has(seat) && state.phase === 'navigation') {
					const farmNav = cleanFarmableFlags(state, seat, catalog, farmNavigationThreshold);
					updateFallenHuntMemoryBeforeNavigation(seat);
					// Diagnostic override: force a fixed destination (e.g. Arcane Abyss) when legal.
					if (opts.forceDest) {
						const legal = legalDestinations(state, seat, catalog);
						if (legal.includes(opts.forceDest as (typeof legal)[number])) {
							const cmd: GameCommand = { type: 'lockNavigation', destination: opts.forceDest as (typeof legal)[number] };
							if (opts.forceDest === 'Arcane Abyss') pstat[seat].abyss++;
							noteNavigationChoice(seat, cmd.destination);
							recordFarmNavigation(seat, farmNav, cmd.destination);
							recordTrace(seat, 'force', cmd, {
								farmable: farmNav.farmable,
							farmOpportunityVp: +farmNav.farmOpportunityVp.toFixed(2),
							usedNavigationPrior: false
						});
						const r = applyGameCommand(state, botActorFor(state, seat), cmd, catalog, { mutate: true });
						if (r.ok) {
							state = r.state;
							progressed = true;
							recordResolvedPvpCombats();
							recordAllPlannerStatus({ kind: 'command', actorSeat: seat, cmdType: cmd.type });
						}
						if (state.status !== 'active') break;
						continue;
					}
				}
				if (opts.routeFinishOracle) {
					const oracleDestination = nearFinishNavigationOracleDestination(
						state,
						seat,
						catalog,
						farmNavigationThreshold,
						maxRounds
					);
					if (oracleDestination) {
							const cmd: GameCommand = { type: 'lockNavigation', destination: oracleDestination };
							pstat[seat].navigationPriorUses++;
							if (oracleDestination === 'Arcane Abyss') pstat[seat].abyss++;
							noteNavigationChoice(seat, cmd.destination);
							recordFarmNavigation(seat, farmNav, cmd.destination);
							recordTrace(seat, 'force', cmd, {
								farmable: farmNav.farmable,
							farmOpportunityVp: +farmNav.farmOpportunityVp.toFixed(2),
							usedNavigationPrior: true
						});
						const r = applyGameCommand(state, botActorFor(state, seat), cmd, catalog, { mutate: true });
						if (r.ok) {
							state = r.state;
							progressed = true;
							recordResolvedPvpCombats();
							recordAllPlannerStatus({ kind: 'command', actorSeat: seat, cmdType: cmd.type });
						}
						if (state.status !== 'active') break;
						continue;
					}
				}
				const activePvpPivotOracle = pvpPivotOracleForSeat(seat);
				if (activePvpPivotOracle !== 'off') {
					const predictive =
						activePvpPivotOracle === 'fallen-predictive-hunt' ||
						activePvpPivotOracle === 'late-descend-predictive-hunt';
					const oracleDestination =
						activePvpPivotOracle === 'status2-target-descend'
							? pvpStatus2TargetDescendOracleDestination(state, seat, catalog, farmNavigationThreshold)
							: activePvpPivotOracle === 'status2-conversion-descend'
								? pvpStatus2ConversionDescendOracleDestination(state, seat, catalog, farmNavigationThreshold)
							: activePvpPivotOracle === 'late-descend-hunt' || activePvpPivotOracle === 'late-descend-predictive-hunt'
								? pvpLateDescendOracleDestination(state, seat, catalog, farmNavigationThreshold, predictive)
								: pvpPivotOracleDestination(state, seat, catalog, farmNavigationThreshold, predictive);
						if (oracleDestination) {
							const cmd: GameCommand = { type: 'lockNavigation', destination: oracleDestination };
							pstat[seat].navigationPriorUses++;
							pstat[seat].pvpPivotOracleUses++;
							noteNavigationChoice(seat, cmd.destination);
							recordFarmNavigation(seat, farmNav, cmd.destination);
							recordForcedNavigationSample(seat, oracleDestination);
							recordTrace(seat, 'force', cmd, {
							farmable: farmNav.farmable,
							farmOpportunityVp: +farmNav.farmOpportunityVp.toFixed(2),
							usedNavigationPrior: true
						});
						const r = applyGameCommand(state, botActorFor(state, seat), cmd, catalog, { mutate: true });
						if (r.ok) {
							state = r.state;
							progressed = true;
							recordResolvedPvpCombats();
							recordAllPlannerStatus({ kind: 'command', actorSeat: seat, cmdType: cmd.type });
						}
						if (state.status !== 'active') break;
						continue;
					}
				}
				const navSelection = navigationSelectionForSeat(state, seat);
				const priorPolicy = navSelection.policy;
				if (priorPolicy !== policyForSeat(seat)) pstat[seat].navigationPriorUses++;
				const res = neuralPlanNavigation(state, seat, catalog, policyForSeat(seat), {
					...opts.planner,
					priorPolicy,
					rootDestinations: navSelection.rootDestinations,
					seed: (opts.seed * 31 + state.round * 7 + 1) >>> 0
				});
					if (res) {
						const obs = encodeObs(state, seat);
						const cands = res.destinations.map((d) =>
							encodeAction(state, seat, { type: 'lockNavigation', destination: d }, undefined, catalog)
						);
					let idx = chooseIndex(res.visits, opts.sampleMoves ?? false, opts.temperature ?? 1, moveRng);
					let pi = res.pi;
					const abyssIndex = res.destinations.indexOf('Arcane Abyss' as (typeof res.destinations)[number]);
					if (farmNavigationOracle === 'force' && farmNav.farmable && abyssIndex >= 0) {
						idx = abyssIndex;
						pi = oneHot(res.destinations.length, abyssIndex);
					}
					opts.navigationProbe?.({
						state,
						seat,
						catalog,
						destinations: [...res.destinations],
						visits: [...res.visits],
						pi: [...pi],
						chosenIndex: idx,
						farmable: farmNav.farmable,
						bossFarmable: farmNav.bossFarmable,
						farmOpportunityVp: farmNav.farmOpportunityVp,
						usedNavigationPrior: priorPolicy !== policyForSeat(seat),
						farmPriorApplied: res.farmPriorApplied,
						farmPriorScore: res.farmPriorScore,
						farmPriorBonus: res.farmPriorBonus
					});
						const cmd: GameCommand = { type: 'lockNavigation', destination: res.destinations[idx] };
					if ((cmd as { destination?: string }).destination === 'Arcane Abyss') pstat[seat].abyss++;
					if (res.farmPriorApplied) {
						pstat[seat].farmPriorApplications++;
						pstat[seat].farmPriorScoreSum += res.farmPriorScore;
						pstat[seat].farmPriorBonusSum += res.farmPriorBonus;
						pstat[seat].farmPriorMaxScore = Math.max(pstat[seat].farmPriorMaxScore, res.farmPriorScore);
						if (cmd.destination === 'Arcane Abyss') pstat[seat].farmPriorAbyssChoices++;
					}
					noteNavigationChoice(seat, cmd.destination);
					recordFarmNavigation(seat, farmNav, cmd.destination);
					recordTrace(seat, 'navigation', cmd, {
						farmable: farmNav.farmable,
						farmOpportunityVp: +farmNav.farmOpportunityVp.toFixed(2),
						usedNavigationPrior: priorPolicy !== policyForSeat(seat),
						...navigationTraceContext(
							seat,
							priorPolicy,
							navSelection.activeGate,
							navSelection.rootDestinations
						),
						farmPriorApplied: res.farmPriorApplied,
						farmPriorScore: +res.farmPriorScore.toFixed(3),
						farmPriorBonus: +res.farmPriorBonus.toFixed(3)
					});
					if (recordSeats.has(seat)) {
						samples.push({
							obs,
							cands,
							chosen: idx,
							pi,
							ret: 0,
							seat,
							vp: state.players[seat]?.victoryPoints ?? 0,
							phi: 0,
							kill: 0,
							...sampleAuxTargets(state, seat, catalog)
						});
						countDecision(seat, cmd);
					}
					const r = applyGameCommand(state, botActorFor(state, seat), cmd, catalog, { mutate: true });
					if (r.ok) {
						state = r.state;
						progressed = true;
						recordResolvedPvpCombats();
						recordAllPlannerStatus({ kind: 'command', actorSeat: seat, cmdType: cmd.type });
					}
					if (state.status !== 'active') break;
					continue;
				}
			}

			if (plannerSeats.has(seat) && control === 'full') {
				const key = `${seat}:${state.round}:${state.phase}`;
				const used = fullActionCounter.get(key) ?? 0;
				if (used < MAX_FULL_ACTIONS_PER_PHASE) {
					const unfilteredWithNext = legalActionsWithNext(state, seat, catalog);
					const combatOpportunity = recordCombatOpportunity(seat, unfilteredWithNext);
					const pvpOpportunity = recordPvpOpportunity(seat, unfilteredWithNext);
					const withNext = filterPlannerActions(
						state,
						catalog,
						unfilteredWithNext,
						seat,
						forbidTypesForSeat(seat),
						maxStatusLevelForSeat(seat),
						opts.hardConstraints,
						preserveRouteFirepowerForSeat(seat),
						preserveRouteSurvivalForSeat(seat),
						farmNavigationThreshold,
						abyssRouteDisciplineForSeat(seat),
						goodTargetActionDisciplineForSeat(seat)
					);
					if (withNext.length > 0) {
						const decision = chooseArbitratedFullActionDecision(state, seat, withNext);
						const idx = decision.idx;
						const chosen = withNext[idx];
						opts.fullActionProbe?.({
							state,
							seat,
							catalog,
							withNext,
							chosenIndex: idx,
							pi: decision.pi,
							decisionType: chosen.cmd.type
						});
						if (withNext.length > 1 && recordSeats.has(seat)) {
							const obs = encodeObs(state, seat);
							samples.push({
								obs,
								cands: withNext.map((x) => encodeAction(state, seat, x.cmd, x.next, catalog)),
								chosen: idx,
								pi: decision.pi,
								ret: 0,
								seat,
								vp: state.players[seat]?.victoryPoints ?? 0,
								phi: 0,
								kill: chosen.cmd.type === 'resolveMonsterReward' ? 1 : 0,
								...sampleAuxTargets(state, seat, catalog, withNext)
							});
							countDecision(seat, chosen.cmd);
						}
						if (chosen.cmd.type === 'startCombat') {
							pstat[seat].combat++;
							const mc = chosen.next.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === seat);
							if (mc?.killed) pstat[seat].kills++;
						} else if (chosen.cmd.type === 'initiatePvp') {
							pstat[seat].pvpAttacks++;
							if (pvpOpportunity.hardMonsterWindow) {
								pstat[seat].pvpHardMonsterAttacks++;
								pstat[seat].pvpHardMonsterVp += 3;
							}
							if (pvpOpportunity.goodTargetPivotWindow) {
								pstat[seat].pvpGoodTargetPivotAttacks++;
								pstat[seat].pvpGoodTargetPivotVp += 3;
							}
						} else if (pvpOpportunity.legal) {
							pstat[seat].missedPvpOpportunities++;
							if (pvpOpportunity.hardMonsterWindow) pstat[seat].missedPvpHardMonsterOpportunities++;
							if (pvpOpportunity.goodTargetPivotWindow) pstat[seat].missedPvpGoodTargetPivotOpportunities++;
						} else if (combatOpportunity.legalCombat) {
							if (combatOpportunity.clean) pstat[seat].missedCleanCombatOpportunities++;
							if (combatOpportunity.firepower) pstat[seat].missedFirepowerCombatOpportunities++;
						}
							recordLocationInteraction(seat, chosen.cmd);
							recordTrace(seat, 'full', chosen.cmd, {
								pvpOpportunity: pvpOpportunity.legal,
								pvpTargetCount: pvpOpportunity.targetCount,
								pvpTargetVp: pvpOpportunity.targetVp,
								pvpBestTargetVp: pvpOpportunity.bestTargetVp,
								pvpTargets: pvpOpportunity.targets,
								pvpHardMonsterWindow: pvpOpportunity.hardMonsterWindow,
								pvpGoodTargetPivotWindow: pvpOpportunity.goodTargetPivotWindow,
								combatOpportunity: combatOpportunity.legalCombat,
								cleanCombatOpportunity: combatOpportunity.clean,
								firepowerCombatOpportunity: combatOpportunity.firepower
							});
						state = chosen.next;
						recordResolvedPvpCombats();
						recordAllPlannerStatus({ kind: 'command', actorSeat: seat, cmdType: chosen.cmd.type });
						fullActionCounter.set(key, used + 1);
						progressed = true;
						if (state.status !== 'active') break;
						continue;
					}
				}
			}

			// Everything else: heuristic execution (within-round + non-planner seats).
			const trackSeat = plannerSeats.has(seat);
			const plan = trackSeat
				? filterConstrainedPlan(
					state,
					seat,
					catalog,
					planBotPhaseActions(state, seat, catalog, heurRng, profileBySeat[seat]),
					forbidTypesForSeat(seat),
					maxStatusLevelForSeat(seat)
				)
			: planBotPhaseActions(state, seat, catalog, heurRng, profileBySeat[seat]);
			for (const c of plan) {
				if (trackSeat) recordLocationInteraction(seat, c);
				if (trackSeat) recordTrace(seat, 'heuristic', c);
				const heuristicPvpOpportunity =
					trackSeat && c.type === 'initiatePvp'
						? pvpEncounterTargets(state, seat, true)
						: null;
				const r = applyGameCommand(state, botActorFor(state, seat), c, catalog, { mutate: true });
				if (!r.ok) break;
				state = r.state;
				progressed = true;
				recordResolvedPvpCombats();
				recordAllPlannerStatus({ kind: 'command', actorSeat: seat, cmdType: c.type });
				if (trackSeat && c.type === 'startCombat') {
					pstat[seat].combat++;
					const mc = state.combats.find((x) => x.kind === 'monster' && x.sides[0]?.seat === seat);
					if (mc?.killed) pstat[seat].kills++;
				} else if (trackSeat && c.type === 'initiatePvp') {
					pstat[seat].pvpAttacks++;
					if (heuristicPvpOpportunity?.hardMonsterWindow) {
						pstat[seat].pvpHardMonsterAttacks++;
						pstat[seat].pvpHardMonsterVp += 3;
					}
					if (heuristicPvpOpportunity?.goodTargetPivotWindow) {
						pstat[seat].pvpGoodTargetPivotAttacks++;
						pstat[seat].pvpGoodTargetPivotVp += 3;
					}
				}
				if (state.status !== 'active') break;
			}
			if (state.status !== 'active') break;
		}
		if (state.status !== 'active') break;
		if (!progressed) {
			const sig = `${state.phase}:${state.round}`;
			applyDeadlineAdvance(state, catalog);
			recordResolvedPvpCombats();
			recordAllPlannerStatus({ kind: 'deadline', cmdType: 'deadline' });
			if (`${state.phase}:${state.round}` === sig) break; // stalled
		}
	}

	// Label every recorded decision with its seat's game OUTCOME (the value target).
	const finalVP: Record<string, number> = {};
	for (const seat of seats) finalVP[seat] = state.players[seat]?.victoryPoints ?? 0;
	const outcomeBySeat: Record<string, number> = {};
	for (const seat of seats) outcomeBySeat[seat] = outcomeFor(state, seat);
	for (const s of samples) s.ret = outcomeBySeat[s.seat] ?? 0;

	return {
		samples,
		finalVP,
		winnerSeat: state.winnerSeat ?? null,
		rounds: state.round,
		finished: state.status === 'finished',
		finalState: state,
		plannerStats: pstat,
		decisionTypes,
		decisionTypesBySeat,
		plannerTrace
	};
}
