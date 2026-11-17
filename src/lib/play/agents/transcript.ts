/**
 * Transcript records (JSON Lines, one record per line) and replay.
 *
 *   header    — run/game identity: seed, seats, guardians, controllers/models, catalog hash,
 *               rules-brief hash (+ the brief itself), prompt/contract/harness versions, git
 *   decision  — one per applied command: what the seat saw (the exact user message), the offered
 *               actions, the chosen one, the reason, every provider attempt (raw answer, error,
 *               latency, tokens, cost), repaired/fallback/forced flags
 *   advance   — the harness forced the phase machine forward (navigation reveal; nobody able
 *               to act), exactly like the server's deadline enforcement
 *   statement — after the game: the seat's own words on why it played as it did (strategy.ts);
 *               replay ignores it
 *   result    — the game summary (see runner.ts) and the final state hash
 *
 * Replay re-runs the engine from the header and the recorded commands, and checks the final
 * state hash. No provider is called.
 */

import {
	type WriteStream,
	appendFileSync,
	createWriteStream,
	mkdirSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import { BOT_CONTRACT_VERSION } from '../bots/contract';
import { applyDeadlineAdvance, applyGameCommand } from '../runtime';
import { botActorFor } from '../server/botPolicy';
import { hashGameState } from '../stateHash';
import type { GameCommand, PlayCatalog, PublicGameState, SeatColor } from '../types';
import type { AnswerAttempt, DecisionKind } from './contract';
import { createAgentLobby } from './setup';

export interface SeatSetup {
	seat: SeatColor;
	guardian: string;
	controller: string;
	model: string;
	/** The seat's strategy for this game (absent: none given). */
	strategy?: { id: string; name: string; text: string };
}

export interface HeaderRecord {
	type: 'header';
	contract: string;
	botContract: typeof BOT_CONTRACT_VERSION;
	harnessVersion: string;
	promptVersion: string;
	runId: string;
	gameId: string;
	gameIndex: number;
	seed: number;
	seats: SeatSetup[];
	catalog: { source: string; path: string; hash: string };
	rulesBriefSha256: string;
	rulesBrief: string;
	git: { commit: string | null; dirtyFiles: number | null };
	options: Record<string, unknown>;
	startedAt: string;
}

export interface DecisionRecord {
	type: 'decision';
	n: number;
	seat: SeatColor;
	round: number;
	phase: string;
	kind: DecisionKind;
	requestId: string;
	/** The exact user message the agent saw (null for forced / capped moves, which no agent saw). */
	prompt: string | null;
	actions: { id: string; actionId: string; label: string }[];
	truncated: boolean;
	chosen: { id: string; actionId: string; label: string };
	reason: string;
	forced: boolean;
	phaseCapped: boolean;
	repaired: boolean;
	fallback: boolean;
	fallbackReason?: string;
	/** The seat's new plan note (fresh-question seats), when the answer carried one. */
	note?: string;
	attempts: AnswerAttempt[];
	latencyMs: number;
	promptTokens: number;
	completionTokens: number;
	costUsd: number;
	revision: number;
	/** Hash of the whole game state after this decision (a resume checks it; absent in old records). */
	stateHash?: string;
}

export interface AdvanceRecord {
	type: 'advance';
	n: number;
	round: number;
	phase: string;
	reason: string;
}

export interface ResultRecord {
	type: 'result';
	summary: unknown;
	finalStateHash: string;
}

/** A parallel answer that was not applied: another seat's move changed this seat's options first. */
export interface StaleRecord {
	type: 'stale';
	/** Decisions applied before this record. */
	n: number;
	seat: SeatColor;
	round: number;
	phase: string;
	requestId: string;
	prompt: string | null;
	chosen: { id: string; actionId: string; label: string };
	reason: string;
	attempts: AnswerAttempt[];
}

/** After the game: why the seat played as it did (one call in its own conversation). */
export interface StatementRecord {
	type: 'statement';
	seat: SeatColor;
	strategyId: string | null;
	/** The question asked (null when no call was made). */
	prompt: string | null;
	text: string;
	/** True for a mock seat's fixed text (no call). */
	placeholder: boolean;
	/** Why there is no statement (failed or refused call); the game result stands. */
	error?: string;
	/** A learning seat's complete new notebook (memory.ts), when the answer held one. */
	notebook?: string;
	attempts: AnswerAttempt[];
}

export type TranscriptRecord =
	| HeaderRecord
	| DecisionRecord
	| StaleRecord
	| AdvanceRecord
	| StatementRecord
	| ResultRecord;

export interface TranscriptSink {
	write(record: TranscriptRecord): void;
}

export class MemorySink implements TranscriptSink {
	records: TranscriptRecord[] = [];
	write(record: TranscriptRecord): void {
		this.records.push(structuredClone(record));
	}
}

export class JsonlFileSink implements TranscriptSink {
	constructor(readonly path: string) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, '');
	}
	write(record: TranscriptRecord): void {
		appendFileSync(this.path, `${JSON.stringify(record)}\n`);
	}
}

/** A JSONL sink that streams records to disk (one open file, nothing kept in memory). */
export class JsonlStreamSink implements TranscriptSink {
	readonly #stream: WriteStream;
	constructor(readonly path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.#stream = createWriteStream(path, { flags: 'w' });
	}
	write(record: TranscriptRecord): void {
		this.#stream.write(`${JSON.stringify(record)}\n`);
	}
	/** Flush and close the file. */
	close(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.#stream.once('error', reject);
			this.#stream.end(resolve);
		});
	}
}

export function readTranscript(path: string): TranscriptRecord[] {
	return readFileSync(path, 'utf8')
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as TranscriptRecord);
}

export function commandFromActionId(actionId: string): GameCommand {
	const prefix = `${BOT_CONTRACT_VERSION}:`;
	if (!actionId.startsWith(prefix))
		throw new Error(`not an ${BOT_CONTRACT_VERSION} action id: ${actionId.slice(0, 60)}`);
	return JSON.parse(actionId.slice(prefix.length)) as GameCommand;
}

export interface ReplayResult {
	state: PublicGameState;
	finalStateHash: string;
	recordedHash: string | null;
	matches: boolean;
	commands: number;
}

/** Re-run a game from its transcript (engine only, no agents). */
export function replayTranscript(records: TranscriptRecord[], catalog: PlayCatalog): ReplayResult {
	const header = records.find((r): r is HeaderRecord => r.type === 'header');
	if (!header) throw new Error('transcript has no header');
	let state = createAgentLobby(catalog, header.seed, header.seats);
	let commands = 0;
	for (const record of records) {
		if (record.type === 'decision') {
			const command = commandFromActionId(record.chosen.actionId);
			const result = applyGameCommand(state, botActorFor(state, record.seat), command, catalog);
			if (!result.ok)
				throw new Error(
					`replay: decision ${record.n} rejected: ${result.error.code} ${result.error.message}`
				);
			state = result.state;
			commands += 1;
		} else if (record.type === 'advance') {
			applyDeadlineAdvance(state, catalog);
		}
	}
	const result = records.find((r): r is ResultRecord => r.type === 'result');
	const finalStateHash = hashGameState(state);
	return {
		state,
		finalStateHash,
		recordedHash: result?.finalStateHash ?? null,
		matches: result ? result.finalStateHash === finalStateHash : false,
		commands
	};
}
