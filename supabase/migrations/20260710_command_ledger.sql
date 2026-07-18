-- Command ledger: durable exactly-once command identity + atomic room commits.
--
-- Context (2026-07-10 multiplayer-authority batch): every room mutation now goes
-- through ONE durable compare-and-set commit on play_game_sessions.revision, from
-- both transports (HTTP runRoomCommand and the WebSocket room server, which is now
-- write-through instead of snapshot-based). Client retries carry a `cmdId` embedded
-- in the event payload. This migration adds:
--
--   1. a generated `cmd_id` column + partial unique index on
--      play_game_session_events, making (session_id, cmd_id) a DB-enforced
--      exactly-once boundary;
--   2. `commit_room_command(...)` — dedup check + revision CAS + ledger append in
--      ONE transaction, so an ack can never precede durability and a crash can
--      never separate the state write from its idempotency marker. The dedup is
--      IDENTITY-BOUND: a retry only answers `duplicate` when its (actor, command
--      type, payload) matches the committed original; a re-used cmdId with a
--      different identity answers `idempotency_conflict` and applies nothing.
--      Strict monotonicity is validated inside the function (next > expected,
--      state/event revisions coherent) — violations raise.
--   3. a BEFORE UPDATE trigger on play_game_sessions making "revision can only
--      grow" structurally true for EVERY writer: revision never decreases, and
--      public_state never changes under an unchanged revision.
--
-- ORDERING: apply this migration BEFORE serving live traffic. The application
-- FAILS CLOSED without it — commands are rejected with a `store_not_ready`
-- readiness error, because the pre-migration non-atomic fallback (dedup SELECT →
-- CAS UPDATE → ledger INSERT as separate statements) cannot promise exactly-once
-- across a crash between its statements. That fallback remains available ONLY
-- behind the explicit local/test opt-in ARC_ALLOW_NONATOMIC_COMMIT=1 (used by the
-- pre-migration test suites). Apply via the Supabase SQL editor or CLI.

alter table arc_spirits_2d.play_game_session_events
	add column if not exists cmd_id text
		generated always as (command_payload->>'cmdId') stored;

create unique index if not exists play_game_session_events_cmd_unique
	on arc_spirits_2d.play_game_session_events (session_id, cmd_id)
	where cmd_id is not null;

-- Structural monotonicity: no writer — RPC, fallback, close sweep, or manual — can
-- roll a room's revision back or rewrite its state under the same revision.
create or replace function arc_spirits_2d.enforce_session_revision_monotonic()
returns trigger
language plpgsql
as $$
begin
	if new.revision < old.revision then
		raise exception 'play_game_sessions.revision must not decrease (% -> %): revision_not_monotonic',
			old.revision, new.revision;
	end if;
	if new.revision = old.revision and new.public_state is distinct from old.public_state then
		raise exception 'play_game_sessions.public_state must not change under an unchanged revision %: revision_not_monotonic',
			new.revision;
	end if;
	return new;
end
$$;

drop trigger if exists play_game_sessions_revision_monotonic on arc_spirits_2d.play_game_sessions;
create trigger play_game_sessions_revision_monotonic
	before update on arc_spirits_2d.play_game_sessions
	for each row execute function arc_spirits_2d.enforce_session_revision_monotonic();

create or replace function arc_spirits_2d.commit_room_command(
	p_session_id uuid,
	p_expected_revision integer,
	p_next_revision integer,
	p_status text,
	p_game_id text,
	p_scenario jsonb,
	p_public_state jsonb,
	p_stamp_started_at boolean,
	p_stamp_ended_at boolean,
	p_events jsonb
) returns jsonb
language plpgsql
security definer
set search_path = arc_spirits_2d
as $$
declare
	v_row play_game_sessions%rowtype;
	v_evt jsonb;
	v_cmd_id text;
	v_existing record;
begin
	-- Strict monotonicity: the committed history can only move forward, and the
	-- written state/events must agree with the declared next revision.
	if p_next_revision is null or p_next_revision <= p_expected_revision then
		raise exception 'commit_room_command: p_next_revision (%) must exceed p_expected_revision (%) — revision_not_monotonic',
			p_next_revision, p_expected_revision;
	end if;
	if coalesce((p_public_state->>'revision')::integer, -1) <> p_next_revision then
		raise exception 'commit_room_command: p_public_state.revision (%) must equal p_next_revision (%) — revision_incoherent',
			p_public_state->>'revision', p_next_revision;
	end if;
	for v_evt in select value from jsonb_array_elements(coalesce(p_events, '[]'::jsonb))
	loop
		if (v_evt->>'revision')::integer is null
			or (v_evt->>'revision')::integer <= p_expected_revision
			or (v_evt->>'revision')::integer > p_next_revision then
			raise exception 'commit_room_command: event revision (%) outside (%, %] — event_revision_incoherent',
				v_evt->>'revision', p_expected_revision, p_next_revision;
		end if;
	end loop;

	-- Exactly-once, identity-bound: an event carrying an already-committed cmdId is
	-- answered from the ledger. An honest retry (same actor + command type + payload,
	-- cmdId excluded from the comparison since it is equal by definition) gets
	-- 'duplicate' with the ORIGINAL committed revision, applying nothing. The same
	-- cmdId re-used with a DIFFERENT identity gets 'idempotency_conflict' — it is not
	-- the original action and must never be silently substituted for it.
	for v_evt in select value from jsonb_array_elements(coalesce(p_events, '[]'::jsonb))
	loop
		v_cmd_id := v_evt->'command_payload'->>'cmdId';
		if v_cmd_id is not null then
			select ev.revision, ev.actor_member_id, ev.command_type, ev.command_payload
				into v_existing
				from play_game_session_events ev
				where ev.session_id = p_session_id and ev.cmd_id = v_cmd_id
				limit 1;
			if found then
				if v_existing.actor_member_id is distinct from nullif(v_evt->>'actor_member_id', '')::uuid
					or v_existing.command_type is distinct from (v_evt->>'command_type')
					or (v_existing.command_payload - 'cmdId') is distinct from ((v_evt->'command_payload') - 'cmdId') then
					return jsonb_build_object('outcome', 'idempotency_conflict', 'revision', v_existing.revision);
				end if;
				return jsonb_build_object('outcome', 'duplicate', 'revision', v_existing.revision);
			end if;
		end if;
	end loop;

	-- Revision CAS: the single fence for every writer (HTTP, WS instances, bots,
	-- deadlines, room close). Revision can only move forward, on one history.
	update play_game_sessions
		set status = p_status,
			revision = p_next_revision,
			game_id = p_game_id,
			scenario = p_scenario,
			public_state = p_public_state,
			started_at = case when p_stamp_started_at and started_at is null then now() else started_at end,
			ended_at = case when p_stamp_ended_at and ended_at is null then now() else ended_at end
		where id = p_session_id and revision = p_expected_revision
		returning * into v_row;
	if not found then
		return jsonb_build_object('outcome', 'cas_miss');
	end if;

	insert into play_game_session_events
		(session_id, revision, actor_member_id, command_type, command_payload)
	select
		p_session_id,
		(e->>'revision')::integer,
		nullif(e->>'actor_member_id', '')::uuid,
		e->>'command_type',
		coalesce(e->'command_payload', '{}'::jsonb)
	from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e;

	return jsonb_build_object('outcome', 'committed', 'row', to_jsonb(v_row));
exception when unique_violation then
	-- A concurrent writer committed the same cmdId between our dedup check and the
	-- insert. The exception rolls back this block's UPDATE too (plpgsql exception
	-- semantics), so the answer below is the ONLY effect of this call. Re-run the
	-- identity comparison against the winner's ledger row.
	for v_evt in select value from jsonb_array_elements(coalesce(p_events, '[]'::jsonb))
	loop
		v_cmd_id := v_evt->'command_payload'->>'cmdId';
		if v_cmd_id is not null then
			select ev.revision, ev.actor_member_id, ev.command_type, ev.command_payload
				into v_existing
				from play_game_session_events ev
				where ev.session_id = p_session_id and ev.cmd_id = v_cmd_id
				limit 1;
			if found then
				if v_existing.actor_member_id is distinct from nullif(v_evt->>'actor_member_id', '')::uuid
					or v_existing.command_type is distinct from (v_evt->>'command_type')
					or (v_existing.command_payload - 'cmdId') is distinct from ((v_evt->'command_payload') - 'cmdId') then
					return jsonb_build_object('outcome', 'idempotency_conflict', 'revision', v_existing.revision);
				end if;
				return jsonb_build_object('outcome', 'duplicate', 'revision', v_existing.revision);
			end if;
		end if;
	end loop;
	return jsonb_build_object('outcome', 'duplicate', 'revision', -1);
end
$$;

revoke all on function arc_spirits_2d.commit_room_command(uuid, integer, integer, text, text, jsonb, jsonb, boolean, boolean, jsonb) from public;
grant execute on function arc_spirits_2d.commit_room_command(uuid, integer, integer, text, text, jsonb, jsonb, boolean, boolean, jsonb) to service_role;
