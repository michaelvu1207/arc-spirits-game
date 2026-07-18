/**
 * Socket lifecycle + room registry. Implements the wire protocol in server/protocol.ts:
 * ticket-authenticated join, joined/delta acks, per-connection viewer-filtered views,
 * resync, ping/pong, heartbeat-timeout close, and reconnect (resumeFromRevision →
 * delta with full view).
 *
 * SECURITY BOUNDARY:
 *  - The ONLY credential is the short-lived one-use room-scoped ticket
 *    (src/lib/play/server/wsTickets.ts), consumed atomically and verified against
 *    current authoritative rows: exact room, exact user, exact member, exact
 *    permission. Any failure — expired, forged, replayed, wrong room, wrong user,
 *    bot-bound, or a public member UUID where a ticket belongs — is a FATAL join
 *    error: the socket is closed and unregistered, never silently downgraded to
 *    spectator.
 *  - A socket belongs IMMUTABLY to one room: a second `join` frame is a fatal error
 *    and cannot leave the socket registered in the first room. Inbound frames are
 *    processed strictly IN ORDER per connection (chained, never concurrent), so two
 *    same-tick `join` frames cannot race past the guard and cross-register.
 *  - The join ticket authenticates the socket ONCE; it does not vouch forever.
 *    Every command and every private projection (resync, broadcast delta)
 *    RE-PROVES the member row against the durable store — existence, session,
 *    exact user, not-a-bot — and adopts the fresh role; ownership transfer,
 *    sign-out, account switch/deletion terminate the socket fatally. Socket
 *    lifetime is additionally bounded by an authenticated LEASE
 *    (ARC_WS_AUTH_LEASE_MS, default 15 min): past it the socket closes non-fatally
 *    and must reconnect with a fresh ticket.
 *  - Every outgoing view (ack, delta, resync, broadcast) recomputes the viewer's
 *    role/seat/private fields from the CURRENT authoritative state — release,
 *    takeover and reconnect can never leak stale owner information.
 *  - Every inbound frame is schema-validated (bounded strings, known types); the
 *    transport already caps frame size (`ws` maxPayload = MAX_CLIENT_FRAME_BYTES).
 *  - Commands pass the SAME deny-by-default admission policy as the HTTP boundary
 *    (src/lib/play/server/commandPolicy.ts) before the reducer — including the
 *    ranked prohibition on host/debug/rescue tools and the production prohibition
 *    on integrity tools. Spectator connections can never command.
 */

import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import {
	HEARTBEAT_TIMEOUT_MS,
	type ClientMessage,
	type JoinMessage,
	type ServerMessage
} from './protocol';
import type { RoomViewMember } from '../src/lib/play/viewV2';
import type { GameCommand, PublicGameState } from '../src/lib/play/types';
import { RoomHost } from './roomHost';
import {
	consumeWsTicket,
	getMemberById,
	touchMemberLastSeen,
	type SessionMemberRow
} from './supabase';
import {
	admitCommand,
	isValidCmdId,
	validateCommandShape,
	wsIntegrityToolsAllowed
} from '../src/lib/play/server/commandPolicy';
import type { ConsumeWsTicketResult } from '../src/lib/play/server/wsTickets';
import { actorForMember, viewerForMember, type Viewer } from './identity';
import { buildViewForViewer } from './view';

const SWEEP_INTERVAL_MS = 5000;
const ROOM_IDLE_EVICT_MS = Number(process.env.ROOM_IDLE_EVICT_MS ?? 60_000);

/** Default / hard bounds for the authenticated-socket lease. The bounds exist so a
 *  typo can never produce an effectively-unbounded (or busy-loop) lease: a socket's
 *  authority must always expire within a human-scale window. */
export const WS_AUTH_LEASE_DEFAULT_MS = 15 * 60_000;
export const WS_AUTH_LEASE_MIN_MS = 30_000;
export const WS_AUTH_LEASE_MAX_MS = 24 * 60 * 60_000;

/**
 * Validate ARC_WS_AUTH_LEASE_MS into a finite, positive, bounded lease.
 *
 * The pre-fix defect: `Number(garbage)` is NaN, and `elapsed > NaN` is always
 * false — a malformed value silently made the bounded lease INFINITE. Now a value
 * that is not a finite integer number of milliseconds inside
 * [{@link WS_AUTH_LEASE_MIN_MS}, {@link WS_AUTH_LEASE_MAX_MS}] REFUSES TO START
 * the server in production (fail closed at boot, where the operator sees it) and
 * falls back to the default with a loud warning everywhere else. The returned
 * value is always finite and in-bounds, so the sweep comparison can never be
 * defeated by NaN/Infinity.
 */
export function resolveWsAuthLeaseMs(
	raw: string | undefined = process.env.ARC_WS_AUTH_LEASE_MS,
	nodeEnv: string | undefined = process.env.NODE_ENV
): number {
	if (raw == null || raw.trim() === '') return WS_AUTH_LEASE_DEFAULT_MS;
	const parsed = Number(raw.trim());
	const invalid = !Number.isFinite(parsed) || !Number.isInteger(parsed);
	const outOfRange = !invalid && (parsed < WS_AUTH_LEASE_MIN_MS || parsed > WS_AUTH_LEASE_MAX_MS);
	if (invalid || outOfRange) {
		const problem = invalid
			? 'is not a finite integer millisecond value'
			: `is outside the safe bounds [${WS_AUTH_LEASE_MIN_MS}, ${WS_AUTH_LEASE_MAX_MS}] ms`;
		const message =
			`Invalid ARC_WS_AUTH_LEASE_MS: the configured value ${problem}. ` +
			`Set a finite integer between ${WS_AUTH_LEASE_MIN_MS} and ${WS_AUTH_LEASE_MAX_MS} ` +
			`milliseconds, or unset it for the default (${WS_AUTH_LEASE_DEFAULT_MS}).`;
		if (nodeEnv === 'production') {
			throw new Error(message);
		}
		console.warn(`[ws] ${message} Falling back to the default.`);
		return WS_AUTH_LEASE_DEFAULT_MS;
	}
	return parsed;
}

/** Bounded authenticated-socket lease: a live socket's authority is never
 *  indefinite. Past this window the socket is closed NON-fatally with
 *  `lease_expired`; the client's normal reconnect mints a fresh one-use ticket,
 *  which re-proves the caller's CURRENT identity/membership end-to-end. A captured
 *  live socket therefore expires even if its owner never acts. Resolved through
 *  {@link resolveWsAuthLeaseMs} AT MODULE LOAD, so a production deployment with a
 *  malformed value fails at startup instead of running with an infinite lease. */
export const WS_AUTH_LEASE_MS = resolveWsAuthLeaseMs();

/** Integrity tools (manual counters/spawns/debug) are admissible over this wire ONLY
 *  in the explicit local test mode — the same flag that enables the debug seed.
 *  PRODUCTION REFUSES THEM UNCONDITIONALLY: the gate is the shared
 *  wsIntegrityToolsAllowed in commandPolicy.ts, so no environment flag can
 *  re-enable them when NODE_ENV=production. Ranked rejects them regardless. */
function integrityToolsAllowed(): boolean {
	return wsIntegrityToolsAllowed();
}

function send(ws: WebSocket, msg: ServerMessage): void {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

interface RoomEntry {
	host: RoomHost;
	connections: Set<Connection>;
}

/** One live socket + its resolved identity. Identity is set exactly once, by a
 *  successfully consumed ticket; `role: 'spectator'` connections never command. */
class Connection {
	readonly ws: WebSocket;
	roomCode: string | null = null;
	member: SessionMemberRow | null = null;
	/** The ticket's permission level. 'member' ⇔ `member` is non-null. */
	permission: 'member' | 'spectator' | null = null;
	/** The validated account the ticket was bound to — every revalidation re-proves
	 *  the CURRENT member row still belongs to this exact user. */
	userId: string | null = null;
	/** When the ticket authenticated this socket; the lease is measured from here. */
	authenticatedAt = Date.now();
	lastSeenAt = Date.now();
	/** Per-connection frame serialization: every inbound frame is chained onto this
	 *  promise, so two same-tick frames (e.g. two `join`s) can never interleave
	 *  around each other's awaits. */
	frameChain: Promise<void> = Promise.resolve();

	constructor(ws: WebSocket, _req: IncomingMessage) {
		this.ws = ws;
	}
}

/** Injected persistence surface so the boundary is unit-testable against fakes. */
export interface RegistryDeps {
	consumeWsTicket(raw: unknown): Promise<ConsumeWsTicketResult>;
	getMemberById(memberId: string): Promise<SessionMemberRow | null>;
	touchMemberLastSeen(memberId: string): Promise<void>;
	loadRoomHost(roomCode: string): Promise<RoomHost | null>;
}

export function defaultRegistryDeps(): RegistryDeps {
	return {
		consumeWsTicket,
		getMemberById,
		touchMemberLastSeen,
		loadRoomHost: (roomCode) => RoomHost.load(roomCode)
	};
}

export class RoomRegistry {
	private rooms = new Map<string, RoomEntry>();
	/** In-flight cold-room loads, keyed by room code, so truly-simultaneous first joins
	 *  await the SAME entry instead of each loading their own host (double timers +
	 *  orphaned connection). Registered synchronously before the first await. */
	private loading = new Map<string, Promise<RoomEntry | null>>();
	private sweepTimer: NodeJS.Timeout | null = null;
	/** Count of actual RoomHost.load calls — exposed on /healthz so the concurrent-cold-join
	 *  regression test can assert exactly ONE load happens (the old double-load path did two). */
	private loadCount = 0;
	private readonly deps: RegistryDeps;

	constructor(deps: RegistryDeps = defaultRegistryDeps()) {
		this.deps = deps;
	}

	start(): void {
		if (this.sweepTimer) return;
		this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
		this.sweepTimer.unref?.();
	}

	stats(): { rooms: number; connections: number; roomLoads: number } {
		let connections = 0;
		for (const entry of this.rooms.values()) connections += entry.connections.size;
		return { rooms: this.rooms.size, connections, roomLoads: this.loadCount };
	}

	/** Wire a freshly-upgraded socket into the protocol handlers. Frames are
	 *  processed STRICTLY IN ORDER per connection (chained, never concurrent): a
	 *  pre-await guard like the join's `roomCode == null` check is therefore
	 *  race-free — two same-tick joins cannot both pass it and cross-register the
	 *  socket in two rooms. */
	handleSocket(ws: WebSocket, req: IncomingMessage): void {
		const conn = new Connection(ws, req);
		ws.on('message', (data) => {
			const raw = data.toString();
			// Liveness is stamped on RECEIPT (not on processing) so a long frame queue
			// can never let the heartbeat sweep kill an actively-sending client.
			conn.lastSeenAt = Date.now();
			conn.frameChain = conn.frameChain
				.then(() => this.onMessage(conn, raw))
				.catch(() => {
					/* onMessage handles its own errors; keep the chain unbroken */
				});
		});
		ws.on('close', () => this.onClose(conn));
		ws.on('error', () => this.onClose(conn));
	}

	/** Fatal protocol/auth failure: tell the client (no auto-retry), then close and
	 *  UNREGISTER the socket — a failed join never leaves a half-joined connection. */
	private fail(conn: Connection, code: string, message: string): void {
		send(conn.ws, { t: 'error', code, message, fatal: true });
		this.onClose(conn);
		try {
			conn.ws.close(4003, code);
		} catch {
			/* already closing */
		}
	}

	private async onMessage(conn: Connection, raw: string): Promise<void> {
		conn.lastSeenAt = Date.now();
		let msg: ClientMessage;
		try {
			msg = JSON.parse(raw) as ClientMessage;
		} catch {
			send(conn.ws, { t: 'error', code: 'bad_frame', message: 'Malformed JSON frame.' });
			return;
		}
		if (msg == null || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') {
			send(conn.ws, { t: 'error', code: 'bad_frame', message: 'Malformed frame.' });
			return;
		}
		try {
			switch (msg.t) {
				case 'join':
					await this.onJoin(conn, msg);
					break;
				case 'command':
					await this.onCommand(conn, msg.cmdId, msg.command);
					break;
				case 'resync':
					await this.onResync(
						conn,
						typeof msg.fromRevision === 'number' ? msg.fromRevision : undefined
					);
					break;
				case 'ping':
					send(conn.ws, { t: 'pong', ts: typeof msg.ts === 'number' ? msg.ts : 0 });
					break;
				default:
					send(conn.ws, { t: 'error', code: 'unknown_type', message: 'Unknown message type.' });
			}
		} catch (err) {
			send(conn.ws, {
				t: 'error',
				code: 'internal',
				message: err instanceof Error ? err.message : 'Internal error.'
			});
		}
	}

	private async onJoin(conn: Connection, msg: JoinMessage): Promise<void> {
		// A socket belongs immutably to ONE room. A second join — same or different
		// room — is a protocol violation; it must not leave the socket registered
		// anywhere, so it is fatal.
		if (conn.roomCode != null) {
			this.fail(conn, 'already_joined', 'This socket already joined a room.');
			return;
		}
		if (typeof msg.roomCode !== 'string' || msg.roomCode.length === 0 || msg.roomCode.length > 12) {
			this.fail(conn, 'bad_join', 'Malformed join frame.');
			return;
		}
		const roomCode = msg.roomCode.trim().toUpperCase();

		// ── Ticket: the ONLY credential. Consume atomically FIRST (a failed join must
		// still burn the ticket), then verify every binding. Failures are fatal —
		// never a silent spectator downgrade.
		const consumed = await this.deps.consumeWsTicket(msg.ticket);
		if (!consumed.ok) {
			this.fail(conn, 'bad_ticket', `Join ticket rejected (${consumed.reason}).`);
			return;
		}
		const ticket = consumed.ticket;

		const entry = await this.getOrLoadRoom(roomCode);
		if (!entry) {
			this.fail(conn, 'room_not_found', 'Room not found.');
			return;
		}
		// Exact room binding: the ticket must have been minted for THIS session.
		if (ticket.session_id !== entry.host.sessionId) {
			this.fail(conn, 'bad_ticket', 'Join ticket rejected (wrong room).');
			return;
		}

		// A (re)join must converge on the durable truth — the HTTP path or another
		// instance may have committed past this host's cache while it idled.
		if (await entry.host.ensureFresh()) entry.host.onServerAdvance?.();

		let member: SessionMemberRow | null = null;
		if (ticket.role === 'member') {
			if (!ticket.member_id) {
				this.fail(conn, 'bad_ticket', 'Join ticket rejected (no membership bound).');
				return;
			}
			member = await this.deps.getMemberById(ticket.member_id);
			// Exact user + session binding against the CURRENT row, and bots are
			// server-only actors — a bot-associated ticket never joins.
			if (
				!member ||
				member.session_id !== entry.host.sessionId ||
				member.user_id !== ticket.user_id ||
				member.is_bot
			) {
				this.fail(conn, 'bad_ticket', 'Join ticket rejected (membership no longer valid).');
				return;
			}
		}

		conn.roomCode = roomCode;
		conn.member = member;
		conn.permission = ticket.role;
		conn.userId = ticket.user_id;
		conn.authenticatedAt = Date.now();
		entry.connections.add(conn);
		entry.host.touchActivity();

		if (member) void this.deps.touchMemberLastSeen(member.id);

		const view = this.viewFor(entry.host, conn);
		const revision = entry.host.getRevision();
		const viewer = this.viewerFor(entry.host, conn);
		if (msg.resumeFromRevision != null) {
			// Reconnect: reply with a delta carrying the full current view (reconcile merges
			// a whole value regardless of how many revisions were missed offline).
			send(conn.ws, {
				t: 'delta',
				fromRevision: msg.resumeFromRevision,
				toRevision: revision,
				patch: view
			});
		} else {
			send(conn.ws, { t: 'joined', revision, seat: viewer.seatColor, role: viewer.role, view });
		}
	}

	/**
	 * Re-prove a member connection's authority against the CURRENT durable member
	 * row. The ticket authenticated the socket ONCE; ownership can change afterwards
	 * (sign-out, account switch/deletion, membership quarantine), so every command
	 * and every private projection re-verifies: the row still exists, still belongs
	 * to this session, still belongs to the EXACT user the ticket proved, and is not
	 * a bot. Role changes are absorbed (the fresh row replaces the cached one) so
	 * admission always judges the current role. Any failure terminates the socket
	 * FATALLY — a revoked identity never downgrades to spectator, because the caller
	 * behind it was never re-authenticated as one.
	 *
	 * Pure spectator connections carry no membership (their views are already the
	 * public spectator projection) — nothing to revalidate.
	 */
	private async revalidateAuthority(conn: Connection): Promise<boolean> {
		if (conn.permission !== 'member') return true;
		const memberId = conn.member?.id;
		if (!memberId) {
			this.fail(conn, 'authority_revoked', 'Membership no longer valid.');
			return false;
		}
		let fresh: SessionMemberRow | null = null;
		try {
			fresh = await this.deps.getMemberById(memberId);
		} catch {
			// The store is unreachable: we cannot PROVE authority, so we fail closed
			// (the client reconnects/falls back to HTTP, which enforces the same rules).
			this.fail(conn, 'authority_unverifiable', 'Could not verify membership.');
			return false;
		}
		const entry = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
		if (
			!fresh ||
			!entry ||
			fresh.session_id !== entry.host.sessionId ||
			fresh.user_id == null ||
			fresh.user_id !== conn.userId ||
			fresh.is_bot
		) {
			this.fail(conn, 'authority_revoked', 'Membership no longer valid.');
			return false;
		}
		conn.member = fresh;
		return true;
	}

	private async onCommand(conn: Connection, cmdId: unknown, command: unknown): Promise<void> {
		// The SAME bounded cmdId schema as the HTTP boundary — malformed ids never
		// reach the ledger.
		if (!isValidCmdId(cmdId)) {
			send(conn.ws, { t: 'error', code: 'bad_cmd_id', message: 'Malformed or missing cmdId.' });
			return;
		}
		const entry = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
		if (!entry || !entry.connections.has(conn)) {
			send(conn.ws, {
				t: 'ack',
				cmdId,
				ok: false,
				error: { code: 'not_joined', message: 'Join a room first.' }
			});
			return;
		}
		if (!conn.member || conn.permission !== 'member') {
			send(conn.ws, {
				t: 'ack',
				cmdId,
				ok: false,
				error: { code: 'not_a_member', message: 'Spectators cannot submit commands.' }
			});
			return;
		}

		// STALE-AUTHORITY GATE: the cached join-time identity never commits a command.
		// The CURRENT member row is re-proven (existence, session, exact user, not a
		// bot) and adopted (fresh role) before admission; a revoked socket dies here
		// with nothing written.
		if (!(await this.revalidateAuthority(conn))) return;

		// The actor's seat here is advisory only — RoomHost re-derives it from the
		// authoritative state on EVERY commit attempt (including after CAS-miss reloads),
		// so a concurrent release/takeover can never act under a stale seat.
		const actor = actorForMember(entry.host.getState(), conn.member);

		// Deny-by-default admission — identical policy to the HTTP boundary. A
		// rejection acks the failure and changes NOTHING (no reducer, no ledger).
		const admission = admitCommand(
			{
				mode: entry.host.getMode() === 'ranked' ? 'ranked' : 'casual',
				role: conn.member.role,
				seated: actor.seatColor != null,
				isBot: conn.member.is_bot,
				allowIntegrityTools: integrityToolsAllowed()
			},
			command
		);
		if (!admission.ok) {
			send(conn.ws, {
				t: 'ack',
				cmdId,
				ok: false,
				error: { code: admission.code, message: admission.message }
			});
			return;
		}

		const fromRevision = entry.host.getRevision();
		// Durable-first: applyCommand resolves only after the revision-CAS commit (and
		// its ledger row) landed, so this ack can never be rolled back by a crash. The
		// wire cmdId doubles as the durable idempotency key — an honest retry after a
		// lost ack (same socket, a new socket, or the HTTP fallback) is answered with
		// the CURRENT durable view plus `duplicateOfRevision`; the same cmdId with a
		// different actor/command rejects as `idempotency_conflict`.
		const outcome = await entry.host.applyCommand(actor, command as GameCommand, cmdId);
		if (!outcome.ok) {
			send(conn.ws, { t: 'ack', cmdId, ok: false, error: outcome.error });
			return;
		}
		// Ack with a FRESH view (viewer recomputed from the post-commit state inside
		// viewFor). Broadcast the delta to every OTHER connection.
		const actorView = this.viewFor(entry.host, conn);
		// Protocol invariant: ack.revision === ack.view.projection.revision. For a
		// duplicate the view is built from the CURRENT state, so the revision must be
		// read from the view itself, never from the original commit (which rides in
		// duplicateOfRevision instead).
		const ackRevision = outcome.duplicate ? actorView.projection.revision : outcome.revision;
		send(conn.ws, {
			t: 'ack',
			cmdId,
			ok: true,
			revision: ackRevision,
			view: actorView,
			...(outcome.duplicateOfRevision != null
				? { duplicateOfRevision: outcome.duplicateOfRevision }
				: {})
		});
		void this.broadcast(entry, fromRevision, ackRevision, conn);

		void this.deps.touchMemberLastSeen(conn.member.id);
	}

	private async onResync(conn: Connection, fromRevision: number | undefined): Promise<void> {
		const entry = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
		if (!entry || !entry.connections.has(conn)) return;
		// A resync answers with this viewer's PRIVATE projection — re-prove authority
		// against the current member row first (fatal close on revocation).
		if (!(await this.revalidateAuthority(conn))) return;
		// A resync is the client saying "I may have missed something" (woke from
		// background, detected a gap) — converge on the durable truth before replying.
		if (await entry.host.ensureFresh()) entry.host.onServerAdvance?.();
		const revision = entry.host.getRevision();
		send(conn.ws, {
			t: 'delta',
			fromRevision: fromRevision ?? revision,
			toRevision: revision,
			patch: this.viewFor(entry.host, conn)
		});
	}

	private onClose(conn: Connection): void {
		if (!conn.roomCode) return;
		const entry = this.rooms.get(conn.roomCode);
		if (entry) entry.connections.delete(conn);
		conn.roomCode = null;
		conn.member = null;
		conn.permission = null;
	}

	/** The connection's CURRENT viewer identity, derived from the authoritative state
	 *  EVERY time — never cached across revisions, so seat release/takeover and
	 *  cross-room state can never leak a stale owner view. */
	private viewerFor(host: RoomHost, conn: Connection): Viewer {
		return viewerForMember(host.getState(), conn.member);
	}

	/** Build a fresh, viewer-filtered view for one connection (never shared across
	 *  sockets), stamped with truthful room metadata. */
	private viewFor(host: RoomHost, conn: Connection) {
		const viewer = this.viewerFor(host, conn);
		const memberBlock: RoomViewMember = {
			id: conn.member?.id ?? null,
			role: viewer.role,
			seatColor: viewer.seatColor,
			displayName: viewer.displayName
		};
		const view = buildViewForViewer(
			host.getState(),
			viewer,
			memberBlock,
			host.getCatalog(),
			host.getBotMembers()
		);
		// Truthful room metadata on every outgoing view (mirrors the HTTP stamping).
		view.projection.mode = host.getMode() === 'ranked' ? 'ranked' : 'casual';
		view.projection.visibility = host.getVisibility();
		view.projection.rated = host.getMode() === 'ranked';
		return view;
	}

	/** Push a per-connection delta to every connection except the excluded one (the actor,
	 *  who receives the ack-with-view instead). Every MEMBER recipient's authority is
	 *  re-proven against the current member row before its private projection is
	 *  built — a socket whose membership changed hands since join is terminated here
	 *  instead of receiving another owner view. The view itself is always built from
	 *  the live state at send time, so interleaved broadcasts can never regress a
	 *  recipient to older data. */
	private async broadcast(
		entry: RoomEntry,
		fromRevision: number,
		toRevision: number,
		except?: Connection
	): Promise<void> {
		for (const conn of [...entry.connections]) {
			if (conn === except) continue;
			if (!(await this.revalidateAuthority(conn))) continue;
			send(conn.ws, {
				t: 'delta',
				fromRevision,
				toRevision,
				patch: this.viewFor(entry.host, conn)
			});
		}
	}

	/**
	 * Get the room's entry, loading it (once) on the first join. NOT async: it registers
	 * the in-flight load promise in `this.loading` SYNCHRONOUSLY before any await, so two
	 * truly-simultaneous first joins to a cold room both await the SAME promise — exactly
	 * one RoomHost is loaded, one timer starts, one entry holds both connections. On failure
	 * (null / throw) the pending entry is evicted so a later join can retry cleanly.
	 */
	private getOrLoadRoom(roomCode: string): Promise<RoomEntry | null> {
		const existing = this.rooms.get(roomCode);
		if (existing) return Promise.resolve(existing);
		const inFlight = this.loading.get(roomCode);
		if (inFlight) return inFlight;

		const load = (async (): Promise<RoomEntry | null> => {
			try {
				this.loadCount += 1;
				const host = await this.deps.loadRoomHost(roomCode);
				if (!host) return null;
				const entry: RoomEntry = { host, connections: new Set() };
				let lastBroadcastRev = host.getRevision();
				host.onServerAdvance = () => {
					// Server-driven advances (deadline enforcement / bot moves) broadcast to everyone.
					const to = host.getRevision();
					void this.broadcast(entry, lastBroadcastRev, to);
					lastBroadcastRev = to;
				};
				this.rooms.set(roomCode, entry);
				host.start(); // begin the in-process tick loop (deadline enforcement + bots)
				return entry;
			} finally {
				this.loading.delete(roomCode); // clear the in-flight marker (success, null, or throw)
			}
		})();
		this.loading.set(roomCode, load);
		return load;
	}

	private async sweep(): Promise<void> {
		const now = Date.now();

		for (const [roomCode, entry] of this.rooms) {
			// Heartbeat timeout: close sockets that went silent past the window.
			for (const conn of entry.connections) {
				if (now - conn.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
					try {
						conn.ws.close(4000, 'heartbeat timeout');
					} catch {
						/* already gone */
					}
					entry.connections.delete(conn);
					continue;
				}
				// Authenticated-lease expiry: the ticket's proof of identity is not
				// forever. A NON-fatal close — the client's reconnect mints a fresh
				// one-use ticket, re-proving current identity/membership; a captured
				// socket without credentials dies here for good.
				if (now - conn.authenticatedAt > WS_AUTH_LEASE_MS) {
					send(conn.ws, {
						t: 'error',
						code: 'lease_expired',
						message: 'Authenticated session lease expired — reconnect to continue.'
					});
					try {
						conn.ws.close(4001, 'lease expired');
					} catch {
						/* already gone */
					}
					entry.connections.delete(conn);
				}
			}

			// Deadline enforcement + bot moves run on the host's own tick timer (started on
			// load), not here — the sweep only evicts. There is nothing to flush on the way
			// out: every mutation was committed durably (revision CAS) before it was acked.
			const idle = now - entry.host.idleSince() > ROOM_IDLE_EVICT_MS;
			if (entry.connections.size === 0 && (idle || entry.host.isTerminal())) {
				entry.host.stop(); // halt the tick timer before dropping the room
				this.rooms.delete(roomCode);
			}
		}
	}

	/** Graceful shutdown. No flush needed: acked state is already durable (write-
	 *  through commits), so dropping the in-memory caches loses nothing. */
	async shutdown(): Promise<void> {
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		for (const entry of this.rooms.values()) {
			entry.host.stop(); // halt tick timers
			for (const conn of entry.connections) {
				try {
					conn.ws.close(1001, 'server shutting down');
				} catch {
					/* ignore */
				}
			}
		}
		this.rooms.clear();
	}

	/** Test/introspection hook: the live PublicGameState for a loaded room (or null). */
	peekState(roomCode: string): PublicGameState | null {
		return this.rooms.get(roomCode.toUpperCase())?.host.getState() ?? null;
	}

	/** Test/introspection hook: is this exact connection registered in this room? */
	connectionCount(roomCode: string): number {
		return this.rooms.get(roomCode.toUpperCase())?.connections.size ?? 0;
	}
}

export type { Connection };
