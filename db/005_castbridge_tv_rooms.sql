-- Cast Bridge — TV mode rooms.
--
-- The problem this exists for: AirPlay from an iPhone sends the film FROM the
-- phone, so iOS hands the television to whichever app plays sound last.
-- Instagram with its sound on takes the TV away mid-film, and no web page can
-- hold the route. Google Cast avoids it by having the TV fetch the film
-- itself, but an iPhone browser has no Cast.
--
-- TV mode does what Cast does without Cast: a browser on the television opens
-- /tv, shows a six-digit code, and plays whatever the paired phone sends it.
-- The phone becomes a remote. This table is the mailbox between the two —
-- neither side can reach the other directly, and a serverless function keeps
-- nothing between requests.
--
-- One row per television. The phone writes commands, the TV reads the ones it
-- has not seen and writes back what it is doing. Both keys are stored as
-- SHA-256 hashes, so a leaked row cannot drive anybody's TV.
--
-- Same posture as 001–004: RLS deny-all, service_role only, re-runnable.
create table if not exists castbridge.tv_rooms (
  code          text        primary key check (code ~ '^[0-9]{6}$'),
  tv_hash       text        not null,
  -- Null until a phone pairs. Pairing again replaces it: the newest phone is
  -- the remote, and the old one's commands are refused.
  phone_hash    text,
  user_id       uuid        references castbridge.users(id) on delete set null,
  -- The last few commands, each carrying its own seq. A queue rather than a
  -- single slot, because "seek" then "play" inside one TV poll would
  -- otherwise lose the seek.
  commands      jsonb       not null default '[]'::jsonb,
  seq           integer     not null default 0,
  -- What the TV last reported: state, position, duration, title, error.
  status        jsonb,
  created_at    timestamptz not null default now(),
  tv_seen_at    timestamptz not null default now(),
  phone_seen_at timestamptz
);

create index if not exists tv_rooms_seen on castbridge.tv_rooms (tv_seen_at);

alter table castbridge.tv_rooms enable row level security;
-- No policies, deliberately. Deny-all for every key except service_role.

grant select, insert, update, delete, truncate, references, trigger
  on castbridge.tv_rooms to service_role;
