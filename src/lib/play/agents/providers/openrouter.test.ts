/** OpenRouter provider against an injected fetch (no network, no real key). */

import { describe, expect, it } from 'vitest';
import { OpenRouterProvider } from './openrouter';
import { ProviderError } from './types';

const KEY = 'sk-or-test-SECRET-123';

function fakeFetch(
	responses: { status: number; body: unknown; headers?: Record<string, string> }[]
) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const impl = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		const next = responses.shift();
		if (!next) throw new Error('no more fake responses');
		return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), {
			status: next.status,
			headers: next.headers
		});
	}) as typeof fetch;
	return { impl, calls };
}

const request = {
	model: 'test/model',
	messages: [{ role: 'user' as const, content: 'hello' }],
	maxTokens: 50
};

describe('OpenRouterProvider', () => {
	it('returns text, tokens and the reported cost; sends the key only in the header', async () => {
		const { impl, calls } = fakeFetch([
			{
				status: 200,
				body: {
					id: 'gen-1',
					model: 'test/model-2026',
					choices: [{ message: { content: '{"action":"a1"}' } }],
					usage: { prompt_tokens: 120, completion_tokens: 9, cost: 0.00042 }
				}
			}
		]);
		const provider = new OpenRouterProvider({ apiKey: KEY, fetchImpl: impl });
		const res = await provider.complete(request);
		expect(res).toMatchObject({
			text: '{"action":"a1"}',
			promptTokens: 120,
			completionTokens: 9,
			costUsd: 0.00042,
			costEstimated: false,
			servedModel: 'test/model-2026',
			providerRequestId: 'gen-1'
		});
		expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
		expect(String(calls[0].init?.body)).not.toContain(KEY);
		expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
			model: 'test/model',
			max_tokens: 50
		});
	});

	it('treats an HTTP 200 error body as an error and never puts the key in the message', async () => {
		const { impl } = fakeFetch([
			{ status: 200, body: { error: { code: 402, message: `Insufficient credits for ${KEY}` } } }
		]);
		const provider = new OpenRouterProvider({ apiKey: KEY, fetchImpl: impl, maxRetries: 0 });
		const error = await provider.complete(request).catch((e) => e);
		expect(error).toBeInstanceOf(ProviderError);
		expect(error.status).toBe(402);
		expect(error.retryable).toBe(false);
		expect(error.message).not.toContain(KEY);
	});

	it('retries a 429 and then succeeds; estimates cost from list prices when cost is missing', async () => {
		const { impl, calls } = fakeFetch([
			{
				status: 429,
				body: { error: { code: 429, message: 'rate limited' } },
				headers: { 'retry-after': '0.01' }
			},
			{
				status: 200,
				body: {
					choices: [{ message: { content: 'ok' } }],
					usage: { prompt_tokens: 1000, completion_tokens: 100 }
				}
			},
			{
				status: 200,
				body: {
					data: [{ id: 'test/model', pricing: { prompt: '0.000001', completion: '0.000002' } }]
				}
			}
		]);
		const provider = new OpenRouterProvider({ apiKey: KEY, fetchImpl: impl, maxRetries: 1 });
		const res = await provider.complete(request);
		expect(calls).toHaveLength(3);
		expect(res.costEstimated).toBe(true);
		expect(res.costUsd).toBeCloseTo(1000 * 0.000001 + 100 * 0.000002, 10);
		// The pre-call estimate uses the cached list price and the output cap.
		expect(await provider.estimateCostUsd(request)).toBeCloseTo(2 * 0.000001 + 50 * 0.000002, 10);
	});

	it('refuses to start without a key', () => {
		const saved = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		try {
			expect(() => new OpenRouterProvider()).toThrow(/OPENROUTER_API_KEY/);
		} finally {
			if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
		}
	});
});

describe('OpenRouterProvider key redaction at the cut', () => {
	it('redacts the key before shortening an error body', async () => {
		const body = `${'x'.repeat(190)}${KEY}${'y'.repeat(50)}`;
		const { impl } = fakeFetch([{ status: 500, body }]);
		const provider = new OpenRouterProvider({ apiKey: KEY, fetchImpl: impl, maxRetries: 0 });
		const error = await provider.complete(request).catch((e) => e);
		expect(error.message).not.toContain(KEY.slice(0, 8));
	});
});
