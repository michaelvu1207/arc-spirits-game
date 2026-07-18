/**
 * The single durable commit protocol for room mutations — shared by BOTH transports.
 *
 * Every mutation of a room (player command over HTTP or WebSocket, bot/deadline tick,
 * room close) must go through ONE authoritative, durable, monotonically revisioned
 * history: the `play_game_sessions` row, fenced by a compare-and-set on `revision`.
 * The WebSocket room server keeps an in-memory copy purely as a latency cache — it
 * commits here BEFORE acknowledging, and reloads from the row on a CAS miss. That is
 * what makes the player-visible result independent of transport, server instance,
 * retry timing, and reconnects: there is exactly one history, and `revision` can only
 * grow.
 *
 * STRICT MONOTONICITY: a commit must write `nextState.revision > session.revision`
 * (the fenced base) and every ledger event must land inside
 * `(session.revision, nextState.revision]`. An equal-revision rewrite — same revision,
 * different state — is rejected HERE (both modes), inside the `commit_room_command`
 * RPC, and by the `play_game_sessions_revision_monotonic` trigger (see the 20260710
 * migration), so "revision can only grow" is structurally true at every boundary, not
 * a convention.
 *
 * Exactly-once command identity: a client-generated `cmdId` rides inside the event
 * row's `command_payload` (and, post-migration, a generated `cmd_id` column with a
 * partial unique index). The idempotency contract is bound to the ORIGINAL identity:
 * a retry is only answered as a duplicate when its (actor, command type, payload)
 * fingerprint matches the committed ledger row. The same cmdId re-used with a
 * DIFFERENT actor/type/payload is an `idempotency_conflict` — rejected, never
 * silently substituted for the original action.
 *
 * Two wire strategies, one contract:
 *  - RPC mode (REQUIRED for live/production authority): `arc_spirits_2d.commit_room_command`
 *    performs dedup-check + CAS update + event append in ONE transaction (see
 *    supabase/migrations/20260710_command_ledger.sql). Atomic exactly-once.
 *  - Fallback mode (EXPLICIT OPT-IN ONLY — `ARC_ALLOW_NONATOMIC_COMMIT=1`, honored
 *    exclusively under a development/test NODE_ENV; production refuses it
 *    UNCONDITIONALLY, flag or no flag): dedup SELECT → CAS UPDATE → event INSERT as separate
 *    statements. The CAS still guarantees a single linear history, but a crash or a
 *    permanent insert failure BETWEEN the CAS update and the event insert loses the
 *    idempotency marker for that command — so this mode CANNOT promise exactly-once
 *    and is never allowed to engage silently. Without the opt-in, a missing RPC is a
 *    readiness error ({@link CommitNotReadyError}): apply the migration BEFORE
 *    serving traffic.
 *
 * This module is deliberately framework-free (no `$env`, no `@sveltejs/kit`): the
 *  SvelteKit service and the standalone room server both inject their own Supabase
 *  clients, and tests inject an in-memory fake.
 */

import type { GameCommand, PublicGameState } from '../types';

/** Structural subset of a schema-scoped supabase-js client that commits need. */
export interface PlayDbClient {
	// supabase-js query builders are enormous generic types; the structural `any`
	// keeps this module compatible with real clients AND the in-memory test fake.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	from(table: string): any;
	rpc?(
		fn: string,
		args: Record<string, unknown>
	): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export const COMMIT_TABLES = {
	SESSIONS: 'play_game_sessions',
	EVENTS: 'play_game_session_events'
} as const;

export const COMMIT_RPC = 'commit_room_command';

/** The session-row fields a commit needs: the row identity plus the BASE revision the
 *  mutation was computed from (the CAS fence) and the started/ended stamps. */
export interface CommitSessionRef {
	id: string;
	revision: number;
	started_at: string | null;
	ended_at: string | null;
}

/** One command's ledger entry. A player command commits exactly one; a server tick
 *  (deadline advance + bot moves) commits its whole batch under one CAS. */
export interface CommitEvent {
	commandType: string;
	/** Event-log payload; for player commands this is the command itself. `cmdId` (when
	 *  present) is embedded into the stored payload — the durable idempotency key. */
	payload: GameCommand | Record<string, unknown>;
	actorMemberId: string | null;
	/** The revision this command produced (monotone within the batch). */
	revision: number;
	cmdId?: string | null;
}

export type CommitOutcome =
	| {
			outcome: 'committed';
			row: Record<string, unknown>;
			/** True when this commit failed to append its ledger rows (opt-in fallback mode
			 *  only — state IS durable, but the idempotency marker for this cmdId was lost). */
			ledgerWriteFailed?: boolean;
	  }
	| { outcome: 'cas_miss' }
	/** The cmdId already committed WITH THE SAME identity fingerprint; `revision` is the
	 *  ORIGINAL committed revision. Callers answer with the current durable view plus
	 *  this original revision as `duplicateOfRevision`. */
	| { outcome: 'duplicate'; revision: number }
	/** The cmdId already committed with a DIFFERENT actor/type/payload — the retry is
	 *  not the original action and must be rejected, never substituted. */
	| { outcome: 'idempotency_conflict'; revision: number };

/** Raised when the atomic commit RPC is not installed and the non-atomic fallback has
 *  not been explicitly opted into: the store cannot meet the exactly-once contract, so
 *  the server must fail closed with a readiness error instead of degrading silently. */
export class CommitNotReadyError extends Error {
	readonly code = 'store_not_ready';
	constructor() {
		super(
			`store not ready: the atomic ${COMMIT_RPC} RPC is not installed. Apply ` +
				`supabase/migrations/20260710_command_ledger.sql BEFORE serving traffic ` +
				`(or set ARC_ALLOW_NONATOMIC_COMMIT=1 for local/test use only — the ` +
				`non-atomic fallback cannot guarantee exactly-once).`
		);
		this.name = 'CommitNotReadyError';
	}
}

/**
 * Resolve whether the pre-migration NON-ATOMIC fallback may engage.
 *
 * PRODUCTION FAILS CLOSED UNCONDITIONALLY: under NODE_ENV=production neither the
 * ARC_ALLOW_NONATOMIC_COMMIT env flag nor an explicit in-code opt-in
 * (`opts.allowNonAtomicFallback` / RoomHostDeps.allowNonAtomicCommit) can enable
 * it — a leftover flag or a miswired dependency must never quietly downgrade the
 * exactly-once contract on a live store. The fallback is additionally BOUNDED to a
 * safe posture: only development, test, or an unset NODE_ENV (a bare local
 * `tsx`/vitest run) qualify; any other deployment tier (staging, preview, …) fails
 * closed the same way production does.
 *
 * Every gate in the authority path (command commits here, ranked finalization in
 * matchFinalize.ts, and the effects-outbox drain that feeds it) resolves through
 * this ONE function, so no boundary can drift.
 */
export function nonAtomicFallbackPermitted(
	explicit?: boolean,
	env: Record<string, string | undefined> = readProcessEnv()
): boolean {
	const nodeEnv = env.NODE_ENV;
	if (nodeEnv === 'production') return false;
	if (nodeEnv != null && nodeEnv !== '' && nodeEnv !== 'development' && nodeEnv !== 'test') {
		return false;
	}
	return explicit ?? env.ARC_ALLOW_NONATOMIC_COMMIT === '1';
}

function readProcessEnv(): Record<string, string | undefined> {
	try {
		return typeof process !== 'undefined' ? (process.env ?? {}) : {};
	} catch {
		return {};
	}
}

/** The env-flag form of {@link nonAtomicFallbackPermitted} (no explicit opt-in). */
export function nonAtomicCommitAllowedFromEnv(
	env: Record<string, string | undefined> = readProcessEnv()
): boolean {
	return nonAtomicFallbackPermitted(undefined, env);
}

/** Detect "the RPC / column does not exist" errors so readiness (or the opted-in
 *  fallback) can be decided. */
function isMissingRpc(error: { code?: string; message?: string } | null): boolean {
	if (!error) return false;
	const message = error.message ?? '';
	return (
		error.code === 'PGRST202' ||
		error.code === '42883' ||
		message.includes(COMMIT_RPC) ||
		message.includes('schema cache')
	);
}

/** Once the RPC is observed missing, stop probing (per process). Reset for tests. */
let rpcKnownMissing = false;
export function resetCommitRpcProbe(): void {
	rpcKnownMissing = false;
}

/** The stored event payload: the command with the cmdId embedded (the durable key). */
export function eventPayloadFor(event: CommitEvent): Record<string, unknown> {
	const base = event.payload as Record<string, unknown>;
	return event.cmdId ? { ...base, cmdId: event.cmdId } : base;
}

/** Deterministic JSON with recursively sorted object keys — jsonb round-trip safe, so
 *  a fingerprint computed from an in-memory command equals one computed from the
 *  stored (key-reordered) ledger payload. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
	const keys = Object.keys(value as Record<string, unknown>)
		.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
		.sort();
	return `{${keys
		.map(
			(key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
		)
		.join(',')}}`;
}

/**
 * The durable idempotency identity of a command: WHO (actor member) did WHAT (command
 * type + payload, minus the cmdId itself, which is equal on both sides by definition).
 * A retry only counts as a duplicate of the original when this fingerprint matches.
 */
export function commandFingerprint(
	actorMemberId: string | null,
	commandType: string,
	payload: Record<string, unknown>
): string {
	const { cmdId: _cmdId, ...rest } = payload;
	return stableStringify({ actor: actorMemberId ?? null, type: commandType, payload: rest });
}

/** The identity a committed cmdId was stored under (for duplicate-vs-conflict checks). */
export interface CommittedCmd {
	revision: number;
	actorMemberId: string | null;
	commandType: string;
	payload: Record<string, unknown>;
}

/** Does an incoming event carry the SAME identity as the committed original? */
export function committedCmdMatches(existing: CommittedCmd, event: CommitEvent): boolean {
	return (
		commandFingerprint(existing.actorMemberId, existing.commandType, existing.payload) ===
		commandFingerprint(event.actorMemberId, event.commandType, eventPayloadFor(event))
	);
}

/**
 * Durable idempotency lookup: has `cmdId` already committed for this session?
 * Returns the original committed revision AND identity (actor, type, payload) so the
 * caller can distinguish an honest retry from a conflicting re-use, or null. Uses the
 * jsonb path filter so it works with or without the generated `cmd_id` column.
 */
export async function findCommittedCmd(
	db: PlayDbClient,
	sessionId: string,
	cmdId: string
): Promise<CommittedCmd | null> {
	const { data, error } = await db
		.from(COMMIT_TABLES.EVENTS)
		.select('revision, actor_member_id, command_type, command_payload')
		.eq('session_id', sessionId)
		.eq('command_payload->>cmdId', cmdId)
		.limit(1)
		.maybeSingle();
	if (error) {
		throw new Error(`cmdId lookup failed: ${error.message}`);
	}
	const row = data as {
		revision: number;
		actor_member_id: string | null;
		command_type: string;
		command_payload: Record<string, unknown>;
	} | null;
	if (!row) return null;
	return {
		revision: row.revision,
		actorMemberId: row.actor_member_id ?? null,
		commandType: row.command_type,
		payload: row.command_payload ?? {}
	};
}

/** Strict-monotonicity validation, applied BEFORE any wire write in both modes: the
 *  next revision must exceed the fenced base, the written state must carry exactly
 *  that revision, and every ledger event must land inside (base, next]. */
function validateMonotonicCommit(
	session: CommitSessionRef,
	nextState: PublicGameState,
	events: CommitEvent[]
): void {
	if (!Number.isInteger(nextState.revision) || nextState.revision <= session.revision) {
		throw new Error(
			`commit rejected (revision_not_monotonic): next revision ${nextState.revision} must be ` +
				`strictly greater than the fenced base revision ${session.revision} — an equal- or ` +
				`lower-revision write would rewrite committed history.`
		);
	}
	for (const event of events) {
		if (
			!Number.isInteger(event.revision) ||
			event.revision <= session.revision ||
			event.revision > nextState.revision
		) {
			throw new Error(
				`commit rejected (event_revision_incoherent): event ${event.commandType} carries ` +
					`revision ${event.revision}, outside (${session.revision}, ${nextState.revision}].`
			);
		}
	}
}

/**
 * ONE durable commit attempt: fence on `session.revision`, write `nextState`, append
 * the ledger events. Never retries — the caller owns the reload-and-reapply loop,
 * because a CAS miss means the mutation must be recomputed against the fresh state.
 *
 * Requires the atomic RPC unless the non-atomic fallback is explicitly opted into
 * (`opts.allowNonAtomicFallback`, default `ARC_ALLOW_NONATOMIC_COMMIT=1`); with no
 * opt-in a missing RPC throws {@link CommitNotReadyError} — fail closed, never a
 * silent downgrade of the exactly-once guarantee.
 */
export async function commitRoomMutation(
	db: PlayDbClient,
	params: {
		session: CommitSessionRef;
		nextState: PublicGameState;
		events: CommitEvent[];
	},
	opts?: { allowNonAtomicFallback?: boolean }
): Promise<CommitOutcome> {
	const { session, nextState, events } = params;
	validateMonotonicCommit(session, nextState, events);
	// Production (and any non-dev/test tier) fails closed here even when the caller
	// passed an explicit opt-in — see nonAtomicFallbackPermitted.
	const allowFallback = nonAtomicFallbackPermitted(opts?.allowNonAtomicFallback);
	const stampStartedAt = session.started_at == null && nextState.status === 'active';
	const isTerminal = nextState.status === 'finished' || nextState.status === 'closed';
	const stampEndedAt = session.ended_at == null && isTerminal;

	// ── RPC mode: dedup + CAS + ledger in one transaction ─────────────────────────
	if (!(allowFallback && rpcKnownMissing) && typeof db.rpc === 'function') {
		const { data, error } = await db.rpc(COMMIT_RPC, {
			p_session_id: session.id,
			p_expected_revision: session.revision,
			p_next_revision: nextState.revision,
			p_status: nextState.status,
			p_game_id: nextState.gameId,
			p_scenario: nextState.scenario ?? null,
			p_public_state: nextState,
			p_stamp_started_at: stampStartedAt,
			p_stamp_ended_at: stampEndedAt,
			p_events: events.map((event) => ({
				revision: event.revision,
				actor_member_id: event.actorMemberId,
				command_type: event.commandType,
				command_payload: eventPayloadFor(event)
			}))
		});
		if (!error) {
			const result = data as
				| { outcome: 'committed'; row: Record<string, unknown> }
				| { outcome: 'cas_miss' }
				| { outcome: 'duplicate'; revision: number }
				| { outcome: 'idempotency_conflict'; revision: number };
			return result;
		}
		if (!isMissingRpc(error)) {
			throw new Error(`commit RPC failed: ${error.message}`);
		}
		// Migration not applied. Without the explicit opt-in this is a READINESS error:
		// the store cannot meet the atomic exactly-once contract, so no write happens.
		if (!allowFallback) {
			throw new CommitNotReadyError();
		}
		rpcKnownMissing = true; // opted-in local/test store — fall through.
	} else if (typeof db.rpc !== 'function' && !allowFallback) {
		throw new CommitNotReadyError();
	}

	// ── Fallback mode (EXPLICIT OPT-IN): dedup SELECT → CAS UPDATE → ledger INSERT ──
	for (const event of events) {
		if (!event.cmdId) continue;
		const existing = await findCommittedCmd(db, session.id, event.cmdId);
		if (existing) {
			return committedCmdMatches(existing, event)
				? { outcome: 'duplicate', revision: existing.revision }
				: { outcome: 'idempotency_conflict', revision: existing.revision };
		}
	}

	const now = new Date().toISOString();
	const updatePayload: Record<string, unknown> = {
		status: nextState.status,
		revision: nextState.revision,
		game_id: nextState.gameId,
		scenario: nextState.scenario,
		public_state: nextState
	};
	if (stampStartedAt) updatePayload.started_at = now;
	if (stampEndedAt) updatePayload.ended_at = now;

	const { data, error } = await db
		.from(COMMIT_TABLES.SESSIONS)
		.update(updatePayload)
		.eq('id', session.id)
		.eq('revision', session.revision)
		.select('*')
		.maybeSingle();
	if (error) {
		throw new Error(`commit persist failed: ${error.message}`);
	}
	if (!data) {
		return { outcome: 'cas_miss' }; // another writer holds a newer history.
	}

	const eventRows = events.map((event) => ({
		session_id: session.id,
		revision: event.revision,
		actor_member_id: event.actorMemberId,
		command_type: event.commandType,
		command_payload: eventPayloadFor(event)
	}));
	let ledgerWriteFailed = false;
	if (eventRows.length > 0) {
		let insert = await db.from(COMMIT_TABLES.EVENTS).insert(eventRows);
		if (insert.error) {
			// One retry — the ledger row is the durable idempotency marker; losing it
			// (fallback mode only) means a later duplicate of this cmdId could re-apply.
			insert = await db.from(COMMIT_TABLES.EVENTS).insert(eventRows);
		}
		if (insert.error) {
			ledgerWriteFailed = true;
			console.error(
				`[commit] ledger append failed for session ${session.id} rev ${nextState.revision}: ${insert.error.message}`
			);
		}
	}

	return ledgerWriteFailed
		? { outcome: 'committed', row: data as Record<string, unknown>, ledgerWriteFailed }
		: { outcome: 'committed', row: data as Record<string, unknown> };
}
