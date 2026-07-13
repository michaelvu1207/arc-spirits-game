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
	computeEncounter,
	computeInfiltratorSwap,
	computeLegalCommandTypes,
	computePendingReward,
	describePendingWork,
	PASS_COMMAND_BY_PHASE,
	PHASE_LABELS,
	type RoomViewMember
} from './viewV2';
import { augmentClassChoices, augmentPlacementEligibility, SPIRIT_AUGMENT_CLASSES } from './augments';
import { decisionPickerSpec } from './decisionPicker';
import { enumerateCandidates } from './ml/actions';

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

// ════════════════════════════════════════════════════════════════════════════════════
// Wave 2 engine: resolved rewards (§5.3), pendingWork extensions (§5.4), reducer
// hardening (F8/F9 + picker), and the bot-compat proof that hardening never touches bots.
// ════════════════════════════════════════════════════════════════════════════════════

/** Real reward-track VP icon id (mirrors REWARD_ICON_SEMANTICS / the live DB). */
const VP_THREE_ICON = '54a61c34-6e05-44df-a4d1-115e004af31e';

/** Apply expecting a REJECTION; returns the error so the code can be asserted. */
function reject(state: PublicGameState, actor: GameActor, command: GameCommand): { code: string } {
	const result = applyGameCommand(state, actor, command, CATALOG);
	if (result.ok) throw new Error(`${command.type} unexpectedly succeeded`);
	return result.error;
}

// ── §5.3 monster rewards resolved server-side ─────────────────────────────────────────
describe('computePendingReward — resolved monster rewards (§5.3)', () => {
	test('a pending reward resolves to labelled, indexed options; a chooseRune carries its options', () => {
		const state = inPhase(2, 'location');
		clearWork(state, 'Red');
		state.players.Red!.pendingReward = {
			monsterId: 'm1',
			monsterName: 'Gloomfang',
			rewardTrack: [VP_THREE_ICON, ANY_RELIC_ICON],
			chooseAmount: 1
		};
		const resolved = computeAffordances(state, 'Red', CATALOG).pendingReward!;
		expect(resolved.monsterName).toBe('Gloomfang');
		expect(resolved.chooseAmount).toBe(1);
		const [vp, relic] = resolved.options;
		expect(vp).toEqual({ index: 0, label: '3 Victory Points', iconToken: VP_THREE_ICON, effect: 'vp' });
		expect(vp.chooseOptions).toBeUndefined();
		expect(relic.index).toBe(1);
		expect(relic.effect).toBe('chooseRune');
		expect(relic.chooseOptions?.length ?? 0).toBeGreaterThan(0);
		// `index` is exactly what resolveMonsterReward.picks selects by — must match the resolver.
		expect(resolved.options.map((o) => o.index)).toEqual([0, 1]);
	});

	test('no pendingReward → no resolved reward', () => {
		const state = inPhase(2, 'location');
		clearWork(state, 'Red');
		expect(computeAffordances(state, 'Red', CATALOG).pendingReward).toBeUndefined();
		expect(computePendingReward(state.players.Red!)).toBeUndefined();
	});
});

// ── §5.4 corruptionDiscard / overflow descriptor detail ───────────────────────────────
describe('describePendingWork — §5.4 corruption + overflow detail', () => {
	test('corruptionDiscard carries its reason + eligible spirit slots', () => {
		const state = inPhase(7, 'cleanup');
		clearWork(state, 'Red');
		const red = state.players.Red!;
		red.spirits = [
			{ slotIndex: 1, id: 'a', name: 'A', cost: 2, classes: {}, origins: {}, isFaceDown: false },
			{ slotIndex: 2, id: 'b', name: 'B', cost: 2, classes: {}, origins: {}, isFaceDown: false }
		];
		red.pendingCorruptionDiscard = { count: 1, reason: 'You corrupted fighting the monster' };
		const cd = describePendingWork(state, red).find((w) => w.kind === 'corruptionDiscard')!;
		expect(cd.eligibleSpiritSlots).toEqual([1, 2]);
		expect(cd.reason).toBe('You corrupted fighting the monster');
	});

	test('overflow carries the held-rune mat slotIndexes to trim', () => {
		const state = inPhase(7, 'cleanup');
		clearWork(state, 'Red');
		state.players.Red!.mats = [10, 11, 12, 13, 14].map(
			(slotIndex) => ({ slotIndex, hasRune: true, guid: `r${slotIndex}` }) as MatSlotSnapshot
		);
		const ov = describePendingWork(state, state.players.Red!).find((w) => w.kind === 'overflow')!;
		expect(ov.count).toBe(1);
		expect(ov.heldRuneSlotIndexes).toEqual([10, 11, 12, 13, 14]);
	});
});

// ── §5.4 augment placement eligibility (replaces client isAugmentEligible, S5) ─────────
describe('augment placement eligibility (§5.4, S5)', () => {
	/** Fresh Red with three spirits (Fighter, none, Fighter) + one host-class-bound augment. */
	function augState(): PublicGameState {
		const state = startedGame();
		const red = state.players.Red!;
		red.spirits = [
			{ slotIndex: 1, id: 'a', name: 'A', cost: 2, classes: { Fighter: 1 }, origins: {}, isFaceDown: false },
			{ slotIndex: 2, id: 'b', name: 'B', cost: 2, classes: {}, origins: {}, isFaceDown: false },
			{ slotIndex: 3, id: 'c', name: 'C', cost: 2, classes: { Fighter: 1 }, origins: {}, isFaceDown: false }
		];
		red.unplacedAugments = [{ runeId: 'aug-1', name: 'Aug', hostClass: 'Fighter' }];
		red.spiritAugmentAttachments = [];
		return state;
	}

	test('eligibleSpiritSlots EXACTLY matches the slots where placeAugmentOnSpirit succeeds', () => {
		const augment = augState().players.Red!.unplacedAugments![0];
		const elig = augmentPlacementEligibility(augState().players.Red!, augment);
		// hostClass Fighter → slots 1 and 3; slot 2 locked with a reason.
		expect(elig.eligibleSpiritSlots).toEqual([1, 3]);
		expect(elig.slotReasons[2]).toBe('Needs Fighter');

		// Ground truth: for each slot, does the reducer actually accept the placement?
		const accepted: number[] = [];
		for (const slot of [1, 2, 3]) {
			const result = applyGameCommand(
				augState(),
				RED,
				{ type: 'placeAugmentOnSpirit', augmentIndex: 0, augmentRuneId: 'aug-1', spiritSlotIndex: slot, className: 'Fighter' },
				CATALOG
			);
			if (result.ok) accepted.push(slot);
		}
		expect(accepted).toEqual(elig.eligibleSpiritSlots);
	});

	test('a full spirit (capacity reached) is ineligible with a reason', () => {
		const state = augState();
		const red = state.players.Red!;
		// Fill slot 1 (default capacity 1) with a class-linked augment.
		red.spiritAugmentAttachments = [
			{ runeId: 'x', spiritId: 'a', spiritSlotIndex: 1, name: 'Fighter Augment', className: 'Fighter' }
		];
		const unbound = { runeId: 'aug-2', name: 'Aug2' };
		red.unplacedAugments = [unbound];
		const elig = augmentPlacementEligibility(red, unbound);
		expect(elig.eligibleSpiritSlots).toEqual([2, 3]); // 1 is full
		expect(elig.slotReasons[1]).toBe('Augment slots full');
	});

	test('classChoices: unbound offers all six; a classId-bound augment offers only its class', () => {
		expect(augmentClassChoices({ runeId: 'g', name: 'Aug' })).toEqual([...SPIRIT_AUGMENT_CLASSES]);
		const catalogWithClass: PlayCatalog = {
			...CATALOG,
			classes: [{ id: 'cls-fi', name: 'Fighter', classType: null, isSpecial: false, effectSchema: null }]
		};
		expect(augmentClassChoices({ runeId: 'g', name: 'Aug', classId: 'cls-fi' }, catalogWithClass)).toEqual(['Fighter']);
	});

	test('the augment pendingWork descriptor carries per-token placement + class choices', () => {
		const state = augState();
		const aug = describePendingWork(state, state.players.Red!, CATALOG).find((w) => w.kind === 'augment')!;
		expect(aug.augments).toHaveLength(1);
		expect(aug.augments![0]).toMatchObject({
			runeId: 'aug-1',
			eligibleSpiritSlots: [1, 3],
			classChoices: [...SPIRIT_AUGMENT_CLASSES]
		});
		expect(aug.augments![0].slotReasons[2]).toBe('Needs Fighter');
	});
});

// ── §5.4 decision pickerSpec ──────────────────────────────────────────────────────────
describe('decision pickerSpec (§5.4)', () => {
	test('an arcMageTrade decision surfaces a pickerSpec; a plain Yes/No does not', () => {
		const state = inPhase(3, 'awakening');
		clearWork(state, 'Red');
		const red = state.players.Red!;
		red.attackDice = [
			{ instanceId: 'x1', tier: 'basic' },
			{ instanceId: 'x2', tier: 'basic' },
			{ instanceId: 'x3', tier: 'enchanted' },
			{ instanceId: 'x4', tier: 'exalted' },
			{ instanceId: 'x5', tier: 'arcane' }
		];
		red.pendingDecisions = [
			{ id: 'd-arc', source: 'class', kind: 'arcMageTrade', prompt: 'p', options: [{ id: 'yes', label: 'Y' }, { id: 'no', label: 'N' }] },
			{ id: 'd-plain', source: 'class', kind: 'plainYesNo', prompt: 'p', options: [{ id: 'yes', label: 'Y' }] }
		];
		const dec = describePendingWork(state, red).find((w) => w.kind === 'decision')!;
		expect(dec.pickerSpecs).toHaveLength(1);
		expect(dec.pickerSpecs![0]).toEqual({
			decisionId: 'd-arc',
			kind: 'attackDice',
			count: 4,
			eligibleInstanceIds: ['x1', 'x2', 'x3', 'x4', 'x5']
		});
		expect(decisionPickerSpec(red.pendingDecisions[1], red)).toBeNull();

		const strategist = {
			id: 'd-strategist',
			source: 'class' as const,
			kind: 'strategistTrade',
			prompt: 'p',
			options: [{ id: 'yes', label: 'Y' }, { id: 'no', label: 'N' }]
		};
		expect(decisionPickerSpec(strategist, red)).toMatchObject({ count: 3, kind: 'attackDice' });
		expect(
			decisionPickerSpec(strategist, {
				...red,
				attackDice: red.attackDice.slice(0, 3)
			})
		).toBeNull();
		expect(
			decisionPickerSpec(strategist, {
				...red,
				attackDice: red.attackDice.map((die) => ({ ...die, tier: 'basic' as const }))
			})
		).toBeNull();
	});
});

// ── §5.4 encounter + infiltratorSwap affordances (voluntary — NOT pendingWork) ─────────
describe('encounter + infiltrator affordances (§5.4)', () => {
	test('an Evil seat co-located with a Good player gets an encounter affordance; a Good seat none', () => {
		const state = inPhase(4, 'encounter');
		const red = state.players.Red!;
		const blue = state.players.Blue!;
		red.statusLevel = 3; // Fallen ⇒ Evil
		red.navigationDestination = 'Cyber City';
		red.encounterVote = null;
		blue.statusLevel = 0;
		blue.navigationDestination = 'Cyber City';
		expect(computeAffordances(state, 'Red', CATALOG).encounter).toEqual({
			eligibleTargets: ['Blue'],
			votesPending: ['Red']
		});
		expect(computeAffordances(state, 'Blue', CATALOG).encounter).toBeUndefined();
		expect(computeEncounter(state, blue, 'Blue')).toBeUndefined();
	});

	test('an awakened, unused Infiltrator co-located with a player gets a swap affordance', () => {
		const state = inPhase(4, 'location');
		const red = state.players.Red!;
		const blue = state.players.Blue!;
		red.navigationDestination = 'Cyber City';
		red.actionsUsedThisRound = [];
		red.spirits = [
			{ slotIndex: 1, id: 'inf', name: 'Infil', cost: 2, classes: { Infiltrator: 1 }, origins: {}, isFaceDown: false }
		];
		red.attackDice = [{ instanceId: 'r1', tier: 'basic' }];
		blue.navigationDestination = 'Cyber City';
		blue.attackDice = [
			{ instanceId: 'b1', tier: 'enchanted' },
			{ instanceId: 'b2', tier: 'exalted' }
		];
		expect(computeAffordances(state, 'Red', CATALOG).infiltratorSwap).toEqual({
			targets: [{ seat: 'Blue', dice: [{ instanceId: 'b1', tier: 'enchanted' }, { instanceId: 'b2', tier: 'exalted' }] }],
			myDice: [{ instanceId: 'r1', tier: 'basic' }]
		});
		// A face-down Infiltrator can't act.
		red.spirits[0].isFaceDown = true;
		expect(computeInfiltratorSwap(state, red, 'Red')).toBeUndefined();
		// Already used this round.
		red.spirits[0].isFaceDown = false;
		red.actionsUsedThisRound = ['infiltratorSwap'];
		expect(computeInfiltratorSwap(state, red, 'Red')).toBeUndefined();
	});

	test('these voluntary opportunities never enter pendingWork (invariant: pendingWork ⟺ resolution work)', () => {
		const state = inPhase(4, 'encounter');
		const red = state.players.Red!;
		clearWork(state, 'Red');
		red.statusLevel = 3;
		red.navigationDestination = 'Cyber City';
		red.encounterVote = null;
		state.players.Blue!.statusLevel = 0;
		state.players.Blue!.navigationDestination = 'Cyber City';
		// An encounter opportunity exists, but the seat has NO resolution work.
		expect(computeAffordances(state, 'Red', CATALOG).encounter).toBeDefined();
		expect(seatHasResolutionWork(state, 'Red')).toBe(false);
		expect(describePendingWork(state, red)).toHaveLength(0);
	});
});

// ── Reducer hardening: F8 (spawnHandSpirit occupied slot) ──────────────────────────────
describe('reducer hardening — F8 spawnHandSpirit occupied slot', () => {
	function drawState(): PublicGameState {
		const state = startedGame();
		state.phase = 'location';
		const red = state.players.Red!;
		red.spirits = [{ slotIndex: 1, id: 's-0', name: 'Resident', cost: 2, classes: {}, origins: {}, isFaceDown: false }];
		red.pendingDraw = { sourceBag: 'Spirit World Bag', drawCount: 1, summonLimit: 1, summonedCount: 0 };
		red.handDraws = [{ guid: 'g1', id: 's-1' }] as never;
		return state;
	}

	test('an explicit occupied slotIndex is REJECTED (was a silent overwrite)', () => {
		expect(reject(drawState(), RED, { type: 'spawnHandSpirit', guid: 'g1', slotIndex: 1 }).code).toBe(
			'slot_occupied'
		);
	});

	test('the default (no slotIndex) path still summons into an open slot', () => {
		const next = apply(drawState(), RED, { type: 'spawnHandSpirit', guid: 'g1' });
		expect(next.players.Red!.spirits.map((s) => s.slotIndex).sort()).toEqual([1, 2]);
	});
});

// ── Reducer hardening: F9 (resolveDecision unknown option) + picker selection ──────────
describe('reducer hardening — F9 resolveDecision option + arcMage picker', () => {
	function decisionState(kind: string): PublicGameState {
		const state = startedGame();
		state.phase = 'awakening';
		state.players.Red!.pendingDecisions = [
			{ id: 'd1', source: 'class', kind, prompt: 'p', options: [{ id: 'yes', label: 'Y' }, { id: 'no', label: 'N' }] }
		];
		return state;
	}

	test('an optionId not among the options is REJECTED (was a silent no-op consume)', () => {
		expect(reject(decisionState('plainYesNo'), RED, { type: 'resolveDecision', decisionId: 'd1', optionId: 'bogus' }).code).toBe(
			'invalid_option'
		);
	});

	test('a valid option resolves and consumes the decision', () => {
		const next = apply(decisionState('plainYesNo'), RED, { type: 'resolveDecision', decisionId: 'd1', optionId: 'no' });
		expect(next.players.Red!.pendingDecisions).toHaveLength(0);
	});

	function arcState(): PublicGameState {
		const state = decisionState('arcMageTrade');
		state.players.Red!.attackDice = [
			{ instanceId: 'a1', tier: 'basic' },
			{ instanceId: 'a2', tier: 'basic' },
			{ instanceId: 'a3', tier: 'basic' },
			{ instanceId: 'a4', tier: 'basic' },
			{ instanceId: 'a5', tier: 'exalted' }
		];
		return state;
	}

	test('a wrong-COUNT picker selection is REJECTED (was silently auto-picked)', () => {
		expect(
			reject(arcState(), RED, { type: 'resolveDecision', decisionId: 'd1', optionId: 'yes', selectedInstanceIds: ['a1', 'a2'] }).code
		).toBe('invalid_selection');
	});

	test('a non-owned die in the selection is REJECTED', () => {
		expect(
			reject(arcState(), RED, { type: 'resolveDecision', decisionId: 'd1', optionId: 'yes', selectedInstanceIds: ['a1', 'a2', 'a3', 'nope'] }).code
		).toBe('invalid_selection');
	});

	test('exactly 4 owned dice convert to 1 arcane', () => {
		const next = apply(arcState(), RED, {
			type: 'resolveDecision',
			decisionId: 'd1',
			optionId: 'yes',
			selectedInstanceIds: ['a1', 'a2', 'a3', 'a4']
		});
		const dice = next.players.Red!.attackDice;
		expect(dice.filter((d) => d.tier === 'arcane')).toHaveLength(1);
		expect(dice).toHaveLength(2); // 5 − 4 + 1
	});

	test('an OMITTED selection keeps the resolver auto-pick (bot path) — never rejected', () => {
		const next = apply(arcState(), RED, { type: 'resolveDecision', decisionId: 'd1', optionId: 'yes' });
		expect(next.players.Red!.attackDice.filter((d) => d.tier === 'arcane')).toHaveLength(1);
	});
});

// ── Bot compat: the enumerator never generates the now-rejected shapes ─────────────────
describe('bot enumerator never generates the now-rejected command shapes', () => {
	function collect(state: PublicGameState, seat: 'Red'): GameCommand[] {
		const out: GameCommand[] = [];
		enumerateCandidates(state, seat, CATALOG, (c) => out.push(c));
		return out;
	}

	test('spawnHandSpirit candidates never carry an explicit slotIndex (F8-safe)', () => {
		const state = startedGame();
		state.phase = 'location';
		const red = state.players.Red!;
		red.navigationDestination = 'Cyber City';
		red.handDraws = [{ guid: 'g1', id: 's-1' }, { guid: 'g2', id: 's-2' }] as never;
		const spawns = collect(state, 'Red').filter(
			(c): c is Extract<GameCommand, { type: 'spawnHandSpirit' }> => c.type === 'spawnHandSpirit'
		);
		expect(spawns.length).toBeGreaterThan(0);
		expect(spawns.every((c) => c.slotIndex === undefined)).toBe(true);
	});

	test('resolveDecision candidates use listed optionIds and never a selection (F9 + picker-safe)', () => {
		const state = startedGame();
		state.phase = 'awakening';
		state.players.Red!.pendingDecisions = [
			{ id: 'arc', source: 'class', kind: 'arcMageTrade', prompt: 'p', options: [{ id: 'yes', label: 'Y' }, { id: 'no', label: 'N' }] }
		];
		const decs = collect(state, 'Red').filter(
			(c): c is Extract<GameCommand, { type: 'resolveDecision' }> => c.type === 'resolveDecision'
		);
		expect(decs.length).toBe(2);
		expect(decs.every((c) => ['yes', 'no'].includes(c.optionId))).toBe(true);
		expect(decs.every((c) => c.selectedInstanceIds === undefined)).toBe(true);
	});

	test('infiltratorSwap is never enumerated for a bot', () => {
		const state = startedGame();
		state.phase = 'location';
		const red = state.players.Red!;
		red.navigationDestination = 'Cyber City';
		red.spirits = [{ slotIndex: 1, id: 'inf', name: 'Infil', cost: 2, classes: { Infiltrator: 1 }, origins: {}, isFaceDown: false }];
		red.attackDice = [{ instanceId: 'r1', tier: 'basic' }];
		state.players.Blue!.navigationDestination = 'Cyber City';
		state.players.Blue!.attackDice = [{ instanceId: 'b1', tier: 'basic' }];
		expect(collect(state, 'Red').some((c) => c.type === 'infiltratorSwap')).toBe(false);
	});
});
