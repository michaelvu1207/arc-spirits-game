/**
 * Huntress — "On this spirit's Awakening, gain 3 Arcane Attack Dice."
 *
 * No initiative: initiative is the die, no class gives a number.
 *
 * UX channel: the awakening surfaces as a log line ("Gained 3 arcane attack dice.")
 * plus the three pushed arcane dice — never a silent no-op.
 */

import { describe, it, expect } from 'vitest';
import { fire } from './testHelpers';
import { ability } from './dragonWarrior';

describe('Huntress', () => {
	it('gives no initiative in combat', () => {
		const { player, log } = fire({ 'Huntress': 1 }, 'inCombat', {
			player: { initiative: 3 }
		});
		expect(player.initiative).toBe(3);
		expect(log.some((l) => l.includes('initiative'))).toBe(false);
	});

	it('grants exactly 3 arcane attack dice on awakening', () => {
		const { player } = fire({ 'Huntress': 1 }, 'awakening', { command: { slotIndex: 1 } });
		const arcane = player.attackDice.filter((d) => d.tier === 'arcane');
		expect(arcane).toHaveLength(3);
		expect(player.attackDice).toHaveLength(3);
	});

	it('surfaces the dice gain as a log line (no silent no-op)', () => {
		const { log } = fire({ 'Huntress': 1 }, 'awakening', { command: { slotIndex: 1 } });
		expect(log.some((l) => l.includes('Gained 3 arcane attack dice.'))).toBe(true);
	});

	it('adds the 3 arcane dice on top of any pre-existing dice', () => {
		const { player } = fire({ 'Huntress': 1 }, 'awakening', {
			command: { slotIndex: 1 },
			player: { attackDice: [{ instanceId: 'pre1', tier: 'basic' }] }
		});
		const arcane = player.attackDice.filter((d) => d.tier === 'arcane');
		expect(arcane).toHaveLength(3);
		expect(player.attackDice).toHaveLength(4);
	});

	it('hangs its dice on the awakening trigger', () => {
		const awakening = ability.find((a) => a.on === 'awakening');
		expect(typeof awakening?.run).toBe('function');
	});

	it("grants the dice only on THIS spirit's awakening, not when another spirit awakens", () => {
		const { player } = fire({ 'Huntress': 1 }, 'awakening', {
			command: { slotIndex: 2 },
			player: {
				spirits: [
					{ slotIndex: 1, id: 'h', name: 'Tide Huntress', cost: 9, classes: { Huntress: 1 }, origins: {}, isFaceDown: false },
					{ slotIndex: 2, id: 'o', name: 'Other', cost: 3, classes: { Fighter: 1 }, origins: {}, isFaceDown: false }
				]
			}
		});
		expect(player.attackDice).toHaveLength(0);
	});

	it('is inactive when the Huntress spirit is face-down (unawakened)', () => {
		const { player, log } = fire({ 'Huntress': 1 }, 'awakening', {
			command: { slotIndex: 1 },
			player: {
				spirits: [
					{
						slotIndex: 1,
						id: 's1',
						name: 'Spirit 1',
						cost: 2,
						classes: { 'Huntress': 1 },
						origins: {},
						isFaceDown: true
					}
				]
			}
		});
		expect(player.attackDice).toHaveLength(0);
		expect(log.some((l) => l.includes('attack dice'))).toBe(false);
	});
});
