/**
 * Short-lived, one-use, room-scoped WebSocket join tickets — the ONLY credential the
 * standalone room server accepts on `join`.
 *
 * Trust model: the durable human principal is the validated Supabase identity (see
 * membership.ts); the WebSocket boundary cannot read the httpOnly auth cookie and
 * must never be handed a durable credential (an account token or a long-lived room
 * secret) to hold in JS. So the authenticated HTTP layer mints an opaque ticket:
 *
 *   - RAW HANDOFF EXACTLY ONCE: the raw value is returned only by the authenticated,
 *     `Cache-Control: no-store` mint endpoint, straight into the join frame. It is
 *     never logged, persisted, echoed into views, or placed in a URL.
 *   - DIGEST-ONLY STORAGE: the server stores a SHA-256 digest; a database read can
 *     never recover a usable ticket.
 *   - EXACT BINDING: each ticket is bound to (session, user, member, role). The
 *     consumer re-verifies every binding against current authoritative rows — a
 *     wrong-room, wrong-user, bot-bound, or role-escalated ticket fails closed.
 *   - ATOMIC ONE-USE: consumption goes EXCLUSIVELY through the store's
 *     `consume_ws_ticket` function — one conditional UPDATE (`consumed_at IS NULL AND
 *     expires_at > clock_timestamp()`); a replay loses the race and is rejected.
 *     Reconnects mint a FRESH ticket.
 *   - SHORT EXPIRY, DB-CLOCK GOVERNED END TO END: the WHOLE lifecycle reads the
 *     DATABASE WALL clock (clock_timestamp(), never the transaction-start now(), so
 *     a consume that sat blocked on a row lock past expiry still refuses). Minting
 *     goes exclusively through the store's `mint_ws_ticket` function — the
 *     application submits only the digest and the authoritative bindings;
 *     created_at/expires_at are fixed by clock_timestamp() with a 30-second lifetime
 *     baked into the function body ({@link WS_TICKET_TTL_MS} mirrors it for display
 *     only), and the STORED expiry is what the caller reports. Expiry is evaluated
 *     against the database clock inside the consume function, and cleanup deletes
 *     only rows the database itself considers long dead. No application clock
 *     (skewed, frozen, or backdated) participates in any lifecycle decision: a
 *     process an hour ahead cannot mint a 63-minute ticket or sweep a valid one,
 *     and a process an hour behind cannot mint one dead on arrival.
 *
 * Spectator tickets join read-only; the room server refuses commands from them. A
 * failed ticket NEVER silently downgrades an intended member join to spectator — the
 * join fails fatally and the client re-mints.
 *
 * Framework-free: both the SvelteKit service and the room server inject their own
 * schema-scoped clients; tests inject fakes.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { PlayDbClient } from './commit';

export const WS_TICKETS_TABLE = 'play_ws_tickets';
export const WS_TICKET_PREFIX = 'pwt_';
/** Mirrors the 30-second lifetime FIXED INSIDE `mint_ws_ticket` (the SQL body is
 *  authoritative). Display/testing reference only — nothing submits it to the
 *  store, so no caller can stretch or shrink a ticket's life. */
export const WS_TICKET_TTL_MS = 30_000;
/** The store-side mint function (20260710_identity_trust.sql) — the ONLY mint
 *  path. It fixes created_at/expires_at from the DATABASE clock; it accepts no
 *  time or TTL parameter. */
export const WS_TICKET_MINT_RPC = 'mint_ws_ticket';
/** The store-side consume function (20260710_identity_trust.sql) — the ONLY
 *  redemption path. It reads the DATABASE clock; it takes no time parameter. */
export const WS_TICKET_CONSUME_RPC = 'consume_ws_ticket';
/** The store-side hygiene function — deletes only rows the DATABASE clock says
 *  expired over 10 minutes ago. Best-effort; never blocks or times a mint. */
export const WS_TICKET_CLEANUP_RPC = 'cleanup_ws_tickets';

/** 32 random bytes → exactly 43 base64url chars. Structurally disjoint from UUIDs
 *  and from any legacy credential shape, so nothing else can pass the format gate. */
const WS_TICKET_PATTERN = /^pwt_[A-Za-z0-9_-]{43}$/;

export type WsTicketRole = 'member' | 'spectator';

export interface WsTicketRow {
	id: string;
	session_id: string;
	user_id: string;
	/** Null for a pure spectator (an authenticated viewer with no membership). */
	member_id: string | null;
	role: WsTicketRole;
	digest: string;
	expires_at: string;
	consumed_at: string | null;
	created_at: string;
}

export function isWsTicketValue(value: unknown): value is string {
	return typeof value === 'string' && WS_TICKET_PATTERN.test(value);
}

export function mintWsTicketValue(): string {
	return WS_TICKET_PREFIX + randomBytes(32).toString('base64url');
}

/** SHA-256 hex digest — the only form of the ticket that ever touches storage. */
export function digestWsTicket(raw: string): string {
	return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export interface CreateWsTicketParams {
	sessionId: string;
	userId: string;
	memberId: string | null;
	role: WsTicketRole;
}

/**
 * Mint + persist a ticket EXCLUSIVELY through the store's `mint_ws_ticket`
 * function: the application contributes only the high-entropy raw value (whose
 * digest it submits) and the authoritative (session, user, member, role)
 * binding. The DATABASE fixes created_at and expires_at from its own wall clock
 * (clock_timestamp()) with a lifetime baked into the function body — this module deliberately sends no
 * timestamp and no TTL, so a skewed application clock can neither stretch a
 * ticket's life nor mint one dead on arrival. Returns the RAW value (hand it to
 * the authenticated caller exactly once) and the STORED expiry as the database
 * returned it. A store without the function is NOT ready to authenticate
 * sockets — that throws (fail closed) rather than degrading to an
 * application-timed INSERT.
 */
export async function createWsTicket(
	db: PlayDbClient,
	params: CreateWsTicketParams
): Promise<{ ticket: string; expiresAt: string }> {
	const raw = mintWsTicketValue();
	if (typeof db.rpc !== 'function') {
		throw new Error(
			`store not ready: WS ticket minting requires the ${WS_TICKET_MINT_RPC} ` +
				`function (supabase/migrations/20260710_identity_trust.sql) — refusing to fall ` +
				`back to an application-timed insert.`
		);
	}
	const { data, error } = await db.rpc(WS_TICKET_MINT_RPC, {
		p_session_id: params.sessionId,
		p_user_id: params.userId,
		p_member_id: params.memberId,
		p_role: params.role,
		p_digest: digestWsTicket(raw)
	});
	if (error) {
		throw new Error(`Failed to mint WS ticket: ${error.message}`);
	}
	const rows = (data as WsTicketRow[] | null) ?? [];
	const stored = rows.length === 1 ? rows[0] : null;
	if (!stored || typeof stored.expires_at !== 'string' || stored.expires_at.length === 0) {
		throw new Error(
			`Failed to mint WS ticket: ${WS_TICKET_MINT_RPC} returned no authoritative row.`
		);
	}
	return { ticket: raw, expiresAt: stored.expires_at };
}

export type ConsumeWsTicketFailure = 'malformed' | 'not_found_or_replayed' | 'expired';

export type ConsumeWsTicketResult =
	| { ok: true; ticket: WsTicketRow }
	| { ok: false; reason: ConsumeWsTicketFailure };

/**
 * Atomically consume a raw ticket through the store's `consume_ws_ticket` function —
 * one conditional UPDATE (`consumed_at IS NULL AND expires_at > clock_timestamp()`,
 * the WALL clock, so a lock wait past expiry still refuses) evaluated
 * ENTIRELY on the database: concurrent replays admit exactly one winner, and expiry
 * is measured against the DATABASE clock. This module deliberately passes no
 * timestamp and consults no local clock for the redemption decision, so an
 * application process with a skewed or backdated clock can never resurrect an
 * expired digest. A store without the function is NOT ready to authenticate sockets
 * (the same migration ships the table itself) — that throws rather than degrading
 * to a client-timed UPDATE. A failed claim is classified by a follow-up read purely
 * for diagnostics: the digest still present and unconsumed means only the expiry
 * predicate can have refused it. The classification never admits anything; callers
 * must fail the join (no silent downgrade).
 */
export async function consumeWsTicket(
	db: PlayDbClient,
	raw: unknown
): Promise<ConsumeWsTicketResult> {
	if (!isWsTicketValue(raw)) return { ok: false, reason: 'malformed' };
	const digest = digestWsTicket(raw);
	if (typeof db.rpc !== 'function') {
		throw new Error(
			`store not ready: WS ticket consumption requires the ${WS_TICKET_CONSUME_RPC} ` +
				`function (supabase/migrations/20260710_identity_trust.sql) — refusing to fall ` +
				`back to an application-timed update.`
		);
	}
	const { data, error } = await db.rpc(WS_TICKET_CONSUME_RPC, { p_digest: digest });
	if (error) {
		throw new Error(`Failed to consume WS ticket: ${error.message}`);
	}
	const rows = (data as WsTicketRow[] | null) ?? [];
	if (rows.length !== 1) {
		// Diagnostics only: an unconsumed row that the DB refused to claim can only
		// have been refused by the expiry predicate. Both paths reject identically.
		const probe = await db
			.from(WS_TICKETS_TABLE)
			.select('consumed_at')
			.eq('digest', digest)
			.limit(1);
		const probeRow = ((probe.data as Pick<WsTicketRow, 'consumed_at'>[] | null) ?? [])[0];
		if (probeRow && probeRow.consumed_at == null) {
			return { ok: false, reason: 'expired' };
		}
		return { ok: false, reason: 'not_found_or_replayed' };
	}
	return { ok: true, ticket: rows[0] };
}

/** Best-effort cleanup of dead rows, DATABASE-TIME GOVERNED: the store's
 *  `cleanup_ws_tickets` function deletes only rows whose expiry passed over ten
 *  minutes ago BY THE DATABASE CLOCK — an application clock running fast can
 *  never sweep a ticket the database still considers valid (the old
 *  application-timed DELETE could). Ticket rows are tiny and short-lived; this
 *  keeps the table lean without a cron. Purely hygienic: a store without the
 *  function (or a failed call) is a no-op — it never blocks a mint and NEVER
 *  falls back to an application-timed delete. */
export async function sweepWsTickets(db: PlayDbClient): Promise<void> {
	if (typeof db.rpc !== 'function') return;
	await db.rpc(WS_TICKET_CLEANUP_RPC, {});
}
