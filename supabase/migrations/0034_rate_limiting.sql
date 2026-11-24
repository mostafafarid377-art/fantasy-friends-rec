-- 0034_rate_limiting.sql
--
-- Shared, database-backed rate limiting for sensitive endpoints.
--
-- Why the database: the app runs on serverless instances, so an in-memory
-- limiter would reset per instance and let a caller multiply their budget by
-- the instance count. One row per (scope, identity, window) in PostgreSQL is
-- shared by every instance, and the increment is a single atomic upsert.
--
-- The table is internal-only: RLS enabled, no policies, no grants. Callers
-- reach it exclusively through ff_rate_limit_hit, which owns the limit
-- policy. Callers choose a scope and an identity — never the limit — so no
-- client can mint itself a bigger budget.

create table if not exists public.ff_rate_limit_windows (
  bucket text primary key,             -- scope : identity-hash : window index
  hits integer not null default 0,
  window_start timestamptz not null
);

alter table public.ff_rate_limit_windows enable row level security;
-- No policies and no table grants: default deny for anon/authenticated.

-- The one-entry-point limiter. SECURITY DEFINER so it can maintain the
-- internal table; the search_path is pinned like every other definer.
create or replace function public.ff_rate_limit_hit(p_scope text, p_identity text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_limit int;
  v_window int;
  v_now timestamptz := clock_timestamp();
  v_index bigint;
  v_bucket text;
  v_hits int;
  v_reset timestamptz;
begin
  -- Server-side policy table. Scopes not listed here are rejected outright.
  select l.max_hits, l.window_seconds into v_limit, v_window
  from (values
    -- Credential attempts: tight per email, wider per source IP (shared NATs).
    ('auth.login',          10,  300),
    ('auth.login.ip',       30,  300),
    ('auth.signup',          5, 3600),
    ('auth.signup.ip',      10, 3600),
    ('auth.forgot',          5, 3600),
    ('auth.forgot.ip',      15, 3600),
    ('auth.reset',          10, 3600),
    ('auth.resend',          5, 3600),
    -- Authenticated product writes, scoped per verified user.
    ('league.create',       10, 3600),
    ('league.join',         20, 3600),
    ('match.create',        30, 3600),
    -- Live match recording is bursty by nature: a wide 5-minute budget.
    ('match.manage',       120,  300),
    ('profile.update',      30, 3600),
    ('notifications.write', 60, 3600)
  ) as l(scope, max_hits, window_seconds)
  where l.scope = p_scope;

  if not found then
    raise exception 'unknown rate limit scope' using errcode = 'invalid_parameter_value';
  end if;
  if p_identity is null or length(p_identity) < 8 or length(p_identity) > 200 then
    raise exception 'invalid rate limit identity' using errcode = 'invalid_parameter_value';
  end if;

  -- Fixed window keyed by epoch bucket. The upsert takes a row lock on
  -- conflict, so concurrent callers serialize on the bucket and every hit is
  -- counted exactly once.
  v_index := floor(extract(epoch from v_now) / v_window);
  v_bucket := p_scope || ':' || p_identity || ':' || v_index;

  insert into public.ff_rate_limit_windows (bucket, hits, window_start)
  values (v_bucket, 1, v_now)
  on conflict (bucket) do update set hits = public.ff_rate_limit_windows.hits + 1
  returning hits into v_hits;

  v_reset := to_timestamp((v_index + 1) * v_window);

  -- Probabilistic cleanup: no scheduled job to keep the table small.
  if random() < 0.02 then
    delete from public.ff_rate_limit_windows
    where window_start < v_now - interval '7 days';
  end if;

  return jsonb_build_object(
    'allowed', v_hits <= v_limit,
    'remaining', greatest(0, v_limit - v_hits),
    'retryAfterSeconds', greatest(1, floor(extract(epoch from (v_reset - v_now)))::int)
  );
end $$;

revoke all on function public.ff_rate_limit_hit(text, text) from public;
grant execute on function public.ff_rate_limit_hit(text, text) to anon, authenticated;
