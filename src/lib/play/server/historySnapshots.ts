/**
 * Round-history side effect (game_state_snapshots + replay_codes), client-injected so
 * BOTH transports run it: the SvelteKit HTTP path (service.ts wrapper) and the
 * standalone WebSocket room server. Previously WS-committed `commitRound`s skipped
 * these rows — a transport-divergent side effect this batch closes.
 *
 * Exactly-once: the snapshot write is an UPSERT keyed on
 * (game_id, navigation_count, player_color). The replay code is select → insert
 * with the UNIQUE (game_id, navigation_count) index from
 * supabase/migrations/20260710_ranked_finalize.sql as the arbiter: when two
 * concurrent drains race the insert, the loser re-reads and adopts the winner's
 * code, so one logical code exists per round (the old check-then-insert could
 * mint two).
 *
 * No `$env` / SvelteKit imports — throws plain Errors; callers decide severity.
 */
import { buildHistorySnapshotRows, buildSessionProjection } from '../runtime';
import type { PublicGameState } from '../types';
import type { PlayDbClient } from './commit';

const HISTORY_TABLES = {
	SNAPSHOTS: 'game_state_snapshots',
	REPLAY_CODES: 'replay_codes',
	REPLAY_FRAMES: 'replay_frames'
} as const;

export type ReplayFrameRow = {
	game_id: string;
	revision: number;
	round: number;
	phase: string;
	public_state: Record<string, unknown>;
	created_at: string;
};

/** Build the disclosure-safe, command-boundary frame used by public replays. */
export function buildReplayFrame(state: PublicGameState, timestamp: string): ReplayFrameRow | null {
	if (!state.gameId) return null;
	let projected: Record<string, unknown>;
	try {
		projected = buildSessionProjection(state, {
			role: 'spectator',
			seatColor: null,
			displayName: null
		}) as unknown as Record<string, unknown>;
	} catch {
		// Legacy/corrupt rows can be structurally incomplete. Replay capture is owed
		// only for a valid live state and must never prevent its authority commit.
		return null;
	}
	// A share capability is not a room-admission capability. Remove room/member
	// identifiers and the full-state hash (an unnecessary oracle over hidden data).
	delete projected.roomCode;
	delete projected.stateHash;
	delete projected.viewer;
	const seats = projected.seats;
	if (seats && typeof seats === 'object') {
		projected.seats = Object.fromEntries(
			Object.entries(seats as Record<string, Record<string, unknown>>).map(([seat, value]) => [
				seat,
				{ ...value, memberId: null }
			])
		);
	}
	return {
		game_id: state.gameId,
		revision: state.revision,
		round: state.round,
		phase: state.phase,
		public_state: projected,
		created_at: timestamp
	};
}

export async function writeReplayFrameWith(
	historyAdmin: PlayDbClient,
	frame: ReplayFrameRow
): Promise<void> {
	const { error } = await historyAdmin
		.from(HISTORY_TABLES.REPLAY_FRAMES)
		.upsert(frame, { onConflict: 'game_id,revision' });
	if (error) throw new Error(`Failed to write replay frame: ${error.message}`);
}

async function findReplayCode(
	historyAdmin: PlayDbClient,
	gameId: string,
	navigationCount: number
): Promise<string | null> {
	const existing = await historyAdmin
		.from(HISTORY_TABLES.REPLAY_CODES)
		.select('code')
		.eq('game_id', gameId)
		.eq('navigation_count', navigationCount)
		.limit(1)
		.maybeSingle();
	if (existing.error) {
		throw new Error(`Failed to load replay code: ${existing.error.message}`);
	}
	return (existing.data?.code as string | undefined) ?? null;
}

async function ensureReplayCodeWith(
	historyAdmin: PlayDbClient,
	gameId: string,
	navigationCount: number
): Promise<string> {
	const existing = await findReplayCode(historyAdmin, gameId, navigationCount);
	if (existing) return existing;

	const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
	for (let attempt = 0; attempt < 20; attempt += 1) {
		let code = '';
		for (let index = 0; index < 4; index += 1) {
			code += alphabet[Math.floor(Math.random() * alphabet.length)];
		}
		if (!/[A-Z]/.test(code)) continue;

		const inserted = await historyAdmin.from(HISTORY_TABLES.REPLAY_CODES).insert({
			code,
			game_id: gameId,
			navigation_count: navigationCount
		});
		if (!inserted.error) {
			return code;
		}

		// A violation of EITHER unique key means another writer won a race: either the
		// (game_id, navigation_count) arbiter — a concurrent drain minted this round's
		// code first, adopt it — or the code PK collided with another game's code, in
		// which case the re-read finds nothing and the loop retries with a fresh code.
		const winner = await findReplayCode(historyAdmin, gameId, navigationCount);
		if (winner) return winner;
	}

	throw new Error('Failed to create replay code.');
}

/** Upsert PREBUILT per-player snapshot rows + ensure a replay code. Split out so the
 *  effects outbox can replay a round's snapshots from durably stored rows after a
 *  crash, when the pre-commit round state they were built from no longer exists. */
export async function writeSnapshotRowsWith(
	historyAdmin: PlayDbClient,
	rows: Record<string, unknown>[],
	gameId: string,
	navigationCount: number
): Promise<void> {
	if (rows.length === 0) return;

	const { error } = await historyAdmin
		.from(HISTORY_TABLES.SNAPSHOTS)
		.upsert(rows, { onConflict: 'game_id,navigation_count,player_color' });

	if (error) {
		throw new Error(`Failed to write history snapshots: ${error.message}`);
	}

	await ensureReplayCodeWith(historyAdmin, gameId, navigationCount);
}

/** Upsert this round's per-player history snapshots + ensure a replay code. */
export async function writeHistorySnapshotsWith(
	historyAdmin: PlayDbClient,
	state: PublicGameState,
	timestamp: string
): Promise<void> {
	if (!state.gameId) return;
	const rows = buildHistorySnapshotRows(state, timestamp) as unknown as Record<string, unknown>[];
	await writeSnapshotRowsWith(historyAdmin, rows, state.gameId, state.round);
}
