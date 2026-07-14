#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PROTOCOL =
	'ml/experiments/v34-latency-first-expert-iteration/lane-b-execution-protocol.json';
const EXPECTED_CANONICAL_SHA256 =
	'885fd8a55cbb909245c3d5d7780020cde3dedc10db7fa9046f046798f5431d58';

const EXPECTED_ROOT_KEYS = [
	'approvedPlan',
	'authorization',
	'b1',
	'b2',
	'b3',
	'b4',
	'b5',
	'compute',
	'outcomeBlind',
	'promotion',
	'result',
	'retry',
	'schemaVersion',
	'seedLedger',
	'status',
	'storage',
	'validationMetadata'
];

const EXPECTED_RANGES = [
	['b3-g1-teacher', 'b3', 958000000, 4096, 958004095],
	['b3-g2-teacher', 'b3', 958010000, 4096, 958014095],
	['b3-g3-teacher', 'b3', 958020000, 4096, 958024095],
	['b3-g1-ppo', 'b3', 958030000, 4096, 958034095],
	['b3-g2-ppo', 'b3', 958040000, 4096, 958044095],
	['b3-g3-ppo', 'b3', 958050000, 4096, 958054095],
	['b3-g1-development', 'b3', 958100000, 4096, 958104095],
	['b3-g2-development', 'b3', 958110000, 4096, 958114095],
	['b3-g3-development', 'b3', 958120000, 4096, 958124095],
	['base-distilled-transfer-reserved', 'b3', 958200000, 4096, 958204095],
	['b4-r1-teacher', 'b4', 959000000, 4096, 959004095],
	['b4-r1-ppo', 'b4', 959010000, 4096, 959014095],
	['b4-r2-teacher', 'b4', 959100000, 4096, 959104095],
	['b4-r2-ppo', 'b4', 959110000, 4096, 959114095],
	['b4-r3-teacher', 'b4', 959200000, 4096, 959204095],
	['b4-r3-ppo', 'b4', 959210000, 4096, 959214095],
	['b4-development', 'b4', 959900000, 4096, 959904095],
	['b4-heuristic-probe', 'b4', 959910000, 3072, 959913071],
	['b4-exploiter-probe', 'b4', 959920000, 3072, 959923071],
	['b4-handoff-development', 'b4', 959930000, 4096, 959934095],
	['b5-zero-shot-canary', 'b5', 960000000, 512, 960000511],
	['b5-final-development', 'b5', 960010000, 90000, 960099999],
	['b5-final-hidden', 'b5', 960100000, 100000, 960199999],
	['promotion-human-reference', 'promotion', 960900000, 10000, 960909999],
	['b5-2p-training', 'b5', 961000000, 100000, 961099999],
	['b5-3p-training', 'b5', 961100000, 100000, 961199999],
	['b5-4p-pfsp-training', 'b5', 961200000, 100000, 961299999],
	['b5-2p-solo-regression', 'b5', 961300000, 4096, 961304095],
	['b5-3p-solo-regression', 'b5', 961310000, 4096, 961314095],
	['b5-4p-solo-regression', 'b5', 961320000, 4096, 961324095],
	['b5-2p-development', 'b5', 961400000, 10000, 961409999],
	['b5-3p-development', 'b5', 961410000, 9996, 961419995],
	['b5-3p-permanently-unused', 'unused', 961419996, 4, 961419999],
	['b5-4p-development', 'b5', 961420000, 10000, 961429999],
	['b5-main-exploiter', 'b5', 961500000, 30000, 961529999],
	['b5-2p-league-exploiter', 'b5', 961530000, 30000, 961559999],
	['b5-3p-league-exploiter', 'b5', 961560000, 30000, 961589999],
	['b5-4p-league-exploiter', 'b5', 961590000, 30000, 961619999]
];

const EXPECTED_AMBIGUITIES = [
	'storage-exact-prefix-and-probe',
	'b4-probe-family',
	'b5-training-recipes',
	'b5-exploiter-recipes',
	'b5-multiplayer-development-inference',
	'b5-final-hidden-schedule',
	'base-958200-transfer-disposition',
	'human-reference-schedule',
	'b2-replay-integrity-selection',
	'b1-recovery-weak-engine-thresholds',
	'b1-density-smoke-seeds',
	'b4-b5-normal-floor-implementation'
];

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonicalize(value[key])])
	);
}

function canonicalSha256(value) {
	return createHash('sha256')
		.update(JSON.stringify(canonicalize(value)))
		.digest('hex');
}

function fileSha256(file) {
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function exactKeys(value, keys, label) {
	assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
	assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys changed`);
}

function assertArtifact(record, expected, label, repo) {
	exactKeys(record, expected.keys, label);
	assert.equal(record.path, expected.path, `${label} path changed`);
	assert.equal(record.bytes, expected.bytes, `${label} byte count changed`);
	assert.equal(record.sha256, expected.sha256, `${label} digest changed`);
	const file = path.resolve(repo, record.path);
	assert(existsSync(file), `${label} is missing`);
	assert.equal(readFileSync(file).length, record.bytes, `${label} live byte count changed`);
	assert.equal(fileSha256(file), record.sha256, `${label} live digest changed`);
}

function assertClosedFlags(protocol) {
	for (const stage of ['b1', 'b2', 'b3', 'b4', 'b5']) {
		assert.equal(protocol[stage].stageOpen, false, `${stage} must remain closed`);
	}
	assert.equal(protocol.storage.stageOpen, false, 'storage must remain closed');
	assert.equal(protocol.promotion.stageOpen, false, 'promotion must remain closed');
	for (const [name, value] of Object.entries(protocol.authorization)) {
		assert.equal(value, false, `authorization.${name} must remain false`);
	}
	for (const row of protocol.seedLedger) {
		assert.equal(row.open, false, `${row.id} must remain closed`);
	}
	assert.equal(
		protocol.b1.registeredCollectionOpen,
		false,
		'b1 registered collection must remain closed'
	);
	assert.equal(
		protocol.b1.densitySmoke.registered,
		false,
		'b1 density smoke must remain unregistered'
	);
	assert.equal(
		protocol.b2.registeredTeacherOpen,
		false,
		'b2 registered teacher must remain closed'
	);
	assert.equal(
		protocol.b2.systemsPilot.registered,
		false,
		'b2 systems pilot must remain unregistered'
	);
	for (const [generation, open] of Object.entries(protocol.b3.generationOpen)) {
		assert.equal(open, false, `b3 ${generation} must remain closed`);
	}
	for (const [replicate, open] of Object.entries(protocol.b4.replicatesOpen)) {
		assert.equal(open, false, `b4 ${replicate} must remain closed`);
	}
	assert.equal(protocol.b4.handoffRetrain.open, false, 'b4 handoff retrain must remain closed');
	for (const [stage, open] of Object.entries(protocol.b5.stagesOpen)) {
		assert.equal(open, false, `b5 ${stage} must remain closed`);
	}
}

function assertSeedLedger(protocol) {
	assert.equal(protocol.seedLedger.length, EXPECTED_RANGES.length, 'seed-ledger length changed');
	for (let index = 0; index < EXPECTED_RANGES.length; index += 1) {
		const row = protocol.seedLedger[index];
		exactKeys(row, ['id', 'stage', 'seed0', 'games', 'seedMax', 'open'], `seedLedger[${index}]`);
		const [id, stage, seed0, games, seedMax] = EXPECTED_RANGES[index];
		assert.deepEqual(
			[row.id, row.stage, row.seed0, row.games, row.seedMax, row.open],
			[id, stage, seed0, games, seedMax, false],
			`${id} range changed`
		);
		assert.equal(row.seedMax - row.seed0 + 1, row.games, `${id} count is inconsistent`);
		assert(
			[958, 959, 960, 961].includes(Math.floor(row.seed0 / 1_000_000)),
			`${id} prefix changed`
		);
	}
	const sorted = [...protocol.seedLedger].sort((left, right) => left.seed0 - right.seed0);
	for (let index = 1; index < sorted.length; index += 1) {
		assert(sorted[index - 1].seedMax < sorted[index].seed0, 'registered ranges overlap');
	}
}

function assertRngAndArithmetic(protocol) {
	assert.deepEqual(protocol.b1.bandQuotas, {
		late: 50000,
		mid: 25000,
		early: 15000,
		recovery: 10000
	});
	assert.equal(
		Object.values(protocol.b1.bandQuotas).reduce((sum, value) => sum + value, 0),
		protocol.b1.rowsPerGeneration
	);
	assert.deepEqual(protocol.b1.densitySmoke.minimumPostDedupRows, {
		late: 6875,
		mid: 3438,
		early: 2063,
		recovery: 1375
	});
	assert.deepEqual(protocol.b1.selection.generationSeeds, {
		g1: 34043101,
		g2: 34043102,
		g3: 34043103
	});
	assert.deepEqual(protocol.b2.systemsArms, [
		{ simulations: 64, rounds: 10 },
		{ simulations: 48, rounds: 8 },
		{ simulations: 32, rounds: 6 }
	]);
	assert.equal(protocol.b2.poweredAudit.selectionPcg64Seed, 34041026);
	assert.equal(protocol.b2.bootstrap.pcg64Seed, 34041027);
	assert.equal(protocol.b3.development.pcg64Seed, 34042026);
	assert.equal(protocol.b3.optimizer.batchSize, 512);
	assert.equal(
		Object.values(protocol.b3.optimizer.batchComposition).reduce((sum, value) => sum + value, 0),
		512
	);
	assert.equal(
		protocol.b3.optimizer.stepsPerEpoch * protocol.b3.optimizer.batchComposition.ppo,
		100128
	);
	assert.equal(
		protocol.b3.optimizer.stepsPerEpoch * protocol.b3.optimizer.batchComposition.teacher,
		100128
	);
	assert.equal(
		protocol.b3.optimizer.stepsPerEpoch * protocol.b3.optimizer.batchComposition.anchor,
		28608
	);
	assert.equal(protocol.b3.optimizer.ppoRowsPerEpoch - protocol.b3.rows.ppo, 128);
	assert.equal(protocol.b3.optimizer.teacherRowsPerEpoch - protocol.b3.rows.teacher, 128);
	assert.equal(protocol.b3.optimizer.anchorRowsPerEpoch - protocol.b3.rows.generation0Anchor, 3608);
	for (let g = 1; g <= 3; g += 1) {
		for (let e = 1; e <= 2; e += 1) {
			for (const [stream, s] of Object.entries({ ppo: 1, teacher: 2, anchor: 3 })) {
				assert.equal(
					protocol.b3.permutations.seeds[`g${g}`][`epoch${e}`][stream],
					34044000 + 100 * g + 10 * e + s,
					`B3 permutation seed changed for g${g}/e${e}/${stream}`
				);
			}
		}
	}
	assert.deepEqual(
		protocol.b4.replicates.map(({ initializationSeed, rowOrderBaseSeed }) => [
			initializationSeed,
			rowOrderBaseSeed
		]),
		[
			[34051101, 34051102],
			[34051201, 34051202],
			[34051301, 34051302]
		]
	);
	assert.equal(protocol.b4.development.pcg64Seed, 34052026);
	assert.equal(protocol.b4.handoffRetrain.initializationSeed, 34051999);
	assert.equal(protocol.b4.handoffRetrain.rowOrderBaseSeed, 34051998);
	assert.equal(protocol.b4.handoffRetrain.developmentPcg64Seed, 34053026);
	assert.equal(protocol.b4.handoffRetrain.stepsPerEpoch, 1340);
	assert.equal(
		protocol.b4.handoffRetrain.stepsPerEpoch * protocol.b4.handoffRetrain.batchComposition.ppo,
		protocol.b4.handoffRetrain.ppoAndTeacherRowsPerEpoch
	);
	assert.equal(
		protocol.b4.handoffRetrain.stepsPerEpoch * protocol.b4.handoffRetrain.batchComposition.anchor,
		protocol.b4.handoffRetrain.anchorRowsPerEpoch
	);
	assert.equal(protocol.b4.handoffRetrain.ppoAndTeacherRowsPerEpoch - 300000, 160);
	assert.equal(protocol.b4.handoffRetrain.anchorRowsPerEpoch - 3 * 25000, 10760);
	assert.equal(protocol.b5.soloRegression.pcg64Seed, 34062026);
	assert.equal(protocol.b4.development.normalFloorFormula, 'NormalDist().inv_cdf(1 - 0.05 / 48)');
	assert.equal(
		protocol.b5.soloRegression.normalFloorFormula,
		'NormalDist().inv_cdf(1 - 0.05 / 18)'
	);
	assert.equal(
		Object.values(protocol.b5.canary.counts).reduce((sum, value) => sum + value, 0),
		512
	);
	assert.equal(protocol.b5.stageDevelopment.totalGames, 29996);
	assert.equal(protocol.b5.finalDevelopment.gamesPerFormat * 3, 90000);
}

function assertStorageAndRetry(protocol) {
	assert.equal(
		protocol.storage.objectStore.uriTemplate,
		's3://dev-simforge-435362779479-models/arc-spirits/v34/lane-b/<authorization-hash>/'
	);
	assert.equal(protocol.storage.objectStore.exactPrefix, null);
	assert.equal(protocol.storage.objectStore.liveProbePerformed, false);
	assert.equal(protocol.storage.objectStore.authorizedForRegisteredExecution, false);
	assert.equal(protocol.storage.scratch.root, '/dev/shm');
	assert.equal(protocol.storage.scratch.durable, false);
	assert.equal(protocol.storage.minimumDurableBytes, 128 * 1024 ** 3);
	assert.equal(protocol.storage.minimumScratchToPilotPeakRatio, 2);
	assert.equal(protocol.storage.minimumDurableToProjectedTotalRatio, 1.5);
	assert.equal(protocol.storage.actionTraceMaximumDurableFraction, 0.25);
	assert.deepEqual(protocol.retry, {
		attemptsMax: 2,
		attemptSplicing: false,
		identicalFullSeedRetryOnly: true,
		retryableFailures: { 'server-start': 90, 'process-interrupted': 92 },
		requiresImmutableAttempt1Evidence: true,
		forbiddenIfPrimaryOrReplayReportExists: true,
		seedSubstitution: false,
		outcomeDependentRetry: false,
		partialRepair: false,
		semanticReplayProvenanceHiddenInformationOrSafetyFaultClosesStage: true,
		infrastructureFailureBeforeRegisteredSeedConsumptionCreatesAttempt: false
	});
}

function assertAmbiguities(protocol) {
	assert.equal(protocol.validationMetadata.unresolvedFieldsKeepAffectedStagesClosed, true);
	assert.deepEqual(
		protocol.validationMetadata.ambiguities.map(({ id }) => id),
		EXPECTED_AMBIGUITIES
	);
	assert.equal(protocol.b3.reservedBaseDistilledTransfer.open, false);
	assert.equal(protocol.b3.reservedBaseDistilledTransfer.dispositionSpecified, false);
	assert.equal(protocol.b4.probes.statisticalConstructionSpecified, false);
	assert.equal(protocol.b5.exploiterRecipe.specified, false);
	assert.equal(protocol.b5.stageDevelopment.statisticalConstructionSpecified, false);
	assert.equal(protocol.b5.finalHidden.exactScheduleSpecified, false);
}

export function validateProtocol(protocol, { repo = root } = {}) {
	exactKeys(protocol, EXPECTED_ROOT_KEYS, 'root');
	assert.equal(protocol.schemaVersion, 'arc-v34-lane-b-execution-protocol-v1');
	assert.equal(protocol.status, 'closed');
	assert.equal(protocol.outcomeBlind, true);
	assert.equal(protocol.result, null);
	assert.equal(protocol.validationMetadata.draftOnly, true);
	assert.equal(protocol.validationMetadata.syntheticFixturesOnly, true);
	assert.equal(protocol.validationMetadata.registeredSeedExecutionAuthorized, false);

	assertArtifact(
		protocol.approvedPlan,
		{
			keys: ['path', 'bytes', 'sha256', 'finalFableValidation'],
			path: 'ml/experiments/v34-latency-first-expert-iteration/lane-b-tooling-plan.md',
			bytes: 27380,
			sha256: '2b77be787b92f0a5f3d8e1122679f5b8eb3e669fee3190ee925770c33f9a5383'
		},
		'approved plan',
		repo
	);
	assertArtifact(
		protocol.approvedPlan.finalFableValidation,
		{
			keys: ['path', 'bytes', 'sha256', 'result'],
			path: 'ml/experiments/v34-latency-first-expert-iteration/lane-b-tooling-fable-final-validation.md',
			bytes: 1057,
			sha256: '781694f954b1b0c04d4ded8ce06217ba2ea95b67eced5f340e293c0f45524739'
		},
		'final Fable validation',
		repo
	);
	assert.equal(protocol.approvedPlan.finalFableValidation.result, 'PASS');

	assertClosedFlags(protocol);
	assertSeedLedger(protocol);
	assertRngAndArithmetic(protocol);
	assertStorageAndRetry(protocol);
	assertAmbiguities(protocol);
	assert.equal(
		canonicalSha256(protocol),
		EXPECTED_CANONICAL_SHA256,
		'protocol differs from the exact outcome-blind reviewed-plan translation'
	);
	return {
		schemaVersion: 'arc-v34-lane-b-protocol-validation-v1',
		valid: true,
		canonicalSha256: EXPECTED_CANONICAL_SHA256,
		registeredRanges: EXPECTED_RANGES.length,
		registeredSeedsOpen: false,
		unresolvedAmbiguities: EXPECTED_AMBIGUITIES.length
	};
}

function readProtocolArgument() {
	const index = process.argv.indexOf('--protocol');
	assert(index === -1 || process.argv[index + 1], '--protocol requires a path');
	return index === -1 ? DEFAULT_PROTOCOL : process.argv[index + 1];
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	const protocolPath = path.resolve(root, readProtocolArgument());
	const protocol = JSON.parse(readFileSync(protocolPath, 'utf8'));
	const result = validateProtocol(protocol);
	console.log(
		JSON.stringify({
			...result,
			protocol: {
				path: path.relative(root, protocolPath),
				bytes: readFileSync(protocolPath).length,
				sha256: fileSha256(protocolPath)
			}
		})
	);
}
