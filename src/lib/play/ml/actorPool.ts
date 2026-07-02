/**
 * Multi-core self-play actor pool (M1).
 *
 * Fans a seed set out across N node worker_threads, each running actorWorker.ts over
 * its slice. Replaces ml/run_gen.sh's process-per-shard fan-out with an in-process
 * pool that streams per-game summaries back as they finish.
 *
 * Worker TS loading: this repo ships no tsx/vite-node, so each worker starts from an
 * inline CJS bootstrap (`eval: true`) that registers jiti (already in node_modules,
 * with a `$lib` alias for the few SvelteKit-style imports in the engine graph) and
 * imports actorWorker.ts. Works under plain `node` and inside vitest alike.
 *
 * Determinism: a game's outcome depends only on its seed + config — the driver derives
 * every RNG stream from the seed — so any seed→worker partition yields identical
 * per-seed results. Seeds are dealt round-robin purely for load balance; sample rows
 * land in different shards under different worker counts, but per-seed outcomes match.
 */
import { Worker } from 'node:worker_threads';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ACT_DIM, OBS_DIM } from './encode';
import type { ActorGameConfig, ActorWorkerMessage, GameSummary } from './poolTypes';

export interface ActorPoolOptions {
	/** Full seed set for the run (one game per seed). */
	seeds: number[];
	/** Receives shard-<i>.jsonl (samples) and games-<i>.jsonl (summaries). Created if absent. */
	outDir: string;
	config: ActorGameConfig;
	/** Worker-thread count (default: cpus-1, capped at the seed count). */
	workers?: number;
	/** Frozen catalog file (default: <cwd>/ml/catalog.json). */
	catalogPath?: string;
	/** Keep existing shard/games files and append (default: clear them for a fresh run). */
	append?: boolean;
	/** Streamed per-game callback (progress logging, live dashboards). */
	onGame?: (summary: GameSummary) => void;
}

export interface ActorPoolResult {
	workers: number;
	games: number;
	samples: number;
	wallMs: number;
	gamesPerSec: number;
	/** All summaries, in seed order. */
	summaries: GameSummary[];
	shardFiles: string[];
	gameFiles: string[];
}

const workerFile = fileURLToPath(new URL('./actorWorker.ts', import.meta.url));
const srcLibDir = resolve(dirname(workerFile), '..', '..');

/**
 * CJS bootstrap eval'd as each worker's entry: register jiti, then import the real
 * TS worker module. Load failures are reported through parentPort so the pool can
 * surface a stack instead of a bare non-zero exit.
 */
const BOOTSTRAP = `
const { workerData, parentPort } = require('node:worker_threads');
const { createJiti } = require(workerData.__jitiPath);
const jiti = createJiti(workerData.__workerFile, { alias: workerData.__alias });
jiti.import(workerData.__workerFile).catch((err) => {
	if (parentPort) {
		parentPort.postMessage({
			type: 'error',
			workerIndex: workerData.workerIndex,
			message: String((err && err.stack) || err)
		});
	}
	process.exit(1);
});
`;

export async function runActorPool(opts: ActorPoolOptions): Promise<ActorPoolResult> {
	if (opts.seeds.length === 0) {
		return {
			workers: 0,
			games: 0,
			samples: 0,
			wallMs: 0,
			gamesPerSec: 0,
			summaries: [],
			shardFiles: [],
			gameFiles: []
		};
	}
	const nWorkers = Math.max(1, Math.min(opts.workers ?? cpus().length - 1, opts.seeds.length));
	const outDir = resolve(opts.outDir);
	mkdirSync(outDir, { recursive: true });
	const catalogPath = resolve(opts.catalogPath ?? join('ml', 'catalog.json'));
	if (!existsSync(catalogPath)) throw new Error(`actorPool: catalog not found: ${catalogPath}`);
	if (!opts.append) {
		for (const f of readdirSync(outDir)) {
			if (/^(shard|games)-\d+\.jsonl$/.test(f)) rmSync(join(outDir, f));
		}
	}

	// Warm the jiti compile cache in-process before fan-out: N cold workers would
	// otherwise all Babel-compile the same ~60-module engine graph at once (racing on
	// the shared cache dir), and any load error surfaces here with a clean stack.
	const require_ = createRequire(import.meta.url);
	const jitiPath = require_.resolve('jiti');
	const alias = { $lib: srcLibDir };
	const { createJiti } = (await import('jiti')) as typeof import('jiti');
	await createJiti(workerFile, { alias }).import(workerFile);

	// Round-robin seed partition (see determinism note in the header).
	const slices: number[][] = Array.from({ length: nWorkers }, () => []);
	opts.seeds.forEach((seed, i) => slices[i % nWorkers].push(seed));

	const bySeed = new Map<number, GameSummary>();
	let samples = 0;
	const t0 = performance.now();
	await Promise.all(
		slices.map(
			(seeds, workerIndex) =>
				new Promise<void>((resolveWorker, rejectWorker) => {
					const worker = new Worker(BOOTSTRAP, {
						eval: true,
						workerData: {
							workerIndex,
							seeds,
							config: opts.config,
							outDir,
							catalogPath,
							__actorPool: true,
							__workerFile: workerFile,
							__jitiPath: jitiPath,
							__alias: alias
						}
					});
					let done = false;
					worker.on('message', (msg: ActorWorkerMessage) => {
						if (msg.type === 'game') {
							bySeed.set(msg.summary.seed, msg.summary);
							opts.onGame?.(msg.summary);
						} else if (msg.type === 'done') {
							done = true;
							samples += msg.samples;
						} else if (msg.type === 'error') {
							rejectWorker(new Error(`actorPool worker ${msg.workerIndex}: ${msg.message}`));
							void worker.terminate();
						}
					});
					worker.on('error', rejectWorker);
					worker.on('exit', (code) => {
						if (done) resolveWorker();
						else
							rejectWorker(
								new Error(`actorPool worker ${workerIndex} exited (code ${code}) before finishing`)
							);
					});
				})
		)
	);
	const wallMs = performance.now() - t0;

	const summaries = opts.seeds
		.map((seed) => bySeed.get(seed))
		.filter((s): s is GameSummary => s !== undefined);
	// meta.json alongside the shards: ml/model.py's load_dims_from_meta prefers it, and
	// without it the trainer would infer dims from the first *.jsonl alphabetically —
	// which is games-0.jsonl (summaries, no obs), not a sample shard.
	writeFileSync(
		join(outDir, 'meta.json'),
		JSON.stringify(
			{ obs_dim: OBS_DIM, act_dim: ACT_DIM, samples, games: summaries.length, workers: nWorkers },
			null,
			2
		)
	);
	const outFiles = readdirSync(outDir);
	return {
		workers: nWorkers,
		games: summaries.length,
		samples,
		wallMs,
		gamesPerSec: summaries.length / (wallMs / 1000),
		summaries,
		shardFiles: outFiles.filter((f) => /^shard-\d+\.jsonl$/.test(f)).map((f) => join(outDir, f)),
		gameFiles: outFiles.filter((f) => /^games-\d+\.jsonl$/.test(f)).map((f) => join(outDir, f))
	};
}
