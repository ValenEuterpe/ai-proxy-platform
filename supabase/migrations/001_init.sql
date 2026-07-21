-- AI Proxy Platform — initial schema + RLS
-- Run manually in the Supabase SQL Editor (no CLI required).

-- Channels: third-party provider connections
create table if not exists channels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  base_url text not null,
  api_key text not null,
  created_at timestamptz default now(),
  is_active boolean default true
);

-- Models: models discovered from a channel, and whether they're exposed
create table if not exists models (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid references channels(id) on delete cascade,
  model_id text not null,
  display_name text,
  is_exposed boolean default false,
  created_at timestamptz default now(),
  unique(channel_id, model_id)
);

-- Model stats: aggregated counters, updated after each request
create table if not exists model_stats (
  model_id uuid primary key references models(id) on delete cascade,
  total_requests bigint default 0,
  total_errors bigint default 0,
  updated_at timestamptz default now()
);

-- Users: mirrors Supabase auth.users, extended with app-specific fields
create table if not exists app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  discord_id text not null,
  discord_username text,
  api_key text not null unique,
  registered_at timestamptz default now(),
  last_ip inet,
  is_active boolean default true
);

-- Logs: individual generation logs
create table if not exists logs (
  id bigserial primary key,
  user_id uuid references app_users(id) on delete set null,
  api_key text,
  model_id text,
  channel_id uuid references channels(id),
  ip_address inet,
  prompt_tokens int,
  completion_tokens int,
  status_code int,
  is_error boolean default false,
  prompt_content jsonb,
  response_content jsonb,
  created_at timestamptz default now()
);

create index if not exists logs_user_id_created_at_idx on logs (user_id, created_at);
create index if not exists logs_created_at_idx on logs (created_at);

-- Global settings: single-row config table
create table if not exists settings (
  id int primary key default 1,
  count_tokens boolean default false,
  log_user_prompt boolean default false,
  requests_per_day int,
  requests_per_minute int,
  updated_at timestamptz default now(),
  constraint singleton check (id = 1)
);

insert into settings (id) values (1)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table channels enable row level security;
alter table models enable row level security;
alter table model_stats enable row level security;
alter table app_users enable row level security;
alter table logs enable row level security;
alter table settings enable row level security;

-- app_users: user can select only their own row
drop policy if exists "app_users_select_own" on app_users;
create policy "app_users_select_own" on app_users
  for select
  using (auth.uid() = id);

-- logs: user can select only their own rows
drop policy if exists "logs_select_own" on logs;
create policy "logs_select_own" on logs
  for select
  using (user_id = auth.uid());

-- models: public read of exposed models only
drop policy if exists "models_select_exposed" on models;
create policy "models_select_exposed" on models
  for select
  using (is_exposed = true);

-- model_stats: public read only for stats of exposed models
drop policy if exists "model_stats_select_exposed" on model_stats;
create policy "model_stats_select_exposed" on model_stats
  for select
  using (
    exists (
      select 1 from models m
      where m.id = model_stats.model_id and m.is_exposed = true
    )
  );

-- channels, settings: no public policies (service role only)
