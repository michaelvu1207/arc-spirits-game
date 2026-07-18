import { describe, expect, it } from 'vitest';
import { guardianIndexForSeed } from './evalSchedule';

describe('evaluation seed schedule', () => {
	it('is invariant to shard boundaries and balances every contiguous block', () => {
		const seeds = Array.from({ length: 64 }, (_, index) => 9_100_001 + index);
		const unsharded = seeds.map((seed) => guardianIndexForSeed(seed, 10));
		const sharded = Array.from({ length: 32 }, (_, shard) =>
			seeds.slice(shard * 2, shard * 2 + 2).map((seed) => guardianIndexForSeed(seed, 10))
		).flat();
		expect(sharded).toEqual(unsharded);
		const counts = Array.from(
			{ length: 10 },
			(_, index) => unsharded.filter((guardian) => guardian === index).length
		);
		expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
	});

	it('rejects malformed schedules', () => {
		expect(() => guardianIndexForSeed(-1, 10)).toThrow(/seed/);
		expect(() => guardianIndexForSeed(1, 0)).toThrow(/guardianCount/);
	});
});
