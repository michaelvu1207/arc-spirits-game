import { describe, expect, test } from 'vitest';
import { applyGameCommand, createLobbyState } from './runtime';
import { planBotPhaseActions, type BotRandom } from './server/botPolicy';
import { SPIRIT_WORLD_BAG, ARCANE_ABYSS_BAG } from './bags';
import { restBarrier } from './rules';
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
const WATER_ORIGIN = '294cee31-a7ac-4292-9b61-d4293c05c146';
const FOREST_ORIGIN = 'ad555f03-9b89-4a71-a47c-464fd67d2c05';

/**
 * The four regions have fixed actions (regionRules.ts), whatever rows the catalog gives them:
 *   Forest Region:   0 gain Rest;      1 trade Any Rune → a Power
 *   Water Region:    0 gain Summon;    1 trade Any Rune → Fighter / Cultivator / Beast augment
 *   Mountain Region: 0 trade Any Rune → replace a Power
 *   Fire Region:     0 gain Cultivate; 1 trade Any Rune → Cursed Spirit / Elementalist / Mystic augment
 * The Arcane Abyss takes its rows from the catalog: row 0 is its Arcane Abyss Summon action (as in
 * data/game_locations.json); row 1 is a test row that grants two summons, to test the draw queue.
 */
const ABYSS_ROWS: GameLocationRewardRow[] = [
	{ type: 'gain', gain_icon_ids: [ABYSS] },
	{ type: 'gain', gain_icon_ids: [SUMMON, ABYSS] }
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
	locations: [{ name: 'Arcane Abyss', originId: null, rewardRows: ABYSS_ROWS }]
};

/** One held Water Region rune, to pay an "Any Rune" trade. */
const waterRune = (slotIndex = 90) => ({ slotIndex, hasRune: true, originId: WATER_ORIGIN, name: 'Water Region Rune', type: 'rune' as const });

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
	// Every player gets a Power draft at the start of the game, and a pending draft blocks the
	// location interactions; these tests are about the interactions, so the drafts are put aside.
	for (const seat of s.activeSeats) s.players[seat]!.pendingPowerDrafts = [];
	return s;
}

describe('resolveLocationInteraction (engine)', () => {
	test('a free "gain" summon row opens a Spirit World draw', () => {
		let s = atLocation('Water Region');
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] });
		expect(s.players.Red?.pendingDraw).not.toBeNull();
		expect(s.players.Red?.pendingDraw?.summonLimit).toBe(2);
		expect(s.players.Red?.actionsUsedThisRound).toContain('row:0');
	});

	test('each row is once-per-round', () => {
		let s = atLocation('Forest Region');
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] }); // free Rest
		const again = applyGameCommand(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] }, CATALOG);
		expect(again.ok).toBe(false);
		if (!again.ok) expect(again.error.code).toBe('action_used');
	});

	test('Rest restores Barrier by status (4 at Pure) and needs no barrier reward icons', () => {
		let s = atLocation('Forest Region');
		expect(s.players.Red!.statusLevel ?? 0).toBe(0);
		s.players.Red!.barrier = Math.max(0, s.players.Red!.maxBarrier - 5);
		s.players.Red!.brokenBarrier = s.players.Red!.maxBarrier - s.players.Red!.barrier;
		const before = s.players.Red!.barrier;
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] });
		expect(s.players.Red!.barrier).toBe(before + restBarrier(0));
		expect(restBarrier(0)).toBe(4);
		expect(s.players.Red!.brokenBarrier).toBe(s.players.Red!.maxBarrier - s.players.Red!.barrier);
	});

	test('a trade rejects when the player cannot pay the cost', () => {
		const s = atLocation('Water Region');
		s.players.Red!.mats = []; // no rune to pay the "Any Rune" cost
		const res = applyGameCommand(s, RED, { type: 'resolveLocationInteraction', rowIndex: 1, choices: [0] }, CATALOG);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.code).toBe('cannot_afford');
	});

	test('a trade consumes the cost rune and grants the reward, without touching the Barrier', () => {
		let s = atLocation('Water Region');
		s.players.Red!.barrier = Math.max(0, s.players.Red!.maxBarrier - 3);
		s.players.Red!.brokenBarrier = s.players.Red!.maxBarrier - s.players.Red!.barrier;
		const beforeMax = s.players.Red!.maxBarrier;
		const beforeBarrier = s.players.Red!.barrier;
		s.players.Red!.mats = [waterRune()];
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 1, choices: [0] }); // Fighter augment
		expect(s.players.Red!.mats.filter((r) => r.originId === WATER_ORIGIN && r.hasRune)).toHaveLength(0);
		expect(s.players.Red!.unplacedAugments?.map((a) => a.name)).toEqual(['Fighter']);
		expect(s.players.Red!.maxBarrier).toBe(beforeMax);
		expect(s.players.Red!.barrier).toBe(beforeBarrier);
		expect(s.players.Red!.brokenBarrier).toBe(s.players.Red!.maxBarrier - s.players.Red!.barrier);
	});

	test('an "or" gain grants the chosen option', () => {
		let s = atLocation('Fire Region');
		s.players.Red!.mats = [waterRune()];
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 1, choices: [2] }); // pick Mystic
		// Mystic is a class rune ⇒ a spirit augment: it lands in the to-place pouch,
		// never a rune slot. The unchosen options are granted nowhere.
		expect(s.players.Red!.unplacedAugments?.map((a) => a.name)).toEqual(['Mystic']);
		expect(s.players.Red!.mats.some((r) => r.name === 'Mystic')).toBe(false);
		for (const other of ['Elementalist', 'Cursed Spirit'])
			expect(s.players.Red!.mats.some((r) => r.name === other)).toBe(false);
		expect(s.players.Red!.mats.filter((r) => r.hasRune)).toHaveLength(0);
	});

	test('Cultivate grants runes without restoring barriers', () => {
		let s = atLocation('Fire Region');
		// Three Forest Region spirits → one rune and no barrier restoration.
		s.players.Red!.barrier = Math.max(0, s.players.Red!.maxBarrier - 3);
		s.players.Red!.brokenBarrier = s.players.Red!.maxBarrier - s.players.Red!.barrier;
		const beforeBarrier = s.players.Red!.barrier;
		s.players.Red!.mats = [];
		s.players.Red!.spirits = [
			{ slotIndex: 1, id: 'x1', name: 'F A', cost: 1, classes: {}, origins: { 'Forest Region': 1 }, isFaceDown: false },
			{ slotIndex: 2, id: 'x2', name: 'F B', cost: 1, classes: {}, origins: { 'Forest Region': 1 }, isFaceDown: false },
			{ slotIndex: 3, id: 'x3', name: 'F C', cost: 1, classes: {}, origins: { 'Forest Region': 1 }, isFaceDown: false }
		];
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] });
		const forestRunes = s.players.Red!.mats.filter((r) => r.originId === FOREST_ORIGIN && r.hasRune);
		expect(forestRunes).toHaveLength(1);
		expect(s.players.Red!.barrier).toBe(beforeBarrier);
		expect(s.players.Red!.brokenBarrier).toBe(s.players.Red!.maxBarrier - s.players.Red!.barrier);
	});

	test('a row granting two summons queues the second draw', () => {
		let s = atLocation('Arcane Abyss');
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 1, choices: [] }); // Summon + Abyss
		expect(s.players.Red!.pendingDraw?.sourceBag).toBe(SPIRIT_WORLD_BAG); // Spirit World first
		expect(s.players.Red!.pendingDrawQueue).toHaveLength(1); // Abyss queued
		// Resolving the first draw auto-starts the queued Abyss draw.
		s = apply(s, RED, { type: 'discardHandDraws' });
		expect(s.players.Red!.pendingDraw?.sourceBag).toBe(ARCANE_ABYSS_BAG); // Abyss now active
		expect(s.players.Red!.pendingDrawQueue).toHaveLength(0);
	});

	test('interactions only resolve during the Location phase', () => {
		const s = createLobbyState({ roomCode: 'REWARD', guardianNames: ['Red Guard', 'Blue Guard'] });
		const res = applyGameCommand(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] }, CATALOG);
		expect(res.ok).toBe(false);
	});

	test('a row the location does not have is rejected', () => {
		const s = atLocation('Mountain Region');
		const res = applyGameCommand(s, RED, { type: 'resolveLocationInteraction', rowIndex: 1, choices: [] }, CATALOG);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.code).toBe('no_interaction');
	});
});

describe('summon draw-and-pick flow', () => {
	test('Spirit World Summon draws 4 and lets the player summon up to 2', () => {
		let s = atLocation('Water Region');
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

	test('Arcane Abyss Summon draws 4 (face-down) and lets the player summon up to 2', () => {
		let s = atLocation('Arcane Abyss');
		s.players.Red!.spirits = [];
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] });

		expect(s.players.Red!.pendingDraw).toMatchObject({ summonLimit: 2, summonedCount: 0 });
		expect(s.players.Red!.handDraws).toHaveLength(4);
		expect(s.players.Red!.handDraws.every((d) => d.sourceBag === ARCANE_ABYSS_BAG)).toBe(true);

		s = apply(s, RED, { type: 'spawnHandSpirit', guid: s.players.Red!.handDraws[0].guid });
		expect(s.players.Red!.pendingDraw?.summonedCount).toBe(1);
		s = apply(s, RED, { type: 'spawnHandSpirit', guid: s.players.Red!.handDraws[0].guid });
		expect(s.players.Red!.pendingDraw).toBeNull();
		expect(s.players.Red!.spirits).toHaveLength(2);
		expect(s.players.Red!.spirits.every((x) => x.isFaceDown)).toBe(true); // Abyss summons arrive face-down
	});
});

describe('draw-leak guards', () => {
	test('ending the phase is blocked while a reward draw is pending', () => {
		let s = atLocation('Water Region');
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] }); // free summon → pendingDraw
		expect(s.players.Red!.pendingDraw).not.toBeNull();
		const res = applyGameCommand(s, RED, { type: 'endLocationActions' }, CATALOG);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.code).toBe('draw_pending');
	});

	test('force-advancing returns an in-progress draw to its bag (no leak)', () => {
		let s = atLocation('Water Region');
		const bagBefore = s.bags.hexSpirits.contents.length;
		const rewardsBefore = s.bags.rewardHexes?.contents.length ?? 0;
		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] });
		// A tray of 4: a reward hex, while the reward bag has one, takes one of the places.
		expect(s.players.Red!.handDraws.length).toBe(4);
		const drawnSpirits = s.players.Red!.handDraws.filter((d) => !d.rewardId).length;
		const drawnRewards = 4 - drawnSpirits;
		expect(drawnRewards).toBe(rewardsBefore > 0 ? 1 : 0);
		expect(s.bags.hexSpirits.contents.length).toBe(bagBefore - drawnSpirits);
		expect(s.bags.rewardHexes?.contents.length ?? 0).toBe(rewardsBefore - drawnRewards);

		s = apply(s, RED, { type: 'forceAdvancePhase' }); // RED is the host actor
		expect(s.players.Red!.pendingDraw).toBeNull();
		expect(s.players.Red!.handDraws).toHaveLength(0);
		expect(s.players.Red!.pendingDrawQueue).toHaveLength(0);
		expect(s.bags.hexSpirits.contents.length).toBe(bagBefore); // returned — bag intact
		expect(s.bags.rewardHexes?.contents.length ?? 0).toBe(rewardsBefore);
	});

	test('force-advancing also drops a queued (un-started) summon without leaking', () => {
		let s = atLocation('Arcane Abyss');
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
		const s = atLocation('Water Region');
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
	test('Smith pays the trade cost and gains the selected augment plus 1 augment of the owner\'s choice', () => {
		let s = atLocation('Fire Region');
		s.players.Red!.spirits = [
			{ slotIndex: 1, id: 'mod', name: 'Mole', cost: 2, classes: { 'Smith': 1 }, origins: {}, isFaceDown: false }
		];
		s.players.Red!.mats = [waterRune(1)];

		s = apply(s, RED, { type: 'resolveLocationInteraction', rowIndex: 1, choices: [2] }); // pick Mystic augment

		expect(s.players.Red!.unplacedAugments?.map((a) => a.name)).toEqual(['Mystic', 'Spirit Augment']);
		expect(s.players.Red!.mats.filter((r) => r.hasRune).length).toBe(0);
		expect(s.players.Red!.lastAction?.log.some((l) => /Smith/i.test(l))).toBe(true);
	});

	test('the obsolete Undercover free-trade flag no longer waives a cost', () => {
		let s = atLocation('Water Region');
		s.players.Red!.freeNextRelicTrade = true;
		s.players.Red!.mats = [];
		const result = applyGameCommand(s, RED, { type: 'resolveLocationInteraction', rowIndex: 1, choices: [0] }, CATALOG);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('cannot_afford');
		expect(s.players.Red!.freeNextRelicTrade).toBe(true);
	});
});
