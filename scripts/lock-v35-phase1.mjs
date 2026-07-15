#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);
const [command, argument] = process.argv.slice(2);
const experiment = 'ml/experiments/v35-weco-recursive-autoresearch';
const lockPath = `${experiment}/artifacts/phase1-source-lock.json`;

const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const walk = (target) => {
	if (!existsSync(target)) throw new Error(`missing lock input ${target}`);
	if (!lstatSync(target).isDirectory()) return [target];
	return readdirSync(target, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name))
		.flatMap((entry) => walk(path.join(target, entry.name)));
};
const relativeFiles = (targets) =>
	[...new Set(targets.flatMap(walk).map((file) => path.relative(repo, path.resolve(file))))]
		.filter(
			(file) =>
				!file.includes('/__pycache__/') &&
				!file.endsWith('.pyc') &&
				!file.includes('/data/') &&
				!file.includes('/checkpoints/') &&
				!file.endsWith('/state.json') &&
				!file.endsWith('/history.jsonl') &&
				!file.endsWith('/orchestrator.log')
		)
		.sort();

if (command === 'create') {
	if (!argument || !/^[0-9a-f]{40}$/.test(argument)) {
		throw new Error('usage: lock-v35-phase1.mjs create IMPLEMENTATION_COMMIT');
	}
	if (existsSync(lockPath)) throw new Error(`refusing to overwrite ${lockPath}`);
	const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	if (head !== argument) throw new Error(`implementation commit ${argument} is not HEAD ${head}`);
	const protocol = JSON.parse(readFileSync(`${experiment}/phase1-protocol.json`, 'utf8'));
	const review = readFileSync(`${experiment}/phase1-training-fable-review.md`, 'utf8');
	const seedInventory = JSON.parse(
		readFileSync(`${experiment}/artifacts/phase1-seed-inventory.json`, 'utf8')
	);
	if (protocol.status !== 'smoke-frozen') throw new Error('protocol is not smoke-frozen');
	if (protocol.review.verdict !== 'PASS' || !/Verdict: \*\*PASS\*\*/.test(review)) {
		throw new Error('Fable PASS is not bound');
	}
	if (seedInventory.valid !== true || seedInventory.collisions.length !== 0) {
		throw new Error('seed inventory did not pass');
	}
	const targets = [
		'package.json',
		'package-lock.json',
		'ml/requirements.txt',
		'ml/catalog.json',
		'ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt',
		'ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.manifest.json',
		`${experiment}/plan.md`,
		`${experiment}/fable-review.md`,
		`${experiment}/phase1-training-plan.md`,
		`${experiment}/phase1-training-fable-review.md`,
		`${experiment}/phase1-protocol.json`,
		`${experiment}/artifacts/phase1-materialized-configs.json`,
		`${experiment}/artifacts/phase1-seed-inventory.json`,
		`${experiment}/league`,
		'ml/league/configs/fair-v35-late-credit-base.json',
		'ml/autoresearch/v35',
		'ml/audit_v32_generation.py',
		'ml/audit_v35_generation.py',
		'ml/inventory_v35_seeds.py',
		'ml/test_v35_autoresearch.py',
		'ml/test_v35_phase1_protocol.py',
		'ml/train.py',
		'ml/ppo.py',
		'ml/model.py',
		'ml/model_v2.py',
		'ml/obs_v2.py',
		'ml/infer_server.py',
		'scripts/run-actor-pool.mjs',
		'scripts/run-league.mjs',
		'scripts/prepare-v35-phase1.mjs',
		'scripts/lock-v35-phase1.mjs',
		'scripts/run-v35-root.sh',
		'scripts/run-v35-phase1-smoke.sh',
		'src/lib/play'
	];
	const files = relativeFiles(targets);
	const payload = {
		schemaVersion: 'arc-v35-phase1-source-lock-v1',
		phase: 'replicate-a-three-arm-generation-1-smoke',
		implementationCommit: argument,
		createdAt: new Date().toISOString(),
		authorizedGpu: 7,
		forbiddenGpus: [4, 5, 6],
		noSemanticRetry: true,
		files: Object.fromEntries(files.map((file) => [file, hash(file)]))
	};
	writeFileSync(lockPath, JSON.stringify(payload, null, 2) + '\n');
	console.log(`${lockPath} ${files.length} files implementation=${argument}`);
} else if (command === 'verify') {
	const requested = argument ?? lockPath;
	const lock = JSON.parse(readFileSync(requested, 'utf8'));
	if (lock.schemaVersion !== 'arc-v35-phase1-source-lock-v1') {
		throw new Error('wrong V35 source-lock schema');
	}
	const failures = [];
	for (const [file, expected] of Object.entries(lock.files)) {
		if (!existsSync(file)) failures.push(`${file}: missing`);
		else if (hash(file) !== expected) failures.push(`${file}: hash mismatch`);
	}
	if (failures.length) {
		throw new Error(`V35 source lock failed:\n${failures.slice(0, 30).join('\n')}`);
	}
	console.log(`V35 source lock valid (${Object.keys(lock.files).length} files)`);
} else {
	throw new Error('usage: lock-v35-phase1.mjs <create IMPLEMENTATION_COMMIT|verify [LOCK]>');
}
