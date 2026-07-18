-- Canonical Arc Spirits account progression, Guardian mastery, and cosmetic ownership.
-- Server/service-role functions are the only mutation boundary; clients never award
-- currency, mint ownership, or equip an unowned item. Match awards reconcile from
-- trusted match_result_players rows under a per-user transaction lock and a unique
-- (session_id,user_id) ledger, so retries and cross-device reads are exactly-once.

create table if not exists arc_spirits_2d.player_progression (
	user_id uuid primary key,
	credits integer not null default 80 check (credits >= 0),
	lifetime_credits integer not null default 80 check (lifetime_credits >= 0),
	account_xp integer not null default 0 check (account_xp >= 0),
	updated_at timestamptz not null default now()
);

create table if not exists arc_spirits_2d.guardian_mastery (
	user_id uuid not null,
	guardian_name text not null,
	mastery_xp integer not null default 0 check (mastery_xp >= 0),
	mastery_level integer not null default 1 check (mastery_level >= 1),
	games_played integer not null default 0,
	wins integer not null default 0,
	updated_at timestamptz not null default now(),
	primary key (user_id, guardian_name)
);

create table if not exists arc_spirits_2d.cosmetic_catalog (
	id text primary key,
	kind text not null check (kind in ('border','guardianSkin','banner','boardEnvironment','summonTrail','cardFinish','nameplate','emote','victoryPose','profileScene')),
	name text not null,
	description text not null,
	price integer not null check (price >= 0),
	rarity text not null check (rarity in ('common','rare','epic','mythic')),
	accent text not null,
	target_guardian text,
	active boolean not null default true,
	created_at timestamptz not null default now()
);

create table if not exists arc_spirits_2d.player_cosmetic_ownership (
	user_id uuid not null,
	item_id text not null references arc_spirits_2d.cosmetic_catalog(id),
	source text not null default 'purchase',
	unlocked_at timestamptz not null default now(),
	primary key (user_id, item_id)
);

create table if not exists arc_spirits_2d.player_loadouts (
	user_id uuid primary key,
	equipped_border_id text,
	equipped_banner_id text,
	equipped_guardian_skins jsonb not null default '{}'::jsonb,
	equipped_board_environment_id text,
	equipped_summon_trail_id text,
	equipped_card_finish_id text,
	equipped_nameplate_id text,
	equipped_emote_id text,
	equipped_victory_pose_id text,
	equipped_profile_scene_id text,
	updated_at timestamptz not null default now()
);

create table if not exists arc_spirits_2d.progression_awards (
	session_id uuid not null,
	user_id uuid not null,
	guardian_name text,
	credits integer not null,
	account_xp integer not null,
	mastery_xp integer not null,
	placement integer not null,
	victory_points integer not null,
	created_at timestamptz not null default now(),
	primary key (session_id, user_id)
);

insert into arc_spirits_2d.cosmetic_catalog
	(id, kind, name, description, price, rarity, accent, target_guardian)
values
	('border-abyssal-thread','border','Abyssal Thread','A restrained violet-cyan result and name border.',120,'rare','#9d5cff',null),
	('border-lantern-oath','border','Lantern Oath','An amber oath frame with a restrained shrine-glow edge.',160,'epic','#ffba3d',null),
	('border-tidal-veil','border','Tidal Veil','A quiet cyan frame tuned for clean board scanning.',70,'common','#24d4ff',null),
	('skin-myrtle-voidbloom','guardianSkin','Myrtle Voidbloom','A dark Floral treatment for Myrtle showcases.',220,'mythic','#ff2bc7','Myrtle'),
	('skin-cyber-glass','guardianSkin','Cyber Glass','A cyan-magenta glass pass for guardian showcases.',180,'epic','#20e0c1','Any Guardian'),
	('banner-fallen-sigil','banner','Fallen Sigil','A profile and postgame banner mark.',260,'mythic','#5b2dff',null),
	('environment-lantern-steps','boardEnvironment','Lantern Steps','Low-poly lantern fragments and warm shrine facets.',180,'epic','#ffba3d',null),
	('trail-prismatic-shards','summonTrail','Prismatic Shards','Faceted shards follow a summoned spirit.',140,'rare','#65f3e1',null),
	('finish-arcfoil','cardFinish','Arcfoil','A restrained animated foil edge for spirit cards.',110,'rare','#8ee7ff',null),
	('nameplate-veilwalker','nameplate','Veilwalker','A compact low-poly rune nameplate.',90,'common','#a48cff',null),
	('emote-spirit-bow','emote','Spirit Bow','A respectful live-match guardian emote.',80,'common','#f5d08a',null),
	('pose-guardian-rise','victoryPose','Guardian Rise','A faceted guardian victory stance.',210,'epic','#ff7fd9',null),
	('profile-arc-sanctum','profileScene','Arc Sanctum','A low-poly profile scene of rings, shards, and spirit light.',240,'mythic','#7b1dff',null)
on conflict (id) do update set
	kind=excluded.kind, name=excluded.name, description=excluded.description,
	price=excluded.price, rarity=excluded.rarity, accent=excluded.accent,
	target_guardian=excluded.target_guardian, active=true;

create or replace function arc_spirits_2d.progression_snapshot(p_user_id uuid)
returns jsonb language sql stable security definer set search_path=arc_spirits_2d as $$
	select jsonb_build_object(
		'credits', p.credits,
		'lifetimeCredits', p.lifetime_credits,
		'rankXp', p.account_xp,
		'accountXp', p.account_xp,
		'ownedItemIds', coalesce((select jsonb_agg(o.item_id order by o.item_id) from player_cosmetic_ownership o where o.user_id=p_user_id), '[]'::jsonb),
		'equippedBorderId', l.equipped_border_id,
		'equippedBannerId', l.equipped_banner_id,
		'equippedGuardianSkinIds', coalesce(l.equipped_guardian_skins, '{}'::jsonb),
		'equippedBoardEnvironmentId', l.equipped_board_environment_id,
		'equippedSummonTrailId', l.equipped_summon_trail_id,
		'equippedCardFinishId', l.equipped_card_finish_id,
		'equippedNameplateId', l.equipped_nameplate_id,
		'equippedEmoteId', l.equipped_emote_id,
		'equippedVictoryPoseId', l.equipped_victory_pose_id,
		'equippedProfileSceneId', l.equipped_profile_scene_id,
		'guardianMastery', coalesce((select jsonb_agg(jsonb_build_object('guardianName',m.guardian_name,'masteryXp',m.mastery_xp,'masteryLevel',m.mastery_level,'gamesPlayed',m.games_played,'wins',m.wins) order by m.guardian_name) from guardian_mastery m where m.user_id=p_user_id), '[]'::jsonb),
		'catalog', coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'name',c.name,'description',c.description,'price',c.price,'rarity',c.rarity,'accent',c.accent,'targetGuardian',c.target_guardian) order by c.kind,c.id) from cosmetic_catalog c where c.active), '[]'::jsonb)
	)
	from player_progression p join player_loadouts l using(user_id)
	where p.user_id=p_user_id;
$$;

create or replace function arc_spirits_2d.reconcile_player_progression(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=arc_spirits_2d as $$
declare
	r record;
	v_credits integer;
	v_xp integer;
	v_mastery integer;
	v_inserted uuid;
begin
	perform pg_advisory_xact_lock(hashtextextended('arc_spirits_2d.progression:' || p_user_id::text, 0));
	insert into player_progression(user_id) values(p_user_id) on conflict do nothing;
	insert into player_loadouts(user_id) values(p_user_id) on conflict do nothing;

	for r in
		select mrp.session_id, mrp.placement, mrp.victory_points,
			mr.navigation_count, psm.selected_guardian
		from match_result_players mrp
		join match_results mr on mr.session_id=mrp.session_id
		left join play_session_members psm on psm.id=mrp.member_id
		left join progression_awards a on a.session_id=mrp.session_id and a.user_id=mrp.user_id
		where mrp.user_id=p_user_id and not mrp.is_bot and a.session_id is null
		order by mr.ended_at nulls last, mrp.session_id
	loop
		v_credits := 20 + greatest(0,r.victory_points)*3 +
			case when r.placement<=1 then 60 when r.placement=2 then 32 when r.placement=3 then 18 else 10 end +
			case when r.placement<=1 then 40 else 0 end + least(25,greatest(0,r.navigation_count/2));
		v_xp := 12 + greatest(0,r.victory_points)*2 +
			round((case when r.placement<=1 then 60 when r.placement=2 then 32 when r.placement=3 then 18 else 10 end)/2.0)::integer +
			case when r.placement<=1 then 28 else 0 end;
		v_mastery := 10 + greatest(0,r.victory_points) + case when r.placement<=1 then 20 else 0 end;
		v_inserted := null;
		insert into progression_awards(session_id,user_id,guardian_name,credits,account_xp,mastery_xp,placement,victory_points)
		values(r.session_id,p_user_id,nullif(r.selected_guardian,''),v_credits,v_xp,v_mastery,r.placement,r.victory_points)
		on conflict do nothing returning session_id into v_inserted;
		if v_inserted is not null then
			update player_progression set credits=credits+v_credits,
				lifetime_credits=lifetime_credits+v_credits, account_xp=account_xp+v_xp,
				updated_at=now() where user_id=p_user_id;
			if nullif(r.selected_guardian,'') is not null then
				insert into guardian_mastery(user_id,guardian_name,mastery_xp,mastery_level,games_played,wins)
				values(p_user_id,r.selected_guardian,v_mastery,1+floor(sqrt(v_mastery/25.0))::integer,1,case when r.placement<=1 then 1 else 0 end)
				on conflict(user_id,guardian_name) do update set
					mastery_xp=guardian_mastery.mastery_xp+excluded.mastery_xp,
					mastery_level=1+floor(sqrt((guardian_mastery.mastery_xp+excluded.mastery_xp)/25.0))::integer,
					games_played=guardian_mastery.games_played+1,
					wins=guardian_mastery.wins+excluded.wins, updated_at=now();
			end if;
		end if;
	end loop;
	return progression_snapshot(p_user_id);
end; $$;

create or replace function arc_spirits_2d.purchase_cosmetic(p_user_id uuid, p_item_id text)
returns jsonb language plpgsql security definer set search_path=arc_spirits_2d as $$
declare v_price integer;
begin
	perform reconcile_player_progression(p_user_id);
	perform pg_advisory_xact_lock(hashtextextended('arc_spirits_2d.progression:' || p_user_id::text, 0));
	select price into v_price from cosmetic_catalog where id=p_item_id and active;
	if not found then raise exception 'cosmetic_not_found'; end if;
	if exists(select 1 from player_cosmetic_ownership where user_id=p_user_id and item_id=p_item_id) then
		return progression_snapshot(p_user_id);
	end if;
	update player_progression set credits=credits-v_price,updated_at=now()
		where user_id=p_user_id and credits>=v_price;
	if not found then raise exception 'insufficient_credits'; end if;
	insert into player_cosmetic_ownership(user_id,item_id,source) values(p_user_id,p_item_id,'purchase');
	return progression_snapshot(p_user_id);
end; $$;

create or replace function arc_spirits_2d.equip_cosmetic(p_user_id uuid, p_item_id text, p_guardian_name text default null)
returns jsonb language plpgsql security definer set search_path=arc_spirits_2d as $$
declare v_kind text; v_target text;
begin
	perform reconcile_player_progression(p_user_id);
	perform pg_advisory_xact_lock(hashtextextended('arc_spirits_2d.progression:' || p_user_id::text, 0));
	select c.kind,c.target_guardian into v_kind,v_target from cosmetic_catalog c
		join player_cosmetic_ownership o on o.item_id=c.id and o.user_id=p_user_id
		where c.id=p_item_id and c.active;
	if not found then raise exception 'cosmetic_not_owned'; end if;
	update player_loadouts set
		equipped_border_id=case when v_kind='border' then p_item_id else equipped_border_id end,
		equipped_banner_id=case when v_kind='banner' then p_item_id else equipped_banner_id end,
		equipped_guardian_skins=case when v_kind='guardianSkin' then jsonb_set(equipped_guardian_skins,array[coalesce(nullif(p_guardian_name,''),v_target,'Any Guardian')],to_jsonb(p_item_id),true) else equipped_guardian_skins end,
		equipped_board_environment_id=case when v_kind='boardEnvironment' then p_item_id else equipped_board_environment_id end,
		equipped_summon_trail_id=case when v_kind='summonTrail' then p_item_id else equipped_summon_trail_id end,
		equipped_card_finish_id=case when v_kind='cardFinish' then p_item_id else equipped_card_finish_id end,
		equipped_nameplate_id=case when v_kind='nameplate' then p_item_id else equipped_nameplate_id end,
		equipped_emote_id=case when v_kind='emote' then p_item_id else equipped_emote_id end,
		equipped_victory_pose_id=case when v_kind='victoryPose' then p_item_id else equipped_victory_pose_id end,
		equipped_profile_scene_id=case when v_kind='profileScene' then p_item_id else equipped_profile_scene_id end,
		updated_at=now() where user_id=p_user_id;
	return progression_snapshot(p_user_id);
end; $$;

revoke all on function arc_spirits_2d.progression_snapshot(uuid) from public, anon, authenticated;
revoke all on function arc_spirits_2d.reconcile_player_progression(uuid) from public, anon, authenticated;
revoke all on function arc_spirits_2d.purchase_cosmetic(uuid,text) from public, anon, authenticated;
revoke all on function arc_spirits_2d.equip_cosmetic(uuid,text,text) from public, anon, authenticated;
grant execute on function arc_spirits_2d.progression_snapshot(uuid) to service_role;
grant execute on function arc_spirits_2d.reconcile_player_progression(uuid) to service_role;
grant execute on function arc_spirits_2d.purchase_cosmetic(uuid,text) to service_role;
grant execute on function arc_spirits_2d.equip_cosmetic(uuid,text,text) to service_role;
