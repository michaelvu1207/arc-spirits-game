/** Real PostgreSQL acceptance for season pinning, exactly-once season results,
 * placement achievements/rewards, purchase denial, and private competitive state. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MIGRATIONS = ['20260710_ranked_finalize.sql', '20260713_progression_cosmetics.sql',
	'20260715_ranked_seasons_achievements.sql', '20260716_ranked_product_completion.sql',
	'20260717_ranked_disconnect_integrity.sql']
	.map((name) => join(ROOT, 'supabase/migrations', name));
const HAVE_PG = ['initdb', 'pg_ctl'].every((bin) => spawnSync('which', [bin]).status === 0);
let dataDir = '';
let pool: pg.Pool;

function run(cmd: string, args: string[]) {
	const result = spawnSync(cmd, args, { stdio: 'ignore' });
	if (result.status !== 0) throw new Error(`${cmd} failed (${String(result.status)})`);
}

beforeAll(async () => {
	if (!HAVE_PG) return;
	dataDir = mkdtempSync(join(tmpdir(), 'arc-seasons-pg-'));
	run('initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres']);
	run('pg_ctl', ['-D', dataDir, '-l', join(dataDir, 'server.log'), '-o', `-c listen_addresses='' -k ${dataDir}`, '-w', 'start']);
	pool = new pg.Pool({ host: dataDir, user: 'postgres', database: 'postgres' });
	await pool.query(`
		do $$ begin
			if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
			if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
			if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
		end $$;
		create schema auth; create table auth.users(id uuid primary key);
		create schema arc_spirits_2d; create schema arc_spirits_game;
		create table arc_spirits_2d.play_game_sessions(id uuid primary key,room_code text,game_id text,status text,mode text,
			ranked_season_id text,revision integer not null default 0,public_state jsonb not null default '{}'::jsonb);
		create table arc_spirits_2d.play_session_members(id uuid primary key,session_id uuid,user_id uuid,
			display_name text,seat_color text,is_bot boolean default false,selected_guardian text,bot_profile text,
			joined_at timestamptz default now(),updated_at timestamptz default now(),last_seen_at timestamptz default now());
		create table arc_spirits_2d.play_game_session_events(id bigserial primary key,session_id uuid,revision integer,
			actor_member_id uuid,command_type text,command_payload jsonb,created_at timestamptz default now());
		create table arc_spirits_2d.match_queue(user_id uuid primary key,status text,queued_at timestamptz);
	`);
	for (const migration of MIGRATIONS) await pool.query(readFileSync(migration, 'utf8'));
	for (const migration of MIGRATIONS.slice(2)) await pool.query(readFileSync(migration, 'utf8')); // idempotent re-apply
}, 120_000);

afterAll(async () => {
	if (!dataDir) return;
	await pool.end();
	spawnSync('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
	rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(!HAVE_PG)('ranked seasons and achievements migration', () => {
	test('applies five results exactly once, unlocks reward-only cosmetics, and protects private rows', async () => {
		const a = '11111111-1111-4111-8111-111111111111';
		const b = '22222222-2222-4222-8222-222222222222';
		await pool.query('insert into auth.users(id) values($1),($2)', [a, b]);
		let aMu = 25, bMu = 25, sigma = 25 / 3;
		for (let i = 1; i <= 5; i += 1) {
			const session = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
			await pool.query(`insert into arc_spirits_2d.match_results(session_id,mode,ranked,rated,quarantined)
				values($1,'ranked',true,true,false)`, [session]);
			const nextSigma = sigma - 0.2;
			const payload = [
				{ user_id: a, display_name: 'Aster', is_bot: false, placement: 1, mu_before: aMu,
					sigma_before: sigma, mu_after: aMu + 1, sigma_after: nextSigma,
					expected_mu: i === 1 ? null : aMu, expected_sigma: i === 1 ? null : sigma,
					expected_games: i === 1 ? null : i - 1 },
				{ user_id: b, display_name: 'Bramble', is_bot: false, placement: 2, mu_before: bMu,
					sigma_before: sigma, mu_after: bMu - 1, sigma_after: nextSigma,
					expected_mu: i === 1 ? null : bMu, expected_sigma: i === 1 ? null : sigma,
					expected_games: i === 1 ? null : i - 1 }
			];
			const applied = await pool.query(`select arc_spirits_2d.apply_ranked_season_result($1,$2,$3::jsonb) result`,
				[session, 'season-zero-2026', JSON.stringify(payload)]);
			expect(applied.rows[0].result.outcome).toBe('applied');
			if (i === 5) {
				const retry = await pool.query(`select arc_spirits_2d.apply_ranked_season_result($1,$2,$3::jsonb) result`,
					[session, 'season-zero-2026', JSON.stringify(payload)]);
				expect(retry.rows[0].result.outcome).toBe('already_applied');
			}
			aMu += 1; bMu -= 1; sigma = nextSigma;
		}
		const player = await pool.query(`select games_played,wins,placements_completed from arc_spirits_2d.ranked_player_seasons
			where season_id='season-zero-2026' and user_id=$1`, [a]);
		expect(player.rows[0]).toEqual({ games_played: 5, wins: 5, placements_completed: 5 });
		const achievements = await pool.query(`select achievement_id from arc_spirits_2d.player_achievements
			where user_id=$1 order by achievement_id`, [a]);
		expect(achievements.rows.map((row) => row.achievement_id)).toContain('placements-complete');
		const reward = await pool.query(`select source from arc_spirits_2d.player_cosmetic_ownership
			where user_id=$1 and item_id='border-ranked-first-light'`, [a]);
		expect(reward.rows[0].source).toBe('achievement');
		await expect(pool.query(`select arc_spirits_2d.purchase_cosmetic($1,'nameplate-ranked-gold')`, [b]))
			.rejects.toThrow(/cosmetic_not_found/);
		const live = '99999999-9999-4999-8999-999999999999';
		const member = '88888888-8888-4888-8888-888888888888';
		await pool.query(`insert into arc_spirits_2d.play_game_sessions(id,room_code,status,mode,ranked_season_id)
			values($1,'RANKED','active','ranked','season-zero-2026')`, [live]);
		await pool.query(`insert into arc_spirits_2d.play_session_members(id,session_id,user_id,display_name,is_bot)
			values($1,$2,$3,'Aster',false)`, [member, live, a]);
		const conceded = await pool.query(`select arc_spirits_2d.concede_ranked_member($1,$2) result`, [live, a]);
		expect(conceded.rows[0].result.conceded).toBe(true);
		const botControl = await pool.query(`select is_bot,bot_profile from arc_spirits_2d.play_session_members where id=$1`, [member]);
		expect(botControl.rows[0]).toEqual({ is_bot: true, bot_profile: 'neural-v1' });
		const participation = await pool.query(`select abandoned,abandonment_kind from arc_spirits_2d.ranked_participation where member_id=$1`, [member]);
		expect(participation.rows[0]).toEqual({ abandoned: true, abandonment_kind: 'concede' });

		const disconnectSession = '66666666-6666-4666-8666-666666666666';
		const staleMember = '66666666-6666-4666-8666-666666666661';
		const liveMember = '66666666-6666-4666-8666-666666666662';
		await pool.query(`insert into arc_spirits_2d.play_game_sessions(
			id,room_code,status,mode,ranked_season_id,revision,public_state
		) values($1,'DCONN1','active','ranked','season-zero-2026',7,'{"revision":7}')`, [disconnectSession]);
		await pool.query(`insert into arc_spirits_2d.play_session_members(
			id,session_id,user_id,display_name,is_bot,last_seen_at
		) values($1,$2,$3,'Aster',false,now()-interval '121 seconds'),
			($4,$2,$5,'Bramble',false,now())`, [staleMember, disconnectSession, a, liveMember, b]);
		const takeover = await pool.query(`select arc_spirits_2d.takeover_stale_ranked_members($1) result`, [disconnectSession]);
		expect(takeover.rows[0].result).toMatchObject({ takenOver: 1, revision: 8 });
		const takeoverState = await pool.query(`select revision,public_state->>'revision' state_revision
			from arc_spirits_2d.play_game_sessions where id=$1`, [disconnectSession]);
		expect(takeoverState.rows[0]).toEqual({ revision: 8, state_revision: '8' });
		const takeoverMembers = await pool.query(`select id,is_bot,bot_profile from arc_spirits_2d.play_session_members
			where session_id=$1 order by id`, [disconnectSession]);
		expect(takeoverMembers.rows).toEqual([
			{ id: staleMember, is_bot: true, bot_profile: 'neural-v1' },
			{ id: liveMember, is_bot: false, bot_profile: null }
		]);
		const disconnectParticipation = await pool.query(`select abandonment_kind from arc_spirits_2d.ranked_participation
			where session_id=$1 and member_id=$2`, [disconnectSession, staleMember]);
		expect(disconnectParticipation.rows[0].abandonment_kind).toBe('disconnect_deadline');
		const takeoverEvent = await pool.query(`select command_type,command_payload from arc_spirits_2d.play_game_session_events
			where session_id=$1`, [disconnectSession]);
		expect(takeoverEvent.rows[0]).toMatchObject({ command_type: 'rankedDisconnectTakeover',
			command_payload: { takenOver: 1, graceSeconds: 120 } });
		const takeoverRetry = await pool.query(`select arc_spirits_2d.takeover_stale_ranked_members($1) result`, [disconnectSession]);
		expect(takeoverRetry.rows[0].result.takenOver).toBe(0);
		await pool.query(`update arc_spirits_2d.play_session_members set last_seen_at=now()-interval '121 seconds'
			where id=$1`, [liveMember]);
		const allGone = await pool.query(`select arc_spirits_2d.takeover_stale_ranked_members($1) result`, [disconnectSession]);
		expect(allGone.rows[0].result).toMatchObject({ takenOver: 0, allHumansGone: true });
		const stillHuman = await pool.query(`select is_bot from arc_spirits_2d.play_session_members where id=$1`, [liveMember]);
		expect(stillHuman.rows[0].is_bot).toBe(false);
		const abandonedSession = '77777777-7777-4777-8777-777777777777';
		const abandonedMember = '77777777-7777-4777-8777-777777777778';
		await pool.query(`insert into arc_spirits_2d.play_game_sessions(id,room_code,game_id,status,mode,ranked_season_id)
			values($1,'ABANDN','game-abandon','active','ranked','season-zero-2026')`, [abandonedSession]);
		await pool.query(`insert into arc_spirits_2d.play_session_members(id,session_id,user_id,display_name,seat_color,is_bot)
			values($1,$2,$3,'Bramble','Blue',false)`, [abandonedMember, abandonedSession, b]);
		const abandoned = await pool.query(`select arc_spirits_2d.finalize_ranked_abandonment($1) result`, [abandonedSession]);
		expect(abandoned.rows[0].result).toMatchObject({ finalized: true, participants: 1 });
		const abandonmentEvent = await pool.query(`select event_kind from arc_spirits_2d.ranked_season_rating_events
			where session_id=$1 and user_id=$2`, [abandonedSession, b]);
		expect(abandonmentEvent.rows[0].event_kind).toBe('abandonment');

		await pool.query(`update arc_spirits_2d.ranked_player_seasons set last_activity_at=now()-interval '60 days'
			where season_id='season-zero-2026' and user_id=$1`, [a]);
		const beforeDecay = (await pool.query(`select sigma from arc_spirits_2d.ranked_player_seasons
			where season_id='season-zero-2026' and user_id=$1`, [a])).rows[0].sigma;
		const decay = await pool.query(`select arc_spirits_2d.apply_ranked_decay('season-zero-2026',$1) result`, [a]);
		expect(decay.rows[0].result.decayed).toBe(true);
		const decayRetry = await pool.query(`select arc_spirits_2d.apply_ranked_decay('season-zero-2026',$1) result`, [a]);
		expect(decayRetry.rows[0].result.decayed).toBe(false);
		const afterDecay = (await pool.query(`select sigma from arc_spirits_2d.ranked_player_seasons
			where season_id='season-zero-2026' and user_id=$1`, [a])).rows[0].sigma;
		expect(afterDecay).toBeGreaterThan(beforeDecay);

		const closed = await pool.query(`select arc_spirits_2d.close_ranked_season('season-zero-2026') result`);
		expect(closed.rows[0].result.closed).toBe(true);
		const frozen = await pool.query(`select leaderboard_position,division_key from arc_spirits_2d.ranked_season_snapshots
			where season_id='season-zero-2026' and user_id=$1`, [a]);
		expect(frozen.rows[0].leaderboard_position).toBeGreaterThan(0);
		await pool.query(`insert into arc_spirits_2d.ranked_seasons(id,name,status,starts_at,ends_at)
			values('season-one-2027','Season One','active','2027-01-01','2027-07-01')`);
		await pool.query(`insert into arc_spirits_2d.ranked_division_rules(season_id,division_key,label,tier_order,min_ordinal)
			select 'season-one-2027',division_key,label,tier_order,min_ordinal
			from arc_spirits_2d.ranked_division_rules where season_id='season-zero-2026'`);
		const reset = await pool.query(`select arc_spirits_2d.ensure_ranked_season_player('season-one-2027',$1,'Aster',false) result`, [a]);
		expect(reset.rows[0].result.reset).toBe(true);
		const resetRating = await pool.query(`select mu,sigma from arc_spirits_2d.ranked_player_seasons
			where season_id='season-one-2027' and user_id=$1`, [a]);
		expect(resetRating.rows[0].mu).toBeGreaterThan(25);
		expect(resetRating.rows[0].mu).toBeLessThan(aMu);
		const rolled = await pool.query(`select arc_spirits_2d.roll_ranked_season(
			'season-one-2027','season-two-2027','Season Two','2027-07-01','2028-01-01') result`);
		expect(rolled.rows[0].result).toMatchObject({ rolled: true, season_id: 'season-two-2027' });
		const rolledRetry = await pool.query(`select arc_spirits_2d.roll_ranked_season(
			'season-one-2027','season-two-2027','Season Two','2027-07-01','2028-01-01') result`);
		expect(rolledRetry.rows[0].result).toMatchObject({ rolled: false, already_active: true });
		const active = await pool.query(`select id from arc_spirits_2d.ranked_seasons where status='active'`);
		expect(active.rows.map((row) => row.id)).toEqual(['season-two-2027']);
		const copiedRules = await pool.query(`select count(*)::int count from arc_spirits_2d.ranked_division_rules
			where season_id='season-two-2027'`);
		expect(copiedRules.rows[0].count).toBe(6);

		const perms = await pool.query(`select
			has_table_privilege('authenticated','arc_spirits_2d.ranked_player_seasons','select') auth_read,
			has_table_privilege('service_role','arc_spirits_2d.ranked_player_seasons','select') service_read,
			(select relrowsecurity and relforcerowsecurity from pg_class where oid='arc_spirits_2d.ranked_player_seasons'::regclass) forced_rls`);
		expect(perms.rows[0]).toEqual({ auth_read: false, service_read: true, forced_rls: true });
	});
});
