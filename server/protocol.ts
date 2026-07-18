/**
 * WebSocket wire protocol for the long-lived Arc Spirits room server. Both directions of
 * the message union, discriminated on `t`. Framed as JSON text; every server frame carries
 * enough for the client to stay authoritative without re-fetching the SvelteKit /view route.
 *
 * AUTH MODEL: the ONLY join credential is a short-lived, ONE-USE, room-scoped ticket
 * minted by the authenticated HTTP endpoint (`POST /api/play/sessions/<code>/ws-ticket`;
 * see src/lib/play/server/wsTickets.ts). No durable credential — no account token, no
 * room secret, no cookie — ever crosses this boundary, and the public member UUID that
 * labels seats in every projection/frame never authorizes anything. An expired, forged,
 * replayed, wrong-room, wrong-user or bot-bound ticket FAILS the join fatally (the
 * socket is closed) — it never silently downgrades an intended member to spectator.
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
 * First frame on a fresh socket. `ticket` is the short-lived one-use room-scoped
 * join ticket from the authenticated mint endpoint — the ONLY credential this
 * boundary accepts. The server consumes it atomically (a replay fails), verifies
 * its exact (room, user, member, permission) binding against current authoritative
 * rows, and joins the socket as that identity: 'member' tickets command as the
 * bound membership; 'spectator' tickets watch and can never command. ANY ticket
 * failure is a FATAL join error (socket closed) — never a silent spectator
 * downgrade. Reconnects mint a fresh ticket first.
 *
 * `resumeFromRevision` set ⇒ this is a reconnect; the server replies with a `delta`
 * from that revision (see reconnect semantics) instead of a fresh `joined`.
 */
export interface JoinMessage {
	t: 'join';
	roomCode: string;
	ticket: string;
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
 *   - ok:true + `duplicateOfRevision` → this cmdId had ALREADY committed (an honest
 *     retry after a lost ack). INVARIANT: `revision` and `view` are the CURRENT durable
 *     head at answer time — `revision === view.projection.revision` always holds, no
 *     matter how many unrelated commits landed since the original. The revision the
 *     command originally committed at rides in `duplicateOfRevision` (informational);
 *     clients that predate this field simply reconcile the current view, which is the
 *     same convergence a broadcast delta would have produced.
 *   - ok:false → `error` explains the rejection; the client rolls back its optimistic
 *     mutation. No `view` (state is unchanged for a rejected command). A re-used cmdId
 *     whose actor/type/payload does not match the committed original rejects with
 *     code `idempotency_conflict` (the original action is never silently substituted).
 * NOTE: because other players act simultaneously, a broadcast `delta` for a newer revision
 * may arrive BEFORE this ack. The client applies by revision (mirrors isStaleRoomUpdate) —
 * an ack whose `view.projection.revision` is older than what's already applied only retires
 * the cmdId; it must not regress the board.
 */
export type AckMessage =
	| {
			t: 'ack';
			cmdId: CommandId;
			ok: true;
			revision: number;
			view: RoomViewV2;
			/** Present on a duplicate retry: the revision this cmdId ORIGINALLY committed at. */
			duplicateOfRevision?: number;
	  }
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

/** Hard cap on a single client→server frame. Legitimate frames (join / command /
 *  resync / ping) are tiny; anything larger is hostile or broken and the socket is
 *  closed at the transport layer (`ws` maxPayload) before JSON parsing. */
export const MAX_CLIENT_FRAME_BYTES = 32 * 1024;

/** The exact HTTP path the WebSocket upgrade must arrive on. Any other path is
 *  refused at the upgrade — the room is chosen by the `join` frame, never the URL. */
export const WS_UPGRADE_PATH = '/ws';
