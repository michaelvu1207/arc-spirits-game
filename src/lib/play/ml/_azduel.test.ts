/**
 * AlphaZero checkpoint duel. Unlike the older arena/elo tests, this keeps the
 * AlphaZero path active: every seat plans navigation with ISMCTS and uses
 * full-command neural selection for non-navigation actions. Each seat may use a
 * different checkpoint, letting us test whether any trained variant directly
 * exploits the current champion.
 *
 *   AZDUEL=1 AZDUEL_FILES=a.json,b.json AZDUEL_GAMES=24 AZDUEL_ITERS=64 \
 *     npx vitest run src/lib/play/ml/_azduel.test.ts --disable-console-intercept
 */
import { describe, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { profileFor } from '../server/botPolicy';
import { SEAT_COLORS, type GameCommand, type PrivatePlayerState, type SeatColor } from '../types';
import { loadOrSnapshotCatalog, loadPolicyForEval, mlPath } from './nodeIo';
import { playPlannerSelfPlayGame } from './selfplay';
import type { NeuralPolicy } from './net';

const RUN = process.env.AZDUEL === '1';

interface Model {
	name: string;
	file: string;
	policy: NeuralPolicy;
}

interface Row {
	name: string;
	file: string;
	seat_games: number;
	wins: number;
	win_pct: number;
	avg_place: number;
	avg_vp: number;
	reach30_pct: number;
	avg_status: number;
	avg_abyss_navs: number;
	avg_monster_combats: number;
	avg_monster_kills: number;
	decision_types: Record<string, number>;
}

function parseForbidTypes(): Set<GameCommand['type']> | undefined {
	const raw = process.env.AZDUEL_FORBID_TYPES ?? process.env.AZ_FORBID_TYPES ?? process.env.AZ_FORBID;
	if (!raw) return undefined;
	const types = raw.split(',').map((s) => s.trim()).filter(Boolean) as GameCommand['type'][];
	return types.length > 0 ? new Set(types) : undefined;
}

function topN(counts: Record<string, number>, n: number): Record<string, number> {
	return Object.fromEntries(
		Object.entries(counts)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, n)
	);
}

function addCounts(dst: Record<string, number>, src: Record<string, number> | undefined): void {
	for (const [k, v] of Object.entries(src ?? {})) dst[k] = (dst[k] ?? 0) + v;
}

function statusOf(player: PrivatePlayerState | undefined): number {
	return player?.statusLevel ?? 0;
}

describe('AlphaZero checkpoint duel', () => {
	(RUN ? it : it.skip)(
		'plays trained checkpoints directly against each other',
		async () => {
			const rawFiles = (process.env.AZDUEL_FILES ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			if (rawFiles.length < 2) throw new Error('AZDUEL_FILES must include at least two checkpoint files');
			const rawNames = (process.env.AZDUEL_NAMES ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			const models: Model[] = rawFiles.map((file, i) => ({
				file,
				name: rawNames[i] || basename(file).replace(/\.json$/, ''),
				policy: loadPolicyForEval(file)
			}));

			const games = parseInt(process.env.AZDUEL_GAMES ?? '24', 10);
			const iterations = parseInt(process.env.AZDUEL_ITERS ?? '64', 10);
			const horizon = parseInt(process.env.AZDUEL_HORIZON ?? '24', 10);
			const valueWeight = parseFloat(process.env.AZDUEL_VALUEW ?? '1');
			const seatsN = parseInt(process.env.AZDUEL_SEATS ?? '4', 10);
			const maxRounds = parseInt(process.env.AZDUEL_MAXROUNDS ?? '30', 10);
			const sampleMoves = process.env.AZDUEL_SAMPLE === '1';
			const temperature = parseFloat(process.env.AZDUEL_TEMP ?? '0.25');
			const microProfile = process.env.AZDUEL_PROFILE ?? process.env.AZ_PLANNER_PROFILE ?? 'random';
			const control = process.env.AZDUEL_CONTROL === 'navigation' ? 'navigation' : 'full';
			const fullSelection =
				process.env.AZDUEL_FULL_SELECTION === 'policy' ||
				process.env.AZDUEL_FULL_SELECTION === 'hybrid' ||
				process.env.AZDUEL_FULL_SELECTION === 'lookahead'
					? process.env.AZDUEL_FULL_SELECTION
					: process.env.AZ_FULL_SELECTION === 'policy' ||
						  process.env.AZ_FULL_SELECTION === 'hybrid' ||
						  process.env.AZ_FULL_SELECTION === 'lookahead'
						? process.env.AZ_FULL_SELECTION
						: 'value';
			const fullLookaheadDepth = parseInt(process.env.AZDUEL_FULL_LOOKAHEAD_DEPTH ?? process.env.AZ_FULL_LOOKAHEAD_DEPTH ?? process.env.AZ_LOOKAHEAD_DEPTH ?? '2', 10);
			const fullLookaheadBeam = parseInt(process.env.AZDUEL_FULL_LOOKAHEAD_BEAM ?? process.env.AZ_FULL_LOOKAHEAD_BEAM ?? process.env.AZ_LOOKAHEAD_BEAM ?? '8', 10);
			const fullLookaheadRootBeam = parseInt(process.env.AZDUEL_FULL_LOOKAHEAD_ROOT_BEAM ?? process.env.AZ_FULL_LOOKAHEAD_ROOT_BEAM ?? process.env.AZ_LOOKAHEAD_ROOT_BEAM ?? '24', 10);
			const fullTargetTemperature = parseFloat(process.env.AZDUEL_FULL_TARGET_TEMP ?? process.env.AZ_FULL_TARGET_TEMP ?? process.env.AZ_TARGET_TEMP ?? '0.25');
			const farmValueBonus = parseFloat(process.env.AZDUEL_FARM_VALUE_BONUS ?? process.env.AZ_FARM_VALUE_BONUS ?? '0');
			const farmValueThreshold = parseFloat(process.env.AZDUEL_FARM_VALUE_THRESHOLD ?? process.env.AZ_FARM_VALUE_THRESHOLD ?? '0');
			const forbidTypes = parseForbidTypes();
			const maxStatusLevel = process.env.AZDUEL_MAX_STATUS_LEVEL
				? parseInt(process.env.AZDUEL_MAX_STATUS_LEVEL, 10)
				: process.env.AZ_MAX_STATUS_LEVEL
					? parseInt(process.env.AZ_MAX_STATUS_LEVEL, 10)
					: undefined;
			const hardConstraints =
				(process.env.AZDUEL_HARD_CONSTRAINTS ?? process.env.AZ_HARD_CONSTRAINTS ?? (maxStatusLevel !== undefined ? '1' : '0')) === '1';
			const out = process.env.AZDUEL_OUT ?? mlPath('azduel_result.json');

			const catalog = await loadOrSnapshotCatalog();
			const n = Math.min(seatsN, SEAT_COLORS.length, catalog.guardians.length);
			const seatList = SEAT_COLORS.slice(0, n) as SeatColor[];
			const profiles = seatList.map(() => profileFor(microProfile));
			const stats = models.map(() => ({
				seatGames: 0,
				wins: 0,
				place: 0,
				vp: 0,
				reach30: 0,
				status: 0,
				abyss: 0,
				combats: 0,
				kills: 0,
				decisionTypes: {} as Record<string, number>
			}));
			const lineups: string[][] = [];

			for (let g = 0; g < games; g++) {
				const modelIndexBySeat = seatList.map((_, i) => (g + i) % models.length);
				lineups.push(modelIndexBySeat.map((idx) => models[idx].name));
				const seatPolicies: Partial<Record<SeatColor, NeuralPolicy>> = {};
				seatList.forEach((seat, i) => {
					seatPolicies[seat] = models[modelIndexBySeat[i]].policy;
				});
				const r = playPlannerSelfPlayGame(catalog, {
					seed: 9_200_000 + g,
					profiles,
					policy: models[0].policy,
					seatPolicies,
					plannerSeats: seatList,
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

				for (const seat of seatList) {
					const modelIdx = modelIndexBySeat[seatList.indexOf(seat)];
					const s = stats[modelIdx];
					const vp = r.finalVP[seat] ?? 0;
					const place = 1 + seatList.filter((other) => other !== seat && (r.finalVP[other] ?? 0) > vp).length;
					s.seatGames += 1;
					if (r.winnerSeat === seat) s.wins += 1;
					s.place += place;
					s.vp += vp;
					if (vp >= 30) s.reach30 += 1;
					s.status += statusOf(r.finalState.players[seat]);
					const ps = r.plannerStats[seat];
					if (ps) {
						s.abyss += ps.abyss;
						s.combats += ps.combat;
						s.kills += ps.kills;
					}
					addCounts(s.decisionTypes, r.decisionTypesBySeat[seat]);
				}

				if ((g + 1) % 10 === 0 || g === games - 1) {
					/* eslint-disable no-console */
					console.log(`[azduel] g=${g + 1}/${games}`);
					/* eslint-enable no-console */
				}
			}

			const rows: Row[] = models.map((m, i) => {
				const s = stats[i];
				const denom = Math.max(1, s.seatGames);
				return {
					name: m.name,
					file: m.file,
					seat_games: s.seatGames,
					wins: s.wins,
					win_pct: +((100 * s.wins) / denom).toFixed(1),
					avg_place: +(s.place / denom).toFixed(2),
					avg_vp: +(s.vp / denom).toFixed(2),
					reach30_pct: +((100 * s.reach30) / denom).toFixed(1),
					avg_status: +(s.status / denom).toFixed(2),
					avg_abyss_navs: +(s.abyss / denom).toFixed(2),
					avg_monster_combats: +(s.combats / denom).toFixed(2),
					avg_monster_kills: +(s.kills / denom).toFixed(2),
					decision_types: topN(s.decisionTypes, 16)
				};
			}).sort((a, b) => b.win_pct - a.win_pct || b.avg_vp - a.avg_vp);

			const payload = {
				games,
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
				lineups,
				results: rows
			};

			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
			/* eslint-disable no-console */
			console.log(`\n[azduel] ${models.length} model(s), ${games} games, ${n} seats`);
			for (const row of rows) {
				console.log(
					`[azduel] ${row.name.padEnd(24)} win=${row.win_pct.toFixed(1)}% place=${row.avg_place.toFixed(2)} vp=${row.avg_vp.toFixed(2)} status=${row.avg_status.toFixed(2)}`
				);
			}
			console.log(`[azduel] DONE -> ${out}`);
			/* eslint-enable no-console */
		},
		2 * 60 * 60 * 1000
	);
});
