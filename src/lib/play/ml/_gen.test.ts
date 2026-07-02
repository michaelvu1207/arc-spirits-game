/**
 * Self-play DATA GENERATION runner (Phase 2). Opt-in via GEN=1 so it never runs in the
 * normal `npm test`. Mirrors the env-driven style of sim/arena.test.ts.
 *
 * Cold start (GEN_MODE=heur): strong heuristics play each other; we record which legal
 * candidate the heuristic chose at every covered decision. Returns are placement-based,
 * so training on this imitates the WINNERS of strong-bot games.
 *
 * Iteration (GEN_MODE=neural): the current net plays (optionally sampled) against a field
 * of strong heuristics, rotating which seat is neural; we record the neural seat's
 * decisions for advantage-weighted regression — directly optimizing "beat the heuristics".
 *
 * Examples:
 *   GEN=1 GEN_MODE=heur  GEN_GAMES=300 npx vitest run src/lib/play/ml/_gen.test.ts
 *   GEN=1 GEN_MODE=neural GEN_GAMES=300 GEN_SAMPLE=1 npx vitest run src/lib/play/ml/_gen.test.ts
 */

import { describe, it } from 'vitest';
import { profileFor, type BotProfile } from '../server/botPolicy';
import { SEAT_COLORS, type GameCommand, type SeatColor } from '../types';
import { playRecordingGame } from './driver';
import { shapingFor } from './shaping';
import { appendSamples, loadOrSnapshotCatalog, loadWeightsIfPresent, mlPath, writeMeta } from './nodeIo';
import { createRng, nextInt } from '../rng';
import { existsSync, rmSync } from 'node:fs';

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

const RUN = process.env.GEN === '1';

// Field for cold-start data + neural opponents. Weighted toward `pvphunter` because under
// current rules the PvP line is the ONLY winner (the economy line can't reach 30 VP — see
// the health probe / ml-bot-current-meta memory), with economy bots mixed in as the prey a
// hunter needs. Search-heavy tiers (godly/insane/mythic) are excluded from data-gen: they're
// ~10-50x slower per game and, being economy-line, don't win anyway. AVOID an all-hunter
// field (a predator needs prey, or games stall).
const FIELD = (process.env.GEN_FIELD ?? 'pvphunter,pvphunter,medium,aggressive,cultivator,survivor,fighter,hard')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

function env(name: string, dflt: string): string {
	return process.env[name] ?? dflt;
}

describe('ml data generation', () => {
	(RUN ? it : it.skip)(
		'generates self-play training data',
		async () => {
			const games = parseInt(env('GEN_GAMES', '200'), 10);
			const seats = parseInt(env('GEN_SEATS', '4'), 10);
			const mode = env('GEN_MODE', 'heur'); // 'heur' | 'neural'
			const seed0 = parseInt(env('GEN_SEED0', '1'), 10);
			const maxRounds = parseInt(env('GEN_MAXROUNDS', '120'), 10);
			const iter = parseInt(env('GEN_ITER', '0'), 10);
			const out = env('GEN_OUT', mlPath('data', `gen_${mode}.jsonl`));
			const append = env('GEN_APPEND', '0') === '1';
			const sample = env('GEN_SAMPLE', mode === 'neural' ? '1' : '0') === '1';

			const catalog = await loadOrSnapshotCatalog();
			const policy = mode === 'neural' ? loadWeightsIfPresent() : null;
			if (mode === 'neural' && !policy) throw new Error('GEN_MODE=neural but no ml/weights/policy.json found');

			// Diversity levers: vary starting identities (guardians/origins) per game, and
				// optionally forbid action types (e.g. GEN_FORBID=initiatePvp → no PvP-VP, forcing a
				// monster/economy line). GEN_GUARDIANS fixes a lane's lineup for origin specialization.
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

				if (!append && existsSync(out)) rmSync(out);

			const seatList = SEAT_COLORS.slice(0, seats) as SeatColor[];
			let totalSamples = 0;
			let wins = 0;
			let finished = 0;
			let neuralWins = 0;
			const t0 = Date.now();

			for (let g = 0; g < games; g++) {
				// Rotate the field assignment so matchups vary game to game.
				const profiles: BotProfile[] = seatList.map((_, i) => profileFor(FIELD[(g + i) % FIELD.length]));

				let neuralSeat: SeatColor | undefined;
				if (mode === 'neural') {
					neuralSeat = seatList[g % seats]; // rotate the neural seat across the field
				}

				// Champion imitation: in heuristic mode, record ONLY the seats playing the
				// winning strategy (default pvphunter), so BC imitates the winner — not the
				// dead economy bots. GEN_RECORD_PROFILE='' records every seat.
				const recordProfile = process.env.GEN_RECORD_PROFILE ?? 'pvphunter';
				const heurRecordSeats =
					recordProfile === ''
						? undefined
						: seatList.filter((_, i) => FIELD[(g + i) % FIELD.length] === recordProfile);

				const r = playRecordingGame(catalog, {
					seed: seed0 + g,
					profiles,
					maxRounds,
					policy: policy ?? undefined,
					selection: (process.env.GEN_SELECTION as 'hybrid' | 'value' | 'policy') ?? 'value',
					neuralSeats: neuralSeat ? [neuralSeat] : undefined,
					recordSeats: neuralSeat ? [neuralSeat] : heurRecordSeats,
					sample,
					temperature: process.env.GEN_TEMP ? parseFloat(process.env.GEN_TEMP) : undefined,
					shaping: shapingFor(process.env.GEN_SHAPING),
					gamma: process.env.GEN_GAMMA ? parseFloat(process.env.GEN_GAMMA) : undefined,
						guardianNames: fixedGuardians ?? (shuffleGuardians ? shuffledGuardians(allGuardians, seats, seed0 + g) : undefined),
						forbidTypes,
						maxStatusLevel
				});

				appendSamples(out, r.samples, iter);
				totalSamples += r.samples.length;
				if (r.finished) finished += 1;
				if (r.winnerSeat) {
					wins += 1;
					if (neuralSeat && r.winnerSeat === neuralSeat) neuralWins += 1;
				}

				if ((g + 1) % 50 === 0) {
					const dt = ((Date.now() - t0) / 1000).toFixed(0);
					// eslint-disable-next-line no-console
					console.log(`[gen] ${g + 1}/${games} games · ${totalSamples} samples · ${dt}s`);
				}
			}

			writeMeta(totalSamples, games, {
				mode,
				iter,
				finishedRate: finished / games,
				decisiveRate: wins / games,
				neuralWinRate: mode === 'neural' ? neuralWins / games : null,
				out,
				forbidTypes: [...(forbidTypes ?? [])],
				maxStatusLevel
			});

			const dt = ((Date.now() - t0) / 1000).toFixed(1);
			// eslint-disable-next-line no-console
			console.log(
				`[gen] DONE mode=${mode} games=${games} samples=${totalSamples} finished=${(100 * finished / games).toFixed(0)}% ` +
					(mode === 'neural' ? `neuralWinRate=${(100 * neuralWins / games).toFixed(1)}% ` : '') +
					`in ${dt}s → ${out}`
			);
		},
		60 * 60 * 1000 // up to 1h
	);
});
