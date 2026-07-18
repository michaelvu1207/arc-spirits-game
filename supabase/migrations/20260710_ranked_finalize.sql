-- Ranked finalize: cross-process exactly-once terminal match/rating effects.
--
-- Context (2026-07-10 multiplayer-authority batch, follow-up P0): the finished-game
-- side effect (matchFinalize.ts) used to run read-ratings → upsert-ratings →
-- insert-rating-events → insert-match_results → insert-match_result_players as FIVE
-- separate statements, guarded only by a check-then-insert on match_results and an
-- in-process promise map. A crash between any two statements, or two independent
-- drains of the durable effects outbox (recovery worker, second server instance,
-- duplicate-retry handling), could rerun the match: games_played and mu/sigma
-- applied twice, duplicate rating events / result / player rows. This migration
-- makes exactly-once STRUCTURAL:
--
--   1. the ranked result/rating tables are defined here (create if not exists — they
--      may already exist in a live project, created by hand) together with the unique
--      constraints the protocol is anchored on:
--        match_results          UNIQUE (session_id)          — the finalize claim
--        match_result_players   UNIQUE (session_id, seat_color)
--        player_rating_events   UNIQUE (session_id, user_id) — one event per player/match
--        player_ratings         UNIQUE (user_id)             — the upsert key
--      Pre-existing duplicate rows (possible under the old check-then-insert) are
--      deduplicated keeping the earliest row before each index is created.
--   2. `finalize_match(...)` — ONE transaction that (a) claims the session via the
--      match_results unique key (an existing anchor answers 'already_finalized' and
--      only repairs missing player rows — it NEVER re-touches ratings), (b) takes a
--      TRANSACTION-SCOPED ADVISORY LOCK per rated user (deterministic user_id order)
--      BEFORE reading or verifying any rating base — FOR UPDATE alone cannot fence a
--      row that does not exist yet, so without this two first-ever ranked matches
--      sharing a previously UNRATED user could both validate the absent base and the
--      second ON CONFLICT upsert would overwrite the first (games_played stuck at 1,
--      one match's rating lost); the advisory lock serializes same-user finalizes
--      structurally, absent rows included — then (c) locks the existing target
--      player_ratings rows (FOR UPDATE, same order — a belt-and-braces fence against
--      direct writers such as scripts/seed-bots.mjs that do not take the advisory
--      lock) and verifies the caller's rating computation was based on the CURRENT
--      rows (games_played exact, mu/sigma within 1e-4, and "no row" only if there is
--      STILL no row) — a mismatch raises `stale_ratings` and rolls EVERYTHING back so
--      the caller re-reads and recomputes, which is what serializes two different
--      sessions rating the same user, and (d) applies the rating upsert + event
--      inserts + anchor + player rows atomically. A crash at any point is a full
--      rollback: there is no partially-finalized state, ever.
--   3. partial states left by the OLD non-atomic finalizer are detected and never
--      re-applied: existing player_rating_events for the session, or a locked
--      player_ratings row already carrying last_session_id = this session, mean the
--      ratings landed in a prior attempt — the function then records the anchor and
--      player rows with rated=true and does NOT touch ratings again (if the old
--      crash lost the event rows, they are unrecoverable — mu_before is gone — and
--      are intentionally left missing rather than fabricated).
--   4. replay_codes (history schema arc_spirits_game) gets a UNIQUE
--      (game_id, navigation_count) index — its check-then-insert used to permit two
--      concurrent drains to mint two codes for one round; the code path now treats a
--      unique violation as "another writer won" and returns the existing code.
--
-- ORDERING: apply together with (or after) 20260710_command_ledger.sql, BEFORE
-- serving live ranked traffic. The application FAILS CLOSED without it: the ranked
-- finalize effect refuses to run (store_not_ready — the durable effects-outbox row
-- is retained and retried, game flow is unaffected) rather than degrade to the
-- non-atomic sequence. That legacy sequence remains available ONLY behind the
-- explicit local/test opt-in ARC_ALLOW_NONATOMIC_COMMIT=1.
--
-- RLS/grants: deliberately NOT touched here for pre-existing tables (a live project
-- already has its leaderboard read policies configured; enabling RLS blindly would
-- break anon leaderboard reads). Fresh installs should configure policies to match
-- their exposure (service_role is the only writer either way).

-- ── 1. tables + constraints ─────────────────────────────────────────────────────

create table if not exists arc_spirits_2d.match_results (
	id uuid primary key default gen_random_uuid(),
	session_id uuid not null,
	game_id text,
	mode text not null default 'casual',
	ranked boolean not null default false,
	rated boolean not null default false,
	quarantined boolean not null default false,
	winner_seat text,
	player_count integer not null default 0,
	navigation_count integer not null default 0,
	started_at timestamptz,
	ended_at timestamptz,
	rating_version integer not null default 1,
	created_at timestamptz not null default now()
);

create table if not exists arc_spirits_2d.match_result_players (
	id uuid primary key default gen_random_uuid(),
	session_id uuid not null,
	seat_color text not null,
	member_id uuid,
	user_id uuid,
	display_name text,
	is_bot boolean not null default false,
	victory_points integer not null default 0,
	placement integer not null default 0,
	created_at timestamptz not null default now()
);

create table if not exists arc_spirits_2d.player_ratings (
	user_id uuid primary key,
	display_name text,
	mu double precision not null,
	sigma double precision not null,
	games_played integer not null default 0,
	last_session_id uuid,
	last_game_at timestamptz,
	rating_version integer not null default 1,
	-- Non-null only for matchmaking-backfill bot accounts (see scripts/seed-bots.mjs).
	bot_profile text,
	updated_at timestamptz not null default now()
);

create table if not exists arc_spirits_2d.player_rating_events (
	id uuid primary key default gen_random_uuid(),
	session_id uuid not null,
	user_id uuid not null,
	placement integer not null,
	mu_before double precision not null,
	sigma_before double precision not null,
	mu_after double precision not null,
	sigma_after double precision not null,
	rating_version integer not null default 1,
	created_at timestamptz not null default now()
);

-- COMPATIBILITY: these four tables were historically created BY HAND in live
-- projects (no earlier migration ever defined them), so `create table if not exists`
-- above silently no-ops there and cannot be trusted to leave the exact shape
-- finalize_match reads/writes. Add every non-key column explicitly (no-ops on a
-- fresh install and on a complete hand-made table). Deliberately NOT added here:
-- the identity/key columns (session_id, user_id, seat_color — a "table" missing
-- those was never one of these tables) and the not-null-no-default rating numerics
-- (mu, sigma, mu_before/after, sigma_before/after — every writer since the feature
-- shipped has supplied them, so a functioning table has them, and fabricating a
-- default rating for existing rows would be worse than failing loudly).

alter table arc_spirits_2d.match_results
	add column if not exists game_id text,
	add column if not exists mode text not null default 'casual',
	add column if not exists ranked boolean not null default false,
	add column if not exists rated boolean not null default false,
	add column if not exists quarantined boolean not null default false,
	add column if not exists winner_seat text,
	add column if not exists player_count integer not null default 0,
	add column if not exists navigation_count integer not null default 0,
	add column if not exists started_at timestamptz,
	add column if not exists ended_at timestamptz,
	add column if not exists rating_version integer not null default 1,
	add column if not exists created_at timestamptz not null default now();

alter table arc_spirits_2d.match_result_players
	add column if not exists member_id uuid,
	add column if not exists user_id uuid,
	add column if not exists display_name text,
	add column if not exists is_bot boolean not null default false,
	add column if not exists victory_points integer not null default 0,
	add column if not exists placement integer not null default 0,
	add column if not exists created_at timestamptz not null default now();

alter table arc_spirits_2d.player_ratings
	add column if not exists display_name text,
	add column if not exists games_played integer not null default 0,
	add column if not exists last_session_id uuid,
	add column if not exists last_game_at timestamptz,
	add column if not exists rating_version integer not null default 1,
	-- Written only by the OPTIONAL scripts/seed-bots.mjs backfill, so a live table
	-- that never ran it plausibly lacks the column (bot-roster reads would fail).
	add column if not exists bot_profile text,
	add column if not exists updated_at timestamptz not null default now();

alter table arc_spirits_2d.player_rating_events
	add column if not exists placement integer not null default 0,
	add column if not exists rating_version integer not null default 1,
	add column if not exists created_at timestamptz not null default now();

-- Dedupe rows the old check-then-insert protocol may have doubled (keep earliest),
-- then make the exactly-once keys structural.
delete from arc_spirits_2d.match_results a
	using arc_spirits_2d.match_results b
	where a.session_id = b.session_id and a.ctid > b.ctid;
create unique index if not exists match_results_session_unique
	on arc_spirits_2d.match_results (session_id);

delete from arc_spirits_2d.match_result_players a
	using arc_spirits_2d.match_result_players b
	where a.session_id = b.session_id and a.seat_color = b.seat_color and a.ctid > b.ctid;
create unique index if not exists match_result_players_session_seat_unique
	on arc_spirits_2d.match_result_players (session_id, seat_color);

delete from arc_spirits_2d.player_rating_events a
	using arc_spirits_2d.player_rating_events b
	where a.session_id = b.session_id and a.user_id = b.user_id and a.ctid > b.ctid;
create unique index if not exists player_rating_events_session_user_unique
	on arc_spirits_2d.player_rating_events (session_id, user_id);

-- The upsert key (a no-op when user_id is already the primary key).
create unique index if not exists player_ratings_user_unique
	on arc_spirits_2d.player_ratings (user_id);

-- ── 2. the atomic finalize transaction ──────────────────────────────────────────

create or replace function arc_spirits_2d.finalize_match(
	p_session_id uuid,
	p_result jsonb,
	p_players jsonb,
	p_ratings jsonb
) returns jsonb
language plpgsql
security definer
set search_path = arc_spirits_2d
as $$
declare
	v_rating jsonb;
	v_row player_ratings%rowtype;
	v_found boolean;
	v_rated boolean := false;
	v_apply boolean := jsonb_array_length(coalesce(p_ratings, '[]'::jsonb)) > 0;
	v_expected_games integer;
begin
	-- 1. The anchor row is the finalize claim. Present ⇒ a prior attempt (this
	--    protocol, or the legacy one) already committed the terminal record: repair
	--    any missing player rows and answer — ratings are NEVER touched on this path.
	if exists (select 1 from match_results where session_id = p_session_id) then
		insert into match_result_players
			(session_id, seat_color, member_id, user_id, display_name, is_bot, victory_points, placement)
		select
			p_session_id,
			p->>'seat_color',
			nullif(p->>'member_id', '')::uuid,
			nullif(p->>'user_id', '')::uuid,
			p->>'display_name',
			coalesce((p->>'is_bot')::boolean, false),
			coalesce((p->>'victory_points')::integer, 0),
			coalesce((p->>'placement')::integer, 0)
		from jsonb_array_elements(coalesce(p_players, '[]'::jsonb)) p
		on conflict (session_id, seat_color) do nothing;
		return jsonb_build_object('outcome', 'already_finalized');
	end if;

	-- 2. Ratings. Serialize per rated user FIRST (advisory locks — they fence users
	--    with NO player_ratings row yet, which FOR UPDATE cannot), then lock every
	--    existing target row (same deterministic user_id order — no deadlocks),
	--    detect legacy partial attempts, and verify the caller computed its OpenSkill
	--    updates from the CURRENT rows.
	if v_apply then
		-- Structural per-user serialization, absent rows included: every finalizer
		-- rating user U holds this transaction-scoped lock until commit/rollback, so
		-- two matches sharing U — even two FIRST-EVER matches where U has no row to
		-- FOR-UPDATE — check bases strictly one after the other. The loser of the
		-- race then fails verification below (stale_ratings) and its caller re-reads
		-- and recomputes from the winner's committed row.
		for v_rating in
			select value from jsonb_array_elements(p_ratings) order by value->>'user_id'
		loop
			perform pg_advisory_xact_lock(
				hashtextextended('arc_spirits_2d.player_ratings:' || (v_rating->>'user_id'), 0)
			);
		end loop;

		-- Legacy marker A: event rows already exist for this session (the old code
		-- inserted them only AFTER the ratings upsert) ⇒ ratings already applied.
		if exists (select 1 from player_rating_events where session_id = p_session_id) then
			v_apply := false;
			v_rated := true;
		end if;

		for v_rating in
			select value from jsonb_array_elements(p_ratings) order by value->>'user_id'
		loop
			select * into v_row
				from player_ratings
				where user_id = (v_rating->>'user_id')::uuid
				for update;
			v_found := found;
			-- Legacy marker B: the old code's ratings upsert (a single atomic
			-- multi-row statement) stamped last_session_id; seeing OUR session on any
			-- locked row means that upsert landed and only the tail was lost.
			if v_found and v_row.last_session_id = p_session_id then
				v_apply := false;
				v_rated := true;
			end if;
			if v_apply then
				v_expected_games := (v_rating->>'expected_games')::integer; -- null ⇒ caller saw no row
				if v_expected_games is null then
					if v_found then
						raise exception 'finalize_match: stale_ratings (row appeared for user % since the caller computed updates)',
							v_rating->>'user_id';
					end if;
				elsif not v_found
					or v_row.games_played is distinct from v_expected_games
					or abs(v_row.mu - (v_rating->>'expected_mu')::double precision) > 1e-4
					or abs(v_row.sigma - (v_rating->>'expected_sigma')::double precision) > 1e-4
				then
					raise exception 'finalize_match: stale_ratings (user % changed since the caller computed updates)',
						v_rating->>'user_id';
				end if;
			end if;
		end loop;

		if v_apply then
			insert into player_rating_events
				(session_id, user_id, placement, mu_before, sigma_before, mu_after, sigma_after, rating_version)
			select
				p_session_id,
				(r->>'user_id')::uuid,
				(r->>'placement')::integer,
				(r->>'mu_before')::double precision,
				(r->>'sigma_before')::double precision,
				(r->>'mu_after')::double precision,
				(r->>'sigma_after')::double precision,
				coalesce((r->>'rating_version')::integer, 1)
			from jsonb_array_elements(p_ratings) r;

			insert into player_ratings
				(user_id, display_name, mu, sigma, games_played, last_session_id, last_game_at, rating_version, updated_at)
			select
				(r->>'user_id')::uuid,
				r->>'display_name',
				(r->>'mu_after')::double precision,
				(r->>'sigma_after')::double precision,
				coalesce((r->>'expected_games')::integer, 0) + 1,
				p_session_id,
				nullif(r->>'last_game_at', '')::timestamptz,
				coalesce((r->>'rating_version')::integer, 1),
				now()
			from jsonb_array_elements(p_ratings) r
			on conflict (user_id) do update set
				display_name = excluded.display_name,
				mu = excluded.mu,
				sigma = excluded.sigma,
				games_played = excluded.games_played,
				last_session_id = excluded.last_session_id,
				last_game_at = excluded.last_game_at,
				rating_version = excluded.rating_version,
				updated_at = excluded.updated_at;
			v_rated := true;
		end if;
	end if;

	-- 3. The anchor + player rows, in the same transaction as the ratings.
	insert into match_results
		(session_id, game_id, mode, ranked, rated, quarantined, winner_seat, player_count,
		 navigation_count, started_at, ended_at, rating_version)
	values (
		p_session_id,
		p_result->>'game_id',
		coalesce(p_result->>'mode', 'casual'),
		coalesce((p_result->>'ranked')::boolean, false),
		v_rated,
		coalesce((p_result->>'quarantined')::boolean, false),
		p_result->>'winner_seat',
		coalesce((p_result->>'player_count')::integer, 0),
		coalesce((p_result->>'navigation_count')::integer, 0),
		nullif(p_result->>'started_at', '')::timestamptz,
		nullif(p_result->>'ended_at', '')::timestamptz,
		coalesce((p_result->>'rating_version')::integer, 1)
	)
	on conflict (session_id) do nothing;
	if not found then
		-- A concurrent finalizer committed its anchor between our step-1 check and
		-- here (only reachable when this call took no rating locks). Abort so OUR
		-- writes (if any) roll back; the caller retries and takes the
		-- already_finalized path against the winner's record.
		raise exception 'finalize_match: concurrent_finalize (anchor committed by another finalizer)';
	end if;

	insert into match_result_players
		(session_id, seat_color, member_id, user_id, display_name, is_bot, victory_points, placement)
	select
		p_session_id,
		p->>'seat_color',
		nullif(p->>'member_id', '')::uuid,
		nullif(p->>'user_id', '')::uuid,
		p->>'display_name',
		coalesce((p->>'is_bot')::boolean, false),
		coalesce((p->>'victory_points')::integer, 0),
		coalesce((p->>'placement')::integer, 0)
	from jsonb_array_elements(coalesce(p_players, '[]'::jsonb)) p
	on conflict (session_id, seat_color) do nothing;

	return jsonb_build_object('outcome', 'finalized', 'rated', v_rated);
end
$$;

revoke all on function arc_spirits_2d.finalize_match(uuid, jsonb, jsonb, jsonb) from public;
grant execute on function arc_spirits_2d.finalize_match(uuid, jsonb, jsonb, jsonb) to service_role;

-- ── 3. replay codes: one logical code per (game, round) ─────────────────────────
-- The history schema is not managed by these migrations (legacy, created by hand),
-- so guard on the table's existence; dedupe (keep the earliest code) first.
do $$
begin
	if to_regclass('arc_spirits_game.replay_codes') is not null then
		delete from arc_spirits_game.replay_codes a
			using arc_spirits_game.replay_codes b
			where a.game_id = b.game_id
				and a.navigation_count = b.navigation_count
				and a.ctid > b.ctid;
		if not exists (
			select 1 from pg_indexes
			where schemaname = 'arc_spirits_game' and indexname = 'replay_codes_game_nav_unique'
		) then
			create unique index replay_codes_game_nav_unique
				on arc_spirits_game.replay_codes (game_id, navigation_count);
		end if;
	end if;
end $$;
