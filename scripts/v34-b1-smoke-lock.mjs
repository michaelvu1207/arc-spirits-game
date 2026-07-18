#!/usr/bin/env node
/**
 * Outcome-blind authorization-basis and execution-lock tooling for the V34 B1 density smoke.
 *
 * This module never starts a process, touches a GPU/object store, consumes a game seed, or reads a
 * collection/target artifact.  It only records and verifies immutable inputs and absent output paths.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateStoragePreflightReport } from './run-v34-b1-storage-preflight.mjs';

export const BASIS_SCHEMA = 'arc-v34-b1-smoke-authorization-basis-v1';
export const EXECUTION_LOCK_SCHEMA = 'arc-v34-b1-density-smoke-execution-lock-v1';
export const STORAGE_PREFLIGHT_SCHEMA = 'arc-v34-b1-storage-preflight-v1';
export const STRICT_ENVIRONMENT_PREFLIGHT_SCHEMA = 'arc-v34-b1-strict-environment-preflight-v1';
export const REVIEWED_PLAN_COMMIT = 'e1e406f60cc98da91e48d4b1c0ea83b98921aa2a';
export const PARENT_ADAPTER_COMMIT = '0dff1943653f61a37e653b7674c073ab1e70f700';
export const SOURCE_IMPLEMENTATION_COMMIT = 'ff2aa7cc4e69f0f7da530a0d0df418c26839314e';
export const STRENGTH_LOCK_SHA256 =
	'e04b20c3734ad3f920626057e106f6d761a2cdf055449740d8275e08cd12ad78';
export const LANE_B_PROTOCOL_CANONICAL_SHA256 =
	'7ead5625ec12f02c8afda2c03d5c5c56c5d227b3b5dce78bcb76d58a085c3a83';
export const PARENT_CHECKPOINT_SHA256 =
	'aeb254c20367029696da1e6ca823b96187191140056d646a7c2d3d47ec4e567b';
export const PARENT_MANIFEST_SHA256 =
	'fe21b3adfc1b688515dc3a3d2de0d7a6defa611728aac0ccbdfb79bf36678fad';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPERIMENT = 'ml/experiments/v34-latency-first-expert-iteration';
const SHA256_RE = /^[0-9a-f]{64}$/;
const EXACT_HOST = 'ubuntu@216.151.21.122';
const EXACT_ARTIFACT_ROOT = '/data/share8/michaelvuaprilexperimentation/arc-bot';
const STORAGE_PREFIX_TEMPLATE = 'arc-spirits/v34/lane-b/<authorization-basis-sha256>/';
const EXACT_PROBE_BYTES = 16 * 1024 * 1024;
const EXACT_PROJECTED_SMOKE_PEAK_BYTES = 64 * 1024 * 1024 * 1024;

export const BASIS_FLAGS = Object.freeze({
	storagePreflightOpen: true,
	gameExecutionOpen: false,
	densitySmokeOpen: false,
	registeredSeedsOpen: false,
	registeredCollectionOpen: false,
	teacherSearchOpen: false,
	trainingOpen: false,
	developmentEvaluationOpen: false,
	hiddenEvaluationOpen: false,
	humanGateOpen: false,
	promotionOpen: false,
	deploymentOpen: false
});

export const EXECUTION_FLAGS = Object.freeze({
	storagePreflightOpen: false,
	gameExecutionOpen: false,
	densitySmokeOpen: true,
	registeredSeedsOpen: false,
	registeredCollectionOpen: false,
	teacherSearchOpen: false,
	trainingOpen: false,
	developmentEvaluationOpen: false,
	hiddenEvaluationOpen: false,
	humanGateOpen: false,
	promotionOpen: false,
	deploymentOpen: false
});

export const EXACT_SEED_LEDGER = Object.freeze({
	id: 'b1-density-smoke-unregistered-v1',
	registration: 'unregistered',
	seed0: 962000000,
	games: 512,
	seedMax: 962000511,
	contiguousInclusive: true,
	substitutionAllowed: false,
	backfillAllowed: false,
	shards: Object.freeze(
		Array.from({ length: 16 }, (_, index) =>
			Object.freeze({
				index,
				seed0: 962000000 + 32 * index,
				games: 32,
				seedMax: 962000031 + 32 * index
			})
		)
	)
});

const REQUIRED_REPO_FILES = Object.freeze({
	sourceLock: `${EXPERIMENT}/artifacts/source-lock.json`,
	strengthToolingLock: `${EXPERIMENT}/artifacts/strength-tooling-lock.json`,
	baseProtocol: `${EXPERIMENT}/protocol.json`,
	laneBProtocol: `${EXPERIMENT}/lane-b-execution-protocol.json`,
	laneBProtocolValidator: 'scripts/validate-v34-lane-b-protocol.mjs',
	laneBProtocolTests: 'scripts/test-v34-lane-b-protocol.mjs',
	laneBPlan: `${EXPERIMENT}/lane-b-tooling-plan.md`,
	laneBFinalFablePass: `${EXPERIMENT}/lane-b-tooling-fable-final-validation.md`,
	densitySmokePlan: `${EXPERIMENT}/b1-density-smoke-execution-plan.md`,
	densitySmokeFinalFablePass: `${EXPERIMENT}/b1-density-smoke-fable-final-pass.md`,
	densitySmokeIntegrationFableBlock: `${EXPERIMENT}/b1-smoke-integration-fable-review-attempt1.md`,
	densitySmokeIntegrationFinalFablePass: `${EXPERIMENT}/b1-smoke-integration-fable-final-pass.md`,
	collector: 'scripts/collect-v34-teacher-snapshots.mjs',
	collectorTests: 'scripts/test-v34-teacher-snapshots.mjs',
	parentAdapter: 'scripts/v34-parent-snapshot-policy.mjs',
	parentAdapterTests: 'scripts/test-v34-parent-snapshot-policy.mjs',
	parentAdapterFinalFablePass: `${EXPERIMENT}/b1-parent-adapter-fable-final-pass.md`,
	parentAdapterPreflightIncident: `${EXPERIMENT}/b1-parent-adapter-preflight-incident.md`,
	parentAdapterLivePreflight: `${EXPERIMENT}/b1-parent-adapter-live-preflight.json`,
	parentProviderPreflight: `${EXPERIMENT}/b1-parent-provider-preflight.json`,
	storageCapabilityPreflight: `${EXPERIMENT}/b1-storage-capability-preflight.json`,
	strictEnvironmentPreflight: `${EXPERIMENT}/b1-strict-environment-preflight.json`,
	policyConfig: `${EXPERIMENT}/b1-parent-policy-config.json`,
	inferenceServer: 'ml/infer_server.py',
	modelV2: 'ml/model_v2.py',
	gameRuntime: 'src/lib/play/runtime.ts',
	gameTypes: 'src/lib/play/types.ts',
	actions: 'src/lib/play/ml/actions.ts',
	encoderV1: 'src/lib/play/ml/encode.ts',
	encoderV2: 'src/lib/play/ml/encodeV2.ts',
	neuralBot: 'src/lib/play/ml/neuralBot.ts',
	evalSchedule: 'src/lib/play/ml/evalSchedule.ts',
	botPolicy: 'src/lib/play/server/botPolicy.ts',
	snapshotPrimitives: 'src/lib/play/ml/expertIteration/snapshot.ts',
	snapshotTests: 'src/lib/play/ml/expertIteration/snapshot.test.ts',
	freezer: 'ml/freeze_v34_teacher_snapshots.py',
	freezerTests: 'ml/test_freeze_v34_teacher_snapshots.py',
	lockTool: 'scripts/v34-b1-smoke-lock.mjs',
	lockToolTests: 'scripts/test-v34-b1-smoke-lock.mjs',
	storagePreflightTool: 'scripts/run-v34-b1-storage-preflight.mjs',
	storagePreflightTests: 'scripts/test-v34-b1-storage-preflight.mjs',
	orchestrator: 'scripts/run-v34-b1-density-smoke.mjs',
	orchestratorTests: 'scripts/test-run-v34-b1-density-smoke.mjs'
});

function fail(message) {
	throw new Error(`V34 B1 smoke lock: ${message}`);
}

function assert(condition, message) {
	if (!condition) fail(message);
}

function exactKeys(value, expected, label) {
	assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	assert(JSON.stringify(actual) === JSON.stringify(wanted), `${label} keys changed`);
}

function canonicalValue(value, objectMember = false) {
	if (value === undefined) {
		if (objectMember) return undefined;
		fail('canonical JSON root/array cannot contain undefined');
	}
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		assert(Number.isFinite(value), 'canonical JSON requires finite numbers');
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
	assert(
		value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype,
		'canonical JSON requires plain objects'
	);
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.flatMap((key) => {
				const normalized = canonicalValue(value[key], true);
				return normalized === undefined ? [] : [[key, normalized]];
			})
	);
}

export function canonicalJson(value) {
	return JSON.stringify(canonicalValue(value));
}

export function sha256Canonical(value) {
	return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function sha256File(file) {
	const digest = createHash('sha256');
	digest.update(readFileSync(file));
	return digest.digest('hex');
}

function pathLexicallyExists(file) {
	try {
		lstatSync(file);
		return true;
	} catch (error) {
		if (error?.code === 'ENOENT') return false;
		throw error;
	}
}

function assertAbsent(file, label) {
	assert(path.isAbsolute(file), `${label} must be absolute`);
	assert(
		!pathLexicallyExists(file),
		`${label} must be absent (including dangling symlinks): ${file}`
	);
}

function assertRegularFile(file, label) {
	assert(path.isAbsolute(file), `${label} path must be absolute`);
	assert(pathLexicallyExists(file), `${label} is missing: ${file}`);
	const stat = lstatSync(file);
	assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a non-symlink regular file`);
}

export function fileRecord(file) {
	const resolved = path.resolve(file);
	assertRegularFile(resolved, 'recorded file');
	const payload = readFileSync(resolved);
	return { path: resolved, bytes: payload.length, sha256: sha256File(resolved) };
}

function verifyFileRecord(record, label) {
	exactKeys(record, ['path', 'bytes', 'sha256'], label);
	assert(path.isAbsolute(record.path), `${label}.path must be absolute`);
	assert(Number.isSafeInteger(record.bytes) && record.bytes >= 0, `${label}.bytes is invalid`);
	assert(SHA256_RE.test(record.sha256), `${label}.sha256 is invalid`);
	assertRegularFile(record.path, label);
	const actual = fileRecord(record.path);
	assert(canonicalJson(actual) === canonicalJson(record), `${label} live hash/size/path changed`);
	return actual;
}

function readJson(file, label) {
	assertRegularFile(path.resolve(file), label);
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch (error) {
		fail(`${label} is not valid JSON: ${error.message}`);
	}
}

function exactPolicyConfig(config) {
	return (
		canonicalJson(config) ===
		canonicalJson({
			schemaVersion: 'arc-v34-bound-raw-policy-v1',
			policyObservationVersion: 2,
			actionSelector: 'hybrid-v1',
			decisionSelection: 'sample',
			temperature: 0.55,
			progressFilter: { mode: 'selectable-candidate-indices-v1', learnMonsterRewardChoices: false },
			optionHead: { mode: 'disabled', dimension: 0 },
			guardianSchedule: 'absolute-balanced',
			maxStatusLevel: 2,
			maxRounds: 30,
			forcedClosureMaxSteps: 64,
			maxTicks: 50000,
			samplingStream: 0,
			weakEngineThreshold: {
				minRoundInclusive: 16,
				maxExpectedAttack: 3.25,
				maxAttackDice: 3,
				maxAwakenedSpirits: 2,
				maxBarrier: 5,
				maxInitiative: 3
			}
		})
	);
}

function assertExactFlags(flags, expected, label) {
	exactKeys(flags, Object.keys(expected), label);
	assert(canonicalJson(flags) === canonicalJson(expected), `${label} changed`);
}

function assertExactSeedLedger(ledger) {
	assert(
		canonicalJson(ledger) === canonicalJson(EXACT_SEED_LEDGER),
		'unregistered seed ledger changed'
	);
	const seeds = ledger.shards.flatMap((shard) =>
		Array.from({ length: shard.games }, (_, offset) => shard.seed0 + offset)
	);
	assert(
		seeds.length === 512 && new Set(seeds).size === 512,
		'seed shards are not 512 unique seeds'
	);
	assert(seeds[0] === 962000000 && seeds.at(-1) === 962000511, 'seed shards changed endpoints');
}

function assertClosedLaneBProtocol(protocol) {
	assert(
		protocol.schemaVersion === 'arc-v34-lane-b-execution-protocol-v1',
		'Lane B schema changed'
	);
	assert(
		protocol.status === 'closed' && protocol.outcomeBlind === true,
		'Lane B is not outcome-blind/closed'
	);
	assert(
		Array.isArray(protocol.seedLedger) && protocol.seedLedger.length === 38,
		'Lane B seed ledger changed'
	);
	assert(
		protocol.seedLedger.every((row) => row.open === false),
		'a registered Lane B seed range is open'
	);
	assert(protocol.storage?.stageOpen === false, 'Lane B storage stage is unexpectedly open');
	assert(
		protocol.validationMetadata?.registeredSeedExecutionAuthorized === false,
		'Lane B registered execution is unexpectedly authorized'
	);
}

function assertSmokeSeedsDisjointFromRegistered(protocol) {
	for (const row of protocol.seedLedger) {
		assert(
			EXACT_SEED_LEDGER.seedMax < row.seed0 || EXACT_SEED_LEDGER.seed0 > row.seedMax,
			`unregistered smoke overlaps registered range ${row.id}`
		);
	}
}

function assertProviderBindingIdentity(binding, checkpoint, manifest, config, socketPath) {
	exactKeys(
		binding,
		[
			'schemaVersion',
			'mode',
			'provider',
			'purpose',
			'policyObservationVersion',
			'checkpoint',
			'runtime'
		],
		'provider binding'
	);
	exactKeys(
		binding.runtime,
		[
			'adapterSchema',
			'policyConfigSha256',
			'checkpointManifest',
			'server',
			'client',
			'optionHead',
			'reach30Probability',
			'recoveryProbability'
		],
		'provider binding runtime'
	);
	exactKeys(
		binding.runtime.client,
		[
			'implementation',
			'wire',
			'timeoutMs',
			'socketPath',
			'inputQuantization',
			'requestedSections',
			'roundTripsPerDecision'
		],
		'provider binding client'
	);
	assert(
		binding?.schemaVersion === 'arc-v34-policy-provider-binding-v1' &&
			binding.mode === 'registered-parent' &&
			binding.provider === 'arc-v34-remote-parent-policy-adapter-v1' &&
			binding.purpose === 'v34-lane-b-b1-outcome-blind-raw-parent-snapshot-collection' &&
			binding.policyObservationVersion === 2,
		'provider binding identity changed'
	);
	assert(
		canonicalJson(binding.checkpoint) === canonicalJson(checkpoint),
		'provider checkpoint changed'
	);
	assert(
		binding.runtime?.adapterSchema === 'arc-v34-remote-parent-policy-adapter-v1' &&
			binding.runtime.policyConfigSha256 === sha256Canonical(config),
		'provider adapter/config binding changed'
	);
	assert(
		canonicalJson(binding.runtime?.checkpointManifest) === canonicalJson(manifest),
		'provider manifest changed'
	);
	assert(
		binding.runtime?.client?.implementation === 'ready-synchronized-worker-binary-v1' &&
			binding.runtime.client.wire === 'binary' &&
			binding.runtime.client.timeoutMs === 30000 &&
			binding.runtime.client.socketPath === socketPath &&
			binding.runtime.client.inputQuantization === 'Float32Array.from' &&
			canonicalJson(binding.runtime.client.requestedSections) ===
				canonicalJson(['logits', 'reach30']) &&
			binding.runtime.client.roundTripsPerDecision === 1,
		'provider ready-synchronized binary client binding changed'
	);
	const served = binding.runtime?.server;
	assert(
		served?.format === 'arc-entity-scorer-v2' &&
			served.obs_dim === 3419 &&
			served.act_dim === 104 &&
			served.device === 'cuda:0' &&
			served.weights_sha256 === checkpoint.sha256 &&
			path.resolve(served.weights) === checkpoint.path &&
			served.aux?.placement === false &&
			served.aux?.reach30 === true &&
			served.reach30_horizon === 30,
		'served parent identity/head binding changed'
	);
	assert(
		binding.runtime?.optionHead === 'disabled-checkpoint-has-no-option-head' &&
			binding.runtime?.reach30Probability === 'sigmoid-trained-logit-horizon-30' &&
			binding.runtime?.recoveryProbability?.source ===
				'constant-zero-no-trained-head-not-used-for-recovery-classification' &&
			binding.runtime.recoveryProbability.value === 0,
		'provider auxiliary-head semantics changed'
	);
	return binding;
}

export function deriveExpectedExecutionProviderBinding(preflightBinding, executionSocketPath) {
	assert(path.isAbsolute(executionSocketPath), 'execution provider socket must be absolute');
	const expected = structuredClone(preflightBinding);
	assert(
		expected?.runtime?.client && typeof expected.runtime.client === 'object',
		'preflight provider binding has no client identity'
	);
	assert(
		path.resolve(expected.runtime.client.socketPath) !== path.resolve(executionSocketPath),
		'preflight and execution provider sockets must be distinct'
	);
	expected.runtime.client.socketPath = path.resolve(executionSocketPath);
	return expected;
}

function assertProviderEvidence(evidence, checkpoint, manifest, config, execution) {
	exactKeys(
		evidence,
		['schemaVersion', 'policyBinding', 'policyBindingSha256', 'passed', 'checkedAt'],
		'provider binding evidence'
	);
	assert(
		evidence.schemaVersion === 'arc-v34-b1-parent-provider-preflight-v1' &&
			evidence.passed === true,
		'provider binding preflight did not pass'
	);
	assert(!Number.isNaN(Date.parse(evidence.checkedAt)), 'provider binding checkedAt is invalid');
	assert(
		evidence.policyBindingSha256 === sha256Canonical(evidence.policyBinding),
		'provider binding canonical SHA-256 changed'
	);
	const binding = evidence.policyBinding;
	const preflightSocketPath = binding?.runtime?.client?.socketPath;
	assert(
		path.isAbsolute(preflightSocketPath) &&
			preflightSocketPath.startsWith('/dev/shm/') &&
			preflightSocketPath !== execution.socketPath,
		'provider preflight socket must be distinct from the absent execution socket'
	);
	assertAbsent(preflightSocketPath, 'released provider preflight socket');
	assertProviderBindingIdentity(binding, checkpoint, manifest, config, preflightSocketPath);
	const expectedExecutionBinding = deriveExpectedExecutionProviderBinding(
		binding,
		execution.socketPath
	);
	assertProviderBindingIdentity(
		expectedExecutionBinding,
		checkpoint,
		manifest,
		config,
		execution.socketPath
	);
	return { preflightBinding: binding, expectedExecutionBinding };
}

function assertProviderAudit(audit, strictEvidence, inventory) {
	exactKeys(
		audit,
		[
			'schemaVersion',
			'valid',
			'observedAt',
			'host',
			'sourceCommit',
			'outcomeBlind',
			'gamesStarted',
			'seedsConsumed',
			'outcomesRead',
			'phase2OutcomesRead',
			'providerBinding',
			'providerBindingCanonicalSha256',
			'adapter',
			'config',
			'gpu',
			'registeredStagesOpened',
			'densitySmokeOpened',
			'promotionOpened'
		],
		'provider preflight audit'
	);
	assert(
		audit.schemaVersion === 'arc-v34-b1-parent-adapter-live-preflight-v1' &&
			audit.valid === true &&
			audit.sourceCommit === PARENT_ADAPTER_COMMIT &&
			audit.outcomeBlind === true &&
			audit.gamesStarted === 0 &&
			canonicalJson(audit.seedsConsumed) === '[]' &&
			audit.outcomesRead === false &&
			audit.phase2OutcomesRead === false &&
			audit.registeredStagesOpened === false &&
			audit.densitySmokeOpened === false &&
			audit.promotionOpened === false &&
			audit.host === 'simforge1',
		'provider preflight audit is not outcome-blind/closed'
	);
	assert(!Number.isNaN(Date.parse(audit.observedAt)), 'provider audit observedAt is invalid');
	assert(
		audit.providerBindingCanonicalSha256 === sha256Canonical(audit.providerBinding) &&
			audit.providerBindingCanonicalSha256 === strictEvidence.policyBindingSha256 &&
			canonicalJson(audit.providerBinding) === canonicalJson(strictEvidence.policyBinding),
		'provider strict evidence/audit binding mismatch'
	);
	exactKeys(audit.adapter, ['path', 'sha256'], 'provider audit adapter');
	exactKeys(audit.config, ['path', 'sha256'], 'provider audit config');
	exactKeys(
		audit.gpu,
		[
			'physicalIndex',
			'uuid',
			'logicalDevice',
			'memoryMiBAfterRelease',
			'utilizationPercentAfterRelease',
			'serverShutdownClean',
			'socketAbsentAfterRelease'
		],
		'provider audit GPU release'
	);
	assert(
		audit.adapter?.path === 'scripts/v34-parent-snapshot-policy.mjs' &&
			SHA256_RE.test(audit.adapter.sha256 ?? '') &&
			audit.adapter.sha256 === inventory.parentAdapter.sha256 &&
			audit.config?.path === `${EXPERIMENT}/b1-parent-policy-config.json` &&
			SHA256_RE.test(audit.config.sha256 ?? '') &&
			audit.config.sha256 === inventory.policyConfig.sha256,
		'provider preflight adapter/config records changed'
	);
	assert(
		audit.gpu?.physicalIndex === 7 &&
			/^GPU-[0-9a-f-]+$/i.test(audit.gpu.uuid ?? '') &&
			audit.gpu.logicalDevice === 'cuda:0' &&
			audit.gpu.memoryMiBAfterRelease === 0 &&
			audit.gpu.utilizationPercentAfterRelease === 0 &&
			audit.gpu.serverShutdownClean === true &&
			audit.gpu.socketAbsentAfterRelease === true,
		'provider preflight release evidence changed'
	);
	return audit;
}

export function validateV34B1StrictEnvironmentPreflight(
	evidence,
	{ execution, providerEvidence, providerAudit, inventory }
) {
	exactKeys(
		evidence,
		[
			'schemaVersion',
			'checkedAt',
			'host',
			'passed',
			'outcomeBlind',
			'gamesStarted',
			'seedsConsumed',
			'outcomesRead',
			'phase2OutcomesRead',
			'environment',
			'gpu',
			'provider'
		],
		'strict environment preflight'
	);
	assert(
		evidence.schemaVersion === STRICT_ENVIRONMENT_PREFLIGHT_SCHEMA &&
			evidence.passed === true &&
			evidence.outcomeBlind === true &&
			evidence.gamesStarted === 0 &&
			canonicalJson(evidence.seedsConsumed) === '[]' &&
			evidence.outcomesRead === false &&
			evidence.phase2OutcomesRead === false,
		'strict environment preflight is not a passing zero-game outcome-blind preflight'
	);
	assert(
		typeof evidence.checkedAt === 'string' &&
			new Date(evidence.checkedAt).toISOString() === evidence.checkedAt,
		'strict environment preflight checkedAt is invalid'
	);
	assert(evidence.host === EXACT_HOST, 'strict environment preflight host changed');
	exactKeys(
		evidence.environment,
		[
			'ARC_V34_PARENT_CHECKPOINT',
			'ARC_V34_INFER_SOCKET',
			'ARC_V34_INFER_TIMEOUT_MS',
			'ARC_V34_EXPECT_DEVICE',
			'CUDA_VISIBLE_DEVICES'
		],
		'strict environment preflight environment'
	);
	assert(
		canonicalJson(evidence.environment) === canonicalJson(execution.environment),
		'strict environment preflight does not prove the exact locked environment'
	);
	exactKeys(
		evidence.gpu,
		[
			'physicalIndex',
			'uuid',
			'logicalDevice',
			'memoryMiBAfterRelease',
			'utilizationPercentAfterRelease',
			'released',
			'serverProcessAbsent',
			'socketAbsent'
		],
		'strict environment preflight GPU release'
	);
	assert(
		evidence.gpu.physicalIndex === 7 &&
			evidence.gpu.uuid === providerAudit.gpu.uuid &&
			evidence.gpu.logicalDevice === 'cuda:0' &&
			evidence.gpu.memoryMiBAfterRelease === 0 &&
			evidence.gpu.utilizationPercentAfterRelease === 0 &&
			evidence.gpu.released === true &&
			evidence.gpu.serverProcessAbsent === true &&
			evidence.gpu.socketAbsent === true,
		'strict environment preflight did not prove GPU7 fully released'
	);
	exactKeys(
		evidence.provider,
		[
			'bindingCanonicalSha256',
			'providerId',
			'adapterSchema',
			'adapterImplementation',
			'serverImplementation',
			'serverIdentity'
		],
		'strict environment preflight provider identity'
	);
	exactKeys(
		evidence.provider.adapterImplementation,
		['path', 'sha256'],
		'strict environment preflight adapter implementation'
	);
	exactKeys(
		evidence.provider.serverImplementation,
		['path', 'sha256'],
		'strict environment preflight server implementation'
	);
	const binding = providerEvidence.policyBinding;
	assert(
		evidence.provider.bindingCanonicalSha256 === providerEvidence.policyBindingSha256 &&
			evidence.provider.bindingCanonicalSha256 === sha256Canonical(binding) &&
			evidence.provider.providerId === binding.provider &&
			evidence.provider.adapterSchema === binding.runtime.adapterSchema &&
			canonicalJson(evidence.provider.adapterImplementation) ===
				canonicalJson({
					path: 'scripts/v34-parent-snapshot-policy.mjs',
					sha256: inventory.parentAdapter.sha256
				}) &&
			canonicalJson(evidence.provider.serverImplementation) ===
				canonicalJson({
					path: 'ml/infer_server.py',
					sha256: inventory.inferenceServer.sha256
				}) &&
			canonicalJson(evidence.provider.serverIdentity) === canonicalJson(binding.runtime.server),
		'strict environment preflight server/adapter identity differs from the provider record'
	);
	return evidence;
}

function repoInventory(repoRoot, extraRuntimeFiles) {
	const files = { ...REQUIRED_REPO_FILES, ...extraRuntimeFiles };
	return Object.fromEntries(
		Object.entries(files).map(([name, raw]) => [
			name,
			fileRecord(path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw))
		])
	);
}

function assertIntegrationFableReviewChain(inventory) {
	const block = readFileSync(inventory.densitySmokeIntegrationFableBlock.path, 'utf8');
	const pass = readFileSync(inventory.densitySmokeIntegrationFinalFablePass.path, 'utf8');
	for (const [needle, label] of [
		['Verdict: **BLOCK**', 'attempt-1 BLOCK verdict'],
		['expectedExecutionProviderBindingCanonicalSha256', 'provider hash-key blocker'],
		['targetDeletionInvariance', 'target-deletion schema blocker'],
		['outside the scratch attempt root', 'durable-path blocker']
	]) {
		assert(block.includes(needle), `integration Fable BLOCK record lacks ${label}`);
	}
	for (const [needle, label] of [
		['Verdict: **PASS**', 'final PASS verdict'],
		['Supersedes: b1-smoke-integration-fable-review-attempt1.md', 'explicit BLOCK supersession'],
		['expectedExecutionProviderBindingCanonicalSha256', 'provider hash-key resolution'],
		['targetDeletionInvariance', 'target-deletion schema resolution'],
		['b1-density-smoke-attempt-1.orchestrator.result.json', 'durable result-path resolution'],
		['collector-exported-bounded-16-way-feature-only-merge-v1', '16-way merge resolution'],
		['strict-environment-preflight', 'final strict-environment preflight resolution']
	]) {
		assert(pass.includes(needle), `integration Fable PASS record lacks ${label}`);
	}
	return true;
}

function assertGitBinding(repoRoot, implementationCommit, inventory, checkClean) {
	assert(
		/^[0-9a-f]{40}$/.test(implementationCommit),
		'authorization implementation commit is invalid'
	);
	if (!existsSync(path.join(repoRoot, '.git'))) return;
	const head = execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd: repoRoot,
		encoding: 'utf8'
	}).trim();
	assert(head === implementationCommit, 'authorization implementation commit must equal HEAD');
	for (const ancestor of [
		SOURCE_IMPLEMENTATION_COMMIT,
		REVIEWED_PLAN_COMMIT,
		PARENT_ADAPTER_COMMIT
	]) {
		execFileSync('git', ['merge-base', '--is-ancestor', ancestor, implementationCommit], {
			cwd: repoRoot,
			stdio: 'ignore'
		});
	}
	if (!checkClean) return;
	const relative = Object.values(inventory)
		.map((record) => path.relative(repoRoot, record.path))
		.filter((file) => !file.startsWith('..'));
	const status = execFileSync('git', ['status', '--short', '--', ...relative], {
		cwd: repoRoot,
		encoding: 'utf8'
	}).trim();
	assert(status === '', `bound files must be committed and clean:\n${status}`);
}

function validateAbsoluteUnder(candidate, parent, label) {
	assert(path.isAbsolute(candidate) && path.isAbsolute(parent), `${label} must use absolute paths`);
	const relative = path.relative(parent, candidate);
	assert(
		relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative),
		`${label} escapes ${parent}`
	);
}

function expectedShardLaunches(execution, paths) {
	return EXACT_SEED_LEDGER.shards.map((seedShard) => {
		const stem = `shard-${String(seedShard.index).padStart(2, '0')}`;
		const outDir = path.join(execution.attemptRoot, 'shards', stem);
		return {
			...seedShard,
			outDir,
			stdoutPath: path.join(execution.attemptRoot, 'logs', `${stem}.stdout`),
			stderrPath: path.join(execution.attemptRoot, 'logs', `${stem}.stderr`),
			executable: execution.nodeExecutable,
			argv: [
				execution.collectorPath,
				'--catalog',
				execution.catalogPath,
				'--config',
				execution.configPath,
				'--policy-module',
				execution.policyModulePath,
				'--seed0',
				String(seedShard.seed0),
				'--games',
				'32',
				'--out',
				outDir
			]
		};
	});
}

const EXECUTION_PATH_KEYS = Object.freeze([
	'authorizationBasis',
	'providerBindingEvidence',
	'storagePreflight',
	'executionLock',
	'consumedMarker',
	'serverReady',
	'serverExit',
	'finalProviderBinding',
	'mergedFeatures',
	'smokeFreezeProtocol',
	'smokeFreezeOutput',
	'smokeFreezeLedger',
	'featureOnlyReport',
	'orchestratorStdout',
	'orchestratorStderr',
	'orchestratorResult',
	'orchestratorFailure',
	'finalFeatureReport',
	'serverStdout',
	'serverStderr'
]);

const DURABLE_EXECUTION_OUTPUT_KEYS = Object.freeze([
	'consumedMarker',
	'orchestratorStdout',
	'orchestratorStderr',
	'orchestratorResult',
	'orchestratorFailure',
	'finalFeatureReport'
]);

const SCRATCH_EXECUTION_OUTPUT_KEYS = Object.freeze([
	'serverReady',
	'serverExit',
	'finalProviderBinding',
	'mergedFeatures',
	'smokeFreezeOutput',
	'smokeFreezeLedger',
	'featureOnlyReport',
	'serverStdout',
	'serverStderr'
]);

function isStrictlyUnder(candidate, parent) {
	const relative = path.relative(parent, candidate);
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertExecutionPathContract(execution, paths) {
	exactKeys(paths, EXECUTION_PATH_KEYS, 'execution paths');
	for (const [name, value] of Object.entries(paths)) {
		assert(typeof value === 'string' && path.isAbsolute(value), `paths.${name} must be absolute`);
	}
	assert(path.isAbsolute(execution.attemptRoot), 'execution.attemptRoot must be absolute');
	validateAbsoluteUnder(execution.attemptRoot, '/dev/shm', 'execution.attemptRoot');
	const durableRoot = path.dirname(paths.executionLock);
	assert(
		!isStrictlyUnder(durableRoot, execution.attemptRoot) && durableRoot !== execution.attemptRoot,
		'durable execution directory must be outside the scratch attempt root'
	);
	for (const name of DURABLE_EXECUTION_OUTPUT_KEYS) {
		assert(
			path.dirname(paths[name]) === durableRoot,
			`paths.${name} must be a direct sibling of the execution lock`
		);
	}
	for (const name of SCRATCH_EXECUTION_OUTPUT_KEYS) {
		validateAbsoluteUnder(paths[name], execution.attemptRoot, `paths.${name}`);
	}
	validateAbsoluteUnder(execution.socketPath, execution.attemptRoot, 'execution.socketPath');
	const allOutputs = [
		...DURABLE_EXECUTION_OUTPUT_KEYS.map((name) => paths[name]),
		...SCRATCH_EXECUTION_OUTPUT_KEYS.map((name) => paths[name]),
		execution.socketPath,
		...execution.shards.flatMap((shard) => [shard.outDir, shard.stdoutPath, shard.stderrPath])
	];
	assert(new Set(allOutputs).size === allOutputs.length, 'execution output paths overlap');
	for (const shard of execution.shards) {
		validateAbsoluteUnder(shard.outDir, execution.attemptRoot, `shard ${shard.index} outDir`);
		validateAbsoluteUnder(
			shard.stdoutPath,
			execution.attemptRoot,
			`shard ${shard.index} stdoutPath`
		);
		validateAbsoluteUnder(
			shard.stderrPath,
			execution.attemptRoot,
			`shard ${shard.index} stderrPath`
		);
	}
	exactKeys(
		execution.orchestrator,
		[
			'executable',
			'argv',
			'stdoutPath',
			'stderrPath',
			'resultPath',
			'failurePath',
			'finalFeatureReportPath',
			'launchMode',
			'selfPublication'
		],
		'execution orchestrator'
	);
	exactKeys(
		execution.orchestrator.selfPublication,
		['mode', 'precreateAttemptRoot', 'stdout', 'stderr', 'result', 'failure', 'finalFeatureReport'],
		'execution orchestrator self-publication'
	);
	assert(
		canonicalJson({
			stdoutPath: execution.orchestrator.stdoutPath,
			stderrPath: execution.orchestrator.stderrPath,
			resultPath: execution.orchestrator.resultPath,
			failurePath: execution.orchestrator.failurePath,
			finalFeatureReportPath: execution.orchestrator.finalFeatureReportPath
		}) ===
			canonicalJson({
				stdoutPath: paths.orchestratorStdout,
				stderrPath: paths.orchestratorStderr,
				resultPath: paths.orchestratorResult,
				failurePath: paths.orchestratorFailure,
				finalFeatureReportPath: paths.finalFeatureReport
			}),
		'orchestrator publication paths differ from the path contract'
	);
	assert(
		execution.orchestrator.launchMode === 'execFile-no-shell-no-redirection' &&
			execution.orchestrator.selfPublication.mode === 'structured-new-only-result-xor-failure-v1' &&
			execution.orchestrator.selfPublication.precreateAttemptRoot === false &&
			execution.orchestrator.selfPublication.stdout === 'reserved-new-only-not-shell-redirected' &&
			execution.orchestrator.selfPublication.stderr === 'reserved-new-only-not-shell-redirected' &&
			execution.orchestrator.selfPublication.result === 'new-only-on-success' &&
			execution.orchestrator.selfPublication.failure === 'new-only-on-failure' &&
			execution.orchestrator.selfPublication.finalFeatureReport === 'new-only-on-success',
		'orchestrator must self-publish new-only without shell redirection or scratch precreation'
	);
	assert(
		execution.postflight.featureMerge === 'collector-exported-bounded-16-way-feature-only-merge-v1',
		'feature merge must use the bounded 16-way contract'
	);
	exactKeys(
		execution.postflight,
		[
			'featureMerge',
			'freezer',
			'traceVerification',
			'targetDeletionInvariance',
			'providerPostflightHandshakeRequired'
		],
		'execution postflight'
	);
	exactKeys(execution.postflight.freezer, ['executable', 'argv'], 'execution postflight freezer');
	exactKeys(
		execution.postflight.traceVerification,
		['selection', 'seed', 'draws', 'targetFilesReadable'],
		'execution postflight trace verification'
	);
	exactKeys(
		execution.postflight.targetDeletionInvariance,
		[
			'targetPaths',
			'readOrHashBeforeDelete',
			'deletion',
			'freezerFreezeRuns',
			'verify',
			'requireFeatureSelectionOutputLedgerHashesUnchanged'
		],
		'execution postflight target-deletion invariance'
	);
	exactKeys(
		execution.postflight.targetDeletionInvariance.verify,
		['executable', 'argv'],
		'execution postflight target-deletion verifier'
	);
	assert(
		execution.postflight.targetDeletionInvariance.targetPaths ===
			'exact-shard-target-artifacts-from-locked-shard-roots' &&
			execution.postflight.targetDeletionInvariance.readOrHashBeforeDelete === false &&
			execution.postflight.targetDeletionInvariance.deletion ===
				'lexically-bound-unlink-only-no-follow' &&
			execution.postflight.targetDeletionInvariance.freezerFreezeRuns === 1 &&
			execution.postflight.targetDeletionInvariance
				.requireFeatureSelectionOutputLedgerHashesUnchanged === true &&
			execution.postflight.providerPostflightHandshakeRequired === true,
		'postflight target-deletion/provider-handshake contract changed'
	);
	return paths;
}

function assertExecutionOutputPathsAbsent(execution, paths, { includeLock = false } = {}) {
	for (const name of [...DURABLE_EXECUTION_OUTPUT_KEYS, ...SCRATCH_EXECUTION_OUTPUT_KEYS]) {
		assertAbsent(paths[name], `future execution output paths.${name}`);
	}
	for (const shard of execution.shards) {
		assertAbsent(shard.outDir, `future shard ${shard.index} output directory`);
		assertAbsent(shard.stdoutPath, `future shard ${shard.index} stdout`);
		assertAbsent(shard.stderrPath, `future shard ${shard.index} stderr`);
	}
	assertAbsent(execution.attemptRoot, 'density-smoke attempt root');
	assertAbsent(execution.socketPath, 'inference socket');
	if (includeLock) assertAbsent(paths.executionLock, 'execution lock output');
}

function buildExecutionProjection(runtime) {
	const repoRoot = path.resolve(runtime.repoRoot);
	const artifactRoot = path.resolve(runtime.artifactRoot);
	const attemptRoot = path.resolve(runtime.attemptRoot);
	const executionLock = path.resolve(runtime.executionLockPath);
	const durableRoot = path.dirname(executionLock);
	const paths = {
		authorizationBasis: path.resolve(runtime.basisPath),
		providerBindingEvidence: path.resolve(runtime.providerBindingPath),
		storagePreflight: path.resolve(runtime.storagePreflightPath),
		executionLock,
		consumedMarker: path.join(durableRoot, 'b1-density-smoke-attempt-1.consumed.json'),
		serverReady: path.join(attemptRoot, 'server-ready.json'),
		serverExit: path.join(attemptRoot, 'server-exit.json'),
		finalProviderBinding: path.join(attemptRoot, 'final-provider-binding.json'),
		mergedFeatures: path.join(attemptRoot, 'feature-only', 'merged-snapshots.jsonl'),
		smokeFreezeProtocol: path.resolve(runtime.smokeFreezeProtocolPath),
		smokeFreezeOutput: path.join(attemptRoot, 'feature-only', 'selected-g1.jsonl'),
		smokeFreezeLedger: path.join(attemptRoot, 'feature-only', 'selection-ledger-g1.json'),
		featureOnlyReport: path.join(attemptRoot, 'feature-only', 'density-smoke-report.json'),
		orchestratorStdout: path.join(
			durableRoot,
			'b1-density-smoke-attempt-1.orchestrator.stdout.json'
		),
		orchestratorStderr: path.join(
			durableRoot,
			'b1-density-smoke-attempt-1.orchestrator.stderr.json'
		),
		orchestratorResult: path.join(
			durableRoot,
			'b1-density-smoke-attempt-1.orchestrator.result.json'
		),
		orchestratorFailure: path.join(
			durableRoot,
			'b1-density-smoke-attempt-1.orchestrator.failure.json'
		),
		finalFeatureReport: path.join(
			durableRoot,
			'b1-density-smoke-attempt-1.final-feature-report.json'
		),
		serverStdout: path.join(attemptRoot, 'logs', 'infer-server.stdout'),
		serverStderr: path.join(attemptRoot, 'logs', 'infer-server.stderr')
	};
	validateAbsoluteUnder(attemptRoot, '/dev/shm', 'attemptRoot');
	assert(runtime.host === EXACT_HOST, `host must be ${EXACT_HOST}`);
	assert(artifactRoot === EXACT_ARTIFACT_ROOT, `artifactRoot must be ${EXACT_ARTIFACT_ROOT}`);
	assert(repoRoot === artifactRoot, 'repoRoot and artifactRoot must be the frozen SimForge root');
	for (const [name, value] of Object.entries(paths))
		assert(path.isAbsolute(value), `${name} must be absolute`);
	const execution = {
		host: runtime.host,
		repoRoot,
		artifactRoot,
		attemptRoot,
		socketPath: path.join(attemptRoot, 'infer.sock'),
		catalogPath: path.resolve(runtime.catalogPath),
		configPath: path.resolve(repoRoot, `${EXPERIMENT}/b1-parent-policy-config.json`),
		policyModulePath: path.resolve(repoRoot, 'scripts/v34-parent-snapshot-policy.mjs'),
		collectorPath: path.resolve(repoRoot, 'scripts/collect-v34-teacher-snapshots.mjs'),
		orchestratorPath: path.resolve(repoRoot, 'scripts/run-v34-b1-density-smoke.mjs'),
		checkpointPath: path.resolve(runtime.checkpointPath),
		checkpointManifestPath: path.resolve(runtime.checkpointManifestPath),
		nodeExecutable: path.resolve(runtime.nodeExecutable),
		pythonExecutable: path.resolve(runtime.pythonExecutable),
		awsExecutable: path.resolve(runtime.awsExecutable),
		gpuProbe: {
			executable: path.resolve(runtime.nvidiaSmiExecutable),
			argv: [
				'--query-gpu=uuid,memory.used,utilization.gpu',
				'--format=csv,noheader,nounits',
				'--id=7'
			],
			physicalGpuIndex: 7,
			requiredMemoryMiB: 0,
			requiredUtilizationPercent: 0
		},
		serverReadyTimeoutMs: 120000,
		environment: {
			ARC_V34_PARENT_CHECKPOINT: path.resolve(runtime.checkpointPath),
			ARC_V34_INFER_SOCKET: path.join(attemptRoot, 'infer.sock'),
			ARC_V34_INFER_TIMEOUT_MS: '30000',
			ARC_V34_EXPECT_DEVICE: 'cuda:0',
			CUDA_VISIBLE_DEVICES: '7'
		},
		environmentPolicy: {
			allowlist: [
				'ARC_V34_PARENT_CHECKPOINT',
				'ARC_V34_INFER_SOCKET',
				'ARC_V34_INFER_TIMEOUT_MS',
				'ARC_V34_EXPECT_DEVICE',
				'CUDA_VISIBLE_DEVICES'
			],
			forbiddenPatterns: ['^ARC_V34_', '^ARC_DEVICE$', '^CUDA_VISIBLE_DEVICES$'],
			inheritMatchingVariables: false
		},
		server: {
			executable: path.resolve(runtime.pythonExecutable),
			argv: [
				path.resolve(repoRoot, 'ml/infer_server.py'),
				'--weights',
				path.resolve(runtime.checkpointPath),
				'--socket',
				path.join(attemptRoot, 'infer.sock'),
				'--device',
				'cuda:0',
				'--window-ms',
				'2',
				'--max-batch',
				'512',
				'--stats-interval',
				'5'
			],
			stdoutPath: paths.serverStdout,
			stderrPath: paths.serverStderr
		},
		orchestrator: {
			executable: path.resolve(runtime.nodeExecutable),
			argv: [
				path.resolve(repoRoot, 'scripts/run-v34-b1-density-smoke.mjs'),
				'--mode',
				'live',
				'--lock',
				paths.executionLock
			],
			stdoutPath: paths.orchestratorStdout,
			stderrPath: paths.orchestratorStderr,
			resultPath: paths.orchestratorResult,
			failurePath: paths.orchestratorFailure,
			finalFeatureReportPath: paths.finalFeatureReport,
			launchMode: 'execFile-no-shell-no-redirection',
			selfPublication: {
				mode: 'structured-new-only-result-xor-failure-v1',
				precreateAttemptRoot: false,
				stdout: 'reserved-new-only-not-shell-redirected',
				stderr: 'reserved-new-only-not-shell-redirected',
				result: 'new-only-on-success',
				failure: 'new-only-on-failure',
				finalFeatureReport: 'new-only-on-success'
			}
		},
		postflight: {
			featureMerge: 'collector-exported-bounded-16-way-feature-only-merge-v1',
			freezer: {
				executable: path.resolve(runtime.pythonExecutable),
				argv: [
					path.resolve(repoRoot, 'ml/freeze_v34_teacher_snapshots.py'),
					'freeze',
					'--input',
					paths.mergedFeatures,
					'--output',
					paths.smokeFreezeOutput,
					'--ledger',
					paths.smokeFreezeLedger,
					'--protocol',
					paths.smokeFreezeProtocol,
					'--generation',
					'1'
				]
			},
			traceVerification: {
				selection: 'pcg64-without-replacement-over-feature-sort-order',
				seed: 34049620,
				draws: 1000,
				targetFilesReadable: false
			},
			targetDeletionInvariance: {
				targetPaths: 'exact-shard-target-artifacts-from-locked-shard-roots',
				readOrHashBeforeDelete: false,
				deletion: 'lexically-bound-unlink-only-no-follow',
				freezerFreezeRuns: 1,
				verify: {
					executable: path.resolve(runtime.pythonExecutable),
					argv: [
						path.resolve(repoRoot, 'ml/freeze_v34_teacher_snapshots.py'),
						'verify',
						'--ledger',
						paths.smokeFreezeLedger
					]
				},
				requireFeatureSelectionOutputLedgerHashesUnchanged: true
			},
			providerPostflightHandshakeRequired: true
		}
	};
	assert(
		execution.checkpointPath ===
			path.resolve(repoRoot, 'ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt'),
		'checkpoint path differs from the reviewed frozen parent'
	);
	assert(
		execution.checkpointManifestPath ===
			path.resolve(
				repoRoot,
				'ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.manifest.json'
			),
		'checkpoint-manifest path differs from the reviewed frozen parent'
	);
	execution.shards = expectedShardLaunches(execution, paths);
	assertExecutionPathContract(execution, paths);
	return { execution, paths };
}

function verifyFreezeProtocol(file) {
	const protocol = readJson(file, 'smoke freeze protocol');
	assert(
		canonicalJson(protocol) ===
			canonicalJson({
				schemaVersion: 'arc-v34-teacher-snapshot-freeze-protocol-v1',
				quotas: { recovery: 1375, late: 6875, mid: 3438, early: 2063 }
			}),
		'smoke freeze quotas changed'
	);
	return fileRecord(file);
}

function assertCatalogBinding(baseProtocol, repoRoot, catalogRecord) {
	assert(
		baseProtocol?.schemaVersion === 'arc-controlled-experiment-v1' &&
			baseProtocol.experiment === 'v34-latency-first-expert-iteration',
		'V34 base protocol identity changed'
	);
	const declared = baseProtocol?.inputs?.catalog;
	exactKeys(declared, ['path', 'sha256'], 'base protocol catalog');
	assert(
		catalogRecord.path === path.resolve(repoRoot, declared.path) &&
			catalogRecord.sha256 === declared.sha256,
		'catalog differs from the live file frozen by the V34 base protocol'
	);
	return declared;
}

function assertStorageCapabilityEvidence(evidence, execution) {
	exactKeys(
		evidence,
		['schemaVersion', 'checkedAt', 'host', 'storage', 'checks', 'passed'],
		'storage capability preflight'
	);
	assert(
		evidence.schemaVersion === 'arc-v34-b1-storage-capability-preflight-v1' &&
			evidence.passed === true,
		'storage capability preflight did not pass'
	);
	assert(
		typeof evidence.checkedAt === 'string' &&
			new Date(evidence.checkedAt).toISOString() === evidence.checkedAt,
		'storage capability checkedAt is invalid'
	);
	assert(evidence.host === EXACT_HOST, 'storage capability host changed');
	exactKeys(
		evidence.storage,
		['kind', 'bucket', 'region', 'profile'],
		'storage capability identity'
	);
	assert(
		canonicalJson(evidence.storage) ===
			canonicalJson({
				kind: 's3',
				bucket: 'dev-simforge-435362779479-models',
				region: 'us-west-1',
				profile: 'simforge'
			}),
		'storage capability bucket/profile/region changed'
	);
	exactKeys(evidence.checks, ['versioning', 'objectLock'], 'storage capability checks');
	exactKeys(
		evidence.checks.versioning,
		['command', 'exitCode', 'response', 'status'],
		'storage versioning check'
	);
	exactKeys(
		evidence.checks.objectLock,
		['command', 'exitCode', 'errorCode', 'status'],
		'storage Object Lock check'
	);
	const base = [
		path.resolve(execution.awsExecutable),
		'--no-cli-pager',
		'--profile',
		'simforge',
		'--region',
		'us-west-1',
		's3api'
	];
	const suffix = ['--bucket', 'dev-simforge-435362779479-models', '--output', 'json'];
	assert(
		canonicalJson(evidence.checks.versioning.command) ===
			canonicalJson([...base, 'get-bucket-versioning', ...suffix]),
		'storage versioning argv changed'
	);
	assert(
		canonicalJson(evidence.checks.objectLock.command) ===
			canonicalJson([...base, 'get-object-lock-configuration', ...suffix]),
		'storage Object Lock argv changed'
	);
	exactKeys(evidence.checks.versioning.response, [], 'storage versioning response');
	assert(
		evidence.checks.versioning.exitCode === 0 && evidence.checks.versioning.status === 'absent',
		'bucket versioning is enabled or unknown'
	);
	assert(
		evidence.checks.objectLock.exitCode === 254 &&
			evidence.checks.objectLock.errorCode === 'ObjectLockConfigurationNotFoundError' &&
			evidence.checks.objectLock.status === 'absent',
		'bucket Object Lock is enabled or unknown'
	);
	return evidence;
}

function defaultStorage(runtime) {
	return {
		kind: 's3',
		bucket: 'dev-simforge-435362779479-models',
		region: 'us-west-1',
		profile: 'simforge',
		prefixTemplate: STORAGE_PREFIX_TEMPLATE
	};
}

function buildStoragePreflightProjection(runtime) {
	return {
		awsExecutable: path.resolve(runtime.awsExecutable),
		attemptRoot: path.resolve(runtime.storagePreflightAttemptRoot),
		outputPath: path.resolve(runtime.storagePreflightPath),
		probeBytes: runtime.probeBytes,
		projectedSmokePeakBytes: runtime.projectedSmokePeakBytes,
		scratchMultiplier: 2,
		postDeleteHeadAttempts: 5,
		postDeleteDelayMs: 1000,
		metadataKey: 'sha256',
		probeKeySegment: '_unregistered-preflight'
	};
}

function assertExactSmokeStorageSizing(probeBytes, projectedSmokePeakBytes) {
	assert(
		probeBytes === EXACT_PROBE_BYTES,
		'probeBytes must equal the outcome-blind 16 MiB protocol bound'
	);
	assert(
		projectedSmokePeakBytes === EXACT_PROJECTED_SMOKE_PEAK_BYTES,
		'projectedSmokePeakBytes must equal the conservative 64 GiB protocol bound'
	);
	return 2 * projectedSmokePeakBytes;
}

export function buildV34B1SmokeAuthorizationBasis(runtime) {
	const { execution, paths } = buildExecutionProjection(runtime);
	for (const [label, executable] of [
		['node executable', execution.nodeExecutable],
		['python executable', execution.pythonExecutable],
		['AWS executable', execution.awsExecutable],
		['nvidia-smi executable', execution.gpuProbe.executable]
	])
		assertRegularFile(executable, label);
	const checkpoint = fileRecord(execution.checkpointPath);
	const checkpointManifest = fileRecord(execution.checkpointManifestPath);
	assert(
		checkpoint.bytes === 3354466 && checkpoint.sha256 === PARENT_CHECKPOINT_SHA256,
		'parent checkpoint identity changed'
	);
	assert(
		checkpointManifest.sha256 === PARENT_MANIFEST_SHA256,
		'parent checkpoint manifest changed'
	);
	const config = readJson(execution.configPath, 'parent policy config');
	assert(exactPolicyConfig(config), 'parent policy config changed');
	const catalog = fileRecord(execution.catalogPath);
	const smokeFreezeProtocol = verifyFreezeProtocol(paths.smokeFreezeProtocol);
	const inventory = repoInventory(runtime.repoRoot, {
		liveCatalog: execution.catalogPath,
		smokeFreezeProtocol: paths.smokeFreezeProtocol
	});
	assertIntegrationFableReviewChain(inventory);
	assert(
		inventory.strengthToolingLock.sha256 === STRENGTH_LOCK_SHA256,
		'frozen strength-tooling lock changed'
	);
	const baseProtocol = readJson(inventory.baseProtocol.path, 'V34 base protocol');
	assertCatalogBinding(baseProtocol, runtime.repoRoot, catalog);
	assertStorageCapabilityEvidence(
		readJson(inventory.storageCapabilityPreflight.path, 'storage capability preflight'),
		execution
	);
	const laneBProtocol = readJson(inventory.laneBProtocol.path, 'Lane B protocol');
	assertClosedLaneBProtocol(laneBProtocol);
	assertSmokeSeedsDisjointFromRegistered(laneBProtocol);
	assert(
		sha256Canonical(laneBProtocol) === LANE_B_PROTOCOL_CANONICAL_SHA256,
		'Lane B canonical protocol hash changed'
	);
	const providerEvidenceRecord = fileRecord(paths.providerBindingEvidence);
	assert(
		canonicalJson(providerEvidenceRecord) === canonicalJson(inventory.parentProviderPreflight),
		'CLI provider evidence differs from the inventory-bound strict preflight'
	);
	const providerEvidence = readJson(paths.providerBindingEvidence, 'provider binding evidence');
	const { preflightBinding, expectedExecutionBinding } = assertProviderEvidence(
		providerEvidence,
		checkpoint,
		checkpointManifest,
		config,
		execution
	);
	const providerAudit = assertProviderAudit(
		readJson(inventory.parentAdapterLivePreflight.path, 'provider preflight audit'),
		providerEvidence,
		inventory
	);
	validateV34B1StrictEnvironmentPreflight(
		readJson(inventory.strictEnvironmentPreflight.path, 'strict environment preflight'),
		{ execution, providerEvidence, providerAudit, inventory }
	);
	const exactScratchMinimumFreeBytes = assertExactSmokeStorageSizing(
		runtime.probeBytes,
		runtime.projectedSmokePeakBytes
	);
	const storagePreflight = buildStoragePreflightProjection(runtime);
	execution.scratchMinimumFreeBytes = exactScratchMinimumFreeBytes;
	execution.expectedProviderBinding = structuredClone(expectedExecutionBinding);
	validateAbsoluteUnder(storagePreflight.attemptRoot, '/dev/shm', 'storage preflight attemptRoot');
	const authorization = structuredClone(BASIS_FLAGS);
	const authorizationBasis = {
		status: 'outcome-blind-pre-execution',
		outcomesInspected: false,
		sourceImplementationCommit: SOURCE_IMPLEMENTATION_COMMIT,
		reviewedPlanCommit: REVIEWED_PLAN_COMMIT,
		parentAdapterCommit: PARENT_ADAPTER_COMMIT,
		authorizationImplementationCommit: runtime.implementationCommit,
		protocol: {
			record: inventory.laneBProtocol,
			canonicalSha256: LANE_B_PROTOCOL_CANONICAL_SHA256,
			registeredRanges: 38,
			allRegisteredRangesClosed: true
		},
		seedLedger: structuredClone(EXACT_SEED_LEDGER),
		policy: {
			config: inventory.policyConfig,
			configCanonicalSha256: sha256Canonical(config),
			adapter: inventory.parentAdapter,
			checkpoint,
			checkpointManifest,
			providerBindingEvidence: providerEvidenceRecord,
			providerPreflightBinding: preflightBinding,
			providerPreflightBindingCanonicalSha256: providerEvidence.policyBindingSha256,
			expectedExecutionProviderBinding: expectedExecutionBinding,
			expectedExecutionProviderBindingCanonicalSha256: sha256Canonical(expectedExecutionBinding)
		},
		inventory,
		execution,
		paths,
		storage: defaultStorage(runtime),
		storagePreflight,
		smokeFreezeProtocol,
		retry: {
			attempt: 1,
			attemptsMax: 2,
			retryAllowedNow: false,
			retryableExitCodes: { serverStart: 90, processInterrupted: 92 },
			identicalFullSeedRangeOnly: true,
			attemptSplicing: false,
			seedSubstitution: false,
			backfill: false,
			outcomeDependentRetry: false,
			partialRepair: false,
			thirdAttempt: false
		},
		publication: {
			basis: 'exclusive-create-wx-then-readback',
			storagePreflight: 'exclusive-create-new-only',
			executionLock: 'exclusive-create-wx-then-readback',
			attemptRoot: 'must-be-lexically-absent-before-consumption',
			consumedMarker: 'exclusive-create-immediately-before-execFile-launch',
			runtimeOutputs: 'new-only-no-follow-no-overwrite',
			shell: false
		},
		authorization
	};
	assertExactSeedLedger(authorizationBasis.seedLedger);
	assertExactFlags(authorizationBasis.authorization, BASIS_FLAGS, 'basis authorization');
	assertGitBinding(
		runtime.repoRoot,
		runtime.implementationCommit,
		inventory,
		runtime.checkGitClean !== false
	);
	const authorizationBasisSha256 = sha256Canonical(authorizationBasis);
	const derivedStoragePrefix = `arc-spirits/v34/lane-b/${authorizationBasisSha256}/`;
	return {
		schemaVersion: BASIS_SCHEMA,
		authorizationBasis,
		authorizationBasisSha256,
		derivedStoragePrefix,
		flags: structuredClone(BASIS_FLAGS)
	};
}

function verifyBasisShape(basis, repoRoot, { requireFuturePathsAbsent = true } = {}) {
	exactKeys(
		basis,
		[
			'schemaVersion',
			'authorizationBasis',
			'authorizationBasisSha256',
			'derivedStoragePrefix',
			'flags'
		],
		'authorization basis root'
	);
	assert(basis.schemaVersion === BASIS_SCHEMA, 'authorization basis schema changed');
	exactKeys(
		basis.authorizationBasis,
		[
			'status',
			'outcomesInspected',
			'sourceImplementationCommit',
			'reviewedPlanCommit',
			'parentAdapterCommit',
			'authorizationImplementationCommit',
			'protocol',
			'seedLedger',
			'policy',
			'inventory',
			'execution',
			'paths',
			'storage',
			'storagePreflight',
			'smokeFreezeProtocol',
			'retry',
			'publication',
			'authorization'
		],
		'authorizationBasis'
	);
	assert(
		basis.authorizationBasisSha256 === sha256Canonical(basis.authorizationBasis),
		'authorization basis canonical SHA-256 changed'
	);
	assert(
		basis.derivedStoragePrefix === `arc-spirits/v34/lane-b/${basis.authorizationBasisSha256}/`,
		'derived storage prefix changed'
	);
	assertExactFlags(basis.flags, BASIS_FLAGS, 'basis root flags');
	assertExactFlags(basis.authorizationBasis.authorization, BASIS_FLAGS, 'basis authorization');
	assert(
		basis.authorizationBasis.status === 'outcome-blind-pre-execution' &&
			basis.authorizationBasis.outcomesInspected === false,
		'basis is not outcome-blind/pre-execution'
	);
	assertExactSeedLedger(basis.authorizationBasis.seedLedger);
	assert(
		basis.authorizationBasis.sourceImplementationCommit === SOURCE_IMPLEMENTATION_COMMIT &&
			basis.authorizationBasis.reviewedPlanCommit === REVIEWED_PLAN_COMMIT &&
			basis.authorizationBasis.parentAdapterCommit === PARENT_ADAPTER_COMMIT,
		'implementation ancestry anchors changed'
	);
	assert(
		basis.authorizationBasis.protocol.canonicalSha256 === LANE_B_PROTOCOL_CANONICAL_SHA256 &&
			basis.authorizationBasis.protocol.allRegisteredRangesClosed === true,
		'closed protocol binding changed'
	);
	exactKeys(
		basis.authorizationBasis.inventory,
		[...Object.keys(REQUIRED_REPO_FILES), 'liveCatalog', 'smokeFreezeProtocol'],
		'basis inventory'
	);
	for (const [name, record] of Object.entries(basis.authorizationBasis.inventory)) {
		verifyFileRecord(record, `inventory.${name}`);
	}
	assertIntegrationFableReviewChain(basis.authorizationBasis.inventory);
	for (const [name, record] of Object.entries({
		checkpoint: basis.authorizationBasis.policy.checkpoint,
		checkpointManifest: basis.authorizationBasis.policy.checkpointManifest,
		providerBindingEvidence: basis.authorizationBasis.policy.providerBindingEvidence,
		smokeFreezeProtocol: basis.authorizationBasis.smokeFreezeProtocol
	}))
		verifyFileRecord(record, name);
	assert(
		basis.authorizationBasis.inventory.strengthToolingLock.sha256 === STRENGTH_LOCK_SHA256,
		'frozen strength-tooling lock changed'
	);
	assert(
		basis.authorizationBasis.policy.checkpoint.bytes === 3354466 &&
			basis.authorizationBasis.policy.checkpoint.sha256 === PARENT_CHECKPOINT_SHA256 &&
			basis.authorizationBasis.policy.checkpointManifest.sha256 === PARENT_MANIFEST_SHA256,
		'frozen parent checkpoint/manifest changed'
	);
	assert(
		canonicalJson(basis.authorizationBasis.protocol.record) ===
			canonicalJson(basis.authorizationBasis.inventory.laneBProtocol),
		'protocol record differs from the exact inventory binding'
	);
	const protocol = readJson(basis.authorizationBasis.protocol.record.path, 'bound Lane B protocol');
	assertClosedLaneBProtocol(protocol);
	assertSmokeSeedsDisjointFromRegistered(protocol);
	assert(
		sha256Canonical(protocol) === LANE_B_PROTOCOL_CANONICAL_SHA256,
		'live Lane B protocol changed'
	);
	assertCatalogBinding(
		readJson(basis.authorizationBasis.inventory.baseProtocol.path, 'V34 base protocol'),
		repoRoot,
		basis.authorizationBasis.inventory.liveCatalog
	);
	const execution = basis.authorizationBasis.execution;
	const paths = basis.authorizationBasis.paths;
	assertExecutionPathContract(execution, paths);
	assertStorageCapabilityEvidence(
		readJson(
			basis.authorizationBasis.inventory.storageCapabilityPreflight.path,
			'storage capability preflight'
		),
		execution
	);
	assert(
		path.resolve(repoRoot) === execution.repoRoot,
		'verifier repoRoot differs from the bound repo'
	);
	exactKeys(
		execution,
		[
			'host',
			'repoRoot',
			'artifactRoot',
			'attemptRoot',
			'socketPath',
			'catalogPath',
			'configPath',
			'policyModulePath',
			'collectorPath',
			'orchestratorPath',
			'checkpointPath',
			'checkpointManifestPath',
			'nodeExecutable',
			'pythonExecutable',
			'awsExecutable',
			'gpuProbe',
			'serverReadyTimeoutMs',
			'environment',
			'environmentPolicy',
			'server',
			'orchestrator',
			'postflight',
			'shards',
			'scratchMinimumFreeBytes',
			'expectedProviderBinding'
		],
		'execution'
	);
	assert(
		Number.isSafeInteger(execution.scratchMinimumFreeBytes) &&
			execution.scratchMinimumFreeBytes ===
				assertExactSmokeStorageSizing(
					basis.authorizationBasis.storagePreflight.probeBytes,
					basis.authorizationBasis.storagePreflight.projectedSmokePeakBytes
				),
		'launch-time scratch minimum changed'
	);
	assert(execution.serverReadyTimeoutMs === 120000, 'server readiness timeout changed');
	assert(
		canonicalJson(execution.expectedProviderBinding) ===
			canonicalJson(basis.authorizationBasis.policy.expectedExecutionProviderBinding),
		'execution expected provider binding changed'
	);
	exactKeys(
		basis.authorizationBasis.policy,
		[
			'config',
			'configCanonicalSha256',
			'adapter',
			'checkpoint',
			'checkpointManifest',
			'providerBindingEvidence',
			'providerPreflightBinding',
			'providerPreflightBindingCanonicalSha256',
			'expectedExecutionProviderBinding',
			'expectedExecutionProviderBindingCanonicalSha256'
		],
		'policy'
	);
	assert(
		canonicalJson(basis.authorizationBasis.policy.providerBindingEvidence) ===
			canonicalJson(basis.authorizationBasis.inventory.parentProviderPreflight),
		'strict provider evidence is not the inventory-bound preflight'
	);
	assert(
		canonicalJson(execution.shards) === canonicalJson(expectedShardLaunches(execution, paths)),
		'shard launches changed'
	);
	assert(
		canonicalJson(execution.environment) ===
			canonicalJson({
				ARC_V34_PARENT_CHECKPOINT: execution.checkpointPath,
				ARC_V34_INFER_SOCKET: execution.socketPath,
				ARC_V34_INFER_TIMEOUT_MS: '30000',
				ARC_V34_EXPECT_DEVICE: 'cuda:0',
				CUDA_VISIBLE_DEVICES: '7'
			}),
		'exact environment changed'
	);
	assert(
		execution.host === EXACT_HOST && execution.artifactRoot === EXACT_ARTIFACT_ROOT,
		'execution host/root changed'
	);
	assert(
		basis.authorizationBasis.storage.prefixTemplate === STORAGE_PREFIX_TEMPLATE,
		'storage prefix template changed'
	);
	exactKeys(
		basis.authorizationBasis.storage,
		['kind', 'bucket', 'region', 'profile', 'prefixTemplate'],
		'storage'
	);
	exactKeys(
		basis.authorizationBasis.storagePreflight,
		[
			'awsExecutable',
			'attemptRoot',
			'outputPath',
			'probeBytes',
			'projectedSmokePeakBytes',
			'scratchMultiplier',
			'postDeleteHeadAttempts',
			'postDeleteDelayMs',
			'metadataKey',
			'probeKeySegment'
		],
		'storagePreflight'
	);
	assert(
		basis.authorizationBasis.storagePreflight.outputPath === paths.storagePreflight,
		'storage preflight output path changed'
	);
	const verifiedProvider = assertProviderEvidence(
		readJson(paths.providerBindingEvidence, 'provider binding evidence'),
		basis.authorizationBasis.policy.checkpoint,
		basis.authorizationBasis.policy.checkpointManifest,
		readJson(basis.authorizationBasis.policy.config.path, 'policy config'),
		execution
	);
	const providerEvidence = readJson(paths.providerBindingEvidence, 'provider binding evidence');
	const providerAudit = assertProviderAudit(
		readJson(
			basis.authorizationBasis.inventory.parentAdapterLivePreflight.path,
			'provider preflight audit'
		),
		providerEvidence,
		basis.authorizationBasis.inventory
	);
	validateV34B1StrictEnvironmentPreflight(
		readJson(
			basis.authorizationBasis.inventory.strictEnvironmentPreflight.path,
			'strict environment preflight'
		),
		{
			execution,
			providerEvidence,
			providerAudit,
			inventory: basis.authorizationBasis.inventory
		}
	);
	assert(
		canonicalJson(verifiedProvider.preflightBinding) ===
			canonicalJson(basis.authorizationBasis.policy.providerPreflightBinding) &&
			canonicalJson(verifiedProvider.expectedExecutionBinding) ===
				canonicalJson(basis.authorizationBasis.policy.expectedExecutionProviderBinding) &&
			basis.authorizationBasis.policy.providerPreflightBindingCanonicalSha256 ===
				sha256Canonical(verifiedProvider.preflightBinding) &&
			basis.authorizationBasis.policy.expectedExecutionProviderBindingCanonicalSha256 ===
				sha256Canonical(verifiedProvider.expectedExecutionBinding),
		'provider preflight/execution binding projection changed'
	);
	assertGitBinding(
		path.resolve(repoRoot),
		basis.authorizationBasis.authorizationImplementationCommit,
		basis.authorizationBasis.inventory,
		false
	);
	if (requireFuturePathsAbsent) {
		assertAbsent(paths.storagePreflight, 'storage preflight output');
		assertAbsent(
			basis.authorizationBasis.storagePreflight.attemptRoot,
			'storage preflight attempt root'
		);
		assertExecutionOutputPathsAbsent(execution, paths, { includeLock: true });
	}
	return basis;
}

export function verifyV34B1SmokeAuthorizationBasis({
	basisPath,
	repoRoot = DEFAULT_ROOT,
	requireFuturePathsAbsent = true
}) {
	const resolved = path.resolve(basisPath);
	const basis = readJson(resolved, 'authorization basis');
	assert(
		basis.authorizationBasis?.paths?.authorizationBasis === resolved,
		'basis is not at its bound absolute path'
	);
	return verifyBasisShape(basis, repoRoot, { requireFuturePathsAbsent });
}

function assertStoragePreflight(preflight, basis, preflightRecord) {
	assert(preflight.schemaVersion === STORAGE_PREFLIGHT_SCHEMA, 'storage preflight schema changed');
	const validated = validateStoragePreflightReport({
		reportPath: preflightRecord.path,
		basisPath: basis.authorizationBasis.paths.authorizationBasis,
		repo: basis.authorizationBasis.execution.repoRoot,
		requirePassed: true
	});
	assert(
		canonicalJson(validated) === canonicalJson(preflight),
		'storage validator returned different evidence'
	);
	verifyFileRecord(preflightRecord, 'storage preflight record');
	return preflight;
}

function assertSyntheticFileRecord(record, expectedPath, label) {
	exactKeys(record, ['path', 'bytes', 'sha256'], label);
	assert(path.resolve(record.path) === path.resolve(expectedPath), `${label}.path changed`);
	assert(Number.isSafeInteger(record.bytes) && record.bytes >= 0, `${label}.bytes is invalid`);
	assert(SHA256_RE.test(record.sha256), `${label}.sha256 is invalid`);
	return record;
}

export function createV34B1DensitySmokeExecutionLockIntegrationHooks({
	basis,
	basisRecord,
	preflightRecord
}) {
	return Object.freeze({
		mode: 'synthetic-outcome-free-integration-v1',
		basis: structuredClone(basis),
		basisRecord: structuredClone(basisRecord),
		preflightRecord: structuredClone(preflightRecord)
	});
}

function constructV34B1DensitySmokeExecutionLock({
	basis,
	basisRecord,
	preflightRecord,
	createdAt
}) {
	return {
		schemaVersion: EXECUTION_LOCK_SCHEMA,
		authoritative: true,
		outcomeBlind: true,
		authorizationBasis: structuredClone(basisRecord),
		authorizationBasisSha256: basis.authorizationBasisSha256,
		derivedStoragePrefix: basis.derivedStoragePrefix,
		storagePreflight: structuredClone(preflightRecord),
		seedLedger: structuredClone(EXACT_SEED_LEDGER),
		execution: structuredClone(basis.authorizationBasis.execution),
		paths: structuredClone(basis.authorizationBasis.paths),
		expectedExecutionProviderBindingCanonicalSha256:
			basis.authorizationBasis.policy.expectedExecutionProviderBindingCanonicalSha256,
		consumption: {
			state: 'unconsumed',
			markerPath: basis.authorizationBasis.paths.consumedMarker,
			markerCreation: 'exclusive-create-immediately-before-execFile-launch',
			attempt: 1,
			noFurtherLaunchWithoutUnconsumedLock: true
		},
		flags: structuredClone(EXECUTION_FLAGS),
		createdAt
	};
}

export function buildV34B1DensitySmokeExecutionLock({
	basisPath,
	preflightPath,
	createdAt,
	integrationHooks = null
}) {
	const resolvedBasis = path.resolve(basisPath);
	let basis;
	let basisRecord;
	let preflightRecord;
	if (integrationHooks === null) {
		const unverifiedBasis = readJson(resolvedBasis, 'authorization basis');
		basis = verifyV34B1SmokeAuthorizationBasis({
			basisPath: resolvedBasis,
			repoRoot: unverifiedBasis.authorizationBasis?.execution?.repoRoot,
			requireFuturePathsAbsent: false
		});
		basisRecord = fileRecord(resolvedBasis);
		preflightRecord = fileRecord(preflightPath);
		const preflight = readJson(preflightPath, 'storage preflight');
		assertStoragePreflight(preflight, basis, preflightRecord);
	} else {
		exactKeys(
			integrationHooks,
			['mode', 'basis', 'basisRecord', 'preflightRecord'],
			'execution-lock integration hooks'
		);
		assert(
			integrationHooks.mode === 'synthetic-outcome-free-integration-v1',
			'execution-lock integration hook mode changed'
		);
		basis = structuredClone(integrationHooks.basis);
		exactKeys(
			basis,
			[
				'schemaVersion',
				'authorizationBasis',
				'authorizationBasisSha256',
				'derivedStoragePrefix',
				'flags'
			],
			'integration authorization basis root'
		);
		assert(basis.schemaVersion === BASIS_SCHEMA, 'integration authorization basis schema changed');
		assert(
			basis.authorizationBasisSha256 === sha256Canonical(basis.authorizationBasis),
			'integration authorization basis hash changed'
		);
		assert(
			basis.derivedStoragePrefix === `arc-spirits/v34/lane-b/${basis.authorizationBasisSha256}/`,
			'integration derived storage prefix changed'
		);
		assertExactFlags(basis.flags, BASIS_FLAGS, 'integration basis flags');
		assertExactFlags(
			basis.authorizationBasis.authorization,
			BASIS_FLAGS,
			'integration basis authorization'
		);
		assertExactSeedLedger(basis.authorizationBasis.seedLedger);
		assertExecutionPathContract(basis.authorizationBasis.execution, basis.authorizationBasis.paths);
		basisRecord = assertSyntheticFileRecord(
			integrationHooks.basisRecord,
			resolvedBasis,
			'integration basis record'
		);
		preflightRecord = assertSyntheticFileRecord(
			integrationHooks.preflightRecord,
			preflightPath,
			'integration storage preflight record'
		);
	}
	assert(
		path.resolve(preflightPath) === basis.authorizationBasis.paths.storagePreflight,
		'preflight path changed'
	);
	assert(!Number.isNaN(Date.parse(createdAt)), 'execution-lock createdAt is invalid');
	assertExecutionOutputPathsAbsent(
		basis.authorizationBasis.execution,
		basis.authorizationBasis.paths,
		{
			includeLock: true
		}
	);
	return constructV34B1DensitySmokeExecutionLock({
		basis,
		basisRecord,
		preflightRecord,
		createdAt
	});
}

export function verifyV34B1DensitySmokeExecutionLock({
	lockPath,
	repoRoot = DEFAULT_ROOT,
	requireOpen = true,
	requireAbsentPaths = true
}) {
	const resolvedLock = path.resolve(lockPath);
	const lock = readJson(resolvedLock, 'density-smoke execution lock');
	exactKeys(
		lock,
		[
			'schemaVersion',
			'authoritative',
			'outcomeBlind',
			'authorizationBasis',
			'authorizationBasisSha256',
			'derivedStoragePrefix',
			'storagePreflight',
			'seedLedger',
			'execution',
			'paths',
			'expectedExecutionProviderBindingCanonicalSha256',
			'consumption',
			'flags',
			'createdAt'
		],
		'execution lock'
	);
	assert(
		lock.schemaVersion === EXECUTION_LOCK_SCHEMA &&
			lock.authoritative === true &&
			lock.outcomeBlind === true,
		'execution lock identity changed'
	);
	assertExactFlags(lock.flags, EXECUTION_FLAGS, 'execution lock flags');
	assertExactSeedLedger(lock.seedLedger);
	assert(!Number.isNaN(Date.parse(lock.createdAt)), 'execution lock createdAt is invalid');
	const basisRecord = verifyFileRecord(lock.authorizationBasis, 'execution lock basis');
	const basis = verifyV34B1SmokeAuthorizationBasis({
		basisPath: basisRecord.path,
		repoRoot,
		requireFuturePathsAbsent: false
	});
	assert(
		lock.authorizationBasisSha256 === basis.authorizationBasisSha256 &&
			lock.derivedStoragePrefix === basis.derivedStoragePrefix &&
			canonicalJson(lock.execution) === canonicalJson(basis.authorizationBasis.execution) &&
			canonicalJson(lock.paths) === canonicalJson(basis.authorizationBasis.paths),
		'execution lock differs from its authorization basis'
	);
	assertExecutionPathContract(lock.execution, lock.paths);
	assert(resolvedLock === lock.paths.executionLock, 'execution lock is not at its bound path');
	const preflightRecord = verifyFileRecord(
		lock.storagePreflight,
		'execution lock storage preflight'
	);
	assert(
		preflightRecord.path === lock.paths.storagePreflight,
		'execution lock preflight path changed'
	);
	assertStoragePreflight(
		readJson(preflightRecord.path, 'storage preflight'),
		basis,
		preflightRecord
	);
	assert(
		lock.expectedExecutionProviderBindingCanonicalSha256 ===
			basis.authorizationBasis.policy.expectedExecutionProviderBindingCanonicalSha256,
		'expected execution provider binding changed'
	);
	exactKeys(
		lock.consumption,
		['state', 'markerPath', 'markerCreation', 'attempt', 'noFurtherLaunchWithoutUnconsumedLock'],
		'consumption'
	);
	assert(
		lock.consumption.markerPath === lock.paths.consumedMarker &&
			lock.consumption.markerCreation === 'exclusive-create-immediately-before-execFile-launch' &&
			lock.consumption.attempt === 1 &&
			lock.consumption.noFurtherLaunchWithoutUnconsumedLock === true,
		'execution lock consumption contract changed'
	);
	if (requireOpen) {
		assert(lock.consumption.state === 'unconsumed', 'execution lock has already been consumed');
		assert(lock.flags.densitySmokeOpen === true, 'density smoke is closed');
	}
	if (requireAbsentPaths) {
		assertExecutionOutputPathsAbsent(lock.execution, lock.paths);
		assertAbsent(
			basis.authorizationBasis.storagePreflight.attemptRoot,
			'storage preflight attempt root'
		);
	}
	return lock;
}

function writeNewJson(file, value) {
	const resolved = path.resolve(file);
	assertAbsent(resolved, 'output');
	mkdirSync(path.dirname(resolved), { recursive: true });
	writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
	chmodSync(resolved, 0o444);
	assert(
		canonicalJson(readJson(resolved, 'written output')) === canonicalJson(value),
		'written output readback changed'
	);
	return resolved;
}

function positiveInteger(raw, label) {
	assert(typeof raw === 'string' && /^\d+$/.test(raw), `${label} must be an explicit integer`);
	const value = Number(raw);
	assert(Number.isSafeInteger(value) && value > 0, `${label} is outside the safe integer range`);
	return value;
}

// Pure/temporary-filesystem contract hooks.  None can create an authorization artifact or open a flag.
export const __testOnly = Object.freeze({
	assertAbsent,
	assertCatalogBinding,
	assertExecutionOutputPathsAbsent,
	assertExecutionPathContract,
	assertExactFlags,
	assertExactSeedLedger,
	assertExactSmokeStorageSizing,
	assertIntegrationFableReviewChain,
	assertStorageCapabilityEvidence,
	buildExecutionProjection,
	expectedShardLaunches,
	verifyFileRecord,
	verifyFreezeProtocol
});

function cliResult(kind, file, value) {
	return {
		valid: true,
		schemaVersion: value.schemaVersion,
		kind,
		path: path.resolve(file),
		authorizationBasisSha256: value.authorizationBasisSha256,
		derivedStoragePrefix: value.derivedStoragePrefix
	};
}

function main() {
	const { values: args, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			repo: { type: 'string', default: DEFAULT_ROOT },
			basis: { type: 'string' },
			preflight: { type: 'string' },
			lock: { type: 'string' },
			out: { type: 'string' },
			host: { type: 'string' },
			'artifact-root': { type: 'string' },
			'attempt-root': { type: 'string' },
			'provider-binding': { type: 'string' },
			checkpoint: { type: 'string' },
			'checkpoint-manifest': { type: 'string' },
			catalog: { type: 'string' },
			'smoke-freeze-protocol': { type: 'string' },
			'storage-preflight-attempt-root': { type: 'string' },
			'storage-preflight-output': { type: 'string' },
			'execution-lock-output': { type: 'string' },
			node: { type: 'string' },
			python: { type: 'string' },
			aws: { type: 'string' },
			'nvidia-smi': { type: 'string' },
			'implementation-commit': { type: 'string' },
			'probe-bytes': { type: 'string' },
			'projected-smoke-peak-bytes': { type: 'string' },
			'created-at': { type: 'string' },
			'verify-only': { type: 'boolean' }
		}
	});
	const command = positionals[0] ?? (args['verify-only'] ? 'verify-lock' : null);
	assert(
		['create-basis', 'verify-basis', 'create-lock', 'verify-lock'].includes(command),
		'usage: v34-b1-smoke-lock.mjs create-basis|verify-basis|create-lock|verify-lock [options]'
	);
	let value;
	let output;
	if (command === 'create-basis') {
		const required = [
			'out',
			'host',
			'artifact-root',
			'attempt-root',
			'provider-binding',
			'checkpoint',
			'checkpoint-manifest',
			'catalog',
			'smoke-freeze-protocol',
			'storage-preflight-attempt-root',
			'storage-preflight-output',
			'execution-lock-output',
			'node',
			'python',
			'aws',
			'nvidia-smi',
			'implementation-commit',
			'probe-bytes',
			'projected-smoke-peak-bytes'
		];
		for (const name of required) assert(args[name], `--${name} is required`);
		value = buildV34B1SmokeAuthorizationBasis({
			repoRoot: path.resolve(args.repo),
			host: args.host,
			artifactRoot: args['artifact-root'],
			attemptRoot: args['attempt-root'],
			basisPath: args.out,
			providerBindingPath: args['provider-binding'],
			checkpointPath: args.checkpoint,
			checkpointManifestPath: args['checkpoint-manifest'],
			catalogPath: args.catalog,
			smokeFreezeProtocolPath: args['smoke-freeze-protocol'],
			storagePreflightAttemptRoot: args['storage-preflight-attempt-root'],
			storagePreflightPath: args['storage-preflight-output'],
			executionLockPath: args['execution-lock-output'],
			nodeExecutable: args.node,
			pythonExecutable: args.python,
			awsExecutable: args.aws,
			nvidiaSmiExecutable: args['nvidia-smi'],
			implementationCommit: args['implementation-commit'],
			probeBytes: positiveInteger(args['probe-bytes'], 'probe-bytes'),
			projectedSmokePeakBytes: positiveInteger(
				args['projected-smoke-peak-bytes'],
				'projected-smoke-peak-bytes'
			)
		});
		output = writeNewJson(args.out, value);
	} else if (command === 'verify-basis') {
		assert(args.basis, '--basis is required');
		output = path.resolve(args.basis);
		value = verifyV34B1SmokeAuthorizationBasis({ basisPath: output, repoRoot: args.repo });
	} else if (command === 'create-lock') {
		for (const name of ['basis', 'preflight', 'out', 'created-at'])
			assert(args[name], `--${name} is required`);
		value = buildV34B1DensitySmokeExecutionLock({
			basisPath: args.basis,
			preflightPath: args.preflight,
			createdAt: args['created-at']
		});
		assert(
			path.resolve(args.out) === value.paths.executionLock,
			'--out differs from the bound execution lock path'
		);
		output = writeNewJson(args.out, value);
	} else {
		assert(args.lock, '--lock is required');
		output = path.resolve(args.lock);
		value = verifyV34B1DensitySmokeExecutionLock({ lockPath: output, repoRoot: args.repo });
	}
	process.stdout.write(`${JSON.stringify(cliResult(command, output, value))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
