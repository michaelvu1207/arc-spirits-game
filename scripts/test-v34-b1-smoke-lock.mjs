#!/usr/bin/env node
/** Synthetic, outcome-free contract tests for v34-b1-smoke-lock.mjs. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	__testOnly,
	BASIS_FLAGS,
	EXECUTION_FLAGS,
	EXACT_SEED_LEDGER,
	buildV34B1DensitySmokeExecutionLock,
	canonicalJson,
	createV34B1DensitySmokeExecutionLockIntegrationHooks,
	deriveExpectedExecutionProviderBinding,
	fileRecord,
	sha256Canonical,
	validateV34B1StrictEnvironmentPreflight,
	verifyV34B1DensitySmokeExecutionLock,
	verifyV34B1SmokeAuthorizationBasis
} from './v34-b1-smoke-lock.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'v34-b1-smoke-lock-test-'));
let passed = 0;

function test(name, callback) {
	try {
		callback();
		passed += 1;
		process.stdout.write(`ok ${passed} - ${name}\n`);
	} catch (error) {
		process.stderr.write(`not ok ${passed + 1} - ${name}\n${error.stack}\n`);
		process.exitCode = 1;
	}
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

test('canonical JSON is key-order independent', () => {
	assert.equal(
		canonicalJson({ z: 1, a: { y: 2, b: 3 } }),
		canonicalJson({ a: { b: 3, y: 2 }, z: 1 })
	);
	assert.equal(sha256Canonical({ b: 2, a: 1 }), sha256Canonical({ a: 1, b: 2 }));
});

test('canonical JSON rejects non-finite numbers', () => {
	assert.throws(() => canonicalJson({ invalid: Number.NaN }), /finite numbers/);
});

test('the exact 512-game unregistered seed ledger passes', () => {
	__testOnly.assertExactSeedLedger(EXACT_SEED_LEDGER);
	assert.equal(EXACT_SEED_LEDGER.shards.length, 16);
});

test('seed endpoint mutation fails closed', () => {
	const ledger = clone(EXACT_SEED_LEDGER);
	ledger.seedMax += 1;
	assert.throws(() => __testOnly.assertExactSeedLedger(ledger), /seed ledger changed/);
});

test('seed substitution fails closed', () => {
	const ledger = clone(EXACT_SEED_LEDGER);
	ledger.shards[7].seed0 += 1;
	assert.throws(() => __testOnly.assertExactSeedLedger(ledger), /seed ledger changed/);
});

test('basis opens only the storage preflight', () => {
	__testOnly.assertExactFlags(BASIS_FLAGS, BASIS_FLAGS, 'basis flags');
	assert.deepEqual(
		Object.entries(BASIS_FLAGS).filter(([, value]) => value),
		[['storagePreflightOpen', true]]
	);
});

test('execution lock opens only the unregistered density smoke', () => {
	__testOnly.assertExactFlags(EXECUTION_FLAGS, EXECUTION_FLAGS, 'execution flags');
	assert.deepEqual(
		Object.entries(EXECUTION_FLAGS).filter(([, value]) => value),
		[['densitySmokeOpen', true]]
	);
});

test('registered execution flag mutation fails closed', () => {
	const flags = { ...EXECUTION_FLAGS, registeredSeedsOpen: true };
	assert.throws(
		() => __testOnly.assertExactFlags(flags, EXECUTION_FLAGS, 'execution flags'),
		/execution flags changed/
	);
});

test('extra authorization flag fails exact-key validation', () => {
	const flags = { ...BASIS_FLAGS, surpriseOpen: false };
	assert.throws(
		() => __testOnly.assertExactFlags(flags, BASIS_FLAGS, 'basis flags'),
		/basis flags keys changed/
	);
});

test('file records bind absolute path, size, and live hash', () => {
	const file = path.join(root, 'bound.txt');
	writeFileSync(file, 'alpha\n');
	const record = fileRecord(file);
	__testOnly.verifyFileRecord(record, 'fixture');
	writeFileSync(file, 'beta\n');
	assert.throws(
		() => __testOnly.verifyFileRecord(record, 'fixture'),
		/live hash\/size\/path changed/
	);
});

test('absent-path check rejects an existing file', () => {
	const file = path.join(root, 'exists');
	writeFileSync(file, 'x');
	assert.throws(() => __testOnly.assertAbsent(file, 'fixture output'), /must be absent/);
});

test('absent-path check rejects a dangling symlink', () => {
	const link = path.join(root, 'dangling');
	symlinkSync(path.join(root, 'missing-target'), link);
	assert.throws(() => __testOnly.assertAbsent(link, 'fixture output'), /must be absent/);
});

test('exact shard launches cover 962000000..962000511 with no overlap', () => {
	const attemptRoot = path.join(root, 'attempt');
	const execution = {
		attemptRoot,
		nodeExecutable: '/fixture/node',
		collectorPath: '/fixture/collector.mjs',
		catalogPath: '/fixture/catalog.json',
		configPath: '/fixture/config.json',
		policyModulePath: '/fixture/policy.mjs'
	};
	const shards = __testOnly.expectedShardLaunches(execution, {});
	assert.equal(shards.length, 16);
	const seeds = shards.flatMap((shard) =>
		Array.from({ length: shard.games }, (_, offset) => shard.seed0 + offset)
	);
	assert.equal(new Set(seeds).size, 512);
	assert.deepEqual([Math.min(...seeds), Math.max(...seeds)], [962000000, 962000511]);
	assert(shards.every((shard) => shard.argv.includes('--games') && shard.argv.includes('32')));
});

test('smoke freezer protocol accepts only the exact 110-percent quotas', () => {
	const file = path.join(root, 'freeze-protocol.json');
	writeFileSync(
		file,
		JSON.stringify({
			schemaVersion: 'arc-v34-teacher-snapshot-freeze-protocol-v1',
			quotas: { recovery: 1375, late: 6875, mid: 3438, early: 2063 }
		})
	);
	__testOnly.verifyFreezeProtocol(file);
	writeFileSync(
		file,
		JSON.stringify({
			schemaVersion: 'arc-v34-teacher-snapshot-freeze-protocol-v1',
			quotas: { recovery: 1374, late: 6875, mid: 3438, early: 2063 }
		})
	);
	assert.throws(() => __testOnly.verifyFreezeProtocol(file), /smoke freeze quotas changed/);
});

test('integration Fable PASS explicitly supersedes every preserved BLOCK item', () => {
	const blockPath = path.join(root, 'fable-block.md');
	const passPath = path.join(root, 'fable-pass.md');
	writeFileSync(
		blockPath,
		[
			'Verdict: **BLOCK**',
			'expectedExecutionProviderBindingCanonicalSha256',
			'targetDeletionInvariance',
			'outside the scratch attempt root'
		].join('\n')
	);
	writeFileSync(
		passPath,
		[
			'Verdict: **PASS**',
			'Supersedes: b1-smoke-integration-fable-review-attempt1.md',
			'expectedExecutionProviderBindingCanonicalSha256',
			'targetDeletionInvariance',
			'b1-density-smoke-attempt-1.orchestrator.result.json',
			'collector-exported-bounded-16-way-feature-only-merge-v1',
			'strict-environment-preflight'
		].join('\n')
	);
	const inventory = {
		densitySmokeIntegrationFableBlock: fileRecord(blockPath),
		densitySmokeIntegrationFinalFablePass: fileRecord(passPath)
	};
	__testOnly.assertIntegrationFableReviewChain(inventory);
	writeFileSync(passPath, 'Verdict: **PASS**\n');
	assert.throws(
		() => __testOnly.assertIntegrationFableReviewChain(inventory),
		/explicit BLOCK supersession/
	);
});

test('authorization-basis verifier rejects root-key additions before reading outcomes', () => {
	const file = path.join(root, 'bad-basis-extra.json');
	const authorizationBasis = { paths: { authorizationBasis: file } };
	writeFileSync(
		file,
		JSON.stringify({
			schemaVersion: 'arc-v34-b1-smoke-authorization-basis-v1',
			authorizationBasis,
			authorizationBasisSha256: sha256Canonical(authorizationBasis),
			derivedStoragePrefix: `arc-spirits/v34/lane-b/${sha256Canonical(authorizationBasis)}/`,
			flags: BASIS_FLAGS,
			extra: false
		})
	);
	assert.throws(
		() => verifyV34B1SmokeAuthorizationBasis({ basisPath: file, repoRoot: root }),
		/authorization basis root keys changed/
	);
});

test('authorization-basis verifier rejects an incomplete basis before trusting its prefix', () => {
	const file = path.join(root, 'bad-basis-prefix.json');
	const authorizationBasis = { paths: { authorizationBasis: file } };
	writeFileSync(
		file,
		JSON.stringify({
			schemaVersion: 'arc-v34-b1-smoke-authorization-basis-v1',
			authorizationBasis,
			authorizationBasisSha256: sha256Canonical(authorizationBasis),
			derivedStoragePrefix: 'arc-spirits/v34/lane-b/not-the-basis/',
			flags: BASIS_FLAGS
		})
	);
	assert.throws(
		() => verifyV34B1SmokeAuthorizationBasis({ basisPath: file, repoRoot: root }),
		/authorizationBasis keys changed/
	);
});

test('provider preflight identity projects to execution by changing only the socket', () => {
	const evidence = JSON.parse(
		readFileSync(
			path.join(
				path.dirname(fileURLToPath(import.meta.url)),
				'..',
				'ml',
				'experiments',
				'v34-latency-first-expert-iteration',
				'b1-parent-provider-preflight.json'
			),
			'utf8'
		)
	);
	const before = clone(evidence.policyBinding);
	const executionSocket = '/dev/shm/arc-v34-b1-density-smoke-attempt-1/infer.sock';
	const projected = deriveExpectedExecutionProviderBinding(evidence.policyBinding, executionSocket);
	assert.deepEqual(evidence.policyBinding, before, 'projection mutated preflight evidence');
	assert.equal(projected.runtime.client.socketPath, executionSocket);
	before.runtime.client.socketPath = executionSocket;
	assert.equal(canonicalJson(projected), canonicalJson(before));
	assert.equal('inferenceClient' in projected.runtime, false);
});

test('provider projection rejects reuse of the released preflight socket', () => {
	const binding = {
		runtime: { client: { socketPath: '/dev/shm/provider-preflight.sock' } }
	};
	assert.throws(
		() => deriveExpectedExecutionProviderBinding(binding, '/dev/shm/provider-preflight.sock'),
		/preflight and execution provider sockets must be distinct/
	);
});

test('V34 catalog binding accepts the protocol-frozen live catalog and rejects ml/catalog.json', () => {
	const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const protocol = JSON.parse(
		readFileSync(
			path.join(repo, 'ml/experiments/v34-latency-first-expert-iteration/protocol.json'),
			'utf8'
		)
	);
	__testOnly.assertCatalogBinding(
		protocol,
		repo,
		fileRecord(path.join(repo, protocol.inputs.catalog.path))
	);
	assert.throws(
		() =>
			__testOnly.assertCatalogBinding(
				protocol,
				repo,
				fileRecord(path.join(repo, 'ml/catalog.json'))
			),
		/catalog differs from the live file frozen by the V34 base protocol/
	);
});

test('storage sizing is exactly 16 MiB probe, 64 GiB peak, and 128 GiB scratch', () => {
	const mib16 = 16 * 1024 * 1024;
	const gib64 = 64 * 1024 * 1024 * 1024;
	assert.equal(__testOnly.assertExactSmokeStorageSizing(mib16, gib64), 128 * 1024 * 1024 * 1024);
	assert.throws(
		() => __testOnly.assertExactSmokeStorageSizing(mib16 - 1, gib64),
		/16 MiB protocol bound/
	);
	assert.throws(
		() => __testOnly.assertExactSmokeStorageSizing(mib16, gib64 - 1),
		/64 GiB protocol bound/
	);
});

test('storage capability evidence proves versioning and Object Lock are absent', () => {
	const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const evidence = JSON.parse(
		readFileSync(
			path.join(
				repo,
				'ml/experiments/v34-latency-first-expert-iteration/b1-storage-capability-preflight.json'
			),
			'utf8'
		)
	);
	__testOnly.assertStorageCapabilityEvidence(evidence, {
		awsExecutable: '/usr/local/bin/aws'
	});

	const versioningEnabled = clone(evidence);
	versioningEnabled.checks.versioning.status = 'enabled';
	assert.throws(
		() =>
			__testOnly.assertStorageCapabilityEvidence(versioningEnabled, {
				awsExecutable: '/usr/local/bin/aws'
			}),
		/bucket versioning is enabled or unknown/
	);

	const objectLockUnknown = clone(evidence);
	objectLockUnknown.checks.objectLock.errorCode = 'AccessDenied';
	objectLockUnknown.checks.objectLock.status = 'unknown';
	assert.throws(
		() =>
			__testOnly.assertStorageCapabilityEvidence(objectLockUnknown, {
				awsExecutable: '/usr/local/bin/aws'
			}),
		/bucket Object Lock is enabled or unknown/
	);

	const argvDrift = clone(evidence);
	argvDrift.checks.versioning.command[4] = 'us-east-1';
	assert.throws(
		() =>
			__testOnly.assertStorageCapabilityEvidence(argvDrift, {
				awsExecutable: '/usr/local/bin/aws'
			}),
		/storage versioning argv changed/
	);
});

test('strict environment preflight is exact, zero-game, and provider-bound', () => {
	const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const experiment = path.join(repo, 'ml/experiments/v34-latency-first-expert-iteration');
	const providerEvidence = JSON.parse(
		readFileSync(path.join(experiment, 'b1-parent-provider-preflight.json'), 'utf8')
	);
	const providerAudit = JSON.parse(
		readFileSync(path.join(experiment, 'b1-parent-adapter-live-preflight.json'), 'utf8')
	);
	const execution = {
		environment: {
			ARC_V34_PARENT_CHECKPOINT:
				'/data/share8/michaelvuaprilexperimentation/arc-bot/ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt',
			ARC_V34_INFER_SOCKET: '/dev/shm/arc-v34-b1-density-smoke-attempt-1/infer.sock',
			ARC_V34_INFER_TIMEOUT_MS: '30000',
			ARC_V34_EXPECT_DEVICE: 'cuda:0',
			CUDA_VISIBLE_DEVICES: '7'
		}
	};
	const inventory = {
		parentAdapter: fileRecord(path.join(repo, 'scripts/v34-parent-snapshot-policy.mjs')),
		inferenceServer: fileRecord(path.join(repo, 'ml/infer_server.py'))
	};
	const evidence = {
		schemaVersion: 'arc-v34-b1-strict-environment-preflight-v1',
		checkedAt: '2026-07-14T23:20:00.000Z',
		host: 'ubuntu@216.151.21.122',
		passed: true,
		outcomeBlind: true,
		gamesStarted: 0,
		seedsConsumed: [],
		outcomesRead: false,
		phase2OutcomesRead: false,
		environment: clone(execution.environment),
		gpu: {
			physicalIndex: 7,
			uuid: providerAudit.gpu.uuid,
			logicalDevice: 'cuda:0',
			memoryMiBAfterRelease: 0,
			utilizationPercentAfterRelease: 0,
			released: true,
			serverProcessAbsent: true,
			socketAbsent: true
		},
		provider: {
			bindingCanonicalSha256: providerEvidence.policyBindingSha256,
			providerId: providerEvidence.policyBinding.provider,
			adapterSchema: providerEvidence.policyBinding.runtime.adapterSchema,
			adapterImplementation: {
				path: 'scripts/v34-parent-snapshot-policy.mjs',
				sha256: inventory.parentAdapter.sha256
			},
			serverImplementation: {
				path: 'ml/infer_server.py',
				sha256: inventory.inferenceServer.sha256
			},
			serverIdentity: clone(providerEvidence.policyBinding.runtime.server)
		}
	};
	validateV34B1StrictEnvironmentPreflight(evidence, {
		execution,
		providerEvidence,
		providerAudit,
		inventory
	});

	const leakedGame = clone(evidence);
	leakedGame.gamesStarted = 1;
	assert.throws(
		() =>
			validateV34B1StrictEnvironmentPreflight(leakedGame, {
				execution,
				providerEvidence,
				providerAudit,
				inventory
			}),
		/zero-game outcome-blind/
	);
	const environmentDrift = clone(evidence);
	environmentDrift.environment.CUDA_VISIBLE_DEVICES = '6';
	assert.throws(
		() =>
			validateV34B1StrictEnvironmentPreflight(environmentDrift, {
				execution,
				providerEvidence,
				providerAudit,
				inventory
			}),
		/exact locked environment/
	);
	const providerDrift = clone(evidence);
	providerDrift.provider.serverIdentity.weights_sha256 = '0'.repeat(64);
	assert.throws(
		() =>
			validateV34B1StrictEnvironmentPreflight(providerDrift, {
				execution,
				providerEvidence,
				providerAudit,
				inventory
			}),
		/server\/adapter identity differs/
	);
});

test('fixture hooks exercise the real execution-lock constructor and absence contract', () => {
	const fixtureRoot = path.join(root, 'builder-fixture');
	const remoteRoot = '/data/share8/michaelvuaprilexperimentation/arc-bot';
	const basisPath = path.join(fixtureRoot, 'authorization-basis.json');
	const preflightPath = path.join(fixtureRoot, 'storage-preflight.json');
	const executionLockPath = path.join(fixtureRoot, 'execution-lock.json');
	const { execution, paths } = __testOnly.buildExecutionProjection({
		repoRoot: remoteRoot,
		artifactRoot: remoteRoot,
		attemptRoot: `/dev/shm/arc-v34-b1-lock-fixture-${process.pid}`,
		basisPath,
		providerBindingPath: path.join(fixtureRoot, 'provider.json'),
		storagePreflightPath: preflightPath,
		executionLockPath,
		smokeFreezeProtocolPath: path.join(fixtureRoot, 'freeze-protocol.json'),
		host: 'ubuntu@216.151.21.122',
		catalogPath: path.join(remoteRoot, 'ml/catalogs/live-20260713-5f4ad348.json'),
		checkpointPath: path.join(
			remoteRoot,
			'ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.pt'
		),
		checkpointManifestPath: path.join(
			remoteRoot,
			'ml/experiments/v32-onpolicy-solo/shared-critic/checkpoint.manifest.json'
		),
		nodeExecutable: '/usr/bin/node',
		pythonExecutable: '/usr/bin/python3',
		awsExecutable: '/usr/local/bin/aws',
		nvidiaSmiExecutable: '/usr/bin/nvidia-smi'
	});
	const authorizationBasis = {
		seedLedger: clone(EXACT_SEED_LEDGER),
		authorization: clone(BASIS_FLAGS),
		execution,
		paths,
		policy: { expectedExecutionProviderBindingCanonicalSha256: 'a'.repeat(64) }
	};
	const authorizationBasisSha256 = sha256Canonical(authorizationBasis);
	const basis = {
		schemaVersion: 'arc-v34-b1-smoke-authorization-basis-v1',
		authorizationBasis,
		authorizationBasisSha256,
		derivedStoragePrefix: `arc-spirits/v34/lane-b/${authorizationBasisSha256}/`,
		flags: clone(BASIS_FLAGS)
	};
	const integrationHooks = createV34B1DensitySmokeExecutionLockIntegrationHooks({
		basis,
		basisRecord: { path: basisPath, bytes: 0, sha256: 'b'.repeat(64) },
		preflightRecord: { path: preflightPath, bytes: 0, sha256: 'c'.repeat(64) }
	});
	const lock = buildV34B1DensitySmokeExecutionLock({
		basisPath,
		preflightPath,
		createdAt: '2026-07-14T23:20:00.000Z',
		integrationHooks
	});
	assert.equal(lock.schemaVersion, 'arc-v34-b1-density-smoke-execution-lock-v1');
	assert.equal(lock.paths.orchestratorResult, paths.orchestratorResult);
	assert.equal(lock.paths.finalFeatureReport, paths.finalFeatureReport);
	assert.equal(lock.expectedExecutionProviderBindingCanonicalSha256, 'a'.repeat(64));
	assert.deepEqual(
		Object.entries(lock.flags).filter(([, value]) => value),
		[['densitySmokeOpen', true]]
	);
});

test('execution-lock verifier rejects a registered-seed flag before any launch', () => {
	const file = path.join(root, 'bad-lock-flags.json');
	writeFileSync(
		file,
		JSON.stringify({
			schemaVersion: 'arc-v34-b1-density-smoke-execution-lock-v1',
			authoritative: true,
			outcomeBlind: true,
			authorizationBasis: {},
			authorizationBasisSha256: '0'.repeat(64),
			derivedStoragePrefix: `arc-spirits/v34/lane-b/${'0'.repeat(64)}/`,
			storagePreflight: {},
			seedLedger: EXACT_SEED_LEDGER,
			execution: {},
			paths: {},
			expectedExecutionProviderBindingCanonicalSha256: '0'.repeat(64),
			consumption: {},
			flags: { ...EXECUTION_FLAGS, registeredSeedsOpen: true },
			createdAt: '2026-07-14T00:00:00.000Z'
		})
	);
	assert.throws(
		() => verifyV34B1DensitySmokeExecutionLock({ lockPath: file, repoRoot: root }),
		/execution lock flags changed/
	);
});

if (!process.exitCode) process.stdout.write(`1..${passed}\n`);
