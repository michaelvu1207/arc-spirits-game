/**
 * Run-wide budget guard shared by every seat of every game in a run. Checked BEFORE each
 * provider call; when a limit is reached the call is refused with {@link BudgetExceededError}
 * and the runner stops the game (recorded as `stopReason: 'budget'`).
 *
 * The spend check is conservative: a call is refused when the spend so far plus the larger of
 * (the provider's upper-bound estimate for this call, the most expensive call seen so far)
 * would pass the cap, so even the first call cannot jump over it. Calls in flight (seats that
 * think in parallel) hold a reservation until they end, so they cannot pass a cap together.
 */

export interface BudgetLimits {
	/** USD for the whole run. Default 0.25. */
	maxSpendUsd: number;
	/** Prompt + completion tokens for the whole run. Default 2,000,000. */
	maxTokens: number;
	/** Provider calls for the whole run (repairs included). Default 5000. */
	maxCalls: number;
}

export const DEFAULT_BUDGET: BudgetLimits = {
	maxSpendUsd: 0.25,
	maxTokens: 2_000_000,
	maxCalls: 5000
};

export class BudgetExceededError extends Error {
	/** Attempts of the interrupted decision that already ran (and may have cost money). */
	partialAttempts: import('./contract').AnswerAttempt[] = [];
	constructor(
		readonly limit: keyof BudgetLimits,
		message: string
	) {
		super(message);
		this.name = 'BudgetExceededError';
	}
}

export class BudgetGuard {
	readonly limits: BudgetLimits;
	spentUsd = 0;
	tokens = 0;
	calls = 0;
	#maxCallCost = 0;
	#maxCallTokens = 0;
	#inFlightCalls = 0;
	#inFlightUsd = 0;

	constructor(limits: Partial<BudgetLimits> = {}) {
		this.limits = { ...DEFAULT_BUDGET, ...limits };
		for (const [name, value] of Object.entries(this.limits)) {
			// NaN would make every comparison false and silently turn the cap off.
			if (Number.isNaN(value) || value < 0) throw new Error(`budget ${name} must be a number ≥ 0`);
		}
	}

	/**
	 * Throws when the next call could pass a limit; else reserves room for it until
	 * {@link release} (call it once per successful `beforeCall`, after record/recordFailure).
	 * `estimateUsd` is the provider's estimate.
	 */
	beforeCall(estimateUsd = 0): void {
		if (!Number.isFinite(estimateUsd) || estimateUsd < 0)
			throw new BudgetExceededError(
				'maxSpendUsd',
				`the call cost estimate is not usable (${estimateUsd})`
			);
		if (this.calls + this.#inFlightCalls >= this.limits.maxCalls)
			throw new BudgetExceededError(
				'maxCalls',
				`call budget reached (${this.calls}/${this.limits.maxCalls})`
			);
		if (this.tokens + this.#maxCallTokens * (this.#inFlightCalls + 1) > this.limits.maxTokens)
			throw new BudgetExceededError(
				'maxTokens',
				`token budget reached (${this.tokens}/${this.limits.maxTokens})`
			);
		const reserve = Math.max(estimateUsd, this.#maxCallCost);
		if (this.spentUsd + this.#inFlightUsd + reserve > this.limits.maxSpendUsd)
			throw new BudgetExceededError(
				'maxSpendUsd',
				`spend budget reached ($${this.spentUsd.toFixed(4)} of $${this.limits.maxSpendUsd})`
			);
		this.#inFlightCalls += 1;
		this.#inFlightUsd += reserve;
	}

	/** End the reservation of one call admitted by {@link beforeCall} with this estimate. */
	release(estimateUsd = 0): void {
		this.#inFlightCalls = Math.max(0, this.#inFlightCalls - 1);
		this.#inFlightUsd = Math.max(0, this.#inFlightUsd - Math.max(estimateUsd, 0));
		if (this.#inFlightCalls === 0) this.#inFlightUsd = 0;
	}

	record(usage: { promptTokens: number; completionTokens: number; costUsd: number }): void {
		const tokens = usage.promptTokens + usage.completionTokens;
		this.calls += 1;
		this.tokens += tokens;
		this.spentUsd += usage.costUsd;
		this.#maxCallCost = Math.max(this.#maxCallCost, usage.costUsd);
		this.#maxCallTokens = Math.max(this.#maxCallTokens, tokens);
	}

	/**
	 * HTTP attempts that returned no usable answer. They count as calls; attempts that may have
	 * been billed (a timeout or a broken connection after the request was sent) add `possiblyBilledUsd`.
	 */
	recordFailure(httpAttempts: number, possiblyBilledUsd: number): void {
		this.calls += Math.max(0, httpAttempts);
		this.spentUsd += Math.max(0, possiblyBilledUsd);
	}

	snapshot(): { spentUsd: number; tokens: number; calls: number; limits: BudgetLimits } {
		return { spentUsd: this.spentUsd, tokens: this.tokens, calls: this.calls, limits: this.limits };
	}
}
