-- Cast Bridge — real push, and why a table was needed for it.
--
-- Everything the app has ever put on the shade was drawn BY THE PAGE: the
-- page decided, the service worker drew it on request. That works while the
-- app is backgrounded and running, and not at all once the phone freezes the
-- tab or the app is closed — which is most of the time a notification would
-- have been worth anything. Rj's report, twice: "I still can't see background
-- notifications on the cast."
--
-- A real push is sent BY A SERVER to a URL the browser minted, and the
-- browser wakes its worker to draw it whether or not the app exists at that
-- moment. That URL is what this table holds. It is per browser install, not
-- per person: one row for the phone, one for the desktop, one more when the
-- app is reinstalled and the old row is dead on arrival.
--
-- Same posture as 001-003: RLS deny-all, the service-role key is the only
-- way in, and "whose row is this" is decided in the API layer from the
-- signed session -- never from anything the browser sent. Re-runnable.
create table if not exists castbridge.push_subscriptions (
  -- The endpoint IS the identity. Two subscribes from the same install
  -- return the same URL, so this is the primary key rather than a uuid: an
  -- app that re-subscribes on every boot must overwrite its row, not add
  -- one, or a month of opening the app is a month of duplicate buzzes.
  endpoint    text        primary key,
  user_id     uuid        not null references castbridge.users(id) on delete cascade,
  -- RFC 8291 §3.4. The receiver's P-256 public key and the 16-byte auth
  -- secret, both base64url as the browser handed them over. Without the pair
  -- a payload cannot be encrypted, and a push service will not carry an
  -- unencrypted one.
  p256dh      text        not null,
  auth        text        not null,
  -- Which install this is, for the settings panel. "Chrome on Android" is
  -- the difference between "my phone isn't getting these" and "that's the
  -- laptop I signed in on in June", and without it the list is a column of
  -- indistinguishable URLs.
  ua          text,
  created_at  timestamptz not null default now(),
  -- Last time this endpoint accepted a push. NOT last time the app opened:
  -- the question this answers is whether the far end is still alive, and
  -- only a send can answer it.
  last_sent   timestamptz,
  -- Consecutive failures that were NOT a 404/410. A dead subscription is
  -- deleted on the spot; this counts the other kind -- a push service having
  -- a bad afternoon -- so a run of them is visible instead of being either
  -- silently ignored or mistaken for death. Reset by any success.
  failures    integer     not null default 0,
  last_error  text
);

-- The fanout is always "every endpoint belonging to this person", so that is
-- the index. Primary key covers the upsert and the prune.
create index if not exists push_subscriptions_user_idx
  on castbridge.push_subscriptions (user_id);

alter table castbridge.push_subscriptions enable row level security;

-- Deny-all, stated rather than implied. A table with RLS on and no policy
-- already refuses everyone, but a reader of this file should not have to
-- know that to be sure of it.
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'castbridge' and tablename = 'push_subscriptions'
  ) then
    null;
  end if;
end $$;

grant usage on schema castbridge to service_role;
grant select, insert, update, delete on castbridge.push_subscriptions to service_role;
