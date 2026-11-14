/**
 * OpenRouter provider (OpenAI-compatible chat completions).
 *
 * - The key is read from `OPENROUTER_API_KEY` at construction and kept only in memory. It is
 *   never logged, never put in an error message and never written to a record.
 * - Usage (`prompt_tokens`, `completion_tokens`, `cost`) is always in the response body. When
 *   `cost` is missing, it is estimated from the model's list price (`GET /api/v1/models`,
 *   USD per token) and flagged `costEstimated`.
 * - OpenRouter can return an error with HTTP 200 (`{ error: {...} }` and no `choices`), so the
 *   body is always checked.
 * - Retries: 429 / 502 / 503 / 408 / network errors, up to `maxRetries`, honoring Retry-After.
 * - Prompt caching: the fixed rules brief is marked cacheable for models that need a mark.
 *   402 (no credits) and other 4xx fail at once.
 */

import {
	estimateTokens,
	ProviderError,
	type ChatProvider,
	type ChatRequest,
	type ChatResponse
} from './types';

const BASE_URL = 'https://openrouter.ai/api/v1';
const RETRYABLE = new Set([408, 429, 502, 503, 524, 529]);
/** Assumed price when a model's list price is unknown: high on purpose (USD per token). */
const UNKNOWN_PRICE = { prompt: 10 / 1e6, completion: 30 / 1e6 };

export interface OpenRouterOptions {
	apiKey?: string;
	baseUrl?: string;
	timeoutMs?: number;
	maxRetries?: number;
	/** Injected for tests. */
	fetchImpl?: typeof fetch;
}

/**
 * The rules brief (first system message) is identical for a whole run. OpenAI, DeepSeek, Grok
 * and others cache a repeated prefix automatically; Anthropic and Gemini models need an explicit
 * `cache_control` mark on the content part, so add it for them.
 */
function wireMessages(request: ChatRequest): unknown[] {
	const explicitCache = /^(anthropic|google)\//.test(request.model);
	return request.messages.map((m, i) =>
		explicitCache && i === 0 && m.role === 'system'
			? {
					role: m.role,
					content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
				}
			: m
	);
}

interface Pricing {
	prompt: number;
	completion: number;
}

export class OpenRouterProvider implements ChatProvider {
	readonly name = 'openrouter';
	readonly #apiKey: string;
	readonly #baseUrl: string;
	readonly #timeoutMs: number;
	readonly #maxRetries: number;
	readonly #fetch: typeof fetch;
	readonly #pricing = new Map<string, Promise<Pricing | null>>();

	constructor(opts: OpenRouterOptions = {}) {
		const key = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
		if (!key.trim()) {
			throw new ProviderError(
				'OPENROUTER_API_KEY is not set; use a mock seat or export the key.',
				null,
				false
			);
		}
		this.#apiKey = key.trim();
		this.#baseUrl = opts.baseUrl ?? BASE_URL;
		this.#timeoutMs = opts.timeoutMs ?? 90_000;
		this.#maxRetries = opts.maxRetries ?? 1;
		this.#fetch = opts.fetchImpl ?? fetch;
	}

	static available(): boolean {
		return !!process.env.OPENROUTER_API_KEY?.trim();
	}

	async estimateCostUsd(request: ChatRequest): Promise<number> {
		const price = (await this.#priceOf(request.model)) ?? UNKNOWN_PRICE;
		return estimateTokens(request.messages) * price.prompt + request.maxTokens * price.completion;
	}

	async complete(request: ChatRequest): Promise<ChatResponse> {
		let lastError: ProviderError | null = null;
		let billed = 0;
		for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
			try {
				const res = await this.#once(request);
				return { ...res, httpAttempts: attempt + 1, possiblyBilledFailures: billed };
			} catch (err) {
				const timedOut =
					(err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
				const error =
					err instanceof ProviderError
						? err
						: new ProviderError(
								`${timedOut ? 'timeout' : 'network error'}: ${this.#redact(String((err as Error)?.message ?? err))}`.slice(
									0,
									300
								),
								null,
								// A timed-out request may still run (and be billed): do not send it again.
								!timedOut
							);
				// No HTTP status = the request may have reached the model: count it as possibly billed.
				if (error.status === null) billed += 1;
				error.httpAttempts = attempt + 1;
				error.possiblyBilledAttempts = billed;
				if (request.signal?.aborted) throw error;
				lastError = error;
				if (!error.retryable || attempt === this.#maxRetries) throw error;
				const waitMs =
					(error as ProviderError & { retryAfterMs?: number }).retryAfterMs ?? 1500 * 2 ** attempt;
				await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 20_000)));
			}
		}
		throw lastError ?? new ProviderError('unknown provider failure', null, false);
	}

	async #once(request: ChatRequest): Promise<ChatResponse> {
		const timeout = AbortSignal.timeout(this.#timeoutMs);
		const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
		const res = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
			method: 'POST',
			signal,
			headers: {
				Authorization: `Bearer ${this.#apiKey}`,
				'Content-Type': 'application/json',
				// Generic attribution only (no user or project details).
				'X-Title': 'arc-agent-harness'
			},
			body: JSON.stringify({
				model: request.model,
				messages: wireMessages(request),
				max_tokens: request.maxTokens,
				...(request.temperature === undefined ? {} : { temperature: request.temperature })
			})
		});
		const bodyText = await res.text();
		let body: Record<string, unknown> = {};
		try {
			body = JSON.parse(bodyText) as Record<string, unknown>;
		} catch {
			// Non-JSON body (gateway HTML): treated as an error below.
		}
		const apiError = body.error as { code?: number | string; message?: string } | undefined;
		if (!res.ok || apiError || !Array.isArray(body.choices)) {
			const status = res.ok ? Number(apiError?.code) || res.status : res.status;
			// Redact BEFORE cutting, so no part of the key can survive at the cut.
			const message = `OpenRouter ${status}: ${this.#redact(String(apiError?.message ?? bodyText)).slice(0, 200)}`;
			const error = new ProviderError(message, status, RETRYABLE.has(status)) as ProviderError & {
				retryAfterMs?: number;
			};
			const retryAfter = Number(res.headers.get('retry-after'));
			if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000;
			throw error;
		}
		const choice = (body.choices as { message?: { content?: unknown } }[])[0];
		const content = choice?.message?.content;
		const text =
			typeof content === 'string'
				? content
				: Array.isArray(content)
					? content.map((c) => (c as { text?: string }).text ?? '').join('')
					: '';
		const usage = (body.usage ?? {}) as {
			prompt_tokens?: number;
			completion_tokens?: number;
			cost?: number;
		};
		const promptTokens = usage.prompt_tokens ?? 0;
		const completionTokens = usage.completion_tokens ?? 0;
		let costUsd = typeof usage.cost === 'number' ? usage.cost : NaN;
		let costEstimated = false;
		const servedModel = typeof body.model === 'string' ? body.model : undefined;
		if (!Number.isFinite(costUsd)) {
			const pricing = await this.#priceOf(request.model);
			// Unknown price: assume an expensive model so a spend cap errs on the safe side.
			const p = pricing ?? UNKNOWN_PRICE;
			costUsd = promptTokens * p.prompt + completionTokens * p.completion;
			costEstimated = true;
		}
		return {
			text,
			promptTokens,
			completionTokens,
			costUsd,
			costEstimated,
			servedModel,
			providerRequestId: typeof body.id === 'string' ? body.id : undefined
		};
	}

	#redact(text: string): string {
		return text.replaceAll(this.#apiKey, '[key]');
	}

	#priceOf(model: string): Promise<Pricing | null> {
		let pending = this.#pricing.get(model);
		if (!pending) {
			pending = (async () => {
				try {
					const res = await this.#fetch(`${this.#baseUrl}/models`, {
						signal: AbortSignal.timeout(20_000)
					});
					if (!res.ok) return null;
					const list = (await res.json()) as {
						data?: { id: string; pricing?: { prompt?: string; completion?: string } }[];
					};
					const entry = list.data?.find((m) => m.id === model);
					const prompt = Number(entry?.pricing?.prompt);
					const completion = Number(entry?.pricing?.completion);
					return Number.isFinite(prompt) && Number.isFinite(completion)
						? { prompt, completion }
						: null;
				} catch {
					return null;
				}
			})();
			this.#pricing.set(model, pending);
		}
		return pending;
	}
}
