-- Entry-operation compensation contract for room create / solo / join.
--
-- PROBLEM: an aborted create/solo/join can COMMIT server-side while the client
-- never receives the response body (fetch aborted after the server acted —
-- "ambiguous commit"). Pre-fix, compensation relied on the response's roomCode,
-- so exactly the ambiguous case was uncompensatable: the player was left
-- holding an invisible room/membership (create/solo: an unguessable generated
-- code the client never learned; join: no way to tell a NEWLY added membership
-- apart from a pre-existing one it must not remove).
--
-- CONTRACT: the client mints an unguessable ENTRY-OP ID (`peo_` + 43 base64url
-- chars) BEFORE sending the request and includes it in the body. The server
--   - stamps `origin_op` on the SESSION a create/solo op creates, and on the
--     MEMBERSHIP a join op CREATES (an idempotent re-join of an existing member
--     stamps nothing — that membership belongs to an earlier op/none);
--   - lets the authenticated owner ABANDON the op: tombstone the op id, then
--     resolve exactly what it created (session by origin_op / membership by
--     origin_op + user) and leave/close it — a pre-existing membership can
--     never match, so it is never removed;
--   - re-checks the tombstone AFTER a create/join commits: an abandon that
--     raced AHEAD of the (still in-flight) request wins in every ordering, the
--     late commit self-compensates.
--
-- The columns are nullable and ignored by legacy writers (rolling-safe); the
-- tombstone rows are ephemera (reaped after an hour, far beyond any late HTTP
-- request). Idempotent: guarded with IF NOT EXISTS / catalog checks throughout.
--
-- DO NOT APPLY from the app repo CI — reviewed + applied with the release.

alter table arc_spirits_2d.play_game_sessions
	add column if not exists origin_op text;
create index if not exists play_game_sessions_origin_op_idx
	on arc_spirits_2d.play_game_sessions (origin_op)
	where origin_op is not null;

alter table arc_spirits_2d.play_session_members
	add column if not exists origin_op text;
create index if not exists play_session_members_origin_op_idx
	on arc_spirits_2d.play_session_members (origin_op)
	where origin_op is not null;

-- Tombstones: one row per abandoned entry-op id. Same posture as the runtime
-- tables (service-role-only; the authenticated HTTP layer is the sole writer).
create table if not exists arc_spirits_2d.play_entry_op_cancellations (
	op_id text primary key,
	user_id uuid,
	cancelled_at timestamptz not null default now()
);
create index if not exists play_entry_op_cancellations_age_idx
	on arc_spirits_2d.play_entry_op_cancellations (cancelled_at);
alter table arc_spirits_2d.play_entry_op_cancellations enable row level security;
alter table arc_spirits_2d.play_entry_op_cancellations owner to current_user;
revoke all on table arc_spirits_2d.play_entry_op_cancellations from public;
do $$
begin
	if exists (select 1 from pg_roles where rolname = 'service_role') then
		grant select, insert, update, delete
			on table arc_spirits_2d.play_entry_op_cancellations to service_role;
		drop policy if exists play_entry_op_cancellations_service_role_only
			on arc_spirits_2d.play_entry_op_cancellations;
		create policy play_entry_op_cancellations_service_role_only
			on arc_spirits_2d.play_entry_op_cancellations
			for all
			to service_role
			using (true)
			with check (true);
	end if;
end
$$;
alter table arc_spirits_2d.play_entry_op_cancellations force row level security;
