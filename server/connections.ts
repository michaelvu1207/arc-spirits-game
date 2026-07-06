/**
 * Socket lifecycle + room registry. Implements the wire protocol in server/protocol.ts:
 * join auth, joined/delta acks, per-connection viewer-filtered views, resync, ping/pong,
 * heartbeat-timeout close, and reconnect (resumeFromRevision → delta with full view).
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
	getMemberById,
	getMemberBySessionAndUser,
	resolveUserIdFromAccessToken,
	touchMemberLastSeen,
	type SessionMemberRow
} from './supabase';
import { actorForMember, viewerForMember, type Viewer } from './identity';
import { buildViewForViewer } from './view';

const ROOM_COOKIE_PREFIX = 'arc_spirits_play_member_';
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS ?? 5000);
const SWEEP_INTERVAL_MS = 5000;
const ROOM_IDLE_EVICT_MS = Number(process.env.ROOM_IDLE_EVICT_MS ?? 60_000);

function send(ws: WebSocket, msg: ServerMessage): void {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function parseCookies(header: string | undefined): Map<string, string> {
	const out = new Map<string, string>();
	if (!header) return out;
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		out.set(part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1).trim()));
	}
	return out;
}

interface RoomEntry {
	host: RoomHost;
	connections: Set<Connection>;
}

/** One live socket + its resolved identity. */
class Connection {
	readonly ws: WebSocket;
	private readonly cookieHeader: string | undefined;
	roomCode: string | null = null;
	member: SessionMemberRow | null = null;
	viewer: Viewer = { role: 'spectator', seatColor: null, displayName: null };
	lastSeenAt = Date.now();

	constructor(ws: WebSocket, req: IncomingMessage) {
		this.ws = ws;
		this.cookieHeader = req.headers.cookie;
	}

	memberBlock(): RoomViewMember {
		return {
			id: this.member?.id ?? null,
			role: this.viewer.role,
			seatColor: this.viewer.seatColor,
			displayName: this.viewer.displayName
		};
	}

	/** The member id carried by the upgrade cookie for this room, if any. */
	cookieMemberId(roomCode: string): string | null {
		const cookies = parseCookies(this.cookieHeader);
		return cookies.get(`${ROOM_COOKIE_PREFIX}${roomCode.toUpperCase()}`) ?? null;
	}
}

export class RoomRegistry {
	private rooms = new Map<string, RoomEntry>();
	/** In-flight cold-room loads, keyed by room code, so truly-simultaneous first joins
	 *  await the SAME entry instead of each loading their own host (double timers +
	 *  orphaned connection). Registered synchronously before the first await. */
	private loading = new Map<string, Promise<RoomEntry | null>>();
	private sweepTimer: NodeJS.Timeout | null = null;
	private lastSnapshotAt = 0;
	/** Count of actual RoomHost.load calls — exposed on /healthz so the concurrent-cold-join
	 *  regression test can assert exactly ONE load happens (the old double-load path did two). */
	private loadCount = 0;

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

	/** Wire a freshly-upgraded socket into the protocol handlers. */
	handleSocket(ws: WebSocket, req: IncomingMessage): void {
		const conn = new Connection(ws, req);
		ws.on('message', (data) => {
			void this.onMessage(conn, data.toString());
		});
		ws.on('close', () => this.onClose(conn));
		ws.on('error', () => this.onClose(conn));
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
		try {
			switch (msg.t) {
				case 'join':
					await this.onJoin(conn, msg);
					break;
				case 'command':
					await this.onCommand(conn, msg.cmdId, msg.command);
					break;
				case 'resync':
					this.onResync(conn, msg.fromRevision);
					break;
				case 'ping':
					send(conn.ws, { t: 'pong', ts: msg.ts });
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
		const roomCode = msg.roomCode.trim().toUpperCase();
		const entry = await this.getOrLoadRoom(roomCode);
		if (!entry) {
			send(conn.ws, { t: 'error', code: 'room_not_found', message: 'Room not found.', fatal: true });
			return;
		}

		const member = await this.resolveMember(entry.host, conn, msg);
		conn.roomCode = roomCode;
		conn.member = member;
		conn.viewer = viewerForMember(entry.host.getState(), member);
		entry.connections.add(conn);
		entry.host.touchActivity();

		if (member) void touchMemberLastSeen(member.id);

		const view = this.viewFor(entry.host, conn);
		const revision = entry.host.getRevision();
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
			send(conn.ws, { t: 'joined', revision, seat: conn.viewer.seatColor, role: conn.viewer.role, view });
		}
	}

	private async onCommand(conn: Connection, cmdId: string, command: GameCommand): Promise<void> {
		const entry = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
		if (!entry) {
			send(conn.ws, { t: 'ack', cmdId, ok: false, error: { code: 'not_joined', message: 'Join a room first.' } });
			return;
		}
		if (!conn.member) {
			send(conn.ws, {
				t: 'ack',
				cmdId,
				ok: false,
				error: { code: 'not_a_member', message: 'Spectators cannot submit commands.' }
			});
			return;
		}
		const actor = actorForMember(entry.host.getState(), conn.member);
		const fromRevision = entry.host.getRevision();
		const outcome = await entry.host.applyCommand(actor, command);
		if (!outcome.ok) {
			send(conn.ws, { t: 'ack', cmdId, ok: false, error: outcome.error });
			return;
		}
		// Recompute this connection's identity (its seat may have changed, e.g. claimSeat)
		// and ack with the fresh full view. Broadcast the delta to every OTHER connection.
		conn.viewer = viewerForMember(entry.host.getState(), conn.member);
		const actorView = this.viewFor(entry.host, conn);
		send(conn.ws, { t: 'ack', cmdId, ok: true, revision: outcome.revision, view: actorView });
		this.broadcast(entry, fromRevision, outcome.revision, conn);

		if (conn.member) void touchMemberLastSeen(conn.member.id);
		// A terminal command should land in the store promptly, not wait for the interval.
		if (entry.host.isTerminal()) void entry.host.snapshotIfDirty();
	}

	private onResync(conn: Connection, fromRevision: number | undefined): void {
		const entry = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
		if (!entry) return;
		conn.viewer = viewerForMember(entry.host.getState(), conn.member);
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
		if (!entry) return;
		entry.connections.delete(conn);
	}

	/** Build a fresh, viewer-filtered view for one connection (never shared across sockets). */
	private viewFor(host: RoomHost, conn: Connection) {
		return buildViewForViewer(
			host.getState(),
			conn.viewer,
			conn.memberBlock(),
			host.getCatalog(),
			host.getBotMembers()
		);
	}

	/** Push a per-connection delta to every connection except the excluded one (the actor,
	 *  who receives the ack-with-view instead). */
	private broadcast(
		entry: RoomEntry,
		fromRevision: number,
		toRevision: number,
		except?: Connection
	): void {
		for (const conn of entry.connections) {
			if (conn === except) continue;
			send(conn.ws, {
				t: 'delta',
				fromRevision,
				toRevision,
				patch: this.viewFor(entry.host, conn)
			});
		}
	}

	private async resolveMember(
		host: RoomHost,
		conn: Connection,
		msg: JoinMessage
	): Promise<SessionMemberRow | null> {
		// 1) explicit member token, else 2) the upgrade cookie for this room.
		const memberId = msg.memberToken ?? conn.cookieMemberId(host.roomCode);
		if (memberId) {
			const row = await getMemberById(memberId);
			if (row && row.session_id === host.sessionId) return row;
		}
		// 3) matchmade fallback: Supabase bearer → user → membership by user.
		if (msg.authToken) {
			const userId = await resolveUserIdFromAccessToken(msg.authToken);
			if (userId) {
				const row = await getMemberBySessionAndUser(host.sessionId, userId);
				if (row) return row;
			}
		}
		return null; // spectator
	}

	/**
	 * Get the room's entry, loading it (once) on the first join. NOT async: it registers
	 * the in-flight load promise in `this.loading` SYNCHRONOUSLY before any await, so two
	 * truly-simultaneous first joins to a cold room both await the SAME promise — exactly
	 * one RoomHost is loaded, one timer starts, one entry holds both connections. On failure
	 * (null / throw) the pending entry is evicted so a later join can retry cleanly.
	 */
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
				const host = await RoomHost.load(roomCode);
				if (!host) return null;
				const entry: RoomEntry = { host, connections: new Set() };
				let lastBroadcastRev = host.getRevision();
				host.onServerAdvance = () => {
					// Server-driven advances (deadline enforcement / bot moves) broadcast to everyone.
					const to = host.getRevision();
					this.broadcast(entry, lastBroadcastRev, to);
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
		const dueSnapshot = now - this.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS;
		if (dueSnapshot) this.lastSnapshotAt = now;

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
				}
			}

			// Deadline enforcement + bot moves run on the host's own tick timer (started on
			// load), not here — the sweep only snapshots + evicts.
			if (dueSnapshot) {
				try {
					await entry.host.snapshotIfDirty();
				} catch (err) {
					console.error(`[room ${roomCode}] snapshot failed:`, (err as Error).message);
				}
			}

			// Evict an idle room with no sockets (final snapshot on the way out).
			const idle = now - entry.host.idleSince() > ROOM_IDLE_EVICT_MS;
			if (entry.connections.size === 0 && (idle || entry.host.isTerminal())) {
				entry.host.stop(); // halt the tick timer before dropping the room
				try {
					await entry.host.flush();
				} catch (err) {
					console.error(`[room ${roomCode}] evict flush failed:`, (err as Error).message);
				}
				this.rooms.delete(roomCode);
			}
		}
	}

	/** Graceful shutdown: flush every dirty room, then drop them. */
	async shutdown(): Promise<void> {
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		const flushes: Promise<void>[] = [];
		for (const entry of this.rooms.values()) {
			entry.host.stop(); // halt tick timers before the final flush
			flushes.push(
				entry.host.flush().catch((err) => {
					console.error('[shutdown] flush failed:', (err as Error).message);
				})
			);
			for (const conn of entry.connections) {
				try {
					conn.ws.close(1001, 'server shutting down');
				} catch {
					/* ignore */
				}
			}
		}
		await Promise.all(flushes);
		this.rooms.clear();
	}

	/** Test/introspection hook: the live PublicGameState for a loaded room (or null). */
	peekState(roomCode: string): PublicGameState | null {
		return this.rooms.get(roomCode.toUpperCase())?.host.getState() ?? null;
	}
}

export type { Connection };
export { ROOM_COOKIE_PREFIX };
