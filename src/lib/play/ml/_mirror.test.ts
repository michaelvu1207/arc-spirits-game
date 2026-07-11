/**
 * MIRROR-FIELD health probe. Plays N games where EVERY seat is the SAME policy at a
 * given sampling configuration — the live solo-game situation (one human quits, or
 * 3-4 bot copies share one monster ladder). Measures whether clones collide: do games
 * still finish by someone reaching 30 VP, and how much VP does the table produce?
 *
 * The serving question this answers: gauntlet Elo (single copy vs anchors) rises as
 * temperature → 0, but identical argmax clones pile onto the same plan and starve
 * (see NeuralPlanOptions.temperature). The live temperature must win BOTH measures.
 *
 *   MIRROR=1 MIRROR_WEIGHTS=ml/weights/v13-2-verify.json MIRROR_GAMES=200 \
 *     MIRROR_TEMP=0.65 npx vitest run src/lib/play/ml/_mirror.test.ts --disable-console-intercept
 *   MIRROR_NAV_TEMP=<t>  — sample ONLY navigation picks at t, argmax all other phases
 *                          (combinable with MIRROR_TEMP for the non-nav phases).
 */
import { describe, it } from 'vitest';
import { profileFor } from '../server/botPolicy';
import { SEAT_COLORS, type SeatColor, type PublicGameState } from '../types';
import type { LegalAction } from './actions';
import { playRecordingGame } from './driver';
import { hybridIndex } from './neuralBot';
import { loadOrSnapshotCatalog, loadWeightsIfPresent } from './nodeIo';

const RUN = process.env.MIRROR === '1';

describe('mirror-field health probe', () => {
	(RUN ? it : it.skip)(
		'N identical copies per game: do clones still close games?',
		async () => {
			const games = parseInt(process.env.MIRROR_GAMES ?? '200', 10);
			const seats = parseInt(process.env.MIRROR_SEATS ?? '4', 10);
			const maxRounds = parseInt(process.env.MIRROR_MAXROUNDS ?? '40', 10);
			const temp = parseFloat(process.env.MIRROR_TEMP ?? '0');
			const navTemp = parseFloat(process.env.MIRROR_NAV_TEMP ?? '0');
			const weightsPath = process.env.MIRROR_WEIGHTS;
			if (!weightsPath) throw new Error('mirror: set MIRROR_WEIGHTS');
			const pol = loadWeightsIfPresent(weightsPath);
			if (!pol) throw new Error(`mirror: cannot load ${weightsPath}`);
			const catalog = await loadOrSnapshotCatalog();

			const seatList = SEAT_COLORS.slice(0, seats) as SeatColor[];
			const tempFor = (phase: PublicGameState['phase']): number =>
				phase === 'navigation' && navTemp > 0 ? navTemp : temp;
			// chooser drives every non-opponentPolicies seat — here, all of them.
			const chooser =
				navTemp > 0
					? (
							_o: number[],
							_f: number[][],
							_c: unknown,
							_seat: SeatColor,
							st: PublicGameState,
							withNext: LegalAction[]
						): number => {
							const t = tempFor(st.phase);
							return hybridIndex(
								pol,
								st,
								_seat,
								withNext,
								t > 0 ? { sample: true, temperature: t } : { sample: false },
								catalog
							);
						}
					: undefined;

			let finished = 0;
			let reach30Games = 0;
			let sumWinnerVP = 0;
			let sumTableVP = 0;
			let sumRounds = 0;
			let spiritSaved = 0;
			for (let g = 0; g < games; g++) {
				const r = playRecordingGame(catalog, {
					...(chooser ? { chooser } : {}),
					...(temp > 0 && !chooser ? { sample: true, temperature: temp } : {}),
					seed: 9_100_000 + g,
					profiles: seatList.map(() => profileFor('medium')),
					maxRounds,
					policy: pol,
					selection: 'hybrid',
					neuralSeats: [...seatList],
					recordSeats: []
				});
				const vps = seatList.map((s) => r.finalVP[s] ?? 0);
				const best = Math.max(...vps);
				if (best >= 30) reach30Games++;
				if (r.finalState?.status === 'finished') finished++;
				if (r.finalState?.spiritWorldSaved) spiritSaved++;
				sumWinnerVP += best;
				sumTableVP += vps.reduce((a, b) => a + b, 0);
				sumRounds += r.rounds;
			}
			/* eslint-disable no-console */
			console.log(
				`[mirror] ${weightsPath} x${seats} | temp=${temp} navTemp=${navTemp} | ${games} games, maxRounds=${maxRounds}`
			);
			console.log(
				`[mirror] reach30 ${((100 * reach30Games) / games).toFixed(1)}% | winnerVP ${(sumWinnerVP / games).toFixed(2)} | tableVP ${(sumTableVP / games).toFixed(2)} | rounds ${(sumRounds / games).toFixed(1)} | finished ${((100 * finished) / games).toFixed(1)}% | spiritSaved ${((100 * spiritSaved) / games).toFixed(1)}%`
			);
		},
		60 * 60 * 1000
	);
});
