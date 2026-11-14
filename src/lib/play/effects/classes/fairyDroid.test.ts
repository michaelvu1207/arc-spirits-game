import { describe, it, expect } from 'vitest';
import { ability } from './fairyDroid';
import { makePlayer, makeState, spirit } from './testHelpers';
import { applyTrigger } from '../apply';
import { augmentCapacityForSpirit } from '../../augments';
import { RUNE_CARRY_LIMIT, type PrivatePlayerState } from '../../types';

/**
 * Herder — "On awaken, for each Beast that you have, gain 1 rune of the origin of that Beast."
 * Every Beast spirit of the owner counts (face-down too; board position does not matter).
 */
const WATER_RUNE = '5eba8681-16b8-4563-b017-22c80a84b35b';
const FOREST_RUNE = '34b2a963-f8c6-4fc0-8272-ddc50b0036a8';
const MOUNTAIN_RUNE = '356f3ad2-4cac-4b69-a3cc-7559f8891d8e';
const FIRE_RUNE = '480cd5f7-adea-481d-8ea9-aad776599d7b';

function beast(slotIndex: number, origin: string, opts: { faceDown?: boolean; beasts?: number } = {}) {
	return spirit(slotIndex, { Beast: opts.beasts ?? 1 }, { origins: { [origin]: 1 }, faceDown: opts.faceDown });
}

function awaken(player: PrivatePlayerState, slotIndex: number): string[] {
	const log: string[] = [];
	applyTrigger(makeState(player), 'Red', 'awakening', log, { command: { slotIndex } });
	return log;
}

const runeIds = (player: PrivatePlayerState) => player.mats.filter((m) => m.hasRune).map((m) => m.id);

describe('Herder — 1 rune of the origin of each of your Beasts, on awaken', () => {
	it('0 Beasts: nothing', () => {
		const player = makePlayer({ spirits: [spirit(4, { Herder: 1 }), spirit(1, { Fighter: 1 }), spirit(2, { Mystic: 1 })] });
		awaken(player, 4);
		expect(player.mats).toHaveLength(0);
	});

	it('3 Beasts of different origins: 1 rune of each origin', () => {
		const player = makePlayer({
			spirits: [
				spirit(4, { Herder: 1 }),
				beast(1, 'Water Region'),
				beast(3, 'Forest Region'),
				beast(5, 'Mountain Region')
			]
		});
		awaken(player, 4);
		expect(runeIds(player)).toEqual([WATER_RUNE, FOREST_RUNE, MOUNTAIN_RUNE]);
	});

	it('a Beast with 2 origins: 1 rune of each origin that has a rune', () => {
		const twoOrigins = spirit(2, { Beast: 1 }, { origins: { 'Fire Region': 1, Moon: 1, 'Water Region': 1 } });
		const player = makePlayer({ spirits: [spirit(4, { Herder: 1 }), twoOrigins] });
		awaken(player, 4);
		expect(runeIds(player)).toEqual([FIRE_RUNE, WATER_RUNE]);
	});

	it('the runes count toward the carry limit like any gained rune', () => {
		const held = Array.from({ length: RUNE_CARRY_LIMIT }, (_, i) => ({
			slotIndex: i + 1,
			hasRune: true,
			id: FIRE_RUNE,
			name: 'Fire Rune',
			type: 'rune' as const
		}));
		const player = makePlayer({ mats: held, spirits: [spirit(4, { Herder: 1 }), beast(1, 'Water Region')] });
		awaken(player, 4);
		expect(player.mats.filter((m) => m.hasRune)).toHaveLength(RUNE_CARRY_LIMIT + 1); // over: discard at Cleanup
		expect(player.mats.at(-1)).toMatchObject({ id: WATER_RUNE, slotIndex: RUNE_CARRY_LIMIT + 1 });
	});

	it('board position does not matter: a Beast on any slot counts (no adjacency)', () => {
		const player = makePlayer({ spirits: [spirit(1, { Herder: 1 }), beast(3, 'Water Region'), beast(7, 'Mountain Region')] });
		awaken(player, 1); // slots 3 and 7 are not next to slot 1
		expect(runeIds(player)).toEqual([WATER_RUNE, MOUNTAIN_RUNE]);
	});

	it('one Beast: 1 rune of its origin', () => {
		const player = makePlayer({ spirits: [spirit(4, { Herder: 1 }), beast(1, 'Water Region')] });
		const log = awaken(player, 4);
		expect(runeIds(player)).toEqual([WATER_RUNE]);
		expect(player.mats[0]).toMatchObject({ name: 'Water Rune', type: 'rune' });
		expect(log.some((l) => l.includes('Herder'))).toBe(true);
	});

	it('a Beast ×3 card is one Beast; a face-down Beast counts', () => {
		const player = makePlayer({
			spirits: [
				spirit(4, { Herder: 1 }),
				beast(1, 'Water Region', { beasts: 3 }),
				beast(3, 'Forest Region'),
				beast(6, 'Forest Region', { faceDown: true })
			]
		});
		awaken(player, 4);
		expect(runeIds(player)).toEqual([WATER_RUNE, FOREST_RUNE, FOREST_RUNE]);
	});

	it('a Beast whose origin has no base rune (Moon) gives nothing', () => {
		const player = makePlayer({ spirits: [spirit(4, { Herder: 1 }), beast(2, 'Moon')] });
		awaken(player, 4);
		expect(player.mats).toHaveLength(0);
	});

	it('only its own awakening counts', () => {
		const player = makePlayer({ spirits: [spirit(4, { Herder: 1 }), beast(1, 'Water Region')] });
		awaken(player, 1);
		expect(player.mats).toHaveLength(0);
	});

	it('the old augment rules are gone: no augments, and a Herder spirit holds 1 augment', () => {
		const player = makePlayer({ spirits: [spirit(4, { Herder: 1 }), beast(1, 'Water Region')] });
		awaken(player, 4);
		expect(player.unplacedAugments ?? []).toHaveLength(0);
		expect(augmentCapacityForSpirit(spirit(1, { Herder: 1 }))).toBe(1);
	});

	it('exposes a single awakening run-handler', () => {
		expect(ability).toHaveLength(1);
		expect(ability[0].on).toBe('awakening');
	});
});
