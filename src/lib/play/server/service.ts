import { error as kitError } from '@sveltejs/kit';
import {
	createLobbyState,
	applyGameCommand,
	deadlineBlockingSeats,
	refreshActiveChoiceDeadline,
	resolvePassedDeadline,
	buildSessionProjection,
	SEAT_MISSING_MESSAGE
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
import {
	commitRoomMutation,
	CommitNotReadyError,
	committedCmdMatches,
	findCommittedCmd,
	type CommitEvent
} from './commit';
import { computeRequiredEffects, drainEffectsOutbox, effectsOutboxEvent } from './effectsOutbox';
import { RankedFormationAbortError } from './formationAbort';
import { syncMemberMirrorsWith } from './memberMirrors';
import { ensureRoomMembership } from './membership';
import {
	canJoinFromWire,
	canListPublicly,
	canViewRoom,
	roomVisibility,
	type RoomVisibility
} from './roomAdmission';
import { admitCommand, httpIntegrityToolsAllowed } from './commandPolicy';
import { createWsTicket, sweepWsTickets, type WsTicketRole } from './wsTickets';

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
	/** Central admission: 'public' rooms are listable/joinable by policy; 'private'
	 *  rooms (ranked, matchmade, rematch) never leak to outsiders. Optional only for
	 *  rows predating the 20260710_identity_trust migration (normalized on read). */
	visibility?: RoomVisibility | null;
	created_at: string;
	started_at: string | null;
	ended_at: string | null;
	ranked_season_id?: string | null;
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
	/** The validated Supabase account (permanent or anonymous) that OWNS this
	 *  membership — the sole durable human principal. Null only for bots and for
	 *  quarantined legacy rows (see roomLifecycle 'security_upgrade'). */
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

/**
 * Whether the manual integrity tools (see commandPolicy.INTEGRITY_TOOLS) may be
 * admitted from external callers: NEVER in production — the shared gate in
 * commandPolicy.ts refuses NODE_ENV=production unconditionally; no environment
 * flag can override it. Every non-production stack (dev/e2e/bench) qualifies via
 * NODE_ENV alone.
 */
function integrityToolsAllowed(): boolean {
	return httpIntegrityToolsAllowed();
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

/** TRUSTED-ID lookup — for server-internal actors only (bot driving, ranked
 *  assembly, post-mint hydration). Wire input must NEVER reach this: external
 *  callers authenticate through {@link getMemberBySecret} exclusively. */
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
 * Resolve a session member by (session, validated user) — THE authentication rule.
 * The validated Supabase identity (permanent account or auto-created anonymous
 * account) is the sole durable human principal: there are no room secrets, no
 * member cookies, and the public member UUID never authorizes. Sign-out drops
 * authority instantly because every request re-resolves from the CURRENT user.
 * Quarantined legacy rows (user_id null) and bot rows can never resolve here.
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
		.eq('is_bot', false)
		.limit(1);
	if (error) {
		throw kitError(500, `Failed to resolve member by user: ${error.message}`);
	}
	const rows = (data as SessionMemberRow[] | null) ?? [];
	return rows[0] ?? null;
}

/** Read-only membership resolution also recognizes a human seat that has crossed
 * the ranked disconnect deadline and is now bot-controlled. The account may keep
 * watching its private match, but all command/write resolvers continue to use
 * getMemberBySessionAndUser (is_bot=false) and therefore cannot reclaim authority. */
async function getViewerMemberBySessionAndUser(
	sessionId: string,
	userId: string
): Promise<SessionMemberRow | null> {
	const { data, error } = await getPlayAdmin()
		.from(PLAY_TABLES.MEMBERS)
		.select('*')
		.eq('session_id', sessionId)
		.eq('user_id', userId)
		.limit(1);
	if (error) throw kitError(500, `Failed to resolve room viewer: ${error.message}`);
	return ((data as SessionMemberRow[] | null) ?? [])[0] ?? null;
}

/** Authenticate a caller within a session by their validated user identity. */
async function resolveMemberForSession(
	session: PlaySessionRow,
	userId?: string | null
): Promise<SessionMemberRow | null> {
	if (!userId) return null;
	return getMemberBySessionAndUser(session.id, userId);
}

/**
 * Route-edge authentication: resolve the validated account to the member it owns
 * WITHIN a room. Returns the trusted internal identity for handing to internal
 * helpers like botSim, or null when nothing authorizes — callers 401 on null.
 */
export async function authenticateRoomMember(
	roomCode: string,
	userId: string | null | undefined
): Promise<{ memberId: string; role: MemberRole } | null> {
	const session = await getSessionByRoomCode(normalizeRoomCode(roomCode));
	if (!session) return null;
	const member = await resolveMemberForSession(session, userId);
	return member ? { memberId: member.id, role: member.role } : null;
}

/**
 * Mint a short-lived, one-use, room-scoped WebSocket join ticket for the validated
 * caller (see wsTickets.ts). Members get a 'member' ticket bound to their exact
 * membership; an authenticated non-member gets a 'spectator' ticket ONLY for a room
 * they may view (private rooms answer 404 — their existence is not confirmed).
 * A ranked member whose disconnected seat is now bot-controlled may keep watching
 * the private match, but receives a spectator ticket with no command authority.
 */
export async function mintRoomWsTicket(
	roomCode: string,
	userId: string
): Promise<{ ticket: string; expiresAt: string; role: WsTicketRole }> {
	const session = await getSessionByRoomCode(normalizeRoomCode(roomCode));
	if (!session) throw kitError(404, 'Room not found.');
	const member = await getViewerMemberBySessionAndUser(session.id, userId);
	const facts = admissionFacts(session);
	if (!member && !canViewRoom(facts, false)) {
		throw kitError(404, 'Room not found.');
	}
	const liveMember = member && !member.is_bot ? member : null;
	const role: WsTicketRole = liveMember ? 'member' : 'spectator';
	// Opportunistic hygiene — dead ticket rows are swept on the mint path.
	await sweepWsTickets(getPlayAdmin()).catch(() => {});
	const minted = await createWsTicket(getPlayAdmin(), {
		sessionId: session.id,
		userId,
		memberId: liveMember?.id ?? null,
		role
	});
	return { ...minted, role };
}

/** The pure admission facts for a session row (visibility normalized). */
function admissionFacts(session: PlaySessionRow) {
	return {
		mode: session.mode === 'ranked' ? ('ranked' as const) : ('casual' as const),
		visibility: roomVisibility(session),
		status: session.status
	};
}

/** Stamp the truthful room metadata onto an outgoing projection (both transports
 *  do this — clients stay honest across reloads and cannot be lied to by caches). */
function stampRoomMeta(projection: SpectatorProjection, session: PlaySessionRow): SpectatorProjection {
	projection.mode = session.mode === 'ranked' ? 'ranked' : 'casual';
	projection.visibility = roomVisibility(session);
	projection.rated = session.mode === 'ranked';
	return projection;
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

	// The authoritative state is the SOLE seat authority: member.seat_color is only a
	// mirror and may lag a concurrent release/takeover — never consulted as a fallback.
	const seatColor =
		SEAT_COLORS.find((candidate) => state.seats[candidate].memberId === member.id) ?? null;

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
	// Shared, client-injected implementation (memberMirrors.ts) — the SAME side effect
	// now also runs on WebSocket-committed commands in the standalone room server, so
	// a claimSeat over WS can no longer leave the member row stale for the HTTP path.
	try {
		await syncMemberMirrorsWith(getPlayAdmin(), sessionId, state);
	} catch (err) {
		throw kitError(500, err instanceof Error ? err.message : 'Failed to update member mirror.');
	}
}

async function persistSessionUpdate(params: {
	session: PlaySessionRow;
	nextState: PublicGameState;
	actorMemberId: string | null;
	command: GameCommand;
	/** Durable idempotency key for player-issued commands (see commit.ts). */
	cmdId?: string | null;
}) {
	const { session, nextState, actorMemberId, command, cmdId } = params;

	// The shared durable commit (commit.ts): revision CAS + ledger append — the SAME
	// protocol the WebSocket room server commits through, so there is exactly one
	// authoritative history regardless of transport. REQUIRES the atomic
	// commit_room_command RPC (20260710_command_ledger migration); without it the
	// commit fails closed with a readiness error (503) rather than degrade to the
	// non-atomic fallback, which cannot promise exactly-once.
	const events: CommitEvent[] = [
		{
			commandType: command.type,
			payload: command,
			actorMemberId,
			revision: nextState.revision,
			cmdId: cmdId ?? null
		}
	];
	// Required post-commit side effects (member mirrors / match finalize / round
	// history) ride the SAME atomic commit as a durable outbox event, so a crash
	// between the commit and the effects can never lose them — recovery drains later.
	const outbox = effectsOutboxEvent(
		nextState.revision,
		computeRequiredEffects({
			prev: asState(session),
			next: nextState,
			command,
			session: {
				id: session.id,
				game_id: nextState.gameId,
				mode: session.mode,
				started_at: session.started_at,
				ended_at: session.ended_at
			},
			timestamp: new Date().toISOString()
		})
	);
	if (outbox) events.push(outbox);

	let outcome;
	try {
		outcome = await commitRoomMutation(getPlayAdmin(), {
			session: {
				id: session.id,
				revision: session.revision,
				started_at: session.started_at,
				ended_at: session.ended_at
			},
			nextState,
			events
		});
	} catch (err) {
		if (err instanceof CommitNotReadyError) {
			throw kitError(503, err.message);
		}
		throw kitError(500, err instanceof Error ? err.message : 'Failed to persist session.');
	}
	if (outcome.outcome === 'idempotency_conflict') {
		throw kitError(
			409,
			'Idempotency conflict: this cmdId was already used by a different actor or command.'
		);
	}
	if (outcome.outcome !== 'committed') {
		// CAS miss (another write landed between our load and update), or — vanishingly
		// rare — a concurrent duplicate of the same cmdId won first. Either way the
		// caller reloads fresh state; its per-attempt cmdId dedup then answers a
		// duplicate with the original result instead of re-applying.
		return null;
	}
	const data = outcome.row;

	// Attempt the owed effects now — acknowledgement follows this attempt, whose
	// durable record (the outbox event) committed atomically with the state. An
	// effect failure is logged and recovered by a later drain, never a lost effect
	// and never a failed request on top of an already-committed command.
	try {
		await drainEffectsOutbox(getPlayAdmin(), getHistoryAdmin(), session.id, nextState);
	} catch (err) {
		console.error(
			'[effects] post-commit outbox drain failed (recovered on a later drain):',
			err instanceof Error ? err.message : err
		);
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
	members: {
		display_name: string | null;
		last_seen_at: string;
		is_bot?: boolean | null;
		user_id?: string | null;
	}[]
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
		),
		// Legacy human memberships with no owning account have no safe claim path under
		// the account trust model — the room is quarantined (closed) for security upgrade.
		hasUnownedHumans: members.some((m) => !(m.is_bot ?? false) && m.user_id == null)
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
	if (reason === 'abandoned' && session.status === 'active' && session.mode === 'ranked' && session.ranked_season_id) {
		const abandonment = await getPlayAdmin().rpc('finalize_ranked_abandonment', { p_session_id: session.id });
		if (abandonment.error) {
			throw kitError(503, 'Could not durably record ranked abandonment; room closure will retry.');
		}
	}
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

/** One service-role RPC owns the disconnect deadline, participation ledger,
 * bot handoff, room revision, and system event atomically. A migration gap is an
 * integrity failure for a live ranked match and therefore fails closed. */
async function maybeTakeOverRankedDisconnects(session: PlaySessionRow): Promise<PlaySessionRow> {
	if (session.status !== 'active' || session.mode !== 'ranked' || !session.ranked_season_id) {
		return session;
	}
	const takeover = await getPlayAdmin().rpc('takeover_stale_ranked_members', {
		p_session_id: session.id
	});
	if (takeover.error) {
		throw kitError(503, 'Ranked disconnect integrity is unavailable; retrying is safe.');
	}
	const takenOver = Number((takeover.data as { takenOver?: number } | null)?.takenOver ?? 0);
	if (takenOver === 0) return session;
	return (await getSessionByRoomCode(session.room_code)) ?? session;
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
	members?: {
		display_name: string | null;
		last_seen_at: string;
		is_bot?: boolean | null;
		user_id?: string | null;
	}[]
): Promise<PlaySessionRow> {
	if (session.status !== 'lobby' && session.status !== 'active') return session;
	const priorRevision = session.revision;
	session = await maybeTakeOverRankedDisconnects(session);
	const memberRows = members && session.revision === priorRevision
		? members
		: await getMembersForSession(session.id);
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
		.select('session_id, display_name, last_seen_at, is_bot, user_id')
		.in('session_id', ids);
	if (memberError) {
		throw kitError(500, `Failed to sweep room members: ${memberError.message}`);
	}

	type LiteMember = {
		session_id: string;
		display_name: string | null;
		last_seen_at: string;
		is_bot: boolean | null;
		user_id: string | null;
	};
	const bySession = new Map<string, LiteMember[]>();
	for (const row of (memberData as LiteMember[] | null) ?? []) {
		const list = bySession.get(row.session_id);
		if (list) list.push(row);
		else bySession.set(row.session_id, [row]);
	}

	for (const room of rooms) {
		await maybeCloseRoom(room, bySession.get(room.id) ?? []);
	}
}

export async function createRoom(
	displayName: string,
	userId: string | null | undefined,
	mode: PlayMode = 'casual',
	opts?: { visibility?: RoomVisibility; originOp?: string | null; rankedSeasonId?: string | null }
): Promise<{ roomCode: string; memberId: string }> {
	if (!userId) {
		// Validated identity is the sole human principal — the client creates an
		// anonymous account first (auth.resolvePlayIdentity), so this only fires for
		// unauthenticated raw API calls.
		throw kitError(401, 'Sign in (a guest identity is created automatically) to create a room.');
	}
	const originOp = normalizeEntryOp(opts?.originOp);
	// ENTRY-OP IDEMPOTENCY: a retry carrying the same op id (a client resolving an
	// AMBIGUOUS COMMIT — the request may have committed while the response never
	// arrived) resolves to the room the op already created instead of minting a
	// second one. Owner-checked: the op's session must carry the caller's own
	// membership (op ids are unguessable, but never trusted as authorization).
	if (originOp) {
		const prior = await findSessionByOriginOp(originOp);
		if (prior) {
			const mine = await getMemberBySessionAndUser(prior.id, userId);
			if (!mine) throw kitError(409, 'This operation id belongs to a different account.');
			return { roomCode: prior.room_code, memberId: mine.id };
		}
	}
	const catalog = await loadPlayCatalog();
	const normalizedName = normalizeDisplayName(displayName);
	// Ranked/matchmade parties are private by default; casual rooms are public.
	const visibility: RoomVisibility = opts?.visibility ?? (mode === 'ranked' ? 'private' : 'public');

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
				mode,
				visibility,
				origin_op: originOp,
				ranked_season_id: opts?.rankedSeasonId ?? null
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
		let membership;
		try {
			membership = await ensureRoomMembership(getPlayAdmin(), {
				sessionId: createdSession.id,
				userId,
				displayName: normalizedName,
				role: 'host'
			});
		} catch (err) {
			// COMPENSATE: the session row landed but its host membership did not — a
			// member-less lobby would be an orphan room nobody owns. Nothing else
			// references the brand-new session yet, so delete it outright; if even
			// the delete fails, the abandoned-game reaper still covers the shell
			// (logged loudly, never silently ignored).
			try {
				const cleanup = await getPlayAdmin()
					.from(PLAY_TABLES.SESSIONS)
					.delete()
					.eq('id', createdSession.id);
				if (cleanup.error) throw new Error(cleanup.error.message);
			} catch (cleanupErr) {
				console.error(
					'[play] failed to delete orphan session after membership failure:',
					cleanupErr
				);
			}
			throw kitError(
				500,
				err instanceof Error ? err.message : 'Failed to create host membership.'
			);
		}

		// TOMBSTONE RE-CHECK, strictly AFTER the commit: an abandon for this op that
		// raced AHEAD of this (in-flight) create wins in every ordering — the
		// abandon tombstoned first, and this re-check self-compensates the room the
		// late commit just made. The caller was aborted client-side; the returned
		// view is discarded there.
		if (originOp && (await entryOpTombstoned(originOp))) {
			await compensateEntryOp(originOp, userId);
		}

		return { roomCode, memberId: membership.memberId };
	}

	throw kitError(500, 'Failed to generate a unique room code.');
}

/**
 * Leave a room as the validated account — the compensation half of an ABANDONED
 * room entry (the client unmounted/cancelled while its create/solo/join round-trip
 * was in flight and the server-side effect landed anyway). Idempotent and safe to
 * call for rooms the caller never entered:
 *
 *   - No membership → no-op.
 *   - LOBBY: a held seat is released first (the seat map must never point at a
 *     deleted membership), then the caller's membership row is deleted — it is
 *     seconds old and unreferenced. The delete happens ONLY after the release is
 *     proven: the reducer's explicit "no claimed seat" rejection means the member
 *     was already unseated (proceed), while any other release failure (transient
 *     command/CAS/store error, a room racing out of lobby) FAILS CLOSED with seat
 *     and membership left coherent for a retry. A lobby left with NO human member
 *     is closed immediately instead of aging out as an orphan.
 *   - ACTIVE: memberships are NOT deleted (a started seat must never become an
 *     unauthorized ghost). Only when the caller is the SOLE human (the aborted
 *     solo lane) is the room closed outright; otherwise presence rules own the
 *     outcome.
 *   - finished/closed: terminal — no-op.
 */
/** True only for the releaseSeat reducer's explicit "no claimed seat" rejection
 *  (rethrown by runRoomCommand as an HTTP 400 whose body carries the reducer
 *  message). Everything else — CAS exhaustion, store errors, a room that raced
 *  out of lobby (seat_locked) — is NOT benign for leaveRoomAsUser. */
function isSeatMissingRejection(err: unknown): boolean {
	const body = (err as { status?: number; body?: { message?: string } })?.body;
	return (
		(err as { status?: number })?.status === 400 &&
		typeof body?.message === 'string' &&
		body.message === SEAT_MISSING_MESSAGE
	);
}

export async function leaveRoomAsUser(
	roomCode: string,
	userId: string | null
): Promise<{ left: boolean; closed: boolean }> {
	if (!userId) {
		throw kitError(401, 'Sign in (a guest identity is created automatically) to leave a room.');
	}
	const session = await getSessionByRoomCode(normalizeRoomCode(roomCode));
	if (!session) return { left: false, closed: false };
	const admin = getPlayAdmin();
	const memberRes = await admin
		.from(PLAY_TABLES.MEMBERS)
		.select('id')
		.eq('session_id', session.id)
		.eq('user_id', userId)
		.eq('is_bot', false)
		.limit(1);
	if (memberRes.error) {
		throw kitError(500, `Failed to resolve membership: ${memberRes.error.message}`);
	}
	const memberId = (((memberRes.data as { id: string }[] | null) ?? [])[0]?.id ?? null) as
		| string
		| null;
	if (!memberId) return { left: false, closed: false };

	if (session.status === 'lobby') {
		try {
			await runRoomCommand({
				roomCode: session.room_code,
				trustedMemberId: memberId,
				expectedRevision: null,
				command: { type: 'releaseSeat' }
			});
		} catch (err) {
			// ONLY the reducer's explicit "no claimed seat" rejection is benign (the
			// common abandoned-entry case: the member never sat down — nothing to
			// release, already-unseated members keep leaving exactly as before).
			// EVERYTHING else fails CLOSED: a transient command/CAS/store failure
			// here means the seat map may still point at this membership, and
			// deleting the row anyway would strand a GHOST SEAT (a claimed seat
			// whose member no longer exists — unrecoverable by any later actor).
			// Seat + membership stay coherent; the caller may simply retry.
			if (!isSeatMissingRejection(err)) throw err;
		}
		const del = await admin
			.from(PLAY_TABLES.MEMBERS)
			.delete()
			.eq('id', memberId)
			.eq('is_bot', false);
		if (del.error) throw kitError(500, `Failed to leave room: ${del.error.message}`);
		const remaining = await admin
			.from(PLAY_TABLES.MEMBERS)
			.select('id', { count: 'exact', head: true })
			.eq('session_id', session.id)
			.eq('is_bot', false);
		if (remaining.error) {
			throw kitError(500, `Failed to count remaining members: ${remaining.error.message}`);
		}
		if ((remaining.count ?? 0) === 0) {
			const fresh = await getSessionByRoomCode(session.room_code);
			if (fresh && fresh.status === 'lobby') await closeRoomSession(fresh, 'abandoned');
			return { left: true, closed: true };
		}
		return { left: true, closed: false };
	}

	if (session.status === 'active') {
		const humans = await admin
			.from(PLAY_TABLES.MEMBERS)
			.select('id', { count: 'exact', head: true })
			.eq('session_id', session.id)
			.eq('is_bot', false);
		if (humans.error) {
			throw kitError(500, `Failed to count human members: ${humans.error.message}`);
		}
		if ((humans.count ?? 0) === 1) {
			await closeRoomSession(session, 'abandoned');
			return { left: true, closed: true };
		}
		return { left: false, closed: false };
	}

	return { left: false, closed: false };
}

// ── Entry-op abort compensation (create / solo / join) ─────────────────────────
// See supabase/migrations/20260712_entry_op_compensation.sql. The client mints an
// unguessable op id BEFORE sending a create/solo/join, so an ABORTED request can
// be compensated even when its response never arrived (ambiguous commit): the
// abandon path tombstones the op, then resolves exactly what the op created —
// the session stamped with origin_op, or the membership stamped with it — and
// leaves/closes precisely that. The create/join paths re-check the tombstone
// AFTER committing, so an abandon racing AHEAD of the in-flight request still
// wins. A pre-existing membership never carries the op's stamp and can never be
// resolved (or removed) through it.

const ENTRY_OP_CANCELLATIONS = 'play_entry_op_cancellations';
const ENTRY_OP_PATTERN = /^peo_[A-Za-z0-9_-]{43}$/;

/** Validate a client-supplied entry-op id; anything malformed is ignored (the
 *  legacy no-op-id behavior applies). Never trusted as authorization. */
export function normalizeEntryOp(value: unknown): string | null {
	return typeof value === 'string' && ENTRY_OP_PATTERN.test(value) ? value : null;
}

function isMissingRelation(error: { code?: string; message?: string }): boolean {
	return (
		error.code === '42P01' ||
		/relation .* does not exist|could not find the table/i.test(error.message ?? '')
	);
}

/** The session a create/solo entry-op already created, if any (idempotent-replay
 *  resolution for an ambiguous commit). Missing-column = migration lag: behave
 *  as if the op never committed (the pre-contract posture). */
async function findSessionByOriginOp(opId: string): Promise<PlaySessionRow | null> {
	const res = await getPlayAdmin()
		.from(PLAY_TABLES.SESSIONS)
		.select('*')
		.eq('origin_op', opId)
		.maybeSingle();
	if (res.error) {
		if (isMissingColumn(res.error)) return null;
		throw kitError(500, `Entry-op session lookup failed: ${res.error.message}`);
	}
	return (res.data as PlaySessionRow | null) ?? null;
}

/** Whether an entry-op has been abandoned. Store errors THROW (a silently-missed
 *  tombstone would resurrect an abandoned op's room); a store that predates the
 *  tombstone table keeps the pre-contract behavior, loudly logged. */
async function entryOpTombstoned(opId: string): Promise<boolean> {
	const res = await getPlayAdmin()
		.from(ENTRY_OP_CANCELLATIONS)
		.select('op_id')
		.eq('op_id', opId)
		.maybeSingle();
	if (res.error) {
		if (isMissingRelation(res.error)) {
			console.error(
				'[play] play_entry_op_cancellations missing (apply 20260712_entry_op_compensation.sql); ' +
					'entry-op abort compensation disabled until then.'
			);
			return false;
		}
		throw kitError(500, `Entry-op lookup failed: ${res.error.message}`);
	}
	return res.data != null;
}

/**
 * Abandon an entry operation: the authenticated owner's aborted create/solo/join
 * must be resolvable WITHOUT its response. Tombstones the op id FIRST (so an
 * enqueue still in flight self-compensates on its post-commit re-check, whatever
 * the arrival order), then compensates whatever the op already created.
 * Idempotent; safe to call for ops that never committed anything.
 */
export async function abandonEntryOp(
	opId: string,
	userId: string | null
): Promise<{ compensated: 'none' | 'room' | 'membership' }> {
	if (!userId) {
		throw kitError(401, 'Sign in (a guest identity is created automatically) first.');
	}
	const normalized = normalizeEntryOp(opId);
	if (!normalized) return { compensated: 'none' };

	const admin = getPlayAdmin();
	const tombstone = await admin
		.from(ENTRY_OP_CANCELLATIONS)
		.upsert(
			{ op_id: normalized, user_id: userId, cancelled_at: new Date().toISOString() },
			{ onConflict: 'op_id' }
		);
	if (tombstone.error) {
		if (isMissingRelation(tombstone.error)) {
			console.error(
				'[play] play_entry_op_cancellations missing (apply 20260712_entry_op_compensation.sql); ' +
					'abandoning without a tombstone.'
			);
		} else {
			// FAIL-CLOSED: without the tombstone a still-in-flight request could land
			// AFTER this abandon and never be compensated — make the caller retry.
			throw kitError(500, `Failed to abandon operation: ${tombstone.error.message}`);
		}
	}

	return compensateEntryOp(normalized, userId);
}

/** Resolve + unwind what an entry-op created (shared by abandonEntryOp and the
 *  post-commit tombstone re-checks in createRoom/joinRoom). */
async function compensateEntryOp(
	opId: string,
	userId: string
): Promise<{ compensated: 'none' | 'room' | 'membership' }> {
	const admin = getPlayAdmin();

	// A SESSION this op created (create / solo): leave it as the owner —
	// lobby: seat released + membership deleted + close-if-empty; active solo:
	// sole-human close. Ownership is enforced naturally: leaveRoomAsUser acts on
	// the CALLER's own membership only.
	const sess = await admin
		.from(PLAY_TABLES.SESSIONS)
		.select('room_code')
		.eq('origin_op', opId)
		.maybeSingle();
	if (sess.error && !isMissingColumn(sess.error)) {
		throw kitError(500, `Entry-op session lookup failed: ${sess.error.message}`);
	}
	const roomCode = (sess.data as { room_code?: string } | null)?.room_code;
	if (roomCode) {
		await leaveRoomAsUser(roomCode, userId);
		return { compensated: 'room' };
	}

	// A MEMBERSHIP this op created (join). Only a row stamped with exactly this op
	// AND owned by the caller can match — a pre-existing membership is untouchable.
	const mem = await admin
		.from(PLAY_TABLES.MEMBERS)
		.select('id, session_id')
		.eq('origin_op', opId)
		.eq('user_id', userId)
		.eq('is_bot', false)
		.maybeSingle();
	if (mem.error && !isMissingColumn(mem.error)) {
		throw kitError(500, `Entry-op membership lookup failed: ${mem.error.message}`);
	}
	const memberRow = mem.data as { id: string; session_id: string } | null;
	if (!memberRow) return { compensated: 'none' };

	const sessionRes = await admin
		.from(PLAY_TABLES.SESSIONS)
		.select('*')
		.eq('id', memberRow.session_id)
		.maybeSingle();
	if (sessionRes.error) {
		throw kitError(500, `Entry-op session load failed: ${sessionRes.error.message}`);
	}
	const session = sessionRes.data as PlaySessionRow | null;
	if (!session) return { compensated: 'none' };

	if (session.status === 'lobby') {
		// The normal leave path: seat released (fail-closed), membership deleted,
		// lobby closed when the last human departs.
		await leaveRoomAsUser(session.room_code, userId);
		return { compensated: 'membership' };
	}

	if (session.status === 'active') {
		// A join aborted into an ACTIVE room: the op-created membership is a fresh,
		// UNSEATED row (seats lock at start) — delete exactly it, even when other
		// humans remain. A seat somehow held in game state keeps the membership
		// (deleting it would ghost the seat); the standard leave rules own that.
		const state = asState(session);
		const holdsSeat = Object.values(state.seats ?? {}).some(
			(seat) => seat?.memberId === memberRow.id
		);
		if (!holdsSeat) {
			const del = await admin
				.from(PLAY_TABLES.MEMBERS)
				.delete()
				.eq('id', memberRow.id)
				.eq('is_bot', false);
			if (del.error) {
				throw kitError(500, `Entry-op membership delete failed: ${del.error.message}`);
			}
			return { compensated: 'membership' };
		}
		await leaveRoomAsUser(session.room_code, userId);
		return { compensated: 'membership' };
	}

	return { compensated: 'none' };
}

/** PostgREST "column does not exist" (migration-lag posture for origin_op). */
function isMissingColumn(error: { code?: string; message?: string }): boolean {
	return (
		error.code === '42703' || /column .* does not exist|could not find/i.test(error.message ?? '')
	);
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
 * Create a STARTED matchmade game for an already-paired group. Reuses the normal
 * lobby primitives: the first player hosts a PRIVATE room, the rest join + claim
 * distinct seats + pick distinct guardians, then the host starts the game. Returns
 * the room code and a memberId-by-userId map so the matchmaker can stamp each queue
 * row's claimed_session_id.
 *
 * `mode` is decided by the matchmaker: 'ranked' ONLY when every human in the party
 * has a permanent verified identity — an anonymous guest is never represented as a
 * verified ranked identity, so a party containing one plays a casual, unrated
 * matchmade game instead. Either way the room is private (never browsable).
 *
 * Throws on failure. Once a session row exists, every failure is rethrown as a
 * {@link RankedFormationAbortError} telling the caller whether the partial room
 * was VERIFIED closed — only then may the claimed queue rows re-enter the pool
 * (an unconfirmed close must hold them out until recovery closes it for real).
 */
export async function createRankedSession(
	players: RankedPlayer[],
	mode: PlayMode = 'ranked',
	rankedSeasonId: string | null = null
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

	// 1) First player (a human) hosts the private matchmade room.
	const created = await createRoom(host.displayName, host.userId, mode, {
		visibility: 'private', rankedSeasonId: mode === 'ranked' ? rankedSeasonId : null
	});
	const roomCode = created.roomCode;
	const memberIdByUserId: Record<string, string> = { [host.userId]: created.memberId };

	// Resolve the session id for the new room (for claimed_session_id stamping).
	const session = await getSessionByRoomCode(normalizeRoomCode(roomCode));
	if (!session) throw kitError(500, 'Ranked room vanished immediately after creation.');

	try {
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
									? {
											isBot: true,
											botProfile: player.botProfile ?? DEFAULT_BOT_PROFILE_KEY,
											admission: 'internal'
										}
									: { admission: 'internal' }
							)
						).memberId;
			if (i !== 0) memberIdByUserId[player.userId] = memberId;

			await runRoomCommand({
				roomCode,
				trustedMemberId: memberId,
				expectedRevision: null,
				command: { type: 'claimSeat', seatColor: seat }
			});

			// Distinct, unused guardian from the live pool.
			const state = await loadRawRoomState(roomCode);
			const used = new Set(
				SEAT_COLORS.map((s) => state.seats[s]?.selectedGuardian).filter(
					(g): g is string => g != null
				)
			);
			const guardian = state.guardianPool.find((name) => !used.has(name));
			if (guardian) {
				await runRoomCommand({
					roomCode,
					trustedMemberId: memberId,
					expectedRevision: null,
					command: { type: 'selectGuardian', guardianName: guardian }
				});
			}
		}

		// 3) Host starts the game now that the lobby is full.
		await runRoomCommand({
			roomCode,
			trustedMemberId: created.memberId,
			expectedRevision: null,
			command: { type: 'startGame' }
		});

		return { roomCode, sessionId: session.id, memberIdByUserId };
	} catch (err) {
		// ATOMIC ABORT: a failed formation must not leave a half-seated/half-started
		// room OPEN — releasing the claimed queue rows while the shell lives would
		// let these players re-match while still holding live memberships in it
		// (duplicate membership across sessions). Close the just-created session
		// under the revision CAS, VERIFYING that a row actually changed (a zero-row
		// CAS outcome is a lost race, not success — reload and retry; an
		// already-closed reload counts as done). Member rows remain as historical
		// rows of a CLOSED private room (never listed, never joinable, ledger
		// references intact). The caller learns EXACTLY where the abort stands via
		// RankedFormationAbortError: `closed` true means the shell is durably gone
		// and the queue claim may re-enter the pool; false means it must NOT be
		// released until a later recovery confirms the close.
		let closed = false;
		try {
			for (let attempt = 0; attempt < 3 && !closed; attempt++) {
				const current = await getPlayAdmin()
					.from(PLAY_TABLES.SESSIONS)
					.select('*')
					.eq('id', session.id)
					.maybeSingle();
				if (current.error) throw new Error(current.error.message);
				const row = current.data as PlaySessionRow | null;
				if (!row || row.status === 'closed') {
					closed = true;
					break;
				}
				// closeRoomSession CAS-closes and returns null on a lost race — loop
				// reloads the advanced revision and tries again.
				if ((await closeRoomSession(row, 'abandoned')) != null) closed = true;
			}
		} catch (abortErr) {
			console.error('[play] failed to close aborted formation room', session.id, abortErr);
		}
		if (!closed) {
			console.error(
				'[play] aborted formation room could NOT be confirmed closed',
				session.id,
				'- claim must be held out of the pool until recovery closes it'
			);
		}
		throw new RankedFormationAbortError(session.id, closed, err);
	}
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
	spiritId?: string,
	userId?: string | null
): Promise<{ roomCode: string; memberId: string }> {
	if (!userId) {
		throw kitError(401, 'Sign in (a guest identity is created automatically) to spawn a debug room.');
	}
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

	let memberId: string;
	try {
		memberId = (
			await ensureRoomMembership(getPlayAdmin(), {
				sessionId,
				userId,
				displayName: normalizedName,
				role: 'host'
			})
		).memberId;
	} catch (err) {
		throw kitError(500, err instanceof Error ? err.message : 'Failed to create debug host.');
	}

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
	opts?: {
		isBot?: boolean;
		botProfile?: string | null;
		/**
		 * 'wire' (default): an external caller — the central admission policy applies
		 * (validated identity required; private/ranked rooms admit ONLY someone who is
		 * already a member, idempotently). 'internal': server-side assembly (matchmaker
		 * seating, bot fill, rematch convergence) that already made its own decision.
		 */
		admission?: 'wire' | 'internal';
		/** Client-minted ENTRY-OP id (abort-compensation contract): stamped on the
		 *  membership ONLY when this join CREATES it, so an abandoned op resolves
		 *  exactly the row it added — never a pre-existing membership. */
		originOp?: string | null;
	}
): Promise<{ memberId: string; created: boolean }> {
	const isBot = opts?.isBot ?? false;
	const admission = opts?.admission ?? 'wire';
	if (admission === 'wire' && isBot) {
		throw kitError(403, 'Bots are server-managed and cannot join over the wire.');
	}
	if (!isBot && !userId) {
		throw kitError(401, 'Sign in (a guest identity is created automatically) to join a room.');
	}

	let session = await getSessionByRoomCode(normalizeRoomCode(roomCode));
	if (!session) {
		throw kitError(404, 'Room not found.');
	}
	// Close the room first if it's already due (expired/abandoned), so a stale row
	// can't accept a joiner a beat before it would have been reaped.
	session = await maybeCloseRoom(session);

	const facts = admissionFacts(session);
	// Idempotent recovery: the caller's existing membership always resolves, even in
	// a private/finished room — a repeat join can never fail them out of their game.
	const existing = !isBot && userId ? await getMemberBySessionAndUser(session.id, userId) : null;
	if (existing) {
		return { memberId: existing.id, created: false };
	}

	if (admission === 'wire' && !canJoinFromWire(facts, false)) {
		// A hidden room's existence is never confirmed to outsiders.
		if (facts.visibility === 'private') throw kitError(404, 'Room not found.');
		throw kitError(410, 'This room is no longer open to join.');
	}
	if (session.status === 'closed' || session.status === 'finished') {
		throw kitError(410, 'This room is no longer open to join.');
	}

	const originOp = normalizeEntryOp(opts?.originOp);
	let membership;
	try {
		membership = await ensureRoomMembership(getPlayAdmin(), {
			sessionId: session.id,
			userId: userId ?? null,
			displayName: normalizeDisplayName(displayName),
			role: 'spectator',
			isBot,
			botProfile: opts?.botProfile ?? null,
			originOp
		});
	} catch (err) {
		throw kitError(500, err instanceof Error ? err.message : 'Failed to join room.');
	}

	// TOCTOU guard: another request may have closed the room between the status check
	// and this insert. If it went terminal, roll back the orphaned membership so a
	// closed room never carries a live member (the "open only while present" invariant).
	if (membership.created) {
		const fresh = await getSessionByRoomCode(session.room_code);
		if (fresh && (fresh.status === 'closed' || fresh.status === 'finished')) {
			await getPlayAdmin().from(PLAY_TABLES.MEMBERS).delete().eq('id', membership.memberId);
			throw kitError(410, 'This room is no longer open to join.');
		}
	}

	// TOMBSTONE RE-CHECK, strictly AFTER the commit (created memberships only): an
	// abandon for this op that raced AHEAD of this in-flight join wins in every
	// ordering — it tombstoned first, so the late commit self-compensates exactly
	// the membership it just added (a reused pre-existing membership carries a
	// different/no stamp and is untouchable through this op).
	if (membership.created && originOp && userId && (await entryOpTombstoned(originOp))) {
		await compensateEntryOp(originOp, userId);
	}

	return { memberId: membership.memberId, created: membership.created };
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
	// `select('*')` keeps this readable on pre-migration rows (no `visibility` column
	// yet); visibility is normalized in code either way.
	const { data, error } = await admin
		.from(PLAY_TABLES.SESSIONS)
		.select('*')
		.in('status', ['lobby', 'active'])
		.order('created_at', { ascending: false })
		.limit(60);

	if (error) {
		throw kitError(500, `Failed to list rooms: ${error.message}`);
	}

	// Central admission: ONLY public casual rooms are browsable. Ranked, matchmade
	// and rematch rooms are private and never leak through the public list.
	const rows = ((data as PlaySessionRow[] | null) ?? []).filter((row) =>
		canListPublicly(admissionFacts(row))
	);
	if (rows.length === 0) return [];

	// One batched query resolves both the host name and lobby presence (avoids N+1).
	const sessionIds = rows.map((r) => r.id);
	const { data: memberRows, error: memberError } = await admin
		.from(PLAY_TABLES.MEMBERS)
		.select('session_id, display_name, role, last_seen_at, is_bot, user_id')
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
		user_id: string | null;
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
			const facts = admissionFacts(row);
			return {
				roomCode: row.room_code,
				status: row.status,
				mode: facts.mode,
				visibility: facts.visibility,
				rated: facts.mode === 'ranked',
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

/**
 * Viewer identity for a view/command entry point. Exactly one of the two id paths:
 *  - `userId` — the VALIDATED Supabase account from the wire (session cookie or
 *    Bearer token, verified by safeGetSession). The sole external principal.
 *  - `trustedMemberId` — a server-internal actor id (bot driving, post-mint
 *    hydration). MUST NOT be fed from request input: public member ids are
 *    non-authorizing by contract.
 */
export interface RoomViewer {
	userId?: string | null;
	trustedMemberId?: string | null;
}

export async function loadRoomView(roomCode: string, viewer: RoomViewer = {}): Promise<RoomView> {
	let session = await getSessionByRoomCode(roomCode);
	if (!session) {
		throw kitError(404, 'Room not found.');
	}

	// Opportunistic, host-independent enforcement: every connected client's ~1s SSE
	// poll (and the page-load path) advances a phase that has run past its deadline,
	// so a silent/disconnected seat can't stall the game. Cheap no-op when not due.
	session = await maybeEnforceDeadline(session);
	session = await maybeTakeOverRankedDisconnects(session);

	const rawMember = viewer.trustedMemberId
		? await getMemberById(viewer.trustedMemberId)
		: viewer.userId
			? await getViewerMemberBySessionAndUser(session.id, viewer.userId)
			: null;
	const member = rawMember && rawMember.session_id === session.id ? rawMember : null;

	// Central admission: a private room (ranked/matchmade/rematch) exists only for
	// its members — outsiders get 404 through view/spectate exactly like browse/join.
	if (!canViewRoom(admissionFacts(session), member != null)) {
		throw kitError(404, 'Room not found.');
	}
	// Stamp THIS member's liveness BEFORE the room-close check, so an actively
	// polling member always counts as present — an `abandoned` close can never fire
	// out from under someone who is here. (An `expired` lobby still closes regardless.)
	if (member && !member.is_bot) {
		await updateLastSeen(member.id);
	}

	// Opportunistic, host-independent close: reap this room if it's a lobby that aged
	// out (≥30 min, never started) or a lobby/active game that was abandoned (no human
	// present). No-op for finished/closed sessions. On close the revision bumps, so the
	// SSE poll pushes the `closed` snapshot and the client bounces out of the room.
	session = await maybeCloseRoom(session);

	const state = asState(session);
	const viewerContext = member?.is_bot && viewer.userId
		? { role: 'spectator' as const, seatColor: null, displayName: member.display_name }
		: viewerForMember(state, member);
	const projection = stampRoomMeta(
		await attachBotSeatFlags(
			session.id,
			buildSessionProjection(state, viewerContext)
		),
		session
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
	userId?: string | null;
	after?: string | null;
	limit?: number | null;
}): Promise<RoomChatMessage[]> {
	const session = await getSessionByRoomCode(params.roomCode);
	if (!session) {
		throw kitError(404, 'Room not found.');
	}

	const member = params.userId
		? await getViewerMemberBySessionAndUser(session.id, params.userId)
		: null;
	// Private rooms don't leak through chat either — members only.
	if (!canViewRoom(admissionFacts(session), member != null)) {
		throw kitError(404, 'Room not found.');
	}
	if (member && !member.is_bot) {
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
	userId?: string | null;
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

	const member = await resolveMemberForSession(session, params.userId);
	if (!member) {
		// A private room never confirms its existence to outsiders.
		if (!canViewRoom(admissionFacts(session), false)) throw kitError(404, 'Room not found.');
		throw kitError(401, 'Join this room before sending chat messages.');
	}

	const body = normalizeChatBody(params.body);
	const state = asState(session);
	const seatColor =
		SEAT_COLORS.find((seat) => state.seats[seat].memberId === member.id) ?? null;
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
	/** VALIDATED Supabase user from the wire (session cookie / Bearer). The command
	 *  admission policy applies to this path — it is the external boundary. */
	userId?: string | null;
	/** Server-internal trusted actor (bot driving, ranked assembly, solo seeding).
	 *  NEVER pass request-derived values here — public ids do not authorize. */
	trustedMemberId?: string | null;
	expectedRevision: number | null;
	command: GameCommand;
	/**
	 * Client-generated idempotency key for this LOGICAL action. A retry carrying the
	 * same cmdId after a lost response — including a WebSocket→HTTP fallback retry —
	 * is answered from the durable command ledger with the original result instead of
	 * a second application. Optional: legacy clients without one behave as before.
	 */
	cmdId?: string | null;
}): Promise<RoomView> {
	const roomCode = normalizeRoomCode(params.roomCode);
	// Wire callers (userId) pass through the deny-by-default admission policy below;
	// trusted internal actors (bot driver, matchmaker assembly, solo seeding) do not.
	const isWire = !params.trustedMemberId;
	let member: SessionMemberRow | null = null;
	if (params.trustedMemberId) {
		member = await getMemberById(params.trustedMemberId);
	} else if (params.userId) {
		const session = await getSessionByRoomCode(roomCode);
		if (session) {
			const current = await maybeTakeOverRankedDisconnects(session);
			member = await getMemberBySessionAndUser(current.id, params.userId);
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

		// Durable exactly-once boundary: if this cmdId already committed (a retry after
		// a lost ack — same transport or a WS→HTTP fallback), answer with the CURRENT
		// authoritative view instead of applying the command a second time. Checked on
		// every attempt so a CAS-miss retry re-reads the ledger the winner just wrote.
		// IDENTITY-BOUND: only an honest retry (same actor + command type + payload as
		// the committed original) is a duplicate; a re-used cmdId with a different
		// identity is a stable 409 idempotency conflict, never a silent substitution.
		if (params.cmdId) {
			const committed = await findCommittedCmd(getPlayAdmin(), session.id, params.cmdId).catch(
				(err: unknown) => {
					throw kitError(500, err instanceof Error ? err.message : 'Command lookup failed.');
				}
			);
			if (committed) {
				if (
					!committedCmdMatches(committed, {
						commandType: params.command.type,
						payload: params.command,
						actorMemberId: member.id,
						revision: committed.revision,
						cmdId: params.cmdId
					})
				) {
					throw kitError(
						409,
						'Idempotency conflict: this cmdId was already used by a different actor or command.'
					);
				}
				// Recovery drain: the original writer may have died after its commit but
				// before its required side effects — finish them before answering.
				try {
					await drainEffectsOutbox(getPlayAdmin(), getHistoryAdmin(), session.id, asState(session));
				} catch (err) {
					console.error(
						'[effects] duplicate-retry outbox drain failed (recovered later):',
						err instanceof Error ? err.message : err
					);
				}
				return viewForMemberAndState(session, asState(session), member);
			}
		}

		const state = asState(session);
		const actor = actorForMember(state, member);

		// Deny-by-default command admission for EXTERNAL callers (same policy the WS
		// room server enforces — transport-neutral). Internal actors (bot driver,
		// matchmaker assembly, solo seeding) are server code, not wire input. A
		// rejection throws before any reducer/ledger/outbox work: nothing changes.
		if (isWire) {
			const admission = admitCommand(
				{
					mode: session.mode === 'ranked' ? 'ranked' : 'casual',
					role: member.role,
					seated: actor.seatColor != null,
					isBot: member.is_bot,
					allowIntegrityTools: integrityToolsAllowed()
				},
				params.command
			);
			if (!admission.ok) {
				throw kitError(403, admission.message);
			}
		}

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
			command: params.command,
			cmdId: params.cmdId ?? null
		});

		if (!persisted) {
			continue; // CAS conflict — reload fresh state and retry.
		}

		// Round-history snapshots (commitRound) now ride the durable effects outbox
		// inside persistSessionUpdate — committed atomically, drained before this return.

		// The acting member just made a request → they're alive. This (plus the /view
		// poll in loadRoomView) is the only writer of last_seen_at, keeping it a
		// trustworthy per-player liveness signal. Best-effort + off the critical path:
		// don't make the player wait on a heartbeat write, and the next poll re-stamps it.
		void updateLastSeen(member.id).catch(() => {});

		// Project from the authoritative in-memory next-state we just persisted, with the
		// member's role/seat recomputed locally (the same rule syncMemberMirrors applies).
		// This drops a post-write SELECT round-trip that only re-read our own seat back —
		// meaningful latency for cross-region players on every command.
		return viewForMemberAndState(session, commandResult.state, member);
	}

	throw kitError(409, 'This room is being updated by other players — please retry.');
}

/**
 * Project a RoomView for `member` from an authoritative state already in hand, with
 * the member's role/seat recomputed locally (the same rule syncMemberMirrors applies)
 * — no post-write SELECT. Used for both the fresh-commit response and the duplicate-
 * cmdId retry answer, so a retried command sees exactly what the original would have.
 */
async function viewForMemberAndState(
	session: PlaySessionRow,
	state: PublicGameState,
	member: NonNullable<Awaited<ReturnType<typeof getMemberById>>>
): Promise<RoomView> {
	const occupiedSeat =
		SEAT_COLORS.find((seat) => state.seats[seat].memberId === member.id) ?? null;
	const updatedRole: MemberRole =
		member.role === 'host' ? 'host' : occupiedSeat ? 'player' : 'spectator';
	const projection = stampRoomMeta(
		await attachBotSeatFlags(
			session.id,
			buildSessionProjection(state, {
				role: updatedRole,
				// State is the sole seat authority — no stale member.seat_color fallback.
				seatColor: occupiedSeat,
				displayName: member.display_name
			})
		),
		session
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
