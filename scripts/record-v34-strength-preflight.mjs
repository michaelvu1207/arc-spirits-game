#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { V34_STRENGTH_TOOLING_FILES } from './v34-strength-tooling-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const labels = [
	'sourceLock',
	'evidenceChain',
	'strengthProtocol',
	'pythonFixtures',
	'recorderFixtures',
	'replayDeterminism',
	'vitest',
	'typecheck',
	'nodeSyntax',
	'shellSyntax',
	'determinization',
	'resources'
];
const [out, implementationCommit, ...rest] = process.argv.slice(2);
if (
	!out ||
	!/^[0-9a-f]{40}$/.test(implementationCommit ?? '') ||
	rest.length !== labels.length * 2
) {
	throw new Error(
		'record-v34-strength-preflight requires OUT, IMPLEMENTATION_COMMIT, twelve logs, and twelve exit codes'
	);
}
if (existsSync(out)) throw new Error(`refusing to overwrite immutable V34 preflight ${out}`);

const logs = rest.slice(0, labels.length);
const codes = rest.slice(labels.length).map((value) => Number.parseInt(value, 10));
if (codes.some((value) => !Number.isInteger(value))) throw new Error('invalid preflight exit code');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
for (const file of [...logs, ...V34_STRENGTH_TOOLING_FILES]) {
	if (!existsSync(file)) throw new Error(`V34 strength preflight input missing: ${file}`);
}

const experiment = 'ml/experiments/v34-latency-first-expert-iteration';
const artifacts = `${experiment}/artifacts`;
const relative = (file) => path.relative(root, path.resolve(file));
const record = (file) => ({ path: relative(file), sha256: sha256(file) });
const resources = JSON.parse(readFileSync(logs[labels.indexOf('resources')], 'utf8'));
if (resources.schemaVersion !== 'arc-v34-strength-resource-preflight-v1') {
	throw new Error('V34 strength resource preflight schema mismatch');
}
const environment = JSON.parse(
	readFileSync(logs[labels.indexOf('strengthProtocol')], 'utf8').trim().split('\n').at(-1)
);
if (
	environment.schemaVersion !== 'arc-v34-strength-protocol-validation-v1' ||
	environment.valid !== true
) {
	throw new Error('V34 strength protocol validation log malformed');
}
const report = {
	schemaVersion: 'arc-v34-strength-preflight-evidence-v1',
	implementationCommit,
	baseSourceLock: record(`${artifacts}/source-lock.json`),
	strengthProtocol: record(`${experiment}/strength-protocol.json`),
	systemsEligibility: record(`${artifacts}/systems-eligibility.json`),
	phase2Authorization: record(`${artifacts}/phase2-authorization.json`),
	toolingFiles: Object.fromEntries(V34_STRENGTH_TOOLING_FILES.map((file) => [file, sha256(file)])),
	environment: environment.environment,
	resources,
	checks: Object.fromEntries(
		labels.map((label, index) => [
			label,
			{
				exitCode: codes[index],
				log: relative(logs[index]),
				logSha256: sha256(logs[index])
			}
		])
	),
	passed: codes.every((code) => code === 0) && resources.passed === true,
	recordedAt: new Date().toISOString()
};
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
chmodSync(out, 0o444);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
