import { describe, expect, it } from 'vitest';
import {
	takeDamage,
	fightMonster,
	rollAttack,
	resetCombatFlags,
	advanceMonsterIfDefeated,
	monsterBarrierLeft,
	monsterLivesForPlayerCount,
	pvpVpForAttack,
	PVP_VP_PER_CORRUPTED,
	DICE_TIER_FACES
} from './combat';
import { initiativeHits } from './rules';
import { createRng } from './rng';
import type {
	AttackDie,
	MonsterState,
	PlaySpirit,
	PrivatePlayerState,
	PublicGameState,
	RuntimeBagEntry,
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

/** A bare one-seat state. `monster`, when given, is the single card in Red's monster hand
 *  (the same object, so a test can read the damage a fight leaves on it). */
function makeState(
	player: PrivatePlayerState,
	monster: MonsterState | null,
	seed = 1
): PublicGameState {
	const seat: SeatColor = 'Red';
	if (monster) player.monsterHand = [monster];
	return {
		rng: createRng(seed),
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
		// barrier 3, take exactly 3 → barrier hits 0 (all potential tokens on the Broken Barrier
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
		// Corruption now INSTANTLY restores all health (broken barrier flips back to barrier),
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
	it('an arcane die rolls 0, 1, 3 or 5 (faces 0,0,1,3,3,5)', () => {
		expect(DICE_TIER_FACES.arcane).toEqual([0, 0, 1, 3, 3, 5]);
		for (let seed = 1; seed <= 40; seed++) {
			const p = makePlayer({ attackDice: dice('arcane', 1) });
			expect([0, 1, 3, 5]).toContain(rollAttack(makeState(p, null, seed), p));
		}
	});

	it('an exalted die never rolls below 1 (faces 1,1,1,2,2,2)', () => {
		expect(DICE_TIER_FACES.exalted).toEqual([1, 1, 1, 2, 2, 2]);
		const p = makePlayer({ attackDice: dice('exalted', 4) });
		expect(rollAttack(makeState(p, null, 7), p)).toBeGreaterThanOrEqual(4);
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
	/** Fixed 3 damage per fight: no dice, three Beast traits (+1 damage each). */
	const threeDamage = () => [spirit(1, { 'Beast': 3 })];
	const hand = (state: PublicGameState, seat: SeatColor = 'Red') => state.players[seat]?.monsterHand ?? [];

	it('monster hits the player and the player chips the card in their hand (damage persists)', () => {
		const p = makePlayer({ barrier: 4, attackDice: dice('exalted', 1) }); // guarantees >= 1 damage
		const monster = makeMonster({ hp: 10, maxHp: 10, damage: 2 });
		const state = makeState(p, monster, 3);
		const result = fightMonster(state, 'Red');
		expect(result).not.toBeNull();
		expect(result!.corrupted).toBe(false);
		expect(p.barrier).toBe(2); // took 2 monster damage
		expect(result!.playerDamage).toBeGreaterThan(0);
		// The card keeps the damage and stays in the player's hand.
		expect(monster.hp).toBe(10 - result!.playerDamage);
		expect(result!.fought?.hp).toBe(monster.hp);
		expect(hand(state)).toEqual([monster]);
	});

	it("monster HP persists across combats: a second fight continues from the first fight's damage", () => {
		const p = makePlayer({ barrier: 4, attackDice: [], spirits: threeDamage() });
		const monster = makeMonster({ hp: 20, maxHp: 20, damage: 0 });
		const state = makeState(p, monster, 3);

		const first = fightMonster(state, 'Red');
		expect(first!.killed).toBe(false);
		expect(monster.hp).toBe(17); // nothing resets after the fight

		const second = fightMonster(state, 'Red');
		expect(second!.killed).toBe(false);
		expect(second!.fought?.hp).toBe(14); // 20 − 3 − 3
		expect(monster.hp).toBe(14);
		expect(monster.maxHp).toBe(20);
		expect(hand(state)).toHaveLength(1);
	});

	it("damage removes the monster's single Barrier value, and the loss persists", () => {
		const p = makePlayer({ barrier: 4, attackDice: [], spirits: threeDamage() });
		const monster = makeMonster({ hp: 10, maxHp: 10, damage: 0 });
		const state = makeState(p, monster, 3);
		expect(monsterBarrierLeft(monster)).toBe(10);

		const first = fightMonster(state, 'Red');
		expect(first!.playerDamage).toBe(3);
		expect(monster.hp).toBe(7);
		expect(first!.log.some((line) => line.includes('loses 3 Barrier (7/10 left)'))).toBe(true);

		fightMonster(state, 'Red');
		expect(monsterBarrierLeft(monster)).toBe(4);
	});

	it('handIndex picks the card to fight; the other cards in the hand are untouched', () => {
		const p = makePlayer({ barrier: 4, attackDice: [], spirits: threeDamage() });
		const state = makeState(p, null, 3);
		const a = makeMonster({ id: 'a', hp: 10, maxHp: 10, damage: 0 });
		const b = makeMonster({ id: 'b', hp: 10, maxHp: 10, damage: 0 });
		const c = makeMonster({ id: 'c', hp: 10, maxHp: 10, damage: 0 });
		p.monsterHand = [a, b, c];

		const result = fightMonster(state, 'Red', undefined, 1);
		expect(result!.fought?.id).toBe('b');
		expect(b.hp).toBe(7);
		expect(a.hp).toBe(10);
		expect(c.hp).toBe(10);
		expect(hand(state).map((card) => card.id)).toEqual(['a', 'b', 'c']);
	});

	it('a missing hand card cannot be fought (empty hand or out-of-range handIndex)', () => {
		const p = makePlayer({ barrier: 4, attackDice: dice('arcane', 1) });
		const empty = makeState(p, null, 3);
		expect(fightMonster(empty, 'Red')).toBeNull();
		expect(p.barrier).toBe(4); // nothing happened

		const one = makeState(makePlayer({ attackDice: dice('arcane', 1) }), makeMonster(), 3);
		expect(fightMonster(one, 'Red', undefined, 1)).toBeNull();
		expect(fightMonster(one, 'Red', undefined, -1)).toBeNull();
		expect(hand(one)[0].hp).toBe(5);
	});

	it('a kill removes the card from the hand; the fought snapshot shows HP 0', () => {
		const p = makePlayer({ barrier: 4, attackDice: dice('exalted', 1) }); // guarantees >= 1 damage
		const monster = makeMonster({ hp: 1, maxHp: 1, damage: 1 });
		const other = makeMonster({ id: 'keep', hp: 9, maxHp: 9 });
		const state = makeState(p, null, 5);
		p.monsterHand = [other, monster];
		const result = fightMonster(state, 'Red', undefined, 1);
		expect(result!.killed).toBe(true);
		// The fight itself grants no VP — defeating the monster opens a reward claim.
		expect(result!.vpGained).toBe(0);
		expect(p.victoryPoints).toBe(0);
		expect(result!.fought).toMatchObject({ id: 'm1', hp: 0, maxHp: 1 }); // the reward reads this
		expect(hand(state)).toEqual([other]); // the card leaves the game at once
		expect(other.hp).toBe(9);
	});

	it('a card worn down by earlier fights dies to a hit smaller than its printed Barrier', () => {
		const p = makePlayer({ barrier: 4, attackDice: [], spirits: threeDamage() });
		// 3 damage could never kill this Barrier-10 card at full strength, but it has 3 left.
		const monster = makeMonster({ hp: 3, maxHp: 10, damage: 0 });
		const state = makeState(p, monster, 5);
		const result = fightMonster(state, 'Red');
		expect(result!.killed).toBe(true);
		expect(result!.fought?.hp).toBe(0);
		expect(hand(state)).toEqual([]);
	});

	it('a hit one short of the Barrier left does not defeat the card', () => {
		const p = makePlayer({ barrier: 4, attackDice: [], spirits: threeDamage() });
		const monster = makeMonster({ hp: 4, maxHp: 4, damage: 0 });
		const state = makeState(p, monster, 5);
		const result = fightMonster(state, 'Red');
		expect(result!.killed).toBe(false);
		expect(monster.hp).toBe(1);
		expect(hand(state)).toEqual([monster]);
	});

	it("one player's fight never touches another player's hand", () => {
		const red = makePlayer({ barrier: 4, attackDice: [], spirits: threeDamage() });
		const blueCard = makeMonster({ id: 'blue-card', hp: 10, maxHp: 10, damage: 0 });
		const blue = makePlayer({ playerColor: 'Blue', monsterHand: [blueCard] });
		const redCard = makeMonster({ id: 'red-card', hp: 10, maxHp: 10, damage: 0 });
		const state = makeState(red, redCard, 3);
		state.players.Blue = blue;
		state.activeSeats = ['Red', 'Blue'] as SeatColor[];

		fightMonster(state, 'Red');
		expect(redCard.hp).toBe(7);
		expect(blueCard.hp).toBe(10);
		expect(hand(state, 'Blue')).toEqual([blueCard]);
	});

	/** Mark a bare state as having dealt a monster deck, with `deck` cards left to draw. */
	function withDealtDeck(state: PublicGameState, deck: RuntimeBagEntry[] = []): PublicGameState {
		state.monsterDecks = [
			{ difficulty: 1, total: 1, barrierMin: 1, barrierMax: 5, vpValues: [], summonMin: 0, summonMax: 0, extraRewards: [] }
		];
		state.bags = { monsters: { count: deck.length, contents: deck } } as unknown as PublicGameState['bags'];
		return state;
	}

	it('pvpVpForAttack: nothing for engaging, 3 VP per corrupted Good player', () => {
		expect(PVP_VP_PER_CORRUPTED).toBe(3);
		expect(pvpVpForAttack(0)).toBe(0);
		expect(pvpVpForAttack(1)).toBe(3);
		expect(pvpVpForAttack(2)).toBe(6);
		expect(pvpVpForAttack(-1)).toBe(0); // defensive clamp
	});

	it('monsterLivesForPlayerCount: 1 player → 1 life, 2-3 → 2, 4+ → 3', () => {
		expect(monsterLivesForPlayerCount(1)).toBe(1);
		expect(monsterLivesForPlayerCount(2)).toBe(2);
		expect(monsterLivesForPlayerCount(3)).toBe(2);
		expect(monsterLivesForPlayerCount(4)).toBe(3);
		expect(monsterLivesForPlayerCount(5)).toBe(3);
	});

	it('advanceMonsterIfDefeated: a damaged card in a hand never recovers Barrier', () => {
		const monster = makeMonster({ hp: 4, maxHp: 10 });
		const state = withDealtDeck(makeState(makePlayer({}), monster, 5));
		for (let round = 0; round < 3; round++) advanceMonsterIfDefeated(state);
		expect(hand(state)).toEqual([monster]); // same card, even with no fights at all
		expect(monster.hp).toBe(4); // damage is permanent
		expect(state.spiritWorldSaved).toBeUndefined();
	});

	it('the spirit world is saved when every deck is empty and every hand is empty', () => {
		const state = withDealtDeck(makeState(makePlayer({}), null, 5));
		state.players.Blue = makePlayer({ playerColor: 'Blue' });
		state.activeSeats = ['Red', 'Blue', 'Green'] as SeatColor[]; // a seat with no player state holds no cards
		advanceMonsterIfDefeated(state);
		expect(state.spiritWorldSaved).toBe(true); // the game ends at this cleanup
	});

	it('the spirit world is NOT saved while any monster card remains (deck, any hand, pending draw)', () => {
		const inDeck = withDealtDeck(makeState(makePlayer({}), null, 5), [
			{ guid: 'monster-card-m2', id: 'm2', name: 'Strong', barrier: 14, damage: 9, difficulty: 3 }
		]);
		advanceMonsterIfDefeated(inDeck);
		expect(inDeck.spiritWorldSaved).toBeUndefined();

		const inOwnHand = withDealtDeck(makeState(makePlayer({}), makeMonster({ id: 'm2' }), 5));
		advanceMonsterIfDefeated(inOwnHand);
		expect(inOwnHand.spiritWorldSaved).toBeUndefined();

		// A card in ANOTHER player's hand also keeps the game going.
		const inOtherHand = withDealtDeck(makeState(makePlayer({}), null, 5));
		inOtherHand.players.Blue = makePlayer({ playerColor: 'Blue', monsterHand: [makeMonster({ id: 'm2', hp: 1 })] });
		inOtherHand.activeSeats = ['Red', 'Blue'] as SeatColor[];
		advanceMonsterIfDefeated(inOtherHand);
		expect(inOtherHand.spiritWorldSaved).toBeUndefined();

		// An open reveal settles into the hand at the boundary, so it is not "gone" either.
		const inDraw = withDealtDeck(
			makeState(makePlayer({ pendingMonsterDraw: { cards: [makeMonster({ id: 'm2' })], maxCards: 2 } }), null, 5)
		);
		advanceMonsterIfDefeated(inDraw);
		expect(inDraw.spiritWorldSaved).toBeUndefined();
		expect(hand(inDraw).map((card) => card.id)).toEqual(['m2']);
	});

	it('a bare state (no monster deck dealt) never saves the spirit world', () => {
		const state = makeState(makePlayer({}), null, 5);
		advanceMonsterIfDefeated(state); // no catalog, no monsterDecks
		expect(state.spiritWorldSaved).toBeUndefined();
	});
	it('a corrupted player without the initiative cannot strike back', () => {
		const p = makePlayer({ barrier: 1, attackDice: dice('arcane', 5) });
		const monster = makeMonster({ hp: 10, maxHp: 10, damage: 5 }); // 5 > 1 barrier → corrupt
		const state = makeState(p, monster, 2);
		const result = fightMonster(state, 'Red');
		expect(p.initiative).toBe(0); // the initiative die missed: the monster attacks first
		expect(result!.corrupted).toBe(true);
		expect(result!.playerDamage).toBe(0);
		expect(monster.hp).toBe(10); // untouched
	});

	it('"attack at the same time" (Sharpshooter) lets a corrupted player still strike — and kill', () => {
		// Same corrupting setup, but the player holds a Sharpshooter (simultaneous attack).
		const p = makePlayer({
			barrier: 1,
			attackDice: dice('arcane', 5),
			spirits: [spirit(1, { 'Sharpshooter': 1 })]
		});
		const monster = makeMonster({ hp: 3, maxHp: 3, damage: 5 }); // 5 > 1 barrier → corrupt; arcane×5 ≥ 3 hp
		const state = makeState(p, monster, 2);
		const result = fightMonster(state, 'Red');
		expect(result!.corrupted).toBe(true); // still corrupts (status drops; barrier instantly heals)
		expect(result!.playerDamage).toBeGreaterThan(0); // but strikes simultaneously
		expect(result!.killed).toBe(true); // and can kill through the corruption
	});

	it('Mystic ≥3 also grants simultaneous attack through corruption', () => {
		const p = makePlayer({
			barrier: 1,
			attackDice: dice('arcane', 5),
			spirits: [spirit(1, { 'Mystic': 3 })]
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

describe('Beast (inCombat)', () => {
	it('scales damage by the Beast trait count and gives no initiative', () => {
		const p = makePlayer({
			barrier: 4,
			attackDice: [],
			spirits: [spirit(1, { 'Beast': 3 })]
		});
		const monster = makeMonster({ hp: 20, maxHp: 20, damage: 0 });
		const result = fightMonster(makeState(p, monster, 1), 'Red');
		expect(result!.playerDamage).toBe(3); // +1 dmg per trait × 3
		// The initiative is the initiative die's alone (Pure: a roll of 4 or less).
		expect(p.initiative).toBe(p.initiativeRoll! <= initiativeHits(0) ? 1 : 0);
	});

	it('scales to a single trait', () => {
		const p = makePlayer({
			barrier: 4,
			attackDice: [],
			spirits: [spirit(1, { 'Beast': 1 })]
		});
		const monster = makeMonster({ hp: 20, maxHp: 20, damage: 0 });
		const result = fightMonster(makeState(p, monster, 1), 'Red');
		expect(result!.playerDamage).toBe(1);
		expect(p.initiative).toBe(p.initiativeRoll! <= initiativeHits(0) ? 1 : 0);
	});
});

describe('Titan (inCombat)', () => {
	it('deflects 4 damage so a 4-damage hit is fully absorbed', () => {
		const p = makePlayer({
			barrier: 4,
			maxBarrier: 4,
			attackDice: [],
			spirits: [spirit(1, { 'Titan': 1 })]
		});
		const monster = makeMonster({ hp: 10, maxHp: 10, damage: 4 });
		const result = fightMonster(makeState(p, monster, 1), 'Red');
		expect(result!.barrierLost).toBe(0); // 4 − 4 deflect = 0
		expect(p.barrier).toBe(4); // untouched
		expect(result!.corrupted).toBe(false);
	});
});

describe('Woundreaver (inCombat)', () => {
	it('deals +1 damage per Broken Barrier, capped at 4', () => {
		// Broken barrier = maxTokens − barrier ⇒ 10 − 4 = 6.
		const p = makePlayer({
			barrier: 4,
			maxBarrier: 10,
			attackDice: [],
			spirits: [spirit(1, { 'Woundreaver': 1 })]
		});
		const monster = makeMonster({ hp: 20, maxHp: 20, damage: 0 });
		const result = fightMonster(makeState(p, monster, 1), 'Red');
		expect(result!.playerDamage).toBe(4); // min(6, 4)
	});

	it('scales below the cap', () => {
		// Broken barrier = maxTokens − barrier ⇒ 6 − 4 = 2.
		const p = makePlayer({
			barrier: 4,
			maxBarrier: 6,
			attackDice: [],
			spirits: [spirit(1, { 'Woundreaver': 1 })]
		});
		const monster = makeMonster({ hp: 20, maxHp: 20, damage: 0 });
		const result = fightMonster(makeState(p, monster, 1), 'Red');
		expect(result!.playerDamage).toBe(2); // min(2, 4)
	});
});

describe('Aquamaiden (onTakeDamage)', () => {
	it('takes 1 less damage per awakened Water Region spirit', () => {
		const p = makePlayer({
			barrier: 4,
			maxBarrier: 4,
			attackDice: [],
			spirits: [
				{ ...spirit(1, { 'Warden': 1 }), origins: { 'Water Region': 1 } },
				{ ...spirit(2, {}), origins: { 'Water Region': 1 } }
			]
		});
		const monster = makeMonster({ hp: 10, maxHp: 10, damage: 4 });
		const result = fightMonster(makeState(p, monster, 1), 'Red');
		expect(result!.barrierLost).toBe(2);
		expect(p.barrier).toBe(2);
	});
});

// Paladin's combat damage now scales by Cursed Spirit traits (not barrier
// parity) — covered in classes/darkAssassin.test.ts. The rollAttack multiplier +
// advantage primitives it relies on are exercised here.
describe('rollAttack (damage multiplier + advantage)', () => {
	it('the multiplier doubles the rolled-plus-bonus total in rollAttack', () => {
		const p = makePlayer({ attackDice: [], combatDamageBonus: 5, combatDamageMultiplier: 2 });
		expect(rollAttack(makeState(p, null, 1), p)).toBe(10); // (0 + 5) × 2
	});

	it('attackRollAdvantage (roll twice, keep the higher; no class sets it since the Moon rework) rolls twice and keeps the higher total', () => {
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

describe('Bastion (onTakeDamage, HANDLER)', () => {
	function twoSeatState(
		red: PrivatePlayerState,
		blue: PrivatePlayerState,
		seed = 1
	): PublicGameState {
		return {
			rng: createRng(seed),
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
			spirits: [spirit(1, { 'Bastion': 1 })]
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
			spirits: [spirit(1, { 'Bastion': 1 })]
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
	it('Beast combat bonus is re-applied each combat, never accumulated', () => {
		const p = makePlayer({
			barrier: 4,
			attackDice: [],
			spirits: [spirit(1, { 'Beast': 1 })]
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

	it('Golem mitigation does not leak into a later combat without Golem', () => {
		const p = makePlayer({
			barrier: 6,
			maxBarrier: 6,
			attackDice: [],
			spirits: [spirit(1, { 'Titan': 1 })]
		});
		const monster = makeMonster({ hp: 100, maxHp: 100, damage: 4 });
		const state = makeState(p, monster, 1);

		const first = fightMonster(state, 'Red');
		expect(first!.barrierLost).toBe(0); // reduced by 6
		expect(p.damageReduction).toBe(6);

		// Remove Golem; the next combat must NOT carry the stale deflect.
		p.spirits = [];
		const second = fightMonster(state, 'Red');
		expect(p.damageReduction).toBe(0); // reset at combat start, not re-granted
		expect(second!.barrierLost).toBe(4); // full damage now lands
	});

	it('the initiative of a fight is its die alone: stale values, Fairy and Beast add none', () => {
		const p = makePlayer({
			// Simulate the stale pre-fix readout: combat reset must rebuild the real total,
			// not preserve or increment this arbitrary value.
			initiative: 4,
			spirits: [
				spirit(1, { 'Fairy': 1 }),
				spirit(2, { 'Beast': 6 })
			]
		});
		const state = makeState(p, makeMonster({ hp: 100, maxHp: 100, damage: 0 }), 1);

		fightMonster(state, 'Red');

		expect(p.initiative).toBe(p.initiativeRoll! <= initiativeHits(0) ? 1 : 0);
		expect(p.combatDamageBonus).toBe(6);

		fightMonster(state, 'Red');
		expect(p.initiative).toBe(p.initiativeRoll! <= initiativeHits(0) ? 1 : 0);
		expect(p.combatDamageBonus).toBe(6); // per-combat +6 does not accumulate to 12
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

	it('already-Fallen corruption with ZERO spirits: the whole debt converts to VP, which may go below 0', () => {
		// 5th corruption owes 4 (the most one corruption costs); no spirits → no obligation, VP 3 → -1.
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
		expect(p.victoryPoints).toBe(-1);
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
