/**
 * AlphaZero population league matrix. This is the learned-policy promotion gate:
 * every checkpoint plays focused pairwise duels through the same full-command
 * AlphaZero path, then the run writes a pair matrix plus Elo-style ratings.
 *
 *   AZLEAGUE=1 AZLEAGUE_FILES=a.json,b.json,c.json AZLEAGUE_GAMES=12 \
 *     npx vitest run src/lib/play/ml/_azleague.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { profileFor } from '../server/botPolicy';
import { SEAT_COLORS, type GameCommand, type PrivatePlayerState, type SeatColor } from '../types';
import { loadOrSnapshotCatalog, loadPolicyForEval, mlPath } from './nodeIo';
import { playPlannerSelfPlayGame } from './selfplay';
import type { NeuralPolicy } from './net';

const RUN = process.env.AZLEAGUE === '1';

interface Model {
	name: string;
	file: string;
	policy: NeuralPolicy;
}

interface Totals {
	seatGames: number;
	teamGames: number;
	teamVpWins: number;
	teamWinnerWins: number;
	seatWinnerWins: number;
	place: number;
	vp: number;
	reach30: number;
	status: number;
	monsterKills: number;
}

interface PairSide {
	name: string;
	team_vp_win_pct: number;
	team_winner_pct: number;
	seat_winner_pct: number;
	avg_place: number;
	avg_vp: number;
	reach30_pct: number;
	avg_status: number;
	avg_monster_kills: number;
}

interface PairResult {
	a: string;
	b: string;
	games: number;
	a_result: PairSide;
	b_result: PairSide;
}

function parseForbidTypes(): Set<GameCommand['type']> | undefined {
	const raw = process.env.AZLEAGUE_FORBID_TYPES ?? process.env.AZ_FORBID_TYPES ?? process.env.AZ_FORBID;
	if (!raw) return undefined;
	const types = raw.split(',').map((s) => s.trim()).filter(Boolean) as GameCommand['type'][];
	return types.length > 0 ? new Set(types) : undefined;
}

function statusOf(player: PrivatePlayerState | undefined): number {
	return player?.statusLevel ?? 0;
}

function blankTotals(): Totals {
	return {
		seatGames: 0,
		teamGames: 0,
		teamVpWins: 0,
		teamWinnerWins: 0,
		seatWinnerWins: 0,
		place: 0,
		vp: 0,
		reach30: 0,
		status: 0,
		monsterKills: 0
	};
}

function side(name: string, totals: Totals): PairSide {
	const seatDenom = Math.max(1, totals.seatGames);
	const teamDenom = Math.max(1, totals.teamGames);
	return {
		name,
		team_vp_win_pct: +((100 * totals.teamVpWins) / teamDenom).toFixed(1),
		team_winner_pct: +((100 * totals.teamWinnerWins) / teamDenom).toFixed(1),
		seat_winner_pct: +((100 * totals.seatWinnerWins) / seatDenom).toFixed(1),
		avg_place: +(totals.place / seatDenom).toFixed(2),
		avg_vp: +(totals.vp / seatDenom).toFixed(2),
		reach30_pct: +((100 * totals.reach30) / seatDenom).toFixed(1),
		avg_status: +(totals.status / seatDenom).toFixed(2),
		avg_monster_kills: +(totals.monsterKills / seatDenom).toFixed(2)
	};
}

describe('AlphaZero population league matrix', () => {
	(RUN ? it : it.skip)(
		'rates trained checkpoints with focused AlphaZero pairwise duels',
		async () => {
			const rawFiles = (process.env.AZLEAGUE_FILES ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			if (rawFiles.length < 2) throw new Error('AZLEAGUE_FILES must include at least two checkpoint files');
			const rawNames = (process.env.AZLEAGUE_NAMES ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			const models: Model[] = rawFiles.map((file, i) => ({
				file,
				name: rawNames[i] || basename(file).replace(/\.json$/, ''),
				policy: loadPolicyForEval(file)
			}));

			const pairGames = parseInt(process.env.AZLEAGUE_GAMES ?? '12', 10);
			const iterations = parseInt(process.env.AZLEAGUE_ITERS ?? '64', 10);
			const horizon = parseInt(process.env.AZLEAGUE_HORIZON ?? '24', 10);
			const valueWeight = parseFloat(process.env.AZLEAGUE_VALUEW ?? '1');
			const seatsN = parseInt(process.env.AZLEAGUE_SEATS ?? '4', 10);
			const maxRounds = parseInt(process.env.AZLEAGUE_MAXROUNDS ?? '30', 10);
			const sampleMoves = process.env.AZLEAGUE_SAMPLE === '1';
			const temperature = parseFloat(process.env.AZLEAGUE_TEMP ?? '0.25');
			const microProfile = process.env.AZLEAGUE_PROFILE ?? process.env.AZ_PLANNER_PROFILE ?? 'random';
			const control = process.env.AZLEAGUE_CONTROL === 'navigation' ? 'navigation' : 'full';
			const fullSelection =
				process.env.AZLEAGUE_FULL_SELECTION === 'policy' ||
				process.env.AZLEAGUE_FULL_SELECTION === 'hybrid' ||
				process.env.AZLEAGUE_FULL_SELECTION === 'lookahead'
					? process.env.AZLEAGUE_FULL_SELECTION
					: process.env.AZ_FULL_SELECTION === 'policy' ||
						  process.env.AZ_FULL_SELECTION === 'hybrid' ||
						  process.env.AZ_FULL_SELECTION === 'lookahead'
						? process.env.AZ_FULL_SELECTION
						: 'value';
			const fullLookaheadDepth = parseInt(process.env.AZLEAGUE_FULL_LOOKAHEAD_DEPTH ?? process.env.AZ_FULL_LOOKAHEAD_DEPTH ?? process.env.AZ_LOOKAHEAD_DEPTH ?? '2', 10);
			const fullLookaheadBeam = parseInt(process.env.AZLEAGUE_FULL_LOOKAHEAD_BEAM ?? process.env.AZ_FULL_LOOKAHEAD_BEAM ?? process.env.AZ_LOOKAHEAD_BEAM ?? '8', 10);
			const fullLookaheadRootBeam = parseInt(process.env.AZLEAGUE_FULL_LOOKAHEAD_ROOT_BEAM ?? process.env.AZ_FULL_LOOKAHEAD_ROOT_BEAM ?? process.env.AZ_LOOKAHEAD_ROOT_BEAM ?? '24', 10);
			const fullTargetTemperature = parseFloat(process.env.AZLEAGUE_FULL_TARGET_TEMP ?? process.env.AZ_FULL_TARGET_TEMP ?? process.env.AZ_TARGET_TEMP ?? '0.25');
			const farmValueBonus = parseFloat(process.env.AZLEAGUE_FARM_VALUE_BONUS ?? process.env.AZ_FARM_VALUE_BONUS ?? '0');
			const farmValueThreshold = parseFloat(process.env.AZLEAGUE_FARM_VALUE_THRESHOLD ?? process.env.AZ_FARM_VALUE_THRESHOLD ?? '0');
			const forbidTypes = parseForbidTypes();
			const maxStatusLevel = process.env.AZLEAGUE_MAX_STATUS_LEVEL
				? parseInt(process.env.AZLEAGUE_MAX_STATUS_LEVEL, 10)
				: process.env.AZ_MAX_STATUS_LEVEL
					? parseInt(process.env.AZ_MAX_STATUS_LEVEL, 10)
					: undefined;
			const hardConstraints =
				(process.env.AZLEAGUE_HARD_CONSTRAINTS ?? process.env.AZ_HARD_CONSTRAINTS ?? (maxStatusLevel !== undefined ? '1' : '0')) === '1';
			const eloK = parseFloat(process.env.AZLEAGUE_ELO_K ?? '24');
			const out = process.env.AZLEAGUE_OUT ?? mlPath('azleague_result.json');

			const catalog = await loadOrSnapshotCatalog();
			const n = Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
			if (n < 2) throw new Error(`need at least two seats, have ${n}`);
			const seatList = SEAT_COLORS.slice(0, n) as SeatColor[];
			const profiles = seatList.map(() => profileFor(microProfile));
			const totals = models.map(blankTotals);
			const elos = models.map(() => 1000);
			const pairResults: PairResult[] = [];

			for (let a = 0; a < models.length; a++) {
				for (let b = a + 1; b < models.length; b++) {
					const pairTotals = [blankTotals(), blankTotals()];
					for (let g = 0; g < pairGames; g++) {
						const modelIndexBySeat = seatList.map((_, i) => ((g + i) % 2 === 0 ? a : b));
						const seatPolicies: Partial<Record<SeatColor, NeuralPolicy>> = {};
						seatList.forEach((seat, i) => {
							seatPolicies[seat] = models[modelIndexBySeat[i]].policy;
						});
						const r = playPlannerSelfPlayGame(catalog, {
							seed: 10_200_000 + a * 100_000 + b * 1_000 + g,
							profiles,
							policy: models[a].policy,
							seatPolicies,
							plannerSeats: seatList,
							recordSeats: [],
							planner: { iterations, horizon, valueWeight, c: 1.5, farmValueBonus, farmValueThreshold },
							maxRounds,
							sampleMoves,
							temperature,
							control,
							fullSelection,
							fullLookaheadDepth,
							fullLookaheadBeam,
							fullLookaheadRootBeam,
							fullTargetTemperature,
							forbidTypes,
							maxStatusLevel,
							hardConstraints
						});

						let teamA = 0;
						let teamB = 0;
						for (const seat of seatList) {
							const modelIdx = modelIndexBySeat[seatList.indexOf(seat)];
							const pairIdx = modelIdx === a ? 0 : 1;
							const allTotals = totals[modelIdx];
							const pair = pairTotals[pairIdx];
							const vp = r.finalVP[seat] ?? 0;
							if (modelIdx === a) teamA += vp;
							else teamB += vp;
							const place = 1 + seatList.filter((other) => other !== seat && (r.finalVP[other] ?? 0) > vp).length;
							for (const bucket of [allTotals, pair]) {
								bucket.seatGames += 1;
								bucket.place += place;
								bucket.vp += vp;
								if (vp >= 30) bucket.reach30 += 1;
								bucket.status += statusOf(r.finalState.players[seat]);
								bucket.monsterKills += r.plannerStats[seat]?.kills ?? 0;
								if (r.winnerSeat === seat) bucket.seatWinnerWins += 1;
							}
						}

						const gameWinnerIdx = r.winnerSeat ? modelIndexBySeat[seatList.indexOf(r.winnerSeat)] : null;
						const scoreA = teamA === teamB ? 0.5 : teamA > teamB ? 1 : 0;
						const expectedA = 1 / (1 + Math.pow(10, (elos[b] - elos[a]) / 400));
						elos[a] += eloK * (scoreA - expectedA);
						elos[b] += eloK * (1 - scoreA - (1 - expectedA));
						for (const [modelIdx, pairIdx, teamVpWins, teamWinnerWins] of [
							[a, 0, scoreA === 1 ? 1 : scoreA === 0.5 ? 0.5 : 0, gameWinnerIdx === a ? 1 : 0],
							[b, 1, scoreA === 0 ? 1 : scoreA === 0.5 ? 0.5 : 0, gameWinnerIdx === b ? 1 : 0]
						] as const) {
							for (const bucket of [totals[modelIdx], pairTotals[pairIdx]]) {
								bucket.teamGames += 1;
								bucket.teamVpWins += teamVpWins;
								bucket.teamWinnerWins += teamWinnerWins;
							}
						}
					}
					const result = {
						a: models[a].name,
						b: models[b].name,
						games: pairGames,
						a_result: side(models[a].name, pairTotals[0]),
						b_result: side(models[b].name, pairTotals[1])
					};
					pairResults.push(result);
					/* eslint-disable no-console */
					console.log(
						`[azleague] ${models[a].name} vs ${models[b].name}: ` +
							`${result.a_result.team_vp_win_pct.toFixed(1)}%-${result.b_result.team_vp_win_pct.toFixed(1)}% teamVP, ` +
							`VP ${result.a_result.avg_vp.toFixed(2)}-${result.b_result.avg_vp.toFixed(2)}`
					);
					/* eslint-enable no-console */
				}
			}

			const ratings = models
				.map((m, i) => ({
					file: m.file,
					elo: Math.round(elos[i]),
					...side(m.name, totals[i])
				}))
				.sort((x, y) => y.elo - x.elo || y.team_vp_win_pct - x.team_vp_win_pct || y.avg_vp - x.avg_vp);
			const payload = {
				models: models.map((m) => ({ name: m.name, file: m.file })),
				pairGames,
				seats: n,
				iterations,
				horizon,
				valueWeight,
				maxRounds,
				control,
				fullSelection,
				fullLookaheadDepth,
				fullLookaheadBeam,
				fullLookaheadRootBeam,
				fullTargetTemperature,
				farmValueBonus,
				farmValueThreshold,
				sampleMoves,
				temperature,
				forbidTypes: [...(forbidTypes ?? [])],
				maxStatusLevel,
				hardConstraints,
				eloK,
				ratings,
				pairs: pairResults
			};

			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
			/* eslint-disable no-console */
			console.log(`\n[azleague] ${models.length} model(s), ${pairResults.length} pair(s), ${pairGames} games/pair`);
			for (const row of ratings) {
				console.log(
					`[azleague] ${String(row.elo).padStart(4)}  ${row.name.padEnd(18)} teamVP=${row.team_vp_win_pct.toFixed(1)}% avgVP=${row.avg_vp.toFixed(2)} place=${row.avg_place.toFixed(2)}`
				);
			}
			console.log(`[azleague] DONE -> ${out}`);
			/* eslint-enable no-console */
		},
		4 * 60 * 60 * 1000
	);
});
