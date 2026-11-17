/** Chat-completion provider interface (OpenAI-compatible message shape). */

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	maxTokens: number;
	temperature?: number;
	signal?: AbortSignal;
	/** Provider-free metadata (never sent over the network). `sessionKey` names one seat in one
	 *  game: providers with sessions (codex) continue that seat's conversation instead of
	 *  starting a new one. */
	meta?: {
		seat: string;
		requestId: string;
		offeredIds: string[];
		attempt: number;
		sessionKey?: string;
		/** Fresh-question seats: `messages` is the whole request. A provider with sessions sends
		 *  it as is and keeps nothing (the session key still names the game and the cache key). */
		stateless?: boolean;
	};
}

export interface ChatResponse {
	text: string;
	promptTokens: number;
	completionTokens: number;
	/** USD (OpenRouter reports credits; 1 credit = 1 USD). 0 for offline providers. */
	costUsd: number;
	/** True when the provider did not report cost and it was estimated from list prices. */
	costEstimated: boolean;
	/** Model that actually served the call, when the provider reports it. */
	servedModel?: string;
	providerRequestId?: string;
	/** HTTP requests sent for this call, retries included (default 1). */
	httpAttempts?: number;
	/** Failed retries before the success that may still have been billed (timeout, broken connection). */
	possiblyBilledFailures?: number;
	/** Providers with sessions: the thread that answered and what happened to it. */
	session?: {
		threadId: string | null;
		event: 'started' | 'resumed' | 'restarted';
		reason?: string;
	};
	/** Process providers: ms from process start to the model turn starting, and of the turn. */
	timing?: { startupMs: number; turnMs: number };
	/** Of the prompt tokens, how many came from the provider's cache (when reported). */
	cachedPromptTokens?: number;
	/** Of the completion tokens, how many were reasoning (when reported). */
	reasoningTokens?: number;
}

export interface ChatProvider {
	readonly name: string;
	complete(request: ChatRequest): Promise<ChatResponse>;
	/** Resume: add one earlier exchange to a stored conversation, without a call (providers that keep one). */
	remember?(sessionKey: string, user: string, assistant: string): void;
	/** Upper-bound USD estimate of one call (prompt size × list price + the output cap), used by
	 *  the budget guard BEFORE the call. Unknown prices must estimate high, not low. */
	estimateCostUsd(request: ChatRequest): Promise<number>;
}

/** Rough token count for budget estimates (≈ 4 characters per token, rounded up). */
export function estimateTokens(messages: ChatMessage[]): number {
	return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
}

export class ProviderError extends Error {
	/** HTTP requests sent before giving up. */
	httpAttempts = 1;
	/** Of those, requests that may have been billed (no HTTP status: timeout, broken connection). */
	possiblyBilledAttempts = 0;
	/** A real usage limit (the account's window is used up), not a per-minute turn limit. */
	usageLimit = false;
	/** A wait the server asked for (Retry-After or a reset hint), when it gave one. */
	retryAfterMs: number | null = null;
	constructor(
		message: string,
		readonly status: number | null,
		readonly retryable: boolean
	) {
		super(message);
		this.name = 'ProviderError';
	}
}
