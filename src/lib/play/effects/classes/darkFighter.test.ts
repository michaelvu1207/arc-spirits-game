import { describe, expect, it } from 'vitest';
import { fire, makePlayer, makeState, spirit } from './testHelpers';
import { applyTrigger } from '../apply';
import { resetCombatFlags, resolveEncounterCombat } from '../../combat';
import type { AttackDie, PrivatePlayerState } from '../../types';

/** Assassin — "In combat with a player who has more attack dice than you, strike first and deal
 *  3 more damage." */
const dice = (n: number): AttackDie[] => Array.from({ length: n }, (_, i) => ({ instanceId: `x${i}`, tier: 'basic' }));

function inCombat(me: Partial<PrivatePlayerState>, them: Partial<PrivatePlayerState>) {
	const red = makePlayer({ spirits: [spirit(1, { Assassin: 1 })], ...me });
	const blue = makePlayer({ playerColor: 'Blue', ...them });
	const state = makeState(red, { Blue: blue });
	resetCombatFlags(red);
	applyTrigger(state, 'Red', 'inCombat', [], { opponent: 'Blue' });
	return red;
}

describe('Assassin', () => {
	it('opponent has more dice: strike first and +3 damage', () => {
		const red = inCombat({ attackDice: dice(2) }, { attackDice: dice(3) });
		expect(red.alwaysAttackFirst).toBe(true);
		expect(red.combatDamageBonus).toBe(3);
	});

	it('equal or fewer dice: nothing', () => {
		for (const n of [2, 1]) {
			const red = inCombat({ attackDice: dice(2) }, { attackDice: dice(n) });
			expect(red.alwaysAttackFirst).toBe(false);
			expect(red.combatDamageBonus).toBe(0);
		}
	});

	it('monster combat, or face-down: nothing', () => {
		expect(fire({ Assassin: 1 }, 'inCombat').player.combatDamageBonus).toBe(0);
		const red = inCombat({ spirits: [spirit(1, { Assassin: 1 }, { faceDown: true })] }, { attackDice: dice(3) });
		expect(red.combatDamageBonus).toBe(0);
	});

	it('the old rule is gone: no +4 Initiative and no roll-twice', () => {
		const red = inCombat({}, { attackDice: dice(3) });
		expect(red.initiative).toBe(0);
		expect(red.attackRollAdvantage).toBe(false);
	});

	it('PvP: the Assassin side strikes first even with less Initiative', () => {
		const red = makePlayer({ navigationDestination: 'Forest Region', spirits: [spirit(1, { Assassin: 1 })] });
		const blue = makePlayer({
			playerColor: 'Blue',
			statusLevel: 3,
			navigationDestination: 'Forest Region',
			attackDice: dice(2),
			spirits: [spirit(1, { Titan: 1 })]
		});
		const combat = resolveEncounterCombat(makeState(red, { Blue: blue }), undefined, ['Blue'], ['Red']);
		expect(combat.log.some((l) => l.startsWith('Good attacks first'))).toBe(true);
	});
});
