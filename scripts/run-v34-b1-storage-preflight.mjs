#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
	closeSync,
	existsSync,
	fchmodSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmdirSync,
	statfsSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASIS_SCHEMA = 'arc-v34-b1-smoke-authorization-basis-v1';
const REPORT_SCHEMA = 'arc-v34-b1-storage-preflight-v1';
const EXPECTED_BUCKET = 'dev-simforge-435362779479-models';
const EXPECTED_REGION = 'us-west-1';
const EXPECTED_PROFILE = 'simforge';
const PREFIX_TEMPLATE = 'arc-spirits/v34/lane-b/<authorization-basis-sha256>/';
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROBE_BYTES = 1024 * 1024 * 1024;
const AWS_EXEC_TIMEOUT_MS = 120_000;

export const V34_B1_PREFLIGHT_FLAG_KEYS = Object.freeze([
	'storagePreflightOpen',
	'gameExecutionOpen',
	'densitySmokeOpen',
	'registeredSeedsOpen',
	'registeredCollectionOpen',
	'teacherSearchOpen',
	'trainingOpen',
	'developmentEvaluationOpen',
	'hiddenEvaluationOpen',
	'humanGateOpen',
	'promotionOpen',
	'deploymentOpen'
]);

export const V34_B1_STORAGE_PREFLIGHT_KEYS = Object.freeze([
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
]);

const ROOT_KEYS = [
	'schemaVersion',
	'authorizationBasis',
	'authorizationBasisSha256',
	'derivedStoragePrefix',
	'flags'
];
const STORAGE_KEYS = ['kind', 'bucket', 'region', 'profile', 'prefixTemplate'];
const REPORT_KEYS = [
	'schemaVersion',
	'authorizationBasis',
	'authorizationBasisSha256',
	'authorizationBasisFile',
	'derivedStoragePrefix',
	'storage',
	'probe',
	'scratch',
	'commands',
	'throughput',
	'flags',
	'passed',
	'failure',
	'recordedAt'
];

function assert(condition, message) {
	if (!condition) throw new Error(`V34 B1 storage preflight: ${message}`);
}

function same(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, expected, label) {
	assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
	assert(
		same(Object.keys(value).sort(), [...expected].sort()),
		`${label} keys changed (found ${Object.keys(value ?? {})
			.sort()
			.join(',')})`
	);
	return value;
}

export function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonicalize(value[key])])
	);
}

export function canonicalSha256(value) {
	return createHash('sha256')
		.update(JSON.stringify(canonicalize(value)))
		.digest('hex');
}

function bufferSha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

function fileSha256(file) {
	return bufferSha256(readFileSync(file));
}

function resolveBoundPath(value, repo) {
	assert(typeof value === 'string' && value.length > 0, 'bound path is missing');
	return path.isAbsolute(value) ? path.resolve(value) : path.resolve(repo, value);
}

function assertNewPath(file, label) {
	try {
		lstatSync(file);
		throw new Error(`V34 B1 storage preflight: ${label} already exists`);
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error;
	}
}

function recordFile(file) {
	const bytes = readFileSync(file).length;
	return { path: path.resolve(file), bytes, sha256: fileSha256(file) };
}

function fileIdentity(stat) {
	return {
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
		mode: stat.mode
	};
}

function assertBasisUnchanged(loaded) {
	const currentStat = lstatSync(loaded.basisPath);
	assert(
		currentStat.isFile() &&
			!currentStat.isSymbolicLink() &&
			same(fileIdentity(currentStat), loaded.basisFileIdentity) &&
			fileSha256(loaded.basisPath) === loaded.basisFileRecord.sha256,
		'authorization basis changed after validation'
	);
}

function validateFlags(flags) {
	exactKeys(flags, V34_B1_PREFLIGHT_FLAG_KEYS, 'flags');
	assert(flags.storagePreflightOpen === true, 'storagePreflightOpen must be true');
	for (const key of V34_B1_PREFLIGHT_FLAG_KEYS) {
		if (key !== 'storagePreflightOpen') assert(flags[key] === false, `${key} must remain false`);
	}
}

function assertNoSecretFields(value, label = 'authorizationBasis') {
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) assertNoSecretFields(entry, `${label}[${index}]`);
		return;
	}
	if (!value || typeof value !== 'object') return;
	const banned = new Set([
		'secret',
		'secrets',
		'password',
		'passwd',
		'credential',
		'credentials',
		'accesskey',
		'secretaccesskey',
		'sessiontoken',
		'privatekey'
	]);
	for (const [key, entry] of Object.entries(value)) {
		assert(
			!banned.has(key.toLowerCase().replace(/[^a-z0-9]/g, '')),
			`${label}.${key} is a forbidden secret-bearing field`
		);
		assertNoSecretFields(entry, `${label}.${key}`);
	}
}

export function deriveStoragePrefix(authorizationBasisSha256, prefixTemplate = PREFIX_TEMPLATE) {
	assert(/^[0-9a-f]{64}$/.test(authorizationBasisSha256 ?? ''), 'basis SHA-256 is malformed');
	assert(prefixTemplate === PREFIX_TEMPLATE, 'storage prefix template changed');
	return prefixTemplate.replace('<authorization-basis-sha256>', authorizationBasisSha256);
}

function loadAuthorizationBasis({ basisPath, repo = REPO }) {
	repo = path.resolve(repo);
	basisPath = path.resolve(basisPath);
	const basisStat = lstatSync(basisPath);
	assert(
		basisStat.isFile() && !basisStat.isSymbolicLink(),
		'authorization basis must be a regular file'
	);
	assert((basisStat.mode & 0o222) === 0, 'authorization basis must be read-only');
	const basisBytes = readFileSync(basisPath);
	const basisStatAfterRead = lstatSync(basisPath);
	assert(
		same(fileIdentity(basisStat), fileIdentity(basisStatAfterRead)),
		'authorization basis changed while it was being read'
	);
	const basis = JSON.parse(basisBytes.toString('utf8'));
	exactKeys(basis, ROOT_KEYS, 'authorization basis root');
	assert(basis.schemaVersion === BASIS_SCHEMA, 'authorization basis schema mismatch');
	assert(
		canonicalSha256(basis.authorizationBasis) === basis.authorizationBasisSha256,
		'authorizationBasisSha256 does not match the canonical authorizationBasis object'
	);
	assertNoSecretFields(basis.authorizationBasis);
	assert(
		basis.derivedStoragePrefix === deriveStoragePrefix(basis.authorizationBasisSha256),
		'derived storage prefix does not match the basis SHA-256'
	);
	validateFlags(basis.flags);

	const storage = exactKeys(
		basis.authorizationBasis?.storage,
		STORAGE_KEYS,
		'authorizationBasis.storage'
	);
	assert(storage.kind === 's3', 'storage kind must be s3');
	assert(storage.bucket === EXPECTED_BUCKET, 'storage bucket changed');
	assert(storage.region === EXPECTED_REGION, 'storage region changed');
	assert(storage.profile === EXPECTED_PROFILE, 'storage profile changed');
	assert(storage.prefixTemplate === PREFIX_TEMPLATE, 'storage prefix template changed');

	const policy = exactKeys(
		basis.authorizationBasis?.storagePreflight,
		V34_B1_STORAGE_PREFLIGHT_KEYS,
		'authorizationBasis.storagePreflight'
	);
	assert(path.isAbsolute(policy.awsExecutable), 'awsExecutable must be an absolute path');
	assert(path.isAbsolute(policy.attemptRoot), 'attemptRoot must be an absolute path');
	assert(path.isAbsolute(policy.outputPath), 'outputPath must be an absolute path');
	assert(
		Number.isSafeInteger(policy.probeBytes) &&
			policy.probeBytes > 0 &&
			policy.probeBytes <= MAX_PROBE_BYTES,
		'probeBytes is invalid'
	);
	assert(
		Number.isSafeInteger(policy.projectedSmokePeakBytes) && policy.projectedSmokePeakBytes > 0,
		'projectedSmokePeakBytes is invalid'
	);
	assert(policy.scratchMultiplier === 2, 'scratchMultiplier must equal the reviewed value 2');
	assert(
		Number.isSafeInteger(policy.projectedSmokePeakBytes * policy.scratchMultiplier),
		'scratch requirement exceeds the safe-integer range'
	);
	assert(
		Number.isSafeInteger(policy.postDeleteHeadAttempts) &&
			policy.postDeleteHeadAttempts >= 1 &&
			policy.postDeleteHeadAttempts <= 10,
		'postDeleteHeadAttempts is invalid'
	);
	assert(
		Number.isSafeInteger(policy.postDeleteDelayMs) &&
			policy.postDeleteDelayMs >= 0 &&
			policy.postDeleteDelayMs <= 60_000,
		'postDeleteDelayMs is invalid'
	);
	assert(/^[a-z0-9-]{1,64}$/.test(policy.metadataKey), 'metadataKey is invalid');
	assert(/^[a-z0-9_][a-z0-9_-]{0,63}$/.test(policy.probeKeySegment), 'probeKeySegment is invalid');
	return {
		basis,
		basisPath,
		basisStat,
		basisFileIdentity: fileIdentity(basisStat),
		basisFileRecord: {
			path: basisPath,
			bytes: basisBytes.length,
			sha256: bufferSha256(basisBytes)
		},
		policy,
		storage,
		repo
	};
}

export function validateAuthorizationBasis({ basisPath, outputPath, repo = REPO }) {
	const loaded = loadAuthorizationBasis({ basisPath, repo });
	const { policy } = loaded;
	const resolvedOut = path.resolve(outputPath);
	assert(
		resolvedOut === resolveBoundPath(policy.outputPath, loaded.repo),
		'output differs from bound outputPath'
	);
	assert(
		!resolvedOut.startsWith(`${path.resolve(policy.attemptRoot)}${path.sep}`),
		'outputPath must not be inside the disposable attemptRoot'
	);
	assertNewPath(resolvedOut, 'bound report output');
	assertNewPath(path.resolve(policy.attemptRoot), 'bound attemptRoot');
	return { ...loaded, outputPath: resolvedOut };
}

function defaultExec(file, args) {
	const started = performance.now();
	return new Promise((resolve) => {
		execFile(
			file,
			args,
			{
				encoding: null,
				maxBuffer: 4 * 1024 * 1024,
				timeout: AWS_EXEC_TIMEOUT_MS,
				killSignal: 'SIGTERM'
			},
			(error, stdout, stderr) => {
				resolve({
					exitCode: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
					stdout: Buffer.from(stdout ?? ''),
					stderr: Buffer.from(stderr ?? ''),
					durationMs: Math.max(0, performance.now() - started)
				});
			}
		);
	});
}

function outputEvidence(value) {
	const bytes = Buffer.from(value ?? '');
	return { bytes: bytes.length, sha256: bufferSha256(bytes) };
}

function commandRecord(operation, executable, args, result) {
	return {
		operation,
		executable,
		args: [...args],
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		stdout: outputEvidence(result.stdout),
		stderr: outputEvidence(result.stderr)
	};
}

function parseJsonOutput(result, label) {
	try {
		return JSON.parse(Buffer.from(result.stdout).toString('utf8'));
	} catch {
		throw new Error(`V34 B1 storage preflight: ${label} returned invalid JSON`);
	}
}

function absentHeadResult(result) {
	if (result.exitCode === 0) return false;
	const text = `${Buffer.from(result.stdout).toString('utf8')}\n${Buffer.from(result.stderr).toString('utf8')}`;
	return /An error occurred \((?:404|NoSuchKey|NotFound)\) when calling the HeadObject operation:\s*(?:Not Found|NoSuchKey)/i.test(
		text
	);
}

function putPreconditionFailed(result) {
	if (result.exitCode === 0) return false;
	const text = `${Buffer.from(result.stdout).toString('utf8')}\n${Buffer.from(result.stderr).toString('utf8')}`;
	return /An error occurred \((?:412|PreconditionFailed)\) when calling the PutObject operation:/i.test(
		text
	);
}

function freeBytesDevShm() {
	const stats = statfsSync('/dev/shm', { bigint: true });
	return Number(stats.bavail * stats.bsize);
}

function safeFailure(error) {
	const message = String(error?.message ?? error);
	if (message.startsWith('V34 B1 storage preflight: ')) {
		return { code: 'preflight-check-failed', message };
	}
	return {
		code: 'unexpected-preflight-failure',
		message:
			'V34 B1 storage preflight: unexpected internal failure; inspect separately without recording secret-bearing output'
	};
}

function combineFailure(current, next, code = 'multiple-preflight-failures') {
	const normalized = next?.code && next?.message ? next : safeFailure(next);
	if (!current) {
		return code === 'multiple-preflight-failures'
			? normalized
			: { code, message: normalized.message };
	}
	return {
		code,
		message: `${current.message}; ${normalized.message}`
	};
}

function verifyReportShape(report) {
	exactKeys(report, REPORT_KEYS, 'storage preflight report');
	exactKeys(report.authorizationBasisFile, ['path', 'bytes', 'sha256'], 'authorizationBasisFile');
	exactKeys(
		report.storage,
		['kind', 'bucket', 'region', 'profile', 'prefix', 'probeKey'],
		'storage'
	);
	exactKeys(report.probe, ['bytes', 'metadataKey', 'source', 'download', 'checks'], 'probe');
	exactKeys(
		report.probe.checks,
		[
			'localCreate',
			'upload',
			'metadataRead',
			'downloadHash',
			'delete',
			'postDeleteAbsence',
			'localCleanup'
		],
		'probe.checks'
	);
	exactKeys(
		report.scratch,
		[
			'filesystem',
			'freeBytesBefore',
			'requiredBytes',
			'projectedSmokePeakBytes',
			'multiplier',
			'freeBytesAfter'
		],
		'scratch'
	);
	exactKeys(
		report.throughput,
		['uploadBytesPerSecond', 'downloadBytesPerSecond', 'totalRuntimeMs'],
		'throughput'
	);
	validateFlags(report.flags);
	assert(report.flags.densitySmokeOpen === false, 'report cannot open the density smoke');
	assert(report.flags.registeredSeedsOpen === false, 'report cannot open registered seeds');
}

function verifyRecordedFile(record, label) {
	exactKeys(record, ['path', 'bytes', 'sha256'], label);
	assert(path.isAbsolute(record.path), `${label}.path must be absolute`);
	assert(Number.isSafeInteger(record.bytes) && record.bytes > 0, `${label}.bytes is invalid`);
	assert(/^[0-9a-f]{64}$/.test(record.sha256 ?? ''), `${label}.sha256 is invalid`);
}

function verifyCommandRecord(command, label) {
	exactKeys(
		command,
		['operation', 'executable', 'args', 'exitCode', 'durationMs', 'stdout', 'stderr'],
		label
	);
	assert(
		typeof command.operation === 'string' && command.operation,
		`${label}.operation is invalid`
	);
	assert(path.isAbsolute(command.executable), `${label}.executable must be absolute`);
	assert(
		Array.isArray(command.args) && command.args.every((entry) => typeof entry === 'string'),
		`${label}.args is invalid`
	);
	assert(Number.isInteger(command.exitCode), `${label}.exitCode is invalid`);
	assert(
		typeof command.durationMs === 'number' &&
			Number.isFinite(command.durationMs) &&
			command.durationMs >= 0,
		`${label}.durationMs is invalid`
	);
	for (const stream of ['stdout', 'stderr']) {
		exactKeys(command[stream], ['bytes', 'sha256'], `${label}.${stream}`);
		assert(
			Number.isSafeInteger(command[stream].bytes) && command[stream].bytes >= 0,
			`${label}.${stream}.bytes is invalid`
		);
		assert(
			/^[0-9a-f]{64}$/.test(command[stream].sha256 ?? ''),
			`${label}.${stream}.sha256 is invalid`
		);
	}
}

function verifyReportValues(report) {
	verifyReportShape(report);
	assert(report.schemaVersion === REPORT_SCHEMA, 'preflight report schema mismatch');
	assertNoSecretFields(report.authorizationBasis);
	verifyRecordedFile(report.authorizationBasisFile, 'authorizationBasisFile');
	for (const key of ['kind', 'bucket', 'region', 'profile', 'prefix', 'probeKey']) {
		assert(
			typeof report.storage[key] === 'string' && report.storage[key],
			`storage.${key} is invalid`
		);
	}
	assert(
		Number.isSafeInteger(report.probe.bytes) && report.probe.bytes > 0,
		'probe.bytes is invalid'
	);
	assert(
		typeof report.probe.metadataKey === 'string' && report.probe.metadataKey,
		'probe.metadataKey is invalid'
	);
	for (const key of Object.keys(report.probe.checks)) {
		assert(typeof report.probe.checks[key] === 'boolean', `probe.checks.${key} is invalid`);
	}
	if (report.probe.source !== null) verifyRecordedFile(report.probe.source, 'probe.source');
	if (report.probe.download !== null) verifyRecordedFile(report.probe.download, 'probe.download');
	assert(report.scratch.filesystem === '/dev/shm', 'scratch filesystem changed');
	for (const key of ['freeBytesBefore', 'freeBytesAfter']) {
		assert(
			report.scratch[key] === null ||
				(Number.isSafeInteger(report.scratch[key]) && report.scratch[key] >= 0),
			`scratch.${key} is invalid`
		);
	}
	for (const key of ['requiredBytes', 'projectedSmokePeakBytes']) {
		assert(
			Number.isSafeInteger(report.scratch[key]) && report.scratch[key] > 0,
			`scratch.${key} is invalid`
		);
	}
	assert(report.scratch.multiplier === 2, 'scratch.multiplier changed');
	assert(Array.isArray(report.commands), 'commands must be an array');
	for (const [index, command] of report.commands.entries()) {
		verifyCommandRecord(command, `commands[${index}]`);
	}
	for (const key of ['uploadBytesPerSecond', 'downloadBytesPerSecond']) {
		assert(
			report.throughput[key] === null ||
				(typeof report.throughput[key] === 'number' &&
					Number.isFinite(report.throughput[key]) &&
					report.throughput[key] > 0),
			`throughput.${key} is invalid`
		);
	}
	assert(
		typeof report.throughput.totalRuntimeMs === 'number' &&
			Number.isFinite(report.throughput.totalRuntimeMs) &&
			report.throughput.totalRuntimeMs >= 0,
		'throughput.totalRuntimeMs is invalid'
	);
	assert(typeof report.passed === 'boolean', 'passed must be boolean');
	if (report.passed) {
		assert(report.failure === null, 'passed report must have null failure');
	} else {
		exactKeys(report.failure, ['code', 'message'], 'failure');
		assert(
			typeof report.failure.code === 'string' &&
				report.failure.code &&
				typeof report.failure.message === 'string' &&
				report.failure.message.startsWith('V34 B1 storage preflight: '),
			'failure evidence is invalid'
		);
	}
	assert(
		typeof report.recordedAt === 'string' &&
			!Number.isNaN(Date.parse(report.recordedAt)) &&
			new Date(report.recordedAt).toISOString() === report.recordedAt,
		'recordedAt is invalid'
	);
}

export function validateStoragePreflightReport({
	reportPath,
	basisPath,
	repo = REPO,
	requirePassed = true
}) {
	reportPath = path.resolve(reportPath);
	const reportStat = lstatSync(reportPath);
	assert(
		reportStat.isFile() && !reportStat.isSymbolicLink(),
		'preflight report must be a regular file'
	);
	assert((reportStat.mode & 0o222) === 0, 'preflight report must be read-only');
	const report = JSON.parse(readFileSync(reportPath, 'utf8'));
	verifyReportValues(report);
	const loaded = loadAuthorizationBasis({ basisPath, repo });
	const { basis, policy, storage } = loaded;
	assert(
		same(report.authorizationBasis, canonicalize(basis.authorizationBasis)),
		'report authorizationBasis differs from the immutable basis'
	);
	assert(
		report.authorizationBasisSha256 === basis.authorizationBasisSha256,
		'report basis SHA-256 changed'
	);
	assert(
		report.derivedStoragePrefix === basis.derivedStoragePrefix,
		'report derived prefix changed'
	);
	assert(same(report.flags, basis.flags), 'report flags differ from the immutable basis');
	assert(
		same(report.authorizationBasisFile, recordFile(loaded.basisPath)),
		'report authorization-basis file record changed'
	);
	assert(
		same(
			{
				kind: report.storage.kind,
				bucket: report.storage.bucket,
				region: report.storage.region,
				profile: report.storage.profile,
				prefix: report.storage.prefix
			},
			{
				kind: storage.kind,
				bucket: storage.bucket,
				region: storage.region,
				profile: storage.profile,
				prefix: basis.derivedStoragePrefix
			}
		),
		'report storage identity changed'
	);
	assert(
		new RegExp(
			`^${basis.derivedStoragePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${policy.probeKeySegment}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.bin$`,
			'i'
		).test(report.storage.probeKey),
		'report probe key is outside the exact derived prefix/segment'
	);
	assert(report.probe.bytes === policy.probeBytes, 'report probe byte count changed');
	assert(report.probe.metadataKey === policy.metadataKey, 'report metadata key changed');
	if (report.probe.source !== null) verifyRecordedFile(report.probe.source, 'probe.source');
	if (report.probe.download !== null) verifyRecordedFile(report.probe.download, 'probe.download');
	if (report.probe.source !== null) {
		assert(
			report.probe.source.path === path.join(path.resolve(policy.attemptRoot), 'probe-source.bin'),
			'probe.source path changed'
		);
	}
	if (report.probe.download !== null) {
		assert(
			report.probe.download.path ===
				path.join(path.resolve(policy.attemptRoot), 'probe-download.bin'),
			'probe.download path changed'
		);
	}
	assert(report.scratch.filesystem === '/dev/shm', 'scratch filesystem changed');
	assert(
		report.scratch.projectedSmokePeakBytes === policy.projectedSmokePeakBytes &&
			report.scratch.multiplier === policy.scratchMultiplier &&
			report.scratch.requiredBytes ===
				Math.ceil(policy.projectedSmokePeakBytes * policy.scratchMultiplier),
		'scratch requirement changed'
	);
	assert(Array.isArray(report.commands), 'commands must be an array');
	for (const [index, command] of report.commands.entries()) {
		verifyCommandRecord(command, `commands[${index}]`);
		assert(command.executable === policy.awsExecutable, `commands[${index}] executable changed`);
	}
	assert(
		typeof report.recordedAt === 'string' &&
			new Date(report.recordedAt).toISOString() === report.recordedAt,
		'recordedAt is invalid'
	);
	if (!requirePassed) return report;
	assert(report.passed === true && report.failure === null, 'preflight report did not pass');
	assert(Object.values(report.probe.checks).every(Boolean), 'preflight checks are incomplete');
	assert(
		report.probe.source &&
			report.probe.download &&
			report.probe.source.bytes === policy.probeBytes &&
			report.probe.download.bytes === policy.probeBytes &&
			report.probe.source.sha256 === report.probe.download.sha256,
		'probe download does not match the source'
	);
	assert(
		Number.isSafeInteger(report.scratch.freeBytesBefore) &&
			report.scratch.freeBytesBefore >= report.scratch.requiredBytes &&
			Number.isSafeInteger(report.scratch.freeBytesAfter) &&
			report.scratch.freeBytesAfter >= 0,
		'scratch capacity evidence is invalid'
	);
	assert(
		typeof report.throughput.uploadBytesPerSecond === 'number' &&
			Number.isFinite(report.throughput.uploadBytesPerSecond) &&
			report.throughput.uploadBytesPerSecond > 0 &&
			typeof report.throughput.downloadBytesPerSecond === 'number' &&
			Number.isFinite(report.throughput.downloadBytesPerSecond) &&
			report.throughput.downloadBytesPerSecond > 0 &&
			typeof report.throughput.totalRuntimeMs === 'number' &&
			Number.isFinite(report.throughput.totalRuntimeMs) &&
			report.throughput.totalRuntimeMs >= 0,
		'throughput evidence is invalid'
	);
	const operations = report.commands.map((command) => command.operation);
	assert(
		same(operations.slice(0, 4), ['put-object', 'head-object', 'get-object', 'delete-object']),
		'preflight command prefix changed'
	);
	const postOperations = operations.slice(4);
	assert(
		postOperations.length >= 1 &&
			postOperations.length <= policy.postDeleteHeadAttempts &&
			postOperations.every(
				(operation, index) => operation === `post-delete-head-object-${index + 1}`
			),
		'post-delete head-object sequence changed'
	);
	assert(
		report.commands.slice(0, 4).every((command) => command.exitCode === 0) &&
			report.commands.at(-1).exitCode !== 0,
		'command exits do not prove upload/read/download/delete/absence'
	);
	const baseArgs = [
		'--no-cli-pager',
		'--profile',
		storage.profile,
		'--region',
		storage.region,
		's3api'
	];
	const headArgs = [
		...baseArgs,
		'head-object',
		'--bucket',
		storage.bucket,
		'--key',
		report.storage.probeKey
	];
	const expected = [
		[
			...baseArgs,
			'put-object',
			'--bucket',
			storage.bucket,
			'--key',
			report.storage.probeKey,
			'--body',
			report.probe.source.path,
			'--metadata',
			`${policy.metadataKey}=${report.probe.source.sha256}`,
			'--checksum-algorithm',
			'SHA256',
			'--if-none-match',
			'*'
		],
		headArgs,
		[
			...baseArgs,
			'get-object',
			'--bucket',
			storage.bucket,
			'--key',
			report.storage.probeKey,
			report.probe.download.path
		],
		[...baseArgs, 'delete-object', '--bucket', storage.bucket, '--key', report.storage.probeKey]
	];
	for (let index = 0; index < expected.length; index += 1) {
		assert(same(report.commands[index].args, expected[index]), `commands[${index}] argv changed`);
	}
	for (const command of report.commands.slice(4)) {
		assert(same(command.args, headArgs), `${command.operation} argv changed`);
	}
	return report;
}

function publishNewOnly(file, report) {
	verifyReportValues(report);
	const handle = openSync(file, 'wx', 0o444);
	try {
		writeFileSync(handle, `${JSON.stringify(report, null, 2)}\n`);
		fchmodSync(handle, 0o444);
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
	const directoryHandle = openSync(path.dirname(file), 'r');
	try {
		fsyncSync(directoryHandle);
	} finally {
		closeSync(directoryHandle);
	}
}

function cleanupLocal(file) {
	if (file && existsSync(file)) unlinkSync(file);
}

export async function runAuthorizedStoragePreflight({
	basisPath,
	outputPath,
	repo = REPO,
	mode,
	dependencies = {}
}) {
	assert(mode === 'execute', 'explicit --mode execute is required');
	const validated = validateAuthorizationBasis({ basisPath, outputPath, repo });
	const { basis, policy, storage } = validated;
	const verifyFullAuthorization =
		dependencies.verifyAuthorizationBasis ??
		(async ({ basisPath: resolvedBasisPath, repo: resolvedRepo }) => {
			const lockModule = await import('./v34-b1-smoke-lock.mjs');
			return lockModule.verifyV34B1SmokeAuthorizationBasis({
				basisPath: resolvedBasisPath,
				repoRoot: resolvedRepo,
				requireFuturePathsAbsent: true
			});
		});
	const fullyVerifiedBasis = await verifyFullAuthorization({
		basisPath: validated.basisPath,
		repo: validated.repo,
		expectedBasis: basis
	});
	assert(
		same(canonicalize(fullyVerifiedBasis), canonicalize(basis)),
		'full authorization-basis verifier returned a different basis'
	);
	assertBasisUnchanged(validated);
	const execAws = dependencies.execFile ?? defaultExec;
	const makeBytes = dependencies.randomBytes ?? randomBytes;
	const makeUuid = dependencies.randomUUID ?? randomUUID;
	const measureFreeBytes = dependencies.measureFreeBytes ?? freeBytesDevShm;
	const sleep =
		dependencies.sleep ??
		((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
	const now = dependencies.now ?? (() => new Date());
	const monotonic = dependencies.monotonic ?? (() => performance.now());
	const started = monotonic();
	const commands = [];
	const attemptRoot = path.resolve(policy.attemptRoot);
	const sourcePath = path.join(attemptRoot, 'probe-source.bin');
	const downloadPath = path.join(attemptRoot, 'probe-download.bin');
	const uuid = makeUuid();
	assert(UUID_V4_PATTERN.test(uuid), 'random UUID generator returned an invalid v4 value');
	const probeKey = `${basis.derivedStoragePrefix}${policy.probeKeySegment}/${uuid}.bin`;
	const requiredScratchBytes = Math.ceil(policy.projectedSmokePeakBytes * policy.scratchMultiplier);
	let freeBytesBefore = null;
	let freeBytesAfter = null;
	let sourceRecord = null;
	let downloadRecord = null;
	let attemptCreated = false;
	let putAttempted = false;
	let uploaded = false;
	let deleted = false;
	let postDeleteAbsent = false;
	let uploadDurationMs = null;
	let downloadDurationMs = null;
	let failure = null;
	const checks = {
		localCreate: false,
		upload: false,
		metadataRead: false,
		downloadHash: false,
		delete: false,
		postDeleteAbsence: false,
		localCleanup: false
	};

	const baseArgs = [
		'--no-cli-pager',
		'--profile',
		storage.profile,
		'--region',
		storage.region,
		's3api'
	];
	const invoke = async (operation, args) => {
		const result = await execAws(policy.awsExecutable, args);
		assert(
			result &&
				same(Object.keys(result).sort(), ['durationMs', 'exitCode', 'stderr', 'stdout']) &&
				Number.isInteger(result.exitCode) &&
				result.exitCode >= 0 &&
				Buffer.isBuffer(result.stdout) &&
				Buffer.isBuffer(result.stderr) &&
				typeof result.durationMs === 'number' &&
				Number.isFinite(result.durationMs) &&
				result.durationMs >= 0,
			`${operation} executor returned an invalid result`
		);
		commands.push(commandRecord(operation, policy.awsExecutable, args, result));
		return result;
	};
	const headArgs = [...baseArgs, 'head-object', '--bucket', storage.bucket, '--key', probeKey];
	const deleteAndVerify = async () => {
		if (putAttempted && !deleted) {
			const deletion = await invoke('delete-object', [
				...baseArgs,
				'delete-object',
				'--bucket',
				storage.bucket,
				'--key',
				probeKey
			]);
			if (deletion.exitCode !== 0)
				throw new Error('V34 B1 storage preflight: delete-object failed');
			deleted = true;
			checks.delete = true;
		}
		if (!putAttempted) return;
		for (let attempt = 1; attempt <= policy.postDeleteHeadAttempts; attempt += 1) {
			const result = await invoke(`post-delete-head-object-${attempt}`, headArgs);
			if (absentHeadResult(result)) {
				postDeleteAbsent = true;
				checks.postDeleteAbsence = true;
				return;
			}
			if (result.exitCode !== 0) {
				throw new Error(
					'V34 B1 storage preflight: post-delete head-object failed without NotFound evidence'
				);
			}
			if (attempt < policy.postDeleteHeadAttempts && policy.postDeleteDelayMs > 0) {
				await sleep(policy.postDeleteDelayMs);
			}
		}
		throw new Error('V34 B1 storage preflight: probe object still exists after delete');
	};

	try {
		freeBytesBefore = measureFreeBytes();
		assert(
			Number.isSafeInteger(freeBytesBefore) && freeBytesBefore >= 0,
			'/dev/shm free-byte measurement is invalid'
		);
		assert(
			freeBytesBefore >= requiredScratchBytes,
			'/dev/shm has less than twice the projected smoke peak'
		);
		mkdirSync(attemptRoot, { recursive: false, mode: 0o700 });
		attemptCreated = true;
		const generatedProbe = makeBytes(policy.probeBytes);
		assert(
			Buffer.isBuffer(generatedProbe) && generatedProbe.length === policy.probeBytes,
			'random probe generator returned invalid bytes'
		);
		writeFileSync(sourcePath, generatedProbe, { flag: 'wx', mode: 0o600 });
		sourceRecord = recordFile(sourcePath);
		assert(sourceRecord.bytes === policy.probeBytes, 'local random probe byte count changed');
		checks.localCreate = true;

		const putArgs = [
			...baseArgs,
			'put-object',
			'--bucket',
			storage.bucket,
			'--key',
			probeKey,
			'--body',
			sourcePath,
			'--metadata',
			`${policy.metadataKey}=${sourceRecord.sha256}`,
			'--checksum-algorithm',
			'SHA256',
			'--if-none-match',
			'*'
		];
		assertBasisUnchanged(validated);
		putAttempted = true;
		const put = await invoke('put-object', putArgs);
		uploadDurationMs = put.durationMs;
		if (putPreconditionFailed(put)) putAttempted = false;
		assert(put.exitCode === 0, 'put-object failed');
		uploaded = true;
		checks.upload = true;

		const head = await invoke('head-object', headArgs);
		assert(head.exitCode === 0, 'head-object failed');
		const headJson = parseJsonOutput(head, 'head-object');
		assert(
			Number.isSafeInteger(headJson.ContentLength) && headJson.ContentLength === sourceRecord.bytes,
			'head-object byte count changed'
		);
		assert(
			headJson.Metadata?.[policy.metadataKey] === sourceRecord.sha256,
			'head-object SHA-256 metadata changed'
		);
		checks.metadataRead = true;

		const getArgs = [
			...baseArgs,
			'get-object',
			'--bucket',
			storage.bucket,
			'--key',
			probeKey,
			downloadPath
		];
		const get = await invoke('get-object', getArgs);
		downloadDurationMs = get.durationMs;
		assert(get.exitCode === 0, 'get-object failed');
		downloadRecord = recordFile(downloadPath);
		assert(
			downloadRecord.bytes === sourceRecord.bytes && downloadRecord.sha256 === sourceRecord.sha256,
			'downloaded probe bytes or SHA-256 changed'
		);
		checks.downloadHash = true;
		await deleteAndVerify();
	} catch (error) {
		failure = safeFailure(error);
		if (putAttempted && (!deleted || !postDeleteAbsent)) {
			try {
				await deleteAndVerify();
			} catch (cleanupError) {
				failure = {
					code: 'preflight-check-and-remote-cleanup-failed',
					message: `${failure.message}; ${safeFailure(cleanupError).message}`
				};
			}
		}
	} finally {
		try {
			if (attemptCreated) {
				cleanupLocal(downloadPath);
				cleanupLocal(sourcePath);
				if (existsSync(attemptRoot)) rmdirSync(attemptRoot);
			}
			checks.localCleanup = true;
		} catch (cleanupError) {
			failure = combineFailure(failure, safeFailure(cleanupError), 'local-cleanup-failed');
		}
		try {
			freeBytesAfter = measureFreeBytes();
			assert(
				Number.isSafeInteger(freeBytesAfter) && freeBytesAfter >= 0,
				'/dev/shm postflight free-byte measurement is invalid'
			);
		} catch (scratchError) {
			freeBytesAfter = null;
			failure = combineFailure(failure, safeFailure(scratchError), 'scratch-postflight-failed');
		}
	}

	try {
		assertBasisUnchanged(validated);
	} catch (basisError) {
		failure = combineFailure(failure, safeFailure(basisError), 'authorization-basis-changed');
	}
	const rate = (milliseconds) =>
		milliseconds === null || milliseconds <= 0 ? null : (policy.probeBytes * 1000) / milliseconds;
	const uploadBytesPerSecond = rate(uploadDurationMs);
	const downloadBytesPerSecond = rate(downloadDurationMs);
	const totalRuntimeMs = Math.max(0, monotonic() - started);
	const throughputValid =
		typeof uploadBytesPerSecond === 'number' &&
		Number.isFinite(uploadBytesPerSecond) &&
		uploadBytesPerSecond > 0 &&
		typeof downloadBytesPerSecond === 'number' &&
		Number.isFinite(downloadBytesPerSecond) &&
		downloadBytesPerSecond > 0 &&
		Number.isFinite(totalRuntimeMs);
	if (failure === null && !throughputValid) {
		failure = {
			code: 'invalid-throughput-evidence',
			message: 'V34 B1 storage preflight: throughput evidence is invalid'
		};
	}
	const passed =
		failure === null &&
		Object.values(checks).every(Boolean) &&
		uploaded &&
		deleted &&
		postDeleteAbsent &&
		throughputValid;
	const report = {
		schemaVersion: REPORT_SCHEMA,
		authorizationBasis: canonicalize(basis.authorizationBasis),
		authorizationBasisSha256: basis.authorizationBasisSha256,
		authorizationBasisFile: { ...validated.basisFileRecord },
		derivedStoragePrefix: basis.derivedStoragePrefix,
		storage: {
			kind: storage.kind,
			bucket: storage.bucket,
			region: storage.region,
			profile: storage.profile,
			prefix: basis.derivedStoragePrefix,
			probeKey
		},
		probe: {
			bytes: policy.probeBytes,
			metadataKey: policy.metadataKey,
			source: sourceRecord,
			download: downloadRecord,
			checks
		},
		scratch: {
			filesystem: '/dev/shm',
			freeBytesBefore,
			requiredBytes: requiredScratchBytes,
			projectedSmokePeakBytes: policy.projectedSmokePeakBytes,
			multiplier: policy.scratchMultiplier,
			freeBytesAfter
		},
		commands,
		throughput: {
			uploadBytesPerSecond,
			downloadBytesPerSecond,
			totalRuntimeMs
		},
		flags: { ...basis.flags },
		passed,
		failure: passed
			? null
			: (failure ?? {
					code: 'incomplete-preflight',
					message: 'V34 B1 storage preflight: one or more required checks did not complete'
				}),
		recordedAt: now().toISOString()
	};
	publishNewOnly(validated.outputPath, report);
	return report;
}

export function parseCli(argv) {
	const parsed = parseArgs({
		args: argv,
		allowPositionals: false,
		strict: true,
		options: {
			mode: { type: 'string' },
			basis: { type: 'string' },
			out: { type: 'string' }
		}
	});
	assert(parsed.values.mode === 'execute', 'explicit --mode execute is required');
	assert(typeof parsed.values.basis === 'string' && parsed.values.basis, '--basis is required');
	assert(typeof parsed.values.out === 'string' && parsed.values.out, '--out is required');
	return parsed.values;
}

export async function main(argv = process.argv.slice(2)) {
	const args = parseCli(argv);
	const report = await runAuthorizedStoragePreflight({
		basisPath: args.basis,
		outputPath: args.out,
		mode: args.mode,
		repo: REPO
	});
	console.log(JSON.stringify(report, null, 2));
	if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void main().catch((error) => {
		console.error(safeFailure(error).message);
		process.exitCode = 1;
	});
}
