begin;

-- The deadline sweep must never pass a due match by in silence.
--
-- Migration 0029 bounded the sweep to the last 14 days. A match whose result
-- was still not approved after that fell out of the sweep: it was never
-- locked in, and — because the failure check only ran on scanned matches —
-- it was never recorded as a failure either. The runner report stayed green
-- (promoted: 0, failed: 0) while a match was abandoned. The rollout cutoff
-- already bounds the past; the extra window only hid work.
--
-- This migration removes the window: every match that is due (kickoff has
-- passed), has no result yet and is inside the lineup rollout is locked in,
-- however long it has waited.
--
-- It also names the matches. Until now the run row only counted them, so an
-- operator could not tell which match the sweep was working on. Every run
-- now records the ids it scanned, and the status call lists the due matches
-- with the flag that says whether each one is already locked in.

-- The run row remembers which matches it scanned.
alter table public.lineup_deadline_runs add column match_ids text[];

create or replace function public.ff_promote_due_match_lineups(p_source text default 'sweep')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  r record;
  promoted int := 0;
  scanned int := 0;
  failed int := 0;
  source text := coalesce(nullif(btrim(p_source),''),'sweep');
  match_ids text[] := '{}';
begin
  -- The fixtures are promoted in kickoff order, so a fixture that inherits
  -- the lineup of the one before it always finds that lineup already locked
  -- in, even when the runner was down for both deadlines. Every due fixture
  -- is taken, however long it has been waiting: the rollout cutoff is the
  -- only bound on the past.
  for r in select id from public.real_matches where status <> 'approved' and kick_off <= clock_timestamp()
    and kick_off >= (select enabled_at from public.fantasy_lineup_rollout)
    order by kick_off,id loop
    scanned := scanned + 1;
    match_ids := match_ids || r.id;
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
  insert into public.lineup_deadline_runs(source,matches_scanned,promoted,failed,match_ids)
    values (source,scanned,promoted,failed,match_ids);
  -- The trail only has to prove that the runner is alive.
  delete from public.lineup_deadline_runs where ran_at < clock_timestamp() - interval '30 days';
  delete from public.lineup_deadline_failures
    where resolved_at is not null and resolved_at < clock_timestamp() - interval '30 days';
  return jsonb_build_object('matches',scanned,'promoted',promoted,'failed',failed,
    'source',source,'matchIds',match_ids,'at',clock_timestamp());
end $$;
revoke all on function public.ff_promote_due_match_lineups(text) from public,anon,authenticated;

-- The last run says which matches it scanned.
create or replace function public.ff_last_lineup_deadline_run()
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('ranAt',r.ran_at,'source',r.source,'scanned',r.matches_scanned,
    'promoted',r.promoted,'failed',r.failed,'matchIds',r.match_ids)
  from public.lineup_deadline_runs r order by r.ran_at desc,id desc limit 1
$$;
revoke all on function public.ff_last_lineup_deadline_run() from public,anon,authenticated;

-- The health of the deadline, and the names of the matches it is working on.
-- `dueMatches` is the exact set the next sweep will scan; `promoted` on each
-- row says whether its official lineup is already locked in, so a match that
-- keeps appearing with promoted=false is a match that needs a person.
create or replace function public.ff_lineup_deadline_status()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare
  last jsonb; age_seconds int; open_failures int; scheduled boolean; job text; due jsonb;
begin
  select jsonb_build_object('ranAt',r.ran_at,'source',r.source,'scanned',r.matches_scanned,
      'promoted',r.promoted,'failed',r.failed,'matchIds',r.match_ids),
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
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'title',m.title,'kickOff',m.kick_off,
      'leagueId',m.league_id,'promoted',exists(
        select 1 from public.fantasy_match_lineup_history h where h.match_id=m.id))
      order by m.kick_off,m.id),'[]'::jsonb)
    into due
    from public.real_matches m
    where m.status <> 'approved' and m.kick_off <= statement_timestamp()
      and m.kick_off >= (select enabled_at from public.fantasy_lineup_rollout);
  return jsonb_build_object('lastRun',last,'ageSeconds',age_seconds,'openFailures',open_failures,
    'scheduledInDatabase',scheduled,'job',job,'dueMatches',due,'now',statement_timestamp());
end $$;
revoke all on function public.ff_lineup_deadline_status() from public,anon,authenticated;

-- The grants are exactly what 0029 set: the scheduler route holds the
-- service key, and nobody else can run or read the deadline.
do $$
begin
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute 'grant execute on function public.ff_promote_due_match_lineups(text) to service_role';
    execute 'grant execute on function public.ff_last_lineup_deadline_run() to service_role';
    execute 'grant execute on function public.ff_lineup_deadline_status() to service_role';
  end if;
end $$;

-- PostgREST caches the database schema. Reload it so the changed functions
-- and the new column are visible to the API.
notify pgrst, 'reload schema';

commit;
