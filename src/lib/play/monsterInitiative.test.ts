import { describe, expect, it } from 'vitest';
import { makePlayer, makeState, spirit } from './effects/classes/testHelpers';
import { fightMonster, monsterInitiativeOf } from './combat';
import type { MonsterState } from './types';

/** A monster with Barrier 5 that hits for 10, optionally with an initiative number. */
function monster(initiative?: number): MonsterState {
	return {
		id: 'm', name: 'Test Monster', hp: 5, maxHp: 5, damage: 10, rewardTrack: [], chooseAmount: 0,
		livesRemaining: 1, livesTotal: 1, ladderIndex: 0, ladderMax: 1,
		...(initiative === undefined ? {} : { initiative })
	} as MonsterState;
}
// Fairy (awake) gives initiative 3 in every combat; Hunter deals 5 more damage to a monster.
const fight = (m: MonsterState) => {
	const player = makePlayer({ barrier: 4, maxBarrier: 4, spirits: [spirit(1, { Fairy: 1 }), spirit(2, { Hunter: 1 })], monsterHand: [m] });
	return fightMonster(makeState(player), 'Red', undefined, 0)!;
};

describe('monster initiative', () => {
	it('no number: the monster always strikes first (old rule)', () => {
		expect(monsterInitiativeOf(monster())).toBe(Number.POSITIVE_INFINITY);
		const r = fight(monster());
		expect(r.corrupted).toBe(true);
		expect(r.killed).toBe(false);
	});
	it('player initiative higher: the player strikes first and a kill takes no hit', () => {
		const r = fight(monster(2));
		expect(r.killed).toBe(true);
		expect(r.barrierLost).toBe(0);
		expect(r.corrupted).toBe(false);
	});
	it('a tie goes to the monster', () => {
		const r = fight(monster(3));
		expect(r.corrupted).toBe(true);
	});
});

describe('firetailVsMonsters', () => {
	const fightWith = (rules: Record<string, boolean> | undefined) => {
		const player = makePlayer({ barrier: 4, maxBarrier: 4, spirits: [spirit(1, { Firetail: 1 }), spirit(2, { Hunter: 1 })], monsterHand: [monster(2)] });
		return fightMonster(makeState(player), 'Red', { rules } as never, 0)!;
	};
	it('off: no initiative alone vs a monster (initiative 0 < 2): the monster strikes first', () => {
		expect(fightWith(undefined).corrupted).toBe(true);
	});
	it('on: +3 initiative vs a monster (3 > 2): strike first and kill', () => {
		const r = fightWith({ firetailVsMonsters: true });
		expect(r.killed).toBe(true);
		expect(r.barrierLost).toBe(0);
	});
});
