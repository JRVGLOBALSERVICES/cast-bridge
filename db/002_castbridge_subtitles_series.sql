-- Cast Bridge — subtitle files and remembered series pages.
--
-- Two tables, added together because both exist for the same reason: a
-- television has no memory and no session, so anything it needs must live at
-- an address of its own, and anything a person wants back tomorrow must live
-- somewhere other than the phone that found it.
--
-- Same posture as 001: RLS is deny-all, the service-role key is the only way
-- in, and "which rows may this person see" is decided in the API layer from
-- the signed session. Re-runnable.

-- ---------------------------------------------------------------------------
-- subtitles
--
-- An SRT picked off the phone has no address. The Cast receiver fetches its
-- text track itself, over https, cross-origin-open, and will take only WebVTT
-- — so a file on the phone cannot reach the television at all until something
-- gives it a URL. That is this table: the converted VTT is stored once and
-- served back by /api/subs?id=<uuid>.
--
-- The id IS the credential, exactly like a Library share link, because the
-- thing doing the fetching is a Chromecast and it carries no session. So the
-- id is a random uuid and nothing else about the row is guessable. The screen
-- says this in those words rather than assuming it is understood.
-- ---------------------------------------------------------------------------
create table if not exists castbridge.subtitles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null references castbridge.users(id) on delete cascade,
  name       text        not null,
  vtt        text        not null,
  cues       integer     not null default 0,
  created_at timestamptz not null default now(),
  -- A subtitle file outlives the sitting it was uploaded for and nothing ever
  -- goes back to delete it. Thirty days is long enough to finish a series and
  -- short enough that the table does not become a permanent archive of other
  -- people's dialogue.
  expires_at timestamptz not null default (now() + interval '30 days')
);

create index if not exists subtitles_user_recent on castbridge.subtitles (user_id, created_at desc);
create index if not exists subtitles_expiry      on castbridge.subtitles (expires_at);

-- ---------------------------------------------------------------------------
-- series
--
-- A remembered parent page: the season index a crawl was run against, plus
-- the episode list it found. The list is stored so opening it tomorrow paints
-- instantly instead of spending fifteen seconds re-reading a page that has
-- not changed — the re-crawl still happens, behind the list that is already
-- on screen.
--
-- One row per person per address: watching the same season twice updates the
-- row rather than adding a second one, which is what the unique index below
-- is for (PostgREST upserts against it with on_conflict=user_id,url).
-- ---------------------------------------------------------------------------
create table if not exists castbridge.series (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references castbridge.users(id) on delete cascade,
  -- Capped in the API at 1000 characters, well under the btree index limit,
  -- so a pathological query string cannot make the unique index below throw.
  url          text        not null,
  title        text,
  host         text,
  episodes     jsonb       not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create unique index if not exists series_user_url    on castbridge.series (user_id, url);
create index        if not exists series_user_recent on castbridge.series (user_id, last_seen_at desc);

alter table castbridge.subtitles enable row level security;
alter table castbridge.series    enable row level security;
-- No policies, deliberately. Deny-all for every key except service_role.
