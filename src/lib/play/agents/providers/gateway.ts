/**
 * Gateway provider (`gw:`): the local omp auth gateway, an OpenAI-compatible HTTP endpoint on
 * this machine pinned to one subscription account (scripts/agent-harness/gateway/). No process
 * per call.
 *
 * One continuous conversation per seat for the whole game: the provider keeps each seat's
 * message history itself (keyed by `meta.sessionKey` = `<run>-g<game>-s<seed>:<seat>`) and sends
 * the rules brief + the whole history + the new message on every call, with
 * `prompt_cache_key` = the session key (one account, cached prefix). Nothing is reset during a
 * game; a game's histories are dropped with {@link GatewayProvider.forgetGame} when it ends.
 * Only a call that succeeded adds its user message and the answer to the history. A fresh-question
 * seat (`meta.stateless`) sends its whole request each time; nothing is stored for it.
 *
 * - Base URLs: a list (default `ARC_GATEWAY_URL` or http://127.0.0.1:4610/v1); each game is
 *   pinned to one URL (hash of the game id), so later each game can run on one account.
 * - The token is read from a file (`ARC_GATEWAY_TOKEN_FILE`, default the gateway's own token
 *   file) at construction, kept only in memory, and never logged or put in an error message.
 * - Model ids MUST start with a subscription provider ({@link GATEWAY_PROVIDERS}: `openai-codex/…`
 *   or `anthropic/…`): the gateway also exposes an OpenRouter key, and any other id could be
 *   billed per token. Other ids are refused before any request is sent. With a pool, each call
 *   goes to an account of its model's provider (a game has one account per provider).
 * - 429 / usage-limit answers become `ProviderError` status 429: the run-wide call gate backs
 *   off, and stops the run after repeated limit failures. 5xx / network errors retry once here.
 * - A gateway that is not running gives a clear, non-retryable error (and `check()` tests it
 *   before a run without a model call).
 * - Cost is 0 (subscription). Usage: prompt, cached prompt, completion and reasoning tokens.
 * - The model proxy (a pool account with `proxy: true`, see gatewayPool.ts): the call goes straight
 *   to the proxy that owns the subscription logins. Each call carries `X-Session-ID` =
 *   {@link proxySessionId} of the seat's session key: the proxy keeps one id on one real account
 *   (warm prompt cache) and spreads the ids across its accounts. The model id goes out without the
 *   `<provider>/` part. A 502 / 503 waits `overloadPauseMs` and is sent again; "no account has this
 *   model" waits until the proxy has an account that is on.
 * - History modes ({@link GatewayHistory}): through the gateway, a plain multi-turn conversation
 *   can make the model reason on its first turn only. `reasoning` passes each earlier turn's
 *   encrypted reasoning items back in `input` (responses route, `store: false`), as the Codex CLI
 *   does; `single` sends the whole conversation so far as text in ONE user message per call, so
 *   every call is a single-turn request that still holds the full game memory. Both keep the
 *   prefix stable for prompt caching.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hashString } from '../../rng';
import type { GatewayAccount, GatewayPool } from './gatewayPool';
import {
	ProviderError,
	type ChatMessage,
	type ChatProvider,
	type ChatRequest,
	type ChatResponse
} from './types';

export const GATEWAY_DEFAULT_MODEL = 'openai-codex/gpt-6.1-sol';
export const GATEWAY_DEFAULT_URL = 'http://127.0.0.1:4610/v1';
/** The subscription providers a model id may start with (`<provider>/<model>`). */
export const GATEWAY_PROVIDERS = ['openai-codex', 'anthropic'] as const;
export type GatewayProviderId = (typeof GATEWAY_PROVIDERS)[number];
export const DEFAULT_GATEWAY_PROVIDER: GatewayProviderId = 'openai-codex';
export const GATEWAY_DEFAULT_TOKEN_FILE = join(
	homedir(),
	'.local/share/arcspirits-agent-gateway/home/.omp/auth-gateway.token'
);
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 524, 529]);
/** A request that no longer fits the model's context window. */
export const CONTEXT_FULL =
	/context.?(length|window)|maximum context|too many tokens|prompt is too long|input.{0,20}too (long|large)|exceeds.{0,30}(context|token)/i;
const START_HINT = 'start it with scripts/agent-harness/gateway/start.sh';

/** Session ids up to this length are printed whole in the proxy's log; longer ones are cut to a few letters. */
export const PROXY_SESSION_ID_MAX = 13;

/**
 * The `X-Session-ID` of a seat at the model proxy: one id = one real account. Short enough to be
 * read whole in the proxy's log. `…-g<game>-s<seed>:<seat>` becomes `g<game>-<seed>-<first two
 * letters of the seat>` (`g7-10062-Re`); another key is sent as it is when short, else as a hash.
 * Two runs with the same game number, seed and seat share an id: that only puts them on one account.
 */
export function proxySessionId(sessionKey: string): string {
	const m = /-g(\d+)-s(\d+):([A-Za-z]{2})[A-Za-z]*$/.exec(sessionKey);
	const short = m ? `g${m[1]}-${m[2]}-${m[3]}` : sessionKey;
	if (short.length <= PROXY_SESSION_ID_MAX && /^[A-Za-z0-9._-]+$/.test(short)) return short;
	return `h${hashString(sessionKey).toString(36)}${hashString(`${sessionKey}#`).toString(36)}`.slice(0, PROXY_SESSION_ID_MAX);
}

/** The proxy's answer when no account that is on has the model (all at their caps, or a wrong id). */
const PROXY_NO_ACCOUNT = /model_not_found|unknown provider for model/i;
/** A provider that refuses reasoning items made on another account. */
const REASONING_REFUSED = /encrypted[_ ]content|reasoning.{0,60}(invalid|not found|could not|cannot|unable)/i;

/** A model's subscription provider; refuses ids the gateway could route to a per-token key. */
export function gatewayProviderOf(model: string): GatewayProviderId {
	const at = model.indexOf('/');
	const provider = GATEWAY_PROVIDERS.find((p) => p === model.slice(0, at));
	if (!provider || at === model.length - 1)
		throw new ProviderError(
			`gw: model "${model}" refused: only ${GATEWAY_PROVIDERS.map((p) => `${p}/…`).join(' or ')} ids (subscription) are allowed`,
			null,
			false
		);
	return provider;
}

/** Refuse model ids that the gateway could route to a per-token (OpenRouter) key. */
export function assertGatewayModel(model: string): void {
	gatewayProviderOf(model);
}

/**
 * How a seat's earlier turns go to the model on each call:
 * - `messages`: plain user/assistant messages.
 * - `reasoning`: responses route only; earlier turns' encrypted reasoning items are passed back.
 * - `single`: the whole conversation so far as text in one user message (full memory, single turn).
 */
export type GatewayHistory = 'messages' | 'reasoning' | 'single';
export const GATEWAY_HISTORIES: GatewayHistory[] = ['messages', 'reasoning', 'single'];

/** One stored turn: a chat message, plus the reasoning items the model returned with an answer. */
interface StoredTurn extends ChatMessage {
	items?: unknown[];
}

const SINGLE_HEAD =
	'THIS GAME SO FAR: one continuous conversation between the game and you, oldest first. ' +
	'Each GAME block is a message from the game; each YOU block is your answer to it. ' +
	'Answer ONLY the last GAME block.';

/** The `single` mode text: every turn rendered the same way, so earlier calls are a prefix. */
export function singleTurnText(turns: ChatMessage[]): string {
	let n = 0;
	const blocks = turns.map((t) =>
		t.role === 'assistant' ? `### YOU (${n})\n${t.content}` : `### GAME (${++n})\n${t.content}`
	);
	return [SINGLE_HEAD, ...blocks].join('\n\n');
}

export interface GatewayOptions {
	/** Base URLs ending before `/chat/completions`. Default `ARC_GATEWAY_URL` or 127.0.0.1:4610. */
	baseUrls?: string[];
	/** Token file. Default `ARC_GATEWAY_TOKEN_FILE` or the gateway's own token file. */
	tokenFile?: string;
	/** A token given directly (tests). */
	token?: string;
	/** Reasoning effort sent with each call. Default high. */
	effort?: string;
	/** `chat` (/chat/completions, `reasoning_effort`) or `responses` (/responses, `reasoning.effort`). */
	api?: 'chat' | 'responses';
	/** How earlier turns are sent (see {@link GatewayHistory}). Default `messages`. */
	history?: GatewayHistory;
	/** Text added at the end of the system instructions of every call (e.g. a think-first rule). */
	systemSuffix?: string;
	/** Responses route: ask for a reasoning summary (`reasoning.summary`), as the Codex CLI does. */
	reasoningSummary?: 'auto' | 'concise' | 'detailed';
	/** Output cap; not sent by default (reasoning tokens count against it). */
	maxOutputTokens?: number | null;
	timeoutMs?: number;
	maxRetries?: number;
	/**
	 * How often a call that got NO answer within `timeoutMs` ("gw timeout") is sent again before the
	 * error goes up (default 0: the old behaviour, where the seat then plays a fallback move). With a
	 * provider that now and then leaves a request without any reply, a retry costs time, not a move
	 * made for the player. The retry goes out under a new `prompt_cache_key` (the session key plus
	 * `~t<n>`, kept for the seat's later calls), so a gateway that keeps one session per key starts a
	 * new session with the whole conversation instead of resuming the one whose call still hangs
	 * there. `timeoutRetryPauseMs` (default 2 s) is the pause before a retry.
	 */
	timeoutRetries?: number;
	timeoutRetryPauseMs?: number;
	/** The model proxy: the pause before a call that got 502 / 503 is sent again (default 60 s), at most `overloadRetries` times (default 30: the provider asks for about five minutes at a time). */
	overloadPauseMs?: number;
	overloadRetries?: number;
	/** Several accounts (one gateway each): games are pinned per account, each with its own call
	 *  gate; `baseUrls` / `tokenFile` are then not used (see gatewayPool.ts). */
	pool?: GatewayPool;
	/** Injected for tests. */
	fetchImpl?: typeof fetch;
}

/** A real usage limit (the account's window is used up), not the per-minute turn limit. */
export const USAGE_LIMIT =
	/usage.?limit|limit.?reached|insufficient.?quota|quota.?(exceeded|reached)|reached your .{0,40}limit/i;
const TURN_LIMIT = /turn_rate_limit|at capacity|rate.?limit|too many requests/i;

/** Where one call goes: a pooled account, or the single URL + token. */
interface Target {
	url: string;
	headers: Record<string, string>;
	redact: (text: string) => string;
	account: GatewayAccount | null;
	/** The model proxy: `X-Session-ID`, bare model id, one cache key for the whole game. */
	proxy: boolean;
}

export class GatewayProvider implements ChatProvider {
	readonly name = 'gw';
	readonly #urls: string[];
	readonly #token: string;
	readonly #effort: string;
	readonly #api: 'chat' | 'responses';
	readonly #mode: GatewayHistory;
	readonly #systemSuffix: string;
	readonly #reasoningSummary: string | undefined;
	readonly #maxOutputTokens: number | null;
	readonly #timeoutMs: number;
	readonly #maxRetries: number;
	readonly #timeoutRetries: number;
	readonly #timeoutRetryPauseMs: number;
	readonly #overloadPauseMs: number;
	readonly #overloadRetries: number;
	readonly #fetch: typeof fetch;
	readonly #pool: GatewayPool | null;
	/** How often each seat's calls timed out and were sent again: the suffix of its key on the wire. */
	readonly #timeoutEpoch = new Map<string, number>();
	/** Each seat's conversation (user and assistant turns, without the system brief). */
	readonly #history = new Map<string, StoredTurn[]>();
	/** The account each seat last used (a move drops that account's encrypted reasoning). */
	readonly #seatAccount = new Map<string, string>();

	constructor(opts: GatewayOptions = {}) {
		const urls = (opts.baseUrls ?? [process.env.ARC_GATEWAY_URL ?? GATEWAY_DEFAULT_URL])
			.map((u) => u.trim().replace(/\/+$/, ''))
			.filter(Boolean);
		if (!urls.length) throw new ProviderError('gw: give at least one gateway URL', null, false);
		this.#urls = urls;
		this.#pool = opts.pool ?? null;
		let token = opts.token?.trim() ?? '';
		if (!token && this.#pool) token = '-';
		if (!token) {
			const file =
				opts.tokenFile ?? process.env.ARC_GATEWAY_TOKEN_FILE ?? GATEWAY_DEFAULT_TOKEN_FILE;
			try {
				token = readFileSync(file.replace(/^~(?=\/)/, homedir()), 'utf8').trim();
			} catch {
				throw new ProviderError(
					`gw: cannot read the gateway token file; ${START_HINT}`,
					null,
					false
				);
			}
		}
		if (!token) throw new ProviderError('gw: the gateway token file is empty', null, false);
		this.#token = token;
		this.#effort = opts.effort ?? 'high';
		this.#api = opts.api ?? 'chat';
		this.#mode = opts.history ?? 'messages';
		this.#systemSuffix = opts.systemSuffix?.trim() ?? '';
		this.#reasoningSummary = opts.reasoningSummary;
		if (!GATEWAY_HISTORIES.includes(this.#mode))
			throw new ProviderError(`gw: unknown history mode "${this.#mode}"`, null, false);
		if (this.#mode === 'reasoning' && this.#api !== 'responses')
			throw new ProviderError(
				'gw: history mode "reasoning" needs the responses route',
				null,
				false
			);
		this.#maxOutputTokens = opts.maxOutputTokens ?? null;
		this.#timeoutMs = opts.timeoutMs ?? 300_000;
		this.#maxRetries = opts.maxRetries ?? 1;
		this.#timeoutRetries = opts.timeoutRetries ?? 0;
		this.#timeoutRetryPauseMs = opts.timeoutRetryPauseMs ?? 2_000;
		this.#overloadPauseMs = opts.overloadPauseMs ?? 60_000;
		this.#overloadRetries = opts.overloadRetries ?? 30;
		this.#fetch = opts.fetchImpl ?? fetch;
	}

	/** The reasoning effort and history mode this provider sends. */
	get settings(): { effort: string; api: 'chat' | 'responses'; history: GatewayHistory } {
		return { effort: this.#effort, api: this.#api, history: this.#mode };
	}

	/** Subscription: no per-token bill. */
	async estimateCostUsd(): Promise<number> {
		return 0;
	}

	/** The URL a game is pinned to. */
	urlFor(sessionKey: string | undefined): string {
		const gameId = (sessionKey ?? '').split(':')[0];
		return this.#urls[hashString(gameId) % this.#urls.length];
	}

	/** Drop every seat history of one game (call when the game ends). */
	forgetGame(gameId: string): void {
		for (const key of [...this.#history.keys()])
			if (key.startsWith(`${gameId}:`)) {
				this.#history.delete(key);
				this.#seatAccount.delete(key);
			}
		for (const key of [...this.#timeoutEpoch.keys()]) if (key.startsWith(`${gameId}:`)) this.#timeoutEpoch.delete(key);
	}

	/** Resume: one earlier exchange of a seat goes back into its stored conversation (no call). */
	remember(sessionKey: string, user: string, assistant: string): void {
		this.#history.set(sessionKey, [
			...(this.#history.get(sessionKey) ?? []),
			{ role: 'user', content: user },
			{ role: 'assistant', content: assistant }
		]);
	}

	/** The pooled account for a call (waits while every account of the provider is blocked). */
	async #target(
		key: string | undefined,
		provider: GatewayProviderId,
		signal?: AbortSignal
	): Promise<Target> {
		if (!this.#pool)
			return {
				url: this.urlFor(key),
				headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
				redact: (t) => this.#redact(t),
				account: null,
				proxy: false
			};
		const gameId = (key ?? '').split(':')[0];
		for (;;) {
			const account = this.#pool.accountFor(gameId, provider);
			if (account)
				return {
					url: account.url,
					headers: account.headers,
					redact: (t) => account.redact(t),
					account,
					proxy: account.proxy
				};
			await this.#pool.waitForOpen(signal, provider);
		}
	}

	/** Seats with a stored conversation (tests, memory checks). */
	get sessions(): number {
		return this.#history.size;
	}

	/** Fails clearly when no gateway answers at a URL (a model list, no model call). */
	async check(): Promise<void> {
		if (this.#pool) return this.#pool.check();
		for (const url of this.#urls) {
			let res: Response;
			try {
				res = await this.#fetch(`${url}/models`, {
					headers: { Authorization: `Bearer ${this.#token}` },
					signal: AbortSignal.timeout(10_000)
				});
			} catch {
				throw new ProviderError(`gw: no gateway at ${url}; ${START_HINT}`, null, false);
			}
			if (res.status === 401 || res.status === 403)
				throw new ProviderError(
					`gw: the gateway at ${url} refused the token (${res.status})`,
					res.status,
					false
				);
		}
	}

	async complete(request: ChatRequest): Promise<ChatResponse> {
		const model = request.model || GATEWAY_DEFAULT_MODEL;
		const provider = gatewayProviderOf(model);
		const key = request.meta?.sessionKey;
		// The rules brief, then the seat's strategy message when it has one (strategy.ts).
		const system = request.messages.filter((m) => m.role === 'system');
		const turns = request.messages.filter((m) => m.role !== 'system');
		// A stateless (fresh-question) request carries its whole conversation and is not stored.
		const keep = key && !request.meta?.stateless ? key : undefined;
		let stored = keep ? (this.#history.get(keep) ?? []) : [];
		// The seat's conversation already holds its earlier turns and answers: add only what is
		// new in this request (the decision, or a repair message after the stored bad answer).
		const fresh = keep && stored.length ? turns.slice(-1) : turns;
		let messages: StoredTurn[] = [...system, ...stored, ...fresh];
		let lastError: ProviderError | null = null;
		let trimmed = null as { dropped: number; kept: number } | null;
		let timeoutTries = 0;
		let overloadTries = 0;
		let reasoningDropped = false;
		for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
			const target = await this.#target(key, provider, request.signal);
			try {
				// A seat that moved to another account: drop the old account's encrypted reasoning
				// (the plain conversation goes on unchanged).
				if (key && target.account && this.#seatAccount.get(key) !== target.account.label) {
					if (this.#seatAccount.has(key)) {
						stored = stored.map(({ items: _items, ...turn }) => turn);
						messages = [...system, ...stored, ...fresh];
					}
					this.#seatAccount.set(key, target.account.label);
				}
				const call = () => this.#once(request, model, messages, key, target);
				const { items, ...res } = target.account
					? await target.account.gate.run(call, request.signal)
					: await call();
				if (keep)
					this.#history.set(keep, [
						...stored,
						...fresh,
						{ role: 'assistant', content: res.text, ...(items.length ? { items } : {}) }
					]);
				return {
					...res,
					httpAttempts: attempt + 1 + timeoutTries,
					// Safety path only: a full context dropped the oldest turns (recorded).
					...(trimmed && key
						? {
								session: {
									threadId: key,
									event: 'restarted' as const,
									reason: `context-full: dropped the oldest ${trimmed.dropped} turns, kept ${trimmed.kept}`
								}
							}
						: {})
				};
			} catch (err) {
				const error = err instanceof ProviderError ? err : this.#networkError(err, key, target);
				error.httpAttempts = attempt + 1 + timeoutTries;
				if (request.signal?.aborted) throw error;
				lastError = error;
				// No answer at all within the time limit: send the call again (`timeoutRetries`).
				if (error.message === 'gw timeout' && timeoutTries < this.#timeoutRetries) {
					timeoutTries += 1;
					if (key) this.#timeoutEpoch.set(key, (this.#timeoutEpoch.get(key) ?? 0) + 1);
					await new Promise((resolve) => setTimeout(resolve, this.#timeoutRetryPauseMs));
					attempt -= 1;
					continue;
				}
				// The model proxy: the provider is overloaded, or the last live account is in its
				// cooldown. Wait and send the same call again.
				if (target.proxy && (error.status === 502 || error.status === 503) && overloadTries < this.#overloadRetries) {
					overloadTries += 1;
					await new Promise((resolve) => setTimeout(resolve, this.#overloadPauseMs));
					if (request.signal?.aborted) throw error;
					attempt -= 1;
					continue;
				}
				// The model proxy moved the seat to another real account, which refuses the reasoning
				// items of the old one: send the plain conversation (once).
				if (target.proxy && !reasoningDropped && REASONING_REFUSED.test(error.message) && stored.some((t) => t.items)) {
					reasoningDropped = true;
					stored = stored.map(({ items: _items, ...turn }) => turn);
					messages = [...system, ...stored, ...fresh];
					attempt -= 1;
					continue;
				}
				// A real usage limit on a pooled account: block it until its reset and go on with
				// this game on another account (or wait until one opens).
				if (error.usageLimit && target.account && this.#pool) {
					await this.#pool.block(target.account, error.message);
					attempt -= 1;
					continue;
				}
				// Safety path: the conversation no longer fits the model's context. Drop the oldest
				// half of the stored turns (whole decision/answer pairs) and try again at once.
				if (keep && CONTEXT_FULL.test(error.message) && stored.length >= 4) {
					let cut = Math.floor(stored.length / 2);
					while (cut < stored.length && stored[cut].role !== 'user') cut += 1;
					stored = stored.slice(cut);
					trimmed = { dropped: (trimmed?.dropped ?? 0) + cut, kept: stored.length };
					messages = [...system, ...stored, ...fresh];
					attempt -= 1;
					continue;
				}
				// A rate limit goes up to the call gate (shared back-off), not a local retry.
				if (!error.retryable || error.status === 429 || attempt === this.#maxRetries) throw error;
				await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt));
			}
		}
		throw lastError ?? new ProviderError('gw: unknown failure', null, false);
	}

	/** The session key as sent: with `~t<n>` once the seat's calls have timed out n times (see `timeoutRetries`). */
	#wireKey(key: string): string {
		const n = this.#timeoutEpoch.get(key) ?? 0;
		return n ? `${key}~t${n}` : key;
	}

	#networkError(err: unknown, key: string | undefined, target?: Target): ProviderError {
		const e = err as Error & { cause?: { code?: string } };
		if (e?.name === 'TimeoutError' || e?.name === 'AbortError')
			return new ProviderError('gw timeout', null, false);
		if (e?.cause?.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(String(e?.message)))
			return new ProviderError(
				`gw: no gateway at ${target?.url ?? this.urlFor(key)}; ${START_HINT}`,
				null,
				false
			);
		return new ProviderError(
			`gw network error: ${(target?.redact ?? ((t: string) => this.#redact(t)))(String(e?.message ?? err))}`.slice(
				0,
				300
			),
			null,
			true
		);
	}

	async #once(
		request: ChatRequest,
		model: string,
		messages: StoredTurn[],
		key: string | undefined,
		target: Target
	) {
		const timeout = AbortSignal.timeout(this.#timeoutMs);
		const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
		const started = Date.now();
		const responses = this.#api === 'responses';
		const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
		if (this.#systemSuffix) system.push(this.#systemSuffix);
		const allTurns = messages.filter((m) => m.role !== 'system');
		const turns: StoredTurn[] =
			this.#mode === 'single' ? [{ role: 'user', content: singleTurnText(allTurns) }] : allTurns;
		const withReasoning = this.#mode === 'reasoning';
		// The proxy knows the bare model id, and one cache key for the whole game: a call sent again
		// after a time limit must stay on the seat's account and its cached prefix.
		const wireModel = target.proxy ? model.slice(model.indexOf('/') + 1) : model;
		const cacheKey = key ? (target.proxy ? key : this.#wireKey(key)) : undefined;
		const headers = target.proxy && key ? { ...target.headers, 'X-Session-ID': proxySessionId(key) } : target.headers;
		const payload = responses
			? {
					model: wireModel,
					instructions: system.join('\n\n'),
					input: turns.flatMap((m) => [
						...(withReasoning && m.items ? m.items : []),
						{ role: m.role, content: m.content }
					]),
					reasoning: {
						effort: this.#effort,
						...(this.#reasoningSummary ? { summary: this.#reasoningSummary } : {})
					},
					...(withReasoning ? { include: ['reasoning.encrypted_content'], store: false } : {}),
					...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
					...(this.#maxOutputTokens ? { max_output_tokens: this.#maxOutputTokens } : {})
				}
			: {
					model: wireModel,
					messages: [
						...system.map((content) => ({ role: 'system', content })),
						...turns.map((m) => ({ role: m.role, content: m.content }))
					],
					reasoning_effort: this.#effort,
					...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
					...(this.#maxOutputTokens ? { max_completion_tokens: this.#maxOutputTokens } : {})
				};
		const res = await this.#fetch(`${target.url}/${responses ? 'responses' : 'chat/completions'}`, {
			method: 'POST',
			signal,
			headers,
			body: JSON.stringify(payload)
		});
		const bodyText = await res.text();
		let body: Record<string, unknown> = {};
		try {
			body = JSON.parse(bodyText) as Record<string, unknown>;
		} catch {
			// Non-JSON body: an error below.
		}
		const apiError = body.error as { code?: number | string; message?: string } | undefined;
		const shaped = responses
			? Array.isArray(body.output) || typeof body.output_text === 'string'
			: Array.isArray(body.choices);
		if (!res.ok || apiError || !shaped) {
			const detail = target.redact(String(apiError?.message ?? bodyText)).slice(0, 200);
			target.account?.record(Date.now() - started, 0);
			// The per-minute turn limit ("at capacity", turn_rate_limit_exceeded) is a 429 for the
			// call gate; a used-up window is a usage limit (the pool blocks the account).
			// The proxy with no account that is on for this model: the same wait as a used-up window.
			const noAccount = target.proxy && PROXY_NO_ACCOUNT.test(`${String(apiError?.code ?? '')} ${detail}`);
			const usage = noAccount || (USAGE_LIMIT.test(detail) && !TURN_LIMIT.test(detail));
			const limited = usage || res.status === 429 || TURN_LIMIT.test(detail);
			const status = limited ? 429 : res.ok ? Number(apiError?.code) || 500 : res.status;
			const error = new ProviderError(
				`gw ${usage ? 'usage limit' : status}: ${detail}`,
				status,
				!usage && RETRYABLE.has(status)
			);
			error.usageLimit = usage;
			const retryAfter = Number(res.headers.get('retry-after'));
			if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000;
			else {
				const hint = /try again in ([\d.]+)\s*(ms|s|sec|seconds?)\b/i.exec(detail);
				if (hint) error.retryAfterMs = Number(hint[1]) * (hint[2] === 'ms' ? 1 : 1000);
			}
			throw error;
		}
		let text: string;
		let promptTokens: number;
		let completionTokens: number;
		let cachedPromptTokens: number;
		let reasoningTokens: number;
		let items: unknown[] = [];
		if (responses) {
			text =
				typeof body.output_text === 'string'
					? body.output_text
					: (body.output as { type?: string; content?: { type?: string; text?: string }[] }[])
							.filter((o) => o.type === 'message')
							.flatMap((o) => o.content ?? [])
							.filter((c) => c.type === 'output_text' || typeof c.text === 'string')
							.map((c) => c.text ?? '')
							.join('');
			const usage = (body.usage ?? {}) as {
				input_tokens?: number;
				output_tokens?: number;
				input_tokens_details?: { cached_tokens?: number };
				output_tokens_details?: { reasoning_tokens?: number };
			};
			// Reasoning items go back with the next calls (only in `reasoning` mode; small otherwise).
			if (withReasoning && Array.isArray(body.output))
				items = (
					body.output as {
						type?: string;
						id?: string;
						summary?: unknown;
						encrypted_content?: string;
					}[]
				)
					.filter((o) => o?.type === 'reasoning' && typeof o.encrypted_content === 'string')
					.map((o) => ({
						type: 'reasoning',
						...(o.id ? { id: o.id } : {}),
						summary: Array.isArray(o.summary) ? o.summary : [],
						encrypted_content: o.encrypted_content
					}));
			promptTokens = usage.input_tokens ?? 0;
			completionTokens = usage.output_tokens ?? 0;
			cachedPromptTokens = usage.input_tokens_details?.cached_tokens ?? 0;
			reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? 0;
		} else {
			const choice = (body.choices as { message?: { content?: unknown } }[])[0];
			const content = choice?.message?.content;
			text =
				typeof content === 'string'
					? content
					: Array.isArray(content)
						? content.map((c) => (c as { text?: string }).text ?? '').join('')
						: '';
			const usage = (body.usage ?? {}) as {
				prompt_tokens?: number;
				completion_tokens?: number;
				prompt_tokens_details?: { cached_tokens?: number };
				completion_tokens_details?: { reasoning_tokens?: number };
			};
			promptTokens = usage.prompt_tokens ?? 0;
			completionTokens = usage.completion_tokens ?? 0;
			cachedPromptTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
			reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;
		}
		target.account?.record(Date.now() - started, promptTokens);
		return {
			text,
			items,
			promptTokens,
			completionTokens,
			cachedPromptTokens,
			reasoningTokens,
			costUsd: 0,
			costEstimated: false,
			servedModel: `gw:${typeof body.model === 'string' ? body.model : model}`,
			providerRequestId: typeof body.id === 'string' ? body.id : undefined,
			timing: { startupMs: 0, turnMs: Date.now() - started }
		};
	}

	/**
	 * The pinned account's 7-day quota from the gateway's `/usage` (no model call):
	 * percent used, reset time, and whether a limit is reached.
	 */
	async usage(
		url = this.#urls[0]
	): Promise<{ usedPercent: number | null; resetsAt: number | null; limitReached: boolean }> {
		const res = await this.#fetch(`${url}/usage`, {
			headers: { Authorization: `Bearer ${this.#token}` },
			signal: AbortSignal.timeout(15_000)
		});
		const body = (await res.json().catch(() => ({}))) as {
			reports?: {
				provider?: string;
				limits?: {
					window?: { id?: string; resetsAt?: number };
					amount?: { used?: number; unit?: string };
				}[];
				metadata?: { limitReached?: boolean };
			}[];
		};
		const report = body.reports?.find((r) => r.provider === 'openai-codex');
		const week = report?.limits?.find((l) => l.window?.id === '7d');
		return {
			usedPercent: typeof week?.amount?.used === 'number' ? week.amount.used : null,
			resetsAt: week?.window?.resetsAt ?? null,
			limitReached: !!report?.metadata?.limitReached
		};
	}

	#redact(text: string): string {
		return text.replaceAll(this.#token, '[token]');
	}
}
