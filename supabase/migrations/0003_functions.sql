-- ============================================================================
-- 0003_functions.sql — RPC functions and integrity triggers
-- ============================================================================
-- These are the only privileged paths available to an authenticated client.
-- Every function resolves authorization from `auth.uid()::text` against
-- league_members; nothing about the caller's role is accepted from the
-- request payload.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- join_league: the only way a client joins a league (validates the code)
-- ---------------------------------------------------------------------------
create or replace function public.join_league(p_code text, p_team_name text default null)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_league leagues%rowtype;
  v_member  public.league_members%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_league from leagues where invite_code = upper(trim(p_code));
  if not found then
    raise exception 'No league found with that code';
  end if;

  select * into v_member from league_members
   where league_id = v_league.id and profile_id = auth.uid()::text;

  if found then
    return v_league.id; -- idempotent: joining twice is a no-op
  end if;

  insert into league_members (id, league_id, profile_id, role, team_name)
  values (gen_random_uuid()::text, v_league.id, auth.uid()::text, 'manager',
          coalesce(p_team_name, 'My XI'));

  insert into league_standings (id, league_id, profile_id, rank, total_points, matches_played, form)
  values (gen_random_uuid()::text, v_league.id, auth.uid()::text, 0, 0, 0, '[]'::jsonb)
  on conflict (league_id, profile_id) do nothing;

  insert into league_activity (id, league_id, profile_id, action, summary, created_at)
  values (gen_random_uuid()::text, v_league.id, auth.uid()::text, 'member.joined',
          'A manager joined the league', now());

  return v_league.id;
end;
$$;

revoke all on function public.join_league(text, text) from public;
grant execute on function public.join_league(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- create_league: atomic league creation (league + membership + standings +
-- activity + scoring rules) in a single SECURITY DEFINER transaction.
-- ---------------------------------------------------------------------------
create or replace function public.create_league(
  p_name text,
  p_description text default null,
  p_format text default '5v5',
  p_starters integer default 5,
  p_subs_count integer default 5,
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

  return v_league_id;
end;
$$;

revoke all on function public.create_league(text, text, text, integer, integer, text) from public;
grant execute on function public.create_league(text, text, text, integer, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- set_member_role: leaders only, never self-elevation by a non-leader
-- ---------------------------------------------------------------------------
create or replace function public.set_member_role(p_league text, p_profile text, p_role text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_leader(p_league) then
    raise exception 'Only a League Leader can change roles';
  end if;
  if p_role not in ('leader','manager','organizer') then
    raise exception 'Unknown role';
  end if;
  update league_members set role = p_role
   where league_id = p_league and profile_id = p_profile;
  if not found then
    raise exception 'That manager is not in this league';
  end if;
end;
$$;

revoke all on function public.set_member_role(text, text, text) from public;
grant execute on function public.set_member_role(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Trigger: a member can never promote themselves
-- ---------------------------------------------------------------------------
create or replace function public.prevent_self_promotion()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.profile_id = auth.uid()::text and new.role <> old.role
     and not public.is_leader(old.league_id) then
    raise exception 'You cannot change your own role';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_self_promotion on public.league_members;
create trigger trg_prevent_self_promotion
  before update on public.league_members
  for each row execute function public.prevent_self_promotion();
revoke all on function public.prevent_self_promotion() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- calculate_match_points: deterministic, idempotent point production.
-- Only runs for approved matches with an APPROVED rule set.
-- ---------------------------------------------------------------------------
create or replace function public.calculate_match_points(p_match text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_match     public.real_matches%rowtype;
  v_league    public.leagues%rowtype;
  v_rules_ok  boolean;
  v_players   int;
  v_managers  int;
  v_gameweek  int;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_match from public.real_matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if not (public.is_leader(v_match.league_id) or public.is_match_organizer(p_match)) then
    raise exception 'Only the League Leader or Match Organizer can calculate official points';
  end if;
  if v_match.status <> 'approved' then
    raise exception 'Points may only be calculated for approved matches';
  end if;

  select * into v_league from public.leagues where id = v_match.league_id;
  if not found then raise exception 'League not found'; end if;

  select count(*) > 0 and bool_and(status = 'approved')
    into v_rules_ok
    from public.scoring_rules where league_id = v_match.league_id;
  if not coalesce(v_rules_ok, false) then
    raise exception 'Scoring rules are still in draft';
  end if;

  -- Participants match src/lib/points.ts: starters plus players substituted on.
  with appearance as (
    select player_id from public.match_lineups
     where match_id = p_match and slot = 'starter'
    union
    select player_on_id as player_id from public.match_substitutions
     where match_id = p_match
  ), event_counts as (
    select player_id,
           count(*) filter (where event_type = 'goal') as goals,
           count(*) filter (where event_type = 'own_goal') as own_goals,
           count(*) filter (where event_type = 'yellow_card') as yellows,
           count(*) filter (where event_type = 'red_card') as reds,
           count(*) filter (where event_type = 'penalty_saved') as penalties_saved,
           count(*) filter (where event_type = 'penalty_missed') as penalties_missed
      from public.match_events
     where match_id = p_match
     group by player_id
  ), assist_counts as (
    select player_id, sum(n)::int as assists
      from (
        select player_id, count(*)::int as n
          from public.match_events
         where match_id = p_match and event_type = 'assist'
         group by player_id
        union all
        select assist_player_id as player_id, count(*)::int as n
          from public.match_events
         where match_id = p_match and event_type = 'goal'
           and assist_player_id is not null
         group by assist_player_id
      ) a
     group by player_id
  ), team_ids as (
    select distinct team_id from public.match_lineups where match_id = p_match
  ), conceded as (
    select t.team_id,
           count(e.id) filter (
             where (e.event_type = 'goal' and e.team_id <> t.team_id)
                or (e.event_type = 'own_goal' and e.team_id = t.team_id)
           )::int as against
      from team_ids t
      left join public.match_events e on e.match_id = p_match
     group by t.team_id
  ), lines as (
    select l.player_id,
           p.position,
           l.slot,
           coalesce(ec.goals, 0)::int as goals,
           coalesce(ac.assists, 0)::int as assists,
           coalesce(ec.own_goals, 0)::int as own_goals,
           coalesce(ec.yellows, 0)::int as yellows,
           coalesce(ec.reds, 0)::int as reds,
           coalesce(ec.penalties_saved, 0)::int as penalties_saved,
           coalesce(ec.penalties_missed, 0)::int as penalties_missed,
           case when coalesce(c.against, 0) = 0 and l.slot = 'starter'
                then 1 else 0 end as clean_sheet
      from public.match_lineups l
      join public.players p on p.id = l.player_id
      join appearance ap on ap.player_id = l.player_id
      left join event_counts ec on ec.player_id = l.player_id
      left join assist_counts ac on ac.player_id = l.player_id
      left join conceded c on c.team_id = l.team_id
     where l.match_id = p_match
  ), components as (
    select x.player_id, x.position, v.category, v.category_order,
           v.event_count as event_count, r.points as points_per,
           case v.category
             when 'appearance' then 'Appearance'
             when 'clean_sheet' then 'Clean sheet'
             when 'goal' then 'Goal'
             when 'assist' then 'Assist'
             when 'own_goal' then 'Own goal'
             when 'yellow_card' then 'Yellow card'
             when 'red_card' then 'Red card'
             when 'penalty_saved' then 'Penalty saved'
             when 'penalty_missed' then 'Penalty missed'
             else v.category
           end as label
      from lines x
      cross join lateral (values
        ('appearance', 1, 1),
        ('clean_sheet', 2, x.clean_sheet),
        ('goal', 3, x.goals),
        ('assist', 4, x.assists),
        ('own_goal', 5, x.own_goals),
        ('yellow_card', 6, x.yellows),
        ('red_card', 7, x.reds),
        ('penalty_saved', 8, x.penalties_saved),
        ('penalty_missed', 9, x.penalties_missed)
      ) as v(category, category_order, event_count)
      join public.scoring_rules r
        on r.league_id = v_match.league_id
       and r.position = x.position
       and r.event_type = v.category
       and r.status = 'approved'
     where v.event_count > 0 and r.points <> 0
  ), scored as (
    select player_id,
           coalesce(sum(event_count * points_per), 0)::numeric as total,
           coalesce(jsonb_agg(jsonb_build_object(
             'category', category,
             'label', label,
             'count', event_count,
             'pointsPer', points_per,
             'points', event_count * points_per
           ) order by category_order), '[]'::jsonb) as breakdown
      from components
     group by player_id
  )
  insert into public.player_match_points
    (id, league_id, match_id, player_id, match_version, points, breakdown, computed_at)
  select gen_random_uuid()::text, v_match.league_id, p_match, s.player_id,
         v_match.version, s.total, s.breakdown, now()
    from scored s
  on conflict (match_id, player_id) do update
    set points = excluded.points,
        breakdown = excluded.breakdown,
        match_version = excluded.match_version,
        computed_at = now();

  get diagnostics v_players = row_count;

  -- Manager points mirror computeManagerPoints(): the captain doubles only
  -- if they participated; otherwise the vice-captain may inherit the double.
  with appearance as (
    select player_id from public.match_lineups
     where match_id = p_match and slot = 'starter'
    union
    select player_on_id as player_id from public.match_substitutions
     where match_id = p_match
  ), squad_caps as (
    select s.id as squad_id, s.profile_id, s.captain_id, s.vice_captain_id,
           case
             when s.captain_id is not null and exists (
               select 1 from appearance ap where ap.player_id = s.captain_id
             ) then s.captain_id
             when v_league.vice_policy = 'auto_captain'
               and s.vice_captain_id is not null and exists (
                 select 1 from appearance ap where ap.player_id = s.vice_captain_id
               ) then s.vice_captain_id
             else null
           end as active_captain_id
      from public.fantasy_squads s
     where s.league_id = v_match.league_id
  ), manager_lines as (
    select sc.profile_id, sc.active_captain_id, sp.player_id,
           coalesce(pmp.points, 0)::numeric as base,
           case when sp.player_id = sc.active_captain_id then 2 else 1 end as multiplier
      from squad_caps sc
      join public.fantasy_squad_players sp
        on sp.squad_id = sc.squad_id and sp.slot = 'starter'
      left join public.player_match_points pmp
        on pmp.match_id = p_match and pmp.player_id = sp.player_id
  ), manager_totals as (
    select profile_id, active_captain_id,
           coalesce(sum(base * multiplier), 0)::numeric as total,
           coalesce(jsonb_agg(jsonb_build_object(
             'playerId', player_id,
             'base', base,
             'multiplier', multiplier,
             'points', base * multiplier
           ) order by player_id), '[]'::jsonb) as lines
      from manager_lines
     group by profile_id, active_captain_id
  )
  insert into public.manager_points
    (id, league_id, match_id, profile_id, match_version, points, breakdown, computed_at)
  select gen_random_uuid()::text, v_match.league_id, p_match, mt.profile_id,
         v_match.version, mt.total,
         jsonb_build_object('lines', mt.lines, 'captainId', mt.active_captain_id), now()
    from manager_totals mt
  on conflict (match_id, profile_id) do update
    set points = excluded.points,
        breakdown = excluded.breakdown,
        match_version = excluded.match_version,
        computed_at = now();

  get diagnostics v_managers = row_count;

  select coalesce(max(gameweek), 1)::int into v_gameweek
    from public.fantasy_fixtures where league_id = v_match.league_id;

  insert into public.fantasy_points_history
    (id, league_id, profile_id, match_id, gameweek, points, created_at)
  select gen_random_uuid()::text, v_match.league_id, mp.profile_id,
         p_match, v_gameweek, mp.points, now()
    from public.manager_points mp
   where mp.match_id = p_match and mp.league_id = v_match.league_id
  on conflict (profile_id, match_id) do update
    set points = excluded.points, gameweek = excluded.gameweek;

  perform public.recalculate_standings(v_match.league_id);

  return jsonb_build_object('players', v_players, 'managers', v_managers,
                            'matchId', p_match, 'version', v_match.version);
end;
$$;

revoke all on function public.calculate_match_points(text) from public, anon, authenticated;
grant execute on function public.calculate_match_points(text) to authenticated;

-- ---------------------------------------------------------------------------
-- recalculate_standings: rebuild the table from the ledger, never increment
-- ---------------------------------------------------------------------------
create or replace function public.recalculate_standings(p_league text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into league_standings
    (id, league_id, profile_id, rank, prev_rank, total_points, matches_played, form, updated_at)
  select gen_random_uuid()::text, s.league_id, s.profile_id,
         coalesce(st.rank, 0), st.rank,
         coalesce(l.total, 0), coalesce(l.played, 0),
         coalesce(l.form, '[]'::jsonb), now()
    from fantasy_squads s
    left join league_standings st
           on st.league_id = s.league_id and st.profile_id = s.profile_id
    left join lateral (
      select sum(mp.points) as total,
             count(*)       as played,
             jsonb_agg(jsonb_build_object('matchId', mp.match_id,
                                          'points', mp.points)
                       order by mp.computed_at) as form
        from manager_points mp
       where mp.league_id = s.league_id and mp.profile_id = s.profile_id
    ) l on true
   where s.league_id = p_league
  on conflict (league_id, profile_id) do update
    set total_points  = excluded.total_points,
        matches_played = excluded.matches_played,
        form          = excluded.form,
        prev_rank     = league_standings.rank,
        updated_at    = now();

  with ordered as (
    select profile_id,
           row_number() over (order by total_points desc, matches_played asc, profile_id) as new_rank
      from league_standings where league_id = p_league
  )
  update league_standings s
     set rank = o.new_rank
    from ordered o
   where s.league_id = p_league and s.profile_id = o.profile_id;
end;
$$;

revoke all on function public.recalculate_standings(text) from public, anon, authenticated;
grant execute on function public.recalculate_standings(text) to authenticated;

-- ---------------------------------------------------------------------------
-- approve_match / reject_match: the approval state machine, server side.
-- Enforces: pending state, version guard, and Leader/Organizer role.
-- ---------------------------------------------------------------------------
create or replace function public.approve_match(p_match text, p_version int default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v real_matches%rowtype;
  v_result jsonb;
begin
  select * into v from real_matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if not (public.is_leader(v.league_id) or public.is_match_organizer(p_match)) then
    raise exception 'Only the League Leader or Match Organizer can approve results';
  end if;
  if v.status <> 'pending' then
    raise exception 'Match is not pending approval';
  end if;
  if p_version is not null and p_version <> v.version then
    raise exception 'Match changed since you reviewed it';
  end if;
  -- Product rule: the League Leader may approve even when they submitted
  -- the result, and the Match Organizer may approve results for matches
  -- they organize. Neither role is blocked by self-approval.

  update real_matches
     set status = 'approved', decided_by = auth.uid()::text, decided_at = now(),
         rejection_reason = null, version = version + 1, updated_at = now()
   where id = p_match;

  insert into match_approvals (id, match_id, action, actor_id, version, created_at)
  values (gen_random_uuid()::text, p_match, 'approved', auth.uid()::text, v.version + 1, now());

  v_result := public.calculate_match_points(p_match);
  return v_result;
end;
$$;

revoke all on function public.approve_match(text, integer) from public;
grant execute on function public.approve_match(text, integer) to authenticated;

create or replace function public.reject_match(p_match text, p_reason text, p_version int default null)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v real_matches%rowtype;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A rejection reason is required';
  end if;
  select * into v from real_matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if not (public.is_leader(v.league_id) or public.is_match_organizer(p_match)) then
    raise exception 'Only the League Leader or Match Organizer can reject results';
  end if;
  if v.status <> 'pending' then
    raise exception 'Match is not pending approval';
  end if;
  if p_version is not null and p_version <> v.version then
    raise exception 'Match changed since you reviewed it';
  end if;

  update real_matches
     set status = 'rejected', decided_by = auth.uid()::text, decided_at = now(),
         rejection_reason = p_reason, version = version + 1, updated_at = now()
   where id = p_match;

  insert into match_approvals (id, match_id, action, actor_id, reason, version, created_at)
  values (gen_random_uuid()::text, p_match, 'rejected', auth.uid()::text, p_reason, v.version + 1, now());
end;
$$;

revoke all on function public.reject_match(text, text, integer) from public;
grant execute on function public.reject_match(text, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- submit_match: validates both lineups against the league format before the
-- result can enter the approval queue.
-- ---------------------------------------------------------------------------
create or replace function public.submit_match(p_match text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v real_matches%rowtype;
  v_league public.leagues%rowtype;
  v_team text;
  v_starters int;
  v_gks int;
  v_bench int;
begin
  select * into v from real_matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if not (public.is_leader(v.league_id) or public.is_match_organizer(p_match)) then
    raise exception 'Only the League Leader or Match Organizer can submit this result';
  end if;
  if v.status not in ('draft','rejected') then
    raise exception 'Match is not awaiting submission';
  end if;
  select * into v_league from public.leagues where id = v.league_id;
  if not found then raise exception 'League not found'; end if;

  if not exists (
    select 1 from public.teams t
     where t.id = v.team_a_id and t.league_id = v.league_id
  ) or not exists (
    select 1 from public.teams t
     where t.id = v.team_b_id and t.league_id = v.league_id
  ) then
    raise exception 'Both match teams must belong to this league';
  end if;

  if exists (
    select 1
      from public.match_lineups l
      join public.players p on p.id = l.player_id
     where l.match_id = p_match
       and (l.league_id <> v.league_id
         or l.team_id not in (v.team_a_id, v.team_b_id)
         or p.league_id <> v.league_id
         or (p.team_id is not null and p.team_id <> l.team_id))
  ) then
    raise exception 'Every lineup player and team must belong to this match league';
  end if;

  if exists (
    select 1
      from public.match_events e
      join public.players p on p.id = e.player_id
      left join public.players ap on ap.id = e.assist_player_id
     where e.match_id = p_match
       and (e.league_id <> v.league_id
         or e.team_id not in (v.team_a_id, v.team_b_id)
         or p.league_id <> v.league_id
         or (p.team_id is not null and p.team_id <> e.team_id)
         or (e.assist_player_id is not null and (
              ap.id is null or ap.league_id <> v.league_id
              or (ap.team_id is not null and ap.team_id <> e.team_id)
            )))
  ) then
    raise exception 'Every match event and assist must belong to the correct match team';
  end if;

  if exists (
    select 1
      from public.match_substitutions s
      join public.players pon on pon.id = s.player_on_id
      join public.players poff on poff.id = s.player_off_id
     where s.match_id = p_match
       and (s.league_id <> v.league_id
         or s.team_id not in (v.team_a_id, v.team_b_id)
         or pon.league_id <> v.league_id
         or poff.league_id <> v.league_id
         or (pon.team_id is not null and pon.team_id <> s.team_id)
         or (poff.team_id is not null and poff.team_id <> s.team_id)
         or not exists (select 1 from public.match_lineups l
                         where l.match_id = p_match and l.player_id = s.player_on_id
                           and l.team_id = s.team_id)
         or not exists (select 1 from public.match_lineups l
                         where l.match_id = p_match and l.player_id = s.player_off_id
                           and l.team_id = s.team_id))
  ) then
    raise exception 'Substitutions must pair a listed substitute with a starter from the same team';
  end if;

  if not coalesce((
    select count(*) > 0 and bool_and(status = 'approved')
      from public.scoring_rules where league_id = v.league_id
  ), false) then
    raise exception 'All scoring rules must be approved before submitting a result';
  end if;

  foreach v_team in array array[v.team_a_id, v.team_b_id] loop
    select count(*) filter (where slot = 'starter'),
           count(*) filter (where slot = 'starter' and p.position = 'GK'),
           count(*) filter (where slot = 'sub')
      into v_starters, v_gks, v_bench
      from match_lineups l join players p on p.id = l.player_id
     where l.match_id = p_match and l.team_id = v_team;

    if v_starters <> v_league.starters then
      raise exception 'Each team must field exactly % starters', v_league.starters;
    end if;
    if v_gks <> 1 then
      raise exception 'Each team must start exactly one goalkeeper';
    end if;
    if v_bench > v_league.subs_count then
      raise exception 'Too many substitutes for this league format';
    end if;
  end loop;

  update real_matches
     set status = 'pending', submitted_by = auth.uid()::text, submitted_at = now(),
         rejection_reason = null, version = version + 1, updated_at = now()
   where id = p_match;

  insert into match_approvals (id, match_id, action, actor_id, version, created_at)
  values (gen_random_uuid()::text, p_match, 'submitted', auth.uid()::text, v.version + 1, now());

  return public.build_match_state(p_match);
end;
$$;

revoke all on function public.submit_match(text) from public;
grant execute on function public.submit_match(text) to authenticated;

-- ---------------------------------------------------------------------------
create or replace function public.build_match_state(p_match text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
stable
as $$
declare
  v_league_id text;
  v_state jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select m.league_id into v_league_id
    from public.real_matches m where m.id = p_match;
  if not found then raise exception 'Match not found'; end if;
  if not public.is_member(v_league_id) then
    raise exception 'You are not a member of this league';
  end if;

  select jsonb_build_object(
    'id', m.id,
    'status', m.status,
    'version', m.version,
    'events', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', e.id, 'type', e.event_type, 'minute', e.minute,
                 'playerId', e.player_id) order by e.minute)
               from public.match_events e where e.match_id = m.id), '[]'::jsonb),
    'lineups', coalesce((select jsonb_agg(jsonb_build_object(
                 'playerId', l.player_id, 'teamId', l.team_id, 'slot', l.slot))
               from public.match_lineups l where l.match_id = m.id), '[]'::jsonb)
  ) into v_state
  from public.real_matches m where m.id = p_match;

  return v_state;
end;
$$;

revoke all on function public.build_match_state(text) from public, anon;
grant execute on function public.build_match_state(text) to authenticated;
