import { describe, expect, test } from 'vitest';
import type { MatSlotSnapshot } from '$lib/types';
import { applyGameCommand, buildSessionProjection, createLobbyState } from './runtime';
import { seatHasResolutionWork } from './phases';
import { buildLocationInteractions, matchRewardCost } from './locationInteractions';
import type {
	GameActor,
	GameCommand,
	GamePhase,
	PlayCatalog,
	PrivatePlayerState,
	PublicGameState
} from './types';
import {
	buildRoomViewV2,
	computeAffordances,
	computeLegalCommandTypes,
	describePendingWork,
	PASS_COMMAND_BY_PHASE,
	PHASE_LABELS,
	type RoomViewMember
} from './viewV2';

// ── Fixture harness (mirrors phases.test.ts: drive a real game via the reducer) ───────
const HOST: GameActor = { memberId: 'm-host', displayName: 'Host', role: 'host', seatColor: null };
const GUEST: GameActor = { memberId: 'm-guest', displayName: 'Guest', role: 'player', seatColor: null };
const RED: GameActor = { ...HOST, seatColor: 'Red' };
const BLUE: GameActor = { ...GUEST, seatColor: 'Blue' };

const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-a', name: 'Myrtle', originId: 'o1' },
		{ id: 'g-b', name: 'Nyra', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
	spirits: Array.from({ length: 6 }, (_, i) => ({
		id: `s-${i}`,
		name: `Spirit ${i}`,
		cost: 2,
		classes: {},
		origins: {}
	}))
};

function apply(state: PublicGameState, actor: GameActor, command: GameCommand): PublicGameState {
	const result = applyGameCommand(state, actor, command, CATALOG);
	if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`);
	return result.state;
}

function startedGame(seed = 1): PublicGameState {
	let state = createLobbyState({ roomCode: 'ROOM42', guardianNames: ['Myrtle', 'Nyra'] });
	state = apply(state, HOST, { type: 'claimSeat', seatColor: 'Red' });
	state = apply(state, GUEST, { type: 'claimSeat', seatColor: 'Blue' });
	state = apply(state, RED, { type: 'selectGuardian', guardianName: 'Myrtle' });
	state = apply(state, BLUE, { type: 'selectGuardian', guardianName: 'Nyra' });
	state = apply(state, RED, { type: 'startGame', seed });
	return state;
}

/** Put a single face-up spirit on a seat (same shape phases.test.ts uses). */
function giveSpirit(state: PublicGameState, seat: 'Red' | 'Blue', isFaceDown = false): void {
	state.players[seat]!.spirits = [
		{ slotIndex: 1, id: `x-${seat}`, name: `X-${seat}`, cost: 2, classes: {}, origins: {}, isFaceDown }
	];
}

/** Reset every "resolution work" field on a seat to empty, so a scenario sets only what it means to. */
function clearWork(state: PublicGameState, seat: 'Red' | 'Blue'): void {
	const p = state.players[seat]!;
	p.pendingDraw = null;
	p.pendingReward = null;
	p.pendingAwakenReward = null;
	p.pendingDrawQueue = [];
	p.unplacedAugments = [];
	p.awakenOffers = [];
	p.manualPrompts = [];
	p.pendingDecisions = [];
	p.awakenEligible = [];
	p.pendingCorruptionDiscard = null;
	p.spirits = [];
	p.mats = [];
}

/** Force a started game into an arbitrary phase for pure-derivation tests (both functions
 *  under test are pure reads over state.phase — they don't validate reachability). */
function inPhase(seed: number, phase: GamePhase): PublicGameState {
	const state = startedGame(seed);
	state.phase = phase;
	return state;
}

// ── (1) computeLegalCommandTypes ──────────────────────────────────────────────────────
describe('computeLegalCommandTypes', () => {
	test('navigation seat can lock/unlock but never sees cleanup/location commands', () => {
		const state = startedGame();
		const types = computeLegalCommandTypes(state, 'Red', CATALOG);
		expect(types).toContain('lockNavigation');
		expect(types).toContain('unlockNavigation');
		expect(types).not.toContain('commitCleanup');
		expect(types).not.toContain('endLocationActions');
	});

	test('cleanup seat with a pending corruption discard includes discardSpirit', () => {
		const state = inPhase(3, 'cleanup');
		giveSpirit(state, 'Red'); // a spirit to discard
		state.players.Red!.pendingCorruptionDiscard = { count: 1, reason: 'test' };
		const types = computeLegalCommandTypes(state, 'Red', CATALOG);
		expect(types).toContain('discardSpirit');
	});

	test('excluded-on-false: discardSpirit is dropped for a seat with no spirits', () => {
		const state = inPhase(3, 'cleanup');
		clearWork(state, 'Blue'); // no spirits, no runes
		const types = computeLegalCommandTypes(state, 'Blue', CATALOG);
		expect(types).not.toContain('discardSpirit'); // canApply → false, provably excluded
		expect(types).not.toContain('discardRune'); // no held runes → false
		expect(types).toContain('commitCleanup'); // nothing blocks the commit → true, included
	});

	test('awakenSpirit is included only when a face-down spirit exists', () => {
		const withFaceDown = inPhase(4, 'awakening');
		giveSpirit(withFaceDown, 'Red', true);
		withFaceDown.players.Red!.awakenEligible = [1];
		expect(computeLegalCommandTypes(withFaceDown, 'Red', CATALOG)).toContain('awakenSpirit');

		const faceUpOnly = inPhase(4, 'awakening');
		giveSpirit(faceUpOnly, 'Red', false);
		expect(computeLegalCommandTypes(faceUpOnly, 'Red', CATALOG)).not.toContain('awakenSpirit');
	});

	test('returns [] for a missing player or a non-active game', () => {
		const state = startedGame();
		expect(computeLegalCommandTypes(state, 'Green', CATALOG)).toEqual([]); // unseated
		const lobby = createLobbyState({ roomCode: 'L', guardianNames: ['Myrtle', 'Nyra'] });
		lobby.players.Red = state.players.Red; // seat present but status is 'lobby'
		expect(computeLegalCommandTypes(lobby, 'Red', CATALOG)).toEqual([]);
	});
});

// ── (2) describePendingWork ↔ seatHasResolutionWork consistency ──────────────────────
describe('describePendingWork mirrors seatHasResolutionWork', () => {
	// Each scenario mutates Red into one crafted state; `expected` is the ground truth
	// seatHasResolutionWork should report (and thus whether pendingWork must be non-empty).
	const scenarios: { name: string; phase: GamePhase; setup: (s: PublicGameState) => void; expected: boolean }[] = [
		{ name: 'navigation / clean', phase: 'navigation', setup: () => {}, expected: false },
		{ name: 'location / pendingReward', phase: 'location', setup: (s) => { s.players.Red!.pendingReward = { rewardTrack: [], chooseAmount: 0 } as never; }, expected: true },
		{ name: 'location / clean', phase: 'location', setup: () => {}, expected: false },
		{ name: 'location / corruption debt is NOT resolution work here', phase: 'location', setup: (s) => { giveSpirit(s, 'Red'); s.players.Red!.pendingCorruptionDiscard = { count: 1 }; }, expected: false },
		{ name: 'any / pendingDraw', phase: 'location', setup: (s) => { s.players.Red!.pendingDraw = { drawCount: 1 } as never; }, expected: true },
		{ name: 'any / pendingDrawQueue', phase: 'navigation', setup: (s) => { s.players.Red!.pendingDrawQueue = [{ sourceBag: 'hexSpirits', drawCount: 1, summonLimit: 1 }] as never; }, expected: true },
		{ name: 'any / unplacedAugments', phase: 'benefits', setup: (s) => { s.players.Red!.unplacedAugments = [{ runeId: 'aug-1', name: 'Aug' }]; }, expected: true },
		{ name: 'benefits / pendingAwakenReward', phase: 'benefits', setup: (s) => { s.players.Red!.pendingAwakenReward = { grants: [] }; }, expected: true },
		{ name: 'benefits / clean', phase: 'benefits', setup: () => {}, expected: false },
		{ name: 'awakening / awakenOffers', phase: 'awakening', setup: (s) => { s.players.Red!.awakenOffers = [{ slotIndex: 2, spiritName: 'Faerie', requirement: 'Free' }] as never; }, expected: true },
		{ name: 'awakening / manualPrompts', phase: 'awakening', setup: (s) => { s.players.Red!.manualPrompts = [{ id: 'mp-1', source: 'Cls', text: 'do it' }]; }, expected: true },
		{ name: 'awakening / pendingDecisions', phase: 'awakening', setup: (s) => { s.players.Red!.pendingDecisions = [{ id: 'd-1', source: 'class', kind: 'k', prompt: 'p', options: [{ id: 'o', label: 'L' }] }]; }, expected: true },
		{ name: 'awakening / eligible face-down flip', phase: 'awakening', setup: (s) => { giveSpirit(s, 'Red', true); s.players.Red!.awakenEligible = [1]; }, expected: true },
		{ name: 'awakening / eligible but face-UP (no work)', phase: 'awakening', setup: (s) => { giveSpirit(s, 'Red', false); s.players.Red!.awakenEligible = [1]; }, expected: false },
		{ name: 'awakening / clean', phase: 'awakening', setup: () => {}, expected: false },
		{ name: 'cleanup / rune overflow', phase: 'cleanup', setup: (s) => { s.players.Red!.mats = Array.from({ length: 5 }, (_, i) => ({ slotIndex: i + 1, hasRune: true, guid: `r${i}` })); }, expected: true },
		{ name: 'cleanup / at carry limit (no overflow)', phase: 'cleanup', setup: (s) => { s.players.Red!.mats = Array.from({ length: 4 }, (_, i) => ({ slotIndex: i + 1, hasRune: true, guid: `r${i}` })); }, expected: false },
		{ name: 'cleanup / payable corruption debt', phase: 'cleanup', setup: (s) => { giveSpirit(s, 'Red'); s.players.Red!.pendingCorruptionDiscard = { count: 2 }; }, expected: true },
		{ name: 'cleanup / UNPAYABLE corruption debt (no spirits)', phase: 'cleanup', setup: (s) => { s.players.Red!.pendingCorruptionDiscard = { count: 2 }; }, expected: false },
		{ name: 'cleanup / clean', phase: 'cleanup', setup: () => {}, expected: false }
	];

	for (const { name, phase, setup, expected } of scenarios) {
		test(`${name}`, () => {
			const state = inPhase(9, phase);
			clearWork(state, 'Red');
			setup(state);
			const resolutionWork = seatHasResolutionWork(state, 'Red');
			const descriptors = describePendingWork(state, state.players.Red!);
			// Ground-truth check: seatHasResolutionWork itself agrees with the scenario.
			expect(resolutionWork).toBe(expected);
			// Load-bearing consistency: pendingWork is non-empty EXACTLY when there is resolution work.
			expect(descriptors.length > 0).toBe(resolutionWork);
		});
	}

	test('descriptor payloads carry routable detail (slotIndexes / ids / counts)', () => {
		const state = inPhase(9, 'awakening');
		clearWork(state, 'Red');
		state.players.Red!.manualPrompts = [{ id: 'mp-7', source: 'Cls', text: 't' }];
		giveSpirit(state, 'Red', true);
		state.players.Red!.awakenEligible = [1];
		const work = describePendingWork(state, state.players.Red!);
		const manual = work.find((w) => w.kind === 'manualPrompt');
		expect(manual?.ids).toEqual(['mp-7']);
		const flip = work.find((w) => w.kind === 'awaken');
		expect(flip?.slotIndexes).toEqual([1]);
		expect(flip?.count).toBe(1);
	});
});

// ── (3) canPass per phase ────────────────────────────────────────────────────────────
describe('canPass', () => {
	test('navigation never allows a pass (no advance command)', () => {
		const state = startedGame();
		expect(PASS_COMMAND_BY_PHASE.navigation).toBeUndefined();
		expect(computeAffordances(state, 'Red', CATALOG).canPass).toBe(false);
	});

	test('a clean seat can pass in encounter / location / benefits / awakening / cleanup', () => {
		for (const phase of ['encounter', 'location', 'benefits', 'awakening', 'cleanup'] as GamePhase[]) {
			const state = inPhase(5, phase);
			clearWork(state, 'Red');
			expect(computeAffordances(state, 'Red', CATALOG).canPass).toBe(true);
		}
	});

	test('an unclaimed benefits reward blocks the pass', () => {
		const state = inPhase(5, 'benefits');
		clearWork(state, 'Red');
		state.players.Red!.pendingAwakenReward = { grants: [] };
		expect(computeAffordances(state, 'Red', CATALOG).canPass).toBe(false); // commitBenefits → false
	});

	test('rune overflow blocks the cleanup commit', () => {
		const state = inPhase(5, 'cleanup');
		clearWork(state, 'Red');
		state.players.Red!.mats = Array.from({ length: 5 }, (_, i) => ({ slotIndex: i + 1, hasRune: true, guid: `r${i}` }));
		expect(computeAffordances(state, 'Red', CATALOG).canPass).toBe(false);
	});
});

// ── (4) buildRoomViewV2 ──────────────────────────────────────────────────────────────
describe('buildRoomViewV2', () => {
	const member: RoomViewMember = { id: 'm-host', role: 'player', seatColor: 'Red', displayName: 'Host' };

	test('a seated viewer gets affordances for exactly their own seat', () => {
		const state = startedGame();
		const viewer = { role: 'player' as const, seatColor: 'Red' as const, displayName: 'Host' };
		const view = buildRoomViewV2(state, viewer, member, CATALOG);
		expect(view.version).toBe(2);
		expect(Object.keys(view.affordances)).toEqual(['Red']);
		expect(view.affordances.Red?.seat).toBe('Red');
		expect(view.affordances.Blue).toBeUndefined();
	});

	test('a spectator gets no affordances', () => {
		const state = startedGame();
		const viewer = { role: 'spectator' as const, seatColor: null, displayName: 'Watcher' };
		const spectatorMember: RoomViewMember = { id: null, role: 'spectator', seatColor: null, displayName: 'Watcher' };
		const view = buildRoomViewV2(state, viewer, spectatorMember, CATALOG);
		expect(view.affordances).toEqual({});
	});

	test('projection is the untouched buildSessionProjection output', () => {
		const state = startedGame();
		const viewer = { role: 'player' as const, seatColor: 'Red' as const, displayName: 'Host' };
		const view = buildRoomViewV2(state, viewer, member, CATALOG);
		expect(view.projection).toEqual(buildSessionProjection(state, viewer));
		expect(view.member).toBe(member);
	});
});

// ── (5) computeAffordances shape + deadline passthrough ──────────────────────────────
describe('computeAffordances', () => {
	test('phase label + deadline pass straight through', () => {
		const state = inPhase(6, 'awakening');
		state.phaseDeadline = 1_725_000_000_000;
		const aff = computeAffordances(state, 'Red', CATALOG);
		expect(aff.phase).toBe('awakening');
		expect(aff.phaseLabel).toBe(PHASE_LABELS.awakening);
		expect(aff.deadline).toBe(1_725_000_000_000);
	});

	test('a null phaseDeadline passes through as null', () => {
		const state = startedGame();
		state.phaseDeadline = null;
		expect(computeAffordances(state, 'Red', CATALOG).deadline).toBeNull();
	});

	test('hasResolutionWork tracks seatHasResolutionWork', () => {
		const state = inPhase(6, 'cleanup');
		clearWork(state, 'Red');
		giveSpirit(state, 'Red');
		state.players.Red!.pendingCorruptionDiscard = { count: 1 };
		expect(computeAffordances(state, 'Red', CATALOG).hasResolutionWork).toBe(true);
	});
});

// ── §5.2 location-interaction affordances + §5.4 passBlockedReason ─────────────────────

// Real reward-row icon ids (mirror locationInteractions.test.ts / the live DB).
const ANY_RELIC_ICON = '6a85e06a-52cc-483c-aa59-38395a377307';
const CYBER_TOKEN = '87d1f1ad-9c0a-4a65-bb2b-16acebc2d019';
const CYBER_ORIGIN = 'fa7db249-d99d-4c1d-a37d-9027c9f5a31e';
const CYBER_RUNE = '356f3ad2-4cac-4b69-a3cc-7559f8891d8e';
const MAGNET_RUNE = 'ee1486a0-8b61-499c-809b-b4de9920aa8f';
const MAGNET_TOKEN = 'ca4df196-67fb-4507-973d-1dfac277953d';
const BARRIER = '6746f875-a1bc-453c-94b5-718d6ebeb025';
const SORCERER = 'c9b3225f-c8a9-4aa8-8e43-56c39cf68974';
const STRATEGIST = '88facdb6-3374-4891-af8a-fca2e81b79ef';

const LOC = 'Cyber City';
const LOC_CATALOG: PlayCatalog = {
	...CATALOG,
	locations: [
		{
			name: LOC,
			originId: CYBER_ORIGIN,
			rewardRows: [
				// row 0: SPECIFIC-rune cost (Cyber ×2) → Magnet + 2 barrier restore.
				{ type: 'trade', cost_icon_ids: [CYBER_TOKEN, CYBER_TOKEN], gain_icon_ids: [MAGNET_TOKEN, BARRIER, BARRIER] },
				// row 1: WILDCARD cost (any relic) → an "or" augment (a choice group, no default).
				{ type: 'trade', cost_icon_ids: [ANY_RELIC_ICON], gain_icon_ids: [{ kind: 'or', icon_ids: [SORCERER, STRATEGIST] }] },
				// row 2: free gain of barrier restore (for the noEffectNow check).
				{ type: 'gain', gain_icon_ids: [BARRIER] }
			]
		}
	]
};

function mat(slotIndex: number, over: Partial<MatSlotSnapshot> = {}): MatSlotSnapshot {
	return { slotIndex, hasRune: true, type: 'rune', ...over } as MatSlotSnapshot;
}

/** A started game parked in the Location phase at LOC, with all resolution-work
 *  fields cleared so a scenario sets only what it means to. */
function locationState(mats: MatSlotSnapshot[], patch: Partial<PrivatePlayerState> = {}): PublicGameState {
	const state = startedGame();
	state.phase = 'location';
	const red = state.players.Red!;
	red.navigationDestination = LOC;
	red.mats = mats;
	red.actionsUsedThisRound = [];
	red.extraActions = {};
	red.brokenBarrier = 0;
	red.pendingDraw = null;
	red.handDraws = [];
	red.pendingDrawQueue = [];
	red.pendingReward = null;
	red.pendingCorruptionDiscard = null;
	red.spirits = [];
	Object.assign(red, patch);
	return state;
}

describe('computeAffordances — location interactions (§5.2)', () => {
	test('a specific-rune trade lists only the matching mat slots; autoPick = auto-match', () => {
		const state = locationState([
			mat(1, { id: CYBER_RUNE, originId: CYBER_ORIGIN, name: 'Cyber City Rune' }),
			mat(2, { id: CYBER_RUNE, originId: CYBER_ORIGIN, name: 'Cyber City Rune' }),
			mat(3, { id: MAGNET_RUNE, name: 'Magnet', type: 'relic' })
		]);
		const rows = computeAffordances(state, 'Red', LOC_CATALOG).locationInteractions!;
		const row0 = rows.find((r) => r.rowIndex === 0)!;
		expect(row0.affordable).toBe(true);
		expect(row0.costSlots).toHaveLength(2);
		expect(row0.costSlots.every((s) => s.wildcard === false)).toBe(true);
		// Only the two Cyber runes (array indexes 0,1) can pay; the Magnet relic (2) can't.
		expect(row0.costSlots[0].eligibleMatSlotIndexes).toEqual([0, 1]);
		expect(row0.costSlots[1].eligibleMatSlotIndexes).toEqual([0, 1]);
		// autoPick pre-fill == exactly what matchRewardCost (auto-match) would spend.
		const interaction = buildLocationInteractions(LOC_CATALOG.locations![0].rewardRows).find(
			(i) => i.rowIndex === 0
		)!;
		const expected = matchRewardCost(interaction.cost, state.players.Red!.mats)
			.consumedArrayIndexes.slice()
			.sort();
		expect(row0.costSlots.map((s) => s.autoPick).sort()).toEqual(expected);
	});

	test('a wildcard trade lists ALL held relics (never a rune); its "or" gain is a choice group', () => {
		const state = locationState([
			mat(1, { id: MAGNET_RUNE, name: 'Magnet', type: 'relic' }),
			mat(2, { id: 'fairy', name: 'Fairy', type: 'relic' }),
			mat(3, { id: CYBER_RUNE, originId: CYBER_ORIGIN, type: 'rune' })
		]);
		const row1 = computeAffordances(state, 'Red', LOC_CATALOG).locationInteractions!.find(
			(r) => r.rowIndex === 1
		)!;
		expect(row1.costSlots).toHaveLength(1);
		expect(row1.costSlots[0].wildcard).toBe(true);
		// Both relics (array indexes 0,1) are eligible; the rune (2) is not.
		expect(row1.costSlots[0].eligibleMatSlotIndexes).toEqual([0, 1]);
		// The "or" augment gain surfaces as a choice group with no pre-selected default (S6).
		expect(row1.choiceGroups).toHaveLength(1);
		expect(row1.choiceGroups[0].options.map((o) => o.name)).toEqual(['Sorcerer', 'Strategist']);
	});

	test('affordability + usesRemaining reflect held mats and per-row allowance', () => {
		// No mats → the two costed trades are unaffordable, the free gain is not.
		const broke = computeAffordances(locationState([]), 'Red', LOC_CATALOG).locationInteractions!;
		expect(broke.find((r) => r.rowIndex === 0)!.affordable).toBe(false);
		expect(broke.find((r) => r.rowIndex === 2)!.affordable).toBe(true);

		// Child Prodigy allowance (2) minus one recorded use of row 2 → 1 remaining.
		const rows = computeAffordances(
			locationState([], { extraActions: { locationInteraction: 1 }, actionsUsedThisRound: ['row:2'] }),
			'Red',
			LOC_CATALOG
		).locationInteractions!;
		expect(rows.find((r) => r.rowIndex === 2)!.usesRemaining).toBe(1);
	});

	test('noEffectNow flags a barrier restore only while barrier is full', () => {
		const full = computeAffordances(locationState([], { brokenBarrier: 0 }), 'Red', LOC_CATALOG)
			.locationInteractions!.find((r) => r.rowIndex === 2)!;
		expect(full.noEffectNow).toBe(true);
		const broken = computeAffordances(locationState([], { brokenBarrier: 3 }), 'Red', LOC_CATALOG)
			.locationInteractions!.find((r) => r.rowIndex === 2)!;
		expect(broken.noEffectNow).toBeUndefined();
	});

	test('a Mod Injector waives an augment trade (affordable with no relics held)', () => {
		const state = locationState([], {
			spirits: [
				{ slotIndex: 1, id: 'mi', name: 'Mod Injector', cost: 2, classes: { 'Mod Injector': 1 }, origins: {}, isFaceDown: false }
			]
		});
		const row1 = computeAffordances(state, 'Red', LOC_CATALOG).locationInteractions!.find(
			(r) => r.rowIndex === 1
		)!;
		expect(row1.freeTrade).toBe('modInjector');
		expect(row1.affordable).toBe(true);
	});

	test('absent outside the Location phase', () => {
		const nav = locationState([]);
		nav.phase = 'navigation';
		expect(computeAffordances(nav, 'Red', LOC_CATALOG).locationInteractions).toBeUndefined();
	});
});

describe('computeAffordances — passBlockedReason (§5.4, F3)', () => {
	test('a payable corruption debt blocks endLocationActions with a reason', () => {
		const state = locationState([], {
			pendingCorruptionDiscard: { count: 1 },
			spirits: [
				{ slotIndex: 1, id: 'x', name: 'X', cost: 2, classes: {}, origins: {}, isFaceDown: false }
			]
		});
		const aff = computeAffordances(state, 'Red', LOC_CATALOG);
		expect(aff.canPass).toBe(false);
		expect(aff.passBlockedReason).toBe('Discard your corrupted spirits first.');
	});

	test('a clear seat can pass with no blocked reason', () => {
		const aff = computeAffordances(locationState([]), 'Red', LOC_CATALOG);
		expect(aff.canPass).toBe(true);
		expect(aff.passBlockedReason).toBeUndefined();
	});

	test('navigation has no pass command → no blocked reason', () => {
		const nav = locationState([]);
		nav.phase = 'navigation';
		expect(computeAffordances(nav, 'Red', LOC_CATALOG).passBlockedReason).toBeUndefined();
	});
});
