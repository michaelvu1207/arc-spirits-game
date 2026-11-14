/**
 * Scale: the run-wide call gate (concurrency cap, back-off on rate/usage limits) and several
 * games running at once in one process with one shared gate and budget. Offline.
 *
 *   npx vitest run src/lib/play/agents/scale.test.ts
 */

import { describe, expect, it } from 'vitest';
import { BudgetGuard } from './budget';
import { CallGate, isRateLimitError } from './callGate';
import { loadFrozenCatalog } from './catalog';
import { LlmSeatController } from './llmSeat';
import { MockProvider } from './providers/mock';
import { ProviderError } from './providers/types';
import { buildRulesBrief } from './rulesBrief';
import { runAgentGame } from './runner';
import { MemorySink, replayTranscript } from './transcript';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('call gate', () => {
	it('never runs more calls at once than its cap', async () => {
		const gate = new CallGate({ maxConcurrent: 3 });
		let live = 0;
		let peak = 0;
		await Promise.all(
			Array.from({ length: 20 }, () =>
				gate.run(async () => {
					live += 1;
					peak = Math.max(peak, live);
					await tick();
					live -= 1;
				})
			)
		);
		expect(peak).toBe(3);
		expect(gate.stats).toMatchObject({ calls: 20, maxInFlight: 3, rateLimited: 0 });
	});

	it('backs off on a rate/usage limit, pauses everyone, then retries the same call', async () => {
		const pauses: number[] = [];
		const gate = new CallGate({
			maxConcurrent: 2,
			baseBackoffMs: 1000,
			sleep: async (ms) => {
				pauses.push(ms);
			},
			random: () => 0.5
		});
		let failuresLeft = 2;
		const result = await gate.run(async () => {
			if (failuresLeft-- > 0)
				throw new ProviderError('codex exit 1: usage limit reached', 1, false);
			return 'ok';
		});
		expect(result).toBe('ok');
		expect(gate.stats.rateLimited).toBe(2);
		// 1 s, then 2 s (doubled), each waited before the retry.
		expect(pauses.length).toBe(2);
		expect(pauses[0]).toBeGreaterThan(500);
		expect(pauses[1]).toBeGreaterThan(pauses[0]);
	});

	it('passes other errors through at once and gives up after the retry limit', async () => {
		const gate = new CallGate({ maxConcurrent: 1, maxRateRetries: 2, sleep: async () => {} });
		await expect(gate.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
		let calls = 0;
		await expect(
			gate.run(async () => {
				calls += 1;
				throw new ProviderError('HTTP 429', 429, true);
			})
		).rejects.toThrow('429');
		expect(calls).toBe(3);
		expect(isRateLimitError(new Error('Too Many Requests'))).toBe(true);
		expect(isRateLimitError(new Error('stream disconnected'))).toBe(false);
	});
});

describe('adaptive call gate', () => {
	it('lowers the live cap once per limit wave, raises it again with successes, and can be raised', async () => {
		const gate = new CallGate({
			maxConcurrent: 8,
			adaptive: true,
			minConcurrent: 2,
			baseBackoffMs: 1,
			sleep: async () => {},
			random: () => 0.5
		});
		let failuresLeft = 8;
		let inFlight = 0;
		let peakAfterCut = 0;
		const call = () =>
			gate.run(async () => {
				inFlight += 1;
				if (gate.stats.capCuts > 0) peakAfterCut = Math.max(peakAfterCut, inFlight);
				await new Promise((r) => setTimeout(r, 2));
				inFlight -= 1;
				if (failuresLeft-- > 0) throw new ProviderError('gw 429: rate limit', 429, true);
				return 'ok';
			});
		const results = await Promise.all(Array.from({ length: 40 }, call));
		expect(results.every((r) => r === 'ok')).toBe(true);
		expect(gate.stats.capCuts).toBeGreaterThanOrEqual(1);
		expect(gate.stats.lowestCap).toBeLessThanOrEqual(6);
		expect(gate.stats.lastLimitError).toMatch(/429/);
		expect(gate.liveCap).toBeGreaterThan(gate.stats.lowestCap);
		gate.setMaxConcurrent(16);
		expect(gate.maxConcurrent).toBe(16);
		expect(gate.liveCap).toBeLessThanOrEqual(16);
		expect(gate.liveCap).toBeGreaterThan(8 - 8 + gate.stats.lowestCap);
	});
});

describe('call gate rate (token bucket)', () => {
	it('spreads call starts at the rate after a small burst', async () => {
		const gate = new CallGate({ maxConcurrent: 10, ratePerMin: 3, burst: 1, rateWindowMs: 150 });
		const t0 = Date.now();
		const starts: number[] = [];
		await Promise.all(
			Array.from({ length: 7 }, () =>
				gate.run(async () => {
					starts.push(Date.now() - t0);
				})
			)
		);
		expect(starts).toHaveLength(7);
		// 3 per 150 ms = one start per 50 ms after the first.
		expect(starts[1]).toBeGreaterThanOrEqual(40);
		expect(starts[6]).toBeGreaterThanOrEqual(280);
	});

	it('adaptive rate: a limit hit lowers the rate; quiet windows raise it again', async () => {
		let fail = 1;
		const gate = new CallGate({
			maxConcurrent: 4,
			ratePerMin: 100,
			maxRatePerMin: 120,
			minRatePerMin: 10,
			rateStepPerMin: 10,
			rateWindowMs: 60,
			baseBackoffMs: 1,
			sleep: async () => {},
			random: () => 0.5
		});
		await gate.run(async () => {
			if (fail-- > 0) {
				const e = new ProviderError(
					'gw 429: Codex is at capacity (code=turn_rate_limit_exceeded)',
					429,
					true
				);
				e.retryAfterMs = 1;
				throw e;
			}
			return 1;
		});
		expect(gate.ratePerMin).toBe(80);
		await new Promise((r) => setTimeout(r, 140));
		await gate.run(async () => 1);
		expect(gate.ratePerMin).toBeGreaterThan(80);
		// A real usage limit is not a rate limit: it passes through at once.
		const usage = new ProviderError('gw usage limit: weekly window used up', 429, false);
		usage.usageLimit = true;
		expect(isRateLimitError(usage)).toBe(false);
		await expect(gate.run(async () => Promise.reject(usage))).rejects.toBe(usage);
	});
});

describe('call gate stop', () => {
	it('stops the run after repeated limit failures: later calls fail at once', async () => {
		const gate = new CallGate({
			maxConcurrent: 2,
			maxRateRetries: 1,
			maxLimitFailures: 2,
			sleep: async () => {}
		});
		const limited = () =>
			gate.run(async () => Promise.reject(new ProviderError('HTTP 429', 429, true)));
		await expect(limited()).rejects.toThrow('429');
		expect(gate.stoppedReason).toBeNull();
		await expect(limited()).rejects.toThrow('429');
		expect(gate.stoppedReason).toMatch(/stopped the run: 2 calls gave up/);
		let called = false;
		const err = await gate
			.run(async () => {
				called = true;
			})
			.catch((e) => e);
		expect(called).toBe(false);
		expect(err).toMatchObject({ retryable: false });
	});
});

describe('parallel games', () => {
	it('six games at once share one gate and budget, all finish, and each replays', async () => {
		const catalog = loadFrozenCatalog();
		const brief = buildRulesBrief(catalog);
		const budget = new BudgetGuard({ maxTokens: Infinity, maxCalls: Infinity });
		const gate = new CallGate({ maxConcurrent: 2 });
		const games = await Promise.all(
			Array.from({ length: 6 }, async (_, g) => {
				const sink = new MemorySink();
				const seat = (i: number) =>
					new LlmSeatController({
						provider: new MockProvider({ policy: 'random', seed: g * 10 + i }),
						model: 'random',
						budget,
						gate
					});
				const summary = await runAgentGame({
					catalog,
					catalogInfo: { source: 'frozen', path: 'ml/catalog.json', hash: 'test' },
					seed: 100 + g,
					controllers: [seat(0), seat(1)],
					rulesBrief: brief,
					budget,
					runId: 'par',
					gameIndex: g,
					sink,
					maxDecisions: 60
				});
				return { summary, sink };
			})
		);
		expect(gate.stats.maxInFlight).toBeLessThanOrEqual(2);
		expect(new Set(games.map((x) => x.summary.gameId)).size).toBe(6);
		for (const { summary, sink } of games) {
			expect(summary.decisions).toBe(60);
			expect(replayTranscript(sink.records, catalog).matches).toBe(true);
		}
	}, 120_000);
});

describe('tournament table', () => {
	it('counts wins, the pair matrix and per-game tokens per model', async () => {
		const { tournamentTable } = await import('./report');
		const seat = (s: string, model: string, vp: number) => ({
			seat: s,
			model,
			finalVp: vp,
			monsterKills: 1,
			corruptions: 0,
			pvpAttacks: 0,
			providerCalls: 10,
			latencyMsTotal: 50_000,
			invalidAnswers: 1,
			agentDecisions: 10,
			promptTokens: 1000,
			cachedPromptTokens: 800,
			completionTokens: 100,
			reasoningTokens: 50
		});
		const game = (winner: string, a: string, b: string, rounds: number) =>
			({
				winner,
				rounds,
				seats: [
					seat('Red', a, winner === 'Red' ? 30 : 10),
					seat('Blue', b, winner === 'Blue' ? 30 : 10)
				]
			}) as never;
		const t = tournamentTable([game('Red', 'm1', 'm2', 20), game('Red', 'm2', 'm1', 24)]);
		const m1 = t.rows.find((r) => r.model === 'm1')!;
		expect(m1).toMatchObject({
			games: 2,
			wins: 1,
			winRate: 0.5,
			avgVp: 20,
			avgWinRound: 20,
			illegalAnswerRate: 0.1,
			secondsPerCall: 5
		});
		expect(m1.perGame).toEqual({ input: 1000, cached: 800, output: 100, reasoning: 50 });
		expect(t.matrix).toEqual({ m1: { m2: 1 }, m2: { m1: 1 } });
	});
});
