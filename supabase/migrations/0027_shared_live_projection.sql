begin;

-- One live projection per request.
--
-- `ff_latest_display_player_points` needs two things from the live
-- projection: the player's own live points, and the manager breakdown that
-- carries the captain's contribution. Both used to compute the projection
-- separately, so every request built it twice.
--
-- The projection is now built once and handed to the two consumers. The
-- manager fan-out keeps a single implementation and the approved half of the
-- display rows is shared with `ff_display_player_points`, so the captain and
-- vice-captain rules are not written down twice.
--
-- Nothing here writes rows. The projection produces the same matches, the
-- same participants, the same scoring rules and the same captain/vice policy
-- as before, and the caller-scoped lookups still answer only for the caller.

-- The approved half of the display rows.
create function public.ff_approved_display_player_points(p_league text, p_match text, p_players text[])
returns table(match_id text, player_id text, title text, kick_off timestamptz, status text, points numeric,
  breakdown jsonb, started boolean, computed_at timestamptz, provisional boolean)
language sql stable security definer set search_path=pg_catalog,public as $$
  select m.id,p.player_id,m.title,m.kick_off,m.status::text,p.points,p.breakdown,
    coalesce(l.slot='starter',false),p.computed_at,false
  from player_match_points p join real_matches m on m.id=p.match_id and m.league_id=p.league_id and m.version=p.match_version
  left join match_scoring_lineups l on l.match_id=m.id and l.player_id=p.player_id
  where p.league_id=p_league and m.status='approved' and public.is_member(p_league)
    and (p_match is null or m.id=p_match) and (p_players is null or p.player_id=any(p_players));
$$;

-- The live half of the display rows, over an already computed projection.
create function public.ff_live_display_player_points(p_live jsonb, p_players text[])
returns table(match_id text, player_id text, title text, kick_off timestamptz, status text, points numeric,
  breakdown jsonb, started boolean, computed_at timestamptz, provisional boolean)
language sql stable security definer set search_path=pg_catalog,public as $$
  select m.id,p.player_id,m.title,m.kick_off,m.status::text,p.points,p.breakdown,p.started,m.kick_off,true
  from jsonb_to_recordset(p_live) p(match_id text,player_id text,points numeric,breakdown jsonb,started boolean)
  join real_matches m on m.id=p.match_id
  where p_players is null or p.player_id=any(p_players);
$$;

-- The manager fan-out, over an already computed projection.
create function public.ff_live_manager_points_from_live(p_live jsonb, p_league text, p_profile text)
returns table(profile_id text, match_id text, points numeric, breakdown jsonb, computed_at timestamptz)
language sql stable security definer set search_path=pg_catalog,public as $$
  with live as materialized (
    select l.match_id,l.player_id,l.points
    from jsonb_to_recordset(p_live) l(match_id text,player_id text,points numeric)
  ),
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

-- The caller-scoped live manager points, over a projection built here.
create or replace function public.ff_live_manager_points_for(p_league text, p_match text, p_profile text)
returns table(profile_id text, match_id text, points numeric, breakdown jsonb, computed_at timestamptz)
language sql stable security definer set search_path=pg_catalog,public as $$
  select * from public.ff_live_manager_points_from_live(
    (select jsonb_agg(to_jsonb(l)) from public.ff_live_player_points(p_league,p_match) l), p_league, p_profile);
$$;

-- The display rows of a league. The approved half is shared with the latest
-- lookup; the live half keeps reading the projection directly, so a request
-- for a handful of players still reads only those players and the row order
-- stays the same as before.
create or replace function public.ff_display_player_points(p_league text, p_match text default null, p_players text[] default null, p_live_only boolean default false)
returns table(match_id text, player_id text, title text, kick_off timestamptz, status text, points numeric,
  breakdown jsonb, started boolean, computed_at timestamptz, provisional boolean)
language sql stable security definer set search_path=pg_catalog,public as $$
  select a.* from public.ff_approved_display_player_points(p_league,p_match,p_players) a where not p_live_only
  union all
  select m.id,p.player_id,m.title,m.kick_off,m.status::text,p.points,p.breakdown,p.started,m.kick_off,true
  from public.ff_live_player_points(p_league,p_match,p_players) p join real_matches m on m.id=p.match_id;
$$;

-- The latest points of the requested players, with the caller's own captain
-- contribution. The live projection is built once and shared by the player
-- rows and the manager breakdown.
create or replace function public.ff_latest_display_player_points(p_league text, p_players text[], p_match text default null)
returns table(player_id text, match_id text, title text, kick_off timestamptz, points numeric, captain_points numeric, provisional boolean)
language sql stable security definer set search_path=pg_catalog,public as $$
  with live as materialized (
    select jsonb_agg(to_jsonb(l)) as j from public.ff_live_player_points(p_league,p_match) l
  ),
  latest as materialized (
    select distinct on(p.player_id) p.* from (
      select a.* from public.ff_approved_display_player_points(p_league,p_match,p_players) a
      union all
      select l.* from public.ff_live_display_player_points((select j from live),p_players) l
    ) p
    order by p.player_id,p.kick_off desc,p.match_id desc
  ), managers as (
    select m.match_id,m.breakdown from public.ff_live_manager_points_from_live((select j from live),p_league,coalesce(auth.uid()::text,'')) m
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

-- The shared pieces stay inside the database.
revoke all on function public.ff_approved_display_player_points(text,text,text[]),
  public.ff_live_display_player_points(jsonb,text[]),
  public.ff_live_manager_points_from_live(jsonb,text,text),
  public.ff_live_manager_points_for(text,text,text),
  public.ff_live_manager_points(text,text) from public,anon,authenticated;

-- PostgREST caches the database schema. Reload it so the new functions are
-- visible to the API.
notify pgrst, 'reload schema';

commit;
