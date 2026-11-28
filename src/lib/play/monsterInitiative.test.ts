import { describe, expect, it } from 'vitest';
import { makePlayer, makeState, spirit } from './effects/classes/testHelpers';
import { fightMonster } from './combat';
import type { MonsterState } from './types';

/** A monster with Barrier 5 that hits for 10, optionally with an initiative number. */
function monster(initiative?: number): MonsterState {
	return {
		id: 'm', name: 'Test Monster', hp: 5, maxHp: 5, damage: 10, rewardTrack: [], chooseAmount: 0,
		livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1,
		...(initiative === undefined ? {} : { initiative })
	} as MonsterState;
}
// Hunter deals 5 more damage to a monster: enough to kill this one.
const fight = (m: MonsterState, strikeFirstCharges = 0) => {
	const player = makePlayer({ barrier: 4, maxBarrier: 4, spirits: [spirit(1, { Fairy: 1 }), spirit(2, { Hunter: 1 })], monsterHand: [m], strikeFirstCharges });
	return fightMonster(makeState(player), 'Red', undefined, 0)!;
};

describe('a monster always has the initiative', () => {
	it('its hit lands whatever initiative number the card prints', () => {
		for (const initiative of [undefined, 0, 2, 3]) {
			const r = fight(monster(initiative));
			expect(r.corrupted).toBe(true);
			expect(r.barrierLost).toBeGreaterThan(0);
		}
	});
	it('a player who has the initiative attacks at the same time: the kill still takes the hit', () => {
		const r = fight(monster(2), 1); // a Firecracker charge gives the initiative if the die misses
		expect(r.killed).toBe(true);
		expect(r.corrupted).toBe(true);
	});
});
