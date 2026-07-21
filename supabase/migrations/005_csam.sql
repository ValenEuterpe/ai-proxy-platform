-- CSAM flag + per-user prompt logging (flag-only by default; optional block mode)

-- Per-user sticky prompt logging (admin toggle; auto-on after CSAM flag)
alter table app_users
  add column if not exists log_user_prompt boolean not null default false;

-- Global CSAM shield controls
alter table settings
  add column if not exists csam_scan_enabled boolean not null default true;

-- 'log' = flag + force log, continue; 'log_and_block' = same + HTTP 400 before upstream
alter table settings
  add column if not exists csam_action text not null default 'log';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'settings_csam_action_check'
  ) then
    alter table settings
      add constraint settings_csam_action_check
      check (csam_action in ('log', 'log_and_block'));
  end if;
end $$;

-- CSAM fields on request logs
alter table logs
  add column if not exists csam_flagged boolean not null default false;

alter table logs
  add column if not exists csam_reason text;

alter table logs
  add column if not exists csam_snippet text;

alter table logs
  add column if not exists csam_source text;

alter table logs
  add column if not exists csam_reviewed boolean not null default false;

alter table logs
  add column if not exists csam_reviewed_at timestamptz;

alter table logs
  add column if not exists csam_review_note text;

-- Queue index: flagged rows ordered by time
create index if not exists logs_csam_flagged_created_at_idx
  on logs (csam_flagged, created_at desc)
  where csam_flagged = true;
