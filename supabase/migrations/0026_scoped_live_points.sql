begin;

-- Caller-scoped live manager points.
--
-- `ff_live_manager_points` fans the live projection out over every manager in
-- the league. The dashboard, the squad screen and the player-performance
-- screen only ever read the caller's own live row, so those paths used to
-- compute every manager's live points and then throw away all but one.
--
-- This migration keeps a single implementation of the fan-out and adds an
-- optional profile scope to it. `ff_live_manager_points` (every manager, used
-- by the standings table) and the caller-scoped lookups are now thin wrappers
-- over that one implementation.
--
-- The live projection itself is unchanged: the same matches, the same
-- participants, the same scoring rules and the same captain/vice policy.
-- Nothing here writes rows or changes official points, approval or lineups.

create function public.ff_live_manager_points_for(p_league text, p_match text, p_profile text)
returns table(profile_id text, match_id text, points numeric, breakdown jsonb, computed_at timestamptz)
language sql stable security definer set search_path=pg_catalog,public as $$
  with live as materialized (select * from public.ff_live_player_points(p_league,p_match)),
  matches as (
    select m.id,m.kick_off from real_matches m where m.id in (select l.match_id from live l)
  ),
  starters as (
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
  ),
  -- A null scope means every manager, which is what the standings table needs.
  scoped as (
    select s.* from starters s where p_profile is null or s.profile_id=p_profile
  ),
  captaincy as (
    select s.profile_id,s.match_id,
      coalesce(max(s.player_id) filter (where s.player_id=s.captain),max(s.player_id) filter (where s.player_id=s.vice and l.vice_policy='auto_captain')) as captain
    from scoped s join leagues l on l.id=p_league
    where exists (select 1 from match_lineups r where r.match_id=s.match_id and r.player_id=s.player_id and r.slot='starter')
       or exists (select 1 from match_substitutions r where r.match_id=s.match_id and r.player_on_id=s.player_id)
    group by s.profile_id,s.match_id
  ),
  lines as (
    select s.profile_id,s.match_id,s.player_id,l.points as base,c.captain,
      case when s.player_id=c.captain then 2 else 1 end as multiplier
    from scoped s join live l using(match_id,player_id) left join captaincy c using(profile_id,match_id)
  )
  select l.profile_id,l.match_id,sum(l.base*l.multiplier),jsonb_build_object('captainId',l.captain,
    'lines',jsonb_agg(jsonb_build_object('playerId',l.player_id,'base',l.base,'multiplier',l.multiplier,
      'points',l.base*l.multiplier) order by l.player_id)),m.kick_off
  from lines l join matches m on m.id=l.match_id group by l.profile_id,l.match_id,l.captain,m.kick_off;
$$;

-- Every manager, for the standings table. Same result as before.
create or replace function public.ff_live_manager_points(p_league text, p_match text default null)
returns table(profile_id text, match_id text, points numeric, breakdown jsonb, computed_at timestamptz)
language sql stable security definer set search_path=pg_catalog,public as $$
  select * from public.ff_live_manager_points_for(p_league,p_match,null);
$$;

-- Only the caller's own live manager points. An unauthenticated caller has no
-- uid, so it matches no manager and sees nothing.
create or replace function public.ff_my_live_match_points(p_league text)
returns table("matchId" text,title text,"kickOff" timestamptz,points numeric)
language sql stable security definer set search_path=pg_catalog,public as $$
  select m.match_id,r.title,r.kick_off,m.points
  from public.ff_live_manager_points_for(p_league,null,coalesce(auth.uid()::text,'')) m
  join real_matches r on r.id=m.match_id
  order by r.kick_off desc,r.id desc;
$$;

-- The captain breakdown of the caller's own live matches, used to show the
-- captain's contribution next to the player's latest points.
create or replace function public.ff_latest_display_player_points(p_league text,p_players text[],p_match text default null)
returns table(player_id text, match_id text, title text, kick_off timestamptz, points numeric, captain_points numeric, provisional boolean)
language sql stable security definer set search_path=pg_catalog,public as $$
  with latest as materialized (
    select distinct on(p.player_id) p.* from public.ff_display_player_points(p_league,p_match,p_players) p
    order by p.player_id,p.kick_off desc,p.match_id desc
  ), managers as (
    select m.match_id,m.breakdown from public.ff_live_manager_points_for(p_league,p_match,coalesce(auth.uid()::text,'')) m
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

-- The scope helper and the all-managers projection stay internal to the
-- database; only the caller-scoped lookup remains callable by the app.
revoke all on function public.ff_live_manager_points_for(text,text,text),
  public.ff_live_manager_points(text,text) from public,anon,authenticated;
revoke all on function public.ff_my_live_match_points(text),
  public.ff_latest_display_player_points(text,text[],text) from public,anon;
grant execute on function public.ff_my_live_match_points(text),
  public.ff_latest_display_player_points(text,text[],text) to authenticated;

-- PostgREST caches the database schema. Reload it so the new function is
-- visible to the API.
notify pgrst, 'reload schema';

commit;
