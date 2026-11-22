begin;

-- The automatic lineup deadline.
--
-- Migration 0028 locks the lineup of a fixture in at its deadline, but
-- something has to call that lock. Without a runner the official lineup of a
-- fixture only appears when the result is scored, which is too late: the
-- interface, the live projection and the next fixture all read the official
-- lineup.
--
-- This migration makes the deadline automatic without assuming anything
-- about the database or about the app:
--
--   1. `ff_promote_due_match_lineups(source)` is the single entry point. It
--      locks in every fixture whose deadline has passed and that has no
--      result yet, and it records what it did.
--   2. It is safe to call at any time, from anywhere, as often as you like.
--      It is idempotent, it takes the same league lock as a squad save, and
--      it never overwrites a lineup that was already locked in.
--   3. One fixture never stops the others: a fixture that cannot be locked
--      in is counted, recorded with its error, and the sweep carries on.
--   4. It is granted to `service_role`, which only the server-side scheduler
--      route holds. The browser never sees that key.
--   5. If pg_cron is installed, the same function is scheduled inside the
--      database as well. This migration never installs the extension itself:
--      installing it is an explicit operational step.
--
-- Everything that matters is still decided in the database. A scheduler that
-- misses a run loses nothing: the next run locks in everything that is
-- overdue, and a fixture that is scored always has its official lineup
-- before its points are written.

-- ------------------------------------------------------------------
-- What the runner did
-- ------------------------------------------------------------------

-- The runs of the deadline runner. This is the evidence that the deadline is
-- being enforced: if the newest row is older than the scheduler interval,
-- the deadline is not running.
create table public.lineup_deadline_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default clock_timestamp(),
  source text not null default 'sweep',
  matches_scanned int not null,
  promoted int not null,
  failed int not null default 0
);
create index lineup_deadline_runs_ran_at_idx on public.lineup_deadline_runs(ran_at desc);
alter table public.lineup_deadline_runs enable row level security;
revoke all on public.lineup_deadline_runs from public,anon,authenticated;

-- The fixtures the runner could not lock in, and why. A fixture that fails
-- here is a fixture whose lineup does not fit the league or whose captaincy
-- cannot be used: it needs a person, not another run.
create table public.lineup_deadline_failures (
  match_id text primary key references public.real_matches(id) on delete cascade,
  attempts int not null default 1,
  last_error text not null,
  first_failed_at timestamptz not null default clock_timestamp(),
  last_failed_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz
);
create index lineup_deadline_failures_open_idx on public.lineup_deadline_failures(last_failed_at desc)
  where resolved_at is null;
alter table public.lineup_deadline_failures enable row level security;
revoke all on public.lineup_deadline_failures from public,anon,authenticated;

-- The last run of the deadline runner, for the operator and for the
-- scheduler route that reports it.
create function public.ff_last_lineup_deadline_run()
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('ranAt',r.ran_at,'source',r.source,'scanned',r.matches_scanned,
    'promoted',r.promoted,'failed',r.failed)
  from public.lineup_deadline_runs r order by r.ran_at desc,id desc limit 1
$$;
revoke all on function public.ff_last_lineup_deadline_run() from public,anon,authenticated;

-- ------------------------------------------------------------------
-- The runner
-- ------------------------------------------------------------------

-- The 0028 runner takes no argument. It is replaced by one that records what
-- it did and where the run came from.
drop function public.ff_promote_due_match_lineups();

create function public.ff_promote_due_match_lineups(p_source text default 'sweep')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  r record;
  promoted int := 0;
  scanned int := 0;
  failed int := 0;
  source text := coalesce(nullif(btrim(p_source),''),'sweep');
begin
  -- The fixtures are promoted in kickoff order, so a fixture that inherits
  -- the lineup of the one before it always finds that lineup already locked
  -- in, even when the runner was down for both deadlines.
  for r in select id from public.real_matches where status <> 'approved' and kick_off <= clock_timestamp()
    and kick_off > clock_timestamp() - interval '14 days'
    and kick_off >= (select enabled_at from public.fantasy_lineup_rollout)
    order by kick_off,id loop
    scanned := scanned + 1;
    -- One fixture never stops the others. A fixture that cannot be locked in
    -- is counted, recorded with its error, and the sweep carries on.
    begin
      promoted := promoted + public.ff_promote_match_lineup(r.id);
      -- A fixture that is due but has no official lineup is a fixture whose
      -- lineup does not fit the league, or whose captaincy cannot be used.
      -- It needs a person, not another run, so it is recorded.
      if not exists (select 1 from public.fantasy_match_lineup_history h where h.match_id=r.id) then
        failed := failed + 1;
        insert into public.lineup_deadline_failures(match_id,attempts,last_error,last_failed_at)
          values (r.id,1,'no lineup could be locked in for this fixture',clock_timestamp())
          on conflict(match_id) do update set attempts=public.lineup_deadline_failures.attempts+1,
            last_error=excluded.last_error,last_failed_at=excluded.last_failed_at;
      else
        update public.lineup_deadline_failures set resolved_at=clock_timestamp() where match_id=r.id;
      end if;
    exception when others then
      failed := failed + 1;
      insert into public.lineup_deadline_failures(match_id,attempts,last_error,last_failed_at)
        values (r.id,1,sqlerrm,clock_timestamp())
        on conflict(match_id) do update set attempts=public.lineup_deadline_failures.attempts+1,
          last_error=excluded.last_error,last_failed_at=excluded.last_failed_at;
    end;
  end loop;
  insert into public.lineup_deadline_runs(source,matches_scanned,promoted,failed)
    values (source,scanned,promoted,failed);
  -- The trail only has to prove that the runner is alive.
  delete from public.lineup_deadline_runs where ran_at < clock_timestamp() - interval '30 days';
  delete from public.lineup_deadline_failures
    where resolved_at is not null and resolved_at < clock_timestamp() - interval '30 days';
  return jsonb_build_object('matches',scanned,'promoted',promoted,'failed',failed,
    'source',source,'at',clock_timestamp());
end $$;
revoke all on function public.ff_promote_due_match_lineups(text) from public,anon,authenticated;

-- ------------------------------------------------------------------
-- Is the deadline running?
-- ------------------------------------------------------------------

-- The health of the deadline: when it last ran, how long ago that was, how
-- many fixtures it could not lock in, and whether the database itself runs
-- the job. It is the one thing an operator has to look at.
create function public.ff_lineup_deadline_status()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare
  last jsonb; age_seconds int; open_failures int; scheduled boolean; job text;
begin
  select jsonb_build_object('ranAt',r.ran_at,'source',r.source,'scanned',r.matches_scanned,
      'promoted',r.promoted,'failed',r.failed),
    extract(epoch from statement_timestamp()-r.ran_at)::int
    into last,age_seconds
    from public.lineup_deadline_runs r order by r.ran_at desc,id desc limit 1;
  select count(*) into open_failures from public.lineup_deadline_failures where resolved_at is null;
  -- The job table only exists where pg_cron is installed. The question is
  -- asked with dynamic SQL so the function exists either way.
  scheduled := null; job := null;
  if to_regclass('cron.job') is not null then
    execute 'select count(*)>0, min(jobname) from cron.job where jobname=$1'
      into scheduled,job using 'ff-lineup-deadlines';
  end if;
  return jsonb_build_object('lastRun',last,'ageSeconds',age_seconds,'openFailures',open_failures,
    'scheduledInDatabase',scheduled,'job',job,'now',statement_timestamp());
end $$;
revoke all on function public.ff_lineup_deadline_status() from public,anon,authenticated;

-- ------------------------------------------------------------------
-- Who may run it
-- ------------------------------------------------------------------

-- The scheduler route holds the service key, which maps to this role. The
-- grant is three functions: the route can lock lineups in and ask how the
-- deadline is doing, and nothing else.
do $$
begin
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute 'grant execute on function public.ff_promote_due_match_lineups(text) to service_role';
    execute 'grant execute on function public.ff_last_lineup_deadline_run() to service_role';
    execute 'grant execute on function public.ff_lineup_deadline_status() to service_role';
  end if;
end $$;

-- ------------------------------------------------------------------
-- The in-database runner
-- ------------------------------------------------------------------

-- pg_cron runs the same function inside the database. The extension is not
-- installed here: installing it is an explicit operational step, and the
-- deadline works without it.
--
--   create extension pg_cron;
--
-- Apply this migration after that statement, or run the schedule by hand:
--
--   select cron.schedule('ff-lineup-deadlines','* * * * *',
--     'select public.ff_promote_due_match_lineups(''pg_cron'')');
do $$
begin
  if not exists (select 1 from pg_extension where extname='pg_cron') then
    raise notice 'pg_cron is not installed: the lineup deadline runs from the scheduler outside the database.';
    return;
  end if;
  begin
    perform cron.unschedule('ff-lineup-deadlines');
  exception when others then
    null; -- the job does not exist yet
  end;
  perform cron.schedule('ff-lineup-deadlines','* * * * *',
    'select public.ff_promote_due_match_lineups(''pg_cron'')');
exception when others then
  raise notice 'The lineup deadline promotion could not be scheduled: %', sqlerrm;
end $$;

-- PostgREST caches the database schema. Reload it so the new functions are
-- visible to the API.
notify pgrst, 'reload schema';

commit;
