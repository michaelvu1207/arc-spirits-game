import { describe, expect, it } from 'vitest';
import { makePlayer, makeState, spirit } from './testHelpers';
import { takeDamage } from '../../combat';
import type { PrivatePlayerState } from '../../types';

/** Shieldbearer (Dawn Knight) — "When you take damage, if your Barrier is full, take 3 less."
 *  Checked for each hit; the reduction is for that hit only. */
describe('Shieldbearer', () => {
	const hit = (player: PrivatePlayerState, amount: number) =>
		takeDamage(player, amount, { state: makeState(player), seat: 'Red' }, []);

	it('full Barrier: the hit is 3 less; the next hit (Barrier not full) is not reduced', () => {
		const player = makePlayer({ barrier: 10, maxBarrier: 10, spirits: [spirit(1, { Shieldbearer: 1 })] });
		expect(hit(player, 5).barrierLost).toBe(2);
		expect(player.barrier).toBe(8);
		expect(hit(player, 5).barrierLost).toBe(5);
		expect(player.barrier).toBe(3);
	});

	it('a hit of 3 or less at full Barrier: no damage, and the Barrier stays full', () => {
		const player = makePlayer({ barrier: 6, maxBarrier: 6, spirits: [spirit(1, { Shieldbearer: 1 })] });
		hit(player, 3);
		hit(player, 2);
		expect(player.barrier).toBe(6);
	});

	it('the reduction adds to a combat-wide reduction and does not stay after the hit', () => {
		const player = makePlayer({ barrier: 10, maxBarrier: 10, damageReduction: 1, spirits: [spirit(1, { Shieldbearer: 1 })] });
		expect(hit(player, 6).barrierLost).toBe(2);
		expect(player.damageReduction).toBe(1);
	});

	it('Barrier not full, or face-down: no reduction', () => {
		const dented = makePlayer({ barrier: 9, maxBarrier: 10, spirits: [spirit(1, { Shieldbearer: 1 })] });
		expect(hit(dented, 5).barrierLost).toBe(5);
		const down = makePlayer({ barrier: 10, maxBarrier: 10, spirits: [spirit(1, { Shieldbearer: 1 }, { faceDown: true })] });
		expect(hit(down, 5).barrierLost).toBe(5);
	});
});
