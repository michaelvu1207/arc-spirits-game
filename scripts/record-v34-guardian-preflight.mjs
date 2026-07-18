#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { V34_GUARDIAN_TOOLING_FILES } from './v34-guardian-tooling-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const experiment = 'ml/experiments/v34-latency-first-expert-iteration';
const protocolPath = `${experiment}/guardian-execution-protocol.json`;
const labels = [
	'protocol',
	'strengthChain',
	'pythonFixtures',
	'recorderFixtures',
	'assignment',
	'replayDeterminism',
	'vitest',
	'typecheck',
	'nodeSyntax',
	'shellSyntax',
	'resources'
];
const [out, implementationCommit, ...rest] = process.argv.slice(2);
if (
	!out ||
	!/^[0-9a-f]{40}$/.test(implementationCommit ?? '') ||
	rest.length !== labels.length * 2
) {
	throw new Error(
		'record-v34-guardian-preflight requires OUT, IMPLEMENTATION_COMMIT, eleven logs, and eleven exit codes'
	);
}
if (existsSync(out)) throw new Error(`refusing to overwrite immutable guardian preflight ${out}`);
const logs = rest.slice(0, labels.length);
const codes = rest.slice(labels.length).map((value) => Number.parseInt(value, 10));
if (codes.some((value) => !Number.isInteger(value))) throw new Error('invalid preflight exit code');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const relative = (file) => path.relative(root, path.resolve(file));
const record = (file) => ({
	path: relative(file),
	bytes: readFileSync(file).length,
	sha256: sha256(file)
});
for (const file of [...logs, ...V34_GUARDIAN_TOOLING_FILES, protocolPath]) {
	if (!existsSync(file)) throw new Error(`guardian preflight input missing: ${file}`);
}
const protocol = JSON.parse(readFileSync(protocolPath, 'utf8'));
const resources = JSON.parse(readFileSync(logs[labels.indexOf('resources')], 'utf8'));
const assignment = JSON.parse(readFileSync(logs[labels.indexOf('assignment')], 'utf8'));
const replay = JSON.parse(
	readFileSync(`${path.dirname(out)}/replay-determinism-audit.json`, 'utf8')
);
if (
	protocol.schemaVersion !== 'arc-v34-guardian-execution-protocol-v1' ||
	Object.values(protocol.authorization).some((value) => value !== false)
) {
	throw new Error('guardian protocol is not a closed pre-outcome contract');
}
if (resources.schemaVersion !== 'arc-v34-guardian-resource-preflight-v1') {
	throw new Error('guardian resource preflight schema mismatch');
}
if (
	assignment.schemaVersion !== 'arc-v34-guardian-assignment-preflight-v1' ||
	assignment.passed !== true
) {
	throw new Error('guardian assignment preflight mismatch');
}
if (
	replay.schemaVersion !== 'arc-v34-replay-determinism-preflight-v1' ||
	replay.passed !== true ||
	replay.implementationCommit !== implementationCommit
) {
	throw new Error('guardian replay-determinism preflight mismatch');
}
const checks = Object.fromEntries(
	labels.map((label, index) => [
		label,
		{
			exitCode: codes[index],
			log: record(logs[index])
		}
	])
);
const passed = codes.every((code) => code === 0) && resources.passed === true;
const report = {
	schemaVersion: 'arc-v34-guardian-preflight-v1',
	phase: 'tooling',
	implementationCommit,
	guardianProtocol: record(protocolPath),
	toolingFiles: Object.fromEntries(V34_GUARDIAN_TOOLING_FILES.map((file) => [file, sha256(file)])),
	environment: { ...protocol.environment },
	authorization: {
		guardianSeedsOpen: false,
		guardianExecutionOpen: false,
		teacherSeedsOpen: false,
		finalDevelopmentSeedsOpen: false,
		hiddenSeedsOpen: false,
		multiplayerSeedsOpen: false,
		humanReferenceSeedsOpen: false,
		productionPromotionOpen: false
	},
	assignment,
	replayDeterminism: record(`${path.dirname(out)}/replay-determinism-audit.json`),
	resources,
	checks,
	passed,
	recordedAt: new Date().toISOString()
};
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
chmodSync(out, 0o444);
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
