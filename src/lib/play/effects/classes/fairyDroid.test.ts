import { describe, it, expect } from 'vitest';
import { ability } from './fairyDroid';
import { fire, makePlayer, spirit, ctxFor } from './testHelpers';
import { augmentCapacityForSpirit, UNLIMITED_AUGMENT_CAPACITY } from '../../augments';

/**
 * Runebound Vessel — DB intent: "You may place unlimited Spirit Augments on this spirit.
 * On awaken, gain any 2 augments for this spirit."
 *
 * Two halves, two UX channels:
 *  - Unlimited placement: modeled engine-side by `augmentCapacityForSpirit`, which
 *    returns the large finite cap {@link UNLIMITED_AUGMENT_CAPACITY} for any spirit
 *    carrying the Runebound Vessel class. Surfaces as eligibility — the spirit stays a
 *    valid augment target far past the default cap of 1.
 *  - On-awaken grant: a declarative `awakening` breakpoint that fires
 *    `gainAugment amount: 2`, pushing 2 PLACEABLE augments into `player.unplacedAugments`
 *    (the AugmentPlacement pouch) AND emitting a log line (an engine action — never a
 *    silent no-op, and never a dead server-only scalar).
 */
describe('Runebound Vessel (awakening → +2 augments; unlimited augment placement)', () => {
	it('grants exactly 2 placeable spirit augments BOUND to this Runebound Vessel', () => {
		const { player } = fire({ 'Runebound Vessel': 1 }, 'awakening', {
			command: { slotIndex: 1 }
		});
		expect(player.unplacedAugments?.length ?? 0).toBe(2);
		// "for this spirit" — both augments are bound to the Runebound Vessel's own slot.
		expect((player.unplacedAugments ?? []).every((a) => a.boundSlotIndex === 1)).toBe(true);
	});

	it('surfaces the grant to the player via a log line (no silent no-op)', () => {
		const { log } = fire({ 'Runebound Vessel': 1 }, 'awakening', {
			command: { slotIndex: 1 }
		});
		expect(log.some((l) => /spirit augment/i.test(l))).toBe(true);
	});

	it('does not grant augments on an unrelated trigger', () => {
		const { player } = fire({ 'Runebound Vessel': 1 }, 'onTakeDamage');
		expect(player.unplacedAugments?.length ?? 0).toBe(0);
	});

	it('exposes a single awakening run-handler (bound-augment grant, not declarative)', () => {
		expect(ability).toHaveLength(1);
		expect(ability[0].on).toBe('awakening');
		expect(typeof ability[0].run).toBe('function');
		expect(ability[0].breakpoints).toBeUndefined();
	});

	it('unlimited placement: a Runebound Vessel spirit can hold far more than the default 1 augment', () => {
		const droid = spirit(1, { 'Runebound Vessel': 1 });
		expect(augmentCapacityForSpirit(droid)).toBe(UNLIMITED_AUGMENT_CAPACITY);
		// eligibility: capacity is far past any reachable augment count.
		expect(augmentCapacityForSpirit(droid)).toBeGreaterThan(1);
	});

	it('unlimited placement does NOT apply to a non-Fairy-Droid spirit (default cap of 1)', () => {
		const plain = spirit(1, { 'Runic Bulwark': 1 });
		expect(augmentCapacityForSpirit(plain)).toBe(1);
	});

	it('direct handler/breakpoint unit test via fire: pushes 2 placeable augments + logs', () => {
		const player = makePlayer({ spirits: [spirit(1, { 'Runebound Vessel': 1 })] });
		// sanity: the bare context builds for this class without throwing.
		expect(() => ctxFor(player, { trigger: 'awakening', command: { slotIndex: 1 } })).not.toThrow();
		const { player: fired, log } = fire({ 'Runebound Vessel': 1 }, 'awakening', {
			command: { slotIndex: 1 }
		});
		expect(fired.unplacedAugments?.length ?? 0).toBe(2);
		expect(log.some((l) => /spirit augment/i.test(l))).toBe(true);
	});
});
