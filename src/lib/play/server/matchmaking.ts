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
 * pair the same player twice. FAIL-CLOSED CLAIM HANDLING: when a formation fails
 * after the claim, the rows re-enter the pool ONLY once the partial session is
 * CONFIRMED durably closed (or provably never existed) — an unconfirmed close
 * parks them in the RECOVERING state, held out of the pool until the owner's next
 * poll or the reaper completes the close. Nobody is ever eligible for a second
 * match while their first partial room might still be live.
 *
 * All writes go through the play admin client (arc_spirits_2d schema).
 */
import { randomBytes } from 'node:crypto';
import { ordinal, rating } from 'openskill';
import { getSupabaseAdmin } from '$lib/server/supabaseAdmin';
import { RANKED_LOBBY_SIZE } from '../types';
import { DEFAULT_BOT_PROFILE_KEY } from '../bots/contract';
import { createRankedSession, type RankedPlayer } from './service';
import { RankedFormationAbortError } from './formationAbort';
import { botsOnlineAt } from './botRoster';

const PLAY_SCHEMA = 'arc_spirits_2d';
const QUEUE_TABLE = 'match_queue';
const RATINGS_TABLE = 'player_ratings';
const SESSIONS_TABLE = 'play_game_sessions';
const MEMBERS_TABLE = 'play_session_members';
/** Tombstones for ATTEMPT-BOUND search cancellation (see cancelSearch): one row
 *  per cancelled search token, so a leave that raced AHEAD of its own attempt's
 *  enqueue still wins — the late enqueue finds the tombstone and self-cancels. */
const CANCELLATIONS_TABLE = 'match_search_cancellations';
/** A tombstone only needs to outlive any conceivably-late HTTP request of its
 *  attempt; an hour is orders of magnitude beyond every client/proxy timeout. */
const TOMBSTONE_TTL_MS = 60 * 60 * 1000;
/** Queue-row status for a formation whose partial room could NOT be confirmed
 *  closed: the claim is HELD OUT of the pool (never re-queued, never claimable)
 *  until the doomed session is durably closed — the owner's next poll (or the
 *  reaper) retries the close and only then releases the row. Fail-closed: a
 *  player is never eligible for a second match while their first partial room
 *  might still be live. */
const RECOVERING_STATUS = 'recovering';

// Ordinal-spread matchmaking window (in ordinal units). Starts tight and widens with
// the oldest queued player's wait so nobody waits forever for a perfect-skill group.
const BASE_WINDOW = 5.0; // initial acceptable ordinal spread
const WIDEN_PER_SEC = 0.5; // widen by this much per second of the oldest member's wait
const MAX_WINDOW = 100.0; // hard cap on the spread

// A 'matched' queue row whose updated_at is older than this has long since handed off
// to a session; reap it so the queue table doesn't accumulate stale matched rows.
const STALE_MATCHED_MS = 10 * 60 * 1000; // 10 minutes

// A claimed-but-unstamped row ('matched' with claimed_session_id NULL) is a formation
// MID-hand-off. Formation normally stamps within a couple of seconds; a claim older
// than this grace means the formation process died mid-flight, and the row is released
// back to the pool (the stamp, being conditional, can never land on a released row).
const FORMATION_STALE_MS = 30 * 1000;

interface QueueRow {
	user_id: string;
	display_name: string | null;
	status: string;
	is_bot: boolean;
	bot_profile: string | null;
	/** True when the queued human holds a PERMANENT verified account. An anonymous
	 *  guest is never represented as a verified ranked identity: a claimed group
	 *  containing one plays a casual, unrated matchmade game. Bots inherit true so
	 *  they never demote a verified party. */
	is_verified?: boolean | null;
	ranked_season_id?: string | null;
}

function getAdmin() {
	return getSupabaseAdmin(PLAY_SCHEMA);
}

/** A bot account eligible for matchmaking backfill (one row of player_ratings). */
export interface BotCandidate {
	user_id: string;
	display_name: string | null;
	mu: number;
	sigma: number;
	bot_profile: string | null;
}

/** Compute a bot's ordinal the same way OpenSkill does (mu - 3*sigma); player_ratings
 *  has no ordinal column for bots, so we derive it from mu/sigma. */
export function botOrdinal(c: Pick<BotCandidate, 'mu' | 'sigma'>): number {
	return c.mu - 3 * c.sigma;
}

/**
 * Pure helper: order bot candidates by skill proximity to the human (nearest ordinal
 * first) and take the nearest `take`. Extracted so the selection/ordering is unit-testable
 * without a live DB. Stable for equal distances (preserves input order via index tiebreak).
 */
export function pickNearestBots(
	candidates: BotCandidate[],
	humanOrdinal: number,
	take: number
): BotCandidate[] {
	return candidates
		.map((c, i) => ({ c, i, dist: Math.abs(botOrdinal(c) - humanOrdinal) }))
		.sort((a, b) => a.dist - b.dist || a.i - b.i)
		.slice(0, Math.max(0, take))
		.map((x) => x.c);
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

	// Build the player list, carrying each row's bot flags through. Sort humans first so
	// createRankedSession's host (players[0]) is always a human (the SQL matcher guarantees
	// ≥1 human per claimed group). Stable within each group preserves queued order.
	const players: RankedPlayer[] = rows
		.map((r) => ({
			userId: r.user_id,
			displayName: r.display_name ?? 'Player',
			isBot: r.is_bot,
			botProfile: r.bot_profile
		}))
		.sort((a, b) => Number(a.isBot) - Number(b.isBot));

	// 2) Create the started matchmade session for the claimed group. RATED only when
	//    every human in the party holds a permanent verified identity — a party with
	//    an anonymous guest plays casual/unrated (Quick Play stays frictionless, but
	//    an anonymous identity is never presented as a verified ranked one). The
	//    verification flags are re-read from the claimed queue rows (fail-closed:
	//    a missing flag counts as unverified).
	const humanIds = rows.filter((r) => !r.is_bot).map((r) => r.user_id);
	let allHumansVerified = false;
	const flags = new Map<string, { verified: boolean; seasonId: string | null }>();
	if (humanIds.length > 0) {
		const verifiedRes = await admin
			.from(QUEUE_TABLE)
			.select('user_id, is_verified, ranked_season_id')
			.in('user_id', humanIds);
		for (const row of ((verifiedRes.data as { user_id: string; is_verified?: boolean | null; ranked_season_id?: string | null }[] | null) ?? []))
			flags.set(row.user_id, { verified: row.is_verified === true, seasonId: row.ranked_season_id ?? null });
		allHumansVerified = humanIds.every((id) => flags.get(id)?.verified === true);
	}
	const seasonIds = new Set(humanIds.map((id) => flags.get(id)?.seasonId ?? null));
	const rankedSeasonId = allHumansVerified && seasonIds.size === 1 ? [...seasonIds][0] : null;
	allHumansVerified = allHumansVerified && rankedSeasonId != null;
	let created: { roomCode: string; sessionId: string };
	try {
		created = await createRankedSession(players, allHumansVerified ? 'ranked' : 'casual', rankedSeasonId);
	} catch (err) {
		// FAIL-CLOSED CLAIM HANDLING: the claim may only re-enter the pool once the
		// partial room is CONFIRMED gone. createRankedSession signals exactly that:
		// a RankedFormationAbortError says a session row exists and whether its
		// close was durably confirmed. Releasing on an UNCONFIRMED close would let
		// these players form a second match while the first room is still live —
		// so an unconfirmed close parks the claim in the RECOVERING state instead
		// (held out of the pool; the owners' polls / the reaper retry the close and
		// only then release). Any other error precedes session creation — there is
		// no room, and releasing is safe.
		console.error('[matchmaking] createRankedSession failed:', err);
		if (err instanceof RankedFormationAbortError && !err.closed) {
			await markClaimsRecovering(
				players.map((p) => p.userId),
				err.sessionId
			);
			return null;
		}
		await releaseToQueue(players.map((p) => p.userId));
		return null;
	}

	// 3) Stamp each claimed queue row with the new session id so the owners' next poll
	//    resolves the room. The stamp is the SINGLE-WINNER hand-off point, CONDITIONAL
	//    on the row still being 'matched' and still unstamped: a row that was cancelled
	//    mid-formation (handle-bound cancelSearch) or recovered/re-claimed elsewhere is
	//    NOT stamped, and the membership formation just created for it is retired again
	//    below — a cancelled search is never dragged into the formed game, and no ghost
	//    seat survives.
	const stamp = await admin
		.from(QUEUE_TABLE)
		.update({ claimed_session_id: created.sessionId, updated_at: new Date().toISOString() })
		.in(
			'user_id',
			players.map((p) => p.userId)
		)
		.eq('status', 'matched')
		.is('claimed_session_id', null)
		.select('user_id');
	if (stamp.error) {
		// With no stamps, nobody can ever resolve this room — abort the formation
		// whole: close the just-created session, and ONLY a CONFIRMED close puts
		// the claim back in the pool. An unconfirmed close parks the claim in the
		// RECOVERING state (held out of the pool until the room is durably closed)
		// so nobody re-queues while their partial room might still be live.
		console.error('[matchmaking] failed to stamp claimed_session_id:', stamp.error.message);
		try {
			await closeFormedSession(created.sessionId);
		} catch (closeErr) {
			console.error('[matchmaking] failed to close unstamped session:', closeErr);
			await markClaimsRecovering(
				players.map((p) => p.userId),
				created.sessionId
			);
			return null;
		}
		await releaseToQueue(players.map((p) => p.userId));
		return null;
	}
	const stampedIds = new Set(
		(((stamp.data as { user_id: string }[] | null) ?? [])).map((r) => r.user_id)
	);
	for (const player of players.filter((p) => !stampedIds.has(p.userId))) {
		// The row was cancelled (or recovered) mid-formation: the cancellation won —
		// retire the seat formation just created for this player (bot conversion;
		// room close when no human remains). Retried once. If the retirement STILL
		// cannot be confirmed, the formation is ABORTED WHOLE rather than handed
		// off: a cancelled participant must never ride into a live game as an
		// undriven human seat blocking everyone else. Retirement is VERIFIED by
		// re-reading authoritative state (see retireFormedMembership), never
		// inferred from an error-free call.
		try {
			await retireFormedMembership(created.sessionId, player.userId);
		} catch (firstErr) {
			console.error('[matchmaking] retire of unstamped member failed, retrying:', firstErr);
			try {
				await retireFormedMembership(created.sessionId, player.userId);
			} catch (retryErr) {
				console.error(
					'[matchmaking] FAILED to retire unstamped member',
					player.userId,
					'in session',
					created.sessionId,
					'- aborting the formation (no hand-off with a ghost human seat):',
					retryErr
				);
				await abortFormedHandoff(
					created.sessionId,
					players.map((p) => p.userId)
				);
				return null;
			}
		}
	}

	return { roomCode: created.roomCode };
}

/**
 * Abort a formation AFTER its stamp landed (a cancelled participant could not be
 * retired): close the room, then CANCEL the group's still-'matched' queue rows so
 * no later poll resolves the dead room. Cancel — not re-queue — because stamped
 * owners' clients may already have stopped polling (they saw 'matched'); a
 * re-queued row with no poller behind it would just form the next abandoned
 * match. A client still polling simply re-enqueues its cancelled row on the next
 * tick and the search resumes seamlessly. If even the close cannot be confirmed,
 * the rows are parked in the RECOVERING state (held out of the pool) instead.
 */
async function abortFormedHandoff(sessionId: string, userIds: string[]): Promise<void> {
	try {
		await closeFormedSession(sessionId);
	} catch (closeErr) {
		console.error('[matchmaking] failed to close aborted hand-off session:', closeErr);
		await markClaimsRecovering(userIds, sessionId);
		return;
	}
	const admin = getAdmin();
	if (!admin || userIds.length === 0) return;
	const res = await admin
		.from(QUEUE_TABLE)
		.update({ status: 'cancelled', updated_at: new Date().toISOString() })
		.in('user_id', userIds)
		.eq('status', 'matched');
	if (res.error) {
		console.error('[matchmaking] failed to cancel aborted hand-off rows:', res.error.message);
	}
}

/**
 * Park a claimed group's queue rows in the RECOVERING state: the partial session
 * could not be confirmed closed, so the claims are HELD OUT of the pool (the
 * matcher only claims 'queued'; the refresh path never touches 'recovering')
 * with the doomed session id stamped for the recovery paths — the owner's next
 * poll and the reaper each retry the close and only then release/cancel the row.
 * Best-effort by necessity (this IS the failure path); rows it could not mark
 * stay 'matched' and fall to the FORMATION_STALE_MS release, with the abandoned-
 * game reaper as the final backstop for the room itself.
 */
async function markClaimsRecovering(userIds: string[], sessionId: string): Promise<void> {
	const admin = getAdmin();
	if (!admin || userIds.length === 0) return;
	const res = await admin
		.from(QUEUE_TABLE)
		.update({
			status: RECOVERING_STATUS,
			claimed_session_id: sessionId,
			updated_at: new Date().toISOString()
		})
		.in('user_id', userIds)
		.eq('status', 'matched');
	if (res.error) {
		console.error('[matchmaking] failed to mark claims recovering:', res.error.message);
	}
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

/**
 * Bot user_ids currently seated in a LIVE (lobby/active) session — the reservation
 * set the backfill must never re-seat into a second concurrent game.
 *
 * Deliberately TWO PLAIN QUERIES (live session ids, then bot memberships in those
 * sessions) instead of a PostgREST embedded-relation filter
 * (`play_game_sessions!inner(status)` + `.in('play_game_sessions.status', …)`):
 * the local emulator does not implement embedded filters — it silently matched
 * ZERO rows, so the exclusion returned no seated bot ids and back-to-back runs on
 * one store reused the exact bots still seated in the previous run's active room.
 * Plain eq/in filters behave IDENTICALLY on real PostgREST and pgrestEmu (which
 * now REJECTS embedded-relation syntax loudly rather than lying). Bots in
 * closed/finished sessions are NOT reserved — they return to the eligible pool.
 *
 * FAIL-CLOSED: any store error throws (callers must not enqueue bots they cannot
 * prove free). The `.in` list is chunked so a busy store cannot overflow one URL.
 */
async function seatedLiveBotIds(): Promise<Set<string>> {
	const admin = getAdmin();
	const out = new Set<string>();
	if (!admin) return out;
	const live = await admin.from(SESSIONS_TABLE).select('id').in('status', ['lobby', 'active']);
	if (live.error) throw new Error(`Live-session lookup failed: ${live.error.message}`);
	const sessionIds = (((live.data as { id: string }[] | null) ?? [])).map((r) => r.id);
	const CHUNK = 100;
	for (let i = 0; i < sessionIds.length; i += CHUNK) {
		const members = await admin
			.from(MEMBERS_TABLE)
			.select('user_id')
			.eq('is_bot', true)
			.in('session_id', sessionIds.slice(i, i + CHUNK));
		if (members.error) throw new Error(`Seated-bot lookup failed: ${members.error.message}`);
		for (const r of (members.data as { user_id: string | null }[] | null) ?? []) {
			if (r.user_id) out.add(r.user_id);
		}
	}
	return out;
}

/**
 * Backfill the ranked queue with rating-appropriate bots so a waiting human sees real-
 * looking players "join" over a few seconds and is reliably matched. Best-effort: any
 * failure is swallowed so it can never break the human's poll path.
 *
 * Time-ramp: the longer the human waits, the more bots we enqueue (a "lobby filling"
 * feel). Once they've waited ≥4s we always top the queue up to RANKED_LOBBY_SIZE so a
 * match is guaranteed fillable by ~4-6s.
 */
async function ensureBotPresence(humanUserId: string, humanOrdinal: number, rankedSeasonId: string | null): Promise<void> {
	const admin = getAdmin();
	if (!admin) return;
	try {
		// 1) How long has this human been waiting, how many are queued, which bots are
		//    already queued, and which bots are currently seated in a live session.
		const [meRes, queuedCountRes, queuedBotIdsRes, seatedBotIds] = await Promise.all([
			admin.from(QUEUE_TABLE).select('queued_at').eq('user_id', humanUserId).maybeSingle(),
			admin.from(QUEUE_TABLE).select('user_id', { count: 'exact', head: true }).eq('status', 'queued'),
			admin.from(QUEUE_TABLE).select('user_id').eq('status', 'queued').eq('is_bot', true),
			seatedLiveBotIds()
		]);

		const queuedAtMs = meRes.data?.queued_at ? Date.parse(meRes.data.queued_at as string) : Date.now();
		const waitSec = Math.max(0, (Date.now() - queuedAtMs) / 1000);
		const currentQueued = queuedCountRes.count ?? 0;

		// Exclusion set: bots already queued PLUS bots currently seated in a live session.
		// The latter prevents the same bot (e.g. "Mia") appearing in two concurrent games.
		// FAIL-CLOSED: seatedLiveBotIds throws on any store error (caught by the outer
		// best-effort swallow, so NOTHING is enqueued this tick) — a bot whose freedom
		// cannot be verified is never double-seated into a second live game.
		const excludedBotIds = new Set<string>(
			((queuedBotIdsRes.data as { user_id: string }[] | null) ?? []).map((r) => r.user_id)
		);
		for (const id of seatedBotIds) excludedBotIds.add(id);

		// 2) Pull bot candidates from player_ratings (bot_profile is non-null only for the
		//    seeded bot accounts). Drop any excluded (already-queued or mid-game) bots.
		const candidatesRes = await admin
			.from(RATINGS_TABLE)
			.select('user_id, display_name, mu, sigma, bot_profile')
			.not('bot_profile', 'is', null);
		const allBots = ((candidatesRes.data as BotCandidate[] | null) ?? []).filter(
			(b) => !excludedBotIds.has(b.user_id)
		);

		// 2b) Anti-detection rotation: prefer the deterministic "online" subset for this time
		//     bucket so the visible cast rotates rather than always being the same ~30 names.
		//     Keyed on user_id (candidates have no slug). NEVER let rotation starve a match:
		//     pick from online first, then top up from the full eligible pool if the nearest
		//     online bots don't cover what we need. Match reliability beats rotation purity.
		const onlineIds = new Set(
			botsOnlineAt(allBots, Date.now(), { key: (b) => b.user_id }).map((b) => b.user_id)
		);
		const onlineBots = allBots.filter((b) => onlineIds.has(b.user_id));
		// Nearest ~5 from the online subset, then nearest ~5 from the full pool as fallback,
		// de-duplicated with online taking precedence (so rotation is honored when sufficient).
		const nearestOnline = pickNearestBots(onlineBots, humanOrdinal, 5);
		const nearestAll = pickNearestBots(allBots, humanOrdinal, 5);
		const nearestSeen = new Set(nearestOnline.map((b) => b.user_id));
		const nearest = [...nearestOnline, ...nearestAll.filter((b) => !nearestSeen.has(b.user_id))];
		if (nearest.length === 0) return;

		// 3) Decide how many to enqueue this tick.
		//    - Ramp: ~1 bot immediately, +1 per 2s of waiting (the visible "players joining").
		//    - Floor: once waited ≥4s, ALWAYS enqueue enough to reach RANKED_LOBBY_SIZE so a
		//      match can form by ~4-6s.
		const ramp = Math.max(1, Math.floor(waitSec / 2) + 1);
		const topUpToFull = waitSec >= 4 ? Math.max(0, RANKED_LOBBY_SIZE - currentQueued) : 0;
		const want = Math.min(nearest.length, Math.max(ramp, topUpToFull));
		const toEnqueue = nearest.slice(0, want);
		if (toEnqueue.length === 0) return;

		// 4) Upsert each chosen bot into the queue (keyed on user_id).
		const now = new Date().toISOString();
		const rows = toEnqueue.map((b) => ({
			user_id: b.user_id,
			display_name: b.display_name,
			mu: b.mu,
			sigma: b.sigma,
			ordinal: botOrdinal(b),
			party_size: 1,
			status: 'queued',
			claimed_session_id: null,
			is_bot: true,
			bot_profile: b.bot_profile,
			// Bots never demote a verified human party to unrated.
			is_verified: true,
			ranked_season_id: rankedSeasonId,
			queued_at: now,
			updated_at: now
		}));
		await admin.from(QUEUE_TABLE).upsert(rows, { onConflict: 'user_id' });
	} catch (err) {
		console.error('[matchmaking] ensureBotPresence failed (swallowed):', err);
	}
}

/**
 * Reap lingering queued bots when no human is left waiting: if ZERO human rows are
 * status='queued', cancel every queued bot so they don't sit in an empty queue (and
 * can't form a bot-only match — the SQL matcher already forbids that, but this keeps the
 * queue clean). Best-effort: swallows errors.
 */
async function reapQueuedBots(): Promise<void> {
	const admin = getAdmin();
	if (!admin) return;
	try {
		const humans = await admin
			.from(QUEUE_TABLE)
			.select('user_id', { count: 'exact', head: true })
			.eq('status', 'queued')
			.eq('is_bot', false);
		if ((humans.count ?? 0) > 0) return; // a human is still waiting — leave bots in place

		await admin
			.from(QUEUE_TABLE)
			.update({ status: 'cancelled', updated_at: new Date().toISOString() })
			.eq('status', 'queued')
			.eq('is_bot', true);
	} catch (err) {
		console.error('[matchmaking] reapQueuedBots failed (swallowed):', err);
	}
}

/**
 * Reap stale 'matched' queue rows (humans + bots). Once a group is paired, its rows are
 * flipped to status='matched' and the session takes over; the rows are never touched
 * again and would otherwise accumulate forever. Cancel any whose updated_at is older than
 * STALE_MATCHED_MS — long past the hand-off window, so this can't clobber a just-formed
 * match still resolving its room. Best-effort: swallows errors.
 */
async function reapStaleQueueRows(): Promise<void> {
	const admin = getAdmin();
	if (!admin) return;
	try {
		const cutoff = new Date(Date.now() - STALE_MATCHED_MS).toISOString();
		await admin
			.from(QUEUE_TABLE)
			.update({ status: 'cancelled', updated_at: new Date().toISOString() })
			.eq('status', 'matched')
			.lt('updated_at', cutoff);

		// RECOVERING rows whose owner stopped polling: the reaper drives the same
		// recovery — close the doomed room FIRST, and only a confirmed close lets
		// the row leave the held-out state (cancelled here: with no poller behind
		// it, re-queueing would just form the next abandoned match). A row whose
		// close still fails stays recovering and is retried next sweep.
		const held = await admin
			.from(QUEUE_TABLE)
			.select('user_id, claimed_session_id')
			.eq('status', RECOVERING_STATUS)
			.lt('updated_at', cutoff)
			.limit(10);
		for (const row of (held.data as
			| { user_id: string; claimed_session_id: string | null }[]
			| null) ?? []) {
			try {
				if (row.claimed_session_id) await closeFormedSession(row.claimed_session_id);
				await admin
					.from(QUEUE_TABLE)
					.update({ status: 'cancelled', updated_at: new Date().toISOString() })
					.eq('user_id', row.user_id)
					.eq('status', RECOVERING_STATUS);
			} catch (err) {
				console.error('[matchmaking] recovering-row reap failed (retried next sweep):', err);
			}
		}

		// Attempt-cancel tombstones long past any conceivable late request.
		const tombstoneCutoff = new Date(Date.now() - TOMBSTONE_TTL_MS).toISOString();
		const reaped = await admin
			.from(CANCELLATIONS_TABLE)
			.delete()
			.lt('cancelled_at', tombstoneCutoff);
		if (reaped.error && !isMissingTableError(reaped.error)) {
			console.error('[matchmaking] tombstone reap failed (swallowed):', reaped.error.message);
		}
	} catch (err) {
		console.error('[matchmaking] reapStaleQueueRows failed (swallowed):', err);
	}
}

/** A single player currently waiting in the ranked queue. */
export interface QueuedPlayer {
	userId: string;
	displayName: string;
	/** True for the polling user's own row, so the client can highlight "you". */
	you: boolean;
	/** DISCLOSED bot flag: backfilled bot queue entries are never presented as
	 *  ordinary waiting humans — the client labels them truthfully. */
	isBot: boolean;
}

/** Outcome of a queue poll, returned to the client. */
export interface QueuePollResult {
	status: 'searching' | 'matched';
	/** Room code to navigate to, when matched and the session id is resolvable. */
	roomCode?: string;
	/** This user's PUBLIC session member id in the matched game (seat labeling only —
	 *  it never authorizes; the account owns the membership). */
	memberId?: string;
	/** Truthful match metadata: whether the formed game is actually RATED (ranked
	 *  mode — verified-identity party) or a casual unrated matchmade game. */
	rated?: boolean;
	mode?: 'casual' | 'ranked';
	seasonId?: string | null;
	/** The caller's SEARCH HANDLE (see enqueueAndPoll) — an unguessable cancel
	 *  capability for exactly this search's queue row, owner-only. */
	searchId?: string;
	/** How many players are currently queued (this user included). */
	queued: number;
	/** Target lobby size. */
	needed: number;
	/** The players currently waiting in the queue (oldest first, capped). */
	players: QueuedPlayer[];
}

/**
 * Enqueue (or refresh) this user for ranked, run one pairing attempt, and report
 * back this user's status. Idempotent per user (the queue pk is user_id): re-calling
 * while 'queued' just refreshes; while 'matched' it resolves the room. Throws only on
 * a hard enqueue failure; pairing/resolution errors degrade to 'searching'.
 *
 * ATTEMPT CONTRACT (generation-safe cancellation): a new client mints an
 * unguessable ATTEMPT TOKEN per search BEFORE its first request and sends it as
 * `attemptId` with every poll; the row's search_token becomes exactly that
 * token. Because the client knows the token before any response is delivered,
 * an explicit cancel can always retire THIS attempt and only this attempt —
 * there is no current-uid fallback that could cancel a NEWER same-uid search.
 * The write is followed by a tombstone re-check (see cancelSearch): a leave
 * that raced AHEAD of this enqueue has already tombstoned the token, so the
 * late enqueue self-cancels instead of leaving an orphaned live search. Legacy
 * clients that send no attemptId keep the server-minted handle behavior.
 */
export async function enqueueAndPoll(
	userId: string,
	displayName: string,
	verified = false,
	attemptId: string | null = null
): Promise<QueuePollResult> {
	const admin = getAdmin();
	if (!admin) throw new Error('Matchmaking is unavailable (no service-role key).');
	const activeSeason = verified
		? await admin.from('ranked_seasons').select('id').eq('status', 'active').maybeSingle()
		: { data: null, error: null };
	let rankedSeasonId = typeof activeSeason.data?.id === 'string' ? activeSeason.data.id : null;
	if (rankedSeasonId) {
		const ensured = await admin.rpc('ensure_ranked_season_player', {
			p_season_id: rankedSeasonId, p_user_id: userId, p_display_name: displayName, p_is_bot: false
		});
		if (ensured.error) rankedSeasonId = null; // migration lag: fail closed to casual/unrated
	}

	const clientToken = isClientAttemptToken(attemptId) ? attemptId : null;

	// If already matched, skip re-enqueue and just resolve the room.
	const existing = await admin
		.from(QUEUE_TABLE)
		.select('status, claimed_session_id, search_token, queued_at, updated_at')
		.eq('user_id', userId)
		.maybeSingle();
	if (existing.error) throw new Error(`Queue lookup failed: ${existing.error.message}`);

	const row = existing.data as {
		status?: string;
		claimed_session_id?: string | null;
		search_token?: unknown;
		queued_at?: string | null;
		updated_at?: string | null;
	} | null;
	const alreadyMatched = row?.status === 'matched' && row?.claimed_session_id != null;

	// ATTEMPT ADOPTION — the same-uid "attempt 2 while attempt 1's formation is in
	// flight (or formed, or held out recovering)" case. The caller presented a NEW
	// attempt token, but the uid's live row is still bound to the PREVIOUS attempt's
	// cancel handle. The response must never echo that old token as if it were this
	// attempt's own (a cancel through it would be a lie: the client believes it holds
	// its own capability, but a leave with the echoed handle races the OLD attempt's
	// own retirement instead). So the in-flight formation is EXPLICITLY ADOPTED:
	// re-bind the row's search_token to the caller's token (conditional on the row
	// still being in a live non-queued state — the queued/cancelled paths below
	// overwrite the token as part of their normal refresh; only the token moves,
	// never updated_at, so adoption cannot keep a dead formation "fresh" forever).
	// If the caller's token was ALREADY tombstoned (this attempt was cancelled before
	// its first poll landed), the adopted row is retired through the caller's own
	// token instead of being handed to it — the cancel wins in every ordering.
	if (
		clientToken &&
		row &&
		typeof row.search_token === 'string' &&
		row.search_token !== clientToken &&
		(row.status === 'matched' || row.status === RECOVERING_STATUS)
	) {
		const adopt = await admin
			.from(QUEUE_TABLE)
			.update({ search_token: clientToken })
			.eq('user_id', userId)
			.in('status', ['matched', RECOVERING_STATUS])
			.select('user_id');
		if (adopt.error) throw new Error(`Attempt adoption failed: ${adopt.error.message}`);
		if ((adopt.data?.length ?? 0) > 0 && (await isSearchTombstoned(clientToken))) {
			await cancelSearch(clientToken);
			return resolveQueueStatus(userId, clientToken);
		}
	}

	// A RECOVERING row is a formation whose partial room could not be confirmed
	// closed: the claim is held out of the pool until that close is durable. The
	// owner's poll is the natural retry driver — close first, and only a
	// confirmed close releases the row back to 'queued' (the refresh below then
	// re-enqueues it normally). While the close keeps failing the poll reports
	// 'searching' and NEVER re-queues: no duplicate eligibility while the first
	// room might still be live.
	if (row?.status === RECOVERING_STATUS) {
		const doomed = typeof row.claimed_session_id === 'string' ? row.claimed_session_id : null;
		try {
			if (doomed) await closeFormedSession(doomed);
			const release = await admin
				.from(QUEUE_TABLE)
				.update({
					status: 'queued',
					claimed_session_id: null,
					updated_at: new Date().toISOString()
				})
				.eq('user_id', userId)
				.eq('status', RECOVERING_STATUS);
			if (release.error) throw new Error(release.error.message);
		} catch (err) {
			console.error('[matchmaking] recovery close failed (will retry next poll):', err);
			return resolveQueueStatus(userId, clientToken);
		}
	}

	// A 'matched' row with NO claimed_session_id is a formation MID-hand-off: the
	// matcher claimed it and is creating/stamping the session right now. It must
	// NEVER be re-enqueued (that would let this uid be claimed into a SECOND
	// session while the forming one already seats them) and cannot resolve to a
	// room yet — the poll reports 'searching' and the stamp lands on the next
	// tick. If the stamp never lands (the formation process died), the claim is
	// released back to the pool after a grace period; the release is CONDITIONAL,
	// so a stamp racing it either wins whole (matched room resolves) or loses
	// whole (formation's conditional stamp misses and retires the seat).
	let formationInFlight = false;
	if (row?.status === 'matched' && row?.claimed_session_id == null) {
		const ageMs = Date.now() - Date.parse(String(row.updated_at ?? ''));
		if (Number.isFinite(ageMs) && ageMs < FORMATION_STALE_MS) {
			formationInFlight = true;
		} else {
			const release = await admin
				.from(QUEUE_TABLE)
				.update({
					status: 'queued',
					claimed_session_id: null,
					updated_at: new Date().toISOString()
				})
				.eq('user_id', userId)
				.eq('status', 'matched')
				.is('claimed_session_id', null)
				.select('user_id');
			if (release.error) throw new Error(`Queue recovery failed: ${release.error.message}`);
			if ((release.data?.length ?? 0) === 0) {
				// Lost to a concurrent stamp — the match formed after all.
				return resolveQueueStatus(userId, clientToken);
			}
		}
	}

	if (!alreadyMatched && !formationInFlight) {
		// Seed mu/sigma/ordinal from the player's current rating (default for new players).
		const ratingRes = await admin
			.from(rankedSeasonId ? 'ranked_player_seasons' : RATINGS_TABLE)
			.select('mu, sigma')
			.eq('user_id', userId)
			.eq(rankedSeasonId ? 'season_id' : 'user_id', rankedSeasonId ?? userId)
			.maybeSingle();
		if (ratingRes.error) throw new Error(`Rating lookup failed: ${ratingRes.error.message}`);
		const seed = ratingRes.data
			? rating({ mu: ratingRes.data.mu, sigma: ratingRes.data.sigma })
			: rating();
		const ord = ordinal(seed);

		// The SEARCH HANDLE: an unguessable per-search cancel capability. A NEW
		// client supplies its own ATTEMPT TOKEN (known client-side before this
		// request was even sent — the generation-safe cancel contract), and the
		// row is bound to exactly that token: same attempt re-polls carry the same
		// token; a fresh attempt overwrites the previous one. Legacy clients keep
		// the server-minted handle, stable across the polls of one still-queued
		// search. Returned only to the authenticated owner; lets the INITIATING
		// principal retire this exact row later even if their session then
		// authenticates as a different account (or none).
		const searchToken =
			clientToken ??
			(row?.status === 'queued' && typeof row?.search_token === 'string'
				? (row.search_token as string)
				: mintSearchToken());

		const fields = {
			display_name: displayName,
			mu: seed.mu,
			sigma: seed.sigma,
			ordinal: ord,
			party_size: 1,
			status: 'queued',
			claimed_session_id: null,
			is_bot: false,
			// Derived from the VALIDATED user server-side (permanent account vs
			// anonymous guest) — never from wire input.
			is_verified: verified,
			ranked_season_id: rankedSeasonId,
			search_token: searchToken,
			// Preserve the attempt's original wait start across polls. Resetting this
			// every refresh prevented the widening window/bot ramp from ever advancing.
			queued_at: row?.status === 'queued' && row.queued_at ? row.queued_at : new Date().toISOString(),
			updated_at: new Date().toISOString()
		};

		// REFRESH-or-CREATE without ever touching a 'matched' row: a blind upsert
		// here could clobber a row the matcher claimed (or even stamped) between
		// the read above and this write, re-queueing a uid already seated in a
		// forming game — the source of duplicate memberships across sessions. The
		// UPDATE is conditional on a non-matched status; a missing row is INSERTed
		// instead, and a lost insert race (unique violation) means a concurrent
		// writer owns the row now — leave it alone and report the truth below.
		const refresh = await admin
			.from(QUEUE_TABLE)
			.update(fields)
			.eq('user_id', userId)
			.in('status', ['queued', 'cancelled'])
			.select('user_id');
		if (refresh.error) throw new Error(`Failed to enqueue: ${refresh.error.message}`);
		if ((refresh.data?.length ?? 0) === 0) {
			const insert = await admin.from(QUEUE_TABLE).insert({ user_id: userId, ...fields });
			if (
				insert.error &&
				insert.error.code !== '23505' &&
				!/duplicate key/i.test(insert.error.message ?? '')
			) {
				throw new Error(`Failed to enqueue: ${insert.error.message}`);
			}
		}

		// TOMBSTONE RE-CHECK, strictly AFTER the row write: an attempt-bound cancel
		// (cancelSearch) writes its tombstone BEFORE touching rows, so whatever the
		// interleaving, either its row-cancel saw this row, or this re-check sees
		// its tombstone — a leave racing ahead of its own attempt's first enqueue
		// can never leave an orphaned live search that forms an abandoned match.
		// The self-cancel is keyed on (user, THIS attempt token): a newer attempt's
		// row is untouched.
		if (clientToken && (await isSearchTombstoned(clientToken))) {
			const selfCancel = await admin
				.from(QUEUE_TABLE)
				.update({ status: 'cancelled', updated_at: new Date().toISOString() })
				.eq('user_id', userId)
				.eq('search_token', clientToken)
				.in('status', ['queued']);
			if (selfCancel.error) {
				throw new Error(`Failed to honor search cancellation: ${selfCancel.error.message}`);
			}
			return resolveQueueStatus(userId, clientToken);
		}

		// Backfill the queue with rating-appropriate bots (best-effort, never throws) so the
		// human sees players join and a match is reliably fillable. Runs BEFORE pairing so the
		// fresh bots are in the pool for this tick's match attempt.
		await ensureBotPresence(userId, ord, rankedSeasonId);

		// Try to form a match now that this player (and any backfilled bots) are in the pool.
		await tryFormRankedMatch();
	}

	return resolveQueueStatus(userId, clientToken);
}

/** A CLIENT-minted attempt token: `mqa_` + 43 base64url chars (32 random bytes).
 *  Structurally disjoint from the server-minted `mqs_` handles, so neither can
 *  ever be confused for (or forged as) the other. Anything malformed is ignored
 *  and the legacy server-minted handle path applies. */
export function isClientAttemptToken(value: unknown): value is string {
	return typeof value === 'string' && /^mqa_[A-Za-z0-9_-]{43}$/.test(value);
}

/** Whether an attempt token has been tombstoned by cancelSearch. Fail-closed for
 *  the poll path: a store error (other than the tombstone table not existing
 *  yet — a migration-lag posture where the pre-tombstone behavior applies)
 *  throws rather than silently resurrecting a cancelled attempt. */
async function isSearchTombstoned(searchToken: string): Promise<boolean> {
	const admin = getAdmin();
	if (!admin) return false;
	const res = await admin
		.from(CANCELLATIONS_TABLE)
		.select('search_token')
		.eq('search_token', searchToken)
		.maybeSingle();
	if (res.error) {
		if (isMissingTableError(res.error)) {
			console.error(
				'[matchmaking] match_search_cancellations missing (apply 20260710_identity_trust.sql); ' +
					'attempt-cancel tombstones disabled until then.'
			);
			return false;
		}
		throw new Error(`Tombstone lookup failed: ${res.error.message}`);
	}
	return res.data != null;
}

function isMissingTableError(error: { code?: string; message?: string }): boolean {
	return (
		error.code === '42P01' ||
		/relation .* does not exist|could not find the table/i.test(error.message ?? '')
	);
}

/** Resolve a user's current queue status into a client poll result. */
export async function resolveQueueStatus(
	userId: string,
	clientToken: string | null = null
): Promise<QueuePollResult> {
	const admin = getAdmin();
	if (!admin) return { status: 'searching', queued: 0, needed: RANKED_LOBBY_SIZE, players: [] };

	// Best-effort: clear out any bots lingering in an empty (human-less) queue, and any
	// long-stale 'matched' rows that already handed off to a session, before we report
	// status — so the counts the client sees stay honest and the queue table stays lean.
	await reapQueuedBots();
	await reapStaleQueueRows();

	const [me, countRes, listRes] = await Promise.all([
		admin
			.from(QUEUE_TABLE)
			.select('status, claimed_session_id, search_token')
			.eq('user_id', userId)
			.maybeSingle(),
		admin.from(QUEUE_TABLE).select('user_id', { count: 'exact', head: true }).eq('status', 'queued'),
		admin
			.from(QUEUE_TABLE)
			.select('user_id, display_name, is_bot')
			.eq('status', 'queued')
			.order('queued_at', { ascending: true })
			.limit(12)
	]);

	const queued = countRes.count ?? 0;
	const players: QueuedPlayer[] = (
		(listRes.data as { user_id: string; display_name: string | null; is_bot?: boolean | null }[] | null) ?? []
	).map((r) => ({
		userId: r.user_id,
		displayName: r.display_name ?? 'Player',
		you: r.user_id === userId,
		isBot: r.is_bot === true
	}));
	// The caller's own cancel handle (owner-only; every other row's token stays
	// server-side). Present while the row is live — queued, matched, OR held out
	// in recovery — so the initiating principal can retire it in any of them.
	// NEVER AN OLD TOKEN AS THE CALLER'S OWN: when the caller identified its
	// attempt (clientToken), the row's token is echoed ONLY if it IS that
	// attempt's token (adoption normally guarantees this; if adoption lost a
	// race, omitting the echo is honest — the client falls back to its own
	// attempt token, and a mismatched previous-attempt handle is never dressed
	// up as this attempt's cancel capability). Legacy attempt-less callers keep
	// the server-minted-handle echo.
	const rowToken =
		typeof me.data?.search_token === 'string' &&
		(me.data?.status === 'queued' ||
			me.data?.status === 'matched' ||
			me.data?.status === RECOVERING_STATUS)
			? (me.data.search_token as string)
			: undefined;
	const searchId = clientToken == null || rowToken === clientToken ? rowToken : undefined;
	const base = { queued, needed: RANKED_LOBBY_SIZE, players, searchId } as const;

	if (me.data?.status === 'matched' && me.data?.claimed_session_id != null) {
		const sessionId = me.data.claimed_session_id as string;
		// Resolve the room code + this user's member id in the matched session. The
		// member id is the public seat label; the account itself (already validated by
		// the endpoint) is what authorizes every later room request.
		const [sess, mem] = await Promise.all([
			admin.from(SESSIONS_TABLE).select('room_code, mode, ranked_season_id').eq('id', sessionId).maybeSingle(),
			admin
				.from(MEMBERS_TABLE)
				.select('id')
				.eq('session_id', sessionId)
				.eq('user_id', userId)
				.maybeSingle()
		]);
		const sessRow = sess.data as { room_code?: string; mode?: string; ranked_season_id?: string | null } | null;
		const roomCode = sessRow?.room_code;
		const memberId = (mem.data as { id?: string } | null)?.id;
		const mode = sessRow?.mode === 'ranked' ? ('ranked' as const) : ('casual' as const);
		if (roomCode) {
			return { status: 'matched', roomCode, memberId, mode, rated: mode === 'ranked',
				seasonId: sessRow?.ranked_season_id ?? null, ...base };
		}
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

	// This human just left — if they were the last one, reap any queued bots so they don't
	// linger in an empty queue. Best-effort (never throws).
	await reapQueuedBots();
}

/** 32 random bytes, base64url — the unguessable per-search cancel capability. */
function mintSearchToken(): string {
	return `mqs_${randomBytes(32).toString('base64url')}`;
}

/** Outcome of a handle-bound search retirement (see {@link cancelSearch}). */
export type CancelSearchOutcome = 'cancelled' | 'retired_after_match' | 'not_found';

/**
 * Retire a search by its SERVER HANDLE — the initiating-principal-bound cancel
 * contract for Quick Play. A durable account transition leaves the browser
 * authenticated as a NEW uid, so the plain uid-bound {@link leaveQueue} can no
 * longer reach the OLD uid's queue row; possession of the unguessable handle
 * (returned only in the authenticated queue responses of the row's owner) is the
 * proof of initiation instead. No superseded account token is retained or
 * replayed anywhere — the handle authorizes exactly one row's retirement, and
 * can NEVER cancel any other search (every statement is keyed on the handle).
 *
 *   - Row still QUEUED → cancelled (exactly that row; nobody else's), so the old
 *     generation can never form a match.
 *   - Formation MID-hand-off (row 'matched', session not stamped yet) → the
 *     cancel races the conditional stamp for the row and exactly one wins:
 *     winning cancels the search (formation's short-stamped hand-off retires the
 *     seat it created); losing falls through to the formed path below.
 *   - Formation WON the race (row 'matched' with a claimed session) → the
 *     initiating uid's just-formed seat is retired with a coherent authoritative
 *     outcome (bot conversion; room CLOSED when no human member remains — see
 *     retireFormedMembership), and only then is the queue row cancelled so later
 *     polls can never resolve the dead room. FAIL-CLOSED: any store error throws
 *     with the row still 'matched', so a retry re-enters this path — a ghost
 *     seat is never stranded behind an already-cancelled row.
 *   - Unknown/expired handle → 'not_found' (idempotent; a replayed cancel of an
 *     already-cancelled search lands here too).
 */
export async function cancelSearch(searchToken: string): Promise<CancelSearchOutcome> {
	const admin = getAdmin();
	if (!admin || typeof searchToken !== 'string' || searchToken.length === 0) return 'not_found';

	// 0) TOMBSTONE FIRST — before any row is touched. A cancel can race AHEAD of
	//    its own attempt's first enqueue (the queue row does not exist yet); the
	//    tombstone makes the cancel win regardless of arrival order, because the
	//    late enqueue re-checks it AFTER writing its row and self-cancels. Bound
	//    to exactly this token: it can never affect a newer attempt (which holds
	//    a different token). Idempotent (upsert); reaped after TOMBSTONE_TTL_MS.
	//    Fail-closed: if the tombstone cannot be recorded the cancel THROWS (the
	//    caller retries) rather than reporting a cancellation that a late enqueue
	//    could silently undo. A store that predates the tombstone table keeps the
	//    pre-tombstone behavior (migration-lag posture, loudly logged).
	const tombstone = await admin
		.from(CANCELLATIONS_TABLE)
		.upsert(
			{ search_token: searchToken, cancelled_at: new Date().toISOString() },
			{ onConflict: 'search_token' }
		);
	if (tombstone.error) {
		if (isMissingTableError(tombstone.error)) {
			console.error(
				'[matchmaking] match_search_cancellations missing (apply 20260710_identity_trust.sql); ' +
					'cancelling without a tombstone.'
			);
		} else {
			throw new Error(`Search cancel failed: ${tombstone.error.message}`);
		}
	}

	// 1) Still searching: cancel exactly the handle's row. The conditional UPDATE
	//    races formation safely — if try_form_ranked_match claimed the row first,
	//    zero rows match here and we fall through to the retirement path.
	const cancelled = await admin
		.from(QUEUE_TABLE)
		.update({ status: 'cancelled', updated_at: new Date().toISOString() })
		.eq('search_token', searchToken)
		.eq('status', 'queued')
		.select('user_id');
	if (cancelled.error) throw new Error(`Search cancel failed: ${cancelled.error.message}`);
	if ((cancelled.data?.length ?? 0) > 0) {
		await reapQueuedBots();
		return 'cancelled';
	}

	// 2) Formation claimed the row. Look at where the hand-off stands.
	const row = await admin
		.from(QUEUE_TABLE)
		.select('user_id, status, claimed_session_id')
		.eq('search_token', searchToken)
		.maybeSingle();
	if (row.error) throw new Error(`Search lookup failed: ${row.error.message}`);
	let data = row.data as
		| { user_id: string; status: string; claimed_session_id: string | null }
		| null;
	if (data && data.status === RECOVERING_STATUS) {
		// A held-out claim (partial room not yet confirmed closed): the cancel
		// must not strand it — close the doomed room first (FAIL-CLOSED: a store
		// error throws with the row still recovering, so a retry re-enters), then
		// cancel the row.
		if (data.claimed_session_id) await closeFormedSession(data.claimed_session_id);
		const done = await admin
			.from(QUEUE_TABLE)
			.update({ status: 'cancelled', updated_at: new Date().toISOString() })
			.eq('search_token', searchToken)
			.eq('status', RECOVERING_STATUS);
		if (done.error) throw new Error(`Search cancel failed: ${done.error.message}`);
		await reapQueuedBots();
		return 'cancelled';
	}
	if (!data || data.status !== 'matched') {
		return 'not_found';
	}

	if (!data.claimed_session_id) {
		// MID-FORMATION: race the conditional stamp for this row — exactly one
		// winner. Winning here cancels the search outright; formation's stamp then
		// comes up short for this uid and retires the seat it created. Losing
		// means the stamp landed: re-read and retire through the formed path.
		const won = await admin
			.from(QUEUE_TABLE)
			.update({ status: 'cancelled', updated_at: new Date().toISOString() })
			.eq('search_token', searchToken)
			.eq('status', 'matched')
			.is('claimed_session_id', null)
			.select('user_id');
		if (won.error) throw new Error(`Search cancel failed: ${won.error.message}`);
		if ((won.data?.length ?? 0) > 0) {
			await reapQueuedBots();
			return 'cancelled';
		}
		const reread = await admin
			.from(QUEUE_TABLE)
			.select('user_id, status, claimed_session_id')
			.eq('search_token', searchToken)
			.maybeSingle();
		if (reread.error) throw new Error(`Search lookup failed: ${reread.error.message}`);
		data = reread.data as
			| { user_id: string; status: string; claimed_session_id: string | null }
			| null;
		if (!data || data.status !== 'matched' || !data.claimed_session_id) {
			return 'not_found';
		}
	}

	// 3) FORMED: retire the authoritative seat FIRST (idempotent, fail-closed).
	//    Ordering matters for recoverability: if anything below throws, the queue
	//    row is still 'matched' and a retried cancel re-enters this exact path.
	await retireFormedMembership(data.claimed_session_id, data.user_id);

	// 4) Only after the authoritative outcome is durable: cancel the row so a
	//    later poll can never resolve the dead room for the retired search.
	const done = await admin
		.from(QUEUE_TABLE)
		.update({ status: 'cancelled', updated_at: new Date().toISOString() })
		.eq('search_token', searchToken)
		.eq('status', 'matched');
	if (done.error) throw new Error(`Search cancel failed: ${done.error.message}`);
	await reapQueuedBots();
	return 'retired_after_match';
}

/**
 * Retire the just-formed membership of `userId` in `sessionId` with a COHERENT
 * authoritative outcome. The matchmade game is already STARTED when this runs,
 * so deleting the relational row alone would leave the claimed seat in game
 * state with no authorized actor — a ghost blocking every remaining player:
 *
 *   - The HUMAN membership is converted into a DISCLOSED BOT (user_id null,
 *     is_bot true, default bot profile): the seat keeps a server-driven actor,
 *     the public member id survives for any state/ledger reference, and the
 *     remaining humans' game keeps working.
 *   - When NO human member remains the room is a bot shell — it is closed (CAS
 *     on revision) instead of aging out as an abandoned match.
 *
 * Idempotent (an already-converted or absent membership is a no-op) and
 * FAIL-CLOSED: every store error THROWS — callers must never report a
 * retirement that did not durably happen.
 */
async function retireFormedMembership(sessionId: string, userId: string): Promise<void> {
	const admin = getAdmin();
	if (!admin) throw new Error('Matchmaking is unavailable (no service-role key).');

	const converted = await admin
		.from(MEMBERS_TABLE)
		.update({ user_id: null, is_bot: true, bot_profile: DEFAULT_BOT_PROFILE_KEY })
		.eq('session_id', sessionId)
		.eq('user_id', userId)
		.eq('is_bot', false)
		.select('id');
	if (converted.error) {
		throw new Error(`Failed to retire formed membership: ${converted.error.message}`);
	}

	// VERIFY the write result against authoritative state — never infer a
	// retirement from an error-free call alone. Zero converted rows is fine ONLY
	// when no human membership actually remains (idempotent re-entry / the row
	// never existed); a human row still present here means the conversion was
	// silently lost and reporting success would hand off a ghost seat.
	const residual = await admin
		.from(MEMBERS_TABLE)
		.select('id', { count: 'exact', head: true })
		.eq('session_id', sessionId)
		.eq('user_id', userId)
		.eq('is_bot', false);
	if (residual.error) {
		throw new Error(`Failed to verify membership retirement: ${residual.error.message}`);
	}
	if ((residual.count ?? 0) > 0) {
		throw new Error(
			`Membership retirement did not take effect for ${userId} in ${sessionId} ` +
				`(${residual.count} human row(s) remain).`
		);
	}

	const humans = await admin
		.from(MEMBERS_TABLE)
		.select('id', { count: 'exact', head: true })
		.eq('session_id', sessionId)
		.eq('is_bot', false);
	if (humans.error) {
		throw new Error(`Failed to count remaining humans: ${humans.error.message}`);
	}
	if ((humans.count ?? 0) > 0) return;
	await closeFormedSession(sessionId);
}

/** Close a formed session (CAS on revision) — used when a retirement leaves a
 *  bot-only shell, when a formation could not be stamped at all, or when a
 *  recovering claim retries its close. The CAS VERIFIES the affected-row count:
 *  a zero-row outcome is a LOST race, not success — the row is reloaded and the
 *  close retried against the fresh revision (an already-closed reload counts as
 *  done). Exhausting the retries throws: reporting an unconfirmed close would
 *  let callers release queue claims while the room is still live. FAIL-CLOSED:
 *  store errors throw. */
async function closeFormedSession(sessionId: string): Promise<void> {
	const admin = getAdmin();
	if (!admin) throw new Error('Matchmaking is unavailable (no service-role key).');
	const MAX_ATTEMPTS = 3;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const sess = await admin
			.from(SESSIONS_TABLE)
			.select('revision, public_state, status')
			.eq('id', sessionId)
			.maybeSingle();
		if (sess.error) throw new Error(`Failed to load session for close: ${sess.error.message}`);
		const sessRow = sess.data as
			| { revision: number; public_state: Record<string, unknown> | null; status: string }
			| null;
		if (!sessRow || sessRow.status === 'closed') return;
		const nextRevision = (sessRow.revision ?? 0) + 1;
		const publicState = {
			...(sessRow.public_state ?? {}),
			status: 'closed',
			revision: nextRevision
		};
		const closed = await admin
			.from(SESSIONS_TABLE)
			.update({
				status: 'closed',
				ended_at: new Date().toISOString(),
				revision: nextRevision,
				public_state: publicState
			})
			.eq('id', sessionId)
			.eq('revision', sessRow.revision)
			.select('id');
		if (closed.error) throw new Error(`Failed to close abandoned room: ${closed.error.message}`);
		// ZERO-ROW CAS LOSS IS NOT SUCCESS: a concurrent command advanced the
		// revision between the read and this write. Reload and re-close — the
		// room must end up durably closed (or be SEEN closed) before we return.
		if (((closed.data as { id: string }[] | null) ?? []).length > 0) return;
	}
	throw new Error(
		`Failed to close room ${sessionId}: revision CAS lost ${MAX_ATTEMPTS} times (still open).`
	);
}
