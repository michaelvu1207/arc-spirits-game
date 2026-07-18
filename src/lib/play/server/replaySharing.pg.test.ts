/** Real-PostgreSQL acceptance for the replay-share capability table. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATION = fileURLToPath(new URL('../../../../supabase/migrations/20260713_replay_sharing.sql', import.meta.url));
const HAVE_PG = ['initdb', 'pg_ctl'].every((bin) => spawnSync('which', [bin]).status === 0);
let dataDir = '';
let pool: pg.Pool;

function run(cmd: string, args: string[]) {
	const result = spawnSync(cmd, args, { stdio: 'ignore' });
	if (result.status !== 0) throw new Error(`${cmd} failed with status ${String(result.status)}`);
}

beforeAll(async () => {
	if (!HAVE_PG) return;
	dataDir = mkdtempSync(join(tmpdir(), 'arc-replay-pg-'));
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
		create schema arc_spirits_game;
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

describe.skipIf(!HAVE_PG)('replay sharing migration', () => {
	test('is idempotent, service-only, stable per owner/game, and rejects invalid visibility', async () => {
		const user = '11111111-1111-4111-8111-111111111111';
		await pool.query(`insert into auth.users(id) values ($1)`, [user]);
		await pool.query(
			`insert into arc_spirits_game.replay_shares(code, game_id, owner_user_id)
			 values ($1, $2, $3)`,
			['AAAAAAAAAAAAAAAA', 'game-1', user]
		);
		await expect(pool.query(
			`insert into arc_spirits_game.replay_shares(code, game_id, owner_user_id)
			 values ($1, $2, $3)`,
			['BBBBBBBBBBBBBBBB', 'game-1', user]
		)).rejects.toMatchObject({ code: '23505' });
		await expect(pool.query(
			`insert into arc_spirits_game.replay_shares(code, game_id, owner_user_id, visibility)
			 values ($1, $2, $3, 'unlisted')`,
			['CCCCCCCCCCCCCCCC', 'game-2', user]
		)).rejects.toMatchObject({ code: '23514' });
		const permissions = await pool.query(`
			select
				has_schema_privilege('service_role', 'arc_spirits_game', 'usage') as schema_usage,
				has_table_privilege('anon', 'arc_spirits_game.replay_shares', 'select') as anon_read,
				has_table_privilege('authenticated', 'arc_spirits_game.replay_shares', 'select') as auth_read,
				has_table_privilege('service_role', 'arc_spirits_game.replay_shares', 'select') as service_read,
				has_table_privilege('service_role', 'arc_spirits_game.replay_frames', 'insert') as frame_write
		`);
		expect(permissions.rows[0]).toEqual({
			schema_usage: true, anon_read: false, auth_read: false, service_read: true, frame_write: true
		});
		await pool.query('begin');
		await pool.query('set local role service_role');
		await expect(pool.query(`select count(*) from arc_spirits_game.replay_shares`)).resolves.toBeDefined();
		await pool.query('rollback');

		await pool.query(`delete from auth.users where id = $1`, [user]);
		const orphan = await pool.query(`select count(*)::int as count from arc_spirits_game.replay_shares where owner_user_id = $1`, [user]);
		expect(orphan.rows[0].count).toBe(0);
	});
});
