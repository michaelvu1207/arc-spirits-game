/**
 * A monster draw reveals ONE card (Michael, 2026-11-23). The player keeps it or
 * puts it back on top of its deck; when they keep it they may put a card they hold back on top of that
 * card's deck, where it is at full Barrier again. Through the real reducer.
 */
import { describe, expect, it } from 'vitest';
import { applyGameCommand, createLobbyState } from './runtime';
import { returnOpenMonsterReveals } from './combat';
import { canApply } from './legality';
import { agentLegalCommands } from './agents/actionSurface';
import { labelFor } from './agents/labels';
import { buildRulesBrief } from './agents/rulesBrief';
import { abyssDrawBlockedBy } from './abyssDrawOrder';
import { dealTestMonster } from './testing/monsterCards';
import type { GameCommand, PlayCatalog, PlayCatalogMonster, PublicGameState } from './types';

const VP = '70792514-aa43-4526-a7a4-0f1e4ca55d71';
const HOST = { memberId: 'm-host', displayName: 'Host', role: 'host', seatColor: null } as const;
const ACTORS = {
	Red: { ...HOST, seatColor: 'Red' },
	Blue: { memberId: 'm-b', displayName: 'B', role: 'player', seatColor: 'Blue' }
} as const;
const monster = (i: number, barrier: number, stage: 1 | 2): PlayCatalogMonster => ({
	id: `m-${i}`, name: `Deck Monster ${i}`, damage: 1, barrier, rewardTrack: [VP], dicePool: [], chooseAmount: 1, stage, order: i, initiative: 3
});
const LURKER: PlayCatalogMonster = { ...monster(99, 1, 1), id: 'perm', name: 'Abyss Lurker', permanent: true };
const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-a', name: 'Myrtle', originId: 'o1' },
		{ id: 'g-b', name: 'Nyra', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
	spirits: Array.from({ length: 12 }, (_, i) => ({ id: `s-${i}`, name: `Spirit ${i}`, cost: i < 6 ? 2 : 8, classes: {}, origins: {} })),
	// A card's deck is its stage: Difficulty 1, six cards; Difficulty 2, two cards.
	monsters: [monster(1, 2, 1), monster(2, 2, 1), monster(3, 3, 1), monster(4, 3, 1), monster(5, 3, 1), monster(6, 3, 1), monster(7, 5, 2), monster(8, 6, 2), LURKER]
};

const apply = (s: PublicGameState, c: PlayCatalog, actor: object, command: GameCommand) => applyGameCommand(s, actor as never, command, c);
function ok(s: PublicGameState, c: PlayCatalog, actor: object, command: GameCommand): PublicGameState {
	const r = apply(s, c, actor, command);
	if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
	return r.state;
}
/** Red and Blue at the Arcane Abyss, Location step of round 1. */
function atAbyss(c: PlayCatalog): PublicGameState {
	let s = createLobbyState({ roomCode: 'ONE', guardianNames: ['Myrtle', 'Nyra'] });
	s = ok(s, c, { ...HOST, seatColor: null }, { type: 'claimSeat', seatColor: 'Red' });
	s = ok(s, c, { ...ACTORS.Blue, seatColor: null }, { type: 'claimSeat', seatColor: 'Blue' });
	s = ok(s, c, ACTORS.Red, { type: 'selectGuardian', guardianName: 'Myrtle' });
	s = ok(s, c, ACTORS.Blue, { type: 'selectGuardian', guardianName: 'Nyra' });
	s = ok(s, c, ACTORS.Red, { type: 'startGame', seed: 7 });
	for (const seat of ['Red', 'Blue'] as const) s = ok(s, c, ACTORS[seat], { type: 'lockNavigation', destination: 'Arcane Abyss' });
	if (s.phase !== 'location') s = ok(s, c, ACTORS.Red, { type: 'forceAdvancePhase' });
	expect(s.phase).toBe('location');
	return s;
}
const DRAW1: GameCommand = { type: 'drawMonsterCards', difficulty: 1 };
const DRAW2: GameCommand = { type: 'drawMonsterCards', difficulty: 2 };
const KEEP: GameCommand = { type: 'keepMonsterCard', index: 0 };
const BACK: GameCommand = { type: 'keepMonsterCard', index: 0, returnToDeck: true };
const deck = (s: PublicGameState, d: number) => s.bags.monsters.contents.filter((e) => e.difficulty === d);
const top = (s: PublicGameState, d: number) => deck(s, d)[0];

describe('monsterDrawOne: a draw reveals one card', () => {
	it('the top card of the chosen deck is revealed, and only that one', () => {
		const s0 = atAbyss(CATALOG);
		const first = top(s0, 1), n = deck(s0, 1).length;
		const s = ok(s0, CATALOG, ACTORS.Red, DRAW1);
		const pending = s.players.Red!.pendingMonsterDraw!;
		expect(pending.cards.map((c) => c.id)).toEqual([first.id]);
		expect(pending.maxCards).toBe(1);
		expect(deck(s, 1)).toHaveLength(n - 1);
	});

	it('keeping it puts it into the hand', () => {
		const s0 = atAbyss(CATALOG), first = top(s0, 1), n = deck(s0, 1).length;
		const s = ok(ok(s0, CATALOG, ACTORS.Red, DRAW1), CATALOG, ACTORS.Red, KEEP);
		expect(s.players.Red!.monsterHand!.map((c) => c.id)).toEqual([first.id]);
		expect(s.players.Red!.pendingMonsterDraw).toBeNull();
		expect(deck(s, 1)).toHaveLength(n - 1);
	});

	it('putting it back leaves it on top of its deck, and that was the draw of the visit', () => {
		const s0 = atAbyss(CATALOG), first = top(s0, 1), n = deck(s0, 1).length;
		const s = ok(ok(s0, CATALOG, ACTORS.Red, DRAW1), CATALOG, ACTORS.Red, BACK);
		expect(s.players.Red!.monsterHand).toHaveLength(0);
		expect(s.players.Red!.pendingMonsterDraw).toBeNull();
		expect(deck(s, 1)).toHaveLength(n);
		expect(top(s, 1).id).toBe(first.id);
		expect(s.bags.monsters.count).toBe(s.bags.monsters.contents.length);
		// No second look, in this deck or another one.
		const again = apply(s, CATALOG, ACTORS.Red, DRAW2);
		expect(again.ok).toBe(false);
		if (!again.ok) expect(again.error.code).toBe('monster_draw_used');
		// The next player to draw from that deck reveals the same card.
		const blue = ok(s, CATALOG, ACTORS.Blue, DRAW1);
		expect(blue.players.Blue!.pendingMonsterDraw!.cards[0].id).toBe(first.id);
	});
});

describe('monsterDrawOne: replacing a card you hold', () => {
	/** Red holds one damaged Difficulty 2 card and has just revealed the top Difficulty 1 card. */
	function redHoldsDamaged(): { s: PublicGameState; heldId: string; revealedId: string } {
		let s = ok(ok(atAbyss(CATALOG), CATALOG, ACTORS.Red, DRAW2), CATALOG, ACTORS.Red, KEEP);
		s = structuredClone(s);
		const held = s.players.Red!.monsterHand![0];
		held.hp = held.maxHp - 3; // 3 damage done to it
		s.players.Red!.monsterDrawRound = 0; // a later visit
		const revealedId = top(s, 1).id;
		s = ok(s, CATALOG, ACTORS.Red, DRAW1);
		return { s, heldId: held.id, revealedId: revealedId! };
	}

	it('the held card goes back on top of its own deck at full Barrier; the new card is kept', () => {
		const { s: s0, heldId, revealedId } = redHoldsDamaged();
		const d2 = deck(s0, 2).length;
		const s = ok(s0, CATALOG, ACTORS.Red, { type: 'keepMonsterCard', index: 0, replaceHandIndex: 0 });
		expect(s.players.Red!.monsterHand!.map((c) => c.id)).toEqual([revealedId]);
		expect(deck(s, 2)).toHaveLength(d2 + 1);
		expect(top(s, 2).id).toBe(heldId);
		// The next player who draws it finds it undamaged.
		const blue = ok(s, CATALOG, ACTORS.Blue, DRAW2);
		const card = blue.players.Blue!.pendingMonsterDraw!.cards[0];
		expect(card.id).toBe(heldId);
		expect(card.hp).toBe(card.maxHp);
	});

	it('a plain keep leaves the held card and its damage alone', () => {
		const { s: s0, heldId } = redHoldsDamaged();
		const s = ok(s0, CATALOG, ACTORS.Red, KEEP);
		const held = s.players.Red!.monsterHand!.find((c) => c.id === heldId)!;
		expect(s.players.Red!.monsterHand).toHaveLength(2);
		expect(held.hp).toBe(held.maxHp - 3);
	});

	it('a hand index that holds no card is refused', () => {
		const { s } = redHoldsDamaged();
		const cmd: GameCommand = { type: 'keepMonsterCard', index: 0, replaceHandIndex: 2 };
		expect(canApply(s, ACTORS.Red as never, cmd, CATALOG)).toBe(false);
		expect(apply(s, CATALOG, ACTORS.Red, cmd).ok).toBe(false);
	});

	it('a copy of the permanent monster that is swapped out just leaves the hand', () => {
		let s = ok(atAbyss(CATALOG), CATALOG, ACTORS.Red, { type: 'drawMonsterCards', difficulty: 1, permanent: true });
		s = structuredClone(s);
		s.players.Red!.monsterDrawRound = 0;
		const total = s.bags.monsters.contents.length;
		s = ok(s, CATALOG, ACTORS.Red, DRAW1);
		s = ok(s, CATALOG, ACTORS.Red, { type: 'keepMonsterCard', index: 0, replaceHandIndex: 0 });
		expect(s.players.Red!.monsterHand).toHaveLength(1);
		expect(s.players.Red!.monsterHand![0].permanent).toBeFalsy();
		expect(s.bags.monsters.contents).toHaveLength(total - 1);
	});
});

describe('monsterDrawOne: a full hand', () => {
	function fullHand(c: PlayCatalog): PublicGameState {
		const s = structuredClone(atAbyss(c));
		for (let i = 0; i < 3; i++) dealTestMonster(s, 'Red', c, { id: `held-${i}`, name: `Held ${i}`, hp: 4, maxHp: 6, difficulty: 2 });
		return s;
	}

	it('the draw is allowed; the card can only replace a held one or go back', () => {
		const s0 = fullHand(CATALOG);
		expect(canApply(s0, ACTORS.Red as never, DRAW1, CATALOG)).not.toBe(false);
		const s = ok(s0, CATALOG, ACTORS.Red, DRAW1);
		expect(canApply(s, ACTORS.Red as never, KEEP, CATALOG)).toBe(false);
		expect(apply(s, CATALOG, ACTORS.Red, KEEP).ok).toBe(false);
		const offered = agentLegalCommands(s, 'Red', CATALOG).commands.filter((x) => x.type === 'keepMonsterCard');
		expect(offered).toEqual([
			{ type: 'keepMonsterCard', index: 0, replaceHandIndex: 0 },
			{ type: 'keepMonsterCard', index: 0, replaceHandIndex: 1 },
			{ type: 'keepMonsterCard', index: 0, replaceHandIndex: 2 },
			{ type: 'keepMonsterCard', index: 0, returnToDeck: true }
		]);
		const swapped = ok(s, CATALOG, ACTORS.Red, offered[1]);
		expect(swapped.players.Red!.monsterHand!.map((c) => c.id)).not.toContain('held-1');
		expect(swapped.players.Red!.monsterHand).toHaveLength(3);
		expect(top(swapped, 2).id).toBe('held-1');
		expect(top(swapped, 2).barrier).toBe(6); // full Barrier again
	});

	it('the permanent monster still needs room in the hand', () => {
		expect(canApply(fullHand(CATALOG), ACTORS.Red as never, { type: 'drawMonsterCards', difficulty: 1, permanent: true }, CATALOG)).toBe(false);
	});

	it('under the drawing order a full hand ahead still holds the others back until it has drawn', () => {
		const s = fullHand(CATALOG); // Red is first in round 1 (equal points, table order)
		expect(abyssDrawBlockedBy(CATALOG, s, 'Blue')).toBe('Red');
		const after = ok(ok(s, CATALOG, ACTORS.Red, DRAW1), CATALOG, ACTORS.Red, BACK);
		expect(abyssDrawBlockedBy(CATALOG, after, 'Blue')).toBeNull();
	});

	it('a reveal left open at the end of the round goes back on top when the hand has no room', () => {
		const s = structuredClone(ok(fullHand(CATALOG), CATALOG, ACTORS.Red, DRAW1));
		const id = s.players.Red!.pendingMonsterDraw!.cards[0].id;
		returnOpenMonsterReveals(s, CATALOG);
		expect(s.players.Red!.pendingMonsterDraw).toBeNull();
		expect(s.players.Red!.monsterHand).toHaveLength(3);
		expect(top(s, 1).id).toBe(id);
	});
});

describe('monsterDrawOne: what a player is offered and told', () => {
	it('with room in the hand: keep, swap for each held card, or put back', () => {
		let s = ok(ok(atAbyss(CATALOG), CATALOG, ACTORS.Red, DRAW2), CATALOG, ACTORS.Red, KEEP);
		s = structuredClone(s);
		s.players.Red!.monsterHand![0].hp -= 2;
		s.players.Red!.monsterDrawRound = 0;
		s = ok(s, CATALOG, ACTORS.Red, DRAW1);
		const offered = agentLegalCommands(s, 'Red', CATALOG).commands.filter((x) => x.type === 'keepMonsterCard');
		expect(offered).toEqual([
			{ type: 'keepMonsterCard', index: 0 },
			{ type: 'keepMonsterCard', index: 0, replaceHandIndex: 0 },
			{ type: 'keepMonsterCard', index: 0, returnToDeck: true }
		]);
		const labels = offered.map((cmd) => labelFor(cmd, s, 'Red', CATALOG));
		expect(labels[0]).toMatch(/^Keep /);
		expect(labels[1]).toMatch(/goes back on top of its deck at full Barrier \(the 2 damage you did to it is lost\)/);
		expect(labels[2]).toMatch(/back on top of its deck/);
	});

	it('the rules text describes the one-card draw', () => {
		const brief = buildRulesBrief(CATALOG);
		expect(brief).toMatch(/you look at its TOP card and either keep it or put it back on top/);
		expect(brief).toMatch(/goes back on top of its own deck at full Barrier/);
		expect(brief).not.toMatch(/2 cards are revealed/);
	});
});
