begin;

-- Hot-read performance: player history, league events, standings history.
--
-- Measured locally against a seeded league (12 managers, 300 approved matches,
-- ~7.5k events, ~6.6k scored player rows, ~3.6k standings-history rows):
--
--   player_finalized_games_with_logos     p50 513 ms
--   match_events league-wide read          214 ms (11 ms with RLS bypassed)
--   fantasy_points_history read (top 200)   23 ms
--
-- Root causes, and what this migration does about them:
--
-- 1. `player_finalized_games_with_logos` found a player's candidate matches
--    through the `match_scoring_lineups` view with only a league filter the
--    planner could push down. The non-finalized branch of the view therefore
--    seq-scanned `match_lineups` and evaluated its row-level security policy
--    (`is_match_organizer`/`match_is_editable`/`is_member`, all security
--    definer functions) for every lineup row in the database. The candidate
--    set is now read straight from the base tables with the league and player
--    predicates in place, so the existing `lineup_league_player_match_idx`
--    index does the work and the unchanged row-level policies are checked
--    against ~150 rows instead of the whole table. The view itself, its
--    definition, and every other consumer are untouched.
--
-- 2. The points screen reads every `match_events` row of the league through
--    PostgREST, and the standings screen reads `fantasy_points_history` the
--    same way. Both tables use `is_member(league_id)` row-level policies, so
--    each scanned row costs a security-definer function call (about 200 ms
--    per 7.5k rows). The app now reads them through two scoped
--    security-definer functions that verify the caller's membership once and
--    return exactly the columns the routes already selected — the same rows
--    the row-level policies already allowed, nothing more. Direct table reads
--    keep working exactly as before; the policies are unchanged.
--
-- 3. Two supporting indexes: `finalized_match_lineups(league_id)` for the
--    rewritten candidate lookup, and `match_events(league_id)` plus
--    `fantasy_points_history(league_id, created_at)` for the new scoped
--    reads. All three tables grow without bound as matches are played, and
--    each index targets a query that now filters on exactly those columns.
--
-- Nothing here writes rows, changes scoring, changes lineup resolution, or
-- weakens any row-level policy. The rewritten function keeps its signature,
-- its parameter defaults, its result columns and its security-invoker
-- execution; the new functions are callable only by `authenticated` and
-- answer only for leagues the caller belongs to.

create or replace function public.player_finalized_games_with_logos(
  p_league text, p_player text, p_limit int,
  p_before_kickoff timestamptz default null, p_before_match text default null,
  p_include_breakdown boolean default true
) returns table (
  match_id text, title text, kick_off timestamptz, gameweek int, opponent text,
  participation text, points numeric, breakdown jsonb, opponent_id text, opponent_crest text
)
language sql stable security invoker set search_path = pg_catalog, public as $$
  with allowed as materialized (
    select id from public.players
    where id = p_player and league_id = p_league and public.is_member(p_league)
  ), candidates as (
    -- Same set as `match_scoring_lineups` for this player, read straight from
    -- the base tables so the (league, player) index is used. Non-finalized
    -- lineup rows:
    select l.match_id from allowed a join public.match_lineups l on l.player_id = a.id and l.league_id = p_league
      where not exists (select 1 from public.finalized_match_lineups f
                        where f.match_id = l.match_id and f.league_id = l.league_id)
    union
    -- Finalized lineup snapshots that include this player:
    select f.match_id from allowed a
      join public.finalized_match_lineups f on f.league_id = p_league
      cross join lateral jsonb_to_recordset(f.entries) e(team_id text, player_id text, slot text, match_position text)
      where e.player_id = a.id
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
    pm.points, case when p_include_breakdown then pm.breakdown end, opponent.id, opponent.crest_url
  from latest m
  -- Same rows as `match_scoring_lineups` for this (match, player): at most one
  -- non-finalized lineup row, or one entry from the finalized snapshot. Read
  -- straight from the base tables so the (match, player) indexes are used.
  left join lateral (
    select ml.team_id, ml.slot from public.match_lineups ml
      where ml.match_id = m.id and ml.league_id = p_league and ml.player_id = p_player
        and not exists (select 1 from public.finalized_match_lineups nf
                        where nf.match_id = ml.match_id and nf.league_id = ml.league_id)
    union all
    select fe.team_id, fe.slot from public.finalized_match_lineups ff
      cross join lateral jsonb_to_recordset(ff.entries) fe(team_id text, player_id text, slot text, match_position text)
      where ff.match_id = m.id and ff.league_id = p_league and fe.player_id = p_player
  ) l on true
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

-- The finalized branch of the rewritten candidate lookup filters by league.
create index if not exists finalized_match_lineups_league_idx
  on public.finalized_match_lineups(league_id);

-- League-scoped event rows for the points screen. Same rows the
-- `events_select` row-level policy already returns, with the membership check
-- evaluated once per call instead of once per row.
create function public.ff_league_match_events(p_league text, p_match text default null)
returns table(id text, match_id text, player_id text, event_type text, minute integer, assist_player_id text)
language sql stable security definer set search_path=pg_catalog,public as $$
  select e.id,e.match_id,e.player_id,e.event_type,e.minute,e.assist_player_id
  from public.match_events e
  where e.league_id=p_league and (p_match is null or e.match_id=p_match) and public.is_member(p_league);
$$;

-- League-scoped standings history for the standings screen, with the match
-- and profile fields the route already embedded. Same rows the
-- `history_select` row-level policy already returns. The limit is clamped the
-- same way other paginated readers clamp theirs.
create function public.ff_league_points_history(p_league text, p_limit int default 200)
returns table(match_id text, gameweek integer, points numeric, profile_id text,
  match_title text, kick_off timestamptz, username text, display_name text)
language sql stable security definer set search_path=pg_catalog,public as $$
  select h.match_id,h.gameweek,h.points,h.profile_id,m.title,m.kick_off,p.username,p.display_name
  from public.fantasy_points_history h
  left join public.real_matches m on m.id=h.match_id and m.league_id=h.league_id
  left join public.profiles p on p.id=h.profile_id
  where h.league_id=p_league and public.is_member(p_league)
  -- The id tiebreak keeps rows from one approval batch (same created_at) in a
  -- stable order; the direct-read path never specified one.
  order by h.created_at asc, h.id asc
  limit greatest(1, least(coalesce(p_limit,200),500));
$$;

-- The league-scoped reads these functions replace.
create index if not exists match_events_league_idx on public.match_events(league_id);
create index if not exists fph_league_created_idx on public.fantasy_points_history(league_id, created_at, id);

-- Callers must be signed-in league members; the functions stay unavailable to
-- anonymous clients.
revoke all on function public.ff_league_match_events(text,text),
  public.ff_league_points_history(text,int) from public,anon;
grant execute on function public.ff_league_match_events(text,text),
  public.ff_league_points_history(text,int) to authenticated;

-- PostgREST caches the database schema. Reload it so the new functions are
-- visible to the API.
notify pgrst, 'reload schema';

commit;
