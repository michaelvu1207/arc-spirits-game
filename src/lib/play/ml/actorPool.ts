/**
 * Multi-core self-play actor pool (M1).
 *
 * Fans a seed set out across N persistent node worker_threads. Each worker loads the
 * catalog/policies once, then pulls another seed whenever it finishes its current
 * game. This removes static-slice straggler tails while retaining one sample/summary
 * shard per worker and streaming per-game summaries as they finish.
 *
 * Worker TS loading: this repo ships no tsx/vite-node, so each worker starts from an
 * inline CJS bootstrap (`eval: true`) that registers jiti (already in node_modules,
 * with a `$lib` alias for the few SvelteKit-style imports in the engine graph) and
 * imports actorWorker.ts. Works under plain `node` and inside vitest alike.
 *
 * Determinism: a game's outcome depends only on its seed + config — the driver derives
 * every RNG stream from the seed — so any seed→worker partition yields identical
 * per-seed results. Dynamic scheduling changes which worker shard owns a game, but
 * job indices restore input order and per-seed outcomes remain unchanged.
 */
import { Worker } from 'node:worker_threads';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ACT_DIM, OBS_DIM } from './encode';
import { obsV2Meta } from './encodeV2';
import type { PlayCatalog } from '../types';
import type {
	ActorGameConfig,
	ActorSeedJob,
	ActorWorkerCommand,
	ActorWorkerMessage,
	GameSummary
} from './poolTypes';

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

/**
 * Deterministic central queue for persistent workers. The queue never uses timing or
 * worker identity to derive a seed; it only decides which idle worker owns the next
 * input job. jobIndex makes duplicate seed values safe and restores caller order.
 */
export class DynamicSeedScheduler {
	private nextJobIndex = 0;
	private readonly inFlight = new Map<number, number>();
	private readonly completed = new Set<number>();

	constructor(private readonly seeds: readonly number[]) {}

	next(workerIndex: number): ActorSeedJob | null {
		if (this.inFlight.has(workerIndex)) {
			throw new Error(`actorPool scheduler: worker ${workerIndex} requested work while busy`);
		}
		if (this.nextJobIndex >= this.seeds.length) return null;
		const jobIndex = this.nextJobIndex++;
		this.inFlight.set(workerIndex, jobIndex);
		return { jobIndex, seed: this.seeds[jobIndex] };
	}

	complete(workerIndex: number, jobIndex: number): void {
		const expected = this.inFlight.get(workerIndex);
		if (expected !== jobIndex) {
			throw new Error(
				`actorPool scheduler: worker ${workerIndex} completed job ${jobIndex}, expected ${expected ?? 'none'}`
			);
		}
		if (this.completed.has(jobIndex)) {
			throw new Error(`actorPool scheduler: job ${jobIndex} completed more than once`);
		}
		this.inFlight.delete(workerIndex);
		this.completed.add(jobIndex);
	}

	get completedCount(): number {
		return this.completed.size;
	}
}

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

	const scheduler = new DynamicSeedScheduler(opts.seeds);
	const byJob = new Map<number, GameSummary>();
	let samples = 0;
	let gamesCompleted = 0;
	const t0 = performance.now();
	const liveWorkers: Worker[] = [];
	try {
		await Promise.all(
			Array.from(
				{ length: nWorkers },
				(_, workerIndex) =>
					new Promise<void>((resolveWorker, rejectWorker) => {
						const worker = new Worker(BOOTSTRAP, {
							eval: true,
							workerData: {
								workerIndex,
								seeds: [],
								config: opts.config,
								outDir,
								catalogPath,
								__actorPool: true,
								__dynamicSeeds: true,
								__workerFile: workerFile,
								__jitiPath: jitiPath,
								__alias: alias
							}
						});
						liveWorkers.push(worker);
						let done = false;
						let settled = false;
						let stopSent = false;
						const dispatchNext = (): void => {
							if (stopSent) {
								throw new Error(`actorPool worker ${workerIndex} requested work after stop`);
							}
							const job = scheduler.next(workerIndex);
							if (job) {
								worker.postMessage({ type: 'run', ...job } satisfies ActorWorkerCommand);
							} else {
								stopSent = true;
								worker.postMessage({ type: 'stop' } satisfies ActorWorkerCommand);
							}
						};
						const fail = (err: unknown): void => {
							if (settled) return;
							settled = true;
							rejectWorker(err instanceof Error ? err : new Error(String(err)));
							void worker.terminate();
						};
						worker.on('message', (msg: ActorWorkerMessage) => {
							try {
								if (msg.type === 'ready') {
									dispatchNext();
								} else if (msg.type === 'game') {
									scheduler.complete(workerIndex, msg.jobIndex);
									if (byJob.has(msg.jobIndex)) {
										throw new Error(`actorPool received duplicate job ${msg.jobIndex}`);
									}
									byJob.set(msg.jobIndex, msg.summary);
									opts.onGame?.(msg.summary);
									dispatchNext();
								} else if (msg.type === 'done') {
									done = true;
									gamesCompleted += msg.games;
									samples += msg.samples;
								} else if (msg.type === 'error') {
									fail(new Error(`actorPool worker ${msg.workerIndex}: ${msg.message}`));
								}
							} catch (err) {
								fail(err);
							}
						});
						worker.on('error', fail);
						worker.on('exit', (code) => {
							if (settled) return;
							if (done && code === 0) {
								settled = true;
								resolveWorker();
							} else {
								fail(
									new Error(
										`actorPool worker ${workerIndex} exited (code ${code}) before finishing`
									)
								);
							}
						});
					})
			)
		);
	} catch (err) {
		await Promise.allSettled(liveWorkers.map((worker) => worker.terminate()));
		throw err;
	}
	const wallMs = performance.now() - t0;

	if (scheduler.completedCount !== opts.seeds.length || gamesCompleted !== opts.seeds.length) {
		throw new Error(
			`actorPool: incomplete run (${scheduler.completedCount} scheduled completions, ${gamesCompleted} worker completions, expected ${opts.seeds.length})`
		);
	}
	const summaries = opts.seeds.map((seed, jobIndex) => {
		const summary = byJob.get(jobIndex);
		if (!summary) throw new Error(`actorPool: missing summary for job ${jobIndex} (seed ${seed})`);
		if (summary.seed !== seed) {
			throw new Error(
				`actorPool: job ${jobIndex} returned seed ${summary.seed}, expected seed ${seed}`
			);
		}
		return summary;
	});
	// meta.json alongside the shards: ml/model.py's load_dims_from_meta prefers it, and
	// without it the trainer would infer dims from the first *.jsonl alphabetically —
	// which is games-0.jsonl (summaries, no obs), not a sample shard. Shape follows the
	// pinned paired-row contract (docs/encoder-v2.md): obs_dim stays the current v1 187 on every
	// dataset, and v2 runs nest obsV2Meta under the exact key "obs_v2" — the block
	// bc_warmstart_v2 / train.py --model v2 build their ObsV2Spec from.
	writeFileSync(
		join(outDir, 'meta.json'),
		JSON.stringify(
			{
				obs_dim: OBS_DIM,
				act_dim: ACT_DIM,
				samples,
				games: summaries.length,
				workers: nWorkers,
				obs_version: opts.config.obsVersion ?? 1,
				...(opts.config.obsVersion === 2
					? { obs_v2: obsV2Meta(JSON.parse(readFileSync(catalogPath, 'utf8')) as PlayCatalog) }
					: {})
			},
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
