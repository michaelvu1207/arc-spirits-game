/**
 * Fight or summon at the Arcane Abyss (Michael, 2026-11-27:"bring back the summon action but have it an option to do the
 * fight OR an arcane abyss summon action"). The Arcane Abyss has its Arcane Abyss Summon action again; in one
 * round a player there fights or takes that action, never both. Through the real reducer.
 */
import { describe, expect, it } from 'vitest';
import { applyGameCommand, createLobbyState } from './runtime';
import { canApply } from './legality';
import { agentLegalCommands } from './agents/actionSurface';
import { labelFor } from './agents/labels';
import { buildRulesBrief } from './agents/rulesBrief';
import { loadLocalDesignCatalog } from './agents/catalog';
import type { GameCommand, PlayCatalog, PlayCatalogMonster, PublicGameState } from './types';

const VP = '70792514-aa43-4526-a7a4-0f1e4ca55d71';
const ABYSS_SUMMON = '12ff8ffe-20cb-4a86-a493-5e4ff8b9dc3e';
const HOST = { memberId: 'm-host', displayName: 'Host', role: 'host', seatColor: null } as const;
const ACTORS = {
	Red: { ...HOST, seatColor: 'Red' },
	Blue: { memberId: 'm-b', displayName: 'B', role: 'player', seatColor: 'Blue' }
} as const;
const monster = (i: number, barrier: number): PlayCatalogMonster => ({
	id: `m-${i}`, name: `Deck Monster ${i}`, damage: 1, barrier, rewardTrack: [VP], dicePool: [], chooseAmount: 1, stage: 1, order: i, initiative: 3
});
const LURKER: PlayCatalogMonster = { ...monster(99, 1), id: 'perm', name: 'Abyss Lurker', permanent: true };
const CATALOG: PlayCatalog = {
		guardians: [
			{ id: 'g-a', name: 'Myrtle', originId: 'o1' },
			{ id: 'g-b', name: 'Nyra', originId: 'o2' }
		],
		mats: [],
		classes: [],
		dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
		spirits: Array.from({ length: 16 }, (_, i) => ({ id: `s-${i}`, name: `Spirit ${i}`, cost: i < 6 ? 2 : 8, classes: {}, origins: {} })),
		// Difficulty 1 is Barrier 1 to 3; a new player has no attack dice, so a fight never kills here.
		monsters: [monster(1, 3), monster(2, 3), monster(3, 3), monster(4, 3), monster(5, 3), monster(6, 3), LURKER],
		locations: [{ name: 'Arcane Abyss', rewardRows: [{ type: 'gain', gain_icon_ids: [ABYSS_SUMMON] }] }]
	} as unknown as PlayCatalog;

function ok(s: PublicGameState, c: PlayCatalog, actor: object, command: GameCommand): PublicGameState {
	const r = applyGameCommand(s, actor as never, command, c);
	if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
	return r.state;
}
/** Red and Blue at the Arcane Abyss, Location step of round 1; Red holds one monster card. */
function atAbyss(c: PlayCatalog): PublicGameState {
	let s = createLobbyState({ roomCode: 'FOS', guardianNames: ['Myrtle', 'Nyra'] });
	s = ok(s, c, { ...HOST, seatColor: null }, { type: 'claimSeat', seatColor: 'Red' });
	s = ok(s, c, { ...ACTORS.Blue, seatColor: null }, { type: 'claimSeat', seatColor: 'Blue' });
	s = ok(s, c, ACTORS.Red, { type: 'selectGuardian', guardianName: 'Myrtle' });
	s = ok(s, c, ACTORS.Blue, { type: 'selectGuardian', guardianName: 'Nyra' });
	s = ok(s, c, ACTORS.Red, { type: 'startGame', seed: 7 });
	for (const seat of ['Red', 'Blue'] as const) s = ok(s, c, ACTORS[seat], { type: 'lockNavigation', destination: 'Arcane Abyss' });
	if (s.phase !== 'location') s = ok(s, c, ACTORS.Red, { type: 'forceAdvancePhase' });
	expect(s.phase).toBe('location');
	// The opening Power choice blocks location actions: take the first Power offered.
	for (const seat of ['Red', 'Blue'] as const) {
		while (s.players[seat]!.pendingPowerDrafts?.length) s = ok(s, c, ACTORS[seat], { type: 'chooseNavigationPower', powerId: s.players[seat]!.pendingPowerDrafts![0][0] });
	}
	s = ok(s, c, ACTORS.Red, { type: 'drawMonsterCards', difficulty: 1 });
	s = ok(s, c, ACTORS.Red, { type: 'keepMonsterCard', index: 0 });
	expect(s.players.Red!.monsterHand).toHaveLength(1);
	return s;
}
const SUMMON: GameCommand = { type: 'resolveLocationInteraction', rowIndex: 0 };
const FIGHT: GameCommand = { type: 'startCombat', handIndex: 0 };
const can = (s: PublicGameState, c: PlayCatalog, command: GameCommand) => canApply(s, ACTORS.Red as never, command, c) !== false;
const fails = (s: PublicGameState, c: PlayCatalog, command: GameCommand) => {
	const r = applyGameCommand(s, ACTORS.Red as never, command, c);
	return r.ok ? null : r.error.message;
};
/** Leave any open summon draw so the Location turn is free again. */
function closeDraw(s: PublicGameState, c: PlayCatalog): PublicGameState {
	return (s.players.Red!.handDraws?.length ?? 0) > 0 || s.players.Red!.pendingDraw != null ? ok(s, c, ACTORS.Red, { type: 'discardHandDraws' } as GameCommand) : s;
}

describe('abyssFightOrSummon: a round at the Arcane Abyss is a fight OR the Arcane Abyss Summon action', () => {
	it('both are open at the start of the turn', () => {
		const s = atAbyss(CATALOG);
		expect(can(s, CATALOG, SUMMON)).toBe(true);
		expect(can(s, CATALOG, FIGHT)).toBe(true);
	});

	it('after the summon action no fight can start that round', () => {
		let s = ok(atAbyss(CATALOG), CATALOG, ACTORS.Red, SUMMON);
		expect(s.players.Red!.handDraws.length).toBeGreaterThan(0); // the Arcane Abyss draw is open
		s = closeDraw(s, CATALOG);
		expect(can(s, CATALOG, FIGHT)).toBe(false);
		expect(fails(s, CATALOG, FIGHT)).toContain('the Arcane Abyss Summon action used one');
		expect(agentLegalCommands(s, 'Red', CATALOG).commands.some((x) => x.type === 'startCombat')).toBe(false);
	});

	it('after a fight the summon action is gone for that round', () => {
		const s = ok(atAbyss(CATALOG), CATALOG, ACTORS.Red, FIGHT);
		expect(s.players.Red!.monsterHand![0].hp).toBeGreaterThan(0); // the card survived, the fight is spent
		expect(can(s, CATALOG, SUMMON)).toBe(false);
		expect(fails(s, CATALOG, SUMMON)).toContain('uses a battle action');
		expect(agentLegalCommands(s, 'Red', CATALOG).commands.some((x) => x.type === 'resolveLocationInteraction')).toBe(false);
	});

	it('the other player keeps both options, and drawing a card is not part of the choice', () => {
		const s = closeDraw(ok(atAbyss(CATALOG), CATALOG, ACTORS.Red, SUMMON), CATALOG);
		expect(canApply(s, ACTORS.Blue as never, SUMMON, CATALOG)).not.toBe(false);
		expect(canApply(s, ACTORS.Blue as never, { type: 'drawMonsterCards', difficulty: 1 }, CATALOG)).not.toBe(false);
	});

	it('the players are told: labels and rules text', () => {
		const s = atAbyss(CATALOG);
		expect(labelFor(SUMMON, s, 'Red', CATALOG)).toContain('uses your battle action: you cannot fight this round after it');
		expect(labelFor(FIGHT, s, 'Red', CATALOG)).toContain('uses your battle action: no Arcane Abyss Summon action this round after it');
	});
});

/** Red with a Monster Hunter's extra fight of the round (the class grants `extraActions.combat` on navigating). */
function hunterAtAbyss(c: PlayCatalog): PublicGameState {
	const s = atAbyss(c);
	s.players.Red!.extraActions = { ...(s.players.Red!.extraActions ?? {}), combat: 1 };
	return s;
}

describe('abyssFightOrSummon: a Monster Hunter has one extra fight on top of the choice', () => {
	it('the summon action, then still one fight, then none', () => {
		let s = closeDraw(ok(hunterAtAbyss(CATALOG), CATALOG, ACTORS.Red, SUMMON), CATALOG);
		expect(can(s, CATALOG, FIGHT)).toBe(true);
		s = ok(s, CATALOG, ACTORS.Red, FIGHT);
		expect(can(s, CATALOG, FIGHT)).toBe(false);
		expect(fails(s, CATALOG, FIGHT)).toContain('no battle action left');
	});

	it('a fight, then the summon action, then no more fights', () => {
		let s = ok(hunterAtAbyss(CATALOG), CATALOG, ACTORS.Red, FIGHT);
		expect(can(s, CATALOG, SUMMON)).toBe(true);
		expect(can(s, CATALOG, FIGHT)).toBe(true);
		s = closeDraw(ok(s, CATALOG, ACTORS.Red, SUMMON), CATALOG);
		expect(can(s, CATALOG, FIGHT)).toBe(false);
	});

	it('two fights, then the summon action is gone', () => {
		let s = ok(hunterAtAbyss(CATALOG), CATALOG, ACTORS.Red, FIGHT);
		s = ok(s, CATALOG, ACTORS.Red, FIGHT);
		expect(can(s, CATALOG, SUMMON)).toBe(false);
		expect(fails(s, CATALOG, SUMMON)).toContain('no battle action left');
		expect(can(s, CATALOG, FIGHT)).toBe(false);
	});

	it('the labels say what is left', () => {
		const s = hunterAtAbyss(CATALOG);
		expect(labelFor(SUMMON, s, 'Red', CATALOG)).toContain('uses 1 battle action: 1 left after it');
		expect(labelFor(FIGHT, s, 'Red', CATALOG)).toContain('uses 1 battle action: 1 left after it');
		const t = ok(s, CATALOG, ACTORS.Red, FIGHT);
		expect(labelFor(FIGHT, t, 'Red', CATALOG)).toContain('no Arcane Abyss Summon action this round after it');
		expect(labelFor(SUMMON, t, 'Red', CATALOG)).toContain('you cannot fight this round after it');
	});
});

describe('the working tables (lab/data)', () => {
	const now = loadLocalDesignCatalog('data');
	it('the rules brief describes the Arcane Abyss summon action and the fight-or-summon choice', () => {
		const brief = buildRulesBrief(now);
		expect(brief).toContain('you have 1 battle action each round');
		expect(brief).toContain('with 1 battle action you either fight or take that action, never both');
		expect(brief).toContain('a FIGHT uses a battle action, and so does the Arcane Abyss Summon action');
		expect(brief).toContain('without battling it. This uses a battle action.');
		expect(brief).not.toContain('ONLY a monster reward');
		// Monster Hunter is reworded for the choice (Michael: "monster hunter should still be able to trigger a fight").
		expect(brief).toContain('You have 1 extra battle action each round.');
		expect(brief).not.toContain('initiate Monster Combat two times');
	});
});
