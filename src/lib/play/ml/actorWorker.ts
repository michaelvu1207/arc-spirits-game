/**
 * Worker-thread entry for the self-play actor pool.
 *
 * Runs its assigned seed slice through `playRecordingGame`, appending training samples
 * to <outDir>/shard-<workerIndex>.jsonl and one summary line per game to
 * <outDir>/games-<workerIndex>.jsonl (each worker owns its two files — no write
 * contention), while streaming the same summaries to the pool via parentPort.
 *
 * Spawned by actorPool.ts through an inline CJS bootstrap that registers jiti and
 * imports this module (this repo ships no tsx/vite-node; jiti is the only TS loader
 * in node_modules that works under plain `node`). The `__actorPool` workerData marker
 * gates the auto-run, so importing this module elsewhere (vitest, the pool process's
 * cache warm-up) is side-effect free.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { profileFor } from '../server/botPolicy';
import type { GameCommand, PlayCatalog, SeatColor } from '../types';
import { playRecordingGame } from './driver';
import { appendSamples, loadWeightsIfPresent } from './nodeIo';
import type { NeuralPolicy } from './net';
import type { ActorWorkerData, ActorWorkerMessage, GameSummary } from './poolTypes';

function loadPolicyStrict(file: string): NeuralPolicy {
	const policy = loadWeightsIfPresent(file);
	if (!policy) throw new Error(`actorWorker: weights file missing or absent: ${file}`);
	return policy;
}

/** Play every seed in `data.seeds`, writing this worker's shard + summary files. */
export function runActorGames(
	data: ActorWorkerData,
	onGame?: (summary: GameSummary) => void
): { games: number; samples: number } {
	const { workerIndex, seeds, config, outDir, catalogPath } = data;
	const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as PlayCatalog;
	const policy = config.weightsPath ? loadPolicyStrict(config.weightsPath) : undefined;
	let opponentPolicies: Partial<Record<SeatColor, NeuralPolicy>> | undefined;
	if (config.opponentWeights) {
		opponentPolicies = {};
		for (const [seat, file] of Object.entries(config.opponentWeights)) {
			if (file) opponentPolicies[seat as SeatColor] = loadPolicyStrict(file);
		}
	}
	const profiles = Array.from({ length: config.seats }, (_, i) =>
		profileFor(config.profiles[i % config.profiles.length])
	);
	const forbidTypes = config.forbidTypes?.length
		? new Set(config.forbidTypes as GameCommand['type'][])
		: undefined;
	const shardFile = join(outDir, `shard-${workerIndex}.jsonl`);
	const gamesFile = join(outDir, `games-${workerIndex}.jsonl`);
	const weightsOrProfiles = config.weightsPath ?? config.profiles.join(',');

	let samplesTotal = 0;
	for (const seed of seeds) {
		const t0 = performance.now();
		const r = playRecordingGame(catalog, {
			seed,
			profiles,
			maxRounds: config.maxRounds,
			policy,
			neuralSeats: config.neuralSeats,
			recordSeats: config.recordSeats,
			sample: config.sample,
			temperature: config.temperature,
			selection: config.selection,
			opponentPolicies,
			forbidTypes,
			maxStatusLevel: config.maxStatusLevel,
			gamma: config.gamma
		});
		const wallMs = performance.now() - t0;
		appendSamples(shardFile, r.samples, config.iter ?? 0);
		samplesTotal += r.samples.length;

		const seatList = Object.keys(r.finalVP) as SeatColor[];
		const summary: GameSummary = {
			seed,
			seats: seatList.length,
			weightsOrProfiles,
			rounds: r.rounds,
			winnerSeat: r.winnerSeat,
			finished: r.finished,
			stalled: r.stalled,
			samples: r.samples.length,
			perSeat: seatList.map((seat) => ({
				seat,
				finalVP: r.finalVP[seat] ?? 0,
				placement:
					1 +
					seatList.filter((o) => o !== seat && (r.finalVP[o] ?? 0) > (r.finalVP[seat] ?? 0)).length,
				finalStatus: r.finalState?.players[seat]?.statusLevel ?? 0
			})),
			wallMs: Math.round(wallMs * 10) / 10
		};
		appendFileSync(gamesFile, JSON.stringify(summary) + '\n');
		onGame?.(summary);
	}
	return { games: seeds.length, samples: samplesTotal };
}

// Spawned-thread path: run the assigned slice and stream results to the pool.
const wd = workerData as (ActorWorkerData & { __actorPool?: boolean }) | null;
if (parentPort && wd?.__actorPool) {
	const port = parentPort;
	const t0 = performance.now();
	try {
		const { games, samples } = runActorGames(wd, (summary) =>
			port.postMessage({ type: 'game', workerIndex: wd.workerIndex, summary } satisfies ActorWorkerMessage)
		);
		port.postMessage({
			type: 'done',
			workerIndex: wd.workerIndex,
			games,
			samples,
			wallMs: performance.now() - t0
		} satisfies ActorWorkerMessage);
	} catch (err) {
		port.postMessage({
			type: 'error',
			workerIndex: wd.workerIndex,
			message: err instanceof Error ? (err.stack ?? err.message) : String(err)
		} satisfies ActorWorkerMessage);
		process.exitCode = 1;
	}
}
