/**
 * Supabase access for the standalone room server.
 *
 * This REIMPLEMENTS the SvelteKit-bound helpers from `src/lib/server/supabaseAdmin.ts`
 * and `src/lib/play/server/service.ts`, which cannot be imported here because they read
 * `$env/*` virtual modules and throw SvelteKit `error()` objects. The table/column
 * contract is copied verbatim from service.ts (PLAY_SCHEMA / PLAY_TABLES / the row
 * shapes) so the two paths read and write the same rows during the migration.
 *
 * Only the subset the room server needs is reimplemented: load a session by room code,
 * persist an authoritative snapshot, resolve a member (by id / by user), and load the
 * bot-member map. Everything else (chat, ranked finalize, replay codes) stays in the
 * SvelteKit service.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
	GameSessionStatus,
	MemberRole,
	PublicGameState,
	SeatColor
} from '../src/lib/play/types';
import { requireEnv } from './env';

// Schema + table contract — copied from src/lib/play/server/service.ts.
const PLAY_SCHEMA = 'arc_spirits_2d';
const ASSETS_SCHEMA = 'arc_spirits_assets';
export const PLAY_TABLES = {
	SESSIONS: 'play_game_sessions',
	MEMBERS: 'play_session_members'
} as const;

export type PlayMode = 'casual' | 'ranked';

/** Mirror of service.ts PlaySessionRow (the columns the room server touches). */
export interface PlaySessionRow {
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
}

/** Mirror of service.ts SessionMemberRow (the columns the room server touches). */
export interface SessionMemberRow {
	id: string;
	session_id: string;
	display_name: string;
	role: MemberRole;
	seat_color: SeatColor | null;
	user_id: string | null;
	is_bot: boolean;
	bot_profile: string | null;
	last_seen_at: string;
}

const adminClients = new Map<string, SupabaseClient<any, any, any>>();

/** Service-role client scoped to a schema (mirrors getSupabaseAdmin). Cached per schema. */
export function getPlayAdmin(schema: string = PLAY_SCHEMA): SupabaseClient<any, any, any> {
	const cached = adminClients.get(schema);
	if (cached) return cached;
	const url = requireEnv('PUBLIC_SUPABASE_URL');
	const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
	const client = createClient(url, key, {
		db: { schema },
		auth: { persistSession: false, autoRefreshToken: false }
	});
	adminClients.set(schema, client);
	return client;
}

let assetsClient: SupabaseClient<any, any, any> | null = null;

/** Anon client on the public assets schema — the read-only catalog source. */
export function getAssetsClient(): SupabaseClient<any, any, any> {
	if (assetsClient) return assetsClient;
	const url = requireEnv('PUBLIC_SUPABASE_URL');
	const key = requireEnv('PUBLIC_SUPABASE_ANON_KEY');
	assetsClient = createClient(url, key, {
		db: { schema: ASSETS_SCHEMA },
		auth: { persistSession: false, autoRefreshToken: false }
	});
	return assetsClient;
}

function normalizeRoomCode(roomCode: string): string {
	return roomCode.trim().toUpperCase();
}

export async function getSessionByRoomCode(roomCode: string): Promise<PlaySessionRow | null> {
	const { data, error } = await getPlayAdmin()
		.from(PLAY_TABLES.SESSIONS)
		.select('*')
		.eq('room_code', normalizeRoomCode(roomCode))
		.maybeSingle();
	if (error) throw new Error(`Failed to load session ${roomCode}: ${error.message}`);
	return (data as PlaySessionRow | null) ?? null;
}

export async function getMemberById(memberId: string): Promise<SessionMemberRow | null> {
	const { data, error } = await getPlayAdmin()
		.from(PLAY_TABLES.MEMBERS)
		.select('*')
		.eq('id', memberId)
		.maybeSingle();
	if (error) throw new Error(`Failed to load member ${memberId}: ${error.message}`);
	return (data as SessionMemberRow | null) ?? null;
}

/** Resolve a matchmade player by (session, authenticated user) — the authToken fallback. */
export async function getMemberBySessionAndUser(
	sessionId: string,
	userId: string
): Promise<SessionMemberRow | null> {
	const { data, error } = await getPlayAdmin()
		.from(PLAY_TABLES.MEMBERS)
		.select('*')
		.eq('session_id', sessionId)
		.eq('user_id', userId)
		.maybeSingle();
	if (error) throw new Error(`Failed to resolve member by user: ${error.message}`);
	return (data as SessionMemberRow | null) ?? null;
}

/**
 * Member id → bot policy key for a session's bot members (mirrors service.loadBotMembers).
 * Used to stamp `projection.seats[seat].isBot`. Empty map when the query fails.
 */
export async function loadBotMembers(sessionId: string): Promise<Map<string, string | null>> {
	const { data, error } = await getPlayAdmin()
		.from(PLAY_TABLES.MEMBERS)
		.select('id, bot_profile')
		.eq('session_id', sessionId)
		.eq('is_bot', true);
	const out = new Map<string, string | null>();
	if (error) return out;
	for (const row of (data as { id: string; bot_profile: string | null }[] | null) ?? []) {
		out.set(row.id, row.bot_profile ?? null);
	}
	return out;
}

/**
 * Resolve a Supabase auth user id from a bearer access token (the `authToken`
 * matchmade fallback). Uses a short-lived client with the token as the Authorization
 * header. Returns null on any failure — auth is best-effort here; a bad token simply
 * falls through to spectator.
 */
export async function resolveUserIdFromAccessToken(token: string): Promise<string | null> {
	try {
		const url = requireEnv('PUBLIC_SUPABASE_URL');
		const key = requireEnv('PUBLIC_SUPABASE_ANON_KEY');
		const client = createClient(url, key, {
			global: { headers: { Authorization: `Bearer ${token}` } },
			auth: { persistSession: false, autoRefreshToken: false }
		});
		const { data, error } = await client.auth.getUser(token);
		if (error) return null;
		return data.user?.id ?? null;
	} catch {
		return null;
	}
}

/**
 * Persist the authoritative in-memory state back to the session row. Unlike the
 * SvelteKit path this does NOT compare-and-set on revision: the room host is the single
 * writer of its own state (commands are serialized in one per-room queue), so it always
 * writes the freshest revision it holds. Stamps started_at / ended_at on the first
 * active / terminal transition, matching persistSessionUpdate's column writes.
 */
export async function persistSnapshot(params: {
	session: Pick<PlaySessionRow, 'id' | 'started_at' | 'ended_at'>;
	state: PublicGameState;
}): Promise<void> {
	const { session, state } = params;
	const now = new Date().toISOString();
	const payload: Record<string, unknown> = {
		status: state.status,
		revision: state.revision,
		game_id: state.gameId,
		scenario: state.scenario,
		public_state: state
	};
	if (session.started_at == null && state.status === 'active') payload.started_at = now;
	const isFinished = state.status === 'finished' || state.status === 'closed';
	if (isFinished && session.ended_at == null) payload.ended_at = now;

	const { error } = await getPlayAdmin()
		.from(PLAY_TABLES.SESSIONS)
		.update(payload)
		.eq('id', session.id);
	if (error) throw new Error(`Failed to persist snapshot for ${session.id}: ${error.message}`);
}

/** Best-effort last-seen stamp for a member (presence signal). Never throws. */
export async function touchMemberLastSeen(memberId: string): Promise<void> {
	try {
		await getPlayAdmin()
			.from(PLAY_TABLES.MEMBERS)
			.update({ last_seen_at: new Date().toISOString() })
			.eq('id', memberId);
	} catch {
		/* presence is best-effort */
	}
}
