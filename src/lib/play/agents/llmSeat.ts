/**
 * SeatController backed by a chat provider: prompt → answer → parse; one repair turn on an
 * invalid answer; then a safe fallback. Every attempt (raw text, error, latency, tokens, cost)
 * is returned for the transcript.
 */

import { BudgetExceededError, type BudgetGuard } from './budget';
import type { CallGate } from './callGate';
import type {
	AnswerAttempt,
	ControllerAnswer,
	DecideContext,
	DecisionRequest,
	OfferedAction,
	SeatController,
	StatementAnswer,
	StatementRequest
} from './contract';
import {
	freshDecisionMessage,
	mockNotebookUpdate,
	notebookMessage,
	parseNotebook,
	type SeatMemory
} from './memory';
import {
	parseAnswer,
	renderDecisionMessage,
	repairMessage,
	systemMessages,
	type ParsedAnswer
} from './prompt';
import {
	ProviderError,
	type ChatMessage,
	type ChatProvider,
	type ChatRequest
} from './providers/types';
import { parseStatement, STATEMENT_PLACEHOLDER, strategyMessage, type Strategy } from './strategy';

export interface LlmSeatOptions {
	provider: ChatProvider;
	model: string;
	budget: BudgetGuard;
	/** Output token cap per call. Default 400 (action + a 1-3 sentence reason). */
	maxTokens?: number;
	temperature?: number;
	label?: string;
	/** Run-wide call gate (concurrency cap + back-off on rate/usage limits). */
	gate?: CallGate;
	/** The seat's goal for the whole game (a second system message; none for `free`). */
	strategy?: Strategy | null;
	/** End-of-game statement: `ask` the model, or a fixed `placeholder` without a call.
	 *  Default: placeholder for the mock provider, ask for every other provider. */
	statement?: 'ask' | 'placeholder';
	/** `history` (default): one conversation per seat. `fresh`: one request per decision with
	 *  the seat's plan note and notebook and no earlier turns (memory.ts). */
	memory?: SeatMemory;
	/** The notebook read at game start (a system message after the strategy; absent or empty:
	 *  none sent). */
	notebook?: string | null;
	/** Changed cards since the notebook was written (shown with it). */
	dataChanges?: string[];
}

const RAW_LIMIT = 2000;

interface SendResult {
	attempt: AnswerAttempt;
	reason: string;
	note?: string;
	fatal: boolean;
}
const DECLINE_IDS = /^(decline|no|keep:|skip|none)/i;

/**
 * The safe fallback: finish/yield when that is legal, else the option that declines or keeps
 * things as they are, else the first legal action (the engine's enumeration order).
 */
export function safeFallback(actions: OfferedAction[]): { action: OfferedAction; why: string } {
	const yieldAction = actions.find((a) => a.group === 'yield');
	if (yieldAction) return { action: yieldAction, why: 'yield' };
	const decline = actions.find((a) => {
		const cmd = a.command;
		if (cmd.type === 'resolveDecision' || cmd.type === 'resolveNavigationPower')
			return DECLINE_IDS.test(cmd.optionId);
		if (cmd.type === 'respondNavigationPowerTrade') return !cmd.accept;
		return false;
	});
	if (decline) return { action: decline, why: 'decline' };
	return { action: actions[0], why: 'first-legal' };
}

export class LlmSeatController implements SeatController {
	readonly label: string;
	readonly modelId: string;
	readonly strategy: Strategy | null;
	readonly memory: SeatMemory;
	readonly #opts: LlmSeatOptions;
	readonly #strategyMessage: string | null;
	readonly #notebookMessage: string | null;
	/** Fresh seats: each seat's plan note, by session key (`<gameId>:<seat>`). */
	readonly #notes = new Map<string, string>();

	constructor(opts: LlmSeatOptions) {
		this.#opts = opts;
		this.modelId = `${opts.provider.name}:${opts.model}`;
		this.label = opts.label ?? this.modelId;
		this.strategy = opts.strategy ?? null;
		this.memory = opts.memory ?? 'history';
		this.#strategyMessage = strategyMessage(this.strategy);
		this.#notebookMessage = notebookMessage(opts.notebook ?? '', opts.dataChanges);
	}

	/** The seat's current plan note in a game (fresh seats; null: none yet). */
	planNote(gameId: string, seat: string): string | null {
		return this.#notes.get(`${gameId}:${seat}`) ?? null;
	}

	/**
	 * Resume: the seat's memory after a recorded turn is what `decide` left behind. A history seat
	 * gets the decision message and each answer it gave (a repair question before a second answer)
	 * back in its conversation; a provider failure left nothing. The plan note is set again.
	 */
	restore(
		request: DecisionRequest,
		turn: { prompt: string | null; attempts: AnswerAttempt[]; note?: string }
	): void {
		const key = `${request.gameId}:${request.seat}`;
		if (turn.note) this.#notes.set(key, turn.note);
		if (this.memory === 'fresh') return;
		let user = turn.prompt ?? renderDecisionMessage(request);
		for (const attempt of turn.attempts) {
			if (attempt.providerError) continue;
			this.#opts.provider.remember?.(key, user, attempt.raw);
			user = repairMessage(attempt.error ?? 'invalid answer', request);
		}
	}

	async decide(request: DecisionRequest, ctx: DecideContext): Promise<ControllerAnswer> {
		const attempts: AnswerAttempt[] = [];
		const key = `${request.gameId}:${request.seat}`;
		const decision = renderDecisionMessage(request);
		const user =
			this.memory === 'fresh' ? freshDecisionMessage(decision, this.#notes.get(key) ?? null) : decision;
		const messages: ChatMessage[] = [
			...systemMessages(ctx.rulesBrief, this.#strategyMessage, this.#notebookMessage),
			{ role: 'user', content: user }
		];
		const sent = user === decision ? {} : { userMessage: user };
		for (let attempt = 1; attempt <= 2; attempt++) {
			let result: Awaited<ReturnType<LlmSeatController['callOnce']>>;
			try {
				result = await this.callOnce(messages, request, attempt, ctx);
			} catch (err) {
				// Keep what this decision already paid for, so the run totals stay true.
				if (err instanceof BudgetExceededError) err.partialAttempts = attempts;
				throw err;
			}
			attempts.push(result.attempt);
			if (result.attempt.parsedId) {
				if (result.note) this.#notes.set(key, result.note);
				return {
					response: {
						actionId: result.attempt.parsedId,
						reason: result.reason,
						...(result.note ? { note: result.note } : {})
					},
					attempts,
					repaired: attempt === 2,
					fallback: false,
					...sent
				};
			}
			if (result.fatal) break;
			// A provider failure is retried as is; only a real (but unusable) answer gets a repair turn.
			if (result.attempt.providerError) continue;
			messages.push({ role: 'assistant', content: result.attempt.raw || '(empty)' });
			messages.push({
				role: 'user',
				content: repairMessage(result.attempt.error ?? 'invalid answer', request)
			});
		}
		const { action, why } = safeFallback(request.actions);
		return {
			response: { actionId: action.id, reason: `fallback (${why})` },
			attempts,
			repaired: false,
			fallback: true,
			...sent,
			fallbackReason:
				attempts
					.map((a) => a.error)
					.filter(Boolean)
					.join(' | ') || 'no valid answer'
		};
	}

	/**
	 * After the game: one question in the seat's own conversation (same session key), with no
	 * repair turn. Mock seats answer with a fixed placeholder and make no call.
	 */
	async explain(request: StatementRequest, ctx: DecideContext): Promise<StatementAnswer> {
		const mode =
			this.#opts.statement ?? (this.#opts.provider.name === 'mock' ? 'placeholder' : 'ask');
		const notebookCall = request.notebook !== undefined;
		if (mode === 'placeholder')
			return {
				text: STATEMENT_PLACEHOLDER,
				attempts: [],
				placeholder: true,
				// A fixed fake update, so the notebook path runs offline too.
				...(notebookCall ? { notebook: mockNotebookUpdate(request.notebook!, request.gameId) } : {})
			};
		let notebook: string | null = null;
		const result = await this.#send(
			this.#chatRequest(
				[
					...systemMessages(ctx.rulesBrief, this.#strategyMessage),
					{ role: 'user', content: request.prompt }
				],
				{
					seat: request.seat,
					requestId: `${request.gameId}-statement-${request.seat}`,
					offeredIds: [],
					attempt: 1,
					sessionKey: `${request.gameId}:${request.seat}`,
					...(this.memory === 'fresh' ? { stateless: true } : {})
				},
				ctx
			),
			(text) => {
				const parsed = parseStatement(text);
				const book = notebookCall ? parseNotebook(text) : { notebook: null, error: null };
				notebook = book.notebook;
				const error = parsed.error ?? book.error;
				// A statement without a notebook still counts as a statement (the error is kept).
				return { id: parsed.error ? null : 'statement', reason: parsed.text, error };
			},
			ctx
		);
		return {
			text: result.reason,
			attempts: [result.attempt],
			...(result.attempt.error ? { error: result.attempt.error } : {}),
			...(notebook !== null ? { notebook } : {})
		};
	}

	/** One provider call (public only so `decide` can type its result). */
	async callOnce(
		messages: ChatMessage[],
		request: DecisionRequest,
		attempt: number,
		ctx: DecideContext
	): Promise<SendResult> {
		const chatRequest = this.#chatRequest(
			messages,
			{
				seat: request.seat,
				requestId: request.requestId,
				offeredIds: request.actions.map((a) => a.id),
				attempt,
				sessionKey: `${request.gameId}:${request.seat}`,
				...(this.memory === 'fresh' ? { stateless: true } : {})
			},
			ctx
		);
		return this.#send(chatRequest, (text) => parseAnswer(text, request.actions), ctx);
	}

	#chatRequest(
		messages: ChatMessage[],
		meta: NonNullable<ChatRequest['meta']>,
		ctx: DecideContext
	): ChatRequest {
		return {
			model: this.#opts.model,
			messages,
			maxTokens: this.#opts.maxTokens ?? 400,
			temperature: this.#opts.temperature,
			signal: ctx.signal,
			meta
		};
	}

	async #send(
		chatRequest: ChatRequest,
		parse: (text: string) => ParsedAnswer,
		ctx: DecideContext
	): Promise<SendResult> {
		// Budget errors propagate: the runner stops the game.
		const estimate = await this.#opts.provider.estimateCostUsd(chatRequest);
		this.#opts.budget.beforeCall(estimate);
		const started = performance.now();
		try {
			return await this.#call(chatRequest, parse, estimate, started, ctx);
		} finally {
			this.#opts.budget.release(estimate);
		}
	}

	async #call(
		chatRequest: ChatRequest,
		parse: (text: string) => ParsedAnswer,
		estimate: number,
		started: number,
		ctx: DecideContext
	): Promise<SendResult> {
		try {
			const { provider, gate } = this.#opts;
			const res = gate
				? await gate.run(() => provider.complete(chatRequest), ctx.signal)
				: await provider.complete(chatRequest);
			this.#opts.budget.record(res);
			const extraAttempts = (res.httpAttempts ?? 1) - 1;
			const billedFailures = (res.possiblyBilledFailures ?? 0) * estimate;
			if (extraAttempts > 0 || billedFailures > 0)
				this.#opts.budget.recordFailure(extraAttempts, billedFailures);
			const parsed = parse(res.text);
			return {
				attempt: {
					raw: res.text.slice(0, RAW_LIMIT),
					parsedId: parsed.id,
					error: parsed.error,
					latencyMs: Math.round(performance.now() - started),
					promptTokens: res.promptTokens,
					completionTokens: res.completionTokens,
					costUsd: res.costUsd + billedFailures,
					costEstimated: res.costEstimated || billedFailures > 0,
					httpAttempts: res.httpAttempts ?? 1,
					model: res.servedModel,
					...(res.session ? { session: res.session } : {}),
					...(res.timing ? { timing: res.timing } : {}),
					...(res.cachedPromptTokens !== undefined
						? { cachedPromptTokens: res.cachedPromptTokens }
						: {}),
					...(res.reasoningTokens !== undefined ? { reasoningTokens: res.reasoningTokens } : {})
				},
				reason: parsed.reason,
				...(parsed.note ? { note: parsed.note } : {}),
				fatal: false
			};
		} catch (err) {
			if (err instanceof BudgetExceededError) throw err;
			if (ctx.signal?.aborted) throw err;
			const message =
				err instanceof ProviderError ? err.message : `provider error: ${(err as Error).message}`;
			const httpAttempts = err instanceof ProviderError ? err.httpAttempts : 1;
			const possiblyBilled =
				(err instanceof ProviderError ? err.possiblyBilledAttempts : 0) * estimate;
			this.#opts.budget.recordFailure(httpAttempts, possiblyBilled);
			return {
				attempt: {
					raw: '',
					parsedId: null,
					error: message.slice(0, 300),
					latencyMs: Math.round(performance.now() - started),
					promptTokens: 0,
					completionTokens: 0,
					costUsd: possiblyBilled,
					costEstimated: possiblyBilled > 0,
					httpAttempts,
					providerError: true
				},
				reason: '',
				// A non-retryable provider failure (no credits, bad model id) will not heal on repair.
				fatal: err instanceof ProviderError && !err.retryable
			};
		}
	}
}
