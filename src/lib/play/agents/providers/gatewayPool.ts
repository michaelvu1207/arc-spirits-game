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
 *
 * The model proxy (2026-11-27; `proxy: true` on an account): ONE server owns every subscription
 * login and selects the real account for each call. Such a pool entry is not one account but the
 * whole proxy for one provider. The seats call it directly (gateway.ts sends `X-Session-ID`, one id
 * for each seat of each game: the proxy keeps an id on one real account and spreads the ids across
 * the accounts). Its key comes from a command (`tokenCommand`, e.g. `ccc proxy key`), never from a
 * file of this project, and its usage comes from `ccc proxy status --json` (the proxy's own guard
 * turns a real account off at its cap; nothing here does). The entry is blocked only while every
 * real account of the provider is off.
 */

import { execFile, execFileSync } from 'node:child_process';
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
	/** The entry is the model proxy (see the file comment): direct calls with `X-Session-ID`. */
	proxy?: boolean;
	/** A command that prints the key: JSON with a `key` field, or the bare key. Used when no token or token file is given. */
	tokenCommand?: string[];
}

/** The command that reports the proxy's real accounts (no model call, no secrets in its output but e-mail addresses). */
export const PROXY_STATUS_COMMAND = ['ccc', 'proxy', 'status', '--json'];
/** The proxy's name for a subscription provider. */
const PROXY_PROVIDER: Record<GatewayProviderId, string> = { 'openai-codex': 'codex', anthropic: 'claude' };

/** The key from a command's output: JSON `{ key }` or the bare text. Never logged. */
function keyFromCommand(command: string[], label: string): string {
	let out: string;
	try {
		out = execFileSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
	} catch {
		throw new ProviderError(`gw: the key command of account ${label} failed`, null, false);
	}
	try {
		const key = (JSON.parse(out) as { key?: unknown }).key;
		if (typeof key === 'string') return key.trim();
	} catch {
		// Not JSON: the bare key.
	}
	return out.trim();
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
	/** The model proxy, not one account (see the file comment). */
	readonly proxy: boolean;
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
		this.proxy = spec.proxy === true;
		let token = spec.token?.trim() ?? '';
		if (!token && !spec.tokenFile && spec.tokenCommand?.length) token = keyFromCommand(spec.tokenCommand, spec.label);
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
	/** The proxy's status as JSON text (tests); default: run {@link PROXY_STATUS_COMMAND}. */
	proxyStatusImpl?: () => Promise<string>;
	/** The start check: how often and how far apart the proxy's model list is read again for a model it does not list (default 30 times, 30 s). */
	modelLooks?: number;
	modelLookMs?: number;
}

const runProxyStatus = (): Promise<string> =>
	new Promise((resolve, reject) =>
		execFile(PROXY_STATUS_COMMAND[0], PROXY_STATUS_COMMAND.slice(1), { timeout: 30_000, maxBuffer: 4e6 }, (err, stdout) =>
			err ? reject(new Error('the proxy status command failed')) : resolve(stdout)
		)
	);

/** A game's pin for one provider. */
const pinKey = (gameId: string, provider: GatewayProviderId) => `${provider}\n${gameId}`;

export class GatewayPool {
	readonly accounts: GatewayAccount[];
	/** Each game's account per provider (key: {@link pinKey}). */
	readonly #byGame = new Map<string, GatewayAccount>();
	readonly #onEvent: (text: string) => void;
	readonly #fetch: typeof fetch;
	readonly #proxyStatus: () => Promise<string>;
	readonly #modelLooks: number;
	readonly #modelLookMs: number;

	constructor(specs: GatewayAccountSpec[], opts: GatewayPoolOptions) {
		if (!specs.length)
			throw new ProviderError('gw: give at least one gateway account', null, false);
		const labels = new Set(specs.map((s) => s.label));
		if (labels.size !== specs.length)
			throw new ProviderError('gw: account labels must be distinct', null, false);
		this.accounts = specs.map((s) => new GatewayAccount(s, opts.gate, opts.target ?? 3));
		this.#onEvent = opts.onEvent ?? (() => {});
		this.#fetch = opts.fetchImpl ?? fetch;
		this.#proxyStatus = opts.proxyStatusImpl ?? runProxyStatus;
		this.#modelLooks = opts.modelLooks ?? 30;
		this.#modelLookMs = opts.modelLookMs ?? 30_000;
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
		if (account.proxy) {
			// The proxy already tried its other accounts. Every real account off: wait for the first
			// one to come back. Otherwise a short pause (an account in its cooldown), then go on.
			const usage = await this.readUsage(account).catch(() => null);
			const until = usage?.limitReached && usage.resetsAt ? usage.resetsAt : Date.now() + 60_000;
			account.blockedUntil = Math.max(until, Date.now() + 60_000);
			account.blockReason = reason.slice(0, 160);
			this.#onEvent(
				`${account.label}: ${usage?.limitReached ? 'every account of the proxy is off' : 'the proxy refused a call'}; waiting until ${new Date(account.blockedUntil).toISOString()}: ${account.blockReason}`
			);
			return;
		}
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
		if (account.proxy) return this.#readProxyUsage(account);
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

	/**
	 * The proxy's real accounts of this entry's provider, from its status command. One window per
	 * real account, named `a1`, `a2`, … in the order of the report (never by e-mail address), with
	 * ` off` when the proxy's guard or the owner turned it off. `usedPercent`: the least used account
	 * that is on. `limitReached`: none is on; `resetsAt` is then the first time one comes back.
	 */
	async #readProxyUsage(account: GatewayAccount): Promise<AccountUsage> {
		const report = JSON.parse(await this.#proxyStatus()) as {
			accounts?: Record<
				string,
				{ provider?: string; disabled?: boolean; until?: number | null; windows?: { kind?: string; pct?: number; resets_at?: number }[] }
			>;
		};
		const mine = Object.values(report.accounts ?? {}).filter((a) => a.provider === PROXY_PROVIDER[account.provider]);
		const ms = (seconds: number | null | undefined) => (typeof seconds === 'number' ? Math.round(seconds * 1000) : null);
		const rows = mine.map((a, i) => {
			const week = a.windows?.find((w) => w.kind === 'week');
			return {
				off: a.disabled === true,
				back: ms(a.until) ?? ms(week?.resets_at),
				window: {
					id: `a${i + 1}${a.disabled ? ' off' : ''}`,
					usedPercent: typeof week?.pct === 'number' ? week.pct : null,
					resetsAt: ms(week?.resets_at)
				}
			};
		});
		const on = rows.filter((r) => !r.off);
		const used = on.map((r) => r.window.usedPercent).filter((p): p is number => p !== null);
		const backs = rows.map((r) => r.back).filter((t): t is number => t !== null);
		const usage: AccountUsage = {
			at: Date.now(),
			usedPercent: used.length ? Math.min(...used) : null,
			resetsAt: on.length ? null : backs.length ? Math.min(...backs) : null,
			limitReached: rows.length > 0 && on.length === 0,
			windows: rows.map((r) => r.window)
		};
		account.usage = usage;
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

	/**
	 * Fails clearly when a gateway does not answer or refuses its token (no model call). `models`
	 * (ids as `<provider>/<model>`): the proxy must list each one, so a wrong id stops the run at
	 * its start and not at the first move.
	 */
	async check(models: string[] = []): Promise<void> {
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
			if (!a.proxy || !models.length) continue;
			// The proxy leaves a model out of its list while every account with it is in a short wait
			// (the provider said "overloaded"): look again for a while before calling the id wrong.
			const wanted = [...new Set(models)].filter((m) => m.slice(0, m.indexOf('/')) === a.provider).map((m) => m.slice(m.indexOf('/') + 1));
			let missing: string[] = [];
			for (let look = 0; ; look++) {
				const listed = new Set((((await res.json().catch(() => ({}))) as { data?: { id?: string }[] }).data ?? []).map((m) => m.id));
				missing = listed.size ? wanted.filter((m) => !listed.has(m)) : [];
				if (!missing.length || look >= this.#modelLooks) break;
				if (look === 0) this.#onEvent(`${a.label}: the proxy does not list ${missing.join(', ')} now; looking again for up to ${Math.round((this.#modelLooks * this.#modelLookMs) / 60_000)} min`);
				await new Promise((resolve) => setTimeout(resolve, this.#modelLookMs));
				res = await this.#fetch(`${a.url}/models`, { headers: a.headers, signal: AbortSignal.timeout(10_000) });
			}
			if (missing.length)
				throw new ProviderError(
					`gw: the proxy (${a.label}) has no model "${missing[0]}" now: a wrong id, or every account with it is off`,
					null,
					false
				);
		}
	}
}
