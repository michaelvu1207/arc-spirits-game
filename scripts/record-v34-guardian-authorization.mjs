#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
	if (!condition) throw new Error(`V34 guardian authorization: ${message}`);
};
const exactKeys = (value, expected, label) => {
	assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
	assert(
		same(Object.keys(value).sort(), [...expected].sort()),
		`${label} keys changed (found ${Object.keys(value).sort().join(',')})`
	);
	return value;
};
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
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
const verifyRef = (ref, repo, label) => {
	exactKeys(ref, ['path', 'sha256'], label);
	assert(
		typeof ref.path === 'string' && /^[0-9a-f]{64}$/.test(ref.sha256 ?? ''),
		`${label} is malformed`
	);
	const file = resolvePath(ref.path, repo);
	assert(existsSync(file) && sha256(file) === ref.sha256, `${label} file/hash mismatch`);
	return file;
};
const verifyFileRecord = (record, repo, label) => {
	exactKeys(record, ['path', 'bytes', 'sha256'], label);
	const file = resolvePath(record.path, repo);
	assert(
		existsSync(file) &&
			Number.isSafeInteger(record.bytes) &&
			record.bytes >= 0 &&
			readFileSync(file).length === record.bytes &&
			/^[0-9a-f]{64}$/.test(record.sha256 ?? '') &&
			sha256(file) === record.sha256,
		`${label} file/hash/size mismatch`
	);
	return file;
};

function verifyStrengthLock(lockPath, protocol, repo) {
	const expected = protocol.base.strengthToolingLock;
	assert(
		path.resolve(lockPath) === resolvePath(expected.path, repo) &&
			readFileSync(lockPath).length === expected.bytes &&
			sha256(lockPath) === expected.sha256,
		'strength lock differs from guardian protocol'
	);
	const lock = readJson(lockPath);
	assert(
		lock.schemaVersion === 'arc-v34-strength-tooling-lock-v1',
		'strength lock schema mismatch'
	);
	assert(
		lock.implementationCommit === protocol.base.sourceCommit,
		'strength lock source commit mismatch'
	);
	assert(
		lock.authorization?.guardianSeedsOpen === false,
		'historical strength lock unexpectedly opened guardian seeds'
	);
	assert(
		lock.files && typeof lock.files === 'object' && Object.keys(lock.files).length > 0,
		'strength lock inventory missing'
	);
	for (const [raw, expectedHash] of Object.entries(lock.files)) {
		const file = resolvePath(raw, repo);
		assert(
			existsSync(file) && sha256(file) === expectedHash,
			`strength lock source mismatch: ${raw}`
		);
	}
	return lock;
}

function verifyAnalysisInputs(analysis, strengthLockPath, repo) {
	const inputs = exactKeys(
		analysis.inputs,
		[
			'baseProtocol',
			'originalSourceLock',
			'strengthProtocol',
			'systemsAuthorization',
			'systemsEligibility',
			'phase2Authorization',
			'strengthToolingLock',
			'strengthPreflight',
			'conditions'
		],
		'Phase 2 analysis inputs'
	);
	for (const name of [
		'baseProtocol',
		'originalSourceLock',
		'strengthProtocol',
		'systemsAuthorization',
		'systemsEligibility',
		'phase2Authorization',
		'strengthToolingLock',
		'strengthPreflight'
	]) {
		const file = verifyRef(inputs[name], repo, `Phase 2 ${name}`);
		if (name === 'strengthToolingLock') {
			assert(
				file === path.resolve(strengthLockPath),
				'Phase 2 analysis names a different strength lock'
			);
		}
	}
	assert(
		Array.isArray(inputs.conditions) && inputs.conditions.length > 0,
		'Phase 2 conditions are missing'
	);
	for (const [index, row] of inputs.conditions.entries()) {
		exactKeys(row, ['arm', 'manifest', 'report'], `Phase 2 condition ${index}`);
		assert(typeof row.arm === 'string' && row.arm, `Phase 2 condition ${index} arm is invalid`);
		verifyRef(row.manifest, repo, `Phase 2 condition ${row.arm} manifest`);
		verifyRef(row.report, repo, `Phase 2 condition ${row.arm} report`);
	}
}

export function deriveGuardianAuthorization({
	repo,
	guardianProtocolPath,
	strengthLockPath,
	phase2AnalysisPath,
	createdAt
}) {
	repo = path.resolve(repo);
	guardianProtocolPath = path.resolve(guardianProtocolPath);
	strengthLockPath = path.resolve(strengthLockPath);
	phase2AnalysisPath = path.resolve(phase2AnalysisPath);
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
		protocol.authoritativeStateArtifacts
			?.historicalStrengthProtocolFlagsAreNotCurrentAuthorization === true,
		'guardian authoritative-state rule is missing'
	);
	const strengthLock = verifyStrengthLock(strengthLockPath, protocol, repo);
	const analysis = readJson(phase2AnalysisPath);
	assert(
		analysis.schemaVersion === 'arc-v34-phase2-analysis-v1' &&
			analysis.valid === true &&
			analysis.promotionEligible === false &&
			analysis.strengthUse === true,
		'Phase 2 analysis header is invalid'
	);
	verifyAnalysisInputs(analysis, strengthLockPath, repo);

	const registered = protocol.guardian.registeredCandidateSlots;
	const contract = analysis.contract;
	assert(
		contract &&
			same(contract.registeredCandidateSlots, registered) &&
			Array.isArray(contract.systemsEligibleArms) &&
			contract.systemsEligibleArms.every((arm) => registered.includes(arm)) &&
			contract.systemsEligibleArms.length === new Set(contract.systemsEligibleArms).size,
		'Phase 2 arm contract differs from guardian protocol'
	);
	const registeredOrder = new Map(registered.map((arm, index) => [arm, index]));
	const inRegisteredOrder = (arms) =>
		arms.every(
			(arm, index) => index === 0 || registeredOrder.get(arms[index - 1]) < registeredOrder.get(arm)
		);
	assert(
		inRegisteredOrder(contract.systemsEligibleArms),
		'systems-eligible arms are not in registered order'
	);
	assert(
		Array.isArray(analysis.arms) && analysis.arms.length === registered.length,
		'Phase 2 arm rows are incomplete'
	);
	assert(
		same(
			analysis.arms.map((row) => row.arm),
			registered
		),
		'Phase 2 arm row order changed'
	);

	const derivedPassing = [];
	const rankingInputs = new Map();
	for (const row of analysis.arms) {
		assert(typeof row.corePass === 'boolean', `${row.arm}: corePass is not boolean`);
		if (!row.corePass) continue;
		assert(
			row.systemsEligible === true &&
				row.reportComplete === true &&
				row.failedRegisteredSlot === false &&
				row.rejectionReason === null &&
				row.gates &&
				Object.values(row.gates).every((value) => value === true),
			`${row.arm}: core pass contradicts its required gates`
		);
		const winGain = row.endpoints?.winPoints?.mean;
		const bindingW8 = row.bindingDecisionWallMsP95?.['binding-w8'];
		assert(finite(winGain) && finite(bindingW8), `${row.arm}: ranking inputs are missing`);
		derivedPassing.push(row.arm);
		rankingInputs.set(row.arm, { winGain, bindingW8 });
	}
	assert(
		Array.isArray(analysis.corePassingArms) && same(analysis.corePassingArms, derivedPassing),
		'Phase 2 core-passing list cannot be reconstructed'
	);
	assert(inRegisteredOrder(derivedPassing), 'core-passing arms are not in registered order');
	const decision = analysis.decision;
	assert(
		decision &&
			decision.guardianAuthorizationMayOpen === derivedPassing.length > 0 &&
			same(decision.guardianAuthorizationMustNameExactly, derivedPassing) &&
			decision.winnerSelected === false &&
			decision.guardianSeedsOpen === false &&
			decision.teacherSeedsOpen === false &&
			decision.finalDevelopmentSeedsOpen === false &&
			decision.hiddenSeedsOpen === false &&
			decision.multiplayerSeedsOpen === false &&
			decision.humanReferenceSeedsOpen === false &&
			decision.productionPromotionOpen === false,
		'Phase 2 decision does not authorize the derived guardian arm set'
	);
	const ranked = [...derivedPassing].sort((left, right) => {
		const a = rankingInputs.get(left);
		const b = rankingInputs.get(right);
		if (a.winGain !== b.winGain) return b.winGain - a.winGain;
		if (a.bindingW8 !== b.bindingW8) return a.bindingW8 - b.bindingW8;
		return left < right ? -1 : left > right ? 1 : 0;
	});
	const opens = derivedPassing.length > 0;
	assert(
		typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt)),
		'createdAt is invalid'
	);
	return {
		schemaVersion: 'arc-v34-guardian-authorization-v1',
		authoritative: true,
		strengthProtocolHistoricalGuardianFlagsIgnored: true,
		phase2Analysis: fileRecord(phase2AnalysisPath, repo),
		strengthToolingLock: fileRecord(strengthLockPath, repo),
		registeredCandidateSlots: [...registered],
		systemsEligibleArms: [...contract.systemsEligibleArms],
		corePassingArms: [...derivedPassing],
		authorizedArms: [...derivedPassing],
		phase2RankedArms: ranked,
		phase2Leader: ranked[0] ?? null,
		laneAClosed: !opens,
		authorization: {
			guardianSeedsOpen: opens,
			teacherSeedsOpen: false,
			finalDevelopmentSeedsOpen: false,
			hiddenSeedsOpen: false,
			multiplayerSeedsOpen: false,
			humanReferenceSeedsOpen: false,
			productionPromotionOpen: false
		},
		sourceCommit: strengthLock.implementationCommit,
		createdAt
	};
}

function writeImmutable(out, value) {
	const sidecar = `${out}.sha256`;
	assert(!existsSync(out) && !existsSync(sidecar), `refusing to overwrite ${out}`);
	writeFileSync(out, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
	try {
		writeFileSync(sidecar, `${sha256(out)}  ${path.basename(out)}\n`, { flag: 'wx', mode: 0o444 });
	} catch (error) {
		throw new Error(`authorization written but sidecar creation failed: ${error.message}`);
	}
	chmodSync(out, 0o444);
	chmodSync(sidecar, 0o444);
}

function verifyExisting(file, expected) {
	const actual = readJson(file);
	assert(same(actual, expected), 'authorization content cannot be reconstructed exactly');
	const sidecar = `${file}.sha256`;
	assert(
		existsSync(sidecar) &&
			readFileSync(sidecar, 'utf8').trim() === `${sha256(file)}  ${path.basename(file)}`,
		'authorization SHA-256 sidecar is missing or invalid'
	);
}

function main() {
	const { values: args, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			repo: { type: 'string', default: defaultRoot },
			'guardian-protocol': { type: 'string', default: DEFAULT_PROTOCOL },
			'strength-lock': { type: 'string' },
			'phase2-analysis': { type: 'string' },
			out: { type: 'string' },
			manifest: { type: 'string' },
			'created-at': { type: 'string' }
		}
	});
	const repo = path.resolve(args.repo);
	const protocolPath = resolvePath(args['guardian-protocol'], repo);
	const protocol = readJson(protocolPath);
	const strengthLockPath = resolvePath(
		args['strength-lock'] ?? protocol.base.strengthToolingLock.path,
		repo
	);
	const analysisPath = resolvePath(
		args['phase2-analysis'] ?? protocol.authoritativeStateArtifacts.phase2Analysis,
		repo
	);
	const command = positionals[0] ?? 'record';
	if (command !== 'record' && command !== 'verify') {
		throw new Error('usage: record-v34-guardian-authorization.mjs record|verify [options]');
	}
	const manifest = command === 'verify' ? args.manifest : args.out;
	assert(manifest, command === 'verify' ? '--manifest is required' : '--out is required');
	const manifestPath = resolvePath(manifest, repo);
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
	const existingCreatedAt =
		command === 'verify'
			? readJson(manifestPath).createdAt
			: (args['created-at'] ?? new Date().toISOString());
	const value = deriveGuardianAuthorization({
		repo,
		guardianProtocolPath: protocolPath,
		strengthLockPath,
		phase2AnalysisPath: analysisPath,
		createdAt: existingCreatedAt
	});
	if (command === 'verify') verifyExisting(manifestPath, value);
	else writeImmutable(manifestPath, value);
	console.log(JSON.stringify(value, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
