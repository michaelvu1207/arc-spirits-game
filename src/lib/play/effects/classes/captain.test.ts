/**
 * Captain — "If you Cultivate with 3 Heroes, gain 1 Spirit Augment."
 *
 * Heroes = Human Enclave faction spirits (origin is always active, awakened or
 * not). The ability counts every Human Enclave spirit on the board and grants
 * exactly 1 Spirit Augment when the count is ≥3.
 *
 * UX channel: an engine action (`gainAugment`) that pushes a placeable augment into
 * `player.unplacedAugments` (the AugmentPlacement pouch) AND emits a log line — never
 * a silent no-op, and never a dead server-only scalar.
 */

import { describe, it, expect } from 'vitest';
import { ability } from './captain';
import { fire, makePlayer, spirit, ctxFor } from './testHelpers';

/** Build a Captain player carrying `heroCount` Human Enclave spirits. */
function captainWithHeroes(heroCount: number) {
	const spirits = [
		// The Captain itself carries the class; also a Hero so it counts toward Heroes.
		spirit(1, { Captain: 1 }, { origins: { 'Human Enclave': 1 } })
	];
	for (let i = 2; i <= heroCount; i += 1) {
		spirits.push(spirit(i, {}, { origins: { 'Human Enclave': 1 } }));
	}
	return spirits;
}

describe('Captain (onCultivate → +1 Spirit Augment with 3 Heroes)', () => {
	it('gains 1 spirit augment when cultivating with exactly 3 Heroes', () => {
		const { player, log } = fire(
			{ Captain: 1 },
			'onCultivate',
			{ player: { spirits: captainWithHeroes(3) } }
		);
		expect(player.unplacedAugments?.length ?? 0).toBe(1);
		// no-silent-no-op: the grant surfaces as a log line.
		expect(log.some((l) => /spirit augment/i.test(l))).toBe(true);
	});

	it('grants exactly 1 (not per-Hero) when cultivating with more than 3 Heroes', () => {
		const { player } = fire(
			{ Captain: 1 },
			'onCultivate',
			{ player: { spirits: captainWithHeroes(5) } }
		);
		expect(player.unplacedAugments?.length ?? 0).toBe(1);
	});

	it('grants nothing with fewer than 3 Heroes', () => {
		const { player, log } = fire(
			{ Captain: 1 },
			'onCultivate',
			{ player: { spirits: captainWithHeroes(2) } }
		);
		expect(player.unplacedAugments?.length ?? 0).toBe(0);
		expect(log.some((l) => /spirit augment/i.test(l))).toBe(false);
	});

	it('counts Heroes whether or not the Hero spirits are awakened (origin always active)', () => {
		const spirits = [
			spirit(1, { Captain: 1 }, { origins: { 'Human Enclave': 1 }, faceDown: false }),
			spirit(2, {}, { origins: { 'Human Enclave': 1 }, faceDown: true }),
			spirit(3, {}, { origins: { 'Human Enclave': 1 }, faceDown: true })
		];
		const { player } = fire({ Captain: 1 }, 'onCultivate', { player: { spirits } });
		expect(player.unplacedAugments?.length ?? 0).toBe(1);
	});

	it('does NOT count non-Human-Enclave spirits as Heroes', () => {
		const spirits = [
			spirit(1, { Captain: 1 }, { origins: { 'Human Enclave': 1 } }),
			spirit(2, {}, { origins: { 'Spirit Worlds': 1 } }),
			spirit(3, {}, { origins: { 'Spirit Worlds': 1 } })
		];
		const { player } = fire({ Captain: 1 }, 'onCultivate', { player: { spirits } });
		expect(player.unplacedAugments?.length ?? 0).toBe(0);
	});

	it('exposes cultivate, monster-kill (rule captainPowerOnKill) and discard abilities', () => {
		expect(ability.map((x) => x.on)).toEqual(['onCultivate', 'onMonsterKill', 'onSpiritDiscard']);
		expect(typeof ability[0].run).toBe('function');
	});

	it('direct handler unit test: pushes a placeable augment + logs', () => {
		const player = makePlayer({ spirits: captainWithHeroes(3) });
		const ctx = ctxFor(player, { trigger: 'onCultivate' });
		ability[0].run!(ctx);
		expect(player.unplacedAugments?.length ?? 0).toBe(1);
		expect(ctx.log.some((l) => /spirit augment/i.test(l))).toBe(true);
	});
});
