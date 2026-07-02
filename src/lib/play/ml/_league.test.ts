/**
 * League self-play data generation — TRUE net-vs-net. The LEARNER policy plays one seat (recorded)
 * against OPPONENT seats drawn from a POOL of frozen checkpoints (past selves / rival models),
 * optionally with a heuristic anchor seat to prevent collapse. Because the opponents are strong and
 * adaptive (not a fixed heuristic field), the learner can't lean on an anti-heuristic exploit — it
 * must find robust, genuinely strong VP-maximizing play.
 *
 *   LEAGUE=1 LEARNER=ml/weights/policy.json LEAGUE_DIR=ml/league GEN_GAMES=60 GEN_OUT=ml/data/lg_0.jsonl \
 *     npx vitest run src/lib/play/ml/_league.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { profileFor, type BotProfile } from '../server/botPolicy';
import { SEAT_COLORS, type GameCommand, type SeatColor } from '../types';
import { playRecordingGame } from './driver';
import { shapingFor } from './shaping';
import { appendSamples, loadOrSnapshotCatalog, loadWeightsIfPresent, writeMeta } from './nodeIo';
import type { NeuralPolicy } from './net';
import { createRng, nextInt } from '../rng';

/** Seeded Fisher-Yates — per-game guardian shuffle for varied starting identities. */
function shuffledGuardians(all: string[], take: number, seed: number): string[] {
	const a = [...all];
	const rng = createRng((seed ^ 0x6d2b79f5) >>> 0);
	for (let i = a.length - 1; i > 0; i--) {
		const j = nextInt(rng, i + 1);
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a.slice(0, take);
}

const RUN = process.env.LEAGUE === '1';

describe('league self-play', () => {
	(RUN ? it : it.skip)(
		'generate net-vs-net data',
		async () => {
			const games = parseInt(process.env.GEN_GAMES ?? '60', 10);
			const seats = parseInt(process.env.GEN_SEATS ?? '4', 10);
			const maxRounds = parseInt(process.env.GEN_MAXROUNDS ?? '40', 10);
			const out = process.env.GEN_OUT ?? 'ml/data/league.jsonl';
			const seed0 = parseInt(process.env.GEN_SEED0 ?? '1', 10);
			const iter = parseInt(process.env.GEN_ITER ?? '0', 10);
			const anchorP = parseFloat(process.env.GEN_ANCHOR_P ?? '0.2'); // chance an opp seat is a heuristic anchor
			const anchorProfile = process.env.GEN_ANCHOR ?? 'pvphunter';
			const sample = (process.env.GEN_SAMPLE ?? '1') === '1';
			const temp = process.env.GEN_TEMP ? parseFloat(process.env.GEN_TEMP) : 1.0;

			const catalog = await loadOrSnapshotCatalog();
			const learner = loadWeightsIfPresent(process.env.LEARNER ?? 'ml/weights/policy.json');
			if (!learner) throw new Error('no learner policy at LEARNER');

				// Diversity levers: per-game guardian/origin variety + optional forbidden actions
				// (GEN_FORBID=initiatePvp → no PvP-VP, forcing a monster/economy line). GEN_GUARDIANS
				// fixes a lineup for origin specialization.
				const allGuardians = catalog.guardians.map((g) => g.name);
				const fixedGuardians = process.env.GEN_GUARDIANS
					? process.env.GEN_GUARDIANS.split(',').map((s) => s.trim()).filter(Boolean)
					: null;
				const shuffleGuardians = (process.env.GEN_SHUFFLE_GUARDIANS ?? '1') === '1';
				const forbidTypes = process.env.GEN_FORBID
					? new Set(process.env.GEN_FORBID.split(',').map((s) => s.trim()).filter(Boolean) as GameCommand['type'][])
					: undefined;
				const maxStatusLevel = process.env.GEN_MAX_STATUS_LEVEL
					? parseInt(process.env.GEN_MAX_STATUS_LEVEL, 10)
					: undefined;

			// Load the opponent pool (frozen rival/past-self checkpoints).
			const dir = process.env.LEAGUE_DIR ?? 'ml/league';
			let poolFiles: string[] = [];
			try {
				poolFiles = readdirSync(dir)
					.filter((f) => f.endsWith('.json'))
					.map((f) => join(dir, f));
			} catch {
				/* no pool yet → bootstrap vs heuristics */
			}
			const pool = poolFiles.map((f) => loadWeightsIfPresent(f)).filter((p): p is NeuralPolicy => !!p);

			const seatList = SEAT_COLORS.slice(0, seats) as SeatColor[];
			const rng = createRng((seed0 ^ 0x51a9b3) >>> 0);
			let total = 0;
			let lwins = 0;
			let finished = 0;

			for (let g = 0; g < games; g++) {
				const learnerSeat = seatList[g % seats];
				const opponentPolicies: Partial<Record<SeatColor, NeuralPolicy>> = {};
				const profiles: BotProfile[] = seatList.map(() => profileFor('medium')); // guardian + fallback
				const neuralSeats: SeatColor[] = [learnerSeat];
				for (let i = 0; i < seatList.length; i++) {
					const s = seatList[i];
					if (s === learnerSeat) continue;
					const useAnchor = pool.length === 0 || nextInt(rng, 1000) / 1000 < anchorP;
					if (useAnchor) {
						profiles[i] = profileFor(anchorProfile); // heuristic anchor seat (not neural)
					} else {
						opponentPolicies[s] = pool[nextInt(rng, pool.length)]; // frozen rival
						neuralSeats.push(s);
					}
				}
				const r = playRecordingGame(catalog, {
					seed: seed0 + g,
					profiles,
					maxRounds,
					policy: learner,
					selection: (process.env.GEN_SELECTION as 'hybrid' | 'value' | 'policy') ?? 'hybrid',
					neuralSeats,
					opponentPolicies,
					recordSeats: [learnerSeat],
					sample,
					temperature: temp,
					shaping: shapingFor(process.env.GEN_SHAPING),
					gamma: process.env.GEN_GAMMA ? parseFloat(process.env.GEN_GAMMA) : undefined,
						guardianNames: fixedGuardians ?? (shuffleGuardians ? shuffledGuardians(allGuardians, seats, seed0 + g) : undefined),
						forbidTypes,
						maxStatusLevel
				});
				appendSamples(out, r.samples, iter);
				total += r.samples.length;
				if (r.finished) finished++;
				if (r.winnerSeat === learnerSeat) lwins++;
			}

			writeMeta(total, games, {
				mode: 'league',
				iter,
				learnerWinRate: lwins / games,
				poolSize: pool.length,
				out,
				forbidTypes: [...(forbidTypes ?? [])],
				maxStatusLevel
			});
			// eslint-disable-next-line no-console
			console.log(
				`[league] DONE games=${games} pool=${pool.length} learnerWin=${((100 * lwins) / games).toFixed(1)}% (fair=${(100 / seats).toFixed(0)}%) finished=${((100 * finished) / games).toFixed(0)}% samples=${total} → ${out}`
			);
		},
		60 * 60 * 1000
	);
});
