/**
 * Strategy seats, end-of-game statements, the strategy report and the before/after compare —
 * all offline (frozen ml/catalog.json + the mock provider; the gateway with a fake fetch).
 *
 *   npx vitest run src/lib/play/agents/strategy.test.ts
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PlayCatalog } from '../types';
import { BudgetGuard } from './budget';
import {
	catalogHash,
	DEFAULT_LOCAL_CATALOG_DIR,
	loadFrozenCatalog,
	loadLocalDesignCatalog
} from './catalog';
import { LlmSeatController } from './llmSeat';
import { MockProvider, type MockPolicy } from './providers/mock';
import { GatewayProvider } from './providers/gateway';
import type { ChatProvider, ChatRequest, ChatResponse } from './providers/types';
import { buildRulesBrief } from './rulesBrief';
import { runAgentGame, type GameSummary } from './runner';
import { saveRunCatalog } from './runCatalog';
import {
	FREE_STRATEGY_ID,
	loadStrategies,
	parseStatement,
	pickStrategies,
	STATEMENT_PLACEHOLDER,
	statementPrompt,
	strategyMessage,
	type Strategy
} from './strategy';
import { diffCatalogs, compareRuns } from './strategyCompare';
import { buildStrategyReport, traceGame } from './strategyReport';
import {
	JsonlFileSink,
	MemorySink,
	readTranscript,
	replayTranscript,
	type StatementRecord
} from './transcript';

const catalog: PlayCatalog = loadFrozenCatalog();
const brief = buildRulesBrief(catalog);
const catalogInfo = { source: 'frozen', path: 'ml/catalog.json', hash: catalogHash(catalog) };
const STRATEGIES = loadStrategies(join(process.cwd(), 'scripts/agent-harness/strategies.json'));
const FIRE = STRATEGIES.find((s) => s.id === 'fire')!;
const FREE = STRATEGIES.find((s) => s.id === FREE_STRATEGY_ID)!;
const tempDirs: string[] = [];
afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A provider that records every request and answers statements with a fixed text. */
class RecordingProvider implements ChatProvider {
	readonly name: string;
	readonly requests: ChatRequest[] = [];
	readonly #inner: MockProvider;
	readonly #statement: 'answer' | 'fail';
	constructor(policy: MockPolicy, seed: number, statement: 'answer' | 'fail' = 'answer') {
		this.#inner = new MockProvider({ policy, seed });
		this.name = 'test';
		this.#statement = statement;
	}
	estimateCostUsd(): Promise<number> {
		return Promise.resolve(0);
	}
	async complete(request: ChatRequest): Promise<ChatResponse> {
		this.requests.push(structuredClone({ ...request, signal: undefined }));
		const last = request.messages.at(-1)!.content;
		if (last.includes('explain why you played as you did')) {
			if (this.#statement === 'fail') throw new Error('network down');
			return {
				text: '{"action": "statement", "reason": "I followed my strategy and took Fire spirits."}',
				promptTokens: 10,
				completionTokens: 5,
				costUsd: 0,
				costEstimated: false
			};
		}
		return this.#inner.complete(request);
	}
}

function seat(
	provider: ChatProvider,
	budget: BudgetGuard,
	strategy: Strategy | null,
	statement?: 'ask' | 'placeholder'
) {
	return new LlmSeatController({
		provider,
		model: 'm',
		budget,
		strategy,
		statement,
		label: provider.name
	});
}

describe('strategy catalogue', () => {
	it('loads the shipped catalogue: one per origin, the three examples and free', () => {
		const ids = STRATEGIES.map((s) => s.id);
		for (const id of [
			'free',
			'fire',
			'water',
			'sun',
			'forest',
			'mountain',
			'moon',
			'fire-dice',
			'moon-evil',
			'barrier-hunter'
		])
			expect(ids).toContain(id);
		expect(FREE.text).toBe('');
		for (const s of STRATEGIES.filter((x) => x.text)) expect(s.text.length).toBeLessThan(260);
		expect(pickStrategies('fire, free', STRATEGIES).map((s) => s.id)).toEqual(['fire', 'free']);
		expect(() => pickStrategies('fire,nope', STRATEGIES)).toThrow(/unknown strategy "nope"/);
	});

	// The texts are written for the design data (the frozen test catalog is older).
	const designDir = [
		process.env.ARC_DESIGN_DIR,
		join(homedir(), 'arcspirits-harness/design-data/game'),
		DEFAULT_LOCAL_CATALOG_DIR
	].find((d) => d && existsSync(join(d, 'hex_spirits.json')));
	it.skipIf(!designDir)(
		'names only game terms that appear in the rules brief of the design data',
		() => {
			const designBrief = buildRulesBrief(loadLocalDesignCatalog(designDir));
			for (const s of STRATEGIES)
				for (const sentence of s.text.split(/[.:]\s+/))
					// Every capitalized word after the first word of a sentence is a game term.
					for (const word of sentence
						.split(/[\s,()]+/)
						.slice(1)
						.filter((w) => /^[A-Z][a-z]/.test(w)))
						expect(designBrief, `${s.id}: ${word}`).toContain(word);
		}
	);
});

describe('strategy in the prompt', () => {
	it('free: the seat sends byte-identical messages to a seat without a strategy', async () => {
		const runs: ChatRequest[][] = [];
		for (const strategy of [null, FREE]) {
			const provider = new RecordingProvider('greedy', 3);
			await runAgentGame({
				catalog,
				catalogInfo,
				seed: 4,
				controllers: [
					seat(provider, new BudgetGuard(), strategy),
					seat(new RecordingProvider('first', 1), new BudgetGuard(), null)
				],
				rulesBrief: brief,
				budget: new BudgetGuard(),
				runId: 't',
				maxDecisions: 40
			});
			runs.push(provider.requests);
		}
		expect(runs[0].length).toBeGreaterThan(5);
		expect(JSON.stringify(runs[1].map((r) => r.messages))).toBe(
			JSON.stringify(runs[0].map((r) => r.messages))
		);
		expect(runs[0][0].messages.map((m) => m.role)).toEqual(['system', 'user']);
	});

	it('a strategy seat gets the brief unchanged, then its strategy, then the same user message', async () => {
		const plain = new RecordingProvider('greedy', 3);
		const fire = new RecordingProvider('greedy', 3);
		const sink = new MemorySink();
		for (const [provider, strategy, s] of [
			[plain, null, undefined],
			[fire, FIRE, sink]
		] as const) {
			await runAgentGame({
				catalog,
				catalogInfo,
				seed: 4,
				controllers: [
					seat(provider, new BudgetGuard(), strategy),
					seat(new RecordingProvider('first', 1), new BudgetGuard(), null)
				],
				rulesBrief: brief,
				budget: new BudgetGuard(),
				runId: 't',
				maxDecisions: 40,
				sink: s
			});
		}
		const decisions = fire.requests.filter(
			(r) => !r.messages.at(-1)!.content.includes('explain why')
		);
		expect(decisions.length).toBeGreaterThan(5);
		for (const [i, r] of decisions.entries()) {
			expect(r.messages[0]).toEqual({ role: 'system', content: brief });
			expect(r.messages[1]).toEqual({ role: 'system', content: strategyMessage(FIRE) });
			expect(r.messages[1].content).toContain(FIRE.text);
			// The mock reads the same user message (no strategy in it) and so plays the same moves.
			expect(r.messages.slice(2)).toEqual(plain.requests[i].messages.slice(1));
		}
		const header = sink.records.find((r) => r.type === 'header');
		expect(header?.type === 'header' && header.seats[0].strategy).toEqual(FIRE);
		expect(header?.type === 'header' && header.seats[1].strategy).toBeUndefined();
		const result = sink.records.find((r) => r.type === 'result');
		const summary = (result?.type === 'result' ? result.summary : null) as GameSummary;
		expect(summary.seats[0].strategy).toEqual(FIRE);
		expect(summary.seats[0].invalidAnswers).toBe(0);
		// Statements are asked only when the caller turns them on (run.ts: with --strategies).
		expect(sink.records.some((r) => r.type === 'statement')).toBe(false);
		expect(fire.requests.some((r) => r.messages.at(-1)!.content.includes('explain why'))).toBe(
			false
		);
	});

	it('gateway: the brief stays the first bytes; the strategy follows it (responses and chat)', async () => {
		for (const api of ['responses', 'chat'] as const) {
			const sent: Record<string, unknown>[] = [];
			const fetchImpl = (async (_url: string, init: RequestInit) => {
				sent.push(JSON.parse(String(init.body)));
				const body =
					api === 'responses'
						? { output_text: '{"action":"a1","reason":"r"}', usage: {} }
						: { choices: [{ message: { content: '{"action":"a1","reason":"r"}' } }], usage: {} };
				return new Response(JSON.stringify(body), { status: 200 });
			}) as unknown as typeof fetch;
			const provider = new GatewayProvider({
				token: 't',
				api,
				fetchImpl,
				baseUrls: ['http://127.0.0.1:1/v1']
			});
			const request = (content: string): ChatRequest => ({
				model: 'openai-codex/gpt-6.1-sol',
				messages: [
					{ role: 'system', content: 'BRIEF' },
					{ role: 'system', content: strategyMessage(FIRE)! },
					{ role: 'user', content }
				],
				maxTokens: 400,
				meta: { seat: 'Red', requestId: 'r', offeredIds: ['a1'], attempt: 1, sessionKey: 'g:Red' }
			});
			await provider.complete(request('D1'));
			await provider.complete(request('D2'));
			if (api === 'responses') {
				expect(sent[1].instructions).toBe(`BRIEF\n\n${strategyMessage(FIRE)}`);
				expect((sent[1].input as { content: string }[]).map((m) => m.content)).toEqual([
					'D1',
					'{"action":"a1","reason":"r"}',
					'D2'
				]);
			} else {
				const messages = sent[1].messages as { role: string; content: string }[];
				expect(messages.slice(0, 2).map((m) => m.content)).toEqual([
					'BRIEF',
					strategyMessage(FIRE)
				]);
				expect(messages.slice(2).map((m) => m.content)).toEqual([
					'D1',
					'{"action":"a1","reason":"r"}',
					'D2'
				]);
			}
		}
	});
});

describe('end-of-game statement', () => {
	it('asks each model seat once in its own conversation; mock seats get a placeholder; replay ignores it', async () => {
		const asked = new RecordingProvider('greedy', 3);
		const failing = new RecordingProvider('random', 5, 'fail');
		const mock = new MockProvider({ policy: 'greedy', seed: 9 });
		const sink = new MemorySink();
		const summary = await runAgentGame({
			catalog,
			catalogInfo,
			seed: 6,
			controllers: [
				seat(asked, new BudgetGuard(), FIRE, 'ask'),
				seat(failing, new BudgetGuard(), FREE, 'ask'),
				seat(mock, new BudgetGuard(), null)
			],
			rulesBrief: brief,
			budget: new BudgetGuard(),
			runId: 't',
			statements: true,
			sink
		});
		// A full game: a game cut by the decision cap does not replay exactly yet (a class name in
		// the live state is renamed in place; see the Step 2 report), which is not about statements.
		expect(summary.stopReason).toBe('finished');
		const statements = sink.records.filter((r): r is StatementRecord => r.type === 'statement');
		expect(statements.map((s) => s.seat)).toEqual(['Red', 'Blue', 'Orange']);
		const [red, blue, orange] = statements;
		expect(red.text).toBe('I followed my strategy and took Fire spirits.');
		expect(red.strategyId).toBe('fire');
		expect(red.prompt).toContain('The game is over after round');
		expect(red.prompt).toContain('(you)');
		expect(red.attempts).toHaveLength(1);
		// Same conversation: the statement goes under the seat's own session key, after its decisions.
		const last = asked.requests.at(-1)!;
		expect(last.meta?.sessionKey).toBe(asked.requests[0].meta?.sessionKey);
		expect(last.messages[1].content).toContain(FIRE.text);
		expect(blue.text).toBe('');
		expect(blue.error).toMatch(/network down/);
		expect(orange).toMatchObject({
			placeholder: true,
			text: STATEMENT_PLACEHOLDER,
			prompt: null,
			attempts: []
		});
		expect(summary.seats[0].statement).toBe(red.text);
		// The statement record comes before the result; replay still matches.
		expect(sink.records.findIndex((r) => r.type === 'statement')).toBeLessThan(
			sink.records.findIndex((r) => r.type === 'result')
		);
		expect(replayTranscript(sink.records, catalog).matches).toBe(true);
	});

	it('tells a seat in a stopped game that the game did not reach its end', () => {
		const text = statementPrompt('Blue', {
			finished: false,
			winner: null,
			rounds: 4,
			decisions: 80,
			stopReason: 'decision-cap',
			seats: [
				{ seat: 'Red', finalVp: 3 },
				{ seat: 'Blue', finalVp: 5 }
			]
		});
		expect(text).toContain('stopped in round 4 after 80 decisions');
		expect(text).toContain('Final VP: Red 3, Blue 5 (you). You placed 1st of 2.');
	});

	it('parses the JSON reason, a "statement" field, or plain text', () => {
		expect(parseStatement('{"action":"statement","reason":"A. B."}').text).toBe('A. B.');
		expect(parseStatement('{"statement":"X"}').text).toBe('X');
		expect(parseStatement('Plain words.').text).toBe('Plain words.');
		expect(parseStatement('  ').error).toBe('the answer was empty');
	});
});

/** Play a small run like run.ts: a catalog copy and one transcript per game, strategies rotated. */
async function playRun(
	cat: PlayCatalog,
	games: number,
	strategies: Strategy[],
	maxDecisions: number
) {
	const dir = mkdtempSync(join(tmpdir(), 'arc-strategy-'));
	tempDirs.push(dir);
	const hash = catalogHash(cat);
	saveRunCatalog(dir, { catalog: cat, source: 'frozen', path: 'test', hash });
	const summaries: GameSummary[] = [];
	for (let g = 0; g < games; g++) {
		const order = strategies.map((_, i) => strategies[(i + g) % strategies.length]);
		const budget = new BudgetGuard();
		summaries.push(
			await runAgentGame({
				catalog: cat,
				catalogInfo: { source: 'frozen', path: 'test', hash },
				seed: 10 + g,
				controllers: order.map(
					(s, i) =>
						new LlmSeatController({
							provider: new MockProvider({ policy: 'greedy', seed: (10 + g) * 31 + i }),
							model: 'greedy',
							budget,
							strategy: s,
							label: 'mock:greedy'
						})
				),
				rulesBrief: buildRulesBrief(cat),
				budget,
				runId: 'r',
				gameIndex: g,
				maxDecisions,
				statements: true,
				sink: new JsonlFileSink(join(dir, `game-${g}.jsonl`))
			})
		);
	}
	return { dir, summaries };
}

describe('strategy report', () => {
	it('counts wins, places, VP, monsters and cards from the engine, per strategy', async () => {
		const picked = pickStrategies('fire,moon-evil,barrier-hunter,free', STRATEGIES);
		const { dir, summaries } = await playRun(catalog, 2, picked, 700);
		const report = buildStrategyReport(dir);
		expect(report.games).toBe(2);
		expect(report.strategies.map((s) => s.id).sort()).toEqual([
			'barrier-hunter',
			'fire',
			'free',
			'moon-evil'
		]);
		for (const row of report.strategies) expect(row.games).toBe(2);
		const wins = summaries.filter((g) => g.finished && g.winner).length;
		expect(report.strategies.reduce((n, s) => n + s.wins, 0)).toBe(wins);
		// Average VP per strategy equals the summaries' final VP of the seats that had it.
		for (const row of report.strategies) {
			const vps = summaries.flatMap((g) =>
				g.seats.filter((s) => s.strategy?.id === row.id).map((s) => s.finalVp)
			);
			expect(row.avgVp).toBeCloseTo(vps.reduce((a, b) => a + b, 0) / vps.length, 2);
		}
		for (const [g, game] of report.gameTraces.entries()) {
			const places = game.seats.map((s) => s.place).sort();
			expect(places).toEqual([1, 2, 3, 4]);
			for (const s of game.seats) {
				const sum = summaries[g].seats.find((x) => x.seat === s.seat)!;
				// The replay trace agrees with the runner's own counts.
				expect(s.monsters.length).toBe(sum.monsterFights);
				expect(s.monsters.filter((m) => m.killed).length).toBe(sum.monsterKills);
				expect(s.locations.length).toBeLessThanOrEqual(game.rounds);
				expect(s.locations.filter(Boolean).length).toBeGreaterThan(0);
				expect(s.evil).toBe(sum.statusRounds.Fallen !== undefined);
			}
		}
		for (const c of report.spirits.collected)
			expect(Object.values(c.byStrategy).reduce((a, b) => a + b, 0)).toBe(c.total);
		const collectedNames = new Set(report.spirits.collected.map((c) => c.name));
		for (const name of report.spirits.neverTaken) expect(collectedNames.has(name)).toBe(false);
		expect(collectedNames.size + report.spirits.neverTaken.length).toBe(
			new Set(catalog.spirits.map((s) => s.name)).size
		);
		// Built twice from the folder: the same numbers.
		expect(JSON.stringify(buildStrategyReport(dir))).toBe(JSON.stringify(report));
		// A transcript traced alone gives the same game.
		expect(traceGame(readTranscript(join(dir, 'game-0.jsonl')), catalog)).toEqual(
			report.gameTraces[0]
		);
	});
});

describe('before/after compare', () => {
	const changed = structuredClone(catalog);
	const spirit = changed.spirits.find((s) => s.awaken?.kind === 'rune_cost')!;
	if (spirit.awaken?.kind === 'rune_cost') spirit.awaken.mats[0].count += 1;
	const monster = changed.monsters![0];
	monster.damage += 2;

	it('lists the changed spirit and monster by name and field, and nothing else', () => {
		const changes = diffCatalogs(catalog, changed);
		expect(changes.map((c) => `${c.kind}:${c.name}`)).toEqual([
			`spirit:${spirit.name}`,
			`monster:${monster.name}`
		]);
		expect(changes[0].fields.map((f) => f.field)).toEqual(['awaken cost']);
		expect(changes[1].fields).toEqual([
			{ field: 'damage', before: String(monster.damage - 2), after: String(monster.damage) }
		]);
		expect(diffCatalogs(catalog, catalog)).toEqual([]);
	});

	it('compares two runs on the same seeds and strategies', async () => {
		const picked = pickStrategies('fire,free', STRATEGIES);
		const before = await playRun(catalog, 2, picked, 120);
		const after = await playRun(changed, 2, picked, 120);
		const report = compareRuns(before.dir, after.dir);
		expect(report.sameSetup).toBe(true);
		expect(report.old.catalogHash).not.toBe(report.new.catalogHash);
		expect(report.dataChanges).toHaveLength(2);
		expect(report.strategies.map((s) => s.id).sort()).toEqual(['fire', 'free']);
		const card = report.cards.find((c) => c.name === spirit.name)!;
		expect(Object.keys(card.before)).toEqual(['collected', 'awakened']);
		const oldReport = buildStrategyReport(before.dir);
		expect(card.before.collected).toBe(
			oldReport.spirits.collected.find((c) => c.name === spirit.name)?.total ?? 0
		);
	});
});
