import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { profileFor } from '../server/botPolicy';
import { SEAT_COLORS, type SeatColor } from '../types';
import {
	isStrategicCommand,
	isStrategicDecision,
	playRecordingGame,
	sampledPolicyBehavior,
	type Sample
} from './driver';
import { NeuralPolicy } from './net';
import { appendSamples, loadOrSnapshotCatalog, randomPolicy } from './nodeIo';

function scalarPolicy(): NeuralPolicy {
	return new NeuralPolicy({
		format: 'arc-cand-scorer-v1',
		obs_dim: 1,
		act_dim: 1,
		// logit = candidate[0]; the observation weight is zero.
		trunk: [{ W: [[0, 1]], b: [0] }],
		value: [{ W: [[0]], b: [0] }]
	});
}

describe('driver PPO behavior distribution', () => {
	it('marks only the navigation strategy skeleton in the first MC ablation', () => {
		expect(isStrategicCommand({ type: 'lockNavigation', destination: 'Arcane Abyss' })).toBe(true);
		expect(isStrategicCommand({ type: 'startCombat' })).toBe(false);
		expect(isStrategicCommand({ type: 'spawnHandSpirit', guid: 'x' })).toBe(false);
		expect(isStrategicCommand({ type: 'passEncounter' })).toBe(false);
	});
	it('can expand long-horizon credit to engine-cycle decision surfaces', () => {
		expect(isStrategicCommand({ type: 'spawnHandSpirit', guid: 'x' }, 'engine-cycle')).toBe(true);
		expect(isStrategicCommand({ type: 'awakenSpirit', slotIndex: 4 }, 'engine-cycle')).toBe(true);
		expect(isStrategicCommand({ type: 'startCombat' }, 'engine-cycle')).toBe(true);
		expect(isStrategicCommand({ type: 'commitBenefits' }, 'engine-cycle')).toBe(false);
		expect(
			isStrategicDecision(
				[{ type: 'commitBenefits' }, { type: 'resolveAwakenReward', relicPicks: [0] }],
				'engine-cycle'
			)
		).toBe(true);
	});
	it('records the sampled temperature and post-progress-filter denominator exactly', () => {
		const policy = scalarPolicy();
		const behavior = sampledPolicyBehavior(policy, [0], [[0], [1], [2]], [0, 2], 2, 0.5);
		const chosenProbability = Math.exp(4) / (1 + Math.exp(4));

		expect(behavior).not.toBeNull();
		expect(behavior!.behaviorMask).toEqual([1, 0, 1]);
		expect(behavior!.behaviorTemperature).toBe(0.5);
		expect(Math.exp(behavior!.logpOld)).toBeCloseTo(chosenProbability, 14);
	});

	it('uses all candidates and temperature one for legacy/default sampled actions', () => {
		const policy = scalarPolicy();
		const behavior = sampledPolicyBehavior(policy, [0], [[0], [1]], [0, 1], 0);
		expect(behavior).toEqual({
			logpOld: -Math.log(1 + Math.exp(1)),
			behaviorTemperature: 1,
			behaviorMask: [1, 1]
		});
	});

	it('rejects malformed support, impossible choices, and non-finite temperatures', () => {
		const policy = scalarPolicy();
		const cands = [[0], [1]];
		expect(sampledPolicyBehavior(policy, [0], cands, [0, 0], 0, 1)).toBeNull();
		expect(sampledPolicyBehavior(policy, [0], cands, [0], 1, 1)).toBeNull();
		expect(sampledPolicyBehavior(policy, [0], cands, [0, 1], 0, Number.NaN)).toBeNull();
	});

	it('stamps only sampled learned-policy decisions, never greedy/custom/search/opponent rows', async () => {
		const catalog = await loadOrSnapshotCatalog();
		const seats = SEAT_COLORS.slice(0, 2) as SeatColor[];
		const policy = randomPolicy(9123);
		const base = {
			seed: 77123,
			profiles: seats.map(() => profileFor('medium')),
			maxRounds: 1,
			policy,
			neuralSeats: seats,
			recordSeats: [seats[0]],
			selection: 'policy' as const
		};

		const sampled = playRecordingGame(catalog, {
			...base,
			sample: true,
			temperature: 0.4
		});
		const sampledPpo = sampled.samples.filter((row) => row.logpOld !== undefined);
		expect(sampledPpo.length).toBeGreaterThan(0);
		for (const row of sampledPpo) {
			expect(row.policyMask).toBe(1);
			expect(row.behaviorTemperature).toBe(0.4);
			expect(row.behaviorMask).toHaveLength(row.cands.length);
			expect(row.behaviorMask![row.chosen]).toBe(1);
			expect(row.strategic).toBe(row.decisionType === 'lockNavigation' ? 1 : 0);
		}

		const greedy = playRecordingGame(catalog, { ...base, sample: false });
		expect(greedy.samples.every((row) => row.logpOld === undefined)).toBe(true);
		expect(greedy.samples.every((row) => row.policyMask === 0 && row.vPred !== undefined)).toBe(
			true
		);

		const custom = playRecordingGame(catalog, {
			...base,
			sample: true,
			chooser: () => 0
		});
		expect(custom.samples.every((row) => row.logpOld === undefined)).toBe(true);
		expect(custom.samples.every((row) => row.policyMask === 0 && row.vPred !== undefined)).toBe(
			true
		);

		const searched = playRecordingGame(catalog, {
			...base,
			sample: true,
			searcher: (_state, _seat, withNext) => ({
				index: 0,
				pi: withNext.map((_, i) => (i === 0 ? 1 : 0))
			})
		});
		expect(searched.samples.every((row) => row.logpOld === undefined)).toBe(true);
		expect(searched.samples.every((row) => row.policyMask === 0 && row.vPred !== undefined)).toBe(
			true
		);

		const opponentSeat = seats[1];
		const opponentOnly = playRecordingGame(catalog, {
			...base,
			recordSeats: [opponentSeat],
			opponentPolicies: { [opponentSeat]: randomPolicy(4567) },
			opponentTemperature: 0.7,
			sample: true
		});
		expect(opponentOnly.samples).toHaveLength(0);
	}, 30_000);

	it('retains a real terminal hybrid-override row and intermediate dense rewards', async () => {
		const catalog = await loadOrSnapshotCatalog();
		const policy = randomPolicy(9123);
		const result = playRecordingGame(catalog, {
			// Seed 11 terminates on a deterministic hybrid override with the complete
			// Benefits action surface. (Seed 3 used to do so only because Cursed Spirit
			// rewards were missing from the neural surface and timed out.)
			seed: 11,
			profiles: SEAT_COLORS.map(() => profileFor('medium')),
			maxRounds: 80,
			policy,
			neuralSeats: ['Red'],
			recordSeats: ['Red'],
			selection: 'hybrid',
			sample: true,
			temperature: 0.4,
			denseVpReward: true
		});
		expect(result.finished).toBe(true);
		expect(result.samples.length).toBeGreaterThan(1);
		expect(result.samples.some((row) => row.rStep !== 0)).toBe(true);
		expect(result.samples.map((row) => row.stepIdx)).toEqual(
			result.samples.map((_, index) => index)
		);

		const terminal = result.samples.at(-1)!;
		expect(terminal.done).toBe(true);
		expect(terminal.policyMask).toBe(0);
		expect(terminal.logpOld).toBeUndefined();
		expect(terminal.vPred).toEqual(expect.any(Number));
	}, 30_000);

	const python = resolve('ml/.venv/bin/python');
	it.skipIf(!existsSync(python))(
		'keeps the initial ratio at one through TypeScript JSONL and the Python loader',
		() => {
			const policy = scalarPolicy();
			const obs = [Math.fround(Math.PI)];
			const cands = [[Math.fround(1 / 3)], [Math.fround(-Math.E)], [Math.fround(Math.SQRT2)]];
			const behavior = sampledPolicyBehavior(policy, obs, cands, [0, 2], 2, 0.37)!;
			const dir = mkdtempSync(join(tmpdir(), 'arc-ppo-jsonl-'));
			const file = join(dir, 'trajectory.jsonl');
			const sample: Sample = {
				obs,
				cands,
				chosen: 2,
				ret: 0,
				seat: 'Red',
				vp: 0,
				phi: 0,
				kill: 0,
				gameId: 'ratio-g0',
				stepIdx: 0,
				rStep: 0,
				done: true,
				decisionType: 'lockNavigation',
				strategic: 1,
				placementProbs: [0.6, 0.25, 0.1, 0.05],
				policyMask: 1,
				vPred: 0,
				...behavior
			};
			try {
				appendSamples(file, [sample]);
				const serialized = JSON.parse(readFileSync(file, 'utf8')) as {
					obs: number[];
					cands: number[][];
					policyMask: number;
					decisionType: string;
					strategic: number;
					placementProbs: number[];
				};
				expect(serialized.obs).toEqual(obs);
				expect(serialized.cands).toEqual(cands);
				expect(serialized.policyMask).toBe(1);
				expect(serialized.decisionType).toBe('lockNavigation');
				expect(serialized.strategic).toBe(1);
				expect(serialized.placementProbs).toEqual([0.6, 0.25, 0.1, 0.05]);

				const code = [
					'import math, sys, torch',
					'from pathlib import Path',
					"sys.path.insert(0, 'ml')",
					'from ppo import behavior_log_probs, load_trajectory_buffer',
					'b = load_trajectory_buffer(Path(sys.argv[1]), 1.0, 1.0, (1.0, 0.3, -0.3, -1.0))',
					'logits = torch.from_numpy(b.cands[0][:, 0]).unsqueeze(0)',
					'mask = torch.from_numpy(b.behavior_mask[0]).unsqueeze(0)',
					'temp = torch.from_numpy(b.behavior_temperature[:1])',
					'new = behavior_log_probs(logits, mask, temp)[0, b.chosen[0]]',
					'print(abs(math.exp(float(new) - float(b.logp_old[0])) - 1.0))'
				].join('\n');
				const result = spawnSync(python, ['-c', code, dir], {
					cwd: process.cwd(),
					encoding: 'utf8'
				});
				expect(result.status, result.stderr).toBe(0);
				const delta = Number(result.stdout.trim().split('\n').at(-1));
				expect(delta).toBeLessThan(2e-6);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		20_000
	);
});
