/**
 * Differential fidelity gate for the pure legality oracle (canApply). Drives full games across
 * diverse bot profiles and, at EVERY decision point, enumerates the full candidate surface and
 * asserts — for every candidate canApply can decide — that it agrees with the reducer:
 *
 *     canApply(state, actor, cmd, catalog) === undefined  ||  === applyGameCommand(...).ok
 *
 * This is what makes canApply safe to trust in legalActions: it can only ever DEFER (undefined),
 * never DISAGREE. If a future rule change makes a guard drift, this fails loudly. Runs in the
 * normal suite (no env gate) so it's a permanent guard. Probing uses the cloning applyGameCommand,
 * which never mutates `state`, so we can probe freely between real moves.
 */
import { describe, it, expect } from 'vitest';
import { applyGameCommand, applyDeadlineAdvance, createLobbyState } from '../runtime';
import { createRng, nextInt, type RngState } from '../rng';
import { botActorFor, botSeatNeedsToAct, planBotPhaseActions, profileFor, type BotRandom } from '../server/botPolicy';
import { SEAT_COLORS, type GameActor, type PublicGameState, type SeatColor } from '../types';
import { enumerateCandidates } from './actions';
import { canApply } from '../legality';
import { hasCatalog, loadPlayCatalogSync } from '../sim/_catalogSync';

function botRandom(rng: RngState): BotRandom {
	return { int: (m: number) => nextInt(rng, m), chance: () => nextInt(rng, 2) === 0 };
}

interface Mismatch {
	round: number;
	phase: string;
	seat: string;
	type: string;
	verdict: boolean;
	oracle: boolean;
	cmd: unknown;
}

/** Drive one full game, probing canApply vs the reducer at every decision. */
function probeGame(
	catalog: Parameters<typeof applyGameCommand>[3],
	seed: number,
	profileKinds: string[],
	maxRounds: number,
	mismatches: Mismatch[],
	counts: { decided: number; deferred: number }
): void {
	const nSeats = profileKinds.length;
	const seats = SEAT_COLORS.slice(0, nSeats) as SeatColor[];
	const guardianNames = catalog.guardians.slice(0, nSeats).map((g) => g.name);
	let state = createLobbyState({ roomCode: 'CAP', guardianNames });
	const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
	const ok = (r: ReturnType<typeof applyGameCommand>): PublicGameState => {
		if (!r.ok) throw new Error(r.error.code);
		return r.state;
	};
	seats.forEach((seat, i) => {
		const id = `bot-${seat}`;
		state = ok(applyGameCommand(state, { memberId: id, displayName: seat, role: 'player', seatColor: null }, { type: 'claimSeat', seatColor: seat }, catalog));
		state = ok(applyGameCommand(state, { memberId: id, displayName: seat, role: 'player', seatColor: seat }, { type: 'selectGuardian', guardianName: guardianNames[i] }, catalog));
	});
	state = ok(applyGameCommand(state, host, { type: 'startGame', seed }, catalog));

	const rng = botRandom(createRng(seed));
	const profiles = Object.fromEntries(seats.map((s, i) => [s, profileFor(profileKinds[i % profileKinds.length])]));

	const probe = (seat: SeatColor): void => {
		const actor = botActorFor(state, seat);
		enumerateCandidates(state, seat, catalog, (cmd) => {
			const verdict = canApply(state, actor, cmd, catalog);
			if (verdict === undefined) {
				counts.deferred++;
				return;
			}
			counts.decided++;
			const oracle = applyGameCommand(state, actor, cmd, catalog).ok; // clones internally — does not mutate `state`
			if (verdict !== oracle) {
				mismatches.push({ round: state.round, phase: state.phase, seat, type: cmd.type, verdict, oracle, cmd });
			}
		});
	};

	let ticks = 0;
	while (state.status === 'active' && state.round <= maxRounds && ticks < 20000) {
		ticks++;
		let progressed = false;
		for (const seat of state.activeSeats) {
			if (!botSeatNeedsToAct(state, seat)) continue;
			probe(seat); // check the oracle on the FULL candidate surface at this decision point
			for (const cmd of planBotPhaseActions(state, seat, catalog, rng, profiles[seat])) {
				const r = applyGameCommand(state, botActorFor(state, seat), cmd, catalog, { mutate: true });
				if (!r.ok) break;
				state = r.state;
				progressed = true;
				if (state.status !== 'active') break;
			}
			if (state.status !== 'active') break;
		}
		if (!progressed && state.status === 'active') applyDeadlineAdvance(state, catalog);
	}
}

describe('canApply legality-oracle fidelity', () => {
	it.skipIf(!hasCatalog())('never disagrees with the reducer across diverse profiles', () => {
		const catalog = loadPlayCatalogSync();
		const mismatches: Mismatch[] = [];
		const counts = { decided: 0, deferred: 0 };
		const FIELD = ['pvphunter', 'aggressive', 'cultivator', 'survivor', 'fighter', 'hard', 'medium'];
		// Mix of profile assignments + seeds to exercise every phase/command branch.
		const configs: string[][] = [
			['medium', 'medium', 'medium', 'medium'],
			FIELD.slice(0, 4),
			['pvphunter', 'pvphunter', 'cultivator', 'survivor'],
			['aggressive', 'fighter', 'hard', 'medium']
		];
		for (const profileKinds of configs) {
			for (const seed of [5, 31, 77, 256, 909]) {
				probeGame(catalog, seed, profileKinds, 40, mismatches, counts);
			}
		}
		if (mismatches.length) {
			// eslint-disable-next-line no-console
			console.log(`[canApply] ${mismatches.length} mismatch(es). First 10:\n` + mismatches.slice(0, 10).map((m) => `  r${m.round} ${m.phase} ${m.seat} ${m.type}: canApply=${m.verdict} oracle=${m.oracle} ${JSON.stringify(m.cmd)}`).join('\n'));
		}
		expect(mismatches, 'canApply must never disagree with the reducer').toEqual([]);
		// Telemetry: how much of the candidate surface the oracle decides without a clone.
		// eslint-disable-next-line no-console
		console.log(`[canApply] decided=${counts.decided} deferred=${counts.deferred} (${((100 * counts.decided) / Math.max(1, counts.decided + counts.deferred)).toFixed(1)}% clone-free)`);
	}, 120000);
});
