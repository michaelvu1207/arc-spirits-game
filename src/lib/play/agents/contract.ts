/**
 * arc-agent-v1 — the seam between "one decision for one seat" and "who answers it".
 *
 * The harness (or, later, a live room) builds a {@link DecisionRequest} for a seat from the
 * authoritative state. A {@link SeatController} answers it with a {@link DecisionResponse}. The
 * controller never sees the full state, never mutates anything, and never sends commands: it
 * only names one of the offered action ids. The caller maps the id back to the exact
 * `GameCommand` and applies it through the normal reducer path.
 *
 * Every offered action also carries the canonical `arc-bot-v1` action id (canonical JSON of the
 * command, `bots/contract.ts`), so transcripts, replays and benchmarks refer to moves the same
 * way the bot contract does.
 */

import type { BotActionId } from '../bots/contract';
import type { GameCommand, GamePhase, SeatColor, SpectatorProjection } from '../types';
import type { Strategy } from './strategy';

export const AGENT_CONTRACT_VERSION = 'arc-agent-v1';
/** Bump when the prompt text or its structure changes (benchmarks compare like with like). */
export const PROMPT_VERSION = 'agent-prompt-v3';
export const HARNESS_VERSION = 'agent-harness-0.3.0';

/** What the decision is about, for prompts, summaries and metrics. */
export type DecisionKind =
	| 'power-draft'
	| 'power-offer'
	| 'power-trade-response'
	| 'navigation'
	| 'encounter'
	| 'location'
	| 'monster-reveal'
	| 'monster-reward'
	| 'summon'
	| 'corruption-payment'
	| 'decision-card'
	| 'benefits'
	| 'awakening'
	| 'cleanup';

export interface OfferedAction {
	/** Short id shown to the agent ("a1", "a2", …), in the engine's enumeration order. */
	id: string;
	/** Canonical arc-bot-v1 id of `command` (stable across runs for the same command). */
	actionId: BotActionId;
	/** Plain-language label for the agent. */
	label: string;
	/** Coarse group, e.g. "yield", "move", "fight". */
	group: string;
	command: GameCommand;
}

/** Everything one seat may know when it decides. Built only from that seat's view. */
export interface DecisionRequest {
	contract: typeof AGENT_CONTRACT_VERSION;
	promptVersion: typeof PROMPT_VERSION;
	requestId: string;
	gameId: string;
	seat: SeatColor;
	round: number;
	phase: GamePhase;
	kind: DecisionKind;
	/** One line that says what is being decided. */
	situation: string;
	/** The seat's own view of the table, rendered as text (no hidden information). */
	viewText: string;
	/** Event lines this seat could observe since its previous decision (oldest first). */
	events: string[];
	actions: OfferedAction[];
	/** Number of decisions this seat already made this phase (a loop guard input). */
	phaseDecisionIndex: number;
	/** Engine-computed fact lines (destination preview, monster facts); no advice. */
	facts?: string[];
	/** Round / VP / VP-per-round-needed line. */
	pace?: string;
}

export interface DecisionResponse {
	/** One of `request.actions[].id` (the canonical `actionId` is also accepted). */
	actionId: string;
	reason: string;
	/** The seat's running plan (fresh-question seats; it replaces the earlier note). */
	note?: string;
}

/** Per-call accounting a controller reports back (LLM controllers fill all of it). */
export interface AnswerAttempt {
	/** Raw text the answerer produced (truncated in records). */
	raw: string;
	/** Parsed action id, or null when the answer could not be parsed / was not offered. */
	parsedId: string | null;
	error: string | null;
	latencyMs: number;
	promptTokens: number;
	completionTokens: number;
	costUsd: number;
	/** Provider-reported model id (OpenRouter may route to a specific snapshot). */
	model?: string;
	/** True when the provider failed (no answer text): not counted as an invalid answer. */
	providerError?: boolean;
	/** True when `costUsd` is an estimate (the provider did not report cost, or a failed request may have been billed). */
	costEstimated?: boolean;
	/** HTTP requests behind this attempt (retries included). */
	httpAttempts?: number;
	/** Session bookkeeping of providers with sessions (codex): which thread answered, and
	 *  whether it was started, resumed, or restarted after a failure / full context. */
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

export interface ControllerAnswer {
	response: DecisionResponse;
	attempts: AnswerAttempt[];
	/** True when the second (repair) attempt produced the answer. */
	repaired: boolean;
	/** True when neither attempt was valid and the controller used its safe fallback. */
	fallback: boolean;
	fallbackReason?: string;
	/** The exact user message sent, when the controller added to the decision message (fresh
	 *  seats: the plan note); the transcript records it as the prompt. */
	userMessage?: string;
}

/**
 * Who answers decisions for one seat. The harness ships an LLM-backed controller
 * (`llmSeat.ts`) and scripted controllers for tests. A live-room adapter implements the same
 * interface (see scripts/agent-harness/README.md).
 */
export interface SeatController {
	readonly label: string;
	/** Model id / profile for records (e.g. "openrouter:openai/gpt-4o-mini", "mock:random"). */
	readonly modelId: string;
	decide(request: DecisionRequest, ctx: DecideContext): Promise<ControllerAnswer>;
	/**
	 * Resume: put one recorded turn back into the seat's memory (its conversation and plan note),
	 * with no provider call. `prompt` is the message the seat saw, `attempts` its recorded answers.
	 */
	restore?(
		request: DecisionRequest,
		turn: { prompt: string | null; attempts: AnswerAttempt[]; note?: string }
	): void | Promise<void>;
	/** The goal this seat keeps for the whole game (strategy.ts); absent = none. */
	readonly strategy?: Strategy | null;
	/** Spirits this seat's opening four must include (tests only; absent: as dealt). */
	readonly openingSpirits?: string[];
	/** After the game: why it played as it did (one call in the same conversation). */
	explain?(request: StatementRequest, ctx: DecideContext): Promise<StatementAnswer>;
}

export interface StatementRequest {
	gameId: string;
	seat: SeatColor;
	/** The question with the final result (strategy.ts `statementPrompt`). */
	prompt: string;
	/** A learning seat's notebook call (memory.ts): its notebook now; the answer must hold the new one. */
	notebook?: string;
}

export interface StatementAnswer {
	text: string;
	attempts: AnswerAttempt[];
	/** True when no call was made (mock seats). */
	placeholder?: boolean;
	error?: string;
	/** The seat's complete new notebook (notebook calls only; absent when the answer had none). */
	notebook?: string;
}

export interface DecideContext {
	/** The rules brief (identical for every decision in a run; first system message). */
	rulesBrief: string;
	/** Aborts in-flight provider calls when the run stops (budget, Ctrl-C). */
	signal?: AbortSignal;
	/** The seat's own projection (the same data `viewText` renders; no hidden information), for
	 *  scripted seats that read the table as data. */
	view?: SpectatorProjection;
}
