begin;

-- Enforce the cutoff for all callers without changing existing approvals.
create or replace function public.approve_match(p_match text, p_version int default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v real_matches%rowtype;
  v_result jsonb;
  v_decided_at timestamptz;
begin
  select * into v from real_matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if auth.uid() is null or not (public.is_leader(v.league_id) or public.is_match_organizer(p_match)) then
    raise insufficient_privilege;
  end if;
  if v.status='approved' and p_version in (v.version,v.version-1) and exists (
    select 1 from match_approvals where match_id=p_match and action='approved' and version=v.version
  ) then
    select result into v_result from match_scoring_receipts where match_id=p_match and match_version=v.version;
    if found then return v_result; end if;
  end if;
  if v.status <> 'pending' then
    raise exception 'Match is not pending approval';
  end if;
  if p_version is not null and p_version <> v.version then
    raise exception 'Match changed since you reviewed it';
  end if;
  if v.home_score is null then raise exception 'Send this match back and record both scores before approving'; end if;
  -- Check after locking and reading the current match. Transaction start time
  -- can be stale when a reviewer waits for a concurrent edit.
  v_decided_at := clock_timestamp();
  if v.kick_off > v_decided_at then
    raise exception 'This match cannot be approved before its scheduled kickoff';
  end if;
  -- Product rule: the League Leader may approve even when they submitted
  -- the result, and the Match Organizer may approve results for matches
  -- they organize. Neither role is blocked by self-approval.

  update real_matches
     set status = 'approved', decided_by = auth.uid()::text, decided_at = v_decided_at,
         rejection_reason = null, version = version + 1, updated_at = v_decided_at
   where id = p_match;

  insert into match_approvals (id, match_id, action, actor_id, version, snapshot, created_at)
  values (gen_random_uuid()::text, p_match, 'approved', auth.uid()::text, v.version + 1,
    jsonb_build_object('homeScore',v.home_score,'awayScore',v.away_score), v_decided_at);

  v_result := public.ff_score_match(p_match,true);
  return v_result;
end;
$$;

commit;
