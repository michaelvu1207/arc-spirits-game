/**
 * Room lifecycle policy — the PURE decision half of "is this room still alive?".
 *
 * A game room shouldn't linger forever. The server boundary (`server/service.ts`)
 * calls into these helpers to decide when to close one, mirroring the host-
 * INDEPENDENT, opportunistic pattern used for phase-deadline enforcement: the clock
 * is read at the boundary, the decision itself stays pure (and unit-testable) here.
 *
 * Close conditions, by status:
 *  - `lobby` → `expired`:   the lobby has existed for ≥ {@link LOBBY_MAX_AGE_MS} and
 *                           was never started. Unconditional — even an actively-
 *                           watched lobby is closed once it ages out.
 *  - `lobby` → `abandoned`: no *human* member seen within {@link LOBBY_PRESENCE_WINDOW_MS}.
 *  - `active` → `abandoned`: no *human* member seen within {@link ACTIVE_PRESENCE_WINDOW_MS}
 *                            (a longer grace — a real game shouldn't die on a brief
 *                            all-disconnect, but an abandoned one must not linger as
 *                            "live" forever, since no winner ⇒ it never finishes).
 *  - `finished` / `closed`: terminal — never reconsidered.
 *
 * Bots never keep a room alive: they are real member rows but never poll, so they're
 * excluded from the presence check (see {@link humanLastSeen}).
 */

/**
 * Display-name prefix every bot carries (see `server/botSim.ts`, which re-exports
 * this). Bots are real `session_members` rows but never poll, so their
 * `last_seen_at` is frozen at creation — they must be excluded from the presence
 * check or a bot-only room would look "active" forever.
 */
export const BOT_NAME_PREFIX = '🤖 ';

/** A lobby auto-closes this long after creation if the game never started (30 min). */
export const LOBBY_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * A member counts as "present" in a LOBBY only if seen within this window. The SSE
 * poll bumps `last_seen_at` every ~1s while a client is connected, so a member who
 * closes their tab goes stale within seconds. The window is generous enough to ride
 * out the stream's 30s renewal and reconnect/backoff gaps (≤15s) without flapping.
 */
export const LOBBY_PRESENCE_WINDOW_MS = 60_000;

/**
 * Presence window for an ACTIVE game — longer than the lobby window so a real match
 * survives a transient all-disconnect (e.g. everyone refreshing, a shared-network
 * blip) but an abandoned game (everyone left) is still cancelled within a couple of
 * minutes instead of lingering as a "live" room forever.
 */
export const ACTIVE_PRESENCE_WINDOW_MS = 120_000;

export type RoomStatus = 'lobby' | 'active' | 'finished' | 'closed';
export type RoomCloseReason = 'expired' | 'abandoned' | 'security_upgrade';

/** The minimal liveness facts about a session needed to judge whether it's alive. */
export interface RoomLiveness {
	status: RoomStatus;
	/** Epoch ms the session row was created. */
	createdAtMs: number;
	/** Epoch ms the game started, or null if it never started. */
	startedAtMs: number | null;
	/** `last_seen_at` (epoch ms) for every NON-bot member of the session. */
	humanLastSeenMs: number[];
	/**
	 * True when the room contains a HUMAN membership with no owning account
	 * (`user_id IS NULL`, `is_bot = false`). Such memberships predate the
	 * account-identity trust model and have NO safe claim path — a UUID or display
	 * name can never prove ownership — so the room is closed for security upgrade
	 * rather than letting anyone impersonate the legacy member.
	 */
	hasUnownedHumans?: boolean;
}

/** True if any human was seen within `windowMs` of now. */
function hasPresentHuman(humanLastSeenMs: number[], nowMs: number, windowMs: number): boolean {
	const cutoff = nowMs - windowMs;
	return humanLastSeenMs.some((seenMs) => seenMs >= cutoff);
}

/**
 * Why this room should be closed, or `null` if it should stay open. Lobbies close on
 * age (`expired`) or absence (`abandoned`); active games close only on absence;
 * `finished`/`closed` are terminal (always `null`).
 */
export function roomCloseReason(input: RoomLiveness, nowMs: number): RoomCloseReason | null {
	// Legacy unowned human memberships cannot be re-authenticated under the account
	// trust model; quarantine the room explicitly instead of impersonating.
	if ((input.status === 'lobby' || input.status === 'active') && input.hasUnownedHumans) {
		return 'security_upgrade';
	}
	if (input.status === 'lobby') {
		// A started session is `active`, not `lobby` — guard defensively anyway.
		if (input.startedAtMs != null) return null;
		if (nowMs - input.createdAtMs >= LOBBY_MAX_AGE_MS) return 'expired';
		return hasPresentHuman(input.humanLastSeenMs, nowMs, LOBBY_PRESENCE_WINDOW_MS)
			? null
			: 'abandoned';
	}
	if (input.status === 'active') {
		return hasPresentHuman(input.humanLastSeenMs, nowMs, ACTIVE_PRESENCE_WINDOW_MS)
			? null
			: 'abandoned';
	}
	return null;
}

/** True when a room is still joinable/listable. Inverse of {@link roomCloseReason}. */
export function isRoomOpen(input: RoomLiveness, nowMs: number): boolean {
	return roomCloseReason(input, nowMs) === null;
}

/**
 * Project member rows to the human-only `last_seen_at` timestamps (epoch ms) that
 * {@link roomCloseReason} consumes, dropping bots. A bot is identified by the explicit
 * `isBot` flag (the `is_bot` column — authoritative, and the only way to detect a
 * human-NAMED matchmaking bot), with the legacy {@link BOT_NAME_PREFIX} kept as a
 * fallback so a row that predates the column (no `isBot`) is still excluded.
 */
export function humanLastSeen(
	members: { displayName: string | null | undefined; lastSeenAtMs: number; isBot?: boolean }[]
): number[] {
	return members
		.filter((m) => !(m.isBot === true || (m.displayName ?? '').startsWith(BOT_NAME_PREFIX)))
		.map((m) => m.lastSeenAtMs);
}
