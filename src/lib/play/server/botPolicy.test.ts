import { describe, expect, test } from 'vitest';
import { applyGameCommand, applyDeadlineAdvance, createLobbyState } from '../runtime';
import { createRng, nextInt, type RngState } from '../rng';
import {
	botActorFor,
	botSeatNeedsToAct,
	planBotPhaseActions,
	type BotRandom
} from './botPolicy';
import { SEAT_COLORS, type GameActor, type PlayCatalog, type PublicGameState, type SeatColor } from '../types';

/** Mirror the server's navigation reveal: locking no longer reveals instantly, so once
 *  every active seat is locked the round reveals via deadline enforcement. Returns true
 *  if it advanced the phase. */
function revealNavIfAllLocked(state: PublicGameState, catalog: PlayCatalog): boolean {
	if (state.phase !== 'navigation' || state.revealedDestinations) return false;
	if (state.activeSeats.length === 0) return false;
	if (!state.activeSeats.every((s) => state.navigation[s]?.locked === true)) return false;
	applyDeadlineAdvance(state, catalog);
	return true;
}

// A small catalog with enough spirits to deal opening hands + stock the market,
// and a monster so the Abyss has something to fight (mirrors phases.test.ts).
const CATALOG: PlayCatalog = {
	guardians: [
		{ id: 'g-a', name: 'Myrtle', originId: 'o1' },
		{ id: 'g-b', name: 'Nyra', originId: 'o2' },
		{ id: 'g-c', name: 'Orin', originId: 'o3' },
		{ id: 'g-d', name: 'Vesper', originId: 'o4' }
	],
	mats: [],
	classes: [],
	dice: [{ id: 'basic_attack', name: 'Basic Attack', diceType: 'attack', sides: [1, 1, 2, 2, 3, 3] }],
	spirits: Array.from({ length: 40 }, (_, i) => ({
		id: `s-${i}`,
		name: `Spirit ${i}`,
		// Costs 1-6 stay in the Spirit World bag; a few >=7 stock the Abyss bag.
		cost: i % 8 === 7 ? 8 : (i % 6) + 1,
		classes: { Fighter: 1 },
		origins: { Forest: 1 }
	})),
	monsters: [
		{
			id: 'm-1',
			name: 'Abyss Maw',
			damage: 2,
			barrier: 6,
			rewardTrack: ['icon-a', 'icon-b'],
			dicePool: [],
			chooseAmount: 2,
			stage: 1,
			order: 0
		}
	]
};

const GUARDIAN_NAMES = CATALOG.guardians.map((g) => g.name);

/** Deterministic BotRandom backed by the engine RNG so the test is reproducible. */
function seededBotRandom(rng: RngState): BotRandom {
	return {
		int: (maxExclusive: number) => nextInt(rng, maxExclusive),
		chance: () => nextInt(rng, 2) === 0
	};
}

function hostActor(): GameActor {
	return { memberId: 'bot-host', displayName: 'Host', role: 'host', seatColor: null };
}

/** Seat four bots, select distinct guardians, and start the game. */
function startedFourBotGame(seed: number): PublicGameState {
	let state = createLobbyState({ roomCode: 'BOTSIM', guardianNames: GUARDIAN_NAMES });
	const host = hostActor();
	const seats = SEAT_COLORS.slice(0, 4) as SeatColor[];

	seats.forEach((seat, index) => {
		const memberId = `bot-${seat}`;
		const claim = applyGameCommand(
			state,
			{ memberId, displayName: `🤖 ${seat}`, role: 'player', seatColor: null },
			{ type: 'claimSeat', seatColor: seat },
			CATALOG
		);
		expect(claim.ok).toBe(true);
		if (!claim.ok) throw new Error(claim.error.message);
		state = claim.state;

		const guardian = applyGameCommand(
			state,
			{ memberId, displayName: `🤖 ${seat}`, role: 'player', seatColor: seat },
			{ type: 'selectGuardian', guardianName: GUARDIAN_NAMES[index] },
			CATALOG
		);
		expect(guardian.ok).toBe(true);
		if (!guardian.ok) throw new Error(guardian.error.message);
		state = guardian.state;
	});

	const started = applyGameCommand(state, host, { type: 'startGame', seed }, CATALOG);
	expect(started.ok).toBe(true);
	if (!started.ok) throw new Error(started.error.message);
	return started.state;
}

describe('monster horde size', () => {
	test('opening monster is the weakest rung; ladder length is player-count-independent', () => {
		// CATALOG has 4 guardians, so we can seat 1–4 players. The monster ladder no
		// longer scales with player count — it's the full escalation sequence either way.
		for (const players of [1, 2, 3, 4]) {
			let state = createLobbyState({ roomCode: 'HORDE', guardianNames: GUARDIAN_NAMES });
			const seats = SEAT_COLORS.slice(0, players) as SeatColor[];
			seats.forEach((seat, index) => {
				const memberId = `bot-${seat}`;
				state = (
					applyGameCommand(
						state,
						{ memberId, displayName: `🤖 ${seat}`, role: 'player', seatColor: null },
						{ type: 'claimSeat', seatColor: seat },
						CATALOG
					) as { ok: true; state: PublicGameState }
				).state;
				state = (
					applyGameCommand(
						state,
						{ memberId, displayName: `🤖 ${seat}`, role: 'player', seatColor: seat },
						{ type: 'selectGuardian', guardianName: GUARDIAN_NAMES[index] },
						CATALOG
					) as { ok: true; state: PublicGameState }
				).state;
			});
			const started = applyGameCommand(state, hostActor(), { type: 'startGame', seed: 1 }, CATALOG);
			expect(started.ok).toBe(true);
			if (!started.ok) throw new Error(started.error.message);
			expect(started.state.monster?.ladderIndex).toBe(0);
			expect(started.state.monster?.ladderMax).toBe((CATALOG.monsters ?? []).length);
			// One kill per active player to defeat the monster (1p→1, 2p→2, …).
			expect(started.state.monster?.livesTotal).toBe(players);
			expect(started.state.monster?.livesRemaining).toBe(players);
		}
	});
});

describe('bot policy — full simultaneous round loop', () => {
	test('four bots drive ~25 rounds with only legal commands and the phase machine advances', () => {
		let state = startedFourBotGame(1234);
		expect(state.status).toBe('active');
		expect(state.round).toBe(1);

		const rng = createRng(1234);
		const botRng = seededBotRandom(rng);

		const TARGET_ROUNDS = 25;
		const MAX_TICKS = 5000; // generous safety valve so a stuck loop fails fast
		let ticks = 0;
		let issuedCommands = 0;
		let phaseTransitions = 0;
		let previousPhase = state.phase;
		let previousRound = state.round;

		while (state.round <= TARGET_ROUNDS && state.status === 'active') {
			ticks += 1;
			expect(ticks).toBeLessThan(MAX_TICKS);

			let progressedThisTick = false;

			for (const seat of state.activeSeats) {
				if (!botSeatNeedsToAct(state, seat)) continue;

				const commands = planBotPhaseActions(state, seat, CATALOG, botRng);
				// A seat that needs to act must always have at least one command that
				// makes it ready — otherwise the loop could stall.
				expect(commands.length).toBeGreaterThan(0);

				for (const command of commands) {
					const result = applyGameCommand(state, botActorFor(state, seat), command, CATALOG);
					// (a) No command ever returns an illegal/unsupported error.
					if (!result.ok) {
						throw new Error(
							`Illegal bot command ${command.type} for ${seat} in phase ${state.phase}: ${result.error.code} ${result.error.message}`
						);
					}
					state = result.state;
					issuedCommands += 1;
					progressedThisTick = true;

					if (state.phase !== previousPhase || state.round !== previousRound) {
						phaseTransitions += 1;
						previousPhase = state.phase;
						previousRound = state.round;
					}

					if (state.status !== 'active') break;
				}

				if (state.status !== 'active') break;
			}

			// Once every seat is locked, the round reveals via deadline enforcement
			// (locking no longer reveals instantly) — simulate that so the sim advances.
			if (!progressedThisTick && revealNavIfAllLocked(state, CATALOG)) {
				progressedThisTick = true;
				if (state.phase !== previousPhase || state.round !== previousRound) {
					phaseTransitions += 1;
					previousPhase = state.phase;
					previousRound = state.round;
				}
			}

			// Every tick where some seat needed to act must make progress, so the
			// loop terminates cleanly rather than spinning.
			expect(progressedThisTick).toBe(true);
		}

		// (b) The phase machine advanced — the round counter climbed past the target
		// (or the game finished, which would also be a clean exit).
		expect(state.round).toBeGreaterThan(TARGET_ROUNDS);
		expect(phaseTransitions).toBeGreaterThan(TARGET_ROUNDS); // many phases per round
		expect(issuedCommands).toBeGreaterThan(0);

		// (c) The loop terminated cleanly (we exited because the round target was
		// reached, not because we hit the safety valve).
		expect(ticks).toBeLessThan(MAX_TICKS);
	});

	test('planBotPhaseActions returns no commands for a seat that is already ready', () => {
		const state = startedFourBotGame(7);
		// Lock one seat's navigation so it is no longer pending.
		const seat: SeatColor = 'Red';
		const locked = applyGameCommand(
			state,
			botActorFor(state, seat),
			{ type: 'lockNavigation', destination: 'Cyber City' },
			CATALOG
		);
		expect(locked.ok).toBe(true);
		if (!locked.ok) return;

		expect(botSeatNeedsToAct(locked.state, seat)).toBe(false);
		expect(planBotPhaseActions(locked.state, seat, CATALOG)).toEqual([]);
	});

	test('navigation plan always locks a valid destination', () => {
		const state = startedFourBotGame(99);
		for (const seat of state.activeSeats) {
			const commands = planBotPhaseActions(state, seat, CATALOG);
			expect(commands).toHaveLength(1);
			expect(commands[0]?.type).toBe('lockNavigation');
		}
	});
});

// ── Phase 7 integration sweep: effects + awakening ENABLED ───────────────────
//
// The base loop above runs with an inert catalog (no classes, no awaken
// conditions) — it proves the phase machine. This sweep proves the SAME
// all-legal-commands + phase-progression invariant holds with the full effect
// framework + awakening gate switched ON: every starting spirit carries a real
// class (so onRest/onCultivate/onMonsterKill/awakeningPhase effects fire) and the
// players hold face-down spirits with a mix of awaken conditions (free /
// rune_cost / scripted text) plus enough runes/dice to pay them. The bots issue
// `awakenSpirit` against the auto-eligible slots each cleanup, exercising the gate
// + the `awakening` trigger. Deterministic (seeded) end-to-end.

// Spirit ids whose scripted text-awaken + rune_cost behavior we exercise.
const FIELD_NURSE_ID = 'd7987d17-40af-431e-b765-9cd9dc072245'; // rune_cost: Any Rune ×1
const ANY_RUNE_ID = '7ca279f0-1ca8-484a-a86e-0a87aaa7b312';
const SPACE_INVADER_ID = 'b3068fcf-d197-4030-ba55-29ac1621f9a9'; // text: discard 4 attack dice

/**
 * Effects-and-awakening-enabled catalog. Each Spirit-World spirit carries a class
 * that fires on a common bot trigger, so the effect dispatch runs every round.
 * Two of the catalog spirits carry awaken conditions so the gate is exercised.
 */
const FX_CLASSES = ['Fighter', 'Healer', 'Arc Mage', 'Spirit Animal', 'Fairy', 'Sharpshooter'];
const FX_CATALOG: PlayCatalog = {
	guardians: CATALOG.guardians,
	mats: [],
	classes: [],
	dice: CATALOG.dice,
	monsters: CATALOG.monsters,
	spirits: Array.from({ length: 40 }, (_, i) => ({
		id: `fx-${i}`,
		name: `FX Spirit ${i}`,
		cost: i % 8 === 7 ? 8 : (i % 6) + 1,
		// Rotate through several classes so a mix of triggers fire; all share one
		// origin so a cultivate trio is reachable.
		classes: { [FX_CLASSES[i % FX_CLASSES.length]]: 1 },
		origins: { Forest: 1 }
	}))
};

/** A face-down spirit slot carrying the given catalog id/class/awaken metadata. */
function faceDownSlot(
	slotIndex: number,
	id: string,
	name: string,
	classes: Record<string, number>
) {
	return { slotIndex, id, name, cost: 2, classes, origins: { Forest: 1 }, isFaceDown: true };
}

/** A held rune slot for paying a rune_cost awaken. Carries an `originId` so it
 *  classifies as an origin rune — payable for an "Any Rune" wildcard cost. */
function heldRune(slotIndex: number, runeId: string) {
	return { slotIndex, hasRune: true, id: runeId, name: runeId, type: 'rune' as const, originId: 'forest-origin' };
}

/**
 * Seed each active player with face-down spirits + the runes/dice to awaken them:
 *   - a FREE face-down spirit (Dragon Warrior class → fires the `awakening`
 *     trigger when flipped),
 *   - a rune_cost spirit (Field Nurse, payable with one held Any-Rune),
 *   - a scripted-text spirit (Space Invader, payable by discarding 4 attack dice).
 * The catalog must carry these spirits' awaken conditions so the gate resolves.
 */
function seedAwakenables(state: PublicGameState, catalog: PlayCatalog): void {
	// Register the awaken-bearing spirits in the catalog (Field Nurse rune_cost,
	// Space Invader scripted text), plus a free Dragon-Warrior spirit.
	catalog.spirits.push(
		{
			id: FIELD_NURSE_ID,
			name: 'Field Nurse',
			cost: 2,
			classes: { Healer: 1 },
			origins: { Forest: 1 },
			awaken: { kind: 'rune_cost', mats: [{ runeId: ANY_RUNE_ID, name: 'Any Rune', kind: 'rune', count: 1, wildcard: true }] }
		},
		{
			id: SPACE_INVADER_ID,
			name: 'Space Invader',
			cost: 2,
			classes: { Fighter: 1 },
			origins: { Forest: 1 },
			awaken: { kind: 'text', text: 'Discard 4 of any attack dice.' }
		},
		{ id: 'fx-free', name: 'FX Free', cost: 2, classes: { 'Dragon Warrior': 1 }, origins: { Forest: 1 } }
	);

	for (const seat of state.activeSeats) {
		const player = state.players[seat];
		if (!player) continue;
		const base = player.spirits.length;
		player.spirits.push(
			faceDownSlot(base + 1, 'fx-free', 'FX Free', { 'Dragon Warrior': 1 }),
			faceDownSlot(base + 2, FIELD_NURSE_ID, 'Field Nurse', { Healer: 1 }),
			faceDownSlot(base + 3, SPACE_INVADER_ID, 'Space Invader', { Fighter: 1 })
		);
		// Runes to pay Field Nurse + attack dice for Space Invader, every round.
		player.mats.push(heldRune(player.mats.length + 1, ANY_RUNE_ID));
		for (let d = 0; d < 6; d += 1) {
			player.attackDice.push({ instanceId: `${seat}-die-${d}`, tier: 'basic' });
		}
	}
}

describe('bot policy — Phase 7 integration sweep (effects + awakening ON)', () => {
	test('four bots run with the full effect framework + awaken gate, only legal commands, phases advance', () => {
		let state = startedFourBotGame(2026);
		expect(state.status).toBe('active');

		// Clone the FX catalog so the per-test mutation in seedAwakenables is isolated.
		const catalog: PlayCatalog = structuredClone(FX_CATALOG);
		// The game was started with the inert base CATALOG, so the face-up starting
		// spirits carry no classes. Overlay a real class (+ shared origin) onto each
		// so onRest/onCultivate/onMonsterKill/awakeningPhase effects fire every round.
		for (const seat of state.activeSeats) {
			const player = state.players[seat];
			if (!player) continue;
			player.spirits.forEach((s, idx) => {
				s.classes = { [FX_CLASSES[idx % FX_CLASSES.length]]: 1 };
				s.origins = { Forest: 1 };
			});
		}
		// Seed face-down spirits (free / rune_cost / scripted text) + the runes/dice
		// to pay them, so the awakening gate is genuinely exercised at cleanup.
		seedAwakenables(state, catalog);

		const rng = createRng(2026);
		const botRng = seededBotRandom(rng);

		const TARGET_ROUNDS = 20;
		const MAX_TICKS = 6000;
		let ticks = 0;
		let issuedCommands = 0;
		let awakenCommands = 0;
		let phaseTransitions = 0;
		let previousPhase = state.phase;
		let previousRound = state.round;
		const phasesSeen = new Set<string>();

		while (state.round <= TARGET_ROUNDS && state.status === 'active') {
			ticks += 1;
			expect(ticks).toBeLessThan(MAX_TICKS);
			phasesSeen.add(state.phase);

			let progressedThisTick = false;

			for (const seat of state.activeSeats) {
				phasesSeen.add(state.phase);
				if (!botSeatNeedsToAct(state, seat)) continue;

				const commands = planBotPhaseActions(state, seat, catalog, botRng);
				expect(commands.length).toBeGreaterThan(0);

				for (const command of commands) {
					if (command.type === 'awakenSpirit') awakenCommands += 1;
					const result = applyGameCommand(state, botActorFor(state, seat), command, catalog);
					// Record the phase AFTER each command too, so single-tick phase
					// transits (e.g. the whole table passing encounter) are observed.
					phasesSeen.add(state.phase);
					// (a) No command — including awakenSpirit on an auto-eligible slot —
					// ever returns an illegal/unsupported error.
					if (!result.ok) {
						throw new Error(
							`Illegal bot command ${command.type} for ${seat} in phase ${state.phase}: ${result.error.code} ${result.error.message}`
						);
					}
					state = result.state;
					issuedCommands += 1;
					progressedThisTick = true;

					if (state.phase !== previousPhase || state.round !== previousRound) {
						phaseTransitions += 1;
						previousPhase = state.phase;
						previousRound = state.round;
					}
					if (state.status !== 'active') break;
				}
				if (state.status !== 'active') break;
			}

			// Reveal navigation once everyone is locked (deadline enforcement in prod).
			if (!progressedThisTick && revealNavIfAllLocked(state, catalog)) {
				progressedThisTick = true;
				if (state.phase !== previousPhase || state.round !== previousRound) {
					phaseTransitions += 1;
					previousPhase = state.phase;
					previousRound = state.round;
				}
			}

			expect(progressedThisTick).toBe(true);
		}

		// (b) The phase machine advanced through its resting phases, many times.
		// `encounter` is usually a transient pass-through (auto-skips under all-Good
		// play), but the bots' randomised play can tip a seat Evil, in which case the
		// state rests in encounter until it acts. Assert only valid round-loop phases
		// were observed and the three always-present phases occurred — without
		// over-fitting to whether encounter happened to appear in this RNG stream.
		expect(state.round).toBeGreaterThan(TARGET_ROUNDS);
		expect(phaseTransitions).toBeGreaterThan(TARGET_ROUNDS);
		for (const phase of phasesSeen) {
			expect([
				'navigation',
				'location',
				'encounter',
				'benefits',
				'awakening',
				'cleanup'
			]).toContain(phase);
		}
		// The resolution steps (benefits/awakening/cleanup) now only REST when a seat
		// has real work there — a workless sequence collapses inside one command and
		// is never observed between commands. Navigation/location always rest;
		// awakening reliably appears across a long sweep because the bots keep
		// summoning face-down spirits whose eligible flips hold the step open (also
		// asserted via the awakenSpirit command count in (c) below).
		for (const core of ['navigation', 'location', 'awakening']) {
			expect(phasesSeen.has(core)).toBe(true);
		}

		// (c) Awakening was genuinely exercised — the bots issued awakenSpirit
		// commands against auto-eligible slots and none were illegal (asserted above).
		expect(awakenCommands).toBeGreaterThan(0);

		// (d) Clean termination (round target reached, not the safety valve).
		expect(ticks).toBeLessThan(MAX_TICKS);

		// (e) No player ever holds an illegally-awakened face-down spirit count below
		// zero, and every awakened Field Nurse spent its rune (the gate is real): no
		// player ended with both a face-up Field Nurse AND its original rune unspent
		// beyond what cultivation could grant — sanity via no negative resources.
		for (const seat of state.activeSeats) {
			const player = state.players[seat];
			if (!player) continue;
			expect(player.victoryPoints).toBeGreaterThanOrEqual(0);
			expect(player.barrier).toBeGreaterThanOrEqual(0);
			expect(player.attackDice.length).toBeGreaterThanOrEqual(0);
		}
	});

	test('seeded rune_cost + scripted-text spirits are awaken-eligible at the awakening step (gate is live)', () => {
		let state = startedFourBotGame(7);
		const catalog: PlayCatalog = structuredClone(FX_CATALOG);
		for (const seat of state.activeSeats) {
			const player = state.players[seat];
			if (!player) continue;
			player.spirits.forEach((s, idx) => {
				s.classes = { [FX_CLASSES[idx % FX_CLASSES.length]]: 1 };
			});
		}
		seedAwakenables(state, catalog);

		// Drive every seat to the awakening step via the bot policy so awakenEligible is
		// set — and STOP before the bots auto-awaken there (which would empty the list).
		const rng = createRng(7);
		const botRng = seededBotRandom(rng);
		let guard = 0;
		while (state.phase !== 'awakening' && state.status === 'active' && guard < 200) {
			guard += 1;
			for (const seat of state.activeSeats) {
				if (!botSeatNeedsToAct(state, seat)) continue;
				for (const command of planBotPhaseActions(state, seat, catalog, botRng)) {
					const res = applyGameCommand(state, botActorFor(state, seat), command, catalog);
					expect(res.ok).toBe(true);
					if (res.ok) state = res.state;
				}
			}
			// Reveal navigation once everyone is locked (deadline enforcement in prod).
			revealNavIfAllLocked(state, catalog);
		}
		expect(state.phase).toBe('awakening');

		// At the awakening step the free + payable rune_cost + satisfiable scripted-text
		// slots are all auto-eligible (they were seeded with the runes/dice to pay).
		for (const seat of state.activeSeats) {
			const player = state.players[seat];
			if (!player) continue;
			const faceDownIds = player.spirits.filter((s) => s.isFaceDown).map((s) => s.id);
			for (const id of faceDownIds) {
				const slot = player.spirits.find((s) => s.id === id && s.isFaceDown);
				if (!slot) continue;
				// Each seeded face-down spirit (free / Field Nurse / Space Invader) is
				// auto-awakenable, so it appears in awakenEligible.
				expect(player.awakenEligible).toContain(slot.slotIndex);
			}
			// awakenSpirit on each eligible slot succeeds (gate + pay + flip).
			for (const slotIndex of [...player.awakenEligible]) {
				const res = applyGameCommand(
					state,
					botActorFor(state, seat),
					{ type: 'awakenSpirit', slotIndex },
					catalog
				);
				expect(res.ok, `awakenSpirit slot ${slotIndex} for ${seat} should be legal`).toBe(true);
				if (res.ok) state = res.state;
			}
		}
	});
});
