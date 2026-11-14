import { describe, expect, test } from 'vitest';
import {
	applyGameCommand,
	buildSessionProjection,
	createLobbyState,
	monsterDifficulty
} from './runtime';
import type {
	AttackDie,
	GameActor,
	GameCommand,
	NavigationDestination,
	PlayCatalog,
	PlayCatalogMonster,
	PublicGameState,
	SeatColor
} from './types';
import { canApply } from './legality';
import { dealTestMonster, drawMonsterViaCommands, testMonsterCard } from './testing/monsterCards';

// Arcane Abyss monster CARDS through the real reducer. A player at the Abyss draws two cards from
// one difficulty deck and keeps one in their own private hand (max 3). At the Abyss they fight a
// card from their hand by `handIndex`: damage stays on the card, and a kill removes the card and
// grants every reward on it. Nothing is shared between players.

const VP1 = '70792514-aa43-4526-a7a4-0f1e4ca55d71';
const VP2 = '22e7f408-fa65-417e-a555-56ad87ecb428';
const VP3 = '54a61c34-6e05-44df-a4d1-115e004af31e';

const card = (id: string, hp: number): PlayCatalogMonster => ({
	id,
	name: id,
	damage: 1,
	barrier: hp,
	rewardTrack: [VP1],
	dicePool: [],
	chooseAmount: 1,
	stage: 1,
	order: 0
});

// Difficulty by HP: 1–3 → D1 (4 cards), 4–7 → D2 (2 cards), 8+ → D3 (2 cards).
const MONSTERS = [
	card('d1-a', 1),
	card('d1-b', 2),
	card('d1-c', 3),
	card('d1-d', 3),
	card('d2-a', 4),
	card('d2-b', 7),
	card('d3-a', 8),
	card('d3-b', 12)
];

const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-a', name: 'Red Guard', originId: 'o1' },
		{ id: 'g-b', name: 'Blue Guard', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack', sides: [1, 1, 2, 2, 3, 3] }],
	spirits: Array.from({ length: 30 }, (_, i) => ({
		id: `s-${i}`,
		name: `Spirit ${i}`,
		cost: (i % 5) + 1,
		classes: { Fighter: 1 },
		origins: { Forest: 1 }
	})),
	monsters: MONSTERS,
	locations: []
};

const RED: GameActor = { memberId: 'm-red', displayName: 'Red', role: 'host', seatColor: 'Red' };
const BLUE: GameActor = { memberId: 'm-blue', displayName: 'Blue', role: 'player', seatColor: 'Blue' };
const RED_VIEW = { role: 'host' as const, seatColor: 'Red' as const, displayName: 'Red' };
const BLUE_VIEW = { role: 'player' as const, seatColor: 'Blue' as const, displayName: 'Blue' };
const SPECTATOR_VIEW = { role: 'spectator' as const, seatColor: null, displayName: null };

function run(s: PublicGameState, actor: GameActor, command: GameCommand, catalog = CATALOG) {
	const result = applyGameCommand(s, actor, command, catalog);
	if (!result.ok) throw new Error(`${command.type}: ${result.error.code}: ${result.error.message}`);
	return result.state;
}

/** The error code of a command that must be rejected. */
function rejectCode(s: PublicGameState, actor: GameActor, command: GameCommand, catalog = CATALOG) {
	const result = applyGameCommand(s, actor, command, catalog);
	if (result.ok) throw new Error(`${command.type} was expected to be rejected`);
	return result.error.code;
}

function started(seed = 7, catalog = CATALOG): PublicGameState {
	let s = createLobbyState({ roomCode: 'MCARDS', guardianNames: ['Red Guard', 'Blue Guard'] });
	s = run(s, RED, { type: 'claimSeat', seatColor: 'Red' }, catalog);
	s = run(s, BLUE, { type: 'claimSeat', seatColor: 'Blue' }, catalog);
	s = run(s, RED, { type: 'selectGuardian', guardianName: 'Red Guard' }, catalog);
	s = run(s, BLUE, { type: 'selectGuardian', guardianName: 'Blue Guard' }, catalog);
	return run(s, RED, { type: 'startGame', seed }, catalog);
}

/** Lock both seats and reveal into the Location phase. */
function toLocation(
	s: PublicGameState,
	red: NavigationDestination = 'Arcane Abyss',
	blue: NavigationDestination = 'Arcane Abyss',
	catalog = CATALOG
): PublicGameState {
	s = run(s, RED, { type: 'lockNavigation', destination: red }, catalog);
	s = run(s, BLUE, { type: 'lockNavigation', destination: blue }, catalog);
	s = run(s, RED, { type: 'forceAdvancePhase' }, catalog);
	if (s.phase !== 'location') throw new Error(`expected location phase, got ${s.phase}`);
	return s;
}

/** Host force-advances through the rest of the round (auto-claims rewards) to the next navigation. */
function finishRound(s: PublicGameState, catalog = CATALOG): PublicGameState {
	const round = s.round;
	for (let i = 0; i < 10 && s.status === 'active' && s.round === round; i++) {
		s = run(s, RED, { type: 'forceAdvancePhase' }, catalog);
	}
	return s;
}

const deckCounts = (s: PublicGameState) =>
	([1, 2, 3] as const).map((d) => s.bags.monsters.contents.filter((e) => e.difficulty === d).length);

const arcaneDice = (n: number): AttackDie[] =>
	Array.from({ length: n }, (_, i) => ({ instanceId: `arc-${i}`, tier: 'arcane' as const }));

const seat = (s: PublicGameState, color: SeatColor) => s.players[color]!;


const hand = (s: PublicGameState, color: SeatColor) => s.players[color]!.monsterHand ?? [];

/** The error code a rejected command returns, and the canApply verdict for the same command. */
function rejectWithLegality(s: PublicGameState, actor: GameActor, command: GameCommand, catalog = CATALOG) {
	return { code: rejectCode(s, actor, command, catalog), legal: canApply(s, actor, command, catalog) };
}

describe('monster card decks at startGame', () => {
	test('every catalog monster is dealt into its difficulty deck and every hand starts empty', () => {
		const s = started();
		expect(s.bags.monsters.count).toBe(MONSTERS.length);
		expect(s.bags.monsters.contents).toHaveLength(MONSTERS.length);
		expect(deckCounts(s)).toEqual([4, 2, 2]);
		expect(s.bags.monsters.contents.map((e) => e.id).sort()).toEqual(MONSTERS.map((m) => m.id).sort());
		for (const entry of s.bags.monsters.contents) {
			expect(entry.difficulty).toBe(monsterDifficulty({ barrier: entry.barrier! }));
		}
		for (const color of ['Red', 'Blue'] as const) {
			expect(seat(s, color).monsterHand).toEqual([]);
			expect(seat(s, color).pendingMonsterDraw).toBeNull();
		}
	});

	test('monsterDecks summarises each deck for the card backs', () => {
		const s = started();
		expect(s.monsterDecks?.map((d) => [d.difficulty, d.total, d.barrierMin, d.barrierMax])).toEqual([
			[1, 4, 1, 3],
			[2, 2, 4, 7],
			[3, 2, 8, 12]
		]);
		expect(s.monsterDecks?.every((d) => d.extraRewards.length === 0)).toBe(true);
		expect(s.monsterDecks?.every((d) => d.vpValues.join() === '1')).toBe(true);
		expect(s.monsterDecks?.every((d) => d.summonMin === 0 && d.summonMax === 0)).toBe(true);
	});

	test('difficulty is bucketed by Barrier (1–3 / 4–7 / 8+)', () => {
		expect([1, 3, 4, 7, 8, 99].map((barrier) => monsterDifficulty({ barrier }))).toEqual([1, 1, 2, 2, 3, 3]);
	});

	test('the deck order is seeded: the same seed deals the same order', () => {
		const ids = (s: PublicGameState) => s.bags.monsters.contents.map((e) => e.guid);
		expect(ids(started(11))).toEqual(ids(started(11)));
	});
});

describe('drawMonsterCards', () => {
	test('requires the Arcane Abyss in the Location phase', () => {
		const nav = started();
		expect(rejectCode(nav, RED, { type: 'drawMonsterCards', difficulty: 1 })).toBe('wrong_phase');

		const elsewhere = toLocation(started(), 'Mountain Region', 'Arcane Abyss');
		expect(rejectCode(elsewhere, RED, { type: 'drawMonsterCards', difficulty: 1 })).toBe('not_in_abyss');
		// Blue, who is at the Abyss, may draw.
		expect(seat(run(elsewhere, BLUE, { type: 'drawMonsterCards', difficulty: 1 }), 'Blue').pendingMonsterDraw?.cards).toHaveLength(2);
	});

	test('reveals two cards of the chosen difficulty and removes them from the deck', () => {
		let s = toLocation(started());
		s = run(s, RED, { type: 'drawMonsterCards', difficulty: 2 });
		const revealed = seat(s, 'Red').pendingMonsterDraw!.cards;
		expect(revealed.map((c) => c.id).sort()).toEqual(['d2-a', 'd2-b']);
		for (const c of revealed) {
			expect(c.difficulty).toBe(2);
			expect(c.hp).toBe(c.maxHp);
		}
		expect(deckCounts(s)).toEqual([4, 0, 2]);
		expect(s.bags.monsters.count).toBe(6);
		expect(seat(s, 'Red').monsterDrawRound).toBe(s.round);
	});

	test('reveals only what is left: one card from a one-card deck, and an empty deck rejects the draw', () => {
		let s = toLocation(started());
		s = run(s, BLUE, { type: 'drawMonsterCards', difficulty: 2 });
		s = run(s, BLUE, { type: 'keepMonsterCard', index: 0 }); // the other D2 card goes back
		expect(deckCounts(s)).toEqual([4, 1, 2]);
		s = run(s, RED, { type: 'drawMonsterCards', difficulty: 2 });
		expect(seat(s, 'Red').pendingMonsterDraw!.cards).toHaveLength(1);
		expect(deckCounts(s)).toEqual([4, 0, 2]);

		// Red's D2 draw used Red's draw for the round; Blue's is used too. Next round, D2 is empty.
		s = run(s, RED, { type: 'keepMonsterCard', index: 0 });
		s = toLocation(finishRound(s));
		expect(rejectCode(s, RED, { type: 'drawMonsterCards', difficulty: 2 })).toBe('monster_deck_empty');
		expect(seat(run(s, RED, { type: 'drawMonsterCards', difficulty: 3 }), 'Red').pendingMonsterDraw?.cards).toHaveLength(2);
	});

	test('one draw per round: a second draw waits for the next round', () => {
		let s = toLocation(started());
		s = run(s, RED, { type: 'drawMonsterCards', difficulty: 1 });
		expect(rejectCode(s, RED, { type: 'drawMonsterCards', difficulty: 3 })).toBe('monster_draw_pending');
		s = run(s, RED, { type: 'keepMonsterCard', index: 0 });
		expect(rejectCode(s, RED, { type: 'drawMonsterCards', difficulty: 1 })).toBe('monster_draw_used');

		s = toLocation(finishRound(s));
		s = run(s, RED, { type: 'drawMonsterCards', difficulty: 1 });
		expect(seat(s, 'Red').pendingMonsterDraw?.cards).toHaveLength(2);
	});
});

describe('keepMonsterCard', () => {
	test('keeps the chosen card in the private hand and returns the other to the bottom of its deck', () => {
		let s = toLocation(started());
		s = run(s, RED, { type: 'drawMonsterCards', difficulty: 1 });
		const [first, second] = seat(s, 'Red').pendingMonsterDraw!.cards;
		s = run(s, RED, { type: 'keepMonsterCard', index: 1 });
		expect(hand(s, 'Red').map((c) => c.id)).toEqual([second.id]);
		expect(seat(s, 'Red').pendingMonsterDraw).toBeNull();
		expect(deckCounts(s)).toEqual([3, 2, 2]); // 4 − 2 drawn + 1 returned
		expect(s.bags.monsters.count).toBe(7);
		const bottom = s.bags.monsters.contents.at(-1)!;
		expect(bottom).toMatchObject({ id: first.id, difficulty: 1, barrier: first.maxHp, damage: first.damage });
		expect(hand(s, 'Blue')).toEqual([]); // the card is Red's alone
	});

	test('rejects a keep with no reveal and an out-of-range index', () => {
		let s = toLocation(started());
		expect(rejectCode(s, RED, { type: 'keepMonsterCard', index: 0 })).toBe('monster_draw_missing');
		s = run(s, RED, { type: 'drawMonsterCards', difficulty: 1 });
		expect(rejectCode(s, RED, { type: 'keepMonsterCard', index: 2 })).toBe('monster_card_invalid');
		expect(rejectCode(s, RED, { type: 'keepMonsterCard', index: -1 })).toBe('monster_card_invalid');
	});

	test('the hand holds at most 3 cards: a full hand cannot draw until a card is defeated', () => {
		let s = toLocation(started());
		for (let round = 0; round < 3; round++) {
			s = run(s, RED, { type: 'drawMonsterCards', difficulty: 1 });
			s = run(s, RED, { type: 'keepMonsterCard', index: 0 });
			s = toLocation(finishRound(s));
		}
		expect(hand(s, 'Red')).toHaveLength(3);
		expect(rejectCode(s, RED, { type: 'drawMonsterCards', difficulty: 2 })).toBe('monster_hand_full');
		// Defeating a card frees a slot, and this round's draw is still unused.
		s.players.Red!.attackDice = arcaneDice(6); // ≥ 6 damage kills any D1 card (≤ 3 Barrier)
		s = run(s, RED, { type: 'startCombat', handIndex: 0 });
		expect(hand(s, 'Red')).toHaveLength(2);
		s = run(s, RED, { type: 'drawMonsterCards', difficulty: 2 });
		expect(seat(s, 'Red').pendingMonsterDraw?.cards).toHaveLength(2);
	});

	test('a full hand cannot keep a revealed card', () => {
		let s = toLocation(started());
		s = run(s, RED, { type: 'drawMonsterCards', difficulty: 1 });
		s.players.Red!.monsterHand = [0, 1, 2].map((i) => testMonsterCard(CATALOG, { catalogId: MONSTERS[i].id }));
		expect(rejectCode(s, RED, { type: 'keepMonsterCard', index: 0 })).toBe('monster_hand_full');
	});
});

describe('startCombat: fight a monster card from your hand', () => {
	test('fights the card at handIndex; a non-kill leaves the damage on that card, and it stays in the hand', () => {
		let s = toLocation(started());
		// Red already holds d3-b from an earlier visit, then draws d3-a this visit.
		const held = dealTestMonster(s, 'Red', CATALOG, { catalogId: 'd3-b' });
		s = drawMonsterViaCommands(s, RED, CATALOG, { catalogId: 'd3-a' });
		expect(hand(s, 'Red').map((c) => c.id)).toEqual(['d3-b', 'd3-a']);

		s.players.Red!.attackDice = arcaneDice(1); // 1–3 damage: never defeats a Barrier 8+ card
		s = run(s, RED, { type: 'startCombat', handIndex: 1 });
		const [heldAfter, fought] = hand(s, 'Red');
		expect(fought.id).toBe('d3-a');
		expect(fought.hp).toBeLessThan(fought.maxHp);
		expect(fought.hp).toBeGreaterThan(0);
		expect(heldAfter).toEqual(held); // the other card is untouched
		expect(seat(s, 'Red').pendingReward).toBeNull();
		expect(s.combats.at(-1)).toMatchObject({ killed: false, monster: { id: 'd3-a', hp: fought.hp } });

		// The damage persists into the next round: the Barrier never recovers.
		const hpAfterFirst = fought.hp;
		s = toLocation(finishRound(s));
		expect(hand(s, 'Red').map((c) => [c.id, c.hp])).toEqual([
			['d3-b', 12],
			['d3-a', hpAfterFirst]
		]);
		s.players.Red!.attackDice = arcaneDice(1);
		s = run(s, RED, { type: 'startCombat', handIndex: 1 });
		expect(hand(s, 'Red')[1].hp).toBeLessThan(hpAfterFirst);
	});

	test('a kill removes the card from the hand and opens a claim of every reward on it', () => {
		const rich: PlayCatalog = {
			...CATALOG,
			monsters: MONSTERS.map((m) => (m.id === 'd1-a' ? { ...m, rewardTrack: [VP1, VP2, VP3] } : m))
		};
		let s = toLocation(started(7, rich), 'Arcane Abyss', 'Arcane Abyss', rich);
		const other = dealTestMonster(s, 'Red', rich, { catalogId: 'd3-a' });
		dealTestMonster(s, 'Red', rich, { catalogId: 'd1-a' });
		s.players.Red!.attackDice = arcaneDice(6); // ≥ 6 damage kills the 1-Barrier card
		s = run(s, RED, { type: 'startCombat', handIndex: 1 }, rich);

		expect(hand(s, 'Red')).toEqual([other]); // the defeated card left the game
		expect(seat(s, 'Red').pendingReward).toMatchObject({
			monsterId: 'd1-a',
			rewardTrack: [VP1, VP2, VP3],
			chooseAmount: 3
		});
		expect(s.combats.at(-1)).toMatchObject({ killed: true, monster: { id: 'd1-a', hp: 0 } });
		expect(s.bags.monsters.contents.filter((e) => e.id === 'd1-a')).toHaveLength(1); // only the deck copy dealt at start

		s = run(s, RED, { type: 'resolveMonsterReward', picks: [] }, rich);
		expect(seat(s, 'Red').victoryPoints).toBe(6); // 1 + 2 + 3: every reward, no picking
		expect(seat(s, 'Red').pendingReward).toBeNull();
	});

	test('two players at the Abyss each fight their own card; one fight never changes the other hand', () => {
		let s = toLocation(started());
		s = drawMonsterViaCommands(s, RED, CATALOG, { catalogId: 'd3-a' });
		s = drawMonsterViaCommands(s, BLUE, CATALOG, { catalogId: 'd3-b' });
		expect(hand(s, 'Red').map((c) => c.id)).toEqual(['d3-a']);
		expect(hand(s, 'Blue').map((c) => c.id)).toEqual(['d3-b']);

		s.players.Red!.attackDice = arcaneDice(1);
		s.players.Blue!.attackDice = arcaneDice(1);
		const blueBefore = structuredClone(hand(s, 'Blue'));
		s = run(s, RED, { type: 'startCombat', handIndex: 0 });
		const redAfter = structuredClone(hand(s, 'Red'));
		expect(redAfter[0].hp).toBeLessThan(8);
		expect(hand(s, 'Blue')).toEqual(blueBefore);

		// Blue has one card: index 1 does not reach Red's card.
		expect(rejectCode(s, BLUE, { type: 'startCombat', handIndex: 1 })).toBe('monster_card_invalid');
		s = run(s, BLUE, { type: 'startCombat', handIndex: 0 });
		expect(hand(s, 'Blue')[0].hp).toBeLessThan(12);
		expect(hand(s, 'Red')).toEqual(redAfter);

		// One combat record per seat, each with that seat's own card.
		expect(s.combats.map((c) => [c.sides[0]?.seat, c.monster?.id])).toEqual([
			['Red', 'd3-a'],
			['Blue', 'd3-b']
		]);
		// The other player's projection never shows the card that was fought.
		expect(JSON.stringify(buildSessionProjection(s, BLUE_VIEW).players.Red!.monsterHand)).toBe('[]');
	});

	test('rejects an empty hand or an invalid handIndex, and canApply agrees', () => {
		let s = toLocation(started());
		s.players.Red!.attackDice = arcaneDice(1);
		expect(rejectWithLegality(s, RED, { type: 'startCombat', handIndex: 0 })).toEqual({ code: 'no_monster', legal: false });

		dealTestMonster(s, 'Red', CATALOG, { catalogId: 'd3-a' });
		for (const handIndex of [1, -1, 0.5, Number.NaN]) {
			expect(rejectWithLegality(s, RED, { type: 'startCombat', handIndex })).toEqual({
				code: 'monster_card_invalid',
				legal: false
			});
		}
		// A legal fight: canApply does not reject it (it defers to the reducer), and the reducer accepts it.
		expect(canApply(s, RED, { type: 'startCombat', handIndex: 0 }, CATALOG)).not.toBe(false);
		s = run(s, RED, { type: 'startCombat', handIndex: 0 });

		// Once per round: the same card cannot be fought again this round.
		expect(rejectWithLegality(s, RED, { type: 'startCombat', handIndex: 0 })).toEqual({ code: 'action_used', legal: false });

		// A card with no Barrier left is never fightable.
		dealTestMonster(s, 'Blue', CATALOG, { catalogId: 'd1-a', hp: 0 });
		expect(rejectWithLegality(s, BLUE, { type: 'startCombat', handIndex: 0 })).toEqual({
			code: 'monster_defeated',
			legal: false
		});
	});

	test('a card in the hand can only be fought at the Abyss', () => {
		let s = toLocation(started());
		s = drawMonsterViaCommands(s, RED, CATALOG);
		s = toLocation(finishRound(s), 'Mountain Region', 'Arcane Abyss');
		expect(hand(s, 'Red')).toHaveLength(1); // the hand carries across rounds
		expect(rejectWithLegality(s, RED, { type: 'startCombat', handIndex: 0 })).toEqual({ code: 'not_in_abyss', legal: false });
	});

	test('a player may draw and then fight in the same visit', () => {
		let s = toLocation(started());
		s = drawMonsterViaCommands(s, RED, CATALOG, { difficulty: 1 });
		s.players.Red!.attackDice = arcaneDice(6);
		s = run(s, RED, { type: 'startCombat', handIndex: hand(s, 'Red').length - 1 });
		expect(hand(s, 'Red')).toEqual([]);
		expect(seat(s, 'Red').pendingReward).not.toBeNull();
	});

	test('a player may fight and then draw in the same visit', () => {
		let s = toLocation(started());
		dealTestMonster(s, 'Red', CATALOG, { catalogId: 'd3-b' });
		s.players.Red!.attackDice = arcaneDice(1);
		s = run(s, RED, { type: 'startCombat', handIndex: 0 });
		s = drawMonsterViaCommands(s, RED, CATALOG, { difficulty: 1 });
		expect(hand(s, 'Red')).toHaveLength(2);
		expect(seat(s, 'Red').monsterDrawRound).toBe(s.round);
	});
});

describe('monster cards across the round boundary', () => {
	test('a card nobody fights stays in the hand round after round at full Barrier', () => {
		let s = toLocation(started());
		s = drawMonsterViaCommands(s, RED, CATALOG, { difficulty: 3 });
		const card = structuredClone(hand(s, 'Red')[0]);
		const deckSize = s.bags.monsters.contents.length;
		s = finishRound(s);
		for (let round = 0; round < 3; round++) s = finishRound(toLocation(s));
		expect(hand(s, 'Red')).toEqual([card]);
		expect(s.bags.monsters.contents.some((e) => e.id === card.id)).toBe(false);
		expect(s.bags.monsters.contents.length).toBe(deckSize);
	});

	test('defeating the last card saves the spirit world and ends the game at cleanup', () => {
		const one: PlayCatalog = { ...CATALOG, monsters: [card('only', 1)] };
		let s = toLocation(started(7, one), 'Arcane Abyss', 'Arcane Abyss', one);
		s = run(s, RED, { type: 'drawMonsterCards', difficulty: 1 }, one);
		expect(seat(s, 'Red').pendingMonsterDraw!.cards).toHaveLength(1);
		s = run(s, RED, { type: 'keepMonsterCard', index: 0 }, one);
		s.players.Red!.attackDice = arcaneDice(2);
		s = run(s, RED, { type: 'startCombat', handIndex: 0 }, one);
		expect(hand(s, 'Red')).toEqual([]);
		s = run(s, RED, { type: 'resolveMonsterReward', picks: [0] }, one);
		expect(s.status).toBe('active'); // the save is checked at the round boundary
		s = finishRound(s, one);
		expect(s.spiritWorldSaved).toBe(true);
		expect(s.status).toBe('finished');
		expect(s.winnerSeat).toBe('Red'); // highest VP when the world is saved
	});

	test('the spirit world waits until every deck AND every hand is empty', () => {
		const two: PlayCatalog = { ...CATALOG, monsters: [card('first', 1), card('second', 9)] };
		let s = toLocation(started(7, two), 'Arcane Abyss', 'Arcane Abyss', two);
		s = drawMonsterViaCommands(s, RED, two, { catalogId: 'first' });
		s = drawMonsterViaCommands(s, BLUE, two, { catalogId: 'second' });
		expect(s.bags.monsters.count).toBe(0); // every deck is empty; each player holds one card
		s.players.Red!.attackDice = arcaneDice(2);
		s = run(s, RED, { type: 'startCombat', handIndex: 0 }, two);
		expect(hand(s, 'Red')).toEqual([]);
		s = finishRound(s, two);
		// Blue still holds a card, so the world is not saved yet.
		expect(s.spiritWorldSaved).toBeFalsy();
		expect(s.status).toBe('active');
		expect(hand(s, 'Blue').map((c) => c.id)).toEqual(['second']);

		// Next round Blue defeats it: now every deck and every hand is empty.
		s = toLocation(s, 'Mountain Region', 'Arcane Abyss', two);
		s.players.Blue!.attackDice = arcaneDice(12); // ≥ 12 damage kills the 9-Barrier card
		s = run(s, BLUE, { type: 'startCombat', handIndex: 0 }, two);
		expect(hand(s, 'Blue')).toEqual([]);
		s = finishRound(s, two);
		expect(s.spiritWorldSaved).toBe(true);
		expect(s.status).toBe('finished');
	});
});

describe('a reveal left open when the Location phase ends', () => {
	test('cannot end location actions while a reveal is open', () => {
		let s = toLocation(started());
		s = run(s, RED, { type: 'drawMonsterCards', difficulty: 1 });
		expect(rejectCode(s, RED, { type: 'endLocationActions' })).toBe('monster_draw_pending');
	});

	test('a forced advance keeps the first revealed card and returns the other to its deck', () => {
		let s = toLocation(started());
		s = run(s, RED, { type: 'drawMonsterCards', difficulty: 1 });
		const [first, second] = seat(s, 'Red').pendingMonsterDraw!.cards;
		s = finishRound(s);
		expect(seat(s, 'Red').pendingMonsterDraw).toBeNull();
		expect(hand(s, 'Red').map((c) => c.id)).toEqual([first.id]);
		expect(s.bags.monsters.contents.some((e) => e.id === second.id)).toBe(true);
		expect(deckCounts(s)[0]).toBe(3);
	});
});

describe('monster card projections', () => {
	test("other viewers never see a player's monster hand or pending reveal", () => {
		let s = toLocation(started());
		s = run(s, RED, { type: 'drawMonsterCards', difficulty: 3 });
		const revealedIds = seat(s, 'Red').pendingMonsterDraw!.cards.map((c) => c.id);

		const own = buildSessionProjection(s, RED_VIEW);
		expect(own.players.Red!.pendingMonsterDraw?.cards.map((c) => c.id)).toEqual(revealedIds);
		for (const viewer of [BLUE_VIEW, SPECTATOR_VIEW]) {
			const view = buildSessionProjection(s, viewer);
			expect(view.players.Red!.pendingMonsterDraw).toBeNull();
			expect(view.players.Red!.monsterHand).toEqual([]);
			for (const id of revealedIds) expect(JSON.stringify(view)).not.toContain(id);
		}

		s = run(s, RED, { type: 'keepMonsterCard', index: 0 });
		const keptId = seat(s, 'Red').monsterHand![0].id;
		expect(buildSessionProjection(s, RED_VIEW).players.Red!.monsterHand!.map((c) => c.id)).toEqual([keptId]);
		for (const viewer of [BLUE_VIEW, SPECTATOR_VIEW]) {
			const view = buildSessionProjection(s, viewer);
			expect(view.players.Red!.monsterHand).toEqual([]);
			expect(JSON.stringify(view)).not.toContain(keptId);
		}
	});

	test('the projection shows cards left per deck, never the deck contents', () => {
		let s = toLocation(started());
		const counts = (state: PublicGameState) =>
			buildSessionProjection(state, BLUE_VIEW).monsterDecks?.map((d) => [d.difficulty, d.count, d.total]);
		expect(counts(s)).toEqual([
			[1, 4, 4],
			[2, 2, 2],
			[3, 2, 2]
		]);
		s = run(s, RED, { type: 'drawMonsterCards', difficulty: 1 });
		expect(counts(s)).toEqual([
			[1, 2, 4],
			[2, 2, 2],
			[3, 2, 2]
		]);
		s = run(s, RED, { type: 'keepMonsterCard', index: 0 });
		expect(counts(s)).toEqual([
			[1, 3, 4],
			[2, 2, 2],
			[3, 2, 2]
		]);
		const view = buildSessionProjection(s, BLUE_VIEW);
		expect(view.bagCounts.monsters).toBe(7);
		// Undrawn cards stay hidden: no deck card id appears anywhere in the projection.
		for (const entry of s.bags.monsters.contents) expect(JSON.stringify(view)).not.toContain(entry.id!);
	});
});
