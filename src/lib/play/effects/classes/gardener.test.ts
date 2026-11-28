import { describe, expect, it } from 'vitest';
import { fire, spirit } from './testHelpers';

/** Gardener (Sunflower Maiden) — "In the Awakening Phase, if you are not Evil, restore 3 Barrier
 *  and gain 1 Max Barrier." (A new Max Barrier arrives intact, so it also adds 1 Barrier.)
 *  The engine fires `awakeningPhase` at the start of its Benefits step, like every other
 *  "In the Awakening Phase" class text. */
describe('Gardener', () => {
	it('not Evil: restores 3 Barrier and gains 1 Max Barrier', () => {
		for (const statusLevel of [0, 2]) {
			const { player } = fire({ Gardener: 1 }, 'awakeningPhase', { player: { statusLevel, barrier: 3, maxBarrier: 8 } });
			expect(player.maxBarrier).toBe(9);
			expect(player.barrier).toBe(7); // 3 + 3 restored + 1 new intact Max Barrier
		}
	});
	it('the restore stops at Max Barrier', () => {
		const { player } = fire({ Gardener: 1 }, 'awakeningPhase', { player: { barrier: 9, maxBarrier: 10 } });
		expect(player.barrier).toBe(10);
		expect(player.maxBarrier).toBe(10); // Max Barrier is capped at 10
	});
	it('Evil (Fallen), or face-down: nothing', () => {
		const evil = fire({ Gardener: 1 }, 'awakeningPhase', { player: { statusLevel: 3, barrier: 3, maxBarrier: 8 } }).player;
		expect([evil.barrier, evil.maxBarrier]).toEqual([3, 8]);
		const down = fire({}, 'awakeningPhase', {
			player: { barrier: 3, maxBarrier: 10, spirits: [spirit(1, { Gardener: 1 }, { faceDown: true })] }
		});
		expect(down.player.barrier).toBe(3);
	});
});
