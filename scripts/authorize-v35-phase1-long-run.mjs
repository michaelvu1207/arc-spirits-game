#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);
const experiment = 'ml/experiments/v35-weco-recursive-autoresearch';
const smokePath = `${experiment}/artifacts/phase1-replicate-a-smoke.json`;
const outPath = `${experiment}/artifacts/phase1-long-run-authorization.json`;
const arms = ['control-uniform', 'late-reweighted', 'p30-credit025'];
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const requireCondition = (condition, message) => {
	if (!condition) throw new Error(message);
};

requireCondition(!existsSync(outPath), `refusing to overwrite ${outPath}`);
const smoke = JSON.parse(readFileSync(smokePath, 'utf8'));
requireCondition(smoke.schemaVersion === 'arc-v35-phase1-smoke-v1', 'wrong smoke schema');
requireCondition(
	smoke.valid === true && smoke.promotionEligible === false,
	'smoke disposition changed'
);
requireCondition(smoke.replicate === 'a' && smoke.generation === 1, 'wrong smoke endpoint');
requireCondition(smoke.audits.length === arms.length, 'smoke does not contain all arms');

const verified = [];
for (const arm of arms) {
	const summary = smoke.audits.find((entry) => entry.arm === arm);
	requireCondition(summary, `missing smoke summary for ${arm}`);
	const root = `${experiment}/league/rep-a/${arm}`;
	const auditPath = `${root}/artifacts/gen1-audit.json`;
	const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
	requireCondition(
		audit.valid === true && audit.schemaVersion === 'arc-v35-generation-audit-v1',
		`${arm} audit invalid`
	);
	requireCondition(
		audit.replicate === 'a' && audit.arm === arm && audit.generation === 1,
		`${arm} binding mismatch`
	);
	requireCondition(audit.stalls === 0 && audit.evaluationStalls === 0, `${arm} stalled`);
	requireCondition(
		audit.trainingSeeds.min === 966100000 && audit.trainingSeeds.max === 966101023,
		`${arm} training seeds changed`
	);
	requireCondition(
		audit.evaluationSeeds.min === 966700000 && audit.evaluationSeeds.max === 966700255,
		`${arm} eval seeds changed`
	);
	requireCondition(audit.behaviorLogpMaxAbsError <= 0.001, `${arm} logp reconstruction failed`);
	const calibration = audit.behaviorReach30Calibration;
	requireCondition(calibration.ece <= 0.1, `${arm} ECE failed`);
	requireCondition(calibration.brier <= calibration.constant_brier, `${arm} Brier failed`);
	requireCondition(audit.epochMetrics.length === 2, `${arm} epoch count changed`);
	for (const epoch of audit.epochMetrics) {
		requireCondition(epoch.optimizerSteps === 196, `${arm} optimizer steps changed`);
		requireCondition(epoch.approxKl <= 0.02 && epoch.roundWeightedKl <= 0.02, `${arm} KL failed`);
		requireCondition(epoch.clipFraction <= 0.2, `${arm} ordinary clip failed`);
		requireCondition(epoch.roundWeightedClipFraction <= 0.2, `${arm} weighted clip failed`);
	}
	requireCondition(
		!existsSync(`${root}/artifacts/gen1-audit-failed.txt`),
		`${arm} has failure marker`
	);
	requireCondition(
		audit.checkpointSha256 === summary.checkpointSha256,
		`${arm} checkpoint summary mismatch`
	);
	verified.push({
		arm,
		audit: auditPath,
		auditSha256: sha256(auditPath),
		checkpointSha256: audit.checkpointSha256,
		behaviorLogpMaxAbsError: audit.behaviorLogpMaxAbsError,
		behaviorReach30Calibration: calibration,
		epochMetrics: audit.epochMetrics,
		rawGenerationCommitment: audit.rawGenerationCommitment
	});
}

const output = {
	schemaVersion: 'arc-v35-phase1-long-run-authorization-v1',
	authorized: true,
	authorizedAction: 'run-all-nine-roots-to-generation-8-then-outcome-blind-manipulation-audit',
	performanceOutcomesInspectedForAuthorization: false,
	promotionEligible: false,
	smoke: smokePath,
	smokeSha256: sha256(smokePath),
	verified,
	constraints: {
		gpu: 7,
		forbiddenGpus: [4, 5, 6],
		maxConcurrentRoots: 1,
		generation8OnlyUntilManipulationAudit: true,
		globalGeneration12ExtensionOnly: true,
		semanticRetry: false
	}
};
writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
console.log(outPath);
