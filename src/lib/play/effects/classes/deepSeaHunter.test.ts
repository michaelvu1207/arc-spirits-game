import { describe, expect, it } from 'vitest';
import { fire } from './testHelpers';

describe('Spellblade', () => {
	it('offers a navigation redirect without granting initiative', () => {
		const { player } = fire({ 'Spellblade': 1 }, 'onNavigate');
		expect(player.pendingDecisions[0]?.kind).toBe('deepSeaHunterRedirect');
		expect(player.initiative).toBe(0);
	});

	it('sets attack-first priority in combat', () => {
		const { player } = fire({ 'Spellblade': 1 }, 'inCombat');
		expect(player.alwaysAttackFirst).toBe(true);
	});
});
