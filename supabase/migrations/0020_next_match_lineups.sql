begin;

-- Forward only: an old score ledger is not an original lineup. The cutoff
-- also excludes matches already underway when this migration was installed.
create table public.fantasy_lineup_rollout (
  singleton boolean primary key default true check (singleton),
  enabled_at timestamptz not null
);
insert into public.fantasy_lineup_rollout(enabled_at) values (clock_timestamp());

create table public.fantasy_match_lineup_drafts (
  match_id text not null references public.real_matches(id) on delete cascade,
  profile_id text not null references public.profiles(id) on delete cascade,
  lineup jsonb not null check (jsonb_typeof(lineup) = 'object'),
  updated_at timestamptz not null,
  primary key (match_id, profile_id)
);
create table public.fantasy_match_lineup_history (
  match_id text not null references public.real_matches(id) on delete cascade,
  profile_id text not null references public.profiles(id) on delete cascade,
  lineup jsonb not null check (jsonb_typeof(lineup) = 'object'),
  primary key (match_id, profile_id)
);
create index fantasy_match_lineup_history_profile_idx on public.fantasy_match_lineup_history(profile_id,match_id);
alter table public.fantasy_lineup_rollout enable row level security;
alter table public.fantasy_match_lineup_drafts enable row level security;
alter table public.fantasy_match_lineup_history enable row level security;
revoke all on public.fantasy_lineup_rollout, public.fantasy_match_lineup_drafts, public.fantasy_match_lineup_history from public,anon,authenticated;

create function public.ff_previous_fantasy_lineup(p_league text,p_actor text,p_before timestamptz)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('matchId',m.id,'title',m.title,'kickOff',m.kick_off,'lineup',h.lineup)
  from public.fantasy_match_lineup_history h join public.real_matches m on m.id=h.match_id
  where m.league_id=p_league and h.profile_id=p_actor and m.status='approved' and m.kick_off < p_before
  order by m.kick_off desc,m.id desc limit 1
$$;
revoke all on function public.ff_previous_fantasy_lineup(text,text,timestamptz) from public,anon,authenticated;

create function public.ff_next_match_lineup(p_league text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor text := auth.uid()::text; t timestamptz := clock_timestamp(); m real_matches%rowtype;
  previous jsonb; draft fantasy_match_lineup_drafts%rowtype;
begin
  if actor is null or not public.is_member(p_league) then raise insufficient_privilege; end if;
  select * into m from real_matches where league_id=p_league and status <> 'approved'
    and kick_off >= (select enabled_at from fantasy_lineup_rollout) order by kick_off,id limit 1;
  previous := public.ff_previous_fantasy_lineup(p_league,actor,least(t,coalesce(m.kick_off,t)));
  if previous is null then return jsonb_build_object('previous',null,'match',null,'saved',null,'serverNow',t); end if;
  select * into draft from fantasy_match_lineup_drafts where match_id=m.id and profile_id=actor;
  return jsonb_build_object('previous',previous,'serverNow',t,
    'match',case when m.id is not null then jsonb_build_object('id',m.id,'title',m.title,'kickOff',m.kick_off,
      'locked',m.kick_off<=t) end,
    'saved',case when draft.match_id is not null then jsonb_build_object('revision',draft.updated_at,'lineup',draft.lineup) end);
end $$;
revoke all on function public.ff_next_match_lineup(text) from public,anon,authenticated;
grant execute on function public.ff_next_match_lineup(text) to authenticated;

create function public.ff_save_next_match_lineup(p_league text,p_match text,p_formation text,p_captain text,p_vice text,
  p_expected_updated_at timestamptz,p_entries jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor text := auth.uid()::text; m real_matches%rowtype; l leagues%rowtype;
  stored fantasy_match_lineup_drafts%rowtype; entries jsonb; shape int[]; source jsonb;
begin
  if actor is null or not public.is_member(p_league) then raise insufficient_privilege; end if;
  -- Lock in the same order as match approval and league-wide squad saves.
  select * into m from real_matches where id=p_match and league_id=p_league for update;
  if not found then raise insufficient_privilege; end if;
  perform pg_advisory_xact_lock(hashtextextended('ff-deadline:'||p_league,0));
  perform 1 from league_members where league_id=p_league and profile_id=actor for share;
  if not found then raise insufficient_privilege; end if;
  if m.kick_off <= clock_timestamp() or m.status='approved' or m.id is distinct from (
    select id from real_matches where league_id=p_league and status <> 'approved'
      and kick_off >= (select enabled_at from fantasy_lineup_rollout) order by kick_off,id limit 1
  ) then raise exception 'This lineup is locked or the next match has changed. Reload before saving.' using errcode='PT409'; end if;
  source := public.ff_previous_fantasy_lineup(p_league,actor,least(m.kick_off,clock_timestamp()));
  if source is null then raise exception 'No previous saved starting lineup' using errcode='PT409'; end if;
  select * into stored from fantasy_match_lineup_drafts where match_id=m.id and profile_id=actor;
  if stored.updated_at is distinct from p_expected_updated_at then
    raise exception 'This lineup changed since it was opened. Reload before saving.' using errcode='PT409';
  end if;
  select * into strict l from leagues where id=p_league for share;
  if p_formation is null or p_formation !~ '^[0-6]-[0-6]-[0-6]$' then raise exception 'Invalid formation' using errcode='22023'; end if;
  shape := string_to_array(p_formation,'-')::int[];
  if shape[1]+shape[2]+shape[3] <> l.starters-1 or jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'Invalid lineup for this league' using errcode='22023'; end if;
  if jsonb_array_length(p_entries) > l.squad_size or exists (
    select 1 from jsonb_to_recordset(p_entries) e(id text,slot text,"order" int)
    where e.id is null or e.slot is null or e.slot not in ('starter','sub','reserve') or e."order" is null or e."order" < 0
  ) or jsonb_array_length(p_entries) <> (select count(distinct id) from jsonb_to_recordset(p_entries) e(id text)) then
    raise exception 'Invalid or duplicate lineup entries' using errcode='22023'; end if;
  with selected as materialized (
    select p.id,p.full_name as name,p.position,e.slot,e."order"
    from jsonb_to_recordset(p_entries) e(id text,slot text,"order" int)
    join players p on p.id=e.id and p.league_id=p_league and p.status='active' order by p.id for share of p
  ) select coalesce(jsonb_agg(to_jsonb(selected) order by slot,"order",id),'[]') into entries from selected;
  if jsonb_array_length(entries) <> jsonb_array_length(p_entries) or not exists (
    select 1 from jsonb_to_recordset(entries) e(id text,position text,slot text,"order" int)
    having count(*) filter(where slot='starter')=l.starters
      and count(*) filter(where slot='starter' and position='GK')=1
      and count(*) filter(where slot='starter' and position='DEF')=shape[1]
      and count(*) filter(where slot='starter' and position='MID')=shape[2]
      and count(*) filter(where slot='starter' and position='FWD')=shape[3]
      and count(*) filter(where slot='sub' and position='GK')<=least(1,l.subs_count)
      and count(*) filter(where slot='sub' and position<>'GK')<=greatest(0,l.subs_count-1)
      and count(*) filter(where slot='reserve')<=l.squad_size-l.starters-l.subs_count
      and (p_captain is null or count(*) filter(where slot='starter' and id=p_captain)=1)
      and (p_vice is null or count(*) filter(where slot='starter' and id=p_vice)=1)
  ) or (p_captain is not null and p_captain=p_vice) or exists (
    select 1 from (
      select e."order",case when e.position='GK' then 0 else row_number() over(partition by (e.position='GK') order by e."order",e.id) end as priority
      from jsonb_to_recordset(entries) e(id text,position text,slot text,"order" int) where e.slot='sub'
    ) b where b."order"<>b.priority
  ) then raise exception 'Selected players, captaincy or bench order do not fit this lineup' using errcode='22023'; end if;
  insert into fantasy_match_lineup_drafts(match_id,profile_id,lineup,updated_at)
    values(m.id,actor,jsonb_build_object('formation',p_formation,'captainId',p_captain,'viceId',p_vice,'players',entries),clock_timestamp())
    on conflict(match_id,profile_id) do update set lineup=excluded.lineup,updated_at=excluded.updated_at returning * into strict stored;
  if clock_timestamp() >= m.kick_off then raise exception 'Kickoff has passed. This lineup is locked.' using errcode='PT409'; end if;
  return jsonb_build_object('revision',stored.updated_at,'lineup',stored.lineup);
end $$;
revoke all on function public.ff_save_next_match_lineup(text,text,text,text,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.ff_save_next_match_lineup(text,text,text,text,text,timestamptz,jsonb) to authenticated;

-- Keep the existing scoring formulas, captain fallback, autosubs, receipts,
-- and correction path. Only replace the selection of fantasy input lineups.
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
  if v_match.home_score is not null then
    perform public.ff_apply_match_bonus(p_match,v_match.league_id,v_match.version);
  end if;

  -- Manager points mirror computeManagerPoints(): the captain doubles only
  -- if they participated; otherwise the vice-captain may inherit the double.
  with appearance as (
    select player_id from public.match_lineups
     where match_id = p_match and slot = 'starter'
    union
    select player_on_id as player_id from public.match_substitutions
     where match_id = p_match
  ), overrides as materialized (
    select d.profile_id,d.lineup from public.fantasy_match_lineup_drafts d
    join public.league_members lm on lm.league_id=v_match.league_id and lm.profile_id=d.profile_id
    where d.match_id=p_match
  ), inputs as materialized (
    select profile_id,lineup from overrides
    union all
    select s.profile_id,jsonb_build_object('formation',s.formation,'captainId',s.captain_id,'viceId',s.vice_captain_id,
      'players',jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name,'position',p.position,'slot',sp.slot,'order',sp."order") order by sp.slot,sp."order",p.id))
    from public.fantasy_squads s
    join public.fantasy_squad_players sp on sp.squad_id=s.id
    join public.players p on p.id=sp.player_id and p.league_id=v_match.league_id
    where s.league_id=v_match.league_id and not exists(select 1 from overrides d where d.profile_id=s.profile_id)
    group by s.id
  ), captured as (
    insert into public.fantasy_match_lineup_history(match_id,profile_id,lineup)
    select p_match,i.profile_id,i.lineup from inputs i
    where p_finalize and v_match.kick_off <= clock_timestamp()
      and v_match.kick_off >= (select enabled_at from public.fantasy_lineup_rollout)
      and exists (
        select 1 from jsonb_to_recordset(i.lineup->'players') e(slot text,position text) where e.slot='starter'
        having count(*)=v_league.starters and count(*) filter(where position='GK')=1
          and concat_ws('-',count(*) filter(where position='DEF'),count(*) filter(where position='MID'),count(*) filter(where position='FWD'))=i.lineup->>'formation'
      )
    on conflict(match_id,profile_id) do nothing
    returning match_id
  ), squads as materialized (
    select i.profile_id,i.lineup->>'captainId' as captain_id,i.lineup->>'viceId' as vice_captain_id,i.lineup->>'formation' as formation,
      jsonb_agg(e.data order by e.priority,e.id) filter (where e.slot='starter') as starters,
      jsonb_agg(e.data order by e.priority,e.id) filter (where e.slot='sub') as bench
    from inputs i
    join lateral (
      select p.id,p.slot,p."order" as priority,
        jsonb_build_object('id',p.id,'name',p.name,'position',p.position,'priority',p."order",'played',ap.player_id is not null) as data
      from jsonb_to_recordset(i.lineup->'players') p(id text,name text,position text,slot text,"order" int)
      left join appearance ap on ap.player_id=p.id where p.slot in ('starter','sub')
    ) e on true
    group by i.profile_id,i.lineup
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


commit;
