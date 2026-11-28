import { describe, it, expect } from 'vitest';
import { fire, spirit } from './testHelpers';
import type { MatSlotSnapshot } from '$lib/types';

// Mage — "On this spirit's Awakening, gain 3 Arcane Attack Dice." and nothing else: there is no
// rune trade in the Awakening Phase. The dice come once, when the awakened spirit is itself a Mage.

function rune(slotIndex: number): MatSlotSnapshot {
	return { slotIndex, hasRune: true, name: 'Rune', type: 'rune' };
}

describe('Mage (on its own awakening: 3 Arcane Attack Dice)', () => {
	it('its own awakening gives 3 Arcane Attack Dice', () => {
		const { player, log } = fire({ Mage: 1 }, 'awakening', { command: { slotIndex: 1 } });
		expect(player.attackDice.map((d) => d.tier)).toEqual(['arcane', 'arcane', 'arcane']);
		expect(log.some((l) => l.includes('Gained 3 arcane attack dice.'))).toBe(true);
	});

	it('another spirit awakening gives nothing', () => {
		const { player } = fire({ Mage: 1 }, 'awakening', {
			command: { slotIndex: 2 },
			player: { spirits: [spirit(1, { Mage: 1 }), spirit(2, { Fighter: 1 })] }
		});
		expect(player.attackDice).toHaveLength(0);
	});

	it('the Awakening Phase offers no rune trade, even while a rune is held', () => {
		const { player } = fire({ Mage: 1 }, 'awakeningPhase', { player: { mats: [rune(1)] } });
		expect(player.pendingDecisions).toHaveLength(0);
		expect(player.mats[0].hasRune).toBe(true);
		expect(player.attackDice).toHaveLength(0);
	});
});
