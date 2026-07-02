/**
 * ELO tournament — rate every trained model on one scale. Plays many mixed games (a random subset
 * of models per game), ranks the seats by final VP, and applies pairwise Elo updates from the
 * placement order. Reports the Elo table (sorted) plus the best model overall and the best model at
 * each parameter-size tier. ELO=1 to run.
 *
 *   ELO=1 ELO_DIR=/path/to/models ELO_GAMES=400 npx vitest run src/lib/play/ml/_elo.test.ts --disable-console-intercept
 *   ELO=1 ELO_FILES=a.json,b.json,... ELO_GAMES=400 ...
 */
import { describe, it } from 'vitest';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { profileFor } from '../server/botPolicy';
import { SEAT_COLORS, type SeatColor } from '../types';
import { playRecordingGame } from './driver';
import { loadOrSnapshotCatalog, loadWeightsIfPresent, mlPath } from './nodeIo';
import type { NeuralPolicy } from './net';
import { createRng, nextInt } from '../rng';

const RUN = process.env.ELO === '1';

interface Model {
	name: string;
	pol: NeuralPolicy;
	params: number;
	elo: number;
	games: number;
}

describe('elo tournament', () => {
	(RUN ? it : it.skip)(
		'rate all models on one scale',
		async () => {
			const games = parseInt(process.env.ELO_GAMES ?? '400', 10);
			const seats = parseInt(process.env.ELO_SEATS ?? '4', 10);
			const maxRounds = parseInt(process.env.ELO_MAXROUNDS ?? '40', 10);
			const K = parseFloat(process.env.ELO_K ?? '24');
			const catalog = await loadOrSnapshotCatalog();

			let files: string[];
			if (process.env.ELO_FILES) files = process.env.ELO_FILES.split(',').map((s) => s.trim());
			else {
				const dir = process.env.ELO_DIR ?? mlPath('league');
				files = readdirSync(dir)
					.filter((f) => f.endsWith('.json'))
					.map((f) => join(dir, f));
			}
			const models: Model[] = [];
			for (const f of files) {
				const pol = loadWeightsIfPresent(f);
				if (!pol) continue;
				let params = 0;
				try {
					params = JSON.parse(readFileSync(f, 'utf8')).params ?? 0;
				} catch {
					/* ignore */
				}
				models.push({ name: basename(f).replace(/\.json$/, ''), pol, params, elo: 1000, games: 0 });
			}
			if (models.length < seats) throw new Error(`need >= ${seats} models, have ${models.length}`);

			const seatList = SEAT_COLORS.slice(0, seats) as SeatColor[];
			const rng = createRng(0xe10 + games);
			const shuffle = <T>(a: T[]): T[] => {
				for (let i = a.length - 1; i > 0; i--) {
					const j = nextInt(rng, i + 1);
					[a[i], a[j]] = [a[j], a[i]];
				}
				return a;
			};

			for (let g = 0; g < games; g++) {
				const lineup = shuffle([...models.keys()]).slice(0, seats); // model indices for each seat
				const opponentPolicies: Partial<Record<SeatColor, NeuralPolicy>> = {};
				seatList.forEach((s, i) => {
					if (i > 0) opponentPolicies[s] = models[lineup[i]].pol;
				});
				const r = playRecordingGame(catalog, {
					seed: 6_100_000 + g,
					profiles: seatList.map(() => profileFor('medium')),
					maxRounds,
					policy: models[lineup[0]].pol, // seat0 = "learner" slot, rest are opponentPolicies
					selection: 'hybrid',
					neuralSeats: [...seatList],
					opponentPolicies,
					recordSeats: []
				});
				// Rank seats by final VP (desc) → placement order of the model indices.
				const ranked = seatList
					.map((s, i) => ({ idx: lineup[i], vp: r.finalVP[s] ?? 0 }))
					.sort((a, b) => b.vp - a.vp);
				// Pairwise Elo update for every (higher, lower) pair.
				for (let a = 0; a < ranked.length; a++) {
					for (let b = a + 1; b < ranked.length; b++) {
						const A = models[ranked[a].idx];
						const B = models[ranked[b].idx];
						const sA = ranked[a].vp === ranked[b].vp ? 0.5 : 1;
						const eA = 1 / (1 + Math.pow(10, (B.elo - A.elo) / 400));
						A.elo += K * (sA - eA);
						B.elo += K * (1 - sA - (1 - eA));
					}
				}
				models.forEach((m, i) => {
					if (lineup.includes(i)) m.games++;
				});
			}

			models.sort((a, b) => b.elo - a.elo);
			// eslint-disable-next-line no-console
			console.log(`\n[elo] ${models.length} models, ${games} games, K=${K}:`);
			models.forEach((m, i) => {
				// eslint-disable-next-line no-console
				console.log(`[elo] #${String(i + 1).padStart(2)}  elo=${m.elo.toFixed(0).padStart(5)}  ${m.name.padEnd(26)} params=${m.params.toLocaleString().padStart(13)}  games=${m.games}`);
			});
			// Best per size tier (group by rounded log10 params).
			const tiers = new Map<number, Model>();
			for (const m of models) {
				const t = m.params > 0 ? Math.round(Math.log10(m.params) * 2) : 0;
				if (!tiers.has(t) || tiers.get(t)!.elo < m.elo) tiers.set(t, m);
			}
			// eslint-disable-next-line no-console
			console.log(`\n[elo] BEST PER SIZE TIER:`);
			[...tiers.values()]
				.sort((a, b) => a.params - b.params)
				.forEach((m) => {
					// eslint-disable-next-line no-console
					console.log(`[elo]   ${m.params.toLocaleString().padStart(13)} params → elo=${m.elo.toFixed(0)}  ${m.name}`);
				});
			writeFileSync(mlPath('elo_result.json'), JSON.stringify(models.map((m) => ({ name: m.name, elo: Math.round(m.elo), params: m.params, games: m.games })), null, 2));
			// eslint-disable-next-line no-console
			console.log(`[elo] DONE → ml/elo_result.json`);
		},
		60 * 60 * 1000
	);
});
