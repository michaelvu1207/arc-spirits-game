import { describe, expect, it } from 'vitest';
import { fire, spirit } from './testHelpers';

describe('Cursed Fighter', () => {
	it('gains one combat damage per awakened Cursed Spirit trait', () => {
		const { player } = fire({ 'Cursed Fighter': 1 }, 'inCombat', {
			player: { spirits: [spirit(1, { 'Cursed Fighter': 1 }), spirit(2, { 'Cursed Spirit': 3 })] }
		});
		expect(player.combatDamageBonus).toBe(3);
	});
});
