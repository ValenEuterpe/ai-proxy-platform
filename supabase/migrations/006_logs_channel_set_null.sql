-- Allow deleting channels that still have log references.
-- Logs are kept for statistics; channel_id is cleared (SET NULL).
-- model_id text on logs is unchanged and remains the primary stats key.

alter table logs
  drop constraint if exists logs_channel_id_fkey;

alter table logs
  add constraint logs_channel_id_fkey
  foreign key (channel_id) references channels(id)
  on delete set null;
