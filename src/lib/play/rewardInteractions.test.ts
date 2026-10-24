import { describe, expect, test } from 'vitest';
import { applyGameCommand, createLobbyState } from './runtime';
import { planBotPhaseActions, type BotRandom } from './server/botPolicy';
import { SPIRIT_WORLD_BAG, ARCANE_ABYSS_BAG } from './bags';
import type {
	GameActor,
	GameCommand,
	NavigationDestination,
	PlayCatalog,
	PublicGameState
} from './types';
import type { GameLocationRewardRow } from '$lib/types';

// Real reward-row icon ids (mirror the live DB content).
const SUMMON = '76e58219-e805-4b94-acf4-6d62dfe4c515';
const ABYSS = '12ff8ffe-20cb-4a86-a493-5e4ff8b9dc3e';
const REST = 'bdded3f5-e405-4b68-b63a-9f5c2139beea';
const CULTIVATE = '60e40dd5-c3cc-4f26-9aa3-2043b4106ade';
const AVATAR_BARRIER = '16daf8be-6ae0-4ace-b70c-cbb30e357664';
const ANY_RELIC = '6a85e06a-52cc-483c-aa59-38395a377307';
const TIDAL = '4d34484d-4345-448d-b192-a425841ddbc4';
const MOON_TIDE_ORIGIN = '294cee31-a7ac-4292-9b61-d4293c05c146';
const TEAPOT = 'c8ef5d48-2289-4fee-a34d-b041d3e8bea6';
const SORCERER = 'c9b3225f-c8a9-4aa8-8e43-56c39cf68974';
const STRATEGIST = '88facdb6-3374-4891-af8a-fca2e81b79ef';

const TIDAL_COVE_ROWS: GameLocationRewardRow[] = [
	{ type: 'gain', gain_icon_ids: [SUMMON] },
	{ type: 'trade', cost_icon_ids: [ANY_RELIC], gain_icon_ids: [SUMMON, ABYSS] },
	{ type: 'trade', cost_icon_ids: [TIDAL, TIDAL], gain_icon_ids: [TEAPOT] }
];
const CYBER_CITY_ROWS: GameLocationRewardRow[] = [
	{ type: 'trade', cost_icon_ids: [ANY_RELIC], gain_icon_ids: [{ kind: 'or', icon_ids: [SORCERER, STRATEGIST] }] },
	{ type: 'trade', cost_icon_ids: [ANY_RELIC], gain_icon_ids: [REST] },
	{ type: 'gain', gain_icon_ids: [REST] }
];
const LANTERN_CANYON_ROWS: GameLocationRewardRow[] = [{ type: 'gain', gain_icon_ids: [CULTIVATE] }];
const FLORAL_PATCH_ROWS: GameLocationRewardRow[] = [
	{ type: 'trade', cost_icon_ids: [ANY_RELIC], gain_icon_ids: [AVATAR_BARRIER] }
];

const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-a', name: 'Red Guard', originId: 'o1' },
		{ id: 'g-b', name: 'Blue Guard', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack', sides: [1, 1, 2, 2, 3, 3] }],
	// 30 Spirit World (cost 1-5) + 10 Arcane Abyss (cost 8) spirits.
	spirits: Array.from({ length: 40 }, (_, i) => ({
		id: `s-${i}`,
		name: `Spirit ${i}`,
		cost: i < 30 ? (i % 5) + 1 : 8,
		classes: { Fighter: 1 },
		origins: { Forest: 1 }
	})),
	monsters: [
		{ id: 'm-1', name: 'Abyss Maw', damage: 2, barrier: 6, rewardTrack: [], dicePool: [], chooseAmount: 2, stage: 1, order: 0 }
	],
	locations: [
		{ name: 'Tidal Cove', originId: null, rewardRows: TIDAL_COVE_ROWS },
		{ name: 'Cyber City', originId: 'fa7db249-d99d-4c1d-a37d-9027c9f5a31e', rewardRows: CYBER_CITY_ROWS },
		{ name: 'Lantern Canyon', originId: null, rewardRows: LANTERN_CANYON_ROWS },
		{ name: 'Floral Patch', originId: null, rewardRows: FLORAL_PATCH_ROWS }
	]
};

const RED: GameActor = { memberId: 'm-red', displayName: 'Red', role: 'host', seatColor: 'Red' };
const BLUE: GameActor = { memberId: 'm-blue', displayName: 'Blue', role: 'player', seatColor: 'Blue' };

function apply(state: PublicGameState, actor: GameActor, command: GameCommand): PublicGameState {
	const result = applyGameCommand(state, actor, command, CATALOG);
	if (!result.ok) throw new Error(`${command.type} failed: ${result.error.message}`);
	return result.state;
}

/** Drive a 2-player game to the Location phase with both seats at `dest`. */
function atLocation(dest: NavigationDestination): PublicGameState {
	let s = createLobbyState({ roomCode: 'REWARD', guardianNames: ['Red Guard', 'Blue Guard'] });
	s = apply(s, RED, { type: 'claimSeat', seatColor: 'Red' });
	s = apply(s, BLUE, { type: 'claimSeat', seatColor: 'Blue' });
	s = apply(s, RED, { type: 'selectGuardian', guardianName: 'Red Guard' });
	s = apply(s, BLUE, { type: 'selectGuardian', guardianName: 'Blue Guard' });
	s = apply(s, RED, { type: 'startGame', seed: 42 });
	s = apply(s, RED, { type: 'lockNavigation', destination: dest });
	s = apply(s, BLUE, { type: 'lockNavigation', destination: dest });
	// Locking no longer reveals instantly (a back-out grace was added); force-advance
	// past it (both seats already locked → just reveals their chosen destinations).
	s = apply(s, RED, { type: 'forceAdvancePhase' });
	if (s.phase !== 'location') throw new Error(`expected location phase, got ${s.phase}`);
	if (s.players.Red?.navigationDestination !== dest) throw new Error('Red not at the expected location');
	return s;
}

describe('resolveLocationInteraction (engine)', () => {
	test('a free "gain" summon row opens a Spirit World draw', () => {
		let s = atLocation('Tidal Cove');
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] });
		expect(s.players.Red?.pendingDraw).not.toBeNull();
		expect(s.players.Red?.pendingDraw?.summonLimit).toBe(2);
		expect(s.players.Red?.actionsUsedThisRound).toContain('row:0');
	});

	test('each row is once-per-round', () => {
		let s = atLocation('Cyber City');
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 2, choices: [] }); // free Rest
		const again = applyGameCommand(s, RED, { type: 'resolveLocationInteraction', rowIndex: 2, choices: [] }, CATALOG);
		expect(again.ok).toBe(false);
		if (!again.ok) expect(again.error.code).toBe('action_used');
	});

	test('Rest intrinsically restores exactly two barrier and needs no barrier reward icons', () => {
		let s = atLocation('Cyber City');
		s.players.Red!.barrier = Math.max(0, s.players.Red!.maxBarrier - 3);
		s.players.Red!.brokenBarrier = s.players.Red!.maxBarrier - s.players.Red!.barrier;
		const before = s.players.Red!.barrier;
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 2, choices: [] });
		expect(s.players.Red!.barrier).toBe(before + 2);
		expect(s.players.Red!.brokenBarrier).toBe(s.players.Red!.maxBarrier - s.players.Red!.barrier);
	});

	test('Floral Patch relic trade gains one max barrier without restoring current barrier', () => {
		let s = atLocation('Floral Patch');
		s.players.Red!.barrier = Math.max(0, s.players.Red!.maxBarrier - 2);
		s.players.Red!.brokenBarrier = s.players.Red!.maxBarrier - s.players.Red!.barrier;
		const beforeMax = s.players.Red!.maxBarrier;
		const beforeBarrier = s.players.Red!.barrier;
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] });
		expect(s.players.Red!.maxBarrier).toBe(beforeMax + 1);
		expect(s.players.Red!.barrier).toBe(beforeBarrier);
		expect(s.players.Red!.brokenBarrier).toBe(s.players.Red!.maxBarrier - beforeBarrier);
	});

	test('a trade rejects when the player cannot pay the cost', () => {
		const s = atLocation('Tidal Cove'); // Red holds only Fairy relics → no Moon Tide runes
		const res = applyGameCommand(s, RED, { type: 'resolveLocationInteraction', rowIndex: 2, choices: [] }, CATALOG);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.code).toBe('cannot_afford');
	});

	test('a trade consumes the cost runes and grants the reward', () => {
		let s = atLocation('Tidal Cove');
		// Take 3 damage first to prove the updated relic trade does not restore barrier.
		s.players.Red!.barrier = Math.max(0, s.players.Red!.maxBarrier - 3);
		s.players.Red!.brokenBarrier = s.players.Red!.maxBarrier - s.players.Red!.barrier;
		const beforeTokens = s.players.Red!.maxBarrier;
		const beforeBarrier = s.players.Red!.barrier;
		s.players.Red!.mats.push(
			{ slotIndex: 90, hasRune: true, originId: MOON_TIDE_ORIGIN, name: 'Moon Tide Rune', type: 'rune' },
			{ slotIndex: 91, hasRune: true, originId: MOON_TIDE_ORIGIN, name: 'Moon Tide Rune', type: 'rune' }
		);
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 2, choices: [] });

		// Both Moon Tide runes were spent.
		expect(s.players.Red!.mats.filter((r) => r.originId === MOON_TIDE_ORIGIN && r.hasRune)).toHaveLength(0);
		// Gained a Teapot relic (a rune slot), with no barrier reward.
		expect(s.players.Red!.mats.some((r) => r.name === 'Teapot' && r.hasRune && r.special)).toBe(true);
		expect(s.players.Red!.maxBarrier).toBe(beforeTokens);
		expect(s.players.Red!.barrier).toBe(beforeBarrier);
		expect(s.players.Red!.brokenBarrier).toBe(s.players.Red!.maxBarrier - s.players.Red!.barrier);
	});

	test('an "or" gain grants the chosen option', () => {
		let s = atLocation('Cyber City');
		s.players.Red!.mats.push({ slotIndex: 90, hasRune: true, special: true, type: 'relic', name: 'Spare Relic' });
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [1] }); // pick Soul Weaver
		// Soul Weaver is a class rune ⇒ a spirit augment: it lands in the to-place pouch,
		// never a rune slot. Elementalist (the unchosen option) is granted nowhere.
		expect(s.players.Red!.unplacedAugments?.some((a) => a.name === 'Soul Weaver')).toBe(true);
		expect(s.players.Red!.mats.some((r) => r.name === 'Soul Weaver')).toBe(false);
		expect(s.players.Red!.unplacedAugments?.some((a) => a.name === 'Elementalist')).toBe(false);
		expect(s.players.Red!.mats.some((r) => r.name === 'Elementalist')).toBe(false);
		// One relic was spent to pay the "any relic" cost. (Starting Fairy Relics qualify
		// too, so the greedy matcher may spend one of those before the spare relic — either
		// way exactly one of the three held relics is consumed.)
		expect(s.players.Red!.mats.filter((r) => r.hasRune).length).toBe(2);
	});

	test('Cultivate grants runes without restoring barriers', () => {
		let s = atLocation('Lantern Canyon');
		// Four Floral Patch spirits → two pairs → two runes and no barrier restoration.
		s.players.Red!.barrier = Math.max(0, s.players.Red!.maxBarrier - 3);
		s.players.Red!.brokenBarrier = s.players.Red!.maxBarrier - s.players.Red!.barrier;
		const beforeBarrier = s.players.Red!.barrier;
		s.players.Red!.spirits = [
			{ slotIndex: 1, id: 'x1', name: 'F A', cost: 1, classes: {}, origins: { 'Floral Patch': 1 }, isFaceDown: false },
			{ slotIndex: 2, id: 'x2', name: 'F B', cost: 1, classes: {}, origins: { 'Floral Patch': 1 }, isFaceDown: false },
			{ slotIndex: 3, id: 'x3', name: 'F C', cost: 1, classes: {}, origins: { 'Floral Patch': 1 }, isFaceDown: false },
			{ slotIndex: 4, id: 'x4', name: 'F D', cost: 1, classes: {}, origins: { 'Floral Patch': 1 }, isFaceDown: false }
		];
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] });
		const forestRunes = s.players.Red!.mats.filter((r) => r.name === 'Floral Patch Rune' && r.hasRune);
		expect(forestRunes).toHaveLength(2);
		expect(s.players.Red!.barrier).toBe(beforeBarrier);
		expect(s.players.Red!.brokenBarrier).toBe(s.players.Red!.maxBarrier - s.players.Red!.barrier);
	});

	test('a row granting two summons queues the second draw', () => {
		let s = atLocation('Tidal Cove');
		s.players.Red!.mats.push({ slotIndex: 90, hasRune: true, special: true, type: 'relic', name: 'Spare Relic' });
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 1, choices: [] }); // Summon + Abyss
		expect(s.players.Red!.pendingDraw?.summonLimit).toBe(2); // Spirit World first
		expect(s.players.Red!.pendingDrawQueue).toHaveLength(1); // Abyss queued
		// Resolving the first draw auto-starts the queued Abyss draw.
		s = apply(s, RED, { type: 'discardHandDraws' });
		expect(s.players.Red!.pendingDraw?.summonLimit).toBe(1); // Abyss now active
		expect(s.players.Red!.pendingDrawQueue).toHaveLength(0);
	});

	test('interactions only resolve during the Location phase', () => {
		const s = createLobbyState({ roomCode: 'REWARD', guardianNames: ['Red Guard', 'Blue Guard'] });
		const res = applyGameCommand(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] }, CATALOG);
		expect(res.ok).toBe(false);
	});

	test('reward interactions are blocked at the Arcane Abyss', () => {
		const s = atLocation('Arcane Abyss');
		const res = applyGameCommand(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] }, CATALOG);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.code).toBe('no_interaction');
	});
});

describe('summon draw-and-pick flow', () => {
	test('Spirit World Summon draws 4 and lets the player summon up to 2', () => {
		let s = atLocation('Tidal Cove');
		s.players.Red!.spirits = []; // clear opening spirits so all 7 slots are open
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] }); // free SW summon

		expect(s.players.Red!.handDraws).toHaveLength(4);
		expect(s.players.Red!.handDraws.every((d) => d.sourceBag === SPIRIT_WORLD_BAG)).toBe(true);
		expect(s.players.Red!.pendingDraw).toMatchObject({ summonLimit: 2, summonedCount: 0 });

		// Summon two of the four; after the second pick the draw auto-resolves.
		s = apply(s, RED, { type: 'spawnHandSpirit', guid: s.players.Red!.handDraws[0].guid });
		expect(s.players.Red!.pendingDraw?.summonedCount).toBe(1);
		s = apply(s, RED, { type: 'spawnHandSpirit', guid: s.players.Red!.handDraws[0].guid });

		expect(s.players.Red!.pendingDraw).toBeNull(); // limit reached → hand returned
		expect(s.players.Red!.handDraws).toHaveLength(0);
		expect(s.players.Red!.spirits).toHaveLength(2);
		// No third pick is possible — the draw is over.
		const third = applyGameCommand(s, RED, { type: 'spawnHandSpirit', guid: 'whatever' }, CATALOG);
		expect(third.ok).toBe(false);
	});

	test('Arcane Abyss Summon draws 3 (face-down) and lets the player summon up to 1', () => {
		let s = atLocation('Tidal Cove');
		s.players.Red!.spirits = [];
		s.players.Red!.mats.push({ slotIndex: 90, hasRune: true, special: true, type: 'relic', name: 'Spare Relic' });
		// Row 1 grants Spirit World Summon + a queued Arcane Abyss Summon.
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 1, choices: [] });
		// Clear the Spirit World draw so the queued Abyss draw auto-starts.
		s = apply(s, RED, { type: 'discardHandDraws' });

		expect(s.players.Red!.pendingDraw).toMatchObject({ summonLimit: 1, summonedCount: 0 });
		expect(s.players.Red!.handDraws).toHaveLength(3);
		expect(s.players.Red!.handDraws.every((d) => d.sourceBag === ARCANE_ABYSS_BAG)).toBe(true);

		s = apply(s, RED, { type: 'spawnHandSpirit', guid: s.players.Red!.handDraws[0].guid });
		expect(s.players.Red!.pendingDraw).toBeNull();
		expect(s.players.Red!.spirits).toHaveLength(1);
		expect(s.players.Red!.spirits[0].isFaceDown).toBe(true); // Abyss summons arrive face-down
	});
});

describe('draw-leak guards', () => {
	test('ending the phase is blocked while a reward draw is pending', () => {
		let s = atLocation('Tidal Cove');
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] }); // free summon → pendingDraw
		expect(s.players.Red!.pendingDraw).not.toBeNull();
		const res = applyGameCommand(s, RED, { type: 'endLocationActions' }, CATALOG);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.code).toBe('draw_pending');
	});

	test('force-advancing returns an in-progress draw to its bag (no leak)', () => {
		let s = atLocation('Tidal Cove');
		const bagBefore = s.bags.hexSpirits.contents.length;
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] });
		expect(s.bags.hexSpirits.contents.length).toBe(bagBefore - 4); // 4 drawn out
		expect(s.players.Red!.handDraws.length).toBe(4);

		s = apply(s, RED, { type: 'forceAdvancePhase' }); // RED is the host actor
		expect(s.players.Red!.pendingDraw).toBeNull();
		expect(s.players.Red!.handDraws).toHaveLength(0);
		expect(s.players.Red!.pendingDrawQueue).toHaveLength(0);
		expect(s.bags.hexSpirits.contents.length).toBe(bagBefore); // returned — bag intact
	});

	test('force-advancing also drops a queued (un-started) summon without leaking', () => {
		let s = atLocation('Tidal Cove');
		s.players.Red!.mats.push({ slotIndex: 90, hasRune: true, special: true, type: 'relic', name: 'Spare Relic' });
		const bagBefore = s.bags.hexSpirits.contents.length;
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 1, choices: [] }); // Summon + queued Abyss
		expect(s.players.Red!.pendingDrawQueue).toHaveLength(1);

		s = apply(s, RED, { type: 'forceAdvancePhase' });
		expect(s.players.Red!.pendingDraw).toBeNull();
		expect(s.players.Red!.pendingDrawQueue).toHaveLength(0);
		expect(s.bags.hexSpirits.contents.length).toBe(bagBefore); // the started Spirit World draw was returned
	});
});

describe('bots resolve location interactions', () => {
	const ALWAYS: BotRandom = { int: () => 0, chance: () => true };

	test('a bot resolves a free reward row and ends the phase with only legal commands', () => {
		const s = atLocation('Tidal Cove');
		const commands = planBotPhaseActions(s, 'Red', CATALOG, ALWAYS);

		// It chose the only affordable row (free summon) and finished the phase.
		expect(commands.some((c) => c.type === 'resolveLocationInteraction')).toBe(true);
		expect(commands.at(-1)).toEqual({ type: 'endLocationActions' });

		// Re-applying the plan in order is fully legal and leaves the seat ready.
		let working = s;
		for (const command of commands) {
			const result = applyGameCommand(working, { ...RED }, command, CATALOG);
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error(result.error.message);
			working = result.state;
		}
		expect(working.players.Red?.pendingDraw).toBeNull();
		expect(working.players.Red?.phaseReady).toBe(true);
	});
});

describe('updated trade class rules', () => {
	test('Runic Duplicator pays the trade cost and gains two copies of the selected augment', () => {
		let s = atLocation('Cyber City');
		s.players.Red!.spirits = [
			{ slotIndex: 1, id: 'mod', name: 'Mole', cost: 2, classes: { 'Runic Duplicator': 1 }, origins: {}, isFaceDown: false }
		];
		s.players.Red!.mats = [
			{ slotIndex: 1, hasRune: true, id: 'fairy', name: 'Fairy Relic', type: 'relic', special: true }
		];

		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [1] }); // pick Soul Weaver augment

		expect(s.players.Red!.unplacedAugments?.filter((a) => a.name === 'Soul Weaver')).toHaveLength(2);
		expect(s.players.Red!.mats.filter((r) => r.hasRune).length).toBe(0);
		expect(s.players.Red!.lastAction?.log.some((l) => /Runic Duplicator/i.test(l))).toBe(true);
	});

	test('the obsolete Undercover free-trade flag no longer waives a cost', () => {
		let s = atLocation('Tidal Cove');
		s.players.Red!.freeNextRelicTrade = true;
		s.players.Red!.mats = [];
		const result = applyGameCommand(s, RED, { type: 'resolveLocationInteraction', rowIndex: 2, choices: [] }, CATALOG);
		expect(result.ok).toBe(false);
		expect(s.players.Red!.freeNextRelicTrade).toBe(true);
	});
});
