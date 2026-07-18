/**
 * Ranked finalize — REAL POSTGRESQL concurrency acceptance.
 *
 * The in-memory FakePlayDb executes each finalize_match "transaction" atomically in
 * one JS turn, so it structurally CANNOT reproduce the schedule this suite exists
 * for: two live transactions interleaving BETWEEN statements — in particular two
 * first-ever ranked matches sharing a previously UNRATED user, where both
 * transactions validate the ABSENT rating base (there is no row for FOR UPDATE to
 * lock) and their ON CONFLICT upserts serialize only at write time, the second
 * silently overwriting the first (games_played stuck at 1, one match's rating
 * lost). Locking claims are proven HERE, against a real cluster — never by the fake.
 *
 * This suite boots a throwaway local PostgreSQL cluster (initdb + pg_ctl on a unix
 * socket — self-skips if the binaries are unavailable), applies
 * supabase/migrations/20260710_ranked_finalize.sql TWICE (idempotency) on top of
 * deliberately incomplete HAND-CREATED tables (proving the add-column hardening),
 * and then proves with deterministic, held-open transactions:
 *
 *   1. UNRATED shared user, forced overlap: the second first-ever finalize BLOCKS at
 *      the per-user advisory lock before checking bases, fails with stale_ratings
 *      once the winner commits, and the real caller-level retry
 *      (finalizeMatchUnserialized) converges — both matches counted, event chain
 *      contiguous.
 *   2. ALREADY-RATED shared user, forced overlap: same fencing and convergence.
 *   3. NEGATIVE CONTROL: a distilled replica of the pre-fix locking strategy
 *      (FOR UPDATE + base verification, NO advisory lock) run under the same
 *      schedule demonstrably LOSES one match on real PostgreSQL — the defect the
 *      advisory lock closes, and proof this suite detects it.
 *   4. Wall-clock races through the real code path (independent finalizers,
 *      overlapping sessions, duplicate drains) converge to exactly-once.
 */
import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { rate, rating } from 'openskill';
import {
	finalizeMatchUnserialized,
	type FinalizeMatchSession,
	type FinalizeStateInputs
} from './matchFinalize';
import type { PlayDbClient } from './commit';

const MIGRATION_PATH = fileURLToPath(
	new URL('../../../../supabase/migrations/20260710_ranked_finalize.sql', import.meta.url)
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
// open spawnSync's stdio pipes and take the whole test runner down with it. Errors
// are diagnosed from the server log file instead.
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

async function bootCluster(): Promise<void> {
	dataDir = mkdtempSync(join(tmpdir(), 'arc-ranked-pg-'));
	run('initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres']);
	// Unix socket only (no TCP port to collide on); socket dir = data dir.
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

	// The environment the migration expects: the schema, the service_role grantee,
	// and the members table finalize reads standings from.
	await pool.query(`
		do $$ begin
			if not exists (select 1 from pg_roles where rolname = 'service_role') then
				create role service_role;
			end if;
		end $$;
		create schema if not exists arc_spirits_2d;
		create table arc_spirits_2d.play_session_members (
			id uuid primary key,
			session_id uuid not null,
			user_id uuid,
			display_name text,
			is_bot boolean not null default false
		);
		-- The command ledger: ranked finalize PROVES transcript integrity from it and
		-- DEFERS when it cannot (see the migration-order test below).
		create table arc_spirits_2d.play_game_session_events (
			id bigint generated always as identity primary key,
			session_id uuid not null,
			revision integer not null default 0,
			actor_member_id uuid,
			command_type text not null,
			command_payload jsonb,
			created_at timestamptz not null default now()
		);
	`);

	// HAND-CREATED legacy posture: two of the four ranked tables pre-exist WITHOUT
	// the auxiliary columns (the live tables were only ever created by hand — no
	// earlier migration defined them). `create table if not exists` must not be
	// trusted to fix them; the migration's add-column hardening must.
	await pool.query(`
		create table arc_spirits_2d.match_results (
			id uuid primary key default gen_random_uuid(),
			session_id uuid not null,
			game_id text,
			mode text not null default 'casual',
			ranked boolean not null default false,
			rated boolean not null default false,
			winner_seat text,
			player_count integer not null default 0,
			started_at timestamptz,
			ended_at timestamptz
		);
		create table arc_spirits_2d.player_ratings (
			user_id uuid primary key,
			display_name text,
			mu double precision not null,
			sigma double precision not null,
			games_played integer not null default 0,
			last_session_id uuid
		);
	`);

	const migration = readFileSync(MIGRATION_PATH, 'utf8');
	await pool.query(migration);
	await pool.query(migration); // idempotency: a re-apply must be a clean no-op
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

// ── a real-wire PlayDbClient over node-postgres ─────────────────────────────────
// Minimal but honest: only the surface matchFinalize actually uses (filtered
// selects + the finalize_match RPC). Anything else throws loudly.

const SCHEMA = 'arc_spirits_2d';

function pgAdapter(db: pg.Pool | pg.ClientBase): PlayDbClient {
	return {
		from(table: string) {
			const filters: { sql: string; value: unknown }[] = [];
			let columns = '*';
			let limitCount: number | null = null;
			let single = false;
			const builder = {
				select(cols: string) {
					columns = cols;
					return builder;
				},
				eq(key: string, value: unknown) {
					filters.push({ sql: `${key} = $`, value });
					return builder;
				},
				in(key: string, values: unknown[]) {
					filters.push({ sql: `${key} = any($`, value: values });
					return builder;
				},
				limit(count: number) {
					limitCount = count;
					return builder;
				},
				maybeSingle() {
					single = true;
					return builder;
				},
				then(onfulfilled: (v: unknown) => unknown, onrejected?: (e: unknown) => unknown) {
					const where = filters
						.map((f, i) => f.sql.replace('$', `$${i + 1}`) + (f.sql.includes('any') ? ')' : ''))
						.join(' and ');
					const sql =
						`select ${columns} from ${SCHEMA}.${table}` +
						(where ? ` where ${where}` : '') +
						(limitCount != null ? ` limit ${limitCount}` : '');
					return db
						.query(
							sql,
							filters.map((f) => f.value)
						)
						.then(
							(res) => ({
								data: single ? (res.rows[0] ?? null) : res.rows,
								error: null
							}),
							(err) => ({
								data: null,
								error: { code: (err as { code?: string }).code, message: (err as Error).message }
							})
						)
						.then(onfulfilled, onrejected);
				}
			};
			return builder;
		},
		rpc(fn: string, args: Record<string, unknown>) {
			if (fn !== 'finalize_match') {
				return Promise.resolve({
					data: null,
					error: { code: 'PGRST202', message: `function ${fn} not found in schema cache` }
				});
			}
			return db
				.query(
					`select ${SCHEMA}.finalize_match($1::uuid, $2::jsonb, $3::jsonb, $4::jsonb) as res`,
					[
						args.p_session_id,
						JSON.stringify(args.p_result ?? {}),
						JSON.stringify(args.p_players ?? []),
						JSON.stringify(args.p_ratings ?? [])
					]
				)
				.then(
					(res) => ({ data: res.rows[0]?.res ?? null, error: null }),
					(err) => ({
						data: null,
						error: { code: (err as { code?: string }).code, message: (err as Error).message }
					})
				);
		}
	};
}

// ── fixtures ────────────────────────────────────────────────────────────────────

interface SeededSession {
	session: FinalizeMatchSession;
	state: FinalizeStateInputs;
	users: { red: string; blue: string };
}

/** Seed one two-seat ranked session (Red beats Blue) with real uuid identities. */
async function seedSession(users: { red: string; blue: string }): Promise<SeededSession> {
	const sessionId = randomUUID();
	const memberRed = randomUUID();
	const memberBlue = randomUUID();
	await pool.query(
		`insert into ${SCHEMA}.play_session_members (id, session_id, user_id, display_name) values
			($1, $3, $4, 'Red player'), ($2, $3, $5, 'Blue player')`,
		[memberRed, memberBlue, sessionId, users.red, users.blue]
	);
	return {
		session: {
			id: sessionId,
			game_id: `game-${sessionId.slice(0, 8)}`,
			mode: 'ranked',
			started_at: '2026-07-10T11:00:00.000Z',
			ended_at: '2026-07-10T12:00:00.000Z'
		},
		state: {
			winnerSeat: 'Red',
			round: 7,
			activeSeats: ['Red', 'Blue'],
			seats: {
				Red: { memberId: memberRed, displayName: 'Red player' },
				Blue: { memberId: memberBlue, displayName: 'Blue player' }
			},
			players: { Red: { victoryPoints: 30 }, Blue: { victoryPoints: 22 } }
		},
		users
	};
}

/** The p_ratings payload a caller computes when it sees NO rating rows (both users
 *  unrated) — the exact input of the absent-base race. */
function absentBasePayload(users: { id: string; placement: number }[]) {
	const before = users.map(() => rating());
	const updated = rate(
		before.map((r) => [r]),
		{ rank: users.map((u) => u.placement) }
	);
	return users.map((u, i) => ({
		user_id: u.id,
		display_name: null,
		placement: u.placement,
		mu_before: before[i].mu,
		sigma_before: before[i].sigma,
		mu_after: updated[i][0].mu,
		sigma_after: updated[i][0].sigma,
		expected_mu: null,
		expected_sigma: null,
		expected_games: null,
		last_game_at: '2026-07-10T12:00:00.000Z',
		rating_version: 1
	}));
}

function callFinalize(
	client: pg.ClientBase,
	sessionId: string,
	ratings: unknown[]
): Promise<pg.QueryResult> {
	return client.query(
		`select ${SCHEMA}.finalize_match($1::uuid, $2::jsonb, $3::jsonb, $4::jsonb) as res`,
		[sessionId, JSON.stringify({ mode: 'ranked', ranked: true }), '[]', JSON.stringify(ratings)]
	);
}

/** Whether a promise settles (either way) within ms — the "did it block?" probe. */
function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
	return Promise.race([
		p.then(
			() => true,
			() => true
		),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))
	]);
}

/** Deterministic schedule control: wait (via pg_stat_activity) until some backend
 *  executing `functionName` is genuinely WAITING ON A LOCK. Without this the
 *  "loser" query might not have started executing before the winner commits, and
 *  the test would pass without ever exercising the contended schedule. */
async function waitUntilBlocked(functionName: string): Promise<void> {
	for (let i = 0; i < 100; i += 1) {
		const res = await pool.query(
			`select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like $1`,
			[`%${functionName}%`]
		);
		if (res.rows.length > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`no backend running ${functionName} ever blocked on a lock`);
}

async function ratingRow(userId: string) {
	const res = await pool.query(`select * from ${SCHEMA}.player_ratings where user_id = $1`, [
		userId
	]);
	return res.rows[0] ?? null;
}

async function openClient(): Promise<pg.Client> {
	const client = new pg.Client({ host: dataDir, user: 'postgres', database: 'postgres' });
	await client.connect();
	await client.query(`set statement_timeout = '20s'`);
	return client;
}

// ── the suite ───────────────────────────────────────────────────────────────────

describe.skipIf(!HAVE_PG)('finalize_match against real PostgreSQL', () => {
	test('migration hardening: hand-created tables gained the missing columns', async () => {
		const cols = await pool.query(
			`select table_name, column_name from information_schema.columns
			 where table_schema = $1 and table_name in ('match_results', 'player_ratings')`,
			[SCHEMA]
		);
		const names = new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
		// Absent from the hand-created shape above; owed to the migration's ALTERs.
		for (const required of [
			'match_results.navigation_count',
			'match_results.rating_version',
			'match_results.created_at',
			'player_ratings.last_game_at',
			'player_ratings.rating_version',
			'player_ratings.bot_profile',
			'player_ratings.updated_at'
		]) {
			expect(names, `missing ${required}`).toContain(required);
		}
	});

	test('baseline: a ranked finish through the real code path records everything exactly once', async () => {
		const s = await seedSession({ red: randomUUID(), blue: randomUUID() });
		expect(await finalizeMatchUnserialized(pgAdapter(pool), s.session, s.state)).toBe(true);

		const anchors = await pool.query(
			`select * from ${SCHEMA}.match_results where session_id = $1`,
			[s.session.id]
		);
		expect(anchors.rows).toHaveLength(1);
		expect(anchors.rows[0].rated).toBe(true);
		expect(anchors.rows[0].ended_at.toISOString()).toBe('2026-07-10T12:00:00.000Z');
		const red = await ratingRow(s.users.red);
		const blue = await ratingRow(s.users.blue);
		expect(red.games_played).toBe(1);
		expect(blue.games_played).toBe(1);
		expect(red.mu).toBeGreaterThan(blue.mu);
		const players = await pool.query(
			`select * from ${SCHEMA}.match_result_players where session_id = $1`,
			[s.session.id]
		);
		expect(players.rows).toHaveLength(2);
	});

	test('P0 forced schedule — UNRATED shared user: the second finalize blocks at the advisory lock, gets stale_ratings, and the retry converges', async () => {
		const shared = randomUUID();
		const a = await seedSession({ red: shared, blue: randomUUID() });
		const b = await seedSession({ red: shared, blue: randomUUID() });

		const conn1 = await openClient();
		const conn2 = await openClient();
		try {
			// Both callers computed their payloads from the ABSENT base — the exact
			// two-first-ever-matches race. conn1's transaction applies but stays open.
			await conn1.query('begin');
			const res1 = await callFinalize(
				conn1,
				a.session.id,
				absentBasePayload([
					{ id: shared, placement: 1 },
					{ id: a.users.blue, placement: 2 }
				])
			);
			expect(res1.rows[0].res.outcome).toBe('finalized');

			// conn2 must BLOCK before validating bases (advisory lock) — there is no
			// row yet, so nothing else could fence it.
			await conn2.query('begin');
			const blocked = callFinalize(
				conn2,
				b.session.id,
				absentBasePayload([
					{ id: shared, placement: 1 },
					{ id: b.users.blue, placement: 2 }
				])
			);
			await waitUntilBlocked('finalize_match'); // genuinely executing AND lock-waiting
			expect(await settledWithin(blocked, 100)).toBe(false);

			// Winner commits ⇒ the blocked transaction sees the now-current row and
			// must refuse its stale absent-base computation outright.
			await conn1.query('commit');
			await expect(blocked).rejects.toThrow(/stale_ratings/);
			await conn2.query('rollback');

			// Exactly one match applied so far; nothing lost, nothing doubled.
			expect((await ratingRow(shared)).games_played).toBe(1);

			// The real caller-level retry re-reads the committed base and converges.
			expect(await finalizeMatchUnserialized(pgAdapter(pool), b.session, b.state)).toBe(true);
		} finally {
			await conn1.end().catch(() => {});
			await conn2.end().catch(() => {});
		}

		const sharedRow = await ratingRow(shared);
		expect(sharedRow.games_played).toBe(2); // BOTH first-ever matches counted
		const events = await pool.query(
			`select * from ${SCHEMA}.player_rating_events where user_id = $1 order by created_at`,
			[shared]
		);
		expect(events.rows).toHaveLength(2);
		// Contiguous chain: the retry computed FROM the winner's committed rating.
		const chained =
			events.rows[0].mu_after === events.rows[1].mu_before ||
			events.rows[1].mu_after === events.rows[0].mu_before;
		expect(chained).toBe(true);
		const anchors = await pool.query(
			`select session_id from ${SCHEMA}.match_results where session_id = any($1)`,
			[[a.session.id, b.session.id]]
		);
		expect(anchors.rows).toHaveLength(2);
	});

	test('P0 forced schedule — ALREADY-RATED shared user: same fence, same convergence', async () => {
		const shared = randomUUID();
		await pool.query(
			`insert into ${SCHEMA}.player_ratings (user_id, mu, sigma, games_played) values ($1, 26.5, 7.5, 5)`,
			[shared]
		);
		const a = await seedSession({ red: shared, blue: randomUUID() });
		const b = await seedSession({ red: shared, blue: randomUUID() });

		const basePayload = (opponent: string) => {
			const before = [rating({ mu: 26.5, sigma: 7.5 }), rating()];
			const updated = rate(
				before.map((r) => [r]),
				{ rank: [1, 2] }
			);
			return [
				{
					user_id: shared,
					display_name: null,
					placement: 1,
					mu_before: before[0].mu,
					sigma_before: before[0].sigma,
					mu_after: updated[0][0].mu,
					sigma_after: updated[0][0].sigma,
					expected_mu: 26.5,
					expected_sigma: 7.5,
					expected_games: 5,
					last_game_at: '2026-07-10T12:00:00.000Z',
					rating_version: 1
				},
				{
					user_id: opponent,
					display_name: null,
					placement: 2,
					mu_before: before[1].mu,
					sigma_before: before[1].sigma,
					mu_after: updated[1][0].mu,
					sigma_after: updated[1][0].sigma,
					expected_mu: null,
					expected_sigma: null,
					expected_games: null,
					last_game_at: '2026-07-10T12:00:00.000Z',
					rating_version: 1
				}
			];
		};

		const conn1 = await openClient();
		const conn2 = await openClient();
		try {
			await conn1.query('begin');
			const res1 = await callFinalize(conn1, a.session.id, basePayload(a.users.blue));
			expect(res1.rows[0].res.outcome).toBe('finalized');

			await conn2.query('begin');
			const blocked = callFinalize(conn2, b.session.id, basePayload(b.users.blue));
			await waitUntilBlocked('finalize_match');
			expect(await settledWithin(blocked, 100)).toBe(false);

			await conn1.query('commit');
			await expect(blocked).rejects.toThrow(/stale_ratings/);
			await conn2.query('rollback');

			expect(await finalizeMatchUnserialized(pgAdapter(pool), b.session, b.state)).toBe(true);
		} finally {
			await conn1.end().catch(() => {});
			await conn2.end().catch(() => {});
		}

		expect((await ratingRow(shared)).games_played).toBe(7); // 5 + one per session
		const events = await pool.query(
			`select * from ${SCHEMA}.player_rating_events where user_id = $1`,
			[shared]
		);
		expect(events.rows).toHaveLength(2);
	});

	test('NEGATIVE CONTROL — FOR UPDATE + verification WITHOUT the advisory lock loses a match on this exact schedule (the pre-fix defect)', async () => {
		// Distilled replica of the pre-fix locking strategy: lock existing rows,
		// verify bases, upsert. No advisory lock ⇒ an ABSENT row cannot be fenced.
		await pool.query(`
			create or replace function ${SCHEMA}.finalize_ratings_nolock(p_session_id uuid, p_ratings jsonb)
			returns void language plpgsql as $fn$
			declare
				v_rating jsonb;
				v_row ${SCHEMA}.player_ratings%rowtype;
				v_found boolean;
				v_expected_games integer;
			begin
				for v_rating in select value from jsonb_array_elements(p_ratings) order by value->>'user_id' loop
					select * into v_row from ${SCHEMA}.player_ratings
						where user_id = (v_rating->>'user_id')::uuid for update;
					v_found := found;
					v_expected_games := (v_rating->>'expected_games')::integer;
					if v_expected_games is null then
						if v_found then raise exception 'stale_ratings'; end if;
					elsif not v_found or v_row.games_played is distinct from v_expected_games then
						raise exception 'stale_ratings';
					end if;
				end loop;
				insert into ${SCHEMA}.player_ratings (user_id, display_name, mu, sigma, games_played, last_session_id, updated_at)
				select (r->>'user_id')::uuid, r->>'display_name',
					(r->>'mu_after')::double precision, (r->>'sigma_after')::double precision,
					coalesce((r->>'expected_games')::integer, 0) + 1, p_session_id, now()
				from jsonb_array_elements(p_ratings) r
				on conflict (user_id) do update set
					mu = excluded.mu, sigma = excluded.sigma, games_played = excluded.games_played,
					last_session_id = excluded.last_session_id, updated_at = excluded.updated_at;
			end $fn$;
		`);

		const shared = randomUUID();
		const oppA = randomUUID();
		const oppB = randomUUID();
		const sessionA = randomUUID();
		const sessionB = randomUUID();
		const payload = (opp: string) =>
			absentBasePayload([
				{ id: shared, placement: 1 },
				{ id: opp, placement: 2 }
			]);

		const conn1 = await openClient();
		const conn2 = await openClient();
		try {
			await conn1.query('begin');
			await conn1.query(`select ${SCHEMA}.finalize_ratings_nolock($1::uuid, $2::jsonb)`, [
				sessionA,
				JSON.stringify(payload(oppA))
			]);
			await conn2.query('begin');
			// BOTH transactions validated the absent base — verification did NOT block
			// (nothing to FOR UPDATE); conn2 only queues at write time, on the unique index.
			const second = conn2.query(`select ${SCHEMA}.finalize_ratings_nolock($1::uuid, $2::jsonb)`, [
				sessionB,
				JSON.stringify(payload(oppB))
			]);
			// Wait until conn2 is genuinely PAST verification and queued at the write —
			// only then is the defective schedule (both validated the absent base) locked in.
			await waitUntilBlocked('finalize_ratings_nolock');
			await conn1.query('commit');
			await second; // ON CONFLICT resolves to DO UPDATE — no error, silent overwrite
			await conn2.query('commit');
		} finally {
			await conn1.end().catch(() => {});
			await conn2.end().catch(() => {});
		}

		const row = await ratingRow(shared);
		// THE DEFECT, demonstrated on real PostgreSQL: two first-ever matches, but the
		// user's record shows ONE — session B overwrote session A's application.
		expect(row.games_played).toBe(1);
		expect(row.last_session_id).toBe(sessionB);

		await pool.query(`drop function ${SCHEMA}.finalize_ratings_nolock(uuid, jsonb)`);
		await pool.query(`delete from ${SCHEMA}.player_ratings where user_id = any($1)`, [
			[shared, oppA, oppB]
		]);
	});

	test('MIGRATION ORDER: without the ledger relation a ranked finalize DEFERS (no anchor, no ratings); it converges once the ledger exists', async () => {
		const s = await seedSession({ red: randomUUID(), blue: randomUUID() });
		await pool.query(
			`alter table ${SCHEMA}.play_game_session_events rename to play_game_session_events_missing`
		);
		try {
			// Transcript integrity cannot be PROVEN ⇒ fail closed: defer, rate nobody.
			expect(await finalizeMatchUnserialized(pgAdapter(pool), s.session, s.state)).toBe(false);
			const anchors = await pool.query(
				`select * from ${SCHEMA}.match_results where session_id = $1`,
				[s.session.id]
			);
			expect(anchors.rows).toHaveLength(0);
			expect(await ratingRow(s.users.red)).toBeNull();
			expect(await ratingRow(s.users.blue)).toBeNull();

			// Durable retry: the same call keeps deferring while the ledger is absent.
			expect(await finalizeMatchUnserialized(pgAdapter(pool), s.session, s.state)).toBe(false);
		} finally {
			await pool.query(
				`alter table ${SCHEMA}.play_game_session_events_missing rename to play_game_session_events`
			);
		}
		// The ledger arrived (migration applied): the retained outbox retry now lands.
		expect(await finalizeMatchUnserialized(pgAdapter(pool), s.session, s.state)).toBe(true);
		expect((await ratingRow(s.users.red)).games_played).toBe(1);
	});

	test('DB ERROR during the transcript scan defers rather than rating an unverified game', async () => {
		const s = await seedSession({ red: randomUUID(), blue: randomUUID() });
		// A broad does-not-exist failure that is NOT a missing relation: a column the
		// scan needs is gone. Pre-fix this string-matched into "clean transcript".
		await pool.query(
			`alter table ${SCHEMA}.play_game_session_events rename column command_type to command_type_gone`
		);
		try {
			expect(await finalizeMatchUnserialized(pgAdapter(pool), s.session, s.state)).toBe(false);
			expect(await ratingRow(s.users.red)).toBeNull();
		} finally {
			await pool.query(
				`alter table ${SCHEMA}.play_game_session_events rename column command_type_gone to command_type`
			);
		}
		expect(await finalizeMatchUnserialized(pgAdapter(pool), s.session, s.state)).toBe(true);
	});

	test('a rated transcript CONTAINING a forbidden command is quarantined: recorded, never rated', async () => {
		const s = await seedSession({ red: randomUUID(), blue: randomUUID() });
		await pool.query(
			`insert into ${SCHEMA}.play_game_session_events (session_id, command_type, command_payload)
			 values ($1, 'adjustVictoryPoints', '{"cmdId":"probe-1"}')`,
			[s.session.id]
		);
		expect(await finalizeMatchUnserialized(pgAdapter(pool), s.session, s.state)).toBe(true);
		const anchors = await pool.query(
			`select rated, quarantined from ${SCHEMA}.match_results where session_id = $1`,
			[s.session.id]
		);
		expect(anchors.rows).toHaveLength(1);
		expect(anchors.rows[0].quarantined).toBe(true);
		expect(anchors.rows[0].rated).toBe(false);
		expect(await ratingRow(s.users.red)).toBeNull(); // nobody's rating moved
	});

	test('wall-clock race: independent finalizers (overlapping sessions + duplicate drains) converge exactly-once through the real code path', async () => {
		const shared = randomUUID();
		const a = await seedSession({ red: shared, blue: randomUUID() });
		const b = await seedSession({ red: shared, blue: randomUUID() });

		// Two finalizers per session, all racing on independent pool connections.
		const results = await Promise.all([
			finalizeMatchUnserialized(pgAdapter(pool), a.session, a.state),
			finalizeMatchUnserialized(pgAdapter(pool), b.session, b.state),
			finalizeMatchUnserialized(pgAdapter(pool), a.session, a.state),
			finalizeMatchUnserialized(pgAdapter(pool), b.session, b.state)
		]);
		expect(results).toEqual([true, true, true, true]);

		expect((await ratingRow(shared)).games_played).toBe(2);
		for (const s of [a, b]) {
			const anchors = await pool.query(
				`select * from ${SCHEMA}.match_results where session_id = $1`,
				[s.session.id]
			);
			expect(anchors.rows).toHaveLength(1);
			const players = await pool.query(
				`select * from ${SCHEMA}.match_result_players where session_id = $1`,
				[s.session.id]
			);
			expect(players.rows).toHaveLength(2);
			const events = await pool.query(
				`select * from ${SCHEMA}.player_rating_events where session_id = $1`,
				[s.session.id]
			);
			expect(events.rows).toHaveLength(2);
		}
		const sharedEvents = await pool.query(
			`select * from ${SCHEMA}.player_rating_events where user_id = $1`,
			[shared]
		);
		expect(sharedEvents.rows).toHaveLength(2);
	});
});
