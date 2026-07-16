-- Account-identity trust model + WS join tickets + central room admission.
--
-- The validated Supabase identity (permanent account or automatically-created
-- anonymous account) becomes the SOLE durable human principal for play:
--
--   1. CANONICAL MEMBERSHIP — exactly one human membership per (session, user).
--      The public member UUID (`play_session_members.id`) is a display label only
--      and never authorizes. Existing duplicate (session, user) human rows are
--      QUARANTINED (user_id nulled on all but the most recently seen row) rather
--      than deleted, so ledger/actor references stay intact.
--   2. LEGACY UNOWNED HUMANS — a human membership with no owning account has NO
--      safe claim path (a UUID or display name can never prove ownership), so any
--      still-open room containing one is CLOSED for security upgrade instead of
--      letting anyone impersonate the member. (The application enforces the same
--      rule opportunistically for stores where this migration lags.)
--   3. RETIRED CREDENTIALS — the never-accepted per-room member_secret column,
--      its unique index and mint function are dropped IF they exist (they only
--      ever existed on stores where the unshipped interim design was applied).
--   4. WS TICKETS — `play_ws_tickets` stores SHA-256 digests of the short-lived,
--      one-use, room-scoped WebSocket join tickets. Only a digest is ever stored;
--      the ENTIRE lifecycle is DATABASE-WALL-CLOCK governed: minting happens
--      EXCLUSIVELY through `mint_ws_ticket(session, user, member, role, digest)`
--      (created_at/expires_at fixed by clock_timestamp() with a 30-second lifetime
--      baked into the function body — no caller-supplied time or TTL), consumption
--      EXCLUSIVELY through `consume_ws_ticket(digest)`, one conditional UPDATE
--      (one winner under replay) whose expiry predicate reads the DATABASE clock,
--      and hygiene through `cleanup_ws_tickets()`, which deletes only rows the
--      database itself considers long dead. Application clock skew can therefore
--      never stretch a lifetime, mint a dead-on-arrival ticket, resurrect an
--      expired digest, or sweep a valid one.
--
--      WALL CLOCK, NOT TRANSACTION CLOCK: every lifecycle decision reads
--      clock_timestamp() (the actual instant of evaluation), NEVER now()/
--      transaction_timestamp() (frozen at transaction start). A consume
--      transaction that began before expiry and then blocked on the row lock
--      until after expiry would, under now(), still satisfy `expires_at > now()`
--      and claim a wall-expired ticket; under clock_timestamp() the re-evaluated
--      predicate and the UPDATE trigger both see the true wall time and refuse.
--
--      ROLLING-UPGRADE ENFORCEMENT: the functions are the intended API, but during
--      a migration-first rolling deployment a still-running LEGACY application
--      instance keeps issuing the old direct DML (INSERT with app-clock
--      created/expires values, an app-clock conditional consume UPDATE, an
--      app-clock cleanup DELETE) under service_role grants. Row triggers therefore
--      make the TABLE ITSELF enforce the lifecycle invariants for every writer,
--      privileged or not:
--        - BEFORE INSERT overwrites created_at/expires_at with the DATABASE clock
--          (30-second lifetime) and refuses born-consumed rows — a legacy direct
--          mint keeps WORKING but can no longer stretch a lifetime or mint a
--          dead-on-arrival ticket;
--        - BEFORE UPDATE pins every binding column (id/session/user/member/role/
--          digest) and both clock columns immutable, makes consumption ONE-WAY
--          (a consumed_at can never be reset or moved) and DB-clocked (the stored
--          consumed_at is clock_timestamp(), and a DB-expired row can never
--          transition to consumed no matter what predicate the app evaluated);
--        - BEFORE DELETE silently skips any row the database does not consider
--          long dead (expired over 10 minutes ago by clock_timestamp()) — a
--          legacy fast-clock sweep deletes nothing valid, matching
--          cleanup_ws_tickets() semantics.
--      Direct service mistakes and legacy writers alike therefore cannot bypass
--      immutable bindings/expiry, reset consumption, or delete a DB-valid ticket.
--
--      PARTIAL PRE-EXISTING TABLES are fully healed to the canonical shape:
--      missing columns added, unbindable / null-role / null-expiry rows deleted
--      (a null expiry would otherwise evade both consume and cleanup forever),
--      stretched expiries clamped to the canonical 30-second horizon, null
--      created_at backfilled, NOT-NULL/default posture normalized (role defaults
--      'spectator', created_at defaults now(), expires_at carries NO default),
--      the role CHECK re-declared canonically, and duplicate digests deleted
--      (tickets are ephemera) before the unique digest index is healed BY
--      SEMANTICS (a same-named non-unique/wrong-column/INVALID index is dropped
--      and rebuilt, never trusted by name — indisvalid/indisready/indislive are
--      part of the check, so the debris of a failed CREATE UNIQUE INDEX
--      CONCURRENTLY, unique in the catalog but enforcing NOTHING, is rebuilt
--      too) — apply-twice converges on the same declared schema as a fresh
--      create. The table is SERVICE-ROLE-ONLY regardless of the store's
--      inherited default privileges AND of whatever grants/policies/OWNERSHIP a
--      pre-existing table accumulated: ownership is converged to the migration
--      principal FIRST (a hostile/divergent partial table may be owned by a
--      forgotten legacy role, and a table owner bypasses non-FORCE RLS,
--      re-grants itself, disables triggers, and replaces trigger functions at
--      will), then every table/column ACL entry and every RLS policy is
--      enumerated and stripped (the converged owner excepted), then RLS + FORCE
--      ROW LEVEL SECURITY + a single service_role policy + the explicit
--      service_role grant are re-established — a permissive store can no longer
--      let anon (or any forgotten legacy role) insert a chosen digest bound to
--      a victim, a restrictive store can no longer strand service_role without
--      access, and a displaced rogue owner retains NO bypass: it cannot insert
--      outside policy, cannot ALTER the table or its triggers, and cannot
--      replace the lifecycle trigger functions (their ownership is converged
--      too). The intended trusted bypass paths are exactly: the migration
--      principal's own DDL/healing, and service_role's policy-admitted DML —
--      still subject to the lifecycle triggers.
--   5. CENTRAL ADMISSION — `play_game_sessions.visibility` ('public'|'private').
--      Ranked/matchmade/rematch rooms are private: never listed, never generically
--      joinable, invisible to non-members on every read path. A BEFORE
--      INSERT/UPDATE trigger enforces ranked ⇒ private at the TABLE for every
--      writer — a rolling legacy instance that omits the new column can never
--      mint a public ranked room off the column default.
--   6. MATCH QUEUE VERIFICATION — `match_queue.is_verified` records (server-side,
--      from the validated user) whether the queued human holds a PERMANENT account.
--      A claimed group containing an unverified human plays casual/unrated.
--
-- Portable, idempotent, privilege-safe: every step is guarded (IF EXISTS /
-- IF NOT EXISTS / catalog checks); re-running is a no-op. RLS/grants for
-- PRE-EXISTING tables are deliberately untouched; the table this migration OWNS
-- (play_ws_tickets) gets an explicit service-role-only posture in section 4.
--
-- DO NOT APPLY from the app repo CI — reviewed + applied with the release.

-- ── 1. canonical human membership ───────────────────────────────────────────────

-- Quarantine duplicate (session, user) human memberships: keep the row most
-- recently seen (ties: latest joined), null the account on the rest. Non-destructive
-- — the rows (and any ledger references to them) survive as unowned labels.
with ranked_members as (
	select
		id,
		row_number() over (
			partition by session_id, user_id
			order by last_seen_at desc nulls last, joined_at desc nulls last, id desc
		) as rn
	from arc_spirits_2d.play_session_members
	where user_id is not null and is_bot = false
)
update arc_spirits_2d.play_session_members m
set user_id = null
from ranked_members r
where m.id = r.id and r.rn > 1;

create unique index if not exists play_session_members_session_user_unique
	on arc_spirits_2d.play_session_members (session_id, user_id)
	where user_id is not null and is_bot = false;

-- ── 2. close still-open rooms containing unowned human memberships ─────────────
-- (Includes any rows just quarantined above — those rooms cannot be safely
-- re-authenticated, so they end explicitly rather than impersonably.)

update arc_spirits_2d.play_game_sessions s
set
	status = 'closed',
	ended_at = coalesce(s.ended_at, now()),
	revision = s.revision + 1,
	public_state = jsonb_set(
		jsonb_set(coalesce(s.public_state, '{}'::jsonb), '{status}', '"closed"'),
		'{revision}',
		to_jsonb(s.revision + 1)
	)
where s.status in ('lobby', 'active')
	and exists (
		select 1
		from arc_spirits_2d.play_session_members m
		where m.session_id = s.id and m.is_bot = false and m.user_id is null
	);

-- ── 3. retire the interim member_secret credential (if it ever existed) ────────

drop index if exists arc_spirits_2d.play_session_members_member_secret_key;
alter table arc_spirits_2d.play_session_members
	drop column if exists member_secret;
drop function if exists arc_spirits_2d.mint_member_secret();

-- ── 4. WS join tickets (digest-only storage, service-role-only) ─────────────────

create table if not exists arc_spirits_2d.play_ws_tickets (
	id uuid primary key default gen_random_uuid(),
	session_id uuid not null,
	user_id uuid not null,
	member_id uuid,
	role text not null default 'spectator' check (role in ('member', 'spectator')),
	digest text not null,
	expires_at timestamptz not null,
	consumed_at timestamptz,
	created_at timestamptz not null default now()
);

-- Healing runs TRIGGER-FREE: on a re-apply the lifecycle triggers (installed at
-- the end of this section) would otherwise veto the healing DML itself. Dropped
-- here, recreated below — the whole migration applies in one transaction.
drop trigger if exists play_ws_tickets_lifecycle_insert on arc_spirits_2d.play_ws_tickets;
drop trigger if exists play_ws_tickets_lifecycle_update on arc_spirits_2d.play_ws_tickets;
drop trigger if exists play_ws_tickets_lifecycle_delete on arc_spirits_2d.play_ws_tickets;

-- OWNERSHIP CONVERGENCE — before ANY healing DML. A hostile/divergent partial
-- table may be OWNED by a forgotten legacy role, and PostgreSQL table owners
-- hold implicit, effectively irrevocable powers no ACL/policy sweep can touch:
-- they bypass non-FORCE RLS entirely, may GRANT themselves (or anyone) back in,
-- may ALTER TABLE … DISABLE TRIGGER to switch the lifecycle enforcement off,
-- and may re-declare the table's constraints. The posture convergence below
-- deliberately skips "the owner", so with a rogue owner in place the whole
-- convergence was a no-op FOR THE ONE ROLE that mattered most. Converging
-- ownership to the migration principal first makes the later owner-exception
-- mean what it says (the migration/DDL principal, not a client role), lets the
-- enumeration strip any explicit grants the former owner held, and — together
-- with FORCE ROW LEVEL SECURITY at the end of this section — leaves the
-- intended trusted paths as exactly: migration DDL/healing, and service_role's
-- policy-admitted (trigger-governed) DML.
alter table arc_spirits_2d.play_ws_tickets owner to current_user;

-- The healing DML below runs as the (now-converged) owner. A prior apply left
-- FORCE ROW LEVEL SECURITY set, which subjects even the owner to the
-- service-role-only policy and would veto the healing on stores where the
-- migration principal lacks BYPASSRLS — lift it for the healing window (owner
-- bypass under plain-enabled RLS) and re-establish it at the end of section 4.
alter table arc_spirits_2d.play_ws_tickets no force row level security;

-- Hand-created-table hardening (mirrors the ranked-finalize convention): make the
-- shape right even if a prior PARTIAL version of this table exists — INCLUDING the
-- binding columns (session_id / user_id / digest) and the id/clock columns. New
-- binding columns arrive nullable first; rows that predate them are unusable
-- 30-second tickets with no provable binding, so they are deleted before NOT NULL
-- is enforced. Losing an unexpired ticket only forces one client re-mint; honoring
-- an unbound one would be an authentication bypass.
alter table arc_spirits_2d.play_ws_tickets
	add column if not exists id uuid default gen_random_uuid(),
	add column if not exists session_id uuid,
	add column if not exists user_id uuid,
	add column if not exists digest text,
	add column if not exists member_id uuid,
	add column if not exists role text,
	add column if not exists expires_at timestamptz,
	add column if not exists consumed_at timestamptz,
	add column if not exists created_at timestamptz;

-- Unhealable rows: no provable binding, an invalid/unknown role, or a NULL expiry
-- (which would satisfy neither the consume predicate nor the cleanup cutoff and
-- so persist forever). Tickets are 30-second ephemera — deletion costs at most
-- one client re-mint.
delete from arc_spirits_2d.play_ws_tickets
	where session_id is null or user_id is null or digest is null
		or role is null or role not in ('member', 'spectator')
		or expires_at is null;

-- Healable metadata: a missing id/created_at is backfilled, and a legacy expiry
-- stretched past the canonical horizon is clamped — a partial table can never
-- smuggle a long-lived ticket through the migration. clock_timestamp(): the
-- migration transaction may run long; heal against the wall clock, not its start.
update arc_spirits_2d.play_ws_tickets set id = gen_random_uuid() where id is null;
update arc_spirits_2d.play_ws_tickets set created_at = clock_timestamp() where created_at is null;
update arc_spirits_2d.play_ws_tickets
	set expires_at = clock_timestamp() + interval '30 seconds'
	where expires_at > clock_timestamp() + interval '30 seconds';

-- Canonical nullability + default posture (idempotent to re-declare): role
-- defaults 'spectator', created_at defaults now(), id defaults gen_random_uuid(),
-- expires_at carries NO default (the trigger/mint function always supply it).
alter table arc_spirits_2d.play_ws_tickets
	alter column id set not null,
	alter column id set default gen_random_uuid(),
	alter column session_id set not null,
	alter column user_id set not null,
	alter column digest set not null,
	alter column role set not null,
	alter column role set default 'spectator',
	alter column expires_at set not null,
	alter column expires_at drop default,
	alter column created_at set not null,
	alter column created_at set default now();

-- Primary key, if the partial table never declared one.
do $$
begin
	if not exists (
		select 1 from pg_constraint
		where conrelid = 'arc_spirits_2d.play_ws_tickets'::regclass and contype = 'p'
	) then
		alter table arc_spirits_2d.play_ws_tickets add primary key (id);
	end if;
end
$$;

-- The role CHECK is re-DECLARED (not just added-if-missing) so a partial table
-- carrying a same-named constraint with a different definition still converges
-- on the canonical one.
alter table arc_spirits_2d.play_ws_tickets
	drop constraint if exists play_ws_tickets_role_check;
alter table arc_spirits_2d.play_ws_tickets
	add constraint play_ws_tickets_role_check
	check (role in ('member', 'spectator'));

-- Duplicate digests in a partial pre-existing table make the binding ambiguous —
-- two rows claim the same credential, and honoring either could authenticate the
-- wrong principal. Tickets are 30-second ephemera, so ALL rows sharing a duplicated
-- digest are deleted before uniqueness is enforced (healing instead of failing the
-- index build); losing an unexpired ticket only costs one client re-mint.
delete from arc_spirits_2d.play_ws_tickets t
using (
	select digest
	from arc_spirits_2d.play_ws_tickets
	group by digest
	having count(*) > 1
) dup
where t.digest = dup.digest;

-- The digest is both the lookup key and the one-use uniqueness anchor. Healing is
-- SEMANTIC, not name-trusting: `create unique index if not exists` would silently
-- keep a same-named index that is non-unique, partial, expression-based, or over
-- the wrong column (a divergent partial schema shipped exactly that — a plain
-- index over id under this name — and duplicate digests were accepted). USABILITY
-- is part of the semantics: a failed CREATE UNIQUE INDEX CONCURRENTLY leaves a
-- canonical-named index that is unique in the catalog but INVALID (indisvalid
-- false — enforcing nothing, so duplicate digests are accepted) and possibly
-- unready/dead (indisready/indislive false); trusting its definition alone
-- re-accepted duplicates. Inspect pg_index for the actual definition AND the
-- validity flags; anything under the canonical name that is not a VALID, READY,
-- LIVE UNIQUE(digest), unconditional, plain-column index is dropped (via its
-- constraint when it backs one) and rebuilt canonically. Apply-twice: a
-- canonical survivor is kept as-is.
do $$
declare
	existing record;
	canonical boolean := false;
begin
	for existing in
		select
			c.relname as index_name,
			i.indexrelid,
			(
				i.indisunique
				and i.indisvalid
				and i.indisready
				and i.indislive
				and i.indpred is null
				and i.indexprs is null
				and i.indnkeyatts = 1
				and (
					select a.attname
					from pg_attribute a
					where a.attrelid = i.indrelid and a.attnum = i.indkey[0]
				) = 'digest'
			) as is_canonical
		from pg_index i
		join pg_class c on c.oid = i.indexrelid
		where i.indrelid = 'arc_spirits_2d.play_ws_tickets'::regclass
			and c.relname = 'play_ws_tickets_digest_key'
	loop
		if existing.is_canonical then
			canonical := true;
		elsif exists (
			select 1 from pg_constraint
			where conindid = existing.indexrelid
				and conrelid = 'arc_spirits_2d.play_ws_tickets'::regclass
		) then
			execute 'alter table arc_spirits_2d.play_ws_tickets drop constraint '
				|| quote_ident(existing.index_name);
		else
			execute 'drop index arc_spirits_2d.' || quote_ident(existing.index_name);
		end if;
	end loop;
	if not canonical then
		create unique index play_ws_tickets_digest_key
			on arc_spirits_2d.play_ws_tickets (digest);
	end if;
end
$$;
create index if not exists play_ws_tickets_expiry_idx
	on arc_spirits_2d.play_ws_tickets (expires_at);

-- SERVICE-ROLE-ONLY, regardless of the store's default privileges AND regardless
-- of whatever posture a pre-existing table accumulated.
--  - Permissive defaults (e.g. `alter default privileges … grant all to public`)
--    would otherwise let anon INSERT a chosen digest bound to a victim identity —
--    a forgeable direct path around the authenticated mint endpoint.
--  - Restrictive defaults would otherwise leave service_role without access.
--  - A pre-existing table may carry ARBITRARY legacy grants (table- OR
--    column-level, to roles this migration has never heard of) and permissive or
--    divergent RLS policies — including one squatting on the canonical policy
--    NAME with a different definition. Fixed revokes of anon/authenticated/public
--    would leave all of those standing, so the posture is CONVERGED by
--    enumeration: every table ACL entry and every column ACL entry is revoked
--    (grantees read from pg_class.relacl / pg_attribute.attacl — visible to the
--    migration regardless of role membership), every policy on the table is
--    dropped, and then exactly the canonical service_role grant + policy are
--    re-established. The table OWNER is skipped — and that exception is SAFE
--    only because ownership was converged to the migration principal at the top
--    of this section (the owner IS the migration/DDL principal by construction,
--    never a leftover client role) and because FORCE ROW LEVEL SECURITY at the
--    end of this section subjects even the owner's DML to the policy. This
--    preserves precisely the service-role DML path the lifecycle triggers
--    protect, and nothing else. Apply-twice converges.
-- RLS with a single service_role policy + explicit revokes/grants closes both,
-- and stays correct even if service_role lacks BYPASSRLS on some store.
alter table arc_spirits_2d.play_ws_tickets enable row level security;

do $$
declare
	tbl constant regclass := 'arc_spirits_2d.play_ws_tickets'::regclass;
	owner_name text;
	entry record;
begin
	select pg_get_userbyid(relowner) into owner_name from pg_class where oid = tbl;

	-- Table-level ACL: strip every grantee except the owner (grantee 0 = PUBLIC).
	for entry in
		select distinct a.grantee
		from pg_class c
		cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
		where c.oid = tbl
	loop
		if entry.grantee = 0 then
			revoke all on table arc_spirits_2d.play_ws_tickets from public;
		elsif pg_get_userbyid(entry.grantee) is distinct from owner_name then
			execute format(
				'revoke all on table arc_spirits_2d.play_ws_tickets from %I',
				pg_get_userbyid(entry.grantee)
			);
		end if;
	end loop;

	-- Column-level ACL entries are separate from the table ACL and would survive
	-- a table-level revoke; strip those too.
	for entry in
		select att.attname, a.grantee
		from pg_attribute att
		cross join lateral aclexplode(att.attacl) a
		where att.attrelid = tbl and att.attacl is not null
	loop
		if entry.grantee = 0 then
			execute format(
				'revoke all (%I) on table arc_spirits_2d.play_ws_tickets from public',
				entry.attname
			);
		elsif pg_get_userbyid(entry.grantee) is distinct from owner_name then
			execute format(
				'revoke all (%I) on table arc_spirits_2d.play_ws_tickets from %I',
				entry.attname,
				pg_get_userbyid(entry.grantee)
			);
		end if;
	end loop;

	-- Policies: drop EVERY policy on the table (permissive strangers and
	-- canonical-name squatters alike), then re-create exactly the canonical one.
	for entry in
		select policyname
		from pg_policies
		where schemaname = 'arc_spirits_2d' and tablename = 'play_ws_tickets'
	loop
		execute format(
			'drop policy %I on arc_spirits_2d.play_ws_tickets',
			entry.policyname
		);
	end loop;

	if exists (select 1 from pg_roles where rolname = 'service_role') then
		grant usage on schema arc_spirits_2d to service_role;
		grant select, insert, update, delete on table arc_spirits_2d.play_ws_tickets to service_role;
		create policy play_ws_tickets_service_role_only
			on arc_spirits_2d.play_ws_tickets
			for all
			to service_role
			using (true)
			with check (true);
	end if;
end
$$;

-- FORCE: even the table OWNER's DML goes through the policy. Without this, any
-- role that is (or ever becomes) the owner bypasses RLS entirely for plain DML —
-- the reproduced rogue-owner probe kept inserting victim-bound tickets straight
-- past the converged ACLs/policies, apply-twice notwithstanding. Ownership was
-- converged to the migration principal above, and the healing window lifts this
-- flag before its DML, so the only writers this admits are service_role (via the
-- canonical policy, still trigger-governed) and roles with BYPASSRLS/superuser.
alter table arc_spirits_2d.play_ws_tickets force row level security;

-- The ticket LIFECYCLE functions. Mint, consume and cleanup are ALL governed by
-- the DATABASE WALL clock — none of them accepts a caller-supplied timestamp or
-- lifetime, so no skewed (fast, slow, or deliberately backdated) application
-- clock can stretch a ticket's life, mint one dead on arrival, resurrect an
-- expired digest, or sweep away a ticket the database still considers valid.
--
-- clock_timestamp() EVERYWHERE, never now(): now() is transaction-start time, so
-- a consume whose transaction opened before expiry and then blocked on the row
-- lock past expiry would still pass an `expires_at > now()` predicate and claim
-- a wall-expired ticket. clock_timestamp() is the instant of evaluation — under
-- READ COMMITTED the re-checked predicate after a lock wait reads the true wall
-- time, and the UPDATE trigger below re-verifies at write time regardless.
--
--   - mint_ws_ticket(session, user, member, role, digest): the ONLY mint path.
--     The application supplies the digest and the authoritative bindings; the
--     database itself fixes created_at = clock_timestamp() and expires_at =
--     clock_timestamp() + a 30-SECOND LIFETIME THAT LIVES IN THIS BODY (not in
--     any parameter), and returns the stored row so the caller reports the true
--     expiry. Wall clock: a mint inside a long-running transaction still gets
--     its full real lifetime, anchored at the instant it actually happened.
--   - consume_ws_ticket(digest): the ONLY redemption path — one conditional
--     UPDATE (`consumed_at IS NULL AND expires_at > clock_timestamp()`), exactly
--     one winner per digest under concurrent replay.
--   - cleanup_ws_tickets(): best-effort hygiene — deletes only rows the DATABASE
--     considers long dead (expired over 10 minutes ago by clock_timestamp() —
--     deliberate wall-clock semantics, so a sweep launched inside a stale
--     transaction can never reach past the true 10-minute grace line).
--
-- LEGACY SIGNATURES: earlier interim designs shipped variants of these functions
-- with caller-supplied clocks (notably a two-argument consume_ws_ticket(text,
-- timestamptz) that accepted p_now). Every function of these names is dropped by
-- ENUMERATING pg_proc rather than guessing signatures, so the migration survives
-- ANY pre-existing variant — wrong argument list, wrong return type (where
-- CREATE OR REPLACE would fail), or both — and re-applies cleanly. Plain DROP
-- (no CASCADE): nothing in this stack may depend on these functions, and if
-- something unexpected does, failing loudly beats silently destroying it.
-- search_path is pinned empty in each function, so the fully-qualified bodies
-- cannot be hijacked by objects earlier on a caller's search path; all three are
-- SECURITY INVOKER — they add no privilege beyond the caller's own table grants.
do $$
declare
	legacy record;
begin
	for legacy in
		select p.oid::regprocedure as signature
		from pg_proc p
		join pg_namespace n on n.oid = p.pronamespace
		where n.nspname = 'arc_spirits_2d'
			and p.proname in ('mint_ws_ticket', 'consume_ws_ticket', 'cleanup_ws_tickets')
	loop
		execute format('drop function %s', legacy.signature);
	end loop;
end
$$;

create function arc_spirits_2d.mint_ws_ticket(
	p_session_id uuid,
	p_user_id uuid,
	p_member_id uuid,
	p_role text,
	p_digest text
)
returns setof arc_spirits_2d.play_ws_tickets
language sql
volatile
security invoker
set search_path = ''
as $$
	insert into arc_spirits_2d.play_ws_tickets
		(session_id, user_id, member_id, role, digest, expires_at, created_at)
	values
		(p_session_id, p_user_id, p_member_id, p_role, p_digest,
		 clock_timestamp() + interval '30 seconds', clock_timestamp())
	returning *;
$$;

create function arc_spirits_2d.consume_ws_ticket(p_digest text)
returns setof arc_spirits_2d.play_ws_tickets
language sql
volatile
security invoker
set search_path = ''
as $$
	update arc_spirits_2d.play_ws_tickets
	set consumed_at = clock_timestamp()
	where digest = p_digest
		and consumed_at is null
		and expires_at > clock_timestamp()
	returning *;
$$;

create function arc_spirits_2d.cleanup_ws_tickets()
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
	with dead as (
		delete from arc_spirits_2d.play_ws_tickets
		where expires_at < clock_timestamp() - interval '10 minutes'
		returning 1
	)
	select count(*)::integer from dead;
$$;

-- Function EXECUTE is converged by enumeration for the same reason as the table
-- ACL: fresh functions grant EXECUTE to PUBLIC by default, and ALTER DEFAULT
-- PRIVILEGES on a permissive store can stamp arbitrary extra grantees onto them
-- at creation. Every proacl grantee except the owner is revoked, then exactly
-- service_role is granted. (SECURITY INVOKER means a stray EXECUTE alone could
-- never reach the table — this keeps the declared posture honest anyway.)
do $$
declare
	fn record;
	entry record;
	owner_name text;
begin
	for fn in
		select p.oid::regprocedure as signature, pg_get_userbyid(p.proowner) as owner_name, p.proacl, p.proowner
		from pg_proc p
		join pg_namespace n on n.oid = p.pronamespace
		where n.nspname = 'arc_spirits_2d'
			and p.proname in ('mint_ws_ticket', 'consume_ws_ticket', 'cleanup_ws_tickets')
	loop
		owner_name := fn.owner_name;
		for entry in
			select distinct a.grantee
			from aclexplode(coalesce(fn.proacl, acldefault('f', fn.proowner))) a
		loop
			if entry.grantee = 0 then
				execute format('revoke all on function %s from public', fn.signature);
			elsif pg_get_userbyid(entry.grantee) is distinct from owner_name then
				execute format(
					'revoke all on function %s from %I',
					fn.signature,
					pg_get_userbyid(entry.grantee)
				);
			end if;
		end loop;
		if exists (select 1 from pg_roles where rolname = 'service_role') then
			execute format('grant execute on function %s to service_role', fn.signature);
		end if;
	end loop;
end
$$;

-- ROLLING-UPGRADE ENFORCEMENT TRIGGERS — the table itself upholds the lifecycle
-- invariants for EVERY writer, including a legacy service_role application
-- instance still issuing direct DML during a migration-first rolling deployment
-- (and any future direct service mistake). The functions above remain the API;
-- these triggers make bypassing them harmless:
--
--   INSERT — created_at/expires_at are OVERWRITTEN with the database clock and
--   the canonical 30-second lifetime (a legacy direct mint keeps working, but a
--   fast app clock cannot stretch a lifetime and a slow one cannot mint a ticket
--   dead on arrival), and a row can never be born consumed.
--   UPDATE — id/session/user/member/role/digest/created_at/expires_at are pinned
--   immutable; consumption is ONE-WAY (consumed_at can never be reset or moved)
--   and DB-clocked (the stored consumed_at is clock_timestamp()); a WALL-expired
--   row can never transition to consumed regardless of the predicate the app (or
--   an earlier snapshot of this very transaction) evaluated, so neither a
--   slow-clock legacy consume nor a consume transaction that sat blocked on the
--   row lock past expiry can resurrect a dead digest (the UPDATE matches or
--   lands zero rows and the join fails closed).
--   DELETE — only rows the DATABASE considers long dead (expired over 10 minutes
--   ago by clock_timestamp(), the exact cleanup_ws_tickets() cutoff) may go; a
--   fast-clock legacy sweep silently deletes nothing valid.
--
-- All three are plain (SECURITY INVOKER) plpgsql with an empty search_path; they
-- reference only NEW/OLD and clock_timestamp() — the WALL clock, never the
-- transaction-start now() — so a lock wait or long transaction cannot skew any
-- decision, and they add no privilege surface.
create or replace function arc_spirits_2d.play_ws_tickets_enforce_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
	-- One wall instant per row: created_at and expires_at must be exactly 30
	-- seconds apart, so the clock is read once.
	wall_now constant timestamptz := clock_timestamp();
begin
	new.created_at := wall_now;
	new.expires_at := wall_now + interval '30 seconds';
	new.consumed_at := null;
	return new;
end
$$;

create or replace function arc_spirits_2d.play_ws_tickets_enforce_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	new.id := old.id;
	new.session_id := old.session_id;
	new.user_id := old.user_id;
	new.member_id := old.member_id;
	new.role := old.role;
	new.digest := old.digest;
	new.created_at := old.created_at;
	new.expires_at := old.expires_at;
	if old.consumed_at is not null then
		-- One-way and immovable: a consumed ticket stays consumed at its original
		-- instant — no reset, no replay window reopened.
		new.consumed_at := old.consumed_at;
	elsif new.consumed_at is not null then
		if old.expires_at <= clock_timestamp() then
			-- WALL-expired: refuse the transition entirely (zero rows updated) so
			-- neither a slow-clock legacy consume nor a consume transaction that
			-- blocked on this row's lock until after expiry (whose now() still
			-- predates the expiry) can resurrect a dead digest.
			return null;
		end if;
		new.consumed_at := clock_timestamp();
	end if;
	return new;
end
$$;

create or replace function arc_spirits_2d.play_ws_tickets_enforce_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	if old.expires_at > clock_timestamp() - interval '10 minutes' then
		return null; -- not long dead by DATABASE WALL time — the row stays
	end if;
	return old;
end
$$;

-- The enforcement is only as strong as the OWNERSHIP of its trigger functions:
-- CREATE OR REPLACE preserves a pre-existing function's owner, so a rogue
-- principal that squatted these names before the migration would remain able to
-- replace the bodies afterwards (silently switching the lifecycle enforcement
-- off for every writer). Converge them to the migration principal — idempotent,
-- and a no-op on a clean install.
alter function arc_spirits_2d.play_ws_tickets_enforce_insert() owner to current_user;
alter function arc_spirits_2d.play_ws_tickets_enforce_update() owner to current_user;
alter function arc_spirits_2d.play_ws_tickets_enforce_delete() owner to current_user;

create trigger play_ws_tickets_lifecycle_insert
	before insert on arc_spirits_2d.play_ws_tickets
	for each row execute function arc_spirits_2d.play_ws_tickets_enforce_insert();
create trigger play_ws_tickets_lifecycle_update
	before update on arc_spirits_2d.play_ws_tickets
	for each row execute function arc_spirits_2d.play_ws_tickets_enforce_update();
create trigger play_ws_tickets_lifecycle_delete
	before delete on arc_spirits_2d.play_ws_tickets
	for each row execute function arc_spirits_2d.play_ws_tickets_enforce_delete();

-- ── 5. central room admission ────────────────────────────────────────────────────

alter table arc_spirits_2d.play_game_sessions
	add column if not exists visibility text not null default 'public';

-- Constrain values without failing on legacy rows (normalize first).
update arc_spirits_2d.play_game_sessions
	set visibility = 'public'
	where visibility is null or visibility not in ('public', 'private');

-- Pre-existing ranked/matchmade rooms were always party-only: mark them private.
update arc_spirits_2d.play_game_sessions
	set visibility = 'private'
	where mode = 'ranked' and visibility <> 'private';

do $$
begin
	if not exists (
		select 1
		from pg_constraint
		where conname = 'play_game_sessions_visibility_check'
			and conrelid = 'arc_spirits_2d.play_game_sessions'::regclass
	) then
		alter table arc_spirits_2d.play_game_sessions
			add constraint play_game_sessions_visibility_check
			check (visibility in ('public', 'private'));
	end if;
end
$$;

-- ROLLING-UPGRADE ENFORCEMENT: the UPDATEs above only fix rows that exist when
-- the migration runs. During a migration-first rolling deployment a LEGACY
-- application instance (which predates the visibility column) keeps INSERTing
-- rows that OMIT it — and a ranked room would land with the column's 'public'
-- default, listed and generically joinable by strangers. The TABLE therefore
-- enforces the invariant for every writer: a ranked row is private on INSERT
-- and can never be flipped public (nor can a public room be re-moded to ranked
-- without going private) — silent coercion, not an error, so the legacy writer
-- keeps working. Casual rooms are untouched: the default stays 'public' and an
-- explicit choice ('private' matchmade-casual rooms, public lobbies) is honored.
create or replace function arc_spirits_2d.play_game_sessions_enforce_visibility()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	if new.mode = 'ranked' then
		new.visibility := 'private';
	end if;
	return new;
end
$$;

-- Same ownership convergence as the ticket lifecycle functions: CREATE OR
-- REPLACE keeps a squatter's ownership, and the owner can rewrite the body.
alter function arc_spirits_2d.play_game_sessions_enforce_visibility() owner to current_user;

drop trigger if exists play_game_sessions_visibility_enforce
	on arc_spirits_2d.play_game_sessions;
create trigger play_game_sessions_visibility_enforce
	before insert or update on arc_spirits_2d.play_game_sessions
	for each row execute function arc_spirits_2d.play_game_sessions_enforce_visibility();

-- ── 6. queue verification flag + search cancel handle ─────────────────────────────
-- match_queue was hand-created in the live project (no repo migration defines it),
-- so guard on its existence — fresh local stacks simply skip this step.
--
-- search_token is the per-search CANCEL HANDLE: an unguessable value the server
-- mints when a search enqueues and returns ONLY to the authenticated owner. It
-- lets the INITIATING principal retire exactly that row (or the membership its
-- match created) even after a durable account transition, when a uid-bound
-- cancel can no longer reach it. Nullable: legacy rows simply have no handle.

do $$
begin
	if exists (
		select 1 from pg_tables
		where schemaname = 'arc_spirits_2d' and tablename = 'match_queue'
	) then
		alter table arc_spirits_2d.match_queue
			add column if not exists is_verified boolean not null default false;
		alter table arc_spirits_2d.match_queue
			add column if not exists search_token text;
		create index if not exists match_queue_search_token_idx
			on arc_spirits_2d.match_queue (search_token)
			where search_token is not null;

		-- ATTEMPT-CANCEL TOMBSTONES: one row per cancelled search token. A Quick
		-- Play cancel can race AHEAD of its own attempt's first enqueue (the queue
		-- row does not exist yet when the leave lands); the tombstone makes the
		-- cancel win regardless of arrival order — the late enqueue re-checks it
		-- after writing its row and self-cancels. Keyed on the unguessable
		-- per-attempt token, so a tombstone can never affect any other attempt
		-- (in particular a NEWER search by the same account). Rows are ephemeral
		-- (reaped after an hour — far beyond any late HTTP request). Service-role
		-- only, same posture rationale as the tables above.
		create table if not exists arc_spirits_2d.match_search_cancellations (
			search_token text primary key,
			cancelled_at timestamptz not null default now()
		);
		create index if not exists match_search_cancellations_age_idx
			on arc_spirits_2d.match_search_cancellations (cancelled_at);
		alter table arc_spirits_2d.match_search_cancellations enable row level security;
		alter table arc_spirits_2d.match_search_cancellations owner to current_user;
		revoke all on table arc_spirits_2d.match_search_cancellations from public;
		drop policy if exists match_search_cancellations_service_role_only
			on arc_spirits_2d.match_search_cancellations;
		if exists (select 1 from pg_roles where rolname = 'service_role') then
			grant select, insert, update, delete
				on table arc_spirits_2d.match_search_cancellations to service_role;
			create policy match_search_cancellations_service_role_only
				on arc_spirits_2d.match_search_cancellations
				for all
				to service_role
				using (true)
				with check (true);
		end if;
		alter table arc_spirits_2d.match_search_cancellations force row level security;
	end if;
end
$$;
