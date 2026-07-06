/**
 * WebSocket wire protocol for the long-lived Arc Spirits room server. Both directions of
 * the message union, discriminated on `t`. Framed as JSON text; every server frame carries
 * enough for the client to stay authoritative without re-fetching the SvelteKit /view route.
 *
 * Auth model mirrors the HTTP path exactly: the credential is the member UUID (there is no
 * signed room token). See the join-message doc + the M0c-contract design notes.
 *
 * IMPORTS: this file lives OUTSIDE `src/`, so the SvelteKit `$lib` path alias does not
 * resolve here (and svelte-check's include globs — `../src/**` — do not cover it, so it is
 * not typechecked by `npx svelte-check` today). Types are imported by RELATIVE path from the
 * engine lib until the room server gets its own tsconfig; swap to `$lib/play/...` if/when
 * `server/` is added to the project's path mapping.
 */

import type { GameCommand, MemberRole, SeatColor } from '../src/lib/play/types';
import type { RoomViewV2 } from '../src/lib/play/viewV2';

/** Client-generated id echoed back on the matching ack, so an optimistic client can retire
 *  exactly the command that resolved (multiple may be in flight). */
export type CommandId = string;

/** Structured failure, same shape as CommandResult.error / kitError bodies. */
export interface WsError {
	code: string;
	message: string;
}

// ── Client → Server ─────────────────────────────────────────────────────────────

/**
 * First frame on a fresh socket. Identity resolution mirrors getRoomMemberId +
 * fallbackUserId:
 *   1. `memberToken` (the member UUID) — the primary credential for the cookieless
 *      Godot/Capacitor client;
 *   2. else the httpOnly `arc_spirits_play_member_<ROOMCODE>` cookie that same-origin
 *      browsers send automatically on the WS upgrade request (server reads it off the
 *      handshake, not this frame);
 *   3. else `authToken` (Supabase access token) → user → getMemberBySessionAndUser, for a
 *      matchmade player with no member cookie/token.
 * `resumeFromRevision` set ⇒ this is a reconnect; the server replies with a `delta` from
 * that revision (see reconnect semantics) instead of a fresh `joined`.
 */
export interface JoinMessage {
	t: 'join';
	roomCode: string;
	memberToken?: string; // member UUID; omit to rely on the upgrade cookie
	authToken?: string; // Supabase bearer, matchmade fallback only
	resumeFromRevision?: number;
}

/**
 * Submit a game command. `cmdId` matches the ack. `expectedRevision` is advisory only —
 * the server, like runRoomCommand, does NOT gate on it (simultaneous play); it is carried
 * for client-side ordering/telemetry.
 */
export interface CommandMessage {
	t: 'command';
	cmdId: CommandId;
	command: GameCommand;
	expectedRevision?: number;
}

/** Force a full refresh (client detected a gap / woke from background). Server replies with
 *  a `delta` carrying the full current view. */
export interface ResyncMessage {
	t: 'resync';
	fromRevision?: number;
}

/** Client heartbeat; server replies `pong`. */
export interface PingMessage {
	t: 'ping';
	ts: number;
}

export type ClientMessage = JoinMessage | CommandMessage | ResyncMessage | PingMessage;

// ── Server → Client ─────────────────────────────────────────────────────────────

/** Reply to a successful `join`: the full authoritative view + the resolved identity. */
export interface JoinedMessage {
	t: 'joined';
	revision: number;
	seat: SeatColor | null;
	role: MemberRole;
	view: RoomViewV2;
}

/**
 * Reply to a `command`, matched by `cmdId`.
 *   - ok:true  → `revision` is the post-apply revision and `view` is the FRESH full
 *     RoomViewV2 for this connection (viewer-filtered + own-seat affordances), so the
 *     client reconciles it exactly as it reconciles a delta and retires its optimistic
 *     guess against authoritative state.
 *   - ok:false → `error` explains the rejection; the client rolls back its optimistic
 *     mutation. No `view` (state is unchanged for a rejected command).
 * NOTE: because other players act simultaneously, a broadcast `delta` for a newer revision
 * may arrive BEFORE this ack. The client applies by revision (mirrors isStaleRoomUpdate) —
 * an ack whose `view.projection.revision` is older than what's already applied only retires
 * the cmdId; it must not regress the board.
 */
export type AckMessage =
	| { t: 'ack'; cmdId: CommandId; ok: true; revision: number; view: RoomViewV2 }
	| { t: 'ack'; cmdId: CommandId; ok: false; error: WsError };

/**
 * Pushed to every connection whenever the room's revision advances (another player's
 * command, a bot tick, a deadline enforcement, a room close).
 *
 * DELTA SHAPE — DECISION (M0): `patch` is the FULL fresh RoomViewV2 for this connection, not
 * an RFC6902 op list. Justification: the existing client merge primitive is reconcile()
 * (src/lib/play/reconcile.ts) — a whole-value deep in-place merge that already writes only
 * changed leaves and preserves identity of unchanged subtrees, giving fine-grained Svelte
 * reactivity from a full payload. reconcile CANNOT consume a JSON-Pointer patch; adding one
 * would mean a new server diff computation AND a new client apply path for zero rendering
 * win. So we "reuse the reconcile shape" literally: ship the full view, client calls
 * reconcile(room, patch.projection) + replaces affordances. `fromRevision`/`toRevision` are
 * envelope metadata for ordering/staleness only — the body is not a diff. (A byte-minimal
 * true diff is deferred to M6 payload tuning; it would require a companion reconcile-patch
 * applier.)
 */
export interface DeltaMessage {
	t: 'delta';
	fromRevision: number;
	toRevision: number;
	patch: RoomViewV2;
}

/** Connection-level failure (bad join, room closed/gone, auth failure). `fatal` ⇒ the
 *  server will close the socket; the client should not auto-retry the same join. */
export interface ErrorMessage {
	t: 'error';
	code: string;
	message: string;
	fatal?: boolean;
}

/** Heartbeat reply, echoing the client ping `ts` for RTT measurement. */
export interface PongMessage {
	t: 'pong';
	ts: number;
}

export type ServerMessage =
	| JoinedMessage
	| AckMessage
	| DeltaMessage
	| ErrorMessage
	| PongMessage;

// ── Heartbeat / reconnect semantics ─────────────────────────────────────────────
//
// HEARTBEAT: client sends `ping` every HEARTBEAT_INTERVAL_MS; server replies `pong`. The
// server tracks last-seen per connection and closes any socket idle past
// HEARTBEAT_TIMEOUT_MS (a dead mobile socket). A live connection is the room's presence
// signal, replacing the last_seen_at poll for connected members. The server also drives
// its own deadline enforcement + bot ticks on a timer (it holds authoritative in-memory
// state), so a room with zero live sockets is handled by the server loop, not a poller.
//
// RECONNECT: on socket loss the client re-opens and sends `join` with
// `resumeFromRevision = <last applied revision>`. The server does NOT keep a per-revision
// diff log, and reconcile merges a full value regardless, so "resume" always replies with a
// `delta { fromRevision: resumeFromRevision, toRevision: current, patch: <full view> }`
// (or a `joined` if the client sent no resume revision). The client reconciles the full
// view — cheap, and correct even if it missed N revisions while offline. `resync` behaves
// identically on an already-open socket.

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 45_000;
