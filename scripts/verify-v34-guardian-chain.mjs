#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPERIMENT = 'ml/experiments/v34-latency-first-expert-iteration';
const DEFAULT_PROTOCOL = `${EXPERIMENT}/guardian-execution-protocol.json`;
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const assert = (condition, message) => {
	if (!condition) throw new Error(`V34 guardian chain: ${message}`);
};
const resolvePath = (raw, repo) =>
	path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(repo, raw);
const runNode = (repo, script, argv) =>
	execFileSync(process.execPath, [resolvePath(script, repo), ...argv], {
		cwd: repo,
		stdio: 'ignore'
	});

const { values: args, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		repo: { type: 'string', default: defaultRoot },
		'guardian-protocol': { type: 'string', default: DEFAULT_PROTOCOL },
		preflight: { type: 'string' },
		'tooling-lock': { type: 'string' },
		authorization: { type: 'string' },
		'phase2-analysis': { type: 'string' },
		'execution-lock': { type: 'string' }
	}
});
const mode = positionals[0] ?? 'protocol';
assert(
	['protocol', 'tooling', 'authorization', 'execution'].includes(mode),
	'usage: verify-v34-guardian-chain.mjs protocol|tooling|authorization|execution [options]'
);
const repo = path.resolve(args.repo);
const protocolPath = resolvePath(args['guardian-protocol'], repo);
assert(existsSync(protocolPath), 'guardian protocol is missing');
const protocol = readJson(protocolPath);
assert(
	protocol.schemaVersion === 'arc-v34-guardian-execution-protocol-v1',
	'guardian protocol schema mismatch'
);
const state = protocol.authoritativeStateArtifacts;
assert(
	state?.historicalStrengthProtocolFlagsAreNotCurrentAuthorization === true,
	'new guardian artifacts are not declared authoritative'
);
const preflightPath = resolvePath(args.preflight ?? state.preflight, repo);
const toolingLockPath = resolvePath(args['tooling-lock'] ?? state.toolingLock, repo);
const authorizationPath = resolvePath(args.authorization ?? state.authorization, repo);
const phase2AnalysisPath = resolvePath(args['phase2-analysis'] ?? state.phase2Analysis, repo);
const executionLockPath = resolvePath(args['execution-lock'] ?? state.executionLock, repo);

runNode(repo, 'scripts/validate-v34-guardian-protocol.mjs', [
	'--repo',
	repo,
	'--protocol',
	protocolPath
]);
const historicalStrength = readJson(resolvePath(protocol.base.strengthProtocol.path, repo));
const historicalLock = readJson(resolvePath(protocol.base.strengthToolingLock.path, repo));
assert(
	historicalStrength.authorization?.guardianSeedsOpen === false &&
		historicalStrength.guardianResult === null &&
		historicalLock.authorization?.guardianSeedsOpen === false,
	'immutable historical guardian state changed'
);
if (mode === 'protocol') {
	console.log(
		JSON.stringify({
			schemaVersion: 'arc-v34-guardian-chain-verification-v1',
			mode,
			valid: true,
			currentAuthorizationSource: 'none',
			guardianSeedsOpen: false,
			historicalClosedFlagsRetained: true
		})
	);
	process.exit(0);
}

runNode(repo, 'scripts/lock-v34-guardian-tooling.mjs', [
	'verify',
	'--repo',
	repo,
	'--guardian-protocol',
	protocolPath,
	'--preflight',
	preflightPath,
	'--lock',
	toolingLockPath
]);
const toolingLock = readJson(toolingLockPath);
assert(
	toolingLock.authoritative === true &&
		toolingLock.authorization?.guardianSeedsOpen === false &&
		toolingLock.authorization?.guardianExecutionOpen === false &&
		Object.values(toolingLock.authorization).every((value) => value === false),
	'tooling lock opened a seed family'
);
if (mode === 'tooling') {
	console.log(
		JSON.stringify({
			schemaVersion: 'arc-v34-guardian-chain-verification-v1',
			mode,
			valid: true,
			implementationCommit: toolingLock.implementationCommit,
			currentAuthorizationSource: 'guardian-tooling-lock',
			guardianSeedsOpen: false,
			guardianExecutionOpen: false,
			historicalClosedFlagsRetained: true
		})
	);
	process.exit(0);
}

runNode(repo, 'scripts/record-v34-guardian-authorization.mjs', [
	'verify',
	'--repo',
	repo,
	'--guardian-protocol',
	protocolPath,
	'--phase2-analysis',
	phase2AnalysisPath,
	'--manifest',
	authorizationPath
]);
const authorization = readJson(authorizationPath);
assert(
	authorization.authoritative === true &&
		authorization.strengthProtocolHistoricalGuardianFlagsIgnored === true &&
		authorization.authorization?.guardianSeedsOpen === authorization.authorizedArms.length > 0 &&
		authorization.laneAClosed === (authorization.authorizedArms.length === 0) &&
		same(authorization.corePassingArms, authorization.authorizedArms),
	'guardian authorization state is inconsistent'
);
if (authorization.laneAClosed) {
	assert(mode === 'authorization', 'K=0 authorization cannot open an execution chain');
	assert(!existsSync(executionLockPath), 'K=0 closure has a forbidden execution lock');
	assert(
		!existsSync(resolvePath(state.conditionsRoot, repo)),
		'K=0 closure has guardian condition artifacts'
	);
}
if (mode === 'authorization') {
	console.log(
		JSON.stringify({
			schemaVersion: 'arc-v34-guardian-chain-verification-v1',
			mode,
			valid: true,
			currentAuthorizationSource: 'guardian-authorization',
			guardianSeedsOpen: authorization.authorization.guardianSeedsOpen,
			guardianExecutionOpen: false,
			laneAClosed: authorization.laneAClosed,
			authorizedArms: authorization.authorizedArms,
			phase2RankedArms: authorization.phase2RankedArms,
			historicalClosedFlagsRetained: true
		})
	);
	process.exit(0);
}

assert(authorization.authorizedArms.length > 0, 'execution requires K>0');
runNode(repo, 'scripts/lock-v34-guardian-execution.mjs', [
	'verify',
	'--repo',
	repo,
	'--guardian-protocol',
	protocolPath,
	'--tooling-lock',
	toolingLockPath,
	'--authorization',
	authorizationPath,
	'--phase2-analysis',
	phase2AnalysisPath,
	'--preflight',
	preflightPath,
	'--lock',
	executionLockPath
]);
const executionLock = readJson(executionLockPath);
assert(
	executionLock.authoritative === true &&
		executionLock.authorization?.guardianSeedsOpen === true &&
		executionLock.authorization?.guardianExecutionOpen === true &&
		Object.entries(executionLock.authorization).every(([key, value]) =>
			key === 'guardianSeedsOpen' || key === 'guardianExecutionOpen'
				? value === true
				: value === false
		) &&
		same(executionLock.authorizedArms, authorization.authorizedArms) &&
		same(executionLock.phase2RankedArms, authorization.phase2RankedArms),
	'guardian execution authorization is inconsistent'
);
console.log(
	JSON.stringify({
		schemaVersion: 'arc-v34-guardian-chain-verification-v1',
		mode,
		valid: true,
		currentAuthorizationSource: 'guardian-execution-lock',
		guardianSeedsOpen: true,
		guardianExecutionOpen: true,
		authorizedArms: executionLock.authorizedArms,
		phase2RankedArms: executionLock.phase2RankedArms,
		phase2Conditions: executionLock.phase2Conditions.map((row) => row.arm),
		executionLockSha256: sha256(executionLockPath),
		historicalClosedFlagsRetained: true
	})
);
