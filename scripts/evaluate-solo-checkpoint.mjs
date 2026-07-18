#!/usr/bin/env node
/**
 * Held-out one-player checkpoint evaluation on the production objective.
 *
 * A one-player game always names the lone seat winner at the round cap, so winnerSeat is not a
 * useful success metric. This evaluator instead requires finalVP >= 30, reports a Wilson 95%
 * interval, and records no training samples. Keep seed ranges disjoint from league generation and
 * quick-eval seeds when using this as a certification gate.
 *
 *   node scripts/evaluate-solo-checkpoint.mjs \
 *     --weights ml/checkpoint.json --games 1024 --seed0 900000000 \
 *     --sample --temperature 0.65 --out ml/heldout/solo.json
 */
import { createJiti } from 'jiti';
import { createHash } from 'node:crypto';
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const { values: args } = parseArgs({
	options: {
		weights: { type: 'string' },
		'infer-socket': { type: 'string' },
		'policy-obs-version': { type: 'string', default: '1' },
		catalog: { type: 'string', default: 'ml/catalog.json' },
		'source-commit': { type: 'string' },
		experiment: { type: 'string' },
		replicate: { type: 'string' },
		arm: { type: 'string' },
		'config-sha256': { type: 'string' },
		'binding-sha256': { type: 'string' },
		'root-identity': { type: 'string' },
		games: { type: 'string', default: '1024' },
		workers: { type: 'string', default: '16' },
		seed0: { type: 'string', default: '900000000' },
		'max-rounds': { type: 'string', default: '30' },
		'max-status-level': { type: 'string', default: '2' },
		'learn-monster-reward-choices': { type: 'boolean', default: false },
		sample: { type: 'boolean', default: false },
		temperature: { type: 'string', default: '0.65' },
		'search-sims': { type: 'string', default: '0' },
		'search-objective': { type: 'string', default: 'multiplayer' },
		'search-horizon': { type: 'string', default: '6' },
		'search-frac': { type: 'string', default: '1' },
		'search-value-weight': { type: 'string', default: '0.5' },
		'search-rollout': { type: 'string', default: 'policy' },
		'search-nav-temperature': { type: 'string', default: '0' },
		'rerank-policy-weight': { type: 'string' },
		'include-games': { type: 'boolean', default: false },
		'include-replay-hashes': { type: 'boolean', default: false },
		quiet: { type: 'boolean', default: false },
		out: { type: 'string' },
		help: { type: 'boolean', default: false }
	}
});

if (args.help || !args.weights) {
	console.log(
		'usage: node scripts/evaluate-solo-checkpoint.mjs --weights FILE [--catalog FILE] [--source-commit SHA] [--games N] [--workers N] ' +
			'[--infer-socket SOCK --policy-obs-version 2] ' +
			'[--seed0 N] [--learn-monster-reward-choices] [--sample --temperature T] ' +
			'[--search-sims N | --rerank-policy-weight W] [--include-games] [--include-replay-hashes] [--out FILE]'
	);
	process.exit(args.help ? 0 : 1);
}

const integer = (value, label) => {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0)
		throw new Error(`${label} must be a positive integer`);
	return parsed;
};
const mean = (values) =>
	values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
const quantile = (sorted, q) => {
	if (sorted.length === 0) return null;
	const index = (sorted.length - 1) * q;
	const lo = Math.floor(index);
	const hi = Math.ceil(index);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const wilson95 = (wins, games) => {
	if (games === 0) return { lower: 0, upper: 1 };
	const z = 1.959963984540054;
	const p = wins / games;
	const z2 = z * z;
	const denominator = 1 + z2 / games;
	const center = (p + z2 / (2 * games)) / denominator;
	const radius = (z * Math.sqrt((p * (1 - p) + z2 / (4 * games)) / games)) / denominator;
	return { lower: center - radius, upper: center + radius };
};

const games = integer(args.games, '--games');
const workers = integer(args.workers, '--workers');
const seed0 = integer(args.seed0, '--seed0');
const maxRounds = integer(args['max-rounds'], '--max-rounds');
const maxStatusLevel = integer(args['max-status-level'], '--max-status-level');
const identityFields = [
	'experiment',
	'replicate',
	'arm',
	'config-sha256',
	'binding-sha256',
	'root-identity'
];
const identityValues = identityFields.map((field) => args[field]);
if (identityValues.some(Boolean) && !identityValues.every(Boolean)) {
	throw new Error('execution identity fields must be provided together');
}
if (
	identityValues.every(Boolean) &&
	(!/^[0-9a-f]{64}$/.test(args['config-sha256']) ||
		!/^[0-9a-f]{64}$/.test(args['binding-sha256']))
) {
	throw new Error('execution identity config/binding hashes must be SHA-256 values');
}
const searchSims = Number.parseInt(args['search-sims'], 10);
if (!Number.isSafeInteger(searchSims) || searchSims < 0) {
	throw new Error('--search-sims must be a non-negative integer');
}
const searchObjective = args['search-objective'];
if (searchObjective !== 'multiplayer' && searchObjective !== 'solo-reach30') {
	throw new Error('--search-objective must be multiplayer or solo-reach30');
}
const searchHorizon = integer(args['search-horizon'], '--search-horizon');
const searchFrac = Number.parseFloat(args['search-frac']);
const searchValueWeight = Number.parseFloat(args['search-value-weight']);
const searchNavTemperature = Number.parseFloat(args['search-nav-temperature']);
const rerankPolicyWeight =
	args['rerank-policy-weight'] === undefined
		? undefined
		: Number.parseFloat(args['rerank-policy-weight']);
if (!Number.isFinite(searchFrac) || searchFrac <= 0 || searchFrac > 1) {
	throw new Error('--search-frac must be in (0, 1]');
}
if (!Number.isFinite(searchValueWeight) || searchValueWeight < 0) {
	throw new Error('--search-value-weight must be non-negative');
}
if (!Number.isFinite(searchNavTemperature) || searchNavTemperature < 0) {
	throw new Error('--search-nav-temperature must be non-negative');
}
if (args['search-rollout'] !== 'policy' && args['search-rollout'] !== 'heuristic') {
	throw new Error('--search-rollout must be policy or heuristic');
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
const plannerEnabled = searchSims > 0 || rerankPolicyWeight !== undefined;
const temperature = Number.parseFloat(args.temperature);
if (!Number.isFinite(temperature) || temperature <= 0) {
	throw new Error('--temperature must be a positive number');
}
const policyObsVersion = Number.parseInt(args['policy-obs-version'], 10);
if (policyObsVersion !== 1 && policyObsVersion !== 2) {
	throw new Error('--policy-obs-version must be 1 or 2');
}
if (policyObsVersion === 2 && !args['infer-socket']) {
	throw new Error('--policy-obs-version 2 requires --infer-socket');
}

const jiti = createJiti(import.meta.url, { alias: { $lib: path.join(root, 'src', 'lib') } });
const { runActorPool } = await jiti.import(
	path.join(root, 'src', 'lib', 'play', 'ml', 'actorPool.ts')
);
const { guardianIndexForSeed } = await jiti.import(
	path.join(root, 'src', 'lib', 'play', 'ml', 'evalSchedule.ts')
);
const { MAX_ROUNDS } = await jiti.import(path.join(root, 'src', 'lib', 'play', 'types.ts'));
const effectiveMaxRounds = Math.min(maxRounds, MAX_ROUNDS);
if (effectiveMaxRounds !== maxRounds) {
	console.error(
		`[solo-heldout] requested ${maxRounds} rounds, but the game engine hard-caps at ` +
			`${MAX_ROUNDS}; reporting the effective ${effectiveMaxRounds}-round horizon`
	);
}
const catalogPath = path.resolve(args.catalog);
const catalogBytes = readFileSync(catalogPath);
const catalog = JSON.parse(catalogBytes.toString('utf8'));
const workDir = mkdtempSync(path.join(tmpdir(), 'arc-solo-heldout-'));
const weights = path.resolve(args.weights);
const weightsBytes = readFileSync(weights);

const guardianForSeed = (seed) => {
	const names = catalog.guardians.map((guardian) => guardian.name);
	return names[guardianIndexForSeed(seed, names.length)];
};

try {
	const result = await runActorPool({
		seeds: Array.from({ length: games }, (_, index) => seed0 + index),
		outDir: workDir,
		workers,
		catalogPath,
		config: {
			seats: 1,
			maxRounds: effectiveMaxRounds,
			profiles: ['medium'],
			weightsPath: weights,
			inferSocket: args['infer-socket'],
			selection: 'hybrid',
			learnMonsterRewardChoices: args['learn-monster-reward-choices'] || undefined,
			sample: args.sample,
			temperature,
			recordSeats: [],
			maxStatusLevel,
			guardianSchedule: 'absolute-balanced',
			...(searchSims > 0
				? {
						search: {
							sims: searchSims,
							objective: searchObjective,
							horizonRounds: searchHorizon,
							frac: searchFrac,
							valueWeight: searchValueWeight,
							rollout: args['search-rollout'],
							navTemperature: searchNavTemperature
						}
					}
				: {}),
			...(rerankPolicyWeight !== undefined
				? { rerank: { policyRankWeight: rerankPolicyWeight } }
				: {}),
			obsVersion: 1,
			policyObsVersion,
			includeReplayTraceHash: args['include-replay-hashes'] || undefined
		}
	});
	const inference = result.summaries[0]?.inference;
	if (args['infer-socket']) {
		if (!inference) throw new Error('remote evaluation did not record its inference handshake');
		if (inference.weightsSha256 !== sha256(weightsBytes)) {
			throw new Error(
				`served checkpoint hash ${inference.weightsSha256} does not match --weights ${sha256(weightsBytes)}`
			);
		}
		if (
			result.summaries.some(
				(summary) => JSON.stringify(summary.inference) !== JSON.stringify(inference)
			)
		) {
			throw new Error('inference provenance changed within the evaluation');
		}
	}

	const vp = [];
	const first30Rounds = [];
	const post15 = [];
	const dice = [];
	const spirits = [];
	const barriers = [];
	const perGame = [];
	let trueWins = 0;
	let namedWins = 0;
	let stalls = 0;
	let reach15 = 0;
	let nearMisses = 0;
	const guardianStats = new Map();
	for (const game of result.summaries) {
		const seat = game.perSeat[0];
		if (!seat) throw new Error(`heldout seed ${game.seed} has no solo seat summary`);
		const guardian = guardianForSeed(game.seed);
		const guardianStat = guardianStats.get(guardian) ?? { guardian, games: 0, trueWins: 0, vp: [] };
		guardianStat.games += 1;
		guardianStat.vp.push(seat.finalVP);
		if (seat.finalVP >= 30 && !game.stalled) guardianStat.trueWins += 1;
		guardianStats.set(guardian, guardianStat);
		vp.push(seat.finalVP);
		// A deadlocked bot has not completed a valid solo win even if it happened to
		// cross the score threshold first; stalls are always promotion failures.
		if (seat.finalVP >= 30 && !game.stalled) trueWins += 1;
		if (seat.finalVP >= 15) reach15 += 1;
		if (seat.finalVP >= 27 && seat.finalVP < 30) nearMisses += 1;
		if (game.winnerSeat === seat.seat) namedWins += 1;
		if (game.stalled) stalls += 1;
		if (seat.cycle) {
			if (seat.cycle.first30Round !== null) first30Rounds.push(seat.cycle.first30Round);
			post15.push(seat.cycle.post15VpPerRound);
			dice.push(seat.cycle.finalAttackDice);
			spirits.push(seat.cycle.finalSpirits);
			barriers.push(seat.cycle.finalMaxBarrier);
		}
		if (args['include-games']) {
			perGame.push({
				seed: game.seed,
				guardian,
				trueWin: seat.finalVP >= 30 && !game.stalled,
				stalled: game.stalled,
				finalVP: seat.finalVP,
				first30Round: seat.cycle?.first30Round ?? null,
				post15VpPerRound: seat.cycle?.post15VpPerRound ?? null,
				finalAttackDice: seat.cycle?.finalAttackDice ?? null,
				finalSpirits: seat.cycle?.finalSpirits ?? null,
				finalMaxBarrier: seat.cycle?.finalMaxBarrier ?? null,
				cycle: seat.cycle ?? null
			});
		}
	}
	const sortedVp = [...vp].sort((a, b) => a - b);
	const sortedGameWallMs = result.summaries.map((game) => game.wallMs).sort((a, b) => a - b);
	const sortedSearchDecisionWallMs = result.summaries
		.flatMap((game) => game.search?.decisionWallMs ?? [])
		.sort((a, b) => a - b);
	const searchDecisions = result.summaries.reduce(
		(sum, game) => sum + (game.search?.decisions ?? 0),
		0
	);
	const searchSimulations = result.summaries.reduce(
		(sum, game) => sum + (game.search?.simulations ?? 0),
		0
	);
	const plannerMode = result.summaries[0]?.search?.mode ?? null;
	if (result.summaries.some((game) => (game.search?.mode ?? null) !== plannerMode)) {
		throw new Error('strategic planner mode changed within the evaluation');
	}
	const searchByPhase = result.summaries.reduce(
		(total, game) => {
			total.navigation += game.search?.byPhase.navigation ?? 0;
			total.encounter += game.search?.byPhase.encounter ?? 0;
			return total;
		},
		{ navigation: 0, encounter: 0 }
	);
	const interval = wilson95(trueWins, games);
	const guardianBreakdown = [...guardianStats.values()]
		.map((stat) => ({
			guardian: stat.guardian,
			games: stat.games,
			trueWins: stat.trueWins,
			trueWinRate: stat.trueWins / stat.games,
			trueWinWilson95: wilson95(stat.trueWins, stat.games),
			meanVP: mean(stat.vp),
			medianVP: quantile(
				[...stat.vp].sort((a, b) => a - b),
				0.5
			)
		}))
		.sort((left, right) => left.trueWinRate - right.trueWinRate || left.meanVP - right.meanVP);
	const vpBuckets = {
		under15: vp.filter((value) => value < 15).length,
		from15To19: vp.filter((value) => value >= 15 && value < 20).length,
		from20To24: vp.filter((value) => value >= 20 && value < 25).length,
		from25To26: vp.filter((value) => value >= 25 && value < 27).length,
		from27To29: vp.filter((value) => value >= 27 && value < 30).length,
		atLeast30WithoutStall: trueWins,
		stalledAtLeast30: result.summaries.filter(
			(game) => game.stalled && (game.perSeat[0]?.finalVP ?? 0) >= 30
		).length
	};
	const replayHashes = args['include-replay-hashes']
		? result.summaries.map((game) => {
				if (!/^[0-9a-f]{64}$/.test(game.replayTraceSha256 ?? '')) {
					throw new Error(`heldout seed ${game.seed} is missing its replay trace hash`);
				}
				return { seed: game.seed, replayTraceSha256: game.replayTraceSha256 };
			})
		: undefined;
	const report = {
		schemaVersion: 'solo-heldout-v2',
		...(args['source-commit'] ? { sourceCommit: args['source-commit'] } : {}),
		...(identityValues.every(Boolean)
			? {
					executionIdentity: {
						experiment: args.experiment,
						replicate: args.replicate,
						arm: args.arm,
						configSha256: args['config-sha256'],
						bindingSha256: args['binding-sha256'],
						root: args['root-identity']
					}
				}
			: {}),
		weights: path.relative(root, weights),
		weightsSha256: sha256(weightsBytes),
		catalog: path.relative(root, catalogPath),
		catalogSha256: sha256(catalogBytes),
		...(inference ? { inference } : {}),
		seed0,
		games,
		maxRounds: effectiveMaxRounds,
		...(effectiveMaxRounds !== maxRounds ? { requestedMaxRounds: maxRounds } : {}),
		maxStatusLevel,
		decode: {
			policyObsVersion,
			...(args['infer-socket'] ? { inferenceSocket: args['infer-socket'] } : {}),
			learnMonsterRewardChoices: args['learn-monster-reward-choices'],
			...(args.sample ? { sample: true, temperature } : { sample: false }),
			...(plannerEnabled
				? {
						...(rerankPolicyWeight !== undefined
							? { rerank: { policyRankWeight: rerankPolicyWeight } }
							: {
									search: {
										sims: searchSims,
										objective: searchObjective,
										horizonRounds: searchHorizon,
										frac: searchFrac,
										valueWeight: searchValueWeight,
										rollout: args['search-rollout'],
										navTemperature: searchNavTemperature
									}
								})
					}
				: {})
		},
		trueWins,
		trueWinRate: trueWins / games,
		trueWinWilson95: interval,
		namedWinRate: namedWins / games,
		stalls,
		stallRate: stalls / games,
		reach15Rate: reach15 / games,
		nearMiss27To29Rate: nearMisses / games,
		vp: {
			mean: mean(vp),
			p10: quantile(sortedVp, 0.1),
			median: quantile(sortedVp, 0.5),
			p90: quantile(sortedVp, 0.9),
			min: sortedVp[0] ?? null,
			max: sortedVp.at(-1) ?? null
		},
		vpBuckets,
		guardianBreakdown,
		first30Round: {
			mean: mean(first30Rounds),
			median: quantile(
				[...first30Rounds].sort((a, b) => a - b),
				0.5
			)
		},
		engine: {
			meanPost15VpPerRound: mean(post15),
			meanFinalAttackDice: mean(dice),
			meanFinalSpirits: mean(spirits),
			meanFinalMaxBarrier: mean(barriers)
		},
		performance: {
			wallSeconds: result.wallMs / 1000,
			gamesPerSecond: result.gamesPerSec,
			workers: result.workers,
			gameWallMsP50: quantile(sortedGameWallMs, 0.5),
			gameWallMsP95: quantile(sortedGameWallMs, 0.95),
			...(plannerEnabled
				? {
						search: {
							mode: plannerMode,
							decisions: searchDecisions,
							simulations: searchSimulations,
							byPhase: searchByPhase,
							decisionWallMsP50: quantile(sortedSearchDecisionWallMs, 0.5),
							decisionWallMsP95: quantile(sortedSearchDecisionWallMs, 0.95)
						}
					}
				: {})
		},
		...(args['include-games'] ? { perGame } : {}),
		...(replayHashes ? { replayHashes } : {})
	};

	const json = JSON.stringify(report, null, 2);
	if (args.out) {
		const out = path.resolve(args.out);
		mkdirSync(path.dirname(out), { recursive: true });
		const descriptor = openSync(out, 'wx', 0o600);
		try {
			writeSync(descriptor, `${json}\n`);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	}
	if (!args.quiet) console.log(json);
} finally {
	rmSync(workDir, { recursive: true, force: true });
}
