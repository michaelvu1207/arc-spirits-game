/** Real PostgreSQL acceptance for live-social schema constraints and privacy. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATION = fileURLToPath(new URL('../../../../supabase/migrations/20260714_live_social.sql', import.meta.url));
const HAVE_PG = ['initdb', 'pg_ctl'].every((bin) => spawnSync('which', [bin]).status === 0);
let dataDir = '';
let pool: pg.Pool;

function run(cmd: string, args: string[]) {
	const result = spawnSync(cmd, args, { stdio: 'ignore' });
	if (result.status !== 0) throw new Error(`${cmd} failed (${String(result.status)})`);
}

beforeAll(async () => {
	if (!HAVE_PG) return;
	dataDir = mkdtempSync(join(tmpdir(), 'arc-social-pg-'));
	run('initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres']);
	run('pg_ctl', ['-D', dataDir, '-l', join(dataDir, 'server.log'), '-o', `-c listen_addresses='' -k ${dataDir}`, '-w', 'start']);
	pool = new pg.Pool({ host: dataDir, user: 'postgres', database: 'postgres' });
	await pool.query(`
		do $$ begin
			if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
			if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
			if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
		end $$;
		create schema auth;
		create table auth.users(id uuid primary key);
		create schema arc_spirits_2d;
	`);
	const sql = readFileSync(MIGRATION, 'utf8');
	await pool.query(sql);
	await pool.query(sql);
}, 120_000);

afterAll(async () => {
	if (!dataDir) return;
	await pool.end();
	spawnSync('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
	rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(!HAVE_PG)('live social migration', () => {
	test('is private, idempotent, account-owned, one-party-per-user, and multi-device-presence safe', async () => {
		const a = '11111111-1111-4111-8111-111111111111';
		const b = '22222222-2222-4222-8222-222222222222';
		const c = '33333333-3333-4333-8333-333333333333';
		const d = '44444444-4444-4444-8444-444444444444';
		const e = '55555555-5555-4555-8555-555555555555';
		const f = '66666666-6666-4666-8666-666666666666';
		await pool.query(`insert into auth.users(id) values ($1),($2),($3),($4),($5),($6)`, [a, b, c, d, e, f]);
		const p1 = (await pool.query(`insert into arc_spirits_2d.social_parties(owner_user_id) values ($1) returning id`, [a])).rows[0].id;
		const p2 = (await pool.query(`insert into arc_spirits_2d.social_parties(owner_user_id) values ($1) returning id`, [b])).rows[0].id;
		await pool.query(`insert into arc_spirits_2d.social_party_members(party_id,user_id,role) values ($1,$2,'owner')`, [p1, a]);
		await expect(pool.query(`insert into arc_spirits_2d.social_party_members(party_id,user_id) values ($1,$2)`, [p2, a]))
			.rejects.toMatchObject({ code: '23505' });
		await pool.query(`insert into arc_spirits_2d.social_party_members(party_id,user_id,role) values ($1,$2,'owner'),($1,$3,'member'),($1,$4,'member'),($1,$5,'member')`, [p2, b, c, d, e]);
		await expect(pool.query(`insert into arc_spirits_2d.social_party_members(party_id,user_id) values ($1,$2)`, [p2, f]))
			.rejects.toMatchObject({ code: '23514' });
		await pool.query(`
			insert into arc_spirits_2d.social_presence(user_id,client_id,state,platform,expires_at)
			values ($1,'browser-0001','online','web',now()+interval '90 seconds'),
			       ($1,'iphone-00001','in_game','ios',now()+interval '90 seconds')
		`, [a]);
		const sessions = await pool.query(`select count(*)::int as count from arc_spirits_2d.social_presence where user_id=$1`, [a]);
		expect(sessions.rows[0].count).toBe(2);

		const perms = await pool.query(`select
			has_table_privilege('anon','arc_spirits_2d.social_friendships','select') as anon_read,
			has_table_privilege('authenticated','arc_spirits_2d.social_presence','select') as auth_read,
			has_table_privilege('service_role','arc_spirits_2d.social_presence','select') as service_read,
			(select relrowsecurity and relforcerowsecurity from pg_class where oid='arc_spirits_2d.social_presence'::regclass) as forced_rls`);
		expect(perms.rows[0]).toEqual({ anon_read: false, auth_read: false, service_read: true, forced_rls: true });
		await pool.query('begin');
		await pool.query('set local role service_role');
		await expect(pool.query(`select count(*) from arc_spirits_2d.social_presence`)).resolves.toBeDefined();
		await pool.query('rollback');

		await pool.query(`delete from auth.users where id=$1`, [a]);
		const cascaded = await pool.query(`select
			(select count(*)::int from arc_spirits_2d.social_party_members where user_id=$1) as memberships,
			(select count(*)::int from arc_spirits_2d.social_presence where user_id=$1) as presence`, [a]);
		expect(cascaded.rows[0]).toEqual({ memberships: 0, presence: 0 });
	});
});
