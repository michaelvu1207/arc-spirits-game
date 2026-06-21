/**
 * Ranked matchmaking pairing.
 *
 * `tryFormRankedMatch` asks the DB (under a transaction-level advisory lock — see
 * the `arc_spirits_2d.try_form_ranked_match` SQL function) to atomically claim one
 * in-window group of RANKED_LOBBY_SIZE queued players, then creates a started ranked
 * session for them and stamps each claimed queue row with the new session id.
 *
 * Race-safe: the SQL function serializes all pairing attempts and flips the chosen
 * rows to status='matched' in the same statement, so two concurrent polls can never
 * pair the same player twice. If session creation fails after the claim, the rows
 * are rolled back to 'queued' so the players re-enter the pool.
 *
 * All writes go through the play admin client (arc_spirits_2d schema).
 */
import { ordinal, rating } from 'openskill';
import { getSupabaseAdmin } from '$lib/server/supabaseAdmin';
import { RANKED_LOBBY_SIZE } from '../types';
import { createRankedSession, type RankedPlayer } from './service';

const PLAY_SCHEMA = 'arc_spirits_2d';
const QUEUE_TABLE = 'match_queue';
const RATINGS_TABLE = 'player_ratings';
const SESSIONS_TABLE = 'play_game_sessions';
const MEMBERS_TABLE = 'play_session_members';

// Ordinal-spread matchmaking window (in ordinal units). Starts tight and widens with
// the oldest queued player's wait so nobody waits forever for a perfect-skill group.
const BASE_WINDOW = 5.0; // initial acceptable ordinal spread
const WIDEN_PER_SEC = 0.5; // widen by this much per second of the oldest member's wait
const MAX_WINDOW = 100.0; // hard cap on the spread

interface QueueRow {
	user_id: string;
	display_name: string | null;
	status: string;
}

function getAdmin() {
	return getSupabaseAdmin(PLAY_SCHEMA);
}

/**
 * Attempt to form ONE ranked match from the current queue. Returns the created room
 * code when a group was paired + a session created, or null when there aren't enough
 * in-window players yet. Best-effort: logs and swallows transient errors (callers
 * poll again shortly).
 */
export async function tryFormRankedMatch(): Promise<{ roomCode: string } | null> {
	const admin = getAdmin();
	if (!admin) return null;

	// 1) Atomically claim an in-window group (advisory-locked SQL function). The chosen
	//    rows come back already flipped to status='matched'.
	const claimed = await admin.rpc('try_form_ranked_match', {
		p_lobby_size: RANKED_LOBBY_SIZE,
		p_base_window: BASE_WINDOW,
		p_widen_per_sec: WIDEN_PER_SEC,
		p_max_window: MAX_WINDOW
	});
	if (claimed.error) {
		console.error('[matchmaking] try_form_ranked_match RPC failed:', claimed.error.message);
		return null;
	}

	const rows = (claimed.data as QueueRow[] | null) ?? [];
	if (rows.length < RANKED_LOBBY_SIZE) {
		// Either no in-window group, or a partial/empty claim — nothing to start.
		// (A non-empty-but-short claim shouldn't happen given the SQL, but guard anyway:
		// release any stray claimed rows back to the pool.)
		if (rows.length > 0) await releaseToQueue(rows.map((r) => r.user_id));
		return null;
	}

	const players: RankedPlayer[] = rows.map((r) => ({
		userId: r.user_id,
		displayName: r.display_name ?? 'Player'
	}));

	// 2) Create the started ranked session for the claimed group.
	let created: { roomCode: string; sessionId: string };
	try {
		created = await createRankedSession(players);
	} catch (err) {
		console.error('[matchmaking] createRankedSession failed; releasing claim:', err);
		await releaseToQueue(players.map((p) => p.userId));
		return null;
	}

	// 3) Stamp each claimed queue row with the new session id so the owners' next poll
	//    resolves the room. Best-effort — the session already exists; a stamp failure
	//    just means a slightly slower hand-off (the row stays 'matched').
	const stamp = await admin
		.from(QUEUE_TABLE)
		.update({ claimed_session_id: created.sessionId, updated_at: new Date().toISOString() })
		.in(
			'user_id',
			players.map((p) => p.userId)
		);
	if (stamp.error) {
		console.error('[matchmaking] failed to stamp claimed_session_id:', stamp.error.message);
	}

	return { roomCode: created.roomCode };
}

/** Roll a set of claimed rows back to 'queued' (used when session creation fails). */
async function releaseToQueue(userIds: string[]): Promise<void> {
	const admin = getAdmin();
	if (!admin || userIds.length === 0) return;
	const res = await admin
		.from(QUEUE_TABLE)
		.update({ status: 'queued', claimed_session_id: null, updated_at: new Date().toISOString() })
		.in('user_id', userIds)
		.eq('status', 'matched');
	if (res.error) {
		console.error('[matchmaking] failed to release claim back to queue:', res.error.message);
	}
}

/** Outcome of a queue poll, returned to the client. */
export interface QueuePollResult {
	status: 'searching' | 'matched';
	/** Room code to navigate to, when matched and the session id is resolvable. */
	roomCode?: string;
	/** This user's session member id in the matched game (for cookie/cross-origin storage). */
	memberId?: string;
	/** How many players are currently queued (this user included). */
	queued: number;
	/** Target lobby size. */
	needed: number;
}

/**
 * Enqueue (or refresh) this user for ranked, run one pairing attempt, and report
 * back this user's status. Idempotent per user (the queue pk is user_id): re-calling
 * while 'queued' just refreshes; while 'matched' it resolves the room. Throws only on
 * a hard enqueue failure; pairing/resolution errors degrade to 'searching'.
 */
export async function enqueueAndPoll(
	userId: string,
	displayName: string
): Promise<QueuePollResult> {
	const admin = getAdmin();
	if (!admin) throw new Error('Matchmaking is unavailable (no service-role key).');

	// If already matched, skip re-enqueue and just resolve the room.
	const existing = await admin
		.from(QUEUE_TABLE)
		.select('status, claimed_session_id')
		.eq('user_id', userId)
		.maybeSingle();
	if (existing.error) throw new Error(`Queue lookup failed: ${existing.error.message}`);

	const alreadyMatched =
		existing.data?.status === 'matched' && existing.data?.claimed_session_id != null;

	if (!alreadyMatched) {
		// Seed mu/sigma/ordinal from the player's current rating (default for new players).
		const ratingRes = await admin
			.from(RATINGS_TABLE)
			.select('mu, sigma')
			.eq('user_id', userId)
			.maybeSingle();
		if (ratingRes.error) throw new Error(`Rating lookup failed: ${ratingRes.error.message}`);
		const seed = ratingRes.data
			? rating({ mu: ratingRes.data.mu, sigma: ratingRes.data.sigma })
			: rating();
		const ord = ordinal(seed);

		const upsert = await admin.from(QUEUE_TABLE).upsert(
			{
				user_id: userId,
				display_name: displayName,
				mu: seed.mu,
				sigma: seed.sigma,
				ordinal: ord,
				party_size: 1,
				status: 'queued',
				claimed_session_id: null,
				queued_at: new Date().toISOString(),
				updated_at: new Date().toISOString()
			},
			{ onConflict: 'user_id' }
		);
		if (upsert.error) throw new Error(`Failed to enqueue: ${upsert.error.message}`);

		// Try to form a match now that this player is in the pool.
		await tryFormRankedMatch();
	}

	return resolveQueueStatus(userId);
}

/** Resolve a user's current queue status into a client poll result. */
export async function resolveQueueStatus(userId: string): Promise<QueuePollResult> {
	const admin = getAdmin();
	if (!admin) return { status: 'searching', queued: 0, needed: RANKED_LOBBY_SIZE };

	const [me, countRes] = await Promise.all([
		admin.from(QUEUE_TABLE).select('status, claimed_session_id').eq('user_id', userId).maybeSingle(),
		admin.from(QUEUE_TABLE).select('user_id', { count: 'exact', head: true }).eq('status', 'queued')
	]);

	const queued = countRes.count ?? 0;
	const base = { queued, needed: RANKED_LOBBY_SIZE } as const;

	if (me.data?.status === 'matched' && me.data?.claimed_session_id != null) {
		const sessionId = me.data.claimed_session_id as string;
		// Resolve the room code + this user's member id in the matched session, so the
		// endpoint can set the room-member cookie and the client can store it.
		const [sess, mem] = await Promise.all([
			admin.from(SESSIONS_TABLE).select('room_code').eq('id', sessionId).maybeSingle(),
			admin
				.from(MEMBERS_TABLE)
				.select('id')
				.eq('session_id', sessionId)
				.eq('user_id', userId)
				.maybeSingle()
		]);
		const roomCode = (sess.data as { room_code?: string } | null)?.room_code;
		const memberId = (mem.data as { id?: string } | null)?.id;
		if (roomCode) return { status: 'matched', roomCode, memberId, ...base };
	}

	return { status: 'searching', ...base };
}

/** Remove this user from the queue (cancel search). */
export async function leaveQueue(userId: string): Promise<void> {
	const admin = getAdmin();
	if (!admin) return;
	// Only cancel a still-searching row — never clobber a 'matched' hand-off.
	const res = await admin
		.from(QUEUE_TABLE)
		.update({ status: 'cancelled', updated_at: new Date().toISOString() })
		.eq('user_id', userId)
		.eq('status', 'queued');
	if (res.error) {
		console.error('[matchmaking] leaveQueue failed:', res.error.message);
		throw new Error(res.error.message);
	}
}
