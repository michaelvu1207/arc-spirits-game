/**
 * Gumbel root-search planner — Phase B of the superhuman-bot plan.
 *
 * Replaces the PUCT/solo-determinization planner (planner.ts) at the two
 * STRATEGIC decision nodes:
 *   • navigation  (secret simultaneous destination lock, ≤6 candidates)
 *   • encounter   (initiatePvp / passEncounter, 2 candidates)
 *
 * Method = Gumbel AlphaZero at the root with a small simulation budget
 * (Danihelka et al., ICLR 2022): sample Gumbel noise per candidate, keep the
 * top-m by g + logit, spend the budget via SEQUENTIAL HALVING, and emit the
 * completed-Q improved policy  π' = softmax(logits + σ(completedQ))  as the
 * training target. At n = 8–32 sims this gives a guaranteed-in-expectation
 * policy improvement — the regime where classic UCT is just noise.
 *
 * Differences from planner.ts (deliberate):
 *   • FULL-SEAT determinization. Opponents are KEPT and played by the rollout
 *     profile (max^n: every seat maximizes its own outcome). The solo
 *     isolation of planner.ts could never see PvP (+3 needs a co-located
 *     victim), co-location risk, or interference — exactly the levers that
 *     decide this game.
 *   • Info-safety: bots run server-side on the full state, so opponents'
 *     SECRET pre-reveal `pendingDestination` is visible here. The
 *     determinizer CLEARS those locks and lets the rollout policy re-pick —
 *     search never conditions on information the seat cannot have.
 *   • Root-only search (no tree). At ≤32 sims a depth-1 bandit with playout +
 *     value-blend leaves is the whole method; interior tree machinery buys
 *     nothing until budgets grow 10×.
 *
 * The returned `pi` is the recorder's policy target (Phase C wires that); the
 * returned `index` is the action to play. Navigation callers should SAMPLE
 * (temperature > 0) — a deterministic pick at the game's one simultaneous
 * hidden-info node is structurally exploitable.
 */

import { applyGameCommand, applyDeadlineAdvance } from '../runtime';
import { createRng, hashString, nextInt } from '../rng';
import {
	botActorFor,
	botSeatNeedsToAct,
	planBotPhaseActions,
	profileFor,
	type BotProfile,
	type BotRandom
} from '../server/botPolicy';
import type { PlayCatalog, PublicGameState, SeatColor } from '../types';
import { legalActionsWithNext, policyPreviewState, type LegalAction } from './actions';
import { combatActionExpectation, encodeObs, encodeAction } from './encode';
import type { NeuralPolicy } from './net';

export type SearchLeafObjective = 'multiplayer' | 'solo-reach30';
export type SearchObservationEncoder = (
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog
) => number[];

export interface GumbelPlanOptions {
	/** Total simulation budget n across all candidates. */
	simulations?: number;
	/** Gumbel-Top-m: max root candidates considered. */
	maxConsidered?: number;
	/** Rounds of lookahead before the leaf is scored. */
	horizonRounds?: number;
	/** Leaf blend: value = w·V_net + (1−w)·playoutOutcome. */
	valueWeight?: number;
	/** Leaf semantics. The legacy/default multiplayer objective is unchanged. */
	objective?: SearchLeafObjective;
	/** Observation schema used by both root priors and every leaf critic call. */
	encodeObservation?: SearchObservationEncoder;
	/** Completed-Q transform scale: σ(q) = (cVisit + maxN)·cScale·q. */
	cVisit?: number;
	cScale?: number;
	/** Heuristic profile that plays ALL seats inside rollouts. */
	rolloutProfile?: BotProfile;
	/**
	 * Self-model rollouts: when set, EVERY seat inside a rollout picks via this
	 * callback (typically a hybridIndex closure over the champion net) instead
	 * of the heuristic profile. Injected as a callback — not imported — to keep
	 * gumbelPlanner ↔ neuralBot acyclic. ~10-30× slower per sim than the
	 * heuristic, but the leaf states then reflect champion-quality play (the
	 * medium-heuristic rollouts never execute the PvP line, which biases Q
	 * against exactly the moves that win).
	 */
	rolloutChoose?: (s: PublicGameState, seat: SeatColor, withNext: LegalAction[]) => number;
	/** Base seed for reproducible determinizations. */
	seed?: number;
	/**
	 * Action pick: 0/undefined = the sequential-halving winner (argmax).
	 * > 0 = sample from π'^(1/T) — REQUIRED at navigation (mixing).
	 */
	temperature?: number;
	/** RNG for the π' sample (defaults to a seed-derived stream). */
	rand?: () => number;
}

export interface GumbelPlanResult {
	/** Chosen index into the caller's candidate list. */
	index: number;
	/** Completed-Q improved policy over ALL candidates — the training target. */
	pi: number[];
	/** Mean backed-up value per candidate (our seat; NaN→0 for unvisited). */
	q: number[];
	/** Simulations spent per candidate. */
	visits: number[];
	/** Prior logits from the policy net (diagnostics). */
	logits: number[];
}

/** Terminal-consistent outcome ∈ [0,1] for `seat`: mirrors reward.ts's
 *  0.7·placement + 0.3·VP/30 with the winner pinned to 1. Multi-seat states
 *  only — placement is meaningless in a solo determinization. */
export function outcomeForSeat(s: PublicGameState, seat: SeatColor): number {
	const p = s.players[seat];
	if (!p) return 0;
	if (s.winnerSeat === seat) return 1;
	const seats = Object.keys(s.players) as SeatColor[];
	const myVp = p.victoryPoints;
	let below = 0;
	let ties = 0;
	for (const other of seats) {
		if (other === seat) continue;
		const vp = s.players[other]?.victoryPoints ?? 0;
		if (vp < myVp) below++;
		else if (vp === myVp) ties++;
	}
	const denom = Math.max(1, seats.length - 1);
	const placementFrac = (below + ties * 0.5) / denom;
	const vpFrac = Math.min(1, myVp / 30);
	return 0.7 * placementFrac + 0.3 * vpFrac;
}

/** Full-seat determinization: fresh RNG stream + opponents' secret pre-reveal
 *  navigation locks cleared (re-picked by the rollout policy). */
export function determinizeForSearch(
	state: PublicGameState,
	seat: SeatColor,
	simSeed: number
): PublicGameState {
	const s = structuredClone(state) as PublicGameState;
	s.rng = createRng(simSeed >>> 0 || 1);
	if (s.phase === 'navigation' && !s.revealedDestinations) {
		for (const k of Object.keys(s.players) as SeatColor[]) {
			const p = s.players[k];
			if (k !== seat && p) p.pendingDestination = null;
		}
	}
	return s;
}

/** Unique, reproducible root-search stream key. The monotonically increasing
 * ordinal is per game, including multiple strategic decisions in one round. */
export function searchInvocationSeed(
	gameSeed: number,
	round: number,
	ordinal: number,
	seat: SeatColor
): number {
	if (!Number.isSafeInteger(gameSeed) || !Number.isInteger(round) || !Number.isInteger(ordinal)) {
		throw new Error('search invocation key requires integer game seed, round, and ordinal');
	}
	if (ordinal < 1) throw new Error('search invocation ordinal must be positive');
	const keyed =
		(Math.imul(gameSeed >>> 0, 0x9e3779b1) +
			Math.imul(round >>> 0, 7919) +
			Math.imul(ordinal >>> 0, 104729) +
			hashString(seat)) >>>
		0;
	return keyed || 1;
}

/** Advance a determinized state with every seat played by `profile` (or the
 *  self-model `choose` callback) until game end / stopRound. Same drain shape
 *  as advanceAfterNav (botPolicy.ts). */
export function rolloutPolicyToRound(
	s: PublicGameState,
	catalog: PlayCatalog,
	profile: BotProfile,
	botRng: BotRandom,
	stopRound: number,
	choose?: GumbelPlanOptions['rolloutChoose']
): PublicGameState {
	let ticks = 0;
	while (s.status === 'active' && s.round <= stopRound) {
		if (++ticks > 4000) break;
		let progressed = false;
		for (const st of s.activeSeats) {
			if (!botSeatNeedsToAct(s, st)) continue;
			if (choose) {
				// Self-model: one decision at a time (each pick changes the state).
				let guard = 0;
				while (botSeatNeedsToAct(s, st) && guard < 40) {
					guard += 1;
					const withNext = legalActionsWithNext(s, st, catalog);
					if (withNext.length === 0) break;
					const idx = withNext.length === 1 ? 0 : choose(s, st, withNext);
					const r = applyGameCommand(s, botActorFor(s, st), withNext[idx].cmd, catalog, {
						mutate: true
					});
					if (!r.ok) break;
					s = r.state;
					progressed = true;
					if (s.status !== 'active') break;
				}
			} else {
				const cmds = planBotPhaseActions(s, st, catalog, botRng, profile);
				for (const c of cmds) {
					const r = applyGameCommand(s, botActorFor(s, st), c, catalog, { mutate: true });
					if (!r.ok) break;
					s = r.state;
					progressed = true;
					if (s.status !== 'active') break;
				}
			}
			if (s.status !== 'active') break;
		}
		if (!progressed && s.status === 'active') {
			const before = `${s.phase}:${s.round}`;
			applyDeadlineAdvance(s, catalog);
			if (`${s.phase}:${s.round}` === before) break;
		}
	}
	return s;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

function observationFor(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	encoder?: SearchObservationEncoder
): number[] {
	return encoder ? encoder(state, seat, catalog) : encodeObs(state, seat, catalog);
}

/** Exact solo production objective at a search leaf. The reach head is a
 * load-bearing contract: using the multiplayer value head here would silently
 * reintroduce the short-horizon/placement proxy V33 is intended to remove. */
export function soloReach30LeafValue(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	policy: NeuralPolicy,
	valueWeight: number,
	encoder?: SearchObservationEncoder,
	expectedPublicRewardVp = 0
): number {
	const player = state.players[seat];
	if (!player) return 0;
	if (player.victoryPoints >= 30) return 1;
	if (state.status !== 'active') return 0;
	const horizon = policy.reach30Horizon();
	if (horizon !== 30) {
		throw new Error(
			`solo-reach30 search requires a reach30 critic with horizon 30; got ${String(horizon)}`
		);
	}
	const reach30 = policy.reach30Probability(observationFor(state, seat, catalog, encoder));
	if (reach30 === null || !Number.isFinite(reach30) || reach30 < 0 || reach30 > 1) {
		throw new Error('solo-reach30 search requires a finite reach30 probability in [0,1]');
	}
	const w = clamp01(valueWeight);
	const rollout = clamp01((player.victoryPoints + expectedPublicRewardVp) / 30);
	return clamp01(w * reach30 + (1 - w) * rollout);
}

function leafValue(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	policy: NeuralPolicy,
	valueWeight: number,
	objective: SearchLeafObjective,
	encoder?: SearchObservationEncoder,
	expectedPublicRewardVp = 0
): number {
	if (objective === 'solo-reach30') {
		return soloReach30LeafValue(
			state,
			seat,
			catalog,
			policy,
			valueWeight,
			encoder,
			expectedPublicRewardVp
		);
	}
	if (state.status !== 'active') return outcomeForSeat(state, seat);
	const vNet = clamp01(policy.value(observationFor(state, seat, catalog, encoder)));
	const publicOutcome = outcomeForSeat(state, seat);
	const baseValue =
		valueWeight >= 1 ? vNet : valueWeight * vNet + (1 - valueWeight) * publicOutcome;
	return clamp01(baseValue + (0.3 * expectedPublicRewardVp) / 30);
}

function softmax(xs: number[]): number[] {
	let max = -Infinity;
	for (const x of xs) if (x > max) max = x;
	const exps = xs.map((x) => Math.exp(x - max));
	const sum = exps.reduce((a, b) => a + b, 0) || 1;
	return exps.map((e) => e / sum);
}

/**
 * Gumbel root search over the caller's candidates. `withNext` must come from
 * legalActionsWithNext (cmd + post-apply clone). Returns null when there is
 * nothing to search (< 2 candidates).
 */
export function planDecisionGumbel(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	policy: NeuralPolicy,
	withNext: LegalAction[],
	opts: GumbelPlanOptions = {}
): GumbelPlanResult | null {
	const N = withNext.length;
	if (N < 2) return null;
	const nSims = Math.max(2, opts.simulations ?? 16);
	const m = Math.max(2, Math.min(opts.maxConsidered ?? 8, N));
	const horizon = opts.horizonRounds ?? 6;
	if (!Number.isInteger(horizon) || horizon < 1) {
		throw new Error('Gumbel search horizonRounds must be a positive integer');
	}
	const valueWeight = clamp01(opts.valueWeight ?? 0.5);
	const objective = opts.objective ?? 'multiplayer';
	if (objective === 'solo-reach30') {
		if (Object.keys(state.players).length !== 1) {
			throw new Error('solo-reach30 search requires exactly one player');
		}
		const reach30Horizon = policy.reach30Horizon();
		if (reach30Horizon !== 30) {
			throw new Error(
				`solo-reach30 search requires a reach30 critic with horizon 30; got ${String(reach30Horizon)}`
			);
		}
	}
	const cVisit = opts.cVisit ?? 50;
	const cScale = opts.cScale ?? 1.0;
	const profile: BotProfile = {
		...(opts.rolloutProfile ?? profileFor('medium')),
		ismctsIterations: 0,
		searchRollouts: 0
	};
	const baseSeed = (opts.seed ?? state.round * 7919 + 977) >>> 0 || 1;

	// Priors over ALL candidates from the policy net.
	const obs = observationFor(state, seat, catalog, opts.encodeObservation);
	const feats = withNext.map((x) =>
		encodeAction(state, seat, x.cmd, policyPreviewState(x), catalog)
	);
	const logits = policy.scoreCandidates(obs, feats);

	// Seed-derived uniform stream: Gumbel noise + the π' sample stay reproducible.
	const noiseRng = createRng((baseSeed ^ 0x9e3779b9) >>> 0 || 1);
	const uniform = (): number => (nextInt(noiseRng, 1_073_741_824) + 0.5) / 1_073_741_824;
	const gumbel = (): number => -Math.log(-Math.log(uniform()));
	const g = withNext.map(() => gumbel());

	// Gumbel-Top-m: candidates ranked by g + logit.
	const order = withNext.map((_, i) => i).sort((a, b) => g[b] + logits[b] - (g[a] + logits[a]));
	let survivors = order.slice(0, m);

	const visits = new Array<number>(N).fill(0);
	const qSum = new Array<number>(N).fill(0);
	const qMean = (i: number): number => (visits[i] > 0 ? qSum[i] / visits[i] : 0);

	const simulate = (i: number): void => {
		const action = withNext[i];
		if (action.hasHiddenOutcome) {
			// A root search must not descend from the dry-run's already-realized roll/draw.
			// Score the masked public state as a leaf, adding only analytically expected
			// monster-reward value. Other hidden outcomes remain represented by the policy
			// prior/value until they have an explicit public expectation model.
			const publicState = policyPreviewState(action);
			const combatExpectedVp =
				action.cmd.type === 'startCombat'
					? combatActionExpectation(state, seat, catalog).expectedRewardVp
					: 0;
			const value = leafValue(
				publicState,
				seat,
				catalog,
				policy,
				valueWeight,
				objective,
				opts.encodeObservation,
				combatExpectedVp
			);
			visits[i] += 1;
			qSum[i] += value;
			return;
		}
		const simSeed = (baseSeed + (visits[i] + 1) * 2654435761 + i * 40503) >>> 0 || 1;
		let s = determinizeForSearch(policyPreviewState(action), seat, simSeed);
		const botRng: BotRandom = {
			int: (mm: number) => nextInt(s.rng, mm),
			chance: () => nextInt(s.rng, 2) === 0
		};
		s = rolloutPolicyToRound(
			s,
			catalog,
			profile,
			botRng,
			state.round + horizon - 1,
			opts.rolloutChoose
		);
		const value = leafValue(
			s,
			seat,
			catalog,
			policy,
			valueWeight,
			objective,
			opts.encodeObservation
		);
		visits[i] += 1;
		qSum[i] += value;
	};

	// SEQUENTIAL HALVING: equal share per phase, survivors halve each round.
	const phases = Math.max(1, Math.ceil(Math.log2(m)));
	let budget = nSims;
	for (let ph = 0; ph < phases && survivors.length > 1; ph++) {
		const remainingPhases = phases - ph;
		const perCand = Math.max(1, Math.floor(budget / remainingPhases / survivors.length));
		for (const i of survivors) {
			for (let k = 0; k < perCand && budget > 0; k++) {
				simulate(i);
				budget--;
			}
		}
		survivors = [...survivors].sort(
			(a, b) =>
				g[b] +
				logits[b] +
				sigmaQ(qMean(b), visits, cVisit, cScale) -
				(g[a] + logits[a] + sigmaQ(qMean(a), visits, cVisit, cScale))
		);
		survivors = survivors.slice(0, Math.max(1, Math.ceil(survivors.length / 2)));
	}
	// Spend any remainder on the front-runner (cheap variance reduction).
	while (budget > 0 && survivors.length > 0) {
		simulate(survivors[0]);
		budget--;
	}

	// Completed Q: visited → empirical mean; unvisited → prior-weighted mean of
	// the visited estimates (v_mix), so σ never invents signal for unseen arms.
	const pri = softmax(logits);
	let wSum = 0;
	let wQ = 0;
	for (let i = 0; i < N; i++) {
		if (visits[i] > 0) {
			wSum += pri[i];
			wQ += pri[i] * qMean(i);
		}
	}
	const vMix = wSum > 0 ? wQ / wSum : 0.5;
	const completed = withNext.map((_, i) => (visits[i] > 0 ? qMean(i) : vMix));
	const maxN = Math.max(...visits);
	const improved = logits.map((l, i) => l + (cVisit + maxN) * cScale * completed[i]);
	const pi = softmax(improved);

	// Action: halving winner, or a temperature sample from π' (navigation MUST mix).
	let index = survivors[0] ?? order[0];
	const T = opts.temperature ?? 0;
	if (T > 0) {
		const rand = opts.rand ?? uniform;
		const tempered = softmax(improved.map((x) => x / T));
		let r = rand();
		index = N - 1;
		for (let i = 0; i < N; i++) {
			r -= tempered[i];
			if (r <= 0) {
				index = i;
				break;
			}
		}
	}

	return { index, pi, q: withNext.map((_, i) => qMean(i)), visits, logits };
}

function sigmaQ(q: number, visits: number[], cVisit: number, cScale: number): number {
	let maxN = 0;
	for (const v of visits) if (v > maxN) maxN = v;
	return (cVisit + maxN) * cScale * q;
}
