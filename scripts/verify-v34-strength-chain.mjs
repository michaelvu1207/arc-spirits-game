#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { V34_STRENGTH_TOOLING_FILES } from './v34-strength-tooling-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const mode = process.argv[2];
if (mode !== 'evidence' && mode !== 'preflight' && mode !== 'phase2') {
	throw new Error('usage: verify-v34-strength-chain.mjs evidence|preflight|phase2');
}

const experiment = 'ml/experiments/v34-latency-first-expert-iteration';
const artifacts = `${experiment}/artifacts`;
const baseProtocolPath = `${experiment}/protocol.json`;
const strengthProtocolPath = `${experiment}/strength-protocol.json`;
const sourceLockPath = `${artifacts}/source-lock.json`;
const systemsEligibilityPath = `${artifacts}/systems-eligibility.json`;
const phase2AuthorizationPath = `${artifacts}/phase2-authorization.json`;
const strengthPreflightPath = `${artifacts}/strength-preflight/result.json`;
const strengthLockPath = `${artifacts}/strength-tooling-lock.json`;
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = (message) => {
	throw new Error(`V34 strength chain: ${message}`);
};
const requireFileHash = (record, label) => {
	if (
		!record ||
		typeof record.path !== 'string' ||
		!/^[0-9a-f]{64}$/.test(record.sha256 ?? '') ||
		!existsSync(record.path) ||
		sha256(record.path) !== record.sha256
	) {
		fail(`${label} file/hash mismatch`);
	}
};

execFileSync(process.execPath, ['scripts/verify-v34-source-lock.mjs', sourceLockPath], {
	stdio: 'ignore'
});
execFileSync(process.execPath, ['scripts/verify-v34-authorization-chain.mjs', 'systems'], {
	stdio: 'ignore'
});
execFileSync(process.execPath, ['scripts/validate-v34-strength-protocol.mjs'], {
	stdio: 'ignore'
});

const baseProtocol = JSON.parse(readFileSync(baseProtocolPath, 'utf8'));
const strengthProtocol = JSON.parse(readFileSync(strengthProtocolPath, 'utf8'));
const systemsAuthorizationPath = `${artifacts}/systems-authorization.json`;
const systemsAuthorization = JSON.parse(readFileSync(systemsAuthorizationPath, 'utf8'));
const systemsEligibility = JSON.parse(readFileSync(systemsEligibilityPath, 'utf8'));
const phase2Authorization = JSON.parse(readFileSync(phase2AuthorizationPath, 'utf8'));

if (
	systemsEligibility.schemaVersion !== 'arc-v34-systems-eligibility-v1' ||
	systemsEligibility.strengthUse !== false ||
	systemsEligibility.outcomesLoaded !== false ||
	systemsEligibility.phase2MayOpen !== true ||
	systemsEligibility.protocol?.path !== baseProtocolPath ||
	systemsEligibility.protocol?.sha256 !== sha256(baseProtocolPath) ||
	systemsEligibility.systemsAuthorization?.path !== systemsAuthorizationPath ||
	systemsEligibility.systemsAuthorization?.sha256 !== sha256(systemsAuthorizationPath)
) {
	fail('systems eligibility header or authorization binding invalid');
}

const registered = strengthProtocol.phase2.registeredCandidateSlots;
if (
	!Array.isArray(systemsEligibility.arms) ||
	systemsEligibility.arms.length !== registered.length ||
	!same(
		systemsEligibility.arms.map((arm) => arm.id),
		registered
	)
) {
	fail('systems eligibility arm registry changed');
}

const expectedEligible = [];
for (const arm of systemsEligibility.arms) {
	if (!systemsAuthorization.enabledCandidateArms.includes(arm.id)) {
		const expectedDisabled = {
			id: arm.id,
			enabledBeforeSystems: false,
			operationallyEligible: false,
			rejectionReason: systemsAuthorization.disabledCandidateArms?.[arm.id]
		};
		if (!same(arm, expectedDisabled) || typeof arm.rejectionReason !== 'string') {
			fail(`pre-systems disabled arm record invalid: ${arm.id}`);
		}
		continue;
	}
	if (!Array.isArray(arm.stageReports) || arm.stageReports.length === 0) {
		fail(`enabled systems arm lacks stage evidence: ${arm.id}`);
	}
	const specs = [
		{ stage: 'smoke', games: baseProtocol.systems.smoke.games, workers: 1 },
		...baseProtocol.systems.binding.map((spec) => ({
			stage: `binding-w${spec.workers}`,
			games: spec.games,
			workers: spec.workers
		})),
		...baseProtocol.systems.throughput.workerCounts.map((workers) => ({
			stage: `throughput-w${workers}`,
			games: baseProtocol.systems.throughput.games,
			workers
		}))
	];
	const reports = [];
	let rejectionReason = null;
	for (let index = 0; index < arm.stageReports.length; index += 1) {
		const spec = specs[index];
		if (!spec || rejectionReason !== null) {
			fail(`systems arm has stage evidence after semantic rejection: ${arm.id}`);
		}
		const report = arm.stageReports[index];
		requireFileHash(report, `${arm.id} ${spec.stage}`);
		const parsed = JSON.parse(readFileSync(report.path, 'utf8'));
		if (
			parsed.schemaVersion !== 'arc-v34-systems-stage-v1' ||
			parsed.arm !== arm.id ||
			parsed.stage !== spec.stage ||
			parsed.games !== spec.games ||
			parsed.workers !== spec.workers ||
			parsed.seed0 !== baseProtocol.systems.seed0 ||
			parsed.seedMax !== baseProtocol.systems.seed0 + spec.games - 1 ||
			parsed.strengthUse !== false ||
			parsed.outcomesLoaded !== false
		) {
			fail(`systems stage header invalid: ${report.path}`);
		}
		for (const [input, label] of [
			[parsed.inputs?.protocol, 'protocol'],
			[parsed.inputs?.benchmark, 'benchmark'],
			[parsed.inputs?.progress, 'progress']
		]) {
			requireFileHash(input, `${arm.id} ${spec.stage} ${label}`);
		}
		const verifyDir = mkdtempSync(path.join(tmpdir(), 'arc-v34-stage-'));
		const regeneratedPath = path.join(verifyDir, 'stage-report.json');
		try {
			execFileSync(
				process.execPath,
				[
					'scripts/record-v34-systems-stage.mjs',
					'--arm',
					arm.id,
					'--stage',
					spec.stage,
					'--benchmark',
					parsed.inputs.benchmark.path,
					'--progress',
					parsed.inputs.progress.path,
					'--out',
					regeneratedPath
				],
				{ stdio: 'ignore' }
			);
			const regenerated = JSON.parse(readFileSync(regeneratedPath, 'utf8'));
			if (!same(regenerated, parsed)) fail(`systems stage cannot be reproduced: ${report.path}`);
		} finally {
			rmSync(verifyDir, { recursive: true, force: true });
		}
		reports.push(parsed);
		if (parsed.eligible !== true) {
			if (typeof parsed.rejectionReason !== 'string' || parsed.rejectionReason.length === 0) {
				fail(`failed systems stage lacks a reason: ${report.path}`);
			}
			rejectionReason = parsed.rejectionReason;
		}
	}
	if (rejectionReason === null && reports.length !== specs.length) {
		fail(`systems arm is missing a required stage before eligibility: ${arm.id}`);
	}
	const throughput = reports.filter((report) => report.stage.startsWith('throughput-'));
	let selectedWorkers = null;
	let peakGamesPerSecond = null;
	let projected4096Seconds = null;
	if (rejectionReason === null) {
		peakGamesPerSecond = Math.max(...throughput.map((report) => report.gamesPerSecond));
		selectedWorkers = throughput
			.filter((report) => report.gamesPerSecond >= peakGamesPerSecond * 0.95)
			.map((report) => report.workers)
			.sort((left, right) => left - right)[0];
		projected4096Seconds = throughput.find(
			(report) => report.workers === selectedWorkers
		).projected4096Seconds;
		if (projected4096Seconds > baseProtocol.systems.throughput.projected4096SecondsMax) {
			rejectionReason = 'selected throughput projection exceeds 21600s';
		}
	}
	const reconstructed = {
		id: arm.id,
		enabledBeforeSystems: true,
		operationallyEligible: rejectionReason === null,
		rejectionReason,
		selectedWorkers,
		peakGamesPerSecond,
		projected4096Seconds,
		binding: Object.fromEntries(
			reports
				.filter((report) => report.stage.startsWith('binding-'))
				.map((report) => [report.stage, report.decisionWallMsP95])
		),
		stageReports: arm.stageReports
	};
	if (!same(arm, reconstructed))
		fail(`systems eligibility summary cannot be reconstructed: ${arm.id}`);
	if (arm.operationallyEligible) {
		if (reports.some((report) => report.stalls !== 0)) {
			fail(`eligible systems arm contains a stalled stage: ${arm.id}`);
		}
		expectedEligible.push(arm.id);
	}
}
if (
	expectedEligible.length === 0 ||
	!same(expectedEligible, systemsEligibility.eligibleCandidateArms)
) {
	fail('systems eligible arm list invalid');
}

const expectedPhase2Authorization = {
	phase2SeedsOpen: true,
	guardianSeedsOpen: false,
	teacherSeedsOpen: false,
	finalDevelopmentSeedsOpen: false,
	hiddenSeedsOpen: false,
	multiplayerSeedsOpen: false,
	humanReferenceSeedsOpen: false,
	productionPromotionOpen: false
};
const expectedStrengthLockAuthorization = {
	phase2ExecutionOpen: true,
	guardianSeedsOpen: false,
	teacherSeedsOpen: false,
	finalDevelopmentSeedsOpen: false,
	hiddenSeedsOpen: false,
	multiplayerSeedsOpen: false,
	humanReferenceSeedsOpen: false,
	productionPromotionOpen: false
};
if (
	phase2Authorization.schemaVersion !== 'arc-v34-phase2-authorization-v1' ||
	phase2Authorization.systemsEligibility?.path !== systemsEligibilityPath ||
	phase2Authorization.systemsEligibility?.sha256 !== sha256(systemsEligibilityPath) ||
	!same(phase2Authorization.registeredFamilyCandidateSlots, registered) ||
	!same(phase2Authorization.eligibleCandidateArms, expectedEligible) ||
	!same(phase2Authorization.authorization, expectedPhase2Authorization)
) {
	fail('Phase 2 authorization invalid');
}

if (mode === 'evidence') {
	console.log(
		JSON.stringify({
			schemaVersion: 'arc-v34-strength-chain-verification-v1',
			mode,
			valid: true,
			eligibleCandidateArms: expectedEligible
		})
	);
	process.exit(0);
}

const strengthPreflight = JSON.parse(readFileSync(strengthPreflightPath, 'utf8'));
const expectedPreflightChecks = [
	'sourceLock',
	'evidenceChain',
	'strengthProtocol',
	'pythonFixtures',
	'recorderFixtures',
	'replayDeterminism',
	'vitest',
	'typecheck',
	'nodeSyntax',
	'shellSyntax',
	'determinization',
	'resources'
].sort();
const expectedPreflightKeys = [
	'schemaVersion',
	'implementationCommit',
	'baseSourceLock',
	'strengthProtocol',
	'systemsEligibility',
	'phase2Authorization',
	'toolingFiles',
	'environment',
	'resources',
	'checks',
	'passed',
	'recordedAt'
].sort();
const expectedResourceKeys = [
	'schemaVersion',
	'scratchFreeBytes',
	'scratchRequiredBytes',
	'persistentFreeBytes',
	'persistentRequiredBytes',
	'eligibleGpus',
	'excludedGpu',
	'freeEligibleGpus',
	'gpuProbeError',
	'passed'
].sort();
for (const [record, expectedPath, label] of [
	[strengthPreflight.baseSourceLock, sourceLockPath, 'preflight base source lock'],
	[strengthPreflight.strengthProtocol, strengthProtocolPath, 'preflight strength protocol'],
	[strengthPreflight.systemsEligibility, systemsEligibilityPath, 'preflight systems eligibility'],
	[
		strengthPreflight.phase2Authorization,
		phase2AuthorizationPath,
		'preflight Phase 2 authorization'
	]
]) {
	if (record?.path !== expectedPath) fail(`${label} path changed`);
	requireFileHash(record, label);
}
if (
	strengthPreflight.schemaVersion !== 'arc-v34-strength-preflight-evidence-v1' ||
	strengthPreflight.passed !== true ||
	!same(Object.keys(strengthPreflight).sort(), expectedPreflightKeys) ||
	!/^[0-9a-f]{40}$/.test(strengthPreflight.implementationCommit ?? '') ||
	strengthPreflight.baseSourceLock?.sha256 !== sha256(sourceLockPath) ||
	strengthPreflight.strengthProtocol?.sha256 !== sha256(strengthProtocolPath) ||
	strengthPreflight.systemsEligibility?.sha256 !== sha256(systemsEligibilityPath) ||
	strengthPreflight.phase2Authorization?.sha256 !== sha256(phase2AuthorizationPath) ||
	!same(strengthPreflight.environment, {
		python: strengthProtocol.environment.python,
		numpy: strengthProtocol.environment.numpy
	}) ||
	strengthPreflight.resources?.passed !== true ||
	strengthPreflight.resources?.schemaVersion !== 'arc-v34-strength-resource-preflight-v1' ||
	!same(Object.keys(strengthPreflight.resources ?? {}).sort(), expectedResourceKeys) ||
	strengthPreflight.resources?.scratchFreeBytes <
		strengthPreflight.resources?.scratchRequiredBytes ||
	strengthPreflight.resources?.persistentFreeBytes <
		strengthPreflight.resources?.persistentRequiredBytes ||
	strengthPreflight.resources?.scratchRequiredBytes !==
		strengthProtocol.runtime.minimumScratchFreeBytes ||
	strengthPreflight.resources?.persistentRequiredBytes !==
		(1 + expectedEligible.length) * 1024 ** 3 ||
	!same(strengthPreflight.resources?.eligibleGpus, strengthProtocol.runtime.eligibleGpus) ||
	strengthPreflight.resources?.excludedGpu !== strengthProtocol.runtime.excludedGpu ||
	strengthPreflight.resources?.gpuProbeError !== null ||
	!Array.isArray(strengthPreflight.resources?.freeEligibleGpus) ||
	strengthPreflight.resources.freeEligibleGpus.length === 0 ||
	strengthPreflight.resources.freeEligibleGpus.includes(strengthProtocol.runtime.excludedGpu) ||
	!same(Object.keys(strengthPreflight.toolingFiles ?? {}).sort(), V34_STRENGTH_TOOLING_FILES) ||
	!same(Object.keys(strengthPreflight.checks ?? {}).sort(), expectedPreflightChecks)
) {
	fail('strength-tooling preflight header, resources, or inventory invalid');
}
for (const file of V34_STRENGTH_TOOLING_FILES) {
	if (sha256(file) !== strengthPreflight.toolingFiles[file]) {
		fail(`strength-tooling preflight source mismatch: ${file}`);
	}
}
for (const [name, check] of Object.entries(strengthPreflight.checks)) {
	if (
		!same(Object.keys(check ?? {}).sort(), ['exitCode', 'log', 'logSha256']) ||
		check.exitCode !== 0 ||
		typeof check.log !== 'string' ||
		!existsSync(check.log) ||
		sha256(check.log) !== check.logSha256
	) {
		fail(`strength-tooling preflight check invalid: ${name}`);
	}
}
const replayAuditPath = path.join(
	path.dirname(strengthPreflightPath),
	'replay-determinism-audit.json'
);
const replayAudit = JSON.parse(readFileSync(replayAuditPath, 'utf8'));
const replayLogValue = JSON.parse(
	readFileSync(strengthPreflight.checks.replayDeterminism.log, 'utf8').trim().split(/\r?\n/).at(-1)
);
if (
	!same(replayAudit, replayLogValue) ||
	replayAudit.schemaVersion !== 'arc-v34-replay-determinism-preflight-v1' ||
	replayAudit.passed !== true ||
	replayAudit.implementationCommit !== strengthPreflight.implementationCommit ||
	!strengthProtocol.runtime.eligibleGpus.includes(replayAudit.gpu) ||
	replayAudit.gpu === strengthProtocol.runtime.excludedGpu ||
	replayAudit.seed0 !== baseProtocol.previewCalibration.seed0 ||
	replayAudit.games !== 64 ||
	replayAudit.primaryWorkers !== strengthProtocol.runtime.rawWorkers ||
	replayAudit.replayWorkers !== strengthProtocol.phase2.replayAudit.workers ||
	replayAudit.sameInferenceProcess !== true ||
	replayAudit.comparedBySeed !== true ||
	replayAudit.mismatches !== 0 ||
	replayAudit.checkpointSha256 !== strengthProtocol.base.checkpointSha256 ||
	replayAudit.catalogSha256 !== strengthProtocol.base.catalogSha256 ||
	replayAudit.inference?.weightsSha256 !== strengthProtocol.base.checkpointSha256 ||
	!same(replayAudit.lifecycle, {
		servingLines: 1,
		shutdownLines: 1,
		reloadLines: 0,
		errorLines: 0
	})
) {
	fail('replay-determinism preflight evidence is malformed or failed');
}
if (existsSync('.git')) {
	execFileSync('git', [
		'merge-base',
		'--is-ancestor',
		strengthPreflight.implementationCommit,
		'HEAD'
	]);
}
if (mode === 'preflight') {
	console.log(
		JSON.stringify({
			schemaVersion: 'arc-v34-strength-chain-verification-v1',
			mode,
			valid: true,
			implementationCommit: strengthPreflight.implementationCommit,
			eligibleCandidateArms: expectedEligible
		})
	);
	process.exit(0);
}

const strengthLock = JSON.parse(readFileSync(strengthLockPath, 'utf8'));
const expectedStrengthLockKeys = [
	'schemaVersion',
	'implementationCommit',
	'baseSourceLock',
	'strengthProtocol',
	'systemsEligibility',
	'phase2Authorization',
	'strengthPreflight',
	'files',
	'environment',
	'eligibleCandidateArms',
	'authorization',
	'createdAt'
].sort();
if (
	strengthLock.schemaVersion !== 'arc-v34-strength-tooling-lock-v1' ||
	!/^[0-9a-f]{40}$/.test(strengthLock.implementationCommit ?? '') ||
	!same(Object.keys(strengthLock).sort(), expectedStrengthLockKeys)
) {
	fail('strength-tooling lock header invalid');
}
if (existsSync('.git')) {
	execFileSync('git', ['merge-base', '--is-ancestor', strengthLock.implementationCommit, 'HEAD']);
}
if (!same(Object.keys(strengthLock.files ?? {}).sort(), V34_STRENGTH_TOOLING_FILES)) {
	fail('strength-tooling lock file inventory changed');
}
for (const [file, expected] of Object.entries(strengthLock.files)) {
	if (!existsSync(file) || sha256(file) !== expected) {
		fail(`strength-tooling source mismatch: ${file}`);
	}
}
for (const [record, expectedPath, label] of [
	[strengthLock.baseSourceLock, sourceLockPath, 'base source lock'],
	[strengthLock.strengthProtocol, strengthProtocolPath, 'strength protocol'],
	[strengthLock.systemsEligibility, systemsEligibilityPath, 'systems eligibility'],
	[strengthLock.phase2Authorization, phase2AuthorizationPath, 'Phase 2 authorization'],
	[strengthLock.strengthPreflight, strengthPreflightPath, 'strength preflight']
]) {
	if (record?.path !== expectedPath) fail(`${label} path changed`);
	requireFileHash(record, label);
}
if (
	strengthLock.environment?.python !== strengthProtocol.environment.python ||
	strengthLock.environment?.numpy !== strengthProtocol.environment.numpy ||
	strengthLock.implementationCommit !== strengthPreflight.implementationCommit ||
	!same(strengthLock.eligibleCandidateArms, expectedEligible) ||
	!same(strengthLock.authorization, expectedStrengthLockAuthorization)
) {
	fail('strength-tooling environment, arm set, or authorization changed');
}

console.log(
	JSON.stringify({
		schemaVersion: 'arc-v34-strength-chain-verification-v1',
		mode,
		valid: true,
		implementationCommit: strengthLock.implementationCommit,
		eligibleCandidateArms: expectedEligible,
		files: Object.keys(strengthLock.files ?? {}).length
	})
);
