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
import { createRng, hashString, nextInt } from '../rng';
import type { GameCommand, PlayCatalog, SeatColor } from '../types';
import { OBS_DIM } from './encode';
import { obsV2Meta } from './encodeV2';
import {
	forkContinuationPickRng,
	playRecordingGame,
	type RecordGameOptions,
	type Sample
} from './driver';
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
	ContinuationCurriculumDiagnostics,
	GameSummary
} from './poolTypes';

function loadPolicyStrict(file: string): NeuralPolicy {
	const policy = loadWeightsIfPresent(file);
	if (!policy) throw new Error(`actorWorker: weights file missing or absent: ${file}`);
	return policy;
}

interface ActorGameRunner {
	run(
		seed: number,
		jobIndex: number,
		duplicateSeed?: boolean
	): { summary: GameSummary; samples: number; curriculum: ContinuationCurriculumDiagnostics };
	close(): void;
}

interface NormalizedContinuationCurriculum {
	rounds: number[];
	sourceProbability: number;
	capFailureWeight: number;
	successWeight: number;
}

export function emptyContinuationCurriculumDiagnostics(): ContinuationCurriculumDiagnostics {
	return {
		eligibleSourceGames: 0,
		selectedSourceGames: 0,
		episodes: 0,
		rows: 0,
		wallMs: 0,
		sourceCapFailures: 0,
		sourceSuccesses: 0,
		forkSuccesses: 0,
		forkFailures: 0,
		recoveries: 0,
		skippedNoSnapshot: 0,
		sourceRoundCounts: {},
		forkRoundCounts: {}
	};
}

function addCurriculumDiagnostics(
	into: ContinuationCurriculumDiagnostics,
	add: ContinuationCurriculumDiagnostics
): void {
	for (const key of [
		'eligibleSourceGames',
		'selectedSourceGames',
		'episodes',
		'rows',
		'wallMs',
		'sourceCapFailures',
		'sourceSuccesses',
		'forkSuccesses',
		'forkFailures',
		'recoveries',
		'skippedNoSnapshot'
	] as const) {
		into[key] += add[key];
	}
	for (const key of ['sourceRoundCounts', 'forkRoundCounts'] as const) {
		for (const [round, count] of Object.entries(add[key])) {
			into[key][round] = (into[key][round] ?? 0) + count;
		}
	}
}

function normalizeContinuationCurriculum(
	data: ActorWorkerData,
	hasPolicy: boolean
): NormalizedContinuationCurriculum | null {
	const raw = data.config.continuationCurriculum;
	if (!raw?.enabled) return null;
	if (data.config.seats !== 1) {
		throw new Error('actorWorker: continuation curriculum is train-only and requires seats=1');
	}
	if (!hasPolicy || data.config.recordSeats?.length === 0) {
		throw new Error('actorWorker: continuation curriculum requires a recorded learner policy');
	}
	if (data.config.search) {
		throw new Error('actorWorker: continuation curriculum does not support opaque search state');
	}
	if (data.config.sample !== true) {
		throw new Error(
			'actorWorker: continuation curriculum requires sample=true for policy RNG forks'
		);
	}
	if (Object.keys(data.config.opponentWeights ?? {}).length > 0) {
		throw new Error('actorWorker: continuation curriculum does not support opponent policies');
	}
	const rounds = [...new Set(raw.rounds ?? [12, 16, 20])].sort((a, b) => a - b);
	if (
		rounds.length === 0 ||
		rounds.some((round) => !Number.isInteger(round) || round < 12 || round > 20)
	) {
		throw new Error('actorWorker: continuation curriculum rounds must be integers in 12..20');
	}
	if (rounds.some((round) => round > data.config.maxRounds)) {
		throw new Error('actorWorker: continuation curriculum round exceeds maxRounds');
	}
	const sourceProbability = raw.sourceProbability ?? 1;
	const capFailureWeight = raw.capFailureWeight ?? 1;
	const successWeight = raw.successWeight ?? 0.25;
	if (!Number.isFinite(sourceProbability) || sourceProbability < 0 || sourceProbability > 1) {
		throw new Error('actorWorker: continuation sourceProbability must be in [0,1]');
	}
	for (const [label, value] of [
		['capFailureWeight', capFailureWeight],
		['successWeight', successWeight]
	] as const) {
		if (!Number.isFinite(value) || value < 0) {
			throw new Error(`actorWorker: continuation ${label} must be finite and non-negative`);
		}
	}
	return { rounds, sourceProbability, capFailureWeight, successWeight };
}

function deterministicUnitInterval(key: string): number {
	return hashString(key) / 0x1_0000_0000;
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
	const continuationCurriculum = normalizeContinuationCurriculum(data, !!policy);

	let closed = false;
	return {
		run(seed, jobIndex, duplicateSeed = false) {
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
			const guardianNames = config.shuffleGuardians
				? shuffledGuardianNames(catalog, config.seats, seed)
				: undefined;
			const gameOptions: RecordGameOptions = {
				seed,
				...(continuationCurriculum || duplicateSeed
					? { episodeId: `actor-source-v1-${seed}-j${jobIndex}` }
					: {}),
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
				guardianNames,
				gamma: config.gamma,
				obsVersion: config.obsVersion,
				policyObsVersion: config.policyObsVersion,
				denseVpReward: config.denseVpReward,
				...(config.shapingPreset ? { shaping: shapingFor(config.shapingPreset) } : {}),
				potentialShapingMode: config.potentialShapingMode,
				strategicDecisionScope: config.strategicDecisionScope,
				searcher,
				...(continuationCurriculum
					? { captureContinuationRounds: continuationCurriculum.rounds }
					: {})
			};
			const r = playRecordingGame(catalog, gameOptions);
			const sourceWallMs = performance.now() - t0;
			appendSamples(shardFile, r.samples, config.iter ?? 0);

			const curriculum = emptyContinuationCurriculumDiagnostics();
			let appendedSamples = r.samples.length;
			if (continuationCurriculum) {
				curriculum.eligibleSourceGames = 1;
				const seat = 'Red' as SeatColor;
				const sourceSucceeded = !r.stalled && (r.finalVP[seat] ?? 0) >= 30;
				const outcomeWeight = sourceSucceeded
					? continuationCurriculum.successWeight
					: continuationCurriculum.capFailureWeight;
				const selectionProbability = Math.min(
					1,
					continuationCurriculum.sourceProbability * outcomeWeight
				);
				const selectionKey = [
					'arc-continuation-select-v1',
					seed,
					jobIndex,
					continuationCurriculum.rounds.join(','),
					sourceSucceeded ? 'success' : 'cap-failure'
				].join(':');
				if (deterministicUnitInterval(selectionKey) < selectionProbability) {
					curriculum.selectedSourceGames = 1;
					curriculum[sourceSucceeded ? 'sourceSuccesses' : 'sourceCapFailures'] = 1;
					if (r.continuationSnapshots.length === 0) {
						curriculum.skippedNoSnapshot = 1;
					} else {
						const snapshotIndex =
							hashString(`arc-continuation-round-v1:${seed}:${jobIndex}`) %
							r.continuationSnapshots.length;
						const snapshot = r.continuationSnapshots[snapshotIndex];
						const episodeId = `late-cont-v1-${seed}-j${jobIndex}-r${snapshot.round}-f0`;
						const suffixT0 = performance.now();
						const suffix = playRecordingGame(catalog, {
							...gameOptions,
							episodeId,
							captureContinuationRounds: undefined,
							searcher: undefined,
							opponentPolicies: undefined,
							continuation: {
								snapshot,
								pickRng: forkContinuationPickRng(snapshot, episodeId)
							}
						});
						for (const sample of suffix.samples as Sample[]) sample.continuationCurriculum = 1;
						appendSamples(shardFile, suffix.samples, config.iter ?? 0);
						appendedSamples += suffix.samples.length;
						const forkSucceeded = !suffix.stalled && (suffix.finalVP[seat] ?? 0) >= 30;
						curriculum.episodes = 1;
						curriculum.rows = suffix.samples.length;
						curriculum.wallMs = performance.now() - suffixT0;
						curriculum[forkSucceeded ? 'forkSuccesses' : 'forkFailures'] = 1;
						if (!sourceSucceeded && forkSucceeded) curriculum.recoveries = 1;
						curriculum.sourceRoundCounts[String(snapshot.round)] = 1;
						curriculum.forkRoundCounts[String(snapshot.round)] = 1;
					}
				}
			}

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
				wallMs:
					Math.round(
						(continuationCurriculum ? performance.now() - t0 : sourceWallMs) * 10
					) / 10
			};
			appendFileSync(gamesFile, JSON.stringify(summary) + '\n');
			return { summary, samples: appendedSamples, curriculum };
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
): { games: number; samples: number; curriculum: ContinuationCurriculumDiagnostics } {
	const runner = createActorGameRunner(data);
	let samples = 0;
	const curriculum = emptyContinuationCurriculumDiagnostics();
	const seedCounts = new Map<number, number>();
	for (const seed of data.seeds) seedCounts.set(seed, (seedCounts.get(seed) ?? 0) + 1);
	try {
		for (const [jobIndex, seed] of data.seeds.entries()) {
			const result = runner.run(seed, jobIndex, (seedCounts.get(seed) ?? 0) > 1);
			samples += result.samples;
			addCurriculumDiagnostics(curriculum, result.curriculum);
			onGame?.(result.summary);
		}
	} finally {
		runner.close();
	}
	return { games: data.seeds.length, samples, curriculum };
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
		const curriculum = emptyContinuationCurriculumDiagnostics();
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
						const result = runner!.run(
							command.seed,
							command.jobIndex,
							command.duplicateSeed
						);
						games += 1;
						samples += result.samples;
						addCurriculumDiagnostics(curriculum, result.curriculum);
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
						wallMs: performance.now() - t0,
						curriculum
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
			const { games, samples, curriculum } = runActorGames(wd, (summary) =>
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
				wallMs: performance.now() - t0,
				curriculum
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
