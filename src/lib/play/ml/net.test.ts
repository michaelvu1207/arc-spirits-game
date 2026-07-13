import { describe, expect, it } from 'vitest';
import {
	expandPolicyActDim,
	expandPolicyObsDim,
	loadPolicyWeights,
	type PolicyWeights
} from './net';

function fixture(): PolicyWeights {
	return {
		format: 'arc-cand-scorer-v1',
		obs_dim: 2,
		act_dim: 1,
		trunk: [
			{
				W: [
					[1, 2, 3],
					[-1, 0.5, 2]
				],
				b: [0.1, -0.2]
			},
			{ W: [[0.75, -0.25]], b: [0.3] }
		],
		value: [{ W: [[0.5, -1]], b: [0.2] }],
		farm_value: [{ W: [[0.25, 0.75]], b: [0] }],
		route_mode: [{ W: [[-0.5, 1]], b: [0.1] }],
		placement: [
			{
				W: [
					[1, 0],
					[0, 1],
					[-1, 0],
					[0, -1]
				],
				b: [0, 0, 0, 0]
			}
		],
		reward_pick: [{ W: [[0.1, 0.2, 0.3]], b: [-0.4] }],
		reach30: [{ W: [[0.2, -0.4]], b: [0.1] }],
		reach30_horizon: 35
	};
}

describe('observation-prefix checkpoint compatibility', () => {
	it('zero-expands every input head without changing any old-checkpoint output', () => {
		const raw = fixture();
		const oldPolicy = loadPolicyWeights(raw);
		const expandedPolicy = loadPolicyWeights(raw, { expectedObsDim: 4, expectedActDim: 1 });
		const oldObs = [0.4, -0.7];
		const newObs = [0.4, -0.7, 0, 0];
		const cands = [[0.2], [-0.5]];

		expect(expandedPolicy.scoreCandidates(newObs, cands)).toEqual(
			oldPolicy.scoreCandidates(oldObs, cands)
		);
		expect(expandedPolicy.value(newObs)).toBe(oldPolicy.value(oldObs));
		expect(expandedPolicy.farmValue(newObs)).toBe(oldPolicy.farmValue(oldObs));
		expect(expandedPolicy.routeMode(newObs)).toBe(oldPolicy.routeMode(oldObs));
		expect(expandedPolicy.placementProbs(newObs)).toEqual(oldPolicy.placementProbs(oldObs));
		expect(expandedPolicy.reach30Probability(newObs)).toBe(oldPolicy.reach30Probability(oldObs));
		expect(expandedPolicy.rewardPickScores(newObs, cands)).toEqual(
			oldPolicy.rewardPickScores(oldObs, cands)
		);
		expect(raw.obs_dim).toBe(2);
		expect(raw.trunk[0].W[0]).toHaveLength(3);
		expect(expandedPolicy.w.trunk[0].W[0]).toEqual([1, 2, 0, 0, 3]);
	});

	it('zero-expands an appended action tail without changing old-checkpoint output', () => {
		const raw = fixture();
		const oldPolicy = loadPolicyWeights(raw);
		const expandedPolicy = loadPolicyWeights(raw, { expectedObsDim: 2, expectedActDim: 3 });
		const obs = [0.4, -0.7];
		const oldCands = [[0.2], [-0.5]];
		const newCands = [
			[0.2, 0.9, -0.4],
			[-0.5, -0.7, 0.8]
		];

		expect(expandedPolicy.scoreCandidates(obs, newCands)).toEqual(
			oldPolicy.scoreCandidates(obs, oldCands)
		);
		expect(expandedPolicy.rewardPickScores(obs, newCands)).toEqual(
			oldPolicy.rewardPickScores(obs, oldCands)
		);
		expect(expandedPolicy.value(obs)).toBe(oldPolicy.value(obs));
		expect(expandedPolicy.reach30Probability(obs)).toBe(oldPolicy.reach30Probability(obs));
		expect(raw.act_dim).toBe(1);
		expect(raw.trunk[0].W[0]).toHaveLength(3);
		expect(expandedPolicy.w.trunk[0].W[0]).toEqual([1, 2, 3, 0, 0]);
	});

	it('keeps the reach-30 head optional and rejects malformed dimensions', () => {
		const without = fixture();
		delete without.reach30;
		expect(loadPolicyWeights(without).reach30Probability([0, 0])).toBeNull();

		const malformed = fixture();
		malformed.reach30![0].W[0].push(99);
		expect(() => loadPolicyWeights(malformed)).toThrow(/reach30 input/);
	});

	it('rejects shrinking or malformed head widths', () => {
		expect(() => expandPolicyObsDim(fixture(), 1)).toThrow(/cannot expand/);
		expect(() => expandPolicyActDim(fixture(), 0)).toThrow(/cannot expand/);
		const malformed = fixture();
		malformed.placement![0].W[0].push(99);
		expect(() => loadPolicyWeights(malformed, { expectedObsDim: 4 })).toThrow(
			/placement\[0\].*ragged/
		);
	});
});
