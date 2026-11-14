/**
 * Several gateway accounts for `gw:` seats (one omp gateway per subscription account, each with
 * its own URL and token file). Each account serves one provider (`openai-codex` by default, or
 * `anthropic`). Each GAME is pinned to one account per provider (all its seats of that provider),
 * new games go to the least loaded account of the provider, and each account has its own call
 * gate (rate + back-off) and metrics.
 *
 * A real usage limit (the account's window is used up) marks the account blocked until its reset
 * time; its games then move to another account (a seat conversation is plain history, so it goes
 * on there; encrypted reasoning items of the old account are dropped). When every account is
 * blocked, calls wait until the first reset.
 *
 * Tokens: read once from each account's token file, kept only in memory, never logged; error
 * texts are redacted.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { CallGate, type CallGateOptions } from '../callGate';
import { DEFAULT_GATEWAY_PROVIDER, type GatewayProviderId } from './gateway';
import { ProviderError } from './types';

export interface GatewayAccountSpec {
	label: string;
	url: string;
	/** The subscription provider this account serves. Default `openai-codex`. */
	provider?: GatewayProviderId;
	tokenFile?: string;
	/** A token given directly (tests). */
	token?: string;
}

export interface UsageWindow {
	id: string;
	usedPercent: number | null;
	resetsAt: number | null;
}

export interface AccountUsage {
	at: number;
	usedPercent: number | null;
	resetsAt: number | null;
	limitReached: boolean;
	windows: UsageWindow[];
}

interface CallSample {
	t: number;
	ms: number;
	prompt: number;
}

export class GatewayAccount {
	readonly label: string;
	readonly url: string;
	readonly provider: GatewayProviderId;
	readonly gate: CallGate;
	/** Games pinned to this account now. */
	readonly games = new Set<string>();
	/** Games in flight wanted on this account (the scheduler's target). */
	target: number;
	blockedUntil: number | null = null;
	blockReason: string | null = null;
	usage: AccountUsage | null = null;
	/** First quota reading and the tokens sent since then (quota per token). */
	usageBase: { usedPercent: number; promptTokens: number } | null = null;
	promptTokens = 0;
	readonly #token: string;
	readonly #calls: CallSample[] = [];
	readonly #hits: number[] = [];

	constructor(spec: GatewayAccountSpec, gate: Omit<CallGateOptions, 'onLimit'>, target: number) {
		this.label = spec.label;
		this.url = spec.url.trim().replace(/\/+$/, '');
		this.provider = spec.provider ?? DEFAULT_GATEWAY_PROVIDER;
		let token = spec.token?.trim() ?? '';
		if (!token && spec.tokenFile) {
			try {
				token = readFileSync(spec.tokenFile.replace(/^~(?=\/)/, homedir()), 'utf8').trim();
			} catch {
				throw new ProviderError(
					`gw: cannot read the token file of account ${spec.label}`,
					null,
					false
				);
			}
		}
		if (!token) throw new ProviderError(`gw: no token for account ${spec.label}`, null, false);
		this.#token = token;
		this.target = target;
		this.gate = new CallGate({ ...gate, onLimit: () => this.#hits.push(Date.now()) });
	}

	get headers(): Record<string, string> {
		return { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' };
	}

	redact(text: string): string {
		return text.replaceAll(this.#token, '[token]');
	}

	blocked(now = Date.now()): boolean {
		if (this.blockedUntil !== null && now >= this.blockedUntil) {
			this.blockedUntil = null;
			this.blockReason = null;
		}
		return this.blockedUntil !== null;
	}

	/** Record one model call (HTTP time and input tokens) for the metrics. */
	record(ms: number, promptTokens: number): void {
		this.#calls.push({ t: Date.now(), ms, prompt: promptTokens });
		this.promptTokens += promptTokens;
		const old = Date.now() - 6 * 3600_000;
		while (this.#calls.length && this.#calls[0].t < old) this.#calls.shift();
		while (this.#hits.length && this.#hits[0] < old) this.#hits.shift();
	}

	/** Calls/min, input tokens/min, p50/p90 HTTP latency and limit hits in [from, to). */
	window(from: number, to = Date.now()) {
		const calls = this.#calls.filter((c) => c.t >= from && c.t <= to);
		const minutes = Math.max(1e-9, (to - from) / 60_000);
		const ms = calls.map((c) => c.ms).sort((a, b) => a - b);
		const q = (p: number) =>
			ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : 0;
		return {
			minutes: Math.round(minutes * 10) / 10,
			calls: calls.length,
			callsPerMin: Math.round(calls.length / minutes),
			tokensPerMin: Math.round(calls.reduce((a, c) => a + c.prompt, 0) / minutes),
			p50Ms: q(0.5),
			p90Ms: q(0.9),
			limitHits: this.#hits.filter((t) => t >= from && t <= to).length
		};
	}

	/** Quota percent per million input tokens, from the readings so far (null: not known yet). */
	percentPerMillionTokens(): number | null {
		if (!this.usageBase || this.usage?.usedPercent == null) return null;
		const tokens = this.promptTokens - this.usageBase.promptTokens;
		if (tokens < 5e6) return null;
		return ((this.usage.usedPercent - this.usageBase.usedPercent) / tokens) * 1e6;
	}
}

/**
 * The per-account gate of the long runs (tournament, league): adaptive concurrency and an
 * adaptive call-start rate; the per-minute turn limit is retried for a long time and never stops
 * the run (only a real usage limit blocks an account, see {@link GatewayPool.block}).
 */
export function adaptiveAccountGate(opts: {
	maxConcurrent: number;
	ratePerMin: number;
	maxRatePerMin: number;
}): Omit<CallGateOptions, 'onLimit'> {
	return {
		maxConcurrent: opts.maxConcurrent,
		adaptive: true,
		minConcurrent: 4,
		ratePerMin: opts.ratePerMin,
		maxRatePerMin: opts.maxRatePerMin,
		minRatePerMin: 30,
		rateStepPerMin: 10,
		baseBackoffMs: 2_000,
		maxBackoffMs: 20_000,
		maxRateRetries: 10_000,
		maxLimitFailures: Number.MAX_SAFE_INTEGER
	};
}

export interface GatewayPoolOptions {
	gate: Omit<CallGateOptions, 'onLimit'>;
	/** Games in flight per account at the start. */
	target?: number;
	/** A message for the run log (moves, blocks). */
	onEvent?: (text: string) => void;
	fetchImpl?: typeof fetch;
}

/** A game's pin for one provider. */
const pinKey = (gameId: string, provider: GatewayProviderId) => `${provider}\n${gameId}`;

export class GatewayPool {
	readonly accounts: GatewayAccount[];
	/** Each game's account per provider (key: {@link pinKey}). */
	readonly #byGame = new Map<string, GatewayAccount>();
	readonly #onEvent: (text: string) => void;
	readonly #fetch: typeof fetch;

	constructor(specs: GatewayAccountSpec[], opts: GatewayPoolOptions) {
		if (!specs.length)
			throw new ProviderError('gw: give at least one gateway account', null, false);
		const labels = new Set(specs.map((s) => s.label));
		if (labels.size !== specs.length)
			throw new ProviderError('gw: account labels must be distinct', null, false);
		this.accounts = specs.map((s) => new GatewayAccount(s, opts.gate, opts.target ?? 3));
		this.#onEvent = opts.onEvent ?? (() => {});
		this.#fetch = opts.fetchImpl ?? fetch;
	}

	/**
	 * Accounts from comma lists: URLs, token files (same order) and labels. Token files default to
	 * the gateway rule: `~/.local/share/arcspirits-agent-gateway[-<label>]/home/.omp/auth-gateway.token`.
	 */
	static specs(
		urls: string[],
		tokenFiles: string[] = [],
		labels: string[] = []
	): GatewayAccountSpec[] {
		return urls.map((url, i) => ({
			url,
			label: labels[i] || `account-${i + 1}`,
			tokenFile:
				tokenFiles[i] ||
				`${homedir()}/.local/share/arcspirits-agent-gateway${i === 0 ? '' : `-${labels[i] || i + 1}`}/home/.omp/auth-gateway.token`
		}));
	}

	byLabel(label: string): GatewayAccount | undefined {
		return this.accounts.find((a) => a.label === label);
	}

	/** Free slots of an account (target minus its games), for the scheduler. */
	free(account: GatewayAccount): number {
		return account.blocked() ? 0 : account.target - account.games.size;
	}

	/** Whether some account serves this provider. */
	serves(provider: GatewayProviderId): boolean {
		return this.accounts.some((a) => a.provider === provider);
	}

	/** The provider's open account with the most free slots (ties: fewer games, then list order). */
	leastLoaded(provider: GatewayProviderId = DEFAULT_GATEWAY_PROVIDER): GatewayAccount | null {
		const open = this.accounts.filter((a) => a.provider === provider && !a.blocked());
		if (!open.length) return null;
		return open.reduce((best, a) =>
			this.free(a) > this.free(best) ||
			(this.free(a) === this.free(best) && a.games.size < best.games.size)
				? a
				: best
		);
	}

	/** Pin a game's seats of a provider to an account (the given one, or the least loaded one). */
	assign(
		gameId: string,
		account?: GatewayAccount | null,
		provider: GatewayProviderId = account?.provider ?? DEFAULT_GATEWAY_PROVIDER
	): GatewayAccount | null {
		if (account === undefined) account = this.leastLoaded(provider);
		const key = pinKey(gameId, provider);
		const old = this.#byGame.get(key);
		if (old === account) return account;
		old?.games.delete(gameId);
		if (!account) {
			this.#byGame.delete(key);
			return null;
		}
		account.games.add(gameId);
		this.#byGame.set(key, account);
		return account;
	}

	/** The game's account of a provider; a blocked account's game moves to an open one (null: all
	 *  of the provider blocked). */
	accountFor(
		gameId: string,
		provider: GatewayProviderId = DEFAULT_GATEWAY_PROVIDER
	): GatewayAccount | null {
		const current = this.#byGame.get(pinKey(gameId, provider));
		if (current && !current.blocked()) return current;
		const next = this.assign(gameId, undefined, provider);
		if (current && next)
			this.#onEvent(`game ${gameId} moved from ${current.label} to ${next.label}`);
		return next;
	}

	/** The game's account labels (one per provider, list order, joined by +), null when none. */
	labelOf(gameId: string): string | null {
		const labels = this.#pins(gameId).map(([, a]) => a.label);
		return labels.length ? labels.join('+') : null;
	}

	release(gameId: string): void {
		for (const [key, account] of this.#pins(gameId)) {
			account.games.delete(gameId);
			this.#byGame.delete(key);
		}
	}

	/** The game's pins, in account list order. */
	#pins(gameId: string): [string, GatewayAccount][] {
		return [...this.#byGame]
			.filter(([key]) => key.endsWith(`\n${gameId}`))
			.sort(([, a], [, b]) => this.accounts.indexOf(a) - this.accounts.indexOf(b));
	}

	/** A real usage limit: block the account until its reset (from /usage, else in 30 min). */
	async block(account: GatewayAccount, reason: string): Promise<void> {
		if (account.blocked()) return;
		const usage = await this.readUsage(account).catch(() => null);
		const full = usage?.windows.filter((w) => (w.usedPercent ?? 0) >= 100 && w.resetsAt) ?? [];
		const resets = (full.length ? full : (usage?.windows ?? []))
			.map((w) => w.resetsAt ?? 0)
			.filter(Boolean);
		const until = resets.length ? Math.max(...resets) : Date.now() + 30 * 60_000;
		account.blockedUntil = Math.max(until, Date.now() + 60_000);
		account.blockReason = reason.slice(0, 160);
		this.#onEvent(
			`account ${account.label} blocked until ${new Date(account.blockedUntil).toISOString()}: ${account.blockReason}`
		);
	}

	/** Earliest reset of the blocked accounts (of one provider, or all; null: one is open). */
	nextReset(provider?: GatewayProviderId): number | null {
		const accounts = this.accounts.filter((a) => !provider || a.provider === provider);
		if (accounts.some((a) => !a.blocked())) return null;
		return Math.min(...accounts.map((a) => a.blockedUntil ?? Infinity));
	}

	/** Sleep until an account (of the provider) is open again (all blocked), then go on. */
	async waitForOpen(signal?: AbortSignal, provider?: GatewayProviderId): Promise<void> {
		for (;;) {
			const reset = this.nextReset(provider);
			if (reset === null) return;
			if (signal?.aborted) throw new ProviderError('call aborted', null, false);
			this.#onEvent(`all ${provider ?? ''} accounts blocked; waiting until ${new Date(reset).toISOString()}`);
			const wait = Math.max(5_000, Math.min(reset - Date.now() + 5_000, 15 * 60_000));
			// A stop ends the wait at once.
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, wait);
				signal?.addEventListener(
					'abort',
					() => {
						clearTimeout(timer);
						resolve();
					},
					{ once: true }
				);
			});
		}
	}

	/** Read an account's quota from its gateway's `/usage` (no model call). */
	async readUsage(account: GatewayAccount): Promise<AccountUsage> {
		const res = await this.#fetch(`${account.url}/usage`, {
			headers: account.headers,
			signal: AbortSignal.timeout(15_000)
		});
		const body = (await res.json().catch(() => ({}))) as {
			reports?: {
				provider?: string;
				limits?: {
					window?: { id?: string; resetsAt?: number };
					amount?: { used?: number };
				}[];
				metadata?: { limitReached?: boolean };
			}[];
		};
		const report = body.reports?.find((r) => r.provider === account.provider);
		const windows: UsageWindow[] = (report?.limits ?? []).map((l) => ({
			id: l.window?.id ?? '?',
			usedPercent: typeof l.amount?.used === 'number' ? l.amount.used : null,
			resetsAt: l.window?.resetsAt ?? null
		}));
		const week = windows.find((w) => w.id === '7d');
		const usage: AccountUsage = {
			at: Date.now(),
			usedPercent: week?.usedPercent ?? null,
			resetsAt: week?.resetsAt ?? null,
			limitReached: !!report?.metadata?.limitReached,
			windows
		};
		account.usage = usage;
		if (!account.usageBase && usage.usedPercent !== null)
			account.usageBase = { usedPercent: usage.usedPercent, promptTokens: account.promptTokens };
		return usage;
	}

	/** Read every account's quota; block the ones that report a reached limit. */
	async refreshUsage(): Promise<void> {
		await Promise.all(
			this.accounts.map(async (a) => {
				const u = await this.readUsage(a).catch(() => null);
				if (u?.limitReached && !a.blocked())
					await this.block(a, 'the gateway reports a reached usage limit');
			})
		);
	}

	/** Fails clearly when a gateway does not answer or refuses its token (no model call). */
	async check(): Promise<void> {
		for (const a of this.accounts) {
			let res: Response;
			try {
				res = await this.#fetch(`${a.url}/models`, {
					headers: a.headers,
					signal: AbortSignal.timeout(10_000)
				});
			} catch {
				throw new ProviderError(`gw: no gateway at ${a.url} (account ${a.label})`, null, false);
			}
			if (res.status === 401 || res.status === 403)
				throw new ProviderError(
					`gw: the gateway at ${a.url} refused the token of ${a.label} (${res.status})`,
					res.status,
					false
				);
		}
	}
}
