begin;

-- Live points are a read-time projection of committed events and statistics.
-- Approval still owns the official ledgers, receipts, snapshots and standings.
create function public.ff_live_player_points(p_league text, p_match text default null, p_players text[] default null)
returns table(match_id text, player_id text, points numeric, breakdown jsonb, started boolean)
language sql stable security definer set search_path=pg_catalog,public as $$
  with matches as materialized (
    select m.id from real_matches m where m.league_id=p_league and m.status<>'approved'
      and (p_match is null or m.id=p_match) and public.is_member(p_league)
      and exists (select 1 from scoring_rules r where r.league_id=p_league)
      and not exists (select 1 from scoring_rules r where r.league_id=p_league and r.status<>'approved')
  ), participants as materialized (
    select l.match_id,l.player_id,l.slot='starter' as started,p.position
    from matches m join match_lineups l on l.match_id=m.id and l.league_id=p_league
    join players p on p.id=l.player_id and p.league_id=p_league
    where l.slot='starter' or exists (select 1 from match_substitutions s
      where s.match_id=m.id and s.player_on_id=l.player_id and s.team_id=l.team_id)
  ), credits as (
    select e.match_id,e.player_id,e.event_type::text as event_type
    from match_events e join participants p using(match_id,player_id)
    where e.event_type in ('goal','assist','own_goal','yellow_card','red_card','penalty_saved','penalty_missed')
    union all
    select e.match_id,e.assist_player_id,'assist'
    from match_events e join participants p using(match_id,player_id)
    where e.event_type='goal' and e.assist_player_id is not null
  ), counts as (
    select c.match_id,c.player_id,c.event_type,count(*) as n from credits c group by c.match_id,c.player_id,c.event_type
  ), event_lines as (
    select c.match_id,c.player_id,jsonb_agg(jsonb_build_object('category',c.event_type,
      'count',c.n,'pointsPer',r.points,'points',r.points*c.n) order by c.event_type) as lines
    from counts c join participants p using(match_id,player_id)
    join scoring_rules r on r.league_id=p_league and r.position=p.position and r.event_type::text=c.event_type
    where r.points<>0 group by c.match_id,c.player_id
  ), breakdowns as (
    select p.match_id,p.player_id,p.started,coalesce(e.lines,'[]') || public.ff_match_extra_breakdown(p.match_id,p.player_id) as lines
    from participants p left join event_lines e using(match_id,player_id)
    where p_players is null or p.player_id=any(p_players)
  )
  select b.match_id,b.player_id,(select sum((l->>'points')::numeric) from jsonb_array_elements(b.lines) l),b.lines,b.started
  from breakdowns b where jsonb_array_length(b.lines)>0;
$$;

create function public.ff_live_manager_points(p_league text, p_match text default null)
returns table(profile_id text, match_id text, points numeric, breakdown jsonb, computed_at timestamptz)
language sql stable security definer set search_path=pg_catalog,public as $$
  with live as materialized (select * from public.ff_live_player_points(p_league,p_match)),
  matches as (
    select m.id,m.kick_off from real_matches m where m.id in (select l.match_id from live l)
  ), starters as (
    -- Same input precedence as official scoring: one fixture override, otherwise the default.
    select m.id as match_id,d.profile_id,e.id as player_id,d.lineup->>'captainId' as captain,d.lineup->>'viceId' as vice
    from matches m join fantasy_match_lineup_drafts d on d.match_id=m.id
    join league_members lm on lm.league_id=p_league and lm.profile_id=d.profile_id
    cross join lateral jsonb_to_recordset(d.lineup->'players') e(id text,slot text) where e.slot='starter'
    union all
    select m.id,s.profile_id,sp.player_id,s.captain_id,s.vice_captain_id
    from matches m join fantasy_squads s on s.league_id=p_league
    join league_members lm on lm.league_id=p_league and lm.profile_id=s.profile_id
    join fantasy_squad_players sp on sp.squad_id=s.id and sp.slot='starter'
    where not exists (select 1 from fantasy_match_lineup_drafts d where d.match_id=m.id and d.profile_id=s.profile_id)
  ), captaincy as (
    select s.profile_id,s.match_id,
      coalesce(max(s.player_id) filter (where s.player_id=s.captain),max(s.player_id) filter (where s.player_id=s.vice and l.vice_policy='auto_captain')) as captain
    from starters s join leagues l on l.id=p_league
    where exists (select 1 from match_lineups r where r.match_id=s.match_id and r.player_id=s.player_id and r.slot='starter')
       or exists (select 1 from match_substitutions r where r.match_id=s.match_id and r.player_on_id=s.player_id)
    group by s.profile_id,s.match_id
  ), lines as (
    select s.profile_id,s.match_id,s.player_id,l.points as base,c.captain,
      case when s.player_id=c.captain then 2 else 1 end as multiplier
    from starters s join live l using(match_id,player_id) left join captaincy c using(profile_id,match_id)
  )
  select l.profile_id,l.match_id,sum(l.base*l.multiplier),jsonb_build_object('captainId',l.captain,
    'lines',jsonb_agg(jsonb_build_object('playerId',l.player_id,'base',l.base,'multiplier',l.multiplier,
      'points',l.base*l.multiplier) order by l.player_id)),m.kick_off
  from lines l join matches m on m.id=l.match_id group by l.profile_id,l.match_id,l.captain,m.kick_off;
$$;

create function public.ff_display_player_points(p_league text, p_match text default null, p_players text[] default null, p_live_only boolean default false)
returns table(match_id text, player_id text, title text, kick_off timestamptz, status text, points numeric,
  breakdown jsonb, started boolean, computed_at timestamptz, provisional boolean)
language sql stable security definer set search_path=pg_catalog,public as $$
  select m.id,p.player_id,m.title,m.kick_off,m.status::text,p.points,p.breakdown,coalesce(l.slot='starter',false),p.computed_at,false
  from player_match_points p join real_matches m on m.id=p.match_id and m.league_id=p.league_id and m.version=p.match_version
  left join match_scoring_lineups l on l.match_id=m.id and l.player_id=p.player_id
  where not p_live_only and p.league_id=p_league and m.status='approved' and public.is_member(p_league)
    and (p_match is null or m.id=p_match) and (p_players is null or p.player_id=any(p_players))
  union all
  select m.id,p.player_id,m.title,m.kick_off,m.status::text,p.points,p.breakdown,p.started,m.kick_off,true
  from public.ff_live_player_points(p_league,p_match,p_players) p join real_matches m on m.id=p.match_id;
$$;

create function public.ff_latest_display_player_points(p_league text,p_players text[],p_match text default null)
returns table(player_id text,match_id text,title text,kick_off timestamptz,points numeric,captain_points numeric,provisional boolean)
language sql stable security definer set search_path=pg_catalog,public as $$
  with latest as materialized (
    select distinct on(p.player_id) p.* from public.ff_display_player_points(p_league,p_match,p_players) p
    order by p.player_id,p.kick_off desc,p.match_id desc
  ), managers as (
    select m.match_id,m.breakdown from public.ff_live_manager_points(p_league,p_match) m where m.profile_id=auth.uid()::text
    union all
    select m.match_id,m.breakdown from manager_points m join real_matches r on r.id=m.match_id and r.version=m.match_version
    where m.league_id=p_league and m.profile_id=auth.uid()::text and r.status='approved' and (p_match is null or m.match_id=p_match)
  )
  select p.player_id,p.match_id,p.title,p.kick_off,p.points,c.points,p.provisional
  from latest p left join managers m on m.match_id=p.match_id
  left join lateral (
    select e.points from jsonb_to_recordset(case when jsonb_typeof(m.breakdown->'lines')='array'
      then m.breakdown->'lines' else '[]'::jsonb end) e("playerId" text,multiplier numeric,points numeric)
    where e."playerId"=p.player_id and e.multiplier=2 limit 1
  ) c on true;
$$;

create function public.ff_display_standings(p_league text)
returns table(profile_id text,rank int,prev_rank int,total_points numeric,matches_played int,form jsonb,profiles jsonb,
  provisional boolean, live_points numeric)
language sql stable security definer set search_path=pg_catalog,public as $$
  with live as materialized (
    select p.profile_id,sum(p.points) as total from public.ff_live_manager_points(p_league) p group by p.profile_id
  ), standings as (
    select s.profile_id,coalesce(o.total_points,0)+coalesce(l.total,0) as total,
      coalesce(o.matches_played,0) as played,o.rank as official_rank,o.prev_rank,coalesce(o.form,'[]') as form,l.total as live
    from league_members s left join league_standings o using(league_id,profile_id)
    left join live l on l.profile_id=s.profile_id where s.league_id=p_league and public.is_member(p_league)
      and (o.profile_id is not null or exists(select 1 from live))
  )
  select s.profile_id,(row_number() over(order by s.total desc,s.played asc,s.profile_id))::int,
    case when exists(select 1 from live) then s.official_rank else s.prev_rank end,s.total,s.played,s.form,
    jsonb_build_object('display_name',p.display_name,'username',p.username,'avatar_url',p.avatar_url),
    exists(select 1 from live),coalesce(s.live,0)
  from standings s join profiles p on p.id=s.profile_id order by 2;
$$;

create function public.ff_my_live_match_points(p_league text)
returns table("matchId" text,title text,"kickOff" timestamptz,points numeric)
language sql stable security definer set search_path=pg_catalog,public as $$
  select m.match_id,r.title,r.kick_off,m.points
  from public.ff_live_manager_points(p_league) m join real_matches r on r.id=m.match_id
  where m.profile_id=auth.uid()::text order by r.kick_off desc,r.id desc;
$$;

-- Account/league summaries can use live ranks without making authentication
-- or session recovery depend on computing standings.
create function public.ff_my_display_standings()
returns table(league_id text,rank int,total_points numeric,matches_played int,provisional boolean)
language sql stable security definer set search_path=pg_catalog,public as $$
  select m.league_id,s.rank,s.total_points,s.matches_played,s.provisional
  from league_members m cross join lateral public.ff_display_standings(m.league_id) s
  where m.profile_id=auth.uid()::text and s.profile_id=m.profile_id;
$$;

revoke all on function public.ff_my_display_standings(),public.ff_my_live_match_points(text),public.ff_live_player_points(text,text,text[]),public.ff_live_manager_points(text,text),
  public.ff_display_player_points(text,text,text[],boolean),public.ff_latest_display_player_points(text,text[],text),
  public.ff_display_standings(text) from public,anon,authenticated;
grant execute on function public.ff_my_display_standings(),public.ff_my_live_match_points(text),public.ff_display_player_points(text,text,text[],boolean),
  public.ff_latest_display_player_points(text,text[],text),public.ff_display_standings(text) to authenticated;
commit;
