import { describe, expect, it } from 'vitest';
import {
	takeDamage,
	fightMonster,
	rollAttack,
	resetCombatFlags,
	advanceMonsterIfDefeated,
	monsterLivesForPlayerCount,
	pvpVpForAttack,
	DICE_TIER_FACES
} from './combat';
import { createRng } from './rng';
import type {
	AttackDie,
	MonsterState,
	PlayCatalog,
	PlaySpirit,
	PrivatePlayerState,
	PublicGameState,
	SeatColor
} from './types';

/** A face-up spirit carrying the given class trait counts. */
function spirit(slotIndex: number, classes: Record<string, number>): PlaySpirit {
	return {
		slotIndex,
		id: `s${slotIndex}`,
		name: `S${slotIndex}`,
		cost: 2,
		classes,
		origins: {},
		isFaceDown: false
	};
}

function makePlayer(overrides: Partial<PrivatePlayerState> = {}): PrivatePlayerState {
	return {
		playerColor: 'Red',
		displayName: 'Tester',
		selectedGuardian: 'Myrtle',
		navigationDestination: 'Arcane Abyss',
		brokenBarrier: 0,
		victoryPoints: 0,
		vpHistory: [],
		barrier: 4,
		maxBarrier: 4,
		statusLevel: 0,
		statusToken: 'Pure',
		spirits: [],
		mats: [],
		handDraws: [],
		pendingDraw: null,
		pendingDrawQueue: [],
		spawnedDice: [],
		spawnedItems: [],
		spiritAugmentAttachments: [],
		pendingDestination: null,
		attackDice: [],
		initiative: 0,
		actionsUsedThisRound: [],
		awakenEligible: [],
		awakenOffers: [],
		awakenLocked: [],
		phaseReady: false,
		manualPrompts: [],
		pendingDecisions: [],
		lastAction: null,
		pendingReward: null,
		pendingAwakenReward: null,
		pendingCorruptionDiscard: null,
		damageReduction: 0,
		deflect: 0,
		combatDamageBonus: 0,
		stunImmune: false,
		spiritAugments: 0,
		relics: 0,
		extraActions: {},
		combatDamageMultiplier: 1,
		attackRollAdvantage: false,
		halveIncoming: false,
		skipTakeDamage: false,
		doubleRunes: false,
		redrawAvailable: false,
		freeNextRelicTrade: false,
		becameTaintedThisRound: false,
		becameCorruptThisRound: false,
		becameFallenThisRound: false,
		corruptedThisRound: false,
		awakenProgress: {},
		...overrides
	};
}

function dice(tier: AttackDie['tier'], count: number): AttackDie[] {
	return Array.from({ length: count }, (_, i) => ({ instanceId: `d${i}`, tier }));
}

function makeState(
	player: PrivatePlayerState,
	monster: MonsterState | null,
	seed = 1
): PublicGameState {
	const seat: SeatColor = 'Red';
	return {
		rng: createRng(seed),
		monster,
		players: { [seat]: player },
		activeSeats: [seat]
	} as unknown as PublicGameState;
}

function makeMonster(overrides: Partial<MonsterState> = {}): MonsterState {
	return {
		id: 'm1',
		name: 'Imp',
		hp: 5,
		maxHp: 5,
		damage: 2,
		rewardTrack: [],
		chooseAmount: 2,
		livesRemaining: 1,
		livesTotal: 1,
		ladderIndex: 0,
		ladderMax: 3,
		...overrides
	};
}

describe('takeDamage', () => {
	it('flips barrier to blood without corrupting when absorbed', () => {
		const p = makePlayer({ barrier: 4, maxBarrier: 4 });
		const r = takeDamage(p, 2);
		expect(r.corrupted).toBe(false);
		expect(p.barrier).toBe(2);
		expect(p.brokenBarrier).toBe(2);
	});

	it('corrupts when the hit empties the barrier EXACTLY (0 health), not just on overkill', () => {
		// barrier 3, take exactly 3 → barrier hits 0 (all potential tokens on the Arcane Blood
		// side). Under the old overkill rule (amount > barrier) this did NOT corrupt; now it must.
		const p = makePlayer({
			barrier: 3,
			maxBarrier: 4,
			statusLevel: 0,
			statusToken: 'Pure',
			spirits: [spirit(1, {}), spirit(2, {})]
		});
		const r = takeDamage(p, 3);
		expect(r.corrupted).toBe(true);
		expect(p.statusLevel).toBe(1); // status dropped one step
		expect(p.barrier).toBe(4); // corruption instantly heals to full
		expect(p.corruptionCount).toBe(1);
		expect(p.pendingCorruptionDiscard).toEqual({ count: 1, reason: undefined });
	});

	it('does NOT corrupt when the hit leaves any barrier (one short of zero)', () => {
		const p = makePlayer({ barrier: 3, maxBarrier: 4 });
		const r = takeDamage(p, 2); // barrier 3 → 1, still has health
		expect(r.corrupted).toBe(false);
		expect(p.barrier).toBe(1);
		expect(p.brokenBarrier).toBe(3);
	});

	it('corrupts when damage exceeds barrier: status drops, barrier INSTANTLY heals to full, owes 1 discard', () => {
		const p = makePlayer({
			barrier: 3,
			maxBarrier: 4,
			statusLevel: 0,
			statusToken: 'Pure',
			spirits: [spirit(1, {}), spirit(2, {})]
		});
		const r = takeDamage(p, 5);
		expect(r.corrupted).toBe(true);
		expect(p.statusLevel).toBe(1);
		expect(p.statusToken).toBe('Tainted');
		// Corruption now INSTANTLY restores all health (arcane blood flips back to barrier),
		// then bills the escalating sacrifice in forced spirit discards.
		expect(p.barrier).toBe(4); // healed to maxTokens
		expect(p.brokenBarrier).toBe(0);
		expect(p.corruptionCount).toBe(1); // first corruption
		// 1st corruption owes 1 forced discard. No slot-limit/overflow logic any more.
		expect(p.pendingCorruptionDiscard).toEqual({ count: 1, reason: undefined });
	});

	it('corrupting with NO spirits skips the discard obligation (nothing to sacrifice)', () => {
		const p = makePlayer({
			barrier: 3,
			maxBarrier: 4,
			statusLevel: 0,
			statusToken: 'Pure',
			spirits: []
		});
		const r = takeDamage(p, 5);
		expect(r.corrupted).toBe(true);
		expect(p.corruptionCount).toBe(1);
		// No spirits to shed → the obligation is never set, so Cleanup is never blocked.
		expect(p.pendingCorruptionDiscard).toBeNull();
	});

	it('corrupting with fewer spirits than owed caps the obligation at the spirit count', () => {
		// 2nd corruption owes 2, but the player holds only 1 spirit → owe just that 1.
		const p = makePlayer({
			barrier: 3,
			maxBarrier: 4,
			statusLevel: 1,
			statusToken: 'Tainted',
			spirits: [spirit(1, {})],
			corruptionCount: 1
		});
		const r = takeDamage(p, 5);
		expect(r.corrupted).toBe(true);
		expect(p.corruptionCount).toBe(2);
		expect(p.pendingCorruptionDiscard).toEqual({ count: 1, reason: undefined });
	});

	it('owes a discard regardless of status — corrupting at Fallen still bills the sacrifice', () => {
		// No slot cap any more: the owed count comes from corruptionCount, not the tableau size.
		const spirits = Array.from({ length: 3 }, (_, i) => ({
			slotIndex: i + 1,
			id: `s${i}`,
			name: `S${i}`,
			cost: 2,
			classes: {},
			origins: {},
			isFaceDown: false
		}));
		const p = makePlayer({
			barrier: 0,
			maxBarrier: 4,
			statusLevel: 3,
			statusToken: 'Fallen',
			spirits
		});
		const r = takeDamage(p, 1);
		expect(r.corrupted).toBe(true);
		expect(p.statusLevel).toBe(3); // can't drop past the last status
		expect(p.statusToken).toBe('Fallen');
		// Instant heal to full.
		expect(p.barrier).toBe(4);
		expect(p.brokenBarrier).toBe(0);
		// Spirits are NOT auto-trimmed — the player chooses which to shed via discardSpirit.
		expect(r.discarded).toBe(0);
		expect(p.spirits).toHaveLength(3);
		expect(p.corruptionCount).toBe(1);
		expect(p.pendingCorruptionDiscard).toEqual({ count: 1, reason: undefined });
	});

	it('the owed discard scales with corruptionCount — the Nth corruption owes N spirits', () => {
		// Start as if this is the player's SECOND corruption (corruptionCount already 1).
		const spirits = Array.from({ length: 5 }, (_, i) => ({
			slotIndex: i + 1,
			id: `s${i}`,
			name: `S${i}`,
			cost: 2,
			classes: {},
			origins: {},
			isFaceDown: false
		}));
		const p = makePlayer({
			barrier: 0,
			maxBarrier: 4,
			statusLevel: 1,
			statusToken: 'Tainted',
			spirits,
			corruptionCount: 1
		});
		const r = takeDamage(p, 1);
		expect(r.corrupted).toBe(true);
		expect(r.discarded).toBe(0); // no auto-trim
		expect(p.spirits).toHaveLength(5); // tableau untouched — player chooses what to drop
		expect(p.barrier).toBe(4); // instant heal to full
		expect(p.corruptionCount).toBe(2); // second corruption
		expect(p.pendingCorruptionDiscard).toEqual({ count: 2, reason: undefined }); // owes 2
	});

	it('takeDamage never mutates the tableau — the discard is owed, not auto-applied', () => {
		const spirits = Array.from({ length: 6 }, (_, i) => ({
			slotIndex: i + 1,
			id: `s${i}`,
			name: `S${i}`,
			cost: 2,
			classes: {},
			origins: {},
			isFaceDown: false
		}));
		const p = makePlayer({
			barrier: 0,
			maxBarrier: 4,
			statusLevel: 1,
			statusToken: 'Tainted',
			spirits
		});
		const r = takeDamage(p, 1);
		expect(r.corrupted).toBe(true);
		expect(p.statusLevel).toBe(2);
		expect(r.discarded).toBe(0); // takeDamage no longer mutates spirits
		expect(p.spirits).toHaveLength(6); // tableau untouched until the player discards
		expect(p.barrier).toBe(4); // instant heal to full
		expect(p.corruptionCount).toBe(1);
		expect(p.pendingCorruptionDiscard).toEqual({ count: 1, reason: undefined });
	});

	it('accumulates the owed count when two corruptions land in one exchange', () => {
		const spirits = Array.from({ length: 7 }, (_, i) => ({
			slotIndex: i + 1,
			id: `s${i}`,
			name: `S${i}`,
			cost: 2,
			classes: {},
			origins: {},
			isFaceDown: false
		}));
		const p = makePlayer({
			barrier: 0,
			maxBarrier: 4,
			statusLevel: 0,
			statusToken: 'Pure',
			spirits
		});
		// 1st corruption: heals to full, corruptionCount 1, owes 1.
		takeDamage(p, 1);
		expect(p.statusLevel).toBe(1);
		expect(p.corruptionCount).toBe(1);
		expect(p.pendingCorruptionDiscard?.count).toBe(1);
		// Now barrier is healed to maxTokens (4), so a 5-damage hit corrupts again in the same
		// exchange: corruptionCount → 2, owes 2 MORE, accumulated onto the existing 1 → 3 total.
		takeDamage(p, 5);
		expect(p.statusLevel).toBe(2);
		expect(p.corruptionCount).toBe(2);
		expect(p.spirits).toHaveLength(7); // still nothing auto-trimmed
		expect(p.barrier).toBe(4); // healed to full again
		expect(p.pendingCorruptionDiscard).toEqual({ count: 3, reason: undefined });
	});
});

describe('rollAttack', () => {
	it('sums arcane dice to at least the die count (min face is 1)', () => {
		const p = makePlayer({ attackDice: dice('arcane', 4) });
		const state = makeState(p, null, 7);
		expect(rollAttack(state, p)).toBeGreaterThanOrEqual(4);
	});

	it('is deterministic for a fixed seed', () => {
		const p1 = makePlayer({ attackDice: dice('basic', 6) });
		const p2 = makePlayer({ attackDice: dice('basic', 6) });
		expect(rollAttack(makeState(p1, null, 42), p1)).toBe(rollAttack(makeState(p2, null, 42), p2));
	});

	it('basic dice never exceed 1 per face', () => {
		expect(Math.max(...DICE_TIER_FACES.basic)).toBe(1);
	});
});

describe('fightMonster', () => {
	it('monster hits the player and the player chips the monster (HP does not persist)', () => {
		const p = makePlayer({ barrier: 4, attackDice: dice('basic', 2) });
		const monster = makeMonster({ hp: 10, maxHp: 10, damage: 2 });
		const state = makeState(p, monster, 3);
		const result = fightMonster(state, 'Red');
		expect(result).not.toBeNull();
		expect(result!.corrupted).toBe(false);
		expect(p.barrier).toBe(2); // took 2 monster damage
		// Shared monster HP is NOT chipped — every combat fights a full-strength monster.
		expect(monster.hp).toBe(monster.maxHp);
		// The combat record/snapshot still reflects THIS combat's ending HP.
		expect(result!.fought?.hp).toBe(10 - result!.playerDamage);
	});

	it('monster HP does not persist across combats: a second fight starts at full HP', () => {
		// Two consecutive non-kill fights (maxHp far above one roll's damage, monster deals 0 so
		// the player never corrupts). The second fight must NOT start from the first's chip.
		const p = makePlayer({ barrier: 4, attackDice: dice('basic', 2) });
		const monster = makeMonster({ hp: 20, maxHp: 20, damage: 0 });
		const state = makeState(p, monster, 3);

		const first = fightMonster(state, 'Red');
		expect(first!.killed).toBe(false);
		expect(monster.hp).toBe(20); // shared state restored to full after the fight

		const second = fightMonster(state, 'Red');
		expect(second!.killed).toBe(false);
		// Judged against full HP, not (20 − firstDamage): the snapshot reflects only this fight.
		expect(second!.fought?.hp).toBe(20 - second!.playerDamage);
		expect(monster.hp).toBe(20);
	});

	it('a kill consumes one life and resets HP — it does NOT advance the rung mid-fight', () => {
		const p = makePlayer({ barrier: 4, attackDice: dice('arcane', 1) }); // guarantees >= 1 damage
		// maxHp 1 so one combat's roll kills against the monster's FULL health (HP never persists).
		const monster = makeMonster({
			hp: 1,
			maxHp: 1,
			damage: 1,
			livesRemaining: 1,
			livesTotal: 1,
			ladderIndex: 0
		});
		const state = makeState(p, monster, 5);
		const result = fightMonster(state, 'Red');
		expect(result!.killed).toBe(true);
		// The fight itself grants no VP — defeating the monster opens a reward pick.
		expect(result!.vpGained).toBe(0);
		expect(p.victoryPoints).toBe(0);
		expect(result!.fought?.hp).toBe(0); // the defeated snapshot (reward reads this)
		expect(monster.livesRemaining).toBe(0); // one life spent
		expect(monster.hp).toBe(monster.maxHp); // HP reset for the next challenger
		expect(monster.ladderIndex).toBe(0); // same rung — escalation waits for the round boundary
	});

	it('a multi-life monster survives a kill: same rung, one fewer life, HP reset', () => {
		const p = makePlayer({ barrier: 4, attackDice: dice('arcane', 1) });
		const monster = makeMonster({
			id: 'm1',
			hp: 1,
			maxHp: 1,
			damage: 1,
			livesRemaining: 2,
			livesTotal: 2,
			ladderIndex: 0
		});
		const state = makeState(p, monster, 5);
		const result = fightMonster(state, 'Red');
		expect(result!.killed).toBe(true);
		expect(state.monster?.id).toBe('m1'); // still the same listed monster
		expect(state.monster?.livesRemaining).toBe(1); // 2 → 1
		expect(state.monster?.hp).toBe(1); // full HP for the next player (never persists)
		expect(state.monster?.ladderIndex).toBe(0);
	});

	it('excess kills never carry over: livesRemaining floors at 0', () => {
		const p = makePlayer({ barrier: 4, attackDice: dice('arcane', 1) });
		const monster = makeMonster({
			id: 'm1',
			hp: 1,
			maxHp: 1,
			livesRemaining: 0,
			livesTotal: 2,
			ladderIndex: 0
		});
		const state = makeState(p, monster, 5);
		fightMonster(state, 'Red');
		expect(state.monster?.id).toBe('m1'); // does not advance mid-fight
		expect(state.monster?.livesRemaining).toBe(0); // already spent — never goes negative
	});

	const LADDER = {
		monsters: [
			{
				id: 'm1',
				name: 'Weak',
				damage: 1,
				barrier: 5,
				rewardTrack: [],
				dicePool: [],
				chooseAmount: 2,
				stage: 1,
				order: 0
			},
			{
				id: 'm2',
				name: 'Strong',
				damage: 9,
				barrier: 14,
				rewardTrack: ['r'],
				dicePool: [],
				chooseAmount: 2,
				stage: 1,
				order: 1
			}
		]
	} as unknown as PlayCatalog;

	const LADDER3 = {
		monsters: [
			...(LADDER as unknown as { monsters: unknown[] }).monsters,
			{
				id: 'm3',
				name: 'Apex',
				damage: 12,
				barrier: 20,
				rewardTrack: ['r', 'r'],
				dicePool: [],
				chooseAmount: 2,
				stage: 1,
				order: 2
			}
		]
	} as unknown as PlayCatalog;

	it('advanceMonsterIfDefeated: a spent monster climbs to the next, stronger rung at full HP', () => {
		const p = makePlayer({});
		const monster = makeMonster({
			id: 'm1',
			hp: 5,
			maxHp: 5,
			livesRemaining: 0,
			livesTotal: 1,
			ladderIndex: 0,
			ladderMax: 2
		});
		const state = makeState(p, monster, 5); // makeState seats one player → 1 kill to defeat
		advanceMonsterIfDefeated(state, LADDER);
		expect(state.monster?.id).toBe('m2');
		expect(state.monster?.hp).toBe(14);
		expect(state.monster?.maxHp).toBe(14);
		expect(state.monster?.damage).toBe(9);
		expect(state.monster?.ladderIndex).toBe(1);
		expect(state.monster?.livesTotal).toBe(1); // one active seat → one kill needed
		expect(state.monster?.livesRemaining).toBe(1);
	});

	it('pvpVpForAttack: 2 VP for engaging, +2 per corrupted opponent', () => {
		expect(pvpVpForAttack(0)).toBe(2);
		expect(pvpVpForAttack(1)).toBe(4);
		expect(pvpVpForAttack(2)).toBe(6);
		expect(pvpVpForAttack(-1)).toBe(2); // defensive clamp
	});

	it('monsterLivesForPlayerCount: 1 player → 1 life, 2-3 → 2, 4+ → 3', () => {
		expect(monsterLivesForPlayerCount(1)).toBe(1);
		expect(monsterLivesForPlayerCount(2)).toBe(2);
		expect(monsterLivesForPlayerCount(3)).toBe(2);
		expect(monsterLivesForPlayerCount(4)).toBe(3);
		expect(monsterLivesForPlayerCount(5)).toBe(3);
	});

	it('advanceMonsterIfDefeated: the next rung gets lives scaled by player count (4 seats → 3)', () => {
		const p = makePlayer({});
		const monster = makeMonster({
			id: 'm1',
			hp: 5,
			maxHp: 5,
			livesRemaining: 0,
			livesTotal: 3,
			ladderIndex: 0,
			ladderMax: 3
		});
		const state = makeState(p, monster, 5);
		state.activeSeats = ['Red', 'Blue', 'Green', 'Yellow'] as SeatColor[];
		advanceMonsterIfDefeated(state, LADDER3);
		expect(state.monster?.id).toBe('m2');
		expect(state.monster?.livesTotal).toBe(3);
		expect(state.monster?.livesRemaining).toBe(3);
	});

	it('the FINAL rung gets the same player-count lives as every other rung', () => {
		const p = makePlayer({});
		const monster = makeMonster({
			id: 'm2',
			hp: 14,
			maxHp: 14,
			livesRemaining: 0,
			livesTotal: 3,
			ladderIndex: 1,
			ladderMax: 3
		});
		const state = makeState(p, monster, 5);
		state.activeSeats = ['Red', 'Blue', 'Green', 'Yellow'] as SeatColor[];
		advanceMonsterIfDefeated(state, LADDER3);
		expect(state.monster?.id).toBe('m3');
		expect(state.monster?.livesTotal).toBe(3);
		expect(state.monster?.livesRemaining).toBe(3);
	});

	it('defeating the FINAL monster saves the spirit world: Abyss cleared, end flag set', () => {
		const p = makePlayer({});
		const monster = makeMonster({
			id: 'm3',
			hp: 0,
			maxHp: 20,
			livesRemaining: 0,
			livesTotal: 1,
			ladderIndex: 2,
			ladderMax: 3
		});
		const state = makeState(p, monster, 5);
		state.activeSeats = ['Red', 'Blue', 'Green', 'Yellow'] as SeatColor[];
		advanceMonsterIfDefeated(state, LADDER3);
		expect(state.monster).toBeNull(); // the Abyss is clear
		expect(state.spiritWorldSaved).toBe(true); // game ends at this cleanup
	});

	it('without a catalog the defeated monster returns at full strength (bare-state safety)', () => {
		const p = makePlayer({});
		const monster = makeMonster({ hp: 0, maxHp: 5, livesRemaining: 0, livesTotal: 1 });
		const state = makeState(p, monster, 5);
		advanceMonsterIfDefeated(state); // no catalog
		expect(state.monster?.hp).toBe(5);
		expect(state.monster?.livesRemaining).toBe(1);
		expect(state.spiritWorldSaved).toBeUndefined();
	});

	it('advanceMonsterIfDefeated: no-op while the monster still has lives left', () => {
		const p = makePlayer({});
		const monster = makeMonster({
			id: 'm1',
			livesRemaining: 1,
			livesTotal: 2,
			ladderIndex: 0,
			ladderMax: 2
		});
		const state = makeState(p, monster, 5);
		advanceMonsterIfDefeated(state, LADDER);
		expect(state.monster?.id).toBe('m1'); // unchanged — still has a life
		expect(state.monster?.livesRemaining).toBe(1);
	});

	it('a corrupted player cannot strike back', () => {
		const p = makePlayer({ barrier: 1, attackDice: dice('arcane', 5) });
		const monster = makeMonster({ hp: 10, maxHp: 10, damage: 5 }); // 5 > 1 barrier → corrupt
		const state = makeState(p, monster, 2);
		const result = fightMonster(state, 'Red');
		expect(result!.corrupted).toBe(true);
		expect(result!.playerDamage).toBe(0);
		expect(monster.hp).toBe(10); // untouched
	});

	it('"attack at the same time" (Sharpshooter) lets a corrupted player still strike — and kill', () => {
		// Same corrupting setup, but the player holds a Sharpshooter (simultaneous attack).
		const p = makePlayer({
			barrier: 1,
			attackDice: dice('arcane', 5),
			spirits: [spirit(1, { Sharpshooter: 1 })]
		});
		const monster = makeMonster({ hp: 3, maxHp: 3, damage: 5 }); // 5 > 1 barrier → corrupt; arcane×5 ≥ 3 hp
		const state = makeState(p, monster, 2);
		const result = fightMonster(state, 'Red');
		expect(result!.corrupted).toBe(true); // still corrupts (status drops; barrier instantly heals)
		expect(result!.playerDamage).toBeGreaterThan(0); // but strikes simultaneously
		expect(result!.killed).toBe(true); // and can kill through the corruption
	});

	it('Soul Weaver ≥2 also grants simultaneous attack through corruption', () => {
		const p = makePlayer({
			barrier: 1,
			attackDice: dice('arcane', 5),
			spirits: [spirit(1, { 'Soul Weaver': 2 })]
		});
		const monster = makeMonster({ hp: 10, maxHp: 10, damage: 5 });
		const result = fightMonster(makeState(p, monster, 2), 'Red');
		expect(result!.corrupted).toBe(true);
		expect(result!.playerDamage).toBeGreaterThan(0);
	});
});

// ── P4: inCombat / onTakeDamage class coverage (through fightMonster) ──────────
// Each fight uses a fixed seed; with empty dice and 0-damage monsters the dealt
// damage is purely the class bonus, so results are deterministic.

// Sharpshooter's combat bonus moved to an onSpiritSummon grant (gain 1 Enchanted +
// stun-immune) — covered in classes/sharpshooter.test.ts. Its simultaneous-attack
// rule is still exercised above (corrupted-player-still-strikes test).

describe('Spirit Animal (inCombat)', () => {
	it('scales damage AND initiative by the Spirit Animal trait count', () => {
		const p = makePlayer({
			barrier: 4,
			attackDice: [],
			spirits: [spirit(1, { 'Spirit Animal': 3 })]
		});
		const monster = makeMonster({ hp: 20, maxHp: 20, damage: 0 });
		const result = fightMonster(makeState(p, monster, 1), 'Red');
		expect(result!.playerDamage).toBe(3); // +1 dmg per trait × 3
		expect(p.initiative).toBe(3); // +1 initiative per trait × 3
	});

	it('scales to a single trait', () => {
		const p = makePlayer({
			barrier: 4,
			attackDice: [],
			spirits: [spirit(1, { 'Spirit Animal': 1 })]
		});
		const monster = makeMonster({ hp: 20, maxHp: 20, damage: 0 });
		const result = fightMonster(makeState(p, monster, 1), 'Red');
		expect(result!.playerDamage).toBe(1);
		expect(p.initiative).toBe(1);
	});
});

describe('Golem of Wishes (inCombat)', () => {
	it('deflects 4 damage so a 4-damage hit is fully absorbed', () => {
		const p = makePlayer({
			barrier: 4,
			maxBarrier: 4,
			attackDice: [],
			spirits: [spirit(1, { 'Golem of Wishes': 1 })]
		});
		const monster = makeMonster({ hp: 10, maxHp: 10, damage: 4 });
		const result = fightMonster(makeState(p, monster, 1), 'Red');
		expect(result!.barrierLost).toBe(0); // 4 − 4 deflect = 0
		expect(p.barrier).toBe(4); // untouched
		expect(result!.corrupted).toBe(false);
	});
});

describe('Blood Hunter (inCombat)', () => {
	it('deals +1 damage per Arcane Blood, capped at 4', () => {
		// Arcane blood = maxTokens − barrier ⇒ 10 − 4 = 6.
		const p = makePlayer({
			barrier: 4,
			maxBarrier: 10,
			attackDice: [],
			spirits: [spirit(1, { 'Blood Hunter': 1 })]
		});
		const monster = makeMonster({ hp: 20, maxHp: 20, damage: 0 });
		const result = fightMonster(makeState(p, monster, 1), 'Red');
		expect(result!.playerDamage).toBe(4); // min(6, 4)
	});

	it('scales below the cap', () => {
		// Arcane blood = maxTokens − barrier ⇒ 6 − 4 = 2.
		const p = makePlayer({
			barrier: 4,
			maxBarrier: 6,
			attackDice: [],
			spirits: [spirit(1, { 'Blood Hunter': 1 })]
		});
		const monster = makeMonster({ hp: 20, maxHp: 20, damage: 0 });
		const result = fightMonster(makeState(p, monster, 1), 'Red');
		expect(result!.playerDamage).toBe(2); // min(2, 4)
	});
});

describe('Aquamaiden (onTakeDamage)', () => {
	it('takes 3 less damage when hit', () => {
		const p = makePlayer({
			barrier: 4,
			maxBarrier: 4,
			attackDice: [],
			spirits: [spirit(1, { Aquamaiden: 1 })]
		});
		const monster = makeMonster({ hp: 10, maxHp: 10, damage: 4 });
		const result = fightMonster(makeState(p, monster, 1), 'Red');
		expect(result!.barrierLost).toBe(1); // 4 − 3 reduction = 1
		expect(p.barrier).toBe(3);
	});
});

// Dark Assassin's combat damage now scales by Cursed Spirit traits (not barrier
// parity) — covered in classes/darkAssassin.test.ts. The rollAttack multiplier +
// advantage primitives it relies on are exercised here.
describe('rollAttack (damage multiplier + advantage)', () => {
	it('the multiplier doubles the rolled-plus-bonus total in rollAttack', () => {
		const p = makePlayer({ attackDice: [], combatDamageBonus: 5, combatDamageMultiplier: 2 });
		expect(rollAttack(makeState(p, null, 1), p)).toBe(10); // (0 + 5) × 2
	});

	it('attackRollAdvantage (Dark Fighter) rolls twice and keeps the higher total', () => {
		const dice = Array.from({ length: 4 }, (_, i) => ({
			instanceId: `d${i}`,
			tier: 'basic' as const
		}));
		let advSum = 0;
		let oneSum = 0;
		// Same seed per trial for both players; advantage = max(roll, roll) ⇒ ≥ single roll
		// every trial, and strictly higher in aggregate over many seeds.
		for (let s = 1; s <= 150; s += 1) {
			const adv = makePlayer({ attackDice: dice, attackRollAdvantage: true });
			const one = makePlayer({ attackDice: dice, attackRollAdvantage: false });
			advSum += rollAttack(makeState(adv, null, s), adv);
			oneSum += rollAttack(makeState(one, null, s), one);
		}
		expect(advSum).toBeGreaterThan(oneSum);
	});
});

describe('Disruptor (onTakeDamage, HANDLER)', () => {
	function twoSeatState(
		red: PrivatePlayerState,
		blue: PrivatePlayerState,
		seed = 1
	): PublicGameState {
		return {
			rng: createRng(seed),
			monster: null,
			players: { Red: red, Blue: blue },
			activeSeats: ['Red', 'Blue'] as SeatColor[]
		} as unknown as PublicGameState;
	}

	it('halves incoming damage (rounding up) when the opponent has higher initiative', () => {
		const defender = makePlayer({
			playerColor: 'Blue',
			barrier: 10,
			maxBarrier: 10,
			initiative: 1,
			spirits: [spirit(1, { Disruptor: 1 })]
		});
		const attacker = makePlayer({ playerColor: 'Red', initiative: 5 });
		const state = twoSeatState(attacker, defender);
		const r = takeDamage(defender, 5, { state, seat: 'Blue', opponent: 'Red' });
		expect(r.barrierLost).toBe(3); // ceil(5 / 2)
		expect(defender.barrier).toBe(7);
	});

	it('does NOT halve when the opponent has lower (or equal) initiative', () => {
		const defender = makePlayer({
			playerColor: 'Blue',
			barrier: 10,
			maxBarrier: 10,
			initiative: 5,
			spirits: [spirit(1, { Disruptor: 1 })]
		});
		const attacker = makePlayer({ playerColor: 'Red', initiative: 1 });
		const state = twoSeatState(attacker, defender);
		const r = takeDamage(defender, 5, { state, seat: 'Blue', opponent: 'Red' });
		expect(r.barrierLost).toBe(5); // full damage
		expect(defender.barrier).toBe(5);
	});
});

// Guardian (skip-take-damage-if-it-would-corrupt) was removed from the game — the
// class no longer exists in the DB or the engine.

describe('per-combat flags reset between combats', () => {
	it('Spirit Animal combat bonus is re-applied each combat, never accumulated', () => {
		const p = makePlayer({
			barrier: 4,
			attackDice: [],
			spirits: [spirit(1, { 'Spirit Animal': 1 })]
		});
		const monster = makeMonster({ hp: 100, maxHp: 100, damage: 0 });
		const state = makeState(p, monster, 1);

		const first = fightMonster(state, 'Red');
		expect(first!.playerDamage).toBe(1);
		expect(p.combatDamageBonus).toBe(1); // set this combat

		const second = fightMonster(state, 'Red');
		expect(second!.playerDamage).toBe(1); // still +1, not +2 — flags were reset
		expect(p.combatDamageBonus).toBe(1);
	});

	it('Golem deflect does not leak into a later combat without Golem', () => {
		const p = makePlayer({
			barrier: 6,
			maxBarrier: 6,
			attackDice: [],
			spirits: [spirit(1, { 'Golem of Wishes': 1 })]
		});
		const monster = makeMonster({ hp: 100, maxHp: 100, damage: 4 });
		const state = makeState(p, monster, 1);

		const first = fightMonster(state, 'Red');
		expect(first!.barrierLost).toBe(0); // fully deflected
		expect(p.deflect).toBe(4);

		// Remove Golem; the next combat must NOT carry the stale deflect.
		p.spirits = [];
		const second = fightMonster(state, 'Red');
		expect(p.deflect).toBe(0); // reset at combat start, not re-granted
		expect(second!.barrierLost).toBe(4); // full damage now lands
	});

	it('resetCombatFlags zeroes every per-combat flag', () => {
		const p = makePlayer({
			combatDamageBonus: 9,
			deflect: 9,
			damageReduction: 9,
			combatDamageMultiplier: 4,
			halveIncoming: true,
			skipTakeDamage: true,
			stunImmune: true,
			initiative: 7
		});
		resetCombatFlags(p);
		expect(p.combatDamageBonus).toBe(0);
		expect(p.deflect).toBe(0);
		expect(p.damageReduction).toBe(0);
		expect(p.combatDamageMultiplier).toBe(1);
		expect(p.halveIncoming).toBe(false);
		expect(p.skipTakeDamage).toBe(false);
		expect(p.stunImmune).toBe(false);
		expect(p.initiative).toBe(0);
	});
});

describe('rules v1.2 — Fallen corruption shortfall costs VP', () => {
	it('already-Fallen corruption with too few spirits: unpayable sacrifices become -1 VP each', () => {
		// 4th corruption owes 4; only 2 spirits held → discard 2, lose 2 VP.
		const p = makePlayer({
			barrier: 2,
			maxBarrier: 4,
			statusLevel: 3,
			statusToken: 'Fallen',
			corruptionCount: 3,
			victoryPoints: 10,
			spirits: [spirit(1, {}), spirit(2, {})]
		});
		const log: string[] = [];
		const r = takeDamage(p, 2, undefined, log);
		expect(r.corrupted).toBe(true);
		expect(p.statusLevel).toBe(3); // ladder clamps at Fallen
		expect(p.corruptionCount).toBe(4);
		expect(p.pendingCorruptionDiscard).toEqual({ count: 2, reason: undefined });
		expect(p.victoryPoints).toBe(8);
		expect(log.some((l) => l.includes('2 VP lost'))).toBe(true);
	});

	it('already-Fallen corruption with ZERO spirits: the whole debt converts to VP, clamped at 0', () => {
		// 5th corruption owes 5; no spirits → no obligation, VP 3 → 0 (clamp).
		const p = makePlayer({
			barrier: 1,
			maxBarrier: 4,
			statusLevel: 3,
			statusToken: 'Fallen',
			corruptionCount: 4,
			victoryPoints: 3,
			spirits: []
		});
		const r = takeDamage(p, 1);
		expect(r.corrupted).toBe(true);
		expect(p.pendingCorruptionDiscard).toBeNull();
		expect(p.victoryPoints).toBe(0);
	});

	it('the corruption that CROSSES into Fallen is exempt (pre-corruption status decides)', () => {
		// Corrupt → Fallen crossing, 3rd corruption owes 3, zero spirits: old forgiveness, no VP loss.
		const p = makePlayer({
			barrier: 1,
			maxBarrier: 4,
			statusLevel: 2,
			statusToken: 'Corrupt',
			corruptionCount: 2,
			victoryPoints: 10,
			spirits: []
		});
		const r = takeDamage(p, 1);
		expect(r.corrupted).toBe(true);
		expect(p.statusLevel).toBe(3);
		expect(p.victoryPoints).toBe(10);
		expect(p.pendingCorruptionDiscard).toBeNull();
	});

	it('pre-Fallen shortfalls keep the old forgiveness (no VP loss)', () => {
		// Pure → Tainted, 2nd corruption owes 2, 1 spirit: discard 1, forgive 1, VP untouched.
		const p = makePlayer({
			barrier: 1,
			maxBarrier: 4,
			statusLevel: 0,
			statusToken: 'Pure',
			corruptionCount: 1,
			victoryPoints: 5,
			spirits: [spirit(1, {})]
		});
		const r = takeDamage(p, 1);
		expect(r.corrupted).toBe(true);
		expect(p.pendingCorruptionDiscard).toEqual({ count: 1, reason: undefined });
		expect(p.victoryPoints).toBe(5);
	});
});
