/** Gateway (`gw:`) provider tests with a fake fetch: no network. */

import { describe, expect, it } from 'vitest';
import { assertGatewayModel, GatewayProvider, gatewayProviderOf } from './gateway';
import { GatewayPool } from './gatewayPool';
import { ProviderError, type ChatRequest } from './types';

// Tests never read the real gateway token: every provider gets its own fake token, and a
// missing one points at a file that does not exist.
process.env.ARC_GATEWAY_TOKEN_FILE = '/nonexistent/arc-gateway-test.token';

interface Sent {
	url: string;
	body: {
		model: string;
		messages: { role: string; content: string }[];
		prompt_cache_key?: string;
		reasoning_effort?: string;
	};
	auth: string | null;
}

function fakeFetch(reply: (n: number, sent: Sent) => { status: number; body: unknown }) {
	const sent: Sent[] = [];
	const impl = (async (url: string, init: RequestInit) => {
		const entry: Sent = {
			url,
			body: init.body ? JSON.parse(String(init.body)) : {},
			auth: (init.headers as Record<string, string>).Authorization ?? null
		};
		sent.push(entry);
		const r = reply(sent.length, entry);
		return new Response(JSON.stringify(r.body), { status: r.status });
	}) as unknown as typeof fetch;
	return { impl, sent };
}

const ok = (text: string) => ({
	status: 200,
	body: {
		id: 'x',
		model: 'gpt-6.1-sol',
		choices: [{ message: { content: text } }],
		usage: { prompt_tokens: 100, completion_tokens: 10 }
	}
});

function chat(
	content: string,
	key: string,
	extra: { role: 'user' | 'assistant'; content: string }[] = []
): ChatRequest {
	return {
		model: 'openai-codex/gpt-6.1-sol',
		messages: [{ role: 'system', content: 'BRIEF' }, { role: 'user', content }, ...extra],
		maxTokens: 400,
		meta: { seat: 'Red', requestId: 'r', offeredIds: ['a1'], attempt: 1, sessionKey: key }
	};
}

describe('gateway provider', () => {
	it('keeps one conversation per seat and sends it whole, with prompt_cache_key and effort', async () => {
		const { impl, sent } = fakeFetch(() => ok('{"action":"a1","reason":"r"}'));
		const p = new GatewayProvider({
			baseUrls: ['http://127.0.0.1:47613/v1'],
			token: 'sekrit-token',
			fetchImpl: impl
		});
		await p.complete(chat('D1', 'g1:Red'));
		await p.complete(chat('D2', 'g1:Red'));
		await p.complete(chat('B1', 'g1:Blue'));
		expect(sent[0].url).toBe('http://127.0.0.1:47613/v1/chat/completions');
		expect(sent[0].auth).toBe('Bearer sekrit-token');
		expect(sent[1].body.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
			'system:BRIEF',
			'user:D1',
			'assistant:{"action":"a1","reason":"r"}',
			'user:D2'
		]);
		expect(sent[1].body).toMatchObject({ prompt_cache_key: 'g1:Red', reasoning_effort: 'high' });
		expect(sent[2].body.messages.map((m) => m.content)).toEqual(['BRIEF', 'B1']);
		expect(p.sessions).toBe(2);
		p.forgetGame('g1');
		expect(p.sessions).toBe(0);
	});

	it('a repair adds only the repair message; a failed call adds nothing', async () => {
		let fail = false;
		const { impl, sent } = fakeFetch(() =>
			fail ? { status: 503, body: { error: { message: 'down' } } } : ok('bad')
		);
		const p = new GatewayProvider({
			baseUrls: ['http://h/v1'],
			token: 't',
			fetchImpl: impl,
			maxRetries: 0
		});
		await p.complete(chat('D1', 'g:Red'));
		await p.complete(
			chat('D1', 'g:Red', [
				{ role: 'assistant', content: 'bad' },
				{ role: 'user', content: 'REPAIR' }
			])
		);
		expect(sent[1].body.messages.map((m) => m.content)).toEqual(['BRIEF', 'D1', 'bad', 'REPAIR']);
		fail = true;
		await expect(p.complete(chat('D2', 'g:Red'))).rejects.toBeInstanceOf(ProviderError);
		fail = false;
		await p.complete(chat('D2', 'g:Red'));
		expect(sent.at(-1)!.body.messages.map((m) => m.content)).toEqual([
			'BRIEF',
			'D1',
			'bad',
			'REPAIR',
			'bad',
			'D2'
		]);
	});

	it('maps rate and usage limits to status 429 for the call gate; the token never shows in errors', async () => {
		const { impl } = fakeFetch(() => ({
			status: 400,
			body: { error: { message: 'usage limit reached for sekrit-token' } }
		}));
		const p = new GatewayProvider({
			baseUrls: ['http://h/v1'],
			token: 'sekrit-token',
			fetchImpl: impl
		});
		const err = await p.complete(chat('D1', 'g:Red')).catch((e) => e);
		expect(err).toBeInstanceOf(ProviderError);
		expect(err.status).toBe(429);
		expect(err.message).not.toContain('sekrit-token');
	});

	it('pins each game to one URL of the list', () => {
		const p = new GatewayProvider({
			baseUrls: ['http://a/v1', 'http://b/v1', 'http://c/v1'],
			token: 't',
			fetchImpl: fetch
		});
		for (const game of ['g1', 'g2', 'g3', 'g4']) {
			expect(p.urlFor(`${game}:Red`)).toBe(p.urlFor(`${game}:Blue`));
		}
		const used = new Set(Array.from({ length: 30 }, (_, i) => p.urlFor(`game${i}:Red`)));
		expect(used.size).toBe(3);
	});

	it('refuses any model id that is not openai-codex/… or anthropic/… before sending anything', async () => {
		const { impl, sent } = fakeFetch(() => ok('x'));
		const p = new GatewayProvider({ baseUrls: ['http://h/v1'], token: 't', fetchImpl: impl });
		for (const model of [
			'gpt-6.1-sol',
			'openai/gpt-6.1-sol',
			'openrouter/auto',
			'openrouter/anthropic/claude-opus-5-5',
			'openai-codex/',
			'anthropic/',
			'anthropic',
			'claude-opus-5-5'
		]) {
			await expect(p.complete({ ...chat('D', 'g:Red'), model })).rejects.toThrow(/refused/);
			expect(() => assertGatewayModel(model)).toThrow(/refused/);
		}
		expect(sent).toHaveLength(0);
		expect(gatewayProviderOf('openai-codex/gpt-6.1-sol')).toBe('openai-codex');
		expect(gatewayProviderOf('anthropic/claude-opus-5-5')).toBe('anthropic');
		await p.complete({ ...chat('D', 'g:Red'), model: 'anthropic/claude-opus-5-5' });
		expect(sent[0].body.model).toBe('anthropic/claude-opus-5-5');
	});

	it('records cached and reasoning tokens; a stopped gateway gives a clear error', async () => {
		const { impl } = fakeFetch(() => ({
			status: 200,
			body: {
				choices: [{ message: { content: 'x' } }],
				usage: {
					prompt_tokens: 900,
					completion_tokens: 50,
					prompt_tokens_details: { cached_tokens: 800 },
					completion_tokens_details: { reasoning_tokens: 40 }
				}
			}
		}));
		const p = new GatewayProvider({ baseUrls: ['http://h/v1'], token: 't', fetchImpl: impl });
		expect(await p.complete(chat('D', 'g:Red'))).toMatchObject({
			promptTokens: 900,
			cachedPromptTokens: 800,
			reasoningTokens: 40,
			costUsd: 0
		});
		// Nothing listens on this port of localhost.
		const down = new GatewayProvider({
			baseUrls: ['http://127.0.0.1:47613/v1'],
			token: 'sekrit-token'
		});
		await expect(down.check()).rejects.toThrow(
			/no gateway at http:\/\/127\.0\.0\.1:47613\/v1; start it/
		);
		const err = await down.complete(chat('D', 'g:Red')).catch((e) => e);
		expect(err.message).toMatch(/no gateway at .*start it/);
		expect(err.retryable).toBe(false);
		expect(err.message).not.toContain('sekrit-token');
	});

	it('responses route: instructions + input + reasoning.effort; output text and usage parsed', async () => {
		const { impl, sent } = fakeFetch(() => ({
			status: 200,
			body: {
				id: 'r1',
				output: [
					{ type: 'reasoning', summary: [] },
					{
						type: 'message',
						content: [{ type: 'output_text', text: '{"action":"a1","reason":"r"}' }]
					}
				],
				usage: {
					input_tokens: 500,
					output_tokens: 60,
					input_tokens_details: { cached_tokens: 400 },
					output_tokens_details: { reasoning_tokens: 50 }
				}
			}
		}));
		const p = new GatewayProvider({
			baseUrls: ['http://h/v1'],
			token: 't',
			api: 'responses',
			fetchImpl: impl
		});
		const res = await p.complete(chat('D1', 'g:Red'));
		expect(sent[0].url).toBe('http://h/v1/responses');
		const body = sent[0].body as unknown as Record<string, unknown>;
		expect(body).toMatchObject({
			instructions: 'BRIEF',
			reasoning: { effort: 'high' },
			prompt_cache_key: 'g:Red'
		});
		expect(body.input).toEqual([{ role: 'user', content: 'D1' }]);
		expect(res).toMatchObject({
			text: '{"action":"a1","reason":"r"}',
			promptTokens: 500,
			cachedPromptTokens: 400,
			completionTokens: 60,
			reasoningTokens: 50
		});
		await p.complete(chat('D2', 'g:Red'));
		expect((sent[1].body as unknown as { input: unknown[] }).input).toHaveLength(3);
	});

	const responsesReply = (n: number) => ({
		status: 200,
		body: {
			id: `r${n}`,
			output: [
				{ type: 'reasoning', id: `rs_${n}`, summary: [], encrypted_content: `ENC${n}` },
				{ type: 'message', content: [{ type: 'output_text', text: `A${n}` }] }
			],
			usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } }
		}
	});

	it('history "reasoning": earlier encrypted reasoning items go back in input (store false)', async () => {
		const { impl, sent } = fakeFetch((n) => responsesReply(n));
		const p = new GatewayProvider({
			baseUrls: ['http://h/v1'],
			token: 't',
			api: 'responses',
			history: 'reasoning',
			fetchImpl: impl
		});
		await p.complete(chat('D1', 'g:Red'));
		await p.complete(chat('D2', 'g:Red'));
		const body = sent[1].body as unknown as Record<string, unknown>;
		expect(body).toMatchObject({ include: ['reasoning.encrypted_content'], store: false });
		expect(body.input).toEqual([
			{ role: 'user', content: 'D1' },
			{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC1' },
			{ role: 'assistant', content: 'A1' },
			{ role: 'user', content: 'D2' }
		]);
		expect(() => new GatewayProvider({ token: 't', api: 'chat', history: 'reasoning' })).toThrow(
			/responses route/
		);
	});

	it('a full context drops the oldest turns once and records a restart; other errors do not', async () => {
		let failNext = false;
		const { impl, sent } = fakeFetch((n) =>
			failNext && !(failNext = false)
				? {
						status: 400,
						body: { error: { message: 'Your input exceeds the context window of this model.' } }
					}
				: responsesReply(n)
		);
		const p = new GatewayProvider({
			baseUrls: ['http://h/v1'],
			token: 't',
			api: 'responses',
			fetchImpl: impl
		});
		for (const d of ['D1', 'D2', 'D3', 'D4']) await p.complete(chat(d, 'g:Red'));
		failNext = true;
		const res = await p.complete(chat('D5', 'g:Red'));
		expect(res.session).toMatchObject({ event: 'restarted' });
		expect(res.session?.reason).toMatch(/context-full: dropped the oldest 4 turns/);
		const last = (sent.at(-1)!.body as unknown as { input: { content: string }[] }).input;
		expect(last.map((m) => m.content)).toEqual(['D3', 'A3', 'D4', 'A4', 'D5']);
		const next = await p.complete(chat('D6', 'g:Red'));
		expect(next.session).toBeUndefined();
	});

	it('history "single": the whole conversation in one user message; each call extends the last', async () => {
		const { impl, sent } = fakeFetch((n) => responsesReply(n));
		const p = new GatewayProvider({
			baseUrls: ['http://h/v1'],
			token: 't',
			api: 'responses',
			history: 'single',
			systemSuffix: 'THINK FIRST.',
			fetchImpl: impl
		});
		await p.complete(chat('D1', 'g:Red'));
		await p.complete(chat('D2', 'g:Red'));
		const inputs = sent.map(
			(x) => (x.body as unknown as { input: { role: string; content: string }[] }).input
		);
		expect(inputs[0]).toHaveLength(1);
		expect(inputs[1]).toHaveLength(1);
		expect(inputs[1][0].role).toBe('user');
		expect(inputs[1][0].content.startsWith(inputs[0][0].content)).toBe(true);
		expect(inputs[1][0].content).toMatch(
			/### GAME \(1\)\nD1\n\n### YOU \(1\)\nA1\n\n### GAME \(2\)\nD2$/
		);
		expect((sent[0].body as unknown as { instructions: string }).instructions).toBe(
			'BRIEF\n\nTHINK FIRST.'
		);
		expect((sent[1].body as unknown as Record<string, unknown>).store).toBeUndefined();
	});
});

describe('gateway account pool', () => {
	const okReply = (n: number) => ({
		status: 200,
		body: {
			id: `r${n}`,
			output: [
				{ type: 'reasoning', id: `rs_${n}`, summary: [], encrypted_content: `ENC${n}` },
				{ type: 'message', content: [{ type: 'output_text', text: `A${n}` }] }
			],
			usage: { input_tokens: 1000, output_tokens: 5 }
		}
	});

	it('pins each game to one account with its own token; new games go to the least loaded', async () => {
		const { impl, sent } = fakeFetch((n) => okReply(n));
		const pool = new GatewayPool(
			[
				{ label: 'berkeley', url: 'http://a/v1', token: 'tok-a' },
				{ label: 'gmail', url: 'http://b/v1', token: 'tok-b' }
			],
			{ gate: { maxConcurrent: 4 }, target: 2, fetchImpl: impl }
		);
		const p = new GatewayProvider({ api: 'responses', pool, fetchImpl: impl });
		pool.assign('g1');
		pool.assign('g2');
		expect(pool.labelOf('g1')).not.toBe(pool.labelOf('g2'));
		await p.complete(chat('D1', 'g1:Red'));
		await p.complete(chat('D1', 'g1:Blue'));
		await p.complete(chat('D1', 'g2:Red'));
		const a = pool.byLabel(pool.labelOf('g1')!)!;
		expect(sent[0].url.startsWith(a.url)).toBe(true);
		expect(sent[1].url.startsWith(a.url)).toBe(true);
		expect(sent[2].url.startsWith(a.url)).toBe(false);
		expect(sent[0].auth).toBe(a.label === 'berkeley' ? 'Bearer tok-a' : 'Bearer tok-b');
		expect(a.window(0).calls).toBe(2);
		expect(a.window(Date.now() - 60_000).tokensPerMin).toBe(2000);
	});

	it('mixed table: each seat goes to an account of its model provider; Codex stays pinned per game', async () => {
		const { impl, sent } = fakeFetch((n, s) =>
			s.url.endsWith('/usage')
				? {
						status: 200,
						body: {
							reports: [
								{
									provider: 'anthropic',
									limits: [{ window: { id: '7d', resetsAt: Date.now() + 3_600_000 }, amount: { used: 100 } }],
									metadata: { limitReached: true }
								}
							]
						}
					}
				: okReply(n)
		);
		const pool = new GatewayPool(
			[
				{ label: 'berkeley', url: 'http://a/v1', token: 'tok-a' },
				{ label: 'gmail', url: 'http://b/v1', token: 'tok-b' },
				{ label: 'claude', url: 'http://c/v1', token: 'tok-c', provider: 'anthropic' }
			],
			{ gate: { maxConcurrent: 4 }, target: 2, fetchImpl: impl }
		);
		const p = new GatewayProvider({ api: 'responses', pool, fetchImpl: impl });
		expect(pool.leastLoaded('anthropic')!.label).toBe('claude');
		expect(pool.leastLoaded()!.provider).toBe('openai-codex');
		pool.assign('g1', pool.byLabel('gmail')!);
		pool.assign('g1', pool.byLabel('claude')!);
		const opus = (key: string) => ({ ...chat('D', key), model: 'anthropic/claude-opus-5-5' });
		await p.complete(chat('D', 'g1:Red'));
		await p.complete(opus('g1:Blue'));
		await p.complete(chat('D', 'g1:Green'));
		await p.complete(opus('g1:Yellow'));
		expect(sent.map((s) => `${s.url} ${s.auth}`)).toEqual([
			'http://b/v1/responses Bearer tok-b',
			'http://c/v1/responses Bearer tok-c',
			'http://b/v1/responses Bearer tok-b',
			'http://c/v1/responses Bearer tok-c'
		]);
		expect(pool.labelOf('g1')).toBe('gmail+claude');
		expect(pool.byLabel('claude')!.games.has('g1')).toBe(true);
		expect(pool.byLabel('claude')!.window(0).calls).toBe(2);
		// Its quota is read from the anthropic report; a blocked Claude account blocks only Claude seats.
		await pool.refreshUsage();
		expect(pool.byLabel('claude')!.blocked()).toBe(true);
		expect(pool.byLabel('gmail')!.blocked()).toBe(false);
		expect(pool.nextReset('anthropic')).toBeGreaterThan(Date.now());
		expect(pool.nextReset('openai-codex')).toBeNull();
		expect(pool.accountFor('g1', 'anthropic')).toBeNull();
		expect(pool.accountFor('g1')!.label).toBe('gmail');
		pool.release('g1');
		expect(pool.labelOf('g1')).toBeNull();
		expect(pool.byLabel('gmail')!.games.size + pool.byLabel('claude')!.games.size).toBe(0);
	});

	it('a usage limit blocks the account until its reset; the game moves on without old reasoning', async () => {
		let limitOnA = false;
		const { impl, sent } = fakeFetch((n, s) => {
			if (s.url.endsWith('/usage'))
				return {
					status: 200,
					body: {
						reports: [
							{
								provider: 'openai-codex',
								limits: [
									{ window: { id: '7d', resetsAt: Date.now() + 3_600_000 }, amount: { used: 100 } }
								],
								metadata: { limitReached: true }
							}
						]
					}
				};
			if (limitOnA && s.url.startsWith('http://a/'))
				return {
					status: 429,
					body: { error: { message: "You've hit your usage limit. Try again later." } }
				};
			return okReply(n);
		});
		const events: string[] = [];
		const pool = new GatewayPool(
			[
				{ label: 'berkeley', url: 'http://a/v1', token: 'tok-a' },
				{ label: 'gmail', url: 'http://b/v1', token: 'tok-b' }
			],
			{ gate: { maxConcurrent: 4 }, fetchImpl: impl, onEvent: (t) => events.push(t) }
		);
		const p = new GatewayProvider({
			api: 'responses',
			history: 'reasoning',
			pool,
			fetchImpl: impl
		});
		pool.assign('g1', pool.byLabel('berkeley')!);
		await p.complete(chat('D1', 'g1:Red'));
		limitOnA = true;
		const res = await p.complete(chat('D2', 'g1:Red'));
		expect(res.text).toMatch(/^A/);
		expect(pool.byLabel('berkeley')!.blocked()).toBe(true);
		expect(pool.labelOf('g1')).toBe('gmail');
		expect(events.join('\n')).toMatch(
			/berkeley blocked until .* moved from berkeley to gmail|blocked until/s
		);
		const last = sent.filter((s) => s.url.startsWith('http://b/')).at(-1)!;
		const input = (last.body as unknown as { input: Record<string, unknown>[] }).input;
		expect(input.some((i) => i.type === 'reasoning')).toBe(false);
		expect(input.map((i) => i.content)).toEqual(['D1', 'A1', 'D2']);
		expect(JSON.stringify(events)).not.toContain('tok-a');
		// Both blocked: the pool reports the first reset.
		await pool.block(pool.byLabel('gmail')!, 'test');
		expect(pool.nextReset()).toBeGreaterThan(Date.now());
	});
});

describe('gateway provider: a call that gets no answer (timeoutRetries)', () => {
	/** A fetch that gives no answer (as AbortSignal.timeout does) for the first `silent` calls. */
	function silentThenOk(silent: number) {
		let n = 0;
		const sent: string[][] = [];
		const keys: string[] = [];
		const impl = (async (_url: string, init: RequestInit) => {
			n += 1;
			sent.push(JSON.parse(String(init.body)).messages.map((m: { content: string }) => m.content));
			keys.push(JSON.parse(String(init.body)).prompt_cache_key);
			if (n <= silent) throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
			return new Response(JSON.stringify(ok('{"action":"a1","reason":"r"}').body), { status: 200 });
		}) as unknown as typeof fetch;
		return { impl, sent, keys, calls: () => n };
	}
	const make = (impl: typeof fetch, timeoutRetries?: number) =>
		new GatewayProvider({ baseUrls: ['http://h/v1'], token: 't', fetchImpl: impl, timeoutRetryPauseMs: 1, ...(timeoutRetries === undefined ? {} : { timeoutRetries }) });

	it('by default the timeout goes up at once (the seat then falls back), as before', async () => {
		const f = silentThenOk(1);
		await expect(make(f.impl).complete(chat('D1', 'g:Red'))).rejects.toThrow('gw timeout');
		expect(f.calls()).toBe(1);
	});

	it('with timeoutRetries the same call is sent again and its answer is used', async () => {
		const f = silentThenOk(2);
		const p = make(f.impl, 4);
		const res = await p.complete(chat('D1', 'g:Red'));
		expect(res.text).toBe('{"action":"a1","reason":"r"}');
		expect(res.httpAttempts).toBe(3);
		expect(f.calls()).toBe(3);
		// Every try carried the same conversation; the answer is stored once.
		expect(f.sent[0]).toEqual(f.sent[2]);
		await p.complete(chat('D2', 'g:Red'));
		expect(f.sent[3]).toEqual(['BRIEF', 'D1', '{"action":"a1","reason":"r"}', 'D2']);
		// Each retry goes out under a new key, and the seat keeps the last one; another seat is untouched.
		expect(f.keys).toEqual(['g:Red', 'g:Red~t1', 'g:Red~t2', 'g:Red~t2']);
		await p.complete(chat('B1', 'g:Blue'));
		expect(f.keys[4]).toBe('g:Blue');
	});

	it('gives up after the allowed number of retries', async () => {
		const f = silentThenOk(99);
		await expect(make(f.impl, 2).complete(chat('D1', 'g:Red'))).rejects.toThrow('gw timeout');
		expect(f.calls()).toBe(3);
	});
});
