begin;

-- Round 2 read consolidation.
--
-- 1. `last_game_points` now returns the kickoff of the match it reports, so a
--    caller never has to look that match up again in a second round trip.
--    The function keeps its name, its arguments and its previous columns, so
--    an older app release keeps working against this database.
-- 2. `ff_my_latest_display_player_points` answers the same question as
--    `ff_latest_display_player_points` for the caller's own saved squad,
--    deriving the squad inside the function. The dashboard can then show the
--    latest points of the manager's players without first waiting for the
--    squad read to finish.
--
-- Nothing here writes rows, changes official points, approval or saved lineups.

drop function if exists public.last_game_points(text);

create function public.last_game_points(p_league text)
returns table ("matchId" text, title text, "kickOff" timestamptz, points numeric)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select m.id, m.title, m.kick_off, mp.points
  from (
    select id, title, version, kick_off from public.real_matches
    where league_id = p_league and status = 'approved' and public.is_member(p_league)
    order by kick_off desc, id desc limit 1
  ) m
  left join public.manager_points mp on mp.match_id = m.id and mp.league_id = p_league
    and mp.profile_id = auth.uid()::text and mp.match_version = m.version;
$$;
revoke all on function public.last_game_points(text) from public, anon, authenticated;
grant execute on function public.last_game_points(text) to authenticated;

create function public.ff_my_latest_display_player_points(p_league text)
returns table(player_id text, match_id text, title text, kick_off timestamptz, points numeric,
  captain_points numeric, provisional boolean)
language sql stable security definer set search_path = pg_catalog, public as $$
  select l.player_id, l.match_id, l.title, l.kick_off, l.points, l.captain_points, l.provisional
  from public.ff_latest_display_player_points(
    p_league,
    (select coalesce(array_agg(sp.player_id order by sp.player_id), '{}'::text[])
       from public.fantasy_squads s
       join public.fantasy_squad_players sp on sp.squad_id = s.id
       join public.players p on p.id = sp.player_id and p.league_id = p_league
      where s.league_id = p_league and s.profile_id = auth.uid()::text)) l
  where public.is_member(p_league);
$$;
revoke all on function public.ff_my_latest_display_player_points(text) from public, anon, authenticated;
grant execute on function public.ff_my_latest_display_player_points(text) to authenticated;

-- PostgREST caches the database schema. Reload it so the new return type of
-- `last_game_points` and the new function are visible to the API.
notify pgrst, 'reload schema';

commit;
