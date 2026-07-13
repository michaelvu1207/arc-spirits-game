/**
 * Worker-thread entry for the self-play actor pool.
 *
 * Loads its catalog and policies once, then runs seeds assigned by the parent through
 * `playRecordingGame`, appending training samples to
 * <outDir>/shard-<workerIndex>.jsonl and one summary line per game to
 * <outDir>/games-<workerIndex>.jsonl. Each worker owns its two files, so there is no
 * write contention; completed summaries stream to the pool via parentPort.
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
import { shapingFor } from './shaping';
import { planDecisionGumbel } from './gumbelPlanner';
import { hybridIndex } from './neuralBot';
import { appendSamples, loadWeightsIfPresent } from './nodeIo';
import { asNeuralPolicy, RemotePolicy } from './inferenceClient';
import type { NeuralPolicy } from './net';
import type {
	ActorWorkerCommand,
	ActorWorkerData,
	ActorWorkerMessage,
	GameSummary
} from './poolTypes';

function loadPolicyStrict(file: string): NeuralPolicy {
	const policy = loadWeightsIfPresent(file);
	if (!policy) throw new Error(`actorWorker: weights file missing or absent: ${file}`);
	return policy;
}

interface ActorGameRunner {
	run(seed: number): { summary: GameSummary; samples: number };
	close(): void;
}

function shuffledGuardianNames(catalog: PlayCatalog, seats: number, seed: number): string[] {
	const names = catalog.guardians.map((guardian) => guardian.name);
	const rng = createRng((seed ^ 0x6a09e667) >>> 0 || 1);
	for (let i = names.length - 1; i > 0; i--) {
		const j = nextInt(rng, i + 1);
		[names[i], names[j]] = [names[j], names[i]];
	}
	return names.slice(0, seats);
}

/**
 * Load the immutable catalog, policies and profiles once, then expose a per-seed
 * runner. Both the synchronous runActorGames API and the persistent worker protocol
 * use this session, so dynamic scheduling never reloads a model between games.
 */
function createActorGameRunner(data: ActorWorkerData): ActorGameRunner {
	const { workerIndex, config, outDir, catalogPath } = data;
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
	const learnerRef =
		remote?.info.weights ??
		config.weightsPath ??
		(config.inferSocket ? `remote:${config.inferSocket}` : undefined);
	// Per-seat policy attribution, mirroring the driver's seat routing: with a learner
	// policy, neural seats = config.neuralSeats ?? all seats; opponentWeights seats play
	// their OWN checkpoint and are excluded from the learner's neuralSeats list.
	const opponentSeats = new Set(Object.keys(config.opponentWeights ?? {}) as SeatColor[]);
	const isNeuralSeat = (seat: SeatColor): boolean =>
		!!policy && (config.neuralSeats ? config.neuralSeats.includes(seat) : true);
	const isLearnerSeat = (seat: SeatColor): boolean =>
		isNeuralSeat(seat) && !opponentSeats.has(seat);

	let closed = false;
	return {
		run(seed) {
			if (closed) throw new Error('actorWorker: cannot run a seed after the worker session closed');
			const t0 = performance.now();
			// Expert-iteration searcher: deterministic per (seed, decision index); the
			// frac draw shares the stream, so runs are exactly reproducible.
			let searcher:
				| ((
						st: Parameters<typeof planDecisionGumbel>[0],
						seat: SeatColor,
						withNext: Parameters<typeof planDecisionGumbel>[4]
				  ) => { index: number; pi: number[] } | null)
				| undefined;
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
				opponentTemperature: config.opponentTemperature,
				forbidTypes,
				maxStatusLevel: config.maxStatusLevel,
				guardianNames: config.shuffleGuardians
					? shuffledGuardianNames(catalog, config.seats, seed)
					: undefined,
				gamma: config.gamma,
				obsVersion: config.obsVersion,
				policyObsVersion: config.policyObsVersion,
				denseVpReward: config.denseVpReward,
				...(config.shapingPreset ? { shaping: shapingFor(config.shapingPreset) } : {}),
				potentialShapingMode: config.potentialShapingMode,
				searcher
			});
			const wallMs = performance.now() - t0;
			appendSamples(shardFile, r.samples, config.iter ?? 0);

			const seatList = Object.keys(r.finalVP) as SeatColor[];
			const weightsOrProfiles = seatList.map(
				(seat, index) =>
					config.opponentWeights?.[seat] ??
					(isLearnerSeat(seat)
						? (learnerRef ?? 'learner-policy')
						: (config.profiles[index % config.profiles.length] ?? 'medium'))
			);
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
					policy: isNeuralSeat(seat) ? ('neural' as const) : ('heuristic' as const),
					cycle: r.cycleBySeat[seat]
				})),
				wallMs: Math.round(wallMs * 10) / 10
			};
			appendFileSync(gamesFile, JSON.stringify(summary) + '\n');
			return { summary, samples: r.samples.length };
		},
		close() {
			if (closed) return;
			closed = true;
			remote?.close(); // the bridge's IO thread would otherwise outlive the run
		}
	};
}

/** Play every seed in `data.seeds`, writing this worker's shard + summary files. */
export function runActorGames(
	data: ActorWorkerData,
	onGame?: (summary: GameSummary) => void
): { games: number; samples: number } {
	const runner = createActorGameRunner(data);
	let samples = 0;
	try {
		for (const seed of data.seeds) {
			const result = runner.run(seed);
			samples += result.samples;
			onGame?.(result.summary);
		}
	} finally {
		runner.close();
	}
	return { games: data.seeds.length, samples };
}

// Spawned-thread path. The pool uses a persistent session and assigns a new seed
// whenever this worker announces readiness; the static branch remains for backwards
// compatibility with direct workerData callers.
const wd = workerData as
	| (ActorWorkerData & { __actorPool?: boolean; __dynamicSeeds?: boolean })
	| null;
if (parentPort && wd?.__actorPool) {
	const port = parentPort;
	const t0 = performance.now();
	if (wd.__dynamicSeeds) {
		let runner: ActorGameRunner | null = null;
		let games = 0;
		let samples = 0;
		let stopped = false;
		const fail = (err: unknown): void => {
			if (stopped) return;
			stopped = true;
			try {
				runner?.close();
			} finally {
				port.postMessage({
					type: 'error',
					workerIndex: wd.workerIndex,
					message: err instanceof Error ? (err.stack ?? err.message) : String(err)
				} satisfies ActorWorkerMessage);
				port.close();
				process.exitCode = 1;
			}
		};
		try {
			runner = createActorGameRunner(wd);
			const handleCommand = (command: ActorWorkerCommand): void => {
				if (stopped) return;
				try {
					if (command.type === 'run') {
						const result = runner!.run(command.seed);
						games += 1;
						samples += result.samples;
						port.postMessage({
							type: 'game',
							workerIndex: wd.workerIndex,
							jobIndex: command.jobIndex,
							summary: result.summary
						} satisfies ActorWorkerMessage);
						return;
					}
					runner!.close();
					stopped = true;
					port.off('message', handleCommand);
					port.postMessage({
						type: 'done',
						workerIndex: wd.workerIndex,
						games,
						samples,
						wallMs: performance.now() - t0
					} satisfies ActorWorkerMessage);
					port.close();
				} catch (err) {
					fail(err);
				}
			};
			port.on('message', handleCommand);
			port.postMessage({
				type: 'ready',
				workerIndex: wd.workerIndex
			} satisfies ActorWorkerMessage);
		} catch (err) {
			fail(err);
		}
	} else {
		try {
			let jobIndex = 0;
			const { games, samples } = runActorGames(wd, (summary) =>
				port.postMessage({
					type: 'game',
					workerIndex: wd.workerIndex,
					jobIndex: jobIndex++,
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
}
