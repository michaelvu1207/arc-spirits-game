/**
 * Arena — rank a set of policy checkpoints by strength. Each policy plays as one seat against
 * opponents sampled from the rest of the field; we report win-rate, avg placement, avgVP. Use it to
 * watch models overtake each other across league iterations and to detect convergence (when the
 * newest checkpoint can no longer beat the field, the league has plateaued = practically solved).
 *
 *   ARENA=1 ARENA_DIR=ml/league ARENA_GAMES=40 npx vitest run src/lib/play/ml/_arena.test.ts --disable-console-intercept
 *   ARENA=1 ARENA_FILES=a.json,b.json,c.json ARENA_GAMES=40 npx vitest run ...
 */
import { describe, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { profileFor } from '../server/botPolicy';
import { SEAT_COLORS, type SeatColor } from '../types';
import { playRecordingGame } from './driver';
import { loadOrSnapshotCatalog, loadWeightsIfPresent } from './nodeIo';
import type { NeuralPolicy } from './net';
import { createRng, nextInt } from '../rng';

const RUN = process.env.ARENA === '1';

describe('arena', () => {
	(RUN ? it : it.skip)(
		'rank checkpoints by win-rate vs the field',
		async () => {
			const games = parseInt(process.env.ARENA_GAMES ?? '40', 10);
			const seats = parseInt(process.env.ARENA_SEATS ?? '4', 10);
			const maxRounds = parseInt(process.env.ARENA_MAXROUNDS ?? '40', 10);
			const catalog = await loadOrSnapshotCatalog();

			let files: string[];
			if (process.env.ARENA_FILES) files = process.env.ARENA_FILES.split(',').map((s) => s.trim());
			else {
				const dir = process.env.ARENA_DIR ?? 'ml/league';
				files = readdirSync(dir)
					.filter((f) => f.endsWith('.json'))
					.map((f) => join(dir, f));
			}
			const entries = files
				.map((f) => ({ name: basename(f).replace(/\.json$/, ''), pol: loadWeightsIfPresent(f) }))
				.filter((e): e is { name: string; pol: NeuralPolicy } => !!e.pol);
			const seatList = SEAT_COLORS.slice(0, seats) as SeatColor[];

			const results: { name: string; win: number; place: number; vp: number; rounds: number }[] = [];
			for (let ei = 0; ei < entries.length; ei++) {
				const me = entries[ei];
				const others = entries.filter((_, j) => j !== ei);
				if (others.length === 0) continue;
				const rng = createRng((1234 + ei * 99991) >>> 0);
				let wins = 0;
				let sumPlace = 0;
				let sumVp = 0;
				let sumRounds = 0;
				for (let g = 0; g < games; g++) {
					const mySeat = seatList[g % seats];
					const opponentPolicies: Partial<Record<SeatColor, NeuralPolicy>> = {};
					const neuralSeats: SeatColor[] = [mySeat];
					for (const s of seatList) {
						if (s === mySeat) continue;
						opponentPolicies[s] = others[nextInt(rng, others.length)].pol;
						neuralSeats.push(s);
					}
					const r = playRecordingGame(catalog, {
						seed: 7_700_000 + g + ei * 1000,
						profiles: seatList.map(() => profileFor('medium')),
						maxRounds,
						policy: me.pol,
						selection: 'hybrid',
						neuralSeats,
						opponentPolicies,
						recordSeats: []
					});
					const myVp = r.finalVP[mySeat] ?? 0;
					const place = 1 + seatList.filter((s) => s !== mySeat && (r.finalVP[s] ?? 0) > myVp).length;
					if (r.winnerSeat === mySeat) wins++;
					sumPlace += place;
					sumVp += myVp;
					sumRounds += r.rounds;
				}
				results.push({ name: me.name, win: wins / games, place: sumPlace / games, vp: sumVp / games, rounds: sumRounds / games });
			}

			results.sort((a, b) => b.win - a.win);
			const fair = (100 / seats).toFixed(0);
			// eslint-disable-next-line no-console
			console.log(`\n[arena] ${entries.length} models, ${games} games each vs the field (fair win=${fair}%):`);
			results.forEach((r, i) => {
				// eslint-disable-next-line no-console
				console.log(`[arena] #${i + 1}  ${r.name.padEnd(22)} win=${(100 * r.win).toFixed(1)}%  place=${r.place.toFixed(2)}  avgVP=${r.vp.toFixed(1)}  rounds=${r.rounds.toFixed(1)}`);
			});
		},
		60 * 60 * 1000
	);
});
