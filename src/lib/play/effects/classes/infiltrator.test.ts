import { describe, expect, it } from 'vitest';
import { fire, makePlayer, makeState, spirit } from './testHelpers';
import { applyTrigger } from '../apply';
import type { PrivatePlayerState } from '../../types';

/** Ram — "In combat, deal 1 more damage for each Spirit Augment on your spirits." Every placed
 *  augment counts; augments not yet placed do not. Ram gives no augment at the Mountain Region. */
function navigate(player: PrivatePlayerState, destination: string) {
	player.navigationDestination = destination as PrivatePlayerState['navigationDestination'];
	applyTrigger(makeState(player), 'Red', 'onNavigate', []);
	return player.pendingDecisions;
}

describe('Ram', () => {
	it('in combat: 1 more damage for each placed Spirit Augment; unplaced augments do not count', () => {
		const { player, log } = fire({ Ram: 1 }, 'inCombat', {
			player: {
				spirits: [spirit(1, { Ram: 1 }), spirit(2, {}, { faceDown: true })],
				spiritAugmentAttachments: [
					{ runeId: 'a', spiritId: 's1', spiritSlotIndex: 1, className: 'Fighter' },
					{ runeId: 'b', spiritId: 's2', spiritSlotIndex: 2, className: 'Mage' }
				],
				unplacedAugments: [{ id: 'u1' } as never]
			}
		});
		expect(player.combatDamageBonus).toBe(2);
		expect(log.some((l) => l.includes('Ram: 2 Spirit Augments — deal 2 more damage.'))).toBe(true);
	});

	it('the Mountain Region gives no card and no augment, and a face-down Ram deals nothing', () => {
		const player = makePlayer({ spirits: [spirit(1, { Ram: 1 })] });
		expect(navigate(player, 'Mountain Region')).toHaveLength(0);
		expect(player.unplacedAugments ?? []).toHaveLength(0);
		const faceDown = fire({ Ram: 1 }, 'inCombat', {
			player: {
				spirits: [spirit(1, { Ram: 1 }, { faceDown: true })],
				spiritAugmentAttachments: [{ runeId: 'a', spiritId: 's1', spiritSlotIndex: 1, className: 'Fighter' }]
			}
		});
		expect(faceDown.player.combatDamageBonus).toBe(0);
	});

	it('the old rule is gone: no combat damage from Cursed Spirit traits', () => {
		const { player } = fire({ Ram: 1 }, 'inCombat', {
			player: { spirits: [spirit(1, { Ram: 1 }), spirit(2, { 'Cursed Spirit': 3 })] }
		});
		expect(player.combatDamageBonus).toBe(0);
	});
});
