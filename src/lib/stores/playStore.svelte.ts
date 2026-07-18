import { browser, dev } from '$app/environment';
import { isE2eHarness } from '$lib/play/e2eHarness';
import { env } from '$env/dynamic/public';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '$lib/supabase';
import type { RoomView } from '$lib/play/server/service';
import { isStaleRoomUpdate } from '$lib/play/roomView';
import { reconcile } from '$lib/play/reconcile';
import { apiUrl, isCrossOrigin } from '$lib/play/apiBase';
import { auth } from '$lib/auth/auth.svelte';
import type { RoomViewV2, SeatAffordances } from '$lib/play/viewV2';
import { WsTransport, nextCommandId } from '$lib/stores/wsTransport';
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
// Per-seat action surface from RoomView v2, delivered on BOTH transports (WS acks/deltas
// and the HTTP /view + /commands payloads). Drives pass-turn legality and the §5.2
// location-interaction affordances in the play board.
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

// Optional long-lived WebSocket projection transport (server/protocol.ts). It layers ON TOP
// of the Supabase broadcast + poll machinery below and is deliberately READ-ONLY from the
// browser's perspective: every mutation uses the HTTP command boundary, while WS supplies
// joined views, deltas and explicit resyncs. Keeping one command authority prevents a WS room
// actor and a serverless HTTP handler from independently planning the same next revision.
// `wsConnected` is retained for diagnostics/resync status only; the disconnect banner remains
// owned by the poll/watchdog so a WS blip never flaps it.
let transport: WsTransport | null = null;
let wsConnected = false;
const WS_URL_STORAGE_KEY = 'arc-play-ws-url';

// ── Live-connection diagnostics (dev/e2e only) ─────────────────────────────────
// The journey suite must prove a route re-target ACTUALLY moved the live page:
// the rendered store room is the new one, the old room's transport/channel are
// gone, and exactly one transport owns the page. These counters exist for that
// proof; they are exposed on window only in dev (see the bottom of this module).
let transportRoomCode: string | null = null;
let openTransportCount = 0;
let channelTopic: string | null = null;

/** The exact upgrade path the room server accepts (server/protocol.ts WS_UPGRADE_PATH). */
const WS_PATH = '/ws';

/** Pin the destination: normalize a configured base URL onto the exact ws(s) origin +
 *  upgrade path, refusing anything that is not a WebSocket URL. */
function pinnedWsUrl(raw: string | null | undefined): string | null {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
		url.username = '';
		url.password = '';
		url.search = '';
		url.hash = '';
		if (url.pathname === '/' || url.pathname === '') url.pathname = WS_PATH;
		return url.toString();
	} catch {
		return null;
	}
}

/**
 * The room WebSocket URL, or null to stay on pure HTTP.
 *
 * PRODUCTION: exclusively the `PUBLIC_WS_SERVER_URL` build-time config — a query
 * param or localStorage value can NEVER redirect the client (and its auth/tickets)
 * to an attacker-chosen server.
 *
 * DEV ONLY (fallback/e2e testing): `?ws=<url>` overrides, `?ws=0` disables,
 * `?ws=1` forces the env default, and `localStorage['arc-play-ws-url']` persists a
 * local override.
 */
function resolveWsUrl(): string | null {
	if (browser && dev) {
		try {
			const q = new URLSearchParams(window.location.search).get('ws');
			if (q === '0' || q === 'false') return null;
			if (q === '1' || q === 'true') return pinnedWsUrl(env.PUBLIC_WS_SERVER_URL);
			if (q) return pinnedWsUrl(q);
			const stored = localStorage.getItem(WS_URL_STORAGE_KEY);
			if (stored) return pinnedWsUrl(stored);
		} catch {
			// URL/storage access denied — fall through to the env default.
		}
	}
	return pinnedWsUrl(env.PUBLIC_WS_SERVER_URL);
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

// ── Identity handling ──────────────────────────────────────────────────────────
// `member.id` is the PUBLIC participant identity (seat/"you" labeling only — the
// server never accepts it as authorization). The durable principal is the VALIDATED
// Supabase account (session cookie same-origin; Bearer token cross-origin): every
// HTTP call re-proves it, and the WebSocket boundary is entered with a short-lived
// ONE-USE ticket minted per (re)connect by the authenticated `/ws-ticket` endpoint.
// NOTHING durable is stored in browser storage — legacy credential keys are purged.
const LEGACY_STORAGE_PREFIXES = ['arc-play-member-secret:', 'arc-play-member:'];

// ── Identity generation fence ──────────────────────────────────────────────────
// Sign-out / account switch must be ATOMIC from this store's perspective: work
// started under the previous account (a held /view response, a chat poll, a command
// round-trip, a WS ticket mint) must never apply its result after the identity
// changed — a stale response authorized by account A's cookie/Bearer would silently
// repopulate A's host/member/chat state while the auth store already says "signed
// out". Every async path therefore captures the CURRENT generation before its first
// await; resetPlayIdentityState() bumps the generation (synchronously, before any
// teardown), and a result from an older generation is DISCARDED — reads return
// nothing, mutations reject — regardless of which transport or timer carried it.
let identityGeneration = 0;

/** True when work captured at `generation` no longer speaks for the current account. */
function staleIdentity(generation: number): boolean {
	return generation !== identityGeneration;
}

/** The rejection every fenced mutation surfaces — callers treat it like any other
 *  failed request; nothing from the old account is applied. */
function identityChangedError(): Error {
	return new Error('Your account changed while this request was in flight — nothing was applied.');
}

// ── Room-scope fence ───────────────────────────────────────────────────────────
// The identity fence alone cannot stop SAME-ACCOUNT races: a /view poll, chat
// fetch or command started while the player was in room A must not mutate state
// after the store re-targeted room B (or tore the room down entirely). The epoch
// bumps on every re-target/teardown; a room-scoped operation captures
// (identityGeneration, roomEpoch) at start and discards its result — including
// its catch/finally state writes — when EITHER moved on. The two counters are
// deliberately separate: a token refresh for the SAME account bumps neither.
let roomEpoch = 0;

/** Fence token for one room-scoped operation: capture at operation start (before
 *  the first await), consult after EVERY await — headers, body parse, ack. */
interface RoomOpToken {
	generation: number;
	epoch: number;
}

function roomOpToken(): RoomOpToken {
	return { generation: identityGeneration, epoch: roomEpoch };
}

/** True when the operation no longer speaks for the current account OR the store
 *  has re-targeted/torn down the room it was started in. */
function staleRoomOp(token: RoomOpToken): boolean {
	return token.generation !== identityGeneration || token.epoch !== roomEpoch;
}

// ── Navigation fence ───────────────────────────────────────────────────────────
// Operations that SET the active room (load, create, solo, debug, join, the
// post-reset re-entry, a synchronous hydrate) are serialized by intent: each
// takes the next sequence number, and only the LATEST may apply its result,
// surface its error, or clear the shared loading flag. This closes the
// room-A-response-after-entering-room-B race — a superseded navigation neither
// installs its (older) room nor clobbers the newer operation's state.
let navigationSeq = 0;

/** The rejection a superseded operation surfaces — the newer navigation owns the
 *  store; nothing from this one is applied. */
function supersededError(): Error {
	return new Error('This request was superseded by newer activity — nothing was applied.');
}

// ── Component-lane cancellation ────────────────────────────────────────────────
// The navigation fence stops an OLDER navigation from clobbering a NEWER one, but
// a component that unmounts (or a user who backs out) with its navigation still
// in flight has no newer navigation to hide behind: the late response would still
// install the room, open its channel/transport, and hand the dead component a
// resolved promise whose `.then(goto)` navigates a page nobody is on. Initiating
// components therefore pass an AbortSignal they abort on unmount/cancel; once it
// fires, the operation can neither install a view, connect, surface an error,
// nor resolve successfully — it rejects with {@link RoomNavigationCancelled}
// (which callers use to also skip their own goto/error handling). The loading
// flag is released only when the cancelled operation still OWNS it (it is still
// the latest navigation) — a stale cancel can never blank a newer operation's
// loading state.
export class RoomNavigationCancelled extends Error {
	constructor() {
		super('This navigation was cancelled — nothing was applied.');
		this.name = 'RoomNavigationCancelled';
	}
}

export interface RoomNavigationOptions {
	/** Abort on unmount/cancel: fences the operation out at every await boundary. */
	signal?: AbortSignal;
}

function normalizeRoomCode(roomCode: string): string {
	return roomCode.trim().toUpperCase();
}

/** Delete every retired room-credential key still lingering in this profile. */
function purgeLegacyCredentialStorage() {
	if (!browser) return;
	try {
		const doomed: string[] = [];
		for (let i = 0; i < localStorage.length; i += 1) {
			const key = localStorage.key(i);
			if (key && LEGACY_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
				doomed.push(key);
			}
		}
		for (const key of doomed) localStorage.removeItem(key);
	} catch {
		// Storage denial — nothing to purge then.
	}
}

/**
 * Mint a fresh ONE-USE WS join ticket for a room from the authenticated, no-store
 * endpoint. Called once per (re)connect — the raw ticket goes straight into the
 * join frame and is never stored anywhere. Null ⇒ the transport stays down and the
 * HTTP path carries the session (never a silent, credential-less spectator join).
 */
async function fetchWsTicket(roomCode: string): Promise<string | null> {
	if (!browser) return null;
	const token = roomOpToken();
	try {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			'Content-Type': 'application/json'
		};
		if (isCrossOrigin) {
			const bearer = auth.session?.access_token;
			if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
		}
		const res = await fetch(
			apiUrl(`/api/play/sessions/${encodeURIComponent(roomCode)}/ws-ticket`),
			{
				method: 'POST',
				headers,
				credentials: isCrossOrigin ? 'include' : 'same-origin',
				body: JSON.stringify({})
			}
		);
		// A ticket minted under the PREVIOUS account — or for a room the store has
		// since left — must never enter a join frame.
		if (staleRoomOp(token) || !res.ok) return null;
		const payload = (await res.json().catch(() => null)) as { ticket?: string } | null;
		return staleRoomOp(token) ? null : (payload?.ticket ?? null);
	} catch {
		return null;
	}
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

function setRoomView(
	view: RoomView & {
		affordances?: Partial<Record<SeatColor, SeatAffordances>>;
	}
) {
	// Ignore stale updates FOR THE SAME ROOM. Play is simultaneous: a player's own
	// command response (older revision) can arrive AFTER an SSE snapshot that
	// already reflects a newer state from another player; applying it would regress
	// the board. A view for a DIFFERENT room is never stale — creating/joining a new
	// room lands on a lower revision than the previous game, and rejecting it would
	// strand the player on that previous game.
	if (isStaleRoomUpdate(room, view.projection)) {
		// The whole view is one snapshot: a projection too old to apply carries an
		// equally old member/seat picture. Applying member alone would regress the
		// viewer's own identity (e.g. un-claim a seat a newer view already showed),
		// so a stale view is discarded WHOLE. Every membership change commits with
		// a revision bump, so nothing is lost by waiting for the fresher view.
		return;
	}
	ensureChatRoom(view.projection.roomCode);
	// Same room → reconcile the fresh projection INTO the existing reactive object
	// so only the leaves that actually changed invalidate (a phase tick no longer
	// re-renders the trait tracker, board, every player panel, …). A different room
	// (or first load) has no shared identity to preserve, so swap wholesale — and
	// bump the room epoch so operations still in flight for the PREVIOUS room can
	// never mutate this one's state.
	if (room && room.roomCode === view.projection.roomCode) {
		reconcile(room, view.projection);
	} else {
		roomEpoch += 1;
		room = view.projection;
	}
	member = view.member;
	// HTTP /view + /commands now carry the seat's affordances alongside the
	// projection (the WS path applies its own via applyServerView). A payload
	// WITHOUT the key (e.g. lobby endpoints) leaves the last block in place.
	if (view.affordances) affordances = view.affordances;
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
		openTransportCount = Math.max(0, openTransportCount - 1);
	}
	transportRoomCode = null;
	wsConnected = false;
}

/** Start (or restart) the WS transport for the current room when a URL is configured.
 *  Additive to the existing broadcast/poll path — never replaces it. The transport
 *  mints a fresh one-use join ticket per (re)connect via the authenticated endpoint. */
function startTransport() {
	if (!browser || !room?.roomCode || room.status === 'closed') return;
	const url = resolveWsUrl();
	if (!url) return;
	stopTransport();
	const roomCode = room.roomCode;
	// The transport speaks for the identity AND room it was started under.
	// resetPlayIdentityState / a room re-target close it synchronously, but every
	// callback is ALSO scoped to this exact instance: a view frame, status flip or
	// fatal teardown from a transport that has since been replaced must never
	// mutate the current connection's state (flip wsConnected under the successor,
	// kill the successor via a late fatal, or apply a dead room's view).
	const token = roomOpToken();
	const instance: WsTransport = new WsTransport({
		onView: (view) => {
			if (transport !== instance || staleRoomOp(token)) return;
			applyServerView(view);
		},
		onStatus: ({ connected }) => {
			if (transport !== instance) return;
			wsConnected = connected;
		},
		onFatal: () => {
			if (transport !== instance) return;
			// Bad join / bad ticket / room gone — drop to the HTTP path, which will
			// surface any real error (never a silent identity downgrade).
			stopTransport();
		}
	});
	transport = instance;
	transportRoomCode = roomCode;
	openTransportCount += 1;
	instance.connect(url, roomCode, () => fetchWsTicket(roomCode));
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

export async function postPlayJson<T>(
	path: string,
	body: Record<string, unknown>,
	opts: { signal?: AbortSignal } = {}
): Promise<T> {
	const generation = identityGeneration;
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	// Cross-origin (Capacitor) has no session cookie — the VALIDATED account travels
	// as the Bearer access token instead. That is the only identity channel: no room
	// credentials, no member ids, nothing in the URL.
	if (isCrossOrigin) {
		const token = auth.session?.access_token;
		if (token) headers['Authorization'] = `Bearer ${token}`;
	}
	const response = await fetch(apiUrl(path), {
		method: 'POST',
		headers,
		credentials: isCrossOrigin ? 'include' : 'same-origin',
		body: JSON.stringify(body),
		// An aborted navigation kills the REQUEST itself (not just the local fence):
		// in the common race the server never acts at all, so there is nothing to
		// compensate afterwards.
		signal: opts.signal
	});

	// EVERY play mutation flows through here (commands, seats, chat, create/join,
	// matchmaking) — one fence covers them all: a response authorized by the previous
	// account's cookie/Bearer rejects instead of handing its view to the caller.
	if (staleIdentity(generation)) throw identityChangedError();

	const payload = (await response.json().catch(() => null)) as T | { message?: string } | null;
	// The body parse is its own await: headers can arrive under the old identity's
	// window closing and the DELAYED body land after the account changed. Re-fence.
	if (staleIdentity(generation)) throw identityChangedError();
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

/** The `/view` URL. Identity NEVER rides the URL: same-origin sends the session
 *  cookie, cross-origin sends the Bearer token via {@link playGetHeaders}. */
function viewUrl(roomCode: string): string {
	return apiUrl(`/api/play/sessions/${encodeURIComponent(roomCode)}/view`);
}

function chatUrl(roomCode: string, after?: string | null): string {
	const params = new URLSearchParams();
	if (after) params.set('after', after);
	const query = params.toString();
	return apiUrl(
		`/api/play/sessions/${encodeURIComponent(roomCode)}/chat${query ? `?${query}` : ''}`
	);
}

/** Headers for authenticated GETs: the cross-origin (Capacitor) shell carries the
 *  validated account as a Bearer token; same-origin relies on the session cookie. */
function playGetHeaders(_roomCode: string): Record<string, string> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (isCrossOrigin) {
		const token = auth.session?.access_token;
		if (token) headers['Authorization'] = `Bearer ${token}`;
	}
	return headers;
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
	const token = roomOpToken();
	const code = room.roomCode;
	try {
		const res = await fetch(viewUrl(code), {
			headers: playGetHeaders(code),
			credentials: isCrossOrigin ? 'include' : 'same-origin'
		});
		// The held-response repro: this view was authorized by the PREVIOUS account's
		// session — applying it would restore that account's member/host state after
		// sign-out. The same discard covers a poll for room A landing after the store
		// re-targeted room B: neither its view nor its liveness/connection signals
		// belong to the current room. Discard silently; the current room's own
		// machinery owns the fresh view.
		if (staleRoomOp(token)) return;
		if (!res.ok) throw new Error(`Failed to refresh room view (status ${res.status})`);
		const view = (await res.json()) as RoomView;
		if (staleRoomOp(token)) return;
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
	channelTopic = null;
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
	// Scope both callbacks to THIS channel instance: a broadcast or subscribe
	// status from a channel that has since been replaced (room re-target, reset)
	// must not drive refreshes against the current room's state.
	ch.on('broadcast', { event: 'sync' }, () => {
		if (channel === ch) scheduleRefresh();
	});
	channel = ch;
	channelTopic = `room:${code}`;
	ch.subscribe((status) => {
		if (channel !== ch) return;
		// On a fresh subscribe, pull once to catch anything that changed between the
		// server-rendered hydrate and the socket coming up.
		if (status === 'SUBSCRIBED') void refresh();
	});
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
	// Teardown is a fence event: every in-flight room-scoped operation (poll, chat
	// fetch, command, ticket mint) and every pending navigation is cancelled — its
	// late result must not repopulate state after the page/room has been left.
	roomEpoch += 1;
	navigationSeq += 1;
	clearTimers();
	closeChannel();
	stopTransport();
	isConnected = false;
	isReconnecting = false;
}

/**
 * The durable identity CHANGED (sign-out, account switch, account deletion): make
 * the transition ATOMIC from this store's perspective. Synchronously, before
 * anything can interleave: (1) the identity generation is bumped, so every
 * in-flight request/timer/socket result started under the previous account is
 * fenced out no matter when it lands; (2) the WS transport (whose join ticket
 * proved the OLD identity), the realtime channel, all timers, the member identity
 * and chat are torn down — nothing keeps acting or viewing as the previous
 * account. Only then, if the player is still on a room page, the room is
 * re-entered as whoever they are NOW (under the NEW generation): a public room
 * downgrades to its public projection; a private room refuses the new identity
 * entirely. Callers must have synchronized the auth store BEFORE invoking this,
 * so the re-entry carries the new account's credentials (see +layout.svelte).
 */
export function resetPlayIdentityState() {
	identityGeneration += 1;
	const staleRoomCode = room?.roomCode ?? null;
	disconnect();
	member = null;
	affordances = {};
	chatMessages = [];
	chatUnread = 0;
	chatError = null;
	chatOpen = false;
	chatRoomCode = null;
	error = null;
	if (staleRoomCode && browser) {
		const generation = identityGeneration;
		const reentry = loadPlayRoom(staleRoomCode);
		// loadPlayRoom claimed its navigation slot synchronously — remember it so a
		// FAILED re-entry only clears the room while it is still the latest
		// navigation for this identity. If the player has since entered another
		// room (a newer navigation), this stale catch must not blank it.
		const nav = navigationSeq;
		void reentry.catch(() => {
			// The new identity may not see this room at all (private / signed out).
			if (generation === identityGeneration && nav === navigationSeq) room = null;
		});
	} else {
		room = null;
	}
}

function connect() {
	if (!browser || !room?.roomCode) return;
	bindLifecycle();
	clearTimers();
	ensureChatRoom(room.roomCode);
	// Retired credentials must not linger in browser profiles.
	purgeLegacyCredentialStorage();
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
	// A synchronous navigation landing: it supersedes any in-flight load so a
	// slower, older response cannot replace the room just hydrated.
	navigationSeq += 1;
	isLoading = false;
	setRoomView(view);
	if (browser) {
		connect();
	}
}

/**
 * A navigation operation: capture the fence BEFORE the first await, re-check it
 * after EVERY await (headers AND delayed body), and let only the CURRENT
 * navigation apply its view, surface its error, or clear the shared loading
 * flag — a superseded/stale operation rejects without touching anything.
 */
export async function loadPlayRoom(roomCode: string, options: RoomNavigationOptions = {}) {
	const generation = identityGeneration;
	const nav = ++navigationSeq;
	const current = () => generation === identityGeneration && nav === navigationSeq;
	const cancelled = () => options.signal?.aborted === true;
	isLoading = true;
	try {
		const res = await fetch(viewUrl(roomCode), {
			headers: playGetHeaders(roomCode),
			credentials: isCrossOrigin ? 'include' : 'same-origin',
			signal: options.signal
		});
		if (staleIdentity(generation)) throw identityChangedError();
		if (!current()) throw supersededError();
		if (cancelled()) throw new RoomNavigationCancelled();
		if (!res.ok) throw new Error(`Failed to load room (status ${res.status})`);
		const view = (await res.json()) as RoomView;
		if (staleIdentity(generation)) throw identityChangedError();
		if (!current()) throw supersededError();
		if (cancelled()) throw new RoomNavigationCancelled();
		setRoomView(view);
		if (browser) connect();
		return view;
	} catch (err) {
		// A cancelled operation surfaces NO error — its component is gone.
		if (cancelled()) throw err instanceof RoomNavigationCancelled ? err : new RoomNavigationCancelled();
		if (current()) {
			error = err instanceof Error ? err.message : 'Failed to load room.';
		}
		throw err;
	} finally {
		if (current()) isLoading = false;
	}
}

/**
 * Re-target the store to a DIFFERENT room (a /play/A → /play/B route-param
 * navigation: rematch, in-app room links). SYNCHRONOUSLY — before any await can
 * interleave — the OLD room stops being an authoritative target: `disconnect()`
 * bumps the room/navigation fences and tears down its channel/transport/timers,
 * and the rendered room/member/affordances/chat are CLEARED, so nothing on the
 * page can initiate a fresh HTTP action against room A during the gap while
 * room B loads (every store mutation refuses with "No room is loaded"). The new
 * room then loads through the normal navigation fence and reconnects on arrival.
 */
export function retargetPlayRoom(
	roomCode: string,
	options: RoomNavigationOptions = {}
): Promise<RoomView> {
	disconnect();
	room = null;
	member = null;
	affordances = {};
	chatMessages = [];
	chatUnread = 0;
	chatError = null;
	chatLoading = false;
	chatOpen = false;
	chatRoomCode = null;
	error = null;
	return loadPlayRoom(roomCode, options);
}

/**
 * Seed the active membership ahead of navigating into a room — used by matchmaking
 * and rematch, where the server created this player's membership and the client
 * learns it from the response. `memberId` is the PUBLIC identity (labeling only) —
 * the validated account owns the membership, and the first /view poll re-derives
 * everything authoritatively. Returns the PREVIOUS member picture so a failed
 * navigation can roll the seed back (see {@link restoreActiveMember}) instead of
 * leaving room A rendered with room B's member identity.
 */
export function setActiveMember(memberId: string): RoomView['member'] | null {
	const previous = member;
	member = { id: memberId, role: 'player', seatColor: null, displayName: null };
	return previous;
}

/** Roll back a {@link setActiveMember} seed after a FAILED navigation: restore the
 *  member picture of the room still on screen — but only while the seed is still
 *  the live value (a completed navigation/authoritative view wins otherwise). */
export function restoreActiveMember(
	previous: RoomView['member'] | null,
	seededMemberId: string
) {
	if (member?.id === seededMemberId) member = previous;
}

/** 32 random bytes, base64url, `peo_`-prefixed: the client-minted ENTRY-OP id —
 *  the ambiguous-commit compensation contract for create/solo/join. Minted
 *  BEFORE the request is sent, so an aborted operation can name (and unwind)
 *  its exact server effect even when the response never arrived. */
export function mintEntryOpId(): string {
	const cryptoObj = globalThis.crypto;
	if (!cryptoObj?.getRandomValues) {
		throw new Error('Secure randomness unavailable — cannot start a room operation.');
	}
	const bytes = new Uint8Array(32);
	cryptoObj.getRandomValues(bytes);
	let bin = '';
	for (const byte of bytes) bin += String.fromCharCode(byte);
	return `peo_${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

/** Shared navigation-op harness for the room-entering mutations (create / solo /
 *  debug / join): one fence discipline — capture before the first await, apply /
 *  surface / clear ONLY while still the current navigation for the current
 *  account. The AbortSignal is passed INTO the network request, so an unmount
 *  that wins the race usually cancels the request before the server acts at all.
 *
 *  ABORT COMPENSATION is OP-BOUND: each operation mints an ENTRY-OP id before
 *  sending; the server stamps whatever the op CREATES (the session for
 *  create/solo, the membership for a join that actually added one). A cancelled
 *  operation — whether its response arrived or the fetch died with the commit
 *  AMBIGUOUS — compensates through POST /abandon-entry {opId}: the server
 *  tombstones the op (so a commit still in flight self-compensates on its
 *  post-commit re-check) and unwinds exactly what the op created. A join that
 *  merely reused a PRE-EXISTING membership stamped nothing, so that membership
 *  is untouchable through the op. A superseded (not cancelled) request's server
 *  effect is untouched; only this client refuses to act on the stale response. */
async function runRoomNavigation(
	fallbackMessage: string,
	request: (signal: AbortSignal | undefined, opId: string) => Promise<RoomView>,
	options: RoomNavigationOptions = {}
): Promise<RoomView> {
	const generation = identityGeneration;
	const nav = ++navigationSeq;
	const current = () => generation === identityGeneration && nav === navigationSeq;
	const cancelled = () => options.signal?.aborted === true;
	// The compensation contract exists BEFORE anything is sent.
	const opId = mintEntryOpId();
	const abandon = () => {
		void postPlayJson('/api/play/abandon-entry', { opId }).catch(() => {});
	};
	isLoading = true;
	try {
		const view = await request(options.signal, opId);
		if (staleIdentity(generation)) throw identityChangedError();
		// Unmount/cancel fired while the request was in flight AND the server-side
		// effect landed anyway: this client neither installs the room nor connects
		// to it (the caller's `.then(goto)` never runs) — and the entry the server
		// just recorded is compensated (best-effort, same authenticated account)
		// through the op contract: exactly what THIS op created is left/closed.
		if (cancelled()) {
			abandon();
			throw new RoomNavigationCancelled();
		}
		if (!current()) throw supersededError();
		setRoomView(view);
		if (browser) connect();
		return view;
	} catch (err) {
		// An aborted fetch surfaces as the cancellation it is — never as an error
		// on a page nobody is on. The commit is AMBIGUOUS here (the server may
		// have acted with no response delivered): the op-bound abandon resolves
		// and unwinds the exact effect either way, in every arrival order.
		if (cancelled()) {
			if (!(err instanceof RoomNavigationCancelled)) abandon();
			throw err instanceof RoomNavigationCancelled ? err : new RoomNavigationCancelled();
		}
		if (current()) {
			error = err instanceof Error ? err.message : fallbackMessage;
		}
		throw err;
	} finally {
		if (current()) isLoading = false;
	}
}

export async function createPlayRoom(
	displayName: string,
	options: RoomNavigationOptions & { visibility?: 'public' | 'private' } = {}
) {
	return runRoomNavigation(
		'Failed to create room.',
		(signal, opId) =>
			postPlayJson<RoomView>('/api/play/sessions', {
				displayName, opId, visibility: options.visibility ?? 'public'
			}, { signal }),
		options
	);
}

export async function createSoloPlayRoom(displayName: string, options: RoomNavigationOptions = {}) {
	return runRoomNavigation(
		'Failed to start solo game.',
		(signal, opId) => postPlayJson<RoomView>('/api/play/solo', { displayName, opId }, { signal }),
		options
	);
}

/** Dev-only: spawn a seeded solo game parked in the Awakening phase to test a
 *  class's ability UX. Returns the room view so the caller can navigate in. */
export async function createDebugPlayRoom(
	className: string,
	displayName = 'Debug Player',
	options: RoomNavigationOptions = {}
) {
	return runRoomNavigation(
		'Failed to create debug room.',
		(signal, opId) =>
			postPlayJson<RoomView>('/api/play/debug', { className, displayName, opId }, { signal }),
		options
	);
}

export async function joinPlayRoom(
	roomCode: string,
	displayName: string,
	options: RoomNavigationOptions = {}
) {
	return runRoomNavigation(
		'Failed to join room.',
		(signal, opId) =>
			postPlayJson<RoomView>(
				`/api/play/sessions/${encodeURIComponent(roomCode)}/join`,
				{ displayName, opId },
				{ signal }
			),
		options
	);
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

function mergeChatMessages(nextMessages: RoomChatMessage[], opts: { countUnread?: boolean } = {}) {
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

// ── Chat operation sequencing + same-room coalescing ───────────────────────────
// The room-scope fence (roomOpToken) covers cross-room and cross-identity races,
// but two overlapping operations for the SAME room passed it equally: an OLDER
// load's failure could overwrite a NEWER operation's clean state, and its finally
// could clear the loading flag while the newer request was still pending. Three
// rules close it:
//   - COALESCE: while a load for a room is in flight, a second call for the same
//     room returns the SAME promise — overlapping same-room requests structurally
//     cannot exist (the poll timer and drawer-open both just ride along).
//   - SEQUENCE — loads AND sends: every chat operation (load or send) claims the
//     next operation number; only the LATEST operation may write chatError /
//     chatLoading. A successful SEND is a newer operation than any load already
//     in flight, so that load's later failure/finally can never surface an error
//     (or blank the loading flag) over the send's clean state.
//   - MERGE STAYS MONOTONIC AND UN-SEQUENCED: message merging is id-keyed and
//     order-insensitive (mergeChatMessages), so an older operation that still
//     passes the room/identity fence may always merge what it fetched — the
//     sequencing protects the error/loading STATE, never drops messages.
let chatOpSeq = 0;
let chatInFlight: {
	roomCode: string;
	token: RoomOpToken;
	promise: Promise<RoomChatMessage[]>;
} | null = null;

export async function loadRoomChat(
	roomCode: string | null | undefined = room?.roomCode,
	opts: { countUnread?: boolean } = {}
) {
	if (!browser || !roomCode) return [];
	const normalized = normalizeRoomCode(roomCode);
	// Coalesce onto an in-flight SAME-room load only while that load still speaks
	// for the current account + room scope — a fenced-out (identity change,
	// re-target) load will discard everything, so a new caller must never ride it.
	if (
		chatInFlight &&
		chatInFlight.roomCode === normalized &&
		!staleRoomOp(chatInFlight.token)
	) {
		return chatInFlight.promise;
	}
	const token = roomOpToken();
	const promise = runChatLoad(normalized, opts).finally(() => {
		if (chatInFlight?.promise === promise) chatInFlight = null;
	});
	chatInFlight = { roomCode: normalized, token, promise };
	return promise;
}

async function runChatLoad(
	roomCode: string,
	opts: { countUnread?: boolean }
): Promise<RoomChatMessage[]> {
	ensureChatRoom(roomCode);
	const token = roomOpToken();
	const targetChatRoom = chatRoomCode;
	const op = ++chatOpSeq;
	// Scoped = still the current account + room + chat target: the gate for ANY
	// effect of this operation (merging included). Latest = additionally still the
	// newest chat operation (no newer load OR SEND started): the gate for the
	// shared error/loading state. Both consulted after every await (headers AND
	// delayed body, catch AND finally).
	const scoped = () => !staleRoomOp(token) && chatRoomCode === targetChatRoom;
	const latest = () => scoped() && op === chatOpSeq;
	const after = chatMessages.at(-1)?.id ?? null;
	const headers = playGetHeaders(roomCode);
	if (isCrossOrigin) {
		const bearer = auth.session?.access_token;
		if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
	}
	chatLoading = chatMessages.length === 0;
	try {
		const response = await fetch(chatUrl(roomCode, after), {
			headers,
			credentials: isCrossOrigin ? 'include' : 'same-origin'
		});
		// Member-gated chat fetched under the PREVIOUS account or for a room the
		// store/chat has since left — discard, never merge (headers boundary).
		if (!scoped()) return [];
		const payload = (await response.json().catch(() => null)) as {
			messages?: RoomChatMessage[];
			message?: string;
		} | null;
		// …and again after the (possibly delayed) body parse.
		if (!scoped()) return [];
		if (!response.ok) {
			const message =
				payload && typeof payload.message === 'string'
					? payload.message
					: `Failed to load chat (status ${response.status})`;
			throw new Error(message);
		}
		const messages = payload?.messages ?? [];
		// Merging is monotonic (id-keyed, order-insensitive), so even an operation
		// superseded by a newer load/send may still contribute its messages.
		mergeChatMessages(messages, opts);
		// The shared error state belongs to the LATEST operation only: an older
		// load's success must not clear an error a newer operation just surfaced.
		if (latest()) chatError = null;
		return messages;
	} catch (err) {
		// A stale/superseded operation's failure must not clobber the newer state —
		// including a load that was already in flight when a SEND succeeded.
		if (latest()) chatError = err instanceof Error ? err.message : 'Failed to load chat.';
		return [];
	} finally {
		// Likewise the loading flag: only the LATEST operation that still owns the
		// chat room may clear it — a stale finally must not blank a newer op's state.
		if (latest()) chatLoading = false;
	}
}

export async function sendRoomChat(body: string) {
	if (!room) throw new Error('No room is loaded.');
	// Exact-room scope, captured before the await: the message belongs to THIS
	// room; its response must neither merge into a successor room's thread nor
	// clear that room's chat error. The send ALSO claims the next chat operation
	// number — it participates in the same ordering as loads, so an OLDER load
	// still in flight can no longer surface its failure (or clear the loading
	// flag) over this send's newer, successful state.
	const token = roomOpToken();
	const roomCode = room.roomCode;
	const targetChatRoom = chatRoomCode;
	const op = ++chatOpSeq;
	const scoped = () => !staleRoomOp(token) && chatRoomCode === targetChatRoom;
	const latest = () => scoped() && op === chatOpSeq;
	let payload: { message: RoomChatMessage };
	try {
		payload = await postPlayJson<{ message: RoomChatMessage }>(
			`/api/play/sessions/${encodeURIComponent(roomCode)}/chat`,
			{ body }
		);
	} catch (err) {
		// A FAILED send is still the newest chat operation: by claiming the op
		// number it fenced every older load out of the loading/error state, so it
		// must SETTLE that state itself — otherwise an older load's spinner (whose
		// own finally is now non-latest) would hang forever behind this failure.
		// The caller surfaces the thrown error in the composer; messages are
		// untouched (monotonic merge only ever ADDS).
		if (latest()) chatLoading = false;
		throw err;
	}
	if (!scoped()) throw supersededError();
	mergeChatMessages([payload.message], { countUnread: false });
	if (latest()) {
		chatError = null;
		// The thread visibly has content now; an older load's pending spinner state
		// must not linger (its own finally is fenced out as a non-latest op).
		chatLoading = false;
	}
	return payload.message;
}

export async function claimSeat(seatColor: SeatColor) {
	if (!room) throw new Error('No room is loaded.');
	// Capture the exact room + revision + cmdId this action was taken against.
	const token = roomOpToken();
	const roomCode = room.roomCode;
	const expectedRevision = room.revision;
	const view = await postPlayJson<RoomView>(
		`/api/play/sessions/${encodeURIComponent(roomCode)}/claim-seat`,
		{ seatColor, expectedRevision, cmdId: nextCommandId() }
	);
	if (staleRoomOp(token)) throw supersededError();
	setRoomView(view);
	return view;
}

export async function startPlayGame() {
	if (!room) throw new Error('No room is loaded.');
	const token = roomOpToken();
	const roomCode = room.roomCode;
	const expectedRevision = room.revision;
	const view = await postPlayJson<RoomView>(
		`/api/play/sessions/${encodeURIComponent(roomCode)}/start`,
		{ expectedRevision, cmdId: nextCommandId() }
	);
	if (staleRoomOp(token)) throw supersededError();
	setRoomView(view);
	return view;
}

export async function sendPlayCommand(command: GameCommand): Promise<RoomView> {
	if (!room) throw new Error('No room is loaded.');
	// Capture the room epoch, exact room/revision, and one idempotency key before the
	// request. A retry therefore targets the same durable history, while a route or
	// identity change fences the response from reaching the new room.
	const token = roomOpToken();
	const roomCode = room.roomCode;
	const expectedRevision = room.revision;
	const cmdId = nextCommandId();
	// Mutations intentionally never ride `transport`. The socket's RoomHost is a
	// projection/tick cache over the durable row; allowing clients to choose between
	// that actor and HTTP recreated split ownership under simultaneous actions. HTTP
	// is therefore the one player-command ingress on web and Godot. The cmdId still
	// gives safe same-request retries at the durable ledger boundary.
	const view = await postPlayJson<RoomView>(
		`/api/play/sessions/${encodeURIComponent(roomCode)}/commands`,
		{
			expectedRevision,
			command,
			cmdId
		}
	);
	if (staleRoomOp(token)) throw supersededError();
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
		/** Per-seat action surface from RoomView v2 (both transports). */
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

// DEV/E2E-ONLY test hook (mirrors window.__arcAuth in +layout.svelte): the journey
// suite proves route re-targeting with it — the STORE's live room (not just the
// URL), which room the transport/channel currently serve, and that exactly one
// (or zero, HTTP-only) transport owns the page. The `?e2e` gate exists because
// the deterministic journey lane runs the BUILT preview bundle (dev=false); the
// hook is READ-ONLY introspection of the viewer's own connection state — no
// secrets, no overrides (see $lib/play/e2eHarness.ts; the ws override above
// stays dev-only).
if (browser && (dev || isE2eHarness())) {
	(window as unknown as { __arcPlayDiag?: () => Record<string, unknown> }).__arcPlayDiag = () => ({
		roomCode: room?.roomCode ?? null,
		revision: room?.revision ?? null,
		phase: room?.phase ?? null,
		memberId: member?.id ?? null,
		isConnected,
		transportRoom: transportRoomCode,
		openTransports: openTransportCount,
		channelTopic
	});
}
