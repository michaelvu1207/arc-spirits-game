#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const experiment = 'ml/experiments/v33-strategic-search';
const protocol = JSON.parse(readFileSync(`${experiment}/protocol.json`, 'utf8'));
const sourceLockPath = `${experiment}/artifacts/source-lock.json`;
const sourceLock = JSON.parse(readFileSync(sourceLockPath, 'utf8'));
const preflightPath = `${experiment}/artifacts/preflight/result.json`;
const preflight = JSON.parse(readFileSync(preflightPath, 'utf8'));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const fail = (message) => {
	throw new Error(`V33 systems recorder: ${message}`);
};

if (sourceLock.schemaVersion !== 'arc-v33-source-lock-v1') fail('source lock schema mismatch');
for (const [file, expected] of Object.entries(sourceLock.files)) {
	if (!existsSync(file) || sha256(file) !== expected) fail(`source lock mismatch: ${file}`);
}
if (sourceLock.authorization.systemsSeedsOpen !== true) fail('systems seeds not authorized');
if (sourceLock.authorization.phase2SeedsOpen !== false) fail('phase2 was already open');
if (preflight.schemaVersion !== 'arc-v33-preflight-evidence-v1' || preflight.passed !== true) {
	fail('preflight evidence missing or failed');
}

const determinizationPath = `${experiment}/artifacts/determinization-audit.json`;
const determinization = JSON.parse(readFileSync(determinizationPath, 'utf8'));
if (
	determinization.schemaVersion !== 'arc-v33-determinization-audit-v1' ||
	determinization.passed !== true ||
	determinization.seed0 !== protocol.determinizationAudit.seed0 ||
	determinization.samples !== protocol.determinizationAudit.samples ||
	determinization.confidence?.family !== protocol.determinizationAudit.familyConfidence
) {
	fail('determinization audit mismatch or failure');
}

const expectedWorkers = JSON.stringify(protocol.systems.workerCounts);
const arms = [];
for (const arm of protocol.systems.arms) {
	const reportPath = `${experiment}/artifacts/systems-${arm.id}.json`;
	const report = JSON.parse(readFileSync(reportPath, 'utf8'));
	if (
		report.seed0 !== protocol.systems.seed0 ||
		report.gamesPerTrial !== protocol.systems.games ||
		report.repeats !== protocol.systems.repeats ||
		report.shuffleSeed !== protocol.systems.shuffleSeed
	) {
		fail(`${arm.id}: seed/trial design mismatch`);
	}
	if (JSON.stringify(report.rows.map((row) => row.workers)) !== expectedWorkers) {
		fail(`${arm.id}: worker sweep mismatch`);
	}
	const config = report.config;
	if (
		config.seats !== protocol.commonDecode.seats ||
		config.maxRounds !== protocol.commonDecode.maxRounds ||
		config.maxStatusLevel !== protocol.commonDecode.maxStatusLevel ||
		config.guardianSchedule !== protocol.commonDecode.guardianSchedule ||
		config.selection !== protocol.commonDecode.selection ||
		config.sample !== true ||
		config.temperature !== protocol.commonDecode.temperature ||
		config.policyObsVersion !== protocol.commonDecode.policyObsVersion ||
		JSON.stringify(config.recordSeats) !== '[]'
	) {
		fail(`${arm.id}: common runtime contract mismatch`);
	}
	if (arm.sims === 0) {
		if (config.search !== undefined) fail('raw arm unexpectedly searched');
	} else if (
		config.search?.sims !== arm.sims ||
		config.search?.horizonRounds !== arm.horizonRounds ||
		config.search?.objective !== protocol.commonDecode.searchLeafObjective ||
		config.search?.rollout !== protocol.commonDecode.searchRollout ||
		config.search?.frac !== protocol.commonDecode.searchFrac ||
		config.search?.valueWeight !== protocol.commonDecode.searchValueWeight ||
		config.search?.navTemperature !== protocol.commonDecode.searchNavigationTemperature
	) {
		fail(`${arm.id}: search contract mismatch`);
	}
	for (const trial of report.trials) {
		if (!(trial.gamesPerSecond > 0) || trial.games !== protocol.systems.games) {
			fail(`${arm.id}: invalid throughput trial`);
		}
		if (
			trial.inference?.weightsSha256 !== protocol.policy.sha256 ||
			trial.inference?.format !== protocol.policy.format ||
			trial.inference?.wire !== protocol.commonDecode.inferenceWire
		) {
			fail(`${arm.id}: served checkpoint/wire provenance mismatch`);
		}
		if (arm.sims > 0) {
			if (
				!(trial.searchDecisions > 0) ||
				trial.searchSimulations !== trial.searchDecisions * arm.sims
			) {
				fail(`${arm.id}: simulation accounting mismatch`);
			}
			if (!(trial.searchDecisionWallMsP95 >= 0)) fail(`${arm.id}: missing decision latency`);
		}
	}
	const peak = Math.max(...report.rows.map((row) => row.gamesPerSecondP50));
	const eligibleWorkers = report.rows
		.filter((row) => row.gamesPerSecondP50 >= 0.95 * peak)
		.map((row) => row.workers);
	const selectedWorkers = Math.min(...eligibleWorkers);
	const selected = report.rows.find((row) => row.workers === selectedWorkers);
	let singleConcurrentSearchDecisionP95Ms = null;
	let eightConcurrentSearchDecisionP95Ms = null;
	let singleLatencyReport = null;
	if (arm.sims > 0) {
		const latencyPath = `${experiment}/artifacts/systems-latency-one-${arm.id}.json`;
		const latency = JSON.parse(readFileSync(latencyPath, 'utf8'));
		if (
			latency.seed0 !== protocol.systems.seed0 ||
			latency.gamesPerTrial !== protocol.systems.singleConcurrencyLatencyGames ||
			latency.repeats !== 1 ||
			JSON.stringify(latency.rows.map((row) => row.workers)) !== '[1]' ||
			JSON.stringify(latency.config.search) !== JSON.stringify(config.search)
		) {
			fail(`${arm.id}: single-concurrency latency report mismatch`);
		}
		const oneTrial = latency.trials[0];
		if (
			oneTrial.inference?.weightsSha256 !== protocol.policy.sha256 ||
			oneTrial.inference?.wire !== protocol.commonDecode.inferenceWire
		) {
			fail(`${arm.id}: single-concurrency served provenance mismatch`);
		}
		if (
			!(oneTrial.searchDecisions > 0) ||
			oneTrial.searchSimulations !== oneTrial.searchDecisions * arm.sims
		) {
			fail(`${arm.id}: single-concurrency simulation accounting mismatch`);
		}
		singleConcurrentSearchDecisionP95Ms = oneTrial.searchDecisionWallMsP95;
		eightConcurrentSearchDecisionP95Ms = report.rows.find(
			(row) => row.workers === 8
		).searchDecisionWallMsP95Median;
		singleLatencyReport = { path: latencyPath, sha256: sha256(latencyPath) };
	}
	const projected4096Seconds = 4096 / selected.gamesPerSecondP50;
	const throughputEligible = projected4096Seconds <= 21600;
	const bindingLatencyPassed =
		arm.sims === 0 ||
		(singleConcurrentSearchDecisionP95Ms <=
			protocol.phase2.gates.singleConcurrentSearchDecisionP95MsMax &&
			eightConcurrentSearchDecisionP95Ms <=
				protocol.phase2.gates.eightConcurrentSearchDecisionP95MsMax);
	const operationallyEligible = throughputEligible && bindingLatencyPassed;
	const rejectionReason = !throughputEligible
		? 'projected 4096-game wall time exceeds 21600s'
		: !bindingLatencyPassed
			? 'binding outcome-blind search-decision latency gate failed'
			: null;
	arms.push({
		id: arm.id,
		sims: arm.sims,
		horizonRounds: arm.horizonRounds,
		report: reportPath,
		reportSha256: sha256(reportPath),
		peakGamesPerSecondP50: peak,
		eligibleWorkersWithinFivePercent: eligibleWorkers,
		selectedWorkers,
		projected4096Seconds,
		searchDecisionWallMsP95Median: selected.searchDecisionWallMsP95Median,
		singleConcurrentSearchDecisionP95Ms,
		eightConcurrentSearchDecisionP95Ms,
		singleLatencyReport,
		throughputEligible,
		bindingLatencyPassed,
		operationallyEligible,
		rejectionReason
	});
}
const eligibleSearchArms = arms
	.filter((arm) => arm.sims > 0 && arm.operationallyEligible)
	.map((arm) => arm.id);
const resultPath = `${experiment}/artifacts/systems-eligibility.json`;
const result = {
	schemaVersion: 'arc-v33-systems-eligibility-v1',
	strengthUse: false,
	outcomesInspected: false,
	sourceLock: { path: sourceLockPath, sha256: sha256(sourceLockPath) },
	determinization: { path: determinizationPath, sha256: sha256(determinizationPath) },
	preflight: { path: preflightPath, sha256: sha256(preflightPath) },
	runtimeEvidence: Object.fromEntries(
		[
			'systems-preflight.txt',
			'systems-infer.log',
			'systems-resources.log',
			'systems-postflight.txt'
		].map((name) => {
			const artifact = `${experiment}/artifacts/${name}`;
			return [name, { path: artifact, sha256: sha256(artifact) }];
		})
	),
	arms,
	eligibleSearchArms,
	phase2MayOpen: eligibleSearchArms.length > 0,
	recordedAt: new Date().toISOString()
};
writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
chmodSync(resultPath, 0o444);
if (!result.phase2MayOpen) {
	console.log(JSON.stringify({ result, authorization: null }, null, 2));
	process.exit(0);
}
const authorizationPath = `${experiment}/artifacts/phase2-authorization.json`;
const authorization = {
	schemaVersion: 'arc-v33-phase2-authorization-v1',
	sourceLock: result.sourceLock,
	systemsEligibility: { path: resultPath, sha256: sha256(resultPath) },
	eligibleSearchArms,
	authorization: {
		phase2SeedsOpen: true,
		phase3DevelopmentSeedsOpen: false,
		hiddenSeedsOpen: false,
		expertIterationSeedsOpen: false,
		productionPromotionOpen: false
	},
	recordedAt: new Date().toISOString()
};
writeFileSync(authorizationPath, JSON.stringify(authorization, null, 2) + '\n', { flag: 'wx' });
for (const file of [determinizationPath, authorizationPath]) chmodSync(file, 0o444);
console.log(JSON.stringify({ result, authorization }, null, 2));
