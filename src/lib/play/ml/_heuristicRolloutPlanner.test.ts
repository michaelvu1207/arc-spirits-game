import { beforeAll, describe, expect, it, vi } from 'vitest';
import { applyGameCommand } from '../runtime';
import { createRng, nextInt } from '../rng';
import type { GameActor, PlayCatalog, PublicGameState, SeatColor } from '../types';
import { legalActionsWithNext } from './actions';
import { ACT_DIM, OBS_DIM } from './encode';
import { planDecisionBatchedHeuristic } from './heuristicRolloutPlanner';
import { NeuralPolicy, type LinearLayer, type PolicyWeights } from './net';
import { loadOrSnapshotCatalog } from './nodeIo';

function randomPolicy(seed: number, horizon = 30): NeuralPolicy {
	const rng = createRng(seed);
	const random = (): number => (nextInt(rng, 20001) / 10000 - 1) * 0.1;
	const linear = (out: number, input: number): LinearLayer => ({
		W: Array.from({ length: out }, () => Array.from({ length: input }, random)),
		b: Array.from({ length: out }, () => 0)
	});
	const weights: PolicyWeights = {
		format: 'arc-cand-scorer-v1',
		obs_dim: OBS_DIM,
		act_dim: ACT_DIM,
		trunk: [linear(32, OBS_DIM + ACT_DIM), linear(1, 32)],
		value: [linear(16, OBS_DIM), linear(1, 16)],
		reach30: [{ W: [Array<number>(OBS_DIM).fill(0)], b: [Math.log(0.7 / 0.3)] }],
		reach30_horizon: horizon
	};
	return new NeuralPolicy(weights);
}

let catalog: PlayCatalog;
let state: PublicGameState;
const seat: SeatColor = 'Red';

beforeAll(async () => {
	catalog = await loadOrSnapshotCatalog();
	const { createLobbyState } = await import('../runtime');
	state = createLobbyState({ roomCode: 'V34H', guardianNames: [catalog.guardians[0].name] });
	const actor: GameActor = {
		memberId: 'v34-bot',
		displayName: 'V34',
		role: 'player',
		seatColor: null
	};
	const apply = (command: Parameters<typeof applyGameCommand>[2]): void => {
		const result = applyGameCommand(state, actor, command, catalog);
		if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
		state = result.state;
		actor.seatColor = seat;
	};
	apply({ type: 'claimSeat', seatColor: seat });
	apply({ type: 'selectGuardian', guardianName: catalog.guardians[0].name });
	const host: GameActor = {
		memberId: 'host',
		displayName: 'host',
		role: 'host',
		seatColor: null
	};
	const started = applyGameCommand(state, host, { type: 'startGame', seed: 956300010 }, catalog);
	if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
	state = started.state;
});

const options = {
	simulations: 8,
	horizonRounds: 3,
	valueWeight: 0.5,
	seed: 34001,
	temperature: 0
};

describe('V34 batched heuristic planner', () => {
	it('uses exactly one critic batch and no neural inference inside rollouts', () => {
		const actions = legalActionsWithNext(state, seat, catalog);
		expect(actions.length).toBeGreaterThan(1);
		const policy = randomPolicy(1);
		const batch = vi.spyOn(policy, 'reach30Probabilities');
		const pick = vi.spyOn(policy, 'pick');
		const value = vi.spyOn(policy, 'value');
		const result = planDecisionBatchedHeuristic(state, seat, catalog, policy, actions, options);
		expect(result).not.toBeNull();
		expect(batch).toHaveBeenCalledTimes(1);
		expect(batch.mock.calls[0][0].length).toBeGreaterThan(0);
		expect(batch.mock.calls[0][0].length).toBeLessThanOrEqual(options.simulations);
		// The in-process fallback intentionally maps its scalar head. The remote
		// implementation is separately tested to send this batch as one request.
		expect(pick).not.toHaveBeenCalled();
		expect(value).not.toHaveBeenCalled();
		expect(result!.visits.reduce((sum, count) => sum + count, 0)).toBe(options.simulations);
		expect(result!.visits[result!.index]).toBeGreaterThan(0);
		expect(result!.pi.reduce((sum, probability) => sum + probability, 0)).toBeCloseTo(1, 10);
	});

	it('is exactly replayable for a frozen seed and changes its stream by seed', () => {
		const actions = legalActionsWithNext(state, seat, catalog);
		const policy = randomPolicy(2);
		const first = planDecisionBatchedHeuristic(state, seat, catalog, policy, actions, options)!;
		const replay = planDecisionBatchedHeuristic(state, seat, catalog, policy, actions, options)!;
		expect(replay).toEqual(first);
		const alternatives = Array.from({ length: 8 }, (_, offset) =>
			planDecisionBatchedHeuristic(state, seat, catalog, policy, actions, {
				...options,
				seed: options.seed + offset + 1
			})
		);
		expect(alternatives.some((candidate) => candidate!.index !== first.index)).toBe(true);
	});

	it('fails closed on malformed compute or critic contracts', () => {
		const actions = legalActionsWithNext(state, seat, catalog);
		const policy = randomPolicy(3);
		expect(() =>
			planDecisionBatchedHeuristic(state, seat, catalog, policy, actions, {
				...options,
				simulations: 1
			})
		).toThrow(/at least 2/);
		expect(() =>
			planDecisionBatchedHeuristic(state, seat, catalog, policy, actions, {
				...options,
				horizonRounds: 1.5
			})
		).toThrow(/positive integer/);
		expect(() =>
			planDecisionBatchedHeuristic(state, seat, catalog, randomPolicy(4, 35), actions, options)
		).toThrow(/got 35/);
	});
});
