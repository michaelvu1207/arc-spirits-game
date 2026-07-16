/**
 * Identity-trust migration (20260710_identity_trust.sql) — REAL POSTGRESQL
 * privilege/portability acceptance for the WS ticket boundary.
 *
 * The FakePlayDb cannot express GRANT/REVOKE/RLS or ALTER DEFAULT PRIVILEGES, so
 * the claims this suite exists for are proven against a throwaway local cluster
 * (initdb + pg_ctl on a unix socket — self-skips when the binaries are missing):
 *
 *   1. RESTRICTIVE default privileges (stock PostgreSQL): the migration's explicit
 *      grants + RLS policy leave service_role FULLY able to mint/consume, while
 *      anon/authenticated can neither read, insert, update, delete, nor execute the
 *      consume function. (Pre-fix defect: nothing granted service_role anything.)
 *   2. PERMISSIVE default privileges (ALTER DEFAULT PRIVILEGES … GRANT ALL TO
 *      PUBLIC before the table exists): the migration's revokes + RLS still deny
 *      anon an INSERT of a CHOSEN digest bound to a victim identity — the forgeable
 *      direct path around the authenticated mint endpoint. (Pre-fix defect: the
 *      inherited PUBLIC grant let that insert through.)
 *   3. PARTIAL PRE-EXISTING TABLE: a hand-created play_ws_tickets missing
 *      session_id/user_id/digest (the pre-fix migration only guarded the auxiliary
 *      columns) is healed: binding columns added, unbindable rows deleted, NOT NULL
 *      + role CHECK + digest unique index enforced, and the boundary works after.
 *      A partial table holding DUPLICATE DIGESTS (which used to fail the unique
 *      index build) is healed too: every ambiguous row is deleted, apply-twice clean.
 *   4. EXPIRY IS DB-CLOCK AUTHORITATIVE: an expired digest cannot be claimed no
 *      matter what the application clock says — the consume function takes no time
 *      parameter (the old backdatable two-arg signature is DROPPED), and the TS
 *      boundary redeems through it, so even a process whose Date is backdated to
 *      before the expiry cannot resurrect the ticket. (Pre-fix defect: the TS
 *      conditional UPDATE compared expires_at against the caller's own clock, and
 *      the SQL function accepted a caller-supplied p_now.)
 *   5. REPLAY: one winner per digest — sequentially and under concurrency.
 *   6. BINDING round-trip: the consumed row returns exactly the minted
 *      (session, user, member, role) binding for the boundary to verify.
 *   7. APPLY TWICE: the whole migration is idempotent (each phase re-applies it).
 *   8. MINT IS DB-CLOCK AUTHORITATIVE: the TS boundary mints exclusively through
 *      `mint_ws_ticket` (digest + bindings in, stored row out) — created_at and
 *      expires_at are fixed by the DATABASE's now() with a 30-second lifetime
 *      baked into the SQL body. A process running an hour FAST cannot mint an
 *      hour-long ticket; a process an hour SLOW cannot mint one dead on arrival;
 *      no signature accepting a caller time/TTL exists. (Pre-fix defect: the TS
 *      mint INSERTed created_at/expires_at computed from the app clock.)
 *   9. SWEEP IS DB-CLOCK GOVERNED: `cleanup_ws_tickets()` deletes only rows the
 *      database itself considers long dead — a fast application clock can no
 *      longer delete a ticket that is valid by database time. (Pre-fix defect:
 *      the TS sweep DELETEd below an app-clock cutoff.)
 *  10. MISSING FUNCTIONS FAIL CLOSED: with `mint_ws_ticket` dropped, the TS
 *      boundary refuses to mint (no application-timed INSERT fallback) and the
 *      table stays untouched; re-applying the migration restores service.
 *  11. LEGACY SURVIVAL: a REAL pre-existing legacy two-argument
 *      consume_ws_ticket(text, timestamptz) (and a wrong-shape legacy mint) are
 *      dropped by pg_proc enumeration on first application — the migration
 *      applies, re-applies, and leaves exactly the canonical signatures, without
 *      CASCADE-destroying unrelated objects.
 *  12. ROLLING UPGRADE: during a migration-first rolling deployment a LEGACY
 *      application instance keeps running the pre-fix code — a direct
 *      service_role INSERT carrying app-clock created/expires values, a direct
 *      app-clock conditional consume UPDATE, and a direct app-clock cleanup
 *      DELETE. The table's lifecycle triggers must make every one of those
 *      harmless WITHOUT breaking the legacy instance outright: the direct mint
 *      lands but is clamped to the DB-clock 30-second lifetime (no stretched, no
 *      dead-on-arrival ticket), bindings/expiry are immutable under UPDATE,
 *      consumption is one-way and can never claim a DB-expired digest, and the
 *      fast-clock sweep deletes nothing the database still honors. These suites
 *      replay the EXACT legacy DML shapes as service_role.
 *  13. FULL TABLE HEALING: a partial pre-existing table with nullable
 *      role/expires_at/created_at, NULL legacy rows, a stretched expiry and a
 *      divergent same-named role CHECK converges — apply twice — on the canonical
 *      declared schema: NOT NULL + defaults (role 'spectator', created_at now(),
 *      expires_at NO default), null-expiry rows GONE (they would otherwise evade
 *      consume and cleanup forever), stretched expiries clamped, canonical CHECK.
 *  14. WALL-CLOCK EXPIRY (now() is TRANSACTION-START time): a consume transaction
 *      that begins before expiry and blocks on the row lock until after wall
 *      expiry must claim NOTHING — under a now()-based predicate/trigger it
 *      consumed successfully and returned a row already past wall expiry. Both
 *      the consume function and the legacy direct-DML consume shape are replayed
 *      across a held lock; the stale-transaction (no lock, pg_sleep) variant and
 *      the mint path (full lifetime anchored at the wall instant, not txn start)
 *      are proven too. Every lifecycle decision reads clock_timestamp().
 *  15. RANKED ⇒ PRIVATE AT THE TABLE: a rolling LEGACY writer that predates the
 *      visibility column INSERTs ranked rows without it — the column default
 *      ('public') must never win. The trigger coerces ranked rows private on
 *      INSERT and UPDATE for every writer, while casual rooms keep the public
 *      default and explicit casual visibility choices are honored.
 *  16. ROGUE ACL/POLICY CONVERGENCE: a pre-existing table carrying grants to a
 *      forgotten legacy role (table- and column-level), a PUBLIC free-for-all
 *      policy, and a squatter on the canonical policy NAME admitting anon is
 *      converged — apply twice — to the declared service-role-only posture:
 *      every non-owner grant stripped, exactly the canonical policy remains,
 *      and the service-role rolling-upgrade DML path still works.
 *  17. DIGEST UNIQUENESS BY SEMANTICS: a same-named play_ws_tickets_digest_key
 *      that is NOT the canonical unique-on-(digest) index (a plain index over id,
 *      or a unique CONSTRAINT over id) used to satisfy `create unique index if
 *      not exists` by NAME — duplicate digests were accepted. The healer now
 *      inspects pg_index and rebuilds canonically; duplicates are rejected after,
 *      apply-twice clean.
 *  18. ROGUE TABLE OWNER CONVERGENCE: a hostile/divergent partial table OWNED by
 *      a forgotten legacy role used to keep every owner power through the
 *      ACL/policy convergence (which deliberately skips "the owner"): it
 *      bypassed non-FORCE RLS to insert victim-bound tickets, and could ALTER
 *      TABLE … DISABLE TRIGGER to switch the lifecycle enforcement off — even
 *      after apply-twice. The migration now converges OWNERSHIP to the
 *      migration principal first, sets FORCE ROW LEVEL SECURITY, and converges
 *      the lifecycle/visibility trigger-function ownership (CREATE OR REPLACE
 *      preserves a squatter's ownership, and a function owner can rewrite the
 *      body). The displaced owner can no longer insert, alter the table,
 *      disable triggers, or replace the trigger functions; the service-role
 *      rolling-upgrade direct-DML path stays intact and trigger-governed;
 *      clean install and apply-twice converge.
 *  19. INVALID UNIQUE INDEX HEALING: the debris of a failed CREATE UNIQUE INDEX
 *      CONCURRENTLY — a canonical-named index that is unique in the catalog but
 *      INVALID (indisvalid false: enforcing NOTHING) — used to pass the
 *      semantic check (which read only the definition, not the validity
 *      flags), so duplicate digests kept being accepted. The healer now
 *      requires indisvalid/indisready/indislive and rebuilds the unusable
 *      variant; duplicates are purged and rejected after, apply-twice clean.
 */
import { describe, expect, test, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
	consumeWsTicket,
	createWsTicket,
	digestWsTicket,
	mintWsTicketValue,
	sweepWsTickets
} from './wsTickets';
import type { PlayDbClient } from './commit';

const MIGRATION_PATH = fileURLToPath(
	new URL('../../../../supabase/migrations/20260710_identity_trust.sql', import.meta.url)
);

function havePgBinaries(): boolean {
	return ['initdb', 'pg_ctl'].every(
		(bin) => spawnSync('which', [bin], { encoding: 'utf8' }).status === 0
	);
}
const HAVE_PG = havePgBinaries();

// ── throwaway cluster ───────────────────────────────────────────────────────────

let dataDir = '';
let pool: pg.Pool;

// stdio MUST be 'ignore': pg_ctl daemonizes postgres, which would inherit and hold
// open spawnSync's stdio pipes and take the whole test runner down with it.
function run(cmd: string, args: string[]): void {
	const res = spawnSync(cmd, args, { stdio: 'ignore' });
	if (res.status !== 0) {
		let log = '';
		try {
			log = readFileSync(join(dataDir, 'server.log'), 'utf8').slice(-2000);
		} catch {
			// no log yet
		}
		throw new Error(`${cmd} ${args.join(' ')} failed (status ${res.status})\n${log}`);
	}
}

const SCHEMA = 'arc_spirits_2d';
const MIGRATION = () => readFileSync(MIGRATION_PATH, 'utf8');

async function bootCluster(): Promise<void> {
	dataDir = mkdtempSync(join(tmpdir(), 'arc-idtrust-pg-'));
	run('initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres']);
	run('pg_ctl', [
		'-D',
		dataDir,
		'-l',
		join(dataDir, 'server.log'),
		'-o',
		`-c listen_addresses='' -k ${dataDir}`,
		'-w',
		'start'
	]);
	pool = new pg.Pool({ host: dataDir, user: 'postgres', database: 'postgres', max: 8 });

	// The environment the migration expects: the Supabase-style grantee roles
	// (deliberately WITHOUT bypassrls, so the suite proves the strictest posture:
	// the explicit policy — not a role attribute — is what admits service_role),
	// the play schema, and the two pre-existing tables the migration touches.
	await pool.query(`
		do $$ begin
			if not exists (select 1 from pg_roles where rolname = 'service_role') then
				create role service_role nologin;
			end if;
			if not exists (select 1 from pg_roles where rolname = 'anon') then
				create role anon nologin;
			end if;
			if not exists (select 1 from pg_roles where rolname = 'authenticated') then
				create role authenticated nologin;
			end if;
		end $$;
		create schema if not exists ${SCHEMA};
		create table if not exists ${SCHEMA}.play_game_sessions (
			id uuid primary key default gen_random_uuid(),
			room_code text not null,
			status text not null default 'lobby',
			mode text not null default 'casual',
			revision integer not null default 0,
			public_state jsonb,
			ended_at timestamptz,
			created_at timestamptz not null default now()
		);
		create table if not exists ${SCHEMA}.play_session_members (
			id uuid primary key default gen_random_uuid(),
			session_id uuid not null,
			user_id uuid,
			display_name text,
			role text not null default 'spectator',
			is_bot boolean not null default false,
			joined_at timestamptz not null default now(),
			last_seen_at timestamptz
		);
	`);
}

beforeAll(async () => {
	if (!HAVE_PG) return;
	await bootCluster();
}, 120_000);

afterAll(async () => {
	if (!dataDir) return;
	await pool?.end().catch(() => {});
	spawnSync('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
	rmSync(dataDir, { recursive: true, force: true });
});

/** Run statements AS a Supabase grantee role on a pinned connection (SET ROLE drops
 *  superuser privileges until RESET ROLE), returning rows or the thrown error. */
async function asRole(
	role: 'service_role' | 'anon' | 'authenticated' | 'legacy_client' | 'legacy_owner',
	sql: string,
	params: unknown[] = []
): Promise<{ rows: Record<string, unknown>[]; error: Error | null }> {
	const client = await pool.connect();
	try {
		await client.query(`set role ${role}`);
		const res = await client.query(sql, params);
		return { rows: res.rows, error: null };
	} catch (err) {
		return { rows: [], error: err as Error };
	} finally {
		// A failed statement poisons the session — recycle rather than reuse.
		await client.query('reset role').catch(() => {});
		client.release();
	}
}

/** Honest node-postgres adapter for the wsTickets PlayDbClient surface (insert /
 *  filtered update+select / filtered select / filtered delete), executed AS
 *  service_role so the TS boundary is exercised under the migration's grants. */
function serviceRoleAdapter(): PlayDbClient {
	// PostgREST delivers JSON: timestamptz values arrive as ISO STRINGS, never JS
	// Dates. node-postgres parses them to Dates, so re-serialize to the wire shape
	// the TS boundary actually sees in production.
	function wireShape(rows: Record<string, unknown>[]): Record<string, unknown>[] {
		return rows.map((row) =>
			Object.fromEntries(
				Object.entries(row).map(([key, value]) => [
					key,
					value instanceof Date ? value.toISOString() : value
				])
			)
		);
	}
	function exec(sql: string, params: unknown[]) {
		return asRole('service_role', sql, params).then(({ rows, error }) => ({
			data: wireShape(rows),
			error: error ? { message: error.message } : null
		}));
	}
	return {
		from(table: string) {
			const filters: { sql: string; value: unknown }[] = [];
			let mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
			let columns = '*';
			let payload: Record<string, unknown> = {};
			let limitCount: number | null = null;
			let wantRows = false;
			const where = () =>
				filters.length
					? ' where ' + filters.map((f, i) => f.sql.replace('?', `$${i + 1}`)).join(' and ')
					: '';
			const builder: Record<string, unknown> = {
				select(cols = '*') {
					if (mode === 'select') columns = cols;
					wantRows = true;
					return builder;
				},
				insert(row: Record<string, unknown>) {
					mode = 'insert';
					payload = row;
					return builder;
				},
				update(vals: Record<string, unknown>) {
					mode = 'update';
					payload = vals;
					return builder;
				},
				delete() {
					mode = 'delete';
					return builder;
				},
				eq(key: string, value: unknown) {
					filters.push({ sql: `${key} = ?`, value });
					return builder;
				},
				is(key: string, value: null) {
					if (value === null) filters.push({ sql: `${key} is null`, value: undefined });
					return builder;
				},
				gt(key: string, value: unknown) {
					filters.push({ sql: `${key} > ?`, value });
					return builder;
				},
				lt(key: string, value: unknown) {
					filters.push({ sql: `${key} < ?`, value });
					return builder;
				},
				limit(count: number) {
					limitCount = count;
					return builder;
				},
				then(onfulfilled: (v: unknown) => unknown, onrejected?: (e: unknown) => unknown) {
					const bound = filters.filter((f) => f.value !== undefined);
					const rebind = () => {
						let i = 0;
						return filters
							.map((f) =>
								f.value === undefined ? ` and ${f.sql}` : ` and ${f.sql.replace('?', `$${++i}`)}`
							)
							.join('')
							.replace(/^ and /, ' where ');
					};
					let sql = '';
					let params: unknown[] = [];
					if (mode === 'insert') {
						const keys = Object.keys(payload);
						sql =
							`insert into ${SCHEMA}.${table} (${keys.join(', ')}) values ` +
							`(${keys.map((_, i) => `$${i + 1}`).join(', ')})` +
							(wantRows ? ' returning *' : '');
						params = keys.map((k) => payload[k]);
					} else if (mode === 'update') {
						const keys = Object.keys(payload);
						const set = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
						let p = keys.length;
						const cond = filters
							.map((f) => (f.value === undefined ? f.sql : f.sql.replace('?', `$${++p}`)))
							.join(' and ');
						sql =
							`update ${SCHEMA}.${table} set ${set}` +
							(cond ? ` where ${cond}` : '') +
							(wantRows ? ' returning *' : '');
						params = [...keys.map((k) => payload[k]), ...bound.map((f) => f.value)];
					} else if (mode === 'delete') {
						sql = `delete from ${SCHEMA}.${table}${rebind()}`;
						params = bound.map((f) => f.value);
					} else {
						sql =
							`select ${columns} from ${SCHEMA}.${table}${rebind()}` +
							(limitCount != null ? ` limit ${limitCount}` : '');
						params = bound.map((f) => f.value);
					}
					return exec(sql, params).then(onfulfilled, onrejected);
				}
			};
			return builder as ReturnType<PlayDbClient['from']>;
		},
		rpc(fn: string, args: Record<string, unknown>) {
			// The REAL lifecycle paths: the TS boundary mints exclusively through the
			// store's mint_ws_ticket function, consumes exclusively through
			// consume_ws_ticket(digest), and sweeps through cleanup_ws_tickets() —
			// all executed AS service_role, no timestamp or TTL ever supplied.
			if (fn === 'mint_ws_ticket') {
				return exec(`select * from ${SCHEMA}.mint_ws_ticket($1, $2, $3, $4, $5)`, [
					args.p_session_id,
					args.p_user_id,
					args.p_member_id,
					args.p_role,
					args.p_digest
				]);
			}
			if (fn === 'consume_ws_ticket') {
				return exec(`select * from ${SCHEMA}.consume_ws_ticket($1)`, [args.p_digest]);
			}
			if (fn === 'cleanup_ws_tickets') {
				return exec(`select ${SCHEMA}.cleanup_ws_tickets()`, []);
			}
			return Promise.resolve({
				data: null,
				error: { code: 'PGRST202', message: `rpc ${fn} not modeled here` }
			});
		}
	} as unknown as PlayDbClient;
}

/** Force specific clock values onto a ticket row for FIXTURE purposes only. The
 *  lifecycle triggers deliberately make this impossible for ANY normal writer
 *  (that's the invariant under test), so fixtures use the superuser with
 *  session_replication_role=replica — which disables user triggers for that one
 *  pinned connection — to fabricate expired/long-dead rows. */
async function backdateTicket(digest: string, fields: Record<string, string>): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query(`set session_replication_role = replica`);
		const keys = Object.keys(fields);
		await client.query(
			`update ${SCHEMA}.play_ws_tickets set ${keys
				.map((k, i) => `${k} = $${i + 1}`)
				.join(', ')} where digest = $${keys.length + 1}`,
			[...keys.map((k) => fields[k]), digest]
		);
	} finally {
		await client.query(`set session_replication_role = origin`).catch(() => {});
		client.release();
	}
}

async function insertTicketAsService(overrides: Partial<Record<string, unknown>> = {}) {
	const raw = mintWsTicketValue();
	const row = {
		session_id: randomUUID(),
		user_id: randomUUID(),
		member_id: randomUUID(),
		role: 'member',
		digest: digestWsTicket(raw),
		// The legacy direct-mint shape: an app-computed expiry rides the INSERT. The
		// lifecycle trigger overwrites it with the DB clock; overrides that need a
		// specific stored clock are applied afterwards via the fixture backdoor.
		expires_at: new Date(Date.now() + 30_000).toISOString(),
		...overrides
	};
	const { error } = await asRole(
		'service_role',
		`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, member_id, role, digest, expires_at)
		 values ($1, $2, $3, $4, $5, $6)`,
		[row.session_id, row.user_id, row.member_id, row.role, row.digest, row.expires_at]
	);
	expect(error, `service_role mint failed: ${error?.message}`).toBeNull();
	const clockOverrides: Record<string, string> = {};
	for (const key of ['expires_at', 'created_at', 'consumed_at'] as const) {
		if (key in overrides && typeof overrides[key] === 'string') {
			clockOverrides[key] = overrides[key] as string;
		}
	}
	if (Object.keys(clockOverrides).length > 0) {
		await backdateTicket(row.digest as string, clockOverrides);
	}
	return { raw, ...row };
}

describe.skipIf(!HAVE_PG)('identity-trust WS ticket boundary against real PostgreSQL', () => {
	test('RESTRICTIVE defaults: apply twice; service_role fully usable, anon/authenticated denied everywhere', async () => {
		// Stock PostgreSQL default privileges: nothing is granted to anyone. The
		// pre-fix migration left service_role stranded here.
		await pool.query(MIGRATION());
		await pool.query(MIGRATION()); // idempotency: clean re-apply

		// service_role: mint (via the mint function AND direct INSERT for fixtures),
		// read back (SELECT), consume (UPDATE via the hardened function), sweep
		// (DELETE + the cleanup function) — the full boundary surface.
		const viaMintFn = await asRole(
			'service_role',
			`select * from ${SCHEMA}.mint_ws_ticket($1, $2, $3, 'member', $4)`,
			[randomUUID(), randomUUID(), randomUUID(), digestWsTicket(mintWsTicketValue())]
		);
		expect(viaMintFn.error).toBeNull();
		expect(viaMintFn.rows).toHaveLength(1);
		const cleanupFn = await asRole('service_role', `select ${SCHEMA}.cleanup_ws_tickets()`);
		expect(cleanupFn.error).toBeNull();
		const minted = await insertTicketAsService();
		const read = await asRole(
			'service_role',
			`select digest from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[minted.digest]
		);
		expect(read.error).toBeNull();
		expect(read.rows).toHaveLength(1);
		const consumed = await asRole('service_role', `select * from ${SCHEMA}.consume_ws_ticket($1)`, [
			minted.digest
		]);
		expect(consumed.error).toBeNull();
		expect(consumed.rows).toHaveLength(1);
		expect(consumed.rows[0].session_id).toBe(minted.session_id);
		// service_role DELETE is granted (no permission error) but the lifecycle
		// trigger silently keeps any row that is not long dead by DATABASE time —
		// the sweep verb works, the fresh row survives.
		const swept = await asRole(
			'service_role',
			`delete from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[minted.digest]
		);
		expect(swept.error).toBeNull();
		const survivor = await asRole(
			'service_role',
			`select digest from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[minted.digest]
		);
		expect(survivor.rows).toHaveLength(1);

		// anon / authenticated: every verb is refused (no grant + RLS).
		for (const role of ['anon', 'authenticated'] as const) {
			const sel = await asRole(role, `select * from ${SCHEMA}.play_ws_tickets`);
			expect(sel.error?.message ?? '').toMatch(/permission denied/);
			const ins = await asRole(
				role,
				`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at)
				 values ($1, $2, 'member', $3, now() + interval '1 minute')`,
				[randomUUID(), randomUUID(), digestWsTicket(mintWsTicketValue())]
			);
			expect(ins.error?.message ?? '').toMatch(/permission denied/);
			const upd = await asRole(role, `update ${SCHEMA}.play_ws_tickets set consumed_at = now()`);
			expect(upd.error?.message ?? '').toMatch(/permission denied/);
			const del = await asRole(role, `delete from ${SCHEMA}.play_ws_tickets`);
			expect(del.error?.message ?? '').toMatch(/permission denied/);
			const fn = await asRole(role, `select * from ${SCHEMA}.consume_ws_ticket('x')`);
			expect(fn.error?.message ?? '').toMatch(/permission denied/);
			const mintFn = await asRole(
				role,
				`select * from ${SCHEMA}.mint_ws_ticket($1, $2, $3, 'member', 'x')`,
				[randomUUID(), randomUUID(), randomUUID()]
			);
			expect(mintFn.error?.message ?? '').toMatch(/permission denied/);
			const cleanFn = await asRole(role, `select ${SCHEMA}.cleanup_ws_tickets()`);
			expect(cleanFn.error?.message ?? '').toMatch(/permission denied/);
		}
	});

	test('PERMISSIVE defaults: anon cannot insert a chosen digest bound to a victim (the forgeable direct path)', async () => {
		// Recreate the table under GRANT-ALL-TO-PUBLIC default privileges — the store
		// posture where the real probe forged a victim-bound ticket pre-fix.
		await pool.query(`
			drop table if exists ${SCHEMA}.play_ws_tickets cascade;
			grant usage on schema ${SCHEMA} to public;
			alter default privileges for role postgres in schema ${SCHEMA} grant all on tables to public;
			alter default privileges for role postgres in schema ${SCHEMA} grant execute on functions to public;
		`);
		await pool.query(MIGRATION());
		await pool.query(MIGRATION()); // idempotent under this posture too

		const victimUser = randomUUID();
		const victimSession = randomUUID();
		const chosenRaw = mintWsTicketValue();
		for (const role of ['anon', 'authenticated'] as const) {
			const forge = await asRole(
				role,
				`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at)
				 values ($1, $2, 'member', $3, now() + interval '1 hour')`,
				[victimSession, victimUser, digestWsTicket(chosenRaw)]
			);
			expect(forge.error?.message ?? '').toMatch(/permission denied|row-level security/);
			const read = await asRole(role, `select * from ${SCHEMA}.play_ws_tickets`);
			expect(read.error?.message ?? '').toMatch(/permission denied/);
			const fn = await asRole(role, `select * from ${SCHEMA}.consume_ws_ticket('x')`);
			expect(fn.error?.message ?? '').toMatch(/permission denied/);
			// The mint function is no forge path either: inherited EXECUTE-to-PUBLIC
			// default privileges are revoked, so a chosen digest cannot land through it.
			const mintFn = await asRole(
				role,
				`select * from ${SCHEMA}.mint_ws_ticket($1, $2, null, 'member', $3)`,
				[victimSession, victimUser, digestWsTicket(chosenRaw)]
			);
			expect(mintFn.error?.message ?? '').toMatch(/permission denied/);
		}
		// The chosen digest never landed: nothing for the room server to consume.
		const gone = await asRole(
			'service_role',
			`select * from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[digestWsTicket(chosenRaw)]
		);
		expect(gone.error).toBeNull();
		expect(gone.rows).toHaveLength(0);
		// …while service_role remains fully functional under permissive defaults.
		const minted = await insertTicketAsService();
		const consumed = await asRole('service_role', `select * from ${SCHEMA}.consume_ws_ticket($1)`, [
			minted.digest
		]);
		expect(consumed.rows).toHaveLength(1);

		// Reset the default privileges so later phases run under stock posture again.
		await pool.query(`
			alter default privileges for role postgres in schema ${SCHEMA} revoke all on tables from public;
			alter default privileges for role postgres in schema ${SCHEMA} revoke execute on functions from public;
			revoke usage on schema ${SCHEMA} from public;
		`);
	});

	test('PARTIAL pre-existing table: binding columns healed, unbindable rows deleted, constraints + boundary work after', async () => {
		// The exact pre-fix gap: a hand-created partial table WITHOUT session_id /
		// user_id / digest (only auxiliary columns were guarded), holding a stale row.
		await pool.query(`
			drop table if exists ${SCHEMA}.play_ws_tickets cascade;
			create table ${SCHEMA}.play_ws_tickets (
				id uuid primary key default gen_random_uuid(),
				member_id uuid,
				expires_at timestamptz
			);
			insert into ${SCHEMA}.play_ws_tickets (member_id, expires_at) values (gen_random_uuid(), now());
		`);
		await pool.query(MIGRATION());
		await pool.query(MIGRATION()); // and re-apply stays clean

		// Full shape, NOT NULL bindings, role CHECK, digest unique index.
		const cols = await pool.query(
			`select column_name, is_nullable from information_schema.columns
			 where table_schema = $1 and table_name = 'play_ws_tickets'`,
			[SCHEMA]
		);
		const byName = new Map(cols.rows.map((r) => [r.column_name, r.is_nullable]));
		for (const required of ['session_id', 'user_id', 'digest']) {
			expect(byName.get(required), `${required} missing`).toBe('NO');
		}
		const junk = await pool.query(`select count(*)::int as n from ${SCHEMA}.play_ws_tickets`);
		expect(junk.rows[0].n).toBe(0); // the unbindable row is gone, not honored
		const idx = await pool.query(
			`select indexname from pg_indexes where schemaname = $1 and tablename = 'play_ws_tickets'`,
			[SCHEMA]
		);
		expect(idx.rows.map((r) => r.indexname)).toContain('play_ws_tickets_digest_key');
		const badRole = await asRole(
			'service_role',
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at)
			 values ($1, $2, 'superadmin', $3, now())`,
			[randomUUID(), randomUUID(), digestWsTicket(mintWsTicketValue())]
		);
		expect(badRole.error?.message ?? '').toMatch(/check constraint|violates/);

		// The healed table serves the real TS boundary end-to-end.
		const db = serviceRoleAdapter();
		const { ticket } = await createWsTicket(db, {
			sessionId: randomUUID(),
			userId: randomUUID(),
			memberId: randomUUID(),
			role: 'member'
		});
		const consumed = await consumeWsTicket(db, ticket);
		expect(consumed.ok).toBe(true);
	});

	test('EXPIRY is enforced in SQL: an expired digest cannot be claimed by the function, and the TS boundary reports it', async () => {
		const expired = await insertTicketAsService({
			expires_at: new Date(Date.now() - 1000).toISOString()
		});
		// The hardened SQL function refuses it…
		const viaFn = await asRole('service_role', `select * from ${SCHEMA}.consume_ws_ticket($1)`, [
			expired.digest
		]);
		expect(viaFn.error).toBeNull();
		expect(viaFn.rows).toHaveLength(0);
		// …and the TS boundary (which redeems through that same function) reports it.
		const viaTs = await consumeWsTicket(serviceRoleAdapter(), expired.raw);
		expect(viaTs.ok).toBe(false);
		if (!viaTs.ok) expect(viaTs.reason).toBe('expired');
	});

	test('BACKDATED APPLICATION CLOCK: an expired ticket stays dead — DB time governs, and the backdatable SQL signature is gone', async () => {
		// A ticket that expired 1s ago by REAL (database) time. An application clock
		// running 2 minutes behind still believes it is valid.
		const expired = await insertTicketAsService({
			expires_at: new Date(Date.now() - 1000).toISOString()
		});
		const backdatedMs = Date.now() - 120_000;

		// 1. The old attack surface is structurally gone: no function overload accepts
		//    a caller-supplied timestamp anymore.
		const viaBackdatedFn = await asRole(
			'service_role',
			`select * from ${SCHEMA}.consume_ws_ticket($1, $2::timestamptz)`,
			[expired.digest, new Date(backdatedMs).toISOString()]
		);
		expect(viaBackdatedFn.error?.message ?? '').toMatch(/does not exist/);

		// 2. The TS boundary under a genuinely backdated process clock: freeze Date at
		//    two minutes ago (timers stay real — only the clock the pre-fix conditional
		//    UPDATE trusted is skewed) and redeem. The DB clock still refuses it. Under
		//    the pre-fix code this consumed the ticket (`expires_at > <backdated now>`).
		vi.useFakeTimers({ toFake: ['Date'], now: backdatedMs });
		try {
			expect(Date.now()).toBeLessThan(Date.parse(expired.expires_at as string));
			const viaTs = await consumeWsTicket(serviceRoleAdapter(), expired.raw);
			expect(viaTs.ok).toBe(false);
			if (!viaTs.ok) expect(viaTs.reason).toBe('expired');
		} finally {
			vi.useRealTimers();
		}

		// 3. The row is still there and still unconsumed — nothing claimed it.
		const after = await asRole(
			'service_role',
			`select consumed_at from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[expired.digest]
		);
		expect(after.rows).toHaveLength(1);
		expect(after.rows[0].consumed_at).toBeNull();

		// 4. Control: the same backdated process CAN still redeem a genuinely valid
		//    ticket — the fix removes the app clock from the decision, not the path.
		vi.useFakeTimers({ toFake: ['Date'], now: backdatedMs });
		try {
			const db = serviceRoleAdapter();
			const valid = await insertTicketAsService({
				expires_at: new Date(backdatedMs + 150_000).toISOString() // +30s real time
			});
			const consumed = await consumeWsTicket(db, valid.raw);
			expect(consumed.ok).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	test('DUPLICATE DIGESTS in a partial pre-existing table are healed (ambiguous rows deleted), apply-twice clean', async () => {
		// A valid-LOOKING partial table: full binding columns, but the same digest on
		// two rows bound to DIFFERENT identities — honoring either could authenticate
		// the wrong principal, and building the unique index used to fail outright.
		const dupDigest = digestWsTicket(mintWsTicketValue());
		const keeper = await (async () => {
			const raw = mintWsTicketValue();
			return { raw, digest: digestWsTicket(raw) };
		})();
		await pool.query(`
			drop table if exists ${SCHEMA}.play_ws_tickets cascade;
			create table ${SCHEMA}.play_ws_tickets (
				id uuid primary key default gen_random_uuid(),
				session_id uuid,
				user_id uuid,
				member_id uuid,
				role text default 'spectator',
				digest text,
				expires_at timestamptz,
				consumed_at timestamptz,
				created_at timestamptz default now()
			);
		`);
		await pool.query(
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at) values
			 ($1, $2, 'member', $5, now() + interval '1 hour'),
			 ($3, $4, 'member', $5, now() + interval '1 hour'),
			 ($1, $2, 'member', $6, now() + interval '1 hour')`,
			[randomUUID(), randomUUID(), randomUUID(), randomUUID(), dupDigest, keeper.digest]
		);

		// The migration must APPLY (the pre-fix version died creating the unique
		// index), and re-apply cleanly.
		await pool.query(MIGRATION());
		await pool.query(MIGRATION());

		// Every row of the ambiguous digest is gone; the unambiguous row survives.
		const dup = await pool.query(
			`select count(*)::int as n from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[dupDigest]
		);
		expect(dup.rows[0].n).toBe(0);
		const kept = await pool.query(
			`select count(*)::int as n from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[keeper.digest]
		);
		expect(kept.rows[0].n).toBe(1);
		const idx = await pool.query(
			`select indexname from pg_indexes where schemaname = $1 and tablename = 'play_ws_tickets'`,
			[SCHEMA]
		);
		expect(idx.rows.map((r) => r.indexname)).toContain('play_ws_tickets_digest_key');

		// The healed store serves the boundary end-to-end (mint → consume → replay dead).
		const db = serviceRoleAdapter();
		const { ticket } = await createWsTicket(db, {
			sessionId: randomUUID(),
			userId: randomUUID(),
			memberId: null,
			role: 'spectator'
		});
		const consumed = await consumeWsTicket(db, ticket);
		expect(consumed.ok).toBe(true);
		const replay = await consumeWsTicket(db, ticket);
		expect(replay.ok).toBe(false);
	});

	test('REPLAY: exactly one winner per digest, sequentially and under concurrency', async () => {
		const db = serviceRoleAdapter();
		const sessionId = randomUUID();
		const userId = randomUUID();
		const { ticket } = await createWsTicket(db, {
			sessionId,
			userId,
			memberId: null,
			role: 'spectator'
		});
		const first = await consumeWsTicket(db, ticket);
		expect(first.ok).toBe(true);
		const replay = await consumeWsTicket(db, ticket);
		expect(replay.ok).toBe(false);
		if (!replay.ok) expect(replay.reason).toBe('not_found_or_replayed');

		const { ticket: contested } = await createWsTicket(db, {
			sessionId,
			userId,
			memberId: null,
			role: 'spectator'
		});
		const raced = await Promise.all(
			Array.from({ length: 4 }, () => consumeWsTicket(db, contested))
		);
		expect(raced.filter((r) => r.ok)).toHaveLength(1);
	});

	test('BINDING round-trip: the consumed row returns the exact minted (session, user, member, role) binding', async () => {
		const db = serviceRoleAdapter();
		const binding = {
			sessionId: randomUUID(),
			userId: randomUUID(),
			memberId: randomUUID(),
			role: 'member' as const
		};
		const { ticket } = await createWsTicket(db, binding);
		const consumed = await consumeWsTicket(db, ticket);
		expect(consumed.ok).toBe(true);
		if (consumed.ok) {
			expect(consumed.ticket.session_id).toBe(binding.sessionId);
			expect(consumed.ticket.user_id).toBe(binding.userId);
			expect(consumed.ticket.member_id).toBe(binding.memberId);
			expect(consumed.ticket.role).toBe(binding.role);
		}
		// A DIFFERENT raw value (wrong binding by construction — its digest matches
		// nothing) is rejected outright.
		const wrong = await consumeWsTicket(db, mintWsTicketValue());
		expect(wrong.ok).toBe(false);
	});

	test('MINT is DB-clock authoritative: a FAST application clock cannot stretch the stored or returned lifetime', async () => {
		// The application believes it is one hour in the FUTURE. The pre-fix mint
		// INSERTed expires_at = app now + 30s — an effective 63-minute ticket by
		// database time. The DB mint must fix a 30-second lifetime from ITS now().
		const db = serviceRoleAdapter();
		let minted: { ticket: string; expiresAt: string };
		vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3_600_000 });
		try {
			minted = await createWsTicket(db, {
				sessionId: randomUUID(),
				userId: randomUUID(),
				memberId: randomUUID(),
				role: 'member'
			});
		} finally {
			vi.useRealTimers();
		}
		// The database's own verdict on the stored row: lifetime EXACTLY 30 seconds
		// (created_at and expires_at were fixed in one statement), created just now
		// by DATABASE time (not an hour ahead), and the RETURNED expiry is the
		// STORED expiry — no second, app-computed value anywhere.
		const stored = await asRole(
			'service_role',
			`select
				extract(epoch from (expires_at - created_at)) as lifetime_s,
				(created_at between now() - interval '30 seconds' and now() + interval '2 seconds') as created_fresh,
				-- node-postgres surfaces timestamptz as a millisecond JS Date (PostgREST
				-- itself returns the microsecond string), so compare at that precision.
				(date_trunc('milliseconds', expires_at) = $2::timestamptz) as returned_matches
			 from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[digestWsTicket(minted.ticket), minted.expiresAt]
		);
		expect(stored.error).toBeNull();
		expect(stored.rows).toHaveLength(1);
		expect(Number(stored.rows[0].lifetime_s)).toBe(30);
		expect(stored.rows[0].created_fresh).toBe(true);
		expect(stored.rows[0].returned_matches).toBe(true);
		// And the ticket is a normal, immediately-consumable 30-second ticket.
		const consumed = await consumeWsTicket(db, minted.ticket);
		expect(consumed.ok).toBe(true);
	});

	test('MINT is DB-clock authoritative: a SLOW application clock cannot mint a ticket dead on arrival', async () => {
		// The application believes it is one hour in the PAST. The pre-fix mint
		// wrote expires_at = app now + 30s — already ~59 minutes expired by
		// database time, dead on arrival.
		const db = serviceRoleAdapter();
		let minted: { ticket: string; expiresAt: string };
		vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 3_600_000 });
		try {
			minted = await createWsTicket(db, {
				sessionId: randomUUID(),
				userId: randomUUID(),
				memberId: null,
				role: 'spectator'
			});
		} finally {
			vi.useRealTimers();
		}
		const stored = await asRole(
			'service_role',
			`select (expires_at > now()) as alive from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[digestWsTicket(minted.ticket)]
		);
		expect(stored.rows).toHaveLength(1);
		expect(stored.rows[0].alive).toBe(true);
		const consumed = await consumeWsTicket(db, minted.ticket);
		expect(consumed.ok).toBe(true);
	});

	test('NO caller-controlled lifetime exists: every time/TTL-accepting mint or consume signature is structurally gone', async () => {
		// The only surviving signatures are the canonical ones — nothing accepts a
		// timestamp or a TTL from the application.
		const signatures = await pool.query(
			`select p.proname, pg_get_function_identity_arguments(p.oid) as args
			 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
			 where n.nspname = $1
				 and p.proname in ('mint_ws_ticket', 'consume_ws_ticket', 'cleanup_ws_tickets')
			 order by p.proname`,
			[SCHEMA]
		);
		expect(signatures.rows).toEqual([
			{ proname: 'cleanup_ws_tickets', args: '' },
			{ proname: 'consume_ws_ticket', args: 'p_digest text' },
			{ proname: 'mint_ws_ticket', args: 'p_session_id uuid, p_user_id uuid, p_member_id uuid, p_role text, p_digest text' }
		]);
		// Belt and braces: a TTL-shaped sixth argument resolves to no function.
		const withTtl = await asRole(
			'service_role',
			`select * from ${SCHEMA}.mint_ws_ticket($1, $2, $3, 'member', 'x', interval '1 hour')`,
			[randomUUID(), randomUUID(), randomUUID()]
		);
		expect(withTtl.error?.message ?? '').toMatch(/does not exist/);
	});

	test('SWEEP is DB-clock governed: a FAST application clock cannot delete a ticket the database still honors', async () => {
		const db = serviceRoleAdapter();
		const valid = await createWsTicket(db, {
			sessionId: randomUUID(),
			userId: randomUUID(),
			memberId: null,
			role: 'spectator'
		});
		// A row the DATABASE considers long dead (expired 20 minutes ago by now()) —
		// fabricated via the fixture backdoor, since the lifecycle triggers rightly
		// stop any normal writer from minting one.
		const deadRow = await insertTicketAsService({
			expires_at: new Date(Date.now() - 20 * 60_000).toISOString()
		});
		const dead = { rows: [{ digest: deadRow.digest }] };

		// Sweep from a process running TWO HOURS fast: the pre-fix app-clock DELETE
		// (expires_at < app now - 10min) would have destroyed the valid ticket.
		vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 3_600_000 });
		try {
			await sweepWsTickets(db);
		} finally {
			vi.useRealTimers();
		}
		const after = await asRole(
			'service_role',
			`select digest from ${SCHEMA}.play_ws_tickets where digest = any($1)`,
			[[digestWsTicket(valid.ticket), dead.rows[0].digest]]
		);
		expect(after.rows.map((r) => r.digest)).toEqual([digestWsTicket(valid.ticket)]);
		// The survivor is genuinely still redeemable.
		const consumed = await consumeWsTicket(db, valid.ticket);
		expect(consumed.ok).toBe(true);
	});

	test('MISSING mint function FAILS CLOSED: no application-timed INSERT fallback, and re-applying restores service', async () => {
		const db = serviceRoleAdapter();
		await pool.query(`drop function ${SCHEMA}.mint_ws_ticket(uuid, uuid, uuid, text, text)`);
		const before = await pool.query(`select count(*)::int as n from ${SCHEMA}.play_ws_tickets`);
		await expect(
			createWsTicket(db, {
				sessionId: randomUUID(),
				userId: randomUUID(),
				memberId: null,
				role: 'spectator'
			})
		).rejects.toThrow(/Failed to mint WS ticket/);
		// Fail closed means NOTHING landed — no direct INSERT snuck around the function.
		const after = await pool.query(`select count(*)::int as n from ${SCHEMA}.play_ws_tickets`);
		expect(after.rows[0].n).toBe(before.rows[0].n);
		// Re-applying the migration restores the mint path.
		await pool.query(MIGRATION());
		const healed = await createWsTicket(db, {
			sessionId: randomUUID(),
			userId: randomUUID(),
			memberId: null,
			role: 'spectator'
		});
		expect((await consumeWsTicket(db, healed.ticket)).ok).toBe(true);
	});

	test('LEGACY SURVIVAL: a real pre-existing two-arg consume (and wrong-shape mint) are dropped on first application; unrelated objects survive apply-twice', async () => {
		// Rebuild the pre-migration world: a legacy-shaped store where an interim
		// design shipped consume_ws_ticket(text, timestamptz) with a CALLER-supplied
		// clock, plus a wrong-shape mint variant. CREATE OR REPLACE would die on the
		// mismatched signatures; the migration must enumerate and drop them.
		await pool.query(`drop table if exists ${SCHEMA}.play_ws_tickets cascade`);
		await pool.query(`
			create table ${SCHEMA}.play_ws_tickets (
				id uuid primary key default gen_random_uuid(),
				session_id uuid,
				user_id uuid,
				member_id uuid,
				role text default 'spectator',
				digest text,
				expires_at timestamptz,
				consumed_at timestamptz,
				created_at timestamptz default now()
			);
			create function ${SCHEMA}.consume_ws_ticket(p_digest text, p_now timestamptz)
			returns setof ${SCHEMA}.play_ws_tickets
			language sql as $legacy$
				update ${SCHEMA}.play_ws_tickets
				set consumed_at = p_now
				where digest = p_digest and consumed_at is null and expires_at > p_now
				returning *;
			$legacy$;
			create function ${SCHEMA}.mint_ws_ticket(p_digest text, p_ttl_ms bigint)
			returns uuid
			language sql as $legacy$
				select gen_random_uuid();
			$legacy$;
			-- Unrelated objects that MUST survive: plain DROP FUNCTION must not cascade.
			create or replace function ${SCHEMA}.unrelated_probe() returns int language sql as 'select 42';
			create or replace view ${SCHEMA}.ws_ticket_census as
				select count(*) as n from ${SCHEMA}.play_ws_tickets;
		`);

		await pool.query(MIGRATION());
		await pool.query(MIGRATION()); // idempotent on top of the healed store

		// Exactly the canonical signatures remain — the backdatable two-arg consume
		// and the TTL-accepting mint are gone.
		const signatures = await pool.query(
			`select p.proname, pg_get_function_identity_arguments(p.oid) as args
			 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
			 where n.nspname = $1
				 and p.proname in ('mint_ws_ticket', 'consume_ws_ticket', 'cleanup_ws_tickets')
			 order by p.proname`,
			[SCHEMA]
		);
		expect(signatures.rows).toEqual([
			{ proname: 'cleanup_ws_tickets', args: '' },
			{ proname: 'consume_ws_ticket', args: 'p_digest text' },
			{ proname: 'mint_ws_ticket', args: 'p_session_id uuid, p_user_id uuid, p_member_id uuid, p_role text, p_digest text' }
		]);

		// The unrelated function and the view over the ticket table both survived.
		const probe = await pool.query(`select ${SCHEMA}.unrelated_probe() as v`);
		expect(probe.rows[0].v).toBe(42);
		const census = await pool.query(`select * from ${SCHEMA}.ws_ticket_census`);
		expect(census.rows).toHaveLength(1);

		// The healed store serves the full TS boundary: DB-timed mint → one-use consume.
		const db = serviceRoleAdapter();
		const minted = await createWsTicket(db, {
			sessionId: randomUUID(),
			userId: randomUUID(),
			memberId: randomUUID(),
			role: 'member'
		});
		const consumed = await consumeWsTicket(db, minted.ticket);
		expect(consumed.ok).toBe(true);
		const replay = await consumeWsTicket(db, minted.ticket);
		expect(replay.ok).toBe(false);
	});

	// ── ROLLING UPGRADE: the EXACT legacy direct-DML shapes, as service_role ─────────
	// A migration-first rolling deployment leaves an old application instance
	// running the pre-fix code against the migrated store. These suites replay that
	// instance's literal SQL shapes and prove the table's lifecycle triggers keep
	// every invariant WITHOUT breaking the legacy instance outright.

	test('ROLLING UPGRADE: the legacy direct mint (app-clock created/expires on the INSERT) is clamped to the DB-clock 30-second lifetime', async () => {
		// Fresh migrated store for the rolling-upgrade phases.
		await pool.query(`drop table if exists ${SCHEMA}.play_ws_tickets cascade`);
		await pool.query(MIGRATION());
		await pool.query(MIGRATION());

		// FAST app clock: the legacy instance computes expires_at = its now + 30s —
		// an hour in the future by database time. The stored row must carry the
		// DATABASE's 30-second lifetime, not the smuggled one.
		const fastRaw = mintWsTicketValue();
		const fast = await asRole(
			'service_role',
			`insert into ${SCHEMA}.play_ws_tickets
				(session_id, user_id, member_id, role, digest, expires_at, created_at)
			 values ($1, $2, $3, 'member', $4, $5, $6) returning *`,
			[
				randomUUID(),
				randomUUID(),
				randomUUID(),
				digestWsTicket(fastRaw),
				new Date(Date.now() + 3_600_000 + 30_000).toISOString(),
				new Date(Date.now() + 3_600_000).toISOString()
			]
		);
		expect(fast.error, `legacy direct mint must keep WORKING: ${fast.error?.message}`).toBeNull();
		const fastStored = await asRole(
			'service_role',
			`select
				extract(epoch from (expires_at - created_at)) as lifetime_s,
				(created_at between now() - interval '30 seconds' and now() + interval '2 seconds') as created_fresh,
				(expires_at <= now() + interval '31 seconds') as horizon_ok
			 from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[digestWsTicket(fastRaw)]
		);
		expect(fastStored.rows).toHaveLength(1);
		expect(Number(fastStored.rows[0].lifetime_s)).toBe(30);
		expect(fastStored.rows[0].created_fresh).toBe(true);
		expect(fastStored.rows[0].horizon_ok).toBe(true);
		// …and it is a perfectly normal ticket for the NEW consume path.
		expect((await consumeWsTicket(serviceRoleAdapter(), fastRaw)).ok).toBe(true);

		// SLOW app clock: the legacy mint writes an expiry already in the past by DB
		// time — dead on arrival pre-fix. The trigger gives it the real 30 seconds.
		const slowRaw = mintWsTicketValue();
		const slow = await asRole(
			'service_role',
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at)
			 values ($1, $2, 'spectator', $3, $4)`,
			[
				randomUUID(),
				randomUUID(),
				digestWsTicket(slowRaw),
				new Date(Date.now() - 3_600_000 + 30_000).toISOString()
			]
		);
		expect(slow.error).toBeNull();
		const alive = await asRole(
			'service_role',
			`select (expires_at > now()) as alive from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[digestWsTicket(slowRaw)]
		);
		expect(alive.rows[0].alive).toBe(true);

		// A legacy row can never be born consumed either.
		const bornRaw = mintWsTicketValue();
		await asRole(
			'service_role',
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at, consumed_at)
			 values ($1, $2, 'spectator', $3, now() + interval '30 seconds', now())`,
			[randomUUID(), randomUUID(), digestWsTicket(bornRaw)]
		);
		expect((await consumeWsTicket(serviceRoleAdapter(), bornRaw)).ok).toBe(true);
	});

	test('ROLLING UPGRADE: the legacy app-clock conditional consume works when honest, is DB-clocked, and cannot resurrect a DB-expired digest', async () => {
		// The pre-fix consume was: UPDATE … SET consumed_at = <app now> WHERE digest
		// AND consumed_at IS NULL AND expires_at > <app now>. Replay it exactly.
		const appNowSlow = new Date(Date.now() - 120_000).toISOString(); // 2 min behind

		// 1. Against a VALID ticket the legacy consume still works — but the STORED
		//    consumed_at is the DATABASE's now(), not the backdated app value.
		const valid = await insertTicketAsService();
		const legacyConsume = await asRole(
			'service_role',
			`update ${SCHEMA}.play_ws_tickets set consumed_at = $2
			 where digest = $1 and consumed_at is null and expires_at > $2 returning *`,
			[valid.digest, appNowSlow]
		);
		expect(legacyConsume.error).toBeNull();
		expect(legacyConsume.rows).toHaveLength(1);
		const storedConsume = await asRole(
			'service_role',
			`select (consumed_at between now() - interval '30 seconds' and now() + interval '2 seconds') as db_clocked
			 from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[valid.digest]
		);
		expect(storedConsume.rows[0].db_clocked).toBe(true);

		// 2. Against a DB-EXPIRED ticket the same legacy statement — whose app-side
		//    predicate (expires_at > slow app now) PASSES — must claim NOTHING: zero
		//    rows updated, the row stays unconsumed, and the new consume path still
		//    refuses it. Pre-fix this resurrected the digest.
		const expired = await insertTicketAsService({
			expires_at: new Date(Date.now() - 1_000).toISOString()
		});
		const resurrect = await asRole(
			'service_role',
			`update ${SCHEMA}.play_ws_tickets set consumed_at = $2
			 where digest = $1 and consumed_at is null and expires_at > $2 returning *`,
			[expired.digest, appNowSlow]
		);
		expect(resurrect.error).toBeNull();
		expect(resurrect.rows).toHaveLength(0); // legacy join fails closed
		const after = await asRole(
			'service_role',
			`select consumed_at from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[expired.digest]
		);
		expect(after.rows[0].consumed_at).toBeNull();
		const viaFn = await consumeWsTicket(serviceRoleAdapter(), expired.raw);
		expect(viaFn.ok).toBe(false);
	});

	test('ROLLING UPGRADE: direct UPDATE cannot stretch expiry, rebind a ticket, or reset consumption', async () => {
		const minted = await insertTicketAsService();
		const attacker = randomUUID();

		// Stretch + rebind attempt: every pinned column silently keeps its value.
		const tamper = await asRole(
			'service_role',
			`update ${SCHEMA}.play_ws_tickets
			 set expires_at = now() + interval '1 hour', user_id = $2, session_id = $3,
				 role = 'member', digest = $4, created_at = now() - interval '1 day'
			 where digest = $1 returning *`,
			[minted.digest, attacker, randomUUID(), digestWsTicket(mintWsTicketValue())]
		);
		expect(tamper.error).toBeNull();
		const stored = await asRole(
			'service_role',
			`select user_id, session_id, digest,
					(expires_at <= now() + interval '31 seconds') as horizon_ok
			 from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[minted.digest]
		);
		expect(stored.rows).toHaveLength(1); // digest unchanged — still findable
		expect(stored.rows[0].user_id).toBe(minted.user_id);
		expect(stored.rows[0].session_id).toBe(minted.session_id);
		expect(stored.rows[0].horizon_ok).toBe(true);

		// One-way consumption: consume, then try the reset. The replay must stay dead.
		const consumed = await consumeWsTicket(serviceRoleAdapter(), minted.raw);
		expect(consumed.ok).toBe(true);
		const reset = await asRole(
			'service_role',
			`update ${SCHEMA}.play_ws_tickets set consumed_at = null where digest = $1 returning consumed_at`,
			[minted.digest]
		);
		expect(reset.error).toBeNull();
		const stillConsumed = await asRole(
			'service_role',
			`select consumed_at from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[minted.digest]
		);
		expect(stillConsumed.rows[0].consumed_at).not.toBeNull();
		const replay = await consumeWsTicket(serviceRoleAdapter(), minted.raw);
		expect(replay.ok).toBe(false);
	});

	test('ROLLING UPGRADE: the legacy fast-clock sweep (direct DELETE below an app cutoff) cannot delete a DB-valid ticket', async () => {
		// The pre-fix sweep: DELETE … WHERE expires_at < <app now - 10min>. From a
		// process two hours FAST, that cutoff is far in the DB future and matches
		// EVERY row — including perfectly valid tickets.
		const valid = await insertTicketAsService();
		const longDead = await insertTicketAsService({
			expires_at: new Date(Date.now() - 20 * 60_000).toISOString()
		});
		const fastCutoff = new Date(Date.now() + 2 * 3_600_000 - 10 * 60_000).toISOString();
		const sweep = await asRole(
			'service_role',
			`delete from ${SCHEMA}.play_ws_tickets where expires_at < $1`,
			[fastCutoff]
		);
		expect(sweep.error).toBeNull(); // the legacy sweep statement keeps WORKING…
		const remaining = await asRole(
			'service_role',
			`select digest from ${SCHEMA}.play_ws_tickets where digest = any($1)`,
			[[valid.digest, longDead.digest]]
		);
		// …but only the DB-long-dead row died; the valid ticket survived and redeems.
		expect(remaining.rows.map((r) => r.digest)).toEqual([valid.digest]);
		expect((await consumeWsTicket(serviceRoleAdapter(), valid.raw)).ok).toBe(true);
	});

	test('FULL TABLE HEALING: nullable/null role, expires_at, created_at, a stretched expiry and a divergent role CHECK all converge on the canonical schema (apply twice)', async () => {
		const keeperRaw = mintWsTicketValue();
		const stretchedRaw = mintWsTicketValue();
		await pool.query(`drop table if exists ${SCHEMA}.play_ws_tickets cascade`);
		await pool.query(`
			create table ${SCHEMA}.play_ws_tickets (
				id uuid default gen_random_uuid(),
				session_id uuid,
				user_id uuid,
				member_id uuid,
				role text,
				digest text,
				expires_at timestamptz,
				consumed_at timestamptz,
				created_at timestamptz
			);
			-- A divergent constraint under the canonical NAME (allows 'superadmin').
			alter table ${SCHEMA}.play_ws_tickets
				add constraint play_ws_tickets_role_check
				check (role in ('member', 'spectator', 'superadmin'));
		`);
		await pool.query(
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at, created_at) values
			 ($1, $2, 'member', $3, now() + interval '25 seconds', null),      -- healable: created_at backfilled
			 ($1, $2, null, $4, now() + interval '25 seconds', now()),         -- unhealable: null role
			 ($1, $2, 'member', $5, null, now()),                              -- unhealable: NULL expiry (would persist forever)
			 ($1, $2, 'superadmin', $6, now() + interval '25 seconds', now()), -- unhealable: role outside the canonical set
			 ($1, $2, 'member', $7, now() + interval '6 hours', now())         -- healable: stretched expiry clamped
			`,
			[
				randomUUID(),
				randomUUID(),
				digestWsTicket(keeperRaw),
				digestWsTicket(mintWsTicketValue()),
				digestWsTicket(mintWsTicketValue()),
				digestWsTicket(mintWsTicketValue()),
				digestWsTicket(stretchedRaw)
			]
		);

		await pool.query(MIGRATION());
		await pool.query(MIGRATION()); // apply twice — the healed table re-heals cleanly

		// Declared schema: NOT NULL everywhere it must be, canonical defaults —
		// role 'spectator', created_at now(), id gen_random_uuid(), expires_at NONE.
		const cols = await pool.query(
			`select column_name, is_nullable, column_default from information_schema.columns
			 where table_schema = $1 and table_name = 'play_ws_tickets'`,
			[SCHEMA]
		);
		const byName = new Map(
			cols.rows.map((r) => [r.column_name, { nullable: r.is_nullable, def: r.column_default }])
		);
		for (const required of ['id', 'session_id', 'user_id', 'digest', 'role', 'expires_at', 'created_at']) {
			expect(byName.get(required)?.nullable, `${required} nullable`).toBe('NO');
		}
		expect(byName.get('role')?.def).toMatch(/'spectator'/);
		expect(byName.get('created_at')?.def).toMatch(/now\(\)/);
		expect(byName.get('id')?.def).toMatch(/gen_random_uuid\(\)/);
		expect(byName.get('expires_at')?.def ?? null).toBeNull(); // NO default — always supplied
		expect(byName.get('consumed_at')?.nullable).toBe('YES');

		// Rows: only the two healable rows survive; the null-expiry row is GONE (it
		// must not persist forever), and the stretched expiry is clamped.
		const survivors = await pool.query(
			`select digest, (expires_at <= now() + interval '31 seconds') as horizon_ok,
					created_at is not null as created_ok
			 from ${SCHEMA}.play_ws_tickets order by digest`
		);
		expect(survivors.rows.map((r) => r.digest).sort()).toEqual(
			[digestWsTicket(keeperRaw), digestWsTicket(stretchedRaw)].sort()
		);
		for (const row of survivors.rows) {
			expect(row.horizon_ok).toBe(true);
			expect(row.created_ok).toBe(true);
		}

		// The divergent same-named CHECK was replaced by the canonical one.
		const constraint = await pool.query(
			`select pg_get_constraintdef(oid) as def from pg_constraint
			 where conname = 'play_ws_tickets_role_check'
				 and conrelid = '${SCHEMA}.play_ws_tickets'::regclass`
		);
		expect(constraint.rows).toHaveLength(1);
		expect(constraint.rows[0].def).not.toMatch(/superadmin/);
		const badRole = await asRole(
			'service_role',
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at)
			 values ($1, $2, 'superadmin', $3, now())`,
			[randomUUID(), randomUUID(), digestWsTicket(mintWsTicketValue())]
		);
		expect(badRole.error?.message ?? '').toMatch(/check constraint|violates/);

		// Primary key exists, and the healed store serves the boundary end-to-end.
		const pk = await pool.query(
			`select 1 from pg_constraint
			 where conrelid = '${SCHEMA}.play_ws_tickets'::regclass and contype = 'p'`
		);
		expect(pk.rows).toHaveLength(1);
		const db = serviceRoleAdapter();
		const minted = await createWsTicket(db, {
			sessionId: randomUUID(),
			userId: randomUUID(),
			memberId: null,
			role: 'spectator'
		});
		expect((await consumeWsTicket(db, minted.ticket)).ok).toBe(true);
	});

	test(
		'WALL-CLOCK EXPIRY: a consume that blocked on a held row lock across expiry claims nothing — function and legacy DML shapes',
		{ timeout: 30_000 },
		async () => {
			await pool.query(MIGRATION());

			// Two short-lived tickets (~2s of remaining life), one per consume shape.
			const viaFn = await insertTicketAsService();
			const viaLegacy = await insertTicketAsService();
			const expiresAt = new Date(Date.now() + 2_000).toISOString();
			await backdateTicket(viaFn.digest, { expires_at: expiresAt });
			await backdateTicket(viaLegacy.digest, { expires_at: expiresAt });

			const locker = await pool.connect();
			const fnConsumer = await pool.connect();
			const legacyConsumer = await pool.connect();
			try {
				// Another transaction holds both rows locked across the expiry instant.
				await locker.query('begin');
				await locker.query(
					`select id from ${SCHEMA}.play_ws_tickets where digest = any($1) for update`,
					[[viaFn.digest, viaLegacy.digest]]
				);

				// Both consume transactions BEGIN while the tickets are still valid, so
				// their transaction-start now() predates the expiry — the exact repro:
				// under a now()-based predicate/trigger, both would consume after the
				// lock releases and return rows already past wall expiry.
				await fnConsumer.query('begin');
				await fnConsumer.query('set local role service_role');
				const pendingFn = fnConsumer.query(
					`select * from ${SCHEMA}.consume_ws_ticket($1)`,
					[viaFn.digest]
				);
				await legacyConsumer.query('begin');
				await legacyConsumer.query('set local role service_role');
				const appNow = new Date().toISOString(); // honest legacy app clock
				const pendingLegacy = legacyConsumer.query(
					`update ${SCHEMA}.play_ws_tickets set consumed_at = $2
					 where digest = $1 and consumed_at is null and expires_at > $2 returning *`,
					[viaLegacy.digest, appNow]
				);

				// Hold the lock until the tickets are unambiguously wall-expired…
				await new Promise((resolve) => setTimeout(resolve, 3_500));
				await locker.query('commit'); // …then release WITHOUT consuming.

				const [gotFn, gotLegacy] = await Promise.all([pendingFn, pendingLegacy]);
				await fnConsumer.query('commit');
				await legacyConsumer.query('commit');

				// Neither shape claimed the wall-expired ticket, and no consumed row
				// with a past-wall expiry was ever returned.
				expect(gotFn.rows).toHaveLength(0);
				expect(gotLegacy.rows).toHaveLength(0);
				const after = await pool.query(
					`select consumed_at, (expires_at <= clock_timestamp()) as wall_expired
					 from ${SCHEMA}.play_ws_tickets where digest = any($1)`,
					[[viaFn.digest, viaLegacy.digest]]
				);
				expect(after.rows).toHaveLength(2);
				for (const row of after.rows) {
					expect(row.consumed_at).toBeNull();
					expect(row.wall_expired).toBe(true);
				}
			} finally {
				for (const client of [locker, fnConsumer, legacyConsumer]) {
					await client.query('rollback').catch(() => {});
					client.release();
				}
			}
		}
	);

	test(
		'WALL-CLOCK LIFECYCLE: stale transactions — an old consume transaction cannot claim past expiry, an old mint still gets its full anchored lifetime, an old sweep respects the true grace line',
		{ timeout: 20_000 },
		async () => {
			// CONSUME inside a transaction that outlives the ticket (no lock involved):
			// now() would still predate the expiry; clock_timestamp() must refuse.
			const shortLived = await insertTicketAsService();
			await backdateTicket(shortLived.digest, {
				expires_at: new Date(Date.now() + 1_000).toISOString()
			});
			const client = await pool.connect();
			try {
				await client.query('begin');
				await client.query('set local role service_role');
				await client.query('select pg_sleep(1.6)'); // ticket wall-expires mid-transaction
				const claimed = await client.query(
					`select * from ${SCHEMA}.consume_ws_ticket($1)`,
					[shortLived.digest]
				);
				expect(claimed.rows).toHaveLength(0);

				// MINT in the same stale transaction: the ticket's clocks anchor at the
				// wall instant of the mint, not at transaction start — inside this
				// transaction created_at > now() proves clock_timestamp() governed.
				const raw = mintWsTicketValue();
				const minted = await client.query(
					`select (created_at > now()) as anchored_after_txn_start,
							extract(epoch from (expires_at - created_at)) as lifetime_s
					 from ${SCHEMA}.mint_ws_ticket($1, $2, null, 'spectator', $3)`,
					[randomUUID(), randomUUID(), digestWsTicket(raw)]
				);
				expect(minted.rows[0].anchored_after_txn_start).toBe(true);
				expect(Number(minted.rows[0].lifetime_s)).toBe(30);
				await client.query('commit');
				// …and it is a perfectly valid ticket outside the transaction.
				expect((await consumeWsTicket(serviceRoleAdapter(), raw)).ok).toBe(true);
			} finally {
				await client.query('rollback').catch(() => {});
				client.release();
			}

			// SWEEP semantics are deliberate wall-clock: a row exactly at the edge of
			// the 10-minute grace line by transaction time but inside it by wall time
			// stays; one past it by wall time goes.
			const edge = await insertTicketAsService();
			await backdateTicket(edge.digest, {
				expires_at: new Date(Date.now() - 9 * 60_000).toISOString() // dead 9 min — inside grace
			});
			const longDead = await insertTicketAsService();
			await backdateTicket(longDead.digest, {
				expires_at: new Date(Date.now() - 20 * 60_000).toISOString()
			});
			const swept = await asRole('service_role', `select ${SCHEMA}.cleanup_ws_tickets()`);
			expect(swept.error).toBeNull();
			const census = await pool.query(
				`select digest from ${SCHEMA}.play_ws_tickets where digest = any($1)`,
				[[edge.digest, longDead.digest]]
			);
			expect(census.rows.map((r) => r.digest)).toEqual([edge.digest]);
		}
	);

	test('RANKED ⇒ PRIVATE at the table: a legacy INSERT omitting visibility cannot create a public ranked room; casual behavior intact', async () => {
		await pool.query(MIGRATION());
		const code = () => `WCK${Math.floor(Math.random() * 1_000_000)}`;

		// The exact rolling-upgrade shape: a writer that predates the visibility
		// column INSERTs mode=ranked WITHOUT it — the 'public' default must not win.
		const omitted = await pool.query(
			`insert into ${SCHEMA}.play_game_sessions (room_code, mode) values ($1, 'ranked')
			 returning visibility`,
			[code()]
		);
		expect(omitted.rows[0].visibility).toBe('private');

		// Even an EXPLICIT public request on a ranked row is coerced.
		const explicit = await pool.query(
			`insert into ${SCHEMA}.play_game_sessions (room_code, mode, visibility)
			 values ($1, 'ranked', 'public') returning id, visibility`,
			[code()]
		);
		expect(explicit.rows[0].visibility).toBe('private');

		// A ranked room can never be flipped public later…
		const flipped = await pool.query(
			`update ${SCHEMA}.play_game_sessions set visibility = 'public'
			 where id = $1 returning visibility`,
			[explicit.rows[0].id]
		);
		expect(flipped.rows[0].visibility).toBe('private');

		// …and re-moding a public casual room to ranked forces it private.
		const casual = await pool.query(
			`insert into ${SCHEMA}.play_game_sessions (room_code, mode) values ($1, 'casual')
			 returning id, visibility`,
			[code()]
		);
		expect(casual.rows[0].visibility).toBe('public'); // casual default unchanged
		const remoded = await pool.query(
			`update ${SCHEMA}.play_game_sessions set mode = 'ranked'
			 where id = $1 returning visibility`,
			[casual.rows[0].id]
		);
		expect(remoded.rows[0].visibility).toBe('private');

		// Intended casual behavior is untouched: explicit private (matchmade-casual)
		// is honored and casual visibility remains freely settable.
		const casualPrivate = await pool.query(
			`insert into ${SCHEMA}.play_game_sessions (room_code, mode, visibility)
			 values ($1, 'casual', 'private') returning id, visibility`,
			[code()]
		);
		expect(casualPrivate.rows[0].visibility).toBe('private');
		const casualReopened = await pool.query(
			`update ${SCHEMA}.play_game_sessions set visibility = 'public'
			 where id = $1 returning visibility`,
			[casualPrivate.rows[0].id]
		);
		expect(casualReopened.rows[0].visibility).toBe('public');
	});

	test('ROGUE GRANTS/POLICIES: legacy table/column grants and divergent policies on a pre-existing table are converged away (apply twice), service-role DML path intact', async () => {
		// The reproduced posture: a forgotten legacy role holding INSERT (plus a
		// column-level UPDATE), anon granted ALL, a PUBLIC free-for-all policy, and
		// a squatter on the canonical policy NAME that also admits anon.
		await pool.query(`
			do $$ begin
				if not exists (select 1 from pg_roles where rolname = 'legacy_client') then
					create role legacy_client nologin;
				end if;
			end $$;
			grant usage on schema ${SCHEMA} to legacy_client;
			drop table if exists ${SCHEMA}.play_ws_tickets cascade;
			create table ${SCHEMA}.play_ws_tickets (
				id uuid primary key default gen_random_uuid(),
				session_id uuid,
				user_id uuid,
				member_id uuid,
				role text default 'spectator',
				digest text,
				expires_at timestamptz,
				consumed_at timestamptz,
				created_at timestamptz default now()
			);
			grant insert, select on ${SCHEMA}.play_ws_tickets to legacy_client;
			grant update (consumed_at) on ${SCHEMA}.play_ws_tickets to legacy_client;
			grant all on ${SCHEMA}.play_ws_tickets to anon;
			alter table ${SCHEMA}.play_ws_tickets enable row level security;
			create policy legacy_free_for_all on ${SCHEMA}.play_ws_tickets
				for all to public using (true) with check (true);
			create policy play_ws_tickets_service_role_only on ${SCHEMA}.play_ws_tickets
				for all to anon, service_role using (true) with check (true);
		`);

		// Fixture sanity — the pre-migration hole is real: legacy_client mints a
		// victim-bindable ticket directly.
		const victimSession = randomUUID();
		const victimUser = randomUUID();
		const preFix = await asRole(
			'legacy_client',
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at)
			 values ($1, $2, 'member', $3, now() + interval '1 hour') returning digest`,
			[victimSession, victimUser, digestWsTicket(mintWsTicketValue())]
		);
		expect(preFix.error).toBeNull();
		expect(preFix.rows).toHaveLength(1);

		await pool.query(MIGRATION());
		await pool.query(MIGRATION()); // convergence must survive re-apply

		// legacy_client: every verb refused now — table grants, the column grant,
		// and both rogue policies are gone.
		const forged = await asRole(
			'legacy_client',
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at)
			 values ($1, $2, 'member', $3, now() + interval '1 hour')`,
			[victimSession, victimUser, digestWsTicket(mintWsTicketValue())]
		);
		expect(forged.error?.message ?? '').toMatch(/permission denied/);
		const read = await asRole('legacy_client', `select * from ${SCHEMA}.play_ws_tickets`);
		expect(read.error?.message ?? '').toMatch(/permission denied/);
		const colUpd = await asRole(
			'legacy_client',
			`update ${SCHEMA}.play_ws_tickets set consumed_at = now()`
		);
		expect(colUpd.error?.message ?? '').toMatch(/permission denied/);
		for (const role of ['anon', 'authenticated'] as const) {
			const probe = await asRole(role, `select * from ${SCHEMA}.play_ws_tickets`);
			expect(probe.error?.message ?? '').toMatch(/permission denied/);
		}

		// Policy census: exactly the canonical policy, scoped to service_role alone.
		const policies = await pool.query(
			`select policyname, roles from pg_policies
			 where schemaname = $1 and tablename = 'play_ws_tickets'`,
			[SCHEMA]
		);
		expect(policies.rows.map((r) => r.policyname)).toEqual(['play_ws_tickets_service_role_only']);
		const policyRoles = Array.isArray(policies.rows[0].roles)
			? policies.rows[0].roles
			: String(policies.rows[0].roles).replace(/[{}]/g, '').split(',');
		expect(policyRoles).toEqual(['service_role']);

		// ACL census: no table grantee beyond the owner and service_role, and no
		// column-level ACL entry survives at all.
		const tableAcl = await pool.query(`
			select distinct pg_get_userbyid(a.grantee) as grantee
			from pg_class c
			cross join lateral aclexplode(c.relacl) a
			where c.oid = '${SCHEMA}.play_ws_tickets'::regclass`);
		expect(new Set(tableAcl.rows.map((r) => r.grantee))).toEqual(
			new Set(['postgres', 'service_role'])
		);
		const columnAcl = await pool.query(
			`select count(*)::int as n from pg_attribute
			 where attrelid = '${SCHEMA}.play_ws_tickets'::regclass and attacl is not null`
		);
		expect(columnAcl.rows[0].n).toBe(0);

		// The victim-bindable pre-fix row was healed away or is at least inert —
		// and the service-role rolling-upgrade DML path the triggers protect is
		// fully intact: direct INSERT (clamped) and function consume both work.
		const minted = await insertTicketAsService();
		expect((await consumeWsTicket(serviceRoleAdapter(), minted.raw)).ok).toBe(true);
	});

	test('DIGEST UNIQUENESS BY SEMANTICS: same-named non-unique index over id (and a same-named unique constraint over id) are rebuilt canonically; duplicates rejected; apply twice', async () => {
		// Phase 1 — the reproduced defect: a plain (NON-unique) index squatting on
		// the canonical NAME over the WRONG column, plus pre-existing duplicate
		// digests. `create unique index if not exists` used to trust the name, skip
		// creation, and accept duplicate digests forever after.
		const dupDigest = digestWsTicket(mintWsTicketValue());
		await pool.query(`
			drop table if exists ${SCHEMA}.play_ws_tickets cascade;
			create table ${SCHEMA}.play_ws_tickets (
				id uuid primary key default gen_random_uuid(),
				session_id uuid,
				user_id uuid,
				member_id uuid,
				role text default 'spectator',
				digest text,
				expires_at timestamptz,
				consumed_at timestamptz,
				created_at timestamptz default now()
			);
			create index play_ws_tickets_digest_key on ${SCHEMA}.play_ws_tickets (id);
		`);
		await pool.query(
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at) values
			 ($1, $2, 'member', $3, now() + interval '1 hour'),
			 ($1, $2, 'member', $3, now() + interval '1 hour')`,
			[randomUUID(), randomUUID(), dupDigest]
		);

		await pool.query(MIGRATION());
		await pool.query(MIGRATION());

		// The surviving index of that name is the CANONICAL one: unique, over
		// exactly (digest), unconditional.
		const healed = await pool.query(
			`select indexdef from pg_indexes
			 where schemaname = $1 and tablename = 'play_ws_tickets'
				 and indexname = 'play_ws_tickets_digest_key'`,
			[SCHEMA]
		);
		expect(healed.rows).toHaveLength(1);
		expect(healed.rows[0].indexdef).toMatch(/UNIQUE/i);
		expect(healed.rows[0].indexdef).toMatch(/\(digest\)/);
		// The ambiguous duplicate rows are gone…
		const dups = await pool.query(
			`select count(*)::int as n from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[dupDigest]
		);
		expect(dups.rows[0].n).toBe(0);
		// …and NEW duplicate digests are rejected at the store, not accepted.
		const contested = digestWsTicket(mintWsTicketValue());
		const first = await asRole(
			'service_role',
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at)
			 values ($1, $2, 'member', $3, now())`,
			[randomUUID(), randomUUID(), contested]
		);
		expect(first.error).toBeNull();
		const second = await asRole(
			'service_role',
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at)
			 values ($1, $2, 'member', $3, now())`,
			[randomUUID(), randomUUID(), contested]
		);
		expect(second.error?.message ?? '').toMatch(/duplicate key/);

		// Phase 2 — a same-named unique CONSTRAINT over the wrong column (id): the
		// backing index is unique but semantically wrong; the healer must drop it
		// via its constraint and rebuild over (digest).
		await pool.query(`
			drop table if exists ${SCHEMA}.play_ws_tickets cascade;
			create table ${SCHEMA}.play_ws_tickets (
				id uuid primary key default gen_random_uuid(),
				session_id uuid,
				user_id uuid,
				member_id uuid,
				role text default 'spectator',
				digest text,
				expires_at timestamptz,
				consumed_at timestamptz,
				created_at timestamptz default now(),
				constraint play_ws_tickets_digest_key unique (id)
			);
		`);
		await pool.query(MIGRATION());
		await pool.query(MIGRATION());
		const rebuilt = await pool.query(
			`select indexdef from pg_indexes
			 where schemaname = $1 and tablename = 'play_ws_tickets'
				 and indexname = 'play_ws_tickets_digest_key'`,
			[SCHEMA]
		);
		expect(rebuilt.rows).toHaveLength(1);
		expect(rebuilt.rows[0].indexdef).toMatch(/UNIQUE/i);
		expect(rebuilt.rows[0].indexdef).toMatch(/\(digest\)/);
		// The wrong-column constraint is gone (the PK still covers id).
		const squatter = await pool.query(
			`select contype from pg_constraint
			 where conname = 'play_ws_tickets_digest_key'
				 and conrelid = '${SCHEMA}.play_ws_tickets'::regclass`
		);
		expect(squatter.rows).toHaveLength(0);

		// The healed store serves the boundary end-to-end.
		const db = serviceRoleAdapter();
		const minted = await createWsTicket(db, {
			sessionId: randomUUID(),
			userId: randomUUID(),
			memberId: null,
			role: 'spectator'
		});
		expect((await consumeWsTicket(db, minted.ticket)).ok).toBe(true);
		expect((await consumeWsTicket(db, minted.ticket)).ok).toBe(false);
	});

	test('ROGUE OWNER: hostile partial-table owner is displaced — no insert past FORCE RLS, no trigger disable, no trigger-function takeover; service-role path intact; apply twice', async () => {
		// Ensure the canonical functions exist so the fixture can put a squatter's
		// ownership on one of them (the reproduced posture: the rogue principal
		// created the partial schema INCLUDING same-named trigger functions).
		await pool.query(MIGRATION());
		await pool.query(`
			do $$ begin
				if not exists (select 1 from pg_roles where rolname = 'legacy_owner') then
					create role legacy_owner nologin;
				end if;
			end $$;
			grant usage on schema ${SCHEMA} to legacy_owner;
			drop table if exists ${SCHEMA}.play_ws_tickets cascade;
			create table ${SCHEMA}.play_ws_tickets (
				id uuid primary key default gen_random_uuid(),
				session_id uuid,
				user_id uuid,
				member_id uuid,
				role text default 'spectator',
				digest text,
				expires_at timestamptz,
				consumed_at timestamptz,
				created_at timestamptz default now()
			);
			alter table ${SCHEMA}.play_ws_tickets owner to legacy_owner;
			alter table ${SCHEMA}.play_ws_tickets enable row level security;
			alter function ${SCHEMA}.play_ws_tickets_enforce_update() owner to legacy_owner;
		`);

		// Fixture sanity — the pre-migration hole is real: the OWNER walks straight
		// past enabled-but-not-forced RLS (no policy admits anyone, and none is
		// needed for an owner) and inserts a victim-bound, hour-long ticket.
		const victimSession = randomUUID();
		const victimUser = randomUUID();
		const rogueDigest = digestWsTicket(mintWsTicketValue());
		const preFix = await asRole(
			'legacy_owner',
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at)
			 values ($1, $2, 'member', $3, now() + interval '1 hour') returning digest`,
			[victimSession, victimUser, rogueDigest]
		);
		expect(preFix.error).toBeNull();
		expect(preFix.rows).toHaveLength(1);

		await pool.query(MIGRATION());
		await pool.query(MIGRATION()); // convergence must survive re-apply

		// OWNERSHIP converged: the table and every lifecycle/visibility trigger
		// function belong to the migration principal, not the rogue.
		const tblOwner = await pool.query(
			`select pg_get_userbyid(relowner) as owner, relrowsecurity, relforcerowsecurity
			 from pg_class where oid = '${SCHEMA}.play_ws_tickets'::regclass`
		);
		expect(tblOwner.rows[0].owner).toBe('postgres');
		expect(tblOwner.rows[0].relrowsecurity).toBe(true);
		// FORCE RLS: even a future owner-credentialed writer goes through the policy.
		expect(tblOwner.rows[0].relforcerowsecurity).toBe(true);
		const fnOwners = await pool.query(`
			select p.proname, pg_get_userbyid(p.proowner) as owner
			from pg_proc p join pg_namespace n on n.oid = p.pronamespace
			where n.nspname = '${SCHEMA}' and p.proname in (
				'play_ws_tickets_enforce_insert', 'play_ws_tickets_enforce_update',
				'play_ws_tickets_enforce_delete', 'play_game_sessions_enforce_visibility'
			)`);
		expect(fnOwners.rows).toHaveLength(4);
		for (const row of fnOwners.rows) {
			expect(row.owner, `${row.proname} owner`).toBe('postgres');
		}

		// The displaced rogue: cannot insert (no grant, no policy, no owner bypass)…
		const forged = await asRole(
			'legacy_owner',
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at)
			 values ($1, $2, 'member', $3, now() + interval '1 hour')`,
			[victimSession, victimUser, digestWsTicket(mintWsTicketValue())]
		);
		expect(forged.error?.message ?? '').toMatch(/permission denied/);
		// …cannot switch the lifecycle enforcement off…
		const disable = await asRole(
			'legacy_owner',
			`alter table ${SCHEMA}.play_ws_tickets disable trigger play_ws_tickets_lifecycle_update`
		);
		expect(disable.error?.message ?? '').toMatch(/must be owner|permission denied/);
		// …and cannot rewrite the enforcement body it used to own.
		const takeover = await asRole(
			'legacy_owner',
			`create or replace function ${SCHEMA}.play_ws_tickets_enforce_update()
			 returns trigger language plpgsql as 'begin return new; end'`
		);
		expect(takeover.error?.message ?? '').toMatch(/must be owner|permission denied/);

		// All three lifecycle triggers are present and ENABLED.
		const triggers = await pool.query(
			`select tgname, tgenabled from pg_trigger
			 where tgrelid = '${SCHEMA}.play_ws_tickets'::regclass and not tgisinternal
			 order by tgname`
		);
		expect(triggers.rows.map((r) => `${r.tgname}:${r.tgenabled}`)).toEqual([
			'play_ws_tickets_lifecycle_delete:O',
			'play_ws_tickets_lifecycle_insert:O',
			'play_ws_tickets_lifecycle_update:O'
		]);

		// The rogue's pre-fix hour-long victim ticket did not survive the healing
		// with its stretched life: gone, or clamped to the canonical horizon.
		const rogueRow = await pool.query(
			`select expires_at from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[rogueDigest]
		);
		if (rogueRow.rows.length > 0) {
			const expiresMs = new Date(rogueRow.rows[0].expires_at as string).getTime();
			expect(expiresMs).toBeLessThanOrEqual(Date.now() + 31_000);
		}

		// The deliberate service-role rolling-upgrade direct-DML path is intact and
		// still trigger-governed: a direct INSERT claiming an hour is clamped to the
		// DB-clock 30-second lifetime, and the boundary consumes it exactly once.
		// (Direct SQL — insertTicketAsService's override would re-stretch the clock
		// through the superuser fixture backdoor, defeating the very check.)
		const mintedRaw = mintWsTicketValue();
		const minted = { raw: mintedRaw, digest: digestWsTicket(mintedRaw) };
		const directMint = await asRole(
			'service_role',
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, member_id, role, digest, expires_at)
			 values ($1, $2, $3, 'member', $4, now() + interval '1 hour')`,
			[randomUUID(), randomUUID(), randomUUID(), minted.digest]
		);
		expect(directMint.error).toBeNull();
		const stored = await asRole(
			'service_role',
			`select expires_at, created_at from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[minted.digest]
		);
		expect(stored.rows).toHaveLength(1);
		const life =
			new Date(stored.rows[0].expires_at as string).getTime() -
			new Date(stored.rows[0].created_at as string).getTime();
		expect(life).toBe(30_000);
		expect((await consumeWsTicket(serviceRoleAdapter(), minted.raw)).ok).toBe(true);
		expect((await consumeWsTicket(serviceRoleAdapter(), minted.raw)).ok).toBe(false);
	});

	test('INVALID UNIQUE INDEX: failed CREATE UNIQUE INDEX CONCURRENTLY debris is rebuilt valid; duplicates purged and rejected; apply twice', async () => {
		// Fixture: a canonical-shaped table already holding duplicate digests, then a
		// REAL failed concurrent unique-index build — exactly how production ends up
		// with a canonical-named index that is unique in the catalog but INVALID.
		const dupDigest = digestWsTicket(mintWsTicketValue());
		await pool.query(`
			drop table if exists ${SCHEMA}.play_ws_tickets cascade;
			create table ${SCHEMA}.play_ws_tickets (
				id uuid primary key default gen_random_uuid(),
				session_id uuid,
				user_id uuid,
				member_id uuid,
				role text default 'spectator',
				digest text,
				expires_at timestamptz,
				consumed_at timestamptz,
				created_at timestamptz default now()
			);
		`);
		await pool.query(
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at) values
			 ($1, $2, 'member', $3, now() + interval '1 hour'),
			 ($1, $2, 'member', $3, now() + interval '1 hour')`,
			[randomUUID(), randomUUID(), dupDigest]
		);
		// Must be its own single statement: CONCURRENTLY refuses transaction blocks.
		await expect(
			pool.query(
				`create unique index concurrently play_ws_tickets_digest_key
				 on ${SCHEMA}.play_ws_tickets (digest)`
			)
		).rejects.toThrow(/duplicate key|could not create unique index/i);
		// The debris this leaves is the reproduced trap: canonical name, unique and
		// over (digest) in the catalog — but INVALID, enforcing nothing.
		const debris = await pool.query(
			`select i.indisunique, i.indisvalid from pg_index i
			 join pg_class c on c.oid = i.indexrelid
			 where c.relname = 'play_ws_tickets_digest_key'`
		);
		expect(debris.rows).toHaveLength(1);
		expect(debris.rows[0].indisunique).toBe(true);
		expect(debris.rows[0].indisvalid).toBe(false);

		await pool.query(MIGRATION());
		await pool.query(MIGRATION()); // a canonical VALID survivor is kept as-is

		// Healed: valid, ready, live, unique, over exactly (digest).
		const healed = await pool.query(`
			select i.indisunique, i.indisvalid, i.indisready, i.indislive,
				(select a.attname from pg_attribute a
				 where a.attrelid = i.indrelid and a.attnum = i.indkey[0]) as keycol
			from pg_index i
			join pg_class c on c.oid = i.indexrelid
			where c.relname = 'play_ws_tickets_digest_key'`);
		expect(healed.rows).toHaveLength(1);
		expect(healed.rows[0]).toMatchObject({
			indisunique: true,
			indisvalid: true,
			indisready: true,
			indislive: true,
			keycol: 'digest'
		});
		// The ambiguous duplicates are gone…
		const dups = await pool.query(
			`select count(*)::int as n from ${SCHEMA}.play_ws_tickets where digest = $1`,
			[dupDigest]
		);
		expect(dups.rows[0].n).toBe(0);
		// …and duplicate digests are ACTUALLY rejected now (the invalid index used to
		// let this second insert through).
		const contested = digestWsTicket(mintWsTicketValue());
		const first = await asRole(
			'service_role',
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at)
			 values ($1, $2, 'member', $3, now())`,
			[randomUUID(), randomUUID(), contested]
		);
		expect(first.error).toBeNull();
		const second = await asRole(
			'service_role',
			`insert into ${SCHEMA}.play_ws_tickets (session_id, user_id, role, digest, expires_at)
			 values ($1, $2, 'member', $3, now())`,
			[randomUUID(), randomUUID(), contested]
		);
		expect(second.error?.message ?? '').toMatch(/duplicate key/);

		// The healed store serves the boundary end-to-end.
		const db = serviceRoleAdapter();
		const minted = await createWsTicket(db, {
			sessionId: randomUUID(),
			userId: randomUUID(),
			memberId: null,
			role: 'spectator'
		});
		expect((await consumeWsTicket(db, minted.ticket)).ok).toBe(true);
		expect((await consumeWsTicket(db, minted.ticket)).ok).toBe(false);
	});
});
