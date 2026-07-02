/**
 * DIVERSITY + STRENGTH probe. For each policy in a pool, play many games as the focus seat
 * against a random field drawn from the rest of the pool, and report — on the TRUE objective
 * (no shaping) — win-rate, avg VP, % that reach the 30-VP target, AND a behavioral fingerprint:
 * end corruption level (statusLevel 0..3 → Fallen), max barrier (economy/Cultivator scaling),
 * attack dice, awakened spirits, game length. Classifies each policy's line (Fallen-aggro vs
 * Good-economy vs mixed) and summarizes how diverse the pool is. DIV=1 to run.
 *
 *   DIV=1 DIV_DIR=ml/diverse_pool DIV_GAMES=400 DIV_SEATS=4 npx vitest run src/lib/play/ml/_diversity.test.ts --disable-console-intercept
 *   DIV=1 DIV_FILES=a.json,b.json,... DIV_GAMES=400 ...
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

const RUN = process.env.DIV === '1';

interface Agg {
	name: string;
	pol: NeuralPolicy;
	params: number;
	games: number;
	wins: number;
	reached30: number;
	sumVP: number;
	sumStatus: number;
	sumBarrier: number;
	sumDice: number;
	sumSpirits: number;
	sumRounds: number;
	sumFieldBest: number; // avg best VP among the OTHER (opponent) seats — shows if anyone scores at all
}

function lineType(status: number, barrier: number): string {
	if (status >= 2.5) return 'Fallen-aggro';
	if (status < 1 && barrier >= 8) return 'Good-economy';
	if (status < 1) return 'Good-lean';
	return 'mixed';
}

function std(xs: number[]): number {
	if (xs.length === 0) return 0;
	const m = xs.reduce((a, b) => a + b, 0) / xs.length;
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

describe('diversity probe', () => {
	(RUN ? it : it.skip)(
		'measure each policy strength + behavioral fingerprint on the true objective',
		async () => {
			const games = parseInt(process.env.DIV_GAMES ?? '400', 10);
			const seats = parseInt(process.env.DIV_SEATS ?? '4', 10);
			const maxRounds = parseInt(process.env.DIV_MAXROUNDS ?? '30', 10);
			const catalog = await loadOrSnapshotCatalog();

			let files: string[];
			if (process.env.DIV_FILES) files = process.env.DIV_FILES.split(',').map((s) => s.trim());
			else {
				const dir = process.env.DIV_DIR ?? mlPath('diverse_pool');
				files = readdirSync(dir)
					.filter((f) => f.endsWith('.json'))
					.map((f) => join(dir, f));
			}
			const pool: Agg[] = [];
			for (const f of files) {
				const pol = loadWeightsIfPresent(f);
				if (!pol) continue;
				let params = 0;
				try {
					params = JSON.parse(readFileSync(f, 'utf8')).params ?? 0;
				} catch {
					/* ignore */
				}
				pool.push({ name: basename(f).replace(/\.json$/, ''), pol, params, games: 0, wins: 0, reached30: 0, sumVP: 0, sumStatus: 0, sumBarrier: 0, sumDice: 0, sumSpirits: 0, sumRounds: 0, sumFieldBest: 0 });
			}
			if (pool.length === 0) throw new Error('no policies loaded');

			const seatList = SEAT_COLORS.slice(0, seats) as SeatColor[];
			const rng = createRng(0xd1e + games);
			const gamesPer = Math.max(1, Math.round((games * seats) / pool.length / seats) || games);

			// Each policy is the focus seat for `games` games; opponents drawn randomly from the rest.
			// Opponent mode. 'heur' (DEFAULT, fast): focus is the ONLY neural seat; the rest are a
			// heuristic field — games always progress (no all-neural stalls that hit MAX_TICKS), so
			// the probe is fast and we get a clean read of the focus policy's own behavior. 'pool':
			// cross-archetype neural play (slower, can stall on weak checkpoints — use sparingly).
			const oppMode = process.env.DIV_OPP ?? 'heur';
			// Selection mode for the focus seat. New lanes train under 'policy'; the corruption
			// champion needs 'hybrid' (its hard-coded initiatePvp) to play correctly — set
			// DIV_SELECTION=hybrid to evaluate it fairly in a head-to-head.
			const selMode = (process.env.DIV_SELECTION as 'hybrid' | 'value' | 'policy') ?? 'policy';
			const fieldProfiles = (process.env.DIV_FIELD ?? 'medium,cultivator,survivor,aggressive,fighter')
				.split(',').map((s) => s.trim()).filter(Boolean);
			for (let pi = 0; pi < pool.length; pi++) {
				const focus = pool[pi];
				for (let g = 0; g < games; g++) {
					let opponentPolicies: Partial<Record<SeatColor, NeuralPolicy>> | undefined;
					let neuralSeats: SeatColor[];
					let profiles;
					if (oppMode === 'pool') {
						opponentPolicies = {};
						for (let i = 1; i < seatList.length; i++) {
							let oi = nextInt(rng, pool.length);
							if (pool.length > 1) while (oi === pi) oi = nextInt(rng, pool.length);
							opponentPolicies[seatList[i]] = pool[oi].pol;
						}
						neuralSeats = [...seatList];
						profiles = seatList.map(() => profileFor('medium'));
					} else {
						opponentPolicies = undefined;
						neuralSeats = [seatList[0]];
						profiles = seatList.map((_, i) => (i === 0 ? profileFor('medium') : profileFor(fieldProfiles[(g + i) % fieldProfiles.length])));
					}
					const r = playRecordingGame(catalog, {
						seed: 7_000_000 + pi * 100_003 + g,
						profiles,
						maxRounds,
						policy: focus.pol,
						selection: selMode,
						neuralSeats,
						opponentPolicies,
						recordSeats: []
					});
					const fp = r.finalState?.players[seatList[0]];
					const vp = r.finalVP[seatList[0]] ?? 0;
					focus.games++;
					if (r.winnerSeat === seatList[0]) focus.wins++;
					if (vp >= 30) focus.reached30++;
					focus.sumVP += vp;
					focus.sumStatus += fp?.statusLevel ?? 0;
					focus.sumBarrier += fp?.maxBarrier ?? 0;
					focus.sumDice += fp?.attackDice?.length ?? 0;
					focus.sumSpirits += fp?.spirits?.filter((s) => !s.isFaceDown).length ?? 0;
					focus.sumRounds += r.rounds;
					let fieldBest = 0;
					for (let i = 1; i < seatList.length; i++) fieldBest = Math.max(fieldBest, r.finalVP[seatList[i]] ?? 0);
					focus.sumFieldBest += fieldBest;
				}
			}

			const rows = pool
				.map((a) => ({
					name: a.name,
					params: a.params,
					winPct: (100 * a.wins) / a.games,
					reach30Pct: (100 * a.reached30) / a.games,
					avgVP: a.sumVP / a.games,
					avgStatus: a.sumStatus / a.games,
					avgBarrier: a.sumBarrier / a.games,
					avgDice: a.sumDice / a.games,
					avgSpirits: a.sumSpirits / a.games,
					avgRounds: a.sumRounds / a.games,
					fieldBestVP: a.sumFieldBest / a.games
				}))
				.map((r) => ({ ...r, line: lineType(r.avgStatus, r.avgBarrier) }))
				.sort((a, b) => b.avgVP - a.avgVP);

			/* eslint-disable no-console */
			console.log(`\n[div] ${pool.length} policies, ${games} games each, ${seats}p, maxRounds=${maxRounds} (sorted by avg VP):`);
			console.log(`[div] ${'name'.padEnd(22)} ${'VP'.padStart(6)} ${'win%'.padStart(6)} ${'r30%'.padStart(6)} ${'status'.padStart(7)} ${'barrier'.padStart(8)} ${'dice'.padStart(5)} ${'spir'.padStart(5)} ${'rnds'.padStart(5)}  line`);
			for (const r of rows) {
				console.log(
					`[div] ${r.name.padEnd(22)} ${r.avgVP.toFixed(1).padStart(6)} ${r.winPct.toFixed(0).padStart(6)} ${r.reach30Pct.toFixed(0).padStart(6)} ${r.avgStatus.toFixed(2).padStart(7)} ${r.avgBarrier.toFixed(1).padStart(8)} ${r.avgDice.toFixed(1).padStart(5)} ${r.avgSpirits.toFixed(1).padStart(5)} ${r.avgRounds.toFixed(1).padStart(5)} fieldVP=${r.fieldBestVP.toFixed(1).padStart(5)}  ${r.line}`
				);
			}
			const lines = new Set(rows.map((r) => r.line));
			console.log(`\n[div] DIVERSITY: ${lines.size} distinct line types: ${[...lines].join(', ')}`);
			console.log(`[div]   spread(status)=${std(rows.map((r) => r.avgStatus)).toFixed(2)}  spread(barrier)=${std(rows.map((r) => r.avgBarrier)).toFixed(2)}  spread(VP)=${std(rows.map((r) => r.avgVP)).toFixed(2)}`);
			const best = rows[0];
			const bestGood = rows.filter((r) => r.line.startsWith('Good')).sort((a, b) => b.avgVP - a.avgVP)[0];
			console.log(`[div]   best overall: ${best.name} (VP=${best.avgVP.toFixed(1)}, ${best.line})`);
			if (bestGood) console.log(`[div]   best non-corrupt (Good) line: ${bestGood.name} (VP=${bestGood.avgVP.toFixed(1)}, win%=${bestGood.winPct.toFixed(0)}, reach30=${bestGood.reach30Pct.toFixed(0)}%)`);
			writeFileSync(mlPath('diversity_result.json'), JSON.stringify(rows, null, 2));
			console.log(`[div] DONE → ml/diversity_result.json`);
			/* eslint-enable no-console */
		},
		60 * 60 * 1000
	);
});
