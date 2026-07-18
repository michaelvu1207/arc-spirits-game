#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { V34_STRENGTH_TOOLING_FILES } from './v34-strength-tooling-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const experiment = 'ml/experiments/v34-latency-first-expert-iteration';
const artifacts = `${experiment}/artifacts`;
const output = `${artifacts}/strength-tooling-lock.json`;
const sourceLockPath = `${artifacts}/source-lock.json`;
const strengthProtocolPath = `${experiment}/strength-protocol.json`;
const systemsEligibilityPath = `${artifacts}/systems-eligibility.json`;
const phase2AuthorizationPath = `${artifacts}/phase2-authorization.json`;
const strengthPreflightPath = `${artifacts}/strength-preflight/result.json`;
const declaredFiles = V34_STRENGTH_TOOLING_FILES;

const requested = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(requested ?? '')) {
	throw new Error('usage: lock-v34-strength-inputs.mjs EXACT_40_CHARACTER_IMPLEMENTATION_COMMIT');
}
if (existsSync(output)) throw new Error(`${output} already exists`);
for (const file of declaredFiles) {
	if (!existsSync(file)) throw new Error(`missing frozen strength input ${file}`);
}
if (existsSync('.git')) {
	const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	if (requested !== head) throw new Error('strength implementation commit must equal current HEAD');
	const changed = execFileSync('git', ['status', '--short', '--', ...declaredFiles], {
		encoding: 'utf8'
	}).trim();
	if (changed) throw new Error(`V34 strength inputs are not committed:\n${changed}`);
}

execFileSync(process.execPath, ['scripts/verify-v34-strength-chain.mjs', 'preflight'], {
	stdio: 'inherit'
});
const strengthProtocol = JSON.parse(readFileSync(strengthProtocolPath, 'utf8'));
const systemsEligibility = JSON.parse(readFileSync(systemsEligibilityPath, 'utf8'));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const record = (file) => ({ path: file, sha256: sha256(file) });
const lock = {
	schemaVersion: 'arc-v34-strength-tooling-lock-v1',
	implementationCommit: requested,
	baseSourceLock: record(sourceLockPath),
	strengthProtocol: record(strengthProtocolPath),
	systemsEligibility: record(systemsEligibilityPath),
	phase2Authorization: record(phase2AuthorizationPath),
	strengthPreflight: record(strengthPreflightPath),
	files: Object.fromEntries(declaredFiles.map((file) => [file, sha256(file)])),
	environment: {
		python: strengthProtocol.environment.python,
		numpy: strengthProtocol.environment.numpy
	},
	eligibleCandidateArms: systemsEligibility.eligibleCandidateArms,
	authorization: {
		phase2ExecutionOpen: true,
		guardianSeedsOpen: false,
		teacherSeedsOpen: false,
		finalDevelopmentSeedsOpen: false,
		hiddenSeedsOpen: false,
		multiplayerSeedsOpen: false,
		humanReferenceSeedsOpen: false,
		productionPromotionOpen: false
	},
	createdAt: new Date().toISOString()
};

mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
chmodSync(output, 0o444);
console.log(JSON.stringify(lock, null, 2));
