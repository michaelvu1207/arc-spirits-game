#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
execFileSync(process.execPath, ['scripts/verify-v34-authorization-chain.mjs', 'systems'], {
	stdio: 'ignore'
});
const experiment = 'ml/experiments/v34-latency-first-expert-iteration';
const artifacts = `${experiment}/artifacts`;
const protocol = JSON.parse(readFileSync(`${experiment}/protocol.json`, 'utf8'));
const systemsAuthorizationPath = `${artifacts}/systems-authorization.json`;
const authorization = JSON.parse(readFileSync(systemsAuthorizationPath, 'utf8'));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const protocolSha256 = sha256(`${experiment}/protocol.json`);
if (
	authorization.schemaVersion !== 'arc-v34-systems-authorization-v1' ||
	authorization.authorization.systemsSeedsOpen !== true ||
	authorization.authorization.phase2SeedsOpen !== false
) {
	throw new Error('V34 systems authorization invalid');
}
const enabled = new Set(authorization.enabledCandidateArms);
const stagesRoot = `${artifacts}/systems/stages`;
const loadStage = (arm, stage) => {
	for (const attempt of [1, 2]) {
		const report = `${stagesRoot}/${arm}/${stage}/attempt-${attempt}/stage-report.json`;
		if (existsSync(report)) {
			const parsed = JSON.parse(readFileSync(report, 'utf8'));
			if (
				parsed.schemaVersion !== 'arc-v34-systems-stage-v1' ||
				parsed.arm !== arm ||
				parsed.stage !== stage ||
				parsed.strengthUse !== false ||
				parsed.outcomesLoaded !== false ||
				parsed.inputs?.protocol?.sha256 !== protocolSha256 ||
				sha256(parsed.inputs.protocol.path) !== protocolSha256 ||
				sha256(parsed.inputs.benchmark.path) !== parsed.inputs.benchmark.sha256 ||
				sha256(parsed.inputs.progress.path) !== parsed.inputs.progress.sha256
			) {
				throw new Error(`invalid completed V34 systems stage ${arm}/${stage}`);
			}
			return { path: report, report: parsed };
		}
	}
	return null;
};
const arms = [];
for (const arm of protocol.systems.candidateArms) {
	if (!enabled.has(arm.id)) {
		arms.push({
			id: arm.id,
			enabledBeforeSystems: false,
			operationallyEligible: false,
			rejectionReason: authorization.disabledCandidateArms[arm.id]
		});
		continue;
	}
	const required = ['smoke', 'binding-w1', 'binding-w8'];
	const reports = [];
	let rejectionReason = null;
	for (const stage of required) {
		const loaded = loadStage(arm.id, stage);
		if (!loaded) {
			throw new Error(`missing V34 systems stage before semantic rejection: ${arm.id}/${stage}`);
		}
		reports.push(loaded);
		if (!loaded.report.eligible) {
			rejectionReason = loaded.report.rejectionReason;
			break;
		}
	}
	const throughput = [];
	if (!rejectionReason) {
		for (const workers of protocol.systems.throughput.workerCounts) {
			const loaded = loadStage(arm.id, `throughput-w${workers}`);
			if (!loaded) {
				throw new Error(
					`missing V34 systems stage before semantic rejection: ${arm.id}/throughput-w${workers}`
				);
			}
			reports.push(loaded);
			throughput.push(loaded.report);
			if (!loaded.report.eligible) {
				rejectionReason = loaded.report.rejectionReason;
				break;
			}
		}
	}
	let selectedWorkers = null;
	let peakGamesPerSecond = null;
	let projected4096Seconds = null;
	if (!rejectionReason && throughput.length === protocol.systems.throughput.workerCounts.length) {
		peakGamesPerSecond = Math.max(...throughput.map((report) => report.gamesPerSecond));
		const eligibleWorkers = throughput
			.filter((report) => report.gamesPerSecond >= peakGamesPerSecond * 0.95)
			.map((report) => report.workers)
			.sort((left, right) => left - right);
		selectedWorkers = eligibleWorkers[0];
		const selected = throughput.find((report) => report.workers === selectedWorkers);
		projected4096Seconds = selected.projected4096Seconds;
		if (projected4096Seconds > protocol.systems.throughput.projected4096SecondsMax) {
			rejectionReason = 'selected throughput projection exceeds 21600s';
		}
	}
	arms.push({
		id: arm.id,
		enabledBeforeSystems: true,
		operationallyEligible: rejectionReason === null,
		rejectionReason,
		selectedWorkers,
		peakGamesPerSecond,
		projected4096Seconds,
		binding: Object.fromEntries(
			reports
				.filter(({ report }) => report.stage.startsWith('binding-'))
				.map(({ report }) => [report.stage, report.decisionWallMsP95])
		),
		stageReports: reports.map(({ path: reportPath }) => ({
			path: reportPath,
			sha256: sha256(reportPath)
		}))
	});
}
const eligibleCandidateArms = arms.filter((arm) => arm.operationallyEligible).map((arm) => arm.id);
const resultPath = `${artifacts}/systems-eligibility.json`;
const result = {
	schemaVersion: 'arc-v34-systems-eligibility-v1',
	strengthUse: false,
	outcomesLoaded: false,
	protocol: { path: `${experiment}/protocol.json`, sha256: protocolSha256 },
	systemsAuthorization: {
		path: systemsAuthorizationPath,
		sha256: sha256(systemsAuthorizationPath)
	},
	arms,
	eligibleCandidateArms,
	phase2MayOpen: eligibleCandidateArms.length > 0,
	recordedAt: new Date().toISOString()
};
writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
chmodSync(resultPath, 0o444);
if (!result.phase2MayOpen) {
	console.log(JSON.stringify({ result, phase2Authorization: null }, null, 2));
	process.exit(0);
}
const phase2AuthorizationPath = `${artifacts}/phase2-authorization.json`;
const phase2Authorization = {
	schemaVersion: 'arc-v34-phase2-authorization-v1',
	systemsEligibility: { path: resultPath, sha256: sha256(resultPath) },
	registeredFamilyCandidateSlots: protocol.phase2.registeredCandidateSlots,
	eligibleCandidateArms,
	authorization: {
		phase2SeedsOpen: true,
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
writeFileSync(phase2AuthorizationPath, JSON.stringify(phase2Authorization, null, 2) + '\n', {
	flag: 'wx'
});
chmodSync(phase2AuthorizationPath, 0o444);
console.log(JSON.stringify({ result, phase2Authorization }, null, 2));
