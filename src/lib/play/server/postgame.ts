/**
 * Postgame summary + same-party rematch — the cross-platform terminal-screen
 * contract. Web's PostGameView and the Godot postgame screen both consume the SAME
 * authoritative summary (placements, ranked rating movement once finalized, rematch
 * lobby status) over plain HTTP, so a mixed web/Godot party sees one truth without
 * either client needing a Supabase data connection of its own.
 *
 * REMATCH DESIGN: the first member of a finished room to request a rematch creates
 * a fresh casual lobby (they host it); everyone else's request joins that same
 * lobby. Exactly-once across processes rides the 20260710 command-ledger unique key
 * (session_id, cmd_id): the winner of the anchor insert `rematch:<sessionId>` owns
 * the link, a loser closes its just-created room and joins the winner's. The link
 * event (`command_type: '$rematch'`, fixed cmdId) is inert to every ledger consumer
 * — dedup/effects/chat/history all filter on their own types or client-shaped
 * cmdIds. No engine/reducer involvement: the rematch room is a NORMAL lobby made of
 * the existing create/join primitives, so server authority and cmdId/revision
 * semantics are untouched. A ranked party rematches into a casual room by design —
 * ranked seating is only ever produced by the matchmaking queue.
 */
import { error as kitError } from '@sveltejs/kit';
import { getSupabaseAdmin } from '$lib/server/supabaseAdmin';
import type { GameSessionStatus, PublicGameState, SeatColor } from '../types';
import { createRoom, joinRoom, type PlayMode } from './service';
import { canViewRoom, roomVisibility, type RoomVisibility } from './roomAdmission';

const PLAY_SCHEMA = 'arc_spirits_2d';
const TABLES = {
	SESSIONS: 'play_game_sessions',
	MEMBERS: 'play_session_members',
	EVENTS: 'play_game_session_events',
	RESULT_PLAYERS: 'match_result_players',
	RESULTS: 'match_results',
	RATING_EVENTS: 'player_rating_events'
} as const;

const REMATCH_COMMAND_TYPE = '$rematch';

function getAdmin() {
	const admin = getSupabaseAdmin(PLAY_SCHEMA);
	if (!admin) throw kitError(503, 'Play persistence is not configured.');
	return admin;
}

function rematchCmdId(sessionId: string): string {
	return `rematch:${sessionId}`;
}

/** Per-ORIGINAL-member join anchor: exactly-once membership in the rematch room
 *  for each member of the finished party (repeat taps, refreshes, and two party
 *  members sharing one account all resolve to their own single membership). */
function rematchJoinCmdId(sessionId: string, memberId: string): string {
	return `rematch:${sessionId}:${memberId}`;
}

// ── Summary types (the wire contract both clients parse) ─────────────────────────

export interface PostgameRating {
	muBefore: number;
	sigmaBefore: number;
	muAfter: number;
	sigmaAfter: number;
	/** OpenSkill display ordinal (mu − 3σ) movement for this match. */
	ordinalDelta: number;
}

export interface PostgamePlayer {
	seatColor: SeatColor;
	memberId: string | null;
	displayName: string | null;
	isBot: boolean;
	victoryPoints: number;
	placement: number;
	ratedPlacement: number;
	abandoned: boolean;
	winner: boolean;
	/** Present only for ranked, finalized, account-holding players. */
	rating: PostgameRating | null;
}

export interface RematchStatus {
	roomCode: string;
	status: GameSessionStatus;
	/** Human members who have joined the rematch lobby so far. */
	joinedCount: number;
	joinedNames: string[];
}

export interface PostgameSummary {
	roomCode: string;
	status: GameSessionStatus;
	mode: PlayMode;
	/** Central admission flag (private rooms only ever answer to members). */
	visibility: RoomVisibility;
	/** True only for a real rated (ranked, verified-identity) game. */
	rated: boolean;
	winnerSeat: SeatColor | null;
	navigationCount: number;
	endedAt: string | null;
	/** True once match_result rows exist (rating movement is final). */
	finalized: boolean;
	players: PostgamePlayer[];
	rematch: RematchStatus | null;
}

// ── Internal row shapes ───────────────────────────────────────────────────────────

interface SessionRow {
	id: string;
	room_code: string;
	status: GameSessionStatus;
	mode: PlayMode | null;
	visibility?: RoomVisibility | null;
	revision: number;
	public_state: PublicGameState;
	ended_at: string | null;
}

interface ResultPlayerRow {
	seat_color: SeatColor;
	member_id: string | null;
	user_id: string | null;
	display_name: string | null;
	is_bot: boolean;
	victory_points: number;
	placement: number;
	rated_placement?: number | null;
	abandoned?: boolean | null;
}

interface RatingEventRow {
	user_id: string;
	mu_before: number;
	sigma_before: number;
	mu_after: number;
	sigma_after: number;
}

async function getSessionRow(roomCode: string): Promise<SessionRow | null> {
	// `select('*')` keeps this readable on pre-migration rows (no `visibility` yet).
	const res = await getAdmin()
		.from(TABLES.SESSIONS)
		.select('*')
		.eq('room_code', roomCode.trim().toUpperCase())
		.maybeSingle();
	if (res.error) throw kitError(500, `Failed to load room: ${res.error.message}`);
	return (res.data as SessionRow | null) ?? null;
}

/** Resolve the caller's membership in a session by their VALIDATED account. */
async function getMemberByUser(
	sessionId: string,
	userId: string | null | undefined
): Promise<{ id: string; display_name: string | null; user_id: string | null; is_bot: boolean | null } | null> {
	if (!userId) return null;
	const res = await getAdmin()
		.from(TABLES.MEMBERS)
		.select('id, display_name, user_id, is_bot')
		.eq('session_id', sessionId)
		.eq('user_id', userId)
		.limit(1);
	if (res.error) return null;
	const rows = (res.data as { id: string; display_name: string | null; user_id: string | null; is_bot: boolean | null }[] | null) ?? [];
	return rows[0] ?? null;
}

/**
 * Dense-rank placements from the terminal state — the same rule matchFinalize
 * records (winner first, rest by VP desc with shared ranks). Used only until the
 * finalize effect has landed; after that the recorded rows are authoritative.
 */
function placementsFromState(state: PublicGameState): PostgamePlayer[] {
	const seats = state.activeSeats ?? [];
	const rows = seats.map((seatColor) => ({
		seatColor,
		memberId: state.seats[seatColor]?.memberId ?? null,
		displayName: state.seats[seatColor]?.displayName ?? null,
		isBot: false,
		victoryPoints: state.players[seatColor]?.victoryPoints ?? 0,
		placement: 0,
		ratedPlacement: 0,
		abandoned: false,
		winner: state.winnerSeat === seatColor,
		rating: null as PostgameRating | null
	}));
	const winner = rows.find((r) => r.winner) ?? null;
	const rest = rows.filter((r) => r !== winner);
	rest.sort((a, b) => b.victoryPoints - a.victoryPoints || a.seatColor.localeCompare(b.seatColor));
	if (winner) winner.placement = 1;
	let placement = winner ? 1 : 0;
	let lastVp: number | null = null;
	for (const r of rest) {
		if (lastVp === null || r.victoryPoints !== lastVp) {
			placement += 1;
			lastVp = r.victoryPoints;
		}
		r.placement = placement;
		r.ratedPlacement = placement;
	}
	if (winner) winner.ratedPlacement = 1;
	return rows.sort((a, b) => a.placement - b.placement);
}

/**
 * The rematch PARTY: the public member ids seated on the TERMINAL board — the
 * humans (and bots, excluded elsewhere) who actually played the finished game.
 * Spectator memberships, late-joining nonplayers and outsiders are NOT the party,
 * no matter what memberships they hold in the original room.
 */
function terminalSeatedMemberIds(state: PublicGameState | null | undefined): Set<string> {
	const ids = new Set<string>();
	for (const seat of state?.activeSeats ?? []) {
		const memberId = state?.seats?.[seat]?.memberId;
		if (memberId) ids.add(memberId);
	}
	return ids;
}

async function loadRematchStatus(session: SessionRow): Promise<RematchStatus | null> {
	const admin = getAdmin();
	const anchor = await admin
		.from(TABLES.EVENTS)
		.select('command_payload')
		.eq('session_id', session.id)
		.eq('command_payload->>cmdId', rematchCmdId(session.id))
		.maybeSingle();
	if (anchor.error || !anchor.data) return null;
	const roomCode = String(
		(anchor.data as { command_payload?: { roomCode?: unknown } }).command_payload?.roomCode ?? ''
	);
	if (!roomCode) return null;

	const room = await admin
		.from(TABLES.SESSIONS)
		.select('id, status')
		.eq('room_code', roomCode)
		.maybeSingle();
	if (room.error || !room.data) return null;
	const roomRow = room.data as { id: string; status: GameSessionStatus };

	const members = await admin
		.from(TABLES.MEMBERS)
		.select('display_name, is_bot')
		.eq('session_id', roomRow.id);
	const humanNames = ((members.data as { display_name: string | null; is_bot: boolean | null }[]) ?? [])
		.filter((m) => !m.is_bot)
		.map((m) => m.display_name ?? 'Player');

	return {
		roomCode,
		status: roomRow.status,
		joinedCount: humanNames.length,
		joinedNames: humanNames.slice(0, 8)
	};
}

/**
 * The authoritative postgame summary for a TERMINAL room. Public data only —
 * everything here is already visible to every player and spectator on the finished
 * board (names, VP, winner) or is published movement (rating deltas). 404 when the
 * room does not exist; a non-terminal room answers its live status with no
 * standings so a polling client can react to a rematch/next state honestly.
 */
export async function loadPostgameSummary(
	roomCode: string,
	userId?: string | null
): Promise<PostgameSummary> {
	const session = await getSessionRow(roomCode);
	if (!session) throw kitError(404, 'Room not found.');

	const mode: PlayMode = session.mode === 'ranked' ? 'ranked' : 'casual';

	// Central admission: a PRIVATE room's postgame is visible only to its members —
	// the postgame path is not a discovery door.
	const caller = await getMemberByUser(session.id, userId);
	const facts = { mode, visibility: roomVisibility(session), status: session.status } as const;
	if (!canViewRoom(facts, caller != null)) {
		throw kitError(404, 'Room not found.');
	}
	const state = session.public_state;
	const base: PostgameSummary = {
		roomCode: session.room_code,
		status: session.status,
		mode,
		visibility: facts.visibility,
		rated: false,
		winnerSeat: state?.winnerSeat ?? null,
		navigationCount: state?.round ?? 0,
		endedAt: session.ended_at,
		finalized: false,
		players: [],
		rematch: null
	};
	if (session.status !== 'finished' && session.status !== 'closed') {
		return base; // live room: status only (client is early or stale).
	}

	const admin = getAdmin();
	const [resultRes, recordedRes, ratingsRes, rematch] = await Promise.all([
		admin.from(TABLES.RESULTS).select('rated,quarantined,ranked_season_id').eq('session_id', session.id).maybeSingle(),
		admin
			.from(TABLES.RESULT_PLAYERS)
			.select('seat_color, member_id, user_id, display_name, is_bot, victory_points, placement,rated_placement,abandoned')
			.eq('session_id', session.id),
		admin
			.from(TABLES.RATING_EVENTS)
			.select('user_id, mu_before, sigma_before, mu_after, sigma_after')
			.eq('session_id', session.id),
		// The rematch lobby is PRIVATE party state: only the TERMINAL SEATED party
		// learns its code/status. Spectators of a public finished board — even ones
		// holding a membership in the original room — see standings, never the
		// party's next room.
		caller && terminalSeatedMemberIds(session.public_state).has(caller.id)
			? loadRematchStatus(session)
			: Promise.resolve(null)
	]);
	const result = resultRes.data as { rated?: boolean; quarantined?: boolean; ranked_season_id?: string | null } | null;
	base.rated = result?.rated === true && result?.quarantined !== true;

	const recorded = (recordedRes.data as ResultPlayerRow[] | null) ?? [];
	const ratingByUser = new Map<string, PostgameRating>();
	for (const row of (ratingsRes.data as RatingEventRow[] | null) ?? []) {
		ratingByUser.set(row.user_id, {
			muBefore: row.mu_before,
			sigmaBefore: row.sigma_before,
			muAfter: row.mu_after,
			sigmaAfter: row.sigma_after,
			ordinalDelta:
				row.mu_after - 3 * row.sigma_after - (row.mu_before - 3 * row.sigma_before)
		});
	}

	if (recorded.length > 0) {
		base.finalized = true;
		base.players = recorded
			.map((row) => ({
				seatColor: row.seat_color,
				memberId: row.member_id,
				displayName: row.display_name,
				isBot: row.is_bot,
				victoryPoints: row.victory_points,
				placement: row.placement,
				ratedPlacement: row.rated_placement ?? row.placement,
				abandoned: row.abandoned === true,
				winner: state?.winnerSeat === row.seat_color,
				rating: (row.user_id && ratingByUser.get(row.user_id)) || null
			}))
			.sort((a, b) => a.placement - b.placement);
	} else if (state) {
		base.players = placementsFromState(state).map((row) => ({ ...row,
			ratedPlacement: row.placement, abandoned: false }));
	}
	base.rematch = rematch;
	return base;
}

/**
 * Create-or-join the rematch lobby for a finished room. The caller authenticates
 * with their VALIDATED account — the same boundary as every other room mutation —
 * and must own a membership in the finished room; display name and account
 * attribution carry over from that membership. The rematch lobby is PRIVATE: the
 * original party converges idempotently onto one hidden room, and outsiders can
 * neither discover nor enter it. The returned `memberId` is the public seat label
 * only — the caller's account owns the new membership and every later request
 * re-proves it.
 */
export async function requestRematch(
	roomCode: string,
	userId: string | null
): Promise<{ roomCode: string; memberId: string; created: boolean }> {
	const admin = getAdmin();
	const session = await getSessionRow(roomCode);
	if (!session) throw kitError(404, 'Room not found.');
	if (session.status !== 'finished' && session.status !== 'closed') {
		throw kitError(409, 'This room has not finished — rematch is a postgame action.');
	}

	const member = await getMemberByUser(session.id, userId);
	if (!member) {
		// A private room's existence is never confirmed to outsiders.
		const facts = {
			mode: session.mode === 'ranked' ? ('ranked' as const) : ('casual' as const),
			visibility: roomVisibility(session),
			status: session.status
		};
		if (!canViewRoom(facts, false)) throw kitError(404, 'Room not found.');
		throw kitError(401, 'Join this room before requesting a rematch.');
	}
	if (member.is_bot) throw kitError(403, 'Bots do not request rematches.');

	// PARTY ADMISSION: only the TERMINAL SEATED participants of the finished game
	// are the rematch party. A spectator membership (or a late-joining nonplayer) in
	// the original room confers NOTHING here — it can neither create the hidden
	// lobby (and become its host) nor join it. This gate runs BEFORE the idempotent
	// prior-join lookup, so a previously-recorded illegitimate anchor cannot keep
	// working either.
	const party = terminalSeatedMemberIds(session.public_state);
	if (!party.has(member.id)) {
		throw kitError(403, 'Only players seated in the finished game can rematch.');
	}
	const displayName = member.display_name ?? 'Player';

	// Repeat call by the same ORIGINAL member (retap / refresh / relaunch): their
	// join anchor already records their rematch membership — hand it back.
	const priorJoin = await readAnchor(session.id, rematchJoinCmdId(session.id, member.id));
	if (priorJoin) {
		await syncPersistentPartyRematch(session, String(priorJoin.roomCode ?? ''));
		return {
			roomCode: String(priorJoin.roomCode ?? ''),
			memberId: String(priorJoin.memberId ?? ''),
			created: Boolean(priorJoin.created ?? false)
		};
	}

	// Fast path: the room link already exists — join it as a fresh member.
	const existing = await loadRematchStatus(session);
	if (existing) {
		const joined = await joinRematchRoom(session.id, member.id, existing.roomCode, displayName, member.user_id);
		await syncPersistentPartyRematch(session, existing.roomCode);
		return joined;
	}

	// Create a candidate PRIVATE room, then race for the room-link anchor. The
	// unique (session_id, cmd_id) ledger key picks exactly one winner across
	// processes. Private ⇒ never browsable; only the original party (through this
	// authenticated path) converges into it.
	const createdRoom = await createRoom(displayName, member.user_id, 'casual', {
		visibility: 'private'
	});
	const anchor = await admin.from(TABLES.EVENTS).insert({
		session_id: session.id,
		revision: session.revision,
		actor_member_id: member.id,
		command_type: REMATCH_COMMAND_TYPE,
		command_payload: { cmdId: rematchCmdId(session.id), roomCode: createdRoom.roomCode }
	});

	if (!anchor.error) {
		// Record the winner's own membership under their join anchor (best-effort:
		// its uniqueness only guards THEIR retries, and they just won the link).
		// The anchor payload carries the public id only — it never authorizes.
		await recordJoinAnchor(session.id, member.id, {
			roomCode: createdRoom.roomCode,
			memberId: createdRoom.memberId,
			created: true
		});
		await syncPersistentPartyRematch(session, createdRoom.roomCode);
		return {
			roomCode: createdRoom.roomCode,
			memberId: createdRoom.memberId,
			created: true
		};
	}

	// Lost the race (23505) or the insert failed — abandon our candidate room and
	// follow the recorded link. The abandoned lobby is emptied so the reaper (and
	// the browser's is-open filter) drops it immediately rather than in 30 min.
	await admin.from(TABLES.MEMBERS).delete().eq('id', createdRoom.memberId);
	const linked = await loadRematchStatus(session);
	if (!linked) {
		throw kitError(500, `Rematch link could not be established: ${anchor.error.message}`);
	}
	const joined = await joinRematchRoom(session.id, member.id, linked.roomCode, displayName, member.user_id);
	await syncPersistentPartyRematch(session, linked.roomCode);
	return joined;
}

/**
 * If every terminal human belongs to the same persistent live party, keep that
 * whole group together: pre-create/reuse each party member's private-room
 * membership and advance the party's active-room pointer to the rematch. This is
 * best-effort and migration-compatible; a store without social tables retains the
 * established terminal-seat rematch contract.
 */
async function syncPersistentPartyRematch(session: SessionRow, rematchCode: string): Promise<void> {
	if (!rematchCode) return;
	try {
		const terminalIds = [...terminalSeatedMemberIds(session.public_state)];
		if (!terminalIds.length) return;
		const terminal = await getAdmin().from(TABLES.MEMBERS)
			.select('user_id,display_name,is_bot').eq('session_id', session.id).in('id', terminalIds);
		if (terminal.error) return;
		const humans = ((terminal.data ?? []) as Array<{ user_id: string | null; display_name: string | null; is_bot: boolean }>)
			.filter((row) => !row.is_bot && row.user_id);
		if (!humans.length) return;
		const first = await getAdmin().from('social_party_members').select('party_id')
			.eq('user_id', humans[0].user_id).maybeSingle();
		if (first.error || !first.data?.party_id) return;
		const partyId = String(first.data.party_id);
		for (const human of humans.slice(1)) {
			const membership = await getAdmin().from('social_party_members').select('party_id')
				.eq('user_id', human.user_id).eq('party_id', partyId).maybeSingle();
			if (membership.error || !membership.data) return;
		}
		const partyMembers = await getAdmin().from('social_party_members').select('user_id')
			.eq('party_id', partyId);
		if (partyMembers.error) return;
		const ids = ((partyMembers.data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id);
		const knownNames = new Map(humans.map((row) => [String(row.user_id), row.display_name ?? 'Party Member']));
		const missing = ids.filter((id) => !knownNames.has(id));
		if (missing.length) {
			const publicAdmin = getSupabaseAdmin('public');
			const profiles = publicAdmin
				? await publicAdmin.from('profiles').select('id,display_name').in('id', missing)
				: { data: [], error: null };
			for (const profile of (profiles.data ?? []) as Array<{ id: string; display_name: string | null }>) {
				knownNames.set(profile.id, profile.display_name ?? 'Party Member');
			}
		}
		for (const userId of ids) {
			await joinRoom(rematchCode, knownNames.get(userId) ?? 'Party Member', userId, { admission: 'internal' });
		}
		await getAdmin().from('social_parties').update({
			active_room_code: rematchCode,
			updated_at: new Date().toISOString()
		}).eq('id', partyId);
	} catch (cause) {
		console.error('[social] persistent-party rematch sync deferred:', cause instanceof Error ? cause.message : cause);
	}
}

/** Read a `$rematch`-family anchor payload by cmdId (null when absent). */
async function readAnchor(sessionId: string, cmdId: string): Promise<Record<string, unknown> | null> {
	const res = await getAdmin()
		.from(TABLES.EVENTS)
		.select('command_payload')
		.eq('session_id', sessionId)
		.eq('command_payload->>cmdId', cmdId)
		.maybeSingle();
	if (res.error || !res.data) return null;
	return ((res.data as { command_payload?: Record<string, unknown> }).command_payload ?? null);
}

async function recordJoinAnchor(
	sessionId: string,
	memberId: string,
	payload: { roomCode: string; memberId: string; created: boolean }
): Promise<{ error: { message: string } | null }> {
	return await getAdmin()
		.from(TABLES.EVENTS)
		.insert({
			session_id: sessionId,
			revision: 0,
			actor_member_id: memberId,
			command_type: REMATCH_COMMAND_TYPE,
			command_payload: { cmdId: rematchJoinCmdId(sessionId, memberId), ...payload }
		});
}

/** Join the linked rematch room as a NEW member, anchored exactly-once per
 *  ORIGINAL member: losing the anchor race (a concurrent duplicate of our own
 *  request) adopts the recorded membership — joinRoom itself is idempotent per
 *  (room, user), so a duplicate never creates a second membership to roll back. */
async function joinRematchRoom(
	oldSessionId: string,
	oldMemberId: string,
	rematchCode: string,
	displayName: string,
	userId: string | null
): Promise<{ roomCode: string; memberId: string; created: boolean }> {
	// Server-internal admission: the caller proved ORIGINAL-party membership above;
	// the rematch room itself is private and rejects generic wire joins.
	const joined = await joinRoom(rematchCode, displayName, userId, { admission: 'internal' });
	const anchor = await recordJoinAnchor(oldSessionId, oldMemberId, {
		roomCode: rematchCode,
		memberId: joined.memberId,
		created: false
	});
	if (anchor.error) {
		const prior = await readAnchor(oldSessionId, rematchJoinCmdId(oldSessionId, oldMemberId));
		if (prior) {
			return {
				roomCode: String(prior.roomCode ?? rematchCode),
				memberId: String(prior.memberId ?? joined.memberId),
				created: Boolean(prior.created ?? false)
			};
		}
	}
	return {
		roomCode: rematchCode,
		memberId: joined.memberId,
		created: false
	};
}
