import { describe, expect, it } from 'vitest';
import { fire, makePlayer, makeState, spirit } from './testHelpers';
import { applyTrigger } from '../apply';
import { resetCombatFlags, takeDamage } from '../../combat';
import type { PrivatePlayerState } from '../../types';

/** Monk — "While you are not Evil and have no Cursed Spirits, take 2 less damage." No initiative.
 *  Checked when each combat starts; the reduction comes off each hit (like Titan). */
function startCombat(player: PrivatePlayerState, opponent?: 'Blue') {
	const state = makeState(player, opponent ? { Blue: makePlayer({ playerColor: 'Blue' }) } : {});
	resetCombatFlags(player);
	applyTrigger(state, 'Red', 'inCombat', [], { opponent });
	return state;
}

describe('Monk', () => {
	it('not Evil, no Cursed Spirit: 2 less damage on each hit, and no initiative', () => {
		const player = makePlayer({ barrier: 10, maxBarrier: 10, spirits: [spirit(1, { Monk: 1 })] });
		const state = startCombat(player);
		expect(player.damageReduction).toBe(2);
		expect(player.initiative).toBe(0);
		takeDamage(player, 5, { state, seat: 'Red' }, []);
		takeDamage(player, 5, { state, seat: 'Red' }, []);
		expect(player.barrier).toBe(4); // two hits of 5 − 2
	});

	it('PvP combat gets it too', () => {
		const player = makePlayer({ spirits: [spirit(1, { Monk: 1 })] });
		startCombat(player, 'Blue');
		expect(player.damageReduction).toBe(2);
	});

	it('Evil: nothing', () => {
		const { player } = fire({ Monk: 1 }, 'inCombat', { player: { statusLevel: 3 } });
		expect(player.damageReduction).toBe(0);
	});

	it('one Cursed Spirit (face-down too): nothing; a Cursed Spirit augment does not count', () => {
		const faceDownCursed = makePlayer({
			spirits: [spirit(1, { Monk: 1 }), spirit(2, { 'Cursed Spirit': 1 }, { faceDown: true })]
		});
		startCombat(faceDownCursed);
		expect(faceDownCursed.damageReduction).toBe(0);

		const cursedAugment = makePlayer({
			spirits: [spirit(1, { Monk: 1 }), spirit(2, { Fighter: 1 })],
			spiritAugmentAttachments: [
				{ runeId: 'a', spiritId: 's2', spiritSlotIndex: 2, className: 'Cursed Spirit' }
			]
		});
		startCombat(cursedAugment);
		expect(cursedAugment.damageReduction).toBe(2);
	});

	it('the condition is checked again at each combat', () => {
		const player = makePlayer({ spirits: [spirit(1, { Monk: 1 })] });
		startCombat(player);
		expect(player.damageReduction).toBe(2);
		player.statusLevel = 3; // turned Evil between the two combats
		startCombat(player);
		expect(player.damageReduction).toBe(0);
	});

	it('stacks with Titan', () => {
		const player = makePlayer({ spirits: [spirit(1, { Monk: 1 }), spirit(2, { Titan: 1 })] });
		startCombat(player);
		expect(player.damageReduction).toBe(8);
		expect(player.combatDamageBonus).toBe(6);
	});

	it('the old rule is gone: placed augments do not reduce damage', () => {
		const { player } = fire({ Monk: 1 }, 'onTakeDamage', {
			player: {
				spiritAugmentAttachments: [{ spiritSlotIndex: 1, runeId: 'a', spiritId: 's1', className: 'Fighter' }]
			}
		});
		expect(player.damageReduction).toBe(0);
	});
});
