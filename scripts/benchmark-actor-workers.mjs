#!/usr/bin/env node
/**
 * Repeatable actor-worker throughput sweep over production-shaped self-play.
 *
 * Unlike a raw reducer benchmark, this includes policy inference, legal-candidate
 * enumeration, trajectory construction, JSON serialization, and shard writes.
 * Every worker count sees the same seeds in each repetition. Trial order is
 * deterministically shuffled to reduce thermal/load-order bias, and the report
 * keeps every run plus p50/p90 summaries.
 *
 * League-shaped example (one sampled learner seat, heuristic opponents):
 *   node scripts/benchmark-actor-workers.mjs --games 128 --repeats 3 \
 *     --workers 16,24,32,48,60 --sample --temperature 1 \
 *     --neural-seats Red --record-seats Red --report /tmp/actor-workers.json
 *
 * GPU-inference example:
 *   node scripts/benchmark-actor-workers.mjs --infer-socket /tmp/arc-v1.sock \
 *     --sample --temperature 1 --neural-seats Red --record-seats Red
 */
import { createJiti } from 'jiti';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
	options: {
		games: { type: 'string', default: '128' },
		workers: { type: 'string', default: '1,2,4,8' },
		repeats: { type: 'string', default: '3' },
		'warmup-games': { type: 'string', default: '0' },
		'warmup-seed0': { type: 'string' },
		seed0: { type: 'string', default: '71000' },
		'shuffle-seed': { type: 'string', default: '710' },
		seats: { type: 'string', default: '4' },
		'max-rounds': { type: 'string', default: '90' },
		'max-status-level': { type: 'string' },
		'shuffle-guardians': { type: 'boolean', default: false },
		'guardian-schedule': { type: 'string' },
		gamma: { type: 'string' },
		weights: { type: 'string', default: 'src/lib/play/ml/policy-weights.json' },
		catalog: { type: 'string', default: 'ml/catalog.json' },
		'infer-socket': { type: 'string' },
		profiles: { type: 'string', default: 'pvphunter,medium,aggressive,hard' },
		selection: { type: 'string', default: 'hybrid' },
		sample: { type: 'boolean', default: false },
		temperature: { type: 'string' },
		'neural-seats': { type: 'string' },
		'record-seats': { type: 'string' },
		'no-record': { type: 'boolean', default: false },
		'opponent-weights': { type: 'string' },
		'opponent-temperature': { type: 'string' },
		'obs-version': { type: 'string', default: '1' },
		'policy-obs-version': { type: 'string', default: '1' },
		'search-sims': { type: 'string', default: '0' },
		'search-objective': { type: 'string', default: 'multiplayer' },
		'search-horizon': { type: 'string', default: '6' },
		'search-frac': { type: 'string', default: '1' },
		'search-value-weight': { type: 'string', default: '0.5' },
		'search-rollout': { type: 'string', default: 'policy' },
		'search-nav-temperature': { type: 'string', default: '0' },
		'rerank-policy-weight': { type: 'string' },
		label: { type: 'string' },
		'config-hash': { type: 'string' },
		progress: { type: 'string' },
		report: { type: 'string' },
		'keep-data': { type: 'boolean', default: false },
		help: { type: 'boolean', default: false }
	}
});

if (args.help) {
	console.log(
		'usage: node scripts/benchmark-actor-workers.mjs [--games N] [--repeats N] ' +
			'[--workers 1,4,8] [--weights FILE | --infer-socket SOCK] [--sample] ' +
			'[--temperature X] [--neural-seats Red] [--record-seats Red] ' +
			'[--catalog FILE] [--opponent-weights Blue=file,Green=file] ' +
			'[--rerank-policy-weight W] [--progress FILE] [--report FILE] [--keep-data]'
	);
	process.exit(0);
}

const csv = (raw) =>
	raw
		?.split(',')
		.map((value) => value.trim())
		.filter(Boolean) ?? [];
const positiveInt = (raw, name, { allowZero = false } = {}) => {
	const value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
		throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
	}
	return value;
};
const optionalNumber = (raw) => (raw === undefined ? undefined : Number.parseFloat(raw));
const quantile = (values, q) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
};
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const sampleStdDev = (values) => {
	if (values.length < 2) return 0;
	const avg = mean(values);
	return Math.sqrt(
		values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1)
	);
};
const trialOrderKey = (workers, repeat, shuffleSeed) => {
	let value = (workers * 0x9e3779b1 + repeat * 0x85ebca6b + shuffleSeed) >>> 0;
	value ^= value >>> 16;
	value = Math.imul(value, 0x7feb352d) >>> 0;
	value ^= value >>> 15;
	return value >>> 0;
};
const parseOpponentWeights = (raw) => {
	if (!raw) return undefined;
	const entries = csv(raw).map((entry) => {
		const split = entry.indexOf('=');
		if (split <= 0 || split === entry.length - 1) {
			throw new Error('--opponent-weights entries must look like Blue=path/to/weights.json');
		}
		return [entry.slice(0, split), path.resolve(root, entry.slice(split + 1))];
	});
	return Object.fromEntries(entries);
};
const countPolicyRows = (files) => {
	let trajectoryRows = 0;
	let policyRows = 0;
	for (const file of files) {
		const contents = readFileSync(file, 'utf8').trim();
		if (!contents) continue;
		for (const line of contents.split('\n')) {
			const row = JSON.parse(line);
			if (typeof row.gameId !== 'string') continue;
			trajectoryRows += 1;
			if (row.policyMask === 1 || row.policyMask === true) policyRows += 1;
		}
	}
	return { trajectoryRows, policyRows };
};

const workerCounts = [...new Set(csv(args.workers).map(Number))].filter(
	(value) => Number.isInteger(value) && value > 0
);
if (!workerCounts.length) throw new Error('--workers needs at least one positive integer');
const games = positiveInt(args.games, '--games');
const repeats = positiveInt(args.repeats, '--repeats');
const warmupGames = positiveInt(args['warmup-games'], '--warmup-games', { allowZero: true });
const warmupSeed0 =
	args['warmup-seed0'] === undefined
		? undefined
		: positiveInt(args['warmup-seed0'], '--warmup-seed0');
if (warmupGames > 0 && warmupSeed0 === undefined) {
	throw new Error('--warmup-games requires an explicit disjoint --warmup-seed0');
}
const seed0 = Number.parseInt(args.seed0, 10);
const shuffleSeed = Number.parseInt(args['shuffle-seed'], 10);
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'arc-actor-worker-bench-'));
const catalogPath = path.resolve(root, args.catalog);

const searchSims = positiveInt(args['search-sims'], '--search-sims', { allowZero: true });
const searchObjective = args['search-objective'];
if (searchObjective !== 'multiplayer' && searchObjective !== 'solo-reach30') {
	throw new Error('--search-objective must be multiplayer or solo-reach30');
}
if (args['search-rollout'] !== 'policy' && args['search-rollout'] !== 'heuristic') {
	throw new Error('--search-rollout must be policy or heuristic');
}
const searchFrac = optionalNumber(args['search-frac']);
const searchValueWeight = optionalNumber(args['search-value-weight']);
const searchNavTemperature = optionalNumber(args['search-nav-temperature']);
const rerankPolicyWeight = optionalNumber(args['rerank-policy-weight']);
if (!(searchFrac > 0 && searchFrac <= 1)) throw new Error('--search-frac must be in (0,1]');
if (!(searchValueWeight >= 0 && searchValueWeight <= 1)) {
	throw new Error('--search-value-weight must be in [0,1]');
}
if (!(searchNavTemperature >= 0)) {
	throw new Error('--search-nav-temperature must be non-negative');
}
if (
	rerankPolicyWeight !== undefined &&
	(!Number.isFinite(rerankPolicyWeight) || rerankPolicyWeight < 0 || rerankPolicyWeight > 1)
) {
	throw new Error('--rerank-policy-weight must be in [0,1]');
}
if (searchSims > 0 && rerankPolicyWeight !== undefined) {
	throw new Error('--search-sims and --rerank-policy-weight are mutually exclusive');
}

const jiti = createJiti(import.meta.url, { alias: { $lib: path.join(root, 'src', 'lib') } });
const { runActorPool } = await jiti.import(
	path.join(root, 'src', 'lib', 'play', 'ml', 'actorPool.ts')
);
const config = {
	seats: positiveInt(args.seats, '--seats'),
	maxRounds: positiveInt(args['max-rounds'], '--max-rounds'),
	maxStatusLevel:
		args['max-status-level'] === undefined
			? undefined
			: positiveInt(args['max-status-level'], '--max-status-level'),
	shuffleGuardians: args['shuffle-guardians'] || undefined,
	guardianSchedule: args['guardian-schedule'],
	gamma: optionalNumber(args.gamma),
	profiles: csv(args.profiles),
	weightsPath: args.weights ? path.resolve(root, args.weights) : undefined,
	inferSocket: args['infer-socket'],
	selection: args.selection,
	sample: args.sample || undefined,
	temperature: optionalNumber(args.temperature),
	neuralSeats: csv(args['neural-seats']).length ? csv(args['neural-seats']) : undefined,
	recordSeats: args['no-record']
		? []
		: csv(args['record-seats']).length
			? csv(args['record-seats'])
			: undefined,
	opponentWeights: parseOpponentWeights(args['opponent-weights']),
	opponentTemperature: optionalNumber(args['opponent-temperature']),
	obsVersion: positiveInt(args['obs-version'], '--obs-version'),
	policyObsVersion: positiveInt(args['policy-obs-version'], '--policy-obs-version'),
	...(searchSims > 0
		? {
				search: {
					sims: searchSims,
					objective: searchObjective,
					horizonRounds: positiveInt(args['search-horizon'], '--search-horizon'),
					frac: searchFrac,
					valueWeight: searchValueWeight,
					rollout: args['search-rollout'],
					navTemperature: searchNavTemperature
				}
			}
		: {}),
	...(rerankPolicyWeight !== undefined ? { rerank: { policyRankWeight: rerankPolicyWeight } } : {})
};
if (config.policyObsVersion === 2 && !config.inferSocket) {
	throw new Error('--policy-obs-version 2 requires --infer-socket');
}
if (config.guardianSchedule !== undefined && config.guardianSchedule !== 'absolute-balanced') {
	throw new Error('--guardian-schedule must be absolute-balanced');
}

const progressPath = args.progress ? path.resolve(args.progress) : undefined;
const writeProgress = (event) => {
	if (!progressPath) return;
	appendFileSync(progressPath, `${JSON.stringify(event)}\n`);
};
if (progressPath) {
	if (existsSync(progressPath)) {
		throw new Error(`--progress path already exists: ${progressPath}`);
	}
	mkdirSync(path.dirname(progressPath), { recursive: true });
	writeFileSync(progressPath, '', { flag: 'wx' });
	writeProgress({
		schemaVersion: 'arc-actor-benchmark-progress-v1',
		event: 'benchmark-start',
		timestamp: new Date().toISOString(),
		label: args.label ?? null,
		configHash: args['config-hash'] ?? null,
		seed0,
		gamesPerTrial: games,
		repeats,
		workerCounts,
		planner:
			rerankPolicyWeight !== undefined
				? { mode: 'critic-rerank', policyRankWeight: rerankPolicyWeight }
				: searchSims > 0
					? { mode: 'gumbel', sims: searchSims, horizonRounds: config.search.horizonRounds }
					: null
	});
}

const trials = [];
for (let repeat = 0; repeat < repeats; repeat += 1) {
	for (const count of workerCounts) {
		trials.push({ count, repeat, key: trialOrderKey(count, repeat, shuffleSeed) });
	}
}
trials.sort((left, right) => left.key - right.key);

const trialRows = [];
try {
	if (warmupGames > 0) {
		for (const count of workerCounts) {
			const seeds = Array.from({ length: warmupGames }, (_, index) => warmupSeed0 + index);
			await runActorPool({
				seeds,
				outDir: path.join(tempRoot, `warmup-${count}`),
				workers: count,
				config,
				catalogPath
			});
		}
	}

	for (const trial of trials) {
		const trialSeed0 = seed0 + trial.repeat * games;
		const seeds = Array.from({ length: games }, (_, index) => trialSeed0 + index);
		let completed = 0;
		writeProgress({
			schemaVersion: 'arc-actor-benchmark-progress-v1',
			event: 'trial-start',
			timestamp: new Date().toISOString(),
			label: args.label ?? null,
			configHash: args['config-hash'] ?? null,
			workers: Math.min(trial.count, games),
			repeat: trial.repeat,
			seed0: trialSeed0,
			games
		});
		let result;
		try {
			result = await runActorPool({
				seeds,
				outDir: path.join(tempRoot, `${trial.count}-workers-r${trial.repeat}`),
				workers: trial.count,
				config,
				catalogPath,
				onGame: (summary) => {
					completed += 1;
					const decisionWallMs = summary.search?.decisionWallMs ?? [];
					writeProgress({
						schemaVersion: 'arc-actor-benchmark-progress-v1',
						event: 'game-complete',
						timestamp: new Date().toISOString(),
						label: args.label ?? null,
						configHash: args['config-hash'] ?? null,
						workers: Math.min(trial.count, games),
						repeat: trial.repeat,
						completionOrdinal: completed,
						games,
						seed: summary.seed,
						wallMs: summary.wallMs,
						plannerMode: summary.search?.mode ?? null,
						strategicDecisions: summary.search?.decisions ?? 0,
						strategicSimulations: summary.search?.simulations ?? 0,
						decisionWallMs,
						byPhase: summary.search?.byPhase ?? null,
						inferenceProvenance: summary.inference ?? null
					});
				}
			});
		} catch (error) {
			writeProgress({
				schemaVersion: 'arc-actor-benchmark-progress-v1',
				event: 'trial-error',
				timestamp: new Date().toISOString(),
				label: args.label ?? null,
				configHash: args['config-hash'] ?? null,
				workers: Math.min(trial.count, games),
				repeat: trial.repeat,
				completed,
				games,
				error: error instanceof Error ? error.message : String(error)
			});
			throw error;
		}
		const policyCoverage = countPolicyRows(result.shardFiles);
		const gameWallTimes = result.summaries.map((summary) => summary.wallMs);
		const searchDecisionWallTimes = result.summaries.flatMap(
			(summary) => summary.search?.decisionWallMs ?? []
		);
		const searchDecisions = result.summaries.reduce(
			(sum, summary) => sum + (summary.search?.decisions ?? 0),
			0
		);
		const searchSimulations = result.summaries.reduce(
			(sum, summary) => sum + (summary.search?.simulations ?? 0),
			0
		);
		const plannerMode = result.summaries[0]?.search?.mode ?? null;
		if (result.summaries.some((summary) => (summary.search?.mode ?? null) !== plannerMode)) {
			throw new Error('benchmark strategic planner mode changed within a trial');
		}
		const inference = result.summaries[0]?.inference ?? null;
		if (
			args['infer-socket'] &&
			(!inference ||
				result.summaries.some(
					(summary) => JSON.stringify(summary.inference) !== JSON.stringify(inference)
				))
		) {
			throw new Error('remote benchmark inference provenance is missing or changed within a trial');
		}
		const row = {
			workers: result.workers,
			repeat: trial.repeat,
			seed0: trialSeed0,
			games: result.games,
			samples: result.samples,
			trajectoryRows: policyCoverage.trajectoryRows,
			validPolicyRows: policyCoverage.policyRows,
			validPolicyRowPct:
				policyCoverage.trajectoryRows > 0
					? (100 * policyCoverage.policyRows) / policyCoverage.trajectoryRows
					: 0,
			wallMs: result.wallMs,
			gamesPerSecond: result.gamesPerSec,
			samplesPerSecond: result.samples / (result.wallMs / 1000),
			validPolicyRowsPerSecond: policyCoverage.policyRows / (result.wallMs / 1000),
			gameWallMsP50: quantile(gameWallTimes, 0.5),
			gameWallMsP95: quantile(gameWallTimes, 0.95),
			searchDecisions,
			searchSimulations,
			plannerMode,
			searchDecisionsPerSecond: searchDecisions / (result.wallMs / 1000),
			searchDecisionWallMsP50:
				searchDecisionWallTimes.length > 0 ? quantile(searchDecisionWallTimes, 0.5) : null,
			searchDecisionWallMsP95:
				searchDecisionWallTimes.length > 0 ? quantile(searchDecisionWallTimes, 0.95) : null,
			inference
		};
		trialRows.push(row);
		writeProgress({
			schemaVersion: 'arc-actor-benchmark-progress-v1',
			event: 'trial-complete',
			timestamp: new Date().toISOString(),
			label: args.label ?? null,
			configHash: args['config-hash'] ?? null,
			workers: row.workers,
			repeat: row.repeat,
			completed,
			games: row.games,
			wallMs: row.wallMs,
			gamesPerSecond: row.gamesPerSecond,
			plannerMode: row.plannerMode,
			searchDecisions: row.searchDecisions,
			searchSimulations: row.searchSimulations,
			searchDecisionWallMsP95: row.searchDecisionWallMsP95,
			inference: row.inference
		});
		console.log(
			`${trial.count} workers r${trial.repeat}: ${row.gamesPerSecond.toFixed(2)} games/s, ` +
				`${row.samplesPerSecond.toFixed(0)} samples/s, ` +
				`${row.validPolicyRowsPerSecond.toFixed(0)} policy rows/s`
		);
	}

	const rows = workerCounts.map((count) => {
		const matching = trialRows.filter((row) => row.workers === Math.min(count, games));
		const gameRates = matching.map((row) => row.gamesPerSecond);
		const sampleRates = matching.map((row) => row.samplesPerSecond);
		const policyRates = matching.map((row) => row.validPolicyRowsPerSecond);
		const gameP95 = matching.map((row) => row.gameWallMsP95);
		const searchRates = matching.map((row) => row.searchDecisionsPerSecond);
		const searchP95 = matching
			.map((row) => row.searchDecisionWallMsP95)
			.filter((value) => value !== null);
		return {
			workers: Math.min(count, games),
			repeats: matching.length,
			gamesPerSecondP50: quantile(gameRates, 0.5),
			gamesPerSecondP90: quantile(gameRates, 0.9),
			gamesPerSecondMean: mean(gameRates),
			gamesPerSecondStdDev: sampleStdDev(gameRates),
			samplesPerSecondP50: quantile(sampleRates, 0.5),
			samplesPerSecondP90: quantile(sampleRates, 0.9),
			validPolicyRowsPerSecondP50: quantile(policyRates, 0.5),
			validPolicyRowsPerSecondP90: quantile(policyRates, 0.9),
			gameWallMsP95Median: quantile(gameP95, 0.5),
			searchDecisionsPerSecondP50: quantile(searchRates, 0.5),
			searchDecisionWallMsP95Median: searchP95.length > 0 ? quantile(searchP95, 0.5) : null,
			efficiencyVsOneWorkerP50: null
		};
	});
	const one = rows.find((row) => row.workers === 1);
	if (one) {
		for (const row of rows) {
			row.efficiencyVsOneWorkerP50 = row.gamesPerSecondP50 / one.gamesPerSecondP50 / row.workers;
		}
	}
	const report = {
		capturedAt: new Date().toISOString(),
		host: os.hostname(),
		logicalCpus: os.cpus().length,
		gamesPerTrial: games,
		repeats,
		seed0,
		shuffleSeed,
		catalogPath,
		trialOrder: trials.map(({ count, repeat }) => ({ workers: count, repeat })),
		config,
		rows,
		trials: trialRows
	};
	if (args.report) {
		writeFileSync(path.resolve(args.report), JSON.stringify(report, null, 2) + '\n');
		console.log(`wrote ${path.resolve(args.report)}`);
	} else {
		console.log(JSON.stringify(report, null, 2));
	}
	writeProgress({
		schemaVersion: 'arc-actor-benchmark-progress-v1',
		event: 'benchmark-complete',
		timestamp: new Date().toISOString(),
		label: args.label ?? null,
		configHash: args['config-hash'] ?? null,
		trials: trialRows.length
	});
} finally {
	if (!args['keep-data']) rmSync(tempRoot, { recursive: true, force: true });
	else console.log(`kept benchmark shards in ${tempRoot}`);
}
