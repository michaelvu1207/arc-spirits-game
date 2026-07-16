#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);

const experiment = 'ml/experiments/v35-weco-recursive-autoresearch';
const proposal = `${experiment}/p30-long-horizon`;
const protocolPath = `${proposal}/protocol.proposed.json`;
const basePath = 'ml/league/configs/fair-v35-late-credit-base.json';
const outFlag = process.argv.indexOf('--out-root');
const outputRoot =
	outFlag >= 0 && process.argv[outFlag + 1]
		? path.resolve(process.argv[outFlag + 1])
		: path.resolve(`${proposal}/proposal`);

const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashFile = (file) => hashBytes(readFileSync(file));
const requireCondition = (condition, message) => {
	if (!condition) throw new Error(message);
};
const intervalsOverlap = (left, right) => left.start <= right.end && right.start <= left.end;
const replaceExtraArg = (args, name, value) => {
	const at = args.lastIndexOf(name);
	requireCondition(at >= 0 && at + 1 < args.length, `missing base argument ${name}`);
	args[at + 1] = String(value);
};

requireCondition(outFlag < 0 || Boolean(process.argv[outFlag + 1]), '--out-root requires a path');
const protocolBytes = readFileSync(protocolPath);
const protocol = JSON.parse(protocolBytes);
const base = JSON.parse(readFileSync(basePath, 'utf8'));
requireCondition(
	protocol.schemaVersion === 'arc-v35-p30-long-horizon-protocol-v1',
	'wrong proposal schema'
);
requireCondition(protocol.status === 'proposed-review-pending', 'proposal status drifted');
requireCondition(protocol.authorized === false, 'proposal must not be authorized');
requireCondition(protocol.promotionEligible === false, 'proposal must not be promotion eligible');
requireCondition(protocol.review.artifact === null, 'proposal unexpectedly has a review artifact');
requireCondition(protocol.review.sha256 === null, 'proposal unexpectedly has a review hash');
requireCondition(protocol.review.verdict === null, 'proposal unexpectedly has a review verdict');
requireCondition(
	protocol.review.commandReceipt?.path === null && protocol.review.commandReceipt?.sha256 === null,
	'proposal unexpectedly has a Fable command receipt'
);
requireCondition(protocol.sourceContract.artifact === null, 'proposal unexpectedly has a source contract');
requireCondition(protocol.sourceContract.sha256 === null, 'proposal unexpectedly has a source-contract hash');
requireCondition(
	JSON.stringify(protocol.recoveryPolicy) ===
		JSON.stringify({
			schemaVersion: 'arc-v35-p30-bounded-recovery-policy-v1',
			maximumRecoveriesPerLogicalAction: 1,
			classes: ['PRE_CHILD', 'RECEIPT_ONLY'],
			eligibleKinds: ['generation', 'evaluation-primary', 'evaluation-replay'],
			preChildRequiresNoChildStart: true,
			preChildRequiresNoSeedConsumption: true,
			receiptOnlyForbidsCandidateRerun: true,
			guardianClassificationRequired: true,
			secondRecoveryClosesCampaign: true,
			outcomeExposureClosesCampaign: true
		}),
	'proposal bounded recovery policy changed'
);
requireCondition(
	protocol.executionTrust?.schemaVersion === 'arc-v35-p30-role-trust-v2' &&
		protocol.executionTrust?.algorithm === 'Ed25519' &&
		protocol.executionTrust?.campaignInstanceId === null &&
		Object.keys(protocol.executionTrust?.roles ?? {}).sort().join(',') ===
			'analysis-authorizer,executor,guardian,issuer,review-attester' &&
		Object.values(protocol.executionTrust.roles).every(
			(role) =>
				role.publicKeyPath === null &&
				role.publicKeyPemSha256 === null &&
				role.publicKeyDerSha256 === null &&
				role.keyId === null
		) &&
		protocol.executionTrust?.custody?.schedulerPrivateKeyAccess === false &&
		JSON.stringify(protocol.executionTrust?.custody?.localOnlyRoles) ===
			JSON.stringify(['review-attester']) &&
		protocol.executionTrust?.reviewRuntime?.attesterRole === 'review-attester' &&
		protocol.executionTrust?.reviewRuntime?.privateKeyRemoteDelivery === false &&
		protocol.executionTrust?.bubblewrapSha256 === null,
	'proposal unexpectedly has a runnable execution trust root'
);
requireCondition(
	protocol.sourceContract.schemaVersion === 'arc-v35-p30-source-lock-v1',
	'proposal source-contract schema changed'
);
requireCondition(
	protocol.powerCalibration.schemaVersion === 'arc-v35-p30-power-calibration-v1' &&
		protocol.powerCalibration.claim === 'primary-efficacy-eligibility-power-only' &&
		protocol.powerCalibration.replicates === 18 &&
		protocol.powerCalibration.adequateForPrimaryEfficacy === true &&
		protocol.powerCalibration.minimumJointPrimaryEligibilityPower === 0.8 &&
		protocol.powerCalibration.fullSelectorPowerClaimed === false,
	'proposal power calibration changed or is inadequate'
);
requireCondition(
	hashFile(protocol.powerCalibration.path) === protocol.powerCalibration.sha256,
	'proposal power calibration hash mismatch'
);
requireCondition(
	protocol.confirmationGates?.schemaVersion ===
			'arc-v35-superhuman-confirmation-gates-v1' &&
		protocol.confirmationGates?.frozenBeforeP30Outcomes === true &&
		hashFile(protocol.confirmationGates.path) === protocol.confirmationGates.sha256,
	'proposal confirmation gates changed or are hash-invalid'
);
requireCondition(
	protocol.sourceRegistry?.schemaVersion === 'arc-v35-p30-source-registry-v1' &&
	hashFile(protocol.sourceRegistry.path) === protocol.sourceRegistry.sha256 &&
	JSON.parse(readFileSync(protocol.sourceRegistry.path, 'utf8')).files.length ===
		protocol.sourceRegistry.files,
	'proposal source registry changed or is hash-invalid'
);
requireCondition(protocol.replicates.length === 18, 'proposal requires exactly eighteen replicates');
requireCondition(protocol.arms.length === 3, 'proposal requires exactly three arms');
requireCondition(hashFile(protocol.catalog.path) === protocol.catalog.sha256, 'catalog hash mismatch');
requireCondition(
	hashFile(protocol.seedEvidence.inventoryPath) === protocol.seedEvidence.inventorySha256,
	'seed inventory hash mismatch'
);
requireCondition(hashFile(basePath) === 'c2c0fd7637f27dbc6afdee4adbef48a57b83c19d2c60ebf351f165f506bfb52e', 'base config hash mismatch');

const inventory = JSON.parse(readFileSync(protocol.seedEvidence.inventoryPath, 'utf8'));
requireCondition(inventory.valid === true, 'seed inventory is not valid');
requireCondition(
	Array.isArray(inventory.unprovableNamespaces),
	'seed inventory unprovable namespaces are missing'
);
requireCondition(
	inventory.claim === protocol.seedEvidence.claim,
	'seed inventory claim changed'
);
requireCondition(
	inventory.globalCompletenessProven === protocol.seedEvidence.globalCompletenessProven,
	'seed inventory completeness claim changed'
);
const container = inventory.proposalChecks.find(
	(item) => item.id === protocol.seedEvidence.publicContainer.id
);
requireCondition(Boolean(container), 'reserved public container is missing');
requireCondition(
	container.start === protocol.seedEvidence.publicContainer.start &&
		container.end === protocol.seedEvidence.publicContainer.end &&
		container.disjointFromDeclaredStructuredRanges === true,
	'reserved public container changed or overlaps a declared range'
);

const boundedUnprovableNamespaces = inventory.unprovableNamespaces.flatMap((namespace) => {
	requireCondition(
		namespace && typeof namespace === 'object' && typeof namespace.id === 'string' && namespace.id.length > 0,
		'seed inventory contains an invalid unprovable namespace'
	);
	if (namespace.bounds === null) return [];
	requireCondition(
		namespace.bounds && typeof namespace.bounds === 'object',
		`unprovable namespace ${namespace.id} has invalid bounds`
	);
	const bounded = {
		id: namespace.id,
		start: namespace.bounds.start,
		end: namespace.bounds.end
	};
	requireCondition(
		Number.isSafeInteger(bounded.start) && Number.isSafeInteger(bounded.end),
		`unprovable namespace ${namespace.id} has unsafe bounds`
	);
	requireCondition(
		bounded.start >= 0 && bounded.end >= bounded.start,
		`unprovable namespace ${namespace.id} has invalid bounds`
	);
	return [bounded];
});

const schedule = protocol.seedSchedule;
const intervals = [];
for (const replicate of protocol.replicates) {
	intervals.push({
		id: `${replicate.id}:train`,
		visibility: 'training',
		start: replicate.trainBase,
		end:
			replicate.trainBase +
			(schedule.maxGeneration - 1) * schedule.trainStride +
			schedule.gamesPerGeneration -
			1
	});
	intervals.push({
		id: `${replicate.id}:eval`,
		visibility: 'public-development',
		start: replicate.evalBase,
		end:
			replicate.evalBase +
			(schedule.maxGeneration - 1) * schedule.evalStride +
			schedule.evalGamesPerGeneration -
			1
	});
}
intervals.push({
	id: 'common-public-development',
	visibility: 'public-development',
	start: schedule.commonPublicBase,
	end: schedule.commonPublicBase + schedule.commonPublicGames - 1
});
for (let index = 0; index < intervals.length; index += 1) {
	const interval = intervals[index];
	requireCondition(Number.isSafeInteger(interval.start), `${interval.id} start is unsafe`);
	requireCondition(Number.isSafeInteger(interval.end), `${interval.id} end is unsafe`);
	requireCondition(interval.start >= 0 && interval.end >= interval.start, `${interval.id} is invalid`);
	for (let otherIndex = index + 1; otherIndex < intervals.length; otherIndex += 1) {
		requireCondition(
			!intervalsOverlap(interval, intervals[otherIndex]),
			`proposal seed overlap ${interval.id} and ${intervals[otherIndex].id}`
		);
	}
	for (const declared of inventory.declaredStructuredRanges) {
		requireCondition(
			!intervalsOverlap(interval, declared),
			`proposal seed overlap ${interval.id} and declared ${declared.start}..${declared.end}`
		);
	}
	for (const namespace of boundedUnprovableNamespaces) {
		requireCondition(
			!intervalsOverlap(interval, namespace),
			`proposal seed overlap ${interval.id} and unprovable ${namespace.id} ${namespace.start}..${namespace.end}`
		);
	}
}
const common = intervals.at(-1);
requireCondition(
	common.start >= container.start && common.end <= container.end,
	'common public block is outside the reserved container'
);

const materialized = [];
for (const replicate of protocol.replicates) {
	for (const arm of protocol.arms) {
		const finalRoot = `${proposal}/league/rep-${replicate.id}/${arm.id}`;
		const proposalRoot = path.join(outputRoot, 'league', `rep-${replicate.id}`, arm.id);
		const config = structuredClone(base);
		config._readme =
			`NON-EXECUTABLE V35 proposal ${arm.id} replicate ${replicate.id}; ` +
			'Fable review and immutable launch authorization are absent.';
		config.seedBase = replicate.trainBase;
		config.seedSchedule = {
			trainBase: replicate.trainBase,
			trainStride: schedule.trainStride,
			evalBase: replicate.evalBase,
			evalStride: schedule.evalStride,
			maxGeneration: schedule.maxGeneration
		};
		config.initFrom = protocol.initialPolicy.path;
		config.laneInit = { 'main-0': protocol.initialPolicy.path };
		config.paths = { root: finalRoot };
		replaceExtraArg(config.train.extraArgs, '--solo-reach30-coef', arm.soloReach30Coef);
		if (arm.soloReach30Bands !== null) {
			requireCondition(arm.soloReach30Coef === 0, `${arm.id} mixes scalar and scheduled credit`);
			config.train.extraArgs.push(
				'--solo-reach30-bands',
				arm.soloReach30Bands
					.map(([upper, coefficient]) => `${upper}:${coefficient}`)
					.join(',')
			);
		}
		mkdirSync(proposalRoot, { recursive: true });
		requireCondition(!existsSync(path.join(proposalRoot, 'config.json')), `runnable config exists at ${proposalRoot}`);
		const configBytes = Buffer.from(JSON.stringify(config, null, 2) + '\n');
		const configPath = path.join(proposalRoot, 'config.proposed.json');
		writeFileSync(configPath, configBytes);
		const binding = {
			schemaVersion: 'arc-v35-p30-proposed-root-binding-v1',
			experiment: protocol.experiment,
			replicate: replicate.id,
			arm: arm.id,
			protocolPath,
			protocolSha256: hashBytes(protocolBytes),
			configProposedSha256: hashBytes(configBytes),
			catalogSha256: protocol.catalog.sha256,
			initialPolicySha256: protocol.initialPolicy.sha256,
			authorized: false,
			promotionEligible: false
		};
		const bindingPath = path.join(proposalRoot, 'binding.proposed.json');
		writeFileSync(bindingPath, JSON.stringify(binding, null, 2) + '\n');
		materialized.push({
			replicate: replicate.id,
			arm: arm.id,
			finalRoot,
			configProposed: path.relative(repo, configPath),
			configProposedSha256: hashFile(configPath),
			bindingProposed: path.relative(repo, bindingPath),
			bindingProposedSha256: hashFile(bindingPath)
		});
	}
}

const manifest = {
	schemaVersion: 'arc-v35-p30-proposal-materialization-v1',
	status: protocol.status,
	authorized: false,
	protocolPath,
	protocolSha256: hashBytes(protocolBytes),
	basePath,
	baseSha256: hashFile(basePath),
	seedInventoryPath: protocol.seedEvidence.inventoryPath,
	seedInventorySha256: protocol.seedEvidence.inventorySha256,
	seedIntervals: intervals,
	configs: materialized
};
mkdirSync(outputRoot, { recursive: true });
const manifestPath = path.join(outputRoot, 'materialization.proposed.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ manifestPath: path.relative(repo, manifestPath), ...manifest }, null, 2));
