#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [out, sourceLockPath, ...rest] = process.argv.slice(2);
const labels = ['vitest', 'python', 'typecheck', 'protocol', 'shellSyntax', 'determinization'];
if (!out || !sourceLockPath || rest.length !== labels.length * 2) {
	throw new Error('record-v34-preflight requires OUT, SOURCE_LOCK, six logs, and six exit codes');
}
const logs = rest.slice(0, labels.length);
const codes = rest.slice(labels.length).map((value) => Number.parseInt(value, 10));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceLock = JSON.parse(readFileSync(sourceLockPath, 'utf8'));
if (sourceLock.schemaVersion !== 'arc-v34-source-lock-v1') {
	throw new Error('record-v34-preflight source lock invalid');
}
const checks = Object.fromEntries(
	labels.map((label, index) => [
		label,
		{ exitCode: codes[index], log: path.resolve(logs[index]), logSha256: sha256(logs[index]) }
	])
);
const report = {
	schemaVersion: 'arc-v34-preflight-evidence-v1',
	strengthUse: false,
	sourceLock: {
		path: path.resolve(sourceLockPath),
		sha256: sha256(sourceLockPath),
		implementationCommit: sourceLock.implementationCommit
	},
	evidence: {
		informationSafety: 'actions.informationSafety.test.ts',
		rerankerReplayAndHiddenInvariance: '_gumbelPlanner.test.ts',
		batchedHeuristic: '_heuristicRolloutPlanner.test.ts',
		binaryBatchEquivalenceAndShape: 'inferenceClient.test.ts',
		actorIntegration: '_actorpool.test.ts',
		determinization: 'check-v34-determinization.mjs'
	},
	checks,
	passed: codes.every((code) => code === 0),
	recordedAt: new Date().toISOString()
};
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
