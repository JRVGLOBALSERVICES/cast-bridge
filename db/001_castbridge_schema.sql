-- Cast Bridge — accounts and per-user history.
--
-- This file exists because the schema previously lived ONLY in the database:
-- it had been applied by hand and nothing in the repo recorded it, so a fresh
-- environment had no way to reach a working state and no way to review what
-- the app actually depends on. It is written to be re-runnable.
--
-- The app reaches these tables through PostgREST with the service-role key, so
-- RLS is deny-all on purpose: the anon key can read nothing, and "which rows
-- may this person see" is decided in the API layer from the signed session
-- (api/history.js), never by a query the browser gets to write.

create schema if not exists castbridge;

create table if not exists castbridge.users (
  id            uuid primary key default gen_random_uuid(),
  username      text        not null,
  password_hash text        not null,
  role          text        not null default 'user',
  active        boolean     not null default true,
  created_at    timestamptz not null default now(),
  created_by    uuid        references castbridge.users(id) on delete set null,
  last_seen_at  timestamptz
);

-- Usernames are matched exactly and case-insensitively by lib/users.js
-- normalize(). Before this, the lookup used PostgREST `ilike`, where `%` and
-- `_` are wildcards — and the username pattern is only enforced on CREATE, not
-- on sign-in. `rjnfli%` plus the owner's password signed the caller in AS the
-- owner. The app now queries with `eq.` on a lowercased value; these two
-- constraints stop any other write path reintroducing a second spelling.
create unique index if not exists users_username_key_ci on castbridge.users (lower(username));

alter table castbridge.users drop constraint if exists users_username_lowercase;
alter table castbridge.users add constraint users_username_lowercase
  check (username = lower(username) and username ~ '^[a-z0-9._-]{3,32}$');

alter table castbridge.users drop constraint if exists users_role_allowed;
alter table castbridge.users add constraint users_role_allowed
  check (role in ('admin','user'));

create table if not exists castbridge.history (
  id         uuid primary key default gen_random_uuid(),
  -- ON DELETE CASCADE is load-bearing: api/users.js DELETE relies on it to
  -- take the account's history with it rather than orphaning rows.
  user_id    uuid        not null references castbridge.users(id) on delete cascade,
  url        text        not null,
  title      text,
  kind       text,
  created_at timestamptz not null default now()
);

create index if not exists history_user_recent on castbridge.history (user_id, created_at desc);

alter table castbridge.users   enable row level security;
alter table castbridge.history enable row level security;
-- No policies, deliberately. Deny-all for every key except service_role.
