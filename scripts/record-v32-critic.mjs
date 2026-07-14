#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);
const experiment = 'ml/experiments/v32-onpolicy-solo';
const protocolPath = `${experiment}/protocol.json`;
const checkpointPath = `${experiment}/shared-critic/checkpoint.pt`;
const manifestPath = `${experiment}/shared-critic/checkpoint.manifest.json`;
const auditPath = `${experiment}/shared-critic/audit.json`;
const replayAuditPath = `${experiment}/shared-critic/validation-replay-audit.json`;
const protocol = JSON.parse(readFileSync(protocolPath, 'utf8'));
const auditBytes = readFileSync(auditPath);
const audit = JSON.parse(auditBytes);
const replayAuditBytes = readFileSync(replayAuditPath);
const replayAudit = JSON.parse(replayAuditBytes);
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
if (protocol.status !== 'critic-frozen') {
	throw new Error(`protocol status must be critic-frozen, got ${protocol.status}`);
}
if (!audit.valid || audit.validation?.count !== protocol.criticWarmup.validation.games) {
	throw new Error('shared critic did not pass its preregistered validation');
}
if (audit.base?.sha256 !== protocol.initialPolicy.sha256) {
	throw new Error('critic audit used the wrong base policy');
}
if (audit.critic?.sha256 !== sha(checkpointPath)) {
	throw new Error('critic audit checkpoint hash mismatch');
}
if (
	!replayAudit.valid ||
	replayAudit.trajectory?.rows !== 119279 ||
	replayAudit.afterTelemetry?.reach30PredCount !== replayAudit.trajectory.rows
) {
	throw new Error('shared critic validation replay did not pass telemetry/parity gates');
}
protocol.sharedCritic = {
	path: checkpointPath,
	sha256: sha(checkpointPath),
	manifestPath,
	manifestSha256: sha(manifestPath),
	auditPath,
	auditSha256: createHash('sha256').update(auditBytes).digest('hex'),
	replayAuditPath,
	replayAuditSha256: createHash('sha256').update(replayAuditBytes).digest('hex'),
	repairLockPath: `${experiment}/artifacts/critic-telemetry-repair-lock-v2.json`,
	repairLockSha256: sha(`${experiment}/artifacts/critic-telemetry-repair-lock-v2.json`),
	policyLogitMaxAbsDiff: audit.policyLogits.maxAbsDiff,
	round30Auc: audit.behaviorReach30Calibration.auc,
	round30Ece: audit.behaviorReach30Calibration.ece,
	status: 'valid-policy-identical'
};
protocol.screen.sharedTraining.matchupGames = 1024;
protocol.screen.runtime = {
	workersPerRoot: 24,
	matchupConcurrencyPerRoot: 1,
	maxConcurrentRoots: 4,
	maxActorThreads: 96,
	gpuWaveOrder: [5, 6, 7, 0],
	excludedGpu: 4,
	scratch: '/dev/shm/arc-v32-screen'
};
protocol.screen.manipulationAudit = {
	states: 'frozen shared-critic validation seeds 946004096..946005119',
	rowsPerGameBandPerStratum: 2,
	temperature: 0.55,
	treatmentMeanKlMin: 0.005,
	replicatesRequired: 2,
	roundLateEarlyRatioVsControlMin: 1.25,
	p30ResidualChosenLogpCovariance: 'strictly positive',
	firstEndpointGeneration: 8,
	outcomeBlindExtensionGeneration: 12,
	performanceOutcomesMayTriggerExtension: false
};
protocol.implementationCommits = [
	protocol.implementationCommit,
	'ba3c405',
	'd25dc2a',
	'95fa971',
	'0901766',
	'135e961',
	'3379609'
];
protocol.screenFreezePreparationCommit = '3379609';
protocol.status = 'screen-frozen';
writeFileSync(protocolPath, JSON.stringify(protocol, null, 2) + '\n');
console.log(JSON.stringify(protocol.sharedCritic, null, 2));
