/**
 * Arcane Vanguard — two declarative breakpoint abilities.
 *
 * DB-intended behavior (source of truth):
 *   - Gain 2 Initiative (inCombat).
 *   - On this spirit's Awakening, gain 3 Arcane Attack Dice (awakening).
 *
 * UX channel: both halves surface as combat/awakening log lines
 * ("Gained 2 initiative." / "Gained 3 arcane attack dice.") plus the mechanical
 * +2 initiative and the three pushed arcane dice — never a silent no-op.
 */

import { describe, it, expect } from 'vitest';
import { fire } from './testHelpers';
import { ability } from './dragonWarrior';

describe('Arcane Vanguard', () => {
	it('grants exactly 2 initiative on inCombat', () => {
		const { player } = fire({ 'Arcane Vanguard': 1 }, 'inCombat');
		expect(player.initiative).toBe(2);
	});

	it('surfaces the initiative gain as a log line (no silent no-op)', () => {
		const { log } = fire({ 'Arcane Vanguard': 1 }, 'inCombat');
		expect(log.some((l) => l.includes('Gained 2 initiative.'))).toBe(true);
	});

	it('adds 2 on top of any pre-existing initiative', () => {
		const { player } = fire({ 'Arcane Vanguard': 1 }, 'inCombat', {
			player: { initiative: 3 }
		});
		expect(player.initiative).toBe(5);
	});

	it('grants exactly 3 arcane attack dice on awakening', () => {
		const { player } = fire({ 'Arcane Vanguard': 1 }, 'awakening');
		const arcane = player.attackDice.filter((d) => d.tier === 'arcane');
		expect(arcane).toHaveLength(3);
		expect(player.attackDice).toHaveLength(3);
	});

	it('surfaces the dice gain as a log line (no silent no-op)', () => {
		const { log } = fire({ 'Arcane Vanguard': 1 }, 'awakening');
		expect(log.some((l) => l.includes('Gained 3 arcane attack dice.'))).toBe(true);
	});

	it('adds the 3 arcane dice on top of any pre-existing dice', () => {
		const { player } = fire({ 'Arcane Vanguard': 1 }, 'awakening', {
			player: { attackDice: [{ instanceId: 'pre1', tier: 'basic' }] }
		});
		const arcane = player.attackDice.filter((d) => d.tier === 'arcane');
		expect(arcane).toHaveLength(3);
		expect(player.attackDice).toHaveLength(4);
	});

	it('keeps the two abilities on their distinct triggers', () => {
		const inCombat = ability.find((a) => a.on === 'inCombat');
		const awakening = ability.find((a) => a.on === 'awakening');
		expect(inCombat?.breakpoints?.[0].actions).toEqual([{ kind: 'gainInitiative', amount: 2 }]);
		expect(awakening?.breakpoints?.[0].actions).toEqual([
			{ kind: 'gainAttackDice', tier: 'arcane', amount: 3 }
		]);
	});

	it('is inactive when the Arcane Vanguard spirit is face-down (unawakened)', () => {
		const { player, log } = fire({ 'Arcane Vanguard': 1 }, 'inCombat', {
			player: {
				spirits: [
					{
						slotIndex: 1,
						id: 's1',
						name: 'Spirit 1',
						cost: 2,
						classes: { 'Arcane Vanguard': 1 },
						origins: {},
						isFaceDown: true
					}
				]
			}
		});
		expect(player.initiative).toBe(0);
		expect(log.some((l) => l.includes('initiative'))).toBe(false);
	});
});
