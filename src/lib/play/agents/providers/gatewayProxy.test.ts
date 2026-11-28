/**
 * The model proxy (a pool account with `proxy: true`): seats call it directly with `X-Session-ID`
 * (Michael, 2026-11-27: "requests go to the same accounts and we can spread requests across
 * accounts"). A fake fetch and a fake status report: no network, no real key.
 */

import { describe, expect, it } from 'vitest';
import { GatewayProvider, proxySessionId, PROXY_SESSION_ID_MAX } from './gateway';
import { GatewayPool } from './gatewayPool';
import type { ChatRequest } from './types';

process.env.ARC_GATEWAY_TOKEN_FILE = '/nonexistent/arc-gateway-test.token';

interface Sent {
	url: string;
	headers: Record<string, string>;
	body: { model: string; input?: { role?: string; type?: string; content?: string }[]; prompt_cache_key?: string };
}
type Reply = { status: number; body: unknown } | 'silent';

function fake(reply: (n: number, sent: Sent) => Reply) {
	const sent: Sent[] = [];
	const impl = (async (url: string, init: RequestInit = {}) => {
		if (String(url).endsWith('/models'))
			return new Response(JSON.stringify({ data: [{ id: 'gpt-6.2-astra' }, { id: 'claude-opus-5-5' }] }), { status: 200 });
		const entry: Sent = { url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
		sent.push(entry);
		const r = reply(sent.length, entry);
		if (r === 'silent') throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
		return new Response(JSON.stringify(r.body), { status: r.status });
	}) as unknown as typeof fetch;
	return { impl, sent };
}
const answer = (n: number, enc = true) => ({
	status: 200,
	body: {
		id: `r${n}`,
		output: [
			...(enc ? [{ type: 'reasoning', id: `rs_${n}`, summary: [], encrypted_content: `ENC${n}` }] : []),
			{ type: 'message', content: [{ type: 'output_text', text: `A${n}` }] }
		],
		usage: { input_tokens: 1000, output_tokens: 5 }
	}
});
const ask = (content: string, key: string, model = 'openai-codex/gpt-6.2-astra'): ChatRequest => ({
	model,
	messages: [{ role: 'system', content: 'BRIEF' }, { role: 'user', content }],
	maxTokens: 400,
	meta: { seat: 'Red', requestId: 'r', offeredIds: ['a1'], attempt: 1, sessionKey: key }
});
const GATE = { maxConcurrent: 8, ratePerMin: 6000, baseBackoffMs: 1, maxBackoffMs: 2 };
const account = (provider: string, pct: number, disabled = false, until: number | null = null) => ({
	provider,
	disabled,
	until,
	windows: [{ kind: 'week', pct, resets_at: 2_000_000_000 }]
});
function setup(reply: (n: number, sent: Sent) => Reply, status: Record<string, unknown> = { a: account('codex', 27), b: account('codex', 86) }) {
	const f = fake(reply);
	const events: string[] = [];
	const pool = new GatewayPool(
		[
			{ label: 'proxy-codex', url: 'http://proxy/v1', token: 'KEY', proxy: true },
			{ label: 'proxy-claude', url: 'http://proxy/v1', token: 'KEY', proxy: true, provider: 'anthropic' }
		],
		{ gate: GATE, fetchImpl: f.impl, onEvent: (t) => events.push(t), proxyStatusImpl: async () => JSON.stringify({ accounts: status }) }
	);
	const provider = new GatewayProvider({
		api: 'responses',
		history: 'reasoning',
		pool,
		fetchImpl: f.impl,
		timeoutRetries: 3,
		timeoutRetryPauseMs: 1,
		overloadPauseMs: 1,
		overloadRetries: 2
	});
	return { ...f, pool, provider, events };
}

describe('the session id of a seat at the proxy', () => {
	it('is short enough to be read whole in the proxy log, and one per seat of a game', () => {
		expect(proxySessionId('league-v1-g7-s10062:Red')).toBe('g7-10062-Re');
		expect(proxySessionId('league-v1-g7-s10062:Blue')).toBe('g7-10062-Bl');
		expect(proxySessionId('league-v1-g16-s10077:Orange')).toBe('g16-10077-Or');
		const ids = ['Red', 'Blue', 'Orange', 'Green'].flatMap((seat) => [1, 2, 3].map((g) => proxySessionId(`league-v1-g${g}-s1006${g}:${seat}`)));
		expect(new Set(ids).size).toBe(12);
		for (const id of [...ids, proxySessionId('a very long key of another kind: with spaces'), proxySessionId('run-x-g123456-s1234567:Red')]) {
			expect(id.length).toBeLessThanOrEqual(PROXY_SESSION_ID_MAX);
			expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
		}
		expect(proxySessionId('short-key')).toBe('short-key');
	});
});

describe('seats that call the model proxy directly', () => {
	it('every call of a seat carries its X-Session-ID, the bare model id and the key of the proxy', async () => {
		const t = setup((n) => answer(n));
		await t.provider.complete(ask('D1', 'league-v1-g7-s10062:Red'));
		await t.provider.complete(ask('D2', 'league-v1-g7-s10062:Red'));
		await t.provider.complete(ask('B1', 'league-v1-g7-s10062:Blue'));
		await t.provider.complete(ask('C1', 'league-v1-g7-s10062:Green', 'anthropic/claude-opus-5-5'));
		expect(t.sent.map((s) => s.headers['X-Session-ID'])).toEqual(['g7-10062-Re', 'g7-10062-Re', 'g7-10062-Bl', 'g7-10062-Gr']);
		expect(t.sent.map((s) => s.body.model)).toEqual(['gpt-6.2-astra', 'gpt-6.2-astra', 'gpt-6.2-astra', 'claude-opus-5-5']);
		expect(t.sent.every((s) => s.url === 'http://proxy/v1/responses' && s.headers.Authorization === 'Bearer KEY')).toBe(true);
		// The second call of the seat holds the first exchange with its reasoning item.
		expect(t.sent[1].body.input?.map((i) => i.type ?? i.role)).toEqual(['user', 'reasoning', 'assistant', 'user']);
	});

	it('a call with no answer is sent again under the same session id and cache key', async () => {
		const t = setup((n) => (n <= 2 ? 'silent' : answer(n)));
		const res = await t.provider.complete(ask('D1', 'league-v1-g7-s10062:Red'));
		expect(res.text).toBe('A3');
		expect(t.sent.map((s) => s.headers['X-Session-ID'])).toEqual(['g7-10062-Re', 'g7-10062-Re', 'g7-10062-Re']);
		expect(t.sent.map((s) => s.body.prompt_cache_key)).toEqual(Array(3).fill('league-v1-g7-s10062:Red'));
	});

	it('502 and 503 wait and send the same call again; after the allowed tries the error goes up', async () => {
		const t = setup((n) => (n <= 2 ? { status: n === 1 ? 503 : 502, body: { error: { message: 'overloaded' } } } : answer(n)));
		expect((await t.provider.complete(ask('D1', 'league-v1-g7-s10062:Red'))).text).toBe('A3');
		expect(t.sent).toHaveLength(3);
		const u = setup(() => ({ status: 503, body: { error: { message: 'overloaded' } } }));
		await expect(u.provider.complete(ask('D1', 'league-v1-g7-s10062:Red'))).rejects.toThrow('gw 503');
	});

	it('a seat moved to another real account: refused reasoning items are dropped once and the call goes through', async () => {
		const t = setup((n) => (n === 2 ? { status: 400, body: { error: { message: 'The encrypted content could not be verified.' } } } : answer(n)));
		await t.provider.complete(ask('D1', 'league-v1-g7-s10062:Red'));
		expect((await t.provider.complete(ask('D2', 'league-v1-g7-s10062:Red'))).text).toBe('A3');
		expect(t.sent[1].body.input?.some((i) => i.type === 'reasoning')).toBe(true);
		expect(t.sent[2].body.input?.map((i) => i.type ?? i.role)).toEqual(['user', 'assistant', 'user']);
	});
});

describe('usage and caps come from the proxy status', () => {
	it('reads the accounts of its provider, names none of them, and is open while one is on', async () => {
		const t = setup((n) => answer(n), {
			'person@example.com': account('codex', 27),
			'other@example.com': account('codex', 86),
			'third@example.com': account('codex', 100, true, 1_900_000_000),
			'claude@example.com': account('claude', 47)
		});
		const codex = t.pool.byLabel('proxy-codex')!;
		const usage = await t.pool.readUsage(codex);
		expect(usage.windows.map((w) => `${w.id} ${w.usedPercent}`)).toEqual(['a1 27', 'a2 86', 'a3 off 100']);
		expect(usage.usedPercent).toBe(27);
		expect(usage.limitReached).toBe(false);
		expect(JSON.stringify(usage)).not.toContain('@');
		expect((await t.pool.readUsage(t.pool.byLabel('proxy-claude')!)).windows).toHaveLength(1);
		await t.pool.refreshUsage();
		expect(codex.blocked()).toBe(false);
	});

	it('every account off: the entry waits for the first one that comes back', async () => {
		const back = Date.now() + 3 * 3600_000;
		const t = setup((n) => answer(n), {
			a: account('codex', 99, true, back / 1000),
			b: account('codex', 100, true, back / 1000 + 7200)
		});
		await t.pool.refreshUsage();
		const codex = t.pool.byLabel('proxy-codex')!;
		expect(codex.blocked()).toBe(true);
		expect(Math.abs((codex.blockedUntil ?? 0) - back)).toBeLessThan(2000);
		expect(t.events.join('\n')).toContain('every account of the proxy is off');
		expect(t.pool.byLabel('proxy-claude')!.blocked()).toBe(false);
	});

	it('"no account has this model" from the proxy is a wait, not a move made for the player', async () => {
		const t = setup((n) => (n === 1 ? { status: 400, body: { error: { code: 'model_not_found', message: 'unknown provider for model gpt-6.2-astra' } } } : answer(n)));
		const codex = t.pool.byLabel('proxy-codex')!;
		const call = t.provider.complete(ask('D1', 'league-v1-g7-s10062:Red'));
		await new Promise((r) => setTimeout(r, 30));
		expect(codex.blocked()).toBe(true);
		expect(t.events.join('\n')).toContain('the proxy refused a call');
		codex.blockedUntil = Date.now() - 1; // the pause is over
		void call.catch(() => {});
	});

	it('the start check refuses a model the proxy does not list', async () => {
		const t = setup((n) => answer(n));
		await expect(t.pool.check(['openai-codex/gpt-6.2-astra', 'anthropic/claude-opus-5-5'])).resolves.toBeUndefined();
		await expect(t.pool.check(['openai-codex/gpt-9-nothing'])).rejects.toThrow('has no model "gpt-9-nothing"');
	});
});
