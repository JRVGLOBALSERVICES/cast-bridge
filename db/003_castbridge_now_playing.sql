-- Cast Bridge — the session that outlives the app.
--
-- The problem this exists for, in Rj's words: "can't really see stream
-- history back even when it's still streaming from the app just because
-- close the app."
--
-- That is exactly what was happening. A cast session lives in the Cast SDK,
-- which lives in the page, and everything the app knew ABOUT that session --
-- what is playing, what it is called, where it had got to -- lived in two
-- page-scoped variables (`current`, `currentTitle`). Closing the app threw
-- those away. The television carried on playing, the SDK even rejoined the
-- session on the next open, and the app had nothing left to label it with,
-- so the on-air panel came back blank and the film looked lost.
--
-- So the identity of what is playing is written here, where closing a tab
-- cannot reach it. One row per person: a second phone picking up the same
-- session is the same person, and last write wins.
--
-- This table is deliberately NOT a second history. `history` is the record of
-- what was watched; this is the single row describing what is happening right
-- now, and it is overwritten rather than appended. When a session ends the
-- row is cleared, and the history row is what remains.
--
-- Same posture as 001 and 002: RLS deny-all, service-role key is the only way
-- in, and "whose row is this" is decided in the API layer from the signed
-- session. Re-runnable.
create table if not exists castbridge.now_playing (
  user_id    uuid        primary key references castbridge.users(id) on delete cascade,
  -- The media address actually handed to the television. Capped in the API,
  -- same as series.url, so a pathological query string cannot bloat the row.
  url        text        not null,
  title      text,
  -- The friendly name of the device, stored rather than re-derived: after a
  -- reopen the SDK can take a second or two to hand back the device, and
  -- "Playing on the TV" while it decides reads as a worse answer than the
  -- name the set actually had a moment ago.
  device     text,
  -- Where the TV had got to, and how long the thing is. Both come from the
  -- receiver, never from the local <video> element -- that one has been
  -- paused at zero the whole time the film has been on the television, and
  -- reading it here is how a resume silently restarts a film.
  position   numeric     not null default 0,
  duration   numeric     not null default 0,
  -- sending | playing | paused | idle. What the RECEIVER last reported, not
  -- what the app hoped for. "sending" is its own state on purpose: a load
  -- that was accepted but never started playing is the single most common
  -- failure this app has, and a resume needs to be able to tell that apart
  -- from a film that genuinely is on screen.
  state      text        not null default 'sending',
  -- The subtitle track that was attached, so resuming re-attaches it. A text
  -- track cannot be bolted on after a load, so losing this on a reopen means
  -- a resumed film comes back with the subtitles silently missing.
  subs_id    uuid,
  subs_name  text,
  started_at timestamptz not null default now(),
  -- Heartbeat. The staleness question -- "is this still on?" -- is answered
  -- from this and nothing else, and it is answered honestly: see the note in
  -- lib/nowplaying.js. A row whose app stopped talking is not proof the
  -- television stopped playing, and the UI must not claim otherwise.
  updated_at timestamptz not null default now()
);

create index if not exists now_playing_updated on castbridge.now_playing (updated_at desc);

alter table castbridge.now_playing enable row level security;
-- No policies, deliberately. Deny-all for every key except service_role.

-- The grant, written at the same time as the table rather than after a 403 in
-- production. Creating a table through the management API runs as `postgres`
-- and leaves service_role with no privilege on it; RLS being deny-all and
-- this GRANT are different mechanisms, and only one of them is implied by
-- anything above.
grant select, insert, update, delete, truncate, references, trigger
  on castbridge.now_playing to service_role;
