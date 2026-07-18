#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPERIMENT = 'ml/experiments/v34-latency-first-expert-iteration';
const DEFAULT_GUARDIAN_PROTOCOL = `${EXPERIMENT}/guardian-execution-protocol.json`;
const DEFAULT_BASE_PROTOCOL = `${EXPERIMENT}/protocol.json`;
const DEFAULT_STRENGTH_PROTOCOL = `${EXPERIMENT}/strength-protocol.json`;

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const sha256 = (file) => sha256Bytes(readFileSync(file));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const stable = (value) => JSON.stringify(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const REPORT_KEYS = [
	'schemaVersion',
	'sourceCommit',
	'weights',
	'weightsSha256',
	'catalog',
	'catalogSha256',
	'inference',
	'seed0',
	'games',
	'maxRounds',
	'maxStatusLevel',
	'decode',
	'trueWins',
	'trueWinRate',
	'trueWinWilson95',
	'namedWinRate',
	'stalls',
	'stallRate',
	'reach15Rate',
	'nearMiss27To29Rate',
	'vp',
	'vpBuckets',
	'guardianBreakdown',
	'first30Round',
	'engine',
	'performance',
	'perGame'
];
const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};
const exactKeys = (value, expected, label) => {
	assert(
		value && stable(Object.keys(value).sort()) === stable([...expected].sort()),
		`${label}: exact key inventory mismatch`
	);
};
const relative = (file) => {
	const absolute = path.resolve(file);
	const value = path.relative(repo, absolute);
	return value.startsWith('..') ? absolute : value;
};
const resolveRecord = (value) => (path.isAbsolute(value) ? value : path.resolve(repo, value));
const fileRecord = (file) => ({
	path: relative(file),
	bytes: readFileSync(file).length,
	sha256: sha256(file)
});
const verifyFileRecord = (record, label) => {
	exactKeys(record, ['path', 'bytes', 'sha256'], `${label} file record`);
	assert(typeof record.path === 'string' && record.path.length > 0, `${label}: missing path`);
	assert(Number.isSafeInteger(record.bytes) && record.bytes >= 0, `${label}: invalid byte size`);
	assert(/^[0-9a-f]{64}$/.test(record.sha256 ?? ''), `${label}: invalid SHA-256`);
	const file = resolveRecord(record.path);
	assert(existsSync(file), `${label}: missing ${record.path}`);
	assert(readFileSync(file).length === record.bytes, `${label}: byte size changed`);
	assert(sha256(file) === record.sha256, `${label}: SHA-256 changed`);
	return file;
};
const linkFrom = (value, name) => value?.[name] ?? value?.inputs?.[name];

function artifactPath(guardianProtocol, name) {
	const value = guardianProtocol.authoritativeStateArtifacts?.[name];
	assert(typeof value === 'string' && value.length > 0, `guardian protocol lacks ${name} path`);
	return value;
}

function verifyBoundRecord(actual, expected, label) {
	assert(actual?.path === expected.path, `${label}: path mismatch`);
	assert(actual?.bytes === expected.bytes, `${label}: byte size mismatch`);
	assert(actual?.sha256 === expected.sha256, `${label}: SHA-256 mismatch`);
	verifyFileRecord(actual, label);
}

function guardianNames(context) {
	return context.guardianProtocol.guardian.guardians.map((guardian) => guardian.name);
}

function expectedGuardianCounts(context) {
	const { seed0, seedMax, guardians } = context.guardianProtocol.guardian;
	const counts = Array(guardians.length).fill(0);
	for (let seed = seed0; seed <= seedMax; seed += 1) counts[seed % guardians.length] += 1;
	return counts;
}

function inputPath(context, name) {
	const value = context.inputPaths?.[name];
	assert(typeof value === 'string' && existsSync(value), `missing ${name} input`);
	return value;
}

export function verifyGuardianExecutionLock(lockPath) {
	const guardianProtocolPath = path.resolve(DEFAULT_GUARDIAN_PROTOCOL);
	assert(existsSync(guardianProtocolPath), 'V34 guardian protocol is missing');
	const guardianProtocol = readJson(guardianProtocolPath);
	assert(
		guardianProtocol.schemaVersion === 'arc-v34-guardian-execution-protocol-v1',
		'V34 guardian protocol schema mismatch'
	);
	const defaultLock = artifactPath(guardianProtocol, 'executionLock');
	const resolvedLock = path.resolve(lockPath ?? defaultLock);
	assert(existsSync(resolvedLock), 'V34 guardian execution lock is missing');
	const executionLock = readJson(resolvedLock);
	exactKeys(
		executionLock,
		[
			'schemaVersion',
			'authoritative',
			'implementationCommit',
			'guardianToolingLock',
			'guardianProtocol',
			'phase2Analysis',
			'guardianAuthorization',
			'guardianPreflight',
			'phase2Conditions',
			'authorizedArms',
			'phase2RankedArms',
			'sourceCommit',
			'environment',
			'authorization',
			'createdAt'
		],
		'V34 guardian execution lock'
	);
	assert(
		executionLock.schemaVersion === 'arc-v34-guardian-execution-lock-v1' &&
			executionLock.authoritative === true,
		'V34 guardian execution lock schema mismatch'
	);
	exactKeys(
		executionLock.authorization,
		[
			'guardianSeedsOpen',
			'guardianExecutionOpen',
			'teacherSeedsOpen',
			'finalDevelopmentSeedsOpen',
			'hiddenSeedsOpen',
			'multiplayerSeedsOpen',
			'humanReferenceSeedsOpen',
			'productionPromotionOpen'
		],
		'V34 guardian execution authorization'
	);
	assert(
		executionLock.authorization.guardianSeedsOpen === true &&
			executionLock.authorization.guardianExecutionOpen === true,
		'V34 guardian execution lock is closed'
	);
	for (const [name, value] of Object.entries(executionLock.authorization)) {
		if (name !== 'guardianSeedsOpen' && name !== 'guardianExecutionOpen')
			assert(value === false, `V34 guardian execution lock opens ${name}`);
	}
	const sourceCommit = executionLock.sourceCommit;
	assert(/^[0-9a-f]{40}$/.test(sourceCommit ?? ''), 'V34 guardian source commit is invalid');
	assert(
		sourceCommit === guardianProtocol.base.sourceCommit,
		'V34 guardian source commit mismatch'
	);
	assert(
		/^[0-9a-f]{40}$/.test(executionLock.implementationCommit ?? ''),
		'V34 guardian tooling implementation commit is invalid'
	);

	const baseProtocolPath = resolveRecord(guardianProtocol.base.protocol.path);
	const strengthProtocolPath = resolveRecord(guardianProtocol.base.strengthProtocol.path);
	verifyBoundRecord(guardianProtocol.base.protocol, fileRecord(baseProtocolPath), 'base protocol');
	verifyBoundRecord(
		guardianProtocol.base.strengthProtocol,
		fileRecord(strengthProtocolPath),
		'strength protocol'
	);
	const baseProtocol = readJson(baseProtocolPath);
	const strengthProtocol = readJson(strengthProtocolPath);
	assert(
		strengthProtocol.schemaVersion === 'arc-v34-strength-protocol-v1',
		'V34 strength protocol schema mismatch'
	);
	assert(
		stable(guardianProtocol.commonDecode) === stable(strengthProtocol.commonDecode),
		'guardian common decode differs from frozen strength decode'
	);
	assert(
		stable(guardianProtocol.guardian.guardians) ===
			stable(strengthProtocol.guardian.guardiansFromFrozenCatalog),
		'guardian order differs from the frozen strength protocol'
	);
	for (const field of ['seed0', 'games', 'seedMax']) {
		assert(
			guardianProtocol.guardian[field] === strengthProtocol.guardian[field],
			`guardian ${field} differs from the frozen strength protocol`
		);
	}
	assert(
		guardianProtocol.guardian.seedMax ===
			guardianProtocol.guardian.seed0 + guardianProtocol.guardian.games - 1,
		'guardian registered seed range is not contiguous'
	);
	const derivedCounts = expectedGuardianCounts({ guardianProtocol });
	assert(
		stable(derivedCounts) ===
			stable(guardianProtocol.guardian.assignment.expectedCountsInGuardianOrder),
		'guardian registered counts are inconsistent with seed-modulo assignment'
	);
	assert(
		stable(derivedCounts) === stable([820, 820, 819, 819, 819, 819, 819, 819, 819, 819]),
		'guardian registered counts changed'
	);
	const catalogPath = resolveRecord(guardianProtocol.base.catalog.path);
	verifyBoundRecord(guardianProtocol.base.catalog, fileRecord(catalogPath), 'guardian catalog');
	const catalog = readJson(catalogPath);
	assert(
		stable(catalog.guardians.map(({ id, name }) => ({ id, name }))) ===
			stable(guardianProtocol.guardian.guardians),
		'guardian catalog identity/order mismatch'
	);
	verifyBoundRecord(
		guardianProtocol.base.checkpoint,
		fileRecord(resolveRecord(guardianProtocol.base.checkpoint.path)),
		'guardian checkpoint'
	);

	const inputPaths = {
		guardianExecutionLock: resolvedLock,
		guardianAuthorization: resolveRecord(artifactPath(guardianProtocol, 'authorization')),
		guardianToolingLock: resolveRecord(artifactPath(guardianProtocol, 'toolingLock')),
		baseProtocol: baseProtocolPath,
		strengthProtocol: strengthProtocolPath,
		guardianProtocol: guardianProtocolPath,
		systemsEligibility: path.resolve(`${EXPERIMENT}/artifacts/systems-eligibility.json`),
		guardianPreflight: resolveRecord(artifactPath(guardianProtocol, 'preflight'))
	};
	for (const [name, file] of Object.entries(inputPaths))
		assert(existsSync(file), `V34 guardian ${name} input is missing`);
	const authorization = readJson(inputPaths.guardianAuthorization);
	const toolingLock = readJson(inputPaths.guardianToolingLock);
	const systems = readJson(inputPaths.systemsEligibility);
	const preflight = readJson(inputPaths.guardianPreflight);
	exactKeys(
		toolingLock,
		[
			'schemaVersion',
			'authoritative',
			'implementationCommit',
			'baseSourceLock',
			'strengthProtocol',
			'strengthToolingLock',
			'guardianProtocol',
			'guardianPreflight',
			'files',
			'environment',
			'authorization',
			'createdAt'
		],
		'V34 guardian tooling lock'
	);
	assert(
		authorization.schemaVersion === 'arc-v34-guardian-authorization-v1',
		'V34 guardian authorization schema mismatch'
	);
	exactKeys(
		authorization,
		[
			'schemaVersion',
			'authoritative',
			'strengthProtocolHistoricalGuardianFlagsIgnored',
			'phase2Analysis',
			'strengthToolingLock',
			'registeredCandidateSlots',
			'systemsEligibleArms',
			'corePassingArms',
			'authorizedArms',
			'phase2RankedArms',
			'phase2Leader',
			'laneAClosed',
			'authorization',
			'sourceCommit',
			'createdAt'
		],
		'V34 guardian authorization'
	);
	assert(
		authorization.authoritative === true &&
			authorization.strengthProtocolHistoricalGuardianFlagsIgnored === true &&
			authorization.laneAClosed === false &&
			authorization.sourceCommit === sourceCommit,
		'V34 guardian authorization state mismatch'
	);
	assert(
		toolingLock.schemaVersion === 'arc-v34-guardian-tooling-lock-v1' &&
			toolingLock.authoritative === true &&
			toolingLock.implementationCommit === executionLock.implementationCommit,
		'V34 guardian tooling lock schema mismatch'
	);
	exactKeys(
		toolingLock.authorization,
		[
			'guardianSeedsOpen',
			'guardianExecutionOpen',
			'teacherSeedsOpen',
			'finalDevelopmentSeedsOpen',
			'hiddenSeedsOpen',
			'multiplayerSeedsOpen',
			'humanReferenceSeedsOpen',
			'productionPromotionOpen'
		],
		'V34 guardian tooling authorization'
	);
	assert(
		Object.values(toolingLock.authorization).every((value) => value === false),
		'V34 guardian tooling lock opened a seed family'
	);
	assert(
		preflight.schemaVersion === 'arc-v34-guardian-preflight-v1' &&
			preflight.phase === 'tooling' &&
			preflight.passed === true,
		'V34 guardian preflight is missing or failed'
	);
	assert(
		systems.schemaVersion === 'arc-v34-systems-eligibility-v1',
		'V34 systems eligibility schema mismatch'
	);
	const authorizationFlags = authorization.authorization;
	exactKeys(
		authorizationFlags,
		[
			'guardianSeedsOpen',
			'teacherSeedsOpen',
			'finalDevelopmentSeedsOpen',
			'hiddenSeedsOpen',
			'multiplayerSeedsOpen',
			'humanReferenceSeedsOpen',
			'productionPromotionOpen'
		],
		'V34 guardian authorization flags'
	);
	assert(authorizationFlags.guardianSeedsOpen === true, 'V34 guardian seeds are not authorized');
	for (const name of [
		'teacherSeedsOpen',
		'finalDevelopmentSeedsOpen',
		'hiddenSeedsOpen',
		'multiplayerSeedsOpen',
		'humanReferenceSeedsOpen',
		'productionPromotionOpen'
	]) {
		assert(authorizationFlags[name] === false, `V34 guardian authorization opens ${name}`);
	}
	const authorizedArms = authorization.authorizedArms;
	assert(Array.isArray(authorizedArms) && authorizedArms.length > 0, 'no guardian arms authorized');
	assert(
		stable(executionLock.authorizedArms) === stable(authorizedArms) &&
			stable(authorization.corePassingArms) === stable(authorizedArms) &&
			stable(executionLock.phase2RankedArms) === stable(authorization.phase2RankedArms) &&
			authorization.phase2Leader === authorization.phase2RankedArms[0],
		'guardian execution lock authorized-arm mismatch'
	);
	assert(
		stable(authorization.registeredCandidateSlots) ===
			stable(guardianProtocol.guardian.registeredCandidateSlots) &&
			authorization.systemsEligibleArms.every((arm) =>
				guardianProtocol.guardian.registeredCandidateSlots.includes(arm)
			),
		'guardian authorization registered/system arm contract mismatch'
	);
	assert(
		new Set(authorizedArms).size === authorizedArms.length &&
			authorizedArms.every((arm) =>
				guardianProtocol.guardian.registeredCandidateSlots.includes(arm)
			),
		'guardian authorization contains an invalid or duplicate arm'
	);
	for (const [name, expectedPath] of [
		['guardianAuthorization', artifactPath(guardianProtocol, 'authorization')],
		['guardianToolingLock', artifactPath(guardianProtocol, 'toolingLock')],
		['guardianPreflight', artifactPath(guardianProtocol, 'preflight')],
		['guardianProtocol', DEFAULT_GUARDIAN_PROTOCOL]
	]) {
		const link = linkFrom(executionLock, name);
		assert(link?.path === expectedPath, `guardian execution lock ${name} path mismatch`);
		verifyFileRecord(link, `guardian execution lock ${name}`);
	}
	assert(
		stable(executionLock.guardianAuthorization) ===
			stable(fileRecord(inputPaths.guardianAuthorization)) &&
			stable(executionLock.guardianToolingLock) ===
				stable(fileRecord(inputPaths.guardianToolingLock)) &&
			stable(executionLock.guardianPreflight) ===
				stable(fileRecord(inputPaths.guardianPreflight)) &&
			stable(executionLock.guardianProtocol) === stable(fileRecord(inputPaths.guardianProtocol)),
		'guardian execution lock authoritative artifact record mismatch'
	);
	assert(
		stable(executionLock.phase2Analysis) === stable(authorization.phase2Analysis) &&
			stable(authorization.strengthToolingLock) ===
				stable(guardianProtocol.base.strengthToolingLock),
		'guardian authorization source-chain record mismatch'
	);
	assert(
		stable(toolingLock.guardianProtocol) === stable(fileRecord(inputPaths.guardianProtocol)) &&
			stable(toolingLock.guardianPreflight) === stable(fileRecord(inputPaths.guardianPreflight)),
		'guardian tooling lock protocol/preflight link mismatch'
	);
	assert(
		stable(toolingLock.baseSourceLock) === stable(guardianProtocol.base.sourceLock) &&
			stable(toolingLock.strengthProtocol) === stable(guardianProtocol.base.strengthProtocol) &&
			stable(toolingLock.strengthToolingLock) === stable(guardianProtocol.base.strengthToolingLock),
		'guardian tooling lock base-chain record mismatch'
	);
	execFileSync(
		process.execPath,
		[
			'scripts/verify-v34-guardian-chain.mjs',
			'execution',
			'--execution-lock',
			relative(resolvedLock)
		],
		{ stdio: 'ignore' }
	);
	if (existsSync('.git')) {
		execFileSync(
			'git',
			['merge-base', '--is-ancestor', executionLock.implementationCommit, 'HEAD'],
			{
				stdio: 'ignore'
			}
		);
	}
	return {
		executionLock,
		executionLockPath: resolvedLock,
		sourceCommit,
		baseProtocol,
		strengthProtocol,
		guardianProtocol,
		systems,
		authorization,
		toolingLock,
		preflight,
		inputPaths,
		conditionsRoot: resolveRecord(artifactPath(guardianProtocol, 'conditionsRoot'))
	};
}

function expectedArm(context, condition) {
	if (condition === 'raw') {
		return { id: 'raw', kind: 'raw', selectedWorkers: context.guardianProtocol.runtime.rawWorkers };
	}
	assert(
		context.authorization.authorizedArms.includes(condition),
		`${condition}: arm is not guardian-authorized`
	);
	const registered = context.baseProtocol.systems.candidateArms.find((arm) => arm.id === condition);
	const systemsArm = context.systems.arms.find((arm) => arm.id === condition);
	assert(registered, `${condition}: arm is not registered`);
	assert(
		systemsArm?.operationallyEligible === true,
		`${condition}: arm failed systems eligibility`
	);
	assert(
		Number.isSafeInteger(systemsArm.selectedWorkers) &&
			context.baseProtocol.systems.throughput.workerCounts.includes(systemsArm.selectedWorkers),
		`${condition}: systems-selected worker count is invalid`
	);
	return { ...registered, selectedWorkers: systemsArm.selectedWorkers };
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
function close(actual, expected, label, tolerance = 1e-12) {
	assert(
		finite(actual) && Math.abs(actual - expected) <= tolerance,
		`${label}: aggregate mismatch`
	);
}

function validateCycle(row, condition) {
	for (const field of ['finalVP', 'finalAttackDice', 'finalSpirits', 'finalMaxBarrier']) {
		assert(
			Number.isSafeInteger(row[field]) && row[field] >= 0,
			`${condition}: seed ${row.seed} has invalid ${field}`
		);
	}
	assert(
		finite(row.post15VpPerRound),
		`${condition}: seed ${row.seed} has invalid post15VpPerRound`
	);
	assert(
		row.first30Round === null ||
			(Number.isSafeInteger(row.first30Round) && row.first30Round >= 1 && row.first30Round <= 30),
		`${condition}: invalid first30Round`
	);
	assert(
		row.cycle && typeof row.cycle === 'object',
		`${condition}: seed ${row.seed} lacks cycle telemetry`
	);
	for (const field of [
		'first30Round',
		'post15VpPerRound',
		'finalAttackDice',
		'finalSpirits',
		'finalMaxBarrier'
	]) {
		assert(
			row.cycle[field] === row[field],
			`${condition}: seed ${row.seed} cycle ${field} mismatch`
		);
	}
}

function validateSearch(context, condition, arm, report) {
	const search = report.performance?.search;
	if (arm.kind === 'raw') {
		assert(
			report.decode.rerank === undefined && report.decode.search === undefined,
			'raw: planner decode is not raw'
		);
		assert(search === undefined, 'raw: planner telemetry unexpectedly exists');
	} else if (arm.kind === 'critic-rerank') {
		assert(
			report.decode.rerank?.policyRankWeight === arm.policyRankWeight,
			`${condition}: rerank weight mismatch`
		);
		assert(report.decode.search === undefined, `${condition}: reranker has search decode`);
		assert(search?.mode === 'critic-rerank', `${condition}: reranker mode telemetry mismatch`);
		assert(
			Number.isSafeInteger(search.decisions) && search.decisions > 0,
			`${condition}: reranker decisions missing`
		);
		assert(search.simulations === 0, `${condition}: reranker unexpectedly simulated`);
	} else if (arm.kind === 'heuristic-batched') {
		const decode = report.decode.search;
		assert(report.decode.rerank === undefined, `${condition}: heuristic has reranker decode`);
		assert(
			decode?.sims === arm.simulations &&
				decode?.horizonRounds === arm.horizonRounds &&
				decode?.objective === 'solo-reach30' &&
				decode?.rollout === 'heuristic' &&
				decode?.frac === context.baseProtocol.systems.heuristicDecode.frac &&
				decode?.valueWeight === context.baseProtocol.systems.heuristicDecode.valueWeight &&
				decode?.navTemperature === context.baseProtocol.systems.heuristicDecode.navTemperature,
			`${condition}: heuristic decode mismatch`
		);
		assert(search?.mode === 'heuristic-batched', `${condition}: heuristic mode telemetry mismatch`);
		assert(
			Number.isSafeInteger(search.decisions) && search.decisions > 0,
			`${condition}: heuristic decisions missing`
		);
		assert(
			search.simulations === search.decisions * arm.simulations,
			`${condition}: heuristic simulation count mismatch`
		);
	} else {
		assert(false, `${condition}: unknown arm kind`);
	}
	if (search) {
		assert(
			Number.isSafeInteger(search.byPhase?.navigation) &&
				Number.isSafeInteger(search.byPhase?.encounter) &&
				search.byPhase.navigation >= 0 &&
				search.byPhase.encounter >= 0 &&
				search.byPhase.navigation + search.byPhase.encounter === search.decisions,
			`${condition}: strategic phase telemetry mismatch`
		);
		assert(
			finite(search.decisionWallMsP50) &&
				search.decisionWallMsP50 >= 0 &&
				finite(search.decisionWallMsP95) &&
				search.decisionWallMsP95 >= search.decisionWallMsP50,
			`${condition}: decision latency telemetry missing`
		);
	}
	return search;
}

export function validateGuardianReport(context, condition, workers, reportPath) {
	const arm = expectedArm(context, condition);
	assert(
		workers === arm.selectedWorkers,
		`${condition}: worker count differs from the frozen contract`
	);
	const report = readJson(reportPath);
	const protocol = context.guardianProtocol;
	const common = protocol.commonDecode;
	const guardian = protocol.guardian;
	exactKeys(report, REPORT_KEYS, `${condition}: evaluator report`);
	assert(report.schemaVersion === 'solo-heldout-v2', `${condition}: evaluator schema mismatch`);
	assert(report.sourceCommit === context.sourceCommit, `${condition}: source commit mismatch`);
	assert(
		report.seed0 === guardian.seed0 &&
			report.games === guardian.games &&
			report.seed0 + report.games - 1 === guardian.seedMax,
		`${condition}: seed/game contract mismatch`
	);
	assert(
		report.maxRounds === common.maxRounds && report.maxStatusLevel === common.maxStatusLevel,
		`${condition}: horizon/status mismatch`
	);
	assert(
		report.weights === protocol.base.checkpoint.path,
		`${condition}: checkpoint path mismatch`
	);
	assert(report.catalog === protocol.base.catalog.path, `${condition}: catalog path mismatch`);
	assert(
		report.weightsSha256 === protocol.base.checkpoint.sha256,
		`${condition}: checkpoint hash mismatch`
	);
	assert(
		report.catalogSha256 === protocol.base.catalog.sha256,
		`${condition}: catalog hash mismatch`
	);
	assert(report.performance?.workers === workers, `${condition}: report worker count mismatch`);
	assert(
		finite(report.performance?.wallSeconds) && report.performance.wallSeconds > 0,
		`${condition}: wall time missing`
	);
	assert(
		finite(report.performance?.gamesPerSecond) && report.performance.gamesPerSecond > 0,
		`${condition}: throughput missing`
	);
	assert(
		finite(report.performance?.gameWallMsP50) &&
			report.performance.gameWallMsP50 >= 0 &&
			finite(report.performance?.gameWallMsP95) &&
			report.performance.gameWallMsP95 >= report.performance.gameWallMsP50,
		`${condition}: game latency missing`
	);
	assert(
		report.decode?.policyObsVersion === common.policyObsVersion,
		`${condition}: policy obs version mismatch`
	);
	assert(
		typeof report.decode?.inferenceSocket === 'string' && report.decode.inferenceSocket.length > 0,
		`${condition}: binary inference socket missing`
	);
	assert(
		report.decode.learnMonsterRewardChoices === common.learnMonsterRewardChoices,
		`${condition}: monster choice decode mismatch`
	);
	assert(
		report.decode.sample === common.sample && report.decode.temperature === common.temperature,
		`${condition}: sampled decode mismatch`
	);
	assert(
		stable(Object.keys(report.inference ?? {}).sort()) ===
			stable(['actDim', 'format', 'obsDim', 'weightsPath', 'weightsSha256', 'wire'].sort()) &&
			report.inference?.weightsSha256 === protocol.base.checkpoint.sha256 &&
			report.inference?.weightsPath === protocol.base.checkpoint.path &&
			report.inference?.format === context.baseProtocol.inputs.policy.format &&
			report.inference?.obsDim === context.baseProtocol.inputs.policy.obsDim &&
			report.inference?.actDim === context.baseProtocol.inputs.policy.actDim &&
			report.inference?.wire === common.inferenceWire,
		`${condition}: inference provenance mismatch`
	);
	const expectedDecode = {
		policyObsVersion: common.policyObsVersion,
		inferenceSocket: report.decode.inferenceSocket,
		learnMonsterRewardChoices: common.learnMonsterRewardChoices,
		sample: common.sample,
		temperature: common.temperature
	};
	if (arm.kind === 'critic-rerank') {
		expectedDecode.rerank = { policyRankWeight: arm.policyRankWeight };
	} else if (arm.kind === 'heuristic-batched') {
		expectedDecode.search = {
			sims: arm.simulations,
			objective: 'solo-reach30',
			horizonRounds: arm.horizonRounds,
			frac: context.baseProtocol.systems.heuristicDecode.frac,
			valueWeight: context.baseProtocol.systems.heuristicDecode.valueWeight,
			rollout: 'heuristic',
			navTemperature: context.baseProtocol.systems.heuristicDecode.navTemperature
		};
	}
	assert(
		stable(report.decode) === stable(expectedDecode),
		`${condition}: decode differs from frozen arm`
	);
	const search = validateSearch(context, condition, arm, report);
	assert(
		Array.isArray(report.perGame) && report.perGame.length === guardian.games,
		`${condition}: per-game row count mismatch`
	);
	const expectedRowKeys = [
		'cycle',
		'finalAttackDice',
		'finalMaxBarrier',
		'finalSpirits',
		'finalVP',
		'first30Round',
		'guardian',
		'post15VpPerRound',
		'seed',
		'stalled',
		'trueWin'
	];
	const names = guardianNames(context);
	const seeds = new Set();
	const groups = new Map(names.map((name) => [name, { games: 0, wins: 0, vp: [] }]));
	let measuredStalls = 0;
	for (const row of report.perGame) {
		exactKeys(row, expectedRowKeys, `${condition}: seed ${row.seed} per-game row`);
		assert(Number.isSafeInteger(row.seed), `${condition}: invalid seed`);
		assert(
			row.seed >= guardian.seed0 && row.seed <= guardian.seedMax,
			`${condition}: seed outside guardian block`
		);
		assert(!seeds.has(row.seed), `${condition}: duplicate seed ${row.seed}`);
		seeds.add(row.seed);
		const expectedGuardian = names[row.seed % names.length];
		assert(row.guardian === expectedGuardian, `${condition}: seed ${row.seed} guardian mismatch`);
		assert(
			typeof row.stalled === 'boolean' && typeof row.trueWin === 'boolean',
			`${condition}: invalid outcome/stall row`
		);
		measuredStalls += Number(row.stalled);
		validateCycle(row, condition);
		assert(
			row.trueWin === (row.finalVP >= 30 && !row.stalled),
			`${condition}: seed ${row.seed} true-win mismatch`
		);
		const group = groups.get(row.guardian);
		group.games += 1;
		group.wins += Number(row.trueWin);
		group.vp.push(row.finalVP);
	}
	assert(seeds.size === guardian.games, `${condition}: incomplete seed coverage`);
	for (let seed = guardian.seed0; seed <= guardian.seedMax; seed += 1)
		assert(seeds.has(seed), `${condition}: missing seed ${seed}`);
	const counts = guardian.guardians.map(({ name }) => groups.get(name).games);
	assert(
		stable(counts) === stable(guardian.assignment.expectedCountsInGuardianOrder),
		`${condition}: guardian count vector mismatch`
	);
	assert(
		Number.isSafeInteger(report.stalls) && report.stalls === measuredStalls,
		`${condition}: stall aggregate mismatch`
	);
	close(report.stallRate, measuredStalls / guardian.games, `${condition}: stall rate`);
	assert(
		condition !== 'raw' || measuredStalls === 0,
		'raw: measured stalls invalidate the shared reference'
	);
	const wins = report.perGame.filter((row) => row.trueWin).length;
	assert(report.trueWins === wins, `${condition}: true-win aggregate mismatch`);
	close(report.trueWinRate, wins / report.games, `${condition}: trueWinRate`);
	close(report.vp?.mean, mean(report.perGame.map((row) => row.finalVP)), `${condition}: mean VP`);
	close(
		report.engine?.meanPost15VpPerRound,
		mean(report.perGame.map((row) => row.post15VpPerRound)),
		`${condition}: post-15 rate`
	);
	assert(
		Array.isArray(report.guardianBreakdown) && report.guardianBreakdown.length === names.length,
		`${condition}: guardian aggregate missing`
	);
	const reportedNames = report.guardianBreakdown.map((row) => row.guardian);
	assert(
		stable(reportedNames) === stable(names),
		`${condition}: guardian aggregate order/identity mismatch`
	);
	for (const row of report.guardianBreakdown) {
		const values = groups.get(row.guardian);
		assert(
			row.games === values.games && row.trueWins === values.wins,
			`${condition}: guardian ${row.guardian} count mismatch`
		);
		close(
			row.trueWinRate,
			values.wins / values.games,
			`${condition}: guardian ${row.guardian} win rate`
		);
		close(row.meanVP, mean(values.vp), `${condition}: guardian ${row.guardian} mean VP`);
	}
	return {
		report,
		arm,
		stalls: measuredStalls,
		guardianCounts: counts,
		telemetry: {
			plannerMode: arm.kind,
			strategicDecisions: search?.decisions ?? 0,
			strategicSimulations: search?.simulations ?? 0,
			decisionWallMsP50: search?.decisionWallMsP50 ?? null,
			decisionWallMsP95: search?.decisionWallMsP95 ?? null,
			byPhase: search?.byPhase ?? { navigation: 0, encounter: 0 },
			wallSeconds: report.performance.wallSeconds
		}
	};
}

export function validateGuardianReplayReport(context, condition, replayPath, primaryReport) {
	const replay = readJson(replayPath);
	const audit = context.guardianProtocol.guardian.replayAudit;
	exactKeys(replay, REPORT_KEYS, `${condition}: replay report`);
	assert(replay.schemaVersion === 'solo-heldout-v2', `${condition}: replay schema mismatch`);
	assert(
		replay.sourceCommit === context.sourceCommit,
		`${condition}: replay source commit mismatch`
	);
	assert(
		replay.seed0 === audit.seed0 &&
			replay.games === audit.games &&
			replay.seed0 + replay.games - 1 === audit.seedMax,
		`${condition}: replay seed range mismatch`
	);
	for (const field of [
		'weights',
		'weightsSha256',
		'catalog',
		'catalogSha256',
		'maxRounds',
		'maxStatusLevel'
	])
		assert(replay[field] === primaryReport[field], `${condition}: replay ${field} mismatch`);
	assert(
		stable(replay.decode) === stable(primaryReport.decode),
		`${condition}: replay decode mismatch`
	);
	assert(
		stable(replay.inference) === stable(primaryReport.inference),
		`${condition}: replay inference provenance mismatch`
	);
	assert(
		replay.performance?.workers === audit.workers,
		`${condition}: replay worker count mismatch`
	);
	assert(
		Array.isArray(replay.perGame) && replay.perGame.length === audit.games,
		`${condition}: replay per-game row count mismatch`
	);
	const expectedRows = new Map(
		primaryReport.perGame
			.filter((row) => row.seed >= audit.seed0 && row.seed <= audit.seedMax)
			.map((row) => [row.seed, row])
	);
	const replayRows = new Map(replay.perGame.map((row) => [row.seed, row]));
	assert(
		expectedRows.size === audit.games && replayRows.size === audit.games,
		`${condition}: replay seed coverage is duplicated or incomplete`
	);
	let mismatches = 0;
	for (let seed = audit.seed0; seed <= audit.seedMax; seed += 1) {
		if (stable(replayRows.get(seed)) !== stable(expectedRows.get(seed))) mismatches += 1;
	}
	assert(
		mismatches === 0,
		`${condition}: replay differs from the primary run on ${mismatches} games`
	);
	const replayStalls = replay.perGame.filter((row) => row.stalled).length;
	assert(replay.stalls === replayStalls, `${condition}: replay stall aggregate mismatch`);
	close(replay.stallRate, replayStalls / replay.games, `${condition}: replay stall rate`);
	assert(
		condition !== 'raw' || replayStalls === 0,
		'raw: replay measured stalls invalidate the shared reference'
	);
	const replayWins = replay.perGame.filter((row) => row.trueWin).length;
	assert(replay.trueWins === replayWins, `${condition}: replay true-win aggregate mismatch`);
	close(replay.trueWinRate, replayWins / replay.games, `${condition}: replay true-win rate`);
	return { report: replay, mismatches, stalls: replayStalls };
}

function verifyPathHashLink(link, file, label) {
	exactKeys(link, ['path', 'sha256'], `${label} link`);
	assert(link.path === relative(file), `${label}: path mismatch`);
	assert(link.sha256 === sha256(file), `${label}: SHA-256 mismatch`);
}

export function validateGuardianResourceSnapshot(context, args, arm) {
	const snapshot = readJson(args['resource-snapshot']);
	exactKeys(
		snapshot,
		[
			'schemaVersion',
			'recordedAt',
			'host',
			'sourceCommit',
			'guardianToolingLock',
			'guardianExecutionLock',
			'gpu',
			'locks',
			'workers',
			'maxConcurrentConditions',
			'maxActorWorkers',
			'scratch',
			'persistent',
			'memory',
			'loadAverage',
			'passed'
		],
		'guardian resource snapshot'
	);
	assert(
		snapshot.schemaVersion === 'arc-v34-guardian-resource-snapshot-v1',
		'guardian resource snapshot schema mismatch'
	);
	assert(
		typeof snapshot.recordedAt === 'string' &&
			Number.isFinite(Date.parse(snapshot.recordedAt)) &&
			/Z$/.test(snapshot.recordedAt),
		'guardian resource snapshot UTC time is invalid'
	);
	assert(
		typeof snapshot.host === 'string' && snapshot.host.length > 0,
		'guardian resource snapshot host is missing'
	);
	assert(
		snapshot.sourceCommit === context.sourceCommit,
		'guardian resource snapshot source commit mismatch'
	);
	verifyPathHashLink(
		snapshot.guardianToolingLock,
		inputPath(context, 'guardianToolingLock'),
		'guardian resource tooling lock'
	);
	verifyPathHashLink(
		snapshot.guardianExecutionLock,
		inputPath(context, 'guardianExecutionLock'),
		'guardian resource execution lock'
	);
	exactKeys(snapshot.gpu, ['index', 'uuid', 'computeApps'], 'guardian resource GPU');
	assert(
		context.guardianProtocol.runtime.eligibleGpus.includes(snapshot.gpu.index) &&
			snapshot.gpu.index !== context.guardianProtocol.runtime.excludedGpu,
		'guardian resource snapshot GPU is not eligible'
	);
	assert(
		typeof snapshot.gpu.uuid === 'string' && snapshot.gpu.uuid.length > 0,
		'guardian resource GPU UUID is missing'
	);
	assert(
		Array.isArray(snapshot.gpu.computeApps) && snapshot.gpu.computeApps.length === 0,
		'guardian resource GPU was not empty immediately before launch'
	);
	exactKeys(snapshot.locks, ['conditionSlot', 'gpu', 'phase2Gpu'], 'guardian resource locks');
	for (const [name, lock] of Object.entries(snapshot.locks))
		assert(
			typeof lock === 'string' && lock.length > 0,
			`guardian resource ${name} lock is missing`
		);
	assert(
		/\.condition-slot-[1-9][0-9]*\.lock$/.test(snapshot.locks.conditionSlot),
		'guardian condition-slot lock name mismatch'
	);
	assert(
		snapshot.locks.gpu.endsWith(`.gpu-${snapshot.gpu.index}.lock`),
		'guardian GPU lock name mismatch'
	);
	assert(
		snapshot.locks.phase2Gpu ===
			path.join(
				context.guardianProtocol.runtime.legacyPhase2GpuLockRoot,
				`.gpu-${snapshot.gpu.index}.lock`
			),
		'legacy Phase 2 GPU lock name mismatch'
	);
	assert(snapshot.workers === arm.selectedWorkers, 'guardian resource worker count mismatch');
	assert(
		snapshot.maxConcurrentConditions === context.guardianProtocol.runtime.maxConcurrentConditions,
		'guardian resource condition concurrency mismatch'
	);
	assert(
		snapshot.maxActorWorkers === context.guardianProtocol.runtime.maxActorWorkers &&
			snapshot.maxConcurrentConditions * snapshot.workers <= snapshot.maxActorWorkers,
		'guardian resource actor-worker limit mismatch'
	);
	exactKeys(snapshot.scratch, ['freeBytes', 'requiredBytes'], 'guardian resource scratch');
	exactKeys(
		snapshot.persistent,
		['freeBytes', 'requiredBytes', 'remainingConditions'],
		'guardian resource persistent'
	);
	exactKeys(snapshot.memory, ['availableBytes', 'requiredBytes'], 'guardian resource memory');
	assert(
		snapshot.scratch.requiredBytes === context.guardianProtocol.runtime.minimumScratchFreeBytes &&
			Number.isSafeInteger(snapshot.scratch.freeBytes) &&
			snapshot.scratch.freeBytes >= snapshot.scratch.requiredBytes,
		'guardian scratch headroom is insufficient or misrecorded'
	);
	const scheduledConditions = ['raw', ...context.authorization.authorizedArms];
	const recordedAtMs = Date.parse(snapshot.recordedAt);
	const completedBeforeSnapshot = scheduledConditions.filter((condition) => {
		const completion = path.join(
			context.conditionsRoot ?? context.guardianProtocol.authoritativeStateArtifacts.conditionsRoot,
			condition,
			'completion.json'
		);
		return existsSync(completion) && statSync(completion).mtimeMs <= recordedAtMs;
	}).length;
	const expectedRemainingConditions = scheduledConditions.length - completedBeforeSnapshot;
	const expectedPersistentBytes =
		context.guardianProtocol.runtime.minimumPersistentFreeBytes +
		expectedRemainingConditions *
			context.guardianProtocol.runtime.persistentBytesPerRemainingCondition;
	assert(
		snapshot.persistent.remainingConditions === expectedRemainingConditions &&
			snapshot.persistent.requiredBytes === expectedPersistentBytes &&
			Number.isSafeInteger(snapshot.persistent.freeBytes) &&
			snapshot.persistent.freeBytes >= snapshot.persistent.requiredBytes,
		'guardian persistent headroom is insufficient or misrecorded'
	);
	assert(
		snapshot.memory.requiredBytes ===
			context.guardianProtocol.runtime.minimumAvailableMemoryBytes &&
			Number.isSafeInteger(snapshot.memory.availableBytes) &&
			snapshot.memory.availableBytes >= snapshot.memory.requiredBytes,
		'guardian available memory is insufficient or misrecorded'
	);
	assert(
		(typeof snapshot.loadAverage === 'string' && snapshot.loadAverage.length > 0) ||
			(Array.isArray(snapshot.loadAverage) &&
				snapshot.loadAverage.length === 3 &&
				snapshot.loadAverage.every(finite)),
		'guardian resource load average is invalid'
	);
	assert(snapshot.passed === true, 'guardian resource snapshot did not pass');
	return snapshot;
}

function armArgs(context, arm) {
	if (arm.kind === 'raw') return [];
	if (arm.kind === 'critic-rerank') return ['--rerank-policy-weight', String(arm.policyRankWeight)];
	if (arm.kind === 'heuristic-batched') {
		return [
			'--search-sims',
			String(arm.simulations),
			'--search-horizon',
			String(arm.horizonRounds),
			'--search-objective',
			'solo-reach30',
			'--search-rollout',
			'heuristic',
			'--search-frac',
			String(context.baseProtocol.systems.heuristicDecode.frac),
			'--search-value-weight',
			String(context.baseProtocol.systems.heuristicDecode.valueWeight),
			'--search-nav-temperature',
			String(context.baseProtocol.systems.heuristicDecode.navTemperature)
		];
	}
	assert(false, `unknown guardian arm kind ${arm.kind}`);
}

export function validateGuardianLaunch(context, args, arm, report, snapshot) {
	const launch = readJson(args.launch);
	exactKeys(
		launch,
		[
			'schemaVersion',
			'condition',
			'attempt',
			'workers',
			'gpu',
			'sourceCommit',
			'watchdogSeconds',
			'watchdogKillAfterSeconds',
			'guardianExecutionLock',
			'resourceSnapshot',
			'seed0',
			'games',
			'seedMax',
			'commonDecode',
			'arm',
			'checkpoint',
			'catalog',
			'retryJustification',
			'evaluatorArgs',
			'replayEvaluatorArgs'
		],
		'guardian launch'
	);
	const attempt = Number(args.attempt);
	const protocol = context.guardianProtocol;
	assert(launch.schemaVersion === 'arc-v34-guardian-launch-v1', 'guardian launch schema mismatch');
	assert(
		launch.condition === args.condition && launch.attempt === attempt,
		'guardian launch condition/attempt mismatch'
	);
	assert(launch.workers === Number(args.workers), 'guardian launch worker mismatch');
	assert(launch.gpu === snapshot.gpu.index, 'guardian launch/resource GPU mismatch');
	assert(launch.sourceCommit === context.sourceCommit, 'guardian launch source commit mismatch');
	assert(
		launch.watchdogSeconds === protocol.runtime.watchdogSeconds &&
			launch.watchdogKillAfterSeconds === protocol.runtime.watchdogKillAfterSeconds,
		'guardian launch watchdog contract mismatch'
	);
	verifyPathHashLink(
		launch.guardianExecutionLock,
		inputPath(context, 'guardianExecutionLock'),
		'guardian launch execution lock'
	);
	verifyPathHashLink(
		launch.resourceSnapshot,
		args['resource-snapshot'],
		'guardian launch resource snapshot'
	);
	assert(
		launch.seed0 === protocol.guardian.seed0 &&
			launch.games === protocol.guardian.games &&
			launch.seedMax === protocol.guardian.seedMax,
		'guardian launch seed range mismatch'
	);
	assert(
		stable(launch.commonDecode) === stable(protocol.commonDecode),
		'guardian launch decode mismatch'
	);
	assert(stable(launch.arm) === stable(arm), 'guardian launch arm mismatch');
	for (const [name, expected] of [
		['checkpoint', protocol.base.checkpoint],
		['catalog', protocol.base.catalog]
	]) {
		exactKeys(launch[name], ['path', 'sha256'], `guardian launch ${name}`);
		assert(
			launch[name].path === expected.path && launch[name].sha256 === expected.sha256,
			`guardian launch ${name} mismatch`
		);
	}
	assert(
		Array.isArray(launch.evaluatorArgs) && launch.evaluatorArgs.length > 0,
		'guardian launch argv missing'
	);
	const socket = report.decode.inferenceSocket;
	const expectedArgv = [
		'scripts/evaluate-solo-checkpoint.mjs',
		'--weights',
		protocol.base.checkpoint.path,
		'--catalog',
		protocol.base.catalog.path,
		'--source-commit',
		context.sourceCommit,
		'--infer-socket',
		socket,
		'--policy-obs-version',
		String(protocol.commonDecode.policyObsVersion),
		'--games',
		String(protocol.guardian.games),
		'--workers',
		String(args.workers),
		'--seed0',
		String(protocol.guardian.seed0),
		'--max-rounds',
		String(protocol.commonDecode.maxRounds),
		'--max-status-level',
		String(protocol.commonDecode.maxStatusLevel),
		'--sample',
		'--temperature',
		String(protocol.commonDecode.temperature),
		'--include-games',
		...armArgs(context, arm),
		'--out',
		relative(args.report)
	];
	assert(
		stable(launch.evaluatorArgs) === stable(expectedArgv),
		'guardian launch evaluator argv mismatch'
	);
	const replayArgv = [...expectedArgv];
	const replaceValue = (flag, value) => {
		const index = replayArgv.indexOf(flag);
		assert(index >= 0 && replayArgv[index + 1] !== undefined, `guardian replay ${flag} is missing`);
		replayArgv[index + 1] = String(value);
	};
	replaceValue('--games', protocol.guardian.replayAudit.games);
	replaceValue('--workers', protocol.guardian.replayAudit.workers);
	replaceValue('--out', relative(args['replay-report']));
	assert(
		stable(launch.replayEvaluatorArgs) === stable(replayArgv),
		'guardian launch replay evaluator argv mismatch'
	);
	if (attempt === 1) {
		assert(launch.retryJustification === null, 'guardian attempt 1 launch has retry justification');
	} else {
		assert(args.justification, 'guardian attempt 2 launch lacks retry justification');
		verifyPathHashLink(
			launch.retryJustification,
			args.justification,
			'guardian launch retry justification'
		);
	}
	return launch;
}

function validateRetry(context, args, attempt) {
	if (attempt === 1) {
		assert(!args.justification, 'guardian attempt 1 must not have a retry justification');
		return null;
	}
	assert(attempt === 2, 'guardian attempt must be 1 or 2');
	assert(args.justification, 'guardian attempt 2 requires an immutable retry justification');
	const justification = readJson(args.justification);
	exactKeys(
		justification,
		[
			'schemaVersion',
			'condition',
			'attempt',
			'reason',
			'reasonCode',
			'infrastructureAttributed',
			'identicalSeedRetry',
			'outcomesInspected',
			'attempt1ReportExisted',
			'attempt1ReplayReportExisted',
			'sourceCommit',
			'guardianExecutionLockSha256',
			'seed0',
			'games',
			'seedMax',
			'failureEvidence'
		],
		'guardian retry justification'
	);
	const protocol = context.guardianProtocol;
	const retryableCodes = protocol.runtime.retryableFailureCodes;
	assert(
		justification.schemaVersion === 'arc-v34-guardian-retry-justification-v1' &&
			justification.condition === args.condition &&
			justification.attempt === 2 &&
			justification.identicalSeedRetry === true &&
			justification.outcomesInspected === false &&
			justification.infrastructureAttributed === true &&
			justification.attempt1ReportExisted === false &&
			justification.attempt1ReplayReportExisted === false &&
			Object.hasOwn(retryableCodes, justification.reasonCode) &&
			justification.sourceCommit === context.sourceCommit &&
			justification.guardianExecutionLockSha256 ===
				sha256(inputPath(context, 'guardianExecutionLock')) &&
			justification.seed0 === protocol.guardian.seed0 &&
			justification.games === protocol.guardian.games &&
			justification.seedMax === protocol.guardian.seedMax &&
			typeof justification.reason === 'string' &&
			justification.reason.length > 0,
		'guardian attempt 2 retry justification is invalid'
	);
	assert(
		/(infra|server|socket|cuda|gpu|oom|process|signal|host|machine|power|filesystem|disk|network|runtime|interrupt|service)/i.test(
			justification.reason
		) &&
			!/(outcome|result|win|victor|score|\bvp\b|stall|malform|missing seed|duplicate|provenance|replay|safety|integrity|weak|strength|guardian result)/i.test(
				justification.reason
			),
		'guardian attempt 2 reason is not outcome-blind infrastructure evidence'
	);
	const failurePath = verifyFileRecord(
		justification.failureEvidence,
		'guardian attempt 1 failure evidence'
	);
	const failure = readJson(failurePath);
	exactKeys(
		failure,
		[
			'schemaVersion',
			'condition',
			'attempt',
			'runtimeError',
			'reasonCode',
			'exitCode',
			'reportExists',
			'replayReportExists',
			'outcomesInspected',
			'sourceCommit',
			'guardianExecutionLockSha256',
			'files'
		],
		'guardian attempt 1 failure evidence'
	);
	assert(
		failure.schemaVersion === 'arc-v34-guardian-attempt-failure-v1' &&
			failure.condition === args.condition &&
			failure.attempt === 1 &&
			failure.runtimeError === true &&
			failure.reportExists === false &&
			failure.replayReportExists === false &&
			failure.outcomesInspected === false &&
			failure.sourceCommit === context.sourceCommit &&
			failure.guardianExecutionLockSha256 === sha256(inputPath(context, 'guardianExecutionLock')) &&
			failure.reasonCode === justification.reasonCode &&
			failure.exitCode === retryableCodes[justification.reasonCode],
		'guardian attempt 1 failure is not retry-eligible'
	);
	const failureInputNames = [
		'launch',
		'resourceSnapshot',
		'launchPid',
		'exitCode',
		'inferLog',
		'stdout',
		'stderr'
	];
	exactKeys(failure.files, failureInputNames, 'guardian attempt 1 failure file inventory');
	const failureFiles = {};
	for (const [name, record] of Object.entries(failure.files)) {
		failureFiles[name] = verifyFileRecord(record, `guardian attempt 1 failure input ${name}`);
	}
	const failureDirectory = path.dirname(failurePath);
	assert(
		!existsSync(path.join(failureDirectory, 'report.json')),
		'guardian attempt 1 primary report appeared after retry justification'
	);
	assert(
		!existsSync(path.join(failureDirectory, 'replay-report.json')),
		'guardian attempt 1 replay report appeared after retry justification'
	);
	assert(
		readFileSync(failureFiles.exitCode, 'utf8').trim() === String(failure.exitCode),
		'guardian attempt 1 failure exit-code file mismatch'
	);
	const arm = expectedArm(context, args.condition);
	const failureSnapshot = validateGuardianResourceSnapshot(
		context,
		{ 'resource-snapshot': failureFiles.resourceSnapshot },
		arm
	);
	const failureLaunch = readJson(failureFiles.launch);
	const socketIndex = failureLaunch.evaluatorArgs?.indexOf('--infer-socket') ?? -1;
	assert(
		socketIndex >= 0 && typeof failureLaunch.evaluatorArgs[socketIndex + 1] === 'string',
		'guardian attempt 1 failure launch inference socket is missing'
	);
	validateGuardianLaunch(
		context,
		{
			condition: args.condition,
			attempt: '1',
			workers: String(arm.selectedWorkers),
			launch: failureFiles.launch,
			'resource-snapshot': failureFiles.resourceSnapshot,
			report: path.join(failureDirectory, 'report.json'),
			'replay-report': path.join(failureDirectory, 'replay-report.json')
		},
		arm,
		{ decode: { inferenceSocket: failureLaunch.evaluatorArgs[socketIndex + 1] } },
		failureSnapshot
	);
	return { justification, failure };
}

function servingEvidence(inferLogPath) {
	const lines = readFileSync(inferLogPath, 'utf8').split(/\r?\n/);
	const servingLines = lines.filter((line) => line.startsWith('[infer] serving ')).length;
	const shutdownLines = lines.filter((line) => line === '[infer] shut down').length;
	const reloadLines = lines.filter((line) => /\[infer\] reloaded weights/.test(line)).length;
	const errorLines = lines.filter((line) =>
		/(Traceback|reload FAILED|RuntimeError|Exception)/.test(line)
	).length;
	let requests = 0;
	let rows = 0;
	let batches = 0;
	for (const line of lines) {
		const match = line.match(/\[infer\] reqs=(\d+) rows=(\d+) batches=(\d+)/);
		if (!match) continue;
		requests += Number(match[1]);
		rows += Number(match[2]);
		batches += Number(match[3]);
	}
	assert(
		servingLines === 1 &&
			shutdownLines === 1 &&
			reloadLines === 0 &&
			errorLines === 0 &&
			requests > 0 &&
			rows >= requests &&
			batches > 0,
		'guardian inference server log is incomplete or contains an error'
	);
	return { servingLines, shutdownLines, reloadLines, errorLines, requests, rows, batches };
}

export function buildGuardianCompletion(context, args) {
	const attempt = Number(args.attempt);
	assert(attempt === 1 || attempt === 2, 'guardian attempt must be 1 or 2');
	const validated = validateGuardianReport(
		context,
		args.condition,
		Number(args.workers),
		args.report
	);
	assert(
		readFileSync(args['replay-exit-code'], 'utf8').trim() === '0',
		'guardian replay process did not exit successfully'
	);
	const replay = validateGuardianReplayReport(
		context,
		args.condition,
		args['replay-report'],
		validated.report
	);
	assert(
		readFileSync(args['exit-code'], 'utf8').trim() === '0',
		'guardian condition process did not exit successfully'
	);
	assert(
		/^\d+$/.test(readFileSync(args['launch-pid'], 'utf8').trim()),
		'guardian evaluator PID is invalid'
	);
	const serving = servingEvidence(args['infer-log']);
	const snapshot = validateGuardianResourceSnapshot(context, args, validated.arm);
	validateGuardianLaunch(context, args, validated.arm, validated.report, snapshot);
	validateRetry(context, args, attempt);
	const inputFiles = {
		guardianExecutionLock: fileRecord(inputPath(context, 'guardianExecutionLock')),
		guardianAuthorization: fileRecord(inputPath(context, 'guardianAuthorization')),
		guardianToolingLock: fileRecord(inputPath(context, 'guardianToolingLock')),
		baseProtocol: fileRecord(inputPath(context, 'baseProtocol')),
		strengthProtocol: fileRecord(inputPath(context, 'strengthProtocol')),
		guardianProtocol: fileRecord(inputPath(context, 'guardianProtocol')),
		systemsEligibility: fileRecord(inputPath(context, 'systemsEligibility')),
		guardianPreflight: fileRecord(inputPath(context, 'guardianPreflight')),
		report: fileRecord(args.report),
		replayReport: fileRecord(args['replay-report']),
		replayStdout: fileRecord(args['replay-stdout']),
		replayStderr: fileRecord(args['replay-stderr']),
		replayExitCode: fileRecord(args['replay-exit-code']),
		inferLog: fileRecord(args['infer-log']),
		stdout: fileRecord(args.stdout),
		stderr: fileRecord(args.stderr),
		launch: fileRecord(args.launch),
		resourceSnapshot: fileRecord(args['resource-snapshot']),
		launchPid: fileRecord(args['launch-pid']),
		exitCode: fileRecord(args['exit-code'])
	};
	if (attempt === 2) inputFiles.retryJustification = fileRecord(args.justification);
	const ordered = context.guardianProtocol.guardian.guardians.map(({ id, name }) => ({ id, name }));
	const countByName = Object.fromEntries(
		ordered.map((guardian, index) => [guardian.name, validated.guardianCounts[index]])
	);
	return {
		schemaVersion: 'arc-v34-guardian-condition-v1',
		valid: true,
		immutable: true,
		condition: args.condition,
		attempt,
		workers: Number(args.workers),
		arm: validated.arm,
		sourceCommit: context.sourceCommit,
		seed0: context.guardianProtocol.guardian.seed0,
		games: context.guardianProtocol.guardian.games,
		seedMax: context.guardianProtocol.guardian.seedMax,
		commonDecode: context.guardianProtocol.commonDecode,
		checkpoint: {
			path: context.guardianProtocol.base.checkpoint.path,
			sha256: context.guardianProtocol.base.checkpoint.sha256
		},
		catalog: {
			path: context.guardianProtocol.base.catalog.path,
			sha256: context.guardianProtocol.base.catalog.sha256
		},
		inference: validated.report.inference,
		telemetry: validated.telemetry,
		stalls: validated.stalls,
		guardians: {
			assignment: context.guardianProtocol.guardian.assignment.algorithm,
			ordered,
			countByName
		},
		integrity: {
			informationSafetyFailures: 0,
			replayMismatches: replay.mismatches,
			servingErrors: serving.errorLines,
			provenanceMismatches: serving.reloadLines,
			derivedOnlyAfterStrictValidation: true,
			evidence: {
				informationSafety: {
					guardianPreflight: fileRecord(inputPath(context, 'guardianPreflight'))
				},
				replay: {
					seed0: context.guardianProtocol.guardian.replayAudit.seed0,
					games: context.guardianProtocol.guardian.replayAudit.games,
					workers: context.guardianProtocol.guardian.replayAudit.workers,
					exactPerGameEquality: true,
					mismatches: replay.mismatches,
					stalls: replay.stalls
				},
				serving: {
					servingLines: serving.servingLines,
					shutdownLines: serving.shutdownLines,
					errorLines: serving.errorLines,
					requests: serving.requests,
					rows: serving.rows,
					batches: serving.batches
				},
				provenance: {
					acceptedGameSummariesChecked: validated.report.perGame.length,
					evaluatorCrossGameHandshakeInvariant: true,
					fixedInferenceProcess: true,
					reloadLines: serving.reloadLines
				}
			}
		},
		inputs: inputFiles
	};
}

const COMPLETION_KEYS = [
	'schemaVersion',
	'valid',
	'immutable',
	'condition',
	'attempt',
	'workers',
	'arm',
	'sourceCommit',
	'seed0',
	'games',
	'seedMax',
	'commonDecode',
	'checkpoint',
	'catalog',
	'inference',
	'telemetry',
	'stalls',
	'guardians',
	'integrity',
	'inputs'
];
const BASE_INPUT_KEYS = [
	'guardianExecutionLock',
	'guardianAuthorization',
	'guardianToolingLock',
	'baseProtocol',
	'strengthProtocol',
	'guardianProtocol',
	'systemsEligibility',
	'guardianPreflight',
	'report',
	'replayReport',
	'replayStdout',
	'replayStderr',
	'replayExitCode',
	'inferLog',
	'stdout',
	'stderr',
	'launch',
	'resourceSnapshot',
	'launchPid',
	'exitCode'
];

export function writeImmutable(out, value) {
	const resolved = path.resolve(out);
	const sidecar = `${resolved}.sha256`;
	assert(
		!existsSync(resolved) && !existsSync(sidecar),
		`refusing to overwrite immutable output ${out}`
	);
	writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
	writeFileSync(sidecar, `${sha256(resolved)}  ${path.basename(resolved)}\n`, { flag: 'wx' });
	chmodSync(resolved, 0o444);
	chmodSync(sidecar, 0o444);
}

export function verifyGuardianCompletion(manifestPath, lockPath) {
	const context = verifyGuardianExecutionLock(lockPath);
	const manifest = readJson(manifestPath);
	exactKeys(manifest, COMPLETION_KEYS, 'guardian completion');
	assert(
		manifest.schemaVersion === 'arc-v34-guardian-condition-v1' &&
			manifest.valid === true &&
			manifest.immutable === true,
		'invalid V34 guardian completion manifest'
	);
	exactKeys(
		manifest.guardians,
		['assignment', 'ordered', 'countByName'],
		'guardian completion guardians'
	);
	assert(
		manifest.guardians.assignment === context.guardianProtocol.guardian.assignment.algorithm,
		'guardian completion assignment mismatch'
	);
	const expectedInputKeys = [...BASE_INPUT_KEYS];
	if (manifest.attempt === 2) expectedInputKeys.push('retryJustification');
	exactKeys(manifest.inputs, expectedInputKeys, 'guardian completion inputs');
	const sidecar = `${manifestPath}.sha256`;
	assert(existsSync(sidecar), 'V34 guardian completion sidecar is missing');
	assert(
		readFileSync(sidecar, 'utf8').trim() ===
			`${sha256(manifestPath)}  ${path.basename(manifestPath)}`,
		'V34 guardian completion sidecar mismatch'
	);
	for (const [name, record] of Object.entries(manifest.inputs))
		verifyFileRecord(record, `guardian completion input ${name}`);
	const recomputed = buildGuardianCompletion(context, {
		condition: manifest.condition,
		attempt: String(manifest.attempt),
		workers: String(manifest.workers),
		report: resolveRecord(manifest.inputs.report.path),
		'replay-report': resolveRecord(manifest.inputs.replayReport.path),
		'replay-stdout': resolveRecord(manifest.inputs.replayStdout.path),
		'replay-stderr': resolveRecord(manifest.inputs.replayStderr.path),
		'replay-exit-code': resolveRecord(manifest.inputs.replayExitCode.path),
		'infer-log': resolveRecord(manifest.inputs.inferLog.path),
		stdout: resolveRecord(manifest.inputs.stdout.path),
		stderr: resolveRecord(manifest.inputs.stderr.path),
		launch: resolveRecord(manifest.inputs.launch.path),
		'resource-snapshot': resolveRecord(manifest.inputs.resourceSnapshot.path),
		'launch-pid': resolveRecord(manifest.inputs.launchPid.path),
		'exit-code': resolveRecord(manifest.inputs.exitCode.path),
		...(manifest.inputs.retryJustification
			? { justification: resolveRecord(manifest.inputs.retryJustification.path) }
			: {})
	});
	assert(
		stable(recomputed) === stable(manifest),
		'V34 guardian completion manifest content mismatch'
	);
	return manifest;
}

function main() {
	process.chdir(repo);
	const guardianProtocol = readJson(DEFAULT_GUARDIAN_PROTOCOL);
	const defaultLock = artifactPath(guardianProtocol, 'executionLock');
	const { values: args, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			condition: { type: 'string' },
			attempt: { type: 'string' },
			workers: { type: 'string' },
			report: { type: 'string' },
			'replay-report': { type: 'string' },
			'replay-stdout': { type: 'string' },
			'replay-stderr': { type: 'string' },
			'replay-exit-code': { type: 'string' },
			'infer-log': { type: 'string' },
			stdout: { type: 'string' },
			stderr: { type: 'string' },
			launch: { type: 'string' },
			'resource-snapshot': { type: 'string' },
			'launch-pid': { type: 'string' },
			'exit-code': { type: 'string' },
			justification: { type: 'string' },
			out: { type: 'string' },
			manifest: { type: 'string' },
			'guardian-execution-lock': { type: 'string', default: defaultLock }
		}
	});
	const command = positionals[0];
	if (command === 'verify-lock') {
		const context = verifyGuardianExecutionLock(args['guardian-execution-lock']);
		console.log(
			JSON.stringify({
				schemaVersion: 'arc-v34-guardian-execution-lock-verification-v1',
				valid: true,
				sourceCommit: context.sourceCommit,
				authorizedArms: context.authorization.authorizedArms
			})
		);
		return;
	}
	if (command === 'verify') {
		assert(args.manifest, '--manifest is required');
		const manifest = verifyGuardianCompletion(
			path.resolve(args.manifest),
			args['guardian-execution-lock']
		);
		console.log(
			JSON.stringify({
				schemaVersion: 'arc-v34-guardian-condition-verification-v1',
				valid: true,
				condition: manifest.condition,
				attempt: manifest.attempt,
				stalls: manifest.stalls
			})
		);
		return;
	}
	if (command !== 'record')
		throw new Error('usage: record-v34-guardian-condition.mjs verify-lock|verify|record [options]');
	for (const name of [
		'condition',
		'attempt',
		'workers',
		'report',
		'replay-report',
		'replay-stdout',
		'replay-stderr',
		'replay-exit-code',
		'infer-log',
		'stdout',
		'stderr',
		'launch',
		'resource-snapshot',
		'launch-pid',
		'exit-code',
		'out'
	]) {
		assert(args[name], `--${name} is required`);
	}
	const context = verifyGuardianExecutionLock(args['guardian-execution-lock']);
	const value = buildGuardianCompletion(context, args);
	writeImmutable(args.out, value);
	console.log(JSON.stringify(value, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
