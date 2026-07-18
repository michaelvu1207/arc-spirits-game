#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	buildGuardianCompletion,
	validateGuardianReplayReport,
	validateGuardianReport,
	writeImmutable
} from './record-v34-guardian-condition.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const experiment = 'ml/experiments/v34-latency-first-expert-iteration';
const baseProtocol = JSON.parse(readFileSync(`${experiment}/protocol.json`, 'utf8'));
const strengthProtocol = JSON.parse(readFileSync(`${experiment}/strength-protocol.json`, 'utf8'));
const guardianProtocol = JSON.parse(
	readFileSync(`${experiment}/guardian-execution-protocol.json`, 'utf8')
);
const sourceCommit = guardianProtocol.base.sourceCommit;
const guardians = guardianProtocol.guardian.guardians;
const guardianNames = guardians.map(({ name }) => name);
const selectedWorkers = 8;
const candidateId = 'rerank-p025';
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const record = (file) => ({
	path: path.resolve(file),
	bytes: readFileSync(file).length,
	sha256: sha256(file)
});
const link = (file) => ({ path: path.resolve(file), sha256: sha256(file) });
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value)}\n`);
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function buildRows() {
	return Array.from({ length: guardianProtocol.guardian.games }, (_, index) => {
		const seed = guardianProtocol.guardian.seed0 + index;
		const trueWin = index % 3 === 0;
		const finalVP = trueWin ? 31 : 20 + (index % 7);
		const first30Round = trueWin ? 20 + (index % 11) : null;
		const cycle = {
			first30Round,
			post15VpPerRound: 0.5 + (index % 5) * 0.25,
			finalAttackDice: 2 + (index % 4),
			finalSpirits: 3 + (index % 6),
			finalMaxBarrier: 1 + (index % 5)
		};
		return {
			seed,
			guardian: guardianNames[seed % guardianNames.length],
			trueWin,
			stalled: false,
			finalVP,
			first30Round: cycle.first30Round,
			post15VpPerRound: cycle.post15VpPerRound,
			finalAttackDice: cycle.finalAttackDice,
			finalSpirits: cycle.finalSpirits,
			finalMaxBarrier: cycle.finalMaxBarrier,
			cycle
		};
	});
}

function guardianBreakdown(rows) {
	return guardianNames.map((guardian) => {
		const group = rows.filter((row) => row.guardian === guardian);
		const trueWins = group.filter((row) => row.trueWin).length;
		return {
			guardian,
			games: group.length,
			trueWins,
			trueWinRate: trueWins / group.length,
			meanVP: mean(group.map((row) => row.finalVP))
		};
	});
}

function reportFor(condition, withStall = false) {
	const perGame = buildRows();
	if (withStall) {
		perGame[0].stalled = true;
		perGame[0].trueWin = false;
	}
	const trueWins = perGame.filter((row) => row.trueWin).length;
	const stalls = perGame.filter((row) => row.stalled).length;
	const report = {
		schemaVersion: 'solo-heldout-v2',
		sourceCommit,
		weights: guardianProtocol.base.checkpoint.path,
		weightsSha256: guardianProtocol.base.checkpoint.sha256,
		catalog: guardianProtocol.base.catalog.path,
		catalogSha256: guardianProtocol.base.catalog.sha256,
		inference: {
			weightsPath: guardianProtocol.base.checkpoint.path,
			weightsSha256: guardianProtocol.base.checkpoint.sha256,
			format: baseProtocol.inputs.policy.format,
			obsDim: baseProtocol.inputs.policy.obsDim,
			actDim: baseProtocol.inputs.policy.actDim,
			wire: guardianProtocol.commonDecode.inferenceWire
		},
		seed0: guardianProtocol.guardian.seed0,
		games: guardianProtocol.guardian.games,
		maxRounds: guardianProtocol.commonDecode.maxRounds,
		maxStatusLevel: guardianProtocol.commonDecode.maxStatusLevel,
		decode: {
			policyObsVersion: guardianProtocol.commonDecode.policyObsVersion,
			inferenceSocket: '/tmp/arc-v34-guardian-test.sock',
			learnMonsterRewardChoices: guardianProtocol.commonDecode.learnMonsterRewardChoices,
			sample: guardianProtocol.commonDecode.sample,
			temperature: guardianProtocol.commonDecode.temperature
		},
		trueWins,
		trueWinRate: trueWins / perGame.length,
		trueWinWilson95: { low: 0, high: 1 },
		namedWinRate: trueWins / perGame.length,
		stalls,
		stallRate: stalls / perGame.length,
		reach15Rate: 1,
		nearMiss27To29Rate: 0,
		vp: { mean: mean(perGame.map((row) => row.finalVP)) },
		vpBuckets: {},
		engine: { meanPost15VpPerRound: mean(perGame.map((row) => row.post15VpPerRound)) },
		guardianBreakdown: guardianBreakdown(perGame),
		first30Round: {},
		performance: {
			workers: condition === 'raw' ? guardianProtocol.runtime.rawWorkers : selectedWorkers,
			wallSeconds: 200,
			gamesPerSecond: guardianProtocol.guardian.games / 200,
			gameWallMsP50: 10,
			gameWallMsP95: 20
		},
		perGame
	};
	if (condition !== 'raw') {
		report.decode.rerank = { policyRankWeight: 0.25 };
		report.performance.search = {
			mode: 'critic-rerank',
			decisions: 16384,
			simulations: 0,
			byPhase: { navigation: 8192, encounter: 8192 },
			decisionWallMsP50: 0.5,
			decisionWallMsP95: 1.5
		};
	}
	return report;
}

function replayFor(primary) {
	const audit = guardianProtocol.guardian.replayAudit;
	const replay = structuredClone(primary);
	replay.seed0 = audit.seed0;
	replay.games = audit.games;
	replay.perGame = replay.perGame.slice(0, audit.games).reverse();
	replay.trueWins = replay.perGame.filter((row) => row.trueWin).length;
	replay.trueWinRate = replay.trueWins / replay.games;
	replay.stalls = replay.perGame.filter((row) => row.stalled).length;
	replay.stallRate = replay.stalls / replay.games;
	replay.performance.workers = audit.workers;
	return replay;
}

function expectedArm(condition) {
	if (condition === 'raw')
		return { id: 'raw', kind: 'raw', selectedWorkers: guardianProtocol.runtime.rawWorkers };
	return {
		...baseProtocol.systems.candidateArms.find(({ id }) => id === condition),
		selectedWorkers
	};
}

function expectedEvaluatorArgs(condition, workers, reportPath) {
	const arm = expectedArm(condition);
	const specific =
		arm.kind === 'raw' ? [] : ['--rerank-policy-weight', String(arm.policyRankWeight)];
	return [
		'scripts/evaluate-solo-checkpoint.mjs',
		'--weights',
		guardianProtocol.base.checkpoint.path,
		'--catalog',
		guardianProtocol.base.catalog.path,
		'--source-commit',
		sourceCommit,
		'--infer-socket',
		'/tmp/arc-v34-guardian-test.sock',
		'--policy-obs-version',
		String(guardianProtocol.commonDecode.policyObsVersion),
		'--games',
		String(guardianProtocol.guardian.games),
		'--workers',
		String(workers),
		'--seed0',
		String(guardianProtocol.guardian.seed0),
		'--max-rounds',
		String(guardianProtocol.commonDecode.maxRounds),
		'--max-status-level',
		String(guardianProtocol.commonDecode.maxStatusLevel),
		'--sample',
		'--temperature',
		String(guardianProtocol.commonDecode.temperature),
		'--include-games',
		...specific,
		'--out',
		path.resolve(reportPath)
	];
}

function replayArgs(primary, replayPath) {
	const value = [...primary];
	value[value.indexOf('--games') + 1] = String(guardianProtocol.guardian.replayAudit.games);
	value[value.indexOf('--workers') + 1] = String(guardianProtocol.guardian.replayAudit.workers);
	value[value.indexOf('--out') + 1] = path.resolve(replayPath);
	return value;
}

function fixtureContext(temp) {
	const names = [
		'guardianExecutionLock',
		'guardianAuthorization',
		'guardianToolingLock',
		'baseProtocol',
		'strengthProtocol',
		'guardianProtocol',
		'systemsEligibility',
		'guardianPreflight'
	];
	const inputPaths = {};
	for (const name of names) {
		const file = path.join(temp, `${name}.json`);
		writeJson(file, { fixture: name });
		inputPaths[name] = file;
	}
	const conditionsRoot = path.join(temp, 'conditions');
	mkdirSync(conditionsRoot);
	return {
		sourceCommit,
		baseProtocol,
		strengthProtocol,
		guardianProtocol,
		systems: {
			arms: baseProtocol.systems.candidateArms.map(({ id }) => ({
				id,
				operationallyEligible: true,
				selectedWorkers
			}))
		},
		authorization: { authorizedArms: [candidateId] },
		inputPaths,
		conditionsRoot
	};
}

function resourceSnapshot(context, workers, condition, file) {
	const gpu = 5;
	const value = {
		schemaVersion: 'arc-v34-guardian-resource-snapshot-v1',
		recordedAt: '2026-07-14T12:00:00.000Z',
		host: 'synthetic-simforge',
		sourceCommit,
		guardianToolingLock: link(context.inputPaths.guardianToolingLock),
		guardianExecutionLock: link(context.inputPaths.guardianExecutionLock),
		gpu: { index: gpu, uuid: 'GPU-synthetic', computeApps: [] },
		locks: {
			conditionSlot: '/dev/shm/arc-v34-guardian/.condition-slot-1.lock',
			gpu: `/dev/shm/arc-v34-guardian/.gpu-${gpu}.lock`,
			phase2Gpu: `${guardianProtocol.runtime.legacyPhase2GpuLockRoot}/.gpu-${gpu}.lock`
		},
		workers,
		maxConcurrentConditions: guardianProtocol.runtime.maxConcurrentConditions,
		maxActorWorkers: guardianProtocol.runtime.maxActorWorkers,
		scratch: {
			freeBytes: guardianProtocol.runtime.minimumScratchFreeBytes + 1,
			requiredBytes: guardianProtocol.runtime.minimumScratchFreeBytes
		},
		persistent: {
			freeBytes:
				guardianProtocol.runtime.minimumPersistentFreeBytes +
				3 * guardianProtocol.runtime.persistentBytesPerRemainingCondition,
			requiredBytes:
				guardianProtocol.runtime.minimumPersistentFreeBytes +
				2 * guardianProtocol.runtime.persistentBytesPerRemainingCondition,
			remainingConditions: 2
		},
		memory: {
			availableBytes: guardianProtocol.runtime.minimumAvailableMemoryBytes + 1,
			requiredBytes: guardianProtocol.runtime.minimumAvailableMemoryBytes
		},
		loadAverage: [1, 2, 3],
		passed: true
	};
	writeJson(file, value);
	return value;
}

function launchFixture(
	context,
	condition,
	attempt,
	workers,
	reportPath,
	replayPath,
	resourcePath,
	justification,
	file
) {
	const evaluatorArgs = expectedEvaluatorArgs(condition, workers, reportPath);
	const value = {
		schemaVersion: 'arc-v34-guardian-launch-v1',
		condition,
		attempt,
		workers,
		gpu: 5,
		sourceCommit,
		watchdogSeconds: guardianProtocol.runtime.watchdogSeconds,
		watchdogKillAfterSeconds: guardianProtocol.runtime.watchdogKillAfterSeconds,
		guardianExecutionLock: link(context.inputPaths.guardianExecutionLock),
		resourceSnapshot: link(resourcePath),
		seed0: guardianProtocol.guardian.seed0,
		games: guardianProtocol.guardian.games,
		seedMax: guardianProtocol.guardian.seedMax,
		commonDecode: guardianProtocol.commonDecode,
		arm: expectedArm(condition),
		checkpoint: {
			path: guardianProtocol.base.checkpoint.path,
			sha256: guardianProtocol.base.checkpoint.sha256
		},
		catalog: {
			path: guardianProtocol.base.catalog.path,
			sha256: guardianProtocol.base.catalog.sha256
		},
		retryJustification: justification ? link(justification) : null,
		evaluatorArgs,
		replayEvaluatorArgs: replayArgs(evaluatorArgs, replayPath)
	};
	writeJson(file, value);
	return value;
}

function conditionFixture(
	temp,
	context,
	condition,
	withStall = false,
	attempt = 1,
	justification = null
) {
	const dir = path.join(temp, `${condition}-${withStall ? 'stall' : 'clean'}-${attempt}`);
	mkdirSync(dir);
	const workers = condition === 'raw' ? guardianProtocol.runtime.rawWorkers : selectedWorkers;
	const report = reportFor(condition, withStall);
	const replay = replayFor(report);
	const files = {
		report: path.join(dir, 'report.json'),
		replay: path.join(dir, 'replay-report.json'),
		replayStdout: path.join(dir, 'replay.stdout'),
		replayStderr: path.join(dir, 'replay.stderr'),
		replayExit: path.join(dir, 'replay-exit-code.txt'),
		inferLog: path.join(dir, 'infer.log'),
		stdout: path.join(dir, 'stdout'),
		stderr: path.join(dir, 'stderr'),
		launch: path.join(dir, 'launch.json'),
		resource: path.join(dir, 'resource.json'),
		launchPid: path.join(dir, 'launch.pid'),
		exitCode: path.join(dir, 'exit-code.txt')
	};
	writeJson(files.report, report);
	writeJson(files.replay, replay);
	for (const file of [files.replayStdout, files.replayStderr, files.stdout, files.stderr])
		writeFileSync(file, '');
	writeFileSync(files.replayExit, '0\n');
	writeFileSync(files.exitCode, '0\n');
	writeFileSync(files.launchPid, '12345\n');
	writeFileSync(
		files.inferLog,
		'[infer] serving checkpoint on cuda\n[infer] reqs=10 rows=20 batches=5\n[infer] shut down\n'
	);
	resourceSnapshot(context, workers, condition, files.resource);
	launchFixture(
		context,
		condition,
		attempt,
		workers,
		files.report,
		files.replay,
		files.resource,
		justification,
		files.launch
	);
	return {
		report,
		replay,
		files,
		args: {
			condition,
			attempt: String(attempt),
			workers: String(workers),
			report: files.report,
			'replay-report': files.replay,
			'replay-stdout': files.replayStdout,
			'replay-stderr': files.replayStderr,
			'replay-exit-code': files.replayExit,
			'infer-log': files.inferLog,
			stdout: files.stdout,
			stderr: files.stderr,
			launch: files.launch,
			'resource-snapshot': files.resource,
			'launch-pid': files.launchPid,
			'exit-code': files.exitCode,
			...(justification ? { justification } : {})
		}
	};
}

function retryEvidence(temp, context, condition) {
	const dir = path.join(temp, 'attempt-1-failure');
	mkdirSync(dir);
	const files = {
		launch: path.join(dir, 'launch.json'),
		resourceSnapshot: path.join(dir, 'resource-snapshot.json'),
		launchPid: path.join(dir, 'launch.pid'),
		exitCode: path.join(dir, 'exit-code.txt'),
		inferLog: path.join(dir, 'infer.log'),
		stdout: path.join(dir, 'evaluator.stdout'),
		stderr: path.join(dir, 'evaluator.stderr')
	};
	resourceSnapshot(context, selectedWorkers, condition, files.resourceSnapshot);
	launchFixture(
		context,
		condition,
		1,
		selectedWorkers,
		path.join(dir, 'report.json'),
		path.join(dir, 'replay-report.json'),
		files.resourceSnapshot,
		null,
		files.launch
	);
	writeFileSync(files.launchPid, 'not-launched\n');
	writeFileSync(
		files.exitCode,
		`${guardianProtocol.runtime.retryableFailureCodes['server-start']}\n`
	);
	for (const file of [files.inferLog, files.stdout, files.stderr]) writeFileSync(file, '');
	const failureInputs = Object.fromEntries(
		Object.entries(files).map(([name, file]) => [name, record(file)])
	);
	const failurePath = path.join(dir, 'failure.json');
	const failure = {
		schemaVersion: 'arc-v34-guardian-attempt-failure-v1',
		condition,
		attempt: 1,
		runtimeError: true,
		reasonCode: 'server-start',
		exitCode: guardianProtocol.runtime.retryableFailureCodes['server-start'],
		reportExists: false,
		replayReportExists: false,
		outcomesInspected: false,
		sourceCommit,
		guardianExecutionLockSha256: sha256(context.inputPaths.guardianExecutionLock),
		files: failureInputs
	};
	writeJson(failurePath, failure);
	const justificationPath = path.join(temp, 'retry-justification.json');
	const justification = {
		schemaVersion: 'arc-v34-guardian-retry-justification-v1',
		condition,
		attempt: 2,
		reason: 'GPU server socket infrastructure interruption',
		reasonCode: 'server-start',
		infrastructureAttributed: true,
		identicalSeedRetry: true,
		outcomesInspected: false,
		attempt1ReportExisted: false,
		attempt1ReplayReportExisted: false,
		sourceCommit,
		guardianExecutionLockSha256: sha256(context.inputPaths.guardianExecutionLock),
		seed0: guardianProtocol.guardian.seed0,
		games: guardianProtocol.guardian.games,
		seedMax: guardianProtocol.guardian.seedMax,
		failureEvidence: record(failurePath)
	};
	writeJson(justificationPath, justification);
	return { failurePath, failure, justificationPath, justification };
}

function expectReportRejected(temp, context, label, condition, workers, report, pattern) {
	const file = path.join(temp, `${label}.json`);
	writeJson(file, report);
	assert.throws(
		() => validateGuardianReport(context, condition, workers, file),
		pattern,
		`${label} corruption was accepted`
	);
}

const temp = mkdtempSync(path.join(tmpdir(), 'arc-v34-guardian-condition-test-'));
try {
	const context = fixtureContext(temp);
	const rawFixture = conditionFixture(temp, context, 'raw');
	const rawCompletion = buildGuardianCompletion(context, rawFixture.args);
	assert.equal(rawCompletion.games, 8192);
	assert.equal(rawCompletion.seed0, 957300000);
	assert.equal(rawCompletion.seedMax, 957308191);
	assert.equal(rawCompletion.stalls, 0);
	assert.equal(rawCompletion.guardians.assignment, guardianProtocol.guardian.assignment.algorithm);
	assert.deepEqual(
		Object.values(rawCompletion.guardians.countByName),
		[820, 820, 819, 819, 819, 819, 819, 819, 819, 819]
	);
	assert.deepEqual(rawCompletion.guardians.ordered, guardians);
	assert.deepEqual(Object.keys(rawCompletion.inputs), [
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
	]);

	const candidateFixture = conditionFixture(temp, context, candidateId, true);
	const candidateCompletion = buildGuardianCompletion(context, candidateFixture.args);
	assert.equal(candidateCompletion.stalls, 1);
	assert.equal(candidateCompletion.integrity.evidence.replay.stalls, 1);

	const duplicate = structuredClone(rawFixture.report);
	duplicate.perGame[1].seed = duplicate.perGame[0].seed;
	expectReportRejected(
		temp,
		context,
		'duplicate-seed',
		'raw',
		guardianProtocol.runtime.rawWorkers,
		duplicate,
		/duplicate seed/
	);
	const guardianMismatch = structuredClone(rawFixture.report);
	guardianMismatch.perGame[0].guardian = guardianNames[1];
	expectReportRejected(
		temp,
		context,
		'guardian-mismatch',
		'raw',
		guardianProtocol.runtime.rawWorkers,
		guardianMismatch,
		/guardian mismatch/
	);
	const rawStall = reportFor('raw', true);
	expectReportRejected(
		temp,
		context,
		'raw-stall',
		'raw',
		guardianProtocol.runtime.rawWorkers,
		rawStall,
		/measured stalls invalidate/
	);
	const provenance = structuredClone(rawFixture.report);
	provenance.inference.weightsSha256 = 'b'.repeat(64);
	expectReportRejected(
		temp,
		context,
		'provenance',
		'raw',
		guardianProtocol.runtime.rawWorkers,
		provenance,
		/inference provenance mismatch/
	);
	const wrongSource = structuredClone(rawFixture.report);
	wrongSource.sourceCommit = 'c'.repeat(40);
	expectReportRejected(
		temp,
		context,
		'source',
		'raw',
		guardianProtocol.runtime.rawWorkers,
		wrongSource,
		/source commit mismatch/
	);
	const wrongCheckpoint = structuredClone(rawFixture.report);
	wrongCheckpoint.weightsSha256 = 'd'.repeat(64);
	expectReportRejected(
		temp,
		context,
		'checkpoint',
		'raw',
		guardianProtocol.runtime.rawWorkers,
		wrongCheckpoint,
		/checkpoint hash mismatch/
	);
	const wrongCatalog = structuredClone(rawFixture.report);
	wrongCatalog.catalogSha256 = 'e'.repeat(64);
	expectReportRejected(
		temp,
		context,
		'catalog',
		'raw',
		guardianProtocol.runtime.rawWorkers,
		wrongCatalog,
		/catalog hash mismatch/
	);
	const wrongDecode = structuredClone(rawFixture.report);
	wrongDecode.decode.temperature = 0.1;
	expectReportRejected(
		temp,
		context,
		'decode',
		'raw',
		guardianProtocol.runtime.rawWorkers,
		wrongDecode,
		/sampled decode mismatch/
	);
	const wrongArm = structuredClone(candidateFixture.report);
	wrongArm.decode.rerank.policyRankWeight = 0.5;
	expectReportRejected(
		temp,
		context,
		'arm-config',
		candidateId,
		selectedWorkers,
		wrongArm,
		/decode differs from frozen arm/
	);
	assert.throws(
		() => validateGuardianReport(context, candidateId, 12, candidateFixture.files.report),
		/worker count differs/
	);

	const replayCorrupt = structuredClone(rawFixture.replay);
	replayCorrupt.perGame[0].finalVP += 1;
	const replayCorruptPath = path.join(temp, 'replay-corrupt.json');
	writeJson(replayCorruptPath, replayCorrupt);
	assert.throws(
		() => validateGuardianReplayReport(context, 'raw', replayCorruptPath, rawFixture.report),
		/replay differs from the primary run/
	);

	const originalInfer = readFileSync(rawFixture.files.inferLog, 'utf8');
	writeFileSync(rawFixture.files.inferLog, `${originalInfer}[infer] reloaded weights from bad\n`);
	assert.throws(() => buildGuardianCompletion(context, rawFixture.args), /inference server log/);
	writeFileSync(rawFixture.files.inferLog, originalInfer);
	writeFileSync(rawFixture.files.inferLog, originalInfer.replace('[infer] shut down\n', ''));
	assert.throws(() => buildGuardianCompletion(context, rawFixture.args), /inference server log/);
	writeFileSync(rawFixture.files.inferLog, originalInfer);

	const originalResource = readFileSync(rawFixture.files.resource, 'utf8');
	const occupied = JSON.parse(originalResource);
	occupied.gpu.computeApps = ['1234'];
	writeJson(rawFixture.files.resource, occupied);
	assert.throws(() => buildGuardianCompletion(context, rawFixture.args), /GPU was not empty/);
	writeFileSync(rawFixture.files.resource, originalResource);

	const lowMemory = JSON.parse(originalResource);
	lowMemory.memory.availableBytes = lowMemory.memory.requiredBytes - 1;
	writeJson(rawFixture.files.resource, lowMemory);
	assert.throws(() => buildGuardianCompletion(context, rawFixture.args), /available memory/);
	writeFileSync(rawFixture.files.resource, originalResource);

	const wrongRemaining = JSON.parse(originalResource);
	wrongRemaining.persistent.remainingConditions = 1;
	wrongRemaining.persistent.requiredBytes =
		guardianProtocol.runtime.minimumPersistentFreeBytes +
		guardianProtocol.runtime.persistentBytesPerRemainingCondition;
	writeJson(rawFixture.files.resource, wrongRemaining);
	assert.throws(() => buildGuardianCompletion(context, rawFixture.args), /persistent headroom/);
	writeFileSync(rawFixture.files.resource, originalResource);

	const originalLaunch = readFileSync(rawFixture.files.launch, 'utf8');
	const badArgv = JSON.parse(originalLaunch);
	badArgv.evaluatorArgs[badArgv.evaluatorArgs.indexOf('--games') + 1] = '8191';
	writeJson(rawFixture.files.launch, badArgv);
	assert.throws(() => buildGuardianCompletion(context, rawFixture.args), /evaluator argv mismatch/);
	writeFileSync(rawFixture.files.launch, originalLaunch);

	const badLockHash = JSON.parse(originalLaunch);
	badLockHash.guardianExecutionLock.sha256 = 'f'.repeat(64);
	writeJson(rawFixture.files.launch, badLockHash);
	assert.throws(
		() => buildGuardianCompletion(context, rawFixture.args),
		/execution lock: SHA-256 mismatch/
	);
	writeFileSync(rawFixture.files.launch, originalLaunch);

	const retry = retryEvidence(temp, context, candidateId);
	const retryFixture = conditionFixture(
		temp,
		context,
		candidateId,
		false,
		2,
		retry.justificationPath
	);
	const retryCompletion = buildGuardianCompletion(context, retryFixture.args);
	assert.equal(retryCompletion.attempt, 2);
	assert.ok(retryCompletion.inputs.retryJustification);
	const originalFailure = readFileSync(retry.failurePath, 'utf8');
	const originalJustification = readFileSync(retry.justificationPath, 'utf8');
	const originalRetryLaunch = readFileSync(retryFixture.files.launch, 'utf8');
	const incompleteFailure = JSON.parse(originalFailure);
	delete incompleteFailure.files.stderr;
	writeJson(retry.failurePath, incompleteFailure);
	const updatedJustification = JSON.parse(originalJustification);
	updatedJustification.failureEvidence = record(retry.failurePath);
	writeJson(retry.justificationPath, updatedJustification);
	const updatedLaunch = JSON.parse(originalRetryLaunch);
	updatedLaunch.retryJustification = link(retry.justificationPath);
	writeJson(retryFixture.files.launch, updatedLaunch);
	assert.throws(
		() => buildGuardianCompletion(context, retryFixture.args),
		/failure file inventory: exact key inventory mismatch/
	);

	const immutablePath = path.join(temp, 'completion.json');
	writeImmutable(immutablePath, rawCompletion);
	assert.equal(
		readFileSync(`${immutablePath}.sha256`, 'utf8').trim(),
		`${sha256(immutablePath)}  completion.json`
	);
	assert.throws(
		() => writeImmutable(immutablePath, rawCompletion),
		/refusing to overwrite immutable output/
	);

	console.log(
		JSON.stringify({
			schemaVersion: 'arc-v34-guardian-condition-test-v1',
			passed: true,
			gamesPerValidPrimary: guardianProtocol.guardian.games,
			validCases: ['raw', 'candidate-measured-stall', 'attempt-2-infrastructure-retry'],
			rejectedCorruptions: [
				'duplicate-seed',
				'guardian-assignment',
				'raw-stall',
				'provenance',
				'source',
				'checkpoint',
				'catalog',
				'decode',
				'arm-config',
				'worker-count',
				'replay',
				'serving-reload',
				'serving-lifecycle',
				'occupied-gpu',
				'low-memory',
				'persistent-remaining-count',
				'launch-argv',
				'launch-lock-hash',
				'retry-inventory'
			],
			guardianCounts: Object.values(rawCompletion.guardians.countByName)
		})
	);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
