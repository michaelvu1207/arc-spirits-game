/**
 * The monster reward tokens that the printed cards show and the engine used to drop
 * (owner rule, 2026-11-11: "4 VP is 4 victory points and gaining attack dice is gaining
 * attack dice" — one die-face token = one die of that tier), and the named relic tokens
 * (owner rule, 2026-11-12: "If there's a relic on a monster card, just give the relic.").
 */
import { describe, expect, test } from 'vitest';
import faces from '$lib/components/play2d/monsterCardFaces.json';
import { applyGameCommand, createLobbyState } from './runtime';
import { buildMonsterRewards, monsterGainFor } from './monsterRewards';
import { meaningFor } from './locationInteractions';
import { RELIC_TOOLS } from './effects/relicTools';
import { computePendingReward } from './viewV2';
import { drawMonsterViaCommands } from './testing/monsterCards';
import type { AttackDie, DiceTier, GameActor, GameCommand, PlayCatalog, PublicGameState } from './types';
import { MAX_ATTACK_DICE } from './types';

const VP4 = '8254dc80-329c-4fc8-872b-b0b765c7b888';
const BASIC_1 = '7d052532-89f1-44cf-8521-5a4f2aac5cd9';
const BASIC_2 = '6279ea72-c08c-4e1c-8358-94afab489ecd';
const ENCHANTED = '95e4a832-18d6-5ec3-8d57-2d90118050d6';
const EXALTED = 'e7f1c140-32bd-4603-8255-0be7a8ef34c4';
const ARCANE = '6d48e34b-e461-4deb-9cfd-662dd7127331';

const TRACK = [VP4, BASIC_1, BASIC_2, ENCHANTED, EXALTED, ARCANE];

// Named relic reward tokens (icon_pool id → relic mat id), as printed on Lava Maw, Hollow
// Treant, Quartz Golem and Bell Wraith.
const RELIC_TOKENS = [
	['Firecracker', '895144a1-e0f6-4bdc-a4db-322423f1b922', '8a0d54ca-aeab-405c-9e5c-1c1425d1aa86'],
	['Flower', '75134075-3347-49de-a740-eb99d20b1f1a', '690a7e3b-5737-4494-bb8a-b58bee13f473'],
	['Diamond', 'ca4df196-67fb-4507-973d-1dfac277953d', 'ee1486a0-8b61-499c-809b-b4de9920aa8f'],
	['Cleansing Teapot', 'c8ef5d48-2289-4fee-a34d-b041d3e8bea6', 'a6111d01-2c55-4b1f-854a-32887d92b8e1']
] as const;
const FIRECRACKER_TOKEN = RELIC_TOKENS[0][1];
const TEAPOT_TOKEN = RELIC_TOKENS[3][1];
const ANY_RELIC = '6a85e06a-52cc-483c-aa59-38395a377307';

const CATALOG: PlayCatalog = {
	// Current data: relics.json has no "gain N VP" clause (2026-11-13).
	relicToolVp: 0,
	guardians: [
		{ id: 'g-a', name: 'Red Guard', originId: 'o1' },
		{ id: 'g-b', name: 'Blue Guard', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack', sides: [1, 1, 2, 2, 3, 3] }],
	spirits: Array.from({ length: 40 }, (_, i) => ({
		id: `s-${i}`,
		name: `Spirit ${i}`,
		cost: i < 30 ? (i % 5) + 1 : 8,
		classes: { Fighter: 1 },
		origins: { Forest: 1 }
	})),
	// m-1 dies to the first strike; the apex card stays in its deck so the kill never ends the game.
	monsters: [
		{ id: 'm-1', name: 'Dice Imp', damage: 1, barrier: 1, rewardTrack: TRACK, dicePool: [], chooseAmount: 1, stage: 1, order: 0 },
		{ id: 'm-relic', name: 'Relic Imp', damage: 1, barrier: 1, rewardTrack: [VP4, FIRECRACKER_TOKEN, TEAPOT_TOKEN], dicePool: [], chooseAmount: 1, stage: 1, order: 0 },
		{ id: 'm-apex', name: 'Abyss Apex', damage: 9, barrier: 99, rewardTrack: [VP4], dicePool: [], chooseAmount: 1, stage: 3, order: 1 }
	],
	locations: []
};

const RED: GameActor = { memberId: 'm-red', displayName: 'Red', role: 'host', seatColor: 'Red' };
const BLUE: GameActor = { memberId: 'm-blue', displayName: 'Blue', role: 'player', seatColor: 'Blue' };

function apply(state: PublicGameState, actor: GameActor, command: GameCommand): PublicGameState {
	const result = applyGameCommand(state, actor, command, CATALOG);
	if (!result.ok) throw new Error(`${command.type} failed: ${result.error.message}`);
	return result.state;
}

const dice = (n: number, tier: DiceTier = 'arcane'): AttackDie[] =>
	Array.from({ length: n }, (_, i) => ({ instanceId: `d-${tier}-${i}`, tier }));

const tiers = (state: PublicGameState) => {
	const counts: Record<DiceTier, number> = { basic: 0, enchanted: 0, exalted: 0, arcane: 0 };
	for (const die of state.players.Red!.attackDice) counts[die.tier] += 1;
	return counts;
};

/** Red kills m-1 (or `catalogId`) at the Abyss; returns the state with the reward pending. */
function killDiceImp(startingDice: AttackDie[], catalogId = 'm-1'): PublicGameState {
	let s = createLobbyState({ roomCode: 'DICEIMP', guardianNames: ['Red Guard', 'Blue Guard'] });
	s = apply(s, RED, { type: 'claimSeat', seatColor: 'Red' });
	s = apply(s, BLUE, { type: 'claimSeat', seatColor: 'Blue' });
	s = apply(s, RED, { type: 'selectGuardian', guardianName: 'Red Guard' });
	s = apply(s, BLUE, { type: 'selectGuardian', guardianName: 'Blue Guard' });
	s = apply(s, RED, { type: 'startGame', seed: 7 });
	s = apply(s, RED, { type: 'lockNavigation', destination: 'Arcane Abyss' });
	s = apply(s, BLUE, { type: 'lockNavigation', destination: 'Arcane Abyss' });
	s = apply(s, RED, { type: 'forceAdvancePhase' });
	s = drawMonsterViaCommands(s, RED, CATALOG, { catalogId });
	s.players.Red!.attackDice = startingDice;
	s = apply(s, RED, { type: 'startCombat', handIndex: 0 });
	if (!s.players.Red?.pendingReward) throw new Error('expected a pending reward after the kill');
	return s;
}

describe('reward token meanings', () => {
	test('"4vp" is 4 Victory Points', () => {
		expect(monsterGainFor(VP4)).toEqual({ type: 'vp', amount: 4 });
		expect(buildMonsterRewards([VP4])[0].label).toBe('4 Victory Points');
	});

	test.each([
		['Basic Attack - Side 1', BASIC_1, 'basic'],
		['Basic Attack - Side 2', BASIC_2, 'basic'],
		['Enchanted Attack', ENCHANTED, 'enchanted'],
		['Exalted Attack - Side 1', EXALTED, 'exalted'],
		['Arcane Attack - Side 1', ARCANE, 'arcane']
	] as const)('"%s" is one %s attack die', (_name, token, tier) => {
		expect(monsterGainFor(token)).toEqual({ type: 'attackDice', tier, amount: 1 });
		expect(meaningFor(token)).toMatchObject({ kind: 'attackDice', tier, amount: 1 });
	});

	test('every reward printed on the 108 exported cards has an engine meaning', () => {
		const cards = Object.values((faces as { cards: Record<string, { name: string; rewards: string[] }> }).cards);
		expect(cards.length).toBe(108);
		for (const card of cards) {
			for (const token of card.rewards) {
				expect(monsterGainFor(token), `${card.name}: ${token}`).not.toBeNull();
			}
		}
	});
});

describe('claiming the new rewards (engine)', () => {
	test('a kill grants 4 VP and one die per die-face token, through the normal dice gain', () => {
		const s = killDiceImp(dice(2));
		const vpBefore = s.players.Red!.victoryPoints;
		const before = tiers(s);
		const after = apply(s, RED, { type: 'resolveMonsterReward', picks: [], choices: [] });
		expect(after.players.Red!.pendingReward).toBeNull();
		expect(after.players.Red!.victoryPoints).toBe(vpBefore + 4);
		const got = tiers(after);
		expect(got.basic - before.basic).toBe(2);
		expect(got.enchanted - before.enchanted).toBe(1);
		expect(got.exalted - before.exalted).toBe(1);
		expect(got.arcane - before.arcane).toBe(1);
		expect(after.players.Red!.lastAction?.log).toEqual(
			expect.arrayContaining(['Gained 4 Victory Points.', 'Gained 1 exalted attack dice.'])
		);
	});

	test('the dice cap applies: a full pool gains no dice, the VP still counts', () => {
		const s = killDiceImp(dice(MAX_ATTACK_DICE));
		const vpBefore = s.players.Red!.victoryPoints;
		const after = apply(s, RED, { type: 'resolveMonsterReward', picks: [], choices: [] });
		expect(after.players.Red!.attackDice).toHaveLength(MAX_ATTACK_DICE);
		expect(after.players.Red!.victoryPoints).toBe(vpBefore + 4);
		expect(after.players.Red!.lastAction?.log).toContain(
			`Attack-dice pool is already at the cap (${MAX_ATTACK_DICE}).`
		);
	});

	test('the pool fills up to the cap and stops there', () => {
		const s = killDiceImp(dice(MAX_ATTACK_DICE - 2));
		const after = apply(s, RED, { type: 'resolveMonsterReward', picks: [], choices: [] });
		expect(after.players.Red!.attackDice).toHaveLength(MAX_ATTACK_DICE);
	});

	test('a host force-advance auto-claims the dice too', () => {
		const s = killDiceImp(dice(2));
		const before = s.players.Red!.attackDice.length;
		const after = apply(s, RED, { type: 'forceAdvancePhase' });
		expect(after.players.Red!.pendingReward ?? null).toBeNull();
		expect(after.players.Red!.attackDice.length).toBe(before + 5);
	});

	test('the deck backs list attack dice and 4 VP', () => {
		const s = killDiceImp(dice(2));
		const deck1 = s.monsterDecks?.find((d) => d.difficulty === 1);
		expect(deck1?.vpValues).toContain(4);
		expect(deck1?.extraRewards).toContain('Attack Dice');
	});
});

describe('named relic tokens give the relic (owner rule, 2026-11-12)', () => {
	test.each(RELIC_TOKENS)('the %s token gives the %s relic, not a basic rune', (name, token, relicId) => {
		const gain = monsterGainFor(token);
		expect(gain).toMatchObject({ type: 'rune', rune: { runeId: relicId, type: 'relic', special: true } });
		expect(RELIC_TOOLS[relicId]?.name).toBe(name);
		expect(buildMonsterRewards([token])[0].label).toBe(`${name} relic`);
	});

	test('the four printed relic cards give their relic', () => {
		const cards = Object.values((faces as { cards: Record<string, { name: string; rewards: string[] }> }).cards);
		const relicCards = cards
			.map((card) => ({
				name: card.name,
				relics: buildMonsterRewards(card.rewards).flatMap((o) =>
					o.effect.type === 'rune' && RELIC_TOOLS[o.effect.rune.runeId] ? [RELIC_TOOLS[o.effect.rune.runeId].name] : []
				)
			}))
			.filter((c) => c.relics.length > 0)
			.sort((a, b) => a.name.localeCompare(b.name));
		expect(relicCards).toEqual([
			{ name: 'Bell Wraith', relics: ['Cleansing Teapot'] },
			{ name: 'Hollow Treant', relics: ['Flower'] },
			{ name: 'Lava Maw', relics: ['Firecracker'] },
			{ name: 'Quartz Golem', relics: ['Diamond'] }
		]);
	});

	const heldTools = (s: PublicGameState) =>
		s.players.Red!.mats.filter((m) => m.hasRune && m.relicTool).map((m) => m.name);

	test('a claimed kill puts the relics on the mat as relic tools', () => {
		const s = killDiceImp(dice(2), 'm-relic');
		const relicsBefore = s.players.Red!.relics ?? 0;
		const after = apply(s, RED, { type: 'resolveMonsterReward', picks: [], choices: [] });
		expect(heldTools(after)).toEqual(['Firecracker', 'Cleansing Teapot']);
		expect(after.players.Red!.relics).toBe(relicsBefore + 2);
		expect(after.players.Red!.mats.some((m) => m.hasRune && /Fire Rune|Water Rune/.test(m.name ?? ''))).toBe(false);
		expect(after.players.Red!.lastAction?.log).toEqual(
			expect.arrayContaining(['Gained Firecracker.', 'Gained Cleansing Teapot.'])
		);
	});

	test('the reward screen lists the relics by name', () => {
		const s = killDiceImp(dice(2), 'm-relic');
		const view = computePendingReward(s.players.Red!);
		expect(view?.options.map((o) => [o.label, o.effect])).toEqual([
			['4 Victory Points', 'vp'],
			['Firecracker relic', 'rune'],
			['Cleansing Teapot relic', 'rune']
		]);
	});

	test('a host force-advance auto-claims the relics the same way', () => {
		const s = killDiceImp(dice(2), 'm-relic');
		const after = apply(s, RED, { type: 'forceAdvancePhase' });
		expect(after.players.Red!.pendingReward ?? null).toBeNull();
		expect(heldTools(after)).toEqual(['Firecracker', 'Cleansing Teapot']);
	});

	test('a relic from a kill is offered as a keep / effect card (no VP side, 2026-11-13) after the Location step', () => {
		let s = killDiceImp(dice(2), 'm-relic');
		s = apply(s, RED, { type: 'resolveMonsterReward', picks: [], choices: [] });
		s = apply(s, RED, { type: 'endLocationActions' });
		s = apply(s, BLUE, { type: 'endLocationActions' });
		const cards = (s.players.Red!.pendingDecisions ?? []).filter((d) => d.kind === 'relicTool');
		const firecracker = cards.find((d) => d.prompt.startsWith('Firecracker'));
		expect(firecracker?.options.map((o) => o.label)).toEqual([
			'Keep Firecracker for later',
			'Strike first in your next combat, then discard Firecracker'
		]);
		expect(cards.some((d) => d.prompt.startsWith('Cleansing Teapot'))).toBe(true);
	});

	test('"Any relic" keeps its earlier behavior: a choice of the Fairy relic or a basic rune', () => {
		// No exported card prints this token; this pins today's mapping until a rule exists.
		const gain = monsterGainFor(ANY_RELIC);
		expect(gain?.type).toBe('chooseRune');
		const options = gain?.type === 'chooseRune' ? gain.options : [];
		expect(options.map((o) => `${o.name}:${o.type}`)).toEqual([
			'Fairy Relic:relic',
			'Water Rune:rune',
			'Fire Rune:rune',
			'Forest Rune:rune',
			'Mountain Rune:rune'
		]);
		const cards = Object.values((faces as { cards: Record<string, { rewards: string[] }> }).cards);
		expect(cards.some((card) => card.rewards.includes(ANY_RELIC))).toBe(false);
	});
});
