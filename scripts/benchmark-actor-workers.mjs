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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
			'[--catalog FILE] [--opponent-weights Blue=file,Green=file] [--report FILE] [--keep-data]'
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
if (!(searchFrac > 0 && searchFrac <= 1)) throw new Error('--search-frac must be in (0,1]');
if (!(searchValueWeight >= 0 && searchValueWeight <= 1)) {
	throw new Error('--search-value-weight must be in [0,1]');
}
if (!(searchNavTemperature >= 0)) {
	throw new Error('--search-nav-temperature must be non-negative');
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
		: {})
};
if (config.policyObsVersion === 2 && !config.inferSocket) {
	throw new Error('--policy-obs-version 2 requires --infer-socket');
}
if (config.guardianSchedule !== undefined && config.guardianSchedule !== 'absolute-balanced') {
	throw new Error('--guardian-schedule must be absolute-balanced');
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
		const result = await runActorPool({
			seeds,
			outDir: path.join(tempRoot, `${trial.count}-workers-r${trial.repeat}`),
			workers: trial.count,
			config,
			catalogPath
		});
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
			searchDecisionsPerSecond: searchDecisions / (result.wallMs / 1000),
			searchDecisionWallMsP50:
				searchDecisionWallTimes.length > 0 ? quantile(searchDecisionWallTimes, 0.5) : null,
			searchDecisionWallMsP95:
				searchDecisionWallTimes.length > 0 ? quantile(searchDecisionWallTimes, 0.95) : null,
			inference
		};
		trialRows.push(row);
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
} finally {
	if (!args['keep-data']) rmSync(tempRoot, { recursive: true, force: true });
	else console.log(`kept benchmark shards in ${tempRoot}`);
}
