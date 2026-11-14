/**
 * Strategies (Step 2: one model, different strategies) and the end-of-game statement.
 *
 * A strategy is a short goal text a seat keeps for a whole game. It goes in a SECOND system
 * message after the rules brief, so the brief stays the same bytes for every seat (the cached
 * prefix) and the per-decision user message does not change. `free` (empty text) adds nothing:
 * that seat's prompt is byte-identical to a seat without a strategy.
 *
 * After a game, each seat is asked once, in its own conversation, why it played as it did
 * (`statement` transcript record). Mock seats give a fixed placeholder without a call; a failed
 * call is recorded and never fails the game.
 */

import { readFileSync } from 'node:fs';
import type { SeatColor } from '../types';
import type { AnswerAttempt, SeatController } from './contract';
import { firstJsonObject } from './prompt';
import type { StatementRecord } from './transcript';

export interface Strategy {
	id: string;
	/** Short display name (reports). */
	name: string;
	/** The goal the seat gets (1-2 sentences). Empty for `free`. */
	text: string;
}

export const FREE_STRATEGY_ID = 'free';
export const STATEMENT_PLACEHOLDER = '(mock seat: no statement)';

/** Read a strategy catalogue (`scripts/agent-harness/strategies.json`). */
export function loadStrategies(path: string): Strategy[] {
	const data = JSON.parse(readFileSync(path, 'utf8')) as { strategies?: unknown };
	if (!Array.isArray(data.strategies)) throw new Error(`${path}: no "strategies" list`);
	const out: Strategy[] = [];
	for (const row of data.strategies as Record<string, unknown>[]) {
		const { id, name, text } = row;
		if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id))
			throw new Error(`${path}: strategy id "${String(id)}" must be lower-case letters, digits, -`);
		if (typeof name !== 'string' || typeof text !== 'string')
			throw new Error(`${path}: strategy "${id}" needs a "name" and a "text"`);
		if (out.some((s) => s.id === id)) throw new Error(`${path}: strategy "${id}" is listed twice`);
		out.push({ id, name, text: text.trim() });
	}
	return out;
}

/** `fire,moon-evil,free` → strategies in that order (an unknown id is an error). */
export function pickStrategies(list: string, catalogue: Strategy[]): Strategy[] {
	const ids = list
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return ids.map((id) => {
		const found = catalogue.find((s) => s.id === id);
		if (!found)
			throw new Error(`unknown strategy "${id}" (known: ${catalogue.map((s) => s.id).join(', ')})`);
		return found;
	});
}

/** The second system message for a seat, or null when the strategy adds nothing (free). */
export function strategyMessage(strategy: Strategy | null | undefined): string | null {
	if (!strategy?.text) return null;
	return [
		'# YOUR STRATEGY FOR THIS GAME',
		strategy.text,
		'Keep this goal for the whole game. The rules above and the answer format stay the same.'
	].join('\n');
}

/** Final places: the winner first, then by VP (ties: seat order, as the engine breaks them). */
export function finalPlaces(
	seats: { seat: SeatColor; finalVp: number }[],
	winner: SeatColor | null
): Map<SeatColor, number> {
	const order = seats
		.map((s, i) => ({ ...s, i }))
		.sort(
			(a, b) =>
				Number(b.seat === winner) - Number(a.seat === winner) || b.finalVp - a.finalVp || a.i - b.i
		);
	return new Map(order.map((s, k) => [s.seat, k + 1]));
}

export interface GameOutcome {
	finished: boolean;
	winner: SeatColor | null;
	rounds: number;
	decisions: number;
	stopReason: string;
	seats: { seat: SeatColor; finalVp: number }[];
}

const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th'];

/** How the game ended for this seat (the first lines of every after-game question). */
export function resultLines(seat: SeatColor, outcome: GameOutcome): string[] {
	const places = finalPlaces(outcome.seats, outcome.winner);
	const end = outcome.finished
		? `The game is over after round ${outcome.rounds}: ${outcome.winner ?? 'nobody'} won.`
		: `The game was stopped in round ${outcome.rounds} after ${outcome.decisions} decisions (${outcome.stopReason}); it did not reach its end.`;
	const vp = outcome.seats
		.map((s) => `${s.seat} ${s.finalVp}${s.seat === seat ? ' (you)' : ''}`)
		.join(', ');
	return [
		end,
		`Final VP: ${vp}. You placed ${ORDINAL[(places.get(seat) ?? 1) - 1]} of ${outcome.seats.length}.`
	];
}

/** The one question after the game (asked in the seat's own conversation). */
export function statementPrompt(seat: SeatColor, outcome: GameOutcome): string {
	return [
		...resultLines(seat, outcome),
		'',
		'In 3-5 sentences, explain why you played as you did: the strategy you followed (or why you dropped it), your key choices, and what you would change next time.',
		'Reply with ONE JSON object only: {"action": "statement", "reason": "<your 3-5 sentences>"}'
	].join('\n');
}

/** The statement text: the JSON "reason" (or "statement"), else the plain answer. */
export function parseStatement(text: string): { text: string; error: string | null } {
	const json = firstJsonObject(text);
	const fromJson = json && (json.reason ?? json.statement);
	const value = (typeof fromJson === 'string' ? fromJson : text).trim().slice(0, 2000);
	return value ? { text: value, error: null } : { text: '', error: 'the answer was empty' };
}

/**
 * Ask every seat (or the given `seats`) for its statement (in parallel; each seat once). Never
 * throws: a failed or refused call (budget, usage limit, network) becomes a record with `error`.
 * `promptFor` gives a learning seat its notebook question instead (memory.ts); the answer's new
 * notebook goes into the record.
 */
export async function collectStatements(opts: {
	gameId: string;
	outcome: GameOutcome;
	controllers: Map<SeatColor, SeatController>;
	rulesBrief: string;
	signal?: AbortSignal;
	seats?: SeatColor[];
	promptFor?: (seat: SeatColor) => { prompt: string; notebook: string } | null;
}): Promise<StatementRecord[]> {
	const seats = opts.seats ?? opts.outcome.seats.map((s) => s.seat);
	return Promise.all(
		seats.map(async (seat): Promise<StatementRecord> => {
			const controller = opts.controllers.get(seat)!;
			const base = {
				type: 'statement' as const,
				seat,
				strategyId: controller.strategy?.id ?? null
			};
			if (!controller.explain)
				return {
					...base,
					prompt: null,
					text: STATEMENT_PLACEHOLDER,
					placeholder: true,
					attempts: []
				};
			const custom = opts.promptFor?.(seat) ?? null;
			const prompt = custom?.prompt ?? statementPrompt(seat, opts.outcome);
			try {
				const answer = await controller.explain(
					{ gameId: opts.gameId, seat, prompt, ...(custom ? { notebook: custom.notebook } : {}) },
					{ rulesBrief: opts.rulesBrief, signal: opts.signal }
				);
				return {
					...base,
					prompt: answer.placeholder ? null : prompt,
					text: answer.text,
					placeholder: !!answer.placeholder,
					...(answer.error ? { error: answer.error } : {}),
					...(answer.notebook !== undefined ? { notebook: answer.notebook } : {}),
					attempts: answer.attempts
				};
			} catch (err) {
				const attempts = (err as { partialAttempts?: AnswerAttempt[] }).partialAttempts ?? [];
				return {
					...base,
					prompt,
					text: '',
					placeholder: false,
					error: String((err as Error).message ?? err).slice(0, 300),
					attempts
				};
			}
		})
	);
}
