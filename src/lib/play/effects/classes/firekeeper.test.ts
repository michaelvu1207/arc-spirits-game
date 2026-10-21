import { describe, expect, it } from 'vitest';
import { fire } from './testHelpers';

describe('Emberguard', () => {
	it('reduces damage by five after an even combat roll', () => {
		const even = fire({ 'Emberguard': 1 }, 'onTakeDamage', {
			player: { combatValueThisFight: 4 }
		});
		expect(even.player.damageReduction).toBe(5);
		const odd = fire({ 'Emberguard': 1 }, 'onTakeDamage', {
			player: { combatValueThisFight: 3 }
		});
		expect(odd.player.damageReduction).toBe(0);
	});
});
