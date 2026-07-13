/**
 * Recording self-play driver for the ML pipeline.
 *
 * One function plays a full game (lobby → finished/capped) and emits training samples.
 * Seats are driven either by the existing heuristic (`planBotPhaseActions`) or by a
 * NeuralPolicy choosing among `legalActions`. Every meaningful decision (a covered
 * candidate set with >1 option) is recorded as {obs, cands, chosen}; terminal
 * placement returns are stamped on afterward.
 *
 *   - Heuristic seats  → BC data: we record which legal candidate the heuristic's plan
 *     matched. This is the cold-start dataset (imitate the winners of heuristic games).
 *   - Neural seats     → on-policy data: we record what the net chose (optionally sampled
 *     for exploration). This is the AWR/iteration dataset.
 *
 * Mirrors sim/selfPlay.ts for setup + the no-progress deadline-advance, so it stays
 * faithful to how real games actually run.
 */

import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../runtime';
import { allPlayersFallen } from '../phases';
import { createRng, hashString, nextInt, type RngState } from '../rng';
import {
	botActorFor,
	botSeatNeedsToAct,
	planBotPhaseActions,
	MEDIUM_DEFAULTS,
	type BotProfile,
	type BotRandom
} from '../server/botPolicy';
import {
	VP_TO_WIN,
	MAX_ROUNDS,
	SEAT_COLORS,
	type GameActor,
	type GameCommand,
	type PlayCatalog,
	type PublicGameState,
	type SeatColor
} from '../types';
import { encodeAction, encodeObs } from './encode';
import { encodeEntityObsV2, flattenObsV2 } from './encodeV2';
import {
	legalActionsWithNext,
	commandMatches,
	policyPreviewState,
	type LegalAction
} from './actions';
import { sampleAuxTargets } from './auxTargets';
import {
	valueGuidedIndex,
	hybridIndex,
	isProgressTransition,
	progressSignature,
	policyIndexWithProgressGuard,
	selectableCandidateIndices
} from './neuralBot';
import {
	buildPotential,
	potentialShapingDelta,
	vpOf,
	vpReturnsToGo,
	BALANCED_SHAPING,
	type PotentialShapingMode,
	type ShapingWeights
} from './shaping';
import type { NeuralPolicy } from './net';
import type { SeatCycleSummary, StrategicDecisionScope } from './poolTypes';

/** One recorded decision. `vp`/`phi` (VP and build-potential at decision time) are used to
 *  compute `ret` (VP-maximizing return-to-go) once the game's VP trajectory is known. */
export interface Sample {
	obs: number[];
	/** Paired v2 observation (arc-obs-v2 flat array), present when recorded at obsVersion 2.
	 *  `obs` stays the current v1 199-float vector on EVERY row — the pinned paired-row contract
	 *  (docs/encoder-v2.md): v1 consumers read obs, v2 trainers read obsV2, and
	 *  distillation reads both views of the same decision. */
	obsV2?: number[];
	cands: number[][];
	chosen: number;
	ret: number;
	seat: SeatColor;
	vp: number;
	phi: number;
	kill: number; // 1 if this decision claims a monster-kill reward (drives the optional monster-kill bonus)
	/** Auxiliary target for a state-level farm-value head. Optional for backwards-compatible data. */
	farmValue?: number;
	/** Auxiliary soft target over candidates for monster reward-pick decisions. */
	rewardPi?: number[];
	/** AlphaZero policy target: the MCTS visit distribution over `cands` (search-improved). Present
	 *  only for planner/search decisions; absent for plain heuristic/neural-greedy records. */
	pi?: number[];
	/** Optional multiplier for policy loss. Use 0 for value-only regression/failure rows. */
	policyWeight?: number;
	/** Optional state-level route-mode target for Fallen PvP navigation. 1=hunt Good player, 0=return Abyss. */
	routeMode?: number;
	/** Optional curriculum/source label used by lane scripts to filter narrow training slices. */
	teacherKind?: string;
	/** Training metadata only: 1 for a late-state continuation suffix row. Never encoded into obs. */
	continuationCurriculum?: number;
	/**
	 * PPO trajectory fields (consumed by ml/ppo.py via train.py --mode ppo). The episode key
	 * is per (game, seat) — ml/ppo.py groups rows by gameId alone, so two seats sharing one
	 * id would interleave into a single bogus episode. Every policy-backed row carries vPred
	 * and an explicit policyMask. Deterministic hybrid/search/custom/greedy rows use mask 0:
	 * they stay in the complete episode for rewards, GAE, value, and auxiliary losses, but
	 * never enter the PPO policy-ratio surrogate. Only an exact sampled-policy row uses mask 1.
	 */
	gameId?: string;
	stepIdx?: number;
	/** Per-step shaping reward (default 0; see RecordGameOptions.stepRewards). */
	rStep?: number;
	/** True on the seat's last decision of a FINISHED game. Capped/stalled games leave the
	 *  episode truncated, so the PPO trainer bootstraps GAE from the last vPred. */
	done?: boolean;
	/** 1 on the terminal row of a TRUE 30-VP win (not cap/all-Fallen wins). */
	won?: number;
	/** 1 on the terminal row of EVERY seat when the game ended via the all-Fallen collapse (no seat
	 *  reached 30). The PPO trainer's --all-fallen-loss stamps a terminal LOSS on these rows for all
	 *  seats, so the degenerate mutual-corruption ending pays nothing to anyone (ladder8-C lever). */
	allFallen?: number;
	/** The game's final round number, stamped on done rows alongside `won`. Training-data-only
	 *  (tempo signal): the PPO trainer's --win-bonus-halflife decays the win bonus by how late the
	 *  win landed, so a round-18 30-VP finish is rewarded more than a round-28 one. */
	endRound?: number;
	/** Behavior log-prob of the chosen candidate under the exact sampled distribution. */
	logpOld?: number;
	/** Effective softmax temperature used by the sampled acting policy. */
	behaviorTemperature?: number;
	/** 1 for candidates in the sampled policy's support, 0 for progress-filtered candidates. */
	behaviorMask?: number[];
	/** 1 only when logpOld is the exact stochastic learned-policy behavior probability. */
	policyMask?: number;
	/** Value-head output at decision time. Present on every policy-backed trajectory row. */
	vPred?: number;
	/** Behavior checkpoint's 4-way final-placement probabilities. This is a separate
	 * state-only baseline for pure strategic outcome credit; absent on old/v2 checkpoints. */
	placementProbs?: number[];
	/** Frozen behavior checkpoint's P(reach 30 VP by the solo round cap), before this action. */
	reach30Pred?: number;
	/** Final solo objective label, present only on the last row when the outcome is resolved. */
	reach30Target?: number;
	/** Configured round limit for reach30Target; paired with it to prevent horizon mixing. */
	reach30Horizon?: number;
	/** Final placement 1..seats (ties share the better place), on rows of finished games. */
	placement?: number;
	/** Public round at decision time, retained for held-out calibration slices. */
	round?: number;
	/** Chosen command type, persisted for strategy-cycle diagnostics and training masks. */
	decisionType?: GameCommand['type'];
	/** 1 when this row commits a round-level route, engine, combat, conversion, or yield choice.
	 * PPO may blend these rows toward full-episode Monte Carlo credit; omitted/0 stays tactical. */
	strategic?: number;
	/** Number of seats configured for this episode. Lets PPO apply solo objectives without
	 * treating the automatic solo placement (always first) as a competitive win. */
	playerCount?: number;
	/** Persistent high-level option conditioning this policy decision. Present on every
	 * option-aware low-level row and absent from bit-compatible legacy data. */
	optionId?: number;
}

/** One high-level round-option behavior event. These are written to a separate options-*.jsonl
 * stream so option PPO cannot accidentally count the same choice once per low-level action. */
export interface RoundOptionEvent {
	eventId: string;
	gameId: string;
	seat: SeatColor;
	round: number;
	obs: number[];
	optionId: number;
	behaviorMask: number[];
	logpOld: number;
	optionVPred: number;
	playerCount: number;
	/** Exact number of serialized low-level policy rows governed by this option. Zero is
	 * legitimate for a round whose only policy decision was forced and therefore unrecorded. */
	lowLevelDecisionCount: number;
}

/** Decisions whose consequences commonly span several phases or rounds. This is a credit-assignment
 * mask, not a strategy oracle: it does not say which action is good and never changes legality. */
const NAVIGATION_STRATEGIC_TYPES = new Set<GameCommand['type']>([
	'lockNavigation',
	'selectNavigationDestination'
]);
const ENGINE_CYCLE_STRATEGIC_TYPES = new Set<GameCommand['type']>([
	...NAVIGATION_STRATEGIC_TYPES,
	'resolveLocationInteraction',
	'spawnHandSpirit',
	'absorbSpirit',
	'startCombat',
	'resolveMonsterReward',
	'initiatePvp',
	'passEncounter',
	'awakenSpirit',
	'resolveDecision',
	'placeAugmentOnSpirit',
	'resolveAwakenReward',
	'discardSpirit',
	'discardRune',
	'discardUnplacedAugments'
]);

export function isStrategicCommand(
	cmd: GameCommand,
	scope: StrategicDecisionScope = 'navigation'
): boolean {
	return (scope === 'engine-cycle' ? ENGINE_CYCLE_STRATEGIC_TYPES : NAVIGATION_STRATEGIC_TYPES).has(
		cmd.type
	);
}

/** Classify the decision state, not only the chosen action. Stopping/yielding while an engine
 * action remains is itself a long-horizon choice and must receive the same credit as taking it. */
export function isStrategicDecision(
	candidates: readonly GameCommand[],
	scope: StrategicDecisionScope = 'navigation'
): boolean {
	return candidates.some((candidate) => isStrategicCommand(candidate, scope));
}

/**
 * Did this decision KILL the monster (or claim its reward)? The old flag fired only on
 * recorded `resolveMonsterReward` rows — but a forced claim (single legal candidate) is
 * never recorded, so those kills were invisible (the "zero kills" misread, 2026-07-02).
 * A kill is detected structurally: the seat's pendingReward APPEARS in the next state.
 */
function decisionKills(
	prev: PublicGameState,
	next: PublicGameState,
	seat: SeatColor,
	cmd: GameCommand
): boolean {
	if (cmd.type === 'resolveMonsterReward') return true;
	return !prev.players[seat]?.pendingReward && !!next.players[seat]?.pendingReward;
}

export interface RecordGameOptions {
	seed: number;
	/** One profile per seat; seat count = profiles.length. Used for heuristic seats and as
	 *  the unstick fallback for neural seats. */
	profiles: BotProfile[];
	maxRounds?: number;
	/** Optional stable episode-key prefix. The seat is appended by the driver. Continuation
	 * episodes MUST provide this so multiple suffixes from one source seed cannot collide. */
	episodeId?: string;
	/** Capture resumable solo states at the beginning of these navigation rounds. The supported
	 * late-state curriculum window is deliberately narrow (rounds 12..20). */
	captureContinuationRounds?: number[];
	/** Resume a previously captured clean-navigation state. Omitting pickRng restores the exact
	 * behavior stream; supplying a deterministic fork explores a new on-policy suffix. */
	continuation?: ContinuationStart;
	/** If set, these seats are driven by `policy`; the rest stay heuristic. Default: all
	 *  seats are neural when a policy is supplied, else all heuristic. */
	policy?: NeuralPolicy;
	neuralSeats?: SeatColor[];
	/** Sample from the softmax (exploration) instead of greedy argmax. */
	sample?: boolean;
	temperature?: number;
	/** How neural seats choose actions: 'hybrid' (default) = learned policy for positioning +
	 *  always grab immediate VP; 'policy' = imitation head only; 'value' = 1-ply value-lookahead. */
	selection?: 'hybrid' | 'value' | 'policy';
	/** Opt-in V24 hybrid mode: policy-select ambiguous monster rewards except immediate wins. */
	learnMonsterRewardChoices?: boolean;
	/** Which seats to record decisions for. Default: neural seats (or all, heuristic mode). */
	recordSeats?: SeatColor[];
	/**
	 * Custom decision function. When supplied, the "neural" seats are driven by this instead of
	 * `policy.pick` — given the legal candidates, return the index to take. Lets you drop in a
	 * hand-written or alternative bot without changing the engine.
	 */
	chooser?: (
		obs: number[],
		candFeatures: number[][],
		cands: GameCommand[],
		seat: SeatColor,
		state: PublicGameState,
		withNext: LegalAction[]
	) => number;
	/**
	 * Expert-iteration search hook (learner seats only). Called before the
	 * selection modes; a non-null result plays `index` AND records `pi` (the
	 * search-improved distribution over the candidate set) into the sample row —
	 * the policy target train.py --mode alphazero consumes. Return null to fall
	 * through to the configured selection (playout-cap randomization: search a
	 * fraction of decisions, record pi only for those).
	 */
	searcher?: (
		state: PublicGameState,
		seat: SeatColor,
		withNext: LegalAction[]
	) => { index: number; pi: number[] } | null;
	/**
	 * League play: per-seat opponent policies. A seat listed here is driven by ITS OWN policy
	 * (a sampled past checkpoint / exploiter), instead of `opts.policy` or a heuristic — so the
	 * learner trains against a diverse, strong, self-generated field rather than one weak bot.
	 * Opponent seats play greedily by default (no recording); `opponentTemperature` > 0 makes
	 * them SAMPLE instead. The learner seat(s) still use `opts.policy` + `recordSeats`.
	 */
	opponentPolicies?: Partial<Record<SeatColor, NeuralPolicy>>;
	/** Sampling temperature for opponentPolicies seats. Default 0 = greedy (argmax) — the
	 *  historical behavior, kept for bit-parity. > 0 makes opponents sample at this temperature,
	 *  which is what breaks the argmax-clone-collision artifact when several opponent seats share
	 *  one checkpoint (mirror/self-play/exploiter fields): greedy clones make identical moves and
	 *  self-sabotage, so a measurement against them is not a real strength/exploitability test. */
	opponentTemperature?: number;
	/** Reward-shaping weights for the progress potential Φ (default BALANCED). Drives the
	 *  per-decision return-to-go; vary across a population for diverse playstyles. */
	shaping?: ShapingWeights;
	/**
	 * Historical shaping retains final engine value. `policy-invariant` instead uses
	 * gamma*Phi(next)-Phi(current) with Phi(terminal)=0, so engine resources help only
	 * when converted into the real VP/placement objective.
	 */
	potentialShapingMode?: PotentialShapingMode;
	/** Long-horizon credit mask. Navigation-only preserves the completed v16 ablations. */
	strategicDecisionScope?: StrategicDecisionScope;
	/** Discount for return-to-go (default 0.99). */
	gamma?: number;
	/**
	 * Which guardians (by name) sit in each seat. Default = the first N catalog guardians in
	 * fixed order — which means every game has the SAME starting identities. Pass a per-game
	 * shuffle/permutation here to expose the bots to a VARIETY of starting spirits/origins
	 * ("a variety of spots"); unknown names are dropped and back-filled from the catalog.
	 */
	guardianNames?: string[];
	/**
	 * Command types whose candidate actions are REMOVED from the legal set for neural seats —
	 * a hard behavioral constraint. E.g. forbidding the corruption interaction forces a
	 * guaranteed never-corrupt (Good) line, the cleanest test of whether a non-corrupt line wins.
	 */
	forbidTypes?: Set<GameCommand['type']>;
	/**
	 * Maximum allowed status level after a candidate action. Used for Pure-only curriculum/eval
	 * lanes; if every neural action violates the cap, the unfiltered candidate set is retained so
	 * a bad state cannot softlock.
	 */
	maxStatusLevel?: number;
	/**
	 * Per-step PPO shaping rewards (Sample.rStep): given one seat's recorded decisions in play
	 * order, return a reward per decision. Default: all 0 — the terminal placement reward is
	 * added trainer-side (ml/ppo.py), so sparse works. This is the hook where potential-based
	 * shaping (e.g. ΔΦ from shaping.ts) plugs in later without touching the recording path.
	 */
	stepRewards?: (
		seatSamples: Sample[],
		seat: SeatColor,
		finalVP: Record<string, number>
	) => number[];
	/**
	 * Dense PPO reward (Phase 3): fills rStep with ΔVP/VP_TO_WIN + build-potential
	 * shaping per recorded decision. Select `potentialShapingMode='policy-invariant'`
	 * for discounted γΦ(next)−Φ(current) with zero terminal potential. Without this (or a
	 * stepRewards callback) rStep is 0 and PPO trains on placement alone — which
	 * teaches "out-place the field", never "reach 30". See plan happy-quail W1.
	 */
	denseVpReward?: boolean;
	/**
	 * Observation schema recorded on samples (default 1). At 2, every recorded Sample
	 * ADDITIONALLY carries obsV2 = flattenObsV2 (3,419 floats for the frozen catalog);
	 * Sample.obs remains the current v1 199-float vector on every row and Sample.cands stay v1
	 * encodeAction rows — the pinned paired-row contract (docs/encoder-v2.md), which is
	 * exactly what v1<-v2 distillation needs (both views of the same decision). The
	 * ACTING policy runs on v1 obs regardless: selection, logpOld and vPred come from
	 * the v1 in-process net (there is no TS v2 net), so obsV2 is behavior-off-policy
	 * input — fine for BC / off-policy warm start of the Python v2 model.
	 */
	obsVersion?: 1 | 2;
	/**
	 * Observation schema fed to the ACTING policy at decision time (default 1). At 2 the
	 * learner policy receives flattenObsV2 (3,419f) instead of v1 encodeObs, so logpOld/
	 * vPred become the v2 net's — league-v2 PPO data turns truly on-policy. Requires a
	 * v2-capable policy (a RemotePolicy over an infer socket serving arc-entity-scorer-v2);
	 * the in-process TS NeuralPolicy is v1-only and rejected. Selection must be 'hybrid'
	 * or 'policy' — 'value' does 1-ply lookahead on per-candidate NEXT-state observations,
	 * which the root-obs substitution cannot express. Opponent seats and the heuristic
	 * unstick path stay v1. Candidates and Sample.obs stay on the current append-only v1 contracts;
	 * at obsVersion 2 the flat array is computed once per decision and shared with obsV2.
	 */
	policyObsVersion?: 1 | 2;
}

export interface RecordGameResult {
	winnerSeat: SeatColor | null;
	finished: boolean;
	rounds: number;
	stalled: boolean;
	finalVP: Record<string, number>;
	samples: Sample[];
	/** Exactly one event per option-aware recorded seat/round that needed a policy action. */
	optionEvents: RoundOptionEvent[];
	/** Per-seat build-convert-finish diagnostics. Evaluation-only; never used as reward. */
	cycleBySeat: Record<string, SeatCycleSummary>;
	/** The terminal game state (for diagnostics/strategy tracing — final builds, status, etc.). */
	finalState?: PublicGameState;
	/** Clean navigation-boundary states requested by captureContinuationRounds. */
	continuationSnapshots: ContinuationSnapshot[];
}

/** Versioned, JSON-safe continuation state. `state.rng` is the environment cursor; the other
 * two cursors live outside PublicGameState in the recording driver. */
export interface ContinuationSnapshot {
	version: 1;
	sourceSeed: number;
	round: number;
	horizon: number;
	state: PublicGameState;
	botRng: RngState;
	pickRng: RngState;
}

export interface ContinuationStart {
	snapshot: ContinuationSnapshot;
	/** Optional policy-sampling fork. Without it the original suffix replays exactly. */
	pickRng?: RngState;
}

export const MIN_CONTINUATION_ROUND = 12;
export const MAX_CONTINUATION_ROUND = 20;

const CYCLE_ROUNDS = [8, 12, 16, 20] as const;
const OPTIONAL_YIELD_TYPES = new Set<GameCommand['type']>([
	'endLocationActions',
	'commitBenefits',
	'commitAwakening',
	'commitCleanup',
	'passEncounter'
]);

function seededBotRandom(rng: RngState): BotRandom {
	return {
		int: (maxExclusive: number) => nextInt(rng, maxExclusive),
		chance: () => nextInt(rng, 2) === 0
	};
}

/** Random-access option draw keyed by public identity. It is independent across seats/rounds and
 * cannot consume or perturb the engine, heuristic, or low-level policy RNG streams. */
export function deterministicRoundOptionRandom(
	seed: number,
	seat: SeatColor,
	round: number
): number {
	return hashString(`arc-round-option-v1:${seed}:${seat}:${round}`) / 0x1_0000_0000;
}

function jsonClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function validRngState(value: unknown): value is RngState {
	if (!value || typeof value !== 'object') return false;
	const rng = value as Partial<RngState>;
	return (
		Number.isInteger(rng.seed) &&
		Number.isInteger(rng.cursor) &&
		(rng.seed as number) >= 0 &&
		(rng.seed as number) <= 0xffffffff &&
		(rng.cursor as number) >= 0 &&
		(rng.cursor as number) <= 0xffffffff
	);
}

/** A deterministic alternative policy-sampling stream for a continuation. Environment and
 * fallback RNG cursors stay at their captured values; only the learned-policy exploration fork
 * changes. The source snapshot is never mutated. */
export function forkContinuationPickRng(
	snapshot: ContinuationSnapshot,
	forkId: string | number
): RngState {
	const id = String(forkId);
	if (!id.trim()) throw new Error('driver: continuation forkId must be non-empty');
	return createRng(
		hashString(`arc-continuation-pick-v1:${snapshot.sourceSeed}:${snapshot.round}:${id}`)
	);
}

function assertLateRound(round: number, label: string): void {
	if (
		!Number.isInteger(round) ||
		round < MIN_CONTINUATION_ROUND ||
		round > MAX_CONTINUATION_ROUND
	) {
		throw new Error(
			`driver: ${label} must be an integer in rounds ${MIN_CONTINUATION_ROUND}..${MAX_CONTINUATION_ROUND}`
		);
	}
}

function validateContinuationSnapshot(
	snapshot: ContinuationSnapshot,
	seats: readonly SeatColor[],
	horizon: number
): void {
	if (snapshot.version !== 1) throw new Error('driver: unsupported continuation snapshot version');
	if (!Number.isSafeInteger(snapshot.sourceSeed)) {
		throw new Error('driver: continuation sourceSeed must be a safe integer');
	}
	assertLateRound(snapshot.round, 'continuation snapshot round');
	if (!Number.isInteger(snapshot.horizon) || snapshot.horizon < 1) {
		throw new Error('driver: continuation snapshot horizon must be a positive integer');
	}
	if (snapshot.horizon !== horizon) {
		throw new Error(
			`driver: continuation snapshot horizon ${snapshot.horizon} does not match effective rollout horizon ${horizon}`
		);
	}
	if (!validRngState(snapshot.botRng) || !validRngState(snapshot.pickRng)) {
		throw new Error('driver: continuation snapshot has an invalid external RNG cursor');
	}
	const state = snapshot.state;
	if (!state || !validRngState(state.rng)) {
		throw new Error('driver: continuation snapshot has an invalid environment RNG cursor');
	}
	if (
		!Array.isArray(state.activeSeats) ||
		!state.players ||
		typeof state.players !== 'object' ||
		!state.navigation ||
		typeof state.navigation !== 'object' ||
		!Array.isArray(state.combats) ||
		!state.locationOccupancy ||
		typeof state.locationOccupancy !== 'object'
	) {
		throw new Error('driver: continuation snapshot has a malformed game-state shape');
	}
	if (state.round !== snapshot.round) {
		throw new Error('driver: continuation snapshot round does not match state.round');
	}
	if (state.status !== 'active' || state.phase !== 'navigation' || state.winnerSeat !== null) {
		throw new Error('driver: continuation requires an active, winner-free navigation state');
	}
	if (seats.length !== 1 || state.activeSeats.length !== 1 || state.activeSeats[0] !== seats[0]) {
		throw new Error('driver: continuation currently requires exactly one matching active seat');
	}
	if (
		state.revealedDestinations ||
		state.combats.length > 0 ||
		Object.keys(state.locationOccupancy).length > 0 ||
		state.navigation[seats[0]]?.locked !== false
	) {
		throw new Error('driver: continuation snapshot is not at a clean navigation boundary');
	}
	const player = state.players[seats[0]];
	if (!player) throw new Error('driver: continuation snapshot is missing its active player');
	if (
		player.pendingDestination !== null ||
		player.navigationDestination !== null ||
		player.phaseReady ||
		player.pendingDraw !== null ||
		player.handDraws.length > 0 ||
		player.pendingDrawQueue.length > 0 ||
		player.pendingReward !== null ||
		player.pendingAwakenReward !== null ||
		!!player.pendingCorruptionDiscard ||
		(player.unplacedAugments?.length ?? 0) > 0 ||
		player.pendingDecisions.length > 0 ||
		player.manualPrompts.length > 0
	) {
		throw new Error('driver: continuation snapshot contains unresolved player work');
	}
}

/**
 * Automatic capture is opportunistic: navigation can be visible while a reward, draw, or
 * decision from the preceding work is still unresolved.  Such a state must not abort the source
 * game; keep advancing it and capture later in the same round once the true clean boundary is
 * reached.  Explicitly supplied snapshots are still validated strictly above and fail closed.
 */
export function isContinuationCaptureBoundary(
	state: PublicGameState,
	seats: readonly SeatColor[]
): boolean {
	if (
		state.status !== 'active' ||
		state.phase !== 'navigation' ||
		state.winnerSeat !== null ||
		seats.length !== 1 ||
		state.activeSeats.length !== 1 ||
		state.activeSeats[0] !== seats[0] ||
		state.revealedDestinations ||
		state.combats.length > 0 ||
		Object.keys(state.locationOccupancy).length > 0 ||
		state.navigation[seats[0]]?.locked !== false
	) {
		return false;
	}
	const player = state.players[seats[0]];
	return !!(
		player &&
		player.pendingDestination === null &&
		player.navigationDestination === null &&
		!player.phaseReady &&
		player.pendingDraw === null &&
		player.handDraws.length === 0 &&
		player.pendingDrawQueue.length === 0 &&
		player.pendingReward === null &&
		player.pendingAwakenReward === null &&
		!player.pendingCorruptionDiscard &&
		(player.unplacedAugments?.length ?? 0) === 0 &&
		player.pendingDecisions.length === 0 &&
		player.manualPrompts.length === 0
	);
}

function makeContinuationSnapshot(
	state: PublicGameState,
	botRng: RngState,
	pickRng: RngState,
	sourceSeed: number,
	horizon: number,
	seats: readonly SeatColor[]
): ContinuationSnapshot {
	const snapshot: ContinuationSnapshot = {
		version: 1,
		sourceSeed,
		round: state.round,
		horizon,
		state: jsonClone(state),
		botRng: { ...botRng },
		pickRng: { ...pickRng }
	};
	validateContinuationSnapshot(snapshot, seats, horizon);
	return snapshot;
}

/** Per (seat,round,phase) action cap so a mis-trained greedy net can't loop forever. */
const MAX_ACTIONS_PER_PHASE = 30;
const MAX_TICKS = 50_000;

/**
 * Command types that represent a genuine STRATEGIC choice worth recording as a training
 * decision. Recording calls `legalActions` (≈expensive — it dry-runs many candidates,
 * each deep-cloning state), so we only do it for these high-leverage commands, not for
 * the many mechanical/forced commands a heuristic plan also emits. The net thus learns
 * the decisions that matter; everything else stays heuristic-driven during cold start.
 */
const RECORDABLE_TYPES = new Set<GameCommand['type']>([
	'lockNavigation',
	'selectNavigationDestination',
	'resolveLocationInteraction',
	'spawnHandSpirit',
	'takeSpirit',
	'replaceSpirit',
	'absorbSpirit',
	'initiatePvp',
	'passEncounter',
	'startCombat',
	'resolveMonsterReward',
	'awakenSpirit',
	'resolveDecision',
	'placeAugmentOnSpirit',
	'resolveAwakenReward',
	'discardSpirit'
]);

export function filterConstrainedActions(
	withNext: LegalAction[],
	seat: SeatColor,
	forbidTypes?: Set<GameCommand['type']>,
	maxStatusLevel?: number
): LegalAction[] {
	if (!forbidTypes?.size && maxStatusLevel === undefined) return withNext;
	const filtered = withNext.filter((x) => {
		if (forbidTypes?.has(x.cmd.type)) return false;
		if (
			maxStatusLevel !== undefined &&
			(policyPreviewState(x).players[seat]?.statusLevel ?? 0) > maxStatusLevel
		) {
			return false;
		}
		return true;
	});
	return filtered.length > 0 ? filtered : withNext;
}

/**
 * neuralBot's selection helpers re-encode the v1 obs internally, so at policyObsVersion 2
 * the learner policy is wrapped to see this DECISION's flat v2 obs on every call instead.
 * All substituted methods are root-state ones — selection 'value' (whose 1-ply lookahead
 * calls value() on per-candidate next-state obs) is rejected before this shim is built.
 */
function withFixedObs(policy: NeuralPolicy, obs: number[]): NeuralPolicy {
	const p = policy as unknown as {
		scoreCandidates(o: number[], c: number[][]): number[];
		probs(o: number[], c: number[][], t?: number): number[];
		value(o: number[]): number;
		farmValue(o: number[]): number;
		routeMode(o: number[]): number | null;
		rewardPickScores(o: number[], c: number[][]): number[] | null;
		rewardPickProbs(o: number[], c: number[][], t?: number): number[] | null;
		pick(
			o: number[],
			c: number[][],
			po?: { sample?: boolean; temperature?: number; rand?: () => number }
		): number;
	};
	const shim = {
		scoreCandidates: (_o: number[], c: number[][]) => p.scoreCandidates(obs, c),
		probs: (_o: number[], c: number[][], t?: number) => p.probs(obs, c, t),
		value: (_o: number[]) => p.value(obs),
		farmValue: (_o: number[]) => p.farmValue(obs),
		routeMode: (_o: number[]) => p.routeMode(obs),
		rewardPickScores: (_o: number[], c: number[][]) => p.rewardPickScores(obs, c),
		rewardPickProbs: (_o: number[], c: number[][], t?: number) => p.rewardPickProbs(obs, c, t),
		pick: (
			_o: number[],
			c: number[][],
			po?: { sample?: boolean; temperature?: number; rand?: () => number }
		) => p.pick(obs, c, po)
	};
	return shim as unknown as NeuralPolicy;
}

/** Bind the persistent round option once so existing low-level selection helpers keep their
 * public API while every option-conditioned head sees the same one-hot vector. */
function withFixedOption(policy: NeuralPolicy, option: number[]): NeuralPolicy {
	return new Proxy(policy, {
		get(target, prop) {
			if (prop === 'scoreCandidates') {
				return (obs: number[], cands: number[][]): number[] =>
					target.scoreCandidates(obs, cands, option);
			}
			if (prop === 'probs') {
				return (obs: number[], cands: number[][], temperature?: number): number[] =>
					target.probs(obs, cands, temperature, option);
			}
			if (prop === 'pick') {
				return (
					obs: number[],
					cands: number[][],
					opts?: { sample?: boolean; temperature?: number; rand?: () => number }
				): number => target.pick(obs, cands, { ...opts, option });
			}
			if (prop === 'value') return (obs: number[]): number => target.value(obs, option);
			if (prop === 'farmValue') return (obs: number[]): number => target.farmValue(obs, option);
			if (prop === 'placementProbs') {
				return (obs: number[]): number[] | null => target.placementProbs(obs, option);
			}
			if (prop === 'reach30Probability') {
				return (obs: number[]): number | null => target.reach30Probability(obs, option);
			}
			if (prop === 'routeMode') {
				return (obs: number[]): number | null => target.routeMode(obs, option);
			}
			if (prop === 'rewardPickScores') {
				return (obs: number[], cands: number[][]): number[] | null =>
					target.rewardPickScores(obs, cands, option);
			}
			if (prop === 'rewardPickProbs') {
				return (obs: number[], cands: number[][], temperature?: number): number[] | null =>
					target.rewardPickProbs(obs, cands, temperature, option);
			}
			const value = Reflect.get(target, prop, target) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		}
	}) as NeuralPolicy;
}

interface PolicyPickTrace {
	chosen: number;
	candidateCount: number;
	sample: boolean;
	temperature?: number;
}

/** The learner is float32. Quantize before acting so the exact values written to JSONL are
 * also the values whose behavior probability and value prediction were evaluated. */
function float32Numbers(values: number[]): number[] {
	return Array.from(Float32Array.from(values));
}

function float32Matrix(values: number[][]): number[][] {
	return values.map(float32Numbers);
}

/** Observe whether a selection helper actually delegated to the learned policy. Hybrid/value
 * selectors can take deterministic branches before `policy.pick`; those rows are not on-policy
 * PPO samples and must not receive fabricated behavior probabilities. */
function withPickObserver(
	policy: NeuralPolicy,
	onPick: (trace: PolicyPickTrace) => void
): NeuralPolicy {
	return new Proxy(policy, {
		get(target, prop) {
			if (prop === 'pick') {
				return (
					obs: number[],
					cands: number[][],
					opts?: { sample?: boolean; temperature?: number; rand?: () => number }
				): number => {
					// neuralBot builds these arrays internally. Re-quantizing here closes the final
					// TS-double -> JSON-rounded -> torch-float mismatch in PPO's initial ratio.
					const exactObs = float32Numbers(obs);
					const exactCands = float32Matrix(cands);
					const chosen = target.pick(exactObs, exactCands, opts);
					onPick({
						chosen,
						candidateCount: cands.length,
						sample: opts?.sample === true,
						temperature: opts?.temperature
					});
					return chosen;
				};
			}
			const value = Reflect.get(target, prop, target) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		}
	}) as NeuralPolicy;
}

export interface SampledPolicyBehavior {
	logpOld: number;
	behaviorTemperature: number;
	behaviorMask: number[];
}

/** Reconstruct the exact softmax distribution used for a sampled learned-policy action.
 * `supportIndices` is the post-progress-filter support in full-candidate order. Returning null
 * makes the caller omit PPO fields rather than train on an invalid importance ratio. */
export function sampledPolicyBehavior(
	policy: NeuralPolicy,
	obs: number[],
	cands: number[][],
	supportIndices: number[],
	chosenFullIndex: number,
	temperature?: number
): SampledPolicyBehavior | null {
	const effectiveTemperature = temperature ?? 1;
	if (!Number.isFinite(effectiveTemperature)) return null;
	const t = Math.max(1e-6, effectiveTemperature);
	if (supportIndices.length === 0 || new Set(supportIndices).size !== supportIndices.length)
		return null;
	if (supportIndices.some((i) => !Number.isInteger(i) || i < 0 || i >= cands.length)) return null;
	const chosenLocalIndex = supportIndices.indexOf(chosenFullIndex);
	if (chosenLocalIndex < 0) return null;
	const supportCands = supportIndices.map((i) => cands[i]);
	const probs = policy.probs(obs, supportCands, t);
	if (
		probs.length !== supportCands.length ||
		probs.some((p) => !Number.isFinite(p) || p < 0) ||
		!(probs[chosenLocalIndex] > 0)
	) {
		return null;
	}
	return {
		logpOld: Math.log(probs[chosenLocalIndex]),
		behaviorTemperature: t,
		behaviorMask: cands.map((_, i) => (supportIndices.includes(i) ? 1 : 0))
	};
}

export function playRecordingGame(catalog: PlayCatalog, opts: RecordGameOptions): RecordGameResult {
	if (opts.policyObsVersion === 2) {
		// The in-process TS net is v1-only: local weights consume the current 199-float obs.
		if (opts.policy && (opts.policy as unknown as { w?: unknown }).w) {
			throw new Error(
				'driver: policyObsVersion 2 requires a v2-capable policy (RemotePolicy over an infer socket serving arc-entity-scorer-v2); the in-process NeuralPolicy is v1-only'
			);
		}
		if (opts.selection === 'value') {
			throw new Error(
				"driver: policyObsVersion 2 does not support selection 'value' — its 1-ply lookahead needs per-candidate next-state observations"
			);
		}
	}
	const profiles = opts.profiles;
	const maxRounds = opts.maxRounds ?? 300;
	// The engine itself ends after cleanup on MAX_ROUNDS. A larger driver safety
	// limit cannot extend the game, so critic metadata uses the effective horizon.
	const reach30Horizon = Math.min(maxRounds, MAX_ROUNDS);
	const n = Math.min(profiles.length, SEAT_COLORS.length, catalog.guardians.length);
	const seats = SEAT_COLORS.slice(0, n) as SeatColor[];
	if (opts.episodeId !== undefined && (!opts.episodeId.trim() || opts.episodeId.length > 200)) {
		throw new Error('driver: episodeId must be non-empty and at most 200 characters');
	}
	if (opts.continuation && !opts.episodeId) {
		throw new Error('driver: continuation episodes require an explicit unique episodeId');
	}
	const captureRounds = new Set(opts.captureContinuationRounds ?? []);
	for (const round of captureRounds) assertLateRound(round, 'capture continuation round');
	if ((opts.continuation || captureRounds.size > 0) && (opts.chooser || opts.searcher)) {
		throw new Error(
			'driver: continuation capture/replay does not support opaque chooser or searcher state'
		);
	}
	if (opts.continuation && Object.keys(opts.opponentPolicies ?? {}).length > 0) {
		throw new Error('driver: continuation replay does not support opponent policies');
	}
	if (captureRounds.size > 0 && n !== 1) {
		throw new Error('driver: continuation capture currently requires a solo game');
	}
	if (opts.continuation && captureRounds.size > 0) {
		throw new Error('driver: continuation replay cannot recursively capture more continuations');
	}
	// Seat guardians: honor an explicit (per-game shuffled) lineup, keeping only valid catalog
	// names, de-duplicated (each seat needs a distinct guardian), then back-fill from the catalog
	// so we always have n. Default (no override) = first n catalog guardians, as before.
	const catalogNames = catalog.guardians.map((g) => g.name);
	let guardianNames: string[];
	if (opts.guardianNames && opts.guardianNames.length) {
		const seen = new Set<string>();
		guardianNames = [];
		for (const nm of opts.guardianNames) {
			if (catalogNames.includes(nm) && !seen.has(nm)) {
				guardianNames.push(nm);
				seen.add(nm);
			}
			if (guardianNames.length >= n) break;
		}
		for (const nm of catalogNames) {
			if (guardianNames.length >= n) break;
			if (!seen.has(nm)) {
				guardianNames.push(nm);
				seen.add(nm);
			}
		}
	} else {
		guardianNames = catalogNames.slice(0, n);
	}

	const hasController = !!(opts.policy || opts.chooser);
	const neuralSet = new Set<SeatColor>(hasController ? (opts.neuralSeats ?? seats) : []);
	const recordSet = new Set<SeatColor>(
		opts.recordSeats ?? (opts.policy ? Array.from(neuralSet) : seats)
	);
	const shaping = opts.shaping ?? BALANCED_SHAPING;
	const gamma = opts.gamma ?? 0.99;
	// Optional explicit monster-kill bonus (env ARC_HUNT_BONUS, default 0 = off). Added to the
	// per-step reward when a decision claims a monster reward — directly drives the monster/economy
	// line the sparse ΔVP signal struggles to discover. Policy-additive shaping; ΔVP stays the core.
	const huntBonus = process.env.ARC_HUNT_BONUS ? parseFloat(process.env.ARC_HUNT_BONUS) : 0;

	let state: PublicGameState;
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	const profileBySeat: Record<string, BotProfile> = {};
	seats.forEach((seat, i) => {
		profileBySeat[seat] = profiles[i] ?? MEDIUM_DEFAULTS;
	});

	const expectOk = (r: ReturnType<typeof applyGameCommand>, label: string): void => {
		if (!r.ok) throw new Error(`${label}: ${r.error.code} ${r.error.message}`);
		state = r.state;
	};

	let botRngState: RngState;
	let pickRng: RngState;
	if (opts.continuation) {
		if (opts.seed !== opts.continuation.snapshot.sourceSeed) {
			throw new Error(
				`driver: continuation seed ${opts.seed} does not match snapshot sourceSeed ${opts.continuation.snapshot.sourceSeed}`
			);
		}
		validateContinuationSnapshot(opts.continuation.snapshot, seats, reach30Horizon);
		if (opts.continuation.pickRng && !validRngState(opts.continuation.pickRng)) {
			throw new Error('driver: continuation pick-RNG override is invalid');
		}
		state = jsonClone(opts.continuation.snapshot.state);
		botRngState = { ...opts.continuation.snapshot.botRng };
		pickRng = { ...(opts.continuation.pickRng ?? opts.continuation.snapshot.pickRng) };
	} else {
		state = createLobbyState({ roomCode: 'MLSIM', guardianNames });
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
		expectOk(
			applyGameCommand(state, host, { type: 'startGame', seed: opts.seed }, catalog),
			'startGame'
		);
		botRngState = createRng(opts.seed);
		pickRng = createRng(opts.seed ^ 0x9e3779b9);
	}

	const botRng = seededBotRandom(botRngState);
	const rand = (): number => nextInt(pickRng, 1_000_000) / 1_000_000;

	const samples: Sample[] = [];
	const optionEvents: RoundOptionEvent[] = [];
	const optionBySeat = new Map<SeatColor, { round: number; optionId: number; oneHot: number[] }>();
	const gameIdForSeat = (seat: SeatColor): string =>
		opts.episodeId ? `${opts.episodeId}-${seat}` : `${opts.seed}-${n}p-${seat}`;
	const continuationSnapshots: ContinuationSnapshot[] = [];
	const capturedRounds = new Set<number>();
	const cycleBySeat: Record<string, SeatCycleSummary> = {};
	for (const seat of seats) {
		cycleBySeat[seat] = {
			vpAfterRound: {},
			first15Round: null,
			first30Round: null,
			decisions: 0,
			productiveDecisions: 0,
			optionalYieldDecisions: 0,
			locationInteractions: 0,
			summons: 0,
			awakens: 0,
			combats: 0,
			rewards: 0,
			pvpAttacks: 0,
			finalAttackDice: 0,
			finalSpirits: 0,
			finalMaxBarrier: 0,
			post15VpPerRound: 0
		};
	}
	let observedRound = state.round;
	const captureCycle = (terminal = false): void => {
		for (const seat of seats) {
			const cycle = cycleBySeat[seat];
			const vp = vpOf(state.players[seat]);
			if (cycle.first15Round === null && vp >= 15) cycle.first15Round = state.round;
			if (cycle.first30Round === null && vp >= VP_TO_WIN) cycle.first30Round = state.round;
			for (const round of CYCLE_ROUNDS) {
				const crossed = observedRound <= round && state.round > round;
				const endedOnRound = terminal && state.round === round;
				if (cycle.vpAfterRound[String(round)] === undefined && (crossed || endedOnRound)) {
					cycle.vpAfterRound[String(round)] = vp;
				}
			}
		}
		observedRound = Math.max(observedRound, state.round);
	};
	captureCycle();
	const actionCounter = new Map<string, number>();
	let ticks = 0;
	let stalled = false;
	const recordCycleDecision = (
		seat: SeatColor,
		cmd: GameCommand,
		productive: boolean,
		hadAlternatives: boolean
	): void => {
		const cycle = cycleBySeat[seat];
		cycle.decisions += 1;
		if (productive) cycle.productiveDecisions += 1;
		if (hadAlternatives && OPTIONAL_YIELD_TYPES.has(cmd.type)) {
			cycle.optionalYieldDecisions += 1;
		}
		if (cmd.type === 'resolveLocationInteraction') cycle.locationInteractions += 1;
		if (cmd.type === 'spawnHandSpirit') cycle.summons += 1;
		if (cmd.type === 'awakenSpirit') cycle.awakens += 1;
		if (cmd.type === 'startCombat') cycle.combats += 1;
		if (cmd.type === 'resolveMonsterReward') cycle.rewards += 1;
		if (cmd.type === 'initiatePvp') cycle.pvpAttacks += 1;
	};

	// v2 recording: samples gain a PAIRED obsV2 flat array next to the v1 obs (see the
	// obsVersion option docs). Reads the live `state` binding, so call it exactly where
	// encodeObs is called for the same decision.
	const recordObsV2 =
		opts.obsVersion === 2
			? (seat: SeatColor): number[] =>
					flattenObsV2(encodeEntityObsV2(state, seat, catalog), catalog)
			: null;

	const applyHeuristic = (seat: SeatColor): boolean => {
		let progressed = false;
		const plan = planBotPhaseActions(state, seat, catalog, botRng, profileBySeat[seat]);
		for (const cmd of plan) {
			if (opts.forbidTypes?.has(cmd.type)) continue;
			if (opts.maxStatusLevel !== undefined) {
				const probe = applyGameCommand(state, botActorFor(state, seat), cmd, catalog);
				if (probe.ok && (probe.state.players[seat]?.statusLevel ?? 0) > opts.maxStatusLevel)
					continue;
			}
			// Record covered heuristic decisions (BC label) BEFORE applying — but only for
			// strategic command types, since recording dry-runs many candidates (expensive).
			if (recordSet.has(seat) && !neuralSet.has(seat) && RECORDABLE_TYPES.has(cmd.type)) {
				const withNextH = filterConstrainedActions(
					legalActionsWithNext(state, seat, catalog),
					seat,
					opts.forbidTypes,
					opts.maxStatusLevel
				);
				if (withNextH.length > 1) {
					const mi = withNextH.findIndex((x) => commandMatches(x.cmd, cmd));
					if (mi >= 0) {
						const obs = encodeObs(state, seat, catalog);
						samples.push({
							obs,
							...(recordObsV2 ? { obsV2: recordObsV2(seat) } : {}),
							cands: withNextH.map((x) =>
								encodeAction(state, seat, x.cmd, policyPreviewState(x), catalog)
							),
							chosen: mi,
							ret: 0,
							seat,
							vp: vpOf(state.players[seat]),
							phi: buildPotential(state.players[seat], shaping),
							kill: decisionKills(state, withNextH[mi].next, seat, cmd) ? 1 : 0,
							decisionType: cmd.type,
							playerCount: opts.profiles.length,
							strategic: isStrategicDecision(
								withNextH.map((candidate) => candidate.cmd),
								opts.strategicDecisionScope
							)
								? 1
								: 0,
							...sampleAuxTargets(state, seat, catalog, withNextH, withNextH[mi])
						});
					}
				}
			}
			// Commit the chosen heuristic command in place — the prior `state` is discarded each
			// step (reassigned just below), exactly like sim/selfPlay, so the defensive deep clone
			// is pure overhead here. Parity-tested fast path (sim/_parity.test.ts); the recording
			// dry-runs above (legalActions) still clone, which is what preserves the candidate states.
			const beforeProgress = progressSignature(state, seat);
			// Computing the full legal surface is only needed for the avoidable-yield
			// diagnostic, so normal heuristic actions retain the fast mutate path.
			const hadAlternatives = OPTIONAL_YIELD_TYPES.has(cmd.type)
				? legalActionsWithNext(state, seat, catalog).length > 1
				: false;
			const res = applyGameCommand(state, botActorFor(state, seat), cmd, catalog, { mutate: true });
			if (!res.ok) break;
			recordCycleDecision(
				seat,
				cmd,
				progressSignature(res.state, seat) !== beforeProgress,
				hadAlternatives
			);
			state = res.state;
			progressed = true;
			if (state.status !== 'active') break;
		}
		return progressed;
	};

	const stepNeural = (seat: SeatColor): boolean => {
		const key = `${seat}:${state.round}:${state.phase}`;
		const used = actionCounter.get(key) ?? 0;
		if (used >= MAX_ACTIONS_PER_PHASE) return applyHeuristic(seat); // unstick → forces a yield
		const withNextRaw = legalActionsWithNext(state, seat, catalog);
		if (withNextRaw.length === 0) return applyHeuristic(seat); // uncovered phase → heuristic
		// Hard behavioral constraint: drop forbidden action types (e.g. corruption) for neural
		// seats — unless that would leave no legal move (never softlock).
		const withNext = filterConstrainedActions(
			withNextRaw,
			seat,
			opts.forbidTypes,
			opts.maxStatusLevel
		);
		const cands = withNext.map((x) => x.cmd);
		const obs = float32Numbers(encodeObs(state, seat, catalog));
		// One flatten per decision, shared by the v2-driven policy and the recorded obsV2.
		const flatV2Raw =
			opts.policyObsVersion === 2 || recordObsV2
				? flattenObsV2(encodeEntityObsV2(state, seat, catalog), catalog)
				: null;
		const flatV2 = flatV2Raw ? float32Numbers(flatV2Raw) : null;
		const policyObs = opts.policyObsVersion === 2 ? flatV2! : obs;
		const feats = float32Matrix(
			withNext.map((x) => encodeAction(state, seat, x.cmd, policyPreviewState(x), catalog))
		);
		// League opponents play their own checkpoint greedily (no exploration, no recording);
		// the learner seat uses the configured selection + exploration and is recorded.
		const oppPolicy = opts.opponentPolicies?.[seat];
		const seatPolicy = oppPolicy ?? opts.policy;
		let roundOption = optionBySeat.get(seat);
		if (seatPolicy?.optionDim === 4 && roundOption?.round !== state.round) {
			const behaviorMask = n === 1 ? [1, 1, 1, 0] : [1, 1, 1, 1];
			const optionSample = oppPolicy ? (opts.opponentTemperature ?? 0) > 0 : opts.sample === true;
			const optionProbs = seatPolicy.optionProbs(policyObs, behaviorMask);
			const optionId = seatPolicy.pickOption(policyObs, {
				sample: optionSample,
				behaviorMask,
				rand: () => deterministicRoundOptionRandom(opts.seed, seat, state.round)
			});
			const optionVPred = seatPolicy.optionValue(policyObs);
			if (
				!optionProbs ||
				optionId === null ||
				optionVPred === null ||
				!Number.isFinite(optionVPred) ||
				!(optionProbs[optionId] > 0)
			) {
				throw new Error('driver: option-aware policy produced an invalid round-option event');
			}
			const oneHot = Array<number>(seatPolicy.optionDim).fill(0);
			oneHot[optionId] = 1;
			roundOption = { round: state.round, optionId, oneHot };
			optionBySeat.set(seat, roundOption);
			if (recordSet.has(seat) && !oppPolicy) {
				const gameId = gameIdForSeat(seat);
				optionEvents.push({
					eventId: `${gameId}:r${state.round}`,
					gameId,
					seat,
					round: state.round,
					obs: policyObs,
					optionId,
					behaviorMask,
					logpOld: optionSample ? Math.log(optionProbs[optionId]) : 0,
					optionVPred,
					playerCount: n,
					lowLevelDecisionCount: 0
				});
			}
		}
		if (seatPolicy?.optionDim === 4 && !roundOption) {
			throw new Error('driver: missing persistent option after option-aware selection');
		}
		let observedPick: PolicyPickTrace | null = null;
		// Learner at policyObsVersion 2: neuralBot re-encodes v1 obs internally, so wrap the
		// policy to substitute this decision's flat v2 obs. Opponents keep v1 nets + v1 obs.
		const fixedObsPolicy =
			seatPolicy && opts.policyObsVersion === 2 && !oppPolicy && opts.policy
				? withFixedObs(seatPolicy, flatV2!)
				: seatPolicy;
		const optionConditionedPolicy =
			fixedObsPolicy && roundOption
				? withFixedOption(fixedObsPolicy, roundOption.oneHot)
				: fixedObsPolicy;
		const activePolicy = optionConditionedPolicy
			? withPickObserver(optionConditionedPolicy, (trace) => {
					observedPick = trace;
				})
			: undefined;
		// Opponents: greedy by default (opponentTemperature 0), else sample at opponentTemperature.
		const oppTemp = opts.opponentTemperature ?? 0;
		const sample = oppPolicy ? oppTemp > 0 : opts.sample;
		const pickTemperature = oppPolicy ? oppTemp : opts.temperature;
		const willRecord = cands.length > 1 && recordSet.has(seat) && !oppPolicy;
		const searched =
			opts.searcher && !oppPolicy && cands.length > 1 ? opts.searcher(state, seat, withNext) : null;
		const behaviorSupport = selectableCandidateIndices(state, seat, withNext, {
			learnMonsterRewardChoices: opts.learnMonsterRewardChoices
		});
		// Prime RemotePolicy's per-decision cache with the full candidate set. A subsequent
		// progress-filtered pick derives its subset logits from this same response.
		if (
			willRecord &&
			opts.policy &&
			!opts.chooser &&
			!searched &&
			sample === true &&
			opts.selection !== 'value'
		) {
			optionConditionedPolicy!.scoreCandidates(policyObs, feats);
		}
		const idx =
			cands.length === 1
				? 0
				: searched
					? searched.index
					: opts.chooser && !oppPolicy
						? opts.chooser(policyObs, feats, cands, seat, state, withNext)
						: opts.selection === 'policy'
							? policyIndexWithProgressGuard(
									activePolicy!,
									state,
									seat,
									withNext,
									{ sample, temperature: pickTemperature, rand },
									catalog
								)
							: opts.selection === 'value'
								? valueGuidedIndex(
										activePolicy!,
										state,
										seat,
										withNext,
										{ sample, temperature: pickTemperature, rand },
										catalog
									)
								: hybridIndex(
										activePolicy!,
										state,
										seat,
										withNext,
										{
											sample,
											temperature: pickTemperature,
											rand,
											learnMonsterRewardChoices: opts.learnMonsterRewardChoices
										},
										catalog
									);
		const chosenAction = withNext[idx];
		recordCycleDecision(
			seat,
			cands[idx],
			chosenAction.hasHiddenOutcome ||
				isProgressTransition(state, seat, policyPreviewState(chosenAction)),
			cands.length > 1
		);
		if (willRecord) {
			// Every policy-backed decision remains in the PPO trajectory. Only an exact sampled
			// policy decision gets policyMask=1 and behavior fields; deterministic branches still
			// supply vPred for complete-episode GAE/value/auxiliary training.
			const learnerPolicy = optionConditionedPolicy;
			const vPred = learnerPolicy?.value(policyObs);
			const valueFields =
				typeof vPred === 'number' && Number.isFinite(vPred) ? { vPred, policyMask: 0 } : undefined;
			const placementProbs = (
				learnerPolicy as unknown as { placementProbs?: (input: number[]) => number[] | null }
			)?.placementProbs?.(policyObs);
			const outcomeFields =
				placementProbs?.length === 4 &&
				placementProbs.every((probability) => Number.isFinite(probability) && probability >= 0)
					? { placementProbs }
					: undefined;
			const reach30Policy = learnerPolicy as unknown as {
				reach30Probability?: (input: number[]) => number | null;
				reach30Horizon?: () => number | null;
			};
			const reach30Pred = reach30Policy?.reach30Probability?.(policyObs);
			if (typeof reach30Pred === 'number' && reach30Policy.reach30Horizon?.() !== reach30Horizon) {
				throw new Error(
					`reach30 critic horizon ${String(reach30Policy.reach30Horizon?.())} ` +
						`does not match effective rollout horizon ${reach30Horizon}`
				);
			}
			const reach30Fields =
				typeof reach30Pred === 'number' &&
				Number.isFinite(reach30Pred) &&
				reach30Pred >= 0 &&
				reach30Pred <= 1
					? { reach30Pred }
					: undefined;
			let behaviorFields: (SampledPolicyBehavior & { policyMask: 1 }) | undefined;
			// The observer callback runs synchronously inside policy.pick, but TypeScript does not
			// model assignments made through callbacks in its control-flow analysis.
			const policyPick = observedPick as PolicyPickTrace | null;
			if (
				opts.policy &&
				policyPick?.sample === true &&
				policyPick.candidateCount === behaviorSupport.length &&
				behaviorSupport[policyPick.chosen] === idx
			) {
				const behavior = sampledPolicyBehavior(
					learnerPolicy!,
					policyObs,
					feats,
					behaviorSupport,
					idx,
					policyPick.temperature
				);
				if (behavior && valueFields) behaviorFields = { ...behavior, policyMask: 1 };
			}
			samples.push({
				obs,
				...(recordObsV2 ? { obsV2: flatV2! } : {}),
				...(searched ? { pi: searched.pi } : {}),
				cands: feats,
				chosen: idx,
				ret: 0,
				seat,
				vp: vpOf(state.players[seat]),
				round: state.round,
				phi: buildPotential(state.players[seat], shaping),
				kill: decisionKills(state, withNext[idx].next, seat, cands[idx]) ? 1 : 0,
				decisionType: cands[idx].type,
				playerCount: opts.profiles.length,
				...(roundOption ? { optionId: roundOption.optionId } : {}),
				strategic: isStrategicDecision(cands, opts.strategicDecisionScope) ? 1 : 0,
				...valueFields,
				...outcomeFields,
				...reach30Fields,
				...behaviorFields,
				...sampleAuxTargets(state, seat, catalog, withNext, withNext[idx])
			});
		}
		state = withNext[idx].next;
		actionCounter.set(key, used + 1);
		return true;
	};

	while (state.status === 'active' && state.round <= maxRounds) {
		if (
			captureRounds.has(state.round) &&
			!capturedRounds.has(state.round) &&
			isContinuationCaptureBoundary(state, seats)
		) {
			continuationSnapshots.push(
				makeContinuationSnapshot(state, botRngState, pickRng, opts.seed, reach30Horizon, seats)
			);
			capturedRounds.add(state.round);
		}
		ticks += 1;
		if (ticks > MAX_TICKS) {
			stalled = true;
			break;
		}
		let progressed = false;
		for (const seat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, seat)) continue;
			const did = neuralSet.has(seat) ? stepNeural(seat) : applyHeuristic(seat);
			progressed = progressed || did;
			if (state.status !== 'active') break;
		}
		captureCycle(state.status !== 'active');
		if (state.status !== 'active') break;
		if (!progressed) {
			const before = `${state.phase}:${state.round}`;
			applyDeadlineAdvance(state, catalog);
			if (`${state.phase}:${state.round}` === before) {
				stalled = true;
				break;
			}
			captureCycle(false);
		}
	}
	captureCycle(state.status !== 'active');

	const finalVP: Record<string, number> = {};
	for (const seat of seats) finalVP[seat] = state.players[seat]?.victoryPoints ?? 0;
	for (const seat of seats) {
		const player = state.players[seat];
		const cycle = cycleBySeat[seat];
		cycle.finalAttackDice = player?.attackDice.length ?? 0;
		cycle.finalSpirits = player?.spirits.filter(Boolean).length ?? 0;
		cycle.finalMaxBarrier = player?.maxBarrier ?? 0;
		cycle.post15VpPerRound =
			cycle.first15Round === null
				? 0
				: Math.max(0, (finalVP[seat] - 15) / Math.max(1, state.round - cycle.first15Round));
	}

	// VP-maximizing return-to-go: per seat, credit each decision with its discounted future VP
	// (plus potential-based build shaping). γ<1 trades total-VP vs VP/turn — a harness knob.
	const finished = state.status === 'finished';
	// All-Fallen collapse terminal: the game ended (finished) with NO seat at the VP target and
	// every player Fallen (phases.tryAdvanceFromCleanup's second branch). Stamped on every seat's
	// terminal row so the trainer can price the degenerate mutual-corruption ending as a loss.
	const allFallenEnd =
		finished && (finalVP[state.winnerSeat ?? ''] ?? 0) < VP_TO_WIN && allPlayersFallen(state);
	for (const seat of seats) {
		const seatSamples = samples.filter((s) => s.seat === seat); // already in play order
		if (seatSamples.length === 0) continue;
		const finalBuild = buildPotential(state.players[seat], shaping);
		const g = vpReturnsToGo(
			seatSamples.map((s) => s.vp),
			seatSamples.map((s) => s.phi),
			finalVP[seat],
			finalBuild,
			gamma,
			seatSamples.map((s) => huntBonus * s.kill),
			{ potentialMode: opts.potentialShapingMode, terminal: finished }
		);
		seatSamples.forEach((s, i) => (s.ret = g[i]));

		// PPO trajectory stamps (per-seat episode; see the Sample field docs).
		const gameId = gameIdForSeat(seat);
		const placement = 1 + seats.filter((o) => o !== seat && finalVP[o] > finalVP[seat]).length;
		const rSteps = opts.stepRewards?.(seatSamples, seat, finalVP);
		// Dense reward: ΔVP + ΔΦ between consecutive recorded decisions; the last
		// row absorbs the tail to the FINAL state (cleanup VP, end-of-game build).
		let dense: number[] | null = null;
		if (!rSteps && opts.denseVpReward) {
			dense = seatSamples.map((s, i) => {
				const nextVp = i + 1 < seatSamples.length ? seatSamples[i + 1].vp : finalVP[seat];
				const nextPhi = i + 1 < seatSamples.length ? seatSamples[i + 1].phi : finalBuild;
				return (
					(nextVp - s.vp) / VP_TO_WIN +
					potentialShapingDelta(
						s.phi,
						nextPhi,
						gamma,
						finished && i === seatSamples.length - 1,
						opts.potentialShapingMode
					)
				);
			});
		}
		// True 30-VP win (not a round-cap or all-Fallen highest-VP finish): the
		// PPO --win-bonus rewards THIS, so the trainer distinguishes winning the
		// game from merely out-placing the field.
		const wonGame = finished && state.winnerSeat === seat && finalVP[seat] >= VP_TO_WIN ? 1 : 0;
		seatSamples.forEach((s, i) => {
			s.gameId = gameId;
			s.stepIdx = i;
			s.rStep = rSteps?.[i] ?? dense?.[i] ?? 0;
			// New trajectory rows always state policy eligibility explicitly. Pure heuristic
			// episodes have no vPred and are rejected as whole episodes by the PPO loader, while
			// remaining valid AWR/teacher data.
			s.policyMask ??= 0;
			s.done = finished && i === seatSamples.length - 1;
			if (finished) s.placement = placement;
			if (s.done) {
				s.won = wonGame;
				s.allFallen = allFallenEnd ? 1 : 0;
				// The game's final round — the tempo trainer decays the win bonus by how late
				// it landed. state.round is the terminal round for both finished and capped games.
				s.endRound = state.round;
			}
			// Round-cap and deterministic deadlock failures are resolved losses for the
			// solo objective even though PPO keeps done=false for dense-return bootstrapping.
			// Infrastructure exceptions never reach this point and therefore remain unlabeled.
			if (opts.profiles.length === 1 && i === seatSamples.length - 1) {
				s.reach30Target = !stalled && finalVP[seat] >= VP_TO_WIN ? 1 : 0;
				s.reach30Horizon = reach30Horizon;
			}
		});
	}

	// Bind the separate high-level stream to the exact low-level rows it governed. This is
	// finalized only after gameId/round/seat have been stamped on every recorded decision.
	const lowLevelCounts = new Map<string, number>();
	for (const sample of samples) {
		if (
			typeof sample.gameId !== 'string' ||
			typeof sample.round !== 'number' ||
			typeof sample.optionId !== 'number'
		) {
			continue;
		}
		const key = `${sample.gameId}\u0000${sample.seat}\u0000${sample.round}`;
		lowLevelCounts.set(key, (lowLevelCounts.get(key) ?? 0) + 1);
	}
	for (const event of optionEvents) {
		const key = `${event.gameId}\u0000${event.seat}\u0000${event.round}`;
		event.lowLevelDecisionCount = lowLevelCounts.get(key) ?? 0;
	}

	return {
		winnerSeat: state.winnerSeat ?? null,
		finished: state.status === 'finished',
		rounds: state.round,
		stalled,
		finalVP,
		samples,
		optionEvents,
		cycleBySeat,
		finalState: state,
		continuationSnapshots
	};
}
