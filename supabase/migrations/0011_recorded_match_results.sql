begin;

alter table public.real_matches
  add column home_score integer,
  add column away_score integer,
  add constraint real_matches_result_ck check (
    (home_score is null and away_score is null) or
    (home_score is not null and away_score is not null and home_score between 0 and 999 and away_score between 0 and 999)
  );

-- Results must go through the locked workflow; direct inserts still support drafts only.
alter policy matches_insert on public.real_matches with check (
  status = 'draft' and home_score is null and away_score is null and
  (public.is_leader(league_id) or (public.is_organizer(league_id) and organizer_id = auth.uid()::text))
);
revoke update (home_score, away_score) on public.real_matches from public, anon, authenticated;
alter table public.match_approvals drop constraint approvals_action_ck,
  add constraint approvals_action_ck check (action in ('submitted','approved','rejected','reopened','corrected'));

-- Freeze only the information needed for a score correction. The existing
-- manager ledger already freezes the effective squad, captain and autosubs.
alter table public.match_scoring_receipts add column result_basis jsonb;

create function public.ff_result_breakdown(
  p_for int, p_against int, p_started boolean, p_clean numeric, p_win numeric, p_draw numeric
) returns jsonb language sql immutable set search_path = pg_catalog, public as $$
  select coalesce(jsonb_agg(jsonb_build_object('category', c.category, 'label', c.label,
    'count', 1, 'pointsPer', c.value, 'points', c.value) order by c.rank), '[]'::jsonb)
  from (values
    ('clean_sheet', 'Clean sheet', 1, p_clean, p_started and p_against = 0),
    ('win', 'Match win', 2, p_win, p_for > p_against),
    ('draw', 'Match draw', 3, p_draw, p_for = p_against)
  ) c(category, label, rank, value, eligible)
  where c.eligible and c.value <> 0;
$$;
revoke all on function public.ff_result_breakdown(int,int,boolean,numeric,numeric,numeric) from public, anon, authenticated;

-- Reuse the original lineup, event, rule and substitution checks, but don't
-- allow callers to submit without a result. The transition and score are atomic.
alter function public.submit_match(text) rename to ff_submit_validated_match;
revoke all on function public.ff_submit_validated_match(text) from public, anon, authenticated;

create function public.submit_match(p_match text, p_version int, p_home_score int, p_away_score int)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare m real_matches%rowtype;
begin
  select * into m from real_matches where id=p_match for update;
  if auth.uid() is null or not found or not (public.is_leader(m.league_id) or public.is_match_organizer(p_match)) then
    raise insufficient_privilege;
  end if;
  if p_home_score is null or p_away_score is null or p_home_score not between 0 and 999 or p_away_score not between 0 and 999 then
    raise invalid_parameter_value using message='Enter both scores as whole numbers from 0 to 999';
  end if;
  if m.status='pending' and p_version=m.version-1 and (m.home_score,m.away_score)=(p_home_score,p_away_score) then
    return to_jsonb(m);
  end if;
  if p_version is distinct from m.version then raise serialization_failure; end if;
  perform public.ff_submit_validated_match(p_match);
  update real_matches set home_score=p_home_score,away_score=p_away_score where id=p_match returning * into strict m;
  update match_approvals set snapshot=jsonb_build_object('homeScore',p_home_score,'awayScore',p_away_score)
    where match_id=p_match and action='submitted' and version=m.version;
  return to_jsonb(m);
end;
$$;
revoke all on function public.submit_match(text,int,int,int) from public, anon, authenticated;
grant execute on function public.submit_match(text,int,int,int) to authenticated;

-- Keep legacy approved matches readable and preserve their existing explicit rescore path.
create or replace function public.ff_score_match(p_match text, p_finalize boolean)
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
  v_result jsonb;
  v_basis jsonb;
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

  select result into v_result from public.match_scoring_receipts where match_id=p_match and match_version=v_match.version;
  if found then return v_result; end if;
  -- Serialize finalization in the same league so simultaneous approvals do not
  -- publish standings computed before the other match's ledger commits.
  perform pg_advisory_xact_lock(hashtextextended('ff-score:' || v_match.league_id,0));

  select * into v_league from public.leagues where id = v_match.league_id;
  if not found then raise exception 'League not found'; end if;

  select count(*) > 0 and bool_and(status = 'approved')
    into v_rules_ok
    from public.scoring_rules where league_id = v_match.league_id;
  if not coalesce(v_rules_ok, false) then
    raise exception 'Scoring rules are still in draft';
  end if;

  -- Snapshot the result-only scoring rules and actual starters/participants
  -- once. Future score edits must not depend on today's rules or roster.
  if v_match.home_score is not null then
    select coalesce(jsonb_agg(to_jsonb(b) order by b.player_id),'[]') into v_basis
    from (
      select l.player_id, l.team_id=v_match.team_a_id as is_home, l.slot='starter' as started,
        max(r.points) filter (where r.event_type='clean_sheet') as clean,
        max(r.points) filter (where r.event_type='win') as win,
        max(r.points) filter (where r.event_type='draw') as draw
      from match_lineups l
      join players p on p.id=l.player_id
      left join scoring_rules r on r.league_id=v_match.league_id and r.position=p.position
        and r.status='approved' and r.event_type in ('clean_sheet','win','draw')
      where l.match_id=p_match and (l.slot='starter' or exists (
        select 1 from match_substitutions s where s.match_id=p_match and s.player_on_id=l.player_id
      ))
      group by l.player_id,l.team_id,l.slot
    ) b;
  end if;

  -- Participants match src/lib/points.ts: starters plus players substituted on.
  with appearance as (
    select player_id from public.match_lineups
     where match_id = p_match and slot = 'starter'
    union
    select player_on_id as player_id from public.match_substitutions
     where match_id = p_match
  ), recorded_events as materialized (
    select e.* from match_events e join appearance a using (player_id) where e.match_id=p_match
  ), event_counts as (
    select player_id,
           count(*) filter (where event_type = 'goal') as goals,
           count(*) filter (where event_type = 'own_goal') as own_goals,
           count(*) filter (where event_type = 'yellow_card') as yellows,
           count(*) filter (where event_type = 'red_card') as reds,
           count(*) filter (where event_type = 'penalty_saved') as penalties_saved,
           count(*) filter (where event_type = 'penalty_missed') as penalties_missed
      from recorded_events
     group by player_id
  ), assist_counts as (
    select player_id, sum(n)::int as assists
      from (
        select player_id, count(*)::int as n
          from recorded_events
         where event_type = 'assist'
         group by player_id
        union all
        select assist_player_id as player_id, count(*)::int as n
          from recorded_events
         where event_type = 'goal'
           and assist_player_id is not null
         group by assist_player_id
      ) a
     group by player_id
  ), team_ids as (
    select unnest(array[v_match.team_a_id,v_match.team_b_id]) as team_id
  ), conceded as (
    select t.team_id,
           count(e.id) filter (
             where (e.event_type = 'goal' and e.team_id <> t.team_id)
                or (e.event_type = 'own_goal' and e.team_id = t.team_id)
           )::int as against
      from team_ids t
      left join recorded_events e on true
     group by t.team_id
  ), lines as (
    select l.player_id,
           p.position,
           l.slot,
           case when c.against < opponent.against then 1 else 0 end as won,
           case when c.against = opponent.against then 1 else 0 end as drawn,
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
      left join conceded opponent on opponent.team_id = case when l.team_id=v_match.team_a_id then v_match.team_b_id else v_match.team_a_id end
     where l.match_id = p_match
  ), components as materialized (
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
             when 'win' then 'Match win'
             when 'draw' then 'Match draw'
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
        ('penalty_missed', 9, x.penalties_missed),
        ('win',10,x.won), ('draw',11,x.drawn)
      ) as v(category, category_order, event_count)
      join public.scoring_rules r
        on r.league_id = v_match.league_id
       and r.position = x.position
       and r.event_type = v.category
       and r.status = 'approved'
     where v.event_count > 0 and r.points <> 0
       and (v_basis is null or v.category not in ('clean_sheet','win','draw'))
  ), result_components as (
    select b.player_id, entries.lines,
      (select coalesce(sum((e->>'points')::numeric),0) from jsonb_array_elements(entries.lines) e) as total
    from jsonb_to_recordset(v_basis) b(player_id text,is_home boolean,started boolean,clean numeric,win numeric,draw numeric)
    cross join lateral (select public.ff_result_breakdown(
      case when b.is_home then v_match.home_score else v_match.away_score end,
      case when b.is_home then v_match.away_score else v_match.home_score end,
      b.started,b.clean,b.win,b.draw) as lines) entries
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
  select gen_random_uuid()::text, v_match.league_id, p_match, l.player_id,
         v_match.version, coalesce(s.total,0)+coalesce(rc.total,0), coalesce(s.breakdown,'[]'::jsonb)||coalesce(rc.lines,'[]'::jsonb), now()
    from lines l left join scored s on s.player_id=l.player_id
    left join result_components rc on rc.player_id=l.player_id
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
  ), squads as materialized (
    select s.id,s.profile_id,s.captain_id,s.vice_captain_id,s.formation,
      jsonb_agg(e.data order by e.priority,e.id) filter (where e.slot='starter') as starters,
      jsonb_agg(e.data order by e.priority,e.id) filter (where e.slot='sub') as bench
    from fantasy_squads s
    join lateral (
      select sp.player_id as id,sp.slot,sp."order" as priority,
        jsonb_build_object('id',p.id,'name',p.full_name,'position',p.position,'priority',sp."order",'played',ap.player_id is not null) as data
      from fantasy_squad_players sp join players p on p.id=sp.player_id and p.league_id=v_match.league_id
      left join appearance ap on ap.player_id=p.id where sp.squad_id=s.id and sp.slot in ('starter','sub')
    ) e on true
    where s.league_id=v_match.league_id
    group by s.id
  ), squad_caps as materialized (
    select s.profile_id,s.starters,
           case when p_finalize then public.ff_auto_substitutions(s.starters,coalesce(s.bench,'[]'),s.formation,v_league.starters)
             else '[]'::jsonb end as substitutions,
           case
             when s.captain_id is not null and exists (
               select 1 from appearance ap where ap.player_id = s.captain_id
             ) and s.starters @> jsonb_build_array(jsonb_build_object('id',s.captain_id)) then s.captain_id
             when v_league.vice_policy = 'auto_captain'
               and s.vice_captain_id is not null and exists (
                 select 1 from appearance ap where ap.player_id = s.vice_captain_id
               ) and s.starters @> jsonb_build_array(jsonb_build_object('id',s.vice_captain_id)) then s.vice_captain_id
             else null
           end as active_captain_id
      from squads s
     where s.starters is not null
  ), manager_lines as (
    select sc.profile_id,sc.active_captain_id,sc.substitutions, effective.player_id,
           coalesce(pmp.points,0) as base,
           case when effective.player_id = sc.active_captain_id then 2 else 1 end as multiplier
    from squad_caps sc cross join lateral jsonb_array_elements(sc.starters) starter
    left join lateral (select value->>'inId' as incoming from jsonb_array_elements(sc.substitutions)
      where value->>'outId'=starter->>'id') swap on true
    cross join lateral (select coalesce(swap.incoming,starter->>'id') as player_id) effective
    left join player_match_points pmp on pmp.match_id=p_match and pmp.player_id=effective.player_id and pmp.match_version=v_match.version
  ), manager_totals as (
    select profile_id, active_captain_id, substitutions,
           coalesce(sum(base * multiplier), 0)::numeric as total,
           coalesce(jsonb_agg(jsonb_build_object(
             'playerId', player_id,
             'base', base,
             'multiplier', multiplier,
             'points', base * multiplier
           ) order by player_id), '[]'::jsonb) as lines
      from manager_lines
     group by profile_id, active_captain_id, substitutions
  )
  insert into public.manager_points
    (id, league_id, match_id, profile_id, match_version, points, breakdown, computed_at)
  select gen_random_uuid()::text, v_match.league_id, p_match, mt.profile_id,
         v_match.version, mt.total,
         jsonb_build_object('lines', mt.lines, 'captainId', mt.active_captain_id, 'substitutions', mt.substitutions), now()
    from manager_totals mt
  on conflict (match_id, profile_id) do update
    set points = excluded.points,
        breakdown = excluded.breakdown,
        match_version = excluded.match_version,
        computed_at = now();

  get diagnostics v_managers = row_count;

  select gameweek into v_gameweek from fantasy_fixtures where id=v_match.fixture_id and league_id=v_match.league_id;
  if v_gameweek is null then
    select coalesce(max(gameweek),1)::int into v_gameweek from fantasy_fixtures where league_id=v_match.league_id;
  end if;

  insert into public.fantasy_points_history
    (id, league_id, profile_id, match_id, gameweek, points, created_at)
  select gen_random_uuid()::text, v_match.league_id, mp.profile_id,
         p_match, v_gameweek, mp.points, now()
    from public.manager_points mp
   where mp.match_id = p_match and mp.league_id = v_match.league_id
  on conflict (profile_id, match_id) do update
    set points = excluded.points, gameweek = excluded.gameweek;

  perform public.recalculate_standings(v_match.league_id);

  v_result := jsonb_build_object('players',v_players,'managers',v_managers,'matchId',p_match,'version',v_match.version);
  if p_finalize then
    insert into match_scoring_receipts(match_id,match_version,result,result_basis) values(p_match,v_match.version,v_result,v_basis)
      on conflict (match_id) do update set match_version=excluded.match_version,result=excluded.result,result_basis=excluded.result_basis;
  end if;
  return v_result;
end;
$$;

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
  -- Product rule: the League Leader may approve even when they submitted
  -- the result, and the Match Organizer may approve results for matches
  -- they organize. Neither role is blocked by self-approval.

  update real_matches
     set status = 'approved', decided_by = auth.uid()::text, decided_at = now(),
         rejection_reason = null, version = version + 1, updated_at = now()
   where id = p_match;

  insert into match_approvals (id, match_id, action, actor_id, version, snapshot, created_at)
  values (gen_random_uuid()::text, p_match, 'approved', auth.uid()::text, v.version + 1,
    jsonb_build_object('homeScore',v.home_score,'awayScore',v.away_score), now());

  v_result := public.ff_score_match(p_match,true);
  return v_result;
end;
$$;

-- Score-only corrections preserve historical event points, fantasy picks and
-- multipliers, appearances, substitutions and the original gameweek.
create function public.correct_match_result(p_match text, p_version int, p_home_score int, p_away_score int, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m real_matches%rowtype;
  receipt match_scoring_receipts%rowtype;
  revision int;
  changed_rows int;
begin
  select * into m from real_matches where id=p_match for update;
  if auth.uid() is null or not found or not (public.is_leader(m.league_id) or public.is_match_organizer(p_match)) then
    raise insufficient_privilege;
  end if;
  if p_home_score is null or p_away_score is null or p_home_score not between 0 and 999 or p_away_score not between 0 and 999
     or coalesce(length(trim(p_reason)),0) not between 1 and 400 then
    raise invalid_parameter_value using message='Enter both valid scores and a correction reason';
  end if;
  select * into receipt from match_scoring_receipts where match_id=p_match and match_version=m.version;
  if m.status <> 'approved' or m.home_score is null or receipt.result_basis is null then
    raise exception 'Only finalized matches with a recorded result can be corrected';
  end if;
  if p_version in (m.version,m.version-1) and (m.home_score,m.away_score)=(p_home_score,p_away_score) then
    return receipt.result;
  end if;
  if p_version is distinct from m.version then raise serialization_failure; end if;
  revision := m.version+1;
  perform pg_advisory_xact_lock(hashtextextended('ff-score:' || m.league_id,0));

  with revised as (
    select p.id, rows.breakdown,
      (select coalesce(sum((line->>'points')::numeric),0) from jsonb_array_elements(rows.breakdown) line) as points
    from player_match_points p
    join jsonb_to_recordset(receipt.result_basis) b(player_id text,is_home boolean,started boolean,clean numeric,win numeric,draw numeric)
      on b.player_id=p.player_id
    cross join lateral (
      select coalesce((select jsonb_agg(e.value order by e.ord)
        from jsonb_array_elements(p.breakdown) with ordinality e(value,ord)
        where e.value->>'category' not in ('clean_sheet','win','draw')), '[]'::jsonb)
      || public.ff_result_breakdown(case when b.is_home then p_home_score else p_away_score end,
        case when b.is_home then p_away_score else p_home_score end,b.started,b.clean,b.win,b.draw) as breakdown
    ) rows
    where p.match_id=p_match and p.league_id=m.league_id and p.match_version=m.version
  )
  update player_match_points p set points=r.points,breakdown=r.breakdown,match_version=revision
    from revised r where p.id=r.id;
  get diagnostics changed_rows = row_count;
  if changed_rows is distinct from (receipt.result->>'players')::int then
    raise exception 'The player scoring ledger is incomplete; the correction was not applied';
  end if;

  with revised as (
    select mp.id, coalesce(sum(base.points*(line->>'multiplier')::numeric),0) as points,
      coalesce(jsonb_agg(line || jsonb_build_object('base',base.points,'points',base.points*(line->>'multiplier')::numeric)
        order by ord),'[]'::jsonb) as lines
    from manager_points mp
    cross join lateral jsonb_array_elements(mp.breakdown->'lines') with ordinality e(line,ord)
    left join player_match_points p on p.match_id=p_match and p.league_id=m.league_id and p.match_version=revision
       and p.player_id=line->>'playerId'
    cross join lateral (select coalesce(p.points,0) as points) base
    where mp.match_id=p_match and mp.league_id=m.league_id and mp.match_version=m.version
    group by mp.id
  )
  update manager_points mp set points=r.points,breakdown=jsonb_set(mp.breakdown,'{lines}',r.lines),match_version=revision
    from revised r where mp.id=r.id;
  get diagnostics changed_rows = row_count;
  if changed_rows is distinct from (receipt.result->>'managers')::int then
    raise exception 'The manager scoring ledger is incomplete; the correction was not applied';
  end if;

  update fantasy_points_history h set points=mp.points
    from manager_points mp where h.match_id=p_match and h.league_id=m.league_id and h.profile_id=mp.profile_id
      and mp.match_id=p_match and mp.league_id=m.league_id and mp.match_version=revision;
  get diagnostics changed_rows = row_count;
  if changed_rows is distinct from (receipt.result->>'managers')::int then
    raise exception 'The fantasy points history is incomplete; the correction was not applied';
  end if;
  perform public.recalculate_standings(m.league_id);

  update real_matches set home_score=p_home_score,away_score=p_away_score,version=revision,updated_at=now() where id=p_match;
  insert into match_approvals(id,match_id,action,actor_id,reason,version,snapshot)
    values(gen_random_uuid()::text,p_match,'corrected',auth.uid()::text,trim(p_reason),revision,
      jsonb_build_object('previousHomeScore',m.home_score,'previousAwayScore',m.away_score,'homeScore',p_home_score,'awayScore',p_away_score));
  receipt.result := jsonb_set(receipt.result,'{version}',to_jsonb(revision));
  update match_scoring_receipts set result=receipt.result,match_version=revision where match_id=p_match;
  return receipt.result;
end;
$$;
revoke all on function public.correct_match_result(text,int,int,int,text) from public, anon, authenticated;
grant execute on function public.correct_match_result(text,int,int,int,text) to authenticated;

commit;
