begin;

create index if not exists lineup_league_player_match_idx
  on public.match_lineups (league_id, player_id, match_id);
create index if not exists subs_league_player_on_match_idx
  on public.match_substitutions (league_id, player_on_id, match_id);

-- Read-only projection of the official ledger. A team match alone is not
-- evidence that a player was involved, especially after a roster transfer.
create function public.player_finalized_games(
  p_league text, p_player text, p_limit int,
  p_before_kickoff timestamptz default null, p_before_match text default null,
  p_include_breakdown boolean default true
) returns table (
  match_id text, title text, kick_off timestamptz, gameweek int, opponent text,
  participation text, points numeric, breakdown jsonb
)
language sql stable security invoker set search_path = pg_catalog, public as $$
  with allowed as materialized (
    select id from public.players
    where id = p_player and league_id = p_league and public.is_member(p_league)
  ), candidates as (
    select l.match_id from allowed a join public.match_lineups l on l.player_id = a.id where l.league_id = p_league
    union
    select s.match_id from allowed a join public.match_substitutions s on s.player_on_id = a.id where s.league_id = p_league
    union
    select pm.match_id from allowed a join public.player_match_points pm on pm.player_id = a.id
      join public.real_matches m on m.id = pm.match_id and m.league_id = p_league and m.version = pm.match_version
      where pm.league_id = p_league
  ), latest as materialized (
    select m.id, m.title, m.kick_off, m.version, m.team_a_id, m.team_b_id, m.fixture_id
    from candidates c join public.real_matches m on m.id = c.match_id
    where m.league_id = p_league and m.status = 'approved'
      and (p_before_kickoff is null or (m.kick_off, m.id) < (p_before_kickoff, p_before_match))
    order by m.kick_off desc, m.id desc
    limit greatest(1, least(coalesce(p_limit, 21), 51))
  )
  select m.id, m.title, m.kick_off, f.gameweek, opponent.name,
    case when l.slot = 'starter' or s.team_id is not null then 'played'
         when l.slot = 'sub' then 'did_not_play' else 'unknown' end,
    pm.points, case when p_include_breakdown then pm.breakdown end
  from latest m
  left join public.match_lineups l on l.match_id = m.id and l.league_id = p_league and l.player_id = p_player
  left join lateral (
    select sub.team_id from public.match_substitutions sub
    where sub.match_id = m.id and sub.league_id = p_league and sub.player_on_id = p_player
    order by sub.id limit 1
  ) s on true
  left join public.player_match_points pm on pm.match_id = m.id and pm.league_id = p_league
    and pm.player_id = p_player and pm.match_version = m.version
  left join public.fantasy_fixtures f on f.id = m.fixture_id and f.league_id = p_league
  left join public.teams opponent on opponent.league_id = p_league and opponent.id = case coalesce(l.team_id, s.team_id)
    when m.team_a_id then m.team_b_id when m.team_b_id then m.team_a_id end
  order by m.kick_off desc, m.id desc;
$$;

-- A single bounded read for the pitch, with no event breakdowns returned.
create function public.latest_player_games(p_league text, p_players text[])
returns table (player_id text, match_id text, points numeric)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select p.id, g.match_id, g.points
  from (select distinct id from unnest(p_players) ids(id) where id is not null and public.is_member(p_league) limit 15) p
  cross join lateral public.player_finalized_games(p_league, p.id, 1, null, null, false) g;
$$;

revoke all on function public.player_finalized_games(text,text,int,timestamptz,text,boolean),
  public.latest_player_games(text,text[]) from public, anon, authenticated;
grant execute on function public.player_finalized_games(text,text,int,timestamptz,text,boolean),
  public.latest_player_games(text,text[]) to authenticated;

commit;
