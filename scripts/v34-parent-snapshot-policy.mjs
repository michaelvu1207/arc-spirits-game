#!/usr/bin/env node
/**
 * Exact V34 Lane-B parent-policy adapter.
 *
 * The collector owns raw-policy action selection.  This adapter only quantizes the public
 * obs-v2/candidate tensors, obtains the frozen parent's raw logits and round-30 critic output,
 * and emits self-verifying provenance.  It never receives source-game seeds, decision ordinals,
 * traces, future targets, or authoritative hidden state.
 */
import { createHash } from 'node:crypto';
import { statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

export const ADAPTER_SCHEMA = 'arc-v34-remote-parent-policy-adapter-v1';
export const POLICY_BINDING_SCHEMA = 'arc-v34-policy-provider-binding-v1';
export const POLICY_CONFIG_SCHEMA = 'arc-v34-bound-raw-policy-v1';
export const EXPECTED_PARENT = Object.freeze({
	format: 'arc-entity-scorer-v2',
	obsDim: 3419,
	actDim: 104,
	reach30Horizon: 30,
	checkpointSha256: 'aeb254c20367029696da1e6ca823b96187191140056d646a7c2d3d47ec4e567b',
	manifestSha256: 'fe21b3adfc1b688515dc3a3d2de0d7a6defa611728aac0ccbdfb79bf36678fad'
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INFERENCE_CLIENT_PATH = path.join(ROOT, 'src', 'lib', 'play', 'ml', 'inferenceClient.ts');

function requireCondition(condition, message) {
	if (!condition) throw new Error(message);
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

export function sha256File(file) {
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function fileRecord(file) {
	const resolved = path.resolve(file);
	const stat = statSync(resolved);
	requireCondition(stat.isFile(), `not a regular file: ${resolved}`);
	return { path: resolved, bytes: stat.size, sha256: sha256File(resolved) };
}

function parseRequiredInteger(value, name, minimum, maximum) {
	requireCondition(typeof value === 'string' && /^\d+$/.test(value), `${name} must be explicit`);
	const parsed = Number(value);
	requireCondition(
		Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum,
		`${name} must be an integer in [${minimum}, ${maximum}]`
	);
	return parsed;
}

export function assertBoundPolicyConfig(config) {
	const expected = {
		schemaVersion: POLICY_CONFIG_SCHEMA,
		policyObservationVersion: 2,
		actionSelector: 'hybrid-v1',
		decisionSelection: 'sample',
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
		maxTicks: 50000,
		samplingStream: 0,
		weakEngineThreshold: {
			minRoundInclusive: 16,
			maxExpectedAttack: 3.25,
			maxAttackDice: 3,
			maxAwakenedSpirits: 2,
			maxBarrier: 5,
			maxInitiative: 3
		}
	};
	requireCondition(
		canonicalJson(config) === canonicalJson(expected),
		'policy config differs from the exact V34 Lane-B B1 parent binding'
	);
	return structuredClone(expected);
}

export function resolveAdapterEnvironment(environment = process.env) {
	for (const name of [
		'ARC_V34_PARENT_CHECKPOINT',
		'ARC_V34_INFER_SOCKET',
		'ARC_V34_INFER_TIMEOUT_MS',
		'ARC_V34_EXPECT_DEVICE'
	]) {
		requireCondition(
			typeof environment[name] === 'string' && environment[name].length > 0,
			`${name} is required`
		);
	}
	const checkpoint = path.resolve(environment.ARC_V34_PARENT_CHECKPOINT);
	const socketPath = path.resolve(environment.ARC_V34_INFER_SOCKET);
	requireCondition(
		path.isAbsolute(environment.ARC_V34_PARENT_CHECKPOINT),
		'ARC_V34_PARENT_CHECKPOINT must be absolute'
	);
	requireCondition(
		path.isAbsolute(environment.ARC_V34_INFER_SOCKET),
		'ARC_V34_INFER_SOCKET must be absolute'
	);
	const timeoutMs = parseRequiredInteger(
		environment.ARC_V34_INFER_TIMEOUT_MS,
		'ARC_V34_INFER_TIMEOUT_MS',
		1000,
		120000
	);
	requireCondition(
		environment.ARC_V34_EXPECT_DEVICE === 'cuda:0' || environment.ARC_V34_EXPECT_DEVICE === 'cpu',
		'ARC_V34_EXPECT_DEVICE must be cuda:0 or cpu'
	);
	return {
		checkpoint,
		manifest: checkpoint.replace(/\.pt$/, '.manifest.json'),
		socketPath,
		timeoutMs,
		expectedDevice: environment.ARC_V34_EXPECT_DEVICE
	};
}

function validateManifest(record) {
	requireCondition(
		record.sha256 === EXPECTED_PARENT.manifestSha256,
		'parent manifest SHA-256 mismatch'
	);
	const manifest = JSON.parse(readFileSync(record.path, 'utf8'));
	requireCondition(manifest.format === EXPECTED_PARENT.format, 'parent manifest format mismatch');
	requireCondition(manifest.obs_version === 2, 'parent manifest observation version mismatch');
	requireCondition(
		manifest.obs_flat_len === EXPECTED_PARENT.obsDim,
		'parent manifest obs width mismatch'
	);
	requireCondition(
		manifest.act_dim === EXPECTED_PARENT.actDim,
		'parent manifest action width mismatch'
	);
	requireCondition(
		manifest.reach30_trained === true,
		'parent manifest reach30 head is not trained'
	);
	requireCondition(
		Array.isArray(manifest.reach30_horizons) && manifest.reach30_horizons.includes(30),
		'parent manifest has no round-30 critic horizon'
	);
	return manifest;
}

export function validateServedParent(info, checkpointRecord, expectedDevice) {
	requireCondition(info && typeof info === 'object', 'inference handshake returned no info');
	requireCondition(info.format === EXPECTED_PARENT.format, 'served format mismatch');
	requireCondition(info.obs_dim === EXPECTED_PARENT.obsDim, 'served obs width mismatch');
	requireCondition(info.act_dim === EXPECTED_PARENT.actDim, 'served action width mismatch');
	requireCondition(info.device === expectedDevice, 'served device mismatch');
	requireCondition(
		info.weights_sha256 === checkpointRecord.sha256,
		'served checkpoint SHA-256 mismatch'
	);
	requireCondition(
		path.resolve(info.weights) === checkpointRecord.path,
		'served checkpoint path differs from the bound checkpoint'
	);
	requireCondition(info.aux?.reach30 === true, 'served parent has no trained reach30 head');
	requireCondition(
		info.reach30_horizon === EXPECTED_PARENT.reach30Horizon,
		'served critic horizon mismatch'
	);
	requireCondition(
		info.aux?.placement === false,
		'served v2 placement semantics unexpectedly enabled'
	);
	return structuredClone(info);
}

function float32Row(values, expectedWidth, label) {
	requireCondition(
		Array.isArray(values) && values.length === expectedWidth && values.every(Number.isFinite),
		`${label} must contain ${expectedWidth} finite values`
	);
	return Array.from(Float32Array.from(values));
}

function validateDecisionContext(context) {
	requireCondition(
		context?.schemaVersion === 'arc-v34-injected-policy-context-v1',
		'unsupported injected policy context'
	);
	requireCondition(context.option === null, 'the frozen parent has no option head/context');
	requireCondition(
		Array.isArray(context.candidateFeatures) && context.candidateFeatures.length >= 1,
		'policy context has no candidate features'
	);
	requireCondition(
		Array.isArray(context.candidateCommands) &&
			context.candidateCommands.length === context.candidateFeatures.length &&
			Array.isArray(context.candidateCommandHashes) &&
			context.candidateCommandHashes.length === context.candidateFeatures.length,
		'policy context candidate arrays disagree'
	);
}

export async function createV34SnapshotPolicy({ config, catalogPath }) {
	const boundConfig = assertBoundPolicyConfig(config);
	requireCondition(path.isAbsolute(catalogPath), 'collector catalogPath must be absolute');
	const environment = resolveAdapterEnvironment();
	const checkpoint = fileRecord(environment.checkpoint);
	requireCondition(
		checkpoint.sha256 === EXPECTED_PARENT.checkpointSha256,
		'parent checkpoint SHA-256 mismatch'
	);
	const checkpointManifest = fileRecord(environment.manifest);
	validateManifest(checkpointManifest);
	const inferenceClient = fileRecord(INFERENCE_CLIENT_PATH);
	const jiti = createJiti(import.meta.url, { alias: { $lib: path.join(ROOT, 'src', 'lib') } });
	const { RemotePolicy } = await jiti.import(INFERENCE_CLIENT_PATH);
	const policy = new RemotePolicy(environment.socketPath, {
		timeoutMs: environment.timeoutMs,
		expectObsDim: EXPECTED_PARENT.obsDim,
		wire: 'binary'
	});
	let closed = false;
	try {
		const served = validateServedParent(policy.info, checkpoint, environment.expectedDevice);
		requireCondition(policy.wireFormat === 'binary', 'parent policy did not bind the binary wire');
		return {
			binding: {
				schemaVersion: POLICY_BINDING_SCHEMA,
				mode: 'registered-parent',
				provider: ADAPTER_SCHEMA,
				purpose: 'v34-lane-b-b1-outcome-blind-raw-parent-snapshot-collection',
				policyObservationVersion: 2,
				checkpoint,
				runtime: {
					adapterSchema: ADAPTER_SCHEMA,
					policyConfigSha256: createHash('sha256')
						.update(canonicalJson(boundConfig), 'utf8')
						.digest('hex'),
					checkpointManifest,
					inferenceClient,
					server: served,
					client: {
						wire: 'binary',
						timeoutMs: environment.timeoutMs,
						socketPath: environment.socketPath,
						inputQuantization: 'Float32Array.from'
					},
					optionHead: 'disabled-checkpoint-has-no-option-head',
					reach30Probability: 'sigmoid-trained-logit-horizon-30',
					recoveryProbability: {
						source: 'constant-zero-no-trained-head-not-used-for-recovery-classification',
						value: 0
					}
				}
			},
			scoreDecision(context) {
				validateDecisionContext(context);
				const observation = float32Row(context.obsV2, EXPECTED_PARENT.obsDim, 'obsV2');
				const candidates = context.candidateFeatures.map((row, index) =>
					float32Row(row, EXPECTED_PARENT.actDim, `candidateFeatures[${index}]`)
				);
				const rawLogits = policy.scoreCandidates(observation, candidates);
				const reach30Probability = policy.reach30Probability(observation);
				requireCondition(
					Array.isArray(rawLogits) &&
						rawLogits.length === candidates.length &&
						rawLogits.every(Number.isFinite),
					'served parent returned malformed raw logits'
				);
				requireCondition(
					Number.isFinite(reach30Probability) && reach30Probability >= 0 && reach30Probability <= 1,
					'served parent returned malformed reach30 probability'
				);
				return { rawLogits: [...rawLogits], reach30Probability, recoveryProbability: 0 };
			},
			close() {
				if (closed) return;
				closed = true;
				policy.close();
			}
		};
	} catch (error) {
		if (!closed) policy.close();
		throw error;
	}
}
