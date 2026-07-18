/**
 * Unit tests for the Gumbel root-search planner (gumbelPlanner.ts).
 *
 * The info-safety test is the load-bearing one: bots run server-side on the
 * FULL state, so opponents' secret pre-reveal `pendingDestination` is visible
 * to the process. The planner must be INVARIANT to it — same seed, different
 * hidden opponent locks, identical result — which black-box-proves the
 * determinizer strips the secret before any rollout reads it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { applyGameCommand } from '../runtime';
import { createRng, nextInt } from '../rng';
import {
	SEAT_COLORS,
	type GameActor,
	type PlayCatalog,
	type PublicGameState,
	type SeatColor
} from '../types';
import { loadOrSnapshotCatalog } from './nodeIo';
import { NeuralPolicy, type PolicyWeights, type LinearLayer } from './net';
import { OBS_DIM, ACT_DIM, encodeObs } from './encode';
import { legalActionsWithNext } from './actions';
import {
	planDecisionGumbel,
	outcomeForSeat,
	searchInvocationSeed,
	soloReach30LeafValue
} from './gumbelPlanner';
import { normalizedRanks, planDecisionCriticRerank } from './criticReranker';

function randomPolicy(
	seed: number,
	reach30?: { probability: number; horizon: number }
): NeuralPolicy {
	const rng = createRng(seed);
	const g = (): number => (nextInt(rng, 20001) / 10000 - 1) * 0.1;
	const lin = (out: number, inn: number): LinearLayer => ({
		W: Array.from({ length: out }, () => Array.from({ length: inn }, g)),
		b: Array.from({ length: out }, () => 0)
	});
	const w: PolicyWeights = {
		format: 'arc-cand-scorer-v1',
		obs_dim: OBS_DIM,
		act_dim: ACT_DIM,
		trunk: [lin(32, OBS_DIM + ACT_DIM), lin(1, 32)],
		value: [lin(16, OBS_DIM), lin(1, 16)],
		...(reach30
			? {
					reach30: [
						{
							W: [Array<number>(OBS_DIM).fill(0)],
							b: [Math.log(reach30.probability / (1 - reach30.probability))]
						}
					],
					reach30_horizon: reach30.horizon
				}
			: {})
	};
	return new NeuralPolicy(w);
}

let catalog: PlayCatalog;
let navState: PublicGameState;
const seats = SEAT_COLORS.slice(0, 4) as SeatColor[];
const focus = seats[0];
const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };

beforeAll(async () => {
	catalog = await loadOrSnapshotCatalog();
	const { createLobbyState } = await import('../runtime');
	const guardianNames = catalog.guardians.map((gd) => gd.name).slice(0, 4);
	let state = createLobbyState({ roomCode: 'GMBL', guardianNames });
	const ok = (r: ReturnType<typeof applyGameCommand>): void => {
		if (!r.ok) throw new Error(`${r.error.code} ${r.error.message}`);
		state = r.state;
	};
	seats.forEach((seat, i) => {
		const mid = `bot-${seat}`;
		ok(
			applyGameCommand(
				state,
				{ memberId: mid, displayName: seat, role: 'player', seatColor: null },
				{ type: 'claimSeat', seatColor: seat },
				catalog
			)
		);
		ok(
			applyGameCommand(
				state,
				{ memberId: mid, displayName: seat, role: 'player', seatColor: seat },
				{ type: 'selectGuardian', guardianName: guardianNames[i] },
				catalog
			)
		);
	});
	ok(applyGameCommand(state, host, { type: 'startGame', seed: 424242 }, catalog));
	if (state.phase !== 'navigation') throw new Error(`expected navigation, got ${state.phase}`);
	navState = state;
});

const OPTS = { simulations: 8, maxConsidered: 4, horizonRounds: 2, valueWeight: 0.5, seed: 777 };

describe('gumbel planner', () => {
	it('returns a valid improved policy and spends the budget', () => {
		const cands = legalActionsWithNext(navState, focus, catalog);
		expect(cands.length).toBeGreaterThan(1);
		const res = planDecisionGumbel(navState, focus, catalog, randomPolicy(1), cands, OPTS);
		expect(res).not.toBeNull();
		expect(res!.pi).toHaveLength(cands.length);
		expect(Math.abs(res!.pi.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-6);
		for (const p of res!.pi) expect(p).toBeGreaterThanOrEqual(0);
		expect(res!.visits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(OPTS.simulations);
		expect(res!.index).toBeGreaterThanOrEqual(0);
		expect(res!.index).toBeLessThan(cands.length);
		// The winner must have been simulated, not just prior-ranked.
		expect(res!.visits[res!.index]).toBeGreaterThan(0);
	});

	it('is deterministic for a fixed seed and differs across seeds', () => {
		const cands = legalActionsWithNext(navState, focus, catalog);
		const policy = randomPolicy(2);
		const a = planDecisionGumbel(navState, focus, catalog, policy, cands, OPTS)!;
		const b = planDecisionGumbel(navState, focus, catalog, policy, cands, OPTS)!;
		expect(a.index).toBe(b.index);
		expect(a.pi).toEqual(b.pi);
		expect(a.visits).toEqual(b.visits);
		// A particular adjacent seed can legitimately land on the same Gumbel top-m set.
		// Check a small deterministic seed family so this asserts seed sensitivity without
		// depending on one random-policy/action-width coincidence.
		const alternatives = Array.from(
			{ length: 8 },
			(_, offset) =>
				planDecisionGumbel(navState, focus, catalog, policy, cands, {
					...OPTS,
					seed: 778 + offset
				})!
		);
		expect(
			alternatives.some(
				(candidate) =>
					JSON.stringify(candidate.pi) !== JSON.stringify(a.pi) ||
					JSON.stringify(candidate.visits) !== JSON.stringify(a.visits)
			)
		).toBe(true);
	});

	it('keys replay streams by the positive per-game invocation ordinal', () => {
		const first = searchInvocationSeed(952000123, 17, 1, focus);
		expect(searchInvocationSeed(952000123, 17, 1, focus)).toBe(first);
		expect(searchInvocationSeed(952000123, 17, 2, focus)).not.toBe(first);
		expect(searchInvocationSeed(952000123, 17, 1, focus, 'heuristic-s4-h2')).not.toBe(first);
		expect(searchInvocationSeed(952000123, 17, 1, focus, 'heuristic-s8-h3')).not.toBe(
			searchInvocationSeed(952000123, 17, 1, focus, 'heuristic-s4-h2')
		);
		expect(() => searchInvocationSeed(952000123, 17, 0, focus)).toThrow(/positive/);
	});

	it('rejects a zero or fractional lookahead horizon before simulation', () => {
		const cands = legalActionsWithNext(navState, focus, catalog);
		const policy = randomPolicy(29);
		for (const horizonRounds of [0, 1.5]) {
			expect(() =>
				planDecisionGumbel(navState, focus, catalog, policy, cands, {
					...OPTS,
					horizonRounds
				})
			).toThrow(/positive integer/);
		}
	});

	it("is INVARIANT to opponents' secret pre-reveal destination locks", () => {
		const cands = legalActionsWithNext(navState, focus, catalog);
		const policy = randomPolicy(3);
		const base = planDecisionGumbel(navState, focus, catalog, policy, cands, OPTS)!;

		const leaky = structuredClone(navState) as PublicGameState;
		for (const s of seats) {
			const p = leaky.players[s];
			if (s !== focus && p) p.pendingDestination = 'Arcane Abyss';
		}
		const candsLeaky = legalActionsWithNext(leaky, focus, catalog);
		const withSecret = planDecisionGumbel(leaky, focus, catalog, policy, candsLeaky, OPTS)!;
		expect(withSecret.index).toBe(base.index);
		expect(withSecret.pi).toEqual(base.pi);
		expect(withSecret.q).toEqual(base.q);
	});

	it('temperature sampling is reproducible with an injected rand', () => {
		const cands = legalActionsWithNext(navState, focus, catalog);
		const policy = randomPolicy(4);
		const mk = (): number =>
			planDecisionGumbel(navState, focus, catalog, policy, cands, {
				...OPTS,
				temperature: 1.0,
				rand: (() => {
					const r = createRng(99);
					return () => (nextInt(r, 1 << 30) + 0.5) / (1 << 30);
				})()
			})!.index;
		expect(mk()).toBe(mk());
	});

	it('outcomeForSeat: winner pinned to 1, placement ordered by VP', () => {
		const s = structuredClone(navState) as PublicGameState;
		const [a, b, c, d] = seats;
		s.players[a]!.victoryPoints = 12;
		s.players[b]!.victoryPoints = 6;
		s.players[c]!.victoryPoints = 6;
		s.players[d]!.victoryPoints = 0;
		const oa = outcomeForSeat(s, a);
		const ob = outcomeForSeat(s, b);
		const oc = outcomeForSeat(s, c);
		const od = outcomeForSeat(s, d);
		expect(oa).toBeGreaterThan(ob);
		expect(ob).toBeCloseTo(oc, 10);
		expect(oc).toBeGreaterThan(od);
		s.winnerSeat = a;
		expect(outcomeForSeat(s, a)).toBe(1);
	});

	it('solo-reach30 leaf freezes active, terminal, success, and public expectation semantics', () => {
		const s = structuredClone(navState) as PublicGameState;
		for (const other of seats.slice(1)) delete s.players[other];
		s.activeSeats = [focus];
		s.players[focus]!.victoryPoints = 12;
		const policy = randomPolicy(5, { probability: 0.8, horizon: 30 });
		expect(soloReach30LeafValue(s, focus, catalog, policy, 0.5)).toBeCloseTo(0.6, 10);
		expect(soloReach30LeafValue(s, focus, catalog, policy, 0.5, undefined, 3)).toBeCloseTo(
			0.65,
			10
		);
		s.status = 'finished';
		expect(soloReach30LeafValue(s, focus, catalog, policy, 0.5)).toBe(0);
		s.players[focus]!.victoryPoints = 30;
		expect(soloReach30LeafValue(s, focus, catalog, policy, 0.5)).toBe(1);
	});

	it('solo-reach30 fails closed on an absent or wrong-horizon critic', () => {
		const s = structuredClone(navState) as PublicGameState;
		for (const other of seats.slice(1)) delete s.players[other];
		s.activeSeats = [focus];
		expect(() => soloReach30LeafValue(s, focus, catalog, randomPolicy(6), 0.5)).toThrow(
			/horizon 30/
		);
		expect(() =>
			soloReach30LeafValue(
				s,
				focus,
				catalog,
				randomPolicy(7, { probability: 0.7, horizon: 35 }),
				0.5
			)
		).toThrow(/got 35/);
	});

	it('uses the injected observation schema for both root priors and solo leaves', () => {
		const s = structuredClone(navState) as PublicGameState;
		for (const other of seats.slice(1)) delete s.players[other];
		s.activeSeats = [focus];
		const cands = legalActionsWithNext(s, focus, catalog);
		let calls = 0;
		const res = planDecisionGumbel(
			s,
			focus,
			catalog,
			randomPolicy(8, { probability: 0.7, horizon: 30 }),
			cands,
			{
				...OPTS,
				objective: 'solo-reach30',
				encodeObservation: (state, seat) => {
					calls += 1;
					return encodeObs(state, seat, catalog);
				}
			}
		);
		expect(res).not.toBeNull();
		expect(calls).toBeGreaterThan(1);
	});
});

describe('V34 critic reranker', () => {
	const soloNavigation = (): PublicGameState => {
		const state = structuredClone(navState) as PublicGameState;
		for (const other of seats.slice(1)) delete state.players[other];
		state.activeSeats = [focus];
		return state;
	};

	it('normalizes exact ties to their average rank', () => {
		expect(normalizedRanks([4, 1, 4, 2])).toEqual([5 / 6, 0, 5 / 6, 1 / 3]);
		expect(normalizedRanks([7, 7])).toEqual([0.5, 0.5]);
		expect(() => normalizedRanks([0, Number.NaN])).toThrow(/non-finite/);
	});

	it('uses exactly one batched critic call for every unresolved preview', () => {
		const state = soloNavigation();
		const actions = legalActionsWithNext(state, focus, catalog);
		expect(actions.length).toBeGreaterThan(1);
		const policy = randomPolicy(31, { probability: 0.5, horizon: 30 });
		policy.scoreCandidates = () => actions.map(() => 0);
		let batches = 0;
		let batchSize = 0;
		policy.reach30Probabilities = (observations) => {
			batches += 1;
			batchSize = observations.length;
			return observations.map((_, index) => (index === 0 ? 0.9 : 0.1));
		};
		const result = planDecisionCriticRerank(state, focus, catalog, policy, actions, {
			policyRankWeight: 0.5
		})!;
		expect(batches).toBe(1);
		expect(batchSize).toBe(actions.length);
		expect(result.index).toBe(0);
		expect(result.pi.reduce((sum, value) => sum + value, 0)).toBe(1);
	});

	it('runs the weight-1 argmax control without a critic request', () => {
		const state = soloNavigation();
		const actions = legalActionsWithNext(state, focus, catalog);
		const policy = randomPolicy(32, { probability: 0.5, horizon: 30 });
		policy.scoreCandidates = () => actions.map((_, index) => index);
		policy.reach30Probabilities = () => {
			throw new Error('argmax control must not call the critic');
		};
		const result = planDecisionCriticRerank(state, focus, catalog, policy, actions, {
			policyRankWeight: 1
		})!;
		expect(result.index).toBe(actions.length - 1);
		expect(result.criticProbabilities.every((value) => value === null)).toBe(true);
	});

	it('fails closed when the root policy returns the wrong number of logits', () => {
		const state = soloNavigation();
		const actions = legalActionsWithNext(state, focus, catalog);
		const policy = randomPolicy(320, { probability: 0.5, horizon: 30 });
		policy.scoreCandidates = () => [];
		expect(() =>
			planDecisionCriticRerank(state, focus, catalog, policy, actions, {
				policyRankWeight: 1
			})
		).toThrow(/0 root logits/);
	});

	it('is replay deterministic, ignores hidden realized next states, and breaks full ties by order', () => {
		const state = soloNavigation();
		const actions = legalActionsWithNext(state, focus, catalog);
		const policy = randomPolicy(321, { probability: 0.5, horizon: 30 });
		policy.scoreCandidates = () => actions.map(() => 0);
		policy.reach30Probabilities = (observations) => observations.map(() => 0.5);
		const first = planDecisionCriticRerank(state, focus, catalog, policy, actions, {
			policyRankWeight: 0.5
		})!;
		const replay = planDecisionCriticRerank(state, focus, catalog, policy, actions, {
			policyRankWeight: 0.5
		})!;
		expect(replay).toEqual(first);
		expect(first.index).toBe(0);
		const hiddenRealizationsChanged = actions.map((action, index) => {
			const changed = structuredClone(action);
			changed.next.players[focus]!.victoryPoints += index + 7;
			changed.next.rng.cursor += index + 11;
			return changed;
		});
		const changed = planDecisionCriticRerank(
			state,
			focus,
			catalog,
			policy,
			hiddenRealizationsChanged,
			{ policyRankWeight: 0.5 }
		)!;
		expect(changed).toEqual(first);
	});

	it('applies exact terminal overrides before batched critic values', () => {
		const state = soloNavigation();
		const actions = legalActionsWithNext(state, focus, catalog).slice(0, 2);
		const winning = structuredClone(actions[0]);
		winning.policyNext.players[focus]!.victoryPoints = 30;
		const losing = structuredClone(actions[1]);
		losing.policyNext.status = 'finished';
		losing.policyNext.players[focus]!.victoryPoints = 29;
		const policy = randomPolicy(33, { probability: 0.5, horizon: 30 });
		policy.scoreCandidates = () => [0, 0];
		let batches = 0;
		policy.reach30Probabilities = () => {
			batches += 1;
			return [];
		};
		const result = planDecisionCriticRerank(state, focus, catalog, policy, [winning, losing], {
			policyRankWeight: 0
		})!;
		expect(batches).toBe(0);
		expect(result.criticProbabilities).toEqual([1, 0]);
		expect(result.index).toBe(0);
	});

	it('fails closed on a missing round-30 critic or invalid mixture', () => {
		const state = soloNavigation();
		const actions = legalActionsWithNext(state, focus, catalog);
		expect(() =>
			planDecisionCriticRerank(state, focus, catalog, randomPolicy(34), actions, {
				policyRankWeight: 0.5
			})
		).toThrow(/horizon 30/);
		expect(() =>
			planDecisionCriticRerank(
				state,
				focus,
				catalog,
				randomPolicy(35, { probability: 0.5, horizon: 30 }),
				actions,
				{ policyRankWeight: -0.1 }
			)
		).toThrow(/\[0,1\]/);
	});
});
