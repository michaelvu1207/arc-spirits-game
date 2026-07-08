import { describe, expect, test } from 'vitest';
import {
	applyDeadlineAdvance,
	applyGameCommand,
	buildHistorySnapshotRows,
	buildSessionProjection,
	createLobbyState
} from './runtime';
import { deckCopiesForCost } from './bags';
import { enterBenefits } from './phases';
import { GENERIC_AUGMENT_RUNE_ID } from './effects/actions';
import type { GameActor, NavigationDestination, PlayCatalog, PublicGameState } from './types';
import type { GameLocationRewardRow } from '$lib/types';

// Reward-row icon ids (mirror the live DB content). A Spirit World location's available
// actions ARE its reward rows: the only way to summon is to resolve a row whose gain is a
// Summon action token. Tidal Cove offers a free Spirit World Summon; Cyber City a
// relic-paid Arcane Abyss Summon.
const SUMMON_ICON = '76e58219-e805-4b94-acf4-6d62dfe4c515';
const ABYSS_SUMMON_ICON = '12ff8ffe-20cb-4a86-a493-5e4ff8b9dc3e';
const ANY_RELIC_ICON = '6a85e06a-52cc-483c-aa59-38395a377307';
// Tidal Cove row 0: free Spirit World Summon (draw 4, summon 2).
const TIDAL_COVE_ROWS: GameLocationRewardRow[] = [{ type: 'gain', gain_icon_ids: [SUMMON_ICON] }];
// Cyber City row 0: Arcane Abyss Summon (draw 3, summon 1), paid with any relic.
const CYBER_CITY_ROWS: GameLocationRewardRow[] = [
	{ type: 'trade', cost_icon_ids: [ANY_RELIC_ICON], gain_icon_ids: [ABYSS_SUMMON_ICON] }
];

const HOST: GameActor = {
	memberId: 'member-host',
	displayName: 'Host Player',
	role: 'host',
	seatColor: null
};

const GUEST: GameActor = {
	memberId: 'member-guest',
	displayName: 'Guest Player',
	role: 'player',
	seatColor: null
};

const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-myrtle', name: 'Myrtle', originId: 'astral-zone' },
		{ id: 'g-nyra', name: 'Nyra', originId: 'arcane-abyss' }
	],
	mats: [
		{
			id: 'rune-forest',
			name: 'Forest Rune',
			kind: 'rune',
			originId: 'forest'
		},
		{
			id: 'augment-fighter',
			name: 'Fighter Augment',
			kind: 'augment',
			originId: null
		},
		{
			id: 'relic-sun',
			name: 'Sun Relic',
			kind: 'relic',
			originId: null
		}
	],
	classes: [],
	dice: [
		{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' },
		{ id: 'exalted_attack', name: 'Exalted Attack', diceType: 'attack' },
		{ id: 'arcane_attack', name: 'Arcane Attack', diceType: 'attack' },
		{ id: 'defense_dice', name: 'Defense Dice', diceType: 'defense' }
	],
	spirits: [
		{
			id: 'spirit-01',
			name: 'Hero Party',
			cost: 3,
			classes: { Bard: 1 },
			origins: { Carnival: 1 }
		},
		{
			id: 'spirit-02',
			name: 'Star Binder',
			cost: 2,
			classes: { Mage: 2 },
			origins: { Astral: 1 }
		},
		{
			id: 'spirit-03',
			name: 'Crimson Duelist',
			cost: 2,
			classes: { Fighter: 2 },
			origins: { Blood: 1 }
		},
		{
			id: 'spirit-04',
			name: 'Sun Herald',
			cost: 4,
			classes: { Cleric: 2 },
			origins: { Dawn: 1 }
		},
		{
			id: 'spirit-05',
			name: 'Abyss Watcher',
			cost: 5,
			classes: { Rogue: 2 },
			origins: { Abyss: 1 }
		},
		{
			id: 'spirit-06',
			name: 'Glass Oracle',
			cost: 1,
			classes: { Mage: 1 },
			origins: { Fate: 1 }
		},
		{
			id: 'spirit-07',
			name: 'Tide Warden',
			cost: 2,
			classes: { Guardian: 1 },
			origins: { Tide: 2 }
		},
		{
			id: 'spirit-08',
			name: 'Contessa',
			cost: 7,
			classes: { WorldEnder: 1 },
			origins: {}
		},
		{
			id: 'spirit-09',
			name: 'Hollow Eyes',
			cost: 8,
			classes: { Rogue: 1 },
			origins: {}
		},
		{
			id: 'spirit-10',
			name: 'Meteor Shower',
			cost: 9,
			classes: { Elementalist: 1 },
			origins: {}
		},
		{
			id: 'spirit-11',
			name: 'Lantern Dryad',
			cost: 3,
			classes: { Druid: 1 },
			origins: { Lantern: 1 }
		},
		{
			id: 'spirit-12',
			name: 'Signal Fox',
			cost: 2,
			classes: { Scout: 1 },
			origins: { Cyber: 1 }
		},
		{
			id: 'spirit-13',
			name: 'Pebble Sage',
			cost: 1,
			classes: { Sage: 1 },
			origins: { Earth: 1 }
		},
		{
			id: 'spirit-14',
			name: 'Moss Knight',
			cost: 4,
			classes: { Guardian: 1 },
			origins: { Forest: 1 }
		},
		{ id: 'spirit-15', name: 'Reef Singer', cost: 2, classes: { Bard: 1 }, origins: { Tide: 1 } },
		{ id: 'spirit-16', name: 'Cinder Imp', cost: 1, classes: { Rogue: 1 }, origins: { Ember: 1 } },
		{ id: 'spirit-17', name: 'Gale Dancer', cost: 3, classes: { Scout: 1 }, origins: { Wind: 1 } },
		{ id: 'spirit-18', name: 'Loam Tender', cost: 2, classes: { Druid: 1 }, origins: { Forest: 1 } },
		{ id: 'spirit-19', name: 'Spark Wisp', cost: 1, classes: { Mage: 1 }, origins: { Cyber: 1 } },
		{ id: 'spirit-20', name: 'Dawn Piper', cost: 3, classes: { Cleric: 1 }, origins: { Dawn: 1 } },
		{ id: 'spirit-21', name: 'Coral Scout', cost: 2, classes: { Scout: 1 }, origins: { Tide: 1 } },
		{ id: 'spirit-22', name: 'Fen Warden', cost: 4, classes: { Guardian: 1 }, origins: { Forest: 1 } },
		{ id: 'spirit-23', name: 'Mote Keeper', cost: 1, classes: { Sage: 1 }, origins: { Fate: 1 } },
		{ id: 'spirit-24', name: 'Lumen Fox', cost: 2, classes: { Scout: 1 }, origins: { Lantern: 1 } }
	],
	locations: [
		{ name: 'Tidal Cove', originId: null, rewardRows: TIDAL_COVE_ROWS },
		{ name: 'Cyber City', originId: null, rewardRows: CYBER_CITY_ROWS }
	]
};

// Spirit World bag size = the per-cost deck multiplier summed over cost 1–5
// spirits. After startGame, opening hands (4 × 2 seats) + 6 market slots are dealt
// out, leaving the rest in the bag. Derived from deckCopiesForCost so an edition
// tweak to the copy-counts can't silently rot these assertions.
const SW_BAG_TOTAL = CATALOG.spirits
	.filter((s) => s.cost >= 1 && s.cost <= 5)
	.reduce((n, s) => n + deckCopiesForCost(s.cost), 0);
const SW_BAG_AFTER_START = SW_BAG_TOTAL - 8 - 6;

function withLobbySelections(): PublicGameState {
	let state = createLobbyState({
		roomCode: 'ROOM42',
		guardianNames: CATALOG.guardians.map((guardian) => guardian.name)
	});

	const redClaim = applyGameCommand(state, HOST, { type: 'claimSeat', seatColor: 'Red' }, CATALOG);
	if (!redClaim.ok) throw new Error(redClaim.error.message);
	state = redClaim.state;

	const blueClaim = applyGameCommand(state, GUEST, { type: 'claimSeat', seatColor: 'Blue' }, CATALOG);
	if (!blueClaim.ok) throw new Error(blueClaim.error.message);
	state = blueClaim.state;

	const redGuardian = applyGameCommand(
		state,
		{ ...HOST, seatColor: 'Red' },
		{ type: 'selectGuardian', guardianName: 'Myrtle' },
		CATALOG
	);
	if (!redGuardian.ok) throw new Error(redGuardian.error.message);
	state = redGuardian.state;

	const blueGuardian = applyGameCommand(
		state,
		{ ...GUEST, seatColor: 'Blue' },
		{ type: 'selectGuardian', guardianName: 'Nyra' },
		CATALOG
	);
	if (!blueGuardian.ok) throw new Error(blueGuardian.error.message);
	return blueGuardian.state;
}

/**
 * Drive an already-started game (navigation phase) into the Location phase with RED
 * standing at `dest`. Both seats lock onto the same Good location, so the encounter
 * phase auto-skips straight to Location. `dest` defaults to Tidal Cove (free Spirit
 * World Summon at row 0); pass 'Cyber City' for the relic-paid Arcane Abyss Summon.
 */
function locationPhase(
	started: PublicGameState,
	dest: NavigationDestination = 'Tidal Cove'
): PublicGameState {
	let state = started;
	for (const actor of [
		{ ...HOST, seatColor: 'Red' as const },
		{ ...GUEST, seatColor: 'Blue' as const }
	]) {
		const locked = applyGameCommand(state, actor, { type: 'lockNavigation', destination: dest }, CATALOG);
		if (!locked.ok) throw new Error(locked.error.message);
		state = locked.state;
	}
	// Locking no longer reveals instantly; force-advance past the grace to reveal
	// (both seats already locked) → encounter auto-skips → location phase.
	const advanced = applyGameCommand(
		state,
		{ ...HOST, seatColor: 'Red' },
		{ type: 'forceAdvancePhase' },
		CATALOG
	);
	if (!advanced.ok) throw new Error(advanced.error.message);
	if (advanced.state.phase !== 'location') {
		throw new Error(`expected location phase, got ${advanced.state.phase}`);
	}
	return advanced.state;
}

describe('play runtime', () => {
	test('rejects claiming an occupied seat', () => {
		const initial = createLobbyState({
			roomCode: 'ROOM42',
			guardianNames: CATALOG.guardians.map((guardian) => guardian.name)
		});

		const firstClaim = applyGameCommand(initial, HOST, { type: 'claimSeat', seatColor: 'Red' }, CATALOG);
		expect(firstClaim.ok).toBe(true);
		if (!firstClaim.ok) return;

		const secondClaim = applyGameCommand(
			firstClaim.state,
			GUEST,
			{ type: 'claimSeat', seatColor: 'Red' },
			CATALOG
		);

		expect(secondClaim.ok).toBe(false);
		if (secondClaim.ok) return;
		expect(secondClaim.error.code).toBe('seat_taken');
	});

	test('discardUnplacedAugments clears the pouch so placement can never soft-lock', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		// A player granted more augments than they have host spirits for (all spirits full).
		started.state.players.Red!.unplacedAugments = [
			{ runeId: 'a', name: 'Spirit Augment' },
			{ runeId: 'b', name: 'Spirit Augment' }
		];
		const done = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'discardUnplacedAugments' },
			CATALOG
		);
		expect(done.ok).toBe(true);
		if (!done.ok) return;
		expect(done.state.players.Red?.unplacedAugments ?? []).toEqual([]);
	});

	test('starts a game with initialized players and seeded market slots', () => {
		const lobby = withLobbySelections();

		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);

		expect(started.ok).toBe(true);
		if (!started.ok) return;

		expect(started.state.status).toBe('active');
		expect(started.state.gameId).toMatch(/^game_/);
		expect(started.state.round).toBe(1);

		// The Spirit World bag is SHUFFLED at startGame (TTS shuffle = true), so the
		// market is no longer dealt in catalog/alphabetical order. The Spirit World
		// pool (cost 1–5) is seeded by the per-cost deck multiplier (Complete edition),
		// and Arcane Abyss (cost 7–9) one copy each. Opening hands take 4 × 2 = 8 and
		// the market 6, leaving SW_BAG_AFTER_START in the world bag.
		const worldIds = CATALOG.spirits.filter((s) => s.cost >= 1 && s.cost <= 5).map((s) => s.id);
		const abyssIds = CATALOG.spirits.filter((s) => s.cost >= 7 && s.cost <= 9).map((s) => s.id);
		expect(worldIds).toHaveLength(21);
		expect(abyssIds).toHaveLength(3);

		const marketIds = started.state.market.map((slot) => slot.spiritId);
		expect(marketIds).toHaveLength(6);
		// Every market slot is filled with a Spirit World (cost 1–5) spirit…
		expect(marketIds.every((id) => id !== null && worldIds.includes(id))).toBe(true);
		// …and the order is NOT the catalog/alphabetical order (proves the shuffle).
		expect(marketIds).not.toEqual(['spirit-12', 'spirit-13', 'spirit-14', 'spirit-15', 'spirit-16', 'spirit-17']);
		expect(started.state.bags.hexSpirits.count).toBe(SW_BAG_AFTER_START);
		expect(started.state.bags.abyssFallen.count).toBe(3);
		const redPlayer = started.state.players.Red;
		const bluePlayer = started.state.players.Blue;
		expect(redPlayer).toBeDefined();
		expect(bluePlayer).toBeDefined();
		if (!redPlayer || !bluePlayer) return;
		expect(redPlayer.selectedGuardian).toBe('Myrtle');
		expect(redPlayer.barrier).toBe(4);
		expect(bluePlayer.selectedGuardian).toBe('Nyra');
		// Opening hand: four awakened Spirit World spirits each, drawn off the shuffled
		// bag (order/identity now seed-driven, so assert membership + invariants, not
		// the old alphabetical ids).
		expect(redPlayer.spirits).toHaveLength(4);
		expect(redPlayer.spirits.every((s) => worldIds.includes(s.id))).toBe(true);
		expect(redPlayer.spirits.every((s) => !s.isFaceDown)).toBe(true);
		expect(bluePlayer.spirits).toHaveLength(4);
		expect(bluePlayer.spirits.every((s) => worldIds.includes(s.id))).toBe(true);
		// Conservation: every Spirit World copy is accounted for across the two opening
		// hands + market + bag. With the TTS deck multiplier each cost 1–5 spirit is
		// seeded twice, so the total is 21 × 2 = 42 and every spirit appears exactly
		// deckCopiesForCost(cost) times.
		const dealtWorld = [
			...redPlayer.spirits.map((s) => s.id),
			...bluePlayer.spirits.map((s) => s.id),
			...marketIds.filter((id): id is string => id !== null),
			...started.state.bags.hexSpirits.contents.map((e) => e.id!)
		];
		const worldCopies = CATALOG.spirits
			.filter((s) => s.cost >= 1 && s.cost <= 5)
			.reduce((sum, s) => sum + deckCopiesForCost(s.cost), 0);
		expect(dealtWorld).toHaveLength(worldCopies);
		expect(new Set(dealtWorld)).toEqual(new Set(worldIds));
		for (const spirit of CATALOG.spirits) {
			if (spirit.cost < 1 || spirit.cost > 5) continue;
			expect(dealtWorld.filter((id) => id === spirit.id)).toHaveLength(deckCopiesForCost(spirit.cost));
		}
	});

	test('spawns synced dice on the player mat and allows moving them', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);

		const spawned = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'spawnDiceBatch', diceId: 'basic_attack', count: 2 },
			CATALOG
		);

		expect(spawned.ok).toBe(true);
		if (!spawned.ok) return;

		const dice = spawned.state.players.Red?.spawnedDice ?? [];
		expect(dice).toHaveLength(2);
			expect(dice[0]).toMatchObject({
				diceId: 'basic_attack',
				name: 'Basic Attack',
				diceType: 'attack',
				faceIndex: expect.any(Number),
				rollRotation: {
					x: expect.any(Number),
					y: expect.any(Number),
					z: expect.any(Number)
				}
			});

		const moved = applyGameCommand(
			spawned.state,
			{ ...HOST, seatColor: 'Red' },
			{
				type: 'moveMatObject',
				objectType: 'die',
				instanceId: dice[0]!.instanceId,
				localX: -0.25,
				localZ: 0.55
			},
			CATALOG
		);

		expect(moved.ok).toBe(true);
		if (!moved.ok) return;
			expect(moved.state.players.Red?.spawnedDice[0]).toMatchObject({
				localX: -0.25,
				localZ: 0.55
			});
		});

		test('rolls all spawned dice for the active player', () => {
			const lobby = withLobbySelections();
			const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
			if (!started.ok) throw new Error(started.error.message);

			const spawned = applyGameCommand(
				started.state,
				{ ...HOST, seatColor: 'Red' },
				{ type: 'spawnDiceBatch', diceId: 'basic_attack', count: 2 },
				CATALOG
			);
			if (!spawned.ok) throw new Error(spawned.error.message);

			const before = spawned.state.players.Red?.spawnedDice.map((die) => ({
				faceIndex: die.faceIndex,
				rollRotation: die.rollRotation
			}));
			const rolled = applyGameCommand(
				spawned.state,
				{ ...HOST, seatColor: 'Red' },
				{ type: 'rollSpawnedDice' },
				CATALOG
			);

			expect(rolled.ok).toBe(true);
			if (!rolled.ok) return;
			const dice = rolled.state.players.Red?.spawnedDice ?? [];
			expect(dice).toHaveLength(2);
			expect(dice.every((die) => die.faceIndex >= 0 && die.faceIndex < 6)).toBe(true);
			expect(dice.map((die) => ({ faceIndex: die.faceIndex, rollRotation: die.rollRotation }))).not.toEqual(before);
		});

		test('spawns rune, augment, and relic props on the player mat', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);

		let state = started.state;
		for (const runeId of ['rune-forest', 'augment-fighter', 'relic-sun'] as const) {
			const next = applyGameCommand(
				state,
				{ ...HOST, seatColor: 'Red' },
				{ type: 'spawnMatItem', runeId },
				CATALOG
			);
			if (!next.ok) throw new Error(next.error.message);
			state = next.state;
		}

		const items = state.players.Red?.spawnedItems ?? [];
		expect(items).toHaveLength(3);
		expect(items.map((item) => item.kind)).toEqual(['rune', 'augment', 'relic']);
	});

	// ── Rules v1.1 regression: the market family is not a player action, and a
	// destination can never be (re)set outside the pre-reveal Navigation phase.
	// These pin the location-commitment rule: bots exploited the ungated market
	// to build whole boards for free while locked to the Abyss (docs/rules-v1.1.md).
	test('rules v1.1: takeSpirit / replaceSpirit / refillMarket are rejected for players', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		// The market is still stocked at startGame (display only) — a filled slot
		// must NOT make the command acceptable.
		expect(started.state.market[0].spiritId).not.toBeNull();

		const commands = [
			{ type: 'takeSpirit', marketIndex: 0 },
			{ type: 'replaceSpirit', marketIndex: 0, slotIndex: 1 },
			{ type: 'refillMarket' }
		] as const;
		for (const command of commands) {
			const r = applyGameCommand(started.state, { ...HOST, seatColor: 'Red' }, command, CATALOG);
			expect(r.ok).toBe(false);
			if (r.ok) throw new Error(`${command.type} unexpectedly accepted`);
			expect(r.error.code).toBe('unsupported_command');
		}
		// Player state is untouched by the rejected commands.
		expect(started.state.players.Red!.spirits).toHaveLength(4);
	});

	test('rules v1.1: selectNavigationDestination is gated to the pre-reveal Navigation phase', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);

		// Navigation phase, pre-reveal: still accepted (legacy destination set).
		const inNav = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'selectNavigationDestination', destination: 'Tidal Cove' },
			CATALOG
		);
		expect(inNav.ok).toBe(true);

		// Location phase (destinations revealed): switching destinations mid-round
		// would break the one-location-per-round commitment — rejected.
		const located = locationPhase(started.state, 'Tidal Cove');
		const midRound = applyGameCommand(
			located,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'selectNavigationDestination', destination: 'Floral Patch' },
			CATALOG
		);
		expect(midRound.ok).toBe(false);
		if (midRound.ok) return;
		expect(midRound.error.code).toBe('wrong_phase');
		expect(located.players.Red!.navigationDestination).toBe('Tidal Cove');
	});

	test('draws four spirit world spirits into the private tray and tracks picks remaining', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		// Tidal Cove's row 0 is a free Spirit World Summon (draw 4, summon up to 2).
		const located = locationPhase(started.state, 'Tidal Cove');

		const drawn = applyGameCommand(
			located,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'resolveLocationInteraction', rowIndex: 0, choices: [] },
			CATALOG
		);

		expect(drawn.ok).toBe(true);
		if (!drawn.ok) return;

		const redPlayer = drawn.state.players.Red;
		expect(redPlayer).toBeDefined();
		if (!redPlayer) return;
		expect(redPlayer.handDraws).toHaveLength(4);
		expect(redPlayer.pendingDraw).toMatchObject({
			sourceBag: 'Spirit World Bag',
			drawCount: 4,
			summonLimit: 2,
			summonedCount: 0
		});
		expect(drawn.state.bags.hexSpirits.count).toBe(SW_BAG_AFTER_START - 4);
	});

	test('spawns a chosen spirit world draw face-up and returns leftovers after the second summon', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		// Tidal Cove's row 0 is a free Spirit World Summon (draw 4, summon up to 2).
		const located = locationPhase(started.state, 'Tidal Cove');

		const drawn = applyGameCommand(
			located,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'resolveLocationInteraction', rowIndex: 0, choices: [] },
			CATALOG
		);
		if (!drawn.ok) throw new Error(drawn.error.message);

		const firstGuid = drawn.state.players.Red?.handDraws[0]?.guid;
		const secondGuid = drawn.state.players.Red?.handDraws[1]?.guid;
		if (!firstGuid || !secondGuid) throw new Error('Expected spirit world tray entries.');

		const firstSpawn = applyGameCommand(
			drawn.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'spawnHandSpirit', guid: firstGuid },
			CATALOG
		);
		if (!firstSpawn.ok) throw new Error(firstSpawn.error.message);

		const secondSpawn = applyGameCommand(
			firstSpawn.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'spawnHandSpirit', guid: secondGuid },
			CATALOG
		);

		expect(secondSpawn.ok).toBe(true);
		if (!secondSpawn.ok) return;

		const redPlayer = secondSpawn.state.players.Red;
		expect(redPlayer).toBeDefined();
		if (!redPlayer) return;
		// Four opening spirits + the two summoned here = six, all awakened.
		expect(redPlayer.spirits).toHaveLength(6);
		expect(redPlayer.spirits.every((s) => !s.isFaceDown)).toBe(true);
		expect(redPlayer.handDraws).toEqual([]);
		expect(redPlayer.pendingDraw).toBeNull();
		expect(secondSpawn.state.bags.hexSpirits.count).toBe(SW_BAG_AFTER_START - 2);
	});

	test('draws arcane abyss spirits face-down and flips them on command', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		// Cyber City's row 0 is an Arcane Abyss Summon (draw 3, summon 1), paid with a
		// relic — the starting Fairy relic covers it.
		const located = locationPhase(started.state, 'Cyber City');

		const drawn = applyGameCommand(
			located,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'resolveLocationInteraction', rowIndex: 0, choices: [] },
			CATALOG
		);
		if (!drawn.ok) throw new Error(drawn.error.message);

		const guid = drawn.state.players.Red?.handDraws[0]?.guid;
		if (!guid) throw new Error('Expected arcane abyss tray entries.');

		const spawned = applyGameCommand(
			drawn.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'spawnHandSpirit', guid },
			CATALOG
		);
		if (!spawned.ok) throw new Error(spawned.error.message);

		const redPlayer = spawned.state.players.Red;
		expect(redPlayer).toBeDefined();
		if (!redPlayer) return;
		// The abyss spirit lands face-down in slot 5 (after the four opening spirits).
		expect(redPlayer.spirits[4]?.isFaceDown).toBe(true);
		expect(redPlayer.handDraws).toEqual([]);
		expect(redPlayer.pendingDraw).toBeNull();
		expect(spawned.state.bags.abyssFallen.count).toBe(2);

		const flipped = applyGameCommand(
			spawned.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'flipSpirit', slotIndex: 5 },
			CATALOG
		);

		expect(flipped.ok).toBe(true);
		if (!flipped.ok) return;
		expect(flipped.state.players.Red?.spirits[4]?.isFaceDown).toBe(false);
	});

	test('returns unchosen tray spirits to their source bag', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		// Cyber City's row 0 is an Arcane Abyss Summon (draw 3, summon 1), paid with the
		// starting Fairy relic.
		const located = locationPhase(started.state, 'Cyber City');

		const drawn = applyGameCommand(
			located,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'resolveLocationInteraction', rowIndex: 0, choices: [] },
			CATALOG
		);
		if (!drawn.ok) throw new Error(drawn.error.message);

		const discarded = applyGameCommand(
			drawn.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'discardHandDraws' },
			CATALOG
		);

		expect(discarded.ok).toBe(true);
		if (!discarded.ok) return;

		const redPlayer = discarded.state.players.Red;
		expect(redPlayer).toBeDefined();
		if (!redPlayer) return;
		expect(redPlayer.handDraws).toEqual([]);
		expect(redPlayer.pendingDraw).toBeNull();
		expect(discarded.state.bags.abyssFallen.count).toBe(3);
	});

	test('projection exposes bag spirits grouped by id (Spirit World doubled, sorted by cost)', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);

		const projection = buildSessionProjection(started.state, {
			role: 'player',
			seatColor: 'Red',
			displayName: 'Host Player'
		});

		const sw = projection.bagSpirits.spiritWorld;
		const aa = projection.bagSpirits.arcaneAbyss;
		expect(sw.length).toBeGreaterThan(0);
		// Spirit World entries are cost 1–5; Arcane Abyss are cost 7–9, one copy each.
		expect(sw.every((e) => e.cost >= 1 && e.cost <= 5)).toBe(true);
		expect(aa.every((e) => e.cost >= 7 && e.cost <= 9 && e.count === 1)).toBe(true);
		// Grouped & sorted by cost ascending, and never more copies than the multiplier.
		const costs = sw.map((e) => e.cost);
		expect([...costs].sort((a, b) => a - b)).toEqual(costs);
		for (const e of sw) expect(e.count).toBeLessThanOrEqual(deckCopiesForCost(e.cost));
	});

	test('discardSpirit returns a Spirit World spirit to its bag and frees the slot', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);

		const victim = started.state.players.Red!.spirits[0]; // opening (cost 1–5, face-up) spirit
		expect(victim).toBeDefined();
		const swBefore = started.state.bags.hexSpirits.count;

		const res = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'discardSpirit', slotIndex: victim.slotIndex },
			CATALOG
		);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error(res.error.message);

		// Slot freed + spirit gone from the tableau.
		expect(res.state.players.Red!.spirits.some((s) => s.slotIndex === victim.slotIndex)).toBe(false);
		// Returned to the Spirit World bag.
		expect(res.state.bags.hexSpirits.count).toBe(swBefore + 1);
		expect(res.state.bags.hexSpirits.contents.some((e) => e.id === victim.id)).toBe(true);
	});

	test('discardSpirit sends an Arcane Abyss spirit back to the Abyss bag', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		started.state.players.Red!.spirits.push({
			slotIndex: 6,
			id: 'abyssal-test',
			name: 'Abyssal',
			cost: 8,
			classes: {},
			origins: {},
			isFaceDown: true
		});
		const aaBefore = started.state.bags.abyssFallen.count;

		const res = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'discardSpirit', slotIndex: 6 },
			CATALOG
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.state.bags.abyssFallen.count).toBe(aaBefore + 1);
		expect(res.state.players.Red!.spirits.some((s) => s.slotIndex === 6)).toBe(false);
	});

	test('discardSpirit rejects an empty slot', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const res = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'discardSpirit', slotIndex: 7 },
			CATALOG
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.code).toBe('spirit_missing');
	});

	test('discardSpirit pays down a corruption-discard obligation, clearing it at 0', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const red = started.state.players.Red!;
		// Owe two forced discards (the heal already happened instantly in takeDamage).
		// We have at least the two opening spirits to pay with.
		red.pendingCorruptionDiscard = { count: 2, reason: 'corruption' };
		const slot1 = red.spirits[0]!.slotIndex;

		const first = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'discardSpirit', slotIndex: slot1 },
			CATALOG
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		// Decremented, still outstanding.
		expect(first.state.players.Red!.pendingCorruptionDiscard).toEqual({
			count: 1,
			reason: 'corruption'
		});

		const slot2 = first.state.players.Red!.spirits[0]!.slotIndex;
		const second = applyGameCommand(
			first.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'discardSpirit', slotIndex: slot2 },
			CATALOG
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		// Owed count hits 0 → obligation cleared.
		expect(second.state.players.Red!.pendingCorruptionDiscard).toBeNull();
	});

	test('discardSpirit clears the obligation the moment the last owed discard is paid', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const red = started.state.players.Red!;
		// Owe a single discard — the one pay-down clears it (no separate heal gate any more).
		red.pendingCorruptionDiscard = { count: 1, reason: 'corruption' };
		const slot1 = red.spirits[0]!.slotIndex;
		const res = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'discardSpirit', slotIndex: slot1 },
			CATALOG
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// Count reaches 0 → obligation is gone, so the round can advance.
		expect(res.state.players.Red!.pendingCorruptionDiscard).toBeNull();
	});

	test('discardSpirit leaves no obligation untouched when none is owed', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const slot = started.state.players.Red!.spirits[0]!.slotIndex;
		const res = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'discardSpirit', slotIndex: slot },
			CATALOG
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.state.players.Red!.pendingCorruptionDiscard ?? null).toBeNull();
	});

	test('endLocationActions is blocked until the owed corruption discard is paid', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const state = started.state;
		// Drop straight into the Location phase owing a corruption discard. Corruption forces
		// its spirit sacrifice IMMEDIATELY — you can't end your location turn until it's paid.
		state.phase = 'location';
		state.players.Red!.pendingCorruptionDiscard = { count: 1, reason: 'corruption' };

		const blocked = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'endLocationActions' },
			CATALOG
		);
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.error.code).toBe('corruption_pending');
	});

	test('commitCleanup is blocked until the owed corruption discard is paid, then succeeds', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const state = started.state;
		state.phase = 'cleanup';
		const red = state.players.Red!;
		// Corruption already healed the player instantly in takeDamage; the remaining cost is the
		// owed spirit discard, which blocks cleanup until paid. Owe one and pay it with a spirit.
		red.maxBarrier = 4;
		red.barrier = 4; // already healed to full when corruption landed
		red.brokenBarrier = 0;
		red.pendingCorruptionDiscard = { count: 1, reason: 'corruption' };

		const blocked = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'commitCleanup' },
			CATALOG
		);
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.error.code).toBe('corruption_pending');

		// Pay down the owed discard with a spirit → obligation clears, then commit succeeds.
		const slot = red.spirits[0]!.slotIndex;
		const paid = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'discardSpirit', slotIndex: slot },
			CATALOG
		);
		if (!paid.ok) throw new Error(paid.error.message);
		expect(paid.state.players.Red!.pendingCorruptionDiscard).toBeNull();
		// Paying the debt was the seat's last piece of cleanup work — the engine
		// auto-readies it, and with every other seat workless the round rolls over
		// immediately (no explicit commitCleanup needed anymore).
		expect(paid.state.phase).toBe('navigation');
		expect(paid.state.round).toBe(2);
	});

	test('commitCleanup settles an UNPAYABLE corruption debt as VP loss instead of freezing the seat', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const state = started.state;
		state.phase = 'cleanup';
		const red = state.players.Red!;
		// The 2026-07-02 playtest freeze: spirits removed AFTER the debt was set (Golden
		// Ruler evil-discard etc.) leave a debt with nothing to pay it — no legal discard,
		// commit blocked, seat frozen. The debt must settle as -1 VP each on commit.
		red.spirits = [];
		red.victoryPoints = 5;
		red.pendingCorruptionDiscard = { count: 2, reason: 'corruption' };

		const committed = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'commitCleanup' },
			CATALOG
		);
		expect(committed.ok).toBe(true);
		if (!committed.ok) return;
		expect(committed.state.players.Red!.pendingCorruptionDiscard).toBeNull();
		expect(committed.state.players.Red!.victoryPoints).toBe(3);
	});

	test('endLocationActions settles an UNPAYABLE corruption debt as VP loss (clamped at 0)', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const state = started.state;
		state.phase = 'location';
		const red = state.players.Red!;
		red.spirits = [];
		red.victoryPoints = 1;
		red.pendingCorruptionDiscard = { count: 3, reason: 'corruption' };

		const res = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'endLocationActions' },
			CATALOG
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.state.players.Red!.pendingCorruptionDiscard).toBeNull();
		// 3 owed, 1 VP held → clamped at 0 (the adjustVictoryPoints convention).
		expect(res.state.players.Red!.victoryPoints).toBe(0);
	});

	test('discardSpirit converts the unpayable remainder to VP loss when the tableau empties', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const state = started.state;
		state.phase = 'cleanup';
		const red = state.players.Red!;
		// One spirit, three owed: the discard pays one, the unpayable remainder (2)
		// converts to VP loss instead of the old silent forgiveness.
		red.spirits = [red.spirits[0]!];
		red.victoryPoints = 5;
		red.pendingCorruptionDiscard = { count: 3, reason: 'corruption' };

		const res = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'discardSpirit', slotIndex: red.spirits[0]!.slotIndex },
			CATALOG
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.state.players.Red!.spirits).toHaveLength(0);
		expect(res.state.players.Red!.pendingCorruptionDiscard).toBeNull();
		expect(res.state.players.Red!.victoryPoints).toBe(3);
	});

	test('round-cap end runs FINAL SCORING: last-round World Guardian pays its +6 VP (U94RP3 case)', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const state = started.state;
		// Michael's game: 25 VP, Good (Corrupt L2), Cosmic Guardian (World Guardian class)
		// awakened in round 30's awakening phase — benefits phase never comes back, so
		// without final scoring the +6 ("24+ VP and Good") evaporates. He really hit 31.
		state.phase = 'cleanup';
		state.round = 30;
		const red = state.players.Red!;
		red.victoryPoints = 25;
		red.statusLevel = 2; // Corrupt — still Good (only Fallen is Evil)
		red.spirits = [
			...red.spirits.filter((s) => s.slotIndex !== 6),
			{ slotIndex: 6, id: 'cg', name: 'Cosmic Guardian', cost: 9, classes: { 'World Guardian': 1 }, origins: {}, isFaceDown: false }
		];
		for (const seat of state.activeSeats) {
			if (seat !== 'Red') state.players[seat]!.phaseReady = true;
		}

		const committed = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'commitCleanup' },
			CATALOG
		);
		expect(committed.ok).toBe(true);
		if (!committed.ok) return;
		expect(committed.state.status).toBe('finished');
		expect(committed.state.winnerSeat).toBe('Red');
		expect(committed.state.players.Red!.victoryPoints).toBe(31);
		// The points-over-time chart's last point shows the final score.
		const hist = committed.state.players.Red!.vpHistory!;
		expect(hist[hist.length - 1]).toBe(31);
	});

	test('spirit world saved: final-monster defeat ends the game at cleanup with final scoring', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const state = started.state;
		state.phase = 'cleanup';
		state.round = 12; // well before the round cap — the save ends it early
		state.spiritWorldSaved = true; // set by advanceMonsterIfDefeated at cleanup entry
		state.monster = null;
		state.players.Red!.victoryPoints = 22;
		state.players.Blue!.victoryPoints = 17;
		for (const seat of state.activeSeats) {
			if (seat !== 'Red') state.players[seat]!.phaseReady = true;
		}

		const committed = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'commitCleanup' },
			CATALOG
		);
		expect(committed.ok).toBe(true);
		if (!committed.ok) return;
		expect(committed.state.status).toBe('finished');
		expect(committed.state.winnerSeat).toBe('Red'); // highest VP when the world is saved
	});

	test('final scoring does NOT run before the round cap', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const state = started.state;
		state.phase = 'cleanup';
		state.round = 5;
		const red = state.players.Red!;
		red.victoryPoints = 25;
		red.statusLevel = 2;
		red.spirits = [
			...red.spirits.filter((s) => s.slotIndex !== 6),
			{ slotIndex: 6, id: 'cg', name: 'Cosmic Guardian', cost: 9, classes: { 'World Guardian': 1 }, origins: {}, isFaceDown: false }
		];
		for (const seat of state.activeSeats) {
			if (seat !== 'Red') state.players[seat]!.phaseReady = true;
		}

		const committed = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'commitCleanup' },
			CATALOG
		);
		expect(committed.ok).toBe(true);
		if (!committed.ok) return;
		// Round advances normally; the +6 is the NEXT benefits phase's business.
		expect(committed.state.status).toBe('active');
		expect(committed.state.round).toBe(6);
		expect(committed.state.players.Red!.victoryPoints).toBe(25);
	});

	test('the deadline drain auto-resolves leftover corruption in cleanup (highest slots)', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const state = started.state;
		state.phase = 'cleanup';
		const red = state.players.Red!;
		// Corruption already healed the player to full when it landed in takeDamage; the drain
		// only resolves the leftover owed spirit discards (it does NOT heal).
		red.maxBarrier = 5;
		red.barrier = 5;
		red.brokenBarrier = 0;
		// Give Red a known tableau and owe two discards.
		red.spirits = [1, 2, 3, 4, 5].map((slotIndex) => ({
			slotIndex,
			id: `auto-${slotIndex}`,
			name: `Auto ${slotIndex}`,
			cost: 2,
			classes: {},
			origins: {},
			isFaceDown: false
		}));
		red.pendingCorruptionDiscard = { count: 2, reason: 'corruption' };

		applyDeadlineAdvance(state, CATALOG);

		const after = state.players.Red!;
		// Obligation cleared and the two HIGHEST slots auto-discarded (health was already full).
		expect(after.pendingCorruptionDiscard ?? null).toBeNull();
		expect(after.barrier).toBe(5);
		expect(after.brokenBarrier).toBe(0);
		expect(after.spirits.map((s) => s.slotIndex).sort((a, b) => a - b)).toEqual([1, 2, 3]);
	});

	test('projection redacts the corruption obligation for non-owners', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		started.state.players.Red!.pendingCorruptionDiscard = { count: 1, reason: 'corruption' };

		const ownerView = buildSessionProjection(started.state, {
			role: 'player',
			seatColor: 'Red',
			displayName: 'Host Player'
		});
		expect(ownerView.players.Red!.pendingCorruptionDiscard).toEqual({
			count: 1,
			reason: 'corruption'
		});

		const otherView = buildSessionProjection(started.state, {
			role: 'player',
			seatColor: 'Blue',
			displayName: 'Guest Player'
		});
		expect(otherView.players.Red!.pendingCorruptionDiscard).toBeNull();
	});

	test('placeAugmentOnSpirit attaches an augment to a spirit and clears the pouch', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const target = started.state.players.Red!.spirits[0];
		started.state.players.Red!.unplacedAugments = [{ runeId: 'aug-sword', name: 'Spirit Augment' }];

		const res = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			// The owner picks which Spirit Augment (class) at placement.
			{ type: 'placeAugmentOnSpirit', augmentIndex: 0, augmentRuneId: 'aug-sword', spiritSlotIndex: target.slotIndex, className: 'Fighter' },
			CATALOG
		);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error(res.error.message);

		// Pouch emptied; a permanent attachment now binds the augment to that spirit.
		expect(res.state.players.Red!.unplacedAugments).toEqual([]);
		const attachments = res.state.players.Red!.spiritAugmentAttachments;
		expect(attachments).toHaveLength(1);
		expect(attachments[0].runeId).toBe('aug-sword');
		expect(attachments[0].className).toBe('Fighter');
		expect(attachments[0].spiritSlotIndex).toBe(target.slotIndex);
		expect(attachments[0].spiritId).toBe(target.id);
		// Augments never occupy rune slots.
		expect(res.state.players.Red!.mats.some((r) => r.id === 'aug-sword')).toBe(false);
	});

	test('a gained augment is placeable (owner picks the class) and counts toward the per-spirit cap', () => {
		// gainAugment (Captain / Strategist / Cursed-Spirit) pushes a placeable augment into
		// unplacedAugments; the owner picks WHICH Spirit Augment (class) at placement, and a
		// placed augment occupies capacity so a cap-1 spirit can't silently stack two.
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const target = started.state.players.Red!.spirits[0];
		started.state.players.Red!.unplacedAugments = [
			{ runeId: GENERIC_AUGMENT_RUNE_ID, name: 'Spirit Augment' },
			{ runeId: GENERIC_AUGMENT_RUNE_ID, name: 'Spirit Augment' }
		];

		const first = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'placeAugmentOnSpirit', augmentIndex: 0, augmentRuneId: GENERIC_AUGMENT_RUNE_ID, spiritSlotIndex: target.slotIndex, className: 'Cultivator' },
			CATALOG
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.state.players.Red!.spiritAugmentAttachments).toHaveLength(1);
		// The placed augment adds the class the owner picked.
		expect(first.state.players.Red!.spiritAugmentAttachments[0].className).toBe('Cultivator');

		// A second augment onto the SAME default-cap-1 spirit is rejected.
		const second = applyGameCommand(
			first.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'placeAugmentOnSpirit', augmentIndex: 0, augmentRuneId: GENERIC_AUGMENT_RUNE_ID, spiritSlotIndex: target.slotIndex, className: 'Fighter' },
			CATALOG
		);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.error.code).toBe('augment_full');
	});

	test('discarding a spirit takes its placed augment with it (gone forever)', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const target = started.state.players.Red!.spirits[0];
		started.state.players.Red!.unplacedAugments = [{ runeId: 'aug-sword', name: 'Spirit Augment' }];

		const placed = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'placeAugmentOnSpirit', augmentIndex: 0, augmentRuneId: 'aug-sword', spiritSlotIndex: target.slotIndex, className: 'Fighter' },
			CATALOG
		);
		if (!placed.ok) throw new Error(placed.error.message);
		expect(placed.state.players.Red!.spiritAugmentAttachments).toHaveLength(1);

		const discarded = applyGameCommand(
			placed.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'discardSpirit', slotIndex: target.slotIndex },
			CATALOG
		);
		expect(discarded.ok).toBe(true);
		if (!discarded.ok) return;
		// The augment is gone with the spirit — not returned anywhere.
		expect(discarded.state.players.Red!.spiritAugmentAttachments).toHaveLength(0);
		expect(discarded.state.players.Red!.unplacedAugments).toEqual([]);
	});

	test('placeAugmentOnSpirit rejects an empty slot and a bad augment index', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		started.state.players.Red!.unplacedAugments = [{ runeId: 'aug-sword', name: 'Swordsman' }];

		const noSpirit = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'placeAugmentOnSpirit', augmentIndex: 0, augmentRuneId: 'aug-sword', spiritSlotIndex: 7 },
			CATALOG
		);
		expect(noSpirit.ok).toBe(false);
		if (!noSpirit.ok) expect(noSpirit.error.code).toBe('spirit_missing');

		const target = started.state.players.Red!.spirits[0];
		const noAugment = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'placeAugmentOnSpirit', augmentIndex: 5, augmentRuneId: 'ghost-rune', spiritSlotIndex: target.slotIndex },
			CATALOG
		);
		expect(noAugment.ok).toBe(false);
		if (!noAugment.ok) expect(noAugment.error.code).toBe('augment_missing');
	});

	test('unplaced augments are owner-only in the projection', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		started.state.players.Red!.unplacedAugments = [{ runeId: 'aug-sword', name: 'Swordsman' }];

		const ownerView = buildSessionProjection(started.state, {
			role: 'player',
			seatColor: 'Red',
			displayName: 'Host Player'
		});
		expect(ownerView.players.Red!.unplacedAugments).toHaveLength(1);

		const otherView = buildSessionProjection(started.state, {
			role: 'player',
			seatColor: 'Blue',
			displayName: 'Guest Player'
		});
		expect(otherView.players.Red!.unplacedAugments).toEqual([]);
	});

	test('summoning into an occupied augmented slot is rejected (F8) — resident + augment survive', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const target = started.state.players.Red!.spirits[0];
		started.state.players.Red!.unplacedAugments = [{ runeId: 'aug-sword', name: 'Spirit Augment' }];

		const placed = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'placeAugmentOnSpirit', augmentIndex: 0, augmentRuneId: 'aug-sword', spiritSlotIndex: target.slotIndex, className: 'Fighter' },
			CATALOG
		);
		if (!placed.ok) throw new Error(placed.error.message);
		expect(placed.state.players.Red!.spiritAugmentAttachments).toHaveLength(1);

		// Summon a fresh spirit and aim it at the OCCUPIED slot (Tidal Cove row 0 = free
		// Spirit World Summon). F8: this is rejected — the engine never overwrites (and so
		// never destroys) the resident spirit + its augment.
		let state = locationPhase(placed.state, 'Tidal Cove');
		const open = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'resolveLocationInteraction', rowIndex: 0, choices: [] },
			CATALOG
		);
		if (!open.ok) throw new Error(open.error.message);
		state = open.state;
		const guid = state.players.Red!.handDraws[0]!.guid;
		const summoned = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'spawnHandSpirit', guid, slotIndex: target.slotIndex },
			CATALOG
		);
		expect(summoned.ok).toBe(false);
		if (summoned.ok) return;
		expect(summoned.error.code).toBe('slot_occupied');
		// The resident spirit and its augment are untouched.
		expect(state.players.Red!.spiritAugmentAttachments).toHaveLength(1);
		expect(state.players.Red!.spirits.some((s) => s.slotIndex === target.slotIndex)).toBe(true);
	});

	test('adjustBarrier / adjustBrokenBarrier keep arcane blood === maxTokens − barrier', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);

		// Lower health → arcane blood (the corrupted side) appears; invariant must hold.
		let s = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'adjustBarrier', amount: -2 },
			CATALOG
		);
		expect(s.ok).toBe(true);
		if (!s.ok) return;
		let p = s.state.players.Red!;
		expect(p.brokenBarrier).toBe(p.maxBarrier - p.barrier);
		expect(p.brokenBarrier).toBeGreaterThan(0);

		// Bump arcane blood directly → the health side re-derives, invariant still holds.
		s = applyGameCommand(s.state, { ...HOST, seatColor: 'Red' }, { type: 'adjustBrokenBarrier', amount: 1 }, CATALOG);
		expect(s.ok).toBe(true);
		if (!s.ok) return;
		p = s.state.players.Red!;
		expect(p.brokenBarrier).toBe(p.maxBarrier - p.barrier);
	});

	test('hides private hand draws from spectators and other seats', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);

		const redPlayer = started.state.players.Red;
		if (!redPlayer) throw new Error('Red player was not initialized.');
		redPlayer.handDraws = [{ guid: 'draw-01', id: 'spirit-07', name: 'Tide Warden' }];

		const spectatorProjection = buildSessionProjection(started.state, {
			role: 'spectator',
			seatColor: null,
			displayName: 'Observer'
		});
		const blueProjection = buildSessionProjection(started.state, {
			role: 'player',
			seatColor: 'Blue',
			displayName: 'Guest Player'
		});
		const redProjection = buildSessionProjection(started.state, {
			role: 'player',
			seatColor: 'Red',
			displayName: 'Host Player'
		});

		const spectatorRed = spectatorProjection.players.Red;
		const blueRed = blueProjection.players.Red;
		const redRed = redProjection.players.Red;
		expect(spectatorRed).toBeDefined();
		expect(blueRed).toBeDefined();
		expect(redRed).toBeDefined();
		if (!spectatorRed || !blueRed || !redRed) return;
		expect(spectatorRed.handDraws).toEqual([]);
		expect(blueRed.handDraws).toEqual([]);
		expect(redRed.handDraws).toHaveLength(1);
	});

	test('builds history-compatible snapshot rows at round commit', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);

		let state = started.state;
		const redDestination = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'selectNavigationDestination', destination: 'Tidal Cove' },
			CATALOG
		);
		if (!redDestination.ok) throw new Error(redDestination.error.message);
		state = redDestination.state;

		const blueDestination = applyGameCommand(
			state,
			{ ...GUEST, seatColor: 'Blue' },
			{ type: 'selectNavigationDestination', destination: 'Arcane Abyss' },
			CATALOG
		);
		if (!blueDestination.ok) throw new Error(blueDestination.error.message);
		state = blueDestination.state;

		const rows = buildHistorySnapshotRows(state, '2026-04-27T20:00:00.000Z');

		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			game_id: state.gameId,
			navigation_count: 1,
			player_color: 'Blue',
			selected_character: 'Nyra'
		});
		expect(rows[0].bags).toEqual(state.bags.history);
		expect(rows[1]).toMatchObject({
			game_id: state.gameId,
			navigation_count: 1,
			player_color: 'Red',
			selected_character: 'Myrtle'
		});
	});

	test('rejects destinations outside the spirit world map', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);

		const invalidDestination = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'selectNavigationDestination', destination: 'Kitchen Sink' },
			CATALOG
		);

		expect(invalidDestination.ok).toBe(false);
		if (invalidDestination.ok) return;
		expect(invalidDestination.error.code).toBe('destination_invalid');
	});
});

// ── P5: onSpiritSummon + onStatusChange wiring through the runtime ────────────

describe('P5 onSpiritSummon wiring', () => {
	const apply = (state: PublicGameState, seat: 'Red', command: Parameters<typeof applyGameCommand>[2]) => {
		const r = applyGameCommand(state, { ...HOST, seatColor: seat }, command, CATALOG);
		if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
		return r.state;
	};

	// A Sharpshooter-class spirit to summon (the base CATALOG has none). onSpiritSummon now
	// fires scoped to the JUST-SUMMONED spirit's classes, so the summoned spirit must itself
	// be the Sharpshooter for the grant to land.
	const SHARP = { id: 'spirit-sharp', name: 'Sniper', cost: 2, classes: { Sharpshooter: 1 }, origins: {} };
	const sharpCatalog: PlayCatalog = { ...CATALOG, spirits: [...CATALOG.spirits, SHARP] };

	test('spawnHandSpirit fires onSpiritSummon scoped to the summoned spirit (Sharpshooter)', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, sharpCatalog);
		if (!started.ok) throw new Error(started.error.message);
		// Drive to the Location phase at Tidal Cove (free Spirit World Summon at row 0).
		let state = locationPhase(started.state, 'Tidal Cove');
		expect(state.players.Red!.stunImmune).toBe(false);

		// Open the draw, then point the first drawn card at the Sharpshooter and summon it.
		// Sharpshooter's onSpiritSummon hook sets stunImmune — observable proof the summon
		// fired the trigger for THIS spirit's classes.
		const open = applyGameCommand(state, { ...HOST, seatColor: 'Red' }, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] }, sharpCatalog);
		if (!open.ok) throw new Error(open.error.message);
		state = open.state;
		state.players.Red!.handDraws[0]!.id = SHARP.id;
		const guid = state.players.Red!.handDraws[0]!.guid;
		const summoned = applyGameCommand(state, { ...HOST, seatColor: 'Red' }, { type: 'spawnHandSpirit', guid }, sharpCatalog);
		if (!summoned.ok) throw new Error(summoned.error.message);
		state = summoned.state;

		expect(state.players.Red!.stunImmune).toBe(true);
	});

	test('summoning a NON-Sharpshooter does not fire the Sharpshooter grant (per-spirit scope)', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, sharpCatalog);
		if (!started.ok) throw new Error(started.error.message);
		let state = locationPhase(started.state, 'Tidal Cove');
		// A Sharpshooter sits in the tableau, but the spirit being summoned is NOT one —
		// under per-spirit scoping the grant must NOT fire just because a Sharpshooter is in play.
		state.players.Red!.spirits = [
			{ slotIndex: 6, id: 'ss', name: 'Sharp', cost: 2, classes: { Sharpshooter: 1 }, origins: {}, isFaceDown: false }
		];
		state.players.Red!.stunImmune = false;
		const open = applyGameCommand(state, { ...HOST, seatColor: 'Red' }, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] }, sharpCatalog);
		if (!open.ok) throw new Error(open.error.message);
		state = open.state;
		const guid = state.players.Red!.handDraws[0]!.guid; // a random non-Sharpshooter draw
		const summoned = applyGameCommand(state, { ...HOST, seatColor: 'Red' }, { type: 'spawnHandSpirit', guid }, sharpCatalog);
		if (!summoned.ok) throw new Error(summoned.error.message);
		state = summoned.state;
		expect(state.players.Red!.stunImmune).toBe(false);
	});

	test('Soul Weaver: opening a summon draw arms a redraw; redrawHandDraws refreshes the hand', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		let state = locationPhase(started.state, 'Tidal Cove');

		// An awakened Soul Weaver in play → the redraw arms when the draw opens.
		state.players.Red!.spirits = [
			{ slotIndex: 6, id: 'sw', name: 'Weaver', cost: 2, classes: { 'Soul Weaver': 1 }, origins: {}, isFaceDown: false }
		];
		expect(state.players.Red!.redrawAvailable).toBe(false);

		// Free Spirit World Summon (row 0) opens the DrawTray.
		state = apply(state, 'Red', { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] });
		expect(state.players.Red!.handDraws.length).toBeGreaterThan(0);
		// Armed BEFORE any pick — the player can redraw their fresh hand immediately.
		expect(state.players.Red!.redrawAvailable).toBe(true);

		const beforeGuids = state.players.Red!.handDraws.map((d) => d.guid).sort();
		const beforeLimit = state.players.Red!.pendingDraw!.summonLimit;

		state = apply(state, 'Red', { type: 'redrawHandDraws' });

		// Fresh hand drawn, picks preserved, one-shot consumed.
		expect(state.players.Red!.handDraws.length).toBeGreaterThan(0);
		expect(state.players.Red!.pendingDraw!.summonLimit).toBe(beforeLimit);
		expect(state.players.Red!.pendingDraw!.summonedCount).toBe(0);
		expect(state.players.Red!.redrawAvailable).toBe(false);
		const afterGuids = state.players.Red!.handDraws.map((d) => d.guid).sort();
		// The returned spirits were reshuffled back, so the guids differ from before.
		expect(afterGuids).not.toEqual(beforeGuids);

		// A second redraw is rejected — it is a one-shot, not re-armed.
		const retry = applyGameCommand(state, { ...HOST, seatColor: 'Red' }, { type: 'redrawHandDraws' }, CATALOG);
		expect(retry.ok).toBe(false);
	});

	test('Soul Weaver: redraw is NOT available after picking a spirit', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		let state = locationPhase(started.state, 'Tidal Cove');
		state.players.Red!.spirits = [
			{ slotIndex: 6, id: 'sw', name: 'Weaver', cost: 2, classes: { 'Soul Weaver': 1 }, origins: {}, isFaceDown: false }
		];

		// Open the draw (armed), then summon one spirit.
		state = apply(state, 'Red', { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] });
		expect(state.players.Red!.redrawAvailable).toBe(true);
		const guid = state.players.Red!.handDraws[0]!.guid;
		state = apply(state, 'Red', { type: 'spawnHandSpirit', guid });

		// Committing to a pick spends the redraw — it is no longer armed (Spirit World
		// summon allows 2 picks, so a draw is still open, but redraw is gone).
		expect(state.players.Red!.redrawAvailable).toBe(false);
		const retry = applyGameCommand(state, { ...HOST, seatColor: 'Red' }, { type: 'redrawHandDraws' }, CATALOG);
		expect(retry.ok).toBe(false);
	});

	test('redrawHandDraws is rejected for a player without a Soul Weaver (no redraw armed)', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		let state = locationPhase(started.state, 'Tidal Cove');
		state = apply(state, 'Red', { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] });
		expect(state.players.Red!.redrawAvailable).toBe(false);
		const r = applyGameCommand(state, { ...HOST, seatColor: 'Red' }, { type: 'redrawHandDraws' }, CATALOG);
		expect(r.ok).toBe(false);
	});

	// (The former takeSpirit onSpiritSummon test is gone with the market family —
	// rules v1.1 — the spawnHandSpirit test above pins the same trigger scoping.)
});

describe('P5 onStatusChange wiring (adjustStatus corrupts a player)', () => {
	const corrupt = (state: PublicGameState, classes: Record<string, number>): PublicGameState => {
		state.players.Red!.spirits = [
			{ slotIndex: 6, id: 'cs', name: 'C', cost: 2, classes, origins: {}, isFaceDown: false }
		];
		const r = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'adjustStatus', amount: 1 }, // Pure → Tainted
			CATALOG
		);
		if (!r.ok) throw new Error(r.error.message);
		return r.state;
	};

	test('Cursed Spirit records the Tainted threshold for the Awakening Phase', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const state = corrupt(started.state, { 'Cursed Spirit': 1 });
		expect(state.players.Red!.statusLevel).toBe(1);
		expect(state.players.Red!.becameTaintedThisRound).toBe(true);
		expect(state.players.Red!.corruptedThisRound).toBe(true);
		// The grant itself is deferred to the Awakening Phase (cleanup), so dice are
		// not yet added at the moment of the status change.
		expect(state.players.Red!.attackDice).toHaveLength(0);
	});

	test('The Corruptor records corruption this round', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);
		const state = corrupt(started.state, { 'The Corruptor': 1 });
		expect(state.players.Red!.corruptedThisRound).toBe(true);
	});

	test('resolveDecision runs the resolver and clears the decision', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);

		// Seed a strategistTrade decision card + the dice it can trade.
		const red = started.state.players.Red!;
		red.maxBarrier = 10;
		red.attackDice = [
			{ instanceId: 'd0', tier: 'basic' },
			{ instanceId: 'd1', tier: 'basic' },
			{ instanceId: 'd2', tier: 'basic' }
		];
		red.pendingDecisions = [
			{
				id: 'dec-1',
				source: 'class',
				kind: 'strategistTrade',
				prompt: 'On rest, you may discard 3 attack dice to gain 1 Spirit Augment.',
				options: [
					{ id: 'yes', label: 'Discard 3 dice → 1 Augment' },
					{ id: 'no', label: 'No' }
				]
			}
		];

		const resolved = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'resolveDecision', decisionId: 'dec-1', optionId: 'yes' },
			CATALOG
		);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		const after = resolved.state.players.Red!;
		expect(after.pendingDecisions).toHaveLength(0); // cleared
		expect(after.attackDice).toHaveLength(0); // 3 − 3 discarded
		expect(after.unplacedAugments?.length ?? 0).toBe(1); // granted (placeable)
	});

	test('resolveDecision rejects an unknown decision id', () => {
		const lobby = withLobbySelections();
		const started = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!started.ok) throw new Error(started.error.message);

		const missing = applyGameCommand(
			started.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'resolveDecision', decisionId: 'nope', optionId: 'yes' },
			CATALOG
		);
		expect(missing.ok).toBe(false);
		if (missing.ok) return;
		expect(missing.error.code).toBe('decision_missing');
	});
});

describe('Cursed Spirit cleanup claim flow', () => {
	const started = (): PublicGameState => {
		const lobby = withLobbySelections();
		const r = applyGameCommand(lobby, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		if (!r.ok) throw new Error(r.error.message);
		return r.state;
	};
	const cursedSpirit = (n: number) => ({
		slotIndex: 6,
		id: 'cs',
		name: 'C',
		cost: 2,
		classes: { 'Cursed Spirit': n },
		origins: {},
		isFaceDown: false
	});
	const claim = (state: PublicGameState, taintedMaxBarrier?: number, relicPicks?: number[]) =>
		applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'resolveAwakenReward', taintedMaxBarrier, relicPicks },
			CATALOG
		);
	const classSpirit = (cls: string, n = 1, slotIndex = 5) => ({
		slotIndex,
		id: cls,
		name: cls,
		cost: 2,
		classes: { [cls]: n },
		origins: {},
		isFaceDown: false
	});

	test('enterBenefits builds a pending claim scaled ×N for a Tainted Cursed Spirit holder', () => {
		const state = started();
		state.players.Red!.spirits = [cursedSpirit(2)];
		state.players.Red!.becameTaintedThisRound = true;
		enterBenefits(state, CATALOG);
		const pending = state.players.Red!.pendingAwakenReward;
		expect(pending).not.toBeNull();
		expect(pending!.grants).toEqual([
			{ kind: 'taintedChoice', amount: 2, source: 'Cursed Spirit' }
		]);
	});

	test('a multi-tier corruption builds one grant line per stage crossed', () => {
		const state = started();
		state.players.Red!.spirits = [cursedSpirit(1)];
		state.players.Red!.becameTaintedThisRound = true;
		state.players.Red!.becameCorruptThisRound = true;
		enterBenefits(state, CATALOG);
		const grants = state.players.Red!.pendingAwakenReward!.grants;
		expect(grants.map((g) => g.kind)).toEqual(['taintedChoice', 'relicChoice']);
		expect(grants.find((g) => g.kind === 'relicChoice')).toMatchObject({ amount: 1 });
	});

	test('no Cursed Spirit, or no stage crossed this round → no pending claim', () => {
		const noClass = started();
		noClass.players.Red!.becameTaintedThisRound = true; // flag set, but no Cursed Spirit
		enterBenefits(noClass, CATALOG);
		expect(noClass.players.Red!.pendingAwakenReward).toBeNull();

		const noCross = started();
		noCross.players.Red!.spirits = [cursedSpirit(2)];
		enterBenefits(noCross, CATALOG); // held, but crossed nothing this round
		expect(noCross.players.Red!.pendingAwakenReward).toBeNull();
	});

	test('resolveAwakenReward applies the Tainted split (potential + Enchanted) and clears the claim', () => {
		const state = started();
		state.players.Red!.maxBarrier = 4;
		state.players.Red!.attackDice = [];
		state.players.Red!.spirits = [cursedSpirit(3)];
		state.players.Red!.becameTaintedThisRound = true;
		enterBenefits(state, CATALOG);
		const beforeMax = state.players.Red!.maxBarrier;
		const r = claim(state, 1); // 1 → potential, remaining 2 → Enchanted Attack
		if (!r.ok) throw new Error(r.error.message);
		const p = r.state.players.Red!;
		expect(p.pendingAwakenReward).toBeNull();
		expect(p.maxBarrier).toBe(beforeMax + 1);
		expect(p.attackDice.filter((d) => d.tier === 'enchanted')).toHaveLength(2);
	});

	test('benefits cannot be committed while a Cursed Spirit claim is pending', () => {
		const state = started();
		state.players.Red!.spirits = [cursedSpirit(1)];
		state.players.Red!.becameFallenThisRound = true;
		enterBenefits(state, CATALOG);
		const blocked = applyGameCommand(
			state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'commitBenefits' },
			CATALOG
		);
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.error.code).toBe('claim_pending');

		const claimed = claim(state, 0); // all-Enchanted default; here it's the Fallen augment line
		if (!claimed.ok) throw new Error(claimed.error.message);
		expect(claimed.state.players.Red!.unplacedAugments?.length ?? 0).toBe(1); // placeable
		const committed = applyGameCommand(
			claimed.state,
			{ ...HOST, seatColor: 'Red' },
			{ type: 'commitBenefits' },
			CATALOG
		);
		expect(committed.ok).toBe(true);
	});

	test('Golden Ruler builds a +1 VP claim; claiming grants the VP', () => {
		const state = started();
		state.players.Red!.spirits = [classSpirit('Golden Ruler')];
		const vp0 = state.players.Red!.victoryPoints;
		enterBenefits(state, CATALOG);
		expect(state.players.Red!.pendingAwakenReward!.grants).toEqual([
			{ kind: 'vp', amount: 1, source: 'Golden Ruler' }
		]);
		const r = claim(state);
		if (!r.ok) throw new Error(r.error.message);
		expect(r.state.players.Red!.victoryPoints).toBe(vp0 + 1);
	});

	test('Golden Ruler while Evil discards a Golden Ruler spirit on claim', () => {
		const state = started();
		state.players.Red!.spirits = [classSpirit('Golden Ruler')];
		state.players.Red!.statusLevel = 3; // Fallen → Evil
		enterBenefits(state, CATALOG);
		const grant = state.players.Red!.pendingAwakenReward!.grants[0];
		expect(grant).toMatchObject({ kind: 'vp', source: 'Golden Ruler' });
		expect((grant as { note?: string }).note).toBeTruthy();
		const r = claim(state);
		if (!r.ok) throw new Error(r.error.message);
		expect(r.state.players.Red!.spirits.some((s) => s.classes?.['Golden Ruler'])).toBe(false);
	});

	test('The Corruptor claims an Arcane die only when corrupted this round', () => {
		const noCorrupt = started();
		noCorrupt.players.Red!.spirits = [classSpirit('The Corruptor')];
		enterBenefits(noCorrupt, CATALOG);
		expect(noCorrupt.players.Red!.pendingAwakenReward).toBeNull();

		const corrupted = started();
		corrupted.players.Red!.spirits = [classSpirit('The Corruptor')];
		corrupted.players.Red!.corruptedThisRound = true;
		corrupted.players.Red!.attackDice = [];
		enterBenefits(corrupted, CATALOG);
		expect(corrupted.players.Red!.pendingAwakenReward!.grants).toEqual([
			{ kind: 'attackDice', tier: 'arcane', amount: 1, source: 'The Corruptor' }
		]);
		const r = claim(corrupted);
		if (!r.ok) throw new Error(r.error.message);
		expect(r.state.players.Red!.attackDice.filter((d) => d.tier === 'arcane')).toHaveLength(1);
	});

	test('World Guardian claims +6 VP only when Good with ≥24 VP', () => {
		const low = started();
		low.players.Red!.spirits = [classSpirit('World Guardian')];
		low.players.Red!.victoryPoints = 10;
		enterBenefits(low, CATALOG);
		expect(low.players.Red!.pendingAwakenReward).toBeNull();

		const hi = started();
		hi.players.Red!.spirits = [classSpirit('World Guardian')];
		hi.players.Red!.victoryPoints = 24;
		enterBenefits(hi, CATALOG);
		expect(hi.players.Red!.pendingAwakenReward!.grants).toEqual([
			{ kind: 'vp', amount: 6, source: 'World Guardian' }
		]);
	});

	test('World Ender grants a flat +1 VP at cleanup (no longer a claim)', () => {
		const state = started();
		state.players.Red!.spirits = [classSpirit('World Ender')];
		enterBenefits(state, CATALOG);
		// Reworked: World Ender is now a flat +1 VP awakeningPhase handler (fires during
		// enterBenefits), not an all-Evil Cleanup claim.
		expect(state.players.Red!.victoryPoints).toBe(1);
		const grants = state.players.Red!.pendingAwakenReward?.grants ?? [];
		expect(grants.some((g) => g.source === 'World Ender')).toBe(false);
	});

	test('Cursed Spirit relic choice grants the PICKED relics, not generic', () => {
		const state = started();
		state.players.Red!.spirits = [cursedSpirit(2)];
		state.players.Red!.becameCorruptThisRound = true;
		enterBenefits(state, CATALOG);
		const before = state.players.Red!.mats.length;
		const r = claim(state, 0, [2, 0]); // unit0 → Firecracker (idx 2), unit1 → Fairy (idx 0)
		if (!r.ok) throw new Error(r.error.message);
		const p = r.state.players.Red!;
		expect(p.relics).toBe(2);
		expect(p.mats.slice(before).map((x) => x.name)).toEqual(['Firecracker Relic', 'Fairy Relic']);
	});
});

// ── §5.5 lobby canStart (host start-gate, S4) ─────────────────────────────────────────
describe('lobby canStart projection', () => {
	const hostViewer = { role: 'host' as const, seatColor: 'Red' as const, displayName: 'Host Player' };
	const playerViewer = { role: 'player' as const, seatColor: 'Blue' as const, displayName: 'Guest Player' };
	const spectatorViewer = { role: 'spectator' as const, seatColor: null, displayName: null };

	function ok(state: PublicGameState, actor: GameActor, command: Parameters<typeof applyGameCommand>[2]): PublicGameState {
		const r = applyGameCommand(state, actor, command, CATALOG);
		if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
		return r.state;
	}
	const emptyLobby = () =>
		createLobbyState({ roomCode: 'ROOM42', guardianNames: CATALOG.guardians.map((g) => g.name) });

	test('a ready lobby → host sees canStart ok', () => {
		expect(buildSessionProjection(withLobbySelections(), hostViewer).canStart).toEqual({ ok: true });
	});

	test('a seated player without a guardian blocks start; reason names that seat and matches the reducer', () => {
		let state = emptyLobby();
		state = ok(state, HOST, { type: 'claimSeat', seatColor: 'Red' });
		state = ok(state, GUEST, { type: 'claimSeat', seatColor: 'Blue' });
		state = ok(state, { ...HOST, seatColor: 'Red' }, { type: 'selectGuardian', guardianName: 'Myrtle' });
		// Blue never picks a guardian.
		expect(buildSessionProjection(state, hostViewer).canStart).toEqual({
			ok: false,
			reason: 'Seat Blue must choose a guardian.'
		});
		// The reducer rejects startGame for the SAME reason (shared canStartGame — S4 can't drift).
		const rejected = applyGameCommand(state, { ...HOST, seatColor: 'Red' }, { type: 'startGame' }, CATALOG);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) throw new Error('expected rejection');
		expect(rejected.error.code).toBe('guardian_required');
		expect(rejected.error.message).toBe('Seat Blue must choose a guardian.');
	});

	test('an empty lobby → blocked on no seated players', () => {
		expect(buildSessionProjection(emptyLobby(), hostViewer).canStart).toEqual({
			ok: false,
			reason: 'At least one player must claim a seat.'
		});
	});

	test('canStart is host-only — players and spectators never see it', () => {
		const ready = withLobbySelections();
		expect(buildSessionProjection(ready, playerViewer).canStart).toBeUndefined();
		expect(buildSessionProjection(ready, spectatorViewer).canStart).toBeUndefined();
	});

	test('canStart is absent once the game has started', () => {
		const started = applyGameCommand(
			withLobbySelections(),
			{ ...HOST, seatColor: 'Red' },
			{ type: 'startGame' },
			CATALOG
		);
		if (!started.ok) throw new Error(started.error.message);
		expect(buildSessionProjection(started.state, hostViewer).canStart).toBeUndefined();
	});
});
