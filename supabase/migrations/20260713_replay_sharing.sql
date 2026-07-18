-- Stable, revocable, participant-created replay shares. The share table lives with
-- history snapshots; service-role application code verifies finished participation
-- before insert and returns only an explicit public-field allow-list.
create table if not exists arc_spirits_game.replay_shares (
	code text primary key,
	game_id text not null,
	owner_user_id uuid not null,
	visibility text not null default 'public' check (visibility in ('public','private')),
	title text,
	revoked_at timestamptz,
	expires_at timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	unique(owner_user_id, game_id)
);
create index if not exists replay_shares_game_idx on arc_spirits_game.replay_shares(game_id);

-- One disclosure-safe spectator projection per committed game revision. Unlike the
-- legacy round snapshots this captures every authoritative command boundary, so a
-- viewer can deterministically step through the actual public match history without
-- exposing hands, prompts, draw order, or private choices.
create table if not exists arc_spirits_game.replay_frames (
	game_id text not null,
	revision integer not null check (revision >= 0),
	round integer not null check (round >= 0),
	phase text not null,
	public_state jsonb not null,
	created_at timestamptz not null default now(),
	primary key(game_id, revision)
);
create index if not exists replay_frames_game_round_idx
	on arc_spirits_game.replay_frames(game_id, round, revision);

-- Existing deployments may have applied an earlier copy of this migration. Add
-- the account lifecycle constraint idempotently when Supabase auth is present.
do $$
begin
	if to_regclass('auth.users') is not null and not exists (
		select 1 from pg_constraint
		where conname = 'replay_shares_owner_user_fk'
			and conrelid = 'arc_spirits_game.replay_shares'::regclass
	) then
		alter table arc_spirits_game.replay_shares
			add constraint replay_shares_owner_user_fk
			foreign key(owner_user_id) references auth.users(id) on delete cascade;
	end if;
end $$;

create or replace function arc_spirits_game.touch_replay_share_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
	new.updated_at = now();
	return new;
end $$;
drop trigger if exists replay_shares_touch_updated_at on arc_spirits_game.replay_shares;
create trigger replay_shares_touch_updated_at
	before update on arc_spirits_game.replay_shares
	for each row execute function arc_spirits_game.touch_replay_share_updated_at();

revoke all on arc_spirits_game.replay_shares from public, anon, authenticated;
revoke all on arc_spirits_game.replay_frames from public, anon, authenticated;
grant usage on schema arc_spirits_game to service_role;
grant all on arc_spirits_game.replay_shares to service_role;
grant all on arc_spirits_game.replay_frames to service_role;
