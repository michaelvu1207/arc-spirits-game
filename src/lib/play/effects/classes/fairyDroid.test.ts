import { describe, it, expect } from 'vitest';
import { ability } from './fairyDroid';
import { makePlayer, makeState, spirit } from './testHelpers';
import { applyTrigger } from '../apply';
import { augmentCapacityForSpirit, ownerAugmentCapacity } from '../../augments';
import type { PrivatePlayerState } from '../../types';

/**
 * Herder — "Each of your Arcane spirits may hold up to 2 Spirit Augments." Capacity only
 * (Arcane = cost 7 or more, read by augments.ts `ownerAugmentCapacity`); Herder has no
 * triggered ability, so its awakening gives no runes and no augments.
 */
function beast(slotIndex: number, origin: string) {
	return spirit(slotIndex, { Beast: 1 }, { origins: { [origin]: 1 } });
}

function awaken(player: PrivatePlayerState, slotIndex: number): string[] {
	const log: string[] = [];
	applyTrigger(makeState(player), 'Red', 'awakening', log, { command: { slotIndex } });
	return log;
}

const arcane = (slotIndex: number) => ({ ...spirit(slotIndex, {}), cost: 7 });

describe('Herder — each of your Arcane spirits may hold up to 2 Spirit Augments', () => {
	it('its awakening gives no runes, even with Beasts on the board', () => {
		const player = makePlayer({
			spirits: [spirit(4, { Herder: 1 }), beast(1, 'Water Region'), beast(3, 'Forest Region')]
		});
		const log = awaken(player, 4);
		expect(player.mats).toHaveLength(0);
		expect(log.some((l) => l.includes('Herder'))).toBe(false);
	});

	it('the old augment rules are gone: no augments, and a Herder spirit holds 1 augment', () => {
		const player = makePlayer({ spirits: [spirit(4, { Herder: 1 }), beast(1, 'Water Region')] });
		awaken(player, 4);
		expect(player.unplacedAugments ?? []).toHaveLength(0);
		expect(augmentCapacityForSpirit(spirit(1, { Herder: 1 }))).toBe(1);
	});

	it('with an awakened Herder, an Arcane spirit (cost 7+) holds 2; a cheaper spirit holds 1', () => {
		const cheap = { ...spirit(2, {}), cost: 6 };
		const player = makePlayer({ spirits: [spirit(1, { Herder: 1 }), arcane(2), cheap] });
		expect(ownerAugmentCapacity(player, arcane(2))).toBe(2);
		expect(ownerAugmentCapacity(player, cheap)).toBe(1);
	});

	it('a face-down Herder raises nothing', () => {
		const player = makePlayer({ spirits: [spirit(1, { Herder: 1 }, { faceDown: true }), arcane(2)] });
		expect(ownerAugmentCapacity(player, arcane(2))).toBe(1);
	});

	it('has no triggered ability', () => {
		expect(ability).toHaveLength(0);
	});
});
