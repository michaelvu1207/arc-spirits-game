#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const protocolPath = 'ml/experiments/v34-latency-first-expert-iteration/strength-protocol.json';
const protocol = JSON.parse(readFileSync(protocolPath, 'utf8'));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = (message) => {
	throw new Error(`V34 strength protocol: ${message}`);
};
if (
	protocol.schemaVersion !== 'arc-v34-strength-protocol-v1' ||
	protocol.status !== 'closed' ||
	protocol.strengthToolingLockRequired !== true
) {
	fail('schema or initial status changed');
}
for (const [pathKey, hashKey] of [
	['protocolPath', 'protocolSha256'],
	['sourceLockPath', 'sourceLockSha256'],
	['catalogPath', 'catalogSha256'],
	['checkpointPath', 'checkpointSha256']
]) {
	if (sha256(protocol.base[pathKey]) !== protocol.base[hashKey]) {
		fail(`base hash mismatch: ${pathKey}`);
	}
}
const baseProtocol = JSON.parse(readFileSync(protocol.base.protocolPath, 'utf8'));
if (
	protocol.phase2.seed0 !== baseProtocol.phase2.seed0 ||
	protocol.phase2.games !== baseProtocol.phase2.games ||
	protocol.phase2.seedMax !== baseProtocol.phase2.seedMax ||
	protocol.guardian.seed0 !== baseProtocol.guardianConfirmation.seed0 ||
	protocol.guardian.games !== baseProtocol.guardianConfirmation.games ||
	protocol.guardian.seedMax !== baseProtocol.guardianConfirmation.seedMax
) {
	fail('registered seed ranges diverge from the locked base protocol');
}
const expectedSlots = [
	'rerank-p025',
	'rerank-p050',
	'rerank-p075',
	'rerank-p100',
	'heuristic-s4-h2',
	'heuristic-s8-h3'
];
if (
	JSON.stringify(protocol.phase2.registeredCandidateSlots) !== JSON.stringify(expectedSlots) ||
	JSON.stringify(protocol.phase2.registeredCandidateSlots) !==
		JSON.stringify(baseProtocol.phase2.registeredCandidateSlots)
) {
	fail('registered candidate slots changed');
}
const expectedAuthorization = {
	phase2SeedsOpen: false,
	guardianSeedsOpen: false,
	teacherSeedsOpen: false,
	finalDevelopmentSeedsOpen: false,
	hiddenSeedsOpen: false,
	multiplayerSeedsOpen: false,
	humanReferenceSeedsOpen: false,
	productionPromotionOpen: false
};
if (!same(protocol.authorization, expectedAuthorization)) {
	fail('initial authorization must remain fully closed');
}
if (
	protocol.environment.executable !== 'ml/v34_stats_env/.venv/bin/python' ||
	protocol.environment.python !== '3.12.8' ||
	protocol.environment.numpy !== '2.5.0' ||
	protocol.environment.rng !== 'numpy.random.Generator(PCG64)' ||
	protocol.environment.exactFixtureRequired !== true
) {
	fail('pinned statistical environment changed');
}
const environment = JSON.parse(
	execFileSync(
		protocol.environment.executable,
		[
			'-c',
			'import json,platform,numpy;print(json.dumps({"python":platform.python_version(),"numpy":numpy.__version__}))'
		],
		{ encoding: 'utf8' }
	)
);
if (
	environment.python !== protocol.environment.python ||
	environment.numpy !== protocol.environment.numpy
) {
	fail(`runtime mismatch: ${JSON.stringify(environment)}`);
}
const expectedDecode = {
	seats: 1,
	maxRounds: 30,
	maxStatusLevel: 2,
	guardianSchedule: 'absolute-balanced',
	selection: 'hybrid',
	sample: true,
	temperature: 0.55,
	learnMonsterRewardChoices: false,
	obsVersion: 1,
	policyObsVersion: 2,
	inferenceWire: 'binary'
};
if (!same(protocol.commonDecode, expectedDecode)) fail('common decode changed');
const expectedRuntime = {
	eligibleGpus: [0, 5, 6, 7],
	excludedGpu: 4,
	rawWorkers: 24,
	maxConcurrentConditions: 3,
	maxActorWorkers: 96,
	nice: 19,
	minimumScratchFreeBytes: 17179869184,
	attemptsMax: 2,
	attemptSplicing: false,
	retryRequiresPrelaunchOutcomeBlindJustification: true,
	retryForbiddenAfterOutcomeReportExists: true
};
if (!same(protocol.runtime, expectedRuntime)) {
	fail('runtime or retry safety contract changed');
}
const expectedPhase2Family = {
	method: 'complete-seed centered paired max-t bootstrap with 24-endpoint Bonferroni-normal floor',
	draws: 10000,
	rngSeed: 34022026,
	candidateSlots: 6,
	outcomesPerSlot: 4,
	familySize: 24,
	confidence: 0.95,
	nearestRankIndex: 'ceil(0.95 * 10000) - 1',
	studentization: 't_be=(bootstrapMean_be-observedMean_e)/originalPairedSE_e',
	drawMaximum: 'max absolute t_be across observed nonzero-SE endpoints',
	criticalFloor: 'NormalDist().inv_cdf(1 - 0.05 / (2 * 24))',
	zeroSeRule: 'exclude from max statistic and pass only if point estimate satisfies gate',
	systemsRejectedSlotsRemainFailed: true
};
const expectedPhase2Gates = {
	winPointGainMin: 3,
	winSimultaneousLowerStrictlyAbove: 0,
	finalVpSimultaneousLowerMin: -0.5,
	post15SimultaneousLowerMin: -0.025,
	censoredFirst30SimultaneousUpperMax: 0.5,
	stalls: 0,
	informationSafetyFailures: 0,
	replayMismatches: 0,
	servingErrors: 0,
	evaluationProvenanceMismatches: 0,
	bindingEvidenceHashesMustMatch: true
};
const expectedReplayAudit = {
	seed0: 957000000,
	games: 64,
	seedMax: 957000063,
	workers: 8,
	exactPerGameEquality: true,
	sameInferenceProcess: true
};
const expectedIntegrityEvidence = {
	informationSafety:
		'hash-bound passing actions.informationSafety and determinization preflight evidence',
	replay:
		'preflight 24-vs-8-worker preview-seed scheduling audit plus exact same-process rerun of the registered 64-seed Phase 2 prefix, compared by seed',
	serving:
		'one fixed inference process, one serving line, one shutdown line, zero error or reload lines',
	provenance:
		'source-locked evaluator accepts only one served-checkpoint handshake across all 4096 game summaries; request statistics use one fixed no-reload process'
};
if (
	protocol.phase2.status !== 'closed' ||
	protocol.phase2.referenceArm !== 'raw' ||
	!same(protocol.phase2.outcomes, [
		'winPoints',
		'finalVp',
		'post15VpPerRound',
		'censoredFirst30Round'
	]) ||
	!same(protocol.phase2.family, expectedPhase2Family) ||
	!same(protocol.phase2.gates, expectedPhase2Gates) ||
	!same(protocol.phase2.replayAudit, expectedReplayAudit) ||
	!same(protocol.phase2.integrityEvidence, expectedIntegrityEvidence) ||
	!same(protocol.phase2.selectionAfterGuardian, [
		'largest phase2 paired win gain among guardian survivors',
		'lower 8-worker binding p95',
		'lexicographically smaller arm id'
	])
) {
	fail('Phase 2 statistic or gates changed');
}
const catalog = JSON.parse(readFileSync(protocol.base.catalogPath, 'utf8'));
const catalogGuardians = catalog.guardians.map(({ id, name }) => ({ id, name }));
if (
	sha256(protocol.base.catalogPath) !== protocol.base.catalogSha256 ||
	!same(protocol.guardian.guardiansFromFrozenCatalog, catalogGuardians)
) {
	fail('guardian order does not match the frozen catalog');
}
const expectedGuardianFamily = {
	method:
		'complete-seed centered paired one-sided max-t bootstrap with 60-cell Bonferroni-normal floor',
	draws: 10000,
	rngSeed: 34032026,
	maximumArms: 6,
	guardians: 10,
	maximumFamilySize: 60,
	confidence: 0.95,
	criticalFloor: 'NormalDist().inv_cdf(1 - 0.05 / 60)'
};
const expectedGuardianGates = {
	everyCellPointDeltaPointsMin: -5,
	everyCellSimultaneousLowerStrictlyAbovePoints: -10,
	stalls: 0,
	safetyAndProvenanceFailures: 0
};
if (
	protocol.guardian.status !== 'closed' ||
	protocol.guardian.assignmentInvariant !==
		'guardian identity is a deterministic function of engine seed only and identical in every condition' ||
	!same(protocol.guardian.family, expectedGuardianFamily) ||
	!same(protocol.guardian.gates, expectedGuardianGates) ||
	protocol.guardian.phase2LeaderFailureRule !==
		'select the highest phase2-ranked guardian survivor; close Lane A if none survive'
) {
	fail('guardian statistic, gates, or selection rule changed');
}
if (protocol.phase2Result !== null || protocol.guardianResult !== null) {
	fail('initial result fields must be null');
}
console.log(
	JSON.stringify({
		schemaVersion: 'arc-v34-strength-protocol-validation-v1',
		valid: true,
		protocolSha256: sha256(protocolPath),
		environment
	})
);
