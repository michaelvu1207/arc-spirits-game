import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { sampledPolicyBehavior } from './driver';
import { asNeuralPolicy, RemotePolicy } from './inferenceClient';
import { NeuralPolicy, type PolicyWeights } from './net';

const PYTHON = resolve('ml/.venv/bin/python');
const SERVER = resolve('ml/infer_server.py');
const WEIGHTS = resolve('src/lib/play/ml/policy-weights.json');

async function waitForServer(
	proc: ChildProcessWithoutNullStreams,
	socketPath: string,
	log: () => string
): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) throw new Error(`infer server exited early:\n${log()}`);
		if (existsSync(socketPath) && log().includes('[infer] serving')) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
	throw new Error(`infer server was not ready within 30s:\n${log()}`);
}

describe.skipIf(!existsSync(PYTHON))('RemotePolicy decision memo and wire contract', () => {
	let proc: ChildProcessWithoutNullStreams;
	let dir: string;
	let socketPath: string;
	let fixtureWeights: string;
	let serverLog = '';

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'arc-infer-client-'));
		socketPath = join(dir, 'infer.sock');
		fixtureWeights = join(dir, 'policy-with-reach30.json');
		const fixture = JSON.parse(readFileSync(WEIGHTS, 'utf8')) as PolicyWeights;
		// The live policy has placement but no reach30 head. Reuse the compatible
		// one-output value MLP as a deterministic reach30 fixture so the memo test
		// exercises every base/obs-only field without checking in large weights.
		fixture.reach30 = fixture.value;
		fixture.reach30_horizon = 35;
		writeFileSync(fixtureWeights, JSON.stringify(fixture));
		proc = spawn(
			PYTHON,
			[
				SERVER,
				'--weights',
				fixtureWeights,
				'--socket',
				socketPath,
				'--device',
				'cpu',
				'--window-ms',
				'0',
				'--stats-interval',
				'0'
			],
			{ cwd: process.cwd(), stdio: 'pipe' }
		);
		proc.stdout.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
		proc.stderr.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
		await waitForServer(proc, socketPath, () => serverLog);
	}, 35_000);

	afterAll(async () => {
		if (proc && proc.exitCode === null) {
			proc.kill('SIGTERM');
			await new Promise<void>((resolveExit) => proc.once('exit', () => resolveExit()));
		}
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	for (const wire of ['json', 'binary'] as const) {
		it(`reuses one authoritative ${wire} response across re-quantized policy calls`, () => {
			const weights = JSON.parse(readFileSync(fixtureWeights, 'utf8')) as PolicyWeights;
			const local = new NeuralPolicy(weights);
			const remote = new RemotePolicy(socketPath, {
				expectObsDim: weights.obs_dim,
				wire
			});
			try {
				expect(remote.info.weights_sha256).toBe(
					createHash('sha256').update(readFileSync(fixtureWeights)).digest('hex')
				);
				expect(remote.wireFormat).toBe(wire);
				expect(remote.info.aux.placement).toBe(true);
				expect(remote.info.aux.reach30).toBe(true);
				const obs = Array.from({ length: weights.obs_dim }, (_, i) =>
					Math.fround(Math.sin(i * 0.37) * 0.5)
				);
				const cands = Array.from({ length: 4 }, (_, row) =>
					Array.from({ length: weights.act_dim }, (_, col) =>
						Math.fround(Math.cos(row * 1.7 + col * 0.11) * 0.25)
					)
				);

				const prefetched = remote.scoreCandidates(obs, cands);
				expect(remote.scoringRequests).toBe(1);
				expect(prefetched).toHaveLength(cands.length);
				expect(prefetched.every(Number.isFinite)).toBe(true);
				const localLogits = local.scoreCandidates(obs, cands);
				for (let i = 0; i < prefetched.length; i++) {
					expect(prefetched[i]).toBeCloseTo(localLogits[i], 4);
				}

				// This mirrors withPickObserver: newly allocated float32 arrays with
				// identical content, and a progress-guard subset of the prefetched rows.
				const support = [0, 2];
				const copiedObs = Array.from(Float32Array.from(obs));
				const copiedSupport = support.map((i) => Array.from(Float32Array.from(cands[i])));
				const rand = () => 0.42;
				const chosen = remote.pick(copiedObs, copiedSupport, {
					sample: true,
					temperature: 0.55,
					rand
				});
				const localChosen = local.pick(copiedObs, copiedSupport, {
					sample: true,
					temperature: 0.55,
					rand
				});
				expect(chosen).toBe(localChosen);

				const value = remote.value(Array.from(copiedObs));
				expect(value).toBeCloseTo(local.value(obs), 4);
				const placement = remote.placementProbs(Array.from(copiedObs));
				const localPlacement = local.placementProbs(obs)!;
				expect(placement).not.toBeNull();
				expect(placement).toHaveLength(4);
				expect(placement!.reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 12);
				for (let i = 0; i < 4; i++) expect(placement![i]).toBeCloseTo(localPlacement[i], 4);
				const reach30 = remote.reach30Probability(Array.from(copiedObs));
				expect(reach30).toBeCloseTo(local.reach30Probability(obs)!, 4);
				expect(remote.reach30Horizon()).toBe(35);

				const behavior = sampledPolicyBehavior(
					asNeuralPolicy(remote),
					Array.from(copiedObs),
					cands.map((row) => Array.from(row)),
					support,
					support[chosen],
					0.55
				);
				expect(behavior).not.toBeNull();
				const cachedProbs = remote.probs(copiedObs, copiedSupport, 0.55);
				expect(Math.exp(behavior!.logpOld)).toBeCloseTo(cachedProbs[chosen], 14);
				// Prefetch, sampled pick, behavior reconstruction, value, reach30, and placement
				// must all refer to the exact same scoring response.
				expect(remote.scoringRequests).toBe(1);

				const changedObs = Array.from(copiedObs);
				changedObs[0] = Math.fround(changedObs[0] + 0.125);
				remote.scoreCandidates(changedObs, copiedSupport);
				expect(remote.scoringRequests).toBe(2);

				const obsBatch = [
					Array.from(copiedObs),
					Array.from(changedObs),
					Array.from(changedObs, (value, i) => (i === 1 ? Math.fround(value - 0.25) : value))
				];
				const batchReach30 = remote.reach30Probabilities(obsBatch);
				expect(remote.scoringRequests).toBe(3);
				expect(batchReach30).toHaveLength(obsBatch.length);
				const localBatchReach30 = local.reach30Probabilities(obsBatch);
				for (let i = 0; i < batchReach30.length; i++) {
					expect(batchReach30[i]).toBeCloseTo(localBatchReach30[i]!, 4);
				}
				expect(() =>
					remote.reach30Probabilities([Array.from(copiedObs), copiedObs.slice(1)])
				).toThrow(/observation row 1.*expected/);
				expect(remote.scoringRequests).toBe(3);
				expect(() => remote.scoreCandidates(copiedObs, [])).toThrow(/candidate set 0 is empty/);
				expect(remote.scoringRequests).toBe(3);
			} finally {
				remote.close();
			}
		}, 30_000);
	}

	it('serves an older action-prefix checkpoint when the client appends zero-default semantics', () => {
		const weights = JSON.parse(readFileSync(fixtureWeights, 'utf8')) as PolicyWeights;
		const local = new NeuralPolicy(weights);
		const remote = new RemotePolicy(socketPath, {
			expectObsDim: weights.obs_dim,
			wire: 'json'
		});
		try {
			const obs = Array.from({ length: weights.obs_dim }, (_, i) => Math.fround(i / 100));
			const prefix = Array.from({ length: 3 }, (_, row) =>
				Array.from({ length: weights.act_dim }, (_, col) => Math.fround((row - col) / 50))
			);
			const widened = prefix.map((row, index) => [
				...row,
				...Array.from({ length: 20 }, (_, tail) => Math.fround((index + tail + 1) / 20))
			]);
			const remoteLogits = remote.scoreCandidates(obs, widened);
			const prefixLogits = local.scoreCandidates(obs, prefix);
			for (let i = 0; i < remoteLogits.length; i++) {
				expect(remoteLogits[i]).toBeCloseTo(prefixLogits[i], 4);
			}
			expect(remote.scoringRequests).toBe(1);
			expect(remote.probs(obs, widened)).toHaveLength(widened.length);
			expect(remote.scoringRequests).toBe(1);
		} finally {
			remote.close();
		}
	}, 30_000);
});
