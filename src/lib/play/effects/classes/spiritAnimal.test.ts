/**
 * Beast — one declarative `inCombat` ability with a `'1+'` breakpoint.
 *
 * DB-intended behavior (source of truth):
 *   In combat, deal 1 damage and gain 1 combat initiative for every Beast trait.
 *
 * `'1+'` scales BOTH amounts by the trait count: N traits => +N combat damage
 * (player.combatDamageBonus) and +N initiative (player.initiative).
 *
 * UX channel: passive combat numbers (combatDamageBonus + initiative) plus two
 * attributed combat-log lines ("Beast: Gained +N combat damage." /
 * "Beast: Gained N initiative.") — never a silent no-op.
 */

import { describe, it, expect } from 'vitest';
import { fire } from './testHelpers';
import { ability } from './spiritAnimal';

describe('Beast', () => {
	it('deals +1 combat damage and +1 initiative for a single trait', () => {
		const { player } = fire({ 'Beast': 1 }, 'inCombat');
		expect(player.combatDamageBonus).toBe(1);
		expect(player.initiative).toBe(1);
	});

	it('scales both amounts by the trait count (3 traits => +3 / +3)', () => {
		const { player } = fire({ 'Beast': 3 }, 'inCombat');
		expect(player.combatDamageBonus).toBe(3);
		expect(player.initiative).toBe(3);
	});

	it('surfaces both halves as attributed combat-log lines (no silent no-op)', () => {
		const { log } = fire({ 'Beast': 2 }, 'inCombat');
		expect(log.join("\n")).toContain('Beast: Gained +2 combat damage.');
		expect(log.join("\n")).toContain('Beast: Gained 2 initiative.');
	});

	it('stacks on top of pre-existing combat bonus and initiative', () => {
		const { player } = fire({ 'Beast': 1 }, 'inCombat', {
			player: { combatDamageBonus: 2, initiative: 5 }
		});
		expect(player.combatDamageBonus).toBe(3);
		expect(player.initiative).toBe(6);
	});

	it('only fires on the inCombat trigger', () => {
		const { player } = fire({ 'Beast': 2 }, 'awakening');
		expect(player.combatDamageBonus).toBe(0);
		expect(player.initiative).toBe(0);
	});

	it('is inactive when the Beast spirit is face-down (unawakened)', () => {
		const { player, log } = fire({ 'Beast': 2 }, 'inCombat', {
			player: {
				spirits: [
					{
						slotIndex: 1,
						id: 's1',
						name: 'Spirit 1',
						cost: 2,
						classes: { 'Beast': 2 },
						origins: {},
						isFaceDown: true
					}
				]
			}
		});
		expect(player.combatDamageBonus).toBe(0);
		expect(player.initiative).toBe(0);
		expect(log.some((l) => l.includes('combat damage') || l.includes('initiative'))).toBe(false);
	});

	it('declares a single inCombat ability with a per-trait (1+) breakpoint', () => {
		expect(ability).toHaveLength(1);
		const inCombat = ability.find((a) => a.on === 'inCombat');
		expect(inCombat?.breakpoints).toHaveLength(1);
		expect(inCombat?.breakpoints?.[0].count).toBe('1+');
		expect(inCombat?.breakpoints?.[0].actions).toEqual([
			{ kind: 'combatBonus', amount: 1 },
			{ kind: 'gainInitiative', amount: 1 }
		]);
	});
});
