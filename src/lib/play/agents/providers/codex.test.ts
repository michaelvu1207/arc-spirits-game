/**
 * Codex provider tests with a FAKE `codex` binary (a small Node script): no network, no login,
 * no subscription use. The fake logs its argv, answers in the `codex exec --json` event format,
 * and reads stdin to the end (so an open stdin would hang the test, like the real CLI).
 *
 *   npx vitest run src/lib/play/agents/providers/codex.test.ts
 */

import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BudgetGuard } from '../budget';
import { loadFrozenCatalog } from '../catalog';
import { LlmSeatController } from '../llmSeat';
import { buildRulesBrief } from '../rulesBrief';
import { runAgentGame } from '../runner';
import { MemorySink, replayTranscript, type DecisionRecord } from '../transcript';
import { CodexProvider, parseCodexEvents } from './codex';
import { ProviderError, type ChatRequest } from './types';

const FAKE = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
fs.readFileSync(0); // EOF at once only when stdin is closed
const argv = process.argv.slice(2);
const log = process.env.FAKE_CODEX_LOG;
const resume = argv[0] === 'exec' && argv[1] === 'resume';
const prompt = argv[argv.length - 1];
const thread = resume ? argv[argv.length - 2] : 'thread-' + process.pid + '-' + Date.now();
const startedAt = Date.now();
const mode = process.env.FAKE_CODEX_MODE || 'ok';
const done = () => {
	if (log) fs.appendFileSync(log, JSON.stringify({ argv, resume, thread, startedAt, endedAt: Date.now() }) + '\n');
};
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (mode === 'hang') { setTimeout(() => {}, 1e9); return; }
if (mode === 'hang-child') {
	// Like the npm wrapper: the real work runs in a child process.
	const child = require('node:child_process').spawn('sleep', ['30'], { stdio: 'ignore' });
	fs.writeFileSync(process.env.FAKE_CODEX_CHILD_PID, String(child.pid));
	setTimeout(() => {}, 1e9);
	return;
}
if (prompt.includes('CONTEXT-FULL')) { emit({ type: 'turn.failed', error: { message: "Codex ran out of room in the model's context window." } }); done(); process.exit(1); }
if (prompt.includes('FAIL-THIS')) { done(); process.stderr.write('thread is broken\n'); process.exit(1); }
process.stdout.write('banner text that must not be parsed\n');
if (!resume) emit({ type: 'thread.started', thread_id: thread });
emit({ type: 'turn.started' });
if (mode === 'fail') { done(); process.stderr.write('line1\nline2\nstream disconnected\n'); process.exit(1); }
if (mode === 'turn-failed') { emit({ type: 'turn.failed', error: { message: 'usage limit reached' } }); done(); process.exit(1); }
if (mode === 'error-then-ok') emit({ type: 'error', message: 'Reconnecting... 1/5' });
const ids = [...prompt.matchAll(/^\s*(a\d+) \(/gm)].map((m) => m[1]);
const text = mode === 'bad' ? '{"action":"a999","reason":"nope"}' : JSON.stringify({ action: ids[ids.length > 1 ? 1 : 0] || 'a1', reason: 'fake pick' });
emit({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking' } });
emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text } });
// Like Codex: usage is the thread's running total (+1000 input, +25 output per turn).
const turns = 1 + (log && fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('"thread":"' + thread + '"')).length : 0);
setTimeout(() => {
	// Log first: the provider answers as soon as it reads turn.completed.
	done();
	emit({ type: 'turn.completed', usage: { input_tokens: 1000 * turns, cached_input_tokens: 600 * turns, output_tokens: 25 * turns, reasoning_output_tokens: 5 * turns } });
	// Like Codex: the process exits a little after the turn (session file write).
	setTimeout(() => {}, 50);
}, Number(process.env.FAKE_CODEX_DELAY || 0));
`;

function fakeCodex(): { binary: string; log: string } {
	const dir = mkdtempSync(join(tmpdir(), 'fake-codex-'));
	const binary = join(dir, 'codex');
	writeFileSync(binary, FAKE);
	chmodSync(binary, 0o755);
	return { binary, log: join(dir, 'calls.jsonl') };
}

interface Call {
	argv: string[];
	resume: boolean;
	thread: string;
	startedAt: number;
	endedAt: number;
}
const calls = (log: string): Call[] =>
	existsSync(log)
		? readFileSync(log, 'utf8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Call)
		: [];

function provider(
	mode = 'ok',
	extra: Partial<ConstructorParameters<typeof CodexProvider>[0]> = {}
) {
	const fake = fakeCodex();
	const p = new CodexProvider({
		binary: fake.binary,
		modelCatalogJson: null,
		timeoutMs: 10_000,
		...extra,
		env: { FAKE_CODEX_LOG: fake.log, FAKE_CODEX_MODE: mode, ...extra.env }
	});
	return { p, log: fake.log };
}

const decision = (n: number) =>
	`Round 1, navigation phase. Decision ${n}.\nLEGAL ACTIONS\n  a1 (yield) Done\n  a2 (navigate) Go to Forest Region\n`;

function chat(content: string, sessionKey?: string, system = 'RULES BRIEF'): ChatRequest {
	return {
		model: 'gpt-6.1-sol',
		messages: [
			{ role: 'system', content: system },
			{ role: 'user', content }
		],
		maxTokens: 200,
		meta: { seat: 'Red', requestId: 'r1', offeredIds: ['a1', 'a2'], attempt: 1, sessionKey }
	};
}

describe('codex provider (fake binary)', () => {
	it('starts one isolated, tool-less session per seat and resumes it with only the new message', async () => {
		const { p, log } = provider();
		const first = await p.complete(chat(decision(1), 'g1:Red'));
		expect(JSON.parse(first.text)).toEqual({ action: 'a2', reason: 'fake pick' });
		expect(first).toMatchObject({
			promptTokens: 1000,
			cachedPromptTokens: 600,
			completionTokens: 25,
			reasoningTokens: 5,
			costUsd: 0
		});
		// Codex reports running totals; each call records only its own turn.
		const second = await p.complete(chat(decision(2), 'g1:Red'));
		expect(second).toMatchObject({
			promptTokens: 1000,
			cachedPromptTokens: 600,
			reasoningTokens: 5
		});
		await p.complete(chat(decision(1), 'g1:Blue'));
		const [a, b, c] = calls(log);

		// First call: a new thread, read-only sandbox in an empty directory, user config ignored.
		expect(a.resume).toBe(false);
		const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
		expect(a.argv[0]).toBe('exec');
		expect(flag(a.argv, '-m')).toBe('gpt-6.1-sol');
		expect(flag(a.argv, '-s')).toBe('read-only');
		expect(a.argv).toEqual(
			expect.arrayContaining(['--ignore-user-config', '--json', '--skip-git-repo-check'])
		);
		for (const feature of [
			'shell_tool',
			'unified_exec',
			'apps',
			'plugins',
			'multi_agent',
			'hooks',
			'computer_use'
		])
			expect(a.argv.join(' ')).toContain(`--disable ${feature}`);
		expect(a.argv).toContain('web_search="disabled"');
		const workDir = flag(a.argv, '-C');
		expect(readdirSync(workDir)).toEqual([]);
		const schema = JSON.parse(readFileSync(flag(a.argv, '--output-schema'), 'utf8'));
		expect(schema.required).toEqual(['action', 'reason']);
		// The rules brief is the model instructions (system prompt), with the no-tools preface.
		const instr = a.argv.find((x) => x.startsWith('model_instructions_file='))!;
		const instructions = readFileSync(JSON.parse(instr.split('=').slice(1).join('=')), 'utf8');
		expect(instructions).toContain('never try to run commands');
		expect(instructions).toContain('RULES BRIEF');
		expect(a.argv.at(-1)).toBe(decision(1));

		// Second call of the same seat: resume that thread, new decision only, same isolation flags.
		expect(b.resume).toBe(true);
		expect(b.argv.at(-2)).toBe(a.thread);
		expect(b.argv.at(-1)).toBe(decision(2));
		expect(b.argv).toEqual(expect.arrayContaining(['--ignore-user-config', '--output-schema']));
		expect(b.argv.join(' ')).toContain('--disable shell_tool');

		// Another seat: its own thread.
		expect(c.resume).toBe(false);
		expect(c.thread).not.toBe(a.thread);
		expect(p.threads()).toEqual({ 'g1:Red': a.thread, 'g1:Blue': c.thread });
	}, 60_000);

	it('fresh mode never resumes and keeps no session files (--ephemeral)', async () => {
		const { p, log } = provider('ok', { session: 'fresh' });
		await p.complete(chat(decision(1), 'g1:Red'));
		await p.complete(chat(decision(2), 'g1:Red'));
		const all = calls(log);
		expect(all.map((c) => c.resume)).toEqual([false, false]);
		expect(all.every((c) => c.argv.includes('--ephemeral'))).toBe(true);
	}, 60_000);

	it('repair turns go to the same thread; an unusable answer ends in a recorded fallback', async () => {
		const { p, log } = provider('bad');
		const seat = new LlmSeatController({
			provider: p,
			model: 'gpt-6.1-sol',
			budget: new BudgetGuard()
		});
		const answer = await seat.decide(
			{
				contract: 'arc-agent-v1',
				promptVersion: 'test',
				requestId: 'r1',
				gameId: 'g9',
				seat: 'Red',
				round: 1,
				phase: 'navigation',
				kind: 'navigate',
				situation: 'Choose.',
				viewText: 'view',
				events: [],
				actions: [
					{
						id: 'a1',
						actionId: 'x1',
						label: 'Done',
						group: 'yield',
						command: { type: 'setPhaseReady', ready: true } as never
					},
					{
						id: 'a2',
						actionId: 'x2',
						label: 'Go',
						group: 'navigate',
						command: { type: 'lockNavigation', destination: 'Forest Region' } as never
					}
				],
				phaseDecisionIndex: 0
			} as never,
			{ rulesBrief: 'RULES' }
		);
		expect(answer.fallback).toBe(true);
		expect(answer.attempts).toHaveLength(2);
		const [first, repair] = calls(log);
		expect(repair.resume).toBe(true);
		expect(repair.argv.at(-2)).toBe(first.thread);
		expect(repair.argv.at(-1)).toMatch(/^Your answer could not be used/);
	}, 60_000);

	it('exit failures and failed turns become retryable provider errors; a hang is killed', async () => {
		await expect(provider('fail').p.complete(chat(decision(1), 'k'))).rejects.toMatchObject({
			name: 'ProviderError',
			retryable: true,
			message: expect.stringContaining('stream disconnected')
		});
		// A plan limit will not heal on a retry.
		await expect(provider('turn-failed').p.complete(chat(decision(1), 'k'))).rejects.toMatchObject({
			retryable: false,
			message: expect.stringContaining('usage limit reached')
		});
		// A reconnect notice followed by a finished turn is a success.
		const healed = await provider('error-then-ok').p.complete(chat(decision(1), 'k'));
		expect(JSON.parse(healed.text).action).toBe('a2');
		const started = Date.now();
		const err = await provider('hang', { timeoutMs: 400 })
			.p.complete(chat(decision(1), 'k'))
			.catch((e) => e);
		expect(err).toBeInstanceOf(ProviderError);
		expect(err.message).toMatch(/timeout/);
		expect(Date.now() - started).toBeLessThan(5000);
		// A missing binary is a clear, non-retryable error.
		const missing = new CodexProvider({ binary: '/nonexistent/codex', modelCatalogJson: null });
		await expect(missing.complete(chat(decision(1)))).rejects.toMatchObject({ retryable: false });
	}, 60_000);

	it('caps concurrent codex processes', async () => {
		const { p, log } = provider('ok', { maxConcurrent: 1, env: { FAKE_CODEX_DELAY: '150' } });
		await Promise.all([p.complete(chat(decision(1), 'a')), p.complete(chat(decision(1), 'b'))]);
		const [x, y] = calls(log).sort((m, n) => m.startedAt - n.startedAt);
		expect(y.startedAt).toBeGreaterThanOrEqual(x.endedAt);
	}, 60_000);

	it('parses only JSON events, never the banner', () => {
		const out = parseCodexEvents(
			[
				'OpenAI Codex v0 (banner) {not json',
				JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
				JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
				JSON.stringify({
					type: 'item.completed',
					item: { type: 'agent_message', text: '{"action":"a1"}' }
				}),
				JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 2 } })
			].join('\n')
		);
		expect(out).toMatchObject({
			threadId: 't1',
			text: '{"action":"a1"}',
			inputTokens: 7,
			outputTokens: 2,
			turnFailed: null
		});
	});

	it('plays a game through the runner: parallel navigation, resumed sessions, replayable', async () => {
		const catalog = loadFrozenCatalog();
		const fake = fakeCodex();
		const codex = new CodexProvider({
			binary: fake.binary,
			modelCatalogJson: null,
			env: { FAKE_CODEX_LOG: fake.log, FAKE_CODEX_DELAY: '30' }
		});
		const budget = new BudgetGuard();
		const seat = () =>
			new LlmSeatController({
				provider: codex,
				model: 'gpt-6.1-sol',
				budget,
				label: 'codex:gpt-6.1-sol'
			});
		const sink = new MemorySink();
		const summary = await runAgentGame({
			catalog,
			catalogInfo: { source: 'frozen', path: 'ml/catalog.json', hash: 'test' },
			seed: 3,
			controllers: [seat(), seat()],
			rulesBrief: buildRulesBrief(catalog),
			budget,
			runId: 'codex-test',
			sink,
			maxDecisions: 24
		});
		expect(summary.decisions).toBe(24);
		expect(summary.invalidAnswerRate).toBe(0);
		expect(summary.parallelBatches).toBeGreaterThan(0);
		const decisions = sink.records.filter((r): r is DecisionRecord => r.type === 'decision');
		expect(decisions.some((d) => d.attempts[0]?.model === 'codex:gpt-6.1-sol')).toBe(true);
		// One thread per seat; every later call of that seat resumed it.
		const all = calls(fake.log);
		expect(all.filter((c) => !c.resume)).toHaveLength(2);
		expect(new Set(all.map((c) => c.thread)).size).toBe(2);
		// Parallel navigation answers overlapped in time.
		const overlap = all.some((c, i) =>
			all.some((d, j) => i !== j && d.startedAt < c.endedAt && c.startedAt < d.endedAt)
		);
		expect(overlap).toBe(true);
		expect(replayTranscript(sink.records, catalog).matches).toBe(true);
	}, 60_000);

	it('uses the model of the request, and passes a no-tools copy of the user model catalog', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'fake-catalog-'));
		const source = join(dir, 'models.json');
		const original = JSON.stringify({
			models: [
				{
					slug: 'gpt-6.1-sol',
					tool_mode: 'code_mode_only',
					shell_type: 'unified_exec',
					multi_agent_version: 'v2',
					context_window: 272000
				}
			]
		});
		writeFileSync(source, original);
		const { p, log } = provider('ok', { modelCatalogJson: source });
		expect(p.toolsStripped).toBe(true);
		await p.complete({ ...chat(decision(1), 'g1:Red'), model: 'gpt-6-luna' });
		const [call] = calls(log);
		expect(call.argv[call.argv.indexOf('-m') + 1]).toBe('gpt-6-luna');
		const arg = call.argv.find((x) => x.startsWith('model_catalog_json='))!;
		const copyPath = JSON.parse(arg.slice('model_catalog_json='.length));
		expect(copyPath).not.toBe(source);
		const copy = JSON.parse(readFileSync(copyPath, 'utf8'));
		expect(copy.models[0]).toMatchObject({
			slug: 'gpt-6.1-sol',
			tool_mode: 'direct',
			shell_type: 'disabled',
			multi_agent_version: null,
			context_window: 272000
		});
		expect(readFileSync(source, 'utf8')).toBe(original); // the user's file is untouched
		for (const key of [
			'skills.include_instructions=false',
			'include_permissions_instructions=false',
			'include_environment_context=false'
		])
			expect(call.argv).toContain(key);
		p.dispose();
		expect(existsSync(copyPath)).toBe(false);
	}, 60_000);

	it('one failure keeps the thread; a second failure in a row restarts it (recorded)', async () => {
		const { p, log } = provider();
		const first = await p.complete(chat(decision(1), 'g1:Red'));
		expect(first.session).toMatchObject({ event: 'started' });
		await expect(p.complete(chat('FAIL-THIS', 'g1:Red'))).rejects.toBeInstanceOf(ProviderError);
		const kept = await p.complete(chat(decision(2), 'g1:Red'));
		expect(kept.session).toMatchObject({ event: 'resumed', threadId: first.session!.threadId });
		await expect(p.complete(chat('FAIL-THIS', 'g1:Red'))).rejects.toBeInstanceOf(ProviderError);
		await expect(p.complete(chat('FAIL-THIS', 'g1:Red'))).rejects.toBeInstanceOf(ProviderError);
		const fresh = await p.complete(chat(decision(3), 'g1:Red'));
		expect(fresh.session).toMatchObject({ event: 'restarted', reason: 'thread-failed' });
		const all = calls(log);
		const last = all.at(-1)!;
		expect(last.resume).toBe(false);
		expect(last.thread).not.toBe(all[0].thread);
		// The new thread says so; the decision (with its full view) follows.
		expect(last.argv.at(-1)).toMatch(
			/^\(A new conversation starts here because the previous one failed/
		);
		expect(last.argv.at(-1)!.endsWith(decision(3))).toBe(true);
	}, 60_000);

	it('a full context restarts the thread at once', async () => {
		const { p } = provider();
		await p.complete(chat(decision(1), 'g1:Red'));
		await expect(p.complete(chat('CONTEXT-FULL', 'g1:Red'))).rejects.toThrow(/context window/);
		const next = await p.complete(chat(decision(2), 'g1:Red'));
		expect(next.session).toMatchObject({ event: 'restarted', reason: 'context-full' });
	}, 60_000);

	it('an aborted call does not start codex; a timeout kills the whole process group', async () => {
		const { p, log } = provider();
		const abort = new AbortController();
		abort.abort();
		await expect(p.complete({ ...chat(decision(1), 'k'), signal: abort.signal })).rejects.toThrow(
			/aborted/
		);
		expect(calls(log)).toEqual([]);

		const pidFile = join(mkdtempSync(join(tmpdir(), 'fake-pid-')), 'child.pid');
		const hung = provider('hang-child', {
			timeoutMs: 6000,
			env: { FAKE_CODEX_CHILD_PID: pidFile }
		});
		await expect(hung.p.complete(chat(decision(1), 'k'))).rejects.toThrow(/timeout/);
		const pid = Number(readFileSync(pidFile, 'utf8'));
		await new Promise((r) => setTimeout(r, 200));
		expect(() => process.kill(pid, 0)).toThrow(); // the grandchild is gone too
	}, 60_000);

	it('parallel seats cannot pass the call cap together', () => {
		const budget = new BudgetGuard({ maxCalls: 2 });
		budget.beforeCall(0);
		budget.beforeCall(0);
		expect(() => budget.beforeCall(0)).toThrow(/call budget/);
		budget.release(0);
		expect(() => budget.beforeCall(0)).not.toThrow();
	});

	it('stops the game when a seat gets no answers at all (CLI failing)', async () => {
		const catalog = loadFrozenCatalog();
		const fake = fakeCodex();
		const codex = new CodexProvider({
			binary: fake.binary,
			modelCatalogJson: null,
			env: { FAKE_CODEX_LOG: fake.log, FAKE_CODEX_MODE: 'fail' }
		});
		const budget = new BudgetGuard();
		const seat = () => new LlmSeatController({ provider: codex, model: 'gpt-6.1-sol', budget });
		const summary = await runAgentGame({
			catalog,
			catalogInfo: { source: 'frozen', path: 'ml/catalog.json', hash: 'test' },
			seed: 3,
			controllers: [seat(), seat()],
			rulesBrief: buildRulesBrief(catalog),
			budget,
			runId: 'codex-fail',
			maxDecisions: 200
		});
		expect(summary.stopReason).toBe('provider-errors');
		expect(summary.decisions).toBeLessThan(20);
		expect(summary.stopDetail).toMatch(/stream disconnected/);
	}, 60_000);

	it('keeps one thread for the whole game (no restart by turn count); passes the context window', async () => {
		const { p, log } = provider('ok', { contextWindow: 872000, autoCompactTokenLimit: 780000 });
		for (let n = 1; n <= 6; n++) await p.complete(chat(decision(n), 'g1:Red'));
		const all = calls(log);
		expect(all.map((c) => c.resume)).toEqual([false, true, true, true, true, true]);
		expect(new Set(all.map((c) => c.thread)).size).toBe(1);
		const argv = all[0].argv.join(' ');
		expect(argv).toContain('model_context_window=872000');
		expect(argv).toContain('model_auto_compact_token_limit=780000');
		expect(argv).toContain('model_reasoning_effort="high"');
	}, 60_000);
});
