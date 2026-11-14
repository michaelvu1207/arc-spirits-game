import { describe, expect, it } from 'vitest';
import { fire, spirit } from './testHelpers';

/** Gardener (Sunflower Maiden) — "In the Awakening Phase, if you are not Evil, restore 2 Barrier."
 *  The engine fires `awakeningPhase` at the start of its Benefits step, like every other
 *  "In the Awakening Phase" class text. */
describe('Gardener', () => {
	it('not Evil: restores 2 Barrier', () => {
		for (const statusLevel of [0, 2]) {
			const { player } = fire({ Gardener: 1 }, 'awakeningPhase', { player: { statusLevel, barrier: 3, maxBarrier: 10 } });
			expect(player.barrier).toBe(5);
		}
	});
	it('the restore stops at Max Barrier', () => {
		const { player } = fire({ Gardener: 1 }, 'awakeningPhase', { player: { barrier: 9, maxBarrier: 10 } });
		expect(player.barrier).toBe(10);
	});
	it('Evil (Fallen), or face-down: nothing', () => {
		expect(fire({ Gardener: 1 }, 'awakeningPhase', { player: { statusLevel: 3, barrier: 3, maxBarrier: 10 } }).player.barrier).toBe(3);
		const down = fire({}, 'awakeningPhase', {
			player: { barrier: 3, maxBarrier: 10, spirits: [spirit(1, { Gardener: 1 }, { faceDown: true })] }
		});
		expect(down.player.barrier).toBe(3);
	});
});
