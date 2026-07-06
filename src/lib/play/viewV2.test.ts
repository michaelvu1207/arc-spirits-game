import { describe, expect, test } from 'vitest';
import { applyGameCommand, buildSessionProjection, createLobbyState } from './runtime';
import { seatHasResolutionWork } from './phases';
import type { GameActor, GameCommand, GamePhase, PlayCatalog, PublicGameState } from './types';
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
