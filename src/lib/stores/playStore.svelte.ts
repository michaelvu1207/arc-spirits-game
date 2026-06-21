import { browser } from '$app/environment';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '$lib/supabase';
import type { RoomView } from '$lib/play/server/service';
import { isStaleRoomUpdate } from '$lib/play/roomView';
import { reconcile } from '$lib/play/reconcile';
import { apiUrl, isCrossOrigin } from '$lib/play/apiBase';
import { auth } from '$lib/auth/auth.svelte';
import type { GameCommand, RoomSummary, SeatColor, SpectatorProjection } from '$lib/play/types';

let room = $state<SpectatorProjection | null>(null);
let member = $state<RoomView['member'] | null>(null);
let isLoading = $state(false);
let error = $state<string | null>(null);
let isConnected = $state(false);
let isReconnecting = $state(false);

// Live transport: a Supabase Realtime broadcast channel (push) backed by a slow
// safety/enforcement poll. The DB trigger broadcasts a tiny `{revision}` signal on
// `room:<code>` the instant a command commits; we then fetch our own owner-gated
// projection from `/view`. Replaces the old per-second SSE poll + 30s function cap.
let channel: RealtimeChannel | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let refreshDebounce: ReturnType<typeof setTimeout> | null = null;
let refreshing = false;
let refreshQueued = false;
let lastOkAt = 0;
let lifecycleBound = false;

// Safety/enforcement poll cadence. Realtime broadcasts cover the responsive path
// (≈150ms after any commit); this slower pull is the fallback that converges state
// if a broadcast is ever dropped AND the heartbeat that keeps server-side deadline
// enforcement / room-close running now that the 1s SSE poll is gone.
const POLL_MS = 3_000;
// Only surface the "Connection lost / Reconnecting" banner once our state is THIS
// stale. A normal blip (a dropped poll, a backgrounded tab, a websocket rejoin)
// recovers well within this window — so the banner never flaps on a healthy line.
const STALE_MS = 12_000;
const WATCHDOG_TICK_MS = 3_000;
// Coalesce a burst of broadcasts (e.g. several rapid commits) into one fetch.
const REFRESH_DEBOUNCE_MS = 80;

function setRoomView(view: RoomView) {
	// Ignore stale updates FOR THE SAME ROOM. Play is simultaneous: a player's own
	// command response (older revision) can arrive AFTER an SSE snapshot that
	// already reflects a newer state from another player; applying it would regress
	// the board. A view for a DIFFERENT room is never stale — creating/joining a new
	// room lands on a lower revision than the previous game, and rejecting it would
	// strand the player on that previous game.
	if (isStaleRoomUpdate(room, view.projection)) {
		// Still refresh our own identity (seat/role) if it changed.
		member = view.member;
		return;
	}
	// Same room → reconcile the fresh projection INTO the existing reactive object
	// so only the leaves that actually changed invalidate (a phase tick no longer
	// re-renders the trait tracker, board, every player panel, …). A different room
	// (or first load) has no shared identity to preserve, so swap wholesale.
	if (room && room.roomCode === view.projection.roomCode) {
		reconcile(room, view.projection);
	} else {
		room = view.projection;
	}
	member = view.member;
	error = null;
}

/**
 * Optimistically mutate the local room IN PLACE for instant tap feedback, before
 * the server round-trip lands. Safe because the authoritative `/view` that follows
 * every command is `reconcile`d over this guess — any divergence self-corrects on
 * the next revision. Use only for trivially-predictable, owner-local changes
 * (toggling ready, locking a destination); never to fake rule resolution.
 */
export function applyOptimistic(mutate: (room: SpectatorProjection) => void) {
	if (room) mutate(room);
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	// Cross-origin (Capacitor) has no session cookie — authenticate by member id.
	if (isCrossOrigin && member?.id) headers['X-Play-Member'] = member.id;
	// ...and no auth cookie either, so forward the access token as a Bearer header so the
	// server can attribute the action to the player's real uid (user_id capture on mobile).
	if (isCrossOrigin) {
		const token = auth.session?.access_token;
		if (token) headers['Authorization'] = `Bearer ${token}`;
	}
	const response = await fetch(apiUrl(path), {
		method: 'POST',
		headers,
		credentials: isCrossOrigin ? 'include' : 'same-origin',
		body: JSON.stringify(body)
	});

	const payload = (await response.json().catch(() => null)) as T | { message?: string } | null;
	if (!response.ok) {
		const message =
			payload &&
			typeof payload === 'object' &&
			'message' in payload &&
			typeof payload.message === 'string'
				? payload.message
				: `Request failed with status ${response.status}`;
		throw new Error(message);
	}

	return payload as T;
}

function clearTimers() {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	if (watchdogTimer) {
		clearInterval(watchdogTimer);
		watchdogTimer = null;
	}
	if (refreshDebounce) {
		clearTimeout(refreshDebounce);
		refreshDebounce = null;
	}
}

/** The `/view` URL, carrying the member id explicitly when cross-origin (the
 *  Capacitor shell has no same-origin session cookie). */
function viewUrl(roomCode: string): string {
	const query = isCrossOrigin && member?.id ? `?member=${encodeURIComponent(member.id)}` : '';
	return apiUrl(`/api/play/sessions/${encodeURIComponent(roomCode)}/view${query}`);
}

/** Fetch our own owner-gated projection and apply it. Concurrency-coalesced: a
 *  refresh requested while one is in flight runs exactly once more afterwards, so a
 *  burst of broadcasts never stacks up overlapping fetches. A failure is swallowed —
 *  the watchdog (not a single dropped request) decides when to show the banner. */
async function refresh(): Promise<void> {
	if (!browser || !room?.roomCode || room.status === 'closed') return;
	if (refreshing) {
		refreshQueued = true;
		return;
	}
	refreshing = true;
	const code = room.roomCode;
	try {
		const res = await fetch(viewUrl(code), {
			headers: { Accept: 'application/json' },
			credentials: isCrossOrigin ? 'include' : 'same-origin'
		});
		if (!res.ok) throw new Error(`Failed to refresh room view (status ${res.status})`);
		const view = (await res.json()) as RoomView;
		setRoomView(view);
		lastOkAt = Date.now();
		isConnected = true;
		isReconnecting = false;
	} catch {
		// Transient — let the staleness watchdog decide whether to flag a disconnect.
	} finally {
		refreshing = false;
		if (refreshQueued) {
			refreshQueued = false;
			void refresh();
		}
	}
}

/** Debounce a broadcast-driven refresh so several rapid commits coalesce. */
function scheduleRefresh() {
	if (refreshDebounce) return;
	refreshDebounce = setTimeout(() => {
		refreshDebounce = null;
		void refresh();
	}, REFRESH_DEBOUNCE_MS);
}

function closeChannel() {
	if (channel) {
		supabase.removeChannel(channel);
		channel = null;
	}
}

/** (Re)subscribe to the room's realtime broadcast topic. Each `sync` message
 *  (emitted by the DB trigger on every revision bump) triggers a debounced refetch.
 *  supabase-js owns the socket's own reconnect/backoff; the poll + watchdog are the
 *  safety net, so transport status changes here don't directly flip the banner. */
function openChannel() {
	if (!browser || !room?.roomCode || room.status === 'closed') return;
	closeChannel();
	const code = room.roomCode;
	const ch = supabase.channel(`room:${code}`, {
		config: { broadcast: { self: false }, private: false }
	});
	ch.on('broadcast', { event: 'sync' }, () => scheduleRefresh());
	ch.subscribe((status) => {
		// On a fresh subscribe, pull once to catch anything that changed between the
		// server-rendered hydrate and the socket coming up.
		if (status === 'SUBSCRIBED') void refresh();
	});
	channel = ch;
}

/** Periodically check whether our state has gone stale (no successful refresh
 *  within STALE_MS). Only then do we show the banner AND proactively try to
 *  recover — re-subscribe the channel (the socket may have died silently on mobile)
 *  and force a refetch. A healthy line never trips this. */
function startWatchdog() {
	if (watchdogTimer) clearInterval(watchdogTimer);
	watchdogTimer = setInterval(() => {
		if (Date.now() - lastOkAt <= STALE_MS) return;
		isConnected = false;
		isReconnecting = true;
		openChannel();
		void refresh();
	}, WATCHDOG_TICK_MS);
}

function bindLifecycle() {
	if (!browser || lifecycleBound) return;
	lifecycleBound = true;
	// Network came back, or the user returned to a backgrounded tab/app — the
	// websocket is likely dead, so re-subscribe and refetch immediately.
	const wake = () => {
		if (!room?.roomCode || room.status === 'closed') return;
		openChannel();
		void refresh();
	};
	window.addEventListener('online', wake);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') wake();
	});
}

function disconnect() {
	clearTimers();
	closeChannel();
	isConnected = false;
	isReconnecting = false;
}

function connect() {
	if (!browser || !room?.roomCode) return;
	bindLifecycle();
	clearTimers();
	// We just hydrated authoritative server state, so we ARE connected — start the
	// clock fresh so the watchdog doesn't false-trip before the first poll lands.
	isReconnecting = false;
	isConnected = true;
	lastOkAt = Date.now();
	openChannel();
	void refresh();
	pollTimer = setInterval(() => void refresh(), POLL_MS);
	startWatchdog();
}

export function hydratePlayRoom(view: RoomView) {
	setRoomView(view);
	if (browser) {
		connect();
	}
}

/**
 * Seed the active member id ahead of navigating into a room — used by matchmaking,
 * where the server created this player's membership and the client only learns its
 * id from the queue poll. On the cross-origin (Capacitor) shell this is what makes
 * subsequent requests carry the `?member=` / `X-Play-Member` identity; same-origin
 * relies on the cookie the queue endpoint set, but seeding here is harmless and keeps
 * the in-memory identity consistent until the first /view poll replaces it.
 */
export function setActiveMemberId(memberId: string) {
	member = { id: memberId, role: 'player', seatColor: null, displayName: null };
}

export async function createPlayRoom(displayName: string) {
	isLoading = true;
	try {
		const view = await postJson<RoomView>('/api/play/sessions', { displayName });
		setRoomView(view);
		if (browser) connect();
		return view;
	} catch (err) {
		error = err instanceof Error ? err.message : 'Failed to create room.';
		throw err;
	} finally {
		isLoading = false;
	}
}

/** Dev-only: spawn a seeded solo game parked in the Awakening phase to test a
 *  class's ability UX. Returns the room view so the caller can navigate in. */
export async function createDebugPlayRoom(className: string, displayName = 'Debug Player') {
	isLoading = true;
	try {
		const view = await postJson<RoomView>('/api/play/debug', { className, displayName });
		setRoomView(view);
		if (browser) connect();
		return view;
	} catch (err) {
		error = err instanceof Error ? err.message : 'Failed to create debug room.';
		throw err;
	} finally {
		isLoading = false;
	}
}

export async function joinPlayRoom(roomCode: string, displayName: string) {
	isLoading = true;
	try {
		const view = await postJson<RoomView>(
			`/api/play/sessions/${encodeURIComponent(roomCode)}/join`,
			{ displayName }
		);
		setRoomView(view);
		if (browser) connect();
		return view;
	} catch (err) {
		error = err instanceof Error ? err.message : 'Failed to join room.';
		throw err;
	} finally {
		isLoading = false;
	}
}

/** Fetch the public server-browser list of open lobbies + live games. */
export async function fetchOpenRooms(): Promise<RoomSummary[]> {
	const response = await fetch(apiUrl('/api/play/sessions'), {
		headers: { Accept: 'application/json' },
		credentials: isCrossOrigin ? 'include' : 'same-origin'
	});
	if (!response.ok) {
		throw new Error(`Failed to load rooms (status ${response.status})`);
	}
	const payload = (await response.json().catch(() => null)) as { rooms?: RoomSummary[] } | null;
	return payload?.rooms ?? [];
}

export async function claimSeat(seatColor: SeatColor) {
	if (!room) throw new Error('No room is loaded.');
	const view = await postJson<RoomView>(
		`/api/play/sessions/${encodeURIComponent(room.roomCode)}/claim-seat`,
		{ seatColor, expectedRevision: room.revision }
	);
	setRoomView(view);
	return view;
}

export async function startPlayGame() {
	if (!room) throw new Error('No room is loaded.');
	const view = await postJson<RoomView>(
		`/api/play/sessions/${encodeURIComponent(room.roomCode)}/start`,
		{ expectedRevision: room.revision }
	);
	setRoomView(view);
	return view;
}

export async function sendPlayCommand(command: GameCommand) {
	if (!room) throw new Error('No room is loaded.');
	const view = await postJson<RoomView>(
		`/api/play/sessions/${encodeURIComponent(room.roomCode)}/commands`,
		{
			expectedRevision: room.revision,
			command
		}
	);
	setRoomView(view);
	return view;
}

export function getPlayState() {
	return {
		get room() {
			return room;
		},
		get member() {
			return member;
		},
		get isLoading() {
			return isLoading;
		},
		get error() {
			return error;
		},
		get isConnected() {
			return isConnected;
		},
		get isReconnecting() {
			return isReconnecting;
		},
		connect,
		disconnect
	};
}
