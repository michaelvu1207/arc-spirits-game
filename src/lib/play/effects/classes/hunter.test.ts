import { describe, expect, it } from 'vitest';
import { makePlayer, makeState, spirit } from './testHelpers';
import { applyTrigger } from '../apply';
import { fightMonster, resetCombatFlags } from '../../combat';
import type { MonsterState } from '../../types';

/** Hunter — "In combat with a monster, deal 5 more damage." Flat, once per monster combat. */
function monster(damage: number, hp: number): MonsterState {
	return {
		id: 'm',
		name: 'Test Monster',
		hp,
		maxHp: hp,
		damage,
		rewardTrack: [],
		chooseAmount: 0,
		livesRemaining: 1,
		livesTotal: 1,
		ladderIndex: 0,
		ladderMax: 1
	} as MonsterState;
}

describe('Hunter', () => {
	it('awake: +5 damage in a monster combat', () => {
		const player = makePlayer({ spirits: [spirit(1, { Hunter: 1 })], monsterHand: [monster(1, 30)] });
		expect(fightMonster(makeState(player), 'Red', undefined, 0)!.playerDamage).toBe(5);
	});

	it('face-down: no bonus', () => {
		const player = makePlayer({
			spirits: [spirit(1, { Hunter: 1 }, { faceDown: true })],
			monsterHand: [monster(1, 30)]
		});
		expect(fightMonster(makeState(player), 'Red', undefined, 0)!.playerDamage).toBe(0);
	});

	it('no bonus in PvP; no Evil condition and no Initiative (old rule gone)', () => {
		const player = makePlayer({ statusLevel: 3, spirits: [spirit(1, { Hunter: 1 })] });
		const state = makeState(player, { Blue: makePlayer({ playerColor: 'Blue' }) });
		resetCombatFlags(player);
		applyTrigger(state, 'Red', 'inCombat', [], { opponent: 'Blue' });
		expect(player.combatDamageBonus).toBe(0);
		expect(player.initiative).toBe(0);
	});

	it('both Monster Hunter combats get the bonus', () => {
		const player = makePlayer({
			barrier: 10,
			maxBarrier: 10,
			spirits: [spirit(1, { Hunter: 1 }), spirit(2, { 'Monster Hunter': 1 })],
			monsterHand: [monster(1, 30)]
		});
		const state = makeState(player);
		expect(fightMonster(state, 'Red', undefined, 0)!.playerDamage).toBe(5);
		expect(fightMonster(state, 'Red', undefined, 0)!.playerDamage).toBe(5);
	});
});
