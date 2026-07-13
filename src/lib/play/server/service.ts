import { error as kitError } from '@sveltejs/kit';
import {
	createLobbyState,
	applyGameCommand,
	deadlineBlockingSeats,
	refreshActiveChoiceDeadline,
	resolvePassedDeadline,
	buildHistorySnapshotRows,
	buildSessionProjection
} from '../runtime';
import { enterBenefits, enterAwakening } from '../phases';
import { WILDCARD_MAT_IDS } from '../awakenConditions';
import { AWAKEN_PROGRESS_KEYS } from '../effects/awakenHandlers';
import { nextId } from '../rng';
import type {
	CommandResult,
	GameActor,
	GameCommand,
	GameSessionStatus,
	MemberRole,
	NormalizedAwaken,
	PlayCatalog,
	PlayCatalogSpirit,
	PrivatePlayerState,
	PublicGameState,
	RoomChatMessage,
	RoomSummary,
	SeatColor,
	SpectatorProjection
} from '../types';
import type { MatSlotSnapshot } from '$lib/types';
import { SEAT_COLORS, phaseDurationMs } from '../types';
import {
	roomCloseReason,
	isRoomOpen,
	humanLastSeen,
	type RoomCloseReason,
	type RoomLiveness
} from '../roomLifecycle';
import { DEFAULT_BOT_PROFILE_KEY } from '../bots/contract';
import { loadPlayCatalog } from './catalog';
import { getSupabaseAdmin } from '$lib/server/supabaseAdmin';
import { finalizeMatch } from './ranked';

const HISTORY_SCHEMA = 'arc_spirits_game';
// The live 2D engine session tables live in their own schema; everything else
// (snapshots, replay codes, verified/stats tables) stays in HISTORY_SCHEMA.
const PLAY_SCHEMA = 'arc_spirits_2d';
const PLAY_TABLES = {
	SESSIONS: 'play_game_sessions',
	MEMBERS: 'play_session_members',
	EVENTS: 'play_game_session_events',
	MESSAGES: 'play_session_messages'
} as const;
const HISTORY_TABLES = {
	SNAPSHOTS: 'game_state_snapshots',
	REPLAY_CODES: 'replay_codes'
} as const;

export type PlayMode = 'casual' | 'ranked';

export type PlaySessionRow = {
	id: string;
	room_code: string;
	game_id: string | null;
	status: GameSessionStatus;
	revision: number;
	scenario: PublicGameState['scenario'];
	public_state: PublicGameState | string | null;
	mode: PlayMode;
	created_at: string;
	started_at: string | null;
	ended_at: string | null;
};

type SessionMemberRow = {
	id: string;
	session_id: string;
	display_name: string;
	role: MemberRole;
	seat_color: SeatColor | null;
	selected_guardian: string | null;
	private_state: Record<string, unknown> | string | null;
	created_at: string;
	joined_at: string;
	updated_at: string;
	last_seen_at: string;
	user_id: string | null;
	is_bot: boolean;
	bot_profile: string | null;
};

type SessionMessageRow = {
	id: string;
	session_id: string;
	member_id: string | null;
	author_display_name: string;
	author_role: MemberRole;
	seat_color: SeatColor | null;
	kind: RoomChatMessage['kind'];
	body: string;
	created_at: string;
};

export interface RoomView {
	projection: SpectatorProjection;
	member: {
		id: string | null;
		role: MemberRole;
		seatColor: SeatColor | null;
		displayName: string | null;
	};
}

function parseJsonValue<T>(value: T | string | null | undefined, fallback: T): T {
	if (value == null) return fallback;
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function getPlayAdmin() {
	const client = getSupabaseAdmin(PLAY_SCHEMA);
	if (!client) {
		throw kitError(500, 'Missing SUPABASE_SERVICE_ROLE_KEY on the server.');
	}
	return client;
}

function getHistoryAdmin() {
	const client = getSupabaseAdmin(HISTORY_SCHEMA);
	if (!client) {
		throw kitError(500, 'Missing SUPABASE_SERVICE_ROLE_KEY on the server.');
	}
	return client;
}

function normalizeRoomCode(roomCode: string): string {
	return roomCode.trim().toUpperCase();
}

function normalizeDisplayName(displayName: string | null | undefined): string {
	const trimmed = (displayName ?? '').trim();
	return trimmed.length > 0 ? trimmed.slice(0, 40) : 'Anonymous Spectator';
}

function createRoomCode(): string {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let code = '';
	for (let i = 0; i < 6; i += 1) {
		code += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return code;
}

function asState(row: PlaySessionRow): PublicGameState {
	return parseJsonValue(
		row.public_state,
		createLobbyState({ roomCode: row.room_code, guardianNames: [] })
	);
}

async function getSessionByRoomCode(roomCode: string): Promise<PlaySessionRow | null> {
	const { data, error } = await getPlayAdmin()
		.from(PLAY_TABLES.SESSIONS)
		.select('*')
		.eq('room_code', normalizeRoomCode(roomCode))
		.maybeSingle();

	if (error) {
		throw kitError(500, `Failed to load session: ${error.message}`);
	}

	return (data as PlaySessionRow | null) ?? null;
}

/** The play mode ('casual' | 'ranked') of a room, or null if the room doesn't exist. */
export async function getSessionModeByRoomCode(roomCode: string): Promise<PlayMode | null> {
	const session = await getSessionByRoomCode(normalizeRoomCode(roomCode));
	return session?.mode ?? null;
}

/** The session id (uuid) for a room, or null if the room doesn't exist. Exposed so the
 *  bot driver can key its per-session bot-member lookup off the room code it already holds. */
export async function getSessionIdByRoomCode(roomCode: string): Promise<string | null> {
	const session = await getSessionByRoomCode(normalizeRoomCode(roomCode));
	return session?.id ?? null;
}

/**
 * The bot members of a session, keyed by member id → shared bot contract policy key
 * (the `bot_profile` column, or null). The authoritative source of bot-ness for the live
 * driving path: `PublicGameState.seats` only carries memberId + displayName, so botSim
 * loads this map to tell which seated members are bots and which strategy drives each —
 * replacing the legacy 🤖-display-name parse. Empty map when no service-role key.
 */
export async function loadBotMembers(sessionId: string): Promise<Map<string, string | null>> {
	const admin = getSupabaseAdmin(PLAY_SCHEMA);
	if (!admin) return new Map();
	const { data, error } = await admin
		.from(PLAY_TABLES.MEMBERS)
		.select('id, bot_profile')
		.eq('session_id', sessionId)
		.eq('is_bot', true);
	if (error) {
		throw kitError(500, `Failed to load bot members: ${error.message}`);
	}
	const out = new Map<string, string | null>();
	for (const row of (data as { id: string; bot_profile: string | null }[] | null) ?? []) {
		out.set(row.id, row.bot_profile ?? null);
	}
	return out;
}

async function attachBotSeatFlags(
	sessionId: string,
	projection: SpectatorProjection
): Promise<SpectatorProjection> {
	const botMembers = await loadBotMembers(sessionId);
	for (const seat of SEAT_COLORS) {
		const memberId = projection.seats[seat]?.memberId;
		projection.seats[seat].isBot = memberId != null && botMembers.has(memberId);
	}
	return projection;
}

async function getMembersForSession(sessionId: string): Promise<SessionMemberRow[]> {
	const { data, error } = await getPlayAdmin()
		.from(PLAY_TABLES.MEMBERS)
		.select('*')
		.eq('session_id', sessionId)
		.order('joined_at', { ascending: true });

	if (error) {
		throw kitError(500, `Failed to load session members: ${error.message}`);
	}

	return (data as SessionMemberRow[] | null) ?? [];
}

async function getMemberById(memberId: string): Promise<SessionMemberRow | null> {
	const { data, error } = await getPlayAdmin()
		.from(PLAY_TABLES.MEMBERS)
		.select('*')
		.eq('id', memberId)
		.maybeSingle();
	if (error) {
		throw kitError(500, `Failed to load session member: ${error.message}`);
	}
	return (data as SessionMemberRow | null) ?? null;
}

/**
 * Resolve a session member by (session, authenticated user). Used as the fallback
 * identity for matchmade players who arrive at /play/<roomCode> with no room-member
 * cookie / member id but a valid auth session — their membership was created
 * server-side by the matchmaker, keyed only by user_id.
 */
async function getMemberBySessionAndUser(
	sessionId: string,
	userId: string
): Promise<SessionMemberRow | null> {
	const { data, error } = await getPlayAdmin()
		.from(PLAY_TABLES.MEMBERS)
		.select('*')
		.eq('session_id', sessionId)
		.eq('user_id', userId)
		.maybeSingle();
	if (error) {
		throw kitError(500, `Failed to resolve member by user: ${error.message}`);
	}
	return (data as SessionMemberRow | null) ?? null;
}

async function resolveMemberForSession(
	session: PlaySessionRow,
	memberId: string | null | undefined,
	fallbackUserId?: string | null
): Promise<SessionMemberRow | null> {
	const rawMember = memberId ? await getMemberById(memberId) : null;
	let member = rawMember && rawMember.session_id === session.id ? rawMember : null;
	if (!member && fallbackUserId) {
		member = await getMemberBySessionAndUser(session.id, fallbackUserId);
	}
	return member;
}

function viewerForMember(
	state: PublicGameState,
	member: SessionMemberRow | null
): SpectatorProjection['viewer'] {
	if (!member) {
		return {
			role: 'spectator',
			seatColor: null,
			displayName: null
		};
	}

	const seatColor =
		SEAT_COLORS.find((candidate) => state.seats[candidate].memberId === member.id) ??
		member.seat_color ??
		null;

	return {
		role: member.role,
		seatColor,
		displayName: member.display_name
	};
}

function actorForMember(state: PublicGameState, member: SessionMemberRow): GameActor {
	const viewer = viewerForMember(state, member);
	return {
		memberId: member.id,
		displayName: member.display_name,
		role: member.role,
		seatColor: viewer.seatColor
	};
}

async function updateLastSeen(memberId: string) {
	await getPlayAdmin()
		.from(PLAY_TABLES.MEMBERS)
		.update({ last_seen_at: new Date().toISOString() })
		.eq('id', memberId);
}

async function syncMemberMirrors(sessionId: string, state: PublicGameState) {
	const members = await getMembersForSession(sessionId);

	// Run the per-member mirror writes CONCURRENTLY — they touch independent rows, so
	// serializing them (the old `for await` loop) added one DB round-trip per member to
	// every command's latency, which is painful for cross-region players. A single
	// rejection still surfaces as a 500 below.
	const results = await Promise.all(
		members.map((member) => {
			const occupiedSeat =
				SEAT_COLORS.find((seatColor) => state.seats[seatColor].memberId === member.id) ?? null;
			const selectedGuardian = occupiedSeat
				? (state.seats[occupiedSeat].selectedGuardian ?? null)
				: null;
			const role: MemberRole =
				member.role === 'host' ? 'host' : occupiedSeat ? 'player' : 'spectator';

			// NOTE: do NOT touch last_seen_at here. It must reflect only THIS member's own
			// activity (their /view poll in loadRoomView / their own command), so that a stale
			// last_seen_at is a reliable "this member has disconnected" signal. Bumping it
			// for every member on every command (the old behavior) made it useless.
			return getPlayAdmin()
				.from(PLAY_TABLES.MEMBERS)
				.update({ seat_color: occupiedSeat, selected_guardian: selectedGuardian, role })
				.eq('id', member.id);
		})
	);

	const failed = results.find((result) => result.error);
	if (failed?.error) {
		throw kitError(500, `Failed to update member mirror: ${failed.error.message}`);
	}
}

async function ensureReplayCode(gameId: string, navigationCount: number) {
	const historyAdmin = getHistoryAdmin();
	const existing = await historyAdmin
		.from(HISTORY_TABLES.REPLAY_CODES)
		.select('code')
		.eq('game_id', gameId)
		.eq('navigation_count', navigationCount)
		.maybeSingle();

	if (existing.error) {
		throw kitError(500, `Failed to load replay code: ${existing.error.message}`);
	}
	if (existing.data?.code) {
		return existing.data.code as string;
	}

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
	}

	throw kitError(500, 'Failed to create replay code.');
}

async function writeHistorySnapshots(state: PublicGameState, timestamp: string) {
	if (!state.gameId) return;

	const rows = buildHistorySnapshotRows(state, timestamp);
	if (rows.length === 0) return;

	const { error } = await getHistoryAdmin()
		.from(HISTORY_TABLES.SNAPSHOTS)
		.upsert(rows, { onConflict: 'game_id,navigation_count,player_color' });

	if (error) {
		throw kitError(500, `Failed to write history snapshots: ${error.message}`);
	}

	await ensureReplayCode(state.gameId, state.round);
}

async function persistSessionUpdate(params: {
	session: PlaySessionRow;
	nextState: PublicGameState;
	actorMemberId: string | null;
	command: GameCommand;
}) {
	const now = new Date().toISOString();
	const { session, nextState, actorMemberId, command } = params;
	const updatePayload: Record<string, unknown> = {
		status: nextState.status,
		revision: nextState.revision,
		game_id: nextState.gameId,
		scenario: nextState.scenario,
		public_state: nextState
	};

	if (session.started_at == null && nextState.status === 'active') {
		updatePayload.started_at = now;
	}
	// The finished-transition fires exactly once: when we first stamp ended_at.
	const isFinishedTransition = nextState.status === 'finished' && session.ended_at == null;
	if (isFinishedTransition) {
		updatePayload.ended_at = now;
	}

	const { data, error } = await getPlayAdmin()
		.from(PLAY_TABLES.SESSIONS)
		.update(updatePayload)
		.eq('id', session.id)
		.eq('revision', session.revision)
		.select('*')
		.maybeSingle();

	if (error) {
		throw kitError(500, `Failed to persist session: ${error.message}`);
	}
	if (!data) {
		// Compare-and-set miss: another write landed between our load and update.
		// Signal the caller to reload fresh state and re-apply the command.
		return null;
	}

	// The audit/replay event-log insert and the member-mirror sync touch different
	// tables and neither feeds the projection we return, so run them CONCURRENTLY
	// instead of back-to-back — collapsing two sequential round-trips into one.
	const [eventInsert] = await Promise.all([
		getPlayAdmin().from(PLAY_TABLES.EVENTS).insert({
			session_id: session.id,
			revision: nextState.revision,
			actor_member_id: actorMemberId,
			command_type: command.type,
			command_payload: command
		}),
		syncMemberMirrors(session.id, nextState)
	]);
	if (eventInsert.error) {
		throw kitError(500, `Failed to append room event: ${eventInsert.error.message}`);
	}

	// On the transition into `finished`, record the match result + ratings exactly
	// once. Best-effort: finalizeMatch is idempotent and never throws, but we still
	// guard here so a ratings failure can never break the game-state persist.
	if (isFinishedTransition) {
		try {
			await finalizeMatch(data as PlaySessionRow, nextState);
		} catch (err) {
			console.error('[ranked] finalizeMatch threw (swallowed):', err);
		}
	}

	return data as PlaySessionRow;
}

/** Synthetic command recorded in the events log when the server force-advances a phase. */
const ENFORCE_DEADLINE_COMMAND = { type: 'enforceDeadline' } as unknown as GameCommand;

/**
 * Server boundary: stamp the wall-clock deadline for the CURRENT phase if it isn't
 * already set. The pure reducer nulls phaseDeadline on every phase entry, so this
 * re-stamps the freshly-entered (final) phase after a command resolves; an in-phase
 * action (deadline still set) is left untouched. Uses the SERVER clock only — a
 * client's echoed value is never trusted for enforcement. Mirrors navigationDeadline
 * so the existing navigation countdown UI keeps working.
 */
function stampPhaseDeadline(state: PublicGameState): void {
	if (state.status !== 'active') {
		state.phaseDeadline = null;
		return;
	}
	if (state.phase === 'navigation' && !state.revealedDestinations) {
		// Navigation uses the host-configured timer. `null` = no limit: no time-based
		// deadline at all — the round advances only once every seat locks (the all-locked
		// grace in applyNavLockDeadline sets a short deadline at that point).
		const dur = state.navigationDurationMs;
		if (dur == null) {
			state.phaseDeadline = null;
			state.navigationDeadline = null;
			state.navigationFullDeadline = null;
			return;
		}
		if (state.phaseDeadline == null) state.phaseDeadline = Date.now() + dur;
		state.navigationDeadline ??= state.phaseDeadline;
		state.navigationFullDeadline ??= state.navigationDeadline;
		return;
	}
	if (state.phaseDeadline == null) {
		state.phaseDeadline = Date.now() + phaseDurationMs(state.phase);
	}
}

/** When every active seat is locked, collapse the navigation deadline to a short final
 *  grace so the round doesn't idle — while still leaving a window to back out. A seat
 *  unlocking (or someone still picking) restores the original full deadline. Server-clock
 *  only; navigationFullDeadline (stamped above) remembers the un-shortened deadline. */
const NAV_GRACE_MS = 5000;
function applyNavLockDeadline(state: PublicGameState): void {
	if (state.status !== 'active' || state.phase !== 'navigation' || state.revealedDestinations)
		return;
	const seats = state.activeSeats;
	const allLocked = seats.length > 0 && seats.every((s) => state.navigation[s]?.locked === true);
	// `full` is null under a "no limit" timer (no time deadline while picking).
	const full = state.navigationFullDeadline;
	if (allLocked) {
		// Everyone's in — collapse to a short final grace so the round advances (still a
		// back-out window). Never EXTEND past the original deadline when one exists; under
		// "no limit" the grace IS the only deadline, so the round can't idle forever.
		const grace = Date.now() + NAV_GRACE_MS;
		const target = full == null ? grace : Math.min(full, grace);
		state.navigationDeadline = target;
		state.phaseDeadline = target;
	} else {
		// Someone is still choosing — restore the full deadline (null under "no limit",
		// which clears the countdown and any pending advance entirely).
		state.navigationDeadline = full;
		state.phaseDeadline = full;
	}
}

/**
 * If the room's current phase has run past its server-clock deadline, advance it ONCE
 * past any silent/disconnected seat and persist under the existing revision CAS.
 * Single-winner: every connected client's ~1s SSE poll calls this; concurrent callers
 * all compute the same advance, exactly one wins the CAS (eq revision), the rest no-op.
 * Advances at most one phase per call (re-stamping a future deadline), so a long-idle
 * room steps forward one phase per poll rather than racing a whole round in one request.
 * Returns the freshest session row (advanced / the CAS winner's / unchanged).
 */
async function maybeEnforceDeadline(session: PlaySessionRow): Promise<PlaySessionRow> {
	const state = asState(session);
	if (state.status !== 'active') return session;
	if (state.phaseDeadline == null || Date.now() <= state.phaseDeadline) return session;

	const catalog = await loadPlayCatalog();

	// A present human still mid-obligation in an extendable phase (an unclaimed Location
	// reward / in-flight draw, the round's Benefits grants, an un-flipped Awakening spirit or
	// decision, a Cleanup corruption sacrifice / rune overflow) EXTENDS the deadline rather
	// than being force-advanced — a forced advance would silently resolve it FOR them (incl.
	// `chooseRune` and Benefits split/relic picks). Bots are excluded (they resolve during
	// their own tick), and the extension is bounded so a disconnected seat can't stall the
	// room: after the budget the backstop advance below fires. `botSeats` is loaded ONLY when
	// an obligation is actually open (the rare path), never on the hot no-op.
	let botSeats: SeatColor[] = [];
	if (deadlineBlockingSeats(state).length > 0) {
		const botMembers = await loadBotMembers(session.id);
		botSeats = state.activeSeats.filter((seat) => {
			const memberId = state.seats[seat]?.memberId;
			return memberId != null && botMembers.has(memberId);
		});
	}

	const outcome = resolvePassedDeadline(state, catalog, Date.now(), botSeats);
	// On a backstop advance the phase changed and phaseDeadline was nulled — re-stamp the new
	// phase against the server clock. An extension already re-stamped phaseDeadline itself.
	if (outcome === 'advanced') stampPhaseDeadline(state);

	const persisted = await persistSessionUpdate({
		session,
		nextState: state,
		actorMemberId: null,
		command: ENFORCE_DEADLINE_COMMAND
	});
	if (persisted) return persisted;
	// CAS miss: another poller advanced it first — return their fresh state.
	return (await getSessionByRoomCode(session.room_code)) ?? session;
}

/**
 * Opportunistic, host-INDEPENDENT deadline enforcement. Called from every server
 * touchpoint that already loads room state — the SSE poll's loadRoomView (~1s per
 * connected client) and the top of runRoomCommand — plus the page-load path, which
 * gives the lazy-on-reconnect floor for a room that dropped to zero pollers. Cheap
 * no-op when the deadline hasn't passed (one SELECT, no write).
 */
export async function enforceRoomDeadlines(roomCode: string): Promise<void> {
	const session = await getSessionByRoomCode(normalizeRoomCode(roomCode));
	if (session) await maybeEnforceDeadline(session);
}

// ── Room lifecycle (host-independent close of abandoned/expired rooms) ────────

/** Build the pure {@link RoomLiveness} input from a session row + its member rows. */
function roomLivenessFrom(
	session: Pick<PlaySessionRow, 'status' | 'created_at' | 'started_at'>,
	members: { display_name: string | null; last_seen_at: string; is_bot?: boolean | null }[]
): RoomLiveness {
	return {
		status: session.status,
		createdAtMs: Date.parse(session.created_at),
		startedAtMs: session.started_at ? Date.parse(session.started_at) : null,
		humanLastSeenMs: humanLastSeen(
			members.map((m) => ({
				displayName: m.display_name,
				lastSeenAtMs: Date.parse(m.last_seen_at),
				isBot: m.is_bot ?? false
			}))
		)
	};
}

/**
 * Transition a room to the terminal `closed` state: mirrors the row `status`, stamps
 * `ended_at`, syncs `public_state.status` (so a stranded client's projection reads
 * `closed` and bounces, and a late command can't reopen it), and bumps `revision`
 * under the existing compare-and-set so connected SSE pollers get pushed the change.
 * Returns the updated row, or `null` on a CAS miss (another writer won).
 */
async function closeRoomSession(
	session: PlaySessionRow,
	reason: RoomCloseReason
): Promise<PlaySessionRow | null> {
	const oldRevision = session.revision;
	// Clone before mutating: asState() may alias the row's parsed public_state, and a
	// CAS miss would otherwise leave a half-mutated object behind for the next reader.
	const state = structuredClone(asState(session));
	state.status = 'closed';
	state.revision = oldRevision + 1;
	const now = new Date().toISOString();

	const { data, error } = await getPlayAdmin()
		.from(PLAY_TABLES.SESSIONS)
		.update({
			status: 'closed',
			revision: state.revision,
			ended_at: session.ended_at ?? now,
			public_state: state
		})
		.eq('id', session.id)
		.eq('revision', oldRevision)
		.select('*')
		.maybeSingle();

	if (error) {
		throw kitError(500, `Failed to close room: ${error.message}`);
	}
	if (!data) {
		// CAS miss — another request closed/advanced this row first.
		return null;
	}

	// Best-effort audit row; never fail the close on a logging hiccup.
	await getPlayAdmin()
		.from(PLAY_TABLES.EVENTS)
		.insert({
			session_id: session.id,
			revision: state.revision,
			actor_member_id: null,
			command_type: 'closeRoom',
			command_payload: { reason }
		})
		.then(undefined, () => {});

	return data as PlaySessionRow;
}

/**
 * Close THIS session if it is a lobby that has aged out (≥30 min, never started) or a
 * lobby/active room that has been abandoned (no human seen within the presence
 * window). Host-independent and opportunistic — the per-room analogue of
 * {@link maybeEnforceDeadline}; no-op for finished/closed sessions. Returns the
 * freshest row (closed / the CAS winner's row / unchanged). Pass `members` to reuse
 * rows already loaded by the caller.
 */
async function maybeCloseRoom(
	session: PlaySessionRow,
	members?: { display_name: string | null; last_seen_at: string; is_bot?: boolean | null }[]
): Promise<PlaySessionRow> {
	if (session.status !== 'lobby' && session.status !== 'active') return session;
	const memberRows = members ?? (await getMembersForSession(session.id));
	const reason = roomCloseReason(roomLivenessFrom(session, memberRows), Date.now());
	if (!reason) return session;

	const closed = await closeRoomSession(session, reason);
	if (closed) return closed;
	// CAS miss: another request closed it first — return their fresh row.
	return (await getSessionByRoomCode(session.room_code)) ?? session;
}

/**
 * Sweep every open room (lobby + active) and close the abandoned/expired ones.
 * Opportunistic + host-independent — called from the server-browser list path so
 * stale rooms are reaped whenever anyone views the browser (no cron needed). Bounded:
 * two batched queries (rooms + their members) regardless of room count, then one CAS
 * update per room that needs closing.
 */
export async function closeAbandonedRooms(): Promise<void> {
	const admin = getPlayAdmin();
	const { data, error } = await admin
		.from(PLAY_TABLES.SESSIONS)
		.select('*')
		.in('status', ['lobby', 'active']);
	if (error) {
		throw kitError(500, `Failed to sweep rooms: ${error.message}`);
	}
	const rooms = (data as PlaySessionRow[] | null) ?? [];
	if (rooms.length === 0) return;

	const ids = rooms.map((room) => room.id);
	const { data: memberData, error: memberError } = await admin
		.from(PLAY_TABLES.MEMBERS)
		.select('session_id, display_name, last_seen_at, is_bot')
		.in('session_id', ids);
	if (memberError) {
		throw kitError(500, `Failed to sweep room members: ${memberError.message}`);
	}

	type LiteMember = {
		session_id: string;
		display_name: string | null;
		last_seen_at: string;
		is_bot: boolean | null;
	};
	const bySession = new Map<string, LiteMember[]>();
	for (const row of (memberData as LiteMember[] | null) ?? []) {
		const list = bySession.get(row.session_id);
		if (list) list.push(row);
		else bySession.set(row.session_id, [row]);
	}

	const now = Date.now();
	for (const room of rooms) {
		const reason = roomCloseReason(roomLivenessFrom(room, bySession.get(room.id) ?? []), now);
		if (reason) await closeRoomSession(room, reason); // CAS miss ⇒ already handled; ignore
	}
}

export async function createRoom(
	displayName: string,
	userId?: string | null,
	mode: PlayMode = 'casual'
): Promise<{ roomCode: string; memberId: string }> {
	const catalog = await loadPlayCatalog();
	const normalizedName = normalizeDisplayName(displayName);

	let roomCode = createRoomCode();
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const state = createLobbyState({
			roomCode,
			guardianNames: catalog.guardians.map((guardian) => guardian.name)
		});

		const { data, error } = await getPlayAdmin()
			.from(PLAY_TABLES.SESSIONS)
			.insert({
				room_code: roomCode,
				status: state.status,
				revision: state.revision,
				scenario: state.scenario,
				public_state: state,
				mode
			})
			.select('*')
			.maybeSingle();

		if (error) {
			if (error.code === '23505') {
				roomCode = createRoomCode();
				continue;
			}
			throw kitError(500, `Failed to create room: ${error.message}`);
		}

		if (!data) {
			throw kitError(500, 'Room creation did not return a session row.');
		}

		const createdSession = data as PlaySessionRow;
		const memberInsert = await getPlayAdmin()
			.from(PLAY_TABLES.MEMBERS)
			.insert({
				session_id: createdSession.id,
				display_name: normalizedName,
				role: 'host',
				private_state: {},
				user_id: userId ?? null
			})
			.select('*')
			.single();

		if (memberInsert.error) {
			throw kitError(500, `Failed to create host membership: ${memberInsert.error.message}`);
		}

		return {
			roomCode,
			memberId: (memberInsert.data as SessionMemberRow).id
		};
	}

	throw kitError(500, 'Failed to generate a unique room code.');
}

/** A ranked-match participant the matchmaker pairs into a session. */
export interface RankedPlayer {
	userId: string;
	displayName: string;
	/** True for backfilled bot accounts; their seat is driven by the bot engine. */
	isBot?: boolean;
	/** Shared bot contract policy key for a bot (ignored for humans). */
	botProfile?: string | null;
}

/**
 * Create a STARTED ranked game for an already-paired group. Reuses the normal
 * lobby primitives: the first player hosts a ranked room (createRoom mode:'ranked'),
 * the rest join + claim distinct seats + pick distinct guardians, then the host
 * starts the game. Returns the room code and a memberId-by-userId map so the
 * matchmaker can stamp each queue row's claimed_session_id.
 *
 * Throws on failure so the caller can roll the queue rows back to 'queued'.
 */
export async function createRankedSession(
	players: RankedPlayer[]
): Promise<{ roomCode: string; sessionId: string; memberIdByUserId: Record<string, string> }> {
	if (players.length < 2) {
		throw kitError(400, 'A ranked session needs at least two players.');
	}
	if (players.length > SEAT_COLORS.length) {
		throw kitError(400, `A ranked session supports at most ${SEAT_COLORS.length} players.`);
	}

	// A bot MUST NOT be host: the host creates the room and presses Start, which the bot
	// engine doesn't drive. Reorder so a human is first while keeping the relative order
	// of everyone else stable. The matcher guarantees ≥1 human, so a human is always found;
	// if somehow all are bots we fall back to players[0] (shouldn't happen).
	const orderedPlayers = (() => {
		const firstHumanIndex = players.findIndex((p) => !p.isBot);
		if (firstHumanIndex <= 0) return players; // already human-first (or all bots)
		const human = players[firstHumanIndex];
		return [human, ...players.filter((_, i) => i !== firstHumanIndex)];
	})();

	const [host] = orderedPlayers;

	// 1) First player (a human) hosts a ranked room.
	const created = await createRoom(host.displayName, host.userId, 'ranked');
	const roomCode = created.roomCode;
	const memberIdByUserId: Record<string, string> = { [host.userId]: created.memberId };

	// Resolve the session id for the new room (for claimed_session_id stamping).
	const session = await getSessionByRoomCode(normalizeRoomCode(roomCode));
	if (!session) throw kitError(500, 'Ranked room vanished immediately after creation.');

	// 2) Seat everyone at a distinct seat with a distinct guardian.
	for (let i = 0; i < orderedPlayers.length; i += 1) {
		const seat = SEAT_COLORS[i];
		const player = orderedPlayers[i];
		const memberId =
			i === 0
				? created.memberId
				: (
						await joinRoom(
							roomCode,
							player.displayName,
							player.userId,
							player.isBot
								? { isBot: true, botProfile: player.botProfile ?? DEFAULT_BOT_PROFILE_KEY }
								: undefined
						)
					).memberId;
		if (i !== 0) memberIdByUserId[player.userId] = memberId;

		await runRoomCommand({
			roomCode,
			memberId,
			expectedRevision: null,
			command: { type: 'claimSeat', seatColor: seat }
		});

		// Distinct, unused guardian from the live pool.
		const state = await loadRawRoomState(roomCode);
		const used = new Set(
			SEAT_COLORS.map((s) => state.seats[s]?.selectedGuardian).filter((g): g is string => g != null)
		);
		const guardian = state.guardianPool.find((name) => !used.has(name));
		if (guardian) {
			await runRoomCommand({
				roomCode,
				memberId,
				expectedRevision: null,
				command: { type: 'selectGuardian', guardianName: guardian }
			});
		}
	}

	// 3) Host starts the game now that the lobby is full.
	await runRoomCommand({
		roomCode,
		memberId: created.memberId,
		expectedRevision: null,
		command: { type: 'startGame' }
	});

	return { roomCode, sessionId: session.id, memberIdByUserId };
}

// ── Debug spawn (dev-only) ────────────────────────────────────────────────────
// Seed a solo, already-started game parked in the Awakening phase (folded into
// Cleanup) with a face-down spirit of the requested class plus everything needed
// to awaken it — so the ability UX can be tested without playing a whole game.
const DEBUG_AWAKENING_DEADLINE_MS = 10 * 60 * 1000;

/** Pick the best catalog spirit carrying `className` to test: prefer a rune-cost
 *  awaken (exercises the cost UX), then a free flip, then a text condition. */
function pickDebugSpirit(catalog: PlayCatalog, className: string): PlayCatalogSpirit | null {
	const candidates = catalog.spirits.filter((s) => (s.classes?.[className] ?? 0) > 0);
	if (candidates.length === 0) return null;
	const rank = (s: PlayCatalogSpirit) =>
		s.awaken?.kind === 'rune_cost' ? 0 : s.awaken == null ? 1 : 2;
	return [...candidates].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** Push rune slots that satisfy a spirit's awaken cost into the player's rune mat,
 *  so the seeded face-down spirit is immediately awakenable. */
function grantAwakenRunes(player: PrivatePlayerState, awaken: NormalizedAwaken | undefined): void {
	if (awaken?.kind !== 'rune_cost') return;
	let slot = (player.mats.at(-1)?.slotIndex ?? 0) + 1;
	for (const req of awaken.mats) {
		for (let n = 0; n < req.count; n += 1) {
			const wildcardKind = req.wildcard
				? req.runeId === WILDCARD_MAT_IDS.anyRune
					? 'rune'
					: 'relic'
				: req.kind;
			const isRune = req.wildcard ? wildcardKind === 'rune' : req.kind === 'rune';
			const isAugment = req.wildcard ? false : req.kind === 'augment';
			player.mats.push({
				slotIndex: slot++,
				hasRune: true,
				// Named requirements match on id; wildcards match on derived kind only.
				id: req.wildcard ? undefined : req.runeId,
				name: req.name,
				originId: isRune ? 'debug-origin' : undefined,
				classId: isAugment ? 'debug-class' : undefined
			} satisfies MatSlotSnapshot);
		}
	}
}

/** Place a face-up spirit carrying `className` (a prerequisite target, e.g. the
 *  Purifier's Cursed Spirit). No-op when the catalog has none. */
function seedFaceUpSpiritWithClass(
	catalog: PlayCatalog,
	player: PrivatePlayerState,
	className: string,
	slotIndex: number
): void {
	const spirit = catalog.spirits.find((s) => (s.classes?.[className] ?? 0) > 0);
	if (!spirit) return;
	player.spirits.push({
		slotIndex,
		id: spirit.id,
		name: spirit.name,
		cost: spirit.cost,
		classes: spirit.classes,
		origins: spirit.origins,
		isFaceDown: false
	});
}

/**
 * Make a face-down `text`-awaken test spirit genuinely awakenable via its REAL
 * condition (so the debug game exercises the actual awaken path, not a shortcut):
 *   - progress-flag conditions (cultivate/rest/combat events) → set the flag so the
 *     handler's `check` passes and `pay` consumes it on awaken;
 *   - "Discard N of any attack dice" (Space Invader) → grant enough attack dice;
 *   - "Discard N Arcane Abyss Spirits" → seed N spare cost 7–9 spirits to discard;
 *   - relic-discard Faeries / Blood Hound → satisfied by the two starting Fairy Relics.
 * No-op for `rune_cost` (handled by grantAwakenRunes) and free flips.
 */
function satisfyAwakenCondition(
	state: PublicGameState,
	player: PrivatePlayerState,
	catalog: PlayCatalog,
	testSpirit: PlayCatalogSpirit,
	nextSlot: () => number | null
): void {
	const awaken = testSpirit.awaken;
	if (awaken?.kind !== 'text') return;

	// Progress-flag conditions: simulate the triggering event happened this round. The
	// awaken still resolves through the real handler (check reads the flag, pay clears it).
	player.awakenProgress ??= {};
	for (const key of Object.values(AWAKEN_PROGRESS_KEYS)) player.awakenProgress[key] = true;

	const text = awaken.text.toLowerCase();

	// "Discard N of any attack dice" (Space Invader).
	if (text.includes('attack dice')) {
		for (let i = 0; i < 4; i += 1) {
			player.attackDice.push({ instanceId: nextId(state.rng, 'die'), tier: 'basic' });
		}
	}

	// "Discard N Arcane Abyss Spirits" — seed spare cost 7–9 spirits to spend.
	const abyss = text.match(/discard (\d+) arcane abyss spirit/);
	if (abyss) {
		const need = Number(abyss[1]);
		const have = () =>
			player.spirits.filter((s) => s.cost >= 7 && s.cost <= 9 && s.id !== testSpirit.id).length;
		const fillers = catalog.spirits.filter(
			(s) => s.cost >= 7 && s.cost <= 9 && s.id !== testSpirit.id
		);
		let fi = 0;
		while (have() < need && fi < fillers.length) {
			let slot = nextSlot();
			if (slot === null) {
				// Free a starting (cheap, non-test) spirit to make room.
				const victim = player.spirits.find((s) => s.cost < 7);
				if (!victim) break;
				slot = victim.slotIndex;
				player.spirits = player.spirits.filter((s) => s.slotIndex !== slot);
			}
			const f = fillers[fi++];
			player.spirits.push({
				slotIndex: slot,
				id: f.id,
				name: f.name,
				cost: f.cost,
				classes: f.classes,
				origins: f.origins,
				isFaceDown: false
			});
		}
	}
}

export async function createDebugRoom(
	displayName: string,
	className: string,
	spiritId?: string
): Promise<{ roomCode: string; memberId: string }> {
	const catalog = await loadPlayCatalog();
	const normalizedName = normalizeDisplayName(displayName || 'Debug Player');
	const guardianName = catalog.guardians[0]?.name;
	if (!guardianName) throw kitError(500, 'No guardians available to seed a debug game.');

	// Target a specific spirit when given (so EVERY spirit is testable, not just one per
	// class); otherwise pick the best representative spirit for the class.
	const testSpirit = spiritId
		? (catalog.spirits.find((s) => s.id === spiritId) ?? null)
		: pickDebugSpirit(catalog, className);
	if (!testSpirit) {
		throw kitError(
			400,
			spiritId
				? `No spirit with id "${spiritId}" in the catalog.`
				: `No spirit in the catalog carries the "${className}" class.`
		);
	}

	// 1. Insert a fresh lobby session + a host member.
	let roomCode = createRoomCode();
	let sessionId: string | null = null;
	for (let attempt = 0; attempt < 10 && sessionId === null; attempt += 1) {
		const lobby = createLobbyState({
			roomCode,
			guardianNames: catalog.guardians.map((g) => g.name)
		});
		const { data, error } = await getPlayAdmin()
			.from(PLAY_TABLES.SESSIONS)
			.insert({
				room_code: roomCode,
				status: lobby.status,
				revision: lobby.revision,
				scenario: lobby.scenario,
				public_state: lobby
			})
			.select('*')
			.maybeSingle();
		if (error) {
			if (error.code === '23505') {
				roomCode = createRoomCode();
				continue;
			}
			throw kitError(500, `Failed to create debug room: ${error.message}`);
		}
		if (data) sessionId = (data as PlaySessionRow).id;
	}
	if (sessionId === null) throw kitError(500, 'Failed to generate a unique debug room code.');

	const memberInsert = await getPlayAdmin()
		.from(PLAY_TABLES.MEMBERS)
		.insert({
			session_id: sessionId,
			display_name: normalizedName,
			role: 'host',
			private_state: {}
		})
		.select('*')
		.single();
	if (memberInsert.error) {
		throw kitError(500, `Failed to create debug host: ${memberInsert.error.message}`);
	}
	const memberId = (memberInsert.data as SessionMemberRow).id;

	// 2. Drive the lobby → active transition through the real reducer.
	let state = createLobbyState({ roomCode, guardianNames: catalog.guardians.map((g) => g.name) });
	const host: GameActor = { memberId, displayName: normalizedName, role: 'host', seatColor: null };
	const seat: SeatColor = SEAT_COLORS[0];
	for (const command of [
		{ type: 'claimSeat', seatColor: seat },
		{ type: 'selectGuardian', guardianName },
		// Omit the seed so startGame derives it from the (random) roomCode — otherwise
		// concurrent debug spawns share a fixed seed and mint identical game IDs, which
		// collide on the unique game_id constraint.
		{ type: 'startGame' }
	] as GameCommand[]) {
		const result = applyGameCommand(state, host, command, catalog);
		if (!result.ok)
			throw kitError(500, `Debug seed failed at ${command.type}: ${result.error.message}`);
		state = result.state;
	}

	// 3. Inject the test scenario: a face-down spirit of the class under test +
	//    the runes to awaken it + a Cursed Spirit prerequisite for any class.
	const player = state.players[seat];
	if (!player) throw kitError(500, 'Debug seed produced no player.');
	const usedSlots = new Set(player.spirits.map((s) => s.slotIndex));
	const nextSlot = (): number | null => {
		for (let i = 1; i <= 7; i += 1)
			if (!usedSlots.has(i)) {
				usedSlots.add(i);
				return i;
			}
		return null;
	};
	// Always seed the test spirit FACE-DOWN so the awaken is tested through its real
	// condition: rune costs are granted, and text conditions are genuinely satisfied
	// (flags/dice/abyss spirits) by satisfyAwakenCondition — never a face-up shortcut.
	player.spirits.push({
		slotIndex: nextSlot() ?? 5,
		id: testSpirit.id,
		name: testSpirit.name,
		cost: testSpirit.cost,
		classes: testSpirit.classes,
		origins: testSpirit.origins,
		isFaceDown: true
	});
	grantAwakenRunes(player, testSpirit.awaken);
	satisfyAwakenCondition(state, player, catalog, testSpirit, nextSlot);
	// Purifier needs a summoned Cursed Spirit as its ability target; add one if a slot
	// is free and the test spirit isn't itself a Cursed Spirit.
	if ((testSpirit.classes?.['Cursed Spirit'] ?? 0) === 0) {
		const csSlot = nextSlot();
		if (csSlot !== null) seedFaceUpSpiritWithClass(catalog, player, 'Cursed Spirit', csSlot);
	}
	player.spirits.sort((a, b) => a.slotIndex - b.slotIndex);

	// 4. Land directly on the Awakening step (run Benefits first so the awakeningPhase
	//    grants fire + any reward is computed, then advance to where the awaken offers
	//    live — what the debug flow is here to test) and persist. enterBenefits may
	//    already have chained into awakening on its own (seats with no benefits work
	//    auto-ready and the phase collapses forward), so only step forward if it hasn't.
	enterBenefits(state, catalog);
	if (state.phase === 'benefits') enterAwakening(state, catalog);
	if (state.phase !== 'awakening') {
		throw kitError(500, `Debug room expected to land on awakening, got ${state.phase}.`);
	}
	state.revision += 1;
	state.phaseDeadline = Date.now() + DEBUG_AWAKENING_DEADLINE_MS;

	const now = new Date().toISOString();
	const { error: updateError } = await getPlayAdmin()
		.from(PLAY_TABLES.SESSIONS)
		.update({
			status: state.status,
			revision: state.revision,
			game_id: state.gameId,
			scenario: state.scenario,
			public_state: state,
			started_at: now
		})
		.eq('id', sessionId);
	if (updateError) throw kitError(500, `Failed to persist debug room: ${updateError.message}`);

	await syncMemberMirrors(sessionId, state);
	return { roomCode, memberId };
}

export async function joinRoom(
	roomCode: string,
	displayName: string,
	userId?: string | null,
	opts?: { isBot?: boolean; botProfile?: string | null }
): Promise<{ memberId: string }> {
	let session = await getSessionByRoomCode(normalizeRoomCode(roomCode));
	if (!session) {
		throw kitError(404, 'Room not found.');
	}
	// Close the room first if it's already due (expired/abandoned), so a stale row
	// can't accept a joiner a beat before it would have been reaped.
	session = await maybeCloseRoom(session);
	if (session.status === 'closed' || session.status === 'finished') {
		throw kitError(410, 'This room is no longer open to join.');
	}

	const insert = await getPlayAdmin()
		.from(PLAY_TABLES.MEMBERS)
		.insert({
			session_id: session.id,
			display_name: normalizeDisplayName(displayName),
			role: 'spectator',
			private_state: {},
			user_id: userId ?? null,
			is_bot: opts?.isBot ?? false,
			bot_profile: opts?.botProfile ?? null
		})
		.select('*')
		.single();

	if (insert.error) {
		throw kitError(500, `Failed to join room: ${insert.error.message}`);
	}
	const memberId = (insert.data as SessionMemberRow).id;

	// TOCTOU guard: another request may have closed the room between the status check
	// and this insert. If it went terminal, roll back the orphaned membership so a
	// closed room never carries a live member (the "open only while present" invariant).
	const fresh = await getSessionByRoomCode(session.room_code);
	if (fresh && (fresh.status === 'closed' || fresh.status === 'finished')) {
		await getPlayAdmin().from(PLAY_TABLES.MEMBERS).delete().eq('id', memberId);
		throw kitError(410, 'This room is no longer open to join.');
	}

	return { memberId };
}

function scenarioDisplayName(scenario: PublicGameState['scenario']): string | null {
	if (scenario == null) return null;
	if (typeof scenario === 'string') return scenario;
	return scenario.name ?? scenario.id ?? scenario.requested ?? null;
}

/**
 * List every joinable/spectatable room for the server browser: `lobby` and `active`
 * sessions (never `finished`/`closed`), newest first. Returns public summaries only
 * — no per-seat private state.
 *
 * Room lifecycle is enforced here, host-independently:
 *  1. {@link closeAbandonedRooms} first reaps any aged-out lobby (≥30 min, never
 *     started) or abandoned room — a lobby with no human present, or an active game
 *     everyone has left — so they leave the list for good.
 *  2. As defense-in-depth against a sweep that just missed (CAS race / sub-second
 *     boundary), a room is additionally hidden at read time unless it's still
 *     {@link isRoomOpen}.
 *
 * Host names AND presence are resolved from one batched members query.
 */
export async function listOpenRooms(): Promise<RoomSummary[]> {
	// Opportunistic, host-independent cleanup before listing.
	await closeAbandonedRooms();

	const admin = getPlayAdmin();
	const { data, error } = await admin
		.from(PLAY_TABLES.SESSIONS)
		.select('id, room_code, status, public_state, scenario, created_at, started_at')
		.in('status', ['lobby', 'active'])
		.order('created_at', { ascending: false })
		.limit(60);

	if (error) {
		throw kitError(500, `Failed to list rooms: ${error.message}`);
	}

	type ListRow = Pick<
		PlaySessionRow,
		'id' | 'room_code' | 'status' | 'public_state' | 'scenario' | 'created_at' | 'started_at'
	>;
	const rows = (data as ListRow[] | null) ?? [];
	if (rows.length === 0) return [];

	// One batched query resolves both the host name and lobby presence (avoids N+1).
	const sessionIds = rows.map((r) => r.id);
	const { data: memberRows, error: memberError } = await admin
		.from(PLAY_TABLES.MEMBERS)
		.select('session_id, display_name, role, last_seen_at, is_bot')
		.in('session_id', sessionIds);

	if (memberError) {
		throw kitError(500, `Failed to load room members: ${memberError.message}`);
	}

	type LiteMember = {
		session_id: string;
		display_name: string | null;
		role: MemberRole;
		last_seen_at: string;
		is_bot: boolean | null;
	};
	const hostBySession = new Map<string, string>();
	const membersBySession = new Map<string, LiteMember[]>();
	for (const row of (memberRows as LiteMember[] | null) ?? []) {
		const list = membersBySession.get(row.session_id);
		if (list) list.push(row);
		else membersBySession.set(row.session_id, [row]);
		if (row.role === 'host' && !hostBySession.has(row.session_id) && row.display_name) {
			hostBySession.set(row.session_id, row.display_name);
		}
	}

	const now = Date.now();
	return rows
		.filter((row) =>
			// Hide any room the sweep would have closed (lobby aged-out/abandoned, or an
			// abandoned active game) even if a CAS race left it un-swept this tick.
			isRoomOpen(roomLivenessFrom(row, membersBySession.get(row.id) ?? []), now)
		)
		.map((row) => {
			const state = parseJsonValue<PublicGameState | null>(row.public_state, null);
			const seats = state ? Object.values(state.seats) : [];
			const occupiedSeats = seats.filter((seat) => seat.memberId != null).length;
			return {
				roomCode: row.room_code,
				status: row.status,
				hostName: hostBySession.get(row.id) ?? 'Anonymous',
				occupiedSeats,
				totalSeats: seats.length,
				round: state?.round ?? 0,
				scenarioName: scenarioDisplayName(state?.scenario ?? row.scenario),
				createdAt: row.created_at,
				startedAt: row.started_at
			} satisfies RoomSummary;
		});
}

export async function loadRoomView(
	roomCode: string,
	memberId: string | null | undefined,
	fallbackUserId?: string | null
): Promise<RoomView> {
	let session = await getSessionByRoomCode(roomCode);
	if (!session) {
		throw kitError(404, 'Room not found.');
	}

	// Opportunistic, host-independent enforcement: every connected client's ~1s SSE
	// poll (and the page-load path) advances a phase that has run past its deadline,
	// so a silent/disconnected seat can't stall the game. Cheap no-op when not due.
	session = await maybeEnforceDeadline(session);

	const rawMember = memberId ? await getMemberById(memberId) : null;
	let member = rawMember && rawMember.session_id === session.id ? rawMember : null;
	// Fallback: a matchmade (or just-authenticated) player may arrive with no
	// member cookie/id but a valid auth session — resolve their membership by user_id.
	if (!member && fallbackUserId) {
		member = await getMemberBySessionAndUser(session.id, fallbackUserId);
	}
	// Stamp THIS member's liveness BEFORE the room-close check, so an actively
	// polling member always counts as present — an `abandoned` close can never fire
	// out from under someone who is here. (An `expired` lobby still closes regardless.)
	if (member) {
		await updateLastSeen(member.id);
	}

	// Opportunistic, host-independent close: reap this room if it's a lobby that aged
	// out (≥30 min, never started) or a lobby/active game that was abandoned (no human
	// present). No-op for finished/closed sessions. On close the revision bumps, so the
	// SSE poll pushes the `closed` snapshot and the client bounces out of the room.
	session = await maybeCloseRoom(session);

	const state = asState(session);
	const projection = await attachBotSeatFlags(
		session.id,
		buildSessionProjection(state, viewerForMember(state, member))
	);
	return {
		projection,
		member: {
			id: member?.id ?? null,
			role: projection.viewer.role,
			seatColor: projection.viewer.seatColor,
			displayName: projection.viewer.displayName
		}
	};
}

function normalizeChatBody(body: unknown): string {
	if (typeof body !== 'string') {
		throw kitError(400, 'Message body is required.');
	}
	const normalized = body.replace(/\s+/g, ' ').trim();
	if (!normalized) {
		throw kitError(400, 'Message cannot be empty.');
	}
	if (normalized.length > 500) {
		throw kitError(400, 'Message must be 500 characters or fewer.');
	}
	return normalized;
}

function chatMessageFromRow(row: SessionMessageRow, roomCode: string): RoomChatMessage {
	return {
		id: row.id,
		roomCode,
		memberId: row.member_id,
		authorDisplayName: row.author_display_name,
		authorRole: row.author_role,
		seatColor: row.seat_color,
		kind: row.kind,
		body: row.body,
		createdAt: row.created_at
	};
}

type ChatEventPayload = {
	chatMessage?: {
		memberId: string | null;
		authorDisplayName: string;
		authorRole: MemberRole;
		seatColor: SeatColor | null;
		kind: RoomChatMessage['kind'];
		body: string;
	};
};

type SessionChatEventRow = {
	id: string;
	actor_member_id: string | null;
	command_payload: ChatEventPayload | string | null;
	created_at: string;
};

function isMissingChatTable(error: { code?: string; message?: string } | null | undefined): boolean {
	const message = error?.message ?? '';
	return (
		error?.code === '42P01' ||
		error?.code === 'PGRST205' ||
		message.includes('play_session_messages') ||
		message.includes('schema cache')
	);
}

function chatEventPayload(row: SessionChatEventRow): ChatEventPayload['chatMessage'] | null {
	const payload =
		typeof row.command_payload === 'string'
			? parseJsonValue<ChatEventPayload | null>(row.command_payload, null)
			: row.command_payload;
	return payload?.chatMessage ?? null;
}

function chatMessageFromEventRow(row: SessionChatEventRow, roomCode: string): RoomChatMessage | null {
	const payload = chatEventPayload(row);
	if (!payload) return null;
	return {
		id: row.id,
		roomCode,
		memberId: payload.memberId ?? row.actor_member_id ?? null,
		authorDisplayName: payload.authorDisplayName,
		authorRole: payload.authorRole,
		seatColor: payload.seatColor,
		kind: payload.kind,
		body: payload.body,
		createdAt: row.created_at
	};
}

async function listRoomChatMessagesFromEvents(
	session: PlaySessionRow,
	after: string | null | undefined,
	limit: number
): Promise<RoomChatMessage[]> {
	let afterCreatedAt: string | null = null;
	if (after) {
		const anchor = await getPlayAdmin()
			.from(PLAY_TABLES.EVENTS)
			.select('created_at')
			.eq('session_id', session.id)
			.eq('id', after)
			.eq('command_type', 'chatMessage')
			.maybeSingle();
		if (anchor.error) {
			throw kitError(500, `Failed to load chat cursor: ${anchor.error.message}`);
		}
		afterCreatedAt = (anchor.data as { created_at?: string } | null)?.created_at ?? null;
	}

	const query = getPlayAdmin()
		.from(PLAY_TABLES.EVENTS)
		.select('id, actor_member_id, command_payload, created_at')
		.eq('session_id', session.id)
		.eq('command_type', 'chatMessage')
		.limit(limit);

	if (afterCreatedAt) {
		const { data, error } = await query.gt('created_at', afterCreatedAt).order('created_at', {
			ascending: true
		});
		if (error) {
			throw kitError(500, `Failed to load chat messages: ${error.message}`);
		}
		return ((data as SessionChatEventRow[] | null) ?? [])
			.map((row) => chatMessageFromEventRow(row, session.room_code))
			.filter((message): message is RoomChatMessage => message != null);
	}

	const { data, error } = await query.order('created_at', { ascending: false });
	if (error) {
		throw kitError(500, `Failed to load chat messages: ${error.message}`);
	}
	return ((data as SessionChatEventRow[] | null) ?? [])
		.reverse()
		.map((row) => chatMessageFromEventRow(row, session.room_code))
		.filter((message): message is RoomChatMessage => message != null);
}

export async function listRoomChatMessages(params: {
	roomCode: string;
	memberId?: string | null;
	fallbackUserId?: string | null;
	after?: string | null;
	limit?: number | null;
}): Promise<RoomChatMessage[]> {
	const session = await getSessionByRoomCode(params.roomCode);
	if (!session) {
		throw kitError(404, 'Room not found.');
	}

	const member = await resolveMemberForSession(session, params.memberId, params.fallbackUserId);
	if (member) {
		void updateLastSeen(member.id).catch(() => {});
	}

	const limit = Math.max(1, Math.min(params.limit ?? 100, 100));
	let afterCreatedAt: string | null = null;
	if (params.after) {
		const anchor = await getPlayAdmin()
			.from(PLAY_TABLES.MESSAGES)
			.select('created_at')
			.eq('session_id', session.id)
			.eq('id', params.after)
			.maybeSingle();
		if (anchor.error) {
			if (isMissingChatTable(anchor.error)) {
				return listRoomChatMessagesFromEvents(session, params.after, limit);
			}
			throw kitError(500, `Failed to load chat cursor: ${anchor.error.message}`);
		}
		afterCreatedAt = (anchor.data as { created_at?: string } | null)?.created_at ?? null;
	}

	const query = getPlayAdmin()
		.from(PLAY_TABLES.MESSAGES)
		.select('*')
		.eq('session_id', session.id)
		.limit(limit);

	if (afterCreatedAt) {
		const { data, error } = await query.gt('created_at', afterCreatedAt).order('created_at', {
			ascending: true
		});
		if (error) {
			if (isMissingChatTable(error)) {
				return listRoomChatMessagesFromEvents(session, params.after, limit);
			}
			throw kitError(500, `Failed to load chat messages: ${error.message}`);
		}
		return ((data as SessionMessageRow[] | null) ?? []).map((row) =>
			chatMessageFromRow(row, session.room_code)
		);
	}

	const { data, error } = await query.order('created_at', { ascending: false });
	if (error) {
		if (isMissingChatTable(error)) {
			return listRoomChatMessagesFromEvents(session, params.after, limit);
		}
		throw kitError(500, `Failed to load chat messages: ${error.message}`);
	}
	return ((data as SessionMessageRow[] | null) ?? [])
		.reverse()
		.map((row) => chatMessageFromRow(row, session.room_code));
}

export async function createRoomChatMessage(params: {
	roomCode: string;
	memberId?: string | null;
	fallbackUserId?: string | null;
	body: unknown;
}): Promise<RoomChatMessage> {
	let session = await getSessionByRoomCode(params.roomCode);
	if (!session) {
		throw kitError(404, 'Room not found.');
	}
	session = await maybeCloseRoom(session);
	if (session.status === 'closed') {
		throw kitError(410, 'This room has closed.');
	}

	const member = await resolveMemberForSession(session, params.memberId, params.fallbackUserId);
	if (!member) {
		throw kitError(401, 'Join this room before sending chat messages.');
	}

	const body = normalizeChatBody(params.body);
	const state = asState(session);
	const seatColor =
		SEAT_COLORS.find((seat) => state.seats[seat].memberId === member.id) ??
		member.seat_color ??
		null;
	const authorRole: MemberRole = member.role === 'host' ? 'host' : seatColor ? 'player' : 'spectator';

	const { data, error } = await getPlayAdmin()
		.from(PLAY_TABLES.MESSAGES)
		.insert({
			session_id: session.id,
			member_id: member.id,
			author_display_name: member.display_name,
			author_role: authorRole,
			seat_color: seatColor,
			kind: 'user',
			body
		})
		.select('*')
		.single();

	if (error) {
		if (isMissingChatTable(error)) {
			const fallback = await getPlayAdmin()
				.from(PLAY_TABLES.EVENTS)
				.insert({
					session_id: session.id,
					revision: session.revision,
					actor_member_id: member.id,
					command_type: 'chatMessage',
					command_payload: {
						chatMessage: {
							memberId: member.id,
							authorDisplayName: member.display_name,
							authorRole,
							seatColor,
							kind: 'user',
							body
						}
					}
				})
				.select('id, actor_member_id, command_payload, created_at')
				.single();
			if (fallback.error) {
				throw kitError(500, `Failed to send chat message: ${fallback.error.message}`);
			}
			void updateLastSeen(member.id).catch(() => {});
			const message = chatMessageFromEventRow(fallback.data as SessionChatEventRow, session.room_code);
			if (!message) throw kitError(500, 'Failed to read chat message.');
			return message;
		}
		throw kitError(500, `Failed to send chat message: ${error.message}`);
	}

	void updateLastSeen(member.id).catch(() => {});
	return chatMessageFromRow(data as SessionMessageRow, session.room_code);
}

/**
 * Load the full, un-projected {@link PublicGameState} for a room. Unlike
 * {@link loadRoomView} (which returns an owner-gated spectator projection), this
 * returns the raw authoritative state — needed server-side by tools like the bot
 * driver that must trial-apply commands against the real reducer. Server-only.
 */
export async function loadRawRoomState(roomCode: string): Promise<PublicGameState> {
	const session = await getSessionByRoomCode(roomCode);
	if (!session) {
		throw kitError(404, 'Room not found.');
	}
	return asState(session);
}

export async function runRoomCommand(params: {
	roomCode: string;
	memberId: string | null;
	expectedRevision: number | null;
	command: GameCommand;
	fallbackUserId?: string | null;
}): Promise<RoomView> {
	const roomCode = normalizeRoomCode(params.roomCode);
	let member = params.memberId ? await getMemberById(params.memberId) : null;
	// Fallback: resolve a matchmade/authenticated player by user_id within this room
	// when they have no member cookie/id (or it didn't resolve to a member).
	if (!member && params.fallbackUserId) {
		const session = await getSessionByRoomCode(roomCode);
		if (session) {
			member = await getMemberBySessionAndUser(session.id, params.fallbackUserId);
		}
	}
	if (!member) {
		throw kitError(401, 'Session member not found for this room.');
	}

	const catalog = await loadPlayCatalog();

	// If the current phase already timed out, advance it BEFORE applying this command
	// (a late action then resolves against the correct, advanced phase). Host-independent.
	//
	// EXCEPT forceAdvancePhase: that command ALREADY advances exactly one phase on its own,
	// so pre-enforcing here would advance a SECOND time in the same request — enforcement
	// reveals navigation→location, then the command pushes location→cleanup, silently
	// skipping the location interaction. (This is the same double-advance the client-side
	// nav timeout used to cause.) A host's single "Force phase" click must map to a single
	// advance, so skip the leading enforcement for it and let the command do the one hop.
	if (params.command.type !== 'forceAdvancePhase') {
		await enforceRoomDeadlines(roomCode);
	}

	const MAX_ATTEMPTS = 6;

	// Optimistic-concurrency retry loop. Each attempt loads the freshest state,
	// applies the command against it, then persists with a DB compare-and-set. A
	// CAS miss means another player wrote concurrently — reload and re-apply. We
	// intentionally do NOT gate on the client-supplied expectedRevision: play is
	// simultaneous and clients trail the server by up to one ~1s SSE poll.
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		const session = await getSessionByRoomCode(roomCode);
		if (!session) {
			throw kitError(404, 'Room not found.');
		}
		if (member.session_id !== session.id) {
			throw kitError(401, 'Session member not found for this room.');
		}
		// A closed lobby is terminal — never let a late command (e.g. a stranded
		// host's "Start Game") revive it back to active/lobby.
		if (session.status === 'closed') {
			throw kitError(410, 'This lobby has closed.');
		}

		const state = asState(session);
		const actor = actorForMember(state, member);
		const commandResult: CommandResult = applyGameCommand(state, actor, params.command, catalog);
		if (!commandResult.ok) {
			throw kitError(400, commandResult.error.message);
		}

		// Stamp the deadline for the phase this command lands in (the pure reducer can't
		// read the clock; it nulls phaseDeadline on every phase entry). A command can
		// cross multiple phase entries (e.g. commitCleanup → next round's navigation), so
		// we stamp the FINAL phase here after the whole command resolves.
		const next = commandResult.state;
		stampPhaseDeadline(next);
		// A successful player action that opens/leaves a real choice pending (monster
		// reward, summon draw, Benefits claim, etc.) earns a fresh phase window. Otherwise
		// a long fight can consume the Location phase's entire grace budget and the next
		// poll force-passes a just-opened Arcane Summon before its owner can click it.
		if (actor.seatColor) refreshActiveChoiceDeadline(next, actor.seatColor, Date.now());
		// Early-finish grace: collapse the deadline to ~5s once everyone has locked
		// (restored if a seat backs out). Drives the navigation reveal via enforcement.
		applyNavLockDeadline(next);

		const persisted = await persistSessionUpdate({
			session,
			nextState: commandResult.state,
			actorMemberId: member.id,
			command: params.command
		});

		if (!persisted) {
			continue; // CAS conflict — reload fresh state and retry.
		}

		if (params.command.type === 'commitRound') {
			await writeHistorySnapshots(state, new Date().toISOString());
		}

		// The acting member just made a request → they're alive. This (plus the /view
		// poll in loadRoomView) is the only writer of last_seen_at, keeping it a
		// trustworthy per-player liveness signal. Best-effort + off the critical path:
		// don't make the player wait on a heartbeat write, and the next poll re-stamps it.
		void updateLastSeen(member.id).catch(() => {});

		// Project from the authoritative in-memory next-state we just persisted, with the
		// member's role/seat recomputed locally (the same rule syncMemberMirrors applies).
		// This drops a post-write SELECT round-trip that only re-read our own seat back —
		// meaningful latency for cross-region players on every command.
		const occupiedSeat =
			SEAT_COLORS.find((seat) => commandResult.state.seats[seat].memberId === member.id) ?? null;
		const updatedRole: MemberRole =
			member.role === 'host' ? 'host' : occupiedSeat ? 'player' : 'spectator';
		const projection = await attachBotSeatFlags(
			session.id,
			buildSessionProjection(commandResult.state, {
				role: updatedRole,
				seatColor: occupiedSeat ?? member.seat_color ?? null,
				displayName: member.display_name
			})
		);

		return {
			projection,
			member: {
				id: member.id,
				role: projection.viewer.role,
				seatColor: projection.viewer.seatColor,
				displayName: projection.viewer.displayName
			}
		};
	}

	throw kitError(409, 'This room is being updated by other players — please retry.');
}
