/**
 * Gate for model calls (one per account): at most `maxConcurrent` calls in flight, call starts
 * smoothed by a token bucket, and a short shared back-off when the provider reports a limit.
 *
 * - Concurrency: at most the live cap of calls in flight. Adaptive mode (`adaptive: true`): a
 *   limit hit lowers the live cap (×0.75, once per back-off, never below `minConcurrent`); each
 *   full round of successes raises it by one again, up to the set cap.
 * - Rate (`ratePerMin`): a token bucket (burst `burst`, default 3 s of the rate), so parallel calls
 *   start spread out instead of in bursts. Adaptive rate (`maxRatePerMin` above `ratePerMin`): a
 *   limit hit lowers the rate (×0.8, at least `minRatePerMin`); each window without a hit raises
 *   it by `rateStepPerMin`, up to `maxRatePerMin`.
 * - Back-off on a limit hit: short (base, 2×base, … up to max, ±50% jitter), or the wait the
 *   server asked for (`ProviderError.retryAfterMs`). A success resets it. Then the same call is
 *   retried, up to `maxRateRetries` times; only then does the error reach the seat. After
 *   `maxLimitFailures` calls gave up on limits the gate STOPS (every later call fails at once).
 * - A real usage limit (`ProviderError.usageLimit`) is not a rate limit: it passes through at
 *   once, for the provider to move the game to another account.
 */

import { ProviderError } from './providers/types';

export interface CallGateOptions {
	maxConcurrent: number;
	/** First pause after a limit hit. Default 5 s. */
	baseBackoffMs?: number;
	/** Longest single pause. Default 120 s. */
	maxBackoffMs?: number;
	/** Retries of one call after limit hits. Default 6. */
	maxRateRetries?: number;
	/** Calls that gave up on limits before the gate stops the run. Default 3. */
	maxLimitFailures?: number;
	isRateLimit?: (err: unknown) => boolean;
	/** Lower the live cap on a limit hit and raise it again slowly. Default false. */
	adaptive?: boolean;
	/** Lowest live cap in adaptive mode. Default 2. */
	minConcurrent?: number;
	/** Call starts per window (token bucket). Default none. `maxPerMinute` is the old name. */
	ratePerMin?: number;
	maxPerMinute?: number;
	/** Adaptive rate: ceiling, floor and the raise per window without a hit. */
	maxRatePerMin?: number;
	minRatePerMin?: number;
	rateStepPerMin?: number;
	/** Bucket size (starts that may go at once). Default 3 s of the rate, at least 1. */
	burst?: number;
	/** Window of the rate. Default 60 000 ms (tests use less). */
	rateWindowMs?: number;
	/** Called on each limit hit (metrics). */
	onLimit?: (err: unknown) => void;
	/** Injected for tests. */
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
}

/** 429s, "rate limit", "too many requests", "at capacity"; not an error flagged `usageLimit`. */
export function isRateLimitError(err: unknown): boolean {
	if (err instanceof ProviderError && err.usageLimit) return false;
	if (err instanceof ProviderError && err.status === 429) return true;
	const message = err instanceof Error ? err.message : String(err ?? '');
	// Unflagged text (e.g. the Codex CLI's "usage limit"): treated as a limit to back off from.
	return /rate.?limit|usage limit|too many requests|\b429\b|quota|capacity/i.test(message);
}

export class CallGate {
	/** The set cap (the ceiling in adaptive mode). */
	#maxConcurrent: number;
	/** The live cap (= the set cap unless adaptive mode lowered it). */
	#cap: number;
	#successes = 0;
	#lastCut = 0;
	#rate: number;
	#tokens: number;
	#lastRefill = Date.now();
	#lastRateChange = Date.now();
	#lastHit = 0;
	readonly stats = {
		calls: 0,
		rateLimited: 0,
		pausedMs: 0,
		maxInFlight: 0,
		limitFailures: 0,
		capCuts: 0,
		lowestCap: 0,
		lastLimitError: null as string | null
	};
	/** Set when the gate stopped after repeated limit failures. */
	stoppedReason: string | null = null;
	readonly #opts: Required<
		Omit<
			CallGateOptions,
			'maxConcurrent' | 'ratePerMin' | 'maxPerMinute' | 'burst' | 'onLimit' | 'maxRatePerMin'
		>
	> & { maxRatePerMin: number; burst: number | null; onLimit?: (err: unknown) => void };
	#running = 0;
	#queue: (() => void)[] = [];
	#pausedUntil = 0;
	#backoffMs = 0;

	constructor(opts: CallGateOptions) {
		this.#maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent));
		this.#cap = this.#maxConcurrent;
		this.stats.lowestCap = this.#cap;
		this.#rate = Math.max(1, opts.ratePerMin ?? opts.maxPerMinute ?? Infinity);
		this.#opts = {
			baseBackoffMs: opts.baseBackoffMs ?? 5_000,
			maxBackoffMs: opts.maxBackoffMs ?? 120_000,
			maxRateRetries: opts.maxRateRetries ?? 6,
			maxLimitFailures: opts.maxLimitFailures ?? 3,
			isRateLimit: opts.isRateLimit ?? isRateLimitError,
			adaptive: opts.adaptive ?? false,
			minConcurrent: Math.max(1, Math.floor(opts.minConcurrent ?? 2)),
			maxRatePerMin: Math.max(this.#rate, opts.maxRatePerMin ?? this.#rate),
			minRatePerMin: Math.max(1, opts.minRatePerMin ?? Math.min(this.#rate, 30)),
			rateStepPerMin: opts.rateStepPerMin ?? 10,
			burst: opts.burst ?? null,
			rateWindowMs: opts.rateWindowMs ?? 60_000,
			onLimit: opts.onLimit,
			sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
			random: opts.random ?? Math.random
		};
		this.#tokens = this.#burst();
	}

	get maxConcurrent(): number {
		return this.#maxConcurrent;
	}

	/** The cap in force now (lower than {@link maxConcurrent} after adaptive cuts). */
	get liveCap(): number {
		return this.#cap;
	}

	/** The call-start rate in force now (per window; Infinity = none). */
	get ratePerMin(): number {
		return this.#rate;
	}

	/** Old name of {@link ratePerMin}. */
	get maxPerMinute(): number {
		return this.#rate;
	}

	setRatePerMin(n: number, max = Math.max(n, this.#opts.maxRatePerMin)): void {
		this.#rate = Math.max(1, n);
		this.#opts.maxRatePerMin = Math.max(this.#rate, max);
	}

	setMaxPerMinute(n: number): void {
		this.setRatePerMin(n, n);
	}

	get inFlight(): number {
		return this.#running;
	}

	get waiting(): number {
		return this.#queue.length;
	}

	/** Change the set cap during a run (a ramp-up); a raise lets queued calls start at once. */
	setMaxConcurrent(n: number): void {
		const raise = Math.max(1, Math.floor(n)) - this.#maxConcurrent;
		this.#maxConcurrent = Math.max(1, Math.floor(n));
		// Adaptive: the live cap moves by the same step (it keeps its distance below the ceiling).
		this.#cap = this.#opts.adaptive
			? Math.max(1, Math.min(this.#maxConcurrent, this.#cap + raise))
			: this.#maxConcurrent;
		this.#drain();
	}

	#burst(): number {
		if (!Number.isFinite(this.#rate)) return Infinity;
		return Math.max(1, this.#opts.burst ?? Math.round(this.#rate / 20));
	}

	/** Wait for a token of the bucket (real time: the bucket is measured with Date.now()). */
	async #takeToken(): Promise<void> {
		if (!Number.isFinite(this.#rate)) return;
		for (;;) {
			const now = Date.now();
			const perMs = this.#rate / this.#opts.rateWindowMs;
			this.#tokens = Math.min(this.#burst(), this.#tokens + (now - this.#lastRefill) * perMs);
			this.#lastRefill = now;
			// Adaptive rate: one raise per window without a limit hit.
			if (
				this.#rate < this.#opts.maxRatePerMin &&
				now - this.#lastHit >= this.#opts.rateWindowMs &&
				now - this.#lastRateChange >= this.#opts.rateWindowMs
			) {
				this.#rate = Math.min(this.#opts.maxRatePerMin, this.#rate + this.#opts.rateStepPerMin);
				this.#lastRateChange = now;
			}
			if (this.#tokens >= 1) {
				this.#tokens -= 1;
				return;
			}
			const wait = Math.max(2, Math.ceil((1 - this.#tokens) / perMs));
			this.stats.pausedMs += wait;
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
	}

	#drain(): void {
		while (this.#queue.length && this.#running < this.#cap) {
			this.#running += 1;
			this.#queue.shift()!();
		}
		this.stats.maxInFlight = Math.max(this.stats.maxInFlight, this.#running);
	}

	async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			if (this.stoppedReason) throw new ProviderError(this.stoppedReason, null, false);
			await this.#acquire();
			try {
				// Every call waits out a back-off that started while it was queued.
				const pause = this.#pausedUntil - Date.now();
				if (pause > 0) {
					this.stats.pausedMs += pause;
					await this.#opts.sleep(pause);
				}
				await this.#takeToken();
				if (signal?.aborted) throw new ProviderError('call aborted', null, false);
				this.stats.calls += 1;
				const result = await fn();
				this.#backoffMs = 0;
				if (
					this.#opts.adaptive &&
					this.#cap < this.#maxConcurrent &&
					++this.#successes >= this.#cap
				) {
					this.#successes = 0;
					this.#cap += 1;
					this.#drain();
				}
				return result;
			} catch (err) {
				const limit = this.#opts.isRateLimit(err);
				if (limit) {
					this.stats.lastLimitError = String((err as Error)?.message ?? err).slice(0, 200);
					this.#opts.onLimit?.(err);
				}
				if (limit && Date.now() >= this.#lastCut) {
					// One cut per back-off: calls that fail together count once.
					this.#lastHit = Date.now();
					if (this.#opts.adaptive) {
						this.#cap = Math.max(this.#opts.minConcurrent, Math.floor(this.#cap * 0.75));
						this.#successes = 0;
						this.stats.capCuts += 1;
						this.stats.lowestCap = Math.min(this.stats.lowestCap, this.#cap);
					}
					if (Number.isFinite(this.#rate) && this.#opts.maxRatePerMin > this.#opts.minRatePerMin) {
						this.#rate = Math.max(this.#opts.minRatePerMin, Math.floor(this.#rate * 0.8));
						this.#lastRateChange = Date.now();
					}
					this.#lastCut = Date.now() + this.#opts.baseBackoffMs;
				}
				if (limit && attempt >= this.#opts.maxRateRetries) {
					this.stats.limitFailures += 1;
					if (this.stats.limitFailures >= this.#opts.maxLimitFailures && !this.stoppedReason)
						this.stoppedReason = `call gate stopped the run: ${this.stats.limitFailures} calls gave up on rate limits (last: ${String((err as Error)?.message ?? err).slice(0, 120)})`;
				}
				if (!limit || attempt >= this.#opts.maxRateRetries || signal?.aborted) throw err;
				this.stats.rateLimited += 1;
				this.#backoffMs = Math.min(
					this.#opts.maxBackoffMs,
					this.#backoffMs ? this.#backoffMs * 2 : this.#opts.baseBackoffMs
				);
				const hint = err instanceof ProviderError ? err.retryAfterMs : null;
				const wait = hint ?? this.#backoffMs * (0.5 + this.#opts.random());
				this.#pausedUntil = Math.max(this.#pausedUntil, Date.now() + wait);
			} finally {
				this.#release();
			}
		}
	}

	async #acquire(): Promise<void> {
		if (this.#running < this.#cap) {
			this.#running += 1;
		} else {
			// The slot is handed over by #release (the count stays the same).
			await new Promise<void>((resolve) => this.#queue.push(resolve));
		}
		this.stats.maxInFlight = Math.max(this.stats.maxInFlight, this.#running);
	}

	#release(): void {
		// After a lowered cap, a freed slot closes instead of passing to the queue.
		const next = this.#running <= this.#cap ? this.#queue.shift() : undefined;
		if (next) next();
		else this.#running -= 1;
	}
}
