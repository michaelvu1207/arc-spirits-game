import { describe, expect, it } from 'vitest';
import { fire } from './testHelpers';

describe('Runic Bulwark', () => {
	it('reduces incoming damage by the number of placed augments', () => {
		const { player } = fire({ 'Runic Bulwark': 1 }, 'onTakeDamage', {
			player: {
				spiritAugmentAttachments: [
					{ spiritSlotIndex: 1, runeId: 'a' },
					{ spiritSlotIndex: 1, runeId: 'b' }
				] as never
			}
		});
		expect(player.damageReduction).toBe(2);
	});
});
