#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	GAMES_PER_SHARD,
	LOCK_SCHEMA,
	SEED0,
	SHARD_COUNT,
	SMOKE_QUOTAS,
	TOTAL_GAMES,
	assertLaunchPathsAbsent,
	buildFailureEvidence,
	buildSuccessEvidence,
	buildLaunchPlan,
	buildPerformanceEvidence,
	canonicalJson,
	classifyFailure,
	copyNewFileVerified,
	expectedShardLedger,
	mergeFeatureShards,
	parseInferenceServerStats,
	parseCli,
	publishFailureEvidence,
	publishSuccessEvidence,
	recordScratchSample,
	deleteDisposableTargetShards,
	runSmokeFreezer,
	runCollectorProcesses,
	selectTraceVerificationIndexes,
	summarizeScratchSamples,
	validateServedInfo,
	validateFreezerLedger,
	validateFeatureOnlyReport,
	validateStrictChildEnvironment,
	verifyFreezerAfterTargetDeletion,
	verifyShardReports
} from './run-v34-b1-density-smoke.mjs';
import {
	BASIS_FLAGS,
	BASIS_SCHEMA,
	EXACT_SEED_LEDGER,
	buildV34B1DensitySmokeExecutionLock,
	createV34B1DensitySmokeExecutionLockIntegrationHooks
} from './v34-b1-smoke-lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixturePlan(lock = fixtureLock()) {
	return buildLaunchPlan(lock, { fixtureMode: true });
}

function diskFixturePlan(label) {
	const root = mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', `${label}-`));
	return fixturePlan(fixtureLock(path.join(root, 'attempt'), path.join(root, 'durable')));
}

function writeJson(file, value) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: 'wx' });
}

function fixtureRecord(file) {
	const payload = readFileSync(file);
	return {
		path: path.resolve(file),
		bytes: statSync(file).size,
		sha256: createHash('sha256').update(payload).digest('hex')
	};
}

function freezerLedger(plan, inputCounts = SMOKE_QUOTAS) {
	return {
		schemaVersion: 'arc-v34-teacher-snapshot-freeze-v1',
		valid: true,
		outcomesInspected: false,
		generation: 1,
		protocol: { path: plan.paths.smokeFreezeProtocolPath },
		input: {
			path: plan.paths.mergedFeaturePath,
			rows: Object.values(inputCounts).reduce((sum, value) => sum + value, 0)
		},
		output: {
			path: plan.paths.smokeFreezeOutputPath,
			rows: Object.values(SMOKE_QUOTAS).reduce((sum, value) => sum + value, 0)
		},
		contract: {
			quotas: structuredClone(SMOKE_QUOTAS),
			withoutReplacement: true,
			recoveryPrecedence: true,
			maxRowsPerSourceGame: 48,
			maxRowsPerPublicStateHash: 4
		},
		selection: {
			rng: 'numpy.random.Generator(numpy.random.PCG64)',
			rngSeed: 34043101,
			inputCountsByBand: structuredClone(inputCounts),
			selectedCountsByBand: structuredClone(SMOKE_QUOTAS),
			capacitySkipsByBand: {},
			selectedMaxRowsPerSourceGame: 48,
			selectedMaxRowsPerPublicStateHash: 4
		}
	};
}

function fixtureLock(
	root = '/dev/shm/v34-b1-fixture-attempt',
	artifactRoot = '/data/share8/michaelvuaprilexperimentation/arc-bot/v34-b1-fixture'
) {
	const socketPath = path.join(root, 'infer.sock');
	const checkpoint = path.join(
		ROOT,
		'ml',
		'experiments',
		'v32-onpolicy-solo',
		'shared-critic',
		'checkpoint.pt'
	);
	const environment = {
		ARC_V34_EXPECT_DEVICE: 'cuda:0',
		ARC_V34_INFER_SOCKET: socketPath,
		ARC_V34_INFER_TIMEOUT_MS: '30000',
		ARC_V34_PARENT_CHECKPOINT: checkpoint,
		CUDA_VISIBLE_DEVICES: '7'
	};
	const executionLockPath = path.join(artifactRoot, 'execution-lock.json');
	const execution = {
		host: 'ubuntu@216.151.21.122',
		repoRoot: ROOT,
		artifactRoot,
		attemptRoot: root,
		socketPath,
		catalogPath: path.join(ROOT, 'ml', 'catalog.json'),
		configPath: path.join(
			ROOT,
			'ml',
			'experiments',
			'v34-latency-first-expert-iteration',
			'b1-parent-policy-config.json'
		),
		policyModulePath: path.join(ROOT, 'scripts', 'v34-parent-snapshot-policy.mjs'),
		collectorPath: path.join(ROOT, 'scripts', 'collect-v34-teacher-snapshots.mjs'),
		orchestratorPath: path.join(ROOT, 'scripts', 'run-v34-b1-density-smoke.mjs'),
		checkpointPath: checkpoint,
		checkpointManifestPath: checkpoint.replace(/\.pt$/u, '.manifest.json'),
		nodeExecutable: process.execPath,
		pythonExecutable: '/opt/arc/venv/bin/python',
		environment,
		gpuProbe: {
			executable: '/usr/bin/nvidia-smi',
			argv: [
				'--query-gpu=uuid,memory.used,utilization.gpu',
				'--format=csv,noheader,nounits',
				'--id=7'
			],
			physicalGpuIndex: 7,
			requiredMemoryMiB: 0,
			requiredUtilizationPercent: 0
		},
		server: {
			executable: '/opt/arc/venv/bin/python',
			argv: [
				path.join(ROOT, 'ml', 'infer_server.py'),
				'--weights',
				checkpoint,
				'--socket',
				socketPath,
				'--device',
				'cuda:0',
				'--window-ms',
				'2',
				'--max-batch',
				'512',
				'--stats-interval',
				'5'
			],
			stdoutPath: path.join(root, 'logs', 'server.stdout'),
			stderrPath: path.join(root, 'logs', 'server.stderr')
		},
		orchestrator: {
			executable: process.execPath,
			argv: [
				path.join(ROOT, 'scripts', 'run-v34-b1-density-smoke.mjs'),
				'--mode',
				'live',
				'--lock',
				executionLockPath
			],
			stdoutPath: path.join(artifactRoot, 'orchestrator.stdout'),
			stderrPath: path.join(artifactRoot, 'orchestrator.stderr'),
			resultPath: path.join(artifactRoot, 'orchestrator-result.json'),
			failurePath: path.join(artifactRoot, 'orchestrator-failure.json'),
			finalFeatureReportPath: path.join(artifactRoot, 'final-feature-report.json'),
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
		scratchMinimumFreeBytes: 1,
		serverReadyTimeoutMs: 120000,
		expectedProviderBinding: { runtime: { server: servedInfo(checkpoint) } }
	};
	execution.shards = expectedShardLedger().map((ledger) => {
		const stem = `shard-${String(ledger.index).padStart(2, '0')}`;
		const outDir = path.join(root, 'shards', stem);
		return {
			...ledger,
			outDir,
			stdoutPath: path.join(root, 'logs', `${stem}.stdout`),
			stderrPath: path.join(root, 'logs', `${stem}.stderr`),
			executable: process.execPath,
			argv: [
				execution.collectorPath,
				'--catalog',
				execution.catalogPath,
				'--config',
				execution.configPath,
				'--policy-module',
				execution.policyModulePath,
				'--seed0',
				String(ledger.seed0),
				'--games',
				'32',
				'--out',
				outDir
			]
		};
	});
	const paths = {
		authorizationBasis: path.join(artifactRoot, 'authorization-basis.json'),
		providerBindingEvidence: path.join(artifactRoot, 'provider-binding-evidence.json'),
		storagePreflight: path.join(artifactRoot, 'storage-preflight.json'),
		executionLock: executionLockPath,
		consumedMarker: path.join(artifactRoot, 'density-smoke.consumed.json'),
		serverReady: path.join(root, 'server-ready.json'),
		serverExit: path.join(root, 'server-exit.json'),
		finalProviderBinding: path.join(root, 'final-provider-binding.json'),
		mergedFeatures: path.join(root, 'feature-only', 'merged-snapshots.jsonl'),
		smokeFreezeOutput: path.join(root, 'feature-only', 'selected-g1.jsonl'),
		smokeFreezeLedger: path.join(root, 'feature-only', 'selection-ledger-g1.json'),
		featureOnlyReport: path.join(root, 'feature-only', 'density-smoke-report.json'),
		orchestratorStdout: execution.orchestrator.stdoutPath,
		orchestratorStderr: execution.orchestrator.stderrPath,
		orchestratorResult: execution.orchestrator.resultPath,
		orchestratorFailure: execution.orchestrator.failurePath,
		finalFeatureReport: execution.orchestrator.finalFeatureReportPath,
		serverStdout: execution.server.stdoutPath,
		serverStderr: execution.server.stderrPath
	};
	paths.smokeFreezeProtocol = path.join(root, 'feature-only', 'freeze-protocol.json');
	execution.postflight = {
		featureMerge: 'collector-exported-bounded-16-way-feature-only-merge-v1',
		freezer: {
			executable: execution.pythonExecutable,
			argv: [
				path.join(ROOT, 'ml', 'freeze_v34_teacher_snapshots.py'),
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
				executable: execution.pythonExecutable,
				argv: [
					path.join(ROOT, 'ml', 'freeze_v34_teacher_snapshots.py'),
					'verify',
					'--ledger',
					paths.smokeFreezeLedger
				]
			},
			requireFeatureSelectionOutputLedgerHashesUnchanged: true
		},
		providerPostflightHandshakeRequired: true
	};
	return {
		schemaVersion: LOCK_SCHEMA,
		authoritative: true,
		outcomeBlind: true,
		flags: {
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
		},
		execution,
		paths,
		expectedExecutionProviderBindingCanonicalSha256: createHash('sha256')
			.update(canonicalJson(execution.expectedProviderBinding))
			.digest('hex'),
		consumption: { markerPath: paths.consumedMarker }
	};
}

function servedInfo(checkpoint = '/abs/checkpoint.pt') {
	return {
		format: 'arc-entity-scorer-v2',
		obs_dim: 3419,
		act_dim: 104,
		device: 'cuda:0',
		weights: checkpoint,
		weights_sha256: 'b'.repeat(64),
		aux: {
			farm_value: true,
			route_mode: true,
			reward_pick: true,
			placement: false,
			reach30: true
		},
		reach30_horizon: 30
	};
}

function syntheticIntegrationBasis(lock) {
	const authorizationBasis = {
		authorization: structuredClone(BASIS_FLAGS),
		seedLedger: structuredClone(EXACT_SEED_LEDGER),
		policy: {
			expectedExecutionProviderBindingCanonicalSha256:
				lock.expectedExecutionProviderBindingCanonicalSha256
		},
		execution: structuredClone(lock.execution),
		paths: structuredClone(lock.paths)
	};
	const authorizationBasisSha256 = createHash('sha256')
		.update(canonicalJson(authorizationBasis))
		.digest('hex');
	return {
		schemaVersion: BASIS_SCHEMA,
		authorizationBasis,
		authorizationBasisSha256,
		derivedStoragePrefix: `arc-spirits/v34/lane-b/${authorizationBasisSha256}/`,
		flags: structuredClone(BASIS_FLAGS)
	};
}

test('freezes one contiguous 16x32 unregistered ledger', () => {
	const shards = expectedShardLedger();
	assert.equal(shards.length, SHARD_COUNT);
	assert.equal(shards[0].seed0, SEED0);
	assert.equal(shards.at(-1).seedMax, SEED0 + TOTAL_GAMES - 1);
	assert.ok(shards.every((shard) => shard.games === GAMES_PER_SHARD));
	for (let index = 1; index < shards.length; index += 1) {
		assert.equal(shards[index].seed0, shards[index - 1].seedMax + 1);
	}
});

test('strict child environment rejects every extra variable and wrong GPU/device value', () => {
	const lock = fixtureLock();
	const environment = lock.execution.environment;
	assert.deepEqual(
		validateStrictChildEnvironment(environment, lock.execution.socketPath),
		environment
	);
	assert.throws(
		() =>
			validateStrictChildEnvironment(
				{ ...environment, PATH: '/usr/bin' },
				lock.execution.socketPath
			),
		/allowlist/
	);
	assert.throws(
		() =>
			validateStrictChildEnvironment(
				{ ...environment, CUDA_VISIBLE_DEVICES: '4,7' },
				lock.execution.socketPath
			),
		/must be 7/
	);
	assert.throws(
		() =>
			validateStrictChildEnvironment(
				{ ...environment, ARC_V34_EXPECT_DEVICE: 'cuda:7' },
				lock.execution.socketPath
			),
		/must be cuda:0/
	);
});

test('builds exactly one server and sixteen non-shell collector argv arrays', () => {
	const plan = fixturePlan();
	assert.equal(plan.server.argv.filter((entry) => entry === '--socket').length, 1);
	assert.equal(plan.shards.length, 16);
	assert.equal(new Set(plan.shards.map((shard) => shard.outDir)).size, 16);
	for (const [index, shard] of plan.shards.entries()) {
		assert.ok(Array.isArray(shard.argv));
		assert.equal(shard.argv[0], path.join(ROOT, 'scripts', 'collect-v34-teacher-snapshots.mjs'));
		assert.equal(shard.argv[shard.argv.indexOf('--seed0') + 1], String(SEED0 + 32 * index));
		assert.equal(shard.argv[shard.argv.indexOf('--games') + 1], '32');
		assert.equal(shard.argv[shard.argv.indexOf('--out') + 1], shard.outDir);
	}
});

test('real lock-tool builder produces the exact orchestrator launch contract', () => {
	const root = mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'v34-b1-real-lock-'));
	const fixture = fixtureLock(
		path.join('/dev/shm', `v34-b1-real-lock-${path.basename(root)}`),
		path.join(root, 'durable')
	);
	const basis = syntheticIntegrationBasis(fixture);
	const record = (recordPath, content) => ({
		path: recordPath,
		bytes: Buffer.byteLength(content),
		sha256: createHash('sha256').update(content).digest('hex')
	});
	const basisRecord = record(fixture.paths.authorizationBasis, canonicalJson(basis));
	const preflightRecord = record(fixture.paths.storagePreflight, '{}\n');
	const builtLock = buildV34B1DensitySmokeExecutionLock({
		basisPath: fixture.paths.authorizationBasis,
		preflightPath: fixture.paths.storagePreflight,
		createdAt: '2026-07-14T18:30:00.000Z',
		integrationHooks: createV34B1DensitySmokeExecutionLockIntegrationHooks({
			basis,
			basisRecord,
			preflightRecord
		})
	});
	const plan = fixturePlan(builtLock);
	assert.equal(
		builtLock.expectedExecutionProviderBindingCanonicalSha256,
		fixture.expectedExecutionProviderBindingCanonicalSha256
	);
	assert.equal(plan.shards.length, 16);
	assert.equal(plan.paths.durableResultPath, fixture.paths.orchestratorResult);
	assert.equal(plan.paths.durableFailurePath, fixture.paths.orchestratorFailure);
	assert.equal(plan.paths.durableFeatureOnlyReportPath, fixture.paths.finalFeatureReport);
});

test('rejects seed substitution, shard count drift, and every later-stage authorization', () => {
	const substituted = fixtureLock();
	substituted.execution.shards[8].seed0 += 1;
	assert.throws(() => fixturePlan(substituted), /seed0 mismatch/);
	const short = fixtureLock();
	short.execution.shards.pop();
	assert.throws(() => fixturePlan(short), /exactly 16/);
	const promotion = fixtureLock();
	promotion.flags.promotionOpen = true;
	assert.throws(() => fixturePlan(promotion), /must remain false/);
});

test('requires the real provider hash key and exact target-deletion object', () => {
	const staleHashKey = fixtureLock();
	staleHashKey.providerBindingCanonicalSha256 =
		staleHashKey.expectedExecutionProviderBindingCanonicalSha256;
	delete staleHashKey.expectedExecutionProviderBindingCanonicalSha256;
	assert.throws(() => fixturePlan(staleHashKey), /canonical SHA-256 changed/);

	const staleDeletionBoolean = fixtureLock();
	delete staleDeletionBoolean.execution.postflight.targetDeletionInvariance;
	staleDeletionBoolean.execution.postflight.targetDeletionInvarianceRequired = true;
	assert.throws(() => fixturePlan(staleDeletionBoolean), /postflight gates changed/);
});

test('CLI defaults to a non-launching dry run and requires an execution lock', () => {
	const parsed = parseCli(['--lock', '/tmp/execution-lock.json']);
	assert.equal(parsed.mode, 'dry-run');
	assert.throws(() => parseCli([]), /--lock is required/);
	assert.throws(
		() => parseCli(['--lock', '/tmp/execution-lock.json', '--mode', 'fixture']),
		/dry-run or live/
	);
});

test('absent-path verification catches a dangling symlink', () => {
	const root = mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'v34-b1-absence-'));
	const attempt = path.join(root, 'attempt');
	const lock = fixtureLock(attempt, path.join(root, 'artifacts'));
	const plan = fixturePlan(lock);
	assert.doesNotThrow(() => assertLaunchPathsAbsent(plan));
	mkdirSync(path.dirname(plan.paths.consumedMarkerPath), { recursive: true });
	symlinkSync(path.join(root, 'does-not-exist'), plan.paths.consumedMarkerPath);
	assert.throws(() => assertLaunchPathsAbsent(plan), /already exists/);
});

test('served-info identity is exact and a final checkpoint change fails closed', () => {
	const initial = validateServedInfo(servedInfo());
	assert.deepEqual(validateServedInfo(servedInfo(), initial), initial);
	assert.throws(
		() => validateServedInfo({ ...servedInfo(), weights_sha256: 'c'.repeat(64) }, initial),
		/differs/
	);
	assert.throws(
		() => validateServedInfo({ ...servedInfo(), reach30_horizon: 25 }),
		/horizon mismatch/
	);
});

test('failure classes are 90 before readiness, 92 for clean interruption, otherwise 1', () => {
	assert.equal(
		classifyFailure({ serverReady: false, interrupted: false, collectionReportExists: false }),
		90
	);
	assert.equal(
		classifyFailure({ serverReady: true, interrupted: true, collectionReportExists: false }),
		92
	);
	assert.equal(
		classifyFailure({ serverReady: true, interrupted: true, collectionReportExists: true }),
		1
	);
	assert.equal(
		classifyFailure({ serverReady: true, interrupted: false, collectionReportExists: false }),
		1
	);
});

test('collection verification rejects partial shards and requires the exact seed union', () => {
	const plan = diskFixturePlan('v34-b1-collections');
	for (const shard of plan.shards) {
		writeJson(shard.collectionPath, {
			valid: true,
			seeds: Array.from({ length: 32 }, (_, offset) => shard.seed0 + offset),
			metrics: { featureRows: 100 }
		});
	}
	assert.equal(verifyShardReports(plan).length, 16);
	unlinkSync(plan.shards[15].collectionPath);
	assert.throws(() => verifyShardReports(plan), /ENOENT/);
	writeJson(plan.shards[15].collectionPath, {
		valid: true,
		seeds: Array.from({ length: 32 }, (_, offset) => plan.shards[15].seed0 + offset + 1)
	});
	assert.throws(() => verifyShardReports(plan), /seed set mismatch/);
});

test('postflight merger receives feature shards only and cannot splice partial attempts', async () => {
	const plan = diskFixturePlan('v34-b1-features');
	for (const shard of plan.shards) {
		mkdirSync(path.dirname(shard.featurePath), { recursive: true });
		writeFileSync(shard.featurePath, '{}\n', { flag: 'wx' });
	}
	let invocation = null;
	const result = await mergeFeatureShards(plan, async (args) => {
		invocation = args;
		return { path: args.outputFile, rows: 1234, bytes: 55, sha256: 'd'.repeat(64) };
	});
	assert.equal(result.rows, 1234);
	assert.equal(invocation.runFiles.length, 16);
	assert.deepEqual(
		invocation.runFiles,
		plan.shards.map((shard) => shard.featurePath)
	);
	assert.ok(invocation.runFiles.every((file) => file.endsWith('/features/snapshots.jsonl')));
	assert.equal(invocation.fanIn, 16);
});

test('freezer ledger requires every exact floor, PCG64 generation, and global cap', () => {
	const plan = fixturePlan();
	const ledger = freezerLedger(plan, {
		recovery: 1400,
		late: 7000,
		mid: 3500,
		early: 2100
	});
	const floors = validateFreezerLedger(plan, ledger);
	assert.deepEqual(floors.selectedCountsByBand, SMOKE_QUOTAS);
	const short = structuredClone(ledger);
	short.selection.inputCountsByBand.recovery = SMOKE_QUOTAS.recovery - 1;
	assert.throws(() => validateFreezerLedger(plan, short), /recovery floor was not supplied/);
	const wrongRng = structuredClone(ledger);
	wrongRng.selection.rngSeed += 1;
	assert.throws(() => validateFreezerLedger(plan, wrongRng), /RNG changed/);
	const cap = structuredClone(ledger);
	cap.selection.selectedMaxRowsPerSourceGame = 49;
	assert.throws(() => validateFreezerLedger(plan, cap), /cap evidence is invalid/);
});

test('smoke freezer invokes the one exact bound freeze command and validates its report', async () => {
	const plan = diskFixturePlan('v34-b1-freezer');
	mkdirSync(path.dirname(plan.paths.smokeFreezeOutputPath), { recursive: true });
	writeFileSync(plan.paths.smokeFreezeOutputPath, 'selected\n', { flag: 'wx' });
	writeJson(plan.paths.smokeFreezeLedgerPath, freezerLedger(plan));
	let invocation = null;
	const result = await runSmokeFreezer(plan, async (executable, argv, environment) => {
		invocation = { executable, argv, environment };
		return JSON.stringify({
			valid: true,
			generation: 1,
			output: { path: plan.paths.smokeFreezeOutputPath },
			ledger: { path: plan.paths.smokeFreezeLedgerPath }
		});
	});
	assert.equal(invocation.executable, plan.freezer.executable);
	assert.deepEqual(invocation.argv, plan.freezer.argv);
	assert.deepEqual(invocation.environment, plan.environment);
	assert.equal(result.floors.selectedRows, 13751);
});

test('target deletion reads no target bytes, deletes the exact disposable layout, and rejects links', () => {
	const plan = diskFixturePlan('v34-b1-target-delete');
	for (const shard of plan.shards) {
		mkdirSync(shard.targetDir, { recursive: true });
		writeFileSync(shard.targetFile, `opaque-target-${shard.index}`, { flag: 'wx' });
	}
	const deleted = deleteDisposableTargetShards(plan);
	assert.equal(deleted.shards, 16);
	assert.ok(deleted.bytesDeleted > 0);
	assert.ok(plan.shards.every((shard) => !existsSync(shard.targetDir)));

	const linkedPlan = diskFixturePlan('v34-b1-target-link');
	mkdirSync(linkedPlan.shards[0].targetDir, { recursive: true });
	symlinkSync('/tmp/forbidden-target', linkedPlan.shards[0].targetFile);
	assert.throws(() => deleteDisposableTargetShards(linkedPlan), /non-symlink regular file/);
});

test('post-deletion freezer verification rebinds unchanged feature/output/ledger hashes', async () => {
	const plan = diskFixturePlan('v34-b1-invariance');
	for (const file of [
		plan.paths.mergedFeaturePath,
		plan.paths.smokeFreezeOutputPath,
		plan.paths.smokeFreezeLedgerPath
	]) {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, `fixture-${path.basename(file)}\n`, { flag: 'wx' });
	}
	const before = {
		merged: fixtureRecord(plan.paths.mergedFeaturePath),
		output: fixtureRecord(plan.paths.smokeFreezeOutputPath),
		ledger: fixtureRecord(plan.paths.smokeFreezeLedgerPath)
	};
	let argv = null;
	const result = await verifyFreezerAfterTargetDeletion(
		plan,
		before,
		async (executable, actualArgv) => {
			assert.equal(executable, plan.freezer.executable);
			argv = actualArgv;
			return JSON.stringify({
				valid: true,
				generation: 1,
				output: { path: plan.paths.smokeFreezeOutputPath },
				ledgerSha256: before.ledger.sha256
			});
		}
	);
	assert.deepEqual(argv, [
		plan.freezer.argv[0],
		'verify',
		'--ledger',
		plan.paths.smokeFreezeLedgerPath
	]);
	assert.deepEqual(result.artifacts, before);
});

test('trace draw uses the bound PCG64 seed and exactly 1,000 unique feature indexes', async () => {
	const plan = fixturePlan();
	let invocation = null;
	const indexes = await selectTraceVerificationIndexes(
		plan,
		2000,
		async (executable, argv, environment) => {
			invocation = { executable, argv, environment };
			return JSON.stringify(Array.from({ length: 1000 }, (_, index) => 1999 - index));
		}
	);
	assert.equal(indexes.length, 1000);
	assert.equal(new Set(indexes).size, 1000);
	assert.equal(invocation.executable, plan.execution.pythonExecutable);
	assert.equal(invocation.argv.at(-1), '34049620');
	assert.equal(invocation.argv.at(-2), '1000');
	assert.deepEqual(invocation.environment, plan.environment);
});

test('live path wires merge, one freeze, deletion, verify, trace checks, and final feature report', () => {
	const source = readFileSync(path.join(ROOT, 'scripts', 'run-v34-b1-density-smoke.mjs'), 'utf8');
	for (const call of [
		'const mergedFeatures = await mergeFeatureShards',
		'const freezer = await runSmokeFreezer',
		'dependencies.deleteTargets ?? deleteDisposableTargetShards',
		'const postDeletionVerification = await verifyFreezerAfterTargetDeletion',
		'const traceIndexes = await selectTraceVerificationIndexes',
		'const traceVerification = await verifySelectedTracePrefixes',
		'writeNewFile(plan.paths.featureOnlyReportPath'
	]) {
		assert.ok(source.includes(call), `live postflight is missing ${call}`);
	}
	assert.equal((source.match(/await runSmokeFreezer\(/gu) ?? []).length, 1);
});

test('runtime, throughput, and scratch evidence use exact monotonic/boundary contracts', () => {
	const samples = [];
	for (const [phase, free] of [
		['prelaunch', 1000n],
		['after-collection', 700n],
		['after-feature-merge', 600n],
		['after-freezer', 500n],
		['after-target-deletion', 650n],
		['after-trace-verification', 620n]
	]) {
		recordScratchSample(samples, phase, free);
	}
	const scratch = summarizeScratchSamples(samples);
	assert.equal(scratch.minimumFreeBytes, '500');
	assert.equal(scratch.peakConsumedBytesRelativeToPrelaunch, '500');
	assert.throws(() => recordScratchSample(samples, 'after-freezer', 1n), /duplicated/);

	const performance = buildPerformanceEvidence({
		totalElapsedMs: 3000,
		collectionElapsedMs: 2000,
		postflightElapsedMs: 1000,
		featureRows: 4000,
		mergedFeatureBytes: 8000,
		traceVerifications: 1000
	});
	assert.equal(performance.collectionThroughput.gamesPerSecond, 256);
	assert.equal(performance.collectionThroughput.featureRowsPerSecond, 2000);
	assert.equal(performance.postflightThroughput.mergedFeatureBytesPerSecond, 8000);
});

test('strict inference-log parser aggregates batches and fails on format drift', () => {
	const log = [
		'[infer] serving /checkpoint (arc-entity-scorer-v2, obs_dim=3419, act_dim=104) on /tmp/x device=cuda:0 window=2ms max_batch=512',
		'[infer] reqs=20 rows=100 batches=4 avg_batch=25.0 batch_p50=20 batch_p95=40 batch_min=10 batch_max=40 forwards/s=8.0',
		'[infer] reqs=30 rows=150 batches=5 avg_batch=30.0 batch_p50=25 batch_p95=50 batch_min=12 batch_max=50 forwards/s=9.5',
		'[infer] shut down',
		''
	].join('\n');
	const stats = parseInferenceServerStats(log);
	assert.equal(stats.available, true);
	assert.deepEqual(stats.totals, { requests: 50, rows: 250, batches: 9 });
	assert.equal(stats.observedBatchMax, 50);
	assert.throws(
		() => parseInferenceServerStats(log.replace('forwards/s=9.5', 'renamed_forwards=9.5')),
		/format changed/
	);
	const unavailable = parseInferenceServerStats('[infer] serving x\n[infer] shut down\n');
	assert.equal(unavailable.available, false);
	assert.match(unavailable.strictUnavailableReason, /no-stats-interval/);
});

test('failure output preserves exact immutable paths and delegates incident/retry authoring', () => {
	const plan = fixturePlan();
	const failure = buildFailureEvidence(plan, {
		exitCode: 92,
		stage: 'collection',
		serverReady: true,
		interruptedSignal: 'SIGTERM',
		collectionReportExists: false,
		message: 'fixture interruption'
	});
	assert.equal(failure.exitCode, 92);
	assert.equal(failure.paths.executionLock, plan.paths.executionLockPath);
	assert.equal(failure.paths.collectionReports.length, 16);
	assert.equal(failure.externalAuthoring.incidentRecord, 'required-outside-this-attempt');
	assert.equal(failure.externalAuthoring.retryLock, 'requires-new-fable-reviewed-lock');
	assert.equal(failure.externalAuthoring.attemptSplicingAllowed, false);
});

test('durable publications are new-only, hash-verified, and result XOR failure', () => {
	const successPlan = diskFixturePlan('v34-b1-durable-success');
	writeJson(successPlan.paths.executionLockPath, { fixture: 'lock' });
	writeJson(successPlan.paths.consumedMarkerPath, { fixture: 'consumed' });
	writeJson(successPlan.paths.featureOnlyReportPath, { fixture: 'feature-only-report' });
	const reportPublication = copyNewFileVerified(
		successPlan.paths.featureOnlyReportPath,
		successPlan.paths.durableFeatureOnlyReportPath
	);
	assert.equal(reportPublication.source.sha256, reportPublication.destination.sha256);
	const success = buildSuccessEvidence(successPlan, {
		reportPublication,
		consumedMarker: fixtureRecord(successPlan.paths.consumedMarkerPath)
	});
	const publishedSuccess = publishSuccessEvidence(successPlan, success);
	assert.equal(publishedSuccess.value.valid, true);
	assert.throws(
		() => publishFailureEvidence(successPlan, { shouldNotPublish: true }),
		/durable success result/
	);
	assert.throws(
		() =>
			copyNewFileVerified(
				successPlan.paths.featureOnlyReportPath,
				successPlan.paths.durableFeatureOnlyReportPath
			),
		/refusing to overwrite/
	);

	const failurePlan = diskFixturePlan('v34-b1-durable-failure');
	const failure = buildFailureEvidence(failurePlan, {
		exitCode: 90,
		stage: 'server-start',
		serverReady: false,
		interruptedSignal: null,
		collectionReportExists: false,
		message: 'fixture failure'
	});
	assert.equal(publishFailureEvidence(failurePlan, failure).bytes > 0, true);
	assert.throws(
		() => publishSuccessEvidence(failurePlan, { shouldNotPublish: true }),
		/durable failure result/
	);
});

test('feature-only report validator keeps every later gate closed and requires all postflights', () => {
	const plan = fixturePlan();
	const report = {
		schemaVersion: 'arc-v34-b1-density-smoke-orchestration-v1',
		valid: true,
		unregistered: true,
		outcomesInspected: false,
		futureTargetsRead: false,
		attemptSpliced: false,
		seed0: SEED0,
		games: TOTAL_GAMES,
		shards: Array.from({ length: 16 }, (_, index) => ({ index })),
		freezer: {
			floors: {
				selectedRows: 13751,
				selectedCountsByBand: structuredClone(SMOKE_QUOTAS)
			}
		},
		targetDeletionInvariance: {
			shards: 16,
			targetFilesRead: false,
			artifactsUnchanged: true
		},
		traceVerification: { draws: 1000, verified: 1000, futureTargetsLoaded: false },
		servedInfo: { initial: plan.expectedServedInfo, final: plan.expectedServedInfo },
		scratchUsage: {
			root: '/dev/shm',
			initialFreeBytes: '1000',
			minimumFreeBytes: '500',
			peakConsumedBytesRelativeToPrelaunch: '500',
			samples: Array.from({ length: 7 }, (_, index) => ({
				phase: index === 0 ? 'prelaunch' : `phase-${index}`,
				freeBytes: String(1000 - index * 100)
			}))
		},
		performance: buildPerformanceEvidence({
			totalElapsedMs: 3000,
			collectionElapsedMs: 2000,
			postflightElapsedMs: 1000,
			featureRows: 13751,
			mergedFeatureBytes: 1000,
			traceVerifications: 1000
		}),
		inferenceServerStats: {
			available: true,
			servingLines: 1,
			shutdownLines: 1,
			intervals: 1
		}
	};
	assert.equal(validateFeatureOnlyReport(plan, report), report);
	const shortTrace = structuredClone(report);
	shortTrace.traceVerification.verified = 999;
	assert.throws(() => validateFeatureOnlyReport(plan, shortTrace), /trace verification changed/);
	const targetRead = structuredClone(report);
	targetRead.targetDeletionInvariance.targetFilesRead = true;
	assert.throws(
		() => validateFeatureOnlyReport(plan, targetRead),
		/target-deletion evidence changed/
	);
});

test('synthetic collectors launch all 16 shards and abort peers on the first failure', async () => {
	const plan = fixturePlan();
	const children = [];
	const actors = [];
	const launcher = (command) => {
		let resolveExit;
		const exit = new Promise((resolve) => {
			resolveExit = resolve;
		});
		const index = actors.length;
		const child = {
			exitCode: null,
			signalCode: null,
			killed: false,
			kill(signal) {
				this.killed = true;
				this.signalCode = signal;
				resolveExit({ code: null, signal });
			}
		};
		const actor = {
			child,
			exit,
			resolveExit,
			command,
			getStderrTail: () => (index === 5 ? 'fixture failure' : '')
		};
		actors.push(actor);
		return actor;
	};
	const interrupt = { interrupted: new Promise(() => {}) };
	const running = runCollectorProcesses(plan, interrupt, children, launcher);
	assert.equal(actors.length, 16);
	actors[5].child.exitCode = 3;
	actors[5].resolveExit({ code: 3, signal: null });
	await assert.rejects(running, /collector shard 5 failed/);
	assert.equal(children.length, 16);
	assert.ok(actors.filter((_, index) => index !== 5).every((actor) => actor.child.killed));
});

test('synthetic suite itself creates no GPU, game, S3, or live output', () => {
	const source = readFileSync(path.join(ROOT, 'scripts', 'run-v34-b1-density-smoke.mjs'), 'utf8');
	assert.match(source, /shell: false/);
	assert.doesNotMatch(source, /s3:\/\//u);
});
