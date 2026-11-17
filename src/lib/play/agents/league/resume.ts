/**
 * Resume: which part of a cut-off game's transcript a new run of that game can continue from.
 *
 * A transcript is written decision by decision, so a game that was paused, stopped, killed or
 * ended by provider errors still has every decision it made. The runner plays those again
 * without a provider call (`RunGameOptions.resume`) and goes on from there.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HeaderRecord, ResultRecord, TranscriptRecord } from '../transcript';

/** Stops that leave a game that can go on. The others (a rejected move, a stall, the decision
 *  cap, the budget) would only end the same way again. */
const RESUMABLE_STOPS = new Set(['aborted', 'paused', 'provider-errors', 'finished']);

/** A transcript file's records; a torn last line (the process was killed mid-write) is dropped. */
export function readPartialTranscript(path: string): TranscriptRecord[] {
	const out: TranscriptRecord[] = [];
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as TranscriptRecord);
		} catch {
			break;
		}
	}
	return out;
}

/**
 * The records to continue from (header first), or null when the game cannot be continued.
 * - The result and the after-game statements are left out (they are made again).
 * - A game ended by provider errors lost its last decisions to fallbacks: the record is cut
 *   before the first decision of the failing seat's last run of unanswered decisions, so those
 *   are asked again.
 */
export function resumableRecords(records: TranscriptRecord[]): TranscriptRecord[] | null {
	if (records[0]?.type !== 'header') return null;
	const result = records.find((r): r is ResultRecord => r.type === 'result');
	const summary = result?.summary as { stopReason?: string; stopDetail?: string } | undefined;
	const stop = summary?.stopReason;
	if (stop && !RESUMABLE_STOPS.has(stop)) return null;
	let kept = records.filter((r) => r.type !== 'result' && r.type !== 'statement');
	if (stop === 'provider-errors') {
		const unanswered = (r: TranscriptRecord) =>
			r.type === 'decision' &&
			r.fallback &&
			r.attempts.length > 0 &&
			r.attempts.every((a) => a.providerError);
		// The failing seat is named at the start of the stop detail ("Red: 3 decisions in a row …").
		const seat = /^(\w+):/.exec(summary?.stopDetail ?? '')?.[1];
		let cut = kept.length;
		for (let i = kept.length - 1; i > 0; i--) {
			const r = kept[i];
			if (r.type !== 'decision' || r.forced || r.phaseCapped) continue;
			if (seat && r.seat !== seat) continue;
			if (!unanswered(r)) break;
			cut = i;
		}
		kept = kept.slice(0, cut);
	}
	return kept.some((r) => r.type === 'decision') ? kept : null;
}

export interface ResumeSource {
	file: string;
	records: TranscriptRecord[];
	decisions: number;
	/** Play time already spent on the game (from its start to the last write of the file). */
	priorMs: number;
}

/**
 * The best transcript to continue game `index` from: among the files set aside for it (and not
 * marked `.noresume`), the one with the most decisions whose header passes `sameGame`.
 */
export function findResumeSource(
	gamesDir: string,
	index: number,
	sameGame: (header: HeaderRecord) => boolean
): ResumeSource | null {
	if (!existsSync(gamesDir)) return null;
	const prefix = `g${String(index).padStart(5, '0')}.`;
	let best: ResumeSource | null = null;
	for (const name of readdirSync(gamesDir)) {
		if (!name.startsWith(prefix) || !/\.(abandoned|failed)-\d+\.jsonl$/.test(name)) continue;
		const file = join(gamesDir, name);
		let records: TranscriptRecord[] | null;
		try {
			records = resumableRecords(readPartialTranscript(file));
		} catch {
			records = null;
		}
		if (!records) continue;
		const header = records[0] as HeaderRecord;
		if (!sameGame(header)) continue;
		const decisions = records.filter((r) => r.type === 'decision').length;
		if (best && best.decisions >= decisions) continue;
		const started = Date.parse(header.startedAt);
		// A game that was already resumed carries its earlier play time in the header.
		const before = Number((header.options.league as { playedMs?: number } | undefined)?.playedMs ?? 0);
		const priorMs =
			before + (Number.isFinite(started) ? Math.max(0, statSync(file).mtimeMs - started) : 0);
		best = { file, records, decisions, priorMs };
	}
	return best;
}
