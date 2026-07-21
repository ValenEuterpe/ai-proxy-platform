-- /rolelist slash command gates + ephemeral flag

alter table settings
  add column if not exists discord_cmd_rolelist_channel_id text;

alter table settings
  add column if not exists discord_cmd_rolelist_role_id text;

alter table settings
  add column if not exists discord_cmd_rolelist_ephemeral boolean not null default true;
