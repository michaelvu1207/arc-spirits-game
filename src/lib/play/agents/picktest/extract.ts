/**
 * Pick test, step 1: find every SUMMON decision in a recorded game.
 *
 * A recorded game (transcript.ts) is replayed with the catalog it was played with; just before
 * each summon decision the engine state is read: the seat's drawn hand (spirit ids and reward
 * hexes), its draw (bag, how many it may still summon) and what the player chose. The state itself
 * is not stored: `line` (the record's index in the file) lets `snapshotsAt` re-derive it by
 * replay, and `stateHash` checks that the re-derived state is the same.
 */

import { applyDeadlineAdvance, applyGameCommand } from '../../runtime';
import { botActorFor } from '../../server/botPolicy';
import { hashGameState } from '../../stateHash';
import type { GameCommand, PlayCatalog, PublicGameState, SeatColor } from '../../types';
import { createAgentLobby } from '../setup';
import { fitOf } from './desire';
import {
	commandFromActionId,
	type DecisionRecord,
	type HeaderRecord,
	type ResultRecord,
	type TranscriptRecord
} from '../transcript';

/** What the player did at a summon decision. */
export type PickKind = 'spirit' | 'none' | 'redraw' | 'reward' | 'other';

export interface HandEntry {
	guid: string;
	/** Spirit id (null: a reward hex). */
	spiritId: string | null;
	rewardId: string | null;
	name: string;
}

export interface SummonPoint {
	/** Unique id: `<source>/<file>#<line>`. */
	key: string;
	/** Records folder label (league, benchmark, tournament). */
	source: string;
	/** Absolute path of the game record. */
	file: string;
	gameId: string;
	/** Full sha256 of the catalog the game was played with. */
	catalogHash: string;
	/** Index of the decision record in the file (0 = header). */
	line: number;
	/** The record's decision number. */
	n: number;
	seat: SeatColor;
	round: number;
	/** The seat's model and league agent (when recorded). */
	model: string;
	agent: string | null;
	bag: string;
	summonLimit: number;
	summonedCount: number;
	hand: HandEntry[];
	/** Spirit ids the player could summon here (one per offered spawn action, in offer order). */
	offered: string[];
	/** Offered spirit ids that fit the board at this moment (desire.ts `fitOf`, original data). */
	fitting: string[];
	/** Offered action types (spawnHandSpirit, discardHandDraws, redrawHandDraws, ...). */
	optionTypes: string[];
	pick: PickKind;
	/** The summoned spirit id (pick = spirit). */
	pickedSpiritId: string | null;
	/** The original player's reason (short). */
	reason: string;
	repaired: boolean;
	fallback: boolean;
	/** hashGameState of the state just before the decision. */
	stateHash: string;
}

export interface GameInfo {
	source: string;
	file: string;
}

/** The command a decision record applied. */
export function recordCommand(record: DecisionRecord): GameCommand {
	return commandFromActionId(record.chosen.actionId);
}

/**
 * Walk a recorded game: `visit` is called for every decision record with the engine state just
 * BEFORE that decision (do not keep or change it: clone it). Throws when a recorded command is
 * rejected (the record does not belong to this catalog / engine).
 */
export function walkTranscript(
	records: TranscriptRecord[],
	catalog: PlayCatalog,
	visit: (record: DecisionRecord, line: number, state: PublicGameState) => void
): { state: PublicGameState; matches: boolean } {
	const header = records.find((r): r is HeaderRecord => r.type === 'header');
	if (!header) throw new Error('transcript has no header');
	let state = createAgentLobby(catalog, header.seed, header.seats);
	records.forEach((record, line) => {
		if (record.type === 'decision') {
			visit(record, line, state);
			const result = applyGameCommand(
				state,
				botActorFor(state, record.seat),
				recordCommand(record),
				catalog
			);
			if (!result.ok)
				throw new Error(
					`replay: decision ${record.n} rejected: ${result.error.code} ${result.error.message}`
				);
			state = result.state;
		} else if (record.type === 'advance') {
			applyDeadlineAdvance(state, catalog);
		}
	});
	const result = records.find((r): r is ResultRecord => r.type === 'result');
	return { state, matches: !!result && result.finalStateHash === hashGameState(state) };
}

/** A finished game: header + result record with `summary.finished`. */
export function isFinishedGame(records: TranscriptRecord[]): boolean {
	const result = records.find((r): r is ResultRecord => r.type === 'result');
	return !!result && (result.summary as { finished?: boolean } | null)?.finished === true;
}

function seatInfo(header: HeaderRecord, seat: SeatColor): { model: string; agent: string | null } {
	const i = header.seats.findIndex((s) => s.seat === seat);
	const setup = header.seats[i];
	const league = (header.options?.league as { agents?: { agent?: string }[] } | undefined)?.agents;
	return { model: setup?.model ?? '?', agent: league?.[i]?.agent ?? setup?.strategy?.id ?? null };
}

/** The spirit id / kind of a command at a summon decision. */
export function pickOf(
	command: GameCommand,
	hand: HandEntry[]
): { pick: PickKind; spiritId: string | null } {
	switch (command.type) {
		case 'spawnHandSpirit': {
			const entry = hand.find((h) => h.guid === command.guid);
			if (entry?.spiritId) return { pick: 'spirit', spiritId: entry.spiritId };
			return { pick: 'reward', spiritId: null };
		}
		case 'discardHandDraws':
			return { pick: 'none', spiritId: null };
		case 'redrawHandDraws':
			return { pick: 'redraw', spiritId: null };
		default:
			return { pick: 'other', spiritId: null };
	}
}

/** The seat's drawn hand in a state. */
export function handOf(state: PublicGameState, seat: SeatColor): HandEntry[] {
	return (state.players[seat]?.handDraws ?? []).map((d) => ({
		guid: d.guid,
		spiritId: d.rewardId ? null : (d.id ?? null),
		rewardId: d.rewardId ?? null,
		name: d.rewardLabel ?? d.name ?? '?'
	}));
}

/**
 * Every summon decision of a recorded game where the player could summon at least one spirit
 * and an agent actually answered (not forced, not phase-capped).
 */
export function extractSummonPoints(
	records: TranscriptRecord[],
	catalog: PlayCatalog,
	info: GameInfo
): { points: SummonPoint[]; matches: boolean } {
	const header = records.find((r): r is HeaderRecord => r.type === 'header');
	if (!header) throw new Error('transcript has no header');
	const points: SummonPoint[] = [];
	const { matches } = walkTranscript(records, catalog, (record, line, state) => {
		if (record.kind !== 'summon' || record.forced || record.phaseCapped) return;
		const hand = handOf(state, record.seat);
		const commands = record.actions.map((a) => commandFromActionId(a.actionId));
		const offered = commands
			.map((c) => (c.type === 'spawnHandSpirit' ? hand.find((h) => h.guid === c.guid) : undefined))
			.filter((h): h is HandEntry => !!h?.spiritId)
			.map((h) => h.spiritId!);
		if (!offered.length) return;
		const draw = state.players[record.seat]?.pendingDraw;
		const { pick, spiritId } = pickOf(recordCommand(record), hand);
		points.push({
			key: `${info.source}/${info.file.split('/').pop()}#${line}`,
			source: info.source,
			file: info.file,
			gameId: header.gameId,
			catalogHash: header.catalog.hash,
			line,
			n: record.n,
			seat: record.seat,
			round: record.round,
			...seatInfo(header, record.seat),
			bag: draw?.sourceBag ?? '?',
			summonLimit: draw?.summonLimit ?? 0,
			summonedCount: draw?.summonedCount ?? 0,
			hand,
			offered,
			fitting: offered.filter((id) => fitOf(state, record.seat, id, catalog).fits),
			optionTypes: [...new Set(commands.map((c) => c.type))],
			pick,
			pickedSpiritId: spiritId,
			reason: record.reason.slice(0, 300),
			repaired: record.repaired,
			fallback: record.fallback,
			stateHash: hashGameState(state)
		});
	});
	return { points, matches };
}

/**
 * Re-derive the states just before the given decision lines (deep copies, safe to keep), with
 * the recorded decision records.
 */
export function snapshotsAt(
	records: TranscriptRecord[],
	catalog: PlayCatalog,
	lines: Set<number>
): Map<number, { state: PublicGameState; record: DecisionRecord }> {
	const out = new Map<number, { state: PublicGameState; record: DecisionRecord }>();
	walkTranscript(records, catalog, (record, line, state) => {
		if (lines.has(line)) out.set(line, { state: structuredClone(state), record });
	});
	return out;
}
