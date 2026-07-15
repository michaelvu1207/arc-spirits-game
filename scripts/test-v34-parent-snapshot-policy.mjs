#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	EXPECTED_PARENT,
	assertBoundPolicyConfig,
	canonicalJson,
	resolveAdapterEnvironment,
	validateServedParent
} from './v34-parent-snapshot-policy.mjs';

const CONFIG = {
	schemaVersion: 'arc-v34-bound-raw-policy-v1',
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

test('binds the exact V34 B1 parent policy config', () => {
	assert.deepEqual(assertBoundPolicyConfig(CONFIG), CONFIG);
	const changed = structuredClone(CONFIG);
	changed.temperature = 0.56;
	assert.throws(() => assertBoundPolicyConfig(changed), /differs/);
	const optionEnabled = structuredClone(CONFIG);
	optionEnabled.optionHead = {
		mode: 'round-start',
		dimension: 4,
		selection: 'sample',
		temperature: 0.55,
		soloBehaviorMask: [1, 1, 1, 0]
	};
	assert.throws(() => assertBoundPolicyConfig(optionEnabled), /differs/);
});

test('canonical config serialization is key-order invariant', () => {
	assert.equal(
		canonicalJson(CONFIG),
		canonicalJson(Object.fromEntries(Object.entries(CONFIG).reverse()))
	);
});

test('requires an explicit absolute environment and bounded timeout', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'v34-parent-adapter-'));
	const checkpoint = path.join(root, 'checkpoint.pt');
	writeFileSync(checkpoint, 'fixture');
	const environment = {
		ARC_V34_PARENT_CHECKPOINT: checkpoint,
		ARC_V34_INFER_SOCKET: path.join(root, 'infer.sock'),
		ARC_V34_INFER_TIMEOUT_MS: '30000',
		ARC_V34_EXPECT_DEVICE: 'cpu'
	};
	assert.deepEqual(resolveAdapterEnvironment(environment), {
		checkpoint,
		manifest: path.join(root, 'checkpoint.manifest.json'),
		socketPath: path.join(root, 'infer.sock'),
		timeoutMs: 30000,
		expectedDevice: 'cpu'
	});
	assert.throws(
		() => resolveAdapterEnvironment({ ...environment, ARC_V34_INFER_TIMEOUT_MS: '0' }),
		/\[1000, 120000\]/
	);
	assert.throws(
		() => resolveAdapterEnvironment({ ...environment, ARC_V34_INFER_SOCKET: 'relative.sock' }),
		/must be absolute/
	);
});

test('validates the complete served-parent identity', () => {
	const checkpoint = {
		path: '/abs/checkpoint.pt',
		bytes: 1,
		sha256: EXPECTED_PARENT.checkpointSha256
	};
	const info = {
		format: EXPECTED_PARENT.format,
		obs_dim: EXPECTED_PARENT.obsDim,
		act_dim: EXPECTED_PARENT.actDim,
		device: 'cuda:0',
		weights: checkpoint.path,
		weights_sha256: checkpoint.sha256,
		aux: {
			farm_value: true,
			route_mode: true,
			reward_pick: true,
			placement: false,
			reach30: true
		},
		reach30_horizon: 30
	};
	assert.deepEqual(validateServedParent(info, checkpoint, 'cuda:0'), info);
	assert.throws(
		() => validateServedParent({ ...info, weights_sha256: '0'.repeat(64) }, checkpoint, 'cuda:0'),
		/SHA-256 mismatch/
	);
	assert.throws(
		() => validateServedParent({ ...info, reach30_horizon: 25 }, checkpoint, 'cuda:0'),
		/critic horizon mismatch/
	);
});
