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
	if (!condition) throw new Error(`V34 guardian execution lock: ${message}`);
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
const verifyAnalysisRef = (ref, repo, label) => {
	assert(
		ref &&
			same(Object.keys(ref).sort(), ['path', 'sha256']) &&
			typeof ref.path === 'string' &&
			/^[0-9a-f]{64}$/.test(ref.sha256 ?? ''),
		`${label} reference is malformed`
	);
	const file = resolvePath(ref.path, repo);
	assert(existsSync(file) && sha256(file) === ref.sha256, `${label} file/hash mismatch`);
	return file;
};

export function buildGuardianExecutionLock({
	repo,
	guardianProtocolPath,
	toolingLockPath,
	authorizationPath,
	phase2AnalysisPath,
	preflightPath,
	createdAt
}) {
	repo = path.resolve(repo);
	for (const [label, file] of [
		['guardian protocol', guardianProtocolPath],
		['guardian tooling lock', toolingLockPath],
		['guardian authorization', authorizationPath],
		['Phase 2 analysis', phase2AnalysisPath],
		['guardian preflight', preflightPath]
	]) {
		assert(existsSync(file), `${label} is missing`);
	}
	assert(
		typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt)),
		'createdAt is invalid'
	);
	const protocol = readJson(guardianProtocolPath);
	const toolingLock = readJson(toolingLockPath);
	const authorization = readJson(authorizationPath);
	const analysis = readJson(phase2AnalysisPath);
	const preflight = readJson(preflightPath);
	assert(
		protocol.schemaVersion === 'arc-v34-guardian-execution-protocol-v1',
		'guardian protocol schema mismatch'
	);
	assert(
		toolingLock.schemaVersion === 'arc-v34-guardian-tooling-lock-v1' &&
			toolingLock.authoritative === true &&
			Object.values(toolingLock.authorization).every((value) => value === false),
		'guardian tooling lock is invalid or opens seeds'
	);
	assert(
		authorization.schemaVersion === 'arc-v34-guardian-authorization-v1' &&
			authorization.authoritative === true &&
			authorization.strengthProtocolHistoricalGuardianFlagsIgnored === true &&
			authorization.authorization?.guardianSeedsOpen === true &&
			authorization.laneAClosed === false &&
			Array.isArray(authorization.authorizedArms) &&
			authorization.authorizedArms.length > 0 &&
			same(authorization.corePassingArms, authorization.authorizedArms),
		'guardian authorization is not a non-empty execution authorization'
	);
	assert(
		analysis.schemaVersion === 'arc-v34-phase2-analysis-v1' &&
			analysis.valid === true &&
			same(analysis.corePassingArms, authorization.authorizedArms),
		'Phase 2 analysis/authorization arm set mismatch'
	);
	assert(
		preflight.schemaVersion === 'arc-v34-guardian-preflight-v1' &&
			preflight.phase === 'tooling' &&
			preflight.passed === true,
		'guardian tooling preflight is invalid'
	);
	assert(
		verifyRecord(toolingLock.guardianProtocol, repo, 'tooling lock guardian protocol') ===
			path.resolve(guardianProtocolPath),
		'tooling lock binds a different guardian protocol'
	);
	assert(
		verifyRecord(toolingLock.guardianPreflight, repo, 'tooling lock guardian preflight') ===
			path.resolve(preflightPath),
		'tooling lock binds a different guardian preflight'
	);
	assert(
		same(Object.keys(toolingLock.files).sort(), V34_GUARDIAN_TOOLING_FILES),
		'guardian tooling inventory changed'
	);
	for (const [raw, expectedHash] of Object.entries(toolingLock.files)) {
		assert(
			existsSync(resolvePath(raw, repo)) && sha256(resolvePath(raw, repo)) === expectedHash,
			`guardian tooling changed: ${raw}`
		);
	}
	assert(
		verifyRecord(authorization.phase2Analysis, repo, 'authorization Phase 2 analysis') ===
			path.resolve(phase2AnalysisPath),
		'authorization binds a different Phase 2 analysis'
	);
	assert(
		verifyRecord(authorization.strengthToolingLock, repo, 'authorization strength lock') ===
			verifyRecord(toolingLock.strengthToolingLock, repo, 'tooling strength lock'),
		'authorization/tooling strength-lock mismatch'
	);
	const expectedAnalysisRef = fileRecord(phase2AnalysisPath, repo);
	assert(
		same(authorization.phase2Analysis, expectedAnalysisRef),
		'authorization Phase 2 analysis record changed'
	);
	const conditionRefs = analysis.inputs?.conditions;
	assert(
		Array.isArray(conditionRefs) && conditionRefs.length > 0,
		'Phase 2 condition references are missing'
	);
	const expectedConditionOrder = ['raw', ...analysis.contract.systemsEligibleArms];
	assert(
		same(
			conditionRefs.map((row) => row.arm),
			expectedConditionOrder
		),
		'Phase 2 condition order changed'
	);
	const phase2Conditions = conditionRefs.map((row, index) => {
		assert(
			row && same(Object.keys(row).sort(), ['arm', 'manifest', 'report']),
			`Phase 2 condition ${index} reference is malformed`
		);
		const manifest = verifyAnalysisRef(row.manifest, repo, `Phase 2 ${row.arm} manifest`);
		verifyAnalysisRef(row.report, repo, `Phase 2 ${row.arm} report`);
		return { arm: row.arm, ...fileRecord(manifest, repo) };
	});
	assert(
		same(authorization.authorizedArms, authorization.corePassingArms) &&
			authorization.authorizedArms.every((arm) =>
				analysis.contract.systemsEligibleArms.includes(arm)
			) &&
			same([...authorization.phase2RankedArms].sort(), [...authorization.authorizedArms].sort()) &&
			authorization.phase2Leader === authorization.phase2RankedArms[0],
		'authorization ranking/set is invalid'
	);
	return {
		schemaVersion: 'arc-v34-guardian-execution-lock-v1',
		authoritative: true,
		implementationCommit: toolingLock.implementationCommit,
		guardianToolingLock: fileRecord(toolingLockPath, repo),
		guardianProtocol: fileRecord(guardianProtocolPath, repo),
		phase2Analysis: expectedAnalysisRef,
		guardianAuthorization: fileRecord(authorizationPath, repo),
		guardianPreflight: fileRecord(preflightPath, repo),
		phase2Conditions,
		authorizedArms: [...authorization.authorizedArms],
		phase2RankedArms: [...authorization.phase2RankedArms],
		sourceCommit: authorization.sourceCommit,
		environment: { ...toolingLock.environment },
		authorization: {
			guardianSeedsOpen: true,
			guardianExecutionOpen: true,
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

function assertGitState(repo, toolingLock) {
	if (!existsSync(path.join(repo, '.git'))) return;
	execFileSync('git', ['merge-base', '--is-ancestor', toolingLock.implementationCommit, 'HEAD'], {
		cwd: repo,
		stdio: 'ignore'
	});
	const status = execFileSync('git', ['status', '--short', '--', ...V34_GUARDIAN_TOOLING_FILES], {
		cwd: repo,
		encoding: 'utf8'
	}).trim();
	assert(status === '', `guardian tooling changed after the pre-outcome lock:\n${status}`);
}

function verifyExisting(lockPath, expected, repo) {
	const actual = readJson(lockPath);
	assert(same(actual, expected), 'execution lock cannot be reconstructed exactly');
	for (const name of [
		'guardianToolingLock',
		'guardianProtocol',
		'phase2Analysis',
		'guardianAuthorization',
		'guardianPreflight'
	])
		verifyRecord(actual[name], repo, `execution lock ${name}`);
	for (const row of actual.phase2Conditions) {
		assert(typeof row.arm === 'string' && row.arm, 'execution Phase 2 condition arm is invalid');
		verifyRecord(
			{ path: row.path, bytes: row.bytes, sha256: row.sha256 },
			repo,
			`execution Phase 2 ${row.arm}`
		);
	}
}

function main() {
	const { values: args, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			repo: { type: 'string', default: defaultRoot },
			'guardian-protocol': { type: 'string', default: DEFAULT_PROTOCOL },
			'tooling-lock': { type: 'string' },
			authorization: { type: 'string' },
			'phase2-analysis': { type: 'string' },
			preflight: { type: 'string' },
			'created-at': { type: 'string' },
			out: { type: 'string' },
			lock: { type: 'string' }
		}
	});
	const repo = path.resolve(args.repo);
	const command = positionals[0] ?? 'create';
	assert(
		command === 'create' || command === 'verify',
		'usage: lock-v34-guardian-execution.mjs create|verify [options]'
	);
	const protocolPath = resolvePath(args['guardian-protocol'], repo);
	const protocol = readJson(protocolPath);
	const toolingLockPath = resolvePath(
		args['tooling-lock'] ?? protocol.authoritativeStateArtifacts.toolingLock,
		repo
	);
	const authorizationPath = resolvePath(
		args.authorization ?? protocol.authoritativeStateArtifacts.authorization,
		repo
	);
	const analysisPath = resolvePath(
		args['phase2-analysis'] ?? protocol.authoritativeStateArtifacts.phase2Analysis,
		repo
	);
	const preflightPath = resolvePath(
		args.preflight ?? protocol.authoritativeStateArtifacts.preflight,
		repo
	);
	const lockPath = resolvePath(
		(command === 'verify' ? args.lock : args.out) ??
			protocol.authoritativeStateArtifacts.executionLock,
		repo
	);
	const existing = command === 'verify' ? readJson(lockPath) : null;
	const createdAt = args['created-at'] ?? existing?.createdAt ?? new Date().toISOString();
	if (command === 'create') {
		assert(
			!existsSync(resolvePath(protocol.authoritativeStateArtifacts.conditionsRoot, repo)),
			'guardian condition root already exists'
		);
		assertGitState(repo, readJson(toolingLockPath));
		execFileSync(
			process.execPath,
			[
				resolvePath('scripts/lock-v34-guardian-tooling.mjs', repo),
				'verify',
				'--repo',
				repo,
				'--guardian-protocol',
				protocolPath,
				'--preflight',
				preflightPath,
				'--lock',
				toolingLockPath
			],
			{ cwd: repo, stdio: 'ignore' }
		);
		execFileSync(
			process.execPath,
			[
				resolvePath('scripts/record-v34-guardian-authorization.mjs', repo),
				'verify',
				'--repo',
				repo,
				'--guardian-protocol',
				protocolPath,
				'--phase2-analysis',
				analysisPath,
				'--manifest',
				authorizationPath
			],
			{ cwd: repo, stdio: 'ignore' }
		);
	}
	const value = buildGuardianExecutionLock({
		repo,
		guardianProtocolPath: protocolPath,
		toolingLockPath,
		authorizationPath,
		phase2AnalysisPath: analysisPath,
		preflightPath,
		createdAt
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
