/**
 * Captain — "After you defeat a monster, gain 1 random Power."
 *
 * That is the whole ability: no Cultivate clause (the old "+1 Spirit Augment with 3 Heroes")
 * and no "When discarded" clause. The Power comes from the same pool as the Forest Region's
 * random Power and lands in `player.powerInventory`, with a log line.
 */

import { describe, it, expect } from 'vitest';
import { ability } from './captain';
import { fire, makePlayer, spirit, ctxFor } from './testHelpers';

/** Build a Captain player carrying `heroCount` Human Enclave spirits. */
function captainWithHeroes(heroCount: number) {
	const spirits = [spirit(1, { Captain: 1 }, { origins: { 'Human Enclave': 1 } })];
	for (let i = 2; i <= heroCount; i += 1) {
		spirits.push(spirit(i, {}, { origins: { 'Human Enclave': 1 } }));
	}
	return spirits;
}

describe('Captain (after a monster kill → 1 random Power)', () => {
	it('Cultivate with 3 Heroes gives no Spirit Augment, and a discard gives no die', () => {
		const cultivated = fire({ Captain: 1 }, 'onCultivate', { player: { spirits: captainWithHeroes(3) } });
		expect(cultivated.player.unplacedAugments?.length ?? 0).toBe(0);
		const discarded = fire({ Captain: 1 }, 'onSpiritDiscard');
		expect(discarded.player.attackDice).toHaveLength(0);
	});

	it('exposes only the monster-kill ability', () => {
		expect(ability.map((x) => x.on)).toEqual(['onMonsterKill']);
		expect(typeof ability[0].run).toBe('function');
	});

	it('direct handler unit test: a kill gives 1 random Power + logs; no kill gives none', () => {
		const player = makePlayer({ spirits: [spirit(1, { Captain: 1 })] });
		const ctx = ctxFor(player, { trigger: 'onMonsterKill' });
		ctx.combat = { dealt: 5, overkill: 0, killed: false };
		ability[0].run!(ctx);
		expect(player.powerInventory ?? []).toHaveLength(0);
		ctx.combat = { dealt: 5, overkill: 0, killed: true };
		ability[0].run!(ctx);
		expect(player.powerInventory ?? []).toHaveLength(1);
		expect(ctx.log.some((l) => l.startsWith('Captain: defeated a monster — gained 1 random Power'))).toBe(true);
	});
});
