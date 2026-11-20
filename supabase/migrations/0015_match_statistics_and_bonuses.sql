begin;

create table public.match_player_statistics (
  match_id text not null,
  player_id text not null,
  position text not null check (position in ('GK','DEF','MID','FWD')),
  saves integer not null default 0 check (saves between 0 and 999 and (saves=0 or position='GK')),
  defensive_contributions integer not null default 0 check (defensive_contributions between 0 and 999),
  bonus_rank integer check (bonus_rank between 1 and 3),
  primary key (match_id,player_id),
  unique (match_id,bonus_rank),
  foreign key (match_id,player_id) references public.match_lineups(match_id,player_id) on delete cascade
);
alter table public.match_player_statistics enable row level security;
revoke all on public.match_player_statistics from public,anon,authenticated;
grant select on public.match_player_statistics to authenticated;
create policy ff_match_statistics_read on public.match_player_statistics for select to authenticated
using (exists (select 1 from public.real_matches m where m.id=match_id and public.is_member(m.league_id)));

create function public.ff_match_participants(p_match text)
returns table(player_id text,"position" text) language sql stable set search_path=pg_catalog,public as $$
  select l.player_id,coalesce(l.match_position,p.position) from public.match_lineups l
  join public.real_matches m on m.id=l.match_id and m.league_id=l.league_id and l.team_id in (m.team_a_id,m.team_b_id)
  join public.players p on p.id=l.player_id and p.league_id=m.league_id
  where l.match_id=p_match and (l.slot='starter' or exists (
    select 1 from public.match_substitutions s where s.match_id=l.match_id and s.league_id=l.league_id
      and s.team_id=l.team_id and s.player_on_id=l.player_id
  ));
$$;
revoke all on function public.ff_match_participants(text) from public,anon,authenticated;

-- Fixed match-specific additions, independent of existing league scoring rules.
create function public.ff_match_extra_breakdown(p_match text,p_player text)
returns jsonb language sql stable set search_path=pg_catalog,public as $$
  select coalesce(jsonb_agg(jsonb_build_object('category',category,'label',label,'count',groups,
    'pointsPer',rate,'points',groups*rate) order by ord),'[]'::jsonb)
  from public.match_player_statistics s cross join lateral (values
    ('goalkeeper_saves','Goalkeeper saves (groups of 3)',1,case when s.position='GK' then s.saves/3 else 0 end,1),
    ('defensive_contributions','Defensive contributions (completed groups)',2,
      case when s.position='DEF' then s.defensive_contributions/10 when s.position in ('MID','FWD') then s.defensive_contributions/12 else 0 end,2),
    ('match_bonus','Match bonus',3,case when s.bonus_rank is not null then 1 else 0 end,4-s.bonus_rank)
  ) x(category,label,ord,groups,rate)
  where s.match_id=p_match and s.player_id=p_player and groups>0;
$$;
revoke all on function public.ff_match_extra_breakdown(text,text) from public,anon,authenticated;

create function public.ff_validate_match_extras(p_match text) returns void
language plpgsql stable set search_path=pg_catalog,public as $$
begin
  if exists (select 1 from public.match_player_statistics s where s.match_id=p_match
      and not exists (select 1 from public.ff_match_participants(p_match) p where p.player_id=s.player_id)) then
    raise exception 'Update statistics and bonus selections: a selected player did not participate';
  end if;
  if (select count(*) from public.match_player_statistics where match_id=p_match and bonus_rank is not null) not in (0,3) then
    raise exception 'Choose all three bonus players, or leave all three awards empty';
  end if;
end $$;
revoke all on function public.ff_validate_match_extras(text) from public,anon,authenticated;

create or replace function public.submit_match(p_match text, p_version int, p_home_score int, p_away_score int)
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
  perform public.ff_validate_match_extras(p_match);
  perform public.ff_submit_validated_match(p_match);
  update real_matches set home_score=p_home_score,away_score=p_away_score where id=p_match returning * into strict m;
  update match_approvals set snapshot=jsonb_build_object('homeScore',p_home_score,'awayScore',p_away_score)
    where match_id=p_match and action='submitted' and version=m.version;
  return to_jsonb(m);
end;
$$;
revoke all on function public.submit_match(text,int,int,int) from public, anon, authenticated;
grant execute on function public.submit_match(text,int,int,int) to authenticated;


-- Existing scoring pathway: add match extras before calculating manager totals.
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

  perform public.ff_validate_match_extras(p_match);

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
         v_match.version, coalesce(s.total,0)+coalesce(rc.total,0)
           +(select coalesce(sum((e->>'points')::numeric),0) from jsonb_array_elements(extra.lines) e),
         coalesce(s.breakdown,'[]'::jsonb)||coalesce(rc.lines,'[]'::jsonb)||extra.lines, now()
    from lines l left join scored s on s.player_id=l.player_id
    left join result_components rc on rc.player_id=l.player_id
    cross join lateral (select public.ff_match_extra_breakdown(p_match,l.player_id) as lines) extra
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


-- Use the existing frozen ledger correction pathway for finalized statistics.
create function public.ff_correct_match_result(p_match text, p_version int, p_home_score int, p_away_score int, p_reason text, p_refresh_stats boolean)
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
  if not p_refresh_stats and p_version in (m.version,m.version-1) and (m.home_score,m.away_score)=(p_home_score,p_away_score) then
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
        where e.value->>'category' not in ('clean_sheet','win','draw')
          and (not p_refresh_stats or e.value->>'category' not in ('goalkeeper_saves','defensive_contributions','match_bonus'))), '[]'::jsonb)
      || public.ff_result_breakdown(case when b.is_home then p_home_score else p_away_score end,
        case when b.is_home then p_away_score else p_home_score end,b.started,b.clean,b.win,b.draw)
      || case when p_refresh_stats then public.ff_match_extra_breakdown(p_match,p.player_id) else '[]'::jsonb end as breakdown
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
      jsonb_build_object('previousHomeScore',m.home_score,'previousAwayScore',m.away_score,'homeScore',p_home_score,'awayScore',p_away_score) || case when p_refresh_stats then '{"statisticsCorrected":true}'::jsonb else '{}'::jsonb end);
  receipt.result := jsonb_set(receipt.result,'{version}',to_jsonb(revision));
  update match_scoring_receipts set result=receipt.result,match_version=revision where match_id=p_match;
  return receipt.result;
end;
$$;
revoke all on function public.ff_correct_match_result(text,int,int,int,text,boolean) from public,anon,authenticated;
create or replace function public.correct_match_result(p_match text,p_version int,p_home_score int,p_away_score int,p_reason text)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$
  select public.ff_correct_match_result(p_match,p_version,p_home_score,p_away_score,p_reason,false);
$$;

-- Replace the match's statistics and its ordered awards in one transaction.
-- On approved matches only stat corrections are allowed; awards stay frozen.
create function public.save_match_statistics(p_match text,p_version int,p_stats jsonb,p_bonus text[],p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare m real_matches%rowtype; awards text[]; positions jsonb; result jsonb;
begin
  select * into m from real_matches where id=p_match for update;
  if auth.uid() is null or not found or not (public.is_leader(m.league_id) or public.is_match_organizer(p_match)) then
    raise insufficient_privilege;
  end if;
  if p_version is distinct from m.version then raise serialization_failure; end if;
  if m.kick_off>clock_timestamp() or m.status not in ('draft','rejected','approved') then
    raise exception 'Statistics and awards can be entered after kickoff and are locked during review';
  end if;
  if m.status='approved' and p_bonus is not null then raise exception 'Finalized bonus awards cannot change'; end if;
  if jsonb_typeof(p_stats) is distinct from 'array' or jsonb_array_length(p_stats)>40 then
    raise invalid_parameter_value using message='Enter valid match statistics';
  end if;
  select coalesce(jsonb_object_agg(player_id,position),'{}') into positions from public.match_player_statistics where match_id=p_match;
  if exists (select 1 from jsonb_to_recordset(p_stats) r("playerId" text,saves int,"defensiveContributions" int)
    left join public.ff_match_participants(p_match) p on p.player_id=r."playerId"
    where p.player_id is null or r.saves is null or r."defensiveContributions" is null
      or r.saves not between 0 and 999 or r."defensiveContributions" not between 0 and 999
      or (r.saves<>0 and coalesce(positions->>p.player_id,p.position)<>'GK')) or
    (select count(distinct value->>'playerId') from jsonb_array_elements(p_stats))<>jsonb_array_length(p_stats) then
    raise invalid_parameter_value using message='Use distinct participating players and valid position-specific totals';
  end if;
  awards := p_bonus;
  if awards is null then
    select array_agg(player_id order by bonus_rank) into awards from public.match_player_statistics
      where match_id=p_match and bonus_rank is not null;
  end if;
  if coalesce(cardinality(awards),0) not in (0,3) or exists (
    select 1 from unnest(awards) a(id) left join public.ff_match_participants(p_match) p on p.player_id=a.id
      where p.player_id is null
  ) or (select count(distinct a) from unnest(awards) a) <> coalesce(cardinality(awards),0) then
    raise invalid_parameter_value using message='Select three distinct players who participated, or clear all awards';
  end if;
  delete from public.match_player_statistics where match_id=p_match;
  insert into public.match_player_statistics(match_id,player_id,position,saves,defensive_contributions,bonus_rank)
    select p_match,p.player_id,coalesce(positions->>p.player_id,p.position),coalesce(r.saves,0),coalesce(r."defensiveContributions",0),a.rank
    from public.ff_match_participants(p_match) p
    left join jsonb_to_recordset(p_stats) r("playerId" text,saves int,"defensiveContributions" int) on r."playerId"=p.player_id
    left join unnest(awards) with ordinality a(id,rank) on a.id=p.player_id
    where r.saves<>0 or r."defensiveContributions"<>0 or a.rank is not null;
  if m.status='approved' then
    result := public.ff_correct_match_result(p_match,p_version,m.home_score,m.away_score,p_reason,true);
  else
    update public.real_matches set version=version+1,updated_at=now() where id=p_match returning * into m;
  end if;
  return jsonb_build_object('matchId',p_match,'version',coalesce((result->>'version')::int,m.version));
end $$;
revoke all on function public.save_match_statistics(text,int,jsonb,text[],text) from public,anon,authenticated;
grant execute on function public.save_match_statistics(text,int,jsonb,text[],text) to authenticated;
commit;
