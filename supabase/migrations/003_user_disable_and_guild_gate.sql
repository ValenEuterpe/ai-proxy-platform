-- User admin-disable tracking + optional Discord server membership gate
-- Additive only — does not wipe users or flip active users to disabled on deploy.

-- ---------------------------------------------------------------------------
-- app_users: remember owner-initiated disable (vs guild auto-disable)
-- ---------------------------------------------------------------------------
alter table app_users
  add column if not exists admin_disabled boolean not null default false;

-- Users already inactive were disabled by admin (or equivalent); preserve that intent
update app_users
set admin_disabled = true
where is_active = false
  and admin_disabled = false;

-- ---------------------------------------------------------------------------
-- settings: optional Discord guild gate + invite link for disabled UI
-- null / empty guild id = gate off (anyone with Discord OAuth can be active)
-- ---------------------------------------------------------------------------
alter table settings
  add column if not exists required_discord_guild_id text,
  add column if not exists discord_invite_url text;
