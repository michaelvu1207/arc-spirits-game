import { createServer } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { callGateway, createWorker, loadConfig, pickAction, proxyModel, proxySession } from './worker.mjs';

/** A tiny local HTTP stub: `routes[method path](body, req)` → [status, json]. */
async function stub(routes) {
	const calls = [];
	const server = createServer(async (req, res) => {
		let raw = '';
		for await (const chunk of req) raw += chunk;
		const body = raw ? JSON.parse(raw) : null;
		const key = `${req.method} ${req.url}`;
		calls.push({ key, body, headers: req.headers });
		const handler = routes[key];
		const [status, json] = handler ? await handler(body, req) : [404, { error: 'no route' }];
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify(json));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${server.address().port}`;
	return { url, calls, close: () => new Promise((resolve) => server.close(resolve)) };
}

const ITEM = {
	roomCode: 'ROOM01',
	seat: 'Blue',
	revision: 12,
	system: 'RULES BRIEF',
	prompt: 'DECISION … LEGAL ACTIONS: a1 a2',
	actions: [
		{ id: 'a1', label: 'Go to the Mountain' },
		{ id: 'a2', label: 'Go to the Sea' }
	],
	waitingMs: 1000
};

const servers = [];
afterEach(async () => {
	while (servers.length) await servers.pop().close();
});

async function setup({ answers, pendingItems = [ITEM], actStatus = 200 }) {
	const gateway = await stub({
		'POST /v1/chat/completions': () => {
			const text = answers.shift() ?? '';
			return [200, { choices: [{ message: { role: 'assistant', content: text } }] }];
		}
	});
	const site = await stub({
		'GET /api/ai/pending': () => [200, { items: pendingItems }],
		'POST /api/ai/act': () => [actStatus, actStatus === 200 ? { ok: true, revision: 13 } : { message: 'bad id' }]
	});
	servers.push(gateway, site);
	const cfg = {
		site: site.url,
		key: 'worker-key',
		gatewayUrl: `${gateway.url}/v1`,
		token: 'gateway-token',
		model: 'anthropic/claude-opus-5-5',
		effort: 'medium'
	};
	const lines = [];
	const worker = createWorker(cfg, { log: (line) => lines.push(line) });
	return { gateway, site, worker, lines };
}

describe('ai worker', () => {
	test('asks the gateway in the harness chat shape and posts the chosen action', async () => {
		const { gateway, site, worker, lines } = await setup({
			answers: ['Thinking… {"action": "a2", "reason": "The sea is open."}']
		});
		const { started } = await worker.poll();
		await Promise.all(started);

		const [call] = gateway.calls;
		expect(call.headers.authorization).toBe('Bearer gateway-token');
		expect(call.body).toEqual({
			model: 'anthropic/claude-opus-5-5',
			messages: [
				{ role: 'system', content: 'RULES BRIEF' },
				{ role: 'user', content: ITEM.prompt }
			],
			reasoning_effort: 'medium'
		});
		const act = site.calls.find((c) => c.key === 'POST /api/ai/act');
		expect(act.headers['x-arc-ai-key']).toBe('worker-key');
		expect(act.body).toEqual({
			roomCode: 'ROOM01',
			seat: 'Blue',
			revision: 12,
			actionId: 'a2',
			reason: 'The sea is open.'
		});
		expect(lines.join('\n')).toContain('ROOM01 Blue → Go to the Sea');
		expect(lines.join('\n')).not.toContain('gateway-token');

		// The same revision is never asked twice.
		await Promise.all((await worker.poll()).started);
		expect(gateway.calls).toHaveLength(1);
	});

	test('a bad answer is repaired once, then the revision is given up', async () => {
		const { gateway, site, worker } = await setup({ answers: ['no idea', 'still {"action":"a9"}'] });
		await Promise.all((await worker.poll()).started);
		expect(gateway.calls).toHaveLength(2);
		const repair = gateway.calls[1].body.messages.at(-1);
		expect(repair.role).toBe('user');
		expect(repair.content).toContain('Your answer could not be used');
		expect(site.calls.some((c) => c.key === 'POST /api/ai/act')).toBe(false);
	});

	test('a single legal action is posted without a model call', async () => {
		const forced = { ...ITEM, actions: [{ id: 'a1', label: 'End your turn' }] };
		const { gateway, site, worker } = await setup({ answers: [], pendingItems: [forced] });
		await Promise.all((await worker.poll()).started);
		expect(gateway.calls).toHaveLength(0);
		expect(site.calls.find((c) => c.key === 'POST /api/ai/act').body.actionId).toBe('a1');
	});

	test('config: the model proxy by default, its key from a command; Opus or Fable', () => {
		const read = () => 'tok';
		const run = () => '{"key": "proxy-key", "url": "https://example.invalid:8317"}\n';
		expect(() => loadConfig({}, read, run)).toThrow('ARC_AI_WORKER_KEY');
		expect(loadConfig({ ARC_AI_WORKER_KEY: 'k' }, read, run)).toMatchObject({
			site: 'https://arcspirits.com',
			gatewayUrl: 'http://127.0.0.1:8317/v1',
			model: 'anthropic/claude-opus-5-5',
			effort: 'medium',
			token: 'proxy-key',
			proxy: true
		});
		// A bare key is accepted too, and Fable is an allowed model.
		expect(loadConfig({ ARC_AI_WORKER_KEY: 'k', ARC_AI_MODEL: 'anthropic/claude-fable-5-2' }, read, () => 'bare-key\n')).toMatchObject({
			model: 'anthropic/claude-fable-5-2',
			token: 'bare-key'
		});
		expect(() => loadConfig({ ARC_AI_WORKER_KEY: 'k' }, read, () => { throw new Error('no ccc'); })).toThrow('proxy key command failed');
		expect(() => loadConfig({ ARC_AI_WORKER_KEY: 'k' }, read, () => '')).toThrow('no key');
	});

	test('config: ARC_AI_PROXY=0 keeps the gateway with a token file', () => {
		expect(loadConfig({ ARC_AI_WORKER_KEY: 'k', ARC_AI_PROXY: '0' }, () => 'tok', () => { throw new Error('not called'); })).toMatchObject({
			gatewayUrl: 'http://127.0.0.1:4620/v1',
			token: 'tok',
			proxy: false
		});
	});

	test('the proxy gets the bare model id and one session id for the room', async () => {
		const gateway = await stub({
			'POST /v1/chat/completions': () => [200, { choices: [{ message: { role: 'assistant', content: '{"action":"a1"}' } }] }]
		});
		servers.push(gateway);
		const cfg = { gatewayUrl: `${gateway.url}/v1`, token: 'proxy-key', model: 'anthropic/claude-fable-5-2', effort: 'medium', proxy: true };
		const text = await callGateway(cfg, [{ role: 'user', content: 'x' }], fetch, proxySession('ROOM01'));
		expect(text).toBe('{"action":"a1"}');
		const call = gateway.calls[0];
		expect(call.body.model).toBe('claude-fable-5-2');
		expect(call.body.prompt_cache_key).toBe('arc-ai-ROOM01');
		expect(call.headers['x-session-id']).toBe('arc-ai-ROOM01');
		expect(call.headers.authorization).toBe('Bearer proxy-key');
		expect(proxyModel('anthropic/soon/claude-opus-5-5')).toBe('soon/claude-opus-5-5');
	});

	test('the proxy: 503 and 429 are sent again after a pause; other errors are not', async () => {
		const statuses = [503, 429, 200];
		const gateway = await stub({
			'POST /v1/chat/completions': () => {
				const status = statuses.shift();
				return status === 200
					? [200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] }]
					: [status, { error: { message: 'busy' } }];
			}
		});
		servers.push(gateway);
		const cfg = { gatewayUrl: `${gateway.url}/v1`, token: 't', model: 'anthropic/claude-opus-5-5', effort: 'medium', proxy: true };
		const pauses = [];
		const sleep = async (ms) => void pauses.push(ms);
		expect(await callGateway(cfg, [], fetch, 'arc-ai-R', sleep)).toBe('ok');
		expect(pauses).toEqual([15_000, 15_000]);
		expect(gateway.calls).toHaveLength(3);
		// A wrong model id (400) is not sent again.
		statuses.push(400);
		await expect(callGateway(cfg, [], fetch, 'arc-ai-R', sleep)).rejects.toThrow('gateway 400');
		expect(gateway.calls).toHaveLength(4);
	});

	test('pickAction accepts only offered ids', () => {
		expect(pickAction('```json\n{"action":"A1","reason":"x"}\n```', ITEM.actions)).toEqual({ id: 'a1', reason: 'x' });
		expect(pickAction('{"action": 2}', ITEM.actions)?.id).toBe('a2');
		expect(pickAction('{"action":"a7"}', ITEM.actions)).toBeNull();
		expect(pickAction('a2', ITEM.actions)?.id).toBe('a2');
	});
});
