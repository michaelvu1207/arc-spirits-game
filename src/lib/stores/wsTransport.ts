/**
 * Client side of the long-lived Arc Spirits room WebSocket (server/protocol.ts).
 *
 * Responsibilities, all mirroring the wire contract:
 *   - open a socket, `join` (with `resumeFromRevision` on a reconnect);
 *   - `sendCommand` → a Promise resolved by the cmdId-matched `ack` (many may be in flight);
 *   - apply `joined` / ack-ok / `delta` views through a single `onView` callback, guarded by
 *     the STALENESS RULE (never regress the board: an ack/delta whose view revision is older
 *     than what we've already applied only retires its cmdId — same test as isStaleRoomUpdate);
 *   - `ping`/`pong` heartbeat on the committed HEARTBEAT_* cadence, with a dead-socket timeout;
 *   - exponential-backoff reconnect that resumes from the last applied revision;
 *   - clean, intentional close (no reconnect).
 *
 * This module owns NO reactive state — the play store adapts the callbacks into `$state`. It is
 * therefore a plain `.ts` class, unit-testable against a fake socket with no Svelte runtime.
 */

import type { AckMessage, ServerMessage, WsError } from '$lib/play/wsProtocol';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from '$lib/play/wsProtocol';
import type { GameCommand } from '$lib/play/types';
import type { RoomViewV2 } from '$lib/play/viewV2';

/** The `WebSocket.OPEN` ready-state, hard-coded so the transport never depends on the DOM
 *  global existing (tests inject a fake, node has no `WebSocket`). */
const WS_OPEN = 1;

/** The minimal WebSocket surface the transport depends on, so tests can inject a fake and the
 *  browser's real `WebSocket` is used in production via {@link WsTransportOptions.createSocket}. */
export interface WebSocketLike {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	readyState: number;
	onopen: ((ev?: unknown) => void) | null;
	onclose: ((ev?: unknown) => void) | null;
	onerror: ((ev?: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => WebSocketLike;

/** A resolved command: the ack was ok, and its fresh view has already been handed to `onView`
 *  (subject to the staleness rule). */
export interface CommandOk {
	ok: true;
	revision: number;
	view: RoomViewV2;
}

/** The server rejected the command (`ack.ok === false`). The caller should surface this — an
 *  HTTP retry would be rejected identically — and roll back any optimistic mutation. */
export class WsCommandRejected extends Error {
	readonly code: string;
	constructor(error: WsError) {
		super(error.message);
		this.name = 'WsCommandRejected';
		this.code = error.code;
	}
}

/** The command could not be delivered/acked over the socket (never joined, socket dropped,
 *  transport closed). Distinct from {@link WsCommandRejected} so the caller can FALL BACK to
 *  the HTTP path instead of showing the user an error. */
export class WsTransportUnavailable extends Error {
	constructor(message = 'WebSocket transport unavailable') {
		super(message);
		this.name = 'WsTransportUnavailable';
	}
}

export interface WsTransportHandlers {
	/**
	 * A fresh authoritative view arrived and PASSED the staleness gate — apply it
	 * unconditionally (it carries `projection` + own-seat `affordances`). Fired for `joined`,
	 * ack-ok, and `delta`.
	 */
	onView: (view: RoomViewV2) => void;
	/** Transport reachability changed: `connected` true once `join` is acknowledged, false on
	 *  close/reconnect. The store uses this only to decide whether to ROUTE commands over WS —
	 *  the disconnect banner stays owned by the HTTP poll/watchdog safety net. */
	onStatus?: (status: { connected: boolean; reconnecting: boolean }) => void;
	/** A fatal, non-retryable server error (`error` with `fatal`, or a rejected join). The
	 *  socket is closed and NOT retried. */
	onFatal?: (error: WsError) => void;
}

export interface WsTransportOptions {
	/** Socket constructor; defaults to the browser `WebSocket`. Injected by tests. */
	createSocket?: SocketFactory;
	heartbeatIntervalMs?: number;
	heartbeatTimeoutMs?: number;
	/** Reconnect backoff floor / ceiling; the delay doubles each attempt between them. */
	minBackoffMs?: number;
	maxBackoffMs?: number;
}

interface PendingCommand {
	resolve: (result: CommandOk) => void;
	reject: (error: Error) => void;
}

const defaultSocketFactory: SocketFactory = (url) =>
	new WebSocket(url) as unknown as WebSocketLike;

let cmdCounter = 0;
/** One id per LOGICAL player action. Exported so the store can mint it once and reuse
 *  it across a WS attempt AND its HTTP fallback — the server's durable idempotency
 *  ledger then guarantees the action applies exactly once no matter which transport
 *  (or how many retries) actually landed it. */
export function nextCommandId(): string {
	cmdCounter += 1;
	return `c${Date.now().toString(36)}-${cmdCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class WsTransport {
	private readonly handlers: WsTransportHandlers;
	private readonly createSocket: SocketFactory;
	private readonly heartbeatIntervalMs: number;
	private readonly heartbeatTimeoutMs: number;
	private readonly minBackoffMs: number;
	private readonly maxBackoffMs: number;

	private socket: WebSocketLike | null = null;
	private url: string | null = null;
	private roomCode: string | null = null;
	/** Mints a fresh ONE-USE join ticket for every (re)connect — the only credential
	 *  the room server accepts. Null ⇒ the join cannot proceed (fatal, no silent
	 *  spectator downgrade); the store falls back to the HTTP path. */
	private getTicket: (() => Promise<string | null>) | null = null;
	/** Monotonic socket generation so a ticket minted for a dead socket is never
	 *  sent on its successor. */
	private socketGeneration = 0;

	/** Highest revision we have APPLIED. Doubles as `resumeFromRevision` on reconnect and as
	 *  the staleness watermark (mirrors isStaleRoomUpdate: reject `next.revision < this`). */
	private appliedRevision = -1;
	/** Set once `join` is acknowledged (`joined` or a resume `delta`), so commands queued
	 *  before the handshake are flushed exactly once. */
	private joined = false;
	/** Deliberately closed by the caller — suppresses reconnect. */
	private intentionallyClosed = false;
	private reconnectAttempts = 0;

	private readonly pending = new Map<string, PendingCommand>();
	/** Commands submitted before the socket is open/joined; flushed on `joined`. */
	private readonly outbox: { cmdId: string; command: GameCommand }[] = [];

	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private lastServerMessageAt = 0;

	constructor(handlers: WsTransportHandlers, options: WsTransportOptions = {}) {
		this.handlers = handlers;
		this.createSocket = options.createSocket ?? defaultSocketFactory;
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
		this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
		this.minBackoffMs = options.minBackoffMs ?? 1_000;
		this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
	}

	/** True once the join handshake is complete and the socket is open — the store's gate for
	 *  routing a command over WS vs HTTP. */
	get isConnected(): boolean {
		return this.joined && this.socket?.readyState === WS_OPEN;
	}

	/** The highest revision applied so far (−1 before the first view). */
	get revision(): number {
		return this.appliedRevision;
	}

	/** Open the socket and join `roomCode`. Idempotent-ish: a second call re-points the
	 *  transport at a (possibly new) room and reconnects cleanly. `getTicket` is
	 *  called once per (re)connect to mint a fresh one-use join ticket. */
	connect(url: string, roomCode: string, getTicket: () => Promise<string | null>): void {
		// Re-targeting a different room resets the revision watermark so the new room's lower
		// revisions are not rejected as "stale".
		if (roomCode !== this.roomCode) this.appliedRevision = -1;
		this.url = url;
		this.roomCode = roomCode;
		this.getTicket = getTicket;
		this.intentionallyClosed = false;
		this.reconnectAttempts = 0;
		this.openSocket();
	}

	/** Submit a command; the returned Promise settles on the cmdId-matched ack:
	 *   - resolves with the fresh view on ok (already applied via `onView`);
	 *   - rejects with {@link WsCommandRejected} on a server rejection;
	 *   - rejects with {@link WsTransportUnavailable} if the socket drops before the ack. */
	sendCommand(
		command: GameCommand,
		expectedRevision?: number,
		externalCmdId?: string
	): Promise<CommandOk> {
		if (this.intentionallyClosed || !this.roomCode) {
			return Promise.reject(new WsTransportUnavailable('Transport is closed'));
		}
		const cmdId = externalCmdId ?? nextCommandId();
		return new Promise<CommandOk>((resolve, reject) => {
			this.pending.set(cmdId, { resolve, reject });
			const frame = { cmdId, command, expectedRevision };
			if (this.isConnected) {
				this.sendFrame({ t: 'command', ...frame });
			} else {
				// Not joined yet (opening / reconnecting) — queue and flush on `joined`. A drop
				// before then rejects it via failPending → HTTP fallback.
				this.outbox.push({ cmdId, command });
			}
		});
	}

	/** Force a full refresh on the live socket (woke from background / detected a gap). The
	 *  server replies with a `delta` carrying the full current view. */
	resync(): void {
		if (this.isConnected) {
			this.sendFrame({ t: 'resync', fromRevision: this.appliedRevision >= 0 ? this.appliedRevision : undefined });
		}
	}

	/** Deliberate teardown: no reconnect, in-flight commands rejected so callers fall back. */
	close(): void {
		this.intentionallyClosed = true;
		this.clearTimers();
		this.failPending(new WsTransportUnavailable('Transport closed'));
		this.teardownSocket();
		this.joined = false;
		this.handlers.onStatus?.({ connected: false, reconnecting: false });
	}

	// ── internals ──────────────────────────────────────────────────────────────

	private openSocket(): void {
		if (!this.url || !this.roomCode) return;
		this.teardownSocket();
		this.joined = false;
		this.socketGeneration += 1;
		let socket: WebSocketLike;
		try {
			socket = this.createSocket(this.url);
		} catch {
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;
		socket.onopen = () => this.onOpen();
		socket.onmessage = (ev) => this.onMessage(ev);
		socket.onerror = () => {
			/* surfaced via the following onclose */
		};
		socket.onclose = () => this.onClose();
	}

	private onOpen(): void {
		this.lastServerMessageAt = Date.now();
		this.startHeartbeat();
		void this.sendJoin(this.socketGeneration);
	}

	/** Mint a fresh one-use ticket and send the join frame. A mint failure is FATAL
	 *  for the transport (the server would refuse the join anyway — there is no
	 *  credential-less spectator downgrade); the store keeps its HTTP path. */
	private async sendJoin(generation: number): Promise<void> {
		let ticket: string | null = null;
		try {
			ticket = this.getTicket ? await this.getTicket() : null;
		} catch {
			ticket = null;
		}
		// The socket may have died (or been replaced) while the ticket was minting —
		// a ticket is bound to one join attempt on one socket.
		if (generation !== this.socketGeneration || this.socket?.readyState !== WS_OPEN) return;
		if (!ticket) {
			this.handleError({ code: 'no_ticket', message: 'Could not obtain a join ticket.', fatal: true });
			return;
		}
		this.sendFrame({
			t: 'join',
			roomCode: this.roomCode as string,
			ticket,
			resumeFromRevision: this.appliedRevision >= 0 ? this.appliedRevision : undefined
		});
	}

	private onMessage(ev: { data: unknown }): void {
		this.lastServerMessageAt = Date.now();
		let msg: ServerMessage;
		try {
			msg = JSON.parse(String(ev.data)) as ServerMessage;
		} catch {
			return;
		}
		switch (msg.t) {
			case 'joined':
				this.markJoined();
				this.applyView(msg.view);
				break;
			case 'delta':
				this.markJoined();
				// Envelope metadata gates staleness; the body is the full view (protocol M0).
				this.applyViewIfFresh(msg.patch, msg.toRevision);
				break;
			case 'ack':
				this.handleAck(msg);
				break;
			case 'pong':
				// liveness already recorded via lastServerMessageAt
				break;
			case 'error':
				this.handleError(msg);
				break;
		}
	}

	private handleAck(msg: Extract<AckMessage, { t: 'ack' }>): void {
		const waiter = this.pending.get(msg.cmdId);
		this.pending.delete(msg.cmdId);
		if (msg.ok) {
			// Apply the fresh view unless it is older than what we've already applied — the
			// staleness rule: a broadcast delta for a newer revision may have landed first.
			const applied = this.applyViewIfFresh(msg.view, msg.revision);
			waiter?.resolve({ ok: true, revision: msg.revision, view: msg.view });
			void applied;
		} else {
			waiter?.reject(new WsCommandRejected(msg.error));
		}
	}

	private handleError(msg: { code: string; message: string; fatal?: boolean }): void {
		if (msg.fatal) {
			this.intentionallyClosed = true;
			this.clearTimers();
			this.failPending(new WsTransportUnavailable(msg.message));
			this.teardownSocket();
			this.joined = false;
			this.handlers.onStatus?.({ connected: false, reconnecting: false });
			this.handlers.onFatal?.({ code: msg.code, message: msg.message });
		}
		// Non-fatal errors are advisory; the socket stays up.
	}

	private markJoined(): void {
		if (this.joined) return;
		this.joined = true;
		this.reconnectAttempts = 0;
		this.handlers.onStatus?.({ connected: true, reconnecting: false });
		this.flushOutbox();
	}

	private flushOutbox(): void {
		if (!this.isConnected) return;
		for (const { cmdId, command } of this.outbox.splice(0)) {
			// A command may have been retired already if its socket dropped and re-opened; only
			// send those still awaiting an ack.
			if (this.pending.has(cmdId)) this.sendFrame({ t: 'command', cmdId, command });
		}
	}

	/** Apply a view only when it does not regress the board (revision >= watermark). Returns
	 *  whether it was applied. Mirrors isStaleRoomUpdate's `next.revision < current.revision`. */
	private applyViewIfFresh(view: RoomViewV2, revision: number): boolean {
		if (revision < this.appliedRevision) return false;
		this.appliedRevision = revision;
		this.handlers.onView(view);
		return true;
	}

	/** Apply a view whose revision is read from its own projection (joined has no envelope). */
	private applyView(view: RoomViewV2): void {
		this.applyViewIfFresh(view, view.projection.revision);
	}

	private sendFrame(frame: Record<string, unknown>): void {
		try {
			this.socket?.send(JSON.stringify(frame));
		} catch {
			/* a failed send surfaces as onclose → reconnect */
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			if (Date.now() - this.lastServerMessageAt > this.heartbeatTimeoutMs) {
				// Dead socket: force a close so onClose drives the backoff reconnect.
				this.teardownSocket();
				this.onClose();
				return;
			}
			if (this.socket?.readyState === WS_OPEN) {
				this.sendFrame({ t: 'ping', ts: Date.now() });
			}
		}, this.heartbeatIntervalMs);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private onClose(): void {
		this.stopHeartbeat();
		this.joined = false;
		this.socket = null;
		if (this.intentionallyClosed) return;
		// In-flight commands can't be acked on a dead socket — reject so the caller falls back
		// to HTTP rather than hanging. Queued (unsent) commands are rejected too.
		this.failPending(new WsTransportUnavailable('Socket closed before ack'));
		this.handlers.onStatus?.({ connected: false, reconnecting: true });
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.intentionallyClosed || this.reconnectTimer) return;
		const delay = Math.min(
			this.maxBackoffMs,
			this.minBackoffMs * 2 ** this.reconnectAttempts
		);
		this.reconnectAttempts += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.openSocket();
		}, delay);
	}

	private failPending(error: Error): void {
		for (const waiter of this.pending.values()) waiter.reject(error);
		this.pending.clear();
		this.outbox.length = 0;
	}

	private teardownSocket(): void {
		const socket = this.socket;
		this.socket = null;
		if (!socket) return;
		socket.onopen = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
		try {
			socket.close();
		} catch {
			/* already closing */
		}
	}

	private clearTimers(): void {
		this.stopHeartbeat();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}
}
