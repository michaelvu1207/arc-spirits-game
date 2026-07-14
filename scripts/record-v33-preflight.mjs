#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [out, vitestLog, pythonLog, checkLog, protocolLog, shellLog, ...rawCodes] =
	process.argv.slice(2);
if (!out || rawCodes.length !== 5) {
	throw new Error('record-v33-preflight requires OUT and five logs plus five exit codes');
}
const labels = ['vitest', 'python', 'typecheck', 'protocol', 'shellSyntax'];
const logs = [vitestLog, pythonLog, checkLog, protocolLog, shellLog];
const codes = rawCodes.map((value) => Number.parseInt(value, 10));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const checks = Object.fromEntries(
	labels.map((label, index) => [
		label,
		{ exitCode: codes[index], log: path.resolve(logs[index]), logSha256: sha256(logs[index]) }
	])
);
const report = {
	schemaVersion: 'arc-v33-preflight-evidence-v1',
	strengthUse: false,
	evidence: {
		informationSafety: 'actions.informationSafety.test.ts',
		replay: '_gumbelPlanner.test.ts fixed-state/action/visits and unique invocation ordinal',
		servedProvenance: 'inferenceClient handshake test plus runtime SHA enforcement',
		servingErrors: 'every actor/inference error is fatal before report creation'
	},
	checks,
	passed: codes.every((code) => code === 0),
	recordedAt: new Date().toISOString()
};
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
