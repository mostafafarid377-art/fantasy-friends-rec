begin;

-- Keep the latest individual game unchanged. Expose a separate score only
-- when the member's official, current-version ledger applied the multiplier.
create function public.latest_squad_player_games(p_league text, p_players text[])
returns table (player_id text, match_id text, points numeric, captain_points numeric)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select g.player_id, g.match_id, g.points, captain.points
  from public.latest_player_games(p_league, p_players) g
  left join public.real_matches m on m.id=g.match_id and m.league_id=p_league and m.status='approved'
  left join public.manager_points mp on mp.match_id=m.id and mp.league_id=p_league
    and mp.match_version=m.version and mp.profile_id=auth.uid()::text
    and mp.breakdown->>'captainId'=g.player_id
  left join lateral (
    select line.points from jsonb_to_recordset(case when jsonb_typeof(mp.breakdown->'lines')='array' then mp.breakdown->'lines' else '[]'::jsonb end) line("playerId" text, multiplier numeric, points numeric)
    where line."playerId"=g.player_id and line.multiplier=2 limit 1
  ) captain on true;
$$;
revoke all on function public.latest_squad_player_games(text,text[]) from public, anon, authenticated;
grant execute on function public.latest_squad_player_games(text,text[]) to authenticated;

-- The creator is already the only caller allowed by leagues_delete policy.
-- Require explicit confirmation and order child removals around restrictive FKs.
revoke delete on table public.leagues from public, anon, authenticated;
create function public.delete_owned_league(p_league text, p_confirmation text)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  target leagues%rowtype;
  deleted text;
begin
  select * into target from leagues where id=p_league for update;
  if auth.uid() is null or not found or target.created_by <> auth.uid()::text
     or not public.is_member(p_league) then
    raise insufficient_privilege;
  end if;
  if p_confirmation is distinct from target.name then
    raise invalid_parameter_value using message='Type the current league name exactly to confirm deletion';
  end if;

  -- Matches reference teams with RESTRICT; lineup and squad picks reference
  -- players with RESTRICT. Remove the matches and squad picks first.
  delete from real_matches where league_id=p_league;
  delete from fantasy_squads where league_id=p_league;
  delete from leagues where id=p_league returning id into strict deleted;
  return deleted;
end;
$$;
revoke all on function public.delete_owned_league(text,text) from public, anon, authenticated;
grant execute on function public.delete_owned_league(text,text) to authenticated;

commit;
