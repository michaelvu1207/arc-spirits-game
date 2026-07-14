#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);
const implementationCommit = process.argv[2];
if (!/^[0-9a-f]{7,40}$/.test(implementationCommit ?? '')) {
	throw new Error('usage: record-v32-systems-benchmark.mjs IMPLEMENTATION_COMMIT');
}
const experiment = 'ml/experiments/v32-onpolicy-solo';
const reportPath = `${experiment}/artifacts/systems-benchmark.json`;
const protocolPath = `${experiment}/protocol.json`;
const basePath = 'ml/league/configs/fair-v32-onpolicy-base.json';
const reportBytes = readFileSync(reportPath);
const report = JSON.parse(reportBytes);
const protocol = JSON.parse(readFileSync(protocolPath, 'utf8'));
const base = JSON.parse(readFileSync(basePath, 'utf8'));
if (protocol.status !== 'implementation-preflight') {
	throw new Error(`protocol status must be implementation-preflight, got ${protocol.status}`);
}
if (
	report.seed0 !== protocol.systemsBenchmark.seed0 ||
	report.gamesPerTrial !== protocol.systemsBenchmark.gamesPerTrial ||
	report.repeats !== protocol.systemsBenchmark.repeats
) {
	throw new Error('benchmark report does not match the preregistered design');
}
const requested = JSON.stringify(protocol.systemsBenchmark.workerCounts);
const observed = JSON.stringify(report.rows.map((row) => row.workers));
if (requested !== observed) throw new Error(`worker counts differ: ${requested} != ${observed}`);
if (report.catalogPath !== path.resolve(protocol.catalog.path)) {
	throw new Error('benchmark used the wrong catalog');
}
if (
	report.config?.seats !== 1 ||
	report.config?.maxRounds !== 30 ||
	report.config?.maxStatusLevel !== 2 ||
	report.config?.temperature !== 0.55 ||
	report.config?.guardianSchedule !== 'absolute-balanced' ||
	report.config?.policyObsVersion !== 2
) {
	throw new Error('benchmark runtime shape does not match V32');
}
const peak = Math.max(...report.rows.map((row) => row.validPolicyRowsPerSecondP50));
const eligible = report.rows
	.filter((row) => row.validPolicyRowsPerSecondP50 >= 0.95 * peak)
	.map((row) => row.workers);
const selectedWorkers = Math.min(...eligible);
protocol.implementationCommit = implementationCommit;
protocol.systemsBenchmark.result = {
	report: reportPath,
	reportSha256: createHash('sha256').update(reportBytes).digest('hex'),
	peakMedianValidPolicyRowsPerSecond: peak,
	eligibleWorkersWithinFivePercent: eligible,
	selectedWorkers,
	selectedMatchupConcurrency: 1,
	recordedAt: new Date().toISOString()
};
protocol.status = 'critic-frozen';
base.workers = selectedWorkers;
base.matchupConcurrency = 1;
writeFileSync(protocolPath, JSON.stringify(protocol, null, 2) + '\n');
writeFileSync(basePath, JSON.stringify(base, null, 2) + '\n');
console.log(JSON.stringify(protocol.systemsBenchmark.result, null, 2));
