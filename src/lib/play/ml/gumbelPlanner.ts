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
import { createRng, nextInt } from '../rng';
import {
	botActorFor,
	botSeatNeedsToAct,
	planBotPhaseActions,
	profileFor,
	type BotProfile,
	type BotRandom
} from '../server/botPolicy';
import type { PlayCatalog, PublicGameState, SeatColor } from '../types';
import type { LegalAction } from './actions';
import { encodeObs, encodeAction } from './encode';
import type { NeuralPolicy } from './net';

export interface GumbelPlanOptions {
	/** Total simulation budget n across all candidates. */
	simulations?: number;
	/** Gumbel-Top-m: max root candidates considered. */
	maxConsidered?: number;
	/** Rounds of lookahead before the leaf is scored. */
	horizonRounds?: number;
	/** Leaf blend: value = w·V_net + (1−w)·playoutOutcome. */
	valueWeight?: number;
	/** Completed-Q transform scale: σ(q) = (cVisit + maxN)·cScale·q. */
	cVisit?: number;
	cScale?: number;
	/** Heuristic profile that plays ALL seats inside rollouts. */
	rolloutProfile?: BotProfile;
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
function determinize(state: PublicGameState, seat: SeatColor, simSeed: number): PublicGameState {
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

/** Advance a determinized state with every seat played by `profile` until
 *  game end / stopRound. Same drain shape as advanceAfterNav (botPolicy.ts). */
function rollout(
	s: PublicGameState,
	catalog: PlayCatalog,
	profile: BotProfile,
	botRng: BotRandom,
	stopRound: number
): PublicGameState {
	let ticks = 0;
	while (s.status === 'active' && s.round <= stopRound) {
		if (++ticks > 4000) break;
		let progressed = false;
		for (const st of s.activeSeats) {
			if (!botSeatNeedsToAct(s, st)) continue;
			const cmds = planBotPhaseActions(s, st, catalog, botRng, profile);
			for (const c of cmds) {
				const r = applyGameCommand(s, botActorFor(s, st), c, catalog, { mutate: true });
				if (!r.ok) break;
				s = r.state;
				progressed = true;
				if (s.status !== 'active') break;
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
	const valueWeight = clamp01(opts.valueWeight ?? 0.5);
	const cVisit = opts.cVisit ?? 50;
	const cScale = opts.cScale ?? 1.0;
	const profile: BotProfile = {
		...(opts.rolloutProfile ?? profileFor('medium')),
		ismctsIterations: 0,
		searchRollouts: 0
	};
	const baseSeed = (opts.seed ?? (state.round * 7919 + 977)) >>> 0 || 1;

	// Priors over ALL candidates from the policy net.
	const obs = encodeObs(state, seat);
	const feats = withNext.map((x) => encodeAction(state, seat, x.cmd, x.next, catalog));
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
		const simSeed = (baseSeed + (visits[i] + 1) * 2654435761 + i * 40503) >>> 0 || 1;
		let s = determinize(withNext[i].next, seat, simSeed);
		const botRng: BotRandom = {
			int: (mm: number) => nextInt(s.rng, mm),
			chance: () => nextInt(s.rng, 2) === 0
		};
		s = rollout(s, catalog, profile, botRng, state.round + horizon);
		const vNet = clamp01(policy.value(encodeObs(s, seat)));
		const value =
			valueWeight >= 1 || s.status !== 'active'
				? s.status !== 'active'
					? outcomeForSeat(s, seat)
					: vNet
				: valueWeight * vNet + (1 - valueWeight) * outcomeForSeat(s, seat);
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
				g[b] + logits[b] + sigmaQ(qMean(b), visits, cVisit, cScale) -
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
