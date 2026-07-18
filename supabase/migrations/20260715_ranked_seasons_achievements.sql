-- Ranked seasons, trusted achievements, reward cosmetics, and the unsigned
-- platform-mirror outbox. Canonical state remains server-owned; Apple/Google
-- providers may only acknowledge outbound mirror events in a later signed build.

create table if not exists arc_spirits_2d.ranked_seasons (
	id text primary key,
	name text not null,
	status text not null check (status in ('scheduled','active','closed')),
	starts_at timestamptz not null,
	ends_at timestamptz not null,
	placement_games integer not null default 5 check (placement_games between 1 and 20),
	decay_grace_days integer not null default 21 check (decay_grace_days between 7 and 90),
	decay_sigma_step double precision not null default 0.35 check (decay_sigma_step between 0 and 3),
	reset_mu_factor double precision not null default 0.65 check (reset_mu_factor between 0 and 1),
	reset_sigma_floor double precision not null default 6.5 check (reset_sigma_floor > 0),
	rules_version integer not null default 1,
	created_at timestamptz not null default now(),
	check (ends_at > starts_at)
);
create unique index if not exists ranked_seasons_one_active
	on arc_spirits_2d.ranked_seasons ((status)) where status='active';

create table if not exists arc_spirits_2d.ranked_division_rules (
	season_id text not null references arc_spirits_2d.ranked_seasons(id) on delete cascade,
	division_key text not null,
	label text not null,
	tier_order integer not null,
	min_ordinal double precision not null,
	primary key(season_id, division_key),
	unique(season_id, tier_order),
	unique(season_id, min_ordinal)
);

create table if not exists arc_spirits_2d.ranked_player_seasons (
	season_id text not null references arc_spirits_2d.ranked_seasons(id) on delete cascade,
	user_id uuid not null,
	display_name text,
	mu double precision not null default 25,
	sigma double precision not null default 8.333333333333334,
	games_played integer not null default 0,
	wins integer not null default 0,
	placements_completed integer not null default 0,
	peak_ordinal double precision not null default 0,
	last_session_id uuid,
	last_activity_at timestamptz,
	last_decay_bucket date,
	is_bot boolean not null default false,
	rating_version integer not null default 1,
	updated_at timestamptz not null default now(),
	primary key(season_id,user_id)
);

create table if not exists arc_spirits_2d.ranked_season_rating_events (
	id uuid primary key default gen_random_uuid(),
	season_id text not null references arc_spirits_2d.ranked_seasons(id) on delete cascade,
	session_id uuid,
	user_id uuid not null,
	event_kind text not null check (event_kind in ('match','reset','decay','abandonment')),
	event_key text not null,
	placement integer,
	mu_before double precision not null,
	sigma_before double precision not null,
	mu_after double precision not null,
	sigma_after double precision not null,
	created_at timestamptz not null default now(),
	unique(season_id,user_id,event_key)
);

create table if not exists arc_spirits_2d.ranked_season_snapshots (
	season_id text not null references arc_spirits_2d.ranked_seasons(id) on delete cascade,
	user_id uuid not null,
	final_ordinal double precision not null,
	peak_ordinal double precision not null,
	division_key text not null,
	leaderboard_position integer not null,
	reward_item_ids jsonb not null default '[]'::jsonb,
	frozen_at timestamptz not null default now(),
	primary key(season_id,user_id)
);

create table if not exists arc_spirits_2d.ranked_participation (
	session_id uuid not null,
	member_id uuid not null,
	season_id text references arc_spirits_2d.ranked_seasons(id),
	user_id uuid,
	abandoned boolean not null default false,
	abandonment_kind text check (abandonment_kind in ('concede','disconnect_deadline','all_humans_gone')),
	abandoned_at timestamptz,
	bot_controlled_at timestamptz,
	created_at timestamptz not null default now(),
	primary key(session_id,member_id)
);
create unique index if not exists ranked_participation_session_user
	on arc_spirits_2d.ranked_participation(session_id,user_id) where user_id is not null;

create table if not exists arc_spirits_2d.achievement_definitions (
	id text primary key,
	name text not null,
	description text not null,
	category text not null check (category in ('journey','ranked','guardian','social')),
	reward_item_id text,
	active boolean not null default true,
	created_at timestamptz not null default now()
);
create table if not exists arc_spirits_2d.player_achievements (
	user_id uuid not null,
	achievement_id text not null references arc_spirits_2d.achievement_definitions(id),
	progress integer not null default 0,
	target integer not null default 1 check (target > 0),
	unlocked_at timestamptz,
	source_event_key text not null,
	updated_at timestamptz not null default now(),
	primary key(user_id,achievement_id)
);
create table if not exists arc_spirits_2d.achievement_reward_ledger (
	user_id uuid not null,
	achievement_id text not null references arc_spirits_2d.achievement_definitions(id),
	item_id text not null,
	granted_at timestamptz not null default now(),
	primary key(user_id,achievement_id,item_id)
);
create table if not exists arc_spirits_2d.platform_bridge_outbox (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null,
	event_key text not null,
	event_kind text not null check (event_kind in ('achievement','leaderboard')),
	payload jsonb not null,
	created_at timestamptz not null default now(),
	acknowledged_at timestamptz,
	unique(user_id,event_key)
);

insert into arc_spirits_2d.ranked_seasons
	(id,name,status,starts_at,ends_at,placement_games)
values ('season-zero-2026','Season Zero · First Light','active','2026-07-01T00:00:00Z','2027-01-01T00:00:00Z',5)
on conflict(id) do nothing;
insert into arc_spirits_2d.ranked_division_rules(season_id,division_key,label,tier_order,min_ordinal) values
	('season-zero-2026','ember','Ember',0,-1000),
	('season-zero-2026','iron','Iron',1,0),
	('season-zero-2026','bronze','Bronze',2,5),
	('season-zero-2026','silver','Silver',3,10),
	('season-zero-2026','gold','Gold',4,15),
	('season-zero-2026','prism','Prism',5,20)
on conflict(season_id,division_key) do update set
	label=excluded.label,tier_order=excluded.tier_order,min_ordinal=excluded.min_ordinal;

alter table arc_spirits_2d.cosmetic_catalog
	add column if not exists purchasable boolean not null default true;
insert into arc_spirits_2d.cosmetic_catalog
	(id,kind,name,description,price,rarity,accent,target_guardian,active,purchasable)
values
	('border-ranked-first-light','border','First Light','Earned by completing Season Zero placements.',0,'epic','#ffd36a',null,true,false),
	('nameplate-ranked-gold','nameplate','Golden Resolve','Earned by reaching Gold in a ranked season.',0,'mythic','#ffb43a',null,true,false)
on conflict(id) do update set active=true,purchasable=false;
insert into arc_spirits_2d.achievement_definitions(id,name,description,category,reward_item_id) values
	('first-ranked-match','First Step','Complete a rated ranked match.','ranked',null),
	('first-ranked-win','First Ascent','Win a rated ranked match.','ranked',null),
	('placements-complete','Placed in the Aether','Complete five placement matches.','ranked','border-ranked-first-light'),
	('reach-gold','Golden Resolve','Reach Gold division in a ranked season.','ranked','nameplate-ranked-gold')
on conflict(id) do update set name=excluded.name,description=excluded.description,
	category=excluded.category,reward_item_id=excluded.reward_item_id,active=true;

alter table arc_spirits_2d.match_results add column if not exists ranked_season_id text;
alter table arc_spirits_2d.match_result_players
	add column if not exists abandoned boolean not null default false,
	add column if not exists rated_placement integer;
do $$ begin
	if exists(select 1 from pg_tables where schemaname='arc_spirits_2d' and tablename='play_game_sessions') then
		alter table arc_spirits_2d.play_game_sessions add column if not exists ranked_season_id text;
	end if;
	if exists(select 1 from pg_tables where schemaname='arc_spirits_2d' and tablename='play_session_members') then
		alter table arc_spirits_2d.play_session_members add column if not exists bot_profile text;
	end if;
	if exists(select 1 from pg_tables where schemaname='arc_spirits_2d' and tablename='match_queue') then
		alter table arc_spirits_2d.match_queue add column if not exists ranked_season_id text;
		create index if not exists match_queue_season_status_idx on arc_spirits_2d.match_queue(ranked_season_id,status,queued_at);
	end if;
end $$;

-- Apply one season result from bases computed by the service. Per-user advisory
-- locks plus expected-base validation provide the same stale/retry protocol as
-- lifetime rating finalization. One event key makes retries exactly-once.
create or replace function arc_spirits_2d.apply_ranked_season_result(
	p_session_id uuid, p_season_id text, p_ratings jsonb
) returns jsonb language plpgsql security definer set search_path=arc_spirits_2d as $$
declare r jsonb; cur ranked_player_seasons%rowtype; expected_games integer;
	new_ordinal double precision; placement_goal integer;
begin
	if not exists(select 1 from match_results where session_id=p_session_id and rated and not quarantined) then
		raise exception 'season_result_unrated';
	end if;
	if not exists(select 1 from ranked_seasons where id=p_season_id) then raise exception 'season_not_found'; end if;
	if exists(select 1 from ranked_season_rating_events where season_id=p_season_id and event_key='match:'||p_session_id::text) then
		return jsonb_build_object('outcome','already_applied');
	end if;
	select placement_games into placement_goal from ranked_seasons where id=p_season_id;
	for r in select value from jsonb_array_elements(coalesce(p_ratings,'[]'::jsonb)) order by value->>'user_id' loop
		perform pg_advisory_xact_lock(hashtextextended('arc_spirits_2d.season:'||p_season_id||':'||(r->>'user_id'),0));
		select * into cur from ranked_player_seasons where season_id=p_season_id and user_id=(r->>'user_id')::uuid for update;
		expected_games := nullif(r->>'expected_games','')::integer;
		if found then
			if cur.games_played is distinct from expected_games
				or abs(cur.mu-(r->>'expected_mu')::double precision)>1e-4
				or abs(cur.sigma-(r->>'expected_sigma')::double precision)>1e-4 then
				raise exception 'stale_season_ratings';
			end if;
		elsif expected_games is not null then raise exception 'stale_season_ratings'; end if;
	end loop;
	for r in select value from jsonb_array_elements(coalesce(p_ratings,'[]'::jsonb)) loop
		new_ordinal := (r->>'mu_after')::double precision - 3*(r->>'sigma_after')::double precision;
		insert into ranked_season_rating_events(season_id,session_id,user_id,event_kind,event_key,placement,
			mu_before,sigma_before,mu_after,sigma_after)
		values(p_season_id,p_session_id,(r->>'user_id')::uuid,'match','match:'||p_session_id::text,
			(r->>'placement')::integer,(r->>'mu_before')::double precision,(r->>'sigma_before')::double precision,
			(r->>'mu_after')::double precision,(r->>'sigma_after')::double precision);
		insert into ranked_player_seasons(season_id,user_id,display_name,mu,sigma,games_played,wins,
			placements_completed,peak_ordinal,last_session_id,last_activity_at,is_bot)
		values(p_season_id,(r->>'user_id')::uuid,r->>'display_name',(r->>'mu_after')::double precision,
			(r->>'sigma_after')::double precision,1,case when (r->>'placement')::integer=1 then 1 else 0 end,
			1,greatest(0,new_ordinal),p_session_id,now(),coalesce((r->>'is_bot')::boolean,false))
		on conflict(season_id,user_id) do update set display_name=excluded.display_name,mu=excluded.mu,sigma=excluded.sigma,
			games_played=ranked_player_seasons.games_played+1,wins=ranked_player_seasons.wins+excluded.wins,
			placements_completed=least(placement_goal,ranked_player_seasons.placements_completed+1),
			peak_ordinal=greatest(ranked_player_seasons.peak_ordinal,excluded.peak_ordinal),
			last_session_id=p_session_id,last_activity_at=now(),updated_at=now();

		if not coalesce((r->>'is_bot')::boolean,false) then
			insert into player_achievements(user_id,achievement_id,progress,target,unlocked_at,source_event_key)
			values((r->>'user_id')::uuid,'first-ranked-match',1,1,now(),'match:'||p_session_id::text)
			on conflict(user_id,achievement_id) do nothing;
			if (r->>'placement')::integer=1 then
				insert into player_achievements(user_id,achievement_id,progress,target,unlocked_at,source_event_key)
				values((r->>'user_id')::uuid,'first-ranked-win',1,1,now(),'match:'||p_session_id::text)
				on conflict(user_id,achievement_id) do nothing;
			end if;
			if (select placements_completed>=placement_goal from ranked_player_seasons where season_id=p_season_id and user_id=(r->>'user_id')::uuid) then
				insert into player_achievements(user_id,achievement_id,progress,target,unlocked_at,source_event_key)
				values((r->>'user_id')::uuid,'placements-complete',placement_goal,placement_goal,now(),'season:'||p_season_id)
				on conflict(user_id,achievement_id) do update set progress=greatest(player_achievements.progress,excluded.progress),
					unlocked_at=coalesce(player_achievements.unlocked_at,excluded.unlocked_at),updated_at=now();
			end if;
			if new_ordinal >= coalesce((select min_ordinal from ranked_division_rules where season_id=p_season_id and division_key='gold'),1e9) then
				insert into player_achievements(user_id,achievement_id,progress,target,unlocked_at,source_event_key)
				values((r->>'user_id')::uuid,'reach-gold',1,1,now(),'season:'||p_season_id)
				on conflict(user_id,achievement_id) do nothing;
			end if;
		end if;
	end loop;

	for r in select jsonb_build_object('user_id',pa.user_id,'achievement_id',pa.achievement_id,'item_id',ad.reward_item_id) value
		from player_achievements pa join achievement_definitions ad on ad.id=pa.achievement_id
		where pa.unlocked_at is not null and ad.reward_item_id is not null
	loop
		insert into achievement_reward_ledger(user_id,achievement_id,item_id)
		values((r->>'user_id')::uuid,r->>'achievement_id',r->>'item_id') on conflict do nothing;
		insert into player_cosmetic_ownership(user_id,item_id,source)
		values((r->>'user_id')::uuid,r->>'item_id','achievement') on conflict do nothing;
		insert into platform_bridge_outbox(user_id,event_key,event_kind,payload)
		values((r->>'user_id')::uuid,'achievement:'||(r->>'achievement_id'),'achievement',
			jsonb_build_object('achievementId',r->>'achievement_id')) on conflict do nothing;
	end loop;
	update match_results set ranked_season_id=p_season_id where session_id=p_session_id;
	update match_result_players mrp set
		abandoned=coalesce(rp.abandoned,false),
		rated_placement=coalesce((select (x->>'placement')::integer from jsonb_array_elements(p_ratings) x
			where nullif(x->>'user_id','')::uuid=mrp.user_id limit 1),mrp.placement)
	from ranked_participation rp
	where mrp.session_id=p_session_id and rp.session_id=mrp.session_id and rp.member_id=mrp.member_id;
	return jsonb_build_object('outcome','applied');
end $$;

-- Explicit ranked concede atomically records original human attribution and
-- transfers authoritative seat control to a disclosed server bot. Reconnects can
-- observe the match but cannot reclaim the seat after this irreversible commit.
create or replace function arc_spirits_2d.concede_ranked_member(p_session_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=arc_spirits_2d as $$
declare s play_game_sessions%rowtype; m play_session_members%rowtype;
begin
	select * into s from play_game_sessions where id=p_session_id for update;
	if not found or s.status<>'active' or s.mode<>'ranked' or s.ranked_season_id is null then
		raise exception 'ranked_match_not_active';
	end if;
	select * into m from play_session_members where session_id=p_session_id and user_id=p_user_id order by joined_at limit 1 for update;
	if not found then raise exception 'ranked_participant_not_found'; end if;
	if m.is_bot and exists(select 1 from ranked_participation where session_id=p_session_id and member_id=m.id and abandoned) then
		return jsonb_build_object('conceded',true,'already',true);
	end if;
	insert into ranked_participation(session_id,member_id,season_id,user_id,abandoned,abandonment_kind,abandoned_at,bot_controlled_at)
	values(p_session_id,m.id,s.ranked_season_id,p_user_id,true,'concede',clock_timestamp(),clock_timestamp())
	on conflict(session_id,member_id) do update set abandoned=true,abandonment_kind='concede',
		abandoned_at=coalesce(ranked_participation.abandoned_at,excluded.abandoned_at),
		bot_controlled_at=coalesce(ranked_participation.bot_controlled_at,excluded.bot_controlled_at);
	update play_session_members set is_bot=true,bot_profile=coalesce(bot_profile,'neural-v1'),updated_at=now() where id=m.id;
	return jsonb_build_object('conceded',true,'already',false);
end $$;

create or replace function arc_spirits_2d.ensure_ranked_season_player(
	p_season_id text,p_user_id uuid,p_display_name text,p_is_bot boolean default false
) returns jsonb language plpgsql security definer set search_path=arc_spirits_2d as $$
declare s ranked_seasons%rowtype; prior ranked_player_seasons%rowtype; current ranked_player_seasons%rowtype;
	mu_after double precision; sigma_after double precision;
begin
	perform pg_advisory_xact_lock(hashtextextended('arc_spirits_2d.season:'||p_season_id||':'||p_user_id::text,0));
	select * into current from ranked_player_seasons where season_id=p_season_id and user_id=p_user_id;
	if found then return jsonb_build_object('created',false); end if;
	select * into s from ranked_seasons where id=p_season_id and status='active';
	if not found then raise exception 'season_not_active'; end if;
	select ps.* into prior from ranked_player_seasons ps join ranked_seasons rs on rs.id=ps.season_id
		where ps.user_id=p_user_id and rs.status='closed' order by rs.ends_at desc limit 1;
	if found then
		mu_after := 25+(prior.mu-25)*s.reset_mu_factor;
		sigma_after := greatest(prior.sigma,s.reset_sigma_floor);
	else mu_after:=25; sigma_after:=25.0/3.0; end if;
	insert into ranked_player_seasons(season_id,user_id,display_name,mu,sigma,peak_ordinal,is_bot)
	values(p_season_id,p_user_id,p_display_name,mu_after,sigma_after,greatest(0,mu_after-3*sigma_after),p_is_bot);
	if prior.user_id is not null then
		insert into ranked_season_rating_events(season_id,user_id,event_kind,event_key,mu_before,sigma_before,mu_after,sigma_after)
		values(p_season_id,p_user_id,'reset','reset:'||p_season_id,prior.mu,prior.sigma,mu_after,sigma_after)
		on conflict do nothing;
	end if;
	return jsonb_build_object('created',true,'reset',prior.user_id is not null);
end $$;

create or replace function arc_spirits_2d.apply_ranked_decay(p_season_id text,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=arc_spirits_2d as $$
declare s ranked_seasons%rowtype; p ranked_player_seasons%rowtype; bucket date; next_sigma double precision;
begin
	perform pg_advisory_xact_lock(hashtextextended('arc_spirits_2d.season:'||p_season_id||':'||p_user_id::text,0));
	select * into s from ranked_seasons where id=p_season_id;
	select * into p from ranked_player_seasons where season_id=p_season_id and user_id=p_user_id for update;
	if not found then return jsonb_build_object('decayed',false,'reason','no_rating'); end if;
	bucket := date_trunc('week',clock_timestamp())::date;
	if p.last_activity_at is null or p.last_activity_at > clock_timestamp()-(s.decay_grace_days||' days')::interval
		or p.last_decay_bucket=bucket then return jsonb_build_object('decayed',false); end if;
	next_sigma := least(25.0/3.0,p.sigma+s.decay_sigma_step);
	insert into ranked_season_rating_events(season_id,user_id,event_kind,event_key,mu_before,sigma_before,mu_after,sigma_after)
	values(p_season_id,p_user_id,'decay','decay:'||bucket::text,p.mu,p.sigma,p.mu,next_sigma) on conflict do nothing;
	update ranked_player_seasons set sigma=next_sigma,last_decay_bucket=bucket,updated_at=now()
		where season_id=p_season_id and user_id=p_user_id;
	return jsonb_build_object('decayed',true,'bucket',bucket);
end $$;

create or replace function arc_spirits_2d.close_ranked_season(p_season_id text)
returns jsonb language plpgsql security definer set search_path=arc_spirits_2d as $$
declare frozen integer;
begin
	perform pg_advisory_xact_lock(hashtextextended('arc_spirits_2d.close-season:'||p_season_id,0));
	if not exists(select 1 from ranked_seasons where id=p_season_id and status in ('active','closed')) then
		raise exception 'season_not_found'; end if;
	insert into ranked_season_snapshots(season_id,user_id,final_ordinal,peak_ordinal,division_key,leaderboard_position,reward_item_ids)
	select p.season_id,p.user_id,p.mu-3*p.sigma,p.peak_ordinal,
		coalesce((select d.division_key from ranked_division_rules d where d.season_id=p.season_id
			and p.mu-3*p.sigma>=d.min_ordinal order by d.min_ordinal desc limit 1),'ember'),
		row_number() over(order by p.mu-3*p.sigma desc,p.wins desc,p.games_played asc),
		coalesce((select jsonb_agg(o.item_id order by o.item_id) from player_cosmetic_ownership o
			where o.user_id=p.user_id and o.source='achievement'),'[]'::jsonb)
	from ranked_player_seasons p where p.season_id=p_season_id and not p.is_bot
	on conflict(season_id,user_id) do nothing;
	get diagnostics frozen=row_count;
	update ranked_seasons set status='closed' where id=p_season_id and status='active';
	return jsonb_build_object('closed',true,'frozen',frozen);
end $$;

-- If every human disappears and the active room must be closed, record a real
-- abandonment loss before closure. This prevents force-quitting from dodging the
-- season ledger even though there is no normal terminal board state to finalize.
create or replace function arc_spirits_2d.finalize_ranked_abandonment(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path=arc_spirits_2d as $$
declare s play_game_sessions%rowtype; m play_session_members%rowtype; p ranked_player_seasons%rowtype;
	count_humans integer; penalty_place integer;
begin
	select * into s from play_game_sessions where id=p_session_id for update;
	if not found or s.status<>'active' or s.mode<>'ranked' or s.ranked_season_id is null then
		return jsonb_build_object('finalized',false); end if;
	select count(*) into count_humans from play_session_members where session_id=p_session_id and not is_bot;
	penalty_place:=greatest(2,count_humans);
	insert into match_results(session_id,game_id,mode,ranked,rated,quarantined,player_count,ended_at,ranked_season_id)
	values(p_session_id,s.game_id,'ranked',true,false,false,count_humans,clock_timestamp(),s.ranked_season_id)
	on conflict(session_id) do nothing;
	for m in select * from play_session_members where session_id=p_session_id and not is_bot and user_id is not null loop
		perform ensure_ranked_season_player(s.ranked_season_id,m.user_id,m.display_name,false);
		perform pg_advisory_xact_lock(hashtextextended('arc_spirits_2d.season:'||s.ranked_season_id||':'||m.user_id::text,0));
		select * into p from ranked_player_seasons where season_id=s.ranked_season_id and user_id=m.user_id for update;
		insert into ranked_season_rating_events(season_id,session_id,user_id,event_kind,event_key,placement,
			mu_before,sigma_before,mu_after,sigma_after)
		values(s.ranked_season_id,p_session_id,m.user_id,'abandonment','abandonment:'||p_session_id::text,
			penalty_place,p.mu,p.sigma,p.mu-1.5,least(25.0/3.0,p.sigma+0.1)) on conflict do nothing;
		if found then
			update ranked_player_seasons set mu=p.mu-1.5,sigma=least(25.0/3.0,p.sigma+0.1),
				games_played=games_played+1,last_session_id=p_session_id,last_activity_at=clock_timestamp(),updated_at=now()
				where season_id=s.ranked_season_id and user_id=m.user_id;
		end if;
		insert into ranked_participation(session_id,member_id,season_id,user_id,abandoned,abandonment_kind,abandoned_at)
		values(p_session_id,m.id,s.ranked_season_id,m.user_id,true,'all_humans_gone',clock_timestamp())
		on conflict(session_id,member_id) do update set abandoned=true,abandonment_kind='all_humans_gone',
			abandoned_at=coalesce(ranked_participation.abandoned_at,excluded.abandoned_at);
		insert into match_result_players(session_id,seat_color,member_id,user_id,display_name,is_bot,placement,
			victory_points,abandoned,rated_placement)
		values(p_session_id,m.seat_color,m.id,m.user_id,m.display_name,true,penalty_place,0,true,penalty_place)
		on conflict(session_id,seat_color) do nothing;
	end loop;
	return jsonb_build_object('finalized',true,'participants',count_humans);
end $$;

-- Reward-only items are visible/equippable but cannot be bought for zero credits.
create or replace function arc_spirits_2d.purchase_cosmetic(p_user_id uuid,p_item_id text)
returns jsonb language plpgsql security definer set search_path=arc_spirits_2d as $$
declare v_price integer;
begin
	perform reconcile_player_progression(p_user_id);
	perform pg_advisory_xact_lock(hashtextextended('arc_spirits_2d.progression:'||p_user_id::text,0));
	select price into v_price from cosmetic_catalog where id=p_item_id and active and purchasable;
	if not found then raise exception 'cosmetic_not_found'; end if;
	if exists(select 1 from player_cosmetic_ownership where user_id=p_user_id and item_id=p_item_id) then return progression_snapshot(p_user_id); end if;
	update player_progression set credits=credits-v_price,updated_at=now() where user_id=p_user_id and credits>=v_price;
	if not found then raise exception 'insufficient_credits'; end if;
	insert into player_cosmetic_ownership(user_id,item_id,source) values(p_user_id,p_item_id,'purchase');
	return progression_snapshot(p_user_id);
end $$;

-- Service-only posture for all private competitive/account state.
grant usage on schema arc_spirits_2d to service_role;
do $$ declare t text; begin foreach t in array array['ranked_seasons','ranked_division_rules','ranked_player_seasons',
	'ranked_season_rating_events','ranked_season_snapshots','ranked_participation','achievement_definitions',
	'player_achievements','achievement_reward_ledger','platform_bridge_outbox'] loop
	execute format('revoke all on arc_spirits_2d.%I from public, anon, authenticated',t);
	execute format('grant all on arc_spirits_2d.%I to service_role',t);
	execute format('alter table arc_spirits_2d.%I enable row level security',t);
	execute format('alter table arc_spirits_2d.%I force row level security',t);
	execute format('drop policy if exists %I on arc_spirits_2d.%I',t||'_service',t);
	execute format('create policy %I on arc_spirits_2d.%I for all to service_role using (true) with check (true)',t||'_service',t);
	end loop; end $$;
revoke all on function arc_spirits_2d.apply_ranked_season_result(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function arc_spirits_2d.apply_ranked_season_result(uuid,text,jsonb) to service_role;
revoke all on function arc_spirits_2d.concede_ranked_member(uuid,uuid) from public,anon,authenticated;
grant execute on function arc_spirits_2d.concede_ranked_member(uuid,uuid) to service_role;
revoke all on function arc_spirits_2d.ensure_ranked_season_player(text,uuid,text,boolean) from public,anon,authenticated;
grant execute on function arc_spirits_2d.ensure_ranked_season_player(text,uuid,text,boolean) to service_role;
revoke all on function arc_spirits_2d.apply_ranked_decay(text,uuid) from public,anon,authenticated;
grant execute on function arc_spirits_2d.apply_ranked_decay(text,uuid) to service_role;
revoke all on function arc_spirits_2d.close_ranked_season(text) from public,anon,authenticated;
grant execute on function arc_spirits_2d.close_ranked_season(text) to service_role;
revoke all on function arc_spirits_2d.finalize_ranked_abandonment(uuid) from public,anon,authenticated;
grant execute on function arc_spirits_2d.finalize_ranked_abandonment(uuid) to service_role;
revoke all on function arc_spirits_2d.purchase_cosmetic(uuid,text) from public,anon,authenticated;
grant execute on function arc_spirits_2d.purchase_cosmetic(uuid,text) to service_role;
