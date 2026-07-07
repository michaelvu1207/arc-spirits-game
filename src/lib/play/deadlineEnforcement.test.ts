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
import {
	applyGameCommand,
	applyDeadlineAdvance,
	resolvePassedDeadline,
	createLobbyState
} from './runtime';
import type {
	GameActor,
	GameCommand,
	NavigationDestination,
	PendingRewardState,
	PlayCatalog,
	PublicGameState
} from './types';
import { DEADLINE_EXTENSION_MS, DEADLINE_MAX_EXTENSIONS } from './types';
import { enterBenefits, enterAwakening, enterCleanup } from './phases';
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

/**
 * Regression for the "reward yanked at the deadline" bug: the raw force-advance
 * (`applyDeadlineAdvance`) silently auto-claims an unclaimed monster reward — making its
 * `chooseRune` picks for the player — even when a present human is mid-choice in the reward
 * takeover. `resolvePassedDeadline` fixes it: a present, non-bot seat holding a
 * blocking obligation EXTENDS the deadline instead, bounded so a disconnected seat can't
 * hold the room hostage (the backstop still auto-claims once the budget is spent).
 *
 * These tests would FAIL if `resolvePassedDeadline` were the old unconditional advance:
 * the "extends" cases assert the phase does NOT advance and the reward stays intact — the
 * exact opposite of what a plain `applyDeadlineAdvance` does (see the first test, which
 * characterizes that buggy behavior as the surviving backstop).
 */
describe('location deadline extension (resolvePassedDeadline)', () => {
	// A minimal monster reward. An empty track claims nothing, so the backstop auto-claim is
	// observable purely as `pendingReward → null` without needing a real reward-token id.
	function fakeReward(): PendingRewardState {
		return { monsterId: 'm1', monsterName: 'Wraith', rewardTrack: [], chooseAmount: 0 };
	}

	test('a fresh Location phase starts with a zero extension budget', () => {
		expect(locationPhase().phaseDeadlineExtensions).toBe(0);
	});

	test('the raw force-advance silently auto-claims a held reward (the surviving backstop)', () => {
		const state = locationPhase();
		state.players.Red!.pendingReward = fakeReward();
		applyDeadlineAdvance(state, CATALOG);
		// This IS the bug when applied to a present player — retained ONLY as the deadlock backstop.
		expect(state.players.Red?.pendingReward ?? null).toBeNull();
		expect(state.phase).not.toBe('location');
	});

	test('a present human holding a reward EXTENDS instead of advancing — reward left intact', () => {
		const state = locationPhase();
		state.players.Red!.pendingReward = fakeReward();
		state.phaseDeadline = 1000;
		const now = 5000;

		const outcome = resolvePassedDeadline(state, CATALOG, now, []);

		expect(outcome).toBe('extended');
		expect(state.phase).toBe('location'); // did NOT advance past the active player
		expect(state.players.Red?.pendingReward ?? null).not.toBeNull(); // reward untouched, not auto-picked
		expect(state.phaseDeadlineExtensions).toBe(1);
		expect(state.phaseDeadline).toBe(now + DEADLINE_EXTENSION_MS); // re-stamped forward
	});

	test('a seat mid-combat (unresolved CombatState) extends — no yank between roll and reward', () => {
		const state = locationPhase();
		state.combats = [
			{
				id: 'c1',
				kind: 'monster',
				step: 'roll',
				sides: [{ seat: 'Red', initiative: 0, rolled: false, damageDealt: 0 }],
				monster: null,
				log: [],
				killed: false
			}
		];
		state.phaseDeadline = 1000;

		const outcome = resolvePassedDeadline(state, CATALOG, 5000, []);

		expect(outcome).toBe('extended');
		expect(state.phase).toBe('location'); // combat not abandoned mid-roll
		expect(state.combats.length).toBe(1);

		// A RESOLVED combat no longer blocks: same shape with step 'resolved' advances.
		const done = locationPhase();
		done.combats = [
			{
				id: 'c2',
				kind: 'monster',
				step: 'resolved',
				sides: [{ seat: 'Red', initiative: 0, rolled: true, damageDealt: 3 }],
				monster: null,
				log: [],
				killed: true
			}
		];
		done.phaseDeadline = 1000;
		expect(resolvePassedDeadline(done, CATALOG, 5000, [])).toBe('advanced');
	});

	test('an in-flight summon (draw obligation) also extends rather than being returned', () => {
		const state = apply(locationPhase(), RED, {
			type: 'resolveLocationInteraction',
			rowIndex: 0,
			choices: []
		});
		expect(state.players.Red?.handDraws.length ?? 0).toBeGreaterThan(0);

		const outcome = resolvePassedDeadline(state, CATALOG, 5000, []);

		expect(outcome).toBe('extended');
		expect(state.phase).toBe('location');
		expect(state.players.Red?.handDraws.length ?? 0).toBeGreaterThan(0); // draw kept, not drained
	});

	test('a bot-held reward advances immediately — bots are never extended for', () => {
		const state = locationPhase();
		state.players.Red!.pendingReward = fakeReward();

		const outcome = resolvePassedDeadline(state, CATALOG, 5000, ['Red']); // Red seated by a bot

		expect(outcome).toBe('advanced');
		expect(state.phaseDeadlineExtensions).toBe(0);
		expect(state.phase).not.toBe('location');
	});

	test('an idle seat with no obligation advances at the deadline (existing behavior kept)', () => {
		const state = locationPhase();
		const outcome = resolvePassedDeadline(state, CATALOG, 5000, []);
		expect(outcome).toBe('advanced');
		expect(state.phase).not.toBe('location');
	});

	test('extensions are bounded: after the budget the backstop advances + auto-claims', () => {
		const state = locationPhase();
		state.players.Red!.pendingReward = fakeReward();
		let now = 1000;

		for (let i = 0; i < DEADLINE_MAX_EXTENSIONS; i += 1) {
			now += DEADLINE_EXTENSION_MS + 1;
			expect(resolvePassedDeadline(state, CATALOG, now, [])).toBe('extended');
		}
		expect(state.phaseDeadlineExtensions).toBe(DEADLINE_MAX_EXTENSIONS);
		expect(state.phase).toBe('location'); // still protected up to the cap

		now += DEADLINE_EXTENSION_MS + 1;
		expect(resolvePassedDeadline(state, CATALOG, now, [])).toBe('advanced'); // hostage cap reached
		expect(state.players.Red?.pendingReward ?? null).toBeNull(); // backstop auto-claim (deadlock beats hostage)
		expect(state.phase).not.toBe('location');
	});
});

/**
 * Extension coverage for the three post-location resolution phases (Benefits, Awakening,
 * Cleanup), the twin of the Location bug: a forced advance past their deadline silently
 * resolves an open obligation FOR the player — Benefits auto-claims the round's grants with
 * default Tainted-split + relic picks, Awakening abandons an un-resolved decision / flip,
 * Cleanup auto-sacrifices spirits for a corruption debt. `resolvePassedDeadline` now extends
 * for a present, non-bot seat in ANY of these phases (blocking work mirrors
 * `seatHasResolutionWork`), bounded by the same per-phase grace budget.
 *
 * Each "extends" case is a regression that FAILS against the pre-fix engine, whose
 * `resolvePassedDeadline` extended for the Location phase ONLY and unconditionally advanced
 * (auto-resolving the obligation) in every resolution phase — the exact opposite of these
 * assertions. The paired "backstop" case characterizes that surviving force-resolve.
 */
describe('resolution-phase deadline extension (resolvePassedDeadline)', () => {
	/** A location-phase game re-pointed at a resolution phase with a fresh grace budget —
	 *  the state the server holds when a resolution step opens. */
	function resolutionPhase(phase: 'benefits' | 'awakening' | 'cleanup'): PublicGameState {
		const state = locationPhase();
		state.phase = phase;
		state.phaseDeadlineExtensions = 0;
		state.phaseDeadline = 1000;
		return state;
	}

	// ── Benefits ────────────────────────────────────────────────────────────────
	describe('benefits', () => {
		// A minimal unclaimed grant. `resolveAwakenReward` is the only honest way to clear it;
		// a forced advance drains it via applyAwakenRewardClaim with default picks.
		function grantReward(state: PublicGameState) {
			state.players.Red!.pendingAwakenReward = {
				grants: [{ kind: 'vp', amount: 1, source: 'World Guardian' }]
			};
		}

		test('the raw force-advance silently auto-claims the round grants (surviving backstop)', () => {
			const state = resolutionPhase('benefits');
			grantReward(state);
			applyDeadlineAdvance(state, CATALOG);
			// Claimed FOR the player (default picks) — the bug, kept only as the deadlock backstop.
			expect(state.players.Red?.pendingAwakenReward ?? null).toBeNull();
			expect(state.phase).not.toBe('benefits');
		});

		test('a present human with an unclaimed grant EXTENDS — grant left intact, not auto-picked', () => {
			const state = resolutionPhase('benefits');
			grantReward(state);

			const outcome = resolvePassedDeadline(state, CATALOG, 5000, []);

			expect(outcome).toBe('extended');
			expect(state.phase).toBe('benefits'); // did NOT advance past the deliberating player
			expect(state.players.Red?.pendingAwakenReward ?? null).not.toBeNull(); // grant untouched
			expect(state.phaseDeadlineExtensions).toBe(1);
			expect(state.phaseDeadline).toBe(5000 + DEADLINE_EXTENSION_MS);
		});

		test('a bot-held grant advances immediately — bots are never extended for', () => {
			const state = resolutionPhase('benefits');
			grantReward(state);
			const outcome = resolvePassedDeadline(state, CATALOG, 5000, ['Red']);
			expect(outcome).toBe('advanced');
			expect(state.phaseDeadlineExtensions).toBe(0);
			expect(state.phase).not.toBe('benefits');
		});
	});

	// ── Awakening ───────────────────────────────────────────────────────────────
	describe('awakening', () => {
		// A pending decision card — a real choice `seatHasResolutionWork` reports for awakening;
		// a forced advance drops it unresolved (the abandonment harm).
		function pendDecision(state: PublicGameState) {
			state.players.Red!.pendingDecisions = [
				{
					id: 'dec1',
					source: 'class',
					kind: 'test',
					prompt: 'Choose one',
					options: [
						{ id: 'a', label: 'A' },
						{ id: 'b', label: 'B' }
					]
				}
			];
		}

		test('the raw force-advance abandons the pending decision (surviving backstop)', () => {
			const state = resolutionPhase('awakening');
			pendDecision(state);
			applyDeadlineAdvance(state, CATALOG);
			expect(state.phase).not.toBe('awakening'); // advanced past the unresolved choice
		});

		test('a present human mid-decision EXTENDS — the choice is not dropped', () => {
			const state = resolutionPhase('awakening');
			pendDecision(state);

			const outcome = resolvePassedDeadline(state, CATALOG, 5000, []);

			expect(outcome).toBe('extended');
			expect(state.phase).toBe('awakening');
			expect(state.players.Red?.pendingDecisions?.length ?? 0).toBe(1); // choice kept
			expect(state.phaseDeadlineExtensions).toBe(1);
		});

		test('a bot-held decision advances immediately — bots are never extended for', () => {
			const state = resolutionPhase('awakening');
			pendDecision(state);
			const outcome = resolvePassedDeadline(state, CATALOG, 5000, ['Red']);
			expect(outcome).toBe('advanced');
			expect(state.phase).not.toBe('awakening');
		});
	});

	// ── Cleanup ─────────────────────────────────────────────────────────────────
	describe('cleanup', () => {
		// A payable corruption debt (owed count + a spirit to pay it) — the Cleanup obligation
		// a forced advance auto-sacrifices highest-slot spirits to settle.
		function oweCorruption(state: PublicGameState) {
			state.players.Red!.spirits = [
				{ slotIndex: 1, id: 's-x', name: 'Keeper', cost: 2, classes: {}, origins: {}, isFaceDown: false }
			];
			state.players.Red!.pendingCorruptionDiscard = { count: 1, reason: 'combat' };
		}

		test('the raw force-advance silently sacrifices a spirit for the debt (surviving backstop)', () => {
			const state = resolutionPhase('cleanup');
			oweCorruption(state);
			applyDeadlineAdvance(state, CATALOG);
			// Debt auto-paid by discarding the spirit — the silent choice, kept as the backstop.
			expect(state.players.Red?.pendingCorruptionDiscard ?? null).toBeNull();
			expect(state.players.Red?.spirits.length ?? 0).toBe(0);
			expect(state.phase).not.toBe('cleanup');
		});

		test('a present human owing a payable debt EXTENDS — no spirit auto-sacrificed', () => {
			const state = resolutionPhase('cleanup');
			oweCorruption(state);

			const outcome = resolvePassedDeadline(state, CATALOG, 5000, []);

			expect(outcome).toBe('extended');
			expect(state.phase).toBe('cleanup');
			expect(state.players.Red?.pendingCorruptionDiscard?.count ?? 0).toBe(1); // debt kept
			expect(state.players.Red?.spirits.length ?? 0).toBe(1); // spirit not sacrificed
			expect(state.phaseDeadlineExtensions).toBe(1);
		});

		test('a bot-owed debt advances immediately — bots are never extended for', () => {
			const state = resolutionPhase('cleanup');
			oweCorruption(state);
			const outcome = resolvePassedDeadline(state, CATALOG, 5000, ['Red']);
			expect(outcome).toBe('advanced');
			expect(state.phase).not.toBe('cleanup');
		});
	});

	// ── Shared budget bookkeeping ─────────────────────────────────────────────────
	test('each protected phase entry resets the grace budget to zero', () => {
		const state = locationPhase();
		for (const enter of [enterBenefits, enterAwakening, enterCleanup]) {
			state.phaseDeadlineExtensions = 3; // pretend a prior phase spent grace
			enter(state, CATALOG);
			expect(state.phaseDeadlineExtensions).toBe(0);
		}
	});

	test('an idle resolution phase (no work) advances at the deadline — bots unaffected', () => {
		for (const phase of ['benefits', 'awakening', 'cleanup'] as const) {
			const state = resolutionPhase(phase);
			expect(resolvePassedDeadline(state, CATALOG, 5000, [])).toBe('advanced');
			expect(state.phase).not.toBe(phase);
		}
	});
});
