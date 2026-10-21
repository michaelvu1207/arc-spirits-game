import { describe, expect, test } from 'vitest';
import {
	augmentCapacityForSpirit,
	augmentContributions,
	UNLIMITED_AUGMENT_CAPACITY,
	UNLIMITED_AUGMENT_CLASSES
} from './augments';

function spirit(slotIndex: number, isFaceDown: boolean, classes: Record<string, number> = {}) {
	return { slotIndex, isFaceDown, classes };
}

describe('augmentCapacityForSpirit', () => {
	test('a plain spirit holds exactly one augment', () => {
		expect(augmentCapacityForSpirit(spirit(1, false, { Hero: 2 }))).toBe(1);
		expect(augmentCapacityForSpirit(spirit(1, false, {}))).toBe(1);
	});

	test('a Runebound Vessel holds unlimited augments (large finite cap)', () => {
		expect(augmentCapacityForSpirit(spirit(1, false, { 'Runebound Vessel': 1 }))).toBe(
			UNLIMITED_AUGMENT_CAPACITY
		);
		// The cap is a plain integer (not Infinity) and is large enough to never bind.
		expect(Number.isFinite(UNLIMITED_AUGMENT_CAPACITY)).toBe(true);
		expect(UNLIMITED_AUGMENT_CAPACITY).toBeGreaterThanOrEqual(99);
	});

	test('a zero-count augment-capacity class does not raise capacity', () => {
		expect(augmentCapacityForSpirit(spirit(1, false, { 'Runebound Vessel': 0 }))).toBe(1);
	});

	test('Runebound Vessel is registered as an unlimited-capacity class', () => {
		expect(UNLIMITED_AUGMENT_CLASSES.has('Runebound Vessel')).toBe(true);
	});
});

describe('augmentContributions', () => {
	test('an augment on an awakened spirit is an active contribution', () => {
		const player = {
			spirits: [spirit(1, false, { Hero: 1 })],
			spiritAugmentAttachments: [{ spiritSlotIndex: 1, className: 'Mystic' }]
		};
		expect(augmentContributions(player)).toEqual([{ className: 'Mystic', awake: true }]);
	});

	test('an augment on a face-down spirit is dormant (follows the spirit)', () => {
		const player = {
			spirits: [spirit(1, true, {})],
			spiritAugmentAttachments: [{ spiritSlotIndex: 1, className: 'Mystic' }]
		};
		expect(augmentContributions(player)).toEqual([{ className: 'Mystic', awake: false }]);
	});

	test('attachments with no resolved class (plain runes) are ignored', () => {
		const player = {
			spirits: [spirit(1, false, {})],
			spiritAugmentAttachments: [{ spiritSlotIndex: 1 }, { spiritSlotIndex: 1, className: 'Hero' }]
		};
		expect(augmentContributions(player)).toEqual([{ className: 'Hero', awake: true }]);
	});

	test('an orphaned augment (host spirit gone) is ignored', () => {
		const player = {
			spirits: [spirit(2, false, {})],
			spiritAugmentAttachments: [{ spiritSlotIndex: 1, className: 'Hero' }]
		};
		expect(augmentContributions(player)).toEqual([]);
	});

	test('multiple augments across awakened and dormant hosts', () => {
		const player = {
			spirits: [spirit(1, false, {}), spirit(2, true, {})],
			spiritAugmentAttachments: [
				{ spiritSlotIndex: 1, className: 'Hero' },
				{ spiritSlotIndex: 1, className: 'Mystic' },
				{ spiritSlotIndex: 2, className: 'Hero' }
			]
		};
		expect(augmentContributions(player)).toEqual([
			{ className: 'Hero', awake: true },
			{ className: 'Mystic', awake: true },
			{ className: 'Hero', awake: false }
		]);
	});

	test('no attachments ⇒ no contributions', () => {
		expect(augmentContributions({ spirits: [spirit(1, false)] })).toEqual([]);
	});
});
