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
import {
	consumeWsTicket as consumeWsTicketWith,
	type ConsumeWsTicketResult
} from '../src/lib/play/server/wsTickets';

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
	/** Central admission ('public' | 'private'); absent on pre-migration rows. */
	visibility?: string | null;
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
	/** The validated Supabase account that OWNS this membership (null: bots /
	 *  quarantined legacy rows). The sole durable human principal. */
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

/** TRUSTED-ID lookup — server-internal identities only (never wire input; public
 *  member ids do not authorize). */
export async function getMemberById(memberId: string): Promise<SessionMemberRow | null> {
	const { data, error } = await getPlayAdmin()
		.from(PLAY_TABLES.MEMBERS)
		.select('*')
		.eq('id', memberId)
		.maybeSingle();
	if (error) throw new Error(`Failed to load member ${memberId}: ${error.message}`);
	return (data as SessionMemberRow | null) ?? null;
}

/**
 * Atomically consume a raw WS join ticket against the shared store (one conditional
 * UPDATE — exactly one winner under replay). See src/lib/play/server/wsTickets.ts
 * for the full contract; this is the room server's injected-client binding.
 */
export async function consumeWsTicket(raw: unknown): Promise<ConsumeWsTicketResult> {
	return consumeWsTicketWith(getPlayAdmin(), raw);
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
 * The durable head of a session — revision + status only. The room host polls this
 * each tick (and on join/resync) to converge its in-memory cache on writes committed
 * by the OTHER transport (HTTP path) or another instance. There is deliberately NO
 * unconditional snapshot writer in this module anymore (the old `persistSnapshot`
 * could overwrite newer durable state with an equal/stale revision): every state
 * write goes through the revision-CAS commit in src/lib/play/server/commit.ts.
 */
export async function getSessionRevision(
	sessionId: string
): Promise<{ revision: number; status: string } | null> {
	const { data, error } = await getPlayAdmin()
		.from(PLAY_TABLES.SESSIONS)
		.select('revision, status')
		.eq('id', sessionId)
		.maybeSingle();
	if (error) throw new Error(`Failed to read session head ${sessionId}: ${error.message}`);
	return (data as { revision: number; status: string } | null) ?? null;
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

/** Atomically convert only stale ranked humans to server-driven bots while at
 * least one other human remains live. The SQL RPC also bumps the room revision,
 * so every transport observes the metadata change through normal fencing. */
export async function takeOverRankedDisconnects(sessionId: string): Promise<number> {
	const { data, error } = await getPlayAdmin().rpc('takeover_stale_ranked_members', {
		p_session_id: sessionId
	});
	if (error) throw new Error('Ranked disconnect integrity is unavailable.');
	return Number((data as { takenOver?: number } | null)?.takenOver ?? 0);
}
