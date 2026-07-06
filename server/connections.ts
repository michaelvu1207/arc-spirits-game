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
	/** Serializes concurrent first-join loads for the same room. */
	loading?: Promise<RoomHost | null>;
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
	private sweepTimer: NodeJS.Timeout | null = null;
	private lastSnapshotAt = 0;

	start(): void {
		if (this.sweepTimer) return;
		this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
		this.sweepTimer.unref?.();
	}

	stats(): { rooms: number; connections: number } {
		let connections = 0;
		for (const entry of this.rooms.values()) connections += entry.connections.size;
		return { rooms: this.rooms.size, connections };
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

	private async getOrLoadRoom(roomCode: string): Promise<RoomEntry | null> {
		const existing = this.rooms.get(roomCode);
		if (existing) return existing;
		// Deduplicate concurrent first-join loads.
		const placeholder: RoomEntry = { host: null as unknown as RoomHost, connections: new Set() };
		placeholder.loading = RoomHost.load(roomCode);
		const host = await placeholder.loading;
		if (!host) return null;
		// Another join may have populated it while we awaited.
		const raced = this.rooms.get(roomCode);
		if (raced && raced.host) return raced;
		const entry: RoomEntry = { host, connections: placeholder.connections };
		entry.host.onServerAdvance = () => {
			const from = entry.host.getRevision();
			// Server-driven advances (M0e) broadcast to everyone.
			this.broadcast(entry, from, entry.host.getRevision());
		};
		this.rooms.set(roomCode, entry);
		return entry;
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

			entry.host.tick(); // M0e seam (deadline enforcement + bot ticks)

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
