#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
	EXPECTED_PARENT,
	assertBoundPolicyConfig,
	canonicalJson,
	createV34SnapshotPolicy,
	resolveAdapterEnvironment,
	validateServedParent
} from './v34-parent-snapshot-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

test('ready-synchronized binary client performs one logits-plus-p30 round trip', async () => {
	const temporary = mkdtempSync(path.join(tmpdir(), 'v34-parent-wire-'));
	const socketPath = path.join(temporary, 'infer.sock');
	const checkpoint = path.join(
		ROOT,
		'ml',
		'experiments',
		'v32-onpolicy-solo',
		'shared-critic',
		'checkpoint.pt'
	);
	const serverSource = `
const { workerData, parentPort } = require('node:worker_threads');
const net = require('node:net');
const fs = require('node:fs');
const frame = (payload) => {
  const output = Buffer.allocUnsafe(4 + payload.length);
  output.writeUInt32LE(payload.length, 0);
  payload.copy(output, 4);
  return output;
};
const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const request = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      if (request[0] === 0x7b) {
        const message = JSON.parse(request.toString('utf8'));
        const response = Buffer.from(JSON.stringify({
          id: message.id,
          info: {
            format: 'arc-entity-scorer-v2', obs_dim: 3419, act_dim: 104,
            device: 'cpu', weights: workerData.checkpoint,
            weights_sha256: '${EXPECTED_PARENT.checkpointSha256}',
            aux: { farm_value: true, route_mode: true, reward_pick: true, placement: false, reach30: true },
            reach30_horizon: 30
          }
        }), 'utf8');
        socket.write(frame(response));
        continue;
      }
      if (request[0] !== 0xb1 || request[1] !== 33) throw new Error('bad request');
      const idLength = request.readUInt32LE(2);
      const batch = request.readUInt32LE(6);
      const obsDim = request.readUInt32LE(10);
      const actDim = request.readUInt32LE(14);
      const candidates = request.readUInt32LE(18);
      const id = request.subarray(22, 22 + idLength);
      if (batch !== 1 || obsDim !== 3419 || actDim !== 104) throw new Error('bad dimensions');
      const response = Buffer.allocUnsafe(6 + id.length + 8 + 4 * candidates + 4);
      response.writeUInt8(0xb2, 0);
      response.writeUInt8(33, 1);
      response.writeUInt32LE(id.length, 2);
      id.copy(response, 6);
      let offset = 6 + id.length;
      response.writeUInt32LE(1, offset); offset += 4;
      response.writeUInt32LE(candidates, offset); offset += 4;
      for (let index = 0; index < candidates; index += 1) {
        response.writeFloatLE(index + 0.25, offset); offset += 4;
      }
      response.writeFloatLE(0, offset);
      socket.write(frame(response));
    }
  });
});
try { fs.unlinkSync(workerData.socketPath); } catch {}
server.listen(workerData.socketPath, () => parentPort.postMessage({ kind: 'ready' }));
`;
	const server = new Worker(serverSource, {
		eval: true,
		workerData: { socketPath, checkpoint }
	});
	await new Promise((resolve, reject) => {
		server.once('message', resolve);
		server.once('error', reject);
	});
	const names = [
		'ARC_V34_PARENT_CHECKPOINT',
		'ARC_V34_INFER_SOCKET',
		'ARC_V34_INFER_TIMEOUT_MS',
		'ARC_V34_EXPECT_DEVICE'
	];
	const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
	Object.assign(process.env, {
		ARC_V34_PARENT_CHECKPOINT: checkpoint,
		ARC_V34_INFER_SOCKET: socketPath,
		ARC_V34_INFER_TIMEOUT_MS: '5000',
		ARC_V34_EXPECT_DEVICE: 'cpu'
	});
	try {
		const provider = await createV34SnapshotPolicy({
			config: CONFIG,
			catalogPath: path.join(ROOT, 'ml', 'catalog.json')
		});
		assert.equal(provider.binding.runtime.client.roundTripsPerDecision, 1);
		const result = provider.scoreDecision({
			schemaVersion: 'arc-v34-injected-policy-context-v1',
			option: null,
			obsV2: Array(EXPECTED_PARENT.obsDim).fill(0),
			candidateCommands: [{ type: 'a' }, { type: 'b' }],
			candidateCommandHashes: ['a', 'b'],
			candidateFeatures: [
				Array(EXPECTED_PARENT.actDim).fill(0),
				Array(EXPECTED_PARENT.actDim).fill(1)
			]
		});
		assert.deepEqual(result, {
			rawLogits: [0.25, 1.25],
			reach30Probability: 0.5,
			recoveryProbability: 0
		});
		provider.close();
	} finally {
		for (const name of names) {
			if (prior[name] === undefined) delete process.env[name];
			else process.env[name] = prior[name];
		}
		await server.terminate();
	}
});
