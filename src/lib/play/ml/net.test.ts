import { describe, expect, it } from 'vitest';
import { expandPolicyObsDim, loadPolicyWeights, type PolicyWeights } from './net';

function fixture(): PolicyWeights {
	return {
		format: 'arc-cand-scorer-v1',
		obs_dim: 2,
		act_dim: 1,
		trunk: [
			{ W: [[1, 2, 3], [-1, 0.5, 2]], b: [0.1, -0.2] },
			{ W: [[0.75, -0.25]], b: [0.3] }
		],
		value: [{ W: [[0.5, -1]], b: [0.2] }],
		farm_value: [{ W: [[0.25, 0.75]], b: [0] }],
		route_mode: [{ W: [[-0.5, 1]], b: [0.1] }],
		placement: [
			{ W: [[1, 0], [0, 1], [-1, 0], [0, -1]], b: [0, 0, 0, 0] }
		],
		reward_pick: [{ W: [[0.1, 0.2, 0.3]], b: [-0.4] }]
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
		expect(expandedPolicy.rewardPickScores(newObs, cands)).toEqual(
			oldPolicy.rewardPickScores(oldObs, cands)
		);
		expect(raw.obs_dim).toBe(2);
		expect(raw.trunk[0].W[0]).toHaveLength(3);
		expect(expandedPolicy.w.trunk[0].W[0]).toEqual([1, 2, 0, 0, 3]);
	});

	it('rejects shrinking or malformed head widths', () => {
		expect(() => expandPolicyObsDim(fixture(), 1)).toThrow(/cannot expand/);
		const malformed = fixture();
		malformed.placement![0].W[0].push(99);
		expect(() => loadPolicyWeights(malformed, { expectedObsDim: 4 })).toThrow(
			/placement\[0\].*ragged/
		);
	});
});
