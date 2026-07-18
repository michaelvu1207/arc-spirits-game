#!/usr/bin/env node
/** Collect minimal public-preview critic rows without changing raw-policy behavior. */
import { createHash } from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createJiti } from 'jiti';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
	options: {
		weights: { type: 'string' },
		catalog: { type: 'string' },
		'infer-socket': { type: 'string' },
		seed0: { type: 'string' },
		games: { type: 'string' },
		workers: { type: 'string', default: '24' },
		'data-dir': { type: 'string' },
		progress: { type: 'string' },
		out: { type: 'string' }
	}
});
for (const required of [
	'weights',
	'catalog',
	'infer-socket',
	'seed0',
	'games',
	'data-dir',
	'out'
]) {
	if (!args[required]) throw new Error(`--${required} is required`);
}
const integer = (value, name) => {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be positive`);
	return parsed;
};
const seed0 = integer(args.seed0, '--seed0');
const games = integer(args.games, '--games');
const workers = integer(args.workers, '--workers');
const weights = path.resolve(args.weights);
const catalog = path.resolve(args.catalog);
const dataDir = path.resolve(args['data-dir']);
const out = path.resolve(args.out);
const progress = args.progress ? path.resolve(args.progress) : undefined;
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
if (existsSync(dataDir) && readdirSync(dataDir).length > 0) {
	throw new Error(`--data-dir must be absent or empty: ${dataDir}`);
}
mkdirSync(dataDir, { recursive: true });
mkdirSync(path.dirname(out), { recursive: true });
if (existsSync(out)) throw new Error(`--out already exists: ${out}`);
if (progress) {
	mkdirSync(path.dirname(progress), { recursive: true });
	writeFileSync(progress, '', { flag: 'wx' });
}
const emit = (event) => {
	if (progress) appendFileSync(progress, `${JSON.stringify(event)}\n`);
};
emit({
	schemaVersion: 'arc-v34-preview-progress-v1',
	event: 'start',
	at: new Date().toISOString(),
	seed0,
	games,
	workers
});
const jiti = createJiti(import.meta.url, { alias: { $lib: path.join(root, 'src', 'lib') } });
const { runActorPool } = await jiti.import(
	path.join(root, 'src', 'lib', 'play', 'ml', 'actorPool.ts')
);
let completed = 0;
const result = await runActorPool({
	seeds: Array.from({ length: games }, (_, index) => seed0 + index),
	outDir: dataDir,
	workers,
	catalogPath: catalog,
	config: {
		seats: 1,
		maxRounds: 30,
		maxStatusLevel: 2,
		profiles: ['medium'],
		weightsPath: weights,
		inferSocket: args['infer-socket'],
		selection: 'hybrid',
		sample: true,
		temperature: 0.55,
		recordSeats: [],
		writeGameSummaries: false,
		guardianSchedule: 'absolute-balanced',
		obsVersion: 1,
		policyObsVersion: 2,
		previewReach30Audit: true
	},
	onGame: (summary) => {
		completed += 1;
		emit({
			schemaVersion: 'arc-v34-preview-progress-v1',
			event: 'game-complete',
			at: new Date().toISOString(),
			seed: summary.seed,
			completed,
			games,
			wallMs: summary.wallMs,
			inference: summary.inference ?? null
		});
	}
});
if (result.games !== games || completed !== games) throw new Error('preview collection incomplete');
const inference = result.summaries[0]?.inference;
if (!inference) throw new Error('preview collection has no inference provenance');
if (inference.weightsSha256 !== sha256(weights) || inference.wire !== 'binary') {
	throw new Error('preview collection served checkpoint or wire mismatch');
}
if (
	result.summaries.some(
		(summary) => JSON.stringify(summary.inference) !== JSON.stringify(inference)
	)
) {
	throw new Error('preview collection inference provenance changed within the run');
}
if (result.previewAuditFiles.length === 0)
	throw new Error('preview collection emitted no audit rows');
const previewInputs = result.previewAuditFiles.map((file) => ({
	name: path.basename(file),
	sha256: sha256(file),
	rows: readFileSync(file, 'utf8').split('\n').filter(Boolean).length
}));
const report = {
	schemaVersion: 'arc-v34-preview-collection-v1',
	strengthUse: false,
	seed0,
	games,
	seedMax: seed0 + games - 1,
	completed,
	workers: result.workers,
	wallSeconds: result.wallMs / 1000,
	stalls: result.summaries.filter((summary) => summary.stalled).length,
	checkpoint: { path: weights, sha256: sha256(weights) },
	catalog: { path: catalog, sha256: sha256(catalog) },
	inference,
	previewInputs
};
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
emit({
	schemaVersion: 'arc-v34-preview-progress-v1',
	event: 'complete',
	at: new Date().toISOString(),
	completed,
	games,
	wallSeconds: result.wallMs / 1000
});
console.log(JSON.stringify(report, null, 2));
