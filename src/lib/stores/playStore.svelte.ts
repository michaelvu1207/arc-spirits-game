import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '$lib/supabase';
import type { RoomView } from '$lib/play/server/service';
import { isStaleRoomUpdate } from '$lib/play/roomView';
import { reconcile } from '$lib/play/reconcile';
import { apiUrl, isCrossOrigin } from '$lib/play/apiBase';
import { auth } from '$lib/auth/auth.svelte';
import type { RoomViewV2, SeatAffordances } from '$lib/play/viewV2';
import { WsTransport, WsCommandRejected } from '$lib/stores/wsTransport';
import type {
	GameCommand,
	RoomChatMessage,
	RoomSummary,
	SeatColor,
	SpectatorProjection
} from '$lib/play/types';

let room = $state<SpectatorProjection | null>(null);
let member = $state<RoomView['member'] | null>(null);
let isLoading = $state(false);
let error = $state<string | null>(null);
let isConnected = $state(false);
let isReconnecting = $state(false);
let chatMessages = $state<RoomChatMessage[]>([]);
let chatUnread = $state(0);
let chatError = $state<string | null>(null);
let chatLoading = $state(false);
let chatOpen = $state(false);
let chatRoomCode = $state<string | null>(null);
// Per-seat action surface from RoomView v2 (WS transport only). Additive: not yet consumed
// by components — exposed via getPlayState() for future affordance-driven UI. Empty in HTTP mode.
let affordances = $state<Partial<Record<SeatColor, SeatAffordances>>>({});

// Live transport: a Supabase Realtime broadcast channel (push) backed by a slow
// safety/enforcement poll. The DB trigger broadcasts a tiny `{revision}` signal on
// `room:<code>` the instant a command commits; we then fetch our own owner-gated
// projection from `/view`. Replaces the old per-second SSE poll + 30s function cap.
let channel: RealtimeChannel | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let chatPollTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let refreshDebounce: ReturnType<typeof setTimeout> | null = null;
let refreshing = false;
let refreshQueued = false;
let lastOkAt = 0;
let lifecycleBound = false;

// Optional long-lived WebSocket transport (server/protocol.ts). When enabled it layers ON TOP
// of the Supabase broadcast + poll machinery below — that path stays fully live as the HTTP
// fallback and safety net. WS just gives optimistic-feel command acks (the ack IS the fresh
// view) and server-pushed deltas. `wsConnected` (plain, non-reactive) only gates command
// routing; the disconnect banner remains owned by the poll/watchdog so a WS blip never flaps it.
let transport: WsTransport | null = null;
let wsConnected = false;
const WS_URL_STORAGE_KEY = 'arc-play-ws-url';

/**
 * The room WebSocket URL, or null to stay on pure HTTP. WS is enabled when any of:
 *   - `?ws=<wss://url>` query param (explicit URL), or `?ws=1` to use the env default;
 *     `?ws=0` force-disables even if the env var is set (fallback testing);
 *   - `localStorage['arc-play-ws-url']` holds a URL;
 *   - the `PUBLIC_WS_SERVER_URL` public env var is set.
 */
function resolveWsUrl(): string | null {
	if (browser) {
		try {
			const q = new URLSearchParams(window.location.search).get('ws');
			if (q === '0' || q === 'false') return null;
			if (q === '1' || q === 'true') return env.PUBLIC_WS_SERVER_URL || null;
			if (q) return q;
			const stored = localStorage.getItem(WS_URL_STORAGE_KEY);
			if (stored) return stored;
		} catch {
			// URL/storage access denied — fall through to the env default.
		}
	}
	return env.PUBLIC_WS_SERVER_URL || null;
}

// Safety/enforcement poll cadence. Realtime broadcasts cover the responsive path
// (≈150ms after any commit); this slower pull is the fallback that converges state
// if a broadcast is ever dropped AND the heartbeat that keeps server-side deadline
// enforcement / room-close running now that the 1s SSE poll is gone.
const POLL_MS = 3_000;
const CHAT_POLL_MS = 2_000;
// Only surface the "Connection lost / Reconnecting" banner once our state is THIS
// stale. A normal blip (a dropped poll, a backgrounded tab, a websocket rejoin)
// recovers well within this window — so the banner never flaps on a healthy line.
const STALE_MS = 12_000;
const WATCHDOG_TICK_MS = 3_000;
// Coalesce a burst of broadcasts (e.g. several rapid commits) into one fetch.
const REFRESH_DEBOUNCE_MS = 80;
const MEMBER_STORAGE_PREFIX = 'arc-play-member:';

function normalizeRoomCode(roomCode: string): string {
	return roomCode.trim().toUpperCase();
}

function memberStorageKey(roomCode: string): string {
	return `${MEMBER_STORAGE_PREFIX}${normalizeRoomCode(roomCode)}`;
}

function storedMemberId(roomCode: string | null | undefined): string | null {
	if (!browser || !roomCode) return null;
	try {
		return localStorage.getItem(memberStorageKey(roomCode));
	} catch {
		return null;
	}
}

function persistMemberId(roomCode: string, memberId: string) {
	if (!browser) return;
	try {
		localStorage.setItem(memberStorageKey(roomCode), memberId);
	} catch {
		// Private browsing / storage denial: in-memory member state still works.
	}
}

function memberIdForRoom(roomCode: string | null | undefined): string | null {
	if (!roomCode) return member?.id ?? null;
	const normalized = normalizeRoomCode(roomCode);
	if (!room || normalizeRoomCode(room.roomCode) === normalized) return member?.id ?? storedMemberId(roomCode);
	return storedMemberId(roomCode);
}

function ensureChatRoom(roomCode: string) {
	const normalized = normalizeRoomCode(roomCode);
	if (chatRoomCode === normalized) return;
	chatRoomCode = normalized;
	chatMessages = [];
	chatUnread = 0;
	chatError = null;
	chatLoading = false;
	chatOpen = false;
}

function roomCodeFromPath(path: string): string | null {
	const match = path.match(/\/api\/play\/sessions\/([^/]+)/);
	if (!match) return null;
	try {
		return decodeURIComponent(match[1] ?? '');
	} catch {
		return match[1] ?? null;
	}
}

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
		if (view.member?.id) persistMemberId(view.projection.roomCode, view.member.id);
		return;
	}
	ensureChatRoom(view.projection.roomCode);
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
	if (view.member?.id) persistMemberId(view.projection.roomCode, view.member.id);
	error = null;
}

/**
 * Apply an authoritative RoomView v2 delivered over the WebSocket transport (joined / ack /
 * delta). Reuses setRoomView (so the same-room staleness guard + reconcile path apply), then
 * stores affordances only when the view was actually applied (not a stale, board-regressing
 * one). WS activity also refreshes the liveness clock so the poll/watchdog stays quiet while
 * the socket is healthy.
 */
function applyServerView(view: RoomViewV2) {
	const stale = isStaleRoomUpdate(room, view.projection);
	setRoomView({ projection: view.projection, member: view.member });
	if (!stale) affordances = view.affordances ?? {};
	lastOkAt = Date.now();
	isConnected = true;
	isReconnecting = false;
}

/** Tear down the WS transport (leaves the HTTP poll/channel machinery untouched). */
function stopTransport() {
	if (transport) {
		transport.close();
		transport = null;
	}
	wsConnected = false;
}

/** Start (or restart) the WS transport for the current room when a URL is configured. Additive
 *  to the existing broadcast/poll path — never replaces it. */
function startTransport() {
	if (!browser || !room?.roomCode || room.status === 'closed') return;
	const url = resolveWsUrl();
	if (!url) return;
	stopTransport();
	const roomCode = room.roomCode;
	const memberToken = memberIdForRoom(roomCode) ?? undefined;
	transport = new WsTransport({
		onView: (view) => applyServerView(view),
		onStatus: ({ connected }) => {
			wsConnected = connected;
		},
		onFatal: () => {
			// Bad join / room gone — drop to the HTTP path, which will surface any real error.
			stopTransport();
		}
	});
	transport.connect(url, roomCode, memberToken);
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

export async function postPlayJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	// Cross-origin (Capacitor) has no session cookie — authenticate by member id.
	if (isCrossOrigin) {
		const memberId = memberIdForRoom(roomCodeFromPath(path) ?? room?.roomCode);
		if (memberId) headers['X-Play-Member'] = memberId;
	}
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
	if (chatPollTimer) {
		clearInterval(chatPollTimer);
		chatPollTimer = null;
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
	const memberId = memberIdForRoom(roomCode);
	const query = isCrossOrigin && memberId ? `?member=${encodeURIComponent(memberId)}` : '';
	return apiUrl(`/api/play/sessions/${encodeURIComponent(roomCode)}/view${query}`);
}

function chatUrl(roomCode: string, after?: string | null): string {
	const params = new URLSearchParams();
	const memberId = memberIdForRoom(roomCode);
	if (isCrossOrigin && memberId) params.set('member', memberId);
	if (after) params.set('after', after);
	const query = params.toString();
	return apiUrl(`/api/play/sessions/${encodeURIComponent(roomCode)}/chat${query ? `?${query}` : ''}`);
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
		// Nudge the WS transport too: if its socket died silently while backgrounded, ask for a
		// fresh full view (the transport also drives its own backoff reconnect independently).
		if (wsConnected) transport?.resync();
	};
	window.addEventListener('online', wake);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') wake();
	});
}

function disconnect() {
	clearTimers();
	closeChannel();
	stopTransport();
	isConnected = false;
	isReconnecting = false;
}

function connect() {
	if (!browser || !room?.roomCode) return;
	bindLifecycle();
	clearTimers();
	ensureChatRoom(room.roomCode);
	// We just hydrated authoritative server state, so we ARE connected — start the
	// clock fresh so the watchdog doesn't false-trip before the first poll lands.
	isReconnecting = false;
	isConnected = true;
	lastOkAt = Date.now();
	openChannel();
	startTransport();
	void refresh();
	void loadRoomChat(room.roomCode, { countUnread: false });
	pollTimer = setInterval(() => void refresh(), POLL_MS);
	chatPollTimer = setInterval(() => void loadRoomChat(room?.roomCode ?? null), CHAT_POLL_MS);
	startWatchdog();
}

export function hydratePlayRoom(view: RoomView) {
	setRoomView(view);
	if (browser) {
		connect();
	}
}

export async function loadPlayRoom(roomCode: string) {
	isLoading = true;
	try {
		const res = await fetch(viewUrl(roomCode), {
			headers: { Accept: 'application/json' },
			credentials: isCrossOrigin ? 'include' : 'same-origin'
		});
		if (!res.ok) throw new Error(`Failed to load room (status ${res.status})`);
		const view = (await res.json()) as RoomView;
		setRoomView(view);
		if (browser) connect();
		return view;
	} catch (err) {
		error = err instanceof Error ? err.message : 'Failed to load room.';
		throw err;
	} finally {
		isLoading = false;
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
export function setActiveMemberId(memberId: string, roomCode?: string) {
	member = { id: memberId, role: 'player', seatColor: null, displayName: null };
	if (roomCode) persistMemberId(roomCode, memberId);
}

export async function createPlayRoom(displayName: string) {
	isLoading = true;
	try {
		const view = await postPlayJson<RoomView>('/api/play/sessions', { displayName });
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

export async function createSoloPlayRoom(displayName: string) {
	isLoading = true;
	try {
		const view = await postPlayJson<RoomView>('/api/play/solo', { displayName });
		setRoomView(view);
		if (browser) connect();
		return view;
	} catch (err) {
		error = err instanceof Error ? err.message : 'Failed to start solo game.';
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
		const view = await postPlayJson<RoomView>('/api/play/debug', { className, displayName });
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
		const view = await postPlayJson<RoomView>(
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

function mergeChatMessages(
	nextMessages: RoomChatMessage[],
	opts: { countUnread?: boolean } = {}
) {
	if (nextMessages.length === 0) return;
	const previousIds = new Set(chatMessages.map((message) => message.id));
	const byId = new Map(chatMessages.map((message) => [message.id, message]));
	for (const message of nextMessages) {
		byId.set(message.id, message);
	}
	const freshMessages = nextMessages.filter((message) => !previousIds.has(message.id));
	chatMessages = Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	if (opts.countUnread !== false && !chatOpen) {
		const myMemberId = member?.id ?? null;
		chatUnread += freshMessages.filter((message) => message.memberId !== myMemberId).length;
	}
}

export function setRoomChatOpen(open: boolean) {
	chatOpen = open;
	if (open) chatUnread = 0;
}

export async function loadRoomChat(
	roomCode: string | null | undefined = room?.roomCode,
	opts: { countUnread?: boolean } = {}
) {
	if (!browser || !roomCode) return [];
	ensureChatRoom(roomCode);
	const after = chatMessages.at(-1)?.id ?? null;
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (isCrossOrigin) {
		const token = auth.session?.access_token;
		if (token) headers['Authorization'] = `Bearer ${token}`;
	}
	chatLoading = chatMessages.length === 0;
	try {
		const response = await fetch(chatUrl(roomCode, after), {
			headers,
			credentials: isCrossOrigin ? 'include' : 'same-origin'
		});
		const payload = (await response.json().catch(() => null)) as
			| { messages?: RoomChatMessage[]; message?: string }
			| null;
		if (!response.ok) {
			const message =
				payload && typeof payload.message === 'string'
					? payload.message
					: `Failed to load chat (status ${response.status})`;
			throw new Error(message);
		}
		const messages = payload?.messages ?? [];
		mergeChatMessages(messages, opts);
		chatError = null;
		return messages;
	} catch (err) {
		chatError = err instanceof Error ? err.message : 'Failed to load chat.';
		return [];
	} finally {
		chatLoading = false;
	}
}

export async function sendRoomChat(body: string) {
	if (!room) throw new Error('No room is loaded.');
	const payload = await postPlayJson<{ message: RoomChatMessage }>(
		`/api/play/sessions/${encodeURIComponent(room.roomCode)}/chat`,
		{ body }
	);
	mergeChatMessages([payload.message], { countUnread: false });
	chatError = null;
	return payload.message;
}

export async function claimSeat(seatColor: SeatColor) {
	if (!room) throw new Error('No room is loaded.');
	const view = await postPlayJson<RoomView>(
		`/api/play/sessions/${encodeURIComponent(room.roomCode)}/claim-seat`,
		{ seatColor, expectedRevision: room.revision }
	);
	setRoomView(view);
	return view;
}

export async function startPlayGame() {
	if (!room) throw new Error('No room is loaded.');
	const view = await postPlayJson<RoomView>(
		`/api/play/sessions/${encodeURIComponent(room.roomCode)}/start`,
		{ expectedRevision: room.revision }
	);
	setRoomView(view);
	return view;
}

export async function sendPlayCommand(command: GameCommand): Promise<RoomView> {
	if (!room) throw new Error('No room is loaded.');
	// WS path: the ack IS the fresh view (applied immediately via onView — the optimistic-feel
	// fix, no /view refetch). A server REJECTION propagates to the caller (HTTP would reject
	// identically); a transport DROP falls through to HTTP so the command still lands.
	if (transport && wsConnected) {
		try {
			const ack = await transport.sendCommand(command, room.revision);
			return { projection: ack.view.projection, member: ack.view.member };
		} catch (err) {
			if (err instanceof WsCommandRejected) throw new Error(err.message);
			// WsTransportUnavailable (socket dropped) → fall back to HTTP below.
		}
	}
	const view = await postPlayJson<RoomView>(
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
		get chatMessages() {
			return chatMessages;
		},
		get chatUnread() {
			return chatUnread;
		},
		get chatError() {
			return chatError;
		},
		get chatLoading() {
			return chatLoading;
		},
		get chatOpen() {
			return chatOpen;
		},
		/** Per-seat action surface from RoomView v2 (WS mode only; empty on HTTP). Additive —
		 *  not yet consumed by components. */
		get affordances() {
			return affordances;
		},
		connect,
		disconnect,
		loadRoomChat,
		sendRoomChat,
		setRoomChatOpen
	};
}
