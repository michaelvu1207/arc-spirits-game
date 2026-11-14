/**
 * Headless agent game runner: one full game, every decision answered by a SeatController.
 *
 * Loop (mirrors `sim/selfPlay.ts` and the room server's tick):
 *   - pick the next seat that must act (`botSeatNeedsToAct`); seats with a Navigation Power
 *     prompt go first, because such a prompt blocks every other command at the table;
 *     otherwise seats take turns one decision at a time (location turns are simultaneous in the
 *     live game, so no seat finishes its whole turn before the others start);
 *   - in the navigation phase (secret destination choice) the seats are asked in PARALLEL from
 *     the same state and the answers applied in seat order; an answer that another seat's move
 *     made out of date is recorded as `stale` and that seat is asked again;
 *   - build the seat's DecisionRequest (its projection only), ask its controller, apply the
 *     chosen command through `applyGameCommand`;
 *   - when no seat can act, apply the deadline advance exactly like the server (this is how the
 *     navigation reveal happens).
 *
 * Guards: a decision cap per game, a per-seat-per-phase cap (then the seat yields), a run-wide
 * budget (tokens / spend / calls), an abort signal. Forced moves (one legal action) are applied
 * without a provider call unless `askOnForced` is set.
 */

import { awakenedClassCounts } from '../effects/apply';
import { spiritsByOrigin } from '../effects/relicTools';
import { applyDeadlineAdvance, applyGameCommand } from '../runtime';
import { botActorFor, botSeatNeedsToAct } from '../server/botPolicy';
import { hashGameState } from '../stateHash';
import { STATUS_LADDER, type PlayCatalog, type PublicGameState, type SeatColor } from '../types';
import { BudgetExceededError, type BudgetGuard } from './budget';
import {
	AGENT_CONTRACT_VERSION,
	HARNESS_VERSION,
	PROMPT_VERSION,
	type AnswerAttempt,
	type ControllerAnswer,
	type SeatController
} from './contract';
import { buildDecision } from './decision';
import { EventLog, publicDiff, recordCommandEvents } from './events';
import { safeFallback } from './llmSeat';
import { renderDecisionMessage } from './prompt';
import { sha256 } from './rulesBrief';
import { createAgentLobby, pickGuardians, seatsFor } from './setup';
import { collectStatements } from './strategy';
import type { DecisionRecord, SeatSetup, TranscriptSink } from './transcript';
import { seatProjection, spectatorProjection } from './view';

export type StopReason =
	| 'finished'
	| 'budget'
	| 'decision-cap'
	| 'stalled'
	| 'reducer-rejection'
	| 'provider-errors'
	| 'aborted';

export interface SeatSummary {
	seat: SeatColor;
	guardian: string;
	controller: string;
	model: string;
	/** The seat's strategy (absent: none given). */
	strategy?: { id: string; name: string; text: string };
	/** The seat's end-of-game statement (strategy.ts). */
	statement?: string;
	finalVp: number;
	/** VP at the end of each completed round (engine `vpHistory`). */
	vpByRound: number[];
	finalStatus: string;
	/** First round in which the seat reached each status (absent = never). */
	statusRounds: Partial<Record<'Tainted' | 'Corrupt' | 'Fallen', number>>;
	corruptions: number;
	monsterKills: number;
	monsterFights: number;
	pvpAttacks: number;
	finalOrigins: Record<string, number>;
	finalClasses: Record<string, number>;
	finalDice: number;
	finalMaxBarrier: number;
	decisions: number;
	agentDecisions: number;
	forced: number;
	phaseCapped: number;
	/** Answers that were text but not a usable action id (provider failures are counted apart). */
	invalidAnswers: number;
	providerErrors: number;
	repairs: number;
	fallbacks: number;
	/** Parallel answers dropped because another seat's move changed this seat's options first. */
	staleAnswers: number;
	providerCalls: number;
	/** Session threads that were replaced after a failure or a full context. */
	sessionRestarts: number;
	/** Input tokens of the seat's last call and the largest one (a session's context size). */
	lastCallPromptTokens: number;
	maxCallPromptTokens: number;
	promptTokens: number;
	/** Of promptTokens, served from the provider's cache (when reported). */
	cachedPromptTokens: number;
	completionTokens: number;
	/** Of completionTokens, reasoning (when reported). */
	reasoningTokens: number;
	costUsd: number;
	latencyMsTotal: number;
	latencyMsMax: number;
	decisionsByKind: Record<string, number>;
}

export interface GameSummary {
	runId: string;
	gameId: string;
	seed: number;
	catalogHash: string;
	promptVersion: string;
	harnessVersion: string;
	contract: string;
	finished: boolean;
	stopReason: StopReason;
	stopDetail?: string;
	winner: SeatColor | null;
	rounds: number;
	decisions: number;
	advances: number;
	/** Batches of simultaneous (navigation) decisions asked in parallel. */
	parallelBatches: number;
	seats: SeatSummary[];
	/** Agent decisions whose first answer was invalid ÷ agent decisions. */
	invalidAnswerRate: number;
	fallbackRate: number;
	totalCostUsd: number;
	totalTokens: number;
	durationMs: number;
	finalStateHash: string;
	/** Run-wide budget state when this game ended (authoritative spend, failed calls included). */
	budget: ReturnType<BudgetGuard['snapshot']>;
}

export interface RunGameOptions {
	catalog: PlayCatalog;
	catalogInfo: { source: string; path: string; hash: string };
	seed: number;
	controllers: SeatController[];
	rulesBrief: string;
	budget: BudgetGuard;
	runId: string;
	gameIndex?: number;
	sink?: TranscriptSink;
	/** Max decisions (all seats) in one game. Default 3000. */
	maxDecisions?: number;
	/** Max decisions of one seat in one phase before it is made to yield. Default 30. */
	maxPhaseDecisions?: number;
	askOnForced?: boolean;
	/** Stop the game when one seat's last N agent decisions all fell back after provider
	 *  errors only (CLI missing, usage limit, network down). Default 3. */
	maxProviderFailures?: number;
	/** Ask seats in parallel where their decisions are truly simultaneous (navigation). Default true. */
	parallel?: boolean;
	/** After the game, ask each seat why it played as it did (statement records). Default off. */
	statements?: boolean;
	eventsPerPrompt?: number;
	git?: { commit: string | null; dirtyFiles: number | null };
	/** Extra fields for the header's `options` (e.g. the gateway account label of the game). */
	headerOptions?: Record<string, unknown>;
	signal?: AbortSignal;
	onDecision?: (record: DecisionRecord) => void;
}

function emptySeatSummary(setup: SeatSetup): SeatSummary {
	return {
		seat: setup.seat,
		guardian: setup.guardian,
		controller: setup.controller,
		model: setup.model,
		...(setup.strategy ? { strategy: setup.strategy } : {}),
		finalVp: 0,
		vpByRound: [],
		finalStatus: 'Pure',
		statusRounds: {},
		corruptions: 0,
		monsterKills: 0,
		monsterFights: 0,
		pvpAttacks: 0,
		finalOrigins: {},
		finalClasses: {},
		finalDice: 0,
		finalMaxBarrier: 0,
		decisions: 0,
		agentDecisions: 0,
		forced: 0,
		phaseCapped: 0,
		invalidAnswers: 0,
		providerErrors: 0,
		repairs: 0,
		fallbacks: 0,
		staleAnswers: 0,
		providerCalls: 0,
		sessionRestarts: 0,
		lastCallPromptTokens: 0,
		maxCallPromptTokens: 0,
		promptTokens: 0,
		cachedPromptTokens: 0,
		completionTokens: 0,
		reasoningTokens: 0,
		costUsd: 0,
		latencyMsTotal: 0,
		latencyMsMax: 0,
		decisionsByKind: {}
	};
}

/** Add a decision's provider attempts to a seat's totals; returns the decision's own totals. */
function addAttemptStats(sum: SeatSummary, attempts: AnswerAttempt[]) {
	const promptTokens = attempts.reduce((n, a) => n + a.promptTokens, 0);
	const completionTokens = attempts.reduce((n, a) => n + a.completionTokens, 0);
	const costUsd = attempts.reduce((n, a) => n + a.costUsd, 0);
	const latencyMs = attempts.reduce((n, a) => n + a.latencyMs, 0);
	sum.invalidAnswers += attempts.filter((a) => !a.parsedId && !a.providerError).length;
	sum.providerErrors += attempts.filter((a) => a.providerError).length;
	sum.providerCalls += attempts.reduce((n, a) => n + (a.httpAttempts ?? 1), 0);
	sum.sessionRestarts += attempts.filter((a) => a.session?.event === 'restarted').length;
	for (const a of attempts) {
		if (a.providerError) continue;
		sum.lastCallPromptTokens = a.promptTokens;
		sum.maxCallPromptTokens = Math.max(sum.maxCallPromptTokens, a.promptTokens);
	}
	sum.promptTokens += promptTokens;
	sum.cachedPromptTokens += attempts.reduce((n, a) => n + (a.cachedPromptTokens ?? 0), 0);
	sum.reasoningTokens += attempts.reduce((n, a) => n + (a.reasoningTokens ?? 0), 0);
	sum.completionTokens += completionTokens;
	sum.costUsd += costUsd;
	sum.latencyMsTotal += latencyMs;
	sum.latencyMsMax = Math.max(sum.latencyMsMax, latencyMs);
	return { promptTokens, completionTokens, costUsd, latencyMs };
}

/** Seats that must act now; a pending Navigation Power prompt blocks everyone else. */
function seatsToAct(state: PublicGameState): SeatColor[] {
	const needing = state.activeSeats.filter((seat) => botSeatNeedsToAct(state, seat));
	const prompted = needing.filter((seat) => {
		const p = state.players[seat];
		return (
			(p?.navigationPowerOffers?.length ?? 0) > 0 || p?.pendingNavigationTrade?.toSeat === seat
		);
	});
	return prompted.length ? prompted : needing;
}

/**
 * Seats whose decisions are truly simultaneous: secret destination choice in the navigation
 * phase (before the reveal), when no seat has a Power prompt or a trade waiting. Their options
 * depend on their own state only, so they may think at the same time. Empty otherwise.
 */
export function simultaneousSeats(state: PublicGameState, candidates: SeatColor[]): SeatColor[] {
	if (state.phase !== 'navigation' || state.revealedDestinations) return [];
	const blocked = state.activeSeats.some((seat) => {
		const p = state.players[seat];
		return (p?.navigationPowerOffers?.length ?? 0) > 0 || !!p?.pendingNavigationTrade;
	});
	return blocked ? [] : state.activeSeats.filter((seat) => candidates.includes(seat));
}

export async function runAgentGame(opts: RunGameOptions): Promise<GameSummary> {
	const started = performance.now();
	const { catalog, budget } = opts;
	const seats = seatsFor(opts.controllers.length);
	const guardians = pickGuardians(catalog, opts.seed, seats.length);
	const setups: SeatSetup[] = seats.map((seat, i) => ({
		seat,
		guardian: guardians[i],
		controller: opts.controllers[i].label,
		model: opts.controllers[i].modelId,
		...(opts.controllers[i].strategy ? { strategy: opts.controllers[i].strategy! } : {})
	}));
	const controllerBySeat = new Map(seats.map((seat, i) => [seat, opts.controllers[i]]));
	const gameIndex = opts.gameIndex ?? 0;
	const gameId = `${opts.runId}-g${gameIndex}-s${opts.seed}`;
	const maxDecisions = opts.maxDecisions ?? 3000;
	const maxPhaseDecisions = opts.maxPhaseDecisions ?? 30;
	const eventsPerPrompt = opts.eventsPerPrompt ?? 30;
	const sink = opts.sink;

	sink?.write({
		type: 'header',
		contract: AGENT_CONTRACT_VERSION,
		botContract: 'arc-bot-v1',
		harnessVersion: HARNESS_VERSION,
		promptVersion: PROMPT_VERSION,
		runId: opts.runId,
		gameId,
		gameIndex,
		seed: opts.seed,
		seats: setups,
		catalog: opts.catalogInfo,
		rulesBriefSha256: sha256(opts.rulesBrief),
		rulesBrief: opts.rulesBrief,
		git: opts.git ?? { commit: null, dirtyFiles: null },
		options: {
			maxDecisions,
			maxPhaseDecisions,
			askOnForced: !!opts.askOnForced,
			parallel: opts.parallel !== false,
			eventsPerPrompt,
			budget: budget.limits,
			...(opts.headerOptions ?? {})
		},
		startedAt: new Date().toISOString()
	});

	let state = createAgentLobby(catalog, opts.seed, setups);
	const events = new EventLog();
	events.add(
		`Game start: ${setups.map((s) => `${s.seat} (${s.guardian})`).join(', ')}. Round 1, navigation phase.`
	);
	const summaries = new Map(setups.map((s) => [s.seat, emptySeatSummary(s)]));
	const phaseCounts = new Map<string, number>();
	const seenCombats = new Set<string>();
	let decisions = 0;
	let advances = 0;
	let rr = 0;
	let stopReason: StopReason = 'finished';
	let stopDetail: string | undefined;
	let agentDecisionsTotal = 0;
	let firstInvalidTotal = 0;
	let fallbackTotal = 0;
	const stuck = new Set<string>();

	const track = (): void => {
		for (const seat of seats) {
			const p = state.players[seat];
			const sum = summaries.get(seat)!;
			if (!p) continue;
			for (let level = 1; level < STATUS_LADDER.length; level++) {
				const name = STATUS_LADDER[level] as 'Tainted' | 'Corrupt' | 'Fallen';
				if (p.statusLevel >= level && sum.statusRounds[name] === undefined)
					sum.statusRounds[name] = state.round;
			}
		}
		for (const combat of state.combats) {
			if (seenCombats.has(combat.id) || combat.step !== 'resolved') continue;
			seenCombats.add(combat.id);
			if (combat.kind === 'monster') {
				const sum = summaries.get(combat.sides[0]?.seat as SeatColor);
				if (sum) {
					sum.monsterFights += 1;
					if (combat.killed) sum.monsterKills += 1;
				}
			} else {
				for (const side of combat.sides)
					if (side.side === 'evil') summaries.get(side.seat)!.pvpAttacks += 1;
			}
		}
	};

	const advance = (reason: string): void => {
		const before = spectatorProjection(state);
		applyDeadlineAdvance(state, catalog);
		advances += 1;
		const after = spectatorProjection(state);
		sink?.write({
			type: 'advance',
			n: decisions,
			round: before.round,
			phase: before.phase,
			reason
		});
		events.add(
			reason === 'navigation-reveal'
				? 'Every player has locked a destination.'
				: `The ${before.phase} phase timer ended.`
		);
		for (const line of publicDiff(before, after)) events.add(line);
		track();
	};
	let idleAdvances = 0;
	let currentSeat: SeatColor | null = null;
	/** Commands applied so far (a stale-answer check compares this against the build time). */
	let applied = 0;
	let parallelBatches = 0;
	const maxProviderFailures = opts.maxProviderFailures ?? 3;
	const providerFailureRuns = new Map<SeatColor, number>();
	let providerStop: string | null = null;

	interface Prepared {
		seat: SeatColor;
		phaseKey: string;
		phaseIndex: number;
		built: ReturnType<typeof buildDecision>;
		forced: boolean;
		capped: boolean;
		prompt: string | null;
		appliedAtBuild: number;
		/** The seat's event cursor before this decision took its events. */
		eventCursor: number;
	}

	/** Build one seat's decision from the current state (null: the seat is stuck this phase). */
	const prepare = (seat: SeatColor): Prepared | null => {
		const phaseKey = `${seat}:${state.round}:${state.phase}`;
		const phaseIndex = phaseCounts.get(phaseKey) ?? 0;
		if (phaseIndex >= maxPhaseDecisions * 2) {
			stuck.add(phaseKey);
			return null;
		}
		const built = buildDecision({
			state,
			seat,
			catalog,
			gameId,
			requestId: `${gameId}-d${decisions + 1}-${seat}`,
			events: [],
			phaseDecisionIndex: phaseIndex
		});
		if (built.request.actions.length === 0) {
			stuck.add(phaseKey);
			return null;
		}
		const forced = built.request.actions.length === 1 && !opts.askOnForced;
		const capped = !forced && phaseIndex >= maxPhaseDecisions;
		let prompt: string | null = null;
		const eventCursor = events.cursor(seat);
		if (!forced && !capped) {
			built.request.events = events.takeFor(seat, eventsPerPrompt);
			prompt = renderDecisionMessage(built.request);
		}
		return {
			seat,
			phaseKey,
			phaseIndex,
			built,
			forced,
			capped,
			prompt,
			appliedAtBuild: applied,
			eventCursor
		};
	};

	/** The seat's answer: forced / capped moves need no agent. */
	const ask = async (p: Prepared): Promise<ControllerAnswer> => {
		const { request } = p.built;
		if (p.forced || p.capped) {
			const pick = p.forced
				? { action: request.actions[0], why: 'only legal action' }
				: safeFallback(request.actions);
			return {
				response: {
					actionId: pick.action.id,
					reason: p.forced
						? 'forced: only legal action'
						: `phase cap (${maxPhaseDecisions}) reached: ${pick.why}`
				},
				attempts: [],
				repaired: false,
				fallback: false
			};
		}
		currentSeat = p.seat;
		return controllerBySeat.get(p.seat)!.decide(request, {
			rulesBrief: opts.rulesBrief,
			signal: opts.signal
		});
	};

	/**
	 * Apply an answer. When another seat's command was applied after this decision was built
	 * (parallel batch), the answer stands only if the same action with the same label is still
	 * offered; else it is recorded as stale and the seat is asked again on the next loop.
	 */
	const commit = (p: Prepared, answer: ControllerAnswer): 'ok' | 'stale' | 'rejected' => {
		const { seat, phaseKey, phaseIndex, forced, capped, prompt, built } = p;
		const request = built.request;
		let viewBefore = built.view;
		const controller = controllerBySeat.get(seat)!;
		const sum = summaries.get(seat)!;
		const chosen =
			request.actions.find((a) => a.id === answer.response.actionId) ??
			request.actions.find((a) => a.actionId === answer.response.actionId);
		if (!chosen)
			throw new Error(
				`controller ${controller.label} returned an id that was not offered: ${answer.response.actionId}`
			);
		if (applied !== p.appliedAtBuild) {
			const fresh = buildDecision({
				state,
				seat,
				catalog,
				gameId,
				requestId: request.requestId,
				events: [],
				phaseDecisionIndex: phaseIndex
			});
			const still = fresh.request.actions.find(
				(a) => a.actionId === chosen.actionId && a.label === chosen.label
			);
			if (!still) {
				addAttemptStats(sum, answer.attempts);
				sum.staleAnswers += 1;
				// Not a decision: the seat gets these events again when it is asked again.
				events.rewind(seat, p.eventCursor);
				sink?.write({
					type: 'stale',
					n: decisions,
					seat,
					round: request.round,
					phase: request.phase,
					requestId: request.requestId,
					prompt: answer.userMessage ?? prompt,
					chosen: { id: chosen.id, actionId: chosen.actionId, label: chosen.label },
					reason: answer.response.reason,
					attempts: answer.attempts
				});
				return 'stale';
			}
			// Same canonical id = same command; keep the offered id the agent saw in the record.
			viewBefore = fresh.view;
		}

		const actor = botActorFor(state, seat);
		const specBefore = spectatorProjection(state);
		const result = applyGameCommand(state, actor, chosen.command, catalog);
		if (!result.ok) {
			stopReason = 'reducer-rejection';
			stopDetail = `${chosen.command.type}: ${result.error.code} ${result.error.message}`;
			return 'rejected';
		}
		state = result.state;
		applied += 1;
		decisions += 1;
		idleAdvances = 0;
		phaseCounts.set(phaseKey, phaseIndex + 1);
		recordCommandEvents(
			events,
			seat,
			chosen.command,
			chosen.label,
			viewBefore,
			seatProjection(state, seat),
			specBefore,
			spectatorProjection(state)
		);
		track();

		const attempts = answer.attempts;
		const { promptTokens, completionTokens, costUsd, latencyMs } = addAttemptStats(sum, attempts);
		sum.decisions += 1;
		sum.decisionsByKind[request.kind] = (sum.decisionsByKind[request.kind] ?? 0) + 1;
		if (forced) sum.forced += 1;
		else if (capped) sum.phaseCapped += 1;
		else {
			sum.agentDecisions += 1;
			agentDecisionsTotal += 1;
			if (attempts[0] && !attempts[0].parsedId && !attempts[0].providerError)
				firstInvalidTotal += 1;
			if (answer.fallback) fallbackTotal += 1;
		}
		if (answer.repaired) sum.repairs += 1;
		if (answer.fallback) sum.fallbacks += 1;
		if (!forced && !capped) {
			const providerFailure =
				answer.fallback && attempts.length > 0 && attempts.every((a) => a.providerError);
			const run = providerFailure ? (providerFailureRuns.get(seat) ?? 0) + 1 : 0;
			providerFailureRuns.set(seat, run);
			if (run >= maxProviderFailures && !providerStop) {
				providerStop = `${seat}: ${run} decisions in a row without an answer (${attempts.at(-1)?.error ?? 'provider error'})`;
			}
		}

		const record: DecisionRecord = {
			type: 'decision',
			n: decisions,
			seat,
			round: request.round,
			phase: request.phase,
			kind: request.kind,
			requestId: request.requestId,
			prompt: answer.userMessage ?? prompt,
			actions: request.actions.map(({ id, actionId, label }) => ({ id, actionId, label })),
			truncated: built.surface.truncated,
			chosen: { id: chosen.id, actionId: chosen.actionId, label: chosen.label },
			reason: answer.response.reason,
			forced,
			phaseCapped: capped,
			repaired: answer.repaired,
			fallback: answer.fallback,
			...(answer.fallbackReason ? { fallbackReason: answer.fallbackReason } : {}),
			...(answer.response.note ? { note: answer.response.note } : {}),
			attempts,
			latencyMs,
			promptTokens,
			completionTokens,
			costUsd,
			revision: state.revision
		};
		sink?.write(record);
		opts.onDecision?.(record);
		return 'ok';
	};

	try {
		let sinceYield = 0;
		game: while (state.status === 'active') {
			// Let timers and file writes run now and then: with an offline provider every await
			// is a microtask, and many games in one process would otherwise starve the I/O.
			if (++sinceYield >= 16) {
				sinceYield = 0;
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			if (opts.signal?.aborted) {
				stopReason = 'aborted';
				break;
			}
			if (providerStop) {
				stopReason = 'provider-errors';
				stopDetail = providerStop;
				break;
			}
			if (decisions >= maxDecisions) {
				stopReason = 'decision-cap';
				stopDetail = `${decisions} decisions`;
				break;
			}
			const candidates = seatsToAct(state).filter(
				(seat) => !stuck.has(`${seat}:${state.round}:${state.phase}`)
			);
			if (candidates.length === 0) {
				const phaseBefore = `${state.round}:${state.phase}`;
				applied += 1;
				advance(
					state.phase === 'navigation' && !state.revealedDestinations
						? 'navigation-reveal'
						: 'no-seat-can-act'
				);
				idleAdvances = `${state.round}:${state.phase}` === phaseBefore ? idleAdvances + 1 : 0;
				if (idleAdvances >= 3 && state.status === 'active') {
					stopReason = 'stalled';
					stopDetail = `phase ${state.phase} of round ${state.round} would not advance`;
					break;
				}
				continue;
			}

			// Truly simultaneous decisions (secret navigation): every seat thinks at once, from the
			// same state; answers are applied in seat order.
			const batch = opts.parallel === false ? [] : simultaneousSeats(state, candidates);
			if (batch.length > 1) {
				const prepared = batch
					.slice(0, maxDecisions - decisions)
					.map(prepare)
					.filter((p): p is Prepared => p !== null);
				if (prepared.length > 1) {
					parallelBatches += 1;
					const settled = await Promise.allSettled(prepared.map(ask));
					let failure: unknown = null;
					for (let i = 0; i < prepared.length; i++) {
						const outcome = settled[i];
						if (outcome.status === 'rejected') {
							if (outcome.reason instanceof BudgetExceededError) {
								addAttemptStats(summaries.get(prepared[i].seat)!, outcome.reason.partialAttempts);
								outcome.reason.partialAttempts = [];
							}
							failure ??= outcome.reason;
							continue;
						}
						if (commit(prepared[i], outcome.value) === 'rejected') break game;
					}
					currentSeat = null;
					if (failure) throw failure;
					continue;
				}
				for (const p of prepared) {
					if (commit(p, await ask(p)) === 'rejected') break game;
				}
				continue;
			}

			// Otherwise round-robin over the seats that must act, one decision at a time.
			const order = state.activeSeats;
			let seat = candidates[0];
			for (let k = 0; k < order.length; k++) {
				const s = order[(rr + k) % order.length];
				if (candidates.includes(s)) {
					seat = s;
					rr = (order.indexOf(s) + 1) % order.length;
					break;
				}
			}
			const p = prepare(seat);
			if (!p) continue;
			if (commit(p, await ask(p)) === 'rejected') break;
		}
	} catch (err) {
		if (err instanceof BudgetExceededError) {
			stopReason = 'budget';
			stopDetail = err.message;
			// Calls of the interrupted decision already cost money: count them for that seat.
			if (currentSeat) addAttemptStats(summaries.get(currentSeat)!, err.partialAttempts);
		} else if (opts.signal?.aborted) {
			stopReason = 'aborted';
		} else {
			throw err;
		}
	}

	if (state.status !== 'active' && stopReason === 'finished') stopReason = 'finished';
	for (const seat of seats) {
		const p = state.players[seat];
		const sum = summaries.get(seat)!;
		if (!p) continue;
		sum.finalVp = p.victoryPoints;
		sum.vpByRound = [...(p.vpHistory ?? [])];
		sum.finalStatus = STATUS_LADDER[p.statusLevel] ?? String(p.statusLevel);
		sum.corruptions = p.corruptionCount ?? 0;
		sum.finalOrigins = spiritsByOrigin(p.spirits);
		sum.finalClasses = awakenedClassCounts(p);
		sum.finalDice = p.attackDice.length;
		sum.finalMaxBarrier = p.maxBarrier;
	}
	const finalStop: StopReason =
		state.status === 'finished' ? 'finished' : stopReason === 'finished' ? 'stalled' : stopReason;
	// After the game: each seat says why it played as it did (a failure never fails the game).
	if (opts.statements && finalStop !== 'aborted') {
		const statements = await collectStatements({
			gameId,
			outcome: {
				finished: state.status === 'finished',
				winner: state.winnerSeat ?? null,
				rounds: state.round,
				decisions,
				stopReason: finalStop,
				seats: [...summaries.values()]
			},
			controllers: controllerBySeat,
			rulesBrief: opts.rulesBrief,
			signal: opts.signal
		});
		for (const record of statements) {
			sink?.write(record);
			const sum = summaries.get(record.seat)!;
			addAttemptStats(sum, record.attempts);
			sum.statement = record.text;
		}
	}
	const seatSummaries = [...summaries.values()];
	const summary: GameSummary = {
		runId: opts.runId,
		gameId,
		seed: opts.seed,
		catalogHash: opts.catalogInfo.hash,
		promptVersion: PROMPT_VERSION,
		harnessVersion: HARNESS_VERSION,
		contract: AGENT_CONTRACT_VERSION,
		finished: state.status === 'finished',
		stopReason: finalStop,
		...(stopDetail ? { stopDetail } : {}),
		winner: state.winnerSeat ?? null,
		rounds: state.round,
		decisions,
		advances,
		parallelBatches,
		seats: seatSummaries,
		invalidAnswerRate: agentDecisionsTotal ? firstInvalidTotal / agentDecisionsTotal : 0,
		fallbackRate: agentDecisionsTotal ? fallbackTotal / agentDecisionsTotal : 0,
		totalCostUsd: seatSummaries.reduce((n, s) => n + s.costUsd, 0),
		totalTokens: seatSummaries.reduce((n, s) => n + s.promptTokens + s.completionTokens, 0),
		durationMs: Math.round(performance.now() - started),
		finalStateHash: hashGameState(state),
		budget: budget.snapshot()
	};
	sink?.write({ type: 'result', summary, finalStateHash: summary.finalStateHash });
	return summary;
}
