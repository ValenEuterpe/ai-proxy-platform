-- Token rate limits on roles + helpers for token usage / user stats.
-- Additive only — existing roles stay unlimited (null) for tokens.

-- ---------------------------------------------------------------------------
-- roles: tokens per day / minute (null = unlimited)
-- ---------------------------------------------------------------------------
alter table roles
  add column if not exists tokens_per_day int;

alter table roles
  add column if not exists tokens_per_minute int;

-- ---------------------------------------------------------------------------
-- Sum successful-request tokens for a user in a time window.
-- total = coalesce(prompt_tokens,0) + coalesce(completion_tokens,0)
-- Only is_error = false rows count (same spirit as RPM/RPD).
-- p_inclusive: true = daily window (gte), false = rolling minute (gt)
-- ---------------------------------------------------------------------------
create or replace function sum_user_tokens(
  p_user_id uuid,
  p_since timestamptz,
  p_inclusive boolean default false
)
returns bigint
language sql
stable
as $$
  select coalesce(sum(
    coalesce(prompt_tokens, 0)::bigint + coalesce(completion_tokens, 0)::bigint
  ), 0)::bigint
  from logs
  where user_id = p_user_id
    and is_error = false
    and (
      (p_inclusive and created_at >= p_since)
      or (not p_inclusive and created_at > p_since)
    );
$$;

-- ---------------------------------------------------------------------------
-- Aggregated stats for admin user detail / dashboard.
-- today window uses Eastern midnight via p_day_since (caller computes ISO).
-- ---------------------------------------------------------------------------
create or replace function user_usage_stats(
  p_user_id uuid,
  p_day_since timestamptz
)
returns jsonb
language sql
stable
as $$
  with base as (
    select
      is_error,
      created_at,
      model_id,
      coalesce(prompt_tokens, 0)::bigint + coalesce(completion_tokens, 0)::bigint as tokens
    from logs
    where user_id = p_user_id
  ),
  all_time as (
    select
      count(*) filter (where not is_error)::bigint as success,
      count(*) filter (where is_error)::bigint as errors,
      coalesce(sum(tokens) filter (where not is_error), 0)::bigint as tokens
    from base
  ),
  today as (
    select
      count(*) filter (where not is_error)::bigint as success,
      count(*) filter (where is_error)::bigint as errors,
      coalesce(sum(tokens) filter (where not is_error), 0)::bigint as tokens
    from base
    where created_at >= p_day_since
  ),
  top_models as (
    select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) as arr
    from (
      select
        model_id,
        count(*)::bigint as requests,
        count(*) filter (where not is_error)::bigint as success,
        count(*) filter (where is_error)::bigint as errors,
        coalesce(sum(tokens) filter (where not is_error), 0)::bigint as tokens
      from base
      where model_id is not null
      group by model_id
      order by count(*) desc
      limit 5
    ) t
  )
  select jsonb_build_object(
    'calls_all_time', jsonb_build_object(
      'success', (select success from all_time),
      'errors', (select errors from all_time)
    ),
    'calls_today', jsonb_build_object(
      'success', (select success from today),
      'errors', (select errors from today)
    ),
    'tokens_all_time', (select tokens from all_time),
    'tokens_today', (select tokens from today),
    'top_models', (select arr from top_models)
  );
$$;
