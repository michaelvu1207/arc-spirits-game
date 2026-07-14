import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { profileFor } from '../server/botPolicy';
import { nextInt } from '../rng';
import { SEAT_COLORS, type SeatColor } from '../types';
import {
	forkContinuationPickRng,
	isContinuationCaptureBoundary,
	isStrategicCommand,
	isStrategicDecision,
	playRecordingGame,
	sampledPolicyBehavior,
	deterministicRoundOptionRandom,
	type ContinuationSnapshot,
	type Sample
} from './driver';
import { loadPolicyWeights, NeuralPolicy, type PolicyWeights } from './net';
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

function optionPolicy(seed = 1): NeuralPolicy {
	const raw = jsonRoundTrip(randomPolicy(seed).w) as PolicyWeights;
	raw.option_dim = 4;
	raw.trunk[0].W = raw.trunk[0].W.map((row) => [...row, 0, 0, 0, 0]);
	raw.value[0].W = raw.value[0].W.map((row) => [...row, 0, 0, 0, 0]);
	raw.option = [
		{
			W: Array.from({ length: 64 }, () => Array(raw.obs_dim).fill(0)),
			b: Array(64).fill(0)
		},
		{
			W: Array.from({ length: 4 }, () => Array(64).fill(0)),
			b: [0, 0, 0, 0]
		}
	];
	raw.option_value = [
		{
			W: Array.from({ length: 64 }, () => Array(raw.obs_dim).fill(0)),
			b: Array(64).fill(0)
		},
		{ W: [Array(64).fill(0)], b: [0] }
	];
	return loadPolicyWeights(raw);
}

function jsonRoundTrip<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function withoutEpisodeIdentity(sample: Sample): Omit<Sample, 'gameId' | 'stepIdx'> {
	const { gameId: _gameId, stepIdx: _stepIdx, ...rest } = sample;
	return rest;
}

let continuationFixturePromise:
	| Promise<{
			catalog: Awaited<ReturnType<typeof loadOrSnapshotCatalog>>;
			policy: NeuralPolicy;
			source: ReturnType<typeof playRecordingGame>;
			snapshot: ContinuationSnapshot;
	  }>
	| undefined;

function continuationFixture() {
	continuationFixturePromise ??= (async () => {
		const catalog = await loadOrSnapshotCatalog();
		const policy = randomPolicy(9140);
		const source = playRecordingGame(catalog, {
			seed: 77140,
			profiles: [profileFor('medium')],
			maxRounds: 30,
			policy,
			neuralSeats: ['Red'],
			recordSeats: ['Red'],
			selection: 'policy',
			sample: true,
			temperature: 0.65,
			denseVpReward: true,
			potentialShapingMode: 'policy-invariant',
			maxStatusLevel: 2,
			strategicDecisionScope: 'engine-cycle',
			captureContinuationRounds: [12]
		});
		const snapshot = source.continuationSnapshots[0];
		if (!snapshot) throw new Error('continuation fixture did not reach round 12');
		return { catalog, policy, source, snapshot };
	})();
	return continuationFixturePromise;
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

	it('runs a true solo trajectory without immediately ending or corrupting into Fallen', async () => {
		const catalog = await loadOrSnapshotCatalog();
		const result = playRecordingGame(catalog, {
			seed: 77124,
			profiles: [profileFor('medium')],
			maxRounds: 12,
			policy: randomPolicy(9124),
			neuralSeats: ['Red'],
			recordSeats: ['Red'],
			selection: 'policy',
			sample: true,
			temperature: 0.65,
			denseVpReward: true,
			maxStatusLevel: 2,
			strategicDecisionScope: 'engine-cycle'
		});

		expect(result.rounds).toBeGreaterThan(1);
		expect(result.samples.length).toBeGreaterThan(5);
		expect(result.samples.every((row) => row.playerCount === 1)).toBe(true);
		expect(result.finalState!.players.Red!.statusLevel).toBeLessThanOrEqual(2);
	}, 30_000);

	it('samples one independent persistent option per recorded seat and round', async () => {
		const catalog = await loadOrSnapshotCatalog();
		const policy = optionPolicy(9150);
		const run = (seats: SeatColor[], seed: number) =>
			playRecordingGame(catalog, {
				seed,
				profiles: seats.map(() => profileFor('medium')),
				maxRounds: 2,
				policy,
				neuralSeats: seats,
				recordSeats: seats,
				selection: 'policy',
				sample: true,
				temperature: 0.65
			});

		const solo = run(['Red'], 77150);
		expect(solo.optionEvents.length).toBeGreaterThan(0);
		expect(solo.optionEvents.every((event) => event.behaviorMask.join(',') === '1,1,1,0')).toBe(
			true
		);
		expect(solo.optionEvents.every((event) => event.optionId >= 0 && event.optionId <= 2)).toBe(
			true
		);
		expect(new Set(solo.optionEvents.map((event) => event.eventId)).size).toBe(
			solo.optionEvents.length
		);
		for (const event of solo.optionEvents) {
			const governedRows = solo.samples.filter(
				(sample) =>
					sample.gameId === event.gameId &&
					sample.seat === event.seat &&
					sample.round === event.round
			).length;
			expect(event.lowLevelDecisionCount).toBe(governedRows);
		}
		for (const row of solo.samples) {
			const event = solo.optionEvents.find(
				(candidate) => candidate.gameId === row.gameId && candidate.round === row.round
			);
			expect(event).toBeDefined();
			expect(row.optionId).toBe(event!.optionId);
		}
		const serializedDir = mkdtempSync(join(tmpdir(), 'arc-option-seat-jsonl-'));
		try {
			const file = join(serializedDir, 'shard-0.jsonl');
			appendSamples(file, solo.samples.slice(0, 1));
			const serialized = JSON.parse(readFileSync(file, 'utf8')) as {
				seat?: string;
				optionId?: number;
			};
			expect(serialized.seat).toBe('Red');
			expect(serialized.optionId).toBe(solo.samples[0].optionId);
		} finally {
			rmSync(serializedDir, { recursive: true, force: true });
		}
		const repeated = run(['Red'], 77150);
		expect(repeated.optionEvents).toEqual(solo.optionEvents);
		expect(repeated.samples).toEqual(solo.samples);

		const twoSeat = run(['Red', 'Blue'], 77151);
		expect(new Set(twoSeat.optionEvents.map((event) => event.seat))).toEqual(
			new Set(['Red', 'Blue'])
		);
		expect(twoSeat.optionEvents.every((event) => event.behaviorMask.join(',') === '1,1,1,1')).toBe(
			true
		);
		expect(deterministicRoundOptionRandom(77151, 'Red', 1)).not.toBe(
			deterministicRoundOptionRandom(77151, 'Blue', 1)
		);
	}, 30_000);

	it('JSON-restores an exact late-state suffix with all RNG cursors and fresh episode identity', async () => {
		const { catalog, policy, source, snapshot } = await continuationFixture();
		const restored = jsonRoundTrip(snapshot);

		for (const key of ['botRng', 'pickRng'] as const) {
			const originalRng = { ...snapshot[key] };
			const restoredRng = { ...restored[key] };
			expect(nextInt(restoredRng, 1_000_000)).toBe(nextInt(originalRng, 1_000_000));
		}
		const originalEnvironmentRng = { ...snapshot.state.rng };
		const restoredEnvironmentRng = { ...restored.state.rng };
		expect(nextInt(restoredEnvironmentRng, 1_000_000)).toBe(
			nextInt(originalEnvironmentRng, 1_000_000)
		);

		const replay = playRecordingGame(catalog, {
			seed: snapshot.sourceSeed,
			episodeId: 'continuation-exact-r12-f0',
			profiles: [profileFor('medium')],
			maxRounds: 30,
			policy,
			neuralSeats: ['Red'],
			recordSeats: ['Red'],
			selection: 'policy',
			sample: true,
			temperature: 0.65,
			denseVpReward: true,
			potentialShapingMode: 'policy-invariant',
			maxStatusLevel: 2,
			strategicDecisionScope: 'engine-cycle',
			continuation: { snapshot: restored }
		});

		const sourceSuffix = source.samples.filter((sample) => (sample.round ?? 0) >= snapshot.round);
		expect(replay.finalState).toEqual(source.finalState);
		expect(replay.finalVP).toEqual(source.finalVP);
		expect(replay.stalled).toBe(source.stalled);
		expect(replay.samples.map(withoutEpisodeIdentity)).toEqual(
			sourceSuffix.map(withoutEpisodeIdentity)
		);
		expect(replay.samples.map((sample) => sample.stepIdx)).toEqual(
			replay.samples.map((_, index) => index)
		);
		expect(
			replay.samples.every((sample) => sample.gameId === 'continuation-exact-r12-f0-Red')
		).toBe(true);
		expect(replay.samples[0].round).toBe(12);
		expect(replay.samples.slice(0, -1).every((sample) => sample.reach30Target === undefined)).toBe(
			true
		);
		const terminal = replay.samples.at(-1)!;
		expect(terminal.round).toBeLessThanOrEqual(30);
		expect(terminal.endRound).toBe(Math.min(replay.rounds, 30));
		expect(terminal.reach30Horizon).toBe(30);
		expect(terminal.reach30Target).toBe(!replay.stalled && replay.finalVP.Red >= 30 ? 1 : 0);
		expect(terminal.objectiveDone).toBe(1);
		expect(terminal.finalVP).toBe(replay.finalVP.Red);
	}, 60_000);

	it('creates deterministic independent pick-RNG forks and keeps continuation IDs distinct', async () => {
		const { catalog, policy, snapshot } = await continuationFixture();
		const forkA = forkContinuationPickRng(snapshot, 'a');
		const forkAAgain = forkContinuationPickRng(snapshot, 'a');
		const forkB = forkContinuationPickRng(snapshot, 'b');
		expect(forkA).toEqual(forkAAgain);
		expect(forkB).not.toEqual(forkA);
		expect(snapshot.pickRng).not.toEqual(forkA);

		const run = (episodeId: string, pickRng: typeof forkA) =>
			playRecordingGame(catalog, {
				seed: snapshot.sourceSeed,
				episodeId,
				profiles: [profileFor('medium')],
				maxRounds: 30,
				policy,
				neuralSeats: ['Red'],
				recordSeats: ['Red'],
				selection: 'policy',
				sample: true,
				temperature: 0.65,
				denseVpReward: true,
				potentialShapingMode: 'policy-invariant',
				maxStatusLevel: 2,
				strategicDecisionScope: 'engine-cycle',
				continuation: { snapshot, pickRng }
			});
		const a = run('continuation-r12-fork-a', forkA);
		const b = run('continuation-r12-fork-b', forkB);
		expect(new Set([...a.samples, ...b.samples].map((sample) => sample.gameId))).toEqual(
			new Set(['continuation-r12-fork-a-Red', 'continuation-r12-fork-b-Red'])
		);
	}, 60_000);

	it('fails closed on unsafe or ambiguous continuation states', async () => {
		const { catalog, policy, snapshot } = await continuationFixture();
		const base = {
			seed: snapshot.sourceSeed,
			episodeId: 'invalid-continuation',
			profiles: [profileFor('medium')],
			maxRounds: 30,
			policy,
			neuralSeats: ['Red'] as SeatColor[],
			recordSeats: ['Red'] as SeatColor[],
			selection: 'policy' as const,
			sample: true,
			temperature: 0.65
		};

		expect(() =>
			playRecordingGame(catalog, {
				...base,
				episodeId: undefined,
				continuation: { snapshot }
			})
		).toThrow(/explicit unique episodeId/);
		expect(() =>
			playRecordingGame(catalog, {
				...base,
				seed: snapshot.sourceSeed + 1,
				continuation: { snapshot }
			})
		).toThrow(/does not match snapshot sourceSeed/);
		expect(() =>
			playRecordingGame(catalog, {
				...base,
				maxRounds: 29,
				continuation: { snapshot }
			})
		).toThrow(/horizon 30 does not match effective rollout horizon 29/);
		expect(() =>
			playRecordingGame(catalog, {
				...base,
				chooser: () => 0,
				continuation: { snapshot }
			})
		).toThrow(/does not support opaque chooser or searcher/);

		const midPhase = jsonRoundTrip(snapshot);
		midPhase.state.phase = 'location';
		expect(() =>
			playRecordingGame(catalog, { ...base, continuation: { snapshot: midPhase } })
		).toThrow(/active, winner-free navigation state/);

		const unresolved = jsonRoundTrip(snapshot);
		unresolved.state.players.Red!.pendingDecisions.push({
			id: 'pending-test',
			source: 'class',
			kind: 'choose_option',
			prompt: 'test',
			options: []
		});
		expect(isContinuationCaptureBoundary(snapshot.state, ['Red'])).toBe(true);
		expect(isContinuationCaptureBoundary(unresolved.state, ['Red'])).toBe(false);
		expect(() =>
			playRecordingGame(catalog, { ...base, continuation: { snapshot: unresolved } })
		).toThrow(/unresolved player work/);

		const badRng = jsonRoundTrip(snapshot);
		badRng.pickRng.cursor = -1;
		expect(() =>
			playRecordingGame(catalog, { ...base, continuation: { snapshot: badRng } })
		).toThrow(/invalid external RNG cursor/);

		const malformed = jsonRoundTrip(snapshot);
		delete (malformed.state as Partial<ContinuationSnapshot['state']>).combats;
		expect(() =>
			playRecordingGame(catalog, { ...base, continuation: { snapshot: malformed } })
		).toThrow(/malformed game-state shape/);

		expect(() =>
			playRecordingGame(catalog, {
				...base,
				continuation: undefined,
				captureContinuationRounds: [11]
			})
		).toThrow(/rounds 12\.\.20/);
	}, 30_000);

	it('records actor-time reach30 predictions and resolves a clean solo cap failure', async () => {
		const catalog = await loadOrSnapshotCatalog();
		const policy = randomPolicy(9130);
		policy.w.reach30 = [{ W: [new Array<number>(policy.w.obs_dim).fill(0)], b: [Math.log(3)] }]; // sigmoid(log(3)) = 0.75
		policy.w.reach30_horizon = 1;
		const result = playRecordingGame(catalog, {
			seed: 77130,
			profiles: [profileFor('medium')],
			maxRounds: 1,
			policy,
			neuralSeats: ['Red'],
			recordSeats: ['Red'],
			selection: 'policy',
			sample: true,
			temperature: 0.65,
			denseVpReward: true,
			maxStatusLevel: 2,
			strategicDecisionScope: 'engine-cycle'
		});
		expect(result.stalled).toBe(false);
		expect(result.samples.length).toBeGreaterThan(0);
		for (const row of result.samples) expect(row.reach30Pred).toBeCloseTo(0.75, 12);
		expect(result.samples.slice(0, -1).every((row) => row.reach30Target === undefined)).toBe(true);
		expect(result.samples.at(-1)!.reach30Target).toBe(0);
		expect(result.samples.at(-1)!.reach30Horizon).toBe(1);
		expect(result.samples.at(-1)!.objectiveDone).toBe(1);
		expect(result.samples.at(-1)!.finalVP).toBe(result.finalVP.Red);
		expect(result.samples.at(-1)!.endRound).toBe(1);
		expect(result.samples.at(-1)!.done).toBe(false);
	}, 30_000);

	it('preserves outcome-head telemetry through the v2 fixed-observation shim', async () => {
		const catalog = await loadOrSnapshotCatalog();
		const policy = {
			scoreCandidates: (_obs: number[], cands: number[][]) => cands.map(() => 0),
			probs: (_obs: number[], cands: number[][]) => cands.map(() => 1 / cands.length),
			pick: (
				_obs: number[],
				cands: number[][],
				opts?: { rand?: () => number }
			) => Math.min(cands.length - 1, Math.floor((opts?.rand?.() ?? 0) * cands.length)),
			value: (_obs: number[]) => 0,
			farmValue: (_obs: number[]) => 0,
			placementProbs: (_obs: number[]) => [0.1, 0.2, 0.3, 0.4],
			reach30Probability: (_obs: number[]) => 0.625,
			reach30Horizon: () => 1,
			routeMode: (_obs: number[]) => null,
			rewardPickScores: (_obs: number[], _cands: number[][]) => null,
			rewardPickProbs: (_obs: number[], _cands: number[][]) => null
		} as unknown as NeuralPolicy;
		const result = playRecordingGame(catalog, {
			seed: 77_132,
			profiles: [profileFor('medium')],
			maxRounds: 1,
			policy,
			neuralSeats: ['Red'],
			recordSeats: ['Red'],
			selection: 'policy',
			sample: true,
			temperature: 0.55,
			obsVersion: 2,
			policyObsVersion: 2
		});
		expect(result.samples.length).toBeGreaterThan(0);
		for (const row of result.samples) {
			expect(row.reach30Pred).toBe(0.625);
			expect(row.placementProbs).toEqual([0.1, 0.2, 0.3, 0.4]);
		}
		expect(result.samples.at(-1)!.reach30Horizon).toBe(1);
	}, 30_000);

	it('rejects a reach30 behavior baseline trained for a different horizon', async () => {
		const catalog = await loadOrSnapshotCatalog();
		const policy = randomPolicy(9131);
		policy.w.reach30 = [{ W: [new Array<number>(policy.w.obs_dim).fill(0)], b: [0] }];
		policy.w.reach30_horizon = 35;
		expect(() =>
			playRecordingGame(catalog, {
				seed: 77131,
				profiles: [profileFor('medium')],
				maxRounds: 1,
				policy,
				neuralSeats: ['Red'],
				recordSeats: ['Red'],
				selection: 'policy',
				sample: true,
				temperature: 0.65,
				denseVpReward: true
			})
		).toThrow(/does not match effective rollout horizon 1/);
	}, 30_000);

	it('retains a real terminal row with exact behavior metadata and intermediate dense rewards', async () => {
		const catalog = await loadOrSnapshotCatalog();
		const policy = randomPolicy(9123);
		const result = playRecordingGame(catalog, {
			// Seed 11 exercises a complete game with the full Benefits action surface.
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
		expect(result.samples.every((row) => row.reach30Target === undefined)).toBe(true);
		expect(terminal.done).toBe(true);
		expect(terminal.policyMask === 0 || terminal.policyMask === 1).toBe(true);
		expect(terminal.logpOld === undefined).toBe(terminal.policyMask === 0);
		expect(terminal.vPred).toEqual(expect.any(Number));
		expect(terminal.playerCount).toBe(SEAT_COLORS.length);
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
				playerCount: 1,
				placementProbs: [0.6, 0.25, 0.1, 0.05],
				reach30Pred: 0.42,
				reach30Target: 0,
				reach30Horizon: 35,
				objectiveDone: 1,
				finalVP: 29,
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
					reach30Pred: number;
					reach30Target: number;
					reach30Horizon: number;
					objectiveDone: number;
					finalVP: number;
				};
				expect(serialized.obs).toEqual(obs);
				expect(serialized.cands).toEqual(cands);
				expect(serialized.policyMask).toBe(1);
				expect(serialized.decisionType).toBe('lockNavigation');
				expect(serialized.strategic).toBe(1);
				expect(serialized.placementProbs).toEqual([0.6, 0.25, 0.1, 0.05]);
				expect(serialized.reach30Pred).toBe(0.42);
				expect(serialized.reach30Target).toBe(0);
				expect(serialized.reach30Horizon).toBe(35);
				expect(serialized.objectiveDone).toBe(1);
				expect(serialized.finalVP).toBe(29);

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
