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
const protocol = JSON.parse(readFileSync(protocolPath, 'utf8'));
const auditBytes = readFileSync(auditPath);
const audit = JSON.parse(auditBytes);
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
protocol.sharedCritic = {
	path: checkpointPath,
	sha256: sha(checkpointPath),
	manifestPath,
	manifestSha256: sha(manifestPath),
	auditPath,
	auditSha256: createHash('sha256').update(auditBytes).digest('hex'),
	policyLogitMaxAbsDiff: audit.policyLogits.maxAbsDiff,
	round30Auc: audit.behaviorReach30Calibration.auc,
	round30Ece: audit.behaviorReach30Calibration.ece,
	status: 'valid-policy-identical'
};
protocol.status = 'screen-frozen';
writeFileSync(protocolPath, JSON.stringify(protocol, null, 2) + '\n');
console.log(JSON.stringify(protocol.sharedCritic, null, 2));
