import { describe, expect, it } from 'vitest';
import { fire, spirit } from './testHelpers';
import { CLASS_DECISIONS } from '../abilities';

/** Sorcerer — "In the Awakening Phase, if you are Evil, gain 1 Enchanted Attack Dice." */
describe('Sorcerer', () => {
	it('Evil: +1 Enchanted die in the Awakening Phase', () => {
		const { player } = fire({ Sorcerer: 1 }, 'awakeningPhase', { player: { statusLevel: 3 } });
		expect(player.attackDice.map((d) => d.tier)).toEqual(['enchanted']);
	});
	it('not Evil, or face-down: nothing', () => {
		expect(fire({ Sorcerer: 1 }, 'awakeningPhase', { player: { statusLevel: 2 } }).player.attackDice).toHaveLength(0);
		const faceDown = fire({}, 'awakeningPhase', {
			player: { statusLevel: 3, spirits: [spirit(1, { Sorcerer: 1 }, { faceDown: true })] }
		});
		expect(faceDown.player.attackDice).toHaveLength(0);
	});
	it('the normal gain path: the cap of 10 holds', () => {
		const full = Array.from({ length: 10 }, (_, i) => ({ instanceId: `d${i}`, tier: 'basic' as const }));
		const { player } = fire({ Sorcerer: 1 }, 'awakeningPhase', { player: { statusLevel: 3, attackDice: full } });
		expect(player.attackDice).toHaveLength(10);
	});
	it('the old Exalted → Arcane upgrade card is gone', () => {
		const exalted = [{ instanceId: 'e', tier: 'exalted' as const }];
		const { player } = fire({ Sorcerer: 1 }, 'awakeningPhase', { player: { attackDice: exalted } });
		expect(player.pendingDecisions).toHaveLength(0);
		expect(CLASS_DECISIONS['arcaneAdvisorUpgrade']).toBeUndefined();
	});
});
