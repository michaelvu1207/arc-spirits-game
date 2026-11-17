/**
 * Pause and resume: a game that was stopped goes on from its own record, with no answer asked
 * twice; a league can be stopped and started again, and its agent list can change, without
 * losing games. All offline (a provider that always takes the first action; a fake gateway).
 *
 *   npx vitest run src/lib/play/agents/league/resume.test.ts
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BudgetGuard } from '../budget';
import { catalogHash, loadFrozenCatalog } from '../catalog';
import { LlmSeatController } from '../llmSeat';
import { parseOfferedActions } from '../providers/mock';
import type { ChatProvider, ChatRequest, ChatResponse } from '../providers/types';
import { buildRulesBrief } from '../rulesBrief';
import { ResumeMismatchError, runAgentGame } from '../runner';
import { MemorySink, replayTranscript, type DecisionRecord, type TranscriptRecord } from '../transcript';
import { DEFAULT_LEAGUE_CONFIG, type LeagueConfig } from './config';
import { League } from './league';
import { resumableRecords } from './resume';

const catalog = loadFrozenCatalog();
const brief = buildRulesBrief(catalog);
const catalogInfo = { source: 'frozen', path: 'ml/catalog.json', hash: catalogHash(catalog) };
const tempDirs: string[] = [];
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), 'league-resume-'));
	tempDirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Always the first offered action (so a game is the same every time); counts calls and restored turns. */
class FirstProvider implements ChatProvider {
	readonly name = 'test';
	calls = 0;
	remembered: { key: string; user: string; assistant: string }[] = [];
	estimateCostUsd(): Promise<number> {
		return Promise.resolve(0);
	}
	remember(key: string, user: string, assistant: string): void {
		this.remembered.push({ key, user, assistant });
	}
	async complete(request: ChatRequest): Promise<ChatResponse> {
		this.calls += 1;
		const last = request.messages.at(-1)!.content;
		const id = parseOfferedActions(last)[0]?.id;
		return {
			text: JSON.stringify({ action: id, reason: 'first' }),
			promptTokens: 100,
			completionTokens: 10,
			costUsd: 0,
			costEstimated: false
		};
	}
}

const seats = (provider: ChatProvider) =>
	[0, 1, 2, 3].map(
		(i) => new LlmSeatController({ provider, model: 'm', budget: new BudgetGuard(), label: `s${i}`, memory: 'history' })
	);

const play = async (opts: {
	provider: FirstProvider;
	maxDecisions: number;
	resume?: TranscriptRecord[];
	pauseAfter?: number;
}) => {
	const sink = new MemorySink();
	const pause = new AbortController();
	let seen = 0;
	const summary = await runAgentGame({
		catalog,
		catalogInfo,
		seed: 11,
		controllers: seats(opts.provider),
		rulesBrief: brief,
		budget: new BudgetGuard(),
		runId: 'resume',
		maxDecisions: opts.maxDecisions,
		sink,
		pause: pause.signal,
		...(opts.resume ? { resume: { records: opts.resume } } : {}),
		onDecision: () => {
			if (opts.pauseAfter && ++seen >= opts.pauseAfter) pause.abort();
		}
	});
	return { summary, records: sink.records };
};

const decisionsOf = (records: TranscriptRecord[]) =>
	records.filter((r): r is DecisionRecord => r.type === 'decision');
const asked = (records: TranscriptRecord[]) =>
	records.reduce((n, r) => n + (r.type === 'decision' || r.type === 'stale' ? r.attempts.length : 0), 0);

describe('resume one game', () => {
	it('a paused game goes on to the same end as a game that was never stopped, with no call made twice', async () => {
		const whole = new FirstProvider();
		const full = await play({ provider: whole, maxDecisions: 220 });
		expect(full.summary.decisions).toBe(220);

		const first = new FirstProvider();
		const part = await play({ provider: first, maxDecisions: 220, pauseAfter: 90 });
		expect(part.summary.stopReason).toBe('paused');
		expect(part.summary.decisions).toBeGreaterThanOrEqual(90);
		expect(part.summary.decisions).toBeLessThan(100);

		const usable = resumableRecords(part.records)!;
		expect(usable.some((r) => r.type === 'result')).toBe(false);
		const second = new FirstProvider();
		const rest = await play({ provider: second, maxDecisions: 220, resume: usable });
		expect(rest.summary.stopReason).toBe(full.summary.stopReason);
		expect(rest.summary.finalStateHash).toBe(full.summary.finalStateHash);
		expect(rest.summary.resumedDecisions).toBe(part.summary.decisions);
		// The two halves made exactly the calls of the whole game.
		expect(first.calls + second.calls).toBe(whole.calls);
		expect(second.calls).toBe(asked(rest.records) - asked(usable));
		// Each seat got its earlier turns back, in order, as it saw them.
		expect(second.remembered.length).toBe(asked(usable));
		const red = decisionsOf(usable).filter((r) => r.seat === 'Red' && r.attempts.length);
		const back = second.remembered.filter((t) => t.key.endsWith(':Red'));
		expect(back.slice(0, 3).map((t) => t.user)).toEqual(red.slice(0, 3).map((r) => r.prompt));
		// The new transcript is a whole game: it replays to its own final state.
		const replay = replayTranscript(rest.records, catalog);
		expect(replay.finalStateHash).toBe(rest.summary.finalStateHash);
		// Token totals count the recorded part too.
		const sum = (s: typeof full.summary) => s.seats.reduce((n, x) => n + x.promptTokens, 0);
		expect(sum(rest.summary)).toBe(sum(full.summary));
	});

	it('a game cut off anywhere (also inside a round of secret choices) goes on to the same end', async () => {
		const full = await play({ provider: new FirstProvider(), maxDecisions: 160 });
		const cuts = [7, 23, 58, 101, 131].map((n) => {
			// Cut after the n-th decision or stale record, wherever that falls.
			let seen = 0;
			const at = full.records.findIndex((r) => (r.type === 'decision' || r.type === 'stale') && ++seen === n);
			return full.records.slice(0, at + 1);
		});
		for (const prefix of cuts) {
			const rest = await play({ provider: new FirstProvider(), maxDecisions: 160, resume: prefix });
			expect(rest.summary.finalStateHash).toBe(full.summary.finalStateHash);
			expect(rest.summary.decisions).toBe(160);
		}
	});

	it('a record that no longer leads to the same game is refused', async () => {
		const full = await play({ provider: new FirstProvider(), maxDecisions: 60 });
		const records = structuredClone(full.records);
		const d = decisionsOf(records).find((r) => !r.forced && r.actions.length > 1)!;
		d.chosen = { ...d.actions[1] };
		await expect(play({ provider: new FirstProvider(), maxDecisions: 60, resume: records })).rejects.toThrow(
			ResumeMismatchError
		);
		// A record made before state hashes were written is checked by what the seats were shown.
		for (const r of decisionsOf(records)) delete r.stateHash;
		await expect(play({ provider: new FirstProvider(), maxDecisions: 60, resume: records })).rejects.toThrow(
			ResumeMismatchError
		);
		const old = structuredClone(full.records);
		for (const r of decisionsOf(old)) delete r.stateHash;
		const again = await play({ provider: new FirstProvider(), maxDecisions: 60, resume: old.slice(0, 40) });
		expect(again.summary.finalStateHash).toBe(full.summary.finalStateHash);
	});

	it('provider errors: the record is cut before the failing seat`s unanswered decisions', () => {
		const dec = (n: number, seat: string, failed: boolean) =>
			({
				type: 'decision', n, seat, forced: false, phaseCapped: false, fallback: failed,
				attempts: [{ providerError: failed }]
			}) as unknown as TranscriptRecord;
		const records = [
			{ type: 'header' } as unknown as TranscriptRecord,
			dec(1, 'Red', false), dec(2, 'Blue', true), dec(3, 'Red', true), dec(4, 'Blue', false),
			dec(5, 'Red', true), dec(6, 'Blue', false), dec(7, 'Red', true),
			{ type: 'result', summary: { stopReason: 'provider-errors', stopDetail: 'Red: 3 decisions in a row without an answer' } } as unknown as TranscriptRecord
		];
		const kept = resumableRecords(records)!;
		expect(kept.map((r) => (r as DecisionRecord).n ?? 0)).toEqual([0, 1, 2]);
		expect(resumableRecords([records[0], { type: 'result', summary: { stopReason: 'reducer-rejection' } } as unknown as TranscriptRecord])).toBeNull();
	});
});

// League runs (a copy of the design data)

const designDir = [process.env.ARC_DESIGN_DIR, join(homedir(), 'arcspirits-harness/design-data/game')].find(
	(d) => d && existsSync(join(d, 'hex_spirits.json'))
);

function addAgent(agentsDir: string, id: string, file: Record<string, unknown>) {
	mkdirSync(join(agentsDir, id), { recursive: true });
	writeFileSync(join(agentsDir, id, 'agent.json'), JSON.stringify({ name: id, learn: false, ...file }));
	writeFileSync(join(agentsDir, id, 'strategy.md'), '');
}

/** A fake gateway that takes the first action; `onCall` sees the number of calls so far. */
function fakeGateway(onCall: (n: number) => void = () => {}) {
	const calls: { key: string; turns: number }[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		if (url.endsWith('/models')) return new Response('{"data":[]}', { status: 200 });
		if (url.endsWith('/usage')) return new Response('{"reports":[]}', { status: 200 });
		const body = JSON.parse(String(init.body)) as { input: { role?: string; content?: string }[]; prompt_cache_key?: string };
		calls.push({ key: body.prompt_cache_key ?? '', turns: body.input.filter((i) => i.role === 'user').length });
		onCall(calls.length);
		const last = String([...body.input].reverse().find((i) => i.role === 'user')?.content ?? '');
		const id = parseOfferedActions(last)[0]?.id;
		const text = JSON.stringify(id ? { action: id, reason: 'first' } : { statement: 'done' });
		return new Response(
			JSON.stringify({
				output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
				usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 20 }
			}),
			{ status: 200 }
		);
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

function gatewayLeague(config: Partial<LeagueConfig>, ids = ['a', 'b', 'c', 'd']) {
	const dir = temp();
	cpSync(designDir!, join(dir, 'data-src'), { recursive: true });
	writeFileSync(join(dir, 'token'), 'tok\n');
	for (const id of ids) addAgent(join(dir, 'agents'), id, { model: 'openai-codex/gpt-6.1-sol', effort: 'low', memory: 'history' });
	const full: LeagueConfig = {
		...DEFAULT_LEAGUE_CONFIG,
		agentsDir: join(dir, 'agents'),
		dataDir: join(dir, 'data-src'),
		stopGraceSec: 5,
		maxDecisions: 70,
		callsPerMin: 60_000,
		maxCallsPerMin: 60_000,
		benchmark: true,
		gateways: [{ label: 'acct', url: 'http://codex/v1', tokenFile: join(dir, 'token'), games: 2 }],
		...config
	};
	return { dir, config: full };
}

const results = (dir: string, version: string) =>
	readdirSync(join(dir, 'versions', version, 'traces'))
		.sort()
		.map((f) => JSON.parse(readFileSync(join(dir, 'versions', version, 'traces', f), 'utf8')) as { index: number; gameId: string; result: { seats: ({ entrant: string; latencyMsTotal: number } & Record<string, unknown>)[] } })
		.map((t) => `${t.index}:${JSON.stringify(t.result.seats.map(({ latencyMsTotal: _ms, ...seat }) => seat))}`);

describe.skipIf(!designDir)('resume a league', () => {
	it('stop and start again: the games in flight go on, the results and the number of calls are those of one unbroken run', async () => {
		const control = gatewayLeague({ maxGames: 4 });
		const cg = fakeGateway();
		const whole = new League({ dir: control.dir, config: control.config, fetchImpl: cg.fetchImpl, tickMs: 20, statusMs: 200, log: () => {} });
		expect(await whole.run()).toBe('done');

		const broken = gatewayLeague({ maxGames: 4 });
		const log: string[] = [];
		let league: League;
		const g1 = fakeGateway((n) => {
			if (n === 60) league.stop('test pause');
		});
		league = new League({ dir: broken.dir, config: broken.config, fetchImpl: g1.fetchImpl, tickMs: 20, statusMs: 200, log: (l) => log.push(l) });
		expect(await league.run()).toBe('stopped');
		const version = league.current!.id;
		const games = join(broken.dir, 'versions', version, 'games');
		expect(readdirSync(games).some((f) => f.includes('.abandoned-'))).toBe(true);

		const g2 = fakeGateway();
		const again = new League({ dir: broken.dir, config: broken.config, fetchImpl: g2.fetchImpl, tickMs: 20, statusMs: 200, log: (l) => log.push(l) });
		expect(await again.run()).toBe('done');
		expect(log.some((l) => /continued after decision \d+ of its earlier record/.test(l))).toBe(true);
		expect(results(broken.dir, version)).toEqual(results(control.dir, whole.current!.id));
		expect(g1.calls.length + g2.calls.length).toBe(cg.calls.length);
		// A continued seat's first call carries its earlier turns.
		const firstOf = new Map<string, number>();
		for (const c of g2.calls) if (!firstOf.has(c.key)) firstOf.set(c.key, c.turns);
		expect([...firstOf.values()].some((turns) => turns > 3)).toBe(true);
	}, 120_000);

	it('the agent list changes: finished games stay, the rest is scheduled again, removed agents stay in the report', async () => {
		const { dir, config } = gatewayLeague({ maxGames: 5 }, ['a', 'b', 'c', 'd', 'e']);
		const run = async (cfg: LeagueConfig) => {
			const log: string[] = [];
			const league = new League({ dir, config: cfg, fetchImpl: fakeGateway().fetchImpl, tickMs: 20, statusMs: 200, log: (l) => log.push(l) });
			expect(await league.run()).toBe('done');
			return { league, log };
		};
		const first = await run(config);
		const version = first.league.current!.id;
		const before = results(dir, version);
		expect(before.length).toBe(5);

		// One agent more, one less: the five finished games stay; five more are played.
		addAgent(config.agentsDir, 'f', { model: 'openai-codex/gpt-6.1-sol', effort: 'low', memory: 'history' });
		rmSync(join(config.agentsDir, 'a'), { recursive: true });
		const second = await run({ ...config, maxGames: 10 });
		expect(second.log.some((l) => /agent list changed \(added f; removed a\): 5 game\(s\) kept/.test(l))).toBe(true);
		const after = results(dir, version);
		expect(after.slice(0, 5)).toEqual(before);
		expect(after.length).toBe(10);
		const later = after.slice(5).join(' ');
		expect(later).toContain('"entrant":"f"');
		expect(later).not.toContain('"entrant":"a"');
		const md = readFileSync(join(dir, 'report.md'), 'utf8');
		expect(md).toContain('a (removed)');
		const seating = JSON.parse(readFileSync(join(dir, 'versions', version, 'seating.json'), 'utf8')) as { epochs: unknown[] };
		expect(seating.epochs.length).toBe(2);

		// The same id with another effort would mix two different players: refused.
		writeFileSync(join(config.agentsDir, 'b', 'agent.json'), JSON.stringify({ name: 'b', learn: false, model: 'openai-codex/gpt-6.1-sol', effort: 'high', memory: 'history' }));
		const third = new League({ dir, config: { ...config, maxGames: 12 }, fetchImpl: fakeGateway().fetchImpl, tickMs: 20, statusMs: 200, log: () => {} });
		expect(await third.run()).toBe('error');
		expect(third.status.lastError).toMatch(/agent b has games as .* low and is now .* high/);
	}, 120_000);
});
