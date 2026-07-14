#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);
const [command, phaseOrLock] = process.argv.slice(2);
const experiment = 'ml/experiments/v32-onpolicy-solo';

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
		.filter((file) => !file.includes('/__pycache__/') && !file.endsWith('.pyc'))
		.sort();

if (command === 'create') {
	if (!['critic', 'screen'].includes(phaseOrLock)) throw new Error('usage: lock-v32-inputs.mjs create <critic|screen>');
	const phase = phaseOrLock;
	const protocol = JSON.parse(readFileSync(`${experiment}/protocol.json`, 'utf8'));
	const expectedStatus = phase === 'critic' ? 'critic-frozen' : 'screen-frozen';
	if (protocol.status !== expectedStatus) {
		throw new Error(`protocol status ${protocol.status} != ${expectedStatus}`);
	}
	const common = [
		'package.json',
		'package-lock.json',
		'ml/catalogs/live-20260713-5f4ad348.json',
		'ml/experiments/v30-strategic-tail-fidelity/artifacts/arms/strategic-cvar10-c025/checkpoint.pt',
		'ml/experiments/v30-strategic-tail-fidelity/artifacts/arms/strategic-cvar10-c025/checkpoint.manifest.json',
		`${experiment}/protocol.json`,
		'ml/train.py',
		'ml/ppo.py',
		'ml/model.py',
		'ml/model_v2.py',
		'ml/obs_v2.py',
		'ml/infer_server.py',
		'scripts/run-actor-pool.mjs',
		'scripts/benchmark-actor-workers.mjs',
		'scripts/run-v32-critic.sh',
		'scripts/lock-v32-inputs.mjs',
		'ml/audit_v32_critic.py',
		'src/lib/play/ml',
		'src/lib/game',
		'src/lib/shared'
	];
	const phaseSpecific =
		phase === 'critic'
			? [`${experiment}/artifacts/systems-benchmark.json`]
			: [
					'ml/league/configs/fair-v32-onpolicy-base.json',
					'ml/audit_v32_generation.py',
					'scripts/run-league.mjs',
					'scripts/prepare-v32-onpolicy.mjs',
					'scripts/run-v32-root.sh',
					'scripts/run-v32-screen.sh',
					`${experiment}/shared-critic/checkpoint.pt`,
					`${experiment}/shared-critic/checkpoint.manifest.json`,
					`${experiment}/shared-critic/audit.json`,
					`${experiment}/artifacts/materialized-configs.json`,
					`${experiment}/league`
				];
	let files = relativeFiles([...common, ...phaseSpecific]);
	if (phase === 'screen') {
		files = files.filter(
			(file) =>
				!file.includes('/data/') &&
				!file.includes('/checkpoints/') &&
				!file.endsWith('/state.json') &&
				!file.endsWith('/history.jsonl') &&
				!file.endsWith('/orchestrator.log')
		);
	}
	const lockPath = `${experiment}/artifacts/${phase}-lock.json`;
	if (existsSync(lockPath)) throw new Error(`refusing to overwrite ${lockPath}`);
	const payload = {
		schemaVersion: 'arc-v32-input-lock-v1',
		phase,
		createdAt: new Date().toISOString(),
		files: Object.fromEntries(files.map((file) => [file, hash(file)]))
	};
	writeFileSync(lockPath, JSON.stringify(payload, null, 2) + '\n');
	console.log(`${lockPath} ${files.length} files`);
} else if (command === 'verify') {
	const lockPath = phaseOrLock;
	if (!lockPath) throw new Error('usage: lock-v32-inputs.mjs verify <lock.json>');
	const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
	const failures = [];
	for (const [file, expected] of Object.entries(lock.files)) {
		if (!existsSync(file)) failures.push(`${file}: missing`);
		else if (hash(file) !== expected) failures.push(`${file}: hash mismatch`);
	}
	if (failures.length) throw new Error(`V32 ${lock.phase} lock failed:\n${failures.slice(0, 20).join('\n')}`);
	console.log(`V32 ${lock.phase} lock valid (${Object.keys(lock.files).length} files)`);
} else {
	throw new Error('usage: lock-v32-inputs.mjs <create critic|create screen|verify LOCK>');
}
