/**
 * Actor pool tests.
 *
 *   - Determinism (always runs): the same seed set must produce identical per-seed
 *     outcomes regardless of worker count — the guarantee that lets the pool scale
 *     data generation without changing what gets generated.
 *   - Scaling benchmark (opt-in via POOL=1): 1 worker vs cpus-1 workers over the same
 *     neural workload; reports games/s and writes ml/gauntlet_results/actorpool_bench.json.
 *
 *   POOL=1 npx vitest run src/lib/play/ml/_actorpool.test.ts --disable-console-intercept
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runActorPool } from './actorPool';
import { mlPath } from './nodeIo';
import type { ActorGameConfig, GameSummary } from './poolTypes';

const WEIGHTS = resolve(process.cwd(), 'src/lib/play/ml/policy-weights.json');
const RUN_BENCH = process.env.POOL === '1';

/** Collapse a summary to the outcome fields that must be identical across worker counts. */
function outcomeKey(s: GameSummary): string {
	return JSON.stringify({
		rounds: s.rounds,
		winnerSeat: s.winnerSeat,
		finished: s.finished,
		stalled: s.stalled,
		samples: s.samples,
		perSeat: s.perSeat.map((p) => [p.seat, p.finalVP, p.placement, p.finalStatus])
	});
}

function tempDir(label: string): string {
	return mkdtempSync(join(tmpdir(), `actorpool-${label}-`));
}

describe('actor pool', () => {
	it('determinism: 1 worker and 4 workers produce identical per-seed outcomes', async () => {
		const seeds = Array.from({ length: 16 }, (_, i) => 41_000 + i);
		const config: ActorGameConfig = {
			seats: 4,
			maxRounds: 60,
			profiles: ['pvphunter', 'medium', 'aggressive', 'hard'],
			// Exercise the neural path when a checkpoint is available (the shipping config);
			// fall back to heuristic-only so the guarantee is still tested without weights.
			...(existsSync(WEIGHTS) ? { weightsPath: WEIGHTS, selection: 'hybrid' as const } : {})
		};
		const dirA = tempDir('det1');
		const dirB = tempDir('det4');
		try {
			const one = await runActorPool({ seeds, outDir: dirA, workers: 1, config });
			const four = await runActorPool({ seeds, outDir: dirB, workers: 4, config });
			expect(one.games).toBe(seeds.length);
			expect(four.games).toBe(seeds.length);
			expect(one.shardFiles.length).toBe(1);
			expect(four.shardFiles.length).toBeGreaterThan(1);

			const mapOf = (summaries: GameSummary[]): Record<number, string> =>
				Object.fromEntries(summaries.map((s) => [s.seed, outcomeKey(s)]));
			expect(mapOf(four.summaries)).toEqual(mapOf(one.summaries));
			expect(four.samples).toBe(one.samples);

			// The games-<i>.jsonl feed must cover every seed exactly once.
			const lines = four.gameFiles.flatMap((f) =>
				readFileSync(f, 'utf8')
					.trim()
					.split('\n')
					.map((l) => JSON.parse(l) as GameSummary)
			);
			expect(lines.map((l) => l.seed).sort((a, b) => a - b)).toEqual(seeds);
		} finally {
			rmSync(dirA, { recursive: true, force: true });
			rmSync(dirB, { recursive: true, force: true });
		}
	}, 300_000);

	it('obs-version 2: shards carry paired v1 obs + flat obsV2 rows and meta.json validates', async () => {
		const seeds = Array.from({ length: 4 }, (_, i) => 52_000 + i);
		const config: ActorGameConfig = {
			seats: 4,
			maxRounds: 40,
			profiles: ['pvphunter', 'medium', 'aggressive', 'hard'],
			obsVersion: 2,
			...(existsSync(WEIGHTS) ? { weightsPath: WEIGHTS, selection: 'hybrid' as const } : {})
		};
		const dir = tempDir('v2');
		try {
			const res = await runActorPool({ seeds, outDir: dir, workers: 2, config });
			expect(res.games).toBe(seeds.length);
			expect(res.samples).toBeGreaterThan(0);

			// Pinned paired-row contract (docs/encoder-v2.md): obs stays v1 62-float,
			// obsV2 carries the flat array, meta nests obsV2Meta under "obs_v2".
			const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
			expect(meta.obs_version).toBe(2);
			expect(meta.obs_dim).toBe(62);
			expect(meta.obs_v2.versionCode).toBe(2);
			expect(Array.isArray(meta.obs_v2.flatHeader)).toBe(true);

			// Every shard row: paired obs (v1) + obsV2 whose embedded header survives the
			// 4dp serialization exactly (small ints), masks binary, candidates still v1.
			const header = meta.obs_v2.flatHeader as number[];
			const caps = meta.obs_v2.caps;
			// Trailing mask block: one bit per padded-family slot + 1 for monster.
			const maskLen = caps.seats + caps.spirits + caps.market + caps.runes + 1;
			let rows = 0;
			for (const f of res.shardFiles) {
				for (const line of readFileSync(f, 'utf8').trim().split('\n')) {
					const rec = JSON.parse(line) as { obs: number[]; obsV2: number[]; cands: number[][] };
					expect(rec.obs.length).toBe(meta.obs_dim);
					expect(rec.obsV2.length).toBe(meta.obs_v2.flatLength);
					expect(rec.obsV2.slice(0, header.length)).toEqual(header);
					for (const m of rec.obsV2.slice(rec.obsV2.length - maskLen)) {
						expect(m === 0 || m === 1).toBe(true);
					}
					expect(rec.cands[0].length).toBe(meta.act_dim);
					rows += 1;
				}
			}
			expect(rows).toBe(res.samples);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 300_000);

	(RUN_BENCH ? it : it.skip)(
		'scaling benchmark: 1 worker vs cpus-1 workers (POOL=1)',
		async () => {
			if (!existsSync(WEIGHTS)) throw new Error(`POOL bench needs weights at ${WEIGHTS}`);
			const games = parseInt(process.env.POOL_GAMES ?? '64', 10);
			const nCpus = cpus().length;
			const nBig = Math.max(2, nCpus - 1);
			const seeds = Array.from({ length: games }, (_, i) => 71_000 + i);
			const config: ActorGameConfig = {
				seats: 4,
				maxRounds: 90,
				profiles: ['pvphunter', 'medium', 'aggressive', 'hard'],
				weightsPath: WEIGHTS,
				selection: 'hybrid'
			};
			const dir1 = tempDir('bench1');
			const dirN = tempDir('benchN');
			try {
				const one = await runActorPool({ seeds, outDir: dir1, workers: 1, config });
				const many = await runActorPool({ seeds, outDir: dirN, workers: nBig, config });
				const speedup = many.gamesPerSec / one.gamesPerSec;
				const efficiency = speedup / nBig;
				const report = {
					timestamp: new Date().toISOString(),
					cpus: nCpus,
					games,
					seats: config.seats,
					maxRounds: config.maxRounds,
					weights: WEIGHTS,
					baseline: {
						workers: 1,
						gamesPerSec: one.gamesPerSec,
						wallMs: one.wallMs,
						samples: one.samples
					},
					scaled: {
						workers: nBig,
						gamesPerSec: many.gamesPerSec,
						wallMs: many.wallMs,
						samples: many.samples
					},
					speedup,
					efficiency
				};
				const outFile = mlPath('gauntlet_results', 'actorpool_bench.json');
				writeFileSync(outFile, JSON.stringify(report, null, 2));
				// eslint-disable-next-line no-console
				console.log(
					`[pool-bench] 1w=${one.gamesPerSec.toFixed(1)} games/s, ${nBig}w=${many.gamesPerSec.toFixed(1)} games/s, ` +
						`speedup=${speedup.toFixed(2)}x, efficiency=${(100 * efficiency).toFixed(0)}% → ${outFile}`
				);
				expect(many.games).toBe(games);
				expect(many.gamesPerSec).toBeGreaterThan(one.gamesPerSec);
			} finally {
				rmSync(dir1, { recursive: true, force: true });
				rmSync(dirN, { recursive: true, force: true });
			}
		},
		30 * 60 * 1000
	);
});
