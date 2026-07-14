#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { V34_GUARDIAN_TOOLING_FILES } from './v34-guardian-tooling-files.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPERIMENT = 'ml/experiments/v34-latency-first-expert-iteration';
const DEFAULT_PROTOCOL = `${EXPERIMENT}/guardian-execution-protocol.json`;

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const assert = (condition, message) => {
	if (!condition) throw new Error(`V34 guardian tooling lock: ${message}`);
};
const resolvePath = (raw, repo) =>
	path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(repo, raw);
const repoLabel = (file, repo) => {
	const relative = path.relative(repo, path.resolve(file));
	return relative.startsWith('..') ? path.resolve(file) : relative;
};
const fileRecord = (file, repo) => ({
	path: repoLabel(file, repo),
	bytes: readFileSync(file).length,
	sha256: sha256(file)
});
const verifyRecord = (record, repo, label) => {
	assert(
		record &&
			same(Object.keys(record).sort(), ['bytes', 'path', 'sha256']) &&
			typeof record.path === 'string' &&
			Number.isSafeInteger(record.bytes) &&
			record.bytes >= 0 &&
			/^[0-9a-f]{64}$/.test(record.sha256 ?? ''),
		`${label} record is malformed`
	);
	const file = resolvePath(record.path, repo);
	assert(
		existsSync(file) &&
			readFileSync(file).length === record.bytes &&
			sha256(file) === record.sha256,
		`${label} file/hash/size mismatch`
	);
	return file;
};

function validatePreflight(preflightPath, protocolPath, repo) {
	const preflight = readJson(preflightPath);
	assert(
		preflight.schemaVersion === 'arc-v34-guardian-preflight-v1',
		'guardian preflight schema mismatch'
	);
	assert(
		preflight.phase === 'tooling' && preflight.passed === true,
		'guardian tooling preflight did not pass'
	);
	if (preflight.guardianProtocol) {
		const linked = verifyRecord(preflight.guardianProtocol, repo, 'preflight guardian protocol');
		assert(linked === path.resolve(protocolPath), 'preflight names a different guardian protocol');
	}
	if (preflight.authorization) {
		assert(
			preflight.authorization.guardianSeedsOpen !== true &&
				preflight.authorization.guardianExecutionOpen !== true,
			'pre-outcome guardian preflight unexpectedly opens execution'
		);
	}
	return preflight;
}

export function buildGuardianToolingLock({
	repo,
	guardianProtocolPath,
	preflightPath,
	implementationCommit,
	createdAt,
	requirePreOutcome = false
}) {
	repo = path.resolve(repo);
	guardianProtocolPath = path.resolve(guardianProtocolPath);
	preflightPath = path.resolve(preflightPath);
	assert(/^[0-9a-f]{40}$/.test(implementationCommit ?? ''), 'implementation commit is invalid');
	assert(
		typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt)),
		'createdAt is invalid'
	);
	const protocol = readJson(guardianProtocolPath);
	assert(
		protocol.schemaVersion === 'arc-v34-guardian-execution-protocol-v1',
		'guardian protocol schema mismatch'
	);
	assert(
		protocol.status === 'closed' && protocol.result === null,
		'guardian protocol is not closed'
	);
	assert(
		Object.values(protocol.authorization).every((value) => value === false),
		'guardian protocol opens seeds'
	);
	if (requirePreOutcome) {
		for (const name of ['phase2Analysis', 'authorization', 'executionLock']) {
			const artifact = resolvePath(protocol.authoritativeStateArtifacts[name], repo);
			assert(!existsSync(artifact), `${name} already exists; tooling lock must be pre-outcome`);
		}
	}
	for (const file of V34_GUARDIAN_TOOLING_FILES) {
		assert(existsSync(resolvePath(file, repo)), `missing guardian tooling source ${file}`);
	}
	validatePreflight(preflightPath, guardianProtocolPath, repo);
	for (const name of [
		'sourceLock',
		'strengthProtocol',
		'strengthToolingLock',
		'catalog',
		'checkpoint'
	]) {
		verifyRecord(protocol.base[name], repo, `guardian protocol ${name}`);
	}
	const strengthLock = readJson(resolvePath(protocol.base.strengthToolingLock.path, repo));
	assert(
		strengthLock.schemaVersion === 'arc-v34-strength-tooling-lock-v1' &&
			strengthLock.implementationCommit === protocol.base.sourceCommit &&
			strengthLock.authorization?.guardianSeedsOpen === false,
		'strength lock binding is invalid'
	);
	return {
		schemaVersion: 'arc-v34-guardian-tooling-lock-v1',
		authoritative: true,
		implementationCommit,
		baseSourceLock: fileRecord(resolvePath(protocol.base.sourceLock.path, repo), repo),
		strengthProtocol: fileRecord(resolvePath(protocol.base.strengthProtocol.path, repo), repo),
		strengthToolingLock: fileRecord(
			resolvePath(protocol.base.strengthToolingLock.path, repo),
			repo
		),
		guardianProtocol: fileRecord(guardianProtocolPath, repo),
		guardianPreflight: fileRecord(preflightPath, repo),
		files: Object.fromEntries(
			V34_GUARDIAN_TOOLING_FILES.map((file) => [file, sha256(resolvePath(file, repo))])
		),
		environment: {
			python: protocol.environment.python,
			numpy: protocol.environment.numpy,
			rng: protocol.environment.rng
		},
		authorization: {
			guardianSeedsOpen: false,
			guardianExecutionOpen: false,
			teacherSeedsOpen: false,
			finalDevelopmentSeedsOpen: false,
			hiddenSeedsOpen: false,
			multiplayerSeedsOpen: false,
			humanReferenceSeedsOpen: false,
			productionPromotionOpen: false
		},
		createdAt
	};
}

function assertGitState(repo, commit) {
	if (!existsSync(path.join(repo, '.git'))) return;
	const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
	assert(head === commit, 'implementation commit must equal current HEAD at lock creation');
	const status = execFileSync('git', ['status', '--short', '--', ...V34_GUARDIAN_TOOLING_FILES], {
		cwd: repo,
		encoding: 'utf8'
	}).trim();
	assert(status === '', `guardian tooling sources are not committed:\n${status}`);
}

function verifyExisting(lockPath, expected, repo) {
	const actual = readJson(lockPath);
	assert(same(actual, expected), 'tooling lock cannot be reconstructed exactly');
	assert(
		actual.schemaVersion === 'arc-v34-guardian-tooling-lock-v1' && actual.authoritative === true,
		'tooling lock header invalid'
	);
	for (const recordName of [
		'baseSourceLock',
		'strengthProtocol',
		'strengthToolingLock',
		'guardianProtocol',
		'guardianPreflight'
	]) {
		verifyRecord(actual[recordName], repo, `tooling lock ${recordName}`);
	}
	assert(
		same(Object.keys(actual.files).sort(), V34_GUARDIAN_TOOLING_FILES),
		'tooling inventory changed'
	);
	for (const [raw, expectedHash] of Object.entries(actual.files)) {
		assert(sha256(resolvePath(raw, repo)) === expectedHash, `tooling source changed: ${raw}`);
	}
}

function main() {
	const { values: args, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			repo: { type: 'string', default: defaultRoot },
			'guardian-protocol': { type: 'string', default: DEFAULT_PROTOCOL },
			preflight: { type: 'string' },
			'implementation-commit': { type: 'string' },
			'created-at': { type: 'string' },
			out: { type: 'string' },
			lock: { type: 'string' }
		}
	});
	const repo = path.resolve(args.repo);
	const command = positionals[0] ?? 'create';
	assert(
		command === 'create' || command === 'verify',
		'usage: lock-v34-guardian-tooling.mjs create|verify [options]'
	);
	const protocolPath = resolvePath(args['guardian-protocol'], repo);
	const protocol = readJson(protocolPath);
	const preflightPath = resolvePath(
		args.preflight ?? protocol.authoritativeStateArtifacts.preflight,
		repo
	);
	const lockPath = resolvePath(
		(command === 'verify' ? args.lock : args.out) ??
			protocol.authoritativeStateArtifacts.toolingLock,
		repo
	);
	const existing = command === 'verify' ? readJson(lockPath) : null;
	const implementationCommit = args['implementation-commit'] ?? existing?.implementationCommit;
	const createdAt = args['created-at'] ?? existing?.createdAt ?? new Date().toISOString();
	if (command === 'create') {
		assertGitState(repo, implementationCommit);
		execFileSync(
			process.execPath,
			[
				resolvePath('scripts/validate-v34-guardian-protocol.mjs', repo),
				'--repo',
				repo,
				'--protocol',
				protocolPath
			],
			{ cwd: repo, stdio: 'ignore' }
		);
	}
	const value = buildGuardianToolingLock({
		repo,
		guardianProtocolPath: protocolPath,
		preflightPath,
		implementationCommit,
		createdAt,
		requirePreOutcome: command === 'create'
	});
	if (command === 'verify') {
		verifyExisting(lockPath, value, repo);
	} else {
		assert(!existsSync(lockPath), `refusing to overwrite ${lockPath}`);
		writeFileSync(lockPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
		chmodSync(lockPath, 0o444);
	}
	console.log(JSON.stringify(value, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
