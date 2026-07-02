/**
 * Neural-bot EVALUATION vs the heuristic field (the success gate). Opt-in via EVAL=1.
 * Plays the current net (greedy) in one rotating seat against a field of a given heuristic
 * (or a 'mixed' field) and reports win rate, average placement, and VP. Writes
 * ml/eval_result.json so results survive vitest's console interception.
 *
 *   EVAL=1 EVAL_GAMES=40 EVAL_OPPONENTS=pvphunter,medium,mixed npx vitest run src/lib/play/ml/_eval.test.ts
 *
 * In a 4-player game 25% is a fair share; >25% vs `pvphunter` (the strongest line under
 * current rules) means the bot is genuinely beating the heuristics.
 */
import { describe, it } from 'vitest';
import { profileFor } from '../server/botPolicy';
import { SEAT_COLORS, type GameCommand, type SeatColor } from '../types';
import { playRecordingGame } from './driver';
import { loadOrSnapshotCatalog, loadWeightsIfPresent, mlPath } from './nodeIo';
import { writeFileSync } from 'node:fs';

const RUN = process.env.EVAL === '1';
// A realistic ranked mix for the 'mixed' opponent field (cycled across the non-neural seats).
const MIXED = ['pvphunter', 'medium', 'aggressive', 'cultivator', 'hard', 'survivor'];

describe('ml eval', () => {
	(RUN ? it : it.skip)(
		'neural vs heuristic fields',
		async () => {
			const gamesPer = parseInt(process.env.EVAL_GAMES ?? '40', 10);
			const seats = parseInt(process.env.EVAL_SEATS ?? '4', 10);
			const maxRounds = parseInt(process.env.EVAL_MAXROUNDS ?? '120', 10);
			const opponents = (process.env.EVAL_OPPONENTS ?? 'pvphunter,medium,mixed').split(',');
			const forbidTypes = process.env.EVAL_FORBID
				? new Set(process.env.EVAL_FORBID.split(',').map((s) => s.trim()).filter(Boolean) as GameCommand['type'][])
				: undefined;
			const maxStatusLevel = process.env.EVAL_MAX_STATUS_LEVEL
				? parseInt(process.env.EVAL_MAX_STATUS_LEVEL, 10)
				: undefined;
			const catalog = await loadOrSnapshotCatalog();
			const weightsPath = process.env.EVAL_WEIGHTS;
			const policy = weightsPath ? loadWeightsIfPresent(weightsPath) : loadWeightsIfPresent();
			if (!policy)
				throw new Error(`EVAL: no weights found at ${weightsPath ?? 'ml/weights/policy.json'}`);
			const seatList = SEAT_COLORS.slice(0, seats) as SeatColor[];

			const results: Record<string, unknown>[] = [];
			for (const opp of opponents) {
				let wins = 0;
				let sumPlace = 0;
				let sumVP = 0;
				let sumOppVP = 0;
				let finished = 0;
				let sumRounds = 0;
				for (let g = 0; g < gamesPer; g++) {
					const neuralSeat = seatList[g % seats];
					const profiles = seatList.map((_, i) =>
						profileFor(opp === 'mixed' ? MIXED[(g + i) % MIXED.length] : opp)
					);
					const r = playRecordingGame(catalog, {
						seed: 5_000_000 + g,
						profiles,
						maxRounds,
						policy,
						selection: (process.env.EVAL_SELECTION as 'hybrid' | 'value' | 'policy') ?? 'hybrid',
						neuralSeats: [neuralSeat],
						recordSeats: [], // eval only — no data recording
						forbidTypes,
						maxStatusLevel
					});
					const myVP = r.finalVP[neuralSeat] ?? 0;
					const others = seatList.filter((s) => s !== neuralSeat).map((s) => r.finalVP[s] ?? 0);
					const place = 1 + others.filter((v) => v > myVP).length;
					sumPlace += place;
					sumVP += myVP;
					sumOppVP += others.reduce((a, b) => a + b, 0) / others.length;
					if (r.winnerSeat === neuralSeat) wins += 1;
					if (r.finished) finished += 1;
					sumRounds += r.rounds;
				}
				const avgVP = sumVP / gamesPer;
				const avgRounds = sumRounds / gamesPer;
				const res = {
					opponent: opp,
					games: gamesPer,
					winRate: wins / gamesPer,
					avgPlace: sumPlace / gamesPer,
					avgVP,
					avgOppVP: sumOppVP / gamesPer,
					avgRounds,
					vpPerTurn: avgRounds > 0 ? avgVP / avgRounds : 0,
					finishedRate: finished / gamesPer
				};
				results.push(res);
				// eslint-disable-next-line no-console
				console.log(
					`[eval] neural vs ${opp}: win=${(100 * res.winRate).toFixed(1)}% (fair=25%) avgPlace=${res.avgPlace.toFixed(2)} ` +
						`avgVP=${res.avgVP.toFixed(1)} oppVP=${res.avgOppVP.toFixed(1)} avgRounds=${res.avgRounds.toFixed(1)} finished=${(100 * res.finishedRate).toFixed(0)}%`
				);
			}
			writeFileSync(
				mlPath('eval_result.json'),
				JSON.stringify({ seats, gamesPer, forbidTypes: [...(forbidTypes ?? [])], maxStatusLevel, results }, null, 2)
			);
			// eslint-disable-next-line no-console
			console.log('[eval] DONE → ml/eval_result.json');
		},
		60 * 60 * 1000
	);
});
