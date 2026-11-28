/**
 * Fighter — declarative `onRest` breakpoint ladder.
 *
 * DB-intended behavior (source of truth):
 *   On Rest: 2/3/4/5 Fighter traits -> gain 1/2/3/5 Basic Attack dice (5 also gives 1 Spirit Augment).
 *
 * Only the highest qualifying numeric breakpoint fires (selectBreakpoint picks the
 * single highest threshold <= count), so the grants are NOT cumulative across rungs.
 * Below the first rung (count < 2) the ability is dormant — nothing is granted.
 *
 * UX channel: the granted dice surface as an attributed reward/rest log line
 * ("Fighter: Gained N basic attack dice."), and the mechanical attackDice pool grows
 * — never a silent no-op. The flat 10-die cap clamps a grant that would overflow it.
 */

import { describe, it, expect } from 'vitest';
import { fire } from './testHelpers';

/** Fire onRest for a Red player whose single awakened spirit carries N Fighter traits. */
function rest(count: number) {
	return fire({ Fighter: count }, 'onRest');
}

describe('Fighter', () => {
	it('2 traits: gains 1 basic attack die', () => {
		const { player, log } = rest(2);
		expect(player.attackDice.length).toBe(1);
		expect(player.attackDice.every((d) => d.tier === 'basic')).toBe(true);
		// Surfaces to the player as an attributed log line (no silent no-op).
		expect(log.some((l) => l.includes('Fighter: Gained 1 basic attack dice.'))).toBe(true);
	});

	it('3 traits: gains 2 basic attack dice', () => {
		const { player, log } = rest(3);
		expect(player.attackDice.length).toBe(2);
		expect(player.attackDice.every((d) => d.tier === 'basic')).toBe(true);
		expect(log.some((l) => l.includes('Fighter: Gained 2 basic attack dice.'))).toBe(true);
	});

	it('4 traits: gains 3 basic attack dice', () => {
		const { player, log } = rest(4);
		expect(player.attackDice.length).toBe(3);
		expect(player.attackDice.every((d) => d.tier === 'basic')).toBe(true);
		expect(log.some((l) => l.includes('Fighter: Gained 3 basic attack dice.'))).toBe(true);
	});

	it('5 traits: gains 5 basic attack dice', () => {
		const { player, log } = rest(5);
		expect(player.attackDice.length).toBe(5);
		expect(player.attackDice.every((d) => d.tier === 'basic')).toBe(true);
		expect(log.some((l) => l.includes('Fighter: Gained 5 basic attack dice.'))).toBe(true);
	});

	it('only the highest qualifying rung fires (grants are not cumulative)', () => {
		// At count 4 the +3 rung fires, NOT +1 +2 +3 (=6). Confirms breakpoint selection.
		expect(rest(4).player.attackDice.length).toBe(3);
		// At count 6 (above the top rung) the +5 rung still fires.
		expect(rest(6).player.attackDice.length).toBe(5);
	});

	it('below the first rung (1 trait): no dice, no Fighter log line (dormant, not a silent grant)', () => {
		const { player, log } = rest(1);
		expect(player.attackDice.length).toBe(0);
		expect(log.some((l) => l.startsWith('Fighter:'))).toBe(false);
	});

	it('respects the flat 10-die cap when a pool already holds dice', () => {
		// Pre-seed 8 dice, then a count-5 (+5) rest: only 2 fit under the cap of 10.
		const { player, log } = fire({ Fighter: 5 }, 'onRest', {
			player: {
				attackDice: Array.from({ length: 8 }, (_, i) => ({
					instanceId: `seed${i}`,
					tier: 'basic' as const
				}))
			}
		});
		expect(player.attackDice.length).toBe(10);
		// The clamped grant is still surfaced (2 actually added).
		expect(log.some((l) => l.includes('Fighter: Gained 2 basic attack dice.'))).toBe(true);
	});

	it('is inactive when the Fighter spirit is face-down (unawakened)', () => {
		const { player, log } = fire({ Fighter: 5 }, 'onRest', {
			player: {
				spirits: [
					{
						slotIndex: 1,
						id: 's1',
						name: 'Spirit 1',
						cost: 2,
						classes: { Fighter: 5 },
						origins: {},
						isFaceDown: true
					}
				]
			}
		});
		expect(player.attackDice.length).toBe(0);
		expect(log.some((l) => l.startsWith('Fighter:'))).toBe(false);
	});

	it('does not fire on a non-Rest trigger (onCultivate)', () => {
		const { player, log } = fire({ Fighter: 5 }, 'onCultivate');
		expect(player.attackDice.length).toBe(0);
		expect(log.some((l) => l.startsWith('Fighter:'))).toBe(false);
	});
});
