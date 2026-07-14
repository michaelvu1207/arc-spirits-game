#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const lockPath =
	process.argv[2] ?? 'ml/experiments/v34-latency-first-expert-iteration/artifacts/source-lock.json';
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
if (lock.schemaVersion !== 'arc-v34-source-lock-v1')
	throw new Error('V34 source lock schema mismatch');
if (!/^[0-9a-f]{40}$/.test(lock.implementationCommit ?? '')) {
	throw new Error('V34 source lock implementation commit invalid');
}
if (existsSync('.git')) {
	execFileSync('git', ['merge-base', '--is-ancestor', lock.implementationCommit, 'HEAD']);
}
for (const [file, expected] of Object.entries(lock.files ?? {})) {
	if (!existsSync(file)) throw new Error(`V34 source file missing: ${file}`);
	const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
	if (actual !== expected) throw new Error(`V34 source hash mismatch: ${file}`);
}
console.log(
	JSON.stringify({
		schemaVersion: 'arc-v34-source-verification-v1',
		valid: true,
		implementationCommit: lock.implementationCommit,
		files: Object.keys(lock.files).length
	})
);
