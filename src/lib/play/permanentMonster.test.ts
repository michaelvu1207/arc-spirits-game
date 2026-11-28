/**
 * The permanent monster (monsters_v2 `permanent: true`; Michael, 2026-11-14): never in a deck,
 * never used up; at the Arcane Abyss a player may take a copy into the hand instead of drawing
 * from a deck; with one in the catalog, empty decks do not end the game. All through the real
 * reducer.
 */
import { describe, expect, it } from 'vitest';
import { applyGameCommand, createLobbyState } from './runtime';
import { advanceMonsterIfDefeated } from './combat';
import { canApply } from './legality';
import { agentLegalCommands } from './agents/actionSurface';
import { labelFor } from './agents/labels';
import { buildRulesBrief } from './agents/rulesBrief';
import { nextMonsterCardCommand } from './bots/monsterCardAutopilot';
import type { GameCommand, PlayCatalog, PlayCatalogMonster, PublicGameState } from './types';

const VP = '70792514-aa43-4526-a7a4-0f1e4ca55d71';
const ABYSS_SUMMON = '12ff8ffe-20cb-4a86-a493-5e4ff8b9dc3e';
const HOST = { memberId: 'm-host', displayName: 'Host', role: 'host', seatColor: null } as const;
const ACTORS = {
	Red: { ...HOST, seatColor: 'Red' },
	Blue: { memberId: 'm-b', displayName: 'B', role: 'player', seatColor: 'Blue' }
} as const;
// A card's deck is its stage.
const deckMonster = (i: number, barrier: number, stage: 1 | 2 | 3): PlayCatalogMonster => ({
	id: `m-${i}`, name: `Deck Monster ${i}`, damage: 1, barrier, rewardTrack: [VP], dicePool: [], chooseAmount: 1, stage, order: i
});
const LURKER: PlayCatalogMonster = {
	id: 'perm', name: 'Abyss Lurker', damage: 3, barrier: 1, rewardTrack: [VP, ABYSS_SUMMON], dicePool: [], chooseAmount: 2, stage: 1, order: 99, initiative: 4, permanent: true
};
const catalogWith = (permanent: boolean): PlayCatalog => ({
	guardians: [
		{ id: 'g-a', name: 'Myrtle', originId: 'o1' },
		{ id: 'g-b', name: 'Nyra', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
	spirits: Array.from({ length: 12 }, (_, i) => ({ id: `s-${i}`, name: `Spirit ${i}`, cost: i < 6 ? 2 : 8, classes: {}, origins: {} })),
	monsters: [deckMonster(1, 1, 1), deckMonster(2, 2, 1), deckMonster(3, 5, 2), deckMonster(4, 9, 3), ...(permanent ? [LURKER] : [])]
});

function apply(state: PublicGameState, catalog: PlayCatalog, actor: object, command: GameCommand) {
	return applyGameCommand(state, actor as never, command, catalog);
}
function ok(state: PublicGameState, catalog: PlayCatalog, actor: object, command: GameCommand): PublicGameState {
	const r = apply(state, catalog, actor, command);
	if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
	return r.state;
}
/** Red and Blue at the Arcane Abyss, Location step of round 1. */
function atAbyss(catalog: PlayCatalog): PublicGameState {
	let s = createLobbyState({ roomCode: 'PERM', guardianNames: ['Myrtle', 'Nyra'] });
	s = ok(s, catalog, { ...HOST, seatColor: null }, { type: 'claimSeat', seatColor: 'Red' });
	s = ok(s, catalog, { ...ACTORS.Blue, seatColor: null }, { type: 'claimSeat', seatColor: 'Blue' });
	s = ok(s, catalog, ACTORS.Red, { type: 'selectGuardian', guardianName: 'Myrtle' });
	s = ok(s, catalog, ACTORS.Blue, { type: 'selectGuardian', guardianName: 'Nyra' });
	s = ok(s, catalog, ACTORS.Red, { type: 'startGame', seed: 7 });
	for (const seat of ['Red', 'Blue'] as const)
		s = ok(s, catalog, ACTORS[seat], { type: 'lockNavigation', destination: 'Arcane Abyss' });
	if (s.phase !== 'location') s = ok(s, catalog, ACTORS.Red, { type: 'forceAdvancePhase' });
	expect(s.phase).toBe('location');
	return s;
}
const TAKE: GameCommand = { type: 'drawMonsterCards', difficulty: 1, permanent: true };

describe('permanent monster', () => {
	const cat = catalogWith(true);

	it('is on the table from the start, in no deck, and the deck totals do not count it', () => {
		const s = atAbyss(cat);
		expect(s.permanentMonster).toMatchObject({ name: 'Abyss Lurker', hp: 1, maxHp: 1, damage: 3, permanent: true });
		expect(s.permanentMonster?.initiative).toBeUndefined(); // a monster always has the initiative: its printed number is not used
		expect(s.bags.monsters.contents.some((c) => c.id === 'perm')).toBe(false);
		expect(s.bags.monsters.contents).toHaveLength(4);
		expect((s.monsterDecks ?? []).map((d) => d.total)).toEqual([2, 1, 1]);
	});

	it('taking it puts a copy in the hand, uses the draw of the visit, and takes nothing from a deck', () => {
		let s = atAbyss(cat);
		s = ok(s, cat, ACTORS.Red, TAKE);
		const red = s.players.Red!;
		expect(red.monsterHand?.map((c) => c.name)).toEqual(['Abyss Lurker']);
		expect(red.pendingMonsterDraw ?? null).toBeNull();
		expect(s.bags.monsters.contents).toHaveLength(4);
		// One draw per visit: neither a deck nor a second copy.
		expect(apply(s, cat, ACTORS.Red, TAKE).ok).toBe(false);
		expect(apply(s, cat, ACTORS.Red, { type: 'drawMonsterCards', difficulty: 1 }).ok).toBe(false);
		// The other player can take a copy too.
		s = ok(s, cat, ACTORS.Blue, TAKE);
		expect(s.players.Blue!.monsterHand?.map((c) => c.id)).toEqual(['perm']);
	});

	it('defeating it gives its reward; it is there again next time', () => {
		let s = atAbyss(cat);
		s = ok(s, cat, ACTORS.Red, TAKE);
		const red = s.players.Red!;
		red.barrier = 10;
		red.maxBarrier = 10;
		red.attackDice = Array.from({ length: 3 }, (_, i) => ({ instanceId: `d${i}`, tier: 'arcane' as const }));
		const vpBefore = red.victoryPoints;
		s = ok(s, cat, ACTORS.Red, { type: 'startCombat', handIndex: 0 });
		expect(s.combats.find((c) => c.kind === 'monster')?.killed).toBe(true);
		expect(s.players.Red!.monsterHand).toHaveLength(0);
		expect(s.players.Red!.barrier).toBe(7); // a monster always has the initiative: it hits for 3
		s = ok(s, cat, ACTORS.Red, { type: 'resolveMonsterReward', picks: [] });
		expect(s.players.Red!.victoryPoints).toBe(vpBefore + 1);
		expect(s.permanentMonster?.hp).toBe(1); // the table card is untouched
		// A later visit: the draw is available again.
		s.players.Red!.monsterDrawRound = s.round - 1;
		s.players.Red!.handDraws = [];
		expect(canApply(s, ACTORS.Red as never, TAKE, cat)).not.toBe(false);
	});

	it('the hand limit of 3 applies', () => {
		const s = atAbyss(cat);
		const card = s.permanentMonster!;
		s.players.Red!.monsterHand = [card, card, card].map((c) => ({ ...c }));
		expect(apply(s, cat, ACTORS.Red, TAKE).ok).toBe(false);
	});

	it('empty decks do not end the game while there is a permanent monster', () => {
		const withPerm = atAbyss(cat);
		withPerm.bags.monsters.contents = [];
		advanceMonsterIfDefeated(withPerm, cat);
		expect(withPerm.spiritWorldSaved ?? false).toBe(false);
		const plain = catalogWith(false);
		const without = atAbyss(plain);
		without.bags.monsters.contents = [];
		advanceMonsterIfDefeated(without, plain);
		expect(without.spiritWorldSaved).toBe(true);
	});

	it('a catalog without one: no table card, the command is refused, games deal as before', () => {
		const plain = catalogWith(false);
		const s = atAbyss(plain);
		expect(s.permanentMonster).toBeUndefined();
		expect(apply(s, plain, ACTORS.Red, TAKE).ok).toBe(false);
		expect(canApply(s, ACTORS.Red as never, TAKE, plain)).toBe(false);
		// Same seed, same deck order with and without the permanent row.
		expect(atAbyss(cat).bags.monsters.contents.map((c) => c.id)).toEqual(s.bags.monsters.contents.map((c) => c.id));
	});

	it('AI seats see it as an action, bots take it when every deck is empty, and the rules text names it', () => {
		const s = atAbyss(cat);
		const { commands } = agentLegalCommands(s, 'Red', cat);
		const take = commands.find((c) => c.type === 'drawMonsterCards' && c.permanent);
		expect(take).toBeTruthy();
		expect(labelFor(take!, s, 'Red', cat)).toContain('Take the permanent monster Abyss Lurker');
		expect(buildRulesBrief(cat)).toContain('Permanent monster "Abyss Lurker": Barrier 1, damage 3, each kill gives ONE of these');
		expect(buildRulesBrief(cat)).not.toContain('when every monster card is defeated');
		expect(buildRulesBrief(catalogWith(false))).toContain('when every monster card is defeated');
		s.bags.monsters.contents = [];
		expect(nextMonsterCardCommand(s, 'Red', cat)).toEqual(TAKE);
	});
});

describe('a kill of the permanent monster gives one reward, the player\'s choice', () => {
	const cat: PlayCatalog = catalogWith(true);
	/** Red has just defeated the Abyss Lurker and has the claim open. */
	function killed(catalog: PlayCatalog): PublicGameState {
		let s = atAbyss(catalog);
		s = ok(s, catalog, ACTORS.Red, TAKE);
		const red = s.players.Red!;
		red.barrier = 10;
		red.maxBarrier = 10;
		red.attackDice = Array.from({ length: 3 }, (_, i) => ({ instanceId: `d${i}`, tier: 'arcane' as const }));
		s = ok(s, catalog, ACTORS.Red, { type: 'startCombat', handIndex: 0 });
		expect(s.combats.find((c) => c.kind === 'monster')?.killed).toBe(true);
		return s;
	}

	it('the claim is marked as a choice of one, and AI seats get one action for each reward', () => {
		const s = killed(cat);
		expect(s.players.Red!.pendingReward).toMatchObject({ chooseOne: true, chooseAmount: 1 });
		const claims = agentLegalCommands(s, 'Red', cat).commands.filter((c) => c.type === 'resolveMonsterReward');
		expect(claims).toEqual([
			{ type: 'resolveMonsterReward', picks: [0] },
			{ type: 'resolveMonsterReward', picks: [1] }
		]);
		const labels = claims.map((c) => labelFor(c, s, 'Red', cat));
		expect(labels[0]).toContain('Claim ONE reward of Abyss Lurker');
		expect(labels[0]).toContain('you do not get');
		expect(labels[0]).not.toBe(labels[1]);
	});

	it('taking the Victory Point gives 1 VP and no summon', () => {
		let s = killed(cat);
		const vpBefore = s.players.Red!.victoryPoints;
		s = ok(s, cat, ACTORS.Red, { type: 'resolveMonsterReward', picks: [0] });
		expect(s.players.Red!.victoryPoints).toBe(vpBefore + 1);
		expect(s.players.Red!.handDraws ?? []).toHaveLength(0);
		expect(s.players.Red!.pendingReward ?? null).toBeNull();
	});

	it('taking the Arcane Abyss Summon opens the summon and gives no VP', () => {
		let s = killed(cat);
		const vpBefore = s.players.Red!.victoryPoints;
		s = ok(s, cat, ACTORS.Red, { type: 'resolveMonsterReward', picks: [1] });
		expect(s.players.Red!.victoryPoints).toBe(vpBefore);
		expect(s.players.Red!.handDraws.length).toBeGreaterThan(0);
	});

	it('a claim that names no reward takes the first one (the Victory Point)', () => {
		let s = killed(cat);
		const vpBefore = s.players.Red!.victoryPoints;
		s = ok(s, cat, ACTORS.Red, { type: 'resolveMonsterReward', picks: [] });
		expect(s.players.Red!.victoryPoints).toBe(vpBefore + 1);
		expect(s.players.Red!.handDraws ?? []).toHaveLength(0);
	});

	it('the rules text says it is one or the other', () => {
		expect(buildRulesBrief(cat)).toContain('each kill gives ONE of these, your choice:');
		expect(buildRulesBrief(cat)).not.toContain('VP per kill plus its other rewards');
	});
});
