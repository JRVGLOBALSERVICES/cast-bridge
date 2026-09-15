-- Cast Bridge — one log per cast, per person.
--
-- The phone has always kept a cast log, but only in memory: 120 lines, gone
-- the moment the app reloads, and never seen by anyone but the person holding
-- the phone. "Played 10 minutes, disconnected, then wouldn't load" could not be
-- answered from the server because the only record of what the TV said was on
-- a phone in someone's hand. Rj: "Each user, each log, each cast, each log,
-- each movie played a log."
--
-- One row per film played (a cast, an AirPlay, or playback on the phone). The
-- phone appends lines as they happen; `lines` is the whole sequence in order.
-- `session` is minted by the phone so appends from a reloaded page, a beacon on
-- pagehide, or a retry all land on the same row.
--
-- Same posture as 001–006: RLS deny-all, service_role only, re-runnable.
create table if not exists castbridge.cast_logs (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references castbridge.users(id) on delete cascade,
  session     text        not null check (session ~ '^[A-Za-z0-9_-]{8,64}$'),
  title       text,
  url         text,
  page        text,
  device      text,
  agent       text,
  build       text,
  lines       jsonb       not null default '[]'::jsonb,
  line_count  integer     not null default 0,
  -- Any line that reads as a failure (refused, error, not playing, expired).
  problems    integer     not null default 0,
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, session)
);

create index if not exists cast_logs_user_updated on castbridge.cast_logs (user_id, updated_at desc);
create index if not exists cast_logs_updated on castbridge.cast_logs (updated_at desc);

alter table castbridge.cast_logs enable row level security;
grant select, insert, update, delete on castbridge.cast_logs to service_role;

-- Append in one statement. A read-then-write from the API would lose lines
-- whenever two flushes from the same phone overlap (a timer and a pagehide
-- beacon do, routinely). Capped at 3000 lines per film: a heartbeat a minute
-- for a three-hour film is 180, so the cap only bites on a runaway loop, and
-- it keeps the newest lines — the end is where a film fails.
create or replace function castbridge.cast_log_append(
  p_user uuid, p_session text, p_title text, p_url text, p_page text,
  p_device text, p_agent text, p_build text, p_lines jsonb, p_problems integer
) returns uuid
language plpgsql
security invoker
set search_path = castbridge, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into castbridge.cast_logs as c
    (user_id, session, title, url, page, device, agent, build, lines, line_count, problems)
  values
    (p_user, p_session, p_title, p_url, p_page, p_device, p_agent, p_build,
     coalesce(p_lines, '[]'::jsonb), jsonb_array_length(coalesce(p_lines, '[]'::jsonb)),
     coalesce(p_problems, 0))
  on conflict (user_id, session) do update set
    title      = coalesce(excluded.title, c.title),
    url        = coalesce(excluded.url, c.url),
    page       = coalesce(excluded.page, c.page),
    device     = coalesce(excluded.device, c.device),
    agent      = coalesce(excluded.agent, c.agent),
    build      = coalesce(excluded.build, c.build),
    lines      = case
                   when jsonb_array_length(c.lines || excluded.lines) > 3000
                   then (select coalesce(jsonb_agg(e order by n), '[]'::jsonb)
                           from jsonb_array_elements(c.lines || excluded.lines) with ordinality as t(e, n)
                          where n > jsonb_array_length(c.lines || excluded.lines) - 3000)
                   else c.lines || excluded.lines
                 end,
    line_count = least(3000, c.line_count + excluded.line_count),
    problems   = c.problems + excluded.problems,
    updated_at = now()
  returning c.id into v_id;
  return v_id;
end;
$$;

revoke all on function castbridge.cast_log_append(uuid, text, text, text, text, text, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function castbridge.cast_log_append(uuid, text, text, text, text, text, text, text, jsonb, integer) to service_role;

notify pgrst, 'reload schema';
