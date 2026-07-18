#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const mode = process.argv[2];
if (mode !== 'preview' && mode !== 'systems') {
	throw new Error('usage: verify-v34-authorization-chain.mjs preview|systems');
}
const experiment = 'ml/experiments/v34-latency-first-expert-iteration';
const artifacts = `${experiment}/artifacts`;
const protocol = JSON.parse(readFileSync(`${experiment}/protocol.json`, 'utf8'));
const sourceLockPath = `${artifacts}/source-lock.json`;
const preflightPath = `${artifacts}/preflight/result.json`;
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceLock = JSON.parse(readFileSync(sourceLockPath, 'utf8'));
if (
	sourceLock.schemaVersion !== 'arc-v34-source-lock-v1' ||
	sourceLock.authorization.previewCalibrationSeedsOpen !== true ||
	sourceLock.authorization.systemsSeedsOpen !== false
) {
	throw new Error('V34 source lock authorization changed');
}
for (const [file, expected] of Object.entries(sourceLock.files ?? {})) {
	if (!existsSync(file) || sha256(file) !== expected)
		throw new Error(`V34 source mismatch: ${file}`);
}
const sourceLockSha256 = sha256(sourceLockPath);
const preflight = JSON.parse(readFileSync(preflightPath, 'utf8'));
if (
	preflight.schemaVersion !== 'arc-v34-preflight-evidence-v1' ||
	preflight.passed !== true ||
	preflight.sourceLock?.sha256 !== sourceLockSha256 ||
	preflight.sourceLock?.implementationCommit !== sourceLock.implementationCommit
) {
	throw new Error('V34 preflight is not bound to the current source lock');
}
const expectedChecks = [
	'vitest',
	'python',
	'typecheck',
	'protocol',
	'shellSyntax',
	'determinization'
].sort();
if (JSON.stringify(Object.keys(preflight.checks ?? {}).sort()) !== JSON.stringify(expectedChecks)) {
	throw new Error('V34 preflight check set changed');
}
for (const [name, check] of Object.entries(preflight.checks)) {
	if (check.exitCode !== 0 || !existsSync(check.log) || sha256(check.log) !== check.logSha256) {
		throw new Error(`V34 preflight evidence invalid: ${name}`);
	}
}
if (mode === 'preview') {
	console.log(
		JSON.stringify({ schemaVersion: 'arc-v34-authorization-verification-v1', mode, valid: true })
	);
	process.exit(0);
}

const collectionPath = `${artifacts}/preview-calibration-collection.json`;
const calibrationPath = `${artifacts}/preview-calibration.json`;
const authorizationPath = `${artifacts}/systems-authorization.json`;
const collection = JSON.parse(readFileSync(collectionPath, 'utf8'));
const calibration = JSON.parse(readFileSync(calibrationPath, 'utf8'));
const authorization = JSON.parse(readFileSync(authorizationPath, 'utf8'));
if (
	collection.schemaVersion !== 'arc-v34-preview-collection-v1' ||
	collection.seed0 !== protocol.previewCalibration.seed0 ||
	collection.games !== protocol.previewCalibration.games ||
	collection.completed !== protocol.previewCalibration.games ||
	!Number.isInteger(collection.stalls) ||
	collection.stalls < 0 ||
	collection.stalls > collection.games ||
	collection.checkpoint?.sha256 !== protocol.inputs.policy.sha256 ||
	collection.catalog?.sha256 !== protocol.inputs.catalog.sha256 ||
	collection.inference?.wire !== protocol.commonDecode.inferenceWire
) {
	throw new Error('V34 preview collection contract mismatch');
}
if (
	calibration.schemaVersion !== 'arc-v34-preview-calibration-v1' ||
	calibration.seed0 !== protocol.previewCalibration.seed0 ||
	calibration.games !== protocol.previewCalibration.games ||
	calibration.uniqueSeeds !== protocol.previewCalibration.games ||
	calibration.candidateCount !== calibration.finiteCandidateCount ||
	calibration.terminalOverrides?.mismatches !== 0
) {
	throw new Error('V34 preview calibration contract mismatch');
}
const collectedInputs = Object.fromEntries(
	collection.previewInputs.map((input) => [input.name, input.sha256])
);
if (
	calibration.inputs.length !== collection.previewInputs.length ||
	calibration.inputs.some((input) => collectedInputs[input.name] !== input.sha256)
) {
	throw new Error('V34 preview calibration input hash chain mismatch');
}
const criticCalibrationPassed = calibration.passed === true && collection.stalls === 0;
const expectedEnabled = ['rerank-p100', 'heuristic-s4-h2', 'heuristic-s8-h3'];
if (criticCalibrationPassed) {
	expectedEnabled.unshift('rerank-p025', 'rerank-p050', 'rerank-p075');
}
const expectedDisabled = criticCalibrationPassed
	? []
	: ['rerank-p025', 'rerank-p050', 'rerank-p075'];
if (
	authorization.schemaVersion !== 'arc-v34-systems-authorization-v1' ||
	authorization.strengthUse !== false ||
	authorization.sourceLock?.sha256 !== sourceLockSha256 ||
	authorization.preflight?.sha256 !== sha256(preflightPath) ||
	authorization.previewCollection?.sha256 !== sha256(collectionPath) ||
	authorization.previewCalibration?.sha256 !== sha256(calibrationPath) ||
	authorization.criticCalibrationPassed !== criticCalibrationPassed ||
	JSON.stringify(authorization.enabledCandidateArms) !== JSON.stringify(expectedEnabled) ||
	JSON.stringify(Object.keys(authorization.disabledCandidateArms ?? {}).sort()) !==
		JSON.stringify(expectedDisabled)
) {
	throw new Error('V34 systems authorization hash chain or arm set mismatch');
}
const expectedAuthorization = {
	systemsSeedsOpen: true,
	phase2SeedsOpen: false,
	guardianSeedsOpen: false,
	teacherSeedsOpen: false,
	finalDevelopmentSeedsOpen: false,
	hiddenSeedsOpen: false,
	multiplayerSeedsOpen: false,
	humanReferenceSeedsOpen: false,
	productionPromotionOpen: false
};
if (JSON.stringify(authorization.authorization) !== JSON.stringify(expectedAuthorization)) {
	throw new Error('V34 systems seed authorization changed');
}
console.log(
	JSON.stringify({ schemaVersion: 'arc-v34-authorization-verification-v1', mode, valid: true })
);
