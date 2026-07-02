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
import { createRng, nextInt } from '../rng';
import type { GameCommand, PlayCatalog, SeatColor } from '../types';
import { OBS_DIM } from './encode';
import { obsV2Meta } from './encodeV2';
import { playRecordingGame } from './driver';
import { planDecisionGumbel } from './gumbelPlanner';
import { hybridIndex } from './neuralBot';
import { appendSamples, loadWeightsIfPresent } from './nodeIo';
import { asNeuralPolicy, RemotePolicy } from './inferenceClient';
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
	if (config.policyObsVersion === 2 && !config.inferSocket) {
		throw new Error(
			'actorWorker: policyObsVersion 2 requires inferSocket (--infer-socket) — the in-process TS net is v1-only'
		);
	}
	// Learner policy: a RemotePolicy over the inference server's socket when configured,
	// else the in-process net from a weights file. Opponents always load in-process.
	// expectObsDim pins the served checkpoint to the requested policy obs version.
	// ARC_INFER_WIRE=json|binary overrides the checkpoint-based wire cut (wire A/B,
	// forcing binary on v1 shapes, pre-binary servers).
	const wireEnv = process.env.ARC_INFER_WIRE;
	const remote = config.inferSocket
		? new RemotePolicy(config.inferSocket, {
				expectObsDim: config.policyObsVersion === 2 ? obsV2Meta(catalog).flatLength : OBS_DIM,
				wire: wireEnv === 'json' || wireEnv === 'binary' ? wireEnv : undefined
			})
		: null;
	const policy = remote
		? asNeuralPolicy(remote)
		: config.weightsPath
			? loadPolicyStrict(config.weightsPath)
			: undefined;
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
	// Identify the generator by the server's actual checkpoint when remote (the socket
	// path says nothing about which weights produced the games).
	const weightsOrProfiles = remote?.info.weights ?? config.weightsPath ?? config.profiles.join(',');
	// Per-seat policy attribution, mirroring the driver's seat routing: with a learner
	// policy, neural seats = config.neuralSeats ?? all seats; opponentWeights seats play
	// their OWN checkpoint and are excluded from the learner's neuralSeats list.
	const opponentSeats = new Set(Object.keys(config.opponentWeights ?? {}) as SeatColor[]);
	const isNeuralSeat = (seat: SeatColor): boolean =>
		!!policy && (config.neuralSeats ? config.neuralSeats.includes(seat) : true);
	const isLearnerSeat = (seat: SeatColor): boolean =>
		isNeuralSeat(seat) && !opponentSeats.has(seat);

	let samplesTotal = 0;
	try {
		for (const seed of seeds) {
			const t0 = performance.now();
			// Expert-iteration searcher: deterministic per (seed, decision index); the
			// frac draw shares the stream, so runs are exactly reproducible.
			let searcher: ((st: Parameters<typeof planDecisionGumbel>[0], seat: SeatColor, withNext: Parameters<typeof planDecisionGumbel>[4]) => { index: number; pi: number[] } | null) | undefined;
			if (config.search && policy) {
				const sc = config.search;
				const frac = sc.frac ?? 1;
				const searchRng = createRng((seed ^ 0x517cc1b7) >>> 0 || 1);
				const uni = (): number => (nextInt(searchRng, 1_073_741_824) + 0.5) / 1_073_741_824;
				let decisionN = 0;
				searcher = (st, seat, withNext) => {
					if (st.phase !== 'navigation' && st.phase !== 'encounter') return null;
					if (withNext.length < 2) return null;
					decisionN += 1;
					if (frac < 1 && uni() >= frac) return null;
					const res = planDecisionGumbel(st, seat, catalog, policy!, withNext, {
						simulations: sc.sims,
						horizonRounds: sc.horizonRounds ?? 6,
						valueWeight: sc.valueWeight ?? 0.5,
						seed: (seed * 2654435761 + st.round * 7919 + decisionN * 104729) >>> 0,
						temperature: st.phase === 'navigation' ? (sc.navTemperature ?? 0.8) : 0,
						...(sc.rollout === 'heuristic'
							? {}
							: {
									rolloutChoose: (rs, rSeat, rWithNext) =>
										hybridIndex(policy!, rs, rSeat, rWithNext, { sample: false }, catalog)
								})
					});
					return res ? { index: res.index, pi: res.pi } : null;
				};
			}
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
				gamma: config.gamma,
				obsVersion: config.obsVersion,
				policyObsVersion: config.policyObsVersion,
				searcher
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
				neuralSeats: seatList.filter(isLearnerSeat),
				perSeat: seatList.map((seat) => ({
					seat,
					finalVP: r.finalVP[seat] ?? 0,
					placement:
						1 +
						seatList.filter((o) => o !== seat && (r.finalVP[o] ?? 0) > (r.finalVP[seat] ?? 0))
							.length,
					finalStatus: r.finalState?.players[seat]?.statusLevel ?? 0,
					policy: isNeuralSeat(seat) ? ('neural' as const) : ('heuristic' as const)
				})),
				wallMs: Math.round(wallMs * 10) / 10
			};
			appendFileSync(gamesFile, JSON.stringify(summary) + '\n');
			onGame?.(summary);
		}
	} finally {
		remote?.close(); // the bridge's IO thread would otherwise outlive the run
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
			port.postMessage({
				type: 'game',
				workerIndex: wd.workerIndex,
				summary
			} satisfies ActorWorkerMessage)
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
