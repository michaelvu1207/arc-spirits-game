/**
 * P0 robustness: server-authoritative, host-INDEPENDENT phase advance used when a
 * phase runs past its deadline. `applyDeadlineAdvance` is the pure engine half of
 * the opportunistic enforcement wired into the server in `server/service.ts`
 * (`enforceRoomDeadlines` / `maybeEnforceDeadline`); the clock comparison lives at
 * the server boundary so the reducer stays pure. These tests cover the four phases
 * advancing past a silent seat and — critically — that an in-progress summon's
 * drawn spirits are returned to their bag instead of leaking.
 */
import { describe, expect, test } from 'vitest';
import { applyGameCommand, applyDeadlineAdvance, createLobbyState } from './runtime';
import type {
	GameActor,
	GameCommand,
	NavigationDestination,
	PlayCatalog,
	PublicGameState
} from './types';
import type { GameLocationRewardRow } from '$lib/types';

const HOST: GameActor = { memberId: 'm-host', displayName: 'Host', role: 'host', seatColor: null };
const GUEST: GameActor = { memberId: 'm-guest', displayName: 'Guest', role: 'player', seatColor: null };
const RED: GameActor = { ...HOST, seatColor: 'Red' };
const BLUE: GameActor = { ...GUEST, seatColor: 'Blue' };

// Reward-row icon ids (mirror the live DB content). A location's available actions
// ARE its reward rows — the only way to summon is to resolve a row whose gain is a
// Summon action token.
const SUMMON = '76e58219-e805-4b94-acf4-6d62dfe4c515';
// Tidal Cove row 0 is a free Spirit World Summon (draw 4, summon 2).
const TIDAL_COVE_ROWS: GameLocationRewardRow[] = [{ type: 'gain', gain_icon_ids: [SUMMON] }];

// A generous spirit pool so a 4-card Spirit World summon always has stock after the
// market is filled at game start.
const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-a', name: 'Myrtle', originId: 'o1' },
		{ id: 'g-b', name: 'Nyra', originId: 'o2' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack' }],
	spirits: Array.from({ length: 30 }, (_, i) => ({
		id: `s-${i}`,
		name: `Spirit ${i}`,
		cost: 2,
		classes: {},
		origins: {}
	})),
	locations: [{ name: 'Tidal Cove', originId: null, rewardRows: TIDAL_COVE_ROWS }]
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

/**
 * Drive a fresh game into the location phase. Both seats lock onto `redDest` (a Good
 * location), so the encounter phase auto-skips straight to the Location phase with RED
 * standing at `redDest`. Defaults to Tidal Cove, whose row 0 is a free Spirit World
 * Summon.
 */
function locationPhase(seed = 1, redDest: NavigationDestination = 'Tidal Cove'): PublicGameState {
	let state = startedGame(seed);
	state = apply(state, RED, { type: 'lockNavigation', destination: redDest });
	state = apply(state, BLUE, { type: 'lockNavigation', destination: redDest });
	// Locking no longer reveals instantly; force-advance past the grace to reveal
	// (both seats already locked) → encounter auto-skips → location phase.
	state = apply(state, RED, { type: 'forceAdvancePhase' });
	return state;
}

describe('deadline enforcement (applyDeadlineAdvance)', () => {
	test('navigation timeout assigns random destinations and advances past silent seats', () => {
		const state = startedGame();
		expect(state.phase).toBe('navigation');

		applyDeadlineAdvance(state, CATALOG);

		expect(state.revealedDestinations).toBe(true);
		// reveal → encounter auto-skip → location, with every seat given a destination.
		expect(state.phase).toBe('location');
		expect(state.players.Red?.navigationDestination).toBeTruthy();
		expect(state.players.Blue?.navigationDestination).toBeTruthy();
	});

	test('phaseDeadline is nulled on phase entry so the server re-stamps the new phase', () => {
		const state = startedGame();
		state.phaseDeadline = 123_456; // pretend the server boundary had stamped it
		applyDeadlineAdvance(state, CATALOG);
		expect(state.phaseDeadline).toBeNull();
	});

	test('location timeout rolls the whole workless round (resolution steps auto-skip)', () => {
		const state = locationPhase();
		expect(state.phase).toBe('location');
		const round = state.round;
		applyDeadlineAdvance(state, CATALOG);
		// Neither seat has benefits/awakening/cleanup work, so the forced advance
		// chains through the empty resolution steps straight into the next round.
		expect(state.phase).toBe('navigation');
		expect(state.round).toBe(round + 1);
	});

	test('a location timeout with an open summon returns the drawn spirits to the bag (no leak)', () => {
		// RED stands at Tidal Cove, whose row 0 is a free Spirit World Summon.
		const state = locationPhase();
		const before = state.bags.hexSpirits.count;
		const round = state.round;

		const drawn = apply(state, RED, { type: 'resolveLocationInteraction', rowIndex: 0, choices: [] });
		expect(drawn.players.Red?.handDraws.length ?? 0).toBeGreaterThan(0);
		expect(drawn.bags.hexSpirits.count).toBeLessThan(before);

		applyDeadlineAdvance(drawn, CATALOG);

		// The abandoned draw is returned FIRST, leaving no resolution work — so the
		// advance rolls the whole round rather than parking in an empty benefits step.
		expect(drawn.phase).toBe('navigation');
		expect(drawn.round).toBe(round + 1);
		expect(drawn.players.Red?.pendingDraw ?? null).toBeNull();
		expect(drawn.players.Red?.handDraws ?? []).toEqual([]);
		// Bag total is conserved — the in-progress summon did NOT leak spirits.
		expect(drawn.bags.hexSpirits.count).toBe(before);
	});

	test('the advance bumps revision so the persistence CAS sees a change', () => {
		const state = locationPhase();
		const rev = state.revision;
		applyDeadlineAdvance(state, CATALOG);
		expect(state.revision).toBe(rev + 1);
	});

	test('is a no-op when the game is not active', () => {
		const lobby = createLobbyState({ roomCode: 'ROOM42', guardianNames: ['Myrtle', 'Nyra'] });
		const rev = lobby.revision;
		applyDeadlineAdvance(lobby, CATALOG);
		expect(lobby.status).toBe('lobby');
		expect(lobby.revision).toBe(rev);
	});
});
