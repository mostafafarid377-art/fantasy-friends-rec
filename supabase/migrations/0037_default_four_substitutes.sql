-- 0037: new leagues default to four substitutes, not five.
--
-- The bench size of a league has always been the substitutes count chosen at
-- creation; only the fallback for a caller that omits it changes here, from 5
-- to 4 — in step with the creation form and the API schema, which now default
-- to 4 as well. The app always sends an explicit count, so this only affects
-- direct callers that rely on the function default.
--
-- The body is the 0009 definition verbatim except for the one default value;
-- CREATE OR REPLACE keeps the existing grants. Existing leagues, squads and
-- lineups are untouched — their subs_count is already stored. Rollback:
-- recreate the function with p_subs_count integer default 5 (see
-- 0009_bench_lineups_scoring.sql).

create or replace function public.create_league(
  p_name text,
  p_description text default null,
  p_format text default '5v5',
  p_starters integer default 5,
  p_subs_count integer default 4,
  p_team_name text default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_league_id text;
  v_invite_code text;
  v_profile text := auth.uid()::text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Generate a unique invite code
  select gen_random_uuid()::text into v_invite_code;
  -- Use first 8 alphanumeric chars (Crockford-ish, no ambiguous chars)
  select upper(regexp_replace(v_invite_code, '[^A-Z0-9]', '', 'g')) into v_invite_code;
  v_invite_code := left(v_invite_code, 8);

  -- Insert the league
  insert into public.leagues (
    id, name, description, format, starters, subs_count, invite_code,
    vice_policy, created_by, created_at, updated_at
  )
  values (
    gen_random_uuid()::text, p_name, p_description, p_format,
    p_starters, p_subs_count, v_invite_code,
    'auto_captain', v_profile, now(), now()
  )
  returning id into v_league_id;

  -- Insert leader membership
  insert into public.league_members (
    id, league_id, profile_id, role, team_name, created_at
  )
  values (
    gen_random_uuid()::text, v_league_id, v_profile, 'leader',
    coalesce(p_team_name, 'Leader XI'), now()
  );

  -- Insert standings entry
  insert into public.league_standings (
    id, league_id, profile_id, rank, prev_rank, total_points,
    matches_played, form, updated_at
  )
  values (
    gen_random_uuid()::text, v_league_id, v_profile, 1, null, 0,
    0, '[]'::jsonb, now()
  );

  -- Log activity
  insert into public.league_activity (
    id, league_id, profile_id, action, summary, meta, created_at
  )
  values (
    gen_random_uuid()::text, v_league_id, v_profile, 'league.created',
    'League created', jsonb_build_object('format', p_format, 'name', p_name), now()
  );

  perform public.initialize_scoring_rules(v_league_id);
  return v_league_id;
end;
$$;
