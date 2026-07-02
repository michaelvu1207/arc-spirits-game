/**
 * Champion strategy trace — plays the loaded policy (neural seat) vs a heuristic field and dumps
 * the END-GAME build it converges on: awakened classes, dice tiers, max barrier, corruption status,
 * relics/augments, guardian/origin, and how decisively it wins (reached 30 VP?). STRAT=1 to run.
 */
import { describe, it } from 'vitest';
import { profileFor } from '../server/botPolicy';
import { SEAT_COLORS, type SeatColor } from '../types';
import { playRecordingGame } from './driver';
import { loadOrSnapshotCatalog, loadWeightsIfPresent } from './nodeIo';
import { awakenedClassCounts } from '../effects/apply';

const RUN = process.env.STRAT === '1';

describe('champion strategy trace', () => {
	(RUN ? it : it.skip)(
		'dump champion builds',
		async () => {
			const catalog = await loadOrSnapshotCatalog();
			const policy = loadWeightsIfPresent();
			if (!policy) throw new Error('no policy at ml/weights/policy.json');
			const games = parseInt(process.env.STRAT_GAMES ?? '24', 10);
			const opp = process.env.STRAT_OPP ?? 'medium';
			const seats = SEAT_COLORS.slice(0, 4) as SeatColor[];

			const classAgg: Record<string, number> = {};
			const diceAgg: Record<string, number> = {};
			const originAgg: Record<string, number> = {};
			const s = { vp: 0, rounds: 0, maxBarrier: 0, status: 0, relics: 0, augments: 0, evil: 0, won: 0, reached30: 0, spirits: 0, n: 0 };

			for (let g = 0; g < games; g++) {
				const neuralSeat = seats[g % 4];
				const profiles = seats.map(() => profileFor(opp));
				const r = playRecordingGame(catalog, {
					seed: 9_000_000 + g,
					profiles,
					maxRounds: 40,
					policy,
					selection: 'hybrid',
					neuralSeats: [neuralSeat],
					recordSeats: []
				});
				const p = r.finalState?.players?.[neuralSeat];
				if (!p) continue;
				s.n++;
				s.vp += p.victoryPoints;
				s.rounds += r.rounds;
				s.maxBarrier += p.maxBarrier ?? 0;
				s.status += p.statusLevel ?? 0;
				s.relics += p.relics ?? 0;
				s.augments += p.spiritAugments ?? 0;
				s.spirits += p.spirits?.length ?? 0;
				if ((p.statusLevel ?? 0) >= 3) s.evil++;
				if (r.winnerSeat === neuralSeat) s.won++;
				if (p.victoryPoints >= 30) s.reached30++;
				for (const [k, v] of Object.entries(awakenedClassCounts(p))) classAgg[k] = (classAgg[k] ?? 0) + v;
				for (const d of p.attackDice ?? []) diceAgg[d.tier] = (diceAgg[d.tier] ?? 0) + 1;
				const origin = p.selectedGuardian ?? '?';
				originAgg[origin] = (originAgg[origin] ?? 0) + 1;
			}

			const a = (x: number) => (x / Math.max(1, s.n)).toFixed(1);
			const top = (o: Record<string, number>) =>
				Object.entries(o)
					.sort((x, y) => y[1] - x[1])
					.map(([k, v]) => `${k}:${(v / s.n).toFixed(1)}`)
					.join('  ');
			// eslint-disable-next-line no-console
			console.log(`\n[strat] champion vs ${opp} — ${s.n} games`);
			// eslint-disable-next-line no-console
			console.log(`[strat] won=${((100 * s.won) / s.n).toFixed(0)}%  reached30VP=${((100 * s.reached30) / s.n).toFixed(0)}%  avgVP=${a(s.vp)}  avgRounds=${a(s.rounds)}`);
			// eslint-disable-next-line no-console
			console.log(`[strat] build: avgMaxBarrier=${a(s.maxBarrier)}  avgStatus=${a(s.status)}(0=Pure→3=Fallen)  endedEvil=${((100 * s.evil) / s.n).toFixed(0)}%  spirits=${a(s.spirits)}  relics=${a(s.relics)}  augments=${a(s.augments)}`);
			// eslint-disable-next-line no-console
			console.log(`[strat] awakened classes / game: ${top(classAgg)}`);
			// eslint-disable-next-line no-console
			console.log(`[strat] dice by tier / game:      ${top(diceAgg)}`);
			// eslint-disable-next-line no-console
			console.log(`[strat] guardian pick freq:       ${top(originAgg)}`);
		},
		300000
	);
});
