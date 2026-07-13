/**
 * Regression: NEURAL bots freeze when they corrupt.
 *
 * Corruption (fighting the Abyss monster, or losing a PvP strike) sets a forced
 * `pendingCorruptionDiscard` obligation. In the LOCATION phase that obligation
 * blocks `endLocationActions` until it is paid down with `discardSpirit`
 * (legality.ts). The heuristic botPolicy pays it (resolveCorruptionDiscard before
 * passing); but the NEURAL bot enumerates its action surface via
 * `enumerateCandidates`, whose `location` case never offered `discardSpirit` — so a
 * corrupted neural bot had NO legal move that made progress: it could not pay the
 * debt and could not pass. The seat only unstuck when the host deadline drain
 * force-resolved it (the visible "freeze"). This test drives real bot games to a
 * location-phase turn, injects a corruption obligation exactly like combat does, and
 * asserts the neural action surface can pay it and then pass.
 */
import { describe, it, expect } from 'vitest';
import { applyGameCommand, applyDeadlineAdvance, createLobbyState } from '../runtime';
import { createRng, nextInt } from '../rng';
import {
	botActorFor,
	botSeatNeedsToAct,
	planBotPhaseActions,
	profileFor,
	type BotRandom
} from '../server/botPolicy';
import { SEAT_COLORS, type GameActor, type PublicGameState, type SeatColor } from '../types';
import { legalActions } from './actions';
import { getNeuralPolicy, planNeuralPhaseActions } from './neuralBot';
import { canApply } from '../legality';
import { hasCatalog, loadPlayCatalogSync } from '../sim/_catalogSync';

function botRandom(rng: ReturnType<typeof createRng>): BotRandom {
	return { int: (m: number) => nextInt(rng, m), chance: () => nextInt(rng, 2) === 0 };
}

type Catalog = Parameters<typeof applyGameCommand>[3];

/** Start a 4-bot game and step it until the active seat is in the LOCATION phase
 *  holding ≥1 spirit — the state where a mid-fight corruption would strand it. */
function driveToLocationTurn(
	catalog: Catalog,
	seed: number
): { state: PublicGameState; seat: SeatColor } | null {
	const seats = SEAT_COLORS.slice(0, 4) as SeatColor[];
	const guardianNames = catalog.guardians.slice(0, 4).map((g) => g.name);
	let state = createLobbyState({ roomCode: 'FRZ', guardianNames });
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	const ok = (r: ReturnType<typeof applyGameCommand>): PublicGameState => {
		if (!r.ok) throw new Error(r.error.code);
		return r.state;
	};
	seats.forEach((seat, i) => {
		const id = `bot-${seat}`;
		state = ok(
			applyGameCommand(
				state,
				{ memberId: id, displayName: seat, role: 'player', seatColor: null },
				{ type: 'claimSeat', seatColor: seat },
				catalog
			)
		);
		state = ok(
			applyGameCommand(
				state,
				{ memberId: id, displayName: seat, role: 'player', seatColor: seat },
				{ type: 'selectGuardian', guardianName: guardianNames[i] },
				catalog
			)
		);
	});
	state = ok(applyGameCommand(state, host, { type: 'startGame', seed }, catalog));

	const rng = botRandom(createRng(seed));
	const profiles = Object.fromEntries(seats.map((s) => [s, profileFor('medium')]));

	let ticks = 0;
	while (state.status === 'active' && ticks < 8000) {
		ticks++;
		let progressed = false;
		for (const seat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, seat)) continue;
			// Capture the state at the START of a seat's LOCATION turn while it holds a
			// spirit — exactly the point at which a mid-fight corruption would strand it.
			if (state.phase === 'location' && (state.players[seat]?.spirits.length ?? 0) > 0) {
				return { state, seat };
			}
			for (const cmd of planBotPhaseActions(state, seat, catalog, rng, profiles[seat])) {
				const r = applyGameCommand(state, botActorFor(state, seat), cmd, catalog, { mutate: true });
				if (!r.ok) break;
				state = r.state;
				progressed = true;
				if (state.status !== 'active') break;
			}
			if (state.status !== 'active') break;
		}
		// No seat could move — the round is waiting on the host clock; advance it so the
		// driver keeps making progress toward a later, spirit-holding round.
		if (!progressed && state.status === 'active') applyDeadlineAdvance(state, catalog);
	}
	return null;
}

describe('neural bot corruption freeze', () => {
	it.skipIf(!hasCatalog())(
		'location-phase corruption debt is payable + passable on the neural action surface',
		() => {
			const catalog = loadPlayCatalogSync();
			// Try several seeds so we reliably land a location-phase turn with a spirit.
			let found: { state: PublicGameState; seat: SeatColor } | null = null;
			for (const seed of [5, 31, 77, 256, 909, 1234]) {
				found = driveToLocationTurn(catalog, seed);
				if (found) break;
			}
			expect(found, 'could not reach a location-phase turn with a spirit').not.toBeNull();
			const { state, seat } = found!;
			const player = state.players[seat]!;

			// Inject a forced corruption discard exactly as a mid-fight corruption would.
			player.pendingCorruptionDiscard = { count: 1, reason: 'test-corruption' };

			const actor = botActorFor(state, seat);

			// The seat must NOT be able to simply pass while it still owes a spirit.
			expect(canApply(state, actor, { type: 'endLocationActions' }, catalog)).toBe(false);

			// THE BUG: the neural action surface must offer a way to pay the debt.
			const legal = legalActions(state, seat, catalog);
			const discards = legal.filter((c) => c.type === 'discardSpirit');
			expect(
				discards.length,
				'a corrupted neural bot has no discardSpirit move → it freezes until the deadline drain'
			).toBeGreaterThan(0);

			// And paying it must actually clear the obligation and unblock passing.
			const paid = applyGameCommand(state, actor, discards[0], catalog);
			expect(paid.ok).toBe(true);
			if (paid.ok) {
				const after = paid.state.players[seat]!;
				expect(after.pendingCorruptionDiscard).toBeNull();
				expect(canApply(paid.state, actor, { type: 'endLocationActions' }, catalog)).toBe(true);
			}
		}
	);

	it.skipIf(!hasCatalog())(
		'full neural plan discards the corrupted spirit and immediately passes the location phase',
		async () => {
			const catalog = loadPlayCatalogSync();
			let found: { state: PublicGameState; seat: SeatColor } | null = null;
			for (const seed of [5, 31, 77, 256, 909, 1234]) {
				found = driveToLocationTurn(catalog, seed);
				if (found) break;
			}
			expect(found, 'could not reach a location-phase turn with a spirit').not.toBeNull();
			const { state, seat } = found!;
			const player = state.players[seat]!;
			// Keep one sacrifice so the regression has one unambiguous corruption payment.
			player.spirits = [player.spirits[0]];
			player.pendingCorruptionDiscard = { count: 1, reason: 'e2e-corruption' };
			player.phaseReady = false;

			const policy = await getNeuralPolicy();
			expect(policy, 'bundled production policy should load').not.toBeNull();
			const commands = planNeuralPhaseActions(state, seat, catalog, policy!);
			expect(commands.map((command) => command.type)).toEqual([
				'discardSpirit',
				'endLocationActions'
			]);

			// Execute the entire planned batch through the real reducer, matching botSim.
			let actual = state;
			for (const command of commands) {
				const result = applyGameCommand(actual, botActorFor(actual, seat), command, catalog);
				expect(result.ok, command.type).toBe(true);
				if (!result.ok) throw new Error(result.error.message);
				actual = result.state;
			}
			expect(actual.players[seat]!.pendingCorruptionDiscard).toBeNull();
			expect(actual.players[seat]!.spirits).toHaveLength(0);
			expect(actual.phase !== 'location' || actual.players[seat]!.phaseReady).toBe(true);
		}
	);

	it.skipIf(!hasCatalog())(
		'post-corruption Cursed Spirit benefits are claimed and the neural bot is auto-readied',
		async () => {
			const catalog = loadPlayCatalogSync();
			const found = driveToLocationTurn(catalog, 5);
			expect(found, 'could not reach an active bot turn').not.toBeNull();
			const { state, seat } = found!;

			// Cursed Spirit computes this reward at the Benefits boundary after the bot has
			// already paid its corruption sacrifice. Keep another seat unresolved so this
			// bot's plan stops at its own Benefits pass instead of continuing to plan commands
			// across later phases after the phase machine advances.
			state.phase = 'benefits';
			for (const activeSeat of state.activeSeats) {
				state.players[activeSeat]!.phaseReady = false;
			}
			state.players[seat]!.pendingCorruptionDiscard = null;
			state.players[seat]!.pendingAwakenReward = {
				grants: [{ kind: 'taintedChoice', amount: 2, source: 'Cursed Spirit' }]
			};
			const otherSeat = state.activeSeats.find((activeSeat) => activeSeat !== seat)!;
			state.players[otherSeat]!.pendingAwakenReward = {
				grants: [{ kind: 'relicChoice', amount: 1, source: 'Cursed Spirit' }]
			};

			const policy = await getNeuralPolicy();
			expect(policy, 'bundled production policy should load').not.toBeNull();
			const commands = planNeuralPhaseActions(state, seat, catalog, policy!);
			expect(commands.map((command) => command.type)).toEqual(['resolveAwakenReward']);

			let actual = state;
			for (const command of commands) {
				const result = applyGameCommand(actual, botActorFor(actual, seat), command, catalog);
				expect(result.ok, command.type).toBe(true);
				if (!result.ok) throw new Error(result.error.message);
				actual = result.state;
			}
			expect(actual.players[seat]!.pendingAwakenReward).toBeNull();
			expect(actual.players[seat]!.phaseReady).toBe(true);
			expect(actual.phase).toBe('benefits');
		}
	);
});
