/**
 * Rule `abyssDrawByPoints` (Michael, 2026-11-22): at the Arcane Abyss the players draw from the
 * shared monster decks one after the other, fewest points first. Through the real reducer.
 */
import { describe, expect, it } from 'vitest';
import { applyGameCommand, createLobbyState } from './runtime';
import { abyssDrawBlockedBy, abyssDrawOrder } from './abyssDrawOrder';
import { canApply } from './legality';
import { agentLegalCommands } from './agents/actionSurface';
import { buildRulesBrief } from './agents/rulesBrief';
import type { GameCommand, PlayCatalog, PlayCatalogMonster, PlayRules, PublicGameState } from './types';

const VP = '70792514-aa43-4526-a7a4-0f1e4ca55d71';
const HOST = { memberId: 'm-host', displayName: 'Host', role: 'host', seatColor: null } as const;
const ACTORS = {
	Red: { ...HOST, seatColor: 'Red' },
	Blue: { memberId: 'm-b', displayName: 'B', role: 'player', seatColor: 'Blue' }
} as const;
const monster = (i: number, barrier: number): PlayCatalogMonster => ({
	id: `m-${i}`, name: `Deck Monster ${i}`, damage: 1, barrier, rewardTrack: [VP], dicePool: [], chooseAmount: 1, stage: 1, order: i, initiative: 3
});
const LURKER: PlayCatalogMonster = { ...monster(99, 1), id: 'perm', name: 'Abyss Lurker', permanent: true };
const catalogWith = (rules?: PlayRules): PlayCatalog => ({
	guardians: [
		{ id: 'g-a', name: 'Myrtle', originId: 'o1' },
		{ id: 'g-b', name: 'Nyra', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
	spirits: Array.from({ length: 12 }, (_, i) => ({ id: `s-${i}`, name: `Spirit ${i}`, cost: i < 6 ? 2 : 8, classes: {}, origins: {} })),
	monsters: [monster(1, 1), monster(2, 2), monster(3, 3), monster(4, 3), monster(5, 5), LURKER],
	...(rules ? { rules } : {})
});
const ON = catalogWith({ abyssDrawByPoints: true });
const OFF = catalogWith();

const apply = (s: PublicGameState, c: PlayCatalog, actor: object, command: GameCommand) => applyGameCommand(s, actor as never, command, c);
function ok(s: PublicGameState, c: PlayCatalog, actor: object, command: GameCommand): PublicGameState {
	const r = apply(s, c, actor, command);
	if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
	return r.state;
}
/** Red and Blue at the Arcane Abyss, Location step of round 1, both with 0 points. */
function atAbyss(c: PlayCatalog): PublicGameState {
	let s = createLobbyState({ roomCode: 'DRAW', guardianNames: ['Myrtle', 'Nyra'] });
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
const DRAW: GameCommand = { type: 'drawMonsterCards', difficulty: 1 };
const LURK: GameCommand = { type: 'drawMonsterCards', difficulty: 1, permanent: true };
const draws = (s: PublicGameState, seat: 'Red' | 'Blue', c: PlayCatalog) =>
	agentLegalCommands(s, seat, c).commands.filter((x) => x.type === 'drawMonsterCards' && !x.permanent).length;

describe('abyssDrawByPoints: the players at the Abyss draw fewest points first', () => {
	it('equal points: table order from the seat of the round; the one behind waits for the one ahead', () => {
		let s = atAbyss(ON);
		expect(abyssDrawOrder(s)).toEqual(['Red', 'Blue']);
		expect(abyssDrawBlockedBy(ON, s, 'Red')).toBeNull();
		expect(abyssDrawBlockedBy(ON, s, 'Blue')).toBe('Red');
		const refused = apply(s, ON, ACTORS.Blue, DRAW);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.error.code).toBe('abyss_draw_wait');
		expect(canApply(s, ACTORS.Blue as never, DRAW, ON)).toBe(false);
		expect(draws(s, 'Blue', ON)).toBe(0);
		expect(draws(s, 'Red', ON)).toBeGreaterThan(0);
		// Red reveals two cards: Blue still waits until Red has kept one.
		s = ok(s, ON, ACTORS.Red, DRAW);
		expect(abyssDrawBlockedBy(ON, s, 'Blue')).toBe('Red');
		s = ok(s, ON, ACTORS.Red, { type: 'keepMonsterCard', index: 0 });
		expect(abyssDrawBlockedBy(ON, s, 'Blue')).toBeNull();
		s = ok(s, ON, ACTORS.Blue, DRAW);
		expect(s.players.Blue!.pendingMonsterDraw?.cards.length).toBeGreaterThan(0);
	});
	it('the one ahead may pass by ending their Location turn', () => {
		let s = atAbyss(ON);
		s = ok(s, ON, ACTORS.Red, { type: 'endLocationActions' });
		expect(abyssDrawBlockedBy(ON, s, 'Blue')).toBeNull();
		expect(apply(s, ON, ACTORS.Blue, DRAW).ok).toBe(true);
	});
	it('the permanent monster needs no turn and counts as the draw of the visit', () => {
		let s = atAbyss(ON);
		s = ok(s, ON, ACTORS.Blue, LURK);
		expect(s.players.Blue!.monsterHand?.map((c) => c.name)).toEqual(['Abyss Lurker']);
		// Red takes it too: Red has used the draw of the visit and no longer holds anyone back.
		s = ok(s, ON, ACTORS.Red, LURK);
		expect(abyssDrawBlockedBy(ON, s, 'Blue')).toBeNull();
	});
	it('fewer points at the start of the round draws first; a later round starts the tie one seat on', () => {
		const s = atAbyss(ON);
		s.players.Red!.vpHistory = [4];
		s.players.Blue!.vpHistory = [1];
		expect(abyssDrawOrder(s)).toEqual(['Blue', 'Red']);
		expect(abyssDrawBlockedBy(ON, s, 'Red')).toBe('Blue');
		expect(abyssDrawBlockedBy(ON, s, 'Blue')).toBeNull();
		// Points gained during this round do not change the order.
		s.players.Blue!.victoryPoints = 9;
		expect(abyssDrawOrder(s)).toEqual(['Blue', 'Red']);
		s.players.Red!.vpHistory = [2];
		s.players.Blue!.vpHistory = [2];
		expect(abyssDrawOrder({ ...s, round: 2 })).toEqual(['Blue', 'Red']);
		expect(abyssDrawOrder({ ...s, round: 3 })).toEqual(['Red', 'Blue']);
		// A player elsewhere is not in the order.
		s.players.Blue!.navigationDestination = 'Forest Region';
		expect(abyssDrawOrder(s)).toEqual(['Red']);
	});
	it('a full hand does not hold the others back', () => {
		const s = atAbyss(ON);
		const card = { ...s.permanentMonster! };
		s.players.Red!.monsterHand = [card, { ...card }, { ...card }];
		expect(abyssDrawBlockedBy(ON, s, 'Blue')).toBeNull();
	});
	it('with the rule off anyone draws at any time, and only the rule adds the text', () => {
		const s = atAbyss(OFF);
		expect(abyssDrawBlockedBy(OFF, s, 'Blue')).toBeNull();
		expect(apply(s, OFF, ACTORS.Blue, DRAW).ok).toBe(true);
		expect(buildRulesBrief(ON)).toContain('DRAWING ORDER');
		expect(buildRulesBrief(OFF)).not.toContain('DRAWING ORDER');
	});
});
