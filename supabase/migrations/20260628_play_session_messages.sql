create table if not exists arc_spirits_2d.play_session_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references arc_spirits_2d.play_game_sessions (id) on delete cascade,
  member_id uuid references arc_spirits_2d.play_session_members (id) on delete set null,
  author_display_name text not null,
  author_role text not null check (author_role in ('host', 'player', 'spectator')),
  seat_color text,
  kind text not null default 'user' check (kind in ('user', 'system')),
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists play_session_messages_session_created_idx
  on arc_spirits_2d.play_session_messages (session_id, created_at desc);

create index if not exists play_session_messages_member_idx
  on arc_spirits_2d.play_session_messages (member_id);

alter table arc_spirits_2d.play_session_messages enable row level security;

revoke all on table arc_spirits_2d.play_session_messages from anon, authenticated;
grant usage on schema arc_spirits_2d to service_role;
grant all on table arc_spirits_2d.play_session_messages to service_role;
grant all on all sequences in schema arc_spirits_2d to service_role;
