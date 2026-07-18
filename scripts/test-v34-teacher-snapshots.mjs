#!/usr/bin/env node
/** Focused unregistered local tests for collect-v34-teacher-snapshots.mjs. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	FEATURE_SCHEMA,
	POLICY_BINDING_SCHEMA,
	POLICY_CONFIG_SCHEMA,
	TARGET_SCHEMA,
	collectTeacherSnapshots,
	mergeV34FeatureRuns,
	validatePolicyConfig,
	validatePolicyProvider,
	verifyFeatureTracePrefix
} from './collect-v34-teacher-snapshots.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(root, 'ml', 'catalog.json');
const temp = mkdtempSync(path.join(os.tmpdir(), 'arc-v34-teacher-snapshot-test-'));

const config = {
	schemaVersion: POLICY_CONFIG_SCHEMA,
	policyObservationVersion: 2,
	actionSelector: 'hybrid-v1',
	decisionSelection: 'argmax',
	temperature: 0.55,
	progressFilter: {
		mode: 'selectable-candidate-indices-v1',
		learnMonsterRewardChoices: false
	},
	optionHead: { mode: 'disabled', dimension: 0 },
	guardianSchedule: 'absolute-balanced',
	maxStatusLevel: 2,
	maxRounds: 30,
	forcedClosureMaxSteps: 64,
	maxTicks: 20000,
	samplingStream: 0,
	weakEngineThreshold: {
		minRoundInclusive: 16,
		maxExpectedAttack: 3,
		maxAttackDice: 3,
		maxAwakenedSpirits: 2,
		maxBarrier: 5,
		maxInitiative: 3
	}
};

const YIELD_PRIORITY = new Map([
	['commitCleanup', 1000],
	['commitAwakening', 900],
	['commitBenefits', 800],
	['endLocationActions', 700],
	['passEncounter', 600],
	['lockNavigation', 500]
]);

function testBinding() {
	return {
		schemaVersion: POLICY_BINDING_SCHEMA,
		mode: 'unregistered-test',
		provider: 'synthetic-local-test-policy',
		purpose: 'unregistered collector contract smoke only',
		policyObservationVersion: 2,
		checkpoint: null,
		runtime: { kind: 'in-process-javascript', version: process.version }
	};
}

function testPolicy() {
	let decisions = 0;
	return {
		binding: testBinding(),
		scoreDecision(context) {
			decisions += 1;
			assert.equal('state' in context, false, 'authoritative state leaked to policy provider');
			assert.equal('trace' in context, false, 'command trace leaked to policy provider');
			assert.equal('target' in context, false, 'future target leaked to policy provider');
			assert.equal(
				'sourceGameSeed' in context,
				false,
				'audit-only engine seed leaked to policy provider'
			);
			assert.equal(
				'decisionOrdinal' in context,
				false,
				'audit-only row ordinal leaked to policy provider'
			);
			assert.equal(context.obsV2.every(Number.isFinite), true);
			assert.equal(context.candidateCommands.length, context.candidateFeatures.length);
			if (context.option) {
				assert.equal('samplingSeed' in context.option, false, 'option sampling seed leaked');
			}
			return {
				rawLogits: context.candidateCommands.map(
					(command, index) => (YIELD_PRIORITY.get(command.type) ?? 0) + index / 1000
				),
				reach30Probability: 0.25,
				recoveryProbability: context.round >= 16 ? 0.75 : 0.1
			};
		},
		close() {
			assert.ok(decisions > 0, 'test policy was never invoked');
		}
	};
}

function jsonl(file) {
	const payload = readFileSync(file, 'utf8');
	assert.ok(payload.endsWith('\n'), `${file} must end in a newline`);
	return payload
		.trimEnd()
		.split('\n')
		.map((line) => JSON.parse(line));
}

function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

function recursiveExactKeyPaths(value, forbidden, prefix = '$') {
	const found = [];
	if (Array.isArray(value)) {
		value.forEach((entry, index) =>
			found.push(...recursiveExactKeyPaths(entry, forbidden, `${prefix}[${index}]`))
		);
	} else if (value && typeof value === 'object') {
		for (const [key, entry] of Object.entries(value)) {
			if (forbidden.has(key)) found.push(`${prefix}.${key}`);
			found.push(...recursiveExactKeyPaths(entry, forbidden, `${prefix}.${key}`));
		}
	}
	return found;
}

let passed = 0;
async function test(name, body) {
	await body();
	passed += 1;
	process.stdout.write(`ok ${passed} - ${name}\n`);
}

try {
	await test('bound policy configuration is exact and option-head explicit', async () => {
		assert.deepEqual(validatePolicyConfig(config), config);
		const missing = structuredClone(config);
		delete missing.optionHead;
		assert.throws(() => validatePolicyConfig(missing), /optionHead/);
		const unbound = structuredClone(config);
		unbound.temperature = 0;
		assert.throws(() => validatePolicyConfig(unbound), /temperature/);
		assert.throws(
			() =>
				validatePolicyProvider(
					{ binding: testBinding(), scoreDecision() {} },
					{
						...config,
						optionHead: {
							mode: 'round-start',
							dimension: 2,
							selection: 'argmax',
							temperature: 1,
							soloBehaviorMask: [1, 1]
						}
					}
				),
			/scoreOption/
		);
	});

	await test('bounded feature merge handles multiple deterministic fan-in levels', async () => {
		const inputRoot = path.join(temp, 'merge-inputs');
		mkdirSync(inputRoot);
		const runFiles = [];
		for (let index = 16; index >= 0; index -= 1) {
			const file = path.join(inputRoot, `run-${String(index).padStart(2, '0')}.jsonl`);
			writeFileSync(
				file,
				`${canonical({
					publicStateHash: index.toString(16).padStart(64, '0'),
					sourceGameSeed: index + 1,
					decisionOrdinal: 0
				})}\n`,
				{ flag: 'wx' }
			);
			runFiles.push(file);
		}
		const output = path.join(temp, 'merged-features.jsonl');
		const result = await mergeV34FeatureRuns({
			runFiles,
			runRoot: path.join(temp, 'merge-work'),
			outputFile: output,
			fanIn: 3
		});
		const rows = jsonl(output);
		assert.equal(result.rows, 17);
		assert.deepEqual(
			rows.map((row) => row.publicStateHash),
			[...rows.map((row) => row.publicStateHash)].sort()
		);
	});

	const outputDir = path.join(temp, 'collection');
	const report = await collectTeacherSnapshots({
		catalogPath,
		outputDir,
		seeds: [71],
		config,
		provider: testPolicy()
	});
	const features = jsonl(path.join(outputDir, 'features', 'snapshots.jsonl'));
	const targets = jsonl(path.join(outputDir, 'targets', 'future-targets.jsonl'));
	const traceManifest = jsonl(path.join(outputDir, 'traces', 'manifest.jsonl'));
	const trace = jsonl(
		path.join(
			outputDir,
			traceManifest[0].sourceGameSeed === 71 ? 'traces/game-0000000071.jsonl' : 'missing'
		)
	);

	await test('tiny unregistered raw-policy game completes with exact report counts', async () => {
		assert.equal(report.valid, true);
		assert.equal(report.outcomesInspectedForSelection, false);
		assert.equal(report.metrics.games, 1);
		assert.ok(report.metrics.featureRows > 0, 'local smoke produced no ambiguous snapshots');
		assert.equal(report.metrics.featureRows, features.length);
		assert.equal(features.length, targets.length);
		assert.equal(report.metrics.gamesDetail[0].finished, true);
		assert.equal(report.metrics.gamesDetail[0].statusCapViolationEvents, 0);
		assert.ok(report.metrics.gamesDetail[0].traceEvents > 3);
	});

	await test('feature and future-target rows are physically and structurally separate', async () => {
		assert.ok(features.every((row) => row.schemaVersion === FEATURE_SCHEMA));
		assert.ok(targets.every((row) => row.schemaVersion === TARGET_SCHEMA));
		for (const row of features) {
			for (const required of [
				'opaqueRowId',
				'sourceGameSeed',
				'round',
				'decisionOrdinal',
				'publicStateHash',
				'currentVisibleState',
				'canonicalTakenActionTrace',
				'botActionSamplingSeed',
				'obsV1',
				'obsV2',
				'canonicalLegalCommandHashes',
				'candidateFeatures',
				'rawLogits',
				'rawProbabilities',
				'calibratedReach30Probability',
				'currentPublicRecoveryDiagnostics'
			]) {
				assert.ok(required in row, `feature row is missing ${required}`);
			}
			assert.equal('modelDiagnostics' in row, false);
			assert.equal('botSamplingSeed' in row, false);
			assert.equal('tracePrefix' in row, false);
			assert.equal(row.policy.bindingSha256, report.policy.bindingSha256);
			assert.ok(row.candidates.every((candidate) => !('actionFeatures' in candidate)));
		}
		assert.deepEqual(
			recursiveExactKeyPaths(features, new Set(['target', 'targets', 'trace', 'traceHash'])),
			[]
		);
		assert.ok(targets.every((row) => row.target && typeof row.target.finalVp === 'number'));
		assert.deepEqual(
			new Set(features.map((row) => row.opaqueRowId)),
			new Set(targets.map((row) => row.opaqueRowId))
		);
	});

	await test('feature rows use the freezer order and recovery-precedence selection band', async () => {
		const keys = features.map((row) => [
			row.publicStateHash,
			row.sourceGameSeed,
			row.decisionOrdinal
		]);
		const sorted = structuredClone(keys).sort(
			(a, b) => (a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1) || a[1] - b[1] || a[2] - b[2]
		);
		assert.deepEqual(keys, sorted);
		for (const row of features) {
			const expected = row.recoveryDiagnostics.recoveryEligible
				? 'recovery'
				: row.round <= 8
					? 'early'
					: row.round <= 15
						? 'mid'
						: 'late';
			assert.equal(row.selectionBand, expected);
			assert.ok(row.semanticallyDistinctCandidates >= 2);
			assert.ok(row.candidates.length >= 2);
		}
	});

	await test('each row binds a canonical prefix of the one per-game trace shard', async () => {
		const { createHash } = await import('node:crypto');
		const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
		for (const row of features) {
			assert.equal(row.canonicalTakenActionTrace.shardPath, 'traces/game-0000000071.jsonl');
			assert.ok(
				row.canonicalTakenActionTrace.prefixEventCount >= 3 &&
					row.canonicalTakenActionTrace.prefixEventCount <= trace.length
			);
			const actual = createHash('sha256')
				.update(canonical(trace.slice(0, row.canonicalTakenActionTrace.prefixEventCount)))
				.digest('hex');
			assert.equal(actual, row.canonicalTakenActionTrace.prefixSha256);
			assert.deepEqual(
				verifyFeatureTracePrefix({
					feature: row,
					traceEvents: trace,
					traceManifest: traceManifest[0],
					catalog,
					config
				}),
				{
					valid: true,
					publicStateHash: row.publicStateHash,
					legalActions: row.candidates.length,
					takenCommandHash: row.policy.chosenCommandHash,
					futureTargetsLoaded: false
				}
			);
		}
		assert.equal(traceManifest[0].events, trace.length);
		const fullHash = createHash('sha256').update(canonical(trace)).digest('hex');
		assert.equal(fullHash, traceManifest[0].traceSha256);
	});

	await test('target deletion cannot change replay, policy visits, or selected actions', async () => {
		const featureBytes = readFileSync(path.join(outputDir, 'features', 'snapshots.jsonl'));
		const traceBytes = readFileSync(path.join(outputDir, 'traces', 'game-0000000071.jsonl'));
		const manifestBytes = readFileSync(path.join(outputDir, 'traces', 'manifest.jsonl'));
		rmSync(path.join(outputDir, 'targets', 'future-targets.jsonl'));

		const repeatedOutput = path.join(temp, 'targetless-repeat');
		const repeatedReport = await collectTeacherSnapshots({
			catalogPath,
			outputDir: repeatedOutput,
			seeds: [71],
			config,
			provider: testPolicy()
		});
		assert.deepEqual(
			readFileSync(path.join(repeatedOutput, 'features', 'snapshots.jsonl')),
			featureBytes
		);
		assert.deepEqual(
			readFileSync(path.join(repeatedOutput, 'traces', 'game-0000000071.jsonl')),
			traceBytes
		);
		assert.deepEqual(
			readFileSync(path.join(repeatedOutput, 'traces', 'manifest.jsonl')),
			manifestBytes
		);
		assert.equal(
			repeatedReport.metrics.gamesDetail[0].policyDecisions,
			report.metrics.gamesDetail[0].policyDecisions
		);
		assert.equal(
			repeatedReport.metrics.gamesDetail[0].retainedSnapshots,
			report.metrics.gamesDetail[0].retainedSnapshots
		);
	});

	await test('sampled policy selection is deterministic on its bound independent stream', async () => {
		const sampleConfig = {
			...structuredClone(config),
			decisionSelection: 'sample',
			samplingStream: 7
		};
		const first = path.join(temp, 'sampled-first');
		const second = path.join(temp, 'sampled-second');
		await collectTeacherSnapshots({
			catalogPath,
			outputDir: first,
			seeds: [76],
			config: sampleConfig,
			provider: testPolicy()
		});
		await collectTeacherSnapshots({
			catalogPath,
			outputDir: second,
			seeds: [76],
			config: sampleConfig,
			provider: testPolicy()
		});
		assert.deepEqual(
			readFileSync(path.join(first, 'features', 'snapshots.jsonl')),
			readFileSync(path.join(second, 'features', 'snapshots.jsonl'))
		);
		assert.deepEqual(
			readFileSync(path.join(first, 'traces', 'game-0000000076.jsonl')),
			readFileSync(path.join(second, 'traces', 'game-0000000076.jsonl'))
		);
		assert.ok(
			jsonl(path.join(first, 'features', 'snapshots.jsonl')).some(
				(row) => row.policy.selectionReason === 'sampled-policy'
			)
		);
	});

	await test('collector output is accepted by the committed quota freezer', async () => {
		const availableBand = ['recovery', 'late', 'mid', 'early'].find((band) =>
			features.some((row) => row.selectionBand === band)
		);
		assert.ok(availableBand);
		const quotas = { recovery: 0, late: 0, mid: 0, early: 0, [availableBand]: 1 };
		const protocol = path.join(temp, 'freeze-protocol.json');
		const frozen = path.join(temp, 'frozen.jsonl');
		const ledger = path.join(temp, 'freeze-ledger.json');
		writeFileSync(
			protocol,
			JSON.stringify({ schemaVersion: 'arc-v34-teacher-snapshot-freeze-protocol-v1', quotas }) +
				'\n',
			{ flag: 'wx' }
		);
		execFileSync(
			path.join(root, 'ml', 'v34_stats_env', '.venv', 'bin', 'python'),
			[
				path.join(root, 'ml', 'freeze_v34_teacher_snapshots.py'),
				'freeze',
				'--input',
				path.join(outputDir, 'features', 'snapshots.jsonl'),
				'--output',
				frozen,
				'--ledger',
				ledger,
				'--protocol',
				protocol,
				'--generation',
				'1'
			],
			{ cwd: root, stdio: 'pipe' }
		);
		assert.equal(jsonl(frozen).length, 1);
	});

	await test('atomic new-only publication refuses an existing destination', async () => {
		await assert.rejects(
			collectTeacherSnapshots({
				catalogPath,
				outputDir,
				seeds: [72],
				config,
				provider: testPolicy()
			}),
			/output directory already exists/
		);
	});

	await test('new-only publication rejects a dangling destination symlink', async () => {
		const danglingOutput = path.join(temp, 'dangling-collection');
		symlinkSync(path.join(temp, 'missing-target'), danglingOutput);
		await assert.rejects(
			collectTeacherSnapshots({
				catalogPath,
				outputDir: danglingOutput,
				seeds: [72],
				config,
				provider: testPolicy()
			}),
			/output directory already exists/
		);
	});

	await test('policy binding is immutable for the full collection', async () => {
		const provider = testPolicy();
		const originalScore = provider.scoreDecision.bind(provider);
		provider.scoreDecision = (context) => {
			const result = originalScore(context);
			provider.binding.purpose = 'mutated after inference began';
			return result;
		};
		await assert.rejects(
			collectTeacherSnapshots({
				catalogPath,
				outputDir: path.join(temp, 'mutated-binding'),
				seeds: [75],
				config,
				provider
			}),
			/policy provider binding changed during collection/
		);
	});

	await test('enabled option head is scored once per round and bound into retained rows', async () => {
		let optionCalls = 0;
		const optionConfig = {
			...structuredClone(config),
			optionHead: {
				mode: 'round-start',
				dimension: 4,
				selection: 'argmax',
				temperature: 0.55,
				soloBehaviorMask: [1, 1, 1, 0]
			}
		};
		const provider = testPolicy();
		provider.scoreOption = (context) => {
			optionCalls += 1;
			assert.equal('state' in context, false);
			assert.equal('sourceGameSeed' in context, false);
			assert.equal('optionOrdinal' in context, false);
			return { rawLogits: [0, 1, 0, -100] };
		};
		const optionOutput = path.join(temp, 'option-collection');
		const optionReport = await collectTeacherSnapshots({
			catalogPath,
			outputDir: optionOutput,
			seeds: [72],
			config: optionConfig,
			provider
		});
		const optionFeatures = jsonl(path.join(optionOutput, 'features', 'snapshots.jsonl'));
		const optionTargets = jsonl(path.join(optionOutput, 'targets', 'future-targets.jsonl'));
		assert.equal(optionReport.valid, true);
		assert.equal(optionCalls, optionTargets[0].target.terminalRound);
		assert.ok(optionFeatures.length > 0);
		assert.ok(
			optionFeatures.every(
				(row) =>
					row.policy.option?.optionId === 1 &&
					row.policy.option.round === row.round &&
					Number.isSafeInteger(row.policy.option.samplingSeed)
			)
		);
	});

	await test('standalone CLI runs only through an explicit injected policy module', async () => {
		const cliConfig = path.join(temp, 'cli-config.json');
		const cliPolicy = path.join(temp, 'cli-policy.mjs');
		const cliOutput = path.join(temp, 'cli-collection');
		writeFileSync(cliConfig, JSON.stringify(config) + '\n', { flag: 'wx' });
		writeFileSync(
			cliPolicy,
			`export async function createV34SnapshotPolicy() {
				const priority = new Map([['commitCleanup',1000],['commitAwakening',900],['commitBenefits',800],['endLocationActions',700],['passEncounter',600],['lockNavigation',500]]);
				return {
					binding: {
						schemaVersion: '${POLICY_BINDING_SCHEMA}',
						mode: 'unregistered-test',
						provider: 'synthetic-local-cli-smoke',
						purpose: 'unregistered standalone CLI contract test',
						policyObservationVersion: 2,
						checkpoint: null,
						runtime: { kind: 'in-process-javascript', version: process.version }
					},
					scoreDecision(context) {
						return {
							rawLogits: context.candidateCommands.map((command, index) => (priority.get(command.type) ?? 0) + index / 1000),
							reach30Probability: 0.25,
							recoveryProbability: context.round >= 16 ? 0.75 : 0.1
						};
					}
				};
			}\n`,
			{ flag: 'wx' }
		);
		const result = spawnSync(
			process.execPath,
			[
				path.join(root, 'scripts', 'collect-v34-teacher-snapshots.mjs'),
				'--catalog',
				catalogPath,
				'--config',
				cliConfig,
				'--policy-module',
				cliPolicy,
				'--seed0',
				'74',
				'--games',
				'1',
				'--out',
				cliOutput
			],
			{ encoding: 'utf8' }
		);
		assert.equal(result.status, 0, result.stderr);
		const cliReport = JSON.parse(result.stdout);
		assert.equal(cliReport.valid, true);
		assert.equal(cliReport.seeds[0], 74);
		assert.ok(jsonl(path.join(cliOutput, 'features', 'snapshots.jsonl')).length > 0);
	});

	await test('CLI fails closed without an explicitly injected policy module', async () => {
		const result = spawnSync(
			process.execPath,
			[
				path.join(root, 'scripts', 'collect-v34-teacher-snapshots.mjs'),
				'--catalog',
				catalogPath,
				'--config',
				path.join(temp, 'absent-config.json'),
				'--seed0',
				'73',
				'--games',
				'1',
				'--out',
				path.join(temp, 'should-not-exist')
			],
			{ encoding: 'utf8' }
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /--policy-module is required/);
	});

	process.stdout.write(`1..${passed}\n`);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
