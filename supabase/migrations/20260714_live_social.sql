-- Canonical LIVE social authority. No correspondence games, turn reminders, or
-- asynchronous match state live here: parties/friends/presence/invites only lead
-- into active private rooms and expire on short, explicit leases.

create table if not exists arc_spirits_2d.social_friendships (
	user_low uuid not null references auth.users(id) on delete cascade,
	user_high uuid not null references auth.users(id) on delete cascade,
	requested_by uuid not null references auth.users(id) on delete cascade,
	status text not null default 'pending' check (status in ('pending','accepted')),
	created_at timestamptz not null default now(),
	accepted_at timestamptz,
	primary key(user_low, user_high),
	check (user_low < user_high),
	check (requested_by = user_low or requested_by = user_high)
);

create table if not exists arc_spirits_2d.social_blocks (
	blocker_user_id uuid not null references auth.users(id) on delete cascade,
	blocked_user_id uuid not null references auth.users(id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key(blocker_user_id, blocked_user_id),
	check (blocker_user_id <> blocked_user_id)
);

create table if not exists arc_spirits_2d.social_parties (
	id uuid primary key default gen_random_uuid(),
	owner_user_id uuid not null references auth.users(id) on delete cascade,
	active_room_code text,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create table if not exists arc_spirits_2d.social_party_members (
	party_id uuid not null references arc_spirits_2d.social_parties(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	role text not null default 'member' check (role in ('owner','member')),
	joined_at timestamptz not null default now(),
	primary key(party_id, user_id),
	unique(user_id)
);

create unique index if not exists social_party_one_owner
	on arc_spirits_2d.social_party_members(party_id) where role = 'owner';

-- A live game has exactly four seats. Serialize membership inserts on the party
-- row so simultaneous redemptions cannot overfill it even when every caller saw
-- three members before inserting. This is an authority invariant, not a UI cap.
create or replace function arc_spirits_2d.enforce_social_party_cap()
returns trigger language plpgsql security definer
set search_path = pg_catalog, arc_spirits_2d
as $$
declare member_count integer;
begin
	perform 1 from arc_spirits_2d.social_parties where id = new.party_id for update;
	select count(*) into member_count
		from arc_spirits_2d.social_party_members where party_id = new.party_id;
	if member_count >= 4 then
		raise exception 'party is full' using errcode = '23514';
	end if;
	return new;
end;
$$;

drop trigger if exists social_party_cap on arc_spirits_2d.social_party_members;
create trigger social_party_cap before insert on arc_spirits_2d.social_party_members
	for each row execute function arc_spirits_2d.enforce_social_party_cap();
revoke all on function arc_spirits_2d.enforce_social_party_cap() from public, anon, authenticated;
grant execute on function arc_spirits_2d.enforce_social_party_cap() to service_role;

create table if not exists arc_spirits_2d.social_presence (
	user_id uuid not null references auth.users(id) on delete cascade,
	client_id text not null check (length(client_id) between 8 and 64),
	state text not null default 'online' check (state in ('online','away','in_game')),
	platform text not null check (platform in ('web','godot','ios','android')),
	visibility text not null default 'friends' check (visibility in ('friends','party','hidden')),
	room_code text,
	expires_at timestamptz not null,
	updated_at timestamptz not null default now(),
	primary key(user_id, client_id)
);

create index if not exists social_presence_expiry_idx
	on arc_spirits_2d.social_presence(expires_at);

create table if not exists arc_spirits_2d.social_invites (
	id uuid primary key default gen_random_uuid(),
	token_digest text not null unique,
	created_by uuid not null references auth.users(id) on delete cascade,
	invite_kind text not null check (invite_kind in ('friend','party','room')),
	target_user_id uuid references auth.users(id) on delete cascade,
	party_id uuid references arc_spirits_2d.social_parties(id) on delete cascade,
	room_code text,
	expires_at timestamptz not null,
	accepted_by uuid references auth.users(id) on delete set null,
	accepted_at timestamptz,
	revoked_at timestamptz,
	created_at timestamptz not null default now(),
	check (
		(invite_kind = 'friend' and target_user_id is not null and party_id is null and room_code is null)
		or (invite_kind = 'party' and party_id is not null and room_code is null)
		or (invite_kind = 'room' and room_code is not null)
	)
);

create index if not exists social_invites_target_idx
	on arc_spirits_2d.social_invites(target_user_id, created_at desc);
create index if not exists social_invites_creator_idx
	on arc_spirits_2d.social_invites(created_by, created_at desc);

revoke all on arc_spirits_2d.social_friendships from public, anon, authenticated;
revoke all on arc_spirits_2d.social_blocks from public, anon, authenticated;
revoke all on arc_spirits_2d.social_parties from public, anon, authenticated;
revoke all on arc_spirits_2d.social_party_members from public, anon, authenticated;
revoke all on arc_spirits_2d.social_presence from public, anon, authenticated;
revoke all on arc_spirits_2d.social_invites from public, anon, authenticated;
grant usage on schema arc_spirits_2d to service_role;
grant all on arc_spirits_2d.social_friendships to service_role;
grant all on arc_spirits_2d.social_blocks to service_role;
grant all on arc_spirits_2d.social_parties to service_role;
grant all on arc_spirits_2d.social_party_members to service_role;
grant all on arc_spirits_2d.social_presence to service_role;
grant all on arc_spirits_2d.social_invites to service_role;

alter table arc_spirits_2d.social_friendships enable row level security;
alter table arc_spirits_2d.social_friendships force row level security;
alter table arc_spirits_2d.social_blocks enable row level security;
alter table arc_spirits_2d.social_blocks force row level security;
alter table arc_spirits_2d.social_parties enable row level security;
alter table arc_spirits_2d.social_parties force row level security;
alter table arc_spirits_2d.social_party_members enable row level security;
alter table arc_spirits_2d.social_party_members force row level security;
alter table arc_spirits_2d.social_presence enable row level security;
alter table arc_spirits_2d.social_presence force row level security;
alter table arc_spirits_2d.social_invites enable row level security;
alter table arc_spirits_2d.social_invites force row level security;

drop policy if exists social_friendships_service on arc_spirits_2d.social_friendships;
create policy social_friendships_service on arc_spirits_2d.social_friendships for all to service_role using (true) with check (true);
drop policy if exists social_blocks_service on arc_spirits_2d.social_blocks;
create policy social_blocks_service on arc_spirits_2d.social_blocks for all to service_role using (true) with check (true);
drop policy if exists social_parties_service on arc_spirits_2d.social_parties;
create policy social_parties_service on arc_spirits_2d.social_parties for all to service_role using (true) with check (true);
drop policy if exists social_party_members_service on arc_spirits_2d.social_party_members;
create policy social_party_members_service on arc_spirits_2d.social_party_members for all to service_role using (true) with check (true);
drop policy if exists social_presence_service on arc_spirits_2d.social_presence;
create policy social_presence_service on arc_spirits_2d.social_presence for all to service_role using (true) with check (true);
drop policy if exists social_invites_service on arc_spirits_2d.social_invites;
create policy social_invites_service on arc_spirits_2d.social_invites for all to service_role using (true) with check (true);
