/**
 * In-memory fake of the schema-scoped supabase-js client surface the durable commit
 * protocol uses (commit.ts + memberMirrors + matchFinalize + historySnapshots + the
 * room server's session reads). TEST-ONLY: lets the authority/recovery suites prove
 * the cross-instance CAS fencing, exactly-once cmdId semantics, crash recovery and
 * jsonb round-trip stability without a live Postgres.
 *
 * Fidelity choices that matter to the tests:
 *  - Stored jsonb values are DEEP-CLONED and their object keys RE-SORTED on write,
 *    exactly like Postgres `jsonb` (which does not preserve key order and drops
 *    duplicate keys). This is what makes the stateHash stability tests honest.
 *  - `update().eq('revision', N)` is atomic per call — two concurrent CAS updates on
 *    the same base revision admit exactly one winner (the fake serializes writes,
 *    mirroring Postgres row locking).
 *  - The partial unique index (session_id, cmd_id) from 20260710_command_ledger.sql,
 *    the ranked-table unique keys from 20260710_ranked_finalize.sql
 *    (match_results/match_result_players/player_rating_events/player_ratings/
 *    replay_codes) and BOTH atomic RPCs (`commit_room_command`, `finalize_match`)
 *    are emulated when constructed with `{ rpc: true }` ("migrations applied") —
 *    both store postures are testable. Each rpc() body runs synchronously after the
 *    latency delay, exactly like one transaction: concurrent callers serialize at
 *    that boundary and can never observe a partial rpc.
 *
 *    HONESTY LIMIT — the fake proves PROTOCOL logic, never PostgreSQL LOCKING: that
 *    one-JS-turn atomicity is STRONGER than a real transaction schedule, where the
 *    statements of two live transactions interleave. Schedules such as two
 *    finalizers both validating an ABSENT player_ratings row before either commits
 *    (the ranked P0: FOR UPDATE cannot lock a missing row; the real function fences
 *    it with per-user advisory locks) structurally CANNOT occur here, so a fake-only
 *    "race test" of them would be a false proof. Real-database locking behavior is
 *    proven against an actual PostgreSQL cluster in matchFinalize.pg.test.ts.
 *  - `latencyMs` injects a per-statement delay (ack-latency measurement);
 *    `failNextEventInsert` / `crashAfterUpdate` recreate the fallback-mode failure
 *    windows the docs call out; `failNextOp`/`failNextRpcCall` inject an error, a
 *    crash BEFORE the statement (nothing applied) or a crash AFTER it (applied but
 *    the process died before observing) at any table/op — the adversarial-recovery
 *    harness for matchFinalize.test.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { commandFingerprint } from './commit';

type Row = Record<string, any>;

/** Duplicate-vs-conflict decision for a re-used cmdId, mirroring the RPC: an honest
 *  retry matches the stored (actor, type, payload-minus-cmdId) fingerprint. */
function rpcDuplicateOutcome(existing: Row, event: Row): 'duplicate' | 'idempotency_conflict' {
	const stored = commandFingerprint(
		existing.actor_member_id ?? null,
		existing.command_type,
		existing.command_payload ?? {}
	);
	const incoming = commandFingerprint(
		event.actor_member_id ?? null,
		event.command_type,
		event.command_payload ?? {}
	);
	return stored === incoming ? 'duplicate' : 'idempotency_conflict';
}

interface DbError {
	code?: string;
	message: string;
}

/** Failure-injection modes: `error` = the statement/transaction fails cleanly
 *  (nothing applied, the caller sees {error}); `crash-before` = the process dies
 *  before the write reaches the store; `crash-after` = the write IS durable but the
 *  process dies before observing the result. Crashes surface as thrown errors. */
export type InjectedFailure = 'error' | 'crash-before' | 'crash-after';

/** Marker for injected crashes so they propagate as rejections (a dead process runs
 *  nothing afterwards) instead of being shaped into a {error} result. */
export class InjectedCrash extends Error {}

interface QueryResult {
	data: any;
	error: DbError | null;
	/** PostgREST-style row count, present when `.select(cols, {count:'exact'})`. */
	count?: number;
}

/** Postgres-jsonb-like normalization: deep clone with sorted object keys and
 *  `undefined` members dropped. Applied to every stored/returned row value. */
export function jsonbNormalize<T>(value: T): T {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map((item) => jsonbNormalize(item)) as unknown as T;
	const out: Record<string, any> = {};
	for (const key of Object.keys(value as Record<string, any>).sort()) {
		const member = (value as Record<string, any>)[key];
		if (member === undefined) continue;
		out[key] = jsonbNormalize(member);
	}
	return out as T;
}

/** Resolve a filter key that may use the PostgREST jsonb path form `col->>prop`. */
function readColumn(row: Row, key: string): any {
	const arrow = key.indexOf('->>');
	if (arrow === -1) return row[key];
	const col = key.slice(0, arrow);
	const prop = key.slice(arrow + 3);
	const holder = row[col];
	if (holder == null || typeof holder !== 'object') return null;
	const value = (holder as Row)[prop];
	return value == null ? null : String(value);
}

interface Filter {
	kind: 'eq' | 'in';
	key: string;
	value: any;
}

class QueryBuilder implements PromiseLike<QueryResult> {
	private op: 'select' | 'update' | 'insert' | 'upsert' | 'delete' = 'select';
	private updatePayload: Row | null = null;
	private insertRows: Row[] = [];
	private onConflict: string[] | null = null;
	private filters: Filter[] = [];
	private wantRows = false; // .select() chained after a mutation
	private wantCount = false; // .select(cols, {count:'exact'})
	private headOnly = false; // …with {head:true}: count only, no rows
	private singleMode: 'maybe' | 'strict' | null = null;
	private limitCount: number | null = null;
	private orderKey: { key: string; ascending: boolean } | null = null;

	constructor(
		private readonly db: FakePlayDb,
		private readonly table: string
	) {}

	select(_cols?: string, opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }) {
		this.wantRows = true;
		if (opts?.count) {
			this.wantCount = true;
			this.headOnly = opts.head === true;
		}
		return this;
	}
	update(payload: Row) {
		this.op = 'update';
		this.updatePayload = payload;
		return this;
	}
	insert(rows: Row | Row[]) {
		this.op = 'insert';
		this.insertRows = Array.isArray(rows) ? rows : [rows];
		return this;
	}
	upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
		this.op = 'upsert';
		this.insertRows = Array.isArray(rows) ? rows : [rows];
		this.onConflict = opts?.onConflict ? opts.onConflict.split(',').map((s) => s.trim()) : null;
		return this;
	}
	delete() {
		this.op = 'delete';
		return this;
	}
	eq(key: string, value: any) {
		this.filters.push({ kind: 'eq', key, value });
		return this;
	}
	in(key: string, values: any[]) {
		this.filters.push({ kind: 'in', key, value: values });
		return this;
	}
	limit(count: number) {
		this.limitCount = count;
		return this;
	}
	order(key: string, opts?: { ascending?: boolean }) {
		this.orderKey = { key, ascending: opts?.ascending ?? true };
		return this;
	}
	gt(key: string, value: any) {
		this.filters.push({ kind: 'eq', key, value: { __gt: value } });
		return this;
	}
	lt(key: string, value: any) {
		this.filters.push({ kind: 'eq', key, value: { __lt: value } });
		return this;
	}
	/** PostgREST `is.` filter (null / true / false) — used by the one-use ticket
	 *  consume (`consumed_at IS NULL`) so the conditional UPDATE stays atomic. */
	is(key: string, value: null | boolean) {
		this.filters.push({ kind: 'eq', key, value: { __is: value } });
		return this;
	}
	maybeSingle() {
		this.singleMode = 'maybe';
		return this;
	}

	then<TResult1 = QueryResult, TResult2 = never>(
		onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
	): PromiseLike<TResult1 | TResult2> {
		return this.execute().then(onfulfilled, onrejected);
	}

	private matches(row: Row): boolean {
		return this.filters.every((filter) => {
			const actual = readColumn(row, filter.key);
			if (filter.kind === 'in') return (filter.value as any[]).includes(actual);
			if (filter.value != null && typeof filter.value === 'object' && '__gt' in filter.value) {
				return actual > filter.value.__gt;
			}
			if (filter.value != null && typeof filter.value === 'object' && '__lt' in filter.value) {
				return actual < filter.value.__lt;
			}
			if (filter.value != null && typeof filter.value === 'object' && '__is' in filter.value) {
				const expected = filter.value.__is;
				return expected === null ? actual == null : actual === expected;
			}
			return actual === filter.value;
		});
	}

	private async execute(): Promise<QueryResult> {
		await this.db.delay();
		const injected = this.db.takeFailure(this.table, this.op);
		if (injected === 'error') {
			return { data: null, error: { message: `injected ${this.op} failure on ${this.table}` } };
		}
		if (injected === 'crash-before') {
			throw new InjectedCrash(`injected crash before ${this.op} on ${this.table} (not applied)`);
		}
		// The whole statement runs synchronously after the delay — like a single
		// Postgres statement, concurrent callers serialize at this boundary.
		try {
			const result = this.db.run(this);
			if (injected === 'crash-after') {
				throw new InjectedCrash(`injected crash after ${this.op} on ${this.table} (applied)`);
			}
			return result;
		} catch (err) {
			if (err instanceof InjectedCrash) throw err;
			return { data: null, error: { message: (err as Error).message } };
		}
	}

	/** @internal executed under FakePlayDb.run */
	apply(rows: Row[]): QueryResult {
		switch (this.op) {
			case 'select': {
				let found = rows.filter((row) => this.matches(row));
				if (this.orderKey) {
					const { key, ascending } = this.orderKey;
					found = [...found].sort((a, b) =>
						a[key] < b[key] ? (ascending ? -1 : 1) : a[key] > b[key] ? (ascending ? 1 : -1) : 0
					);
				}
				if (this.limitCount != null) found = found.slice(0, this.limitCount);
				return this.shape(found.map((row) => jsonbNormalize(row)));
			}
			case 'update': {
				const hits = rows.filter((row) => this.matches(row));
				for (const row of hits) {
					// Trigger emulation (play_game_sessions_revision_monotonic, 20260710
					// migration): revision must not decrease, and public_state must not be
					// rewritten under an unchanged revision — checked BEFORE applying.
					const monotonicError = this.db.checkSessionMonotonic(
						this.table,
						row,
						this.updatePayload ?? {}
					);
					if (monotonicError) return { data: null, error: monotonicError };
					Object.assign(row, jsonbNormalize(this.updatePayload ?? {}));
					this.db.onRowUpdated?.(this.table, row);
				}
				return this.shape(hits.map((row) => jsonbNormalize(row)));
			}
			case 'delete': {
				const hits = rows.filter((row) => this.matches(row));
				for (const hit of hits) rows.splice(rows.indexOf(hit), 1);
				return this.shape(hits.map((row) => jsonbNormalize(row)));
			}
			case 'insert': {
				if (this.table === 'play_game_session_events' && this.db.failNextEventInsert > 0) {
					this.db.failNextEventInsert -= 1;
					return { data: null, error: { message: 'injected event insert failure' } };
				}
				const inserted: Row[] = [];
				for (const raw of this.insertRows) {
					const row = jsonbNormalize({ ...this.db.defaultsFor(this.table), ...raw });
					const uniqueError = this.db.checkUnique(this.table, row);
					if (uniqueError) return { data: null, error: uniqueError };
					rows.push(row);
					inserted.push(row);
				}
				return this.shape(inserted.map((row) => jsonbNormalize(row)));
			}
			case 'upsert': {
				const keys = this.onConflict ?? [];
				const inserted: Row[] = [];
				for (const raw of this.insertRows) {
					const row = jsonbNormalize({ ...this.db.defaultsFor(this.table), ...raw });
					const existing = keys.length
						? rows.find((candidate) => keys.every((key) => candidate[key] === row[key]))
						: undefined;
					if (existing) Object.assign(existing, row);
					else rows.push(row);
					inserted.push(existing ?? row);
				}
				return this.shape(inserted.map((row) => jsonbNormalize(row)));
			}
		}
	}

	private shape(found: Row[]): QueryResult {
		const mutation = this.op !== 'select';
		if (this.singleMode === 'maybe' || this.singleMode === 'strict') {
			if (found.length === 0) {
				return this.singleMode === 'strict'
					? { data: null, error: { message: 'no rows' } }
					: { data: null, error: null };
			}
			return { data: found[0], error: null };
		}
		if (this.wantCount) {
			return { data: this.headOnly ? null : found, error: null, count: found.length };
		}
		if (mutation && !this.wantRows) return { data: null, error: null };
		return { data: found, error: null };
	}

	singleStrict() {
		this.singleMode = 'strict';
		return this;
	}
}

// supabase-js calls `.single()`; wire it to the strict variant.
(QueryBuilder.prototype as any).single = function (this: any) {
	return this.singleStrict();
};

export class FakePlayDb {
	tables = new Map<string, Row[]>();
	/** Per-statement injected latency (ms) — simulates DB round-trip cost. */
	latencyMs = 0;
	/** The DATABASE's clock relative to the process clock: `clock_timestamp()`
	 *  inside the emulated ticket RPCs (mint/consume/cleanup) reads
	 *  Date.now() + this offset.
	 *  Models exactly the production concern those functions exist for — an
	 *  application whose clock disagrees with the store's. Negative = the database
	 *  runs behind the application (the app is fast); positive = ahead. */
	dbClockOffsetMs = 0;
	/** Fail the next N event-ledger inserts (fallback-mode failure window). */
	failNextEventInsert = 0;
	/** When set, a session UPDATE throws AFTER applying — simulating a process crash
	 *  between the CAS write and the ledger insert (fallback mode). */
	crashAfterSessionUpdate = false;
	/** One-shot statement-level failure injections, consumed in order per (table, op). */
	private failures: { table: string; op: string; mode: InjectedFailure }[] = [];
	/** One-shot RPC-level failure injections, consumed in order per function name. */
	private rpcFailures: { fn: string; mode: InjectedFailure }[] = [];
	/** Observation hook for fencing assertions (e.g. revision monotonicity). */
	onRowUpdated: ((table: string, row: Row) => void) | null = null;
	/** Whether the 20260710 migration is "applied": RPC + unique cmd_id index. */
	readonly withRpc: boolean;
	private idSeq = 0;

	constructor(opts: { rpc?: boolean } = {}) {
		this.withRpc = opts.rpc ?? false;
	}

	rowsFor(table: string): Row[] {
		let rows = this.tables.get(table);
		if (!rows) {
			rows = [];
			this.tables.set(table, rows);
		}
		return rows;
	}

	defaultsFor(table: string): Row {
		this.idSeq += 1;
		const defaults: Row = { id: `${table}-${this.idSeq}`, created_at: new Date().toISOString() };
		if (table === 'play_session_members') {
			defaults.is_bot = false;
			defaults.user_id = null;
		}
		if (table === 'play_ws_tickets') defaults.consumed_at = null;
		return defaults;
	}

	/** Emulated `play_game_sessions_revision_monotonic` trigger (20260710 migration):
	 *  revision never decreases, and public_state is never rewritten under an unchanged
	 *  revision. Enforced in BOTH fake modes — the DB-level twin of the validation in
	 *  commit.ts, so even a writer that bypasses the shared commit cannot fork history. */
	checkSessionMonotonic(table: string, row: Row, payload: Row): DbError | null {
		if (table !== 'play_game_sessions') return null;
		if (!('revision' in payload)) return null;
		const next = payload.revision;
		if (typeof next !== 'number' || next < row.revision) {
			return {
				code: 'P0001',
				message: `play_game_sessions.revision must not decrease (${row.revision} -> ${String(next)}): revision_not_monotonic`
			};
		}
		if (next === row.revision && 'public_state' in payload) {
			const incoming = JSON.stringify(jsonbNormalize(payload.public_state));
			const current = JSON.stringify(jsonbNormalize(row.public_state));
			if (incoming !== current) {
				return {
					code: 'P0001',
					message: `play_game_sessions.public_state must not change under an unchanged revision ${next}: revision_not_monotonic`
				};
			}
		}
		return null;
	}

	/** Emulated unique indexes (post-migration store): (session_id, cmdId) on the
	 *  event ledger (20260710_command_ledger) plus the ranked/replay exactly-once
	 *  keys (20260710_ranked_finalize). */
	checkUnique(table: string, row: Row): DbError | null {
		// Canonical human membership (20260710_identity_trust): one membership per
		// (session, user) for non-bot rows — enforced in BOTH fake modes, like the
		// real partial unique index.
		if (table === 'play_session_members' && row.user_id != null && row.is_bot !== true) {
			const dupe = this.rowsFor(table).some(
				(existing) =>
					existing.session_id === row.session_id &&
					existing.user_id === row.user_id &&
					existing.is_bot !== true
			);
			if (dupe) {
				return {
					code: '23505',
					message:
						'duplicate key value violates unique constraint "play_session_members_session_user_unique"'
				};
			}
		}
		if (!this.withRpc) return null;
		if (table === 'play_game_session_events') {
			const cmdId = row.command_payload?.cmdId;
			if (cmdId == null) return null;
			const dupe = this.rowsFor(table).some(
				(existing) =>
					existing.session_id === row.session_id && existing.command_payload?.cmdId === cmdId
			);
			return dupe
				? {
						code: '23505',
						message:
							'duplicate key value violates unique constraint "play_game_session_events_cmd_unique"'
					}
				: null;
		}
		const uniqueKeys: Record<string, { name: string; cols: string[] }[]> = {
			match_results: [{ name: 'match_results_session_unique', cols: ['session_id'] }],
			match_result_players: [
				{ name: 'match_result_players_session_seat_unique', cols: ['session_id', 'seat_color'] }
			],
			player_rating_events: [
				{ name: 'player_rating_events_session_user_unique', cols: ['session_id', 'user_id'] }
			],
			player_ratings: [{ name: 'player_ratings_user_unique', cols: ['user_id'] }],
			replay_codes: [
				{ name: 'replay_codes_game_nav_unique', cols: ['game_id', 'navigation_count'] },
				{ name: 'replay_codes_pkey', cols: ['code'] }
			],
			replay_shares: [
				{ name: 'replay_shares_pkey', cols: ['code'] },
				{ name: 'replay_shares_owner_game_key', cols: ['owner_user_id', 'game_id'] }
			],
			replay_frames: [
				{ name: 'replay_frames_pkey', cols: ['game_id', 'revision'] }
			],
			social_friendships: [{ name: 'social_friendships_pkey', cols: ['user_low', 'user_high'] }],
			social_blocks: [{ name: 'social_blocks_pkey', cols: ['blocker_user_id', 'blocked_user_id'] }],
			social_party_members: [
				{ name: 'social_party_members_pkey', cols: ['party_id', 'user_id'] },
				{ name: 'social_party_members_user_id_key', cols: ['user_id'] }
			],
			social_presence: [{ name: 'social_presence_pkey', cols: ['user_id', 'client_id'] }],
			social_invites: [{ name: 'social_invites_token_digest_key', cols: ['token_digest'] }]
		};
		for (const key of uniqueKeys[table] ?? []) {
			const dupe = this.rowsFor(table).some((existing) =>
				key.cols.every((col) => existing[col] === row[col])
			);
			if (dupe) {
				return {
					code: '23505',
					message: `duplicate key value violates unique constraint "${key.name}"`
				};
			}
		}
		return null;
	}

	/** Queue a one-shot failure for the NEXT statement matching (table, op). */
	failNextOp(
		table: string,
		op: 'select' | 'insert' | 'update' | 'upsert' | 'delete',
		mode: InjectedFailure
	): void {
		this.failures.push({ table, op, mode });
	}

	/** Queue a one-shot failure for the NEXT call of the named RPC. */
	failNextRpcCall(fn: string, mode: InjectedFailure): void {
		this.rpcFailures.push({ fn, mode });
	}

	/** @internal consume a queued statement failure, if one matches. */
	takeFailure(table: string, op: string): InjectedFailure | null {
		const index = this.failures.findIndex((f) => f.table === table && f.op === op);
		if (index === -1) return null;
		return this.failures.splice(index, 1)[0].mode;
	}

	private takeRpcFailure(fn: string): InjectedFailure | null {
		const index = this.rpcFailures.findIndex((f) => f.fn === fn);
		if (index === -1) return null;
		return this.rpcFailures.splice(index, 1)[0].mode;
	}

	async delay(): Promise<void> {
		if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
	}

	/** @internal one "statement": runs a builder against its table synchronously. */
	run(builder: QueryBuilder): QueryResult {
		const table = (builder as any).table as string;
		const result = builder.apply(this.rowsFor(table));
		if (
			table === 'play_game_sessions' &&
			(builder as any).op === 'update' &&
			this.crashAfterSessionUpdate &&
			result.data != null
		) {
			this.crashAfterSessionUpdate = false;
			throw new Error('injected crash after session update');
		}
		return result;
	}

	from(table: string): QueryBuilder {
		return new QueryBuilder(this, table);
	}

	/** The atomic RPCs (`commit_room_command`, `finalize_match`), available only when
	 *  constructed with {rpc:true}. Each body runs synchronously — one transaction. */
	async rpc(fn: string, args: Record<string, any>): Promise<{ data: any; error: DbError | null }> {
		await this.delay();
		const injected = this.takeRpcFailure(fn);
		if (injected === 'error') {
			// A failed transaction applies nothing.
			return { data: null, error: { message: `injected rpc failure (${fn})` } };
		}
		if (injected === 'crash-before') {
			throw new InjectedCrash(`injected crash before rpc ${fn} (transaction never ran)`);
		}
		let result: { data: any; error: DbError | null };
		if (fn === 'mint_ws_ticket') {
			// The ticket lifecycle functions are emulated in BOTH store postures: they
			// ship in the SAME migration as the ticket table (20260710_identity_trust),
			// so any store holding tickets holds them. Their "database clock" is
			// Date.now() + dbClockOffsetMs — never a caller-supplied time.
			result = this.mintWsTicketRpc(args);
		} else if (fn === 'consume_ws_ticket') {
			result = this.consumeWsTicketRpc(args);
		} else if (fn === 'cleanup_ws_tickets') {
			result = this.cleanupWsTicketsRpc();
		} else if (this.withRpc && fn === 'commit_room_command') {
			result = this.commitRoomCommandRpc(args);
		} else if (this.withRpc && fn === 'finalize_match') {
			result = this.finalizeMatchRpc(args);
		} else if (this.withRpc && fn === 'apply_ranked_season_result') {
			result = this.applyRankedSeasonRpc(args);
		} else {
			result = {
				data: null,
				error: { code: 'PGRST202', message: `function ${fn} not found in schema cache` }
			};
		}
		if (injected === 'crash-after') {
			throw new InjectedCrash(`injected crash after rpc ${fn} (transaction committed)`);
		}
		return result;
	}

	/** The database's own wall clock (clock_timestamp()), as read inside the
	 *  emulated ticket functions. */
	private dbNowMs(): number {
		return Date.now() + this.dbClockOffsetMs;
	}

	/** The `mint_ws_ticket(session, user, member, role, digest)` function
	 *  (20260710_identity_trust.sql), mirrored: the caller supplies ONLY the digest
	 *  and the bindings; created_at/expires_at are fixed from the DATABASE clock
	 *  with the 30-second lifetime baked in — there is no time or TTL argument to
	 *  emulate because the real function accepts none. Mirrors the table's NOT NULL
	 *  bindings, role CHECK, and unique digest index. */
	private mintWsTicketRpc(args: Record<string, any>): { data: any; error: DbError | null } {
		const sessionId = args?.p_session_id;
		const userId = args?.p_user_id;
		const digest = args?.p_digest;
		const role = args?.p_role;
		if (sessionId == null || userId == null || digest == null) {
			return {
				data: null,
				error: {
					code: '23502',
					message: 'null value in column of relation "play_ws_tickets" violates not-null constraint'
				}
			};
		}
		if (role !== 'member' && role !== 'spectator') {
			return {
				data: null,
				error: {
					code: '23514',
					message:
						'new row for relation "play_ws_tickets" violates check constraint "play_ws_tickets_role_check"'
				}
			};
		}
		const rows = this.rowsFor('play_ws_tickets');
		if (rows.some((existing) => existing.digest === digest)) {
			return {
				data: null,
				error: {
					code: '23505',
					message: 'duplicate key value violates unique constraint "play_ws_tickets_digest_key"'
				}
			};
		}
		const nowMs = this.dbNowMs();
		this.idSeq += 1;
		const row = jsonbNormalize({
			id: `play_ws_tickets-${this.idSeq}`,
			session_id: sessionId,
			user_id: userId,
			member_id: args?.p_member_id ?? null,
			role,
			digest,
			expires_at: new Date(nowMs + 30_000).toISOString(),
			consumed_at: null,
			created_at: new Date(nowMs).toISOString()
		});
		rows.push(row);
		return { data: [jsonbNormalize(row)], error: null };
	}

	/** The `consume_ws_ticket(p_digest)` function (20260710_identity_trust.sql),
	 *  mirrored: one conditional UPDATE whose expiry predicate reads the DATABASE
	 *  clock — the caller supplies no time. Runs in one JS turn, so concurrent
	 *  replays admit exactly one winner, like the real statement. */
	private consumeWsTicketRpc(args: Record<string, any>): { data: any; error: DbError | null } {
		const digest = args?.p_digest;
		if (typeof digest !== 'string' || digest.length === 0) return { data: [], error: null };
		const nowMs = this.dbNowMs();
		const row = this.rowsFor('play_ws_tickets').find(
			(candidate) =>
				candidate.digest === digest &&
				candidate.consumed_at == null &&
				typeof candidate.expires_at === 'string' &&
				Date.parse(candidate.expires_at) > nowMs
		);
		if (!row) return { data: [], error: null };
		row.consumed_at = new Date(nowMs).toISOString();
		return { data: [jsonbNormalize(row)], error: null };
	}

	/** The `cleanup_ws_tickets()` hygiene function (20260710_identity_trust.sql),
	 *  mirrored: deletes only rows the DATABASE clock says expired over ten minutes
	 *  ago; returns the count. A fast application clock cannot make it sweep more. */
	private cleanupWsTicketsRpc(): { data: any; error: DbError | null } {
		const cutoffMs = this.dbNowMs() - 10 * 60_000;
		const rows = this.rowsFor('play_ws_tickets');
		const survivors = rows.filter(
			(row) => !(typeof row.expires_at === 'string' && Date.parse(row.expires_at) < cutoffMs)
		);
		const removed = rows.length - survivors.length;
		this.tables.set('play_ws_tickets', survivors);
		return { data: removed, error: null };
	}

	private commitRoomCommandRpc(args: Record<string, any>): { data: any; error: DbError | null } {
		const sessions = this.rowsFor('play_game_sessions');
		const events = this.rowsFor('play_game_session_events');
		const list: Row[] = Array.isArray(args.p_events) ? args.p_events : [];

		// Strict monotonicity + coherence, mirroring the RPC's raise-exception guards.
		const expected = args.p_expected_revision as number;
		const next = args.p_next_revision as number;
		if (typeof next !== 'number' || next <= expected) {
			return {
				data: null,
				error: {
					code: 'P0001',
					message: `commit_room_command: p_next_revision (${String(next)}) must exceed p_expected_revision (${expected}) — revision_not_monotonic`
				}
			};
		}
		if (args.p_public_state?.revision !== next) {
			return {
				data: null,
				error: {
					code: 'P0001',
					message: `commit_room_command: p_public_state.revision (${String(args.p_public_state?.revision)}) must equal p_next_revision (${next}) — revision_incoherent`
				}
			};
		}
		for (const event of list) {
			if (!(event.revision > expected && event.revision <= next)) {
				return {
					data: null,
					error: {
						code: 'P0001',
						message: `commit_room_command: event revision ${String(event.revision)} outside (${expected}, ${next}] — event_revision_incoherent`
					}
				};
			}
		}

		for (const event of list) {
			const cmdId = event?.command_payload?.cmdId;
			if (cmdId == null) continue;
			const existing = events.find(
				(row) => row.session_id === args.p_session_id && row.command_payload?.cmdId === cmdId
			);
			if (existing) {
				// Identity-bound dedup: an honest retry (same actor/type/payload) is a
				// duplicate; a re-used cmdId with a different identity is a conflict.
				const outcome = rpcDuplicateOutcome(existing, event);
				return { data: { outcome, revision: existing.revision }, error: null };
			}
		}

		const row = sessions.find(
			(candidate) =>
				candidate.id === args.p_session_id && candidate.revision === args.p_expected_revision
		);
		if (!row) return { data: { outcome: 'cas_miss' }, error: null };

		const now = new Date().toISOString();
		row.status = args.p_status;
		row.revision = args.p_next_revision;
		row.game_id = args.p_game_id;
		row.scenario = jsonbNormalize(args.p_scenario);
		row.public_state = jsonbNormalize(args.p_public_state);
		if (args.p_stamp_started_at && row.started_at == null) row.started_at = now;
		if (args.p_stamp_ended_at && row.ended_at == null) row.ended_at = now;
		this.onRowUpdated?.('play_game_sessions', row);

		for (const event of list) {
			events.push(
				jsonbNormalize({
					...this.defaultsFor('play_game_session_events'),
					session_id: args.p_session_id,
					revision: event.revision,
					actor_member_id: event.actor_member_id ?? null,
					command_type: event.command_type,
					command_payload: event.command_payload ?? {}
				})
			);
		}

		return { data: { outcome: 'committed', row: jsonbNormalize(row) }, error: null };
	}

	private applyRankedSeasonRpc(args: Record<string, any>): { data: any; error: DbError | null } {
		const sid = args.p_session_id;
		const season = args.p_season_id;
		const result = this.rowsFor('match_results').find((row) => row.session_id === sid);
		if (!result?.rated || result.quarantined) return { data: null, error: { message: 'season_result_unrated' } };
		const events = this.rowsFor('ranked_season_rating_events');
		if (events.some((row) => row.season_id === season && row.event_key === `match:${sid}`))
			return { data: { outcome: 'already_applied' }, error: null };
		const players = this.rowsFor('ranked_player_seasons');
		const payload: Row[] = Array.isArray(args.p_ratings) ? args.p_ratings : [];
		for (const item of payload) {
			const current = players.find((row) => row.season_id === season && row.user_id === item.user_id);
			const stale = item.expected_games == null ? current != null : current == null ||
				current.games_played !== item.expected_games || Math.abs(current.mu - item.expected_mu) > 1e-4 ||
				Math.abs(current.sigma - item.expected_sigma) > 1e-4;
			if (stale) return { data: null, error: { message: 'stale_season_ratings' } };
		}
		for (const item of payload) {
			events.push({ season_id: season, session_id: sid, user_id: item.user_id, event_kind: 'match',
				event_key: `match:${sid}`, placement: item.placement, mu_before: item.mu_before,
				sigma_before: item.sigma_before, mu_after: item.mu_after, sigma_after: item.sigma_after });
			const current = players.find((row) => row.season_id === season && row.user_id === item.user_id);
			if (current) Object.assign(current, { mu: item.mu_after, sigma: item.sigma_after,
				games_played: current.games_played + 1, wins: current.wins + (item.placement === 1 ? 1 : 0),
				placements_completed: Math.min(5, current.placements_completed + 1) });
			else players.push({ season_id: season, user_id: item.user_id, display_name: item.display_name,
				mu: item.mu_after, sigma: item.sigma_after, games_played: 1, wins: item.placement === 1 ? 1 : 0,
				placements_completed: 1, peak_ordinal: item.mu_after - 3 * item.sigma_after, is_bot: item.is_bot });
		}
		result.ranked_season_id = season;
		return { data: { outcome: 'applied' }, error: null };
	}

	/** The `finalize_match` transaction (20260710_ranked_finalize.sql), mirrored:
	 *  anchor claim on UNIQUE(session_id); player-row repair on the already-finalized
	 *  path; legacy partial-attempt markers (session events / last_session_id);
	 *  locked-base verification (stale_ratings error rolls the whole call back —
	 *  trivially true here because nothing is written before verification passes).
	 *  NOT mirrored (cannot be): the real function's per-user advisory locks and
	 *  FOR UPDATE row locks — this body runs in one JS turn, so the interleaved
	 *  schedules those locks exist for never arise here. See the module header's
	 *  HONESTY LIMIT and matchFinalize.pg.test.ts for the real-PostgreSQL proof. */
	private finalizeMatchRpc(args: Record<string, any>): { data: any; error: DbError | null } {
		const sid = args.p_session_id;
		const results = this.rowsFor('match_results');
		const players = this.rowsFor('match_result_players');
		const ratings = this.rowsFor('player_ratings');
		const events = this.rowsFor('player_rating_events');
		const playerList: Row[] = Array.isArray(args.p_players) ? args.p_players : [];
		const ratingList: Row[] = Array.isArray(args.p_ratings) ? args.p_ratings : [];

		const insertMissingPlayers = () => {
			for (const p of playerList) {
				const exists = players.some(
					(row) => row.session_id === sid && row.seat_color === p.seat_color
				);
				if (!exists) {
					players.push(
						jsonbNormalize({ ...this.defaultsFor('match_result_players'), ...p, session_id: sid })
					);
				}
			}
		};

		// 1. Anchor exists ⇒ already finalized: repair missing player rows only.
		if (results.some((row) => row.session_id === sid)) {
			insertMissingPlayers();
			return { data: { outcome: 'already_finalized' }, error: null };
		}

		// 2. Ratings: legacy markers, then base verification, then apply.
		let apply = ratingList.length > 0;
		let rated = false;
		if (apply && events.some((row) => row.session_id === sid)) {
			apply = false;
			rated = true;
		}
		if (apply) {
			for (const r of ratingList) {
				const row = ratings.find((x) => x.user_id === r.user_id);
				if (row && row.last_session_id === sid) {
					apply = false;
					rated = true;
					break;
				}
			}
		}
		if (apply) {
			for (const r of ratingList) {
				const row = ratings.find((x) => x.user_id === r.user_id) ?? null;
				const stale =
					r.expected_games == null
						? row != null
						: row == null ||
							row.games_played !== r.expected_games ||
							Math.abs(row.mu - r.expected_mu) > 1e-4 ||
							Math.abs(row.sigma - r.expected_sigma) > 1e-4;
				if (stale) {
					// Raised BEFORE any write ⇒ the whole "transaction" is a no-op.
					return {
						data: null,
						error: {
							code: 'P0001',
							message: `finalize_match: stale_ratings (user ${r.user_id} changed since the caller computed updates)`
						}
					};
				}
			}
			const now = new Date().toISOString();
			for (const r of ratingList) {
				events.push(
					jsonbNormalize({
						...this.defaultsFor('player_rating_events'),
						session_id: sid,
						user_id: r.user_id,
						placement: r.placement,
						mu_before: r.mu_before,
						sigma_before: r.sigma_before,
						mu_after: r.mu_after,
						sigma_after: r.sigma_after,
						rating_version: r.rating_version ?? 1
					})
				);
				const next = {
					user_id: r.user_id,
					display_name: r.display_name ?? null,
					mu: r.mu_after,
					sigma: r.sigma_after,
					games_played: (r.expected_games ?? 0) + 1,
					last_session_id: sid,
					last_game_at: r.last_game_at ?? null,
					rating_version: r.rating_version ?? 1,
					updated_at: now
				};
				const existing = ratings.find((x) => x.user_id === r.user_id);
				if (existing) Object.assign(existing, jsonbNormalize(next));
				else ratings.push(jsonbNormalize({ ...this.defaultsFor('player_ratings'), ...next }));
			}
			rated = true;
		}

		// 3. Anchor + player rows (same "transaction").
		results.push(
			jsonbNormalize({
				...this.defaultsFor('match_results'),
				...(args.p_result ?? {}),
				session_id: sid,
				rated
			})
		);
		insertMissingPlayers();
		return { data: { outcome: 'finalized', rated }, error: null };
	}

	// ── convenience for tests / RoomHost deps ─────────────────────────────────────

	seedSession(row: Row): Row {
		const stored = jsonbNormalize({
			started_at: null,
			ended_at: null,
			mode: 'casual',
			game_id: null,
			scenario: null,
			...this.defaultsFor('play_game_sessions'),
			...row
		});
		this.rowsFor('play_game_sessions').push(stored);
		return stored;
	}

	seedMember(row: Row): Row {
		const stored = jsonbNormalize({
			user_id: null,
			is_bot: false,
			bot_profile: null,
			seat_color: null,
			selected_guardian: null,
			role: 'player',
			last_seen_at: new Date().toISOString(),
			...this.defaultsFor('play_session_members'),
			...row
		});
		this.rowsFor('play_session_members').push(stored);
		return stored;
	}

	getSession(roomCode: string): Row | null {
		return (
			this.rowsFor('play_game_sessions').find((row) => row.room_code === roomCode.toUpperCase()) ??
			null
		);
	}
}
