-- Roles: custom rate limits + per-channel access control
-- Additive only — does not drop or truncate existing data.
-- Deploy this SQL BEFORE the Worker that depends on roles tables.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  requests_per_day int,
  requests_per_minute int,
  is_default boolean not null default false,
  created_at timestamptz default now(),
  constraint roles_name_unique unique (name)
);

-- At most one default role
create unique index if not exists roles_one_default_idx
  on roles (is_default)
  where is_default = true;

-- ---------------------------------------------------------------------------
-- Channel ↔ role allowlist (empty = open to all roles)
-- ---------------------------------------------------------------------------
create table if not exists channel_roles (
  channel_id uuid not null references channels(id) on delete cascade,
  role_id uuid not null references roles(id) on delete cascade,
  primary key (channel_id, role_id)
);

create index if not exists channel_roles_role_id_idx on channel_roles (role_id);

-- ---------------------------------------------------------------------------
-- app_users.role_id (nullable first so existing rows are not blocked)
-- ---------------------------------------------------------------------------
alter table app_users
  add column if not exists role_id uuid references roles(id);

create index if not exists app_users_role_id_idx on app_users (role_id);

-- ---------------------------------------------------------------------------
-- Seed Default role from current global settings (preserves existing limits)
-- ---------------------------------------------------------------------------
insert into roles (name, requests_per_day, requests_per_minute, is_default)
select
  'Default',
  s.requests_per_day,
  s.requests_per_minute,
  true
from settings s
where s.id = 1
  and not exists (select 1 from roles r where r.is_default = true);

-- If settings row is missing, still ensure a Default role exists
insert into roles (name, requests_per_day, requests_per_minute, is_default)
select 'Default', null, null, true
where not exists (select 1 from roles r where r.is_default = true);

-- Backfill all users without a role → Default (safe for 100+ existing users)
update app_users u
set role_id = r.id
from roles r
where r.is_default = true
  and u.role_id is null;

-- ---------------------------------------------------------------------------
-- RLS: service role only (Worker). No public policies.
-- ---------------------------------------------------------------------------
alter table roles enable row level security;
alter table channel_roles enable row level security;
