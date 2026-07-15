#!/usr/bin/env node
/**
 * One-shot, target-blind orchestrator for the unregistered V34 B1 density smoke.
 *
 * Live execution is deliberately opt-in.  The default CLI mode verifies the immutable
 * execution lock and prints the exact launch plan without consuming the lock, probing a
 * GPU, starting a process, or creating an artifact.  `--mode live` is the sole launch path.
 */
import { createHash } from 'node:crypto';
import {
	closeSync,
	createReadStream,
	createWriteStream,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	rmdirSync,
	statfsSync,
	unlinkSync,
	writeSync
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LOCK_SCHEMA = 'arc-v34-b1-density-smoke-execution-lock-v1';
export const REPORT_SCHEMA = 'arc-v34-b1-density-smoke-orchestration-v1';
export const SEED0 = 962_000_000;
export const SHARD_COUNT = 16;
export const GAMES_PER_SHARD = 32;
export const TOTAL_GAMES = SHARD_COUNT * GAMES_PER_SHARD;
export const PHYSICAL_GPU = 7;
export const LOGICAL_DEVICE = 'cuda:0';
export const SMOKE_QUOTAS = Object.freeze({ recovery: 1375, late: 6875, mid: 3438, early: 2063 });
export const TRACE_VERIFICATION_DRAWS = 1000;
export const TRACE_VERIFICATION_SEED = 34049620;
export const REQUIRED_CHILD_ENV_KEYS = Object.freeze([
	'ARC_V34_EXPECT_DEVICE',
	'ARC_V34_INFER_SOCKET',
	'ARC_V34_INFER_TIMEOUT_MS',
	'ARC_V34_PARENT_CHECKPOINT',
	'CUDA_VISIBLE_DEVICES'
]);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const DEFAULT_LOCK_VERIFIER = path.join(ROOT, 'scripts', 'v34-b1-smoke-lock.mjs');
const COLLECTOR_PATH = path.join(ROOT, 'scripts', 'collect-v34-teacher-snapshots.mjs');
const POLICY_MODULE_PATH = path.join(ROOT, 'scripts', 'v34-parent-snapshot-policy.mjs');
const POLICY_CONFIG_PATH = path.join(
	ROOT,
	'ml',
	'experiments',
	'v34-latency-first-expert-iteration',
	'b1-parent-policy-config.json'
);

function requireCondition(condition, message) {
	if (!condition) throw new Error(`V34 B1 density smoke: ${message}`);
}

function canonicalValue(value, objectMember = false) {
	if (value === undefined) {
		if (objectMember) return undefined;
		throw new TypeError('canonical JSON root/array cannot contain undefined');
	}
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		requireCondition(Number.isFinite(value), 'canonical JSON requires finite numbers');
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
	requireCondition(
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

function sha256Bytes(value) {
	return createHash('sha256').update(value).digest('hex');
}

function pathEntryExists(file) {
	try {
		lstatSync(file);
		return true;
	} catch (error) {
		if (error?.code === 'ENOENT') return false;
		throw error;
	}
}

function assertAbsolute(file, label) {
	requireCondition(typeof file === 'string' && path.isAbsolute(file), `${label} must be absolute`);
	return path.resolve(file);
}

function assertArrayOfStrings(value, label) {
	requireCondition(
		Array.isArray(value) && value.every((entry) => typeof entry === 'string'),
		`${label} must be an argv array of strings`
	);
	return [...value];
}

function exactKeys(value, keys, label) {
	requireCondition(value && typeof value === 'object' && !Array.isArray(value), `${label} missing`);
	requireCondition(
		canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()),
		`${label} keys differ from the frozen allowlist`
	);
}

function writeAll(fd, value) {
	const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
	let offset = 0;
	while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function writeNewFile(file, value, mode = 0o644) {
	requireCondition(!pathEntryExists(file), `refusing to overwrite ${file}`);
	mkdirSync(path.dirname(file), { recursive: true });
	const fd = openSync(file, 'wx', mode);
	try {
		writeAll(fd, value);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const directoryFd = openSync(path.dirname(file), 'r');
	try {
		fsyncSync(directoryFd);
	} finally {
		closeSync(directoryFd);
	}
}

function assertRegularFile(file, label) {
	const stat = lstatSync(file);
	requireCondition(
		stat.isFile() && !stat.isSymbolicLink(),
		`${label} must be a non-symlink regular file: ${file}`
	);
	return stat;
}

function fileRecord(file) {
	const stat = assertRegularFile(file, 'recorded file');
	return {
		path: path.resolve(file),
		bytes: stat.size,
		sha256: sha256Bytes(readFileSync(file))
	};
}

export function copyNewFileVerified(source, destination, mode = 0o444) {
	const sourceRecord = fileRecord(source);
	const bytes = readFileSync(sourceRecord.path);
	requireCondition(
		bytes.length === sourceRecord.bytes && sha256Bytes(bytes) === sourceRecord.sha256,
		`source changed while publishing ${sourceRecord.path}`
	);
	writeNewFile(destination, bytes, mode);
	const destinationRecord = fileRecord(destination);
	requireCondition(
		destinationRecord.bytes === sourceRecord.bytes &&
			destinationRecord.sha256 === sourceRecord.sha256,
		`durable publication differs from ${sourceRecord.path}`
	);
	return { source: sourceRecord, destination: destinationRecord };
}

export function expectedShardLedger() {
	return Array.from({ length: SHARD_COUNT }, (_, index) => ({
		index,
		seed0: SEED0 + index * GAMES_PER_SHARD,
		games: GAMES_PER_SHARD,
		seedMax: SEED0 + (index + 1) * GAMES_PER_SHARD - 1
	}));
}

export function validateStrictChildEnvironment(environment, socketPath) {
	exactKeys(environment, REQUIRED_CHILD_ENV_KEYS, 'execution.environment');
	const normalized = Object.fromEntries(
		Object.entries(environment).map(([key, value]) => {
			requireCondition(typeof value === 'string', `execution.environment.${key} must be a string`);
			return [key, value];
		})
	);
	requireCondition(
		normalized.ARC_V34_EXPECT_DEVICE === LOGICAL_DEVICE,
		'ARC_V34_EXPECT_DEVICE must be cuda:0'
	);
	requireCondition(
		normalized.ARC_V34_INFER_SOCKET === socketPath,
		'ARC_V34_INFER_SOCKET differs from execution.socketPath'
	);
	requireCondition(
		normalized.ARC_V34_INFER_TIMEOUT_MS === '30000',
		'ARC_V34_INFER_TIMEOUT_MS must be 30000'
	);
	requireCondition(
		path.isAbsolute(normalized.ARC_V34_PARENT_CHECKPOINT),
		'ARC_V34_PARENT_CHECKPOINT must be absolute'
	);
	requireCondition(normalized.CUDA_VISIBLE_DEVICES === '7', 'CUDA_VISIBLE_DEVICES must be 7');
	return normalized;
}

function collectorArgvFor(shard, execution) {
	return [
		execution.collectorPath,
		'--catalog',
		execution.catalogPath,
		'--config',
		execution.configPath,
		'--policy-module',
		execution.policyModulePath,
		'--seed0',
		String(shard.seed0),
		'--games',
		String(GAMES_PER_SHARD),
		'--out',
		shard.outDir
	];
}

/** Validate the execution surface independently after the lock tool verifies all hashes. */
export function buildLaunchPlan(lock, { repoRoot = ROOT, fixtureMode = false } = {}) {
	requireCondition(
		path.resolve(repoRoot) === ROOT,
		'repo root differs from the bound orchestrator root'
	);
	requireCondition(lock?.schemaVersion === LOCK_SCHEMA, `lock schema must be ${LOCK_SCHEMA}`);
	requireCondition(lock.authoritative === true, 'execution lock is not authoritative');
	requireCondition(lock.outcomeBlind === true, 'execution lock is not outcome-blind');
	requireCondition(
		lock.flags?.densitySmokeOpen === true,
		'execution lock does not open the unregistered density smoke'
	);
	for (const [name, value] of Object.entries(lock.flags ?? {})) {
		if (name !== 'densitySmokeOpen') {
			requireCondition(value === false, `flags.${name} must remain false`);
		}
	}

	const execution = lock.execution;
	requireCondition(execution && typeof execution === 'object', 'execution block missing');
	requireCondition(
		path.resolve(execution.repoRoot) === ROOT,
		'execution.repoRoot differs from the running repository'
	);
	const artifactRoot = assertAbsolute(execution.artifactRoot, 'execution.artifactRoot');
	const attemptRoot = assertAbsolute(execution.attemptRoot, 'execution.attemptRoot');
	const socketPath = assertAbsolute(execution.socketPath, 'execution.socketPath');
	if (!fixtureMode) {
		requireCondition(
			attemptRoot === '/dev/shm' || attemptRoot.startsWith('/dev/shm/'),
			'execution.attemptRoot must be on /dev/shm'
		);
	}
	requireCondition(
		socketPath.startsWith(`${attemptRoot}${path.sep}`),
		'execution.socketPath must be inside attemptRoot'
	);
	const environment = validateStrictChildEnvironment(execution.environment, socketPath);
	requireCondition(
		path.resolve(environment.ARC_V34_PARENT_CHECKPOINT) === path.resolve(execution.checkpointPath),
		'ARC_V34_PARENT_CHECKPOINT differs from execution.checkpointPath'
	);
	for (const [label, actual, expected] of [
		['execution.collectorPath', execution.collectorPath, COLLECTOR_PATH],
		['execution.policyModulePath', execution.policyModulePath, POLICY_MODULE_PATH],
		['execution.configPath', execution.configPath, POLICY_CONFIG_PATH],
		['execution.orchestratorPath', execution.orchestratorPath, SCRIPT_PATH]
	]) {
		requireCondition(
			path.resolve(actual) === expected,
			`${label} differs from the bound repository file`
		);
	}
	assertAbsolute(execution.catalogPath, 'execution.catalogPath');

	const server = execution.server;
	requireCondition(server && typeof server === 'object', 'execution.server missing');
	const serverExecutable = assertAbsolute(server.executable, 'execution.server.executable');
	requireCondition(
		serverExecutable === path.resolve(execution.pythonExecutable),
		'execution.server.executable differs from execution.pythonExecutable'
	);
	const serverArgv = assertArrayOfStrings(server.argv, 'execution.server.argv');
	const expectedServerArgv = [
		path.join(ROOT, 'ml', 'infer_server.py'),
		'--weights',
		environment.ARC_V34_PARENT_CHECKPOINT,
		'--socket',
		socketPath,
		'--device',
		LOGICAL_DEVICE,
		'--window-ms',
		'2',
		'--max-batch',
		'512',
		'--stats-interval',
		'5'
	];
	requireCondition(
		canonicalJson(serverArgv) === canonicalJson(expectedServerArgv),
		'execution.server.argv differs from the exact one-server command'
	);

	const orchestrator = execution.orchestrator;
	requireCondition(
		orchestrator && typeof orchestrator === 'object',
		'execution.orchestrator missing'
	);
	const nodeExecutable = assertAbsolute(execution.nodeExecutable, 'execution.nodeExecutable');
	requireCondition(
		path.resolve(process.execPath) === nodeExecutable,
		'running Node executable differs from execution.nodeExecutable'
	);
	requireCondition(
		path.resolve(orchestrator.executable) === nodeExecutable,
		'execution.orchestrator.executable differs from execution.nodeExecutable'
	);
	requireCondition(
		path.resolve(orchestrator.argv?.[0] ?? '') === SCRIPT_PATH,
		'execution.orchestrator.argv does not bind this script'
	);
	requireCondition(
		canonicalJson(orchestrator.argv.slice(1)) ===
			canonicalJson(['--mode', 'live', '--lock', lock.paths?.executionLock]),
		'execution.orchestrator.argv must explicitly bind the live mode and execution lock'
	);
	exactKeys(
		orchestrator,
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
		'execution.orchestrator'
	);
	requireCondition(
		orchestrator.launchMode === 'execFile-no-shell-no-redirection',
		'execution.orchestrator.launchMode permits an external redirect'
	);
	requireCondition(
		canonicalJson(orchestrator.selfPublication) ===
			canonicalJson({
				mode: 'structured-new-only-result-xor-failure-v1',
				precreateAttemptRoot: false,
				stdout: 'reserved-new-only-not-shell-redirected',
				stderr: 'reserved-new-only-not-shell-redirected',
				result: 'new-only-on-success',
				failure: 'new-only-on-failure',
				finalFeatureReport: 'new-only-on-success'
			}),
		'execution.orchestrator.selfPublication changed'
	);

	const expected = expectedShardLedger();
	requireCondition(
		Array.isArray(execution.shards) && execution.shards.length === SHARD_COUNT,
		'execution.shards must contain exactly 16 shards'
	);
	const shards = execution.shards.map((shard, index) => {
		const ledger = expected[index];
		requireCondition(shard.index === ledger.index, `shard ${index} index mismatch`);
		requireCondition(shard.seed0 === ledger.seed0, `shard ${index} seed0 mismatch`);
		requireCondition(shard.games === GAMES_PER_SHARD, `shard ${index} games mismatch`);
		const outDir = assertAbsolute(shard.outDir, `shard ${index} outDir`);
		requireCondition(
			outDir.startsWith(`${attemptRoot}${path.sep}`),
			`shard ${index} outDir must be inside attemptRoot`
		);
		const exactCollectorArgv = collectorArgvFor({ ...ledger, outDir }, execution);
		requireCondition(
			path.resolve(shard.executable) === nodeExecutable,
			`shard ${index} executable differs from execution.nodeExecutable`
		);
		requireCondition(
			canonicalJson(shard.argv) === canonicalJson(exactCollectorArgv),
			`shard ${index} argv differs from the immutable collector command`
		);
		return {
			...ledger,
			outDir,
			stdoutPath: assertAbsolute(shard.stdoutPath, `shard ${index} stdoutPath`),
			stderrPath: assertAbsolute(shard.stderrPath, `shard ${index} stderrPath`),
			collectionPath: path.join(outDir, 'collection.json'),
			featurePath: path.join(outDir, 'features', 'snapshots.jsonl'),
			traceManifestPath: path.join(outDir, 'traces', 'manifest.jsonl'),
			targetDir: path.join(outDir, 'targets'),
			targetFile: path.join(outDir, 'targets', 'future-targets.jsonl'),
			executable: nodeExecutable,
			argv: [...shard.argv]
		};
	});
	const seedUnion = shards.flatMap((shard) =>
		Array.from({ length: shard.games }, (_, offset) => shard.seed0 + offset)
	);
	requireCondition(seedUnion.length === TOTAL_GAMES, 'seed union size mismatch');
	requireCondition(new Set(seedUnion).size === TOTAL_GAMES, 'seed union contains duplicates');
	requireCondition(seedUnion[0] === SEED0, 'seed union first seed mismatch');
	requireCondition(seedUnion.at(-1) === SEED0 + TOTAL_GAMES - 1, 'seed union last seed mismatch');

	const paths = {
		attemptRoot,
		socketPath,
		executionLockPath: assertAbsolute(lock.paths?.executionLock, 'paths.executionLock'),
		consumedMarkerPath: assertAbsolute(lock.consumption?.markerPath, 'consumption.markerPath'),
		mergedFeaturePath: assertAbsolute(lock.paths?.mergedFeatures, 'paths.mergedFeatures'),
		serverReadyPath: assertAbsolute(lock.paths?.serverReady, 'paths.serverReady'),
		serverExitPath: assertAbsolute(lock.paths?.serverExit, 'paths.serverExit'),
		finalProviderBindingPath: assertAbsolute(
			lock.paths?.finalProviderBinding,
			'paths.finalProviderBinding'
		),
		featureOnlyReportPath: assertAbsolute(lock.paths?.featureOnlyReport, 'paths.featureOnlyReport'),
		orchestratorStdoutPath: assertAbsolute(
			lock.paths?.orchestratorStdout,
			'paths.orchestratorStdout'
		),
		orchestratorStderrPath: assertAbsolute(
			lock.paths?.orchestratorStderr,
			'paths.orchestratorStderr'
		),
		durableResultPath: assertAbsolute(lock.paths?.orchestratorResult, 'paths.orchestratorResult'),
		durableFailurePath: assertAbsolute(
			lock.paths?.orchestratorFailure,
			'paths.orchestratorFailure'
		),
		durableFeatureOnlyReportPath: assertAbsolute(
			lock.paths?.finalFeatureReport,
			'paths.finalFeatureReport'
		),
		smokeFreezeProtocolPath: assertAbsolute(
			lock.paths?.smokeFreezeProtocol,
			'paths.smokeFreezeProtocol'
		),
		smokeFreezeOutputPath: assertAbsolute(lock.paths?.smokeFreezeOutput, 'paths.smokeFreezeOutput'),
		smokeFreezeLedgerPath: assertAbsolute(lock.paths?.smokeFreezeLedger, 'paths.smokeFreezeLedger'),
		serverStdoutPath: assertAbsolute(server.stdoutPath, 'execution.server.stdoutPath'),
		serverStderrPath: assertAbsolute(server.stderrPath, 'execution.server.stderrPath')
	};
	requireCondition(
		paths.consumedMarkerPath === lock.paths?.consumedMarker,
		'consumption marker differs from paths.consumedMarker'
	);
	for (const [label, actual, expected] of [
		['stdoutPath', orchestrator.stdoutPath, lock.paths?.orchestratorStdout],
		['stderrPath', orchestrator.stderrPath, lock.paths?.orchestratorStderr],
		['resultPath', orchestrator.resultPath, paths.durableResultPath],
		['failurePath', orchestrator.failurePath, paths.durableFailurePath],
		[
			'finalFeatureReportPath',
			orchestrator.finalFeatureReportPath,
			paths.durableFeatureOnlyReportPath
		]
	]) {
		requireCondition(
			path.resolve(actual ?? '') === path.resolve(expected ?? ''),
			`execution.orchestrator.${label} differs from its bound path`
		);
	}
	for (const [label, durablePath] of [
		['consumed marker', paths.consumedMarkerPath],
		['orchestrator result', paths.durableResultPath],
		['orchestrator failure', paths.durableFailurePath],
		['final feature-only report', paths.durableFeatureOnlyReportPath],
		['reserved orchestrator stdout', paths.orchestratorStdoutPath],
		['reserved orchestrator stderr', paths.orchestratorStderrPath]
	]) {
		requireCondition(
			durablePath !== attemptRoot && !durablePath.startsWith(`${attemptRoot}${path.sep}`),
			`${label} must be durable outside attemptRoot`
		);
		requireCondition(
			path.dirname(durablePath) === path.dirname(paths.executionLockPath),
			`${label} must be a direct sibling of the execution lock`
		);
	}
	const absentPaths = [
		paths.attemptRoot,
		paths.socketPath,
		paths.consumedMarkerPath,
		paths.mergedFeaturePath,
		paths.serverReadyPath,
		paths.serverExitPath,
		paths.finalProviderBindingPath,
		paths.featureOnlyReportPath,
		paths.durableResultPath,
		paths.durableFailurePath,
		paths.durableFeatureOnlyReportPath,
		paths.orchestratorStdoutPath,
		paths.orchestratorStderrPath,
		paths.smokeFreezeOutputPath,
		paths.smokeFreezeLedgerPath,
		paths.serverStdoutPath,
		paths.serverStderrPath,
		...shards.flatMap((shard) => [shard.outDir, shard.stdoutPath, shard.stderrPath])
	];
	requireCondition(
		new Set(absentPaths).size === absentPaths.length,
		'execution paths are not pairwise distinct'
	);

	const expectedServedInfo =
		execution.expectedProviderBinding?.runtime?.server ?? execution.expectedServedInfo ?? null;
	requireCondition(expectedServedInfo !== null, 'expected served-provider identity is missing');
	validateServedInfo(expectedServedInfo);
	requireCondition(
		sha256Bytes(canonicalJson(execution.expectedProviderBinding)) ===
			lock.expectedExecutionProviderBindingCanonicalSha256,
		'expected provider binding canonical SHA-256 changed'
	);
	requireCondition(
		execution.gpuProbe && typeof execution.gpuProbe === 'object',
		'GPU probe missing'
	);
	requireCondition(
		canonicalJson(execution.gpuProbe.argv) ===
			canonicalJson([
				'--query-gpu=uuid,memory.used,utilization.gpu',
				'--format=csv,noheader,nounits',
				'--id=7'
			]),
		'GPU probe argv changed'
	);
	assertAbsolute(execution.gpuProbe.executable, 'execution.gpuProbe.executable');
	requireCondition(
		Number.isSafeInteger(execution.scratchMinimumFreeBytes) &&
			execution.scratchMinimumFreeBytes > 0,
		'execution.scratchMinimumFreeBytes must be a positive integer'
	);
	const freezer = execution.postflight?.freezer;
	requireCondition(freezer && typeof freezer === 'object', 'bound smoke freezer is missing');
	const expectedFreezerArgv = [
		path.join(ROOT, 'ml', 'freeze_v34_teacher_snapshots.py'),
		'freeze',
		'--input',
		paths.mergedFeaturePath,
		'--output',
		paths.smokeFreezeOutputPath,
		'--ledger',
		paths.smokeFreezeLedgerPath,
		'--protocol',
		paths.smokeFreezeProtocolPath,
		'--generation',
		'1'
	];
	requireCondition(
		path.resolve(freezer.executable) === path.resolve(execution.pythonExecutable) &&
			canonicalJson(freezer.argv) === canonicalJson(expectedFreezerArgv),
		'bound smoke freezer command changed'
	);
	requireCondition(
		execution.postflight.featureMerge === 'collector-exported-bounded-16-way-feature-only-merge-v1',
		'bound feature merger changed'
	);
	requireCondition(
		canonicalJson(execution.postflight.traceVerification) ===
			canonicalJson({
				selection: 'pcg64-without-replacement-over-feature-sort-order',
				seed: TRACE_VERIFICATION_SEED,
				draws: TRACE_VERIFICATION_DRAWS,
				targetFilesReadable: false
			}),
		'trace-verification contract changed'
	);
	const expectedTargetDeletionInvariance = {
		targetPaths: 'exact-shard-target-artifacts-from-locked-shard-roots',
		readOrHashBeforeDelete: false,
		deletion: 'lexically-bound-unlink-only-no-follow',
		freezerFreezeRuns: 1,
		verify: {
			executable: path.resolve(execution.pythonExecutable),
			argv: [
				path.join(ROOT, 'ml', 'freeze_v34_teacher_snapshots.py'),
				'verify',
				'--ledger',
				paths.smokeFreezeLedgerPath
			]
		},
		requireFeatureSelectionOutputLedgerHashesUnchanged: true
	};
	requireCondition(
		execution.postflight.targetDeletionInvariance &&
			typeof execution.postflight.targetDeletionInvariance === 'object' &&
			canonicalJson(execution.postflight.targetDeletionInvariance) ===
				canonicalJson(expectedTargetDeletionInvariance) &&
			execution.postflight.providerPostflightHandshakeRequired === true,
		'bound postflight gates changed'
	);

	return {
		lock,
		execution,
		artifactRoot,
		attemptRoot,
		socketPath,
		environment,
		server: {
			executable: serverExecutable,
			argv: serverArgv,
			stdoutPath: paths.serverStdoutPath,
			stderrPath: paths.serverStderrPath
		},
		shards,
		seedUnion,
		paths,
		absentPaths,
		scratchMinimumFreeBytes: Number(execution.scratchMinimumFreeBytes),
		serverReadyTimeoutMs: Number(execution.serverReadyTimeoutMs ?? 120_000),
		expectedServedInfo,
		expectedProviderBinding: structuredClone(execution.expectedProviderBinding),
		gpuProbe: execution.gpuProbe,
		freezer: { executable: freezer.executable, argv: [...freezer.argv] },
		traceVerification: structuredClone(execution.postflight.traceVerification)
	};
}

export function assertLaunchPathsAbsent(plan) {
	for (const file of plan.absentPaths) {
		requireCondition(!pathEntryExists(file), `launch path already exists: ${file}`);
	}
}

function parseGpuProbe(stdout, probe) {
	requireCondition(probe && typeof probe === 'object', 'GPU probe binding is missing');
	requireCondition(probe.physicalGpuIndex === PHYSICAL_GPU, 'GPU probe physical index changed');
	requireCondition(probe.requiredMemoryMiB === 0, 'GPU probe memory requirement changed');
	requireCondition(
		probe.requiredUtilizationPercent === 0,
		'GPU probe utilization requirement changed'
	);
	const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
	requireCondition(lines.length === 1, 'GPU probe must return exactly one row');
	const values = lines[0].split(',').map((value) => value.trim());
	requireCondition(values.length === 3, 'GPU probe row has the wrong field count');
	const [uuid, memoryUsedMiB, utilizationPercent] = values;
	requireCondition(/^GPU-[0-9a-f-]+$/iu.test(uuid), 'GPU probe returned an invalid UUID');
	requireCondition(Number(memoryUsedMiB) === 0, 'GPU 7 memory is not empty');
	requireCondition(Number(utilizationPercent) === 0, 'GPU 7 utilization is not zero');
	return {
		physicalIndex: PHYSICAL_GPU,
		uuid,
		memoryUsedMiB: 0,
		utilizationPercent: 0
	};
}

function scratchEvidence(plan) {
	requireCondition(
		Number.isSafeInteger(plan.scratchMinimumFreeBytes) && plan.scratchMinimumFreeBytes > 0,
		'execution scratch minimum is not a bound positive integer'
	);
	const freeBytes = shmFreeBytes();
	requireCondition(
		freeBytes >= BigInt(plan.scratchMinimumFreeBytes),
		`/dev/shm has ${freeBytes} bytes free, needs ${plan.scratchMinimumFreeBytes}`
	);
	return { path: '/dev/shm', freeBytes: freeBytes.toString() };
}

function shmFreeBytes() {
	const stat = statfsSync('/dev/shm', { bigint: true });
	return stat.bavail * stat.bsize;
}

export function recordScratchSample(samples, phase, freeBytes) {
	requireCondition(Array.isArray(samples), 'scratch sample destination must be an array');
	requireCondition(
		typeof phase === 'string' && phase.length > 0 && !samples.some((row) => row.phase === phase),
		`scratch sample phase is invalid or duplicated: ${phase}`
	);
	const normalized = BigInt(freeBytes);
	requireCondition(normalized >= 0n, `scratch sample ${phase} is negative`);
	samples.push({ phase, freeBytes: normalized.toString() });
	return samples.at(-1);
}

export function summarizeScratchSamples(samples) {
	requireCondition(
		Array.isArray(samples) && samples.length >= 2,
		'scratch evidence needs two samples'
	);
	requireCondition(samples[0].phase === 'prelaunch', 'first scratch sample must be prelaunch');
	const values = samples.map((row) => BigInt(row.freeBytes));
	const initial = values[0];
	const minimum = values.reduce((best, value) => (value < best ? value : best), initial);
	return {
		root: '/dev/shm',
		initialFreeBytes: initial.toString(),
		minimumFreeBytes: minimum.toString(),
		peakConsumedBytesRelativeToPrelaunch: (initial - minimum).toString(),
		samples: structuredClone(samples)
	};
}

function positiveRate(numerator, elapsedMs) {
	requireCondition(
		Number.isFinite(numerator) && numerator >= 0 && Number.isFinite(elapsedMs) && elapsedMs >= 0,
		'throughput inputs must be finite and non-negative'
	);
	return numerator / Math.max(elapsedMs / 1000, 0.000001);
}

export function buildPerformanceEvidence({
	totalElapsedMs,
	collectionElapsedMs,
	postflightElapsedMs,
	featureRows,
	mergedFeatureBytes,
	traceVerifications
}) {
	for (const [label, value] of Object.entries({
		totalElapsedMs,
		collectionElapsedMs,
		postflightElapsedMs
	})) {
		requireCondition(
			Number.isFinite(value) && value >= 0,
			`${label} must be finite and non-negative`
		);
	}
	requireCondition(
		collectionElapsedMs <= totalElapsedMs && postflightElapsedMs <= totalElapsedMs,
		'phase elapsed time exceeds total elapsed time'
	);
	return {
		clock: 'process.hrtime.bigint-monotonic',
		elapsedMs: {
			total: totalElapsedMs,
			collection: collectionElapsedMs,
			postflight: postflightElapsedMs
		},
		collectionThroughput: {
			gamesPerSecond: positiveRate(TOTAL_GAMES, collectionElapsedMs),
			featureRowsPerSecond: positiveRate(featureRows, collectionElapsedMs)
		},
		postflightThroughput: {
			featureRowsPerSecond: positiveRate(featureRows, postflightElapsedMs),
			mergedFeatureBytesPerSecond: positiveRate(mergedFeatureBytes, postflightElapsedMs),
			traceVerificationsPerSecond: positiveRate(traceVerifications, postflightElapsedMs)
		}
	};
}

const INFER_STATS_RE =
	/^\[infer\] reqs=(\d+) rows=(\d+) batches=(\d+) avg_batch=([0-9]+(?:\.[0-9]+)?) batch_p50=(\d+) batch_p95=(\d+) batch_min=(\d+) batch_max=(\d+) forwards\/s=([0-9]+(?:\.[0-9]+)?)$/u;

export function parseInferenceServerStats(log) {
	const lines = String(log).split(/\r?\n/u);
	const intervals = [];
	let servingLines = 0;
	let shutdownLines = 0;
	let reloadLines = 0;
	for (const line of lines) {
		if (line.startsWith('[infer] serving ')) servingLines += 1;
		else if (line === '[infer] shut down') shutdownLines += 1;
		else if (line.startsWith('[infer] reloaded weights from ')) reloadLines += 1;
		else if (line.startsWith('[infer] SIGHUP reload FAILED')) reloadLines += 1;
		else if (line.startsWith('[infer] reqs=')) {
			const match = INFER_STATS_RE.exec(line);
			requireCondition(match, `inference stats line format changed: ${line}`);
			intervals.push({
				requests: Number(match[1]),
				rows: Number(match[2]),
				batches: Number(match[3]),
				averageBatch: Number(match[4]),
				batchP50: Number(match[5]),
				batchP95: Number(match[6]),
				batchMin: Number(match[7]),
				batchMax: Number(match[8]),
				forwardsPerSecond: Number(match[9])
			});
		}
	}
	requireCondition(servingLines === 1, 'inference log must contain exactly one serving line');
	requireCondition(shutdownLines === 1, 'inference log must contain exactly one shutdown line');
	const totals = intervals.reduce(
		(sum, row) => ({
			requests: sum.requests + row.requests,
			rows: sum.rows + row.rows,
			batches: sum.batches + row.batches
		}),
		{ requests: 0, rows: 0, batches: 0 }
	);
	if (intervals.length === 0) {
		return {
			available: false,
			strictUnavailableReason: 'no-stats-interval-completed-before-bound-server-shutdown',
			recommendation:
				'If this occurs in the 512-game smoke, Fable-review a shorter --stats-interval before retry; do not infer batch performance.',
			servingLines,
			shutdownLines,
			reloadLines
		};
	}
	return {
		available: true,
		intervals: intervals.length,
		servingLines,
		shutdownLines,
		reloadLines,
		totals,
		weightedAverageBatch: totals.batches > 0 ? totals.rows / totals.batches : 0,
		observedBatchMin: Math.min(...intervals.map((row) => row.batchMin)),
		observedBatchMax: Math.max(...intervals.map((row) => row.batchMax)),
		maximumIntervalBatchP50: Math.max(...intervals.map((row) => row.batchP50)),
		maximumIntervalBatchP95: Math.max(...intervals.map((row) => row.batchP95)),
		maximumIntervalForwardsPerSecond: Math.max(...intervals.map((row) => row.forwardsPerSecond))
	};
}

function spawnLogged(command, { env, readyPattern = null } = {}) {
	mkdirSync(path.dirname(command.stdoutPath), { recursive: true });
	mkdirSync(path.dirname(command.stderrPath), { recursive: true });
	const stdoutFd = openSync(command.stdoutPath, 'wx', 0o644);
	let stderrFd;
	try {
		stderrFd = openSync(command.stderrPath, 'wx', 0o644);
	} catch (error) {
		closeSync(stdoutFd);
		throw error;
	}
	const stdout = createWriteStream(command.stdoutPath, { fd: stdoutFd, autoClose: true });
	const stderr = createWriteStream(command.stderrPath, { fd: stderrFd, autoClose: true });
	const child = spawn(command.executable, command.argv, {
		cwd: ROOT,
		env,
		shell: false,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let stderrTail = '';
	let readyResolve;
	let readyReject;
	const ready = new Promise((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	if (!readyPattern) readyResolve(null);
	child.stdout.on('data', (chunk) => stdout.write(chunk));
	child.stderr.on('data', (chunk) => {
		stderr.write(chunk);
		stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-64 * 1024);
		if (readyPattern?.test(stderrTail)) readyResolve(stderrTail);
	});
	const rawExit = new Promise((resolve, reject) => {
		child.once('error', (error) => {
			readyReject(error);
			reject(error);
		});
		child.once('exit', (code, signal) => {
			if (readyPattern)
				readyReject(new Error(`process exited before readiness: ${code}/${signal}`));
			resolve({ code, signal });
		});
	});
	const exit = rawExit
		.finally(() => {
			stdout.end();
			stderr.end();
		})
		.then(async (result) => {
			await Promise.all([finished(stdout), finished(stderr)]);
			return result;
		});
	return { child, ready, exit, getStderrTail: () => stderrTail };
}

function withTimeout(promise, timeoutMs, label) {
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
				timeoutMs
			);
			timer.unref?.();
		})
	]);
}

function runProbe(executable, argv, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, argv, {
			cwd: ROOT,
			env,
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const stdout = [];
		const stderr = [];
		child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (code !== 0) {
				reject(
					new Error(
						`probe failed ${code}/${signal}: ${Buffer.concat(stderr).toString('utf8').trim()}`
					)
				);
				return;
			}
			resolve(Buffer.concat(stdout).toString('utf8'));
		});
	});
}

export function validateServedInfo(info, expected = null) {
	requireCondition(info && typeof info === 'object', 'server info handshake missing');
	const identity = {
		format: info.format,
		obs_dim: info.obs_dim,
		act_dim: info.act_dim,
		device: info.device,
		weights: info.weights,
		weights_sha256: info.weights_sha256,
		aux: info.aux,
		reach30_horizon: info.reach30_horizon
	};
	requireCondition(identity.format === 'arc-entity-scorer-v2', 'served format mismatch');
	requireCondition(identity.obs_dim === 3419, 'served observation width mismatch');
	requireCondition(identity.act_dim === 104, 'served candidate width mismatch');
	requireCondition(identity.device === LOGICAL_DEVICE, 'served device mismatch');
	requireCondition(identity.aux?.reach30 === true, 'served reach30 head missing');
	requireCondition(identity.reach30_horizon === 30, 'served reach30 horizon mismatch');
	if (expected) {
		requireCondition(
			canonicalJson(identity) === canonicalJson(expected),
			'served identity differs from the execution lock'
		);
	}
	return identity;
}

export function infoHandshake(socketPath, timeoutMs = 30_000) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		const id = 'v34-b1-orchestrator-info';
		const payload = Buffer.from(JSON.stringify({ id, want: ['info'] }), 'utf8');
		const header = Buffer.allocUnsafe(4);
		header.writeUInt32LE(payload.length, 0);
		let buffer = Buffer.alloc(0);
		let expectedLength = null;
		let settled = false;
		const finish = (error, info = null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(info);
		};
		const timer = setTimeout(
			() => finish(new Error(`server info handshake timed out after ${timeoutMs}ms`)),
			timeoutMs
		);
		socket.once('error', (error) => finish(error));
		socket.on('data', (chunk) => {
			try {
				buffer = Buffer.concat([buffer, chunk]);
				if (expectedLength === null && buffer.length >= 4) {
					expectedLength = buffer.readUInt32LE(0);
					requireCondition(
						expectedLength > 0 && expectedLength <= 1024 * 1024,
						'invalid info frame'
					);
				}
				if (expectedLength !== null && buffer.length >= 4 + expectedLength) {
					const response = JSON.parse(buffer.subarray(4, 4 + expectedLength).toString('utf8'));
					requireCondition(response.id === id, 'server info response id mismatch');
					requireCondition(!response.error, `server info error: ${response.error}`);
					finish(null, response.info);
				}
			} catch (error) {
				finish(error);
			}
		});
		socket.once('connect', () => socket.write(Buffer.concat([header, payload])));
	});
}

export function verifyShardReports(
	plan,
	readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
) {
	const seen = new Set();
	const reports = plan.shards.map((shard) => {
		assertRegularFile(shard.collectionPath, `shard ${shard.index} collection`);
		const report = readJson(shard.collectionPath);
		const expectedSeeds = Array.from({ length: shard.games }, (_, offset) => shard.seed0 + offset);
		requireCondition(report?.valid === true, `shard ${shard.index} collection is invalid`);
		requireCondition(
			canonicalJson(report.seeds) === canonicalJson(expectedSeeds),
			`shard ${shard.index} collection seed set mismatch`
		);
		for (const seed of report.seeds) {
			requireCondition(!seen.has(seed), `duplicate collected seed ${seed}`);
			seen.add(seed);
		}
		return report;
	});
	requireCondition(seen.size === TOTAL_GAMES, 'collected seed union is incomplete');
	requireCondition(
		plan.seedUnion.every((seed) => seen.has(seed)),
		'collected seed union differs from the immutable ledger'
	);
	return reports;
}

export async function mergeFeatureShards(plan, merge = null) {
	for (const shard of plan.shards) {
		assertRegularFile(shard.featurePath, `shard ${shard.index} feature artifact`);
	}
	const merger =
		merge ??
		(
			await import(
				`${pathToFileURL(COLLECTOR_PATH).href}?orchestrator=${fileRecord(COLLECTOR_PATH).sha256}`
			)
		).mergeV34FeatureRuns;
	requireCondition(typeof merger === 'function', 'feature merger is unavailable');
	const runRoot = path.join(plan.attemptRoot, '.feature-merge-runs');
	return merger({
		runFiles: plan.shards.map((shard) => shard.featurePath),
		runRoot,
		outputFile: plan.paths.mergedFeaturePath,
		fanIn: 16
	});
}

function parseSingleJsonOutput(stdout, label) {
	const lines = String(stdout).trim().split(/\r?\n/u).filter(Boolean);
	requireCondition(lines.length === 1, `${label} must emit exactly one JSON line`);
	try {
		return JSON.parse(lines[0]);
	} catch (error) {
		throw new Error(`V34 B1 density smoke: ${label} emitted invalid JSON: ${error.message}`);
	}
}

export function validateFreezerLedger(plan, ledger) {
	requireCondition(
		ledger?.schemaVersion === 'arc-v34-teacher-snapshot-freeze-v1' &&
			ledger.valid === true &&
			ledger.outcomesInspected === false &&
			ledger.generation === 1,
		'smoke freezer ledger identity changed'
	);
	for (const [label, record, expectedPath] of [
		['protocol', ledger.protocol, plan.paths.smokeFreezeProtocolPath],
		['input', ledger.input, plan.paths.mergedFeaturePath],
		['output', ledger.output, plan.paths.smokeFreezeOutputPath]
	]) {
		requireCondition(
			path.resolve(record?.path ?? '') === expectedPath,
			`freezer ${label} path changed`
		);
	}
	const totalQuota = Object.values(SMOKE_QUOTAS).reduce((sum, value) => sum + value, 0);
	requireCondition(ledger.output.rows === totalQuota, 'smoke freezer output row total changed');
	requireCondition(
		canonicalJson(ledger.contract?.quotas) === canonicalJson(SMOKE_QUOTAS),
		'smoke freezer quotas changed'
	);
	requireCondition(
		ledger.contract?.withoutReplacement === true &&
			ledger.contract?.recoveryPrecedence === true &&
			ledger.contract?.maxRowsPerSourceGame === 48 &&
			ledger.contract?.maxRowsPerPublicStateHash === 4,
		'smoke freezer cap/selection contract changed'
	);
	requireCondition(
		ledger.selection?.rng === 'numpy.random.Generator(numpy.random.PCG64)' &&
			ledger.selection?.rngSeed === 34043101,
		'smoke freezer RNG changed'
	);
	for (const [band, quota] of Object.entries(SMOKE_QUOTAS)) {
		requireCondition(
			Number.isSafeInteger(ledger.selection?.inputCountsByBand?.[band]) &&
				ledger.selection.inputCountsByBand[band] >= quota,
			`smoke freezer ${band} floor was not supplied`
		);
		requireCondition(
			ledger.selection?.selectedCountsByBand?.[band] === quota,
			`smoke freezer ${band} floor was not selected exactly`
		);
	}
	requireCondition(
		ledger.selection?.selectedMaxRowsPerSourceGame <= 48 &&
			ledger.selection?.selectedMaxRowsPerPublicStateHash <= 4,
		'smoke freezer selected-cap evidence is invalid'
	);
	return {
		inputRows: ledger.input.rows,
		selectedRows: ledger.output.rows,
		inputCountsByBand: structuredClone(ledger.selection.inputCountsByBand),
		selectedCountsByBand: structuredClone(ledger.selection.selectedCountsByBand),
		capacitySkipsByBand: structuredClone(ledger.selection.capacitySkipsByBand),
		selectedMaxRowsPerSourceGame: ledger.selection.selectedMaxRowsPerSourceGame,
		selectedMaxRowsPerPublicStateHash: ledger.selection.selectedMaxRowsPerPublicStateHash
	};
}

export async function runSmokeFreezer(plan, runCommand = runProbe) {
	const stdout = await runCommand(plan.freezer.executable, plan.freezer.argv, plan.environment);
	const summary = parseSingleJsonOutput(stdout, 'smoke freezer');
	requireCondition(
		summary?.valid === true &&
			summary.generation === 1 &&
			path.resolve(summary.output?.path ?? '') === plan.paths.smokeFreezeOutputPath &&
			path.resolve(summary.ledger?.path ?? '') === plan.paths.smokeFreezeLedgerPath,
		'smoke freezer summary changed'
	);
	assertRegularFile(plan.paths.smokeFreezeOutputPath, 'smoke freezer output');
	assertRegularFile(plan.paths.smokeFreezeLedgerPath, 'smoke freezer ledger');
	const ledger = JSON.parse(readFileSync(plan.paths.smokeFreezeLedgerPath, 'utf8'));
	const floors = validateFreezerLedger(plan, ledger);
	return { summary, ledger, floors };
}

/**
 * The density-smoke future labels are disposable.  This function inspects only directory-entry
 * types/names, rejects links and unexpected files, and unlinks bytes without ever opening them.
 */
export function deleteDisposableTargetShards(plan) {
	const deleted = [];
	for (const shard of plan.shards) {
		const directoryStat = lstatSync(shard.targetDir);
		requireCondition(
			directoryStat.isDirectory() && !directoryStat.isSymbolicLink(),
			`shard ${shard.index} target path must be a non-symlink directory`
		);
		const entries = readdirSync(shard.targetDir).sort();
		requireCondition(
			canonicalJson(entries) === canonicalJson(['future-targets.jsonl']),
			`shard ${shard.index} target directory layout changed`
		);
		const fileStat = lstatSync(shard.targetFile);
		requireCondition(
			fileStat.isFile() && !fileStat.isSymbolicLink(),
			`shard ${shard.index} target artifact must be a non-symlink regular file`
		);
		const bytes = fileStat.size;
		unlinkSync(shard.targetFile);
		rmdirSync(shard.targetDir);
		requireCondition(
			!pathEntryExists(shard.targetDir) && !pathEntryExists(shard.targetFile),
			`shard ${shard.index} target deletion was incomplete`
		);
		deleted.push({ index: shard.index, directory: shard.targetDir, file: shard.targetFile, bytes });
	}
	return { shards: deleted.length, bytesDeleted: deleted.reduce((sum, row) => sum + row.bytes, 0) };
}

export async function verifyFreezerAfterTargetDeletion(plan, before, runCommand = runProbe) {
	const verifyArgv = [plan.freezer.argv[0], 'verify', '--ledger', plan.paths.smokeFreezeLedgerPath];
	const summary = parseSingleJsonOutput(
		await runCommand(plan.freezer.executable, verifyArgv, plan.environment),
		'smoke freezer verification'
	);
	requireCondition(
		summary?.valid === true &&
			summary.generation === 1 &&
			path.resolve(summary.output?.path ?? '') === plan.paths.smokeFreezeOutputPath &&
			summary.ledgerSha256 === before.ledger.sha256,
		'post-deletion freezer verification failed'
	);
	const after = {
		merged: fileRecord(plan.paths.mergedFeaturePath),
		output: fileRecord(plan.paths.smokeFreezeOutputPath),
		ledger: fileRecord(plan.paths.smokeFreezeLedgerPath)
	};
	requireCondition(
		canonicalJson(after) === canonicalJson(before),
		'feature/freezer artifacts changed after target deletion'
	);
	return { summary, artifacts: after };
}

const TRACE_INDEX_SCRIPT = [
	'import json,sys',
	'import numpy as np',
	'n=int(sys.argv[1]); draws=int(sys.argv[2]); seed=int(sys.argv[3])',
	'assert n >= draws > 0',
	'rng=np.random.Generator(np.random.PCG64(seed))',
	'print(json.dumps(rng.permutation(n)[:draws].tolist(),separators=(",",":")))'
].join(';');

export async function selectTraceVerificationIndexes(plan, totalRows, runCommand = runProbe) {
	requireCondition(
		Number.isSafeInteger(totalRows) && totalRows >= plan.traceVerification.draws,
		'trace verification has too few feature rows'
	);
	const stdout = await runCommand(
		plan.execution.pythonExecutable,
		[
			'-c',
			TRACE_INDEX_SCRIPT,
			String(totalRows),
			String(plan.traceVerification.draws),
			String(plan.traceVerification.seed)
		],
		plan.environment
	);
	const indexes = parseSingleJsonOutput(stdout, 'trace-index PCG64 selector');
	requireCondition(
		Array.isArray(indexes) &&
			indexes.length === plan.traceVerification.draws &&
			new Set(indexes).size === indexes.length &&
			indexes.every((index) => Number.isSafeInteger(index) && index >= 0 && index < totalRows),
		'trace-index PCG64 selector returned an invalid draw'
	);
	return indexes;
}

async function readJsonl(file, label) {
	assertRegularFile(file, label);
	const input = createReadStream(file, { encoding: 'utf8' });
	const lines = createInterface({ input, crlfDelay: Infinity });
	const rows = [];
	for await (const line of lines) {
		requireCondition(line.length > 0, `${label} contains a blank line`);
		rows.push(JSON.parse(line));
	}
	return rows;
}

async function scanSelectedFeatures(file, indexes, weakThreshold) {
	assertRegularFile(file, 'merged feature artifact');
	const wanted = new Set(indexes);
	const selected = [];
	const rowsByBand = { recovery: 0, late: 0, mid: 0, early: 0 };
	const rowsPerGame = new Map();
	const stateHashCounts = new Map();
	const reasonOverlaps = {};
	const exactBoundaryCounts = {
		minRoundInclusive: 0,
		maxExpectedAttack: 0,
		maxAttackDice: 0,
		maxAwakenedSpirits: 0,
		maxBarrier: 0,
		maxInitiative: 0
	};
	const input = createReadStream(file, { encoding: 'utf8' });
	const lines = createInterface({ input, crlfDelay: Infinity });
	let index = 0;
	for await (const line of lines) {
		requireCondition(line.length > 0, 'merged feature artifact contains a blank line');
		const row = JSON.parse(line);
		requireCondition(row.selectionBand in rowsByBand, 'feature selection band changed');
		rowsByBand[row.selectionBand] += 1;
		rowsPerGame.set(row.sourceGameSeed, (rowsPerGame.get(row.sourceGameSeed) ?? 0) + 1);
		stateHashCounts.set(row.publicStateHash, (stateHashCounts.get(row.publicStateHash) ?? 0) + 1);
		const reasons = [...(row.recoveryDiagnostics?.reasons ?? [])].sort().join('+') || 'none';
		reasonOverlaps[reasons] = (reasonOverlaps[reasons] ?? 0) + 1;
		const observed = row.recoveryDiagnostics?.observed ?? {};
		if (row.round === weakThreshold.minRoundInclusive) exactBoundaryCounts.minRoundInclusive += 1;
		for (const [name, observedName] of [
			['maxExpectedAttack', 'expectedAttack'],
			['maxAttackDice', 'attackDice'],
			['maxAwakenedSpirits', 'awakenedSpirits'],
			['maxBarrier', 'maxBarrier'],
			['maxInitiative', 'initiative']
		]) {
			if (observed[observedName] === weakThreshold[name]) exactBoundaryCounts[name] += 1;
		}
		if (wanted.has(index)) selected.push(row);
		index += 1;
	}
	requireCondition(
		selected.length === indexes.length,
		'selected trace feature rows are incomplete'
	);
	return {
		totalRows: index,
		selected,
		statistics: {
			rowsByBand,
			rowsPerGame: Object.fromEntries([...rowsPerGame.entries()].sort((a, b) => a[0] - b[0])),
			uniquePublicStateHashes: stateHashCounts.size,
			structuralDuplicateRows: [...stateHashCounts.values()].reduce(
				(sum, count) => sum + Math.max(0, count - 1),
				0
			),
			recoveryReasonOverlaps: reasonOverlaps,
			recoveryExactBoundaryCounts: exactBoundaryCounts
		}
	};
}

export async function verifySelectedTracePrefixes(plan, indexes, collectorModule = null) {
	const config = JSON.parse(readFileSync(plan.execution.configPath, 'utf8'));
	const catalog = JSON.parse(readFileSync(plan.execution.catalogPath, 'utf8'));
	const scanned = await scanSelectedFeatures(
		plan.paths.mergedFeaturePath,
		indexes,
		config.weakEngineThreshold
	);
	const collector =
		collectorModule ??
		(await import(
			`${pathToFileURL(plan.execution.collectorPath).href}?trace=${fileRecord(plan.execution.collectorPath).sha256}`
		));
	requireCondition(
		typeof collector.verifyFeatureTracePrefix === 'function',
		'collector trace verifier is unavailable'
	);
	const manifests = new Map();
	const traces = new Map();
	const shardForSeed = (seed) =>
		plan.shards.find((shard) => seed >= shard.seed0 && seed <= shard.seedMax);
	let verified = 0;
	for (const feature of scanned.selected) {
		const shard = shardForSeed(feature.sourceGameSeed);
		requireCondition(shard, `feature seed ${feature.sourceGameSeed} is outside the smoke ledger`);
		if (!manifests.has(shard.index)) {
			const rows = await readJsonl(shard.traceManifestPath, `shard ${shard.index} trace manifest`);
			requireCondition(
				rows.length === GAMES_PER_SHARD,
				`shard ${shard.index} trace manifest size changed`
			);
			manifests.set(shard.index, new Map(rows.map((row) => [row.sourceGameSeed, row])));
		}
		const manifest = manifests.get(shard.index).get(feature.sourceGameSeed);
		requireCondition(manifest, `trace manifest missing seed ${feature.sourceGameSeed}`);
		if (!traces.has(feature.sourceGameSeed)) {
			const expectedRelative = `traces/game-${String(feature.sourceGameSeed).padStart(10, '0')}.jsonl`;
			requireCondition(
				manifest.shard?.path === expectedRelative &&
					feature.canonicalTakenActionTrace?.shardPath === expectedRelative,
				`trace path for seed ${feature.sourceGameSeed} changed`
			);
			const tracePath = path.join(shard.outDir, expectedRelative);
			const record = fileRecord(tracePath);
			requireCondition(
				record.bytes === manifest.shard.bytes && record.sha256 === manifest.shard.sha256,
				`trace file record for seed ${feature.sourceGameSeed} changed`
			);
			traces.set(
				feature.sourceGameSeed,
				await readJsonl(tracePath, `trace for seed ${feature.sourceGameSeed}`)
			);
		}
		const result = collector.verifyFeatureTracePrefix({
			feature,
			traceEvents: traces.get(feature.sourceGameSeed),
			traceManifest: manifest,
			catalog,
			config
		});
		requireCondition(
			result?.valid === true && result.futureTargetsLoaded === false,
			`trace verification failed for seed ${feature.sourceGameSeed}`
		);
		verified += 1;
	}
	requireCondition(verified === indexes.length, 'trace verification draw was incomplete');
	return {
		selection: plan.traceVerification.selection,
		seed: plan.traceVerification.seed,
		draws: indexes.length,
		selectedIndexesSha256: sha256Bytes(canonicalJson(indexes)),
		verified,
		share: verified / scanned.totalRows,
		futureTargetsLoaded: false,
		statistics: scanned.statistics
	};
}

export function classifyFailure({ serverReady, interrupted, collectionReportExists }) {
	if (interrupted) return collectionReportExists ? 1 : 92;
	return serverReady ? 1 : 90;
}

export function buildFailureEvidence(
	plan,
	{ exitCode, stage, serverReady, interruptedSignal, collectionReportExists, message }
) {
	requireCondition([1, 90, 92].includes(exitCode), 'failure evidence exit code is invalid');
	return {
		schemaVersion: 'arc-v34-b1-density-smoke-failure-output-v1',
		valid: true,
		outcomesInspected: false,
		targetFilesRead: false,
		exitCode,
		stage,
		serverReady,
		interruptedSignal: interruptedSignal ?? null,
		collectionReportExists,
		message: String(message),
		paths: {
			executionLock: plan.paths.executionLockPath,
			attemptRoot: plan.attemptRoot,
			consumedMarker: plan.paths.consumedMarkerPath,
			durableFailure: plan.paths.durableFailurePath,
			durableResult: plan.paths.durableResultPath,
			durableFeatureOnlyReport: plan.paths.durableFeatureOnlyReportPath,
			serverStdout: plan.paths.serverStdoutPath,
			serverStderr: plan.paths.serverStderrPath,
			serverReady: plan.paths.serverReadyPath,
			serverExit: plan.paths.serverExitPath,
			finalProviderBinding: plan.paths.finalProviderBindingPath,
			featureOnlyReport: plan.paths.featureOnlyReportPath,
			collectionReports: plan.shards.map((shard) => shard.collectionPath)
		},
		externalAuthoring: {
			incidentRecord: 'required-outside-this-attempt',
			retryLock: 'requires-new-fable-reviewed-lock',
			attemptSplicingAllowed: false
		},
		recordedAt: new Date().toISOString()
	};
}

export function publishFailureEvidence(plan, failureEvidence) {
	requireCondition(
		!pathEntryExists(plan.paths.durableResultPath),
		'refusing to publish failure after a durable success result'
	);
	writeNewFile(plan.paths.durableFailurePath, `${canonicalJson(failureEvidence)}\n`, 0o444);
	const recorded = JSON.parse(readFileSync(plan.paths.durableFailurePath, 'utf8'));
	requireCondition(
		canonicalJson(recorded) === canonicalJson(failureEvidence),
		'durable failure evidence changed during new-only publication'
	);
	return fileRecord(plan.paths.durableFailurePath);
}

export function buildSuccessEvidence(plan, { reportPublication, consumedMarker }) {
	return {
		schemaVersion: 'arc-v34-b1-density-smoke-success-output-v1',
		valid: true,
		outcomesInspected: false,
		targetFilesRead: false,
		attemptSpliced: false,
		executionLock: fileRecord(plan.paths.executionLockPath),
		consumedMarker,
		featureOnlyReport: reportPublication.source,
		durableFeatureOnlyReport: reportPublication.destination,
		paths: {
			attemptRoot: plan.attemptRoot,
			result: plan.paths.durableResultPath,
			failure: plan.paths.durableFailurePath
		},
		recordedAt: new Date().toISOString()
	};
}

export function publishSuccessEvidence(plan, successEvidence) {
	requireCondition(
		!pathEntryExists(plan.paths.durableFailurePath),
		'refusing to publish success after a durable failure result'
	);
	writeNewFile(plan.paths.durableResultPath, `${canonicalJson(successEvidence)}\n`, 0o444);
	const recorded = JSON.parse(readFileSync(plan.paths.durableResultPath, 'utf8'));
	requireCondition(
		canonicalJson(recorded) === canonicalJson(successEvidence),
		'durable success evidence changed during new-only publication'
	);
	return { value: recorded, record: fileRecord(plan.paths.durableResultPath) };
}

export function validateFeatureOnlyReport(plan, report) {
	requireCondition(
		report?.schemaVersion === REPORT_SCHEMA &&
			report.valid === true &&
			report.unregistered === true &&
			report.outcomesInspected === false &&
			report.futureTargetsRead === false &&
			report.attemptSpliced === false,
		'feature-only report identity changed'
	);
	requireCondition(
		report.seed0 === SEED0 && report.games === TOTAL_GAMES && report.shards?.length === SHARD_COUNT,
		'feature-only report seed/shard coverage changed'
	);
	requireCondition(
		canonicalJson(report.freezer?.floors?.selectedCountsByBand) === canonicalJson(SMOKE_QUOTAS) &&
			report.freezer?.floors?.selectedRows ===
				Object.values(SMOKE_QUOTAS).reduce((sum, value) => sum + value, 0),
		'feature-only report freezer floors changed'
	);
	requireCondition(
		report.targetDeletionInvariance?.shards === SHARD_COUNT &&
			report.targetDeletionInvariance?.targetFilesRead === false &&
			report.targetDeletionInvariance?.artifactsUnchanged === true,
		'feature-only report target-deletion evidence changed'
	);
	requireCondition(
		report.traceVerification?.draws === TRACE_VERIFICATION_DRAWS &&
			report.traceVerification?.verified === TRACE_VERIFICATION_DRAWS &&
			report.traceVerification?.futureTargetsLoaded === false,
		'feature-only report trace verification changed'
	);
	requireCondition(
		canonicalJson(report.servedInfo?.initial) === canonicalJson(report.servedInfo?.final) &&
			canonicalJson(report.servedInfo?.initial) === canonicalJson(plan.expectedServedInfo),
		'feature-only report served-provider evidence changed'
	);
	requireCondition(
		report.scratchUsage?.root === '/dev/shm' &&
			Array.isArray(report.scratchUsage.samples) &&
			report.scratchUsage.samples.length === 7 &&
			BigInt(report.scratchUsage.minimumFreeBytes) <= BigInt(report.scratchUsage.initialFreeBytes),
		'feature-only report scratch evidence changed'
	);
	requireCondition(
		report.performance?.clock === 'process.hrtime.bigint-monotonic' &&
			Object.values(report.performance.elapsedMs ?? {}).every(
				(value) => Number.isFinite(value) && value >= 0
			) &&
			Object.values(report.performance.collectionThroughput ?? {}).every(
				(value) => Number.isFinite(value) && value >= 0
			) &&
			Object.values(report.performance.postflightThroughput ?? {}).every(
				(value) => Number.isFinite(value) && value >= 0
			),
		'feature-only report performance evidence changed'
	);
	requireCondition(
		report.inferenceServerStats?.servingLines === 1 &&
			report.inferenceServerStats?.shutdownLines === 1 &&
			(report.inferenceServerStats.available === true ||
				report.inferenceServerStats.strictUnavailableReason ===
					'no-stats-interval-completed-before-bound-server-shutdown'),
		'feature-only report inference stats evidence changed'
	);
	return report;
}

function interruptController(plan, children) {
	let signalName = null;
	let rejectInterrupt;
	const interrupted = new Promise((_, reject) => {
		rejectInterrupt = reject;
	});
	const handler = (signal) => {
		if (signalName) return;
		signalName = signal;
		for (const child of children) {
			if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
		}
		rejectInterrupt(new Error(`process interrupted by ${signal}`));
	};
	process.once('SIGINT', handler);
	process.once('SIGTERM', handler);
	return {
		interrupted,
		get signalName() {
			return signalName;
		},
		throwIfInterrupted() {
			if (signalName) throw new Error(`process interrupted by ${signalName}`);
		},
		dispose() {
			process.removeListener('SIGINT', handler);
			process.removeListener('SIGTERM', handler);
		},
		collectionReportExists() {
			return plan.shards.some((shard) => pathEntryExists(shard.collectionPath));
		}
	};
}

async function stopChildren(children) {
	for (const launched of children) {
		const child = launched?.child ?? launched;
		if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
	}
	await Promise.allSettled(
		children.map((launched) => launched?.exit).filter((promise) => promise instanceof Promise)
	);
}

export async function runCollectorProcesses(
	plan,
	interrupt,
	launchedChildren,
	launch = spawnLogged
) {
	const launched = plan.shards.map((shard) => {
		const actor = launch(
			{
				executable: shard.executable,
				argv: shard.argv,
				stdoutPath: shard.stdoutPath,
				stderrPath: shard.stderrPath
			},
			{ env: plan.environment }
		);
		launchedChildren.push(actor.child);
		return { shard, actor };
	});
	const pending = new Map(
		launched.map(({ shard, actor }) => [
			shard.index,
			Promise.race([actor.exit.then((result) => ({ shard, actor, result })), interrupt.interrupted])
		])
	);
	try {
		while (pending.size > 0) {
			const completed = await Promise.race(pending.values());
			pending.delete(completed.shard.index);
			requireCondition(
				completed.result.code === 0 && completed.result.signal === null,
				`collector shard ${completed.shard.index} failed ` +
					`${completed.result.code}/${completed.result.signal}: ${completed.actor.getStderrTail()}`
			);
		}
	} catch (error) {
		await stopChildren(launched.map(({ actor }) => actor));
		throw error;
	}
	return launched;
}

/**
 * Perform the one live attempt.  All dependencies are injectable only for synthetic tests;
 * the CLI always uses the concrete implementations above.
 */
export async function runLiveDensitySmoke(plan, dependencies = {}) {
	const probe = dependencies.probe ?? runProbe;
	const handshake = dependencies.handshake ?? infoHandshake;
	const spawnChild = dependencies.spawnChild ?? spawnLogged;
	const merge = dependencies.merge ?? null;
	const runCommand = dependencies.runCommand ?? runProbe;
	const readScratchFreeBytes = dependencies.readScratchFreeBytes ?? shmFreeBytes;
	const attemptStartedNs = process.hrtime.bigint();
	const elapsedMsSince = (started) => Number(process.hrtime.bigint() - started) / 1_000_000;
	let serverReady = false;
	let server = null;
	const childProcesses = [];
	let interrupt = null;
	let stage = 'prelaunch';
	const scratchSamples = [];
	let consumedMarkerRecord = null;
	try {
		assertLaunchPathsAbsent(plan);
		const gpu = parseGpuProbe(
			await probe(
				plan.gpuProbe.executable,
				assertArrayOfStrings(plan.gpuProbe.argv, 'gpuProbe.argv'),
				{
					CUDA_VISIBLE_DEVICES: '7'
				}
			),
			plan.gpuProbe
		);
		const scratch = scratchEvidence(plan);
		recordScratchSample(scratchSamples, 'prelaunch', scratch.freeBytes);
		writeNewFile(
			plan.paths.consumedMarkerPath,
			`${canonicalJson({
				schemaVersion: 'arc-v34-b1-density-smoke-consumed-v1',
				executionLock: fileRecord(plan.paths.executionLockPath),
				seed0: SEED0,
				games: TOTAL_GAMES,
				createdAt: new Date().toISOString()
			})}\n`,
			0o444
		);
		consumedMarkerRecord = fileRecord(plan.paths.consumedMarkerPath);
		mkdirSync(plan.attemptRoot, { recursive: false });
		stage = 'server-start';
		server = spawnChild(plan.server, {
			env: plan.environment,
			readyPattern: /\[infer\] serving /u
		});
		childProcesses.push(server.child);
		interrupt = interruptController(plan, childProcesses);
		await Promise.race([
			withTimeout(server.ready, plan.serverReadyTimeoutMs, 'inference server readiness'),
			interrupt.interrupted
		]);
		serverReady = true;
		const initialServedInfo = validateServedInfo(
			await handshake(plan.socketPath, 30_000),
			plan.expectedServedInfo
		);
		writeNewFile(
			plan.paths.serverReadyPath,
			`${canonicalJson({
				schemaVersion: 'arc-v34-b1-infer-server-ready-v1',
				gpu,
				scratch,
				servedInfo: initialServedInfo,
				recordedAt: new Date().toISOString()
			})}\n`,
			0o444
		);
		stage = 'collection';
		const collectionStartedNs = process.hrtime.bigint();
		const collectors = await runCollectorProcesses(
			plan,
			interrupt,
			childProcesses,
			dependencies.spawnCollector ?? spawnLogged
		);
		const collectionElapsedMs = elapsedMsSince(collectionStartedNs);
		recordScratchSample(scratchSamples, 'after-collection', readScratchFreeBytes());
		interrupt.throwIfInterrupted();
		stage = 'provider-postflight';
		const finalServedInfo = validateServedInfo(await handshake(plan.socketPath, 30_000));
		interrupt.throwIfInterrupted();
		requireCondition(
			canonicalJson(finalServedInfo) === canonicalJson(initialServedInfo),
			'final served-info handshake differs from the initial handshake'
		);
		writeNewFile(
			plan.paths.finalProviderBindingPath,
			`${canonicalJson({
				schemaVersion: 'arc-v34-b1-final-provider-binding-v1',
				matchesInitial: true,
				providerBinding: plan.expectedProviderBinding,
				providerBindingCanonicalSha256: plan.lock.expectedExecutionProviderBindingCanonicalSha256,
				initial: initialServedInfo,
				final: finalServedInfo,
				recordedAt: new Date().toISOString()
			})}\n`,
			0o444
		);
		server.child.kill('SIGTERM');
		const serverExit = await server.exit;
		interrupt.throwIfInterrupted();
		requireCondition(
			(serverExit.code === 0 || serverExit.code === null) &&
				(serverExit.signal === null || serverExit.signal === 'SIGTERM'),
			`inference server shutdown failed ${serverExit.code}/${serverExit.signal}`
		);
		writeNewFile(
			plan.paths.serverExitPath,
			`${canonicalJson({
				schemaVersion: 'arc-v34-b1-infer-server-exit-v1',
				code: serverExit.code,
				signal: serverExit.signal,
				recordedAt: new Date().toISOString()
			})}\n`,
			0o444
		);
		const inferenceServerStats = parseInferenceServerStats(
			readFileSync(plan.paths.serverStderrPath, 'utf8')
		);
		const collections = verifyShardReports(plan);
		interrupt.throwIfInterrupted();
		stage = 'feature-only-postflight';
		const postflightStartedNs = process.hrtime.bigint();
		const mergedFeatures = await mergeFeatureShards(plan, merge);
		recordScratchSample(scratchSamples, 'after-feature-merge', readScratchFreeBytes());
		interrupt.throwIfInterrupted();
		const freezer = await runSmokeFreezer(plan, runCommand);
		recordScratchSample(scratchSamples, 'after-freezer', readScratchFreeBytes());
		interrupt.throwIfInterrupted();
		const invariantArtifacts = {
			merged: fileRecord(plan.paths.mergedFeaturePath),
			output: fileRecord(plan.paths.smokeFreezeOutputPath),
			ledger: fileRecord(plan.paths.smokeFreezeLedgerPath)
		};
		const targetDeletion = (dependencies.deleteTargets ?? deleteDisposableTargetShards)(plan);
		recordScratchSample(scratchSamples, 'after-target-deletion', readScratchFreeBytes());
		interrupt.throwIfInterrupted();
		const postDeletionVerification = await verifyFreezerAfterTargetDeletion(
			plan,
			invariantArtifacts,
			runCommand
		);
		interrupt.throwIfInterrupted();
		const traceIndexes = await selectTraceVerificationIndexes(
			plan,
			freezer.floors.inputRows,
			runCommand
		);
		const traceVerification = await verifySelectedTracePrefixes(
			plan,
			traceIndexes,
			dependencies.collectorModule ?? null
		);
		recordScratchSample(scratchSamples, 'after-trace-verification', readScratchFreeBytes());
		interrupt.throwIfInterrupted();
		const postflightElapsedMs = elapsedMsSince(postflightStartedNs);
		recordScratchSample(scratchSamples, 'before-report', readScratchFreeBytes());
		const scratchUsage = summarizeScratchSamples(scratchSamples);
		const featureRows = collections.reduce(
			(sum, collection) => sum + Number(collection.metrics?.featureRows ?? 0),
			0
		);
		requireCondition(
			featureRows === freezer.floors.inputRows,
			'collection/merged feature row count changed'
		);
		const performance = buildPerformanceEvidence({
			totalElapsedMs: elapsedMsSince(attemptStartedNs),
			collectionElapsedMs,
			postflightElapsedMs,
			featureRows,
			mergedFeatureBytes: invariantArtifacts.merged.bytes,
			traceVerifications: traceVerification.verified
		});
		const report = {
			schemaVersion: REPORT_SCHEMA,
			valid: true,
			unregistered: true,
			outcomesInspected: false,
			futureTargetsRead: false,
			attemptSpliced: false,
			seed0: SEED0,
			games: TOTAL_GAMES,
			shards: plan.shards.map((shard, index) => ({
				index,
				seed0: shard.seed0,
				games: shard.games,
				collection: fileRecord(shard.collectionPath),
				featureRows: collections[index].metrics?.featureRows ?? null
			})),
			gpu,
			scratch,
			scratchUsage,
			performance,
			inferenceServerStats,
			servedInfo: { initial: initialServedInfo, final: finalServedInfo },
			mergedFeatures,
			freezer: {
				floors: freezer.floors,
				output: invariantArtifacts.output,
				ledger: invariantArtifacts.ledger,
				postDeletionVerification: postDeletionVerification.summary
			},
			targetDeletionInvariance: {
				...targetDeletion,
				targetFilesRead: false,
				artifactsUnchanged: true
			},
			traceVerification,
			server: { exit: serverExit },
			collectors: collectors.map(({ shard }) => ({ index: shard.index, exit: 0 }))
		};
		validateFeatureOnlyReport(plan, report);
		writeNewFile(plan.paths.featureOnlyReportPath, `${canonicalJson(report)}\n`, 0o444);
		const recordedReport = JSON.parse(readFileSync(plan.paths.featureOnlyReportPath, 'utf8'));
		validateFeatureOnlyReport(plan, recordedReport);
		requireCondition(
			canonicalJson(recordedReport) === canonicalJson(report),
			'feature-only report changed during new-only publication'
		);
		const reportPublication = copyNewFileVerified(
			plan.paths.featureOnlyReportPath,
			plan.paths.durableFeatureOnlyReportPath
		);
		const successEvidence = buildSuccessEvidence(plan, {
			reportPublication,
			consumedMarker: consumedMarkerRecord
		});
		return publishSuccessEvidence(plan, successEvidence).value;
	} catch (error) {
		await stopChildren(server ? [server] : []);
		const interrupted = interrupt?.signalName != null;
		const collectionReportExists = interrupt?.collectionReportExists() ?? false;
		error.exitCode = classifyFailure({ serverReady, interrupted, collectionReportExists });
		error.failureEvidence = buildFailureEvidence(plan, {
			exitCode: error.exitCode,
			stage,
			serverReady,
			interruptedSignal: interrupt?.signalName ?? null,
			collectionReportExists,
			message: error?.message ?? error
		});
		try {
			error.failureEvidenceRecord = publishFailureEvidence(plan, error.failureEvidence);
		} catch (publicationError) {
			error.failurePublicationError = String(publicationError?.stack ?? publicationError);
		}
		throw error;
	} finally {
		interrupt?.dispose();
	}
}

async function loadVerifiedLock(lockPath, verifierPath, requireAbsentPaths) {
	const resolvedLock = assertAbsolute(lockPath, '--lock');
	const resolvedVerifier = assertAbsolute(verifierPath, '--lock-verifier');
	const imported = await import(
		`${pathToFileURL(resolvedVerifier).href}?sha256=${sha256Bytes(readFileSync(resolvedVerifier))}`
	);
	requireCondition(
		typeof imported.verifyV34B1DensitySmokeExecutionLock === 'function',
		'lock verifier does not export verifyV34B1DensitySmokeExecutionLock'
	);
	const verification = imported.verifyV34B1DensitySmokeExecutionLock({
		lockPath: resolvedLock,
		repoRoot: ROOT,
		requireOpen: true,
		requireAbsentPaths
	});
	requireCondition(
		verification?.schemaVersion === LOCK_SCHEMA &&
			verification.authoritative === true &&
			verification.outcomeBlind === true,
		'execution-lock verifier did not return the authoritative parsed lock'
	);
	return verification;
}

export function parseCli(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			mode: { type: 'string', default: 'dry-run' },
			lock: { type: 'string' },
			'lock-verifier': { type: 'string', default: DEFAULT_LOCK_VERIFIER }
		},
		strict: true
	});
	requireCondition(
		values.mode === 'dry-run' || values.mode === 'live',
		'--mode must be dry-run or live'
	);
	requireCondition(typeof values.lock === 'string', '--lock is required');
	return {
		mode: values.mode,
		lockPath: path.resolve(values.lock),
		lockVerifierPath: path.resolve(values['lock-verifier'])
	};
}

export async function cli(argv = process.argv.slice(2)) {
	const args = parseCli(argv);
	const lock = await loadVerifiedLock(args.lockPath, args.lockVerifierPath, true);
	const plan = buildLaunchPlan(lock);
	if (args.mode === 'dry-run') {
		return {
			schemaVersion: 'arc-v34-b1-density-smoke-dry-run-v1',
			valid: true,
			launched: false,
			lock: args.lockPath,
			server: { executable: plan.server.executable, argv: plan.server.argv },
			collectors: plan.shards.map((shard) => ({
				index: shard.index,
				executable: shard.executable,
				argv: shard.argv
			}))
		};
	}
	return runLiveDensitySmoke(plan);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
	cli()
		.then((result) => process.stdout.write(`${canonicalJson(result)}\n`))
		.catch((error) => {
			process.stderr.write(`${error?.stack ?? error}\n`);
			if (error?.failureEvidence) {
				process.stderr.write(`${canonicalJson(error.failureEvidence)}\n`);
			}
			if (error?.failureEvidenceRecord) {
				process.stderr.write(`${canonicalJson({ durableFailure: error.failureEvidenceRecord })}\n`);
			}
			if (error?.failurePublicationError) {
				process.stderr.write(
					`${canonicalJson({ failurePublicationError: error.failurePublicationError })}\n`
				);
			}
			process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
		});
}
