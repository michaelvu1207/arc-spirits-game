#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PROTOCOL =
	'ml/experiments/v34-latency-first-expert-iteration/guardian-execution-protocol.json';

const { values: args } = parseArgs({
	options: {
		repo: { type: 'string', default: defaultRoot },
		protocol: { type: 'string', default: DEFAULT_PROTOCOL },
		'base-protocol': { type: 'string' },
		'strength-protocol': { type: 'string' },
		'source-lock': { type: 'string' },
		'strength-lock': { type: 'string' },
		catalog: { type: 'string' },
		checkpoint: { type: 'string' }
	}
});

const repo = path.resolve(args.repo);
process.chdir(repo);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const assert = (condition, message) => {
	if (!condition) throw new Error(`V34 guardian protocol: ${message}`);
};
const exactKeys = (value, expected, label) => {
	assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
	assert(
		same(Object.keys(value).sort(), [...expected].sort()),
		`${label} keys changed (found ${Object.keys(value).sort().join(',')})`
	);
	return value;
};
const resolve = (raw) => path.resolve(repo, raw);
const verifyRecord = (record, label, override) => {
	exactKeys(record, ['path', 'bytes', 'sha256'], label);
	assert(typeof record.path === 'string' && record.path.length > 0, `${label} path is invalid`);
	assert(Number.isSafeInteger(record.bytes) && record.bytes >= 0, `${label} bytes are invalid`);
	assert(/^[0-9a-f]{64}$/.test(record.sha256 ?? ''), `${label} SHA-256 is invalid`);
	const file = override ? path.resolve(override) : resolve(record.path);
	assert(existsSync(file), `${label} is missing: ${file}`);
	assert(readFileSync(file).length === record.bytes, `${label} byte size changed`);
	assert(sha256(file) === record.sha256, `${label} SHA-256 changed`);
	return file;
};

const protocolPath = path.resolve(repo, args.protocol);
assert(existsSync(protocolPath), `missing ${protocolPath}`);
const protocol = exactKeys(
	readJson(protocolPath),
	[
		'schemaVersion',
		'status',
		'authoritativeStateArtifacts',
		'base',
		'environment',
		'commonDecode',
		'guardian',
		'runtime',
		'authorization',
		'result'
	],
	'root'
);
assert(protocol.schemaVersion === 'arc-v34-guardian-execution-protocol-v1', 'schema mismatch');
assert(protocol.status === 'closed' && protocol.result === null, 'protocol must remain closed');

const authoritative = exactKeys(
	protocol.authoritativeStateArtifacts,
	[
		'toolingLock',
		'authorization',
		'preflight',
		'executionLock',
		'phase2Analysis',
		'conditionsRoot',
		'historicalStrengthProtocolFlagsAreNotCurrentAuthorization'
	],
	'authoritative state'
);
for (const name of [
	'toolingLock',
	'authorization',
	'preflight',
	'executionLock',
	'phase2Analysis',
	'conditionsRoot'
]) {
	assert(typeof authoritative[name] === 'string' && authoritative[name], `${name} path is invalid`);
}
assert(
	authoritative.historicalStrengthProtocolFlagsAreNotCurrentAuthorization === true,
	'new authorization artifacts must be authoritative over historical flags'
);

const base = exactKeys(
	protocol.base,
	[
		'protocol',
		'strengthProtocol',
		'sourceLock',
		'strengthToolingLock',
		'catalog',
		'checkpoint',
		'sourceCommit'
	],
	'base'
);
assert(/^[0-9a-f]{40}$/.test(base.sourceCommit ?? ''), 'base source commit is invalid');
const baseProtocolPath = verifyRecord(base.protocol, 'base protocol', args['base-protocol']);
const strengthProtocolPath = verifyRecord(
	base.strengthProtocol,
	'strength protocol',
	args['strength-protocol']
);
const sourceLockPath = verifyRecord(base.sourceLock, 'source lock', args['source-lock']);
const strengthLockPath = verifyRecord(
	base.strengthToolingLock,
	'strength lock',
	args['strength-lock']
);
const catalogPath = verifyRecord(base.catalog, 'catalog', args.catalog);
verifyRecord(base.checkpoint, 'checkpoint', args.checkpoint);

const baseProtocol = readJson(baseProtocolPath);
const strengthProtocol = readJson(strengthProtocolPath);
const sourceLock = readJson(sourceLockPath);
const strengthLock = readJson(strengthLockPath);
const catalog = readJson(catalogPath);
assert(
	baseProtocol.schemaVersion === 'arc-controlled-experiment-v1',
	'base protocol schema mismatch'
);
assert(
	strengthProtocol.schemaVersion === 'arc-v34-strength-protocol-v1',
	'strength protocol schema mismatch'
);
assert(sourceLock.schemaVersion === 'arc-v34-source-lock-v1', 'source lock schema mismatch');
assert(
	strengthLock.schemaVersion === 'arc-v34-strength-tooling-lock-v1',
	'strength lock schema mismatch'
);
assert(
	strengthLock.implementationCommit === base.sourceCommit,
	'source commit differs from strength lock'
);
assert(
	strengthProtocol.authorization?.guardianSeedsOpen === false &&
		strengthProtocol.guardianResult === null &&
		strengthLock.authorization?.guardianSeedsOpen === false,
	'historical guardian flags were not closed at creation'
);

const environment = exactKeys(
	protocol.environment,
	['executable', 'python', 'numpy', 'rng'],
	'environment'
);
assert(
	environment.executable === 'ml/v34_stats_env/.venv/bin/python' &&
		environment.python === strengthProtocol.environment?.python &&
		environment.numpy === strengthProtocol.environment?.numpy &&
		environment.rng === 'numpy.random.Generator(PCG64)',
	'analysis runtime differs from the pinned strength runtime'
);
assert(
	same(protocol.commonDecode, strengthProtocol.commonDecode),
	'common decode differs from Phase 2'
);

const guardian = exactKeys(
	protocol.guardian,
	[
		'status',
		'seed0',
		'games',
		'seedMax',
		'referenceArm',
		'registeredCandidateSlots',
		'guardians',
		'assignment',
		'replayAudit',
		'family',
		'gates',
		'selection',
		'guardianOutcomesMayReorderPhase2Ranking',
		'poolPhase2Outcomes'
	],
	'guardian'
);
assert(
	guardian.status === 'closed' &&
		guardian.seed0 === 957300000 &&
		guardian.games === 8192 &&
		guardian.seedMax === 957308191 &&
		guardian.referenceArm === 'raw',
	'guardian seed/reference contract changed'
);
assert(
	same(guardian.registeredCandidateSlots, strengthProtocol.phase2?.registeredCandidateSlots),
	'registered arm family changed'
);
const catalogGuardians = catalog.guardians.map(({ id, name }) => ({ id, name }));
assert(
	same(guardian.guardians, catalogGuardians) &&
		same(guardian.guardians, strengthProtocol.guardian?.guardiansFromFrozenCatalog),
	'guardian order differs from the frozen catalog'
);
assert(
	guardian.assignment?.algorithm ===
		'guardianIndexForSeed(seed, guardianCount) = seed % guardianCount' &&
		guardian.assignment?.dependsOnlyOnEngineSeed === true &&
		same(
			guardian.assignment?.expectedCountsInGuardianOrder,
			[820, 820, 819, 819, 819, 819, 819, 819, 819, 819]
		),
	'guardian assignment contract changed'
);
assert(
	same(guardian.replayAudit, {
		seed0: 957300000,
		games: 64,
		seedMax: 957300063,
		workers: 8,
		sameInferenceProcess: true,
		exactPerGameEqualityBySeed: true
	}),
	'guardian replay contract changed'
);
assert(
	guardian.family?.draws === 10000 &&
		guardian.family?.rngSeed === 34032026 &&
		guardian.family?.confidence === 0.95 &&
		guardian.family?.maximumArms === 6 &&
		guardian.family?.guardians === 10 &&
		guardian.family?.maximumFamilySize === 60 &&
		guardian.family?.studentization ===
			't_be=(bootstrapMean_be-observedMean_e)/originalPairedSE_e' &&
		guardian.family?.criticalFloor === 'NormalDist().inv_cdf(1 - 0.05 / 60)' &&
		guardian.family?.emptyBootstrapCellRule === 'abort analysis',
	'guardian simultaneous family changed'
);
assert(
	guardian.gates?.everyCellPointDeltaPointsMin ===
		strengthProtocol.guardian?.gates?.everyCellPointDeltaPointsMin &&
		guardian.gates?.everyCellSimultaneousLowerStrictlyAbovePoints ===
			strengthProtocol.guardian?.gates?.everyCellSimultaneousLowerStrictlyAbovePoints &&
		guardian.gates?.candidateMeasuredStalls === 0 &&
		guardian.gates?.rawMeasuredStalls === 0 &&
		guardian.gates?.safetyAndProvenanceFailures === 0,
	'guardian gates changed'
);
assert(
	same(guardian.selection, strengthProtocol.phase2?.selectionAfterGuardian) &&
		guardian.guardianOutcomesMayReorderPhase2Ranking === false &&
		guardian.poolPhase2Outcomes === false,
	'guardian selection or independence rule changed'
);

const runtime = protocol.runtime;
assert(
	same(runtime.eligibleGpus, [0, 5, 6, 7]) &&
		runtime.excludedGpu === 4 &&
		runtime.rawWorkers === 24 &&
		runtime.maxConcurrentConditions === 3 &&
		runtime.maxActorWorkers === 96 &&
		runtime.nice === 19 &&
		runtime.watchdogSeconds === 46800 &&
		runtime.watchdogKillAfterSeconds === 60 &&
		runtime.replayWatchdogSeconds === 1800 &&
		runtime.minimumScratchFreeBytes === 16 * 1024 ** 3 &&
		runtime.persistentBytesPerRemainingCondition === 1024 ** 3 &&
		runtime.minimumPersistentFreeBytes === 2 * 1024 ** 3 &&
		runtime.minimumAvailableMemoryBytes === 64 * 1024 ** 3 &&
		runtime.resourceChecksBeforeAttemptCreation === true &&
		runtime.cpuLoadBinding === false &&
		runtime.attemptsMax === 2 &&
		runtime.attemptSplicing === false &&
		same(runtime.retryableFailureCodes, { 'server-start': 90, 'process-interrupted': 92 }) &&
		runtime.retryRequiresPrelaunchOutcomeBlindJustification === true &&
		runtime.retryForbiddenAfterPrimaryOrReplayReportExists === true,
	'guardian runtime/retry contract changed'
);
assert(
	same(protocol.authorization, {
		guardianExecutionOpen: false,
		teacherSeedsOpen: false,
		finalDevelopmentSeedsOpen: false,
		hiddenSeedsOpen: false,
		multiplayerSeedsOpen: false,
		humanReferenceSeedsOpen: false,
		productionPromotionOpen: false
	}),
	'guardian protocol must not open any seed family'
);

console.log(
	JSON.stringify({
		schemaVersion: 'arc-v34-guardian-protocol-validation-v1',
		valid: true,
		protocol: {
			path: path.relative(repo, protocolPath),
			bytes: readFileSync(protocolPath).length,
			sha256: sha256(protocolPath)
		},
		historicalStrengthProtocolFlagsIgnoredForCurrentAuthorization: true
	})
);
