/**
 * Diagnostic: what does the trained neural bot actually DO? Logs the chosen-command-type
 * distribution + key strategic counts (navigation targets, combats, PvP) over a few games,
 * to explain pathological results (e.g. ~0 VP). DIAG=1 to run.
 */
import { describe, it } from 'vitest';
import { profileFor } from '../server/botPolicy';
import { SEAT_COLORS, type GameCommand, type SeatColor } from '../types';
import { playRecordingGame } from './driver';
import { legalActionsWithNext } from './actions';
import { valueGuidedIndex, hybridIndex } from './neuralBot';
import { loadOrSnapshotCatalog, loadWeightsIfPresent } from './nodeIo';

const RUN = process.env.DIAG === '1';

describe('ml diag', () => {
	(RUN ? it : it.skip)(
		'neural action distribution',
		async () => {
			const games = parseInt(process.env.DIAG_GAMES ?? '6', 10);
			const opp = process.env.DIAG_OPP ?? 'medium';
			const catalog = await loadOrSnapshotCatalog();
			const policy = loadWeightsIfPresent();
			if (!policy) throw new Error('no weights');
			const seatList = SEAT_COLORS.slice(0, 4) as SeatColor[];

			const typeCount: Record<string, number> = {};
			const navTargets: Record<string, number> = {};
			let decisions = 0;
			let vpSum = 0;

			for (let g = 0; g < games; g++) {
				const neuralSeat = seatList[g % 4];
				const profiles = seatList.map(() => profileFor(opp));
				const r = playRecordingGame(catalog, {
					seed: 9_000_000 + g,
					profiles,
					maxRounds: 90,
					neuralSeats: [neuralSeat],
					recordSeats: [],
					chooser: (obs, feats, cands: GameCommand[], seat, st) => {
						// DIAG_SELECTION=policy|value (default policy) — measure what the bot does.
						const sel = process.env.DIAG_SELECTION ?? 'hybrid';
						let idx: number;
						if (sel === 'policy') {
							idx = policy.pick(obs, feats, { sample: false });
						} else if (sel === 'value') {
							idx = valueGuidedIndex(policy, st, seat, legalActionsWithNext(st, seat, catalog), undefined, catalog);
						} else {
							idx = hybridIndex(policy, st, seat, legalActionsWithNext(st, seat, catalog), undefined, catalog);
						}
						const cmd = cands[idx];
						typeCount[cmd.type] = (typeCount[cmd.type] ?? 0) + 1;
						if (cmd.type === 'lockNavigation') navTargets[cmd.destination] = (navTargets[cmd.destination] ?? 0) + 1;
						decisions += 1;
						return idx;
					}
				});
				vpSum += r.finalVP[neuralSeat] ?? 0;
			}

			const sorted = Object.entries(typeCount).sort((a, b) => b[1] - a[1]);
			// eslint-disable-next-line no-console
			console.log(`[diag] ${games} games · ${decisions} neural decisions · avgVP=${(vpSum / games).toFixed(2)}`);
			// eslint-disable-next-line no-console
			console.log('[diag] action types:', sorted.map(([t, c]) => `${t}=${c}`).join('  '));
			// eslint-disable-next-line no-console
			console.log('[diag] nav targets:', Object.entries(navTargets).map(([d, c]) => `${d}=${c}`).join('  '));
		},
		20 * 60 * 1000
	);
});
