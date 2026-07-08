import { describe, expect, test } from 'vitest';
import { applyGameCommand, buildSessionProjection, createLobbyState } from './runtime';
import { RUNE_CARRY_LIMIT } from './types';
import type { GameActor, GameCommand, PlayCatalog, PublicGameState } from './types';

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

describe('phase machine', () => {
	test('startGame begins round 1 in the navigation phase', () => {
		const state = startedGame();
		expect(state.status).toBe('active');
		expect(state.round).toBe(1);
		expect(state.phase).toBe('navigation');
		expect(state.revealedDestinations).toBe(false);
		expect(state.navigation.Red).toEqual({ locked: false });
		expect(state.navigation.Blue).toEqual({ locked: false });
	});

	test('navigation only reveals once every active seat has locked', () => {
		let state = startedGame();
		state = apply(state, RED, { type: 'lockNavigation', destination: 'Cyber City' });
		expect(state.revealedDestinations).toBe(false);
		expect(state.phase).toBe('navigation');

		state = apply(state, BLUE, { type: 'lockNavigation', destination: 'Tidal Cove' });
		// Locking no longer reveals instantly — the round waits for the deadline.
		expect(state.revealedDestinations).toBe(false);
		state = apply(state, RED, { type: 'forceAdvancePhase' });
		expect(state.revealedDestinations).toBe(true);
		// Encounter auto-skips in P0 → straight to location.
		expect(state.phase).toBe('location');
		expect(state.locationOccupancy['Cyber City']).toEqual(['Red']);
		expect(state.locationOccupancy['Tidal Cove']).toEqual(['Blue']);
		expect(state.players.Red?.navigationDestination).toBe('Cyber City');
	});

	test("a player's pending destination is hidden from other viewers until reveal", () => {
		let state = startedGame();
		state = apply(state, RED, { type: 'lockNavigation', destination: 'Cyber City' });

		const blueView = buildSessionProjection(state, { role: 'player', seatColor: 'Blue', displayName: 'Guest' });
		expect(blueView.players.Red?.pendingDestination).toBeNull();
		expect(blueView.players.Red?.navigationDestination ?? null).toBeNull();

		const redView = buildSessionProjection(state, { role: 'host', seatColor: 'Red', displayName: 'Host' });
		expect(redView.players.Red?.pendingDestination).toBe('Cyber City');
	});

	test('full round: with no resolution work, ending location collapses straight to the next round', () => {
		let state = startedGame();
		state = apply(state, RED, { type: 'lockNavigation', destination: 'Cyber City' });
		state = apply(state, BLUE, { type: 'lockNavigation', destination: 'Tidal Cove' });
		state = apply(state, RED, { type: 'forceAdvancePhase' });
		expect(state.phase).toBe('location');

		state = apply(state, RED, { type: 'endLocationActions' });
		expect(state.phase).toBe('location'); // still waiting on Blue
		state = apply(state, BLUE, { type: 'endLocationActions' });
		// Neither seat has a benefits claim, an awaken offer, or cleanup housekeeping,
		// so the whole benefits → awakening → cleanup sequence auto-collapses inside
		// this one command: clients never see the empty steps.
		expect(state.round).toBe(2);
		expect(state.phase).toBe('navigation');
		expect(state.revealedDestinations).toBe(false);
		expect(state.players.Red?.navigationDestination ?? null).toBeNull();
		expect(state.players.Red?.phaseReady).toBe(false);
		// The round boundary still ran its bookkeeping (per-round VP snapshot).
		expect(state.players.Red?.vpHistory).toHaveLength(1);
	});

	test('reaching the VP target finishes the game when cleanup closes', () => {
		let state = startedGame();
		state = apply(state, RED, { type: 'lockNavigation', destination: 'Cyber City' });
		state = apply(state, BLUE, { type: 'lockNavigation', destination: 'Tidal Cove' });
		state = apply(state, RED, { type: 'forceAdvancePhase' });
		state = apply(state, RED, { type: 'endLocationActions' });
		// Simulate Red having amassed enough VP this round — set BEFORE the round wraps,
		// since the workless resolution sequence collapses on the last location pass.
		state.players.Red!.victoryPoints = 30;
		state = apply(state, BLUE, { type: 'endLocationActions' });
		expect(state.status).toBe('finished');
		expect(state.winnerSeat).toBe('Red');
	});

	test('host can force navigation to reveal without all locks', () => {
		let state = startedGame();
		state = apply(state, RED, { type: 'lockNavigation', destination: 'Cyber City' });
		// Blue has not locked; host forces the phase forward.
		state = apply(state, HOST, { type: 'forceAdvancePhase' });
		expect(state.revealedDestinations).toBe(true);
		expect(state.phase).toBe('location');
	});

	test('non-host cannot force the phase', () => {
		const state = startedGame();
		const result = applyGameCommand(state, BLUE, { type: 'forceAdvancePhase' }, CATALOG);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('host_required');
	});

	test('same seed reproduces the same game id (deterministic rng)', () => {
		expect(startedGame(99).gameId).toBe(startedGame(99).gameId);
	});

	test('rejects an invalid navigation destination', () => {
		const state = startedGame();
		const result = applyGameCommand(
			state,
			RED,
			{ type: 'lockNavigation', destination: 'Nowhere' as never },
			CATALOG
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('destination_invalid');
	});
});

describe('encounter / PvP', () => {
	test('no mixed alignment auto-skips the encounter to the location phase', () => {
		let state = startedGame();
		state = apply(state, RED, { type: 'lockNavigation', destination: 'Cyber City' });
		state = apply(state, BLUE, { type: 'lockNavigation', destination: 'Cyber City' });
		state = apply(state, RED, { type: 'forceAdvancePhase' });
		expect(state.phase).toBe('location');
	});

	test('an Evil player can strike a co-located Good player, then the encounter resolves', () => {
		let state = startedGame();
		state = apply(state, RED, { type: 'lockNavigation', destination: 'Cyber City' });
		// Turn Red Evil (Fallen) with an attack die before the reveal fires.
		state.players.Red!.statusLevel = 3;
		state.players.Red!.statusToken = 'Fallen';
		state.players.Red!.attackDice = [{ instanceId: 'a', tier: 'arcane' }];
		state = apply(state, BLUE, { type: 'lockNavigation', destination: 'Cyber City' });
		state = apply(state, RED, { type: 'forceAdvancePhase' });
		expect(state.phase).toBe('encounter');

		const blueBarrierBefore = state.players.Blue!.barrier;
		state = apply(state, RED, { type: 'initiatePvp' });
		// 2 VP for engaging + 2 per corrupted Good player.
		const pvp = state.combats.find((c) => c.kind === 'pvp')!;
		const corruptedGood = pvp.sides.filter((s) => s.side === 'good' && s.corrupted).length;
		expect(state.players.Red!.victoryPoints).toBe(2 + 2 * corruptedGood);
		expect(state.players.Blue!.barrier).toBeLessThan(blueBarrierBefore);
		expect(state.phase).toBe('location');
	});

	test('Good players cannot initiate PvP', () => {
		let state = startedGame();
		state = apply(state, RED, { type: 'lockNavigation', destination: 'Cyber City' });
		state.players.Red!.statusLevel = 3;
		state.players.Red!.statusToken = 'Fallen';
		state = apply(state, BLUE, { type: 'lockNavigation', destination: 'Cyber City' });
		state = apply(state, RED, { type: 'forceAdvancePhase' });
		const result = applyGameCommand(state, BLUE, { type: 'initiatePvp' }, CATALOG);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('not_evil');
	});
});

// ── P5: trigger wiring + Awakening-Phase win-cons ─────────────────────────────

const giveSpirit = (
	state: PublicGameState,
	seat: 'Red' | 'Blue',
	classes: Record<string, number>
): void => {
	state.players[seat]!.spirits = [
		{ slotIndex: 1, id: `x-${seat}`, name: `X-${seat}`, cost: 2, classes, origins: {}, isFaceDown: false }
	];
};

const lockBoth = (state: PublicGameState): PublicGameState => {
	let s = apply(state, RED, { type: 'lockNavigation', destination: 'Cyber City' });
	s = apply(s, BLUE, { type: 'lockNavigation', destination: 'Tidal Cove' });
	// Locking no longer reveals instantly — force-advance past the grace to reveal
	// (both seats already locked → their chosen destinations are kept).
	s = apply(s, RED, { type: 'forceAdvancePhase' });
	return s;
};

// End location → the resolution sequence (benefits → awakening → cleanup). The engine
// auto-readies workless seats, so the sequence stops ONLY where a seat has real work
// (e.g. a claimable Benefits reward) and otherwise collapses through to the round
// boundary. Any per-test `resolveAwakenReward` runs right after this — and claiming
// the last piece of work rolls the round over automatically (no commits needed).
const toCleanup = (state: PublicGameState): PublicGameState => {
	let s = apply(state, RED, { type: 'endLocationActions' });
	s = apply(s, BLUE, { type: 'endLocationActions' });
	return s;
};

describe('P5 onNavigate fires on reveal', () => {
	test('Deep Sea Hunter gains +4 initiative when destinations are revealed', () => {
		let state = startedGame();
		giveSpirit(state, 'Red', { 'Deep Sea Hunter': 1 });
		expect(state.players.Red!.initiative).toBe(0);
		state = lockBoth(state);
		expect(state.revealedDestinations).toBe(true);
		expect(state.players.Red!.initiative).toBe(4);
	});

	test('doubleRunes stays false for a player with no navigate class', () => {
		let state = startedGame();
		state = lockBoth(state);
		expect(state.players.Blue!.doubleRunes).toBe(false);
	});
});

describe('P5 Awakening-Phase VP win-cons at cleanup', () => {
	test('World Ender grants a flat +1 VP at cleanup (reworked, unconditional)', () => {
		let state = startedGame();
		giveSpirit(state, 'Red', { 'World Ender': 1 });
		state = lockBoth(state);
		state = toCleanup(state);
		// Reworked: World Ender is now a flat +1 VP awakeningPhase handler that fires
		// during cleanup — no alignment condition, no Cleanup claim.
		expect(state.players.Red!.victoryPoints).toBe(1);
	});

	test('World Guardian grants +6 VP at ≥24 VP while Good', () => {
		let state = startedGame();
		giveSpirit(state, 'Red', { 'World Guardian': 1 });
		state = lockBoth(state);
		state.players.Red!.victoryPoints = 24; // Good (status 0)
		state = toCleanup(state);
		state = apply(state, RED, { type: 'resolveAwakenReward', taintedMaxBarrier: 0, relicPicks: [] });
		expect(state.players.Red!.victoryPoints).toBe(30);
	});

	test('Golden Ruler grants +1 VP at cleanup and self-discards while Evil', () => {
		let state = startedGame();
		giveSpirit(state, 'Red', { 'Golden Ruler': 1 });
		state = lockBoth(state);
		state.players.Red!.statusLevel = 3; // Evil (Fallen) → must discard
		state = toCleanup(state);
		state = apply(state, RED, { type: 'resolveAwakenReward', taintedMaxBarrier: 0, relicPicks: [] });
		expect(state.players.Red!.victoryPoints).toBe(1);
		expect(state.players.Red!.spirits).toHaveLength(0); // discarded on claim while Evil
	});

	test('Golden Ruler grants +1 VP and keeps the spirit while Good', () => {
		let state = startedGame();
		giveSpirit(state, 'Red', { 'Golden Ruler': 1 });
		state = lockBoth(state);
		state = toCleanup(state);
		state = apply(state, RED, { type: 'resolveAwakenReward', taintedMaxBarrier: 0, relicPicks: [] });
		expect(state.players.Red!.victoryPoints).toBe(1);
		expect(state.players.Red!.spirits).toHaveLength(1); // kept (Good)
	});

	test('a win-con pushing a player to the VP target makes findWinner declare them THAT round', () => {
		let state = startedGame();
		giveSpirit(state, 'Red', { 'World Guardian': 1 });
		state = lockBoth(state);
		// 24 + 6 (World Guardian) = 30 = VP_TO_WIN. The +6 is a Benefits CLAIM; the
		// sequence holds open on it, and claiming (the last outstanding work) rolls the
		// round through cleanup where findWinner runs.
		state.players.Red!.victoryPoints = 24;
		state = toCleanup(state);
		expect(state.phase).toBe('benefits'); // held open by Red's unclaimed reward
		state = apply(state, RED, { type: 'resolveAwakenReward', taintedMaxBarrier: 0, relicPicks: [] });
		expect(state.players.Red!.victoryPoints).toBe(30);
		expect(state.status).toBe('finished');
		expect(state.winnerSeat).toBe('Red');
	});

	test('without the win-con grant the same player would NOT win that round (ordering proof)', () => {
		let state = startedGame();
		// No win-con spirit: 24 VP stays 24, below the 30 target.
		state = lockBoth(state);
		state.players.Red!.victoryPoints = 24;
		state = toCleanup(state);
		expect(state.status).toBe('active'); // rolled into the next round, no winner
		expect(state.round).toBe(2);
	});
});

describe('P5 determinism', () => {
	test('the same seed reproduces identical post-cleanup win-con state', () => {
		const run = (seed: number): PublicGameState => {
			let s = startedGame(seed);
			giveSpirit(s, 'Red', { 'World Ender': 1 });
			s = lockBoth(s);
			return toCleanup(s);
		};
		expect(run(7).players.Red!.victoryPoints).toBe(run(7).players.Red!.victoryPoints);
		// World Ender's flat +1 VP fires deterministically during cleanup.
		expect(run(7).players.Red!.victoryPoints).toBe(1);
	});
});

// ── Resolution-sequence auto-skip (benefits → awakening → cleanup) ────────────
// Engine-side twin of the client's old per-phase auto-pass: seats with no work are
// auto-readied at each step, so the sequence stops ONLY where a seat has something
// real to do — and resolving that work rolls the sequence forward with no commits.

describe('resolution sequence auto-skip', () => {
	const overflowRunes = (state: PublicGameState, seat: 'Red' | 'Blue', count: number): void => {
		state.players[seat]!.mats = Array.from({ length: count }, (_, i) => ({
			slotIndex: i + 1,
			hasRune: true,
			guid: `rune-${i}`,
			name: `Rune ${i}`
		}));
	};

	test('awakening holds open for a seat with an eligible face-down spirit; the flip rolls the round', () => {
		let state = startedGame();
		giveSpirit(state, 'Red', {});
		state.players.Red!.spirits[0]!.isFaceDown = true; // free flip → awaken-eligible
		state = lockBoth(state);
		state = toCleanup(state);
		// Benefits had no claims → skipped; awakening stops for Red's eligible spirit.
		expect(state.phase).toBe('awakening');
		expect(state.players.Blue!.phaseReady).toBe(true); // Blue idles, already ready
		expect(state.players.Red!.phaseReady).toBe(false);

		state = apply(state, RED, { type: 'awakenSpirit', slotIndex: 1 });
		// The flip was Red's last piece of work → the rest of the sequence collapses.
		expect(state.players.Red!.spirits[0]!.isFaceDown).toBe(false);
		expect(state.round).toBe(2);
		expect(state.phase).toBe('navigation');
	});

	test('commitAwakening still lets a seat decline its pending awaken offers', () => {
		let state = startedGame();
		giveSpirit(state, 'Red', {});
		state.players.Red!.spirits[0]!.isFaceDown = true;
		state = lockBoth(state);
		state = toCleanup(state);
		expect(state.phase).toBe('awakening');

		state = apply(state, RED, { type: 'commitAwakening' });
		expect(state.players.Red!.spirits[0]!.isFaceDown).toBe(true); // left dormant
		expect(state.round).toBe(2);
		expect(state.phase).toBe('navigation');
	});

	test('cleanup holds open on rune overflow; trimming to the carry limit rolls the round', () => {
		let state = startedGame();
		state = lockBoth(state);
		overflowRunes(state, 'Red', RUNE_CARRY_LIMIT + 2);
		state = toCleanup(state);
		// Benefits + awakening had no work → skipped; cleanup stops on the overflow.
		expect(state.phase).toBe('cleanup');
		expect(state.players.Blue!.phaseReady).toBe(true);

		state = apply(state, RED, { type: 'discardRune', slotIndex: 1 });
		expect(state.phase).toBe('cleanup'); // still one over the limit
		state = apply(state, RED, { type: 'discardRune', slotIndex: 2 });
		expect(state.round).toBe(2);
		expect(state.phase).toBe('navigation');
	});

	test('cleanup holds open on a payable corruption debt; paying it rolls the round', () => {
		let state = startedGame();
		giveSpirit(state, 'Red', {}); // face-up spirit — the sacrifice on the hook
		state = lockBoth(state);
		state = apply(state, RED, { type: 'endLocationActions' });
		// Corruption strikes after Red passed but before the round wraps.
		state.players.Red!.pendingCorruptionDiscard = { count: 1, reason: 'test' };
		state = apply(state, BLUE, { type: 'endLocationActions' });
		expect(state.phase).toBe('cleanup');
		expect(state.players.Red!.phaseReady).toBe(false);

		state = apply(state, RED, { type: 'discardSpirit', slotIndex: 1 });
		expect(state.players.Red!.pendingCorruptionDiscard).toBeNull();
		expect(state.round).toBe(2);
		expect(state.phase).toBe('navigation');
	});

	test('benefits holds open on an unclaimed reward while workless seats idle ready', () => {
		let state = startedGame();
		giveSpirit(state, 'Red', { 'Golden Ruler': 1 });
		state = lockBoth(state);
		state = toCleanup(state);
		expect(state.phase).toBe('benefits');
		expect(state.players.Red!.phaseReady).toBe(false); // must claim
		expect(state.players.Blue!.phaseReady).toBe(true); // idles silently

		state = apply(state, RED, { type: 'resolveAwakenReward', taintedMaxBarrier: 0, relicPicks: [] });
		// Claim was the last work anywhere → whole sequence collapses to round 2.
		expect(state.players.Red!.victoryPoints).toBe(1);
		expect(state.round).toBe(2);
		expect(state.phase).toBe('navigation');
	});
});

describe('all-Fallen end condition', () => {
	test('the game ends once every player has Fallen — the highest VP wins', () => {
		let state = startedGame();
		state = lockBoth(state);
		state.players.Red!.statusLevel = 3; // Fallen
		state.players.Blue!.statusLevel = 3; // Fallen
		state.players.Red!.victoryPoints = 5;
		state.players.Blue!.victoryPoints = 8;
		state = toCleanup(state);
		expect(state.status).toBe('finished');
		expect(state.winnerSeat).toBe('Blue'); // most Victory Points
	});

	test('a VP-target win still takes precedence over the all-Fallen result', () => {
		let state = startedGame();
		state = lockBoth(state);
		state.players.Red!.statusLevel = 3;
		state.players.Blue!.statusLevel = 3;
		state.players.Red!.victoryPoints = 30; // reached the win target outright
		state.players.Blue!.victoryPoints = 8;
		state = toCleanup(state);
		expect(state.status).toBe('finished');
		expect(state.winnerSeat).toBe('Red');
	});

	test('the game continues while any player is below Fallen', () => {
		let state = startedGame();
		state = lockBoth(state);
		state.players.Red!.statusLevel = 3; // Fallen
		state.players.Blue!.statusLevel = 2; // Corrupt — not yet Fallen
		state = toCleanup(state);
		expect(state.status).toBe('active');
		expect(state.round).toBe(2);
	});
});
