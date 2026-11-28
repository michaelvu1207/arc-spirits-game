/**
 * What the game screens are told about the Arcane Abyss (viewV2.ts `affordances.abyss`,
 * `pendingReward.chooseOne`, `summonReplace`): battle actions left, how a draw works, whose turn it
 * is to draw. Checked against the real reducer, so the screen and the rules cannot drift apart.
 */
import { describe, expect, it } from 'vitest';
import { applyGameCommand, createLobbyState } from './runtime';
import { computeAffordances } from './viewV2';
import { abyssAffordance } from './abyssAffordance';
import type { GameCommand, PlayCatalog, PlayCatalogMonster, PlayRules, PublicGameState } from './types';

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
const LURKER: PlayCatalogMonster = { ...monster(99, 1), id: 'perm', name: 'Abyss Lurker', rewardTrack: [VP, ABYSS_SUMMON], permanent: true };
const catalogWith = (rules: PlayRules): PlayCatalog =>
	({
		guardians: [
			{ id: 'g-a', name: 'Myrtle', originId: 'o1' },
			{ id: 'g-b', name: 'Nyra', originId: 'o2' }
		],
		mats: [],
		classes: [],
		dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
		spirits: Array.from({ length: 16 }, (_, i) => ({ id: `s-${i}`, name: `Spirit ${i}`, cost: i < 6 ? 2 : 8, classes: {}, origins: {} })),
		monsters: [monster(1, 3), monster(2, 3), monster(3, 3), monster(4, 3), monster(5, 3), monster(6, 3), LURKER],
		locations: [{ name: 'Arcane Abyss', rewardRows: [{ type: 'gain', gain_icon_ids: [ABYSS_SUMMON] }] }],
		rules
	}) as unknown as PlayCatalog;
const NEW = catalogWith({ monsterDrawOne: true, abyssFightOrSummon: true, abyssDrawByPoints: true });
const OLD = catalogWith({});

function ok(s: PublicGameState, c: PlayCatalog, actor: object, command: GameCommand): PublicGameState {
	const r = applyGameCommand(s, actor as never, command, c);
	if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
	return r.state;
}
/** Red and Blue at the Arcane Abyss, Location step of round 1, nothing done yet. */
function atAbyss(c: PlayCatalog): PublicGameState {
	let s = createLobbyState({ roomCode: 'AFF', guardianNames: ['Myrtle', 'Nyra'] });
	s = ok(s, c, { ...HOST, seatColor: null }, { type: 'claimSeat', seatColor: 'Red' });
	s = ok(s, c, { ...ACTORS.Blue, seatColor: null }, { type: 'claimSeat', seatColor: 'Blue' });
	s = ok(s, c, ACTORS.Red, { type: 'selectGuardian', guardianName: 'Myrtle' });
	s = ok(s, c, ACTORS.Blue, { type: 'selectGuardian', guardianName: 'Nyra' });
	s = ok(s, c, ACTORS.Red, { type: 'startGame', seed: 7 });
	for (const seat of ['Red', 'Blue'] as const) s = ok(s, c, ACTORS[seat], { type: 'lockNavigation', destination: 'Arcane Abyss' });
	if (s.phase !== 'location') s = ok(s, c, ACTORS.Red, { type: 'forceAdvancePhase' });
	expect(s.phase).toBe('location');
	for (const seat of ['Red', 'Blue'] as const) {
		while (s.players[seat]!.pendingPowerDrafts?.length) s = ok(s, c, ACTORS[seat], { type: 'chooseNavigationPower', powerId: s.players[seat]!.pendingPowerDrafts![0][0] });
	}
	return s;
}
const SUMMON: GameCommand = { type: 'resolveLocationInteraction', rowIndex: 0 };

describe('affordances.abyss', () => {
	it('is absent away from the Arcane Abyss', () => {
		const s = atAbyss(NEW);
		s.players.Red!.navigationDestination = 'Forest Region';
		expect(computeAffordances(s, 'Red', NEW).abyss).toBeUndefined();
	});

	it('old rules: a draw reveals two, nothing goes back, nobody waits, one battle action', () => {
		const s = atAbyss(OLD);
		expect(computeAffordances(s, 'Red', OLD).abyss).toEqual({
			battleActionsLeft: 1,
			battleActions: 1,
			summonUsesBattleAction: false,
			summonTaken: false,
			drawReveals: 2,
			canReturnDraw: false
		});
	});

	it('new rules: one card, it may go back, and the draws go in order', () => {
		const s = atAbyss(NEW);
		const red = computeAffordances(s, 'Red', NEW).abyss!;
		const blue = computeAffordances(s, 'Blue', NEW).abyss!;
		expect(red).toMatchObject({ drawReveals: 1, canReturnDraw: true, summonUsesBattleAction: true, battleActionsLeft: 1 });
		// Equal points in round 1: table order, so Red draws first and Blue waits for Red.
		expect(red.drawOrder).toEqual(['Red', 'Blue']);
		expect(red.drawWaitsOn).toBeUndefined();
		expect(blue.drawWaitsOn).toBe('Red');
		// The reducer agrees: Blue's draw is refused, Red's is not.
		expect(applyGameCommand(s, ACTORS.Blue as never, { type: 'drawMonsterCards', difficulty: 1 }, NEW).ok).toBe(false);
		let t = ok(s, NEW, ACTORS.Red, { type: 'drawMonsterCards', difficulty: 1 });
		// While Red's card lies revealed Blue still waits; once it is kept Blue may draw.
		expect(computeAffordances(t, 'Blue', NEW).abyss!.drawWaitsOn).toBe('Red');
		t = ok(t, NEW, ACTORS.Red, { type: 'keepMonsterCard', index: 0 });
		expect(computeAffordances(t, 'Blue', NEW).abyss!.drawWaitsOn).toBeUndefined();
		expect(applyGameCommand(t, ACTORS.Blue as never, { type: 'drawMonsterCards', difficulty: 1 }, NEW).ok).toBe(true);
	});

	it('the Arcane Abyss Summon action uses the battle action, and the row then reads as taken', () => {
		let s = atAbyss(NEW);
		s = ok(s, NEW, ACTORS.Red, { type: 'drawMonsterCards', difficulty: 1 });
		s = ok(s, NEW, ACTORS.Red, { type: 'keepMonsterCard', index: 0 });
		expect(computeAffordances(s, 'Red', NEW).locationInteractions?.[0].affordable).toBe(true);
		const afterSummon = ok(s, NEW, ACTORS.Red, SUMMON);
		expect(computeAffordances(afterSummon, 'Red', NEW).abyss).toMatchObject({ battleActionsLeft: 0, summonTaken: true });
		expect(applyGameCommand(afterSummon, ACTORS.Red as never, { type: 'startCombat', handIndex: 0 }, NEW).ok).toBe(false);
	});

	it('after a fight the summon row is not affordable (the same answer as the reducer)', () => {
		let s = atAbyss(NEW);
		s = ok(s, NEW, ACTORS.Red, { type: 'drawMonsterCards', difficulty: 1 });
		s = ok(s, NEW, ACTORS.Red, { type: 'keepMonsterCard', index: 0 });
		s = ok(s, NEW, ACTORS.Red, { type: 'startCombat', handIndex: 0 });
		const a = computeAffordances(s, 'Red', NEW);
		expect(a.abyss).toMatchObject({ battleActionsLeft: 0, summonTaken: false });
		expect(a.locationInteractions?.[0].affordable).toBe(false);
		expect(applyGameCommand(s, ACTORS.Red as never, SUMMON, NEW).ok).toBe(false);
	});

	it('a Monster Hunter has two battle actions', () => {
		const s = atAbyss(NEW);
		s.players.Red!.extraActions = { ...s.players.Red!.extraActions, combat: 1 };
		expect(computeAffordances(s, 'Red', NEW).abyss).toMatchObject({ battleActions: 2, battleActionsLeft: 2 });
	});

	it('a screen without affordances gets the same answer from the room it sees', () => {
		const s = atAbyss(NEW);
		expect(abyssAffordance(s, 'Blue', NEW)).toEqual(computeAffordances(s, 'Blue', NEW).abyss);
	});
});

describe('affordances.pendingReward and summonReplace', () => {
	it('a kill of the permanent monster under permanentRewardChoice is marked choose one', () => {
		const c = catalogWith({ monsterDrawOne: true, permanentRewardChoice: true });
		let s = atAbyss(c);
		s = ok(s, c, ACTORS.Red, { type: 'drawMonsterCards', difficulty: 1, permanent: true });
		// Six Arcane dice kill the Barrier 1 Abyss Lurker.
		s.players.Red!.attackDice = Array.from({ length: 6 }, (_, i) => ({ instanceId: `d${i}`, tier: 'arcane' as const }));
		s = ok(s, c, ACTORS.Red, { type: 'startCombat', handIndex: 0 });
		const reward = computeAffordances(s, 'Red', c).pendingReward;
		expect(reward?.chooseOne).toBe(true);
		expect(reward?.options.length).toBe(2);
		// A deck card still gives every reward: no mark.
		expect(computeAffordances(atAbyss(c), 'Red', c).pendingReward).toBeUndefined();
	});

	it('summonReplace names the spirits only with a full board, a spirit draw and the rule', () => {
		const c = catalogWith({ summonReplaceWhenFull: true });
		const s = atAbyss(c);
		const red = s.players.Red!;
		expect(computeAffordances(s, 'Red', c).summonReplace).toBeUndefined();
		red.spirits = Array.from({ length: 7 }, (_, i) => ({ ...(red.spirits[0] ?? {}), id: `s-${i}`, name: `Spirit ${i}`, slotIndex: i + 1 })) as never;
		red.handDraws = [{ guid: 'd1', id: 's-9', name: 'Spirit 9' }] as never;
		expect(computeAffordances(s, 'Red', c).summonReplace).toEqual({ slots: [1, 2, 3, 4, 5, 6, 7] });
		// Rule off: nothing to offer.
		expect(computeAffordances(s, 'Red', OLD).summonReplace).toBeUndefined();
		// A reward hex in the draw never replaces a spirit.
		red.handDraws = [{ guid: 'd2', rewardId: 'r1', name: 'Reward' }] as never;
		expect(computeAffordances(s, 'Red', c).summonReplace).toBeUndefined();
	});
});
