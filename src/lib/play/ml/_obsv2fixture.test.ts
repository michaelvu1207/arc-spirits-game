/**
 * Fixture generator for the Python obs-v2 parser/model tests (ml/test_model_v2.py).
 *
 * Env-gated: only runs with FIXTURE=1 — it is a data producer, not a test.
 *
 *   FIXTURE=1 npx vitest run src/lib/play/ml/_obsv2fixture.test.ts
 *
 * Replays seeded heuristic self-play (same harness as encodeV2.test.ts), flattens
 * real decision-point observations via flattenObsV2, and writes them with
 * obsV2Meta(catalog) to ml/data_fixtures/obsv2_fixture.json. The Python side
 * parses rows strictly from the flat header / meta — never hard-coded offsets —
 * so this fixture is the ground truth tying obs_v2.py to the real encoder.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyDeadlineAdvance, applyGameCommand, createLobbyState } from '../runtime';
import { createRng, nextInt, type RngState } from '../rng';
import {
	MEDIUM_DEFAULTS,
	botActorFor,
	botSeatNeedsToAct,
	planBotPhaseActions,
	type BotRandom
} from '../server/botPolicy';
import {
	SEAT_COLORS,
	type GameActor,
	type PublicGameState,
	type SeatColor
} from '../types';
import { loadOrSnapshotCatalog, mlPath } from './nodeIo';
import { encodeEntityObsV2, flattenObsV2, obsV2Meta } from './encodeV2';

const enabled = process.env.FIXTURE === '1';

function seededBotRandom(rng: RngState): BotRandom {
	return {
		int: (maxExclusive: number) => nextInt(rng, maxExclusive),
		chance: () => nextInt(rng, 2) === 0
	};
}

interface FixtureRow {
	seat: SeatColor;
	round: number;
	phase: string;
	flat: number[];
}

describe.skipIf(!enabled)('obs-v2 python fixture generator', () => {
	it('writes real flattened decision-point observations to ml/data_fixtures', async () => {
		const catalog = await loadOrSnapshotCatalog();
		const meta = obsV2Meta(catalog);

		const collect = (seed: number, seatCount: number, maxRounds: number): FixtureRow[] => {
			const seats = SEAT_COLORS.slice(0, seatCount) as SeatColor[];
			const guardianNames = catalog.guardians.slice(0, seatCount).map((g) => g.name);
			let state = createLobbyState({ roomCode: 'FIXV2', guardianNames });
			const host: GameActor = { memberId: 'host', displayName: 'host', role: 'host', seatColor: null };
			const expectOk = (r: ReturnType<typeof applyGameCommand>, label: string): void => {
				if (!r.ok) throw new Error(`${label}: ${r.error.code} ${r.error.message}`);
				state = r.state;
			};
			seats.forEach((seat, i) => {
				const memberId = `bot-${seat}`;
				expectOk(
					applyGameCommand(state, { memberId, displayName: seat, role: 'player', seatColor: null }, { type: 'claimSeat', seatColor: seat }, catalog),
					`claimSeat ${seat}`
				);
				expectOk(
					applyGameCommand(state, { memberId, displayName: seat, role: 'player', seatColor: seat }, { type: 'selectGuardian', guardianName: guardianNames[i] }, catalog),
					`selectGuardian ${seat}`
				);
			});
			expectOk(applyGameCommand(state, host, { type: 'startGame', seed }, catalog), 'startGame');

			const rows: FixtureRow[] = [];
			const onDecision = (s: PublicGameState, seat: SeatColor): void => {
				const obs = encodeEntityObsV2(s, seat, catalog);
				rows.push({ seat, round: s.round, phase: s.phase, flat: flattenObsV2(obs, catalog) });
			};

			const botRng = seededBotRandom(createRng(seed));
			let ticks = 0;
			while (state.status === 'active' && state.round <= maxRounds) {
				if (++ticks > 50_000) throw new Error('fixture game: tick cap exceeded');
				let progressed = false;
				for (const seat of state.activeSeats) {
					if (!botSeatNeedsToAct(state, seat)) continue;
					const commands = planBotPhaseActions(state, seat, catalog, botRng, MEDIUM_DEFAULTS);
					for (const command of commands) {
						onDecision(state, seat);
						const result = applyGameCommand(state, botActorFor(state, seat), command, catalog, { mutate: true });
						if (!result.ok) break;
						state = result.state;
						progressed = true;
						if (state.status !== 'active') break;
					}
					if (state.status !== 'active') break;
				}
				if (!progressed && state.status === 'active') {
					const before = `${state.phase}:${state.round}`;
					applyDeadlineAdvance(state, catalog);
					if (`${state.phase}:${state.round}` === before && state.status === 'active') {
						throw new Error(`fixture game: stalled at ${before}`);
					}
				}
			}
			return rows;
		};

		// Even spread over the whole game so the fixture covers early (no monster,
		// no runes) through late (full boards) mask configurations.
		const sample = (rows: FixtureRow[], n: number): FixtureRow[] => {
			if (rows.length <= n) return rows;
			const out: FixtureRow[] = [];
			for (let i = 0; i < n; i++) out.push(rows[Math.floor((i * rows.length) / n)]);
			return out;
		};

		// 4p game for full seat occupancy, 2p game so the seat/spirit masks also
		// exercise the sparse case.
		const rows = [...sample(collect(20260701, 4, 16), 40), ...sample(collect(31337, 2, 12), 16)];
		expect(rows.length).toBeGreaterThanOrEqual(50);
		for (const r of rows) expect(r.flat).toHaveLength(meta.flatLength);

		const file = mlPath('data_fixtures', 'obsv2_fixture.json');
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({
				generator: 'src/lib/play/ml/_obsv2fixture.test.ts',
				meta,
				rows: rows.map((r) => ({ seat: r.seat, round: r.round, phase: r.phase })),
				flat: rows.map((r) => r.flat)
			})
		);
		console.log(`obsv2 fixture: wrote ${rows.length} rows to ${file}`);
	}, 300_000);
});
