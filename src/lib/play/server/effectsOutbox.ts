/**
 * Durable effects outbox — makes the REQUIRED post-commit side effects (member-row
 * mirrors, terminal match/rating records, round-history snapshots) crash-recoverable.
 *
 * The problem this closes: each effect is idempotent WHEN INVOKED, but a SIGKILL in
 * the window after the atomic state/ledger commit and before the effects run used to
 * leave them missing forever — nothing durable said they were still owed, and neither
 * restart load nor duplicate handling replayed them.
 *
 * The protocol:
 *  1. Every commit whose mutation OWES effects appends one synthetic ledger event
 *     (`command_type: '$effects'`, no cmdId) IN THE SAME atomic commit, carrying the
 *     effect list — including prebuilt history-snapshot rows (the pre-commit round
 *     state they derive from does not survive the commit) and, on a game finish, the
 *     FROZEN terminal finalize inputs + finish timestamp (a delayed recovery must
 *     record the state and time that actually ended the game, not the drain-time
 *     state or the recovery wall-clock). The moment the state is durable, so is the
 *     record of what is still owed.
 *  2. After the commit, the writer drains the session's outbox: run each pending
 *     effect (all idempotent / self-repairing), and DELETE the outbox event only when
 *     every effect in it reported durable completion. Acknowledgement happens after
 *     this attempt — the attempt itself is already durable via (1), so an effect
 *     failure never blocks the ack; it just leaves the outbox row for recovery.
 *  3. Recovery: `RoomHost.load` (restart), duplicate-cmdId handling (client retry,
 *     either transport), and every subsequent successful commit drain the outbox
 *     again, so a crashed writer's owed effects are eventually completed EXACTLY ONCE
 *     (mirrors are pure functions of the durable state; history snapshots are
 *     upsert-keyed; match finalize runs as ONE database transaction anchored on the
 *     match_results unique key — see matchFinalize.ts / 20260710_ranked_finalize.sql).
 *
 * No `$env` / SvelteKit imports — clients are injected; callers decide severity.
 */

import type { GameCommand, PublicGameState } from '../types';
import { COMMIT_TABLES, type CommitEvent, type PlayDbClient } from './commit';
import { seatMirrorsChanged, syncMemberMirrorsWith } from './memberMirrors';
import {
	finalizeMatchWith,
	frozenFinalizeState,
	type FinalizeMatchSession,
	type FinalizeStateInputs
} from './matchFinalize';
import { buildReplayFrame, writeReplayFrameWith, writeSnapshotRowsWith, type ReplayFrameRow } from './historySnapshots';
import { buildHistorySnapshotRows } from '../runtime';

/** Synthetic ledger event type marking effects still owed for a committed revision.
 *  Deleted once every effect in it has durably completed. */
export const EFFECTS_COMMAND_TYPE = '$effects';

export type RequiredEffect =
	/** Re-mirror seat/guardian/role onto member rows — replayed from the CURRENT
	 *  durable state (mirrors are a pure function of it, so later state is never wrong). */
	| { kind: 'memberMirrors' }
	/** Record match_results / match_result_players (+ ranked ratings) exactly once.
	 *  `terminal` and the session's ended_at are FROZEN at the finished transition
	 *  (they ride the same atomic commit), so a delayed recovery drain finalizes the
	 *  standings/winner/round/finish-time that actually ended the game — never the
	 *  drain-time state or the recovery wall-clock. `terminal` is optional ONLY for
	 *  wire-compat with outbox rows written before it existed (those legacy rows
	 *  fall back to the drain-time state, the old behavior). */
	| { kind: 'matchFinalize'; session: FinalizeMatchSession; terminal?: FinalizeStateInputs }
	/** Disclosure-safe spectator projection for one authoritative revision. */
	| { kind: 'replayFrame'; frame: ReplayFrameRow }
	/** Round-history snapshot rows PREBUILT from the pre-commit round state (which is
	 *  gone after the commit) + the replay-code key. Upsert-idempotent. */
	| { kind: 'historySnapshots'; rows: Record<string, unknown>[]; gameId: string; round: number };

/**
 * The required effects a mutation owes, computed BEFORE the commit so they can ride
 * in the same atomic write. Shared by both transports (HTTP service + WS room host).
 */
export function computeRequiredEffects(params: {
	prev: PublicGameState;
	next: PublicGameState;
	command: GameCommand | null;
	session: FinalizeMatchSession;
	/** Pre-commit round states for batched ticks that cross a commitRound. */
	roundStates?: PublicGameState[];
	timestamp: string;
}): RequiredEffect[] {
	const { prev, next, command, session, timestamp } = params;
	const effects: RequiredEffect[] = [];
	const replayFrame = buildReplayFrame(next, timestamp);
	if (replayFrame) effects.push({ kind: 'replayFrame', frame: replayFrame });

	if (seatMirrorsChanged(prev, next)) {
		effects.push({ kind: 'memberMirrors' });
	}

	const roundStates = [...(params.roundStates ?? [])];
	if (command?.type === 'commitRound') roundStates.push(prev);
	for (const roundState of roundStates) {
		if (!roundState.gameId) continue;
		const rows = buildHistorySnapshotRows(roundState, timestamp);
		if (rows.length === 0) continue;
		effects.push({
			kind: 'historySnapshots',
			rows: rows as unknown as Record<string, unknown>[],
			gameId: roundState.gameId,
			round: roundState.round
		});
	}

	if (next.status === 'finished' && prev.status !== 'finished') {
		effects.push({
			kind: 'matchFinalize',
			// Freeze the terminal inputs NOW: `next` IS the state that finished the
			// game, and this effect commits atomically with it. The session's ended_at
			// is not stamped until that same commit, so the commit-build timestamp is
			// the committed finish time for the record (recovery must never stamp its
			// own wall-clock).
			session: { ...session, ended_at: session.ended_at ?? timestamp },
			terminal: frozenFinalizeState(next)
		});
	}

	return effects;
}

/** The outbox ledger event for a commit's owed effects (null when nothing is owed). */
export function effectsOutboxEvent(
	revision: number,
	effects: RequiredEffect[]
): CommitEvent | null {
	if (effects.length === 0) return null;
	return {
		commandType: EFFECTS_COMMAND_TYPE,
		payload: { effects },
		actorMemberId: null,
		revision
	};
}

export interface DrainEffectsOpts {
	/** Explicit opt-in for the non-atomic finalize fallback (local/test only);
	 *  undefined defers to ARC_ALLOW_NONATOMIC_COMMIT. Resolved by the shared
	 *  nonAtomicFallbackPermitted gate in commit.ts — production refuses it
	 *  UNCONDITIONALLY, explicit opt-in or not. */
	allowNonAtomicFallback?: boolean;
}

/** Run one effect against the injected clients. Returns whether its durable outcome
 *  now exists (idempotent: re-running a completed effect is a no-op). */
async function runEffect(
	db: PlayDbClient,
	historyDb: PlayDbClient | null,
	sessionId: string,
	state: PublicGameState,
	effect: RequiredEffect,
	opts?: DrainEffectsOpts
): Promise<boolean> {
	switch (effect.kind) {
		case 'memberMirrors':
			await syncMemberMirrorsWith(db, sessionId, state);
			return true;
		case 'matchFinalize':
			// The frozen terminal inputs — NOT the drain-time state — are what gets
			// finalized; only legacy pre-freeze outbox rows lack them.
			return finalizeMatchWith(db, effect.session, effect.terminal ?? state, opts);
		case 'historySnapshots':
			if (!historyDb) return true; // history schema disabled ⇒ effect not owed.
			await writeSnapshotRowsWith(historyDb, effect.rows, effect.gameId, effect.round);
			return true;
		case 'replayFrame':
			if (!historyDb) return true;
			await writeReplayFrameWith(historyDb, effect.frame);
			return true;
		default:
			// Unknown kind (written by a newer version): leave the row for a writer that
			// understands it rather than deleting an effect we cannot perform.
			return false;
	}
}

/**
 * Drain every pending `$effects` outbox row for a session: run the owed effects and
 * delete each row once ALL of its effects durably completed. `state` must be the
 * CURRENT durable state (mirrors/finalize replay from it). Throws only on the outbox
 * read itself; individual effect failures are logged and left for the next drain.
 */
export async function drainEffectsOutbox(
	db: PlayDbClient,
	historyDb: PlayDbClient | null,
	sessionId: string,
	state: PublicGameState,
	opts?: DrainEffectsOpts
): Promise<void> {
	const { data, error } = await db
		.from(COMMIT_TABLES.EVENTS)
		.select('id, command_payload')
		.eq('session_id', sessionId)
		.eq('command_type', EFFECTS_COMMAND_TYPE);
	if (error) {
		throw new Error(`effects outbox read failed: ${error.message}`);
	}
	const rows =
		(data as { id: string; command_payload: { effects?: RequiredEffect[] } }[] | null) ?? [];

	for (const row of rows) {
		const effects = row.command_payload?.effects ?? [];
		let allDone = true;
		for (const effect of effects) {
			try {
				if (!(await runEffect(db, historyDb, sessionId, state, effect, opts))) allDone = false;
			} catch (err) {
				allDone = false;
				console.error(
					`[effects] ${effect.kind} failed for session ${sessionId} (will retry on next drain):`,
					err instanceof Error ? err.message : err
				);
			}
		}
		if (allDone) {
			const del = await db.from(COMMIT_TABLES.EVENTS).delete().eq('id', row.id);
			if (del?.error) {
				// The effects ARE durable; a re-drain re-runs idempotent no-ops and retries
				// the delete — never wrong, only redundant.
				console.error(
					`[effects] outbox delete failed for session ${sessionId}:`,
					del.error.message
				);
			}
		}
	}
}
