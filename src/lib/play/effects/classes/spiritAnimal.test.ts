/**
 * Beast — one declarative `inCombat` ability with a `'1+'` breakpoint.
 *
 * DB-intended behavior (source of truth):
 *   In combat, deal 1 more damage for every Beast trait. No initiative.
 *
 * `'1+'` scales the amount by the trait count: N traits => +N combat damage
 * (player.combatDamageBonus).
 *
 * UX channel: a passive combat number (combatDamageBonus) plus an attributed
 * combat-log line ("Beast: Gained +N combat damage.") — never a silent no-op.
 */

import { describe, it, expect } from 'vitest';
import { fire } from './testHelpers';
import { ability } from './spiritAnimal';

describe('Beast', () => {
	it('deals +1 combat damage and gives no initiative for a single trait', () => {
		const { player } = fire({ 'Beast': 1 }, 'inCombat');
		expect(player.combatDamageBonus).toBe(1);
		expect(player.initiative).toBe(0);
	});

	it('scales the damage by the trait count (3 traits => +3)', () => {
		const { player } = fire({ 'Beast': 3 }, 'inCombat');
		expect(player.combatDamageBonus).toBe(3);
		expect(player.initiative).toBe(0);
	});

	it('surfaces the damage as an attributed combat-log line (no silent no-op)', () => {
		const { log } = fire({ 'Beast': 2 }, 'inCombat');
		expect(log.join("\n")).toContain('Beast: Gained +2 combat damage.');
		expect(log.some((l) => l.includes('initiative'))).toBe(false);
	});

	it('stacks on top of a pre-existing combat bonus and leaves initiative alone', () => {
		const { player } = fire({ 'Beast': 1 }, 'inCombat', {
			player: { combatDamageBonus: 2, initiative: 5 }
		});
		expect(player.combatDamageBonus).toBe(3);
		expect(player.initiative).toBe(5);
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
		expect(inCombat?.breakpoints?.[0].actions).toEqual([{ kind: 'combatBonus', amount: 1 }]);
	});
});
