-- Player-readable achievement definitions and one idempotent service-only
-- season rollover transaction. The canonical Arc Spirits account remains the
-- authority; platform services receive outbound mirrors only.

alter table arc_spirits_2d.achievement_definitions
	add column if not exists target integer not null default 1 check (target > 0);

update arc_spirits_2d.achievement_definitions set target=5 where id='placements-complete';
update arc_spirits_2d.achievement_definitions set target=1
	where id in ('first-ranked-match','first-ranked-win','reach-gold');

create or replace function arc_spirits_2d.roll_ranked_season(
	p_current_season_id text,
	p_next_season_id text,
	p_next_name text,
	p_starts_at timestamptz,
	p_ends_at timestamptz
) returns jsonb language plpgsql security definer set search_path=arc_spirits_2d as $$
declare current_season ranked_seasons%rowtype; next_season ranked_seasons%rowtype; close_result jsonb;
	copied_rules integer;
begin
	if p_current_season_id is null or p_next_season_id is null or p_current_season_id=p_next_season_id
		or p_next_name is null or btrim(p_next_name)='' or p_ends_at<=p_starts_at then
		raise exception 'invalid_season_rollover';
	end if;
	perform pg_advisory_xact_lock(hashtextextended('arc_spirits_2d.roll-season',0));
	select * into next_season from ranked_seasons where id=p_next_season_id;
	if found then
		if next_season.status='active' then
			return jsonb_build_object('rolled',false,'already_active',true,'season_id',next_season.id);
		end if;
		raise exception 'next_season_id_exists';
	end if;
	select * into current_season from ranked_seasons where id=p_current_season_id for update;
	if not found or current_season.status not in ('active','closed') then raise exception 'current_season_not_found'; end if;
	if exists(select 1 from ranked_seasons where status='active' and id<>p_current_season_id) then
		raise exception 'another_season_is_active';
	end if;
	close_result := close_ranked_season(p_current_season_id);
	insert into ranked_seasons(id,name,status,starts_at,ends_at,placement_games,decay_grace_days,
		decay_sigma_step,reset_mu_factor,reset_sigma_floor,rules_version)
	values(p_next_season_id,btrim(p_next_name),'active',p_starts_at,p_ends_at,current_season.placement_games,
		current_season.decay_grace_days,current_season.decay_sigma_step,current_season.reset_mu_factor,
		current_season.reset_sigma_floor,current_season.rules_version+1);
	insert into ranked_division_rules(season_id,division_key,label,tier_order,min_ordinal)
	select p_next_season_id,division_key,label,tier_order,min_ordinal
	from ranked_division_rules where season_id=p_current_season_id;
	get diagnostics copied_rules=row_count;
	if copied_rules=0 then raise exception 'current_season_has_no_division_rules'; end if;
	return jsonb_build_object('rolled',true,'closed',close_result,'season_id',p_next_season_id,
		'rules_version',current_season.rules_version+1,'division_rules',copied_rules);
end $$;

revoke all on function arc_spirits_2d.roll_ranked_season(text,text,text,timestamptz,timestamptz)
	from public,anon,authenticated;
grant execute on function arc_spirits_2d.roll_ranked_season(text,text,text,timestamptz,timestamptz)
	to service_role;
