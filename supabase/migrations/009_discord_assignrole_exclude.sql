-- Website roles that cannot be assigned via /assignrole (roles.id UUIDs)

alter table settings
  add column if not exists discord_cmd_assignrole_excluded_role_ids text[] not null default '{}';
