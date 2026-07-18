-- A ranked seat that stays disconnected past the live-match recovery grace is
-- abandoned exactly once and handed to the server bot. At least one other human
-- must still be present; when everybody is gone the existing whole-room
-- abandonment finalizer remains authoritative. No asynchronous game is created.

create or replace function arc_spirits_2d.takeover_stale_ranked_members(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path=arc_spirits_2d as $$
declare
	s play_game_sessions%rowtype;
	m play_session_members%rowtype;
	now_at timestamptz := clock_timestamp();
	cutoff timestamptz := now_at - interval '120 seconds';
	wrote integer;
	taken integer := 0;
	next_revision integer;
	next_state jsonb;
begin
	-- Serializes against command CAS updates and another takeover sweep.
	select * into s from play_game_sessions where id=p_session_id for update;
	if not found or s.status<>'active' or s.mode<>'ranked' or s.ranked_season_id is null then
		return jsonb_build_object('takenOver',0,'reason','not_active_ranked');
	end if;

	-- Do not convert the last/all stale humans here. The room lifecycle owns the
	-- all-humans-gone finalization and closes that match as a single transaction.
	if not exists(
		select 1 from play_session_members
		where session_id=p_session_id and not is_bot and user_id is not null
			and last_seen_at>=cutoff
	) then
		return jsonb_build_object('takenOver',0,'allHumansGone',true);
	end if;

	for m in
		select * from play_session_members
		where session_id=p_session_id and not is_bot and user_id is not null
			and last_seen_at<cutoff
		order by id for update
	loop
		insert into ranked_participation(
			session_id,member_id,season_id,user_id,abandoned,abandonment_kind,
			abandoned_at,bot_controlled_at
		) values(
			p_session_id,m.id,s.ranked_season_id,m.user_id,true,'disconnect_deadline',now_at,now_at
		)
		on conflict(session_id,member_id) do update set
			abandoned=true,
			abandonment_kind='disconnect_deadline',
			abandoned_at=coalesce(ranked_participation.abandoned_at,excluded.abandoned_at),
			bot_controlled_at=coalesce(ranked_participation.bot_controlled_at,excluded.bot_controlled_at)
		where not ranked_participation.abandoned;
		get diagnostics wrote=row_count;
		if wrote>0 then
			update play_session_members set
				is_bot=true,
				bot_profile=coalesce(bot_profile,'neural-v1'),
				updated_at=now_at
			where id=m.id and not is_bot;
			taken := taken+1;
		end if;
	end loop;

	if taken=0 then return jsonb_build_object('takenOver',0); end if;

	-- Member metadata changes are observable room state. Bump the canonical room
	-- revision and append a non-player system event so HTTP and WebSocket clients
	-- cannot retain an equal-revision pre-takeover projection.
	next_revision := s.revision+1;
	next_state := jsonb_set(coalesce(s.public_state,'{}'::jsonb),'{revision}',to_jsonb(next_revision),true);
	update play_game_sessions set revision=next_revision,public_state=next_state where id=p_session_id;
	insert into play_game_session_events(
		session_id,revision,actor_member_id,command_type,command_payload
	) values(
		p_session_id,next_revision,null,'rankedDisconnectTakeover',
		jsonb_build_object('takenOver',taken,'graceSeconds',120)
	);
	return jsonb_build_object('takenOver',taken,'revision',next_revision);
end $$;

revoke all on function arc_spirits_2d.takeover_stale_ranked_members(uuid)
	from public,anon,authenticated;
grant execute on function arc_spirits_2d.takeover_stale_ranked_members(uuid)
	to service_role;
