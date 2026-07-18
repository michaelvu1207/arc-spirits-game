#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);
const experiment = 'ml/experiments/v32-onpolicy-solo';
const predecessorPath = `${experiment}/artifacts/critic-lock.json`;
const outputPath = `${experiment}/artifacts/critic-telemetry-repair-lock.json`;
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const predecessor = JSON.parse(readFileSync(predecessorPath, 'utf8'));
const allowedChanges = new Set([
	'src/lib/play/ml/driver.ts',
	'src/lib/play/ml/driver.ppo.test.ts'
]);
const failures = [];
for (const [file, expected] of Object.entries(predecessor.files)) {
	if (!existsSync(file)) failures.push(`${file}: missing`);
	else if (sha256(file) !== expected && !allowedChanges.has(file)) failures.push(`${file}: changed`);
}
if (failures.length) {
	throw new Error(`critic repair exceeded the telemetry-only source allowance:\n${failures.slice(0, 20).join('\n')}`);
}
if (existsSync(outputPath)) throw new Error(`refusing to overwrite ${outputPath}`);
const additions = [
	...allowedChanges,
	'ml/audit_v32_validation_replay.py',
	'ml/test_audit_v32_validation_replay.py',
	'scripts/create-v32-critic-repair-lock.mjs',
	'scripts/run-v32-critic-validation-repair.sh',
	`${experiment}/shared-critic/checkpoint.pt`,
	`${experiment}/shared-critic/checkpoint.manifest.json`
];
for (const file of additions) if (!existsSync(file)) throw new Error(`missing repair input ${file}`);
const files = { ...predecessor.files };
for (const file of additions) files[file] = sha256(file);
const payload = {
	schemaVersion: 'arc-v32-input-lock-v1',
	phase: 'critic-telemetry-repair',
	createdAt: new Date().toISOString(),
	predecessor: { path: predecessorPath, sha256: sha256(predecessorPath) },
	changeAllowance: {
		reason: 'v2 fixed-observation shim omitted actor-time outcome-head telemetry',
		files: [...allowedChanges].sort(),
		policyBehaviorMustReplayExactly: true
	},
	files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
};
writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n');
console.log(`${outputPath} ${Object.keys(files).length} files`);
