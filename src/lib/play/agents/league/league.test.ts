/**
 * The league: fresh-question seats, notebooks, the schedule, data versions and the report — all
 * offline (mock seats; the gateway with a fake fetch). The league runs need the design data
 * (~/arcspirits-harness/design-data/game or ARC_DESIGN_DIR); they are skipped without it.
 *
 *   npx vitest run src/lib/play/agents/league
 */

import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BudgetGuard } from '../budget';
import { catalogHash, loadFrozenCatalog } from '../catalog';
import { LlmSeatController } from '../llmSeat';
import { capNotebook, mockNotebookUpdate, NOTEBOOK_MAX_LINES } from '../memory';
import { GatewayProvider } from '../providers/gateway';
import { GatewayPool } from '../providers/gatewayPool';
import { MockProvider, parseOfferedActions } from '../providers/mock';
import type { ChatProvider, ChatRequest, ChatResponse } from '../providers/types';
import { buildRulesBrief } from '../rulesBrief';
import { runAgentGame, type GameSummary } from '../runner';
import { loadStrategies } from '../strategy';
import {
	MemorySink,
	readTranscript,
	replayTranscript,
	type DecisionRecord,
	type HeaderRecord,
	type TranscriptRecord
} from '../transcript';
import { createAgentsFromStrategies, modelLabel } from './agents';
import { DEFAULT_LEAGUE_CONFIG, type LeagueConfig } from './config';
import { gatewaySlots, League } from './league';
import { NotebookStore, textHash } from './notebookStore';
import type { VersionReport } from './report';
import { firstFit, LeagueSchedule } from './schedule';

const catalog = loadFrozenCatalog();
const brief = buildRulesBrief(catalog);
const catalogInfo = { source: 'frozen', path: 'ml/catalog.json', hash: catalogHash(catalog) };
const STRATEGIES = loadStrategies(join(process.cwd(), 'scripts/agent-harness/strategies.json'));
const tempDirs: string[] = [];
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), 'league-'));
	tempDirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Mock answers, plus a plan note `plan <n>` on every answer; records each request. */
class NotingProvider implements ChatProvider {
	readonly name = 'test';
	readonly requests: ChatRequest[] = [];
	readonly #inner: MockProvider;
	#n = 0;
	constructor(seed: number) {
		this.#inner = new MockProvider({ policy: 'greedy', seed });
	}
	estimateCostUsd(): Promise<number> {
		return Promise.resolve(0);
	}
	async complete(request: ChatRequest): Promise<ChatResponse> {
		this.requests.push(structuredClone({ ...request, signal: undefined }));
		const res = await this.#inner.complete(request);
		const answer = JSON.parse(res.text) as Record<string, unknown>;
		return { ...res, text: JSON.stringify({ ...answer, note: `plan ${++this.#n}` }) };
	}
}

const freshSeat = (provider: ChatProvider, i: number) =>
	new LlmSeatController({
		provider,
		model: 'm',
		budget: new BudgetGuard(),
		label: `s${i}`,
		memory: 'fresh',
		strategy: STRATEGIES[i + 1],
		notebook: i === 0 ? '- lesson one\n- lesson two' : null
	});

describe('fresh-question seats', () => {
	it('send one request per decision: the same brief bytes, no earlier turns, the plan note back', async () => {
		const providers = [0, 1, 2, 3].map((i) => new NotingProvider(10 + i));
		const sink = new MemorySink();
		const summary = await runAgentGame({
			catalog,
			catalogInfo,
			seed: 7,
			controllers: providers.map(freshSeat),
			rulesBrief: brief,
			budget: new BudgetGuard(),
			runId: 'fresh',
			maxDecisions: 160,
			sink
		});
		expect(summary.decisions).toBe(160);
		for (const [i, provider] of providers.entries()) {
			expect(provider.requests.length).toBeGreaterThan(5);
			let previousNote: string | null = null;
			for (const r of provider.requests) {
				// The brief: the same bytes for every seat, first; then strategy (and notebook for seat 0).
				expect(r.messages[0]).toEqual({ role: 'system', content: brief });
				expect(r.messages.filter((m) => m.role === 'system')).toHaveLength(i === 0 ? 3 : 2);
				// One user message, no assistant turn: no earlier turn is sent.
				expect(r.messages.filter((m) => m.role === 'user')).toHaveLength(1);
				expect(r.messages.some((m) => m.role === 'assistant')).toBe(false);
				expect(r.meta?.stateless).toBe(true);
				const user = r.messages.at(-1)!.content;
				expect(user).toContain('RECENT EVENTS (since your last decision):');
				// The note of the seat's last answer comes back in its next decision.
				expect(user).toContain(`YOUR PLAN NOTE (your own words from an earlier decision in this game):\n${previousNote ?? '(none yet)'}`);
				previousNote = `plan ${provider.requests.indexOf(r) + 1}`;
			}
		}
		expect(providers[0].requests[0].messages[2].content).toContain('- lesson two');
		const decisions = sink.records.filter(
			(r): r is DecisionRecord => r.type === 'decision' && r.prompt !== null
		);
		expect(decisions.every((d) => /^plan \d+$/.test(d.note ?? ''))).toBe(true);
		// The record holds the exact message sent: the plan note, then the decision message.
		expect(decisions.every((d) => d.prompt!.startsWith('YOUR PLAN NOTE'))).toBe(true);
	});

	it('replays a fresh-mode game with notes exactly', async () => {
		const sink = new MemorySink();
		const summary = await runAgentGame({
			catalog,
			catalogInfo,
			seed: 5,
			controllers: [0, 1, 2, 3].map((i) => freshSeat(new NotingProvider(20 + i), i)),
			rulesBrief: brief,
			budget: new BudgetGuard(),
			runId: 'replay',
			sink
		});
		expect(summary.stopReason).toBe('finished');
		expect(sink.records.some((r) => r.type === 'decision' && r.note)).toBe(true);
		expect(replayTranscript(sink.records, catalog).matches).toBe(true);
	});

	it('gateway: a stateless request is sent as it is and nothing is kept', async () => {
		const sent: { input: { role: string; content: string }[] }[] = [];
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			sent.push(JSON.parse(String(init.body)));
			return new Response(JSON.stringify({ output_text: '{"action":"a1","reason":"r"}', usage: {} }), {
				status: 200
			});
		}) as unknown as typeof fetch;
		const provider = new GatewayProvider({
			token: 't',
			api: 'responses',
			fetchImpl,
			baseUrls: ['http://127.0.0.1:1/v1']
		});
		const request = (content: string): ChatRequest => ({
			model: 'openai-codex/gpt-6.1-sol',
			messages: [
				{ role: 'system', content: 'BRIEF' },
				{ role: 'user', content }
			],
			maxTokens: 400,
			meta: {
				seat: 'Red',
				requestId: 'r',
				offeredIds: ['a1'],
				attempt: 1,
				sessionKey: 'g:Red',
				stateless: true
			}
		});
		await provider.complete(request('D1'));
		await provider.complete(request('D2'));
		expect(sent[1].input.map((m) => m.content)).toEqual(['D2']);
		expect((sent[1] as unknown as { prompt_cache_key: string }).prompt_cache_key).toBe('g:Red');
		expect(provider.sessions).toBe(0);
	});
});

describe('notebooks', () => {
	it('caps the notebook and the mock update keeps the newest lines', () => {
		const long = Array.from({ length: 60 }, (_, i) => `- lesson ${i} ${'x'.repeat(300)}`).join('\n');
		const capped = capNotebook(long).split('\n');
		expect(capped).toHaveLength(NOTEBOOK_MAX_LINES);
		expect(capped[0].length).toBeLessThanOrEqual(160);
		const updated = mockNotebookUpdate(capped.join('\n'), 'g-new').split('\n');
		expect(updated).toHaveLength(NOTEBOOK_MAX_LINES);
		expect(updated.at(-1)).toBe('- g-new: mock seat, no lesson');
	});

	it('serialises the updates of one agent: none is lost, the history chains old → new', async () => {
		const dir = temp();
		const store = new NotebookStore();
		const update = (k: number) =>
			store.withLock(dir, async () => {
				const before = store.read(dir);
				await new Promise((r) => setTimeout(r, Math.random() * 10));
				store.save(dir, `${before}\n- game ${k}`.trim(), `g${k}`, 'hash');
			});
		await Promise.all(Array.from({ length: 30 }, (_, k) => update(k)));
		const lines = store.read(dir).split('\n');
		expect(lines).toHaveLength(30);
		expect(lines).toEqual(Array.from({ length: 30 }, (_, k) => `- game ${k}`));
		const history = store.history(dir);
		expect(history).toHaveLength(30);
		history.forEach((h, k) => {
			expect(h.oldHash).toBe(k === 0 ? textHash('') : history[k - 1].newHash);
			expect(textHash(h.old)).toBe(h.oldHash);
		});
		expect(history.at(-1)!.newHash).toBe(textHash(store.read(dir)));
	});
});

describe('league schedule', () => {
	it('is balanced: every agent plays each seat once per block and meets the others evenly', () => {
		const agents = STRATEGIES.map((s) => s.id);
		expect(agents).toHaveLength(10);
		const schedule = new LeagueSchedule(agents, { seed: 2026, tableSize: 4 });
		const games = Array.from({ length: 90 }, (_, i) => schedule.game(i));
		const positions = new Map(agents.map((a) => [a, [0, 0, 0, 0]]));
		const pairs = new Map<string, number>();
		for (const g of games) {
			expect(new Set(g.seats).size).toBe(4);
			g.seats.forEach((a, p) => {
				positions.get(a)![p] += 1;
				for (const b of g.seats.slice(p + 1)) {
					const key = [a, b].sort().join('|');
					pairs.set(key, (pairs.get(key) ?? 0) + 1);
				}
			});
		}
		for (const counts of positions.values()) expect(counts).toEqual([9, 9, 9, 9]);
		expect(pairs.size).toBe(45);
		const meets = [...pairs.values()];
		// 90 games × 6 pairs over 45 pairs = 12 meetings each on average.
		expect(Math.max(...meets) - Math.min(...meets)).toBeLessThanOrEqual(2);
		// The same game number is the same game (seed and seats), whatever the order of the list.
		const again = new LeagueSchedule([...agents].reverse(), { seed: 2026, tableSize: 4 });
		expect(again.game(37)).toEqual(games[37]);
		expect(games[37].seed).toBe(2026 + 37);
	});

	it('is unchanged for the same agent list (seeds and seats of the first 40 games)', () => {
		const schedule = new LeagueSchedule(
			STRATEGIES.map((s) => s.id),
			{ seed: 2026, tableSize: 4 }
		);
		const games = Array.from({ length: 40 }, (_, i) => schedule.game(i));
		expect(games[0]).toEqual({
			index: 0,
			seed: 2026,
			seats: ['forest', 'mountain', 'barrier-hunter', 'fire-dice']
		});
		expect(createHash('sha256').update(JSON.stringify(games)).digest('hex').slice(0, 16)).toBe(
			'578baa1a7586cd15'
		);
	});

	it('a full Claude account holds back only the tables with a Claude seat; the games stay the same', () => {
		const ids = STRATEGIES.map((s) => s.id);
		const claude = new Set(ids.slice(0, 2));
		const model = (id: string) =>
			claude.has(id) ? 'anthropic/claude-opus-5-5' : 'openai-codex/gpt-6.1-sol';
		const pool = new GatewayPool(
			[
				{ label: 'simforge', url: 'http://a/v1', token: 'a' },
				{ label: 'claude', url: 'http://c/v1', token: 'c', provider: 'anthropic' }
			],
			{ gate: { maxConcurrent: 4 } }
		);
		pool.byLabel('simforge')!.target = 6;
		pool.byLabel('claude')!.target = 1;
		const schedule = new LeagueSchedule(ids, { seed: 2026, tableSize: 4 });
		const started: number[] = [];
		for (;;) {
			const next = firstFit(
				schedule,
				0,
				40,
				(i) => !started.includes(i),
				(game) => gatewaySlots(pool, game.seats.map(model))
			);
			if (!next) break;
			for (const account of next.slots) pool.assign(`g${next.game.index}`, account);
			started.push(next.game.index);
		}
		const hasClaude = (i: number) => schedule.game(i).seats.some((id) => claude.has(id));
		// Six games in flight (the Codex cap), exactly one of them with a Claude seat.
		expect(started).toHaveLength(6);
		expect(started.filter(hasClaude)).toHaveLength(1);
		// The skipped games are exactly the Claude tables before the last one started.
		const skipped = Array.from({ length: started.at(-1)! }, (_, i) => i).filter((i) => !started.includes(i));
		expect(skipped.length).toBeGreaterThan(0);
		expect(skipped.every(hasClaude)).toBe(true);
		expect(pool.byLabel('claude')!.games.size).toBe(1);
		// The Claude game ends: the oldest waiting Claude table is next.
		const claudeGame = started.find(hasClaude)!;
		pool.release(`g${claudeGame}`);
		pool.release(`g${started.find((i) => !hasClaude(i))!}`);
		const next = firstFit(
			schedule,
			0,
			40,
			(i) => !started.includes(i),
			(game) => gatewaySlots(pool, game.seats.map(model))
		)!;
		expect(next.game.index).toBe(skipped[0]);
		expect(next.slots.map((a) => a.label).sort()).toEqual(['claude', 'simforge']);
		// Who plays which game does not depend on the order games were started.
		const fresh = new LeagueSchedule(ids, { seed: 2026, tableSize: 4 });
		for (const i of started) expect(fresh.game(i)).toEqual(schedule.game(i));
	});

	it('fails at start when an agent model has no gateway of its provider', () => {
		const dir = temp();
		writeFileSync(join(dir, 'token'), 't\n');
		createAgentsFromStrategies(join(dir, 'agents'), STRATEGIES.slice(0, 2), {
			model: 'openai-codex/gpt-6.1-sol'
		});
		createAgentsFromStrategies(join(dir, 'agents'), STRATEGIES.slice(2, 4), {
			model: 'anthropic/claude-opus-5-5'
		});
		const config: LeagueConfig = {
			...DEFAULT_LEAGUE_CONFIG,
			agentsDir: join(dir, 'agents'),
			dataDir: join(dir, 'data'),
			gateways: [{ label: 'simforge', url: 'http://a/v1', tokenFile: join(dir, 'token'), games: 2 }]
		};
		expect(() => new League({ dir, config, log: () => {} })).toThrow(
			/agent \S+ uses anthropic\/claude-opus-5-5, but no gateway has "provider": "anthropic"/
		);
		const ok = new League({
			dir,
			config: {
				...config,
				gateways: [
					...config.gateways,
					{ label: 'claude', url: 'http://c/v1', tokenFile: join(dir, 'token'), games: 1, provider: 'anthropic' }
				]
			},
			log: () => {}
		});
		expect(ok.agents.map(modelLabel).sort()).toEqual([
			'Claude Opus 5.5 low',
			'Claude Opus 5.5 low',
			'GPT-6.1 Sol low',
			'GPT-6.1 Sol low'
		]);
	});
});

// ---------------------------------------------------------------------------------------------
// League runs (mock agents, a copy of the design data)

const designDir = [process.env.ARC_DESIGN_DIR, join(homedir(), 'arcspirits-harness/design-data/game')].find(
	(d) => d && existsSync(join(d, 'hex_spirits.json'))
);

function mockLeague(agents: number, config: Partial<LeagueConfig>) {
	const dir = temp();
	cpSync(designDir!, join(dir, 'data-src'), { recursive: true });
	createAgentsFromStrategies(join(dir, 'agents'), STRATEGIES.slice(0, agents), { model: 'mock:greedy' });
	const full: LeagueConfig = {
		...DEFAULT_LEAGUE_CONFIG,
		agentsDir: join(dir, 'agents'),
		dataDir: join(dir, 'data-src'),
		stopGraceSec: 1,
		...config
	};
	const log: string[] = [];
	const league = new League({ dir, config: full, tickMs: 20, statusMs: 200, log: (l) => log.push(l) });
	return { dir, league, log };
}

interface GatewayCall {
	url: string;
	auth: string;
	body: {
		model: string;
		input: Record<string, unknown>[];
		include?: string[];
		store?: boolean;
		prompt_cache_key?: string;
	};
}

/**
 * A fake omp gateway (responses route): answers the first legal action with a reasoning item,
 * records every call. No network.
 */
function fakeGateway() {
	const calls: GatewayCall[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		if (url.endsWith('/models')) return new Response('{"data":[]}', { status: 200 });
		if (url.endsWith('/usage')) return new Response('{"reports":[]}', { status: 200 });
		const body = JSON.parse(String(init.body)) as GatewayCall['body'];
		calls.push({ url, auth: (init.headers as Record<string, string>).Authorization, body });
		const last = String([...body.input].reverse().find((i) => i.role === 'user')?.content ?? '');
		const id = parseOfferedActions(last)[0]?.id;
		const text = JSON.stringify(id ? { action: id, reason: 'first' } : { statement: 'done' });
		return new Response(
			JSON.stringify({
				output: [
					{ type: 'reasoning', id: `rs${calls.length}`, summary: [], encrypted_content: `ENC${calls.length}` },
					{ type: 'message', content: [{ type: 'output_text', text }] }
				],
				usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 20 }
			}),
			{ status: 200 }
		);
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

/** An agent folder with an empty strategy (benchmark style). */
function addAgent(agentsDir: string, id: string, file: Record<string, unknown>) {
	mkdirSync(join(agentsDir, id), { recursive: true });
	writeFileSync(join(agentsDir, id, 'agent.json'), JSON.stringify({ name: id, learn: false, ...file }));
	writeFileSync(join(agentsDir, id, 'strategy.md'), '');
}

/** Add one rune to the awaken cost of the first spirit that has a rune cost. */
function bumpAwakenCost(dataDir: string): string {
	const path = join(dataDir, 'hex_spirits.json');
	const rows = JSON.parse(readFileSync(path, 'utf8')) as {
		name: string;
		awaken_condition?: { type?: string; rune_ids?: string[] };
	}[];
	const spirit = rows.find((r) => r.awaken_condition?.type === 'rune_cost')!;
	spirit.awaken_condition!.rune_ids!.push(spirit.awaken_condition!.rune_ids![0]);
	writeFileSync(path, JSON.stringify(rows, null, 2));
	return spirit.name;
}

const headers = (dir: string, version: string) =>
	readdirSync(join(dir, 'versions', version, 'games'))
		.filter((f) => /^g\d+\.jsonl$/.test(f))
		.map((f) => readTranscript(join(dir, 'versions', version, 'games', f)))
		.map((records) => records.find((r): r is HeaderRecord => r.type === 'header')!)
		.sort((a, b) => a.gameIndex - b.gameIndex);

describe.skipIf(!designDir)('league runs', () => {
	it('report numbers match the games; notebooks are updated after every game', async () => {
		const { dir, league } = mockLeague(5, { maxGames: 5, mockGamesInFlight: 5 });
		expect(await league.run()).toBe('done');
		const version = league.current!.id;
		const report = JSON.parse(
			readFileSync(join(dir, 'versions', version, 'report.json'), 'utf8')
		) as VersionReport;
		// Recount from the transcripts' own results.
		const expected = new Map<string, { games: number; wins: number; vp: number }>();
		for (const f of readdirSync(join(dir, 'versions', version, 'games')).filter((n) => n.endsWith('.jsonl'))) {
			const records: TranscriptRecord[] = readTranscript(join(dir, 'versions', version, 'games', f));
			const header = records.find((r): r is HeaderRecord => r.type === 'header')!;
			const result = records.find((r) => r.type === 'result');
			const summary = (result?.type === 'result' ? result.summary : null) as GameSummary;
			for (const s of summary.seats) {
				const id = header.seats.find((h) => h.seat === s.seat)!.strategy!.id;
				const row = expected.get(id) ?? { games: 0, wins: 0, vp: 0 };
				row.games += 1;
				row.vp += s.finalVp;
				if (summary.finished && s.seat === summary.winner) row.wins += 1;
				expected.set(id, row);
			}
		}
		expect(report.games).toBe(5);
		for (const row of report.report.strategies) {
			const e = expected.get(row.id)!;
			expect(row.games).toBe(e.games);
			expect(row.wins).toBe(e.wins);
			expect(row.avgVp).toBeCloseTo(e.vp / e.games, 2);
		}
		const md = readFileSync(join(dir, 'report.md'), 'utf8');
		expect(md).toContain('Data version');
		expect(md).toContain('## How each agent did');
		expect(md).toContain('| Agent | Model | Learns |');
		expect(md).toContain('| mock greedy | yes |');
		expect(md).toContain('## What strategies emerge');
		expect(md).toContain('## What the agents think');
		for (const s of STRATEGIES.slice(0, 5)) {
			const nb = readFileSync(join(dir, 'agents', s.id, 'notebook.md'), 'utf8').trim().split('\n');
			// 5 agents at 4 seats: each plays 4 of the 5 games.
			expect(nb).toHaveLength(4);
		}
		const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
		expect(status).toMatchObject({ state: 'done', gamesInFlight: 0 });
		expect(status.versions[version]).toMatchObject({ done: 5, running: 0 });
	}, 120_000);

	it('a data change starts a new version at game 0 with the same seeds and seats; bad data is skipped', async () => {
		const { dir, league, log } = mockLeague(4, { maxGames: 6, mockGamesInFlight: 3, maxDecisions: 300 });
		let changed = '';
		let first = '';
		const watch = setInterval(() => {
			if (!first && log.some((l) => / done: /.test(l))) {
				first = league.current!.id;
				changed = bumpAwakenCost(join(dir, 'data-src'));
			} else if (first && league.current!.id !== first && !existsSync(join(dir, 'bad-written'))) {
				// Once: a half-written file. The league must keep going on the version it has.
				writeFileSync(join(dir, 'bad-written'), '');
				writeFileSync(join(dir, 'data-src', 'origins.json'), '[{"broken": ');
				setTimeout(() => {
					cpSync(join(designDir!, 'origins.json'), join(dir, 'data-src', 'origins.json'));
				}, 300);
			}
		}, 5);
		const state = await league.run();
		clearInterval(watch);
		expect(state).toBe('done');
		const second = league.current!.id;
		expect(second).not.toBe(first);
		const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
		expect(status.dataVersion).toBe(second);
		expect(status.versions[second]).toMatchObject({ done: 6, running: 0 });
		expect(status.versions[first].abandoned).toBeGreaterThan(0);
		expect(log.some((l) => /data folder cannot be loaded/.test(l))).toBe(true);
		expect(log.some((l) => /data changed: version/.test(l))).toBe(true);
		// Pair by pair: game i of both versions has the same seed and the same agents in the same seats.
		const a = headers(dir, first);
		const b = headers(dir, second);
		expect(b.map((h) => h.gameIndex)).toEqual([0, 1, 2, 3, 4, 5]);
		for (const ha of a) {
			const hb = b.find((h) => h.gameIndex === ha.gameIndex)!;
			expect(hb.seed).toBe(ha.seed);
			expect(hb.seats.map((s) => s.strategy?.id)).toEqual(ha.seats.map((s) => s.strategy?.id));
		}
		// The abandoned games are kept, marked by name.
		expect(
			readdirSync(join(dir, 'versions', first, 'games')).some((f) => f.includes('.abandoned-'))
		).toBe(true);
		const md = readFileSync(join(dir, 'report.md'), 'utf8');
		expect(md).toContain(`## What changed since the data before (version ${first})`);
		expect(md).toContain(`Spirit ${changed}: awaken cost`);
		// Notebooks updated on the old data see the change in their next prompt.
		const header = b[0];
		const opts = header.options.league as { agents: { dataChanges: string[] }[] };
		expect(opts.agents.some((x) => x.dataChanges.some((c) => c.includes(changed)))).toBe(true);
	}, 120_000);

	it('benchmark: mixed Codex/Claude table, history seats keep their conversation, ranked report', async () => {
		const dir = temp();
		cpSync(designDir!, join(dir, 'data-src'), { recursive: true });
		writeFileSync(join(dir, 'token-codex'), 'tok-codex\n');
		writeFileSync(join(dir, 'token-claude'), 'tok-claude\n');
		const agentsDir = join(dir, 'agents');
		addAgent(agentsDir, 'sol-history', { model: 'openai-codex/gpt-6.1-sol', effort: 'low', memory: 'history' });
		addAgent(agentsDir, 'sol-fresh', { model: 'openai-codex/gpt-6.1-sol', effort: 'high' });
		addAgent(agentsDir, 'opus-fresh', { model: 'anthropic/claude-opus-5-5', effort: 'low' });
		addAgent(agentsDir, 'opus-history', { model: 'anthropic/claude-opus-5-5', effort: 'low', memory: 'history' });
		const { calls, fetchImpl } = fakeGateway();
		const config: LeagueConfig = {
			...DEFAULT_LEAGUE_CONFIG,
			agentsDir,
			dataDir: join(dir, 'data-src'),
			stopGraceSec: 1,
			maxGames: 1,
			maxDecisions: 80,
			benchmark: true,
			gateways: [
				{ label: 'simforge', url: 'http://codex/v1', tokenFile: join(dir, 'token-codex'), games: 2 },
				{ label: 'claude', url: 'http://claude/v1', tokenFile: join(dir, 'token-claude'), games: 1, provider: 'anthropic' }
			]
		};
		const league = new League({ dir, config, fetchImpl, tickMs: 20, statusMs: 200, log: () => {} });
		expect(await league.run()).toBe('done');
		const header = headers(dir, league.current!.id)[0];
		const seatOf = new Map(header.seats.map((s) => [s.strategy!.id, s.seat]));
		const byKey = (id: string) =>
			calls.filter((c) => c.body.prompt_cache_key?.endsWith(`:${seatOf.get(id)}`));
		// Routing: each seat's calls go to the account of its model's provider, with its token.
		for (const id of ['sol-history', 'sol-fresh'])
			expect(byKey(id).every((c) => c.url.startsWith('http://codex/') && c.auth === 'Bearer tok-codex')).toBe(true);
		for (const id of ['opus-fresh', 'opus-history'])
			expect(byKey(id).every((c) => c.url.startsWith('http://claude/') && c.auth === 'Bearer tok-claude')).toBe(true);
		expect((header.options.league as { account: string }).account).toBe('simforge+claude');
		// History seat: every call extends the last one; earlier reasoning items go back (store false).
		const hist = byKey('sol-history');
		expect(hist.length).toBeGreaterThan(5);
		for (let i = 1; i < hist.length; i++) expect(hist[i].body.input.length).toBeGreaterThan(hist[i - 1].body.input.length);
		expect(hist.at(-1)!.body.input.some((x) => x.type === 'reasoning' && String(x.encrypted_content).startsWith('ENC'))).toBe(true);
		expect(hist.at(-1)!.body).toMatchObject({ store: false, include: ['reasoning.encrypted_content'] });
		// Fresh seat: one user message per call, nothing stored, no reasoning items.
		const fresh = byKey('sol-fresh');
		expect(fresh.every((c) => c.body.input.length === 1 && !c.body.include)).toBe(true);
		// The report: standings by agent, model and effort, with plain column names.
		const md = readFileSync(join(dir, 'report.md'), 'utf8');
		expect(md).toContain('## Model benchmark');
		expect(md).toContain('| # | Agent | Rating (95% range) | Games | Wins |');
		expect(md).toContain('### By model');
		expect(md).toMatch(/\| Claude Opus 5\.5 \| \d+ \(/);
		expect(md).toMatch(/\| GPT-6\.1 Sol \| \d+ \(/);
		expect(md).toContain('### By effort');
		expect(md).toMatch(/\| sol-history \(GPT-6\.1 Sol low\) \| \d+ \(\d+–\d+\) \| 1 \|/);
		// A learning agent is refused in a benchmark.
		addAgent(agentsDir, 'learner', { model: 'openai-codex/gpt-6.1-sol', learn: true });
		expect(() => new League({ dir, config, fetchImpl, log: () => {} })).toThrow(/benchmark: agent learner/);
	}, 120_000);
});
