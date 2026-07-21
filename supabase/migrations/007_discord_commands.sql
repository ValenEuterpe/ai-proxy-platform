-- Discord slash command config (singleton settings row).
-- Channel/role IDs are optional gates; empty/null = unrestricted for that dimension.

alter table settings
  add column if not exists discord_commands_enabled boolean not null default false;

alter table settings
  add column if not exists discord_cmd_stats_channel_id text;

alter table settings
  add column if not exists discord_cmd_stats_role_id text;

alter table settings
  add column if not exists discord_cmd_stats_ephemeral boolean not null default true;

alter table settings
  add column if not exists discord_cmd_assignrole_channel_id text;

alter table settings
  add column if not exists discord_cmd_assignrole_role_id text;

-- Website roles.id (UUID), not a Discord role snowflake
alter table settings
  add column if not exists discord_cmd_assignrole_target_role_id text;

alter table settings
  add column if not exists discord_cmd_assignrole_ephemeral boolean not null default true;
