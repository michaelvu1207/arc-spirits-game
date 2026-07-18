import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	WsTransport,
	WsCommandRejected,
	WsTransportUnavailable,
	type WebSocketLike,
	type WsTransportOptions
} from './wsTransport';
import type { RoomViewV2 } from '$lib/play/viewV2';
import type { ServerMessage } from '$lib/play/wsProtocol';

/** A controllable fake WebSocket implementing the surface the transport depends on. Tests
 *  drive it directly: `open()` to fire onopen, `emit(msg)` to deliver a server frame,
 *  `drop()` to simulate a lost socket. `frames` holds every parsed client frame sent. */
class FakeSocket implements WebSocketLike {
	readyState = 0; // CONNECTING
	onopen: ((ev?: unknown) => void) | null = null;
	onclose: ((ev?: unknown) => void) | null = null;
	onerror: ((ev?: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	readonly sent: string[] = [];
	closed = false;

	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.closed = true;
		this.readyState = 3; // CLOSED
	}

	// ── test helpers ──
	open(): void {
		this.readyState = 1; // OPEN
		this.onopen?.();
	}
	emit(msg: ServerMessage): void {
		this.onmessage?.({ data: JSON.stringify(msg) });
	}
	drop(): void {
		this.readyState = 3;
		this.onclose?.();
	}
	get frames(): Array<Record<string, unknown>> {
		return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
	}
	framesOfType(t: string): Array<Record<string, unknown>> {
		return this.frames.filter((f) => f.t === t);
	}
}

/** A minimal RoomViewV2 whose projection carries the revision the transport gates on. */
function viewAt(revision: number, roomCode = 'ROOM'): RoomViewV2 {
	return {
		version: 2,
		projection: { roomCode, revision },
		member: { id: 'm1', role: 'player', seatColor: 'Red', displayName: 'P' },
		affordances: {}
	} as unknown as RoomViewV2;
}

let sockets: FakeSocket[] = [];
let views: RoomViewV2[] = [];
let statuses: Array<{ connected: boolean; reconnecting: boolean }> = [];
let fatals: Array<{ code: string; message: string }> = [];
let transport: WsTransport;

function makeTransport(opts: Partial<WsTransportOptions> = {}) {
	return new WsTransport(
		{
			onView: (v) => views.push(v),
			onStatus: (s) => statuses.push(s),
			onFatal: (e) => fatals.push(e)
		},
		{
			createSocket: () => {
				const s = new FakeSocket();
				sockets.push(s);
				return s;
			},
			minBackoffMs: 10,
			maxBackoffMs: 40,
			...opts
		}
	);
}

/** Ticket provider: mints a fresh one-use ticket per (re)connect, like the store. */
let ticketSeq = 0;
const mintedTickets: string[] = [];
function nextTicket(): Promise<string | null> {
	ticketSeq += 1;
	const ticket = `pwt_test-ticket-${ticketSeq}`;
	mintedTickets.push(ticket);
	return Promise.resolve(ticket);
}

/** Flush the microtask queue so the async ticket mint inside the join path settles
 *  (fake-timer safe: microtasks are not virtualized). */
async function flushJoin(): Promise<void> {
	for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

/** Connect, open the first socket, and complete the join handshake at `revision`. */
async function connectAndJoin(revision = 5): Promise<FakeSocket> {
	transport.connect('wss://rooms.test', 'ROOM', nextTicket);
	const socket = sockets[0];
	socket.open();
	await flushJoin();
	socket.emit({ t: 'joined', revision, seat: 'Red', role: 'player', view: viewAt(revision) });
	return socket;
}

beforeEach(() => {
	sockets = [];
	views = [];
	statuses = [];
	fatals = [];
	ticketSeq = 0;
	mintedTickets.length = 0;
	transport = makeTransport();
});

afterEach(() => {
	transport.close();
	vi.useRealTimers();
});

describe('WsTransport', () => {
	it('sends a join frame with roomCode + a freshly-minted ONE-USE ticket on open, applies the joined view', async () => {
		transport.connect('wss://rooms.test', 'ROOM', nextTicket);
		expect(sockets).toHaveLength(1);
		sockets[0].open();
		await flushJoin();

		const join = sockets[0].framesOfType('join');
		expect(join).toHaveLength(1);
		expect(join[0]).toMatchObject({ roomCode: 'ROOM', ticket: mintedTickets[0] });
		expect(join[0].resumeFromRevision).toBeUndefined();

		sockets[0].emit({ t: 'joined', revision: 5, seat: 'Red', role: 'player', view: viewAt(5) });
		expect(views).toHaveLength(1);
		expect(views[0].projection.revision).toBe(5);
		expect(transport.isConnected).toBe(true);
		expect(statuses.at(-1)).toEqual({ connected: true, reconnecting: false });
	});

	it('resolves sendCommand against the cmdId-matched ack and applies its fresh view', async () => {
		const socket = await connectAndJoin(5);
		const pending = transport.sendCommand({ type: 'passEncounter' }, 5);

		const cmd = socket.framesOfType('command');
		expect(cmd).toHaveLength(1);
		const cmdId = cmd[0].cmdId as string;
		expect(cmdId).toBeTruthy();
		expect(cmd[0].command).toEqual({ type: 'passEncounter' });

		socket.emit({ t: 'ack', cmdId, ok: true, revision: 6, view: viewAt(6) });
		const result = await pending;
		expect(result.ok).toBe(true);
		expect(result.revision).toBe(6);
		expect(views.at(-1)?.projection.revision).toBe(6);
	});

	it('applies an unsolicited delta and advances the revision watermark', async () => {
		const socket = await connectAndJoin(5);
		socket.emit({ t: 'delta', fromRevision: 5, toRevision: 7, patch: viewAt(7) });
		expect(views.at(-1)?.projection.revision).toBe(7);
		expect(transport.revision).toBe(7);
	});

	it('STALENESS: a delta at rev 7 then an ack whose view is rev 6 does not regress the board, but retires the cmdId', async () => {
		const socket = await connectAndJoin(5);
		socket.emit({ t: 'delta', fromRevision: 5, toRevision: 7, patch: viewAt(7) });
		const viewsAfterDelta = views.length;
		expect(views.at(-1)?.projection.revision).toBe(7);

		const pending = transport.sendCommand({ type: 'passEncounter' }, 5);
		const cmdId = socket.framesOfType('command').at(-1)!.cmdId as string;
		// A stale ack (its authoritative revision 6 < applied 7) — the board must NOT regress.
		socket.emit({ t: 'ack', cmdId, ok: true, revision: 6, view: viewAt(6) });

		const result = await pending; // cmdId retired despite the stale view
		expect(result.revision).toBe(6);
		expect(views.length).toBe(viewsAfterDelta); // no new (regressing) apply
		expect(views.at(-1)?.projection.revision).toBe(7);
		expect(transport.revision).toBe(7);
	});

	it('rejects sendCommand with WsCommandRejected when the server rejects (ok:false)', async () => {
		const socket = await connectAndJoin(5);
		const pending = transport.sendCommand({ type: 'passEncounter' }, 5);
		const cmdId = socket.framesOfType('command').at(-1)!.cmdId as string;
		socket.emit({ t: 'ack', cmdId, ok: false, error: { code: 'illegal_move', message: 'Not your turn' } });

		await expect(pending).rejects.toBeInstanceOf(WsCommandRejected);
		await pending.catch((err: WsCommandRejected) => {
			expect(err.code).toBe('illegal_move');
			expect(err.message).toBe('Not your turn');
		});
	});

	it('rejects an in-flight command with WsTransportUnavailable when the socket drops (→ HTTP fallback)', async () => {
		const socket = await connectAndJoin(5);
		const pending = transport.sendCommand({ type: 'passEncounter' }, 5);
		socket.drop();
		await expect(pending).rejects.toBeInstanceOf(WsTransportUnavailable);
		expect(statuses.at(-1)).toEqual({ connected: false, reconnecting: true });
	});

	it('queues commands submitted before join and flushes them once joined', async () => {
		transport.connect('wss://rooms.test', 'ROOM', nextTicket);
		const socket = sockets[0];
		socket.open(); // join sent, not yet acknowledged
		await flushJoin();
		// Never acked in this test; swallow the teardown rejection so it isn't "unhandled".
		transport.sendCommand({ type: 'passEncounter' }, 0).catch(() => {});
		expect(socket.framesOfType('command')).toHaveLength(0); // still queued

		socket.emit({ t: 'joined', revision: 5, seat: 'Red', role: 'player', view: viewAt(5) });
		expect(socket.framesOfType('command')).toHaveLength(1); // flushed
	});

	it('reconnects with resumeFromRevision and a FRESH one-use ticket after a drop', async () => {
		vi.useFakeTimers();
		const socket = await connectAndJoin(5);
		socket.emit({ t: 'delta', fromRevision: 5, toRevision: 7, patch: viewAt(7) });
		expect(transport.revision).toBe(7);

		socket.drop();
		await vi.advanceTimersByTimeAsync(20); // past minBackoffMs
		expect(sockets).toHaveLength(2); // reconnected

		sockets[1].open();
		await flushJoin();
		const join = sockets[1].framesOfType('join');
		expect(join).toHaveLength(1);
		expect(join[0].resumeFromRevision).toBe(7); // resume from last applied revision
		// One-use tickets: the reconnect minted a NEW ticket, never reusing the first.
		expect(mintedTickets).toHaveLength(2);
		expect(join[0].ticket).toBe(mintedTickets[1]);
	});

	it('emits a heartbeat ping on the configured interval and reconnects on heartbeat timeout', async () => {
		vi.useFakeTimers();
		transport = makeTransport({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 250 });
		const socket = await connectAndJoin(5);

		await vi.advanceTimersByTimeAsync(100);
		expect(socket.framesOfType('ping')).toHaveLength(1);

		// No further server messages: the next tick past the timeout window closes the socket
		// and schedules a reconnect.
		await vi.advanceTimersByTimeAsync(300);
		expect(socket.closed).toBe(true);
		expect(sockets.length).toBeGreaterThanOrEqual(2);
	});

	it('closes cleanly on fatal error and reports it', async () => {
		const socket = await connectAndJoin(5);
		socket.emit({ t: 'error', code: 'room_gone', message: 'Room closed', fatal: true });
		expect(fatals).toEqual([{ code: 'room_gone', message: 'Room closed' }]);
		expect(transport.isConnected).toBe(false);
	});

	it('a failed ticket mint is FATAL (no credential-less join, no silent spectator downgrade)', async () => {
		transport.connect('wss://rooms.test', 'ROOM', () => Promise.resolve(null));
		sockets[0].open();
		await flushJoin();
		expect(sockets[0].framesOfType('join')).toHaveLength(0); // no join without a ticket
		expect(fatals.at(-1)?.code).toBe('no_ticket');
		expect(transport.isConnected).toBe(false);
	});

	it('resync sends a resync frame carrying the last applied revision', async () => {
		const socket = await connectAndJoin(5);
		socket.emit({ t: 'delta', fromRevision: 5, toRevision: 7, patch: viewAt(7) });
		transport.resync();
		const resync = socket.framesOfType('resync');
		expect(resync).toHaveLength(1);
		expect(resync[0].fromRevision).toBe(7);
	});
});
