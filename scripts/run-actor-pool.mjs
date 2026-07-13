#!/usr/bin/env node
/**
 * Canonical CLI for the multi-core self-play actor pool (src/lib/play/ml/actorPool.ts).
 *
 *   node scripts/run-actor-pool.mjs --games 64 --workers 8 \
 *     --weights src/lib/play/ml/policy-weights.json --out ml/data/poolrun
 *
 * Omit --weights for heuristic-only (BC/cold-start) generation. Output:
 *   <out>/shard-<i>.jsonl  training samples (appendSamples format)
 *   <out>/games-<i>.jsonl  one summary line per game (league/balance feed)
 *
 * Runs under plain node: actorPool.ts is loaded via jiti (no tsx in this repo).
 */
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
	options: {
		games: { type: 'string', default: '64' },
		workers: { type: 'string' },
		seed0: { type: 'string', default: '1' },
		seats: { type: 'string', default: '4' },
		'max-rounds': { type: 'string', default: '90' },
		weights: { type: 'string' },
		'infer-socket': { type: 'string' },
		out: { type: 'string', default: 'ml/data/poolrun' },
		profiles: { type: 'string', default: 'pvphunter,medium,aggressive,hard' },
		selection: { type: 'string', default: 'hybrid' },
		sample: { type: 'boolean', default: false },
		temperature: { type: 'string' },
		'neural-seats': { type: 'string' },
		'record-seats': { type: 'string' },
		forbid: { type: 'string' },
		'max-status-level': { type: 'string' },
		'shuffle-guardians': { type: 'boolean', default: false },
		gamma: { type: 'string' },
		iter: { type: 'string', default: '0' },
		'obs-version': { type: 'string', default: '1' },
		'policy-obs-version': { type: 'string', default: '1' },
		append: { type: 'boolean', default: false },
		quiet: { type: 'boolean', default: false },
		help: { type: 'boolean', default: false }
	}
});

if (args.help) {
	console.log(
		'usage: node scripts/run-actor-pool.mjs [--games N] [--workers N] [--seed0 N] [--seats N]\n' +
			'         [--max-rounds N] [--weights FILE] [--infer-socket SOCK] [--out DIR] [--profiles a,b,c] \n' +
			'         [--selection hybrid|value|policy] [--sample] [--temperature X]\n' +
			'         [--neural-seats Red,Blue] [--record-seats Red] [--forbid type1,type2]\n' +
			'         [--max-status-level N] [--shuffle-guardians] [--gamma X] [--iter N] [--obs-version 1|2]\n' +
			'         [--policy-obs-version 1|2 (2 needs --infer-socket)] [--append] [--quiet]'
	);
	process.exit(0);
}

const csv = (s) =>
	s
		? s
				.split(',')
				.map((x) => x.trim())
				.filter(Boolean)
		: undefined;
const num = (s) => (s === undefined ? undefined : parseFloat(s));

const games = parseInt(args.games, 10);
const seed0 = parseInt(args.seed0, 10);
const workers = args.workers ? parseInt(args.workers, 10) : Math.max(1, os.cpus().length - 1);

const config = {
	seats: parseInt(args.seats, 10),
	maxRounds: parseInt(args['max-rounds'], 10),
	profiles: csv(args.profiles),
	weightsPath: args.weights ? path.resolve(args.weights) : undefined,
	inferSocket: args['infer-socket'],
	selection: args.selection,
	sample: args.sample || undefined,
	temperature: num(args.temperature),
	neuralSeats: csv(args['neural-seats']),
	recordSeats: csv(args['record-seats']),
	forbidTypes: csv(args.forbid),
	maxStatusLevel: args['max-status-level'] ? parseInt(args['max-status-level'], 10) : undefined,
	shuffleGuardians: args['shuffle-guardians'] || undefined,
	gamma: num(args.gamma),
	iter: parseInt(args.iter, 10),
	obsVersion: parseInt(args['obs-version'], 10),
	policyObsVersion: parseInt(args['policy-obs-version'], 10)
};
if (config.obsVersion !== 1 && config.obsVersion !== 2) {
	console.error(`--obs-version must be 1 or 2, got ${args['obs-version']}`);
	process.exit(1);
}
if (config.policyObsVersion !== 1 && config.policyObsVersion !== 2) {
	console.error(`--policy-obs-version must be 1 or 2, got ${args['policy-obs-version']}`);
	process.exit(1);
}
if (config.policyObsVersion === 2 && !config.inferSocket) {
	console.error(
		'--policy-obs-version 2 requires --infer-socket (the in-process TS net is v1-only)'
	);
	process.exit(1);
}

const jiti = createJiti(import.meta.url, { alias: { $lib: path.join(root, 'src', 'lib') } });
const { runActorPool } = await jiti.import(
	path.join(root, 'src', 'lib', 'play', 'ml', 'actorPool.ts')
);

const seeds = Array.from({ length: games }, (_, i) => seed0 + i);
const logEvery = Math.max(1, Math.floor(games / 10));
let played = 0;
const t0 = Date.now();

console.log(
	`[pool] ${games} games x ${config.seats} seats, ${workers} workers, ` +
		`${config.inferSocket ? `infer-socket=${config.inferSocket}` : config.weightsPath ? `weights=${args.weights}` : `heuristic profiles=${args.profiles}`}`
);
const res = await runActorPool({
	seeds,
	outDir: path.resolve(args.out),
	workers,
	config,
	catalogPath: path.join(root, 'ml', 'catalog.json'),
	append: args.append,
	onGame: args.quiet
		? undefined
		: (s) => {
				played += 1;
				if (played % logEvery === 0 || played === games) {
					const rate = played / ((Date.now() - t0) / 1000);
					console.log(`[pool] ${played}/${games} games (${rate.toFixed(1)}/s live)`);
				}
			}
});

console.log(
	`[pool] DONE games=${res.games} samples=${res.samples} workers=${res.workers} ` +
		`wall=${(res.wallMs / 1000).toFixed(1)}s rate=${res.gamesPerSec.toFixed(1)} games/s`
);
console.log(
	`[pool] shards: ${res.shardFiles.length} files, summaries: ${res.gameFiles.length} files in ${path.resolve(args.out)}`
);
if (res.games !== games) {
	console.error(`[pool] WARNING: expected ${games} games, got ${res.games}`);
	process.exit(1);
}
