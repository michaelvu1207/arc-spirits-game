#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const experiment = 'ml/experiments/v34-latency-first-expert-iteration';
const artifacts = `${experiment}/artifacts`;
const protocol = JSON.parse(readFileSync(`${experiment}/protocol.json`, 'utf8'));
const sourceLockPath = `${artifacts}/source-lock.json`;
const preflightPath = `${artifacts}/preflight/result.json`;
const collectionPath = `${artifacts}/preview-calibration-collection.json`;
const calibrationPath = `${artifacts}/preview-calibration.json`;
const sourceLock = JSON.parse(readFileSync(sourceLockPath, 'utf8'));
const preflight = JSON.parse(readFileSync(preflightPath, 'utf8'));
const collection = JSON.parse(readFileSync(collectionPath, 'utf8'));
const calibration = JSON.parse(readFileSync(calibrationPath, 'utf8'));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
if (
	sourceLock.schemaVersion !== 'arc-v34-source-lock-v1' ||
	sourceLock.authorization.previewCalibrationSeedsOpen !== true ||
	sourceLock.authorization.systemsSeedsOpen !== false
) {
	throw new Error('V34 source lock does not authorize only preview calibration');
}
for (const [file, expected] of Object.entries(sourceLock.files)) {
	if (!existsSync(file) || sha256(file) !== expected)
		throw new Error(`V34 source mismatch: ${file}`);
}
if (preflight.schemaVersion !== 'arc-v34-preflight-evidence-v1' || !preflight.passed) {
	throw new Error('V34 preflight missing or failed');
}
if (
	collection.schemaVersion !== 'arc-v34-preview-collection-v1' ||
	collection.seed0 !== protocol.previewCalibration.seed0 ||
	collection.games !== protocol.previewCalibration.games ||
	collection.completed !== protocol.previewCalibration.games ||
	collection.checkpoint.sha256 !== protocol.inputs.policy.sha256 ||
	collection.catalog.sha256 !== protocol.inputs.catalog.sha256 ||
	collection.inference.wire !== protocol.commonDecode.inferenceWire
) {
	throw new Error('V34 preview collection contract mismatch');
}
if (
	calibration.schemaVersion !== 'arc-v34-preview-calibration-v1' ||
	calibration.seed0 !== protocol.previewCalibration.seed0 ||
	calibration.games !== protocol.previewCalibration.games ||
	calibration.uniqueSeeds !== protocol.previewCalibration.games ||
	calibration.candidateCount !== calibration.finiteCandidateCount ||
	calibration.terminalOverrides.mismatches !== 0
) {
	throw new Error('V34 preview calibration contract mismatch');
}
const collectedInputs = Object.fromEntries(
	collection.previewInputs.map((input) => [input.name, input.sha256])
);
for (const input of calibration.inputs) {
	if (collectedInputs[input.name] !== input.sha256) {
		throw new Error(`V34 preview input hash mismatch for ${input.name}`);
	}
}
const criticCalibrationPassed = calibration.passed === true && collection.stalls === 0;
const enabledCandidateArms = ['rerank-p100', 'heuristic-s4-h2', 'heuristic-s8-h3'];
if (criticCalibrationPassed) {
	enabledCandidateArms.unshift('rerank-p025', 'rerank-p050', 'rerank-p075');
}
const disabledCandidateArms = {};
if (!criticCalibrationPassed) {
	for (const id of ['rerank-p025', 'rerank-p050', 'rerank-p075']) {
		disabledCandidateArms[id] =
			collection.stalls > 0
				? 'preview calibration games stalled'
				: 'preview critic failed preregistered AUC/ECE/Brier gate';
	}
}
const out = `${artifacts}/systems-authorization.json`;
const report = {
	schemaVersion: 'arc-v34-systems-authorization-v1',
	strengthUse: false,
	sourceLock: { path: sourceLockPath, sha256: sha256(sourceLockPath) },
	preflight: { path: preflightPath, sha256: sha256(preflightPath) },
	previewCollection: { path: collectionPath, sha256: sha256(collectionPath) },
	previewCalibration: { path: calibrationPath, sha256: sha256(calibrationPath) },
	criticCalibrationPassed,
	enabledCandidateArms,
	disabledCandidateArms,
	authorization: {
		systemsSeedsOpen: true,
		phase2SeedsOpen: false,
		guardianSeedsOpen: false,
		teacherSeedsOpen: false,
		finalDevelopmentSeedsOpen: false,
		hiddenSeedsOpen: false,
		multiplayerSeedsOpen: false,
		humanReferenceSeedsOpen: false,
		productionPromotionOpen: false
	},
	recordedAt: new Date().toISOString()
};
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
chmodSync(out, 0o444);
for (const file of [collectionPath, calibrationPath]) chmodSync(file, 0o444);
console.log(JSON.stringify(report, null, 2));
