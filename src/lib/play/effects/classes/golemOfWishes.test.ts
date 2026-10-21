import { describe, expect, it } from 'vitest';
import { fire } from './testHelpers';

describe('Living Bastion', () => {
	it('grants six mitigation, damage and initiative in combat', () => {
		const { player } = fire({ 'Living Bastion': 1 }, 'inCombat');
		expect(player.damageReduction).toBe(6);
		expect(player.combatDamageBonus).toBe(6);
		expect(player.initiative).toBe(6);
	});
});
