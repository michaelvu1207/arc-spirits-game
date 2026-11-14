/**
 * Seat memory and the notebook (the league).
 *
 * - `history`: one continuous conversation per seat; the provider keeps the earlier turns (the
 *   tournament's mode, and the default).
 * - `fresh`: each decision is ONE request: the rules brief (the same bytes for every seat, the
 *   cached prefix), the seat's strategy and its notebook (system messages), then one user message
 *   with the seat's own plan note and the normal decision message. No earlier turn is sent: the
 *   decision message already has the full view, the events since the seat's last decision, the
 *   engine facts and the legal actions. A repair turn stays inside the same request.
 *
 * The plan note is the seat's running plan inside one game: an optional `"note"` in its answer
 * (≤ NOTE_LIMIT characters) that replaces its earlier note and is shown in its next decisions.
 *
 * The notebook is the seat's lessons between games (≤ NOTEBOOK_MAX_LINES short lines). After a
 * game a learning seat gets ONE notebook call, an extended end-of-game statement (strategy.ts
 * `collectStatements` with `promptFor`): it says why it played as it did and returns its complete
 * new notebook.
 */

import type { SeatColor } from '../types';
import { firstJsonObject, NOTE_LIMIT } from './prompt';
import { resultLines, type GameOutcome } from './strategy';
import type { SeatTrace } from './strategyReport';

export type SeatMemory = 'history' | 'fresh';
export const SEAT_MEMORIES: SeatMemory[] = ['history', 'fresh'];
export const NOTEBOOK_MAX_LINES = 40;
export const NOTEBOOK_MAX_LINE_CHARS = 160;

const lines = (text: string) =>
	text
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((l) => l.trimEnd().slice(0, NOTEBOOK_MAX_LINE_CHARS))
		// No runs of blank lines.
		.filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''));

/** A notebook within the cap: at most NOTEBOOK_MAX_LINES lines (the first ones), each short. */
export function capNotebook(text: string): string {
	return lines(text.trim()).slice(0, NOTEBOOK_MAX_LINES).join('\n').trim();
}

const DATA_CHANGE_HEAD = 'GAME DATA CHANGED SINCE YOUR NOTES:';

function dataChangeBlock(changes: string[]): string[] {
	return changes.length
		? [
				DATA_CHANGE_HEAD,
				...changes.map((c) => `- ${c}`),
				'Lessons about these cards may no longer hold: check them again.'
			]
		: [];
}

/** The notebook system message of a decision (null: nothing to send). */
export function notebookMessage(notebook: string, dataChanges: string[] = []): string | null {
	if (!notebook.trim() && !dataChanges.length) return null;
	return [
		'# YOUR NOTEBOOK',
		'Lessons you wrote after your earlier games. They can be wrong: the rules above and the facts in each decision come first.',
		'',
		notebook.trim() || '(empty)',
		...(dataChanges.length ? ['', ...dataChangeBlock(dataChanges)] : [])
	].join('\n');
}

export const NOTE_LINE = `You may add "note": "<your plan for the next turns, at most ${NOTE_LIMIT} characters>" to the JSON. It replaces your plan note above; earlier turns of this game are not shown to you again.`;

/** The one user message of a fresh-question decision: the plan note, then the decision message. */
export function freshDecisionMessage(decisionMessage: string, note: string | null): string {
	return [
		'YOUR PLAN NOTE (your own words from an earlier decision in this game):',
		note || '(none yet)',
		'',
		decisionMessage,
		NOTE_LINE
	].join('\n');
}

const placeName = (name: string | null) =>
	name ? name.replace(' Region', '').replace('Arcane Abyss', 'Abyss') : 'none';

/** What a seat did, in short lines, from its game trace (strategyReport.ts). */
export function pathLines(trace: SeatTrace): string[] {
	const runs: string[] = [];
	trace.locations.forEach((loc, i) => {
		const last = runs.at(-1);
		const name = placeName(loc);
		const m = last && /^(\d+)(?:-(\d+))? (.*)$/.exec(last);
		if (m && m[3] === name) runs[runs.length - 1] = `${m[1]}-${i + 1} ${name}`;
		else runs.push(`${i + 1} ${name}`);
	});
	const status = (['Tainted', 'Corrupt', 'Fallen'] as const)
		.filter((k) => trace.statusRounds[k] !== undefined)
		.map((k) => `${k} in round ${trace.statusRounds[k]}`);
	return [
		`Destinations by round: ${runs.join(', ') || 'none'}`,
		`Monsters: ${
			trace.monsters
				.map(
					(m) =>
						`round ${m.round} ${m.name}${m.difficulty ? ` (D${m.difficulty})` : ''} ${m.killed ? 'defeated' : 'not defeated'}`
				)
				.join(', ') || 'none'
		}`,
		`Spirits collected: ${trace.collected.join('; ') || 'none'}`,
		`Spirits awakened: ${trace.awakened.join('; ') || 'none'}`,
		`Status: ${status.join(', ') || 'stayed Pure'}`
	];
}

export interface NotebookContext {
	strategyText: string;
	notebook: string;
	trace: SeatTrace;
	lastNote: string | null;
	dataChanges: string[];
}

/** The notebook call after a game (a learning seat's extended statement question). */
export function notebookPrompt(seat: SeatColor, outcome: GameOutcome, ctx: NotebookContext): string {
	return [
		...resultLines(seat, outcome),
		`Your VP by round: ${ctx.trace.vpByRound.join(', ') || '-'}.`,
		'',
		'WHAT YOU DID (read from the game engine):',
		...pathLines(ctx.trace).map((l) => `- ${l}`),
		'',
		`YOUR LAST PLAN NOTE: ${ctx.lastNote || '(none)'}`,
		`YOUR STRATEGY: ${ctx.strategyText || 'free choice (no instruction)'}`,
		...(ctx.dataChanges.length ? ['', ...dataChangeBlock(ctx.dataChanges)] : []),
		'',
		`YOUR NOTEBOOK NOW (lessons for your next games, at most ${NOTEBOOK_MAX_LINES} short lines):`,
		ctx.notebook.trim() || '(empty)',
		'',
		`Reply with ONE JSON object only: {"statement": "<3-5 sentences: why you played as you did: the strategy you followed or dropped, your key choices, and what you would change next time>", "notebook": "<your COMPLETE new notebook, at most ${NOTEBOOK_MAX_LINES} short lines, one lesson per line: keep what still holds, fix what this game showed to be wrong, drop what does not help; it replaces the old notebook>"}`
	].join('\n');
}

/** The new notebook in a notebook-call answer (capped), or an error. */
export function parseNotebook(text: string): { notebook: string | null; error: string | null } {
	const value = firstJsonObject(text)?.notebook;
	if (typeof value !== 'string') return { notebook: null, error: 'the answer has no "notebook"' };
	return { notebook: capNotebook(value), error: null };
}

/** A mock seat's notebook update (no model call): one line per game, the newest kept. */
export function mockNotebookUpdate(notebook: string, gameId: string): string {
	return capNotebook(
		[...lines(notebook.trim()).filter(Boolean), `- ${gameId}: mock seat, no lesson`]
			.slice(-NOTEBOOK_MAX_LINES)
			.join('\n')
	);
}
