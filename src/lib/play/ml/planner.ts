/**
 * Neural-guided ISMCTS planner — the planning core of the ML bot.
 *
 * The deployed candidate-scoring net is a 1-STEP scorer: it cannot represent a multi-round plan
 * ("go to the Abyss every round, build to survive the escalating monster, farm the reward track")
 * because the payoff is many decisions away. This module adds the missing lookahead: a real
 * Information-Set MCTS over the NAVIGATION skeleton (where to lock each round = the strategic plan),
 * using the engine as a perfect forward model.
 *
 * AlphaZero design (see ml/PLANNING_ARCHITECTURE.md):
 *   • SELECTION/EXPANSION by PUCT  =  Q(s,a) + c·P(s,a)·√ΣN / (1+N(s,a))
 *       P(s,a) = the learned POLICY's softmax over the legal lockNavigation candidates.
 *   • LEAF EVALUATION = the learned VALUE net  V(encodeObs(leaf)) ∈ [0,1], optionally BLENDED with a
 *       short heuristic playout-to-outcome (valueWeight knob) so search is meaningful BEFORE the
 *       value net is trained, annealing to pure value as it improves.
 *   • Determinization: solo-isolate our seat + reseed the engine RNG each iteration (handles hidden
 *       bags + dice), mirroring the existing heuristic ISMCTS.
 *   • Within-round micro-execution (rows/summons/fights/claims) is delegated to `advanceAfterNav`'s
 *       rollout profile — a heuristic teacher during bootstrap; swapped to the net later.
 *
 * Returns the chosen lockNavigation command PLUS the root visit distribution `pi` — the
 * search-improved policy target the self-play recorder trains the net to match.
 */

import { applyGameCommand } from '../runtime';
import { createRng, nextInt } from '../rng';
import {
	legalDestinations,
	advanceAfterNav,
	botActorFor,
	botSeatNeedsToAct,
	planBotPhaseActions,
	profileFor,
	type BotProfile,
	type BotRandom
} from '../server/botPolicy';
import { applyDeadlineAdvance } from '../runtime';
import type {
	GameCommand,
	NavigationDestination,
	PlayCatalog,
	PublicGameState,
	SeatColor
} from '../types';
import { encodeObs, encodeAction } from './encode';
import { evaluateFarmValue } from './farmValue';
import type { NeuralPolicy } from './net';

export interface PlanOptions {
	/** MCTS iterations (tree descents) per decision. More = stronger + slower. */
	iterations?: number;
	/** Rounds of lookahead inside the determinized search. */
	horizon?: number;
	/** PUCT exploration constant. */
	c?: number;
	/** Leaf-eval blend: value = w·V_net + (1−w)·heuristicOutcome. 1 = pure value net. */
	valueWeight?: number;
	/** Optional policy used only for root navigation priors. Leaf value still uses `policy`. */
	priorPolicy?: NeuralPolicy;
	/**
	 * Optional root destination filter for diagnostic option policies. If the filter
	 * removes every legal destination, the planner falls back to the full legal set.
	 */
	rootDestinations?: NavigationDestination[];
	/**
	 * Diagnostic farm-value prior: adds a root logit bonus to Arcane Abyss equal to
	 * `farmValueBonus * farmValue.score`. Off by default; use only for paired eval/training probes.
	 */
	farmValueBonus?: number;
	/** Minimum normalized farm-value score required before the diagnostic farm prior applies. */
	farmValueThreshold?: number;
	/** Which farm-value signal powers the diagnostic Arcane root prior. Defaults to the old heuristic. */
	farmValueSource?: 'heuristic' | 'head' | 'max' | 'sum';
	/** Optional monster HP lower gate for the diagnostic Arcane root prior. */
	farmValueMinMonsterHp?: number;
	/** Optional monster HP upper gate for the diagnostic Arcane root prior. */
	farmValueMaxMonsterHp?: number;
	/** Optional player status upper gate for the diagnostic Arcane root prior. */
	farmValueMaxStatusLevel?: number;
	/** Heuristic profile used for within-round execution + the playout blend during bootstrap. */
	rolloutProfile?: BotProfile;
	/** Base seed for reproducible determinizations. */
	seed?: number;
}

export interface PlanResult {
	/** The robust (most-visited) lockNavigation command to play. */
	command: GameCommand;
	/** Root candidate destinations, aligned with `visits`/`pi`. */
	destinations: NavigationDestination[];
	/** Raw visit counts per root destination. */
	visits: number[];
	/** Normalized visit distribution — the search-improved policy target. */
	pi: number[];
	/** Policy-net priors per destination (for diagnostics). */
	priors: number[];
	/** Mean backed-up value per root destination (for diagnostics). */
	rootQ: number[];
	/** Farm-prior score used for the Arcane root bonus, if any. */
	farmPriorScore: number;
	/** Actual Arcane root logit bonus added by the diagnostic farm prior. */
	farmPriorBonus: number;
	/** Whether a positive diagnostic farm-prior bonus was applied. */
	farmPriorApplied: boolean;
}

interface PlanNode {
	children: Map<NavigationDestination, PlanNode>;
	visits: number;
	value: number; // summed leaf values (∈[0,1] each)
}
const newNode = (): PlanNode => ({ children: new Map(), visits: 0, value: 0 });
const FARM_VALUE_AUX_SHAPE =
	process.env.ARC_FARM_VALUE_AUX_SHAPE !== undefined ? parseFloat(process.env.ARC_FARM_VALUE_AUX_SHAPE) : 0.25;

function softmax(xs: number[]): number[] {
	let max = -Infinity;
	for (const x of xs) if (x > max) max = x;
	const exps = xs.map((x) => Math.exp(x - max));
	const sum = exps.reduce((a, b) => a + b, 0) || 1;
	return exps.map((e) => e / sum);
}
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

function farmValueBonus(policy: NeuralPolicy, obs: number[]): number {
	const fn = (policy as unknown as { farmValue?: (obs: number[]) => number }).farmValue;
	if (FARM_VALUE_AUX_SHAPE <= 0 || typeof fn !== 'function') return 0;
	const raw = fn.call(policy, obs);
	if (!Number.isFinite(raw)) return 0;
	return FARM_VALUE_AUX_SHAPE * Math.max(0, Math.min(1, raw));
}

function farmValueHeadScore(policy: NeuralPolicy, obs: number[]): number {
	const fn = (policy as unknown as { farmValue?: (obs: number[]) => number }).farmValue;
	if (typeof fn !== 'function') return 0;
	const raw = fn.call(policy, obs);
	return Number.isFinite(raw) ? clamp01(raw) : 0;
}

function passesFarmPriorGates(
	state: PublicGameState,
	seat: SeatColor,
	opts: PlanOptions
): boolean {
	const player = state.players[seat];
	const monster = state.monster;
	if (!player || !monster || monster.livesRemaining <= 0) return false;
	const hp = monster.hp ?? monster.maxHp ?? 0;
	if (opts.farmValueMinMonsterHp !== undefined && hp < opts.farmValueMinMonsterHp) return false;
	if (opts.farmValueMaxMonsterHp !== undefined && hp > opts.farmValueMaxMonsterHp) return false;
	if (opts.farmValueMaxStatusLevel !== undefined && (player.statusLevel ?? 0) > opts.farmValueMaxStatusLevel) {
		return false;
	}
	return true;
}

function farmPriorScore(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	policy: NeuralPolicy,
	obs: number[],
	opts: PlanOptions
): number {
	const source = opts.farmValueSource ?? 'heuristic';
	const heuristic = (): number => {
		const farm = evaluateFarmValue(state, seat, catalog, { threshold: 0 });
		return farm.valid ? farm.score : 0;
	};
	const head = (): number => (passesFarmPriorGates(state, seat, opts) ? farmValueHeadScore(policy, obs) : 0);
	if (source === 'head') return head();
	if (source === 'max') return Math.max(heuristic(), head());
	if (source === 'sum') return clamp01(heuristic() + head());
	return heuristic();
}

/** Heuristic playout to game-end / horizon, returning the seat's normalized OUTCOME ∈ [0,1]. */
function playoutOutcome(
	s: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	rolloutProfile: BotProfile,
	botRng: BotRandom,
	stopRound: number
): number {
	let ticks = 0;
	while (s.status === 'active' && s.round <= stopRound) {
		if (++ticks > 8000) break;
		let progressed = false;
		for (const st of s.activeSeats) {
			if (!botSeatNeedsToAct(s, st)) continue;
			const cmds = planBotPhaseActions(s, st, catalog, botRng, rolloutProfile);
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
	const p = s.players[seat];
	if (!p) return 0;
	// PURE VP outcome ∈ [0,1] = normalized victory points (VP_TO_WIN=30). Strategy-agnostic: the bot
	// maximizes points, discovering whatever line scores. NOTE: we deliberately do NOT use the win
	// flag — a solo determinization makes `seat` the trivial `winnerSeat` at the cap regardless of VP,
	// which would collapse every playout to a constant; VP magnitude differentiates cleanly.
	return clamp01(p.victoryPoints / 30);
}

/** Leaf value ∈ [0,1] for `seat` at determinized state `s`. */
function leafValue(
	s: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	policy: NeuralPolicy,
	valueWeight: number,
	rolloutProfile: BotProfile,
	botRng: BotRandom,
	stopRound: number
): number {
	const obs = encodeObs(s, seat);
	const vNet = clamp01(policy.value(obs) + farmValueBonus(policy, obs));
	if (valueWeight >= 1) return vNet;
	const vRollout = playoutOutcome(s, seat, catalog, rolloutProfile, botRng, stopRound);
	return valueWeight * vNet + (1 - valueWeight) * vRollout;
}

/** PUCT score for a child (or an unexpanded action with N=0). */
function puct(parentVisits: number, child: PlanNode | undefined, prior: number, c: number): number {
	const n = child?.visits ?? 0;
	const q = child && n > 0 ? child.value / n : 0; // FPU = 0 (pessimistic for unseen)
	return q + c * prior * Math.sqrt(parentVisits + 1) / (1 + n);
}

/**
 * Plan the navigation decision at `state` for `seat` with neural-guided ISMCTS.
 * Returns null when there is nothing to search (not a navigation decision, no legal destinations).
 */
export function neuralPlanNavigation(
	state: PublicGameState,
	seat: SeatColor,
	catalog: PlayCatalog,
	policy: NeuralPolicy,
	opts: PlanOptions = {}
): PlanResult | null {
	if (state.phase !== 'navigation' || !botSeatNeedsToAct(state, seat)) return null;
	const rawRootLegal = legalDestinations(state, seat, catalog);
	const allowed = opts.rootDestinations?.length ? new Set<NavigationDestination>(opts.rootDestinations) : null;
	const filteredRootLegal = allowed ? rawRootLegal.filter((d) => allowed.has(d)) : rawRootLegal;
	const rootLegal = filteredRootLegal.length > 0 ? filteredRootLegal : rawRootLegal;
	if (rootLegal.length === 0) return null;

	const iterations = opts.iterations ?? 64;
	const horizon = opts.horizon ?? 36;
	const C = opts.c ?? 1.5;
	const valueWeight = opts.valueWeight ?? 0.5;
	const farmValueBonus = Math.max(0, opts.farmValueBonus ?? 0);
	const farmValueThreshold = Math.max(0, opts.farmValueThreshold ?? 0);
	const rolloutProfile: BotProfile = {
		...(opts.rolloutProfile ?? profileFor('medium')),
		ismctsIterations: 0,
		searchRollouts: 0
	};
	const baseSeed = (opts.seed ?? (state.round * 1009 + 12345)) >>> 0 || 1;

	// Root priors P(dest) from the learned navigation-prior policy over legal lockNavigation candidates.
	const priorPolicy = opts.priorPolicy ?? policy;
	const rootObs = encodeObs(state, seat);
	const priorFeats = rootLegal.map((dest) => {
		const cmd: GameCommand = { type: 'lockNavigation', destination: dest };
		const r = applyGameCommand(state, botActorFor(state, seat), cmd, catalog); // clone (no mutate)
		const next = r.ok ? r.state : state;
		return encodeAction(state, seat, cmd, next, catalog);
	});
	const priorLogits = priorPolicy.scoreCandidates(rootObs, priorFeats);
	let farmPriorScoreForRoot = 0;
	let farmPriorBonusForRoot = 0;
	if (farmValueBonus > 0 && rootLegal.includes('Arcane Abyss' as (typeof rootLegal)[number])) {
		const score = farmPriorScore(state, seat, catalog, policy, rootObs, opts);
		farmPriorScoreForRoot = score;
		if (score > 0 && score >= farmValueThreshold) {
			const abyssIndex = rootLegal.indexOf('Arcane Abyss' as (typeof rootLegal)[number]);
			farmPriorBonusForRoot = farmValueBonus * score;
			if (abyssIndex >= 0) priorLogits[abyssIndex] += farmPriorBonusForRoot;
		}
	}
	const priorArr = softmax(priorLogits);
	const priorOf = new Map<NavigationDestination, number>();
	rootLegal.forEach((d, i) => priorOf.set(d, priorArr[i]));

	const root = newNode();
	for (let iter = 0; iter < iterations; iter++) {
		// Determinization: solo-isolate our seat + a fresh bag/dice seed.
		let s = structuredClone(state) as PublicGameState;
		s.activeSeats = [seat];
		for (const k of Object.keys(s.players)) {
			if (k !== seat) delete (s.players as Record<string, unknown>)[k];
		}
		const seed = (baseSeed + iter * 2654435761) >>> 0 || 1;
		s.rng = createRng(seed);
		const botRng: BotRandom = {
			int: (m: number) => nextInt(s.rng, m),
			chance: () => nextInt(s.rng, 2) === 0
		};
		const stopRound = state.round + horizon;

		const path: PlanNode[] = [root];
		let node = root;
		// SELECTION + EXPANSION over the navigation skeleton.
		while (
			s.status === 'active' &&
			s.round <= stopRound &&
			s.phase === 'navigation' &&
			botSeatNeedsToAct(s, seat)
		) {
			const legal = legalDestinations(s, seat, catalog);
			if (legal.length === 0) break;
			const priorsHere =
				node === root
					? priorOf
					: null; // deeper nodes: uniform prior (cheap; root prior is what matters for the target)
			const untried = legal.filter((d) => !node.children.has(d));
			let dest: NavigationDestination;
			if (untried.length > 0) {
				// Expand the highest-prior untried child.
				dest = untried[0];
				if (priorsHere) {
					let bestP = -Infinity;
					for (const d of untried) {
						const p = priorsHere.get(d) ?? 0;
						if (p > bestP) {
							bestP = p;
							dest = d;
						}
					}
				}
				const child = newNode();
				node.children.set(dest, child);
				node = child;
				path.push(node);
				s = advanceAfterNav(s, seat, catalog, dest, rolloutProfile, botRng, stopRound);
				break; // expanded one node → evaluate from here
			}
			// All children tried here → PUCT-select.
			let best = legal[0];
			let bestScore = -Infinity;
			const uni = 1 / legal.length;
			for (const d of legal) {
				const p = priorsHere ? (priorsHere.get(d) ?? uni) : uni;
				const score = puct(node.visits, node.children.get(d), p, C);
				if (score > bestScore) {
					bestScore = score;
					best = d;
				}
			}
			dest = best;
			node = node.children.get(dest)!;
			path.push(node);
			s = advanceAfterNav(s, seat, catalog, dest, rolloutProfile, botRng, stopRound);
		}
		// LEAF EVAL + BACKPROP.
		const value = leafValue(s, seat, catalog, policy, valueWeight, rolloutProfile, botRng, stopRound);
		for (const n of path) {
			n.visits += 1;
			n.value += value;
		}
	}

	// Extract root visit distribution + robust (most-visited) choice.
	const visits = rootLegal.map((d) => root.children.get(d)?.visits ?? 0);
	const total = visits.reduce((a, b) => a + b, 0) || 1;
	const pi = visits.map((v) => v / total);
	let bestI = 0;
	for (let i = 1; i < visits.length; i++) if (visits[i] > visits[bestI]) bestI = i;
	const rootQ = rootLegal.map((d) => {
		const ch = root.children.get(d);
		return ch && ch.visits > 0 ? ch.value / ch.visits : 0;
	});
	return {
		command: { type: 'lockNavigation', destination: rootLegal[bestI] },
		destinations: rootLegal,
		visits,
		pi,
		priors: priorArr,
		rootQ,
		farmPriorScore: farmPriorScoreForRoot,
		farmPriorBonus: farmPriorBonusForRoot,
		farmPriorApplied: farmPriorBonusForRoot > 0
	};
}
