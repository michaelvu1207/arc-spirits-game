/**
 * Heuristic-profile VP audit. Plays all-heuristic games with a roster of bot profiles (one per
 * seat, rotated) and reports each PROFILE's avg VP + win% + reach30% + corruption + build, on the
 * true objective in 30-round games. Identifies which NON-CORRUPT profiles actually score — the
 * functional, diverse, deliverable strategies. HAUD=1 to run.
 *
 *   HAUD=1 HAUD_PROFILES=cultivator,paragon,aggressive,fighter,survivor,medium,pvphunter HAUD_GAMES=60 HAUD_SEATS=4 \
 *     npx vitest run src/lib/play/ml/_heuraudit.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { profileFor } from '../server/botPolicy';
import { SEAT_COLORS, type SeatColor } from '../types';
import { playRecordingGame } from './driver';
import { loadOrSnapshotCatalog, mlPath } from './nodeIo';

const RUN = process.env.HAUD === '1';

interface Agg { name: string; games: number; wins: number; reached30: number; sumVP: number; sumStatus: number; sumBarrier: number; sumDice: number; }

describe('heuristic profile audit', () => {
	(RUN ? it : it.skip)(
		'measure per-profile VP + behavior',
		async () => {
			const games = parseInt(process.env.HAUD_GAMES ?? '60', 10);
			const seats = parseInt(process.env.HAUD_SEATS ?? '4', 10);
			const maxRounds = parseInt(process.env.HAUD_MAXROUNDS ?? '30', 10);
			const profiles = (process.env.HAUD_PROFILES ?? 'cultivator,paragon,aggressive,fighter,survivor,medium,pvphunter')
				.split(',').map((s) => s.trim()).filter(Boolean);
			const catalog = await loadOrSnapshotCatalog();
			const seatList = SEAT_COLORS.slice(0, seats) as SeatColor[];
			const agg = new Map<string, Agg>();
			const get = (n: string) => { let a = agg.get(n); if (!a) { a = { name: n, games: 0, wins: 0, reached30: 0, sumVP: 0, sumStatus: 0, sumBarrier: 0, sumDice: 0 }; agg.set(n, a); } return a; };

			for (let g = 0; g < games; g++) {
				// Rotate profiles across seats so each profile plays every seat position.
				const seatProfiles = seatList.map((_, i) => profiles[(g + i) % profiles.length]);
				const r = playRecordingGame(catalog, {
					seed: 9_000_000 + g,
					profiles: seatProfiles.map((p) => profileFor(p)),
					maxRounds,
					recordSeats: []
				});
				seatList.forEach((s, i) => {
					const a = get(seatProfiles[i]);
					const fp = r.finalState?.players[s];
					const vp = r.finalVP[s] ?? 0;
					a.games++;
					if (r.winnerSeat === s) a.wins++;
					if (vp >= 30) a.reached30++;
					a.sumVP += vp;
					a.sumStatus += fp?.statusLevel ?? 0;
					a.sumBarrier += fp?.maxBarrier ?? 0;
					a.sumDice += fp?.attackDice?.length ?? 0;
				});
			}

			const rows = [...agg.values()].map((a) => ({
				name: a.name, avgVP: a.sumVP / a.games, winPct: (100 * a.wins) / a.games, reach30: (100 * a.reached30) / a.games,
				status: a.sumStatus / a.games, barrier: a.sumBarrier / a.games, dice: a.sumDice / a.games, games: a.games
			})).sort((x, y) => y.avgVP - x.avgVP);
			/* eslint-disable no-console */
			console.log(`\n[haud] ${rows.length} profiles, ${games} games, ${seats}p, maxRounds=${maxRounds} (sorted by VP):`);
			for (const r of rows) console.log(`[haud] ${r.name.padEnd(12)} VP=${r.avgVP.toFixed(1).padStart(5)} win%=${r.winPct.toFixed(0).padStart(3)} r30%=${r.reach30.toFixed(0).padStart(3)} status=${r.status.toFixed(2)} barrier=${r.barrier.toFixed(1)} dice=${r.dice.toFixed(1)} n=${r.games}`);
			const bestGood = rows.filter((r) => r.status < 1).sort((a, b) => b.avgVP - a.avgVP)[0];
			if (bestGood) console.log(`[haud] BEST NON-CORRUPT: ${bestGood.name} (VP=${bestGood.avgVP.toFixed(1)}, status=${bestGood.status.toFixed(2)})`);
			writeFileSync(mlPath('heuraudit_result.json'), JSON.stringify(rows, null, 2));
			console.log(`[haud] DONE → ml/heuraudit_result.json`);
			/* eslint-enable no-console */
		},
		60 * 60 * 1000
	);
});
