begin;

-- A real lineup edit is not a statistics deletion. Keep the parent match and
-- player references; the guarded statistics RPC still validates participation.
alter table public.match_player_statistics
  add constraint match_player_statistics_match_id_fkey foreign key (match_id)
    references public.real_matches(id) on delete cascade,
  add constraint match_player_statistics_player_id_fkey foreign key (player_id)
    references public.players(id) on delete cascade,
  drop constraint match_player_statistics_match_id_player_id_fkey;

-- Keep the scoring/appearance inputs immutable when a published real lineup is edited.
-- Capture only on the first actual edit; no historical rows are rewritten by this migration.
create table public.finalized_match_lineups (
  match_id text primary key references public.real_matches(id) on delete cascade,
  league_id text not null references public.leagues(id) on delete cascade,
  entries jsonb not null check (jsonb_typeof(entries) = 'array')
);
alter table public.finalized_match_lineups enable row level security;
create policy finalized_match_lineups_read on public.finalized_match_lineups for select to authenticated
  using (public.is_member(league_id));
revoke all on public.finalized_match_lineups from public,anon,authenticated;
grant select on public.finalized_match_lineups to authenticated;

create view public.match_scoring_lineups with (security_invoker=true) as
  select l.match_id,l.league_id,l.team_id,l.player_id,l.slot,l.match_position
    from public.match_lineups l where not exists (
      select 1 from public.finalized_match_lineups f where f.match_id=l.match_id and f.league_id=l.league_id)
  union all
  select f.match_id,f.league_id,e.team_id,e.player_id,e.slot,e.match_position
    from public.finalized_match_lineups f
    cross join lateral jsonb_to_recordset(f.entries) e(team_id text,player_id text,slot text,match_position text);
revoke all on public.match_scoring_lineups from public,anon,authenticated;
grant select on public.match_scoring_lineups to authenticated;

create or replace function public.replace_match_lineup(p_match text, p_team text, p_entries jsonb)
returns setof public.match_lineups language plpgsql security definer set search_path = pg_catalog, public as $$
declare m real_matches%rowtype; l leagues%rowtype; n int; valid int; starters int; keepers int; bench int;
begin
  select * into m from real_matches where id=p_match for update;
  if auth.uid() is null or not found or not (public.is_leader(m.league_id) or public.is_match_organizer(p_match)) then
    raise insufficient_privilege;
  end if;
  if p_team is null or p_team not in (m.team_a_id,m.team_b_id) or not exists
    (select 1 from teams where id=p_team and league_id=m.league_id for share) then
    raise exception 'Team is not part of this match' using errcode='22023';
  end if;
  select * into strict l from leagues where id=m.league_id for share;
  if l.starters is distinct from (case l.format when '5v5' then 5 when '7v7' then 7 end) then
    raise exception 'The league starter count does not match its format' using errcode='22023';
  end if;
  if jsonb_typeof(p_entries) is distinct from 'array' then raise exception 'Expected a lineup list' using errcode='22023'; end if;
  n := jsonb_array_length(p_entries);
  if n > l.squad_size or n < l.starters or exists (
    select 1 from jsonb_to_recordset(p_entries) e(player_id text, slot text, "order" int)
    where e.player_id is null or e.slot is null or e.slot not in ('starter','sub') or e."order" is null or e."order" < 0 or e."order" >= n
  ) or n <> (select count(distinct e.player_id) from jsonb_to_recordset(p_entries) e(player_id text)) or exists (
    select 1 from jsonb_to_recordset(p_entries) e(slot text, "order" int) group by slot
    having count(distinct "order") <> count(*) or min("order") <> 0 or max("order") <> count(*)-1
  ) then raise exception 'Invalid or duplicate lineup entries' using errcode='22023'; end if;

  with eligible as materialized (
    select e.slot,p.position from jsonb_to_recordset(p_entries) e(player_id text,slot text)
    join players p on p.id=e.player_id and p.league_id=m.league_id and p.team_id=p_team
      and p.status='active' and p.availability in ('available','doubt')
    order by p.id for share of p
  ) select count(*),count(*) filter (where slot='starter'),count(*) filter (where slot='starter' and position='GK'),count(*) filter (where slot='sub')
    into valid,starters,keepers,bench from eligible;
  if valid <> n then raise exception 'A selected player is unavailable or not part of this match team' using errcode='22023'; end if;
  if starters <> l.starters or keepers <> 1 or bench > l.subs_count then
    raise exception 'Select exactly % starters, including one goalkeeper, and at most % substitutes', l.starters,l.subs_count using errcode='22023';
  end if;
  if exists (select 1 from match_lineups old join jsonb_to_recordset(p_entries) e(player_id text) on e.player_id=old.player_id
             where old.match_id=p_match and old.team_id<>p_team) then
    raise exception 'A player is already selected for the other team' using errcode='22023';
  end if;

  -- A retry of the same selection does not rewrite player rows or log another action.
  if (select count(*) from match_lineups where match_id=p_match and team_id=p_team)=n and not exists (
    select player_id,slot,"order" from jsonb_to_recordset(p_entries) e(player_id text,slot text,"order" int)
    except select player_id,slot,"order" from match_lineups where match_id=p_match and team_id=p_team
  ) then
    return query select * from match_lineups where match_id=p_match and team_id=p_team;
    return;
  end if;

  if m.status='approved' then
    insert into public.finalized_match_lineups(match_id,league_id,entries)
      select p_match,m.league_id,coalesce(jsonb_agg(jsonb_build_object(
        'player_id',old.player_id,'team_id',old.team_id,'slot',old.slot,
        'match_position',coalesce(old.match_position,p.position))), '[]'::jsonb)
      from public.match_lineups old join public.players p on p.id=old.player_id and p.league_id=old.league_id
      where old.match_id=p_match and old.league_id=m.league_id
      on conflict (match_id) do nothing;
  elsif exists (
    select 1 from (
      select player_on_id from public.match_substitutions where match_id=p_match and team_id=p_team
      union select player_off_id from public.match_substitutions where match_id=p_match and team_id=p_team
      union select player_id from public.match_events where match_id=p_match and team_id=p_team
      union select assist_player_id from public.match_events where match_id=p_match and team_id=p_team
    ) refs(player_id) where refs.player_id is not null and not exists (
      select 1 from jsonb_to_recordset(p_entries) e(player_id text) where e.player_id=refs.player_id)
  ) then
    raise exception 'Keep players with recorded events or substitutions in the lineup' using errcode='22023';
  end if;
  if m.status<>'approved' and exists (
    select 1 from public.match_player_statistics s
    join public.match_lineups old on old.match_id=s.match_id and old.player_id=s.player_id and old.team_id=p_team
    where s.match_id=p_match and (s.saves<>0 or s.defensive_contributions<>0)
      and not exists (
        select 1 from jsonb_to_recordset(p_entries) e(player_id text,slot text)
        where e.player_id=s.player_id and (e.slot='starter' or exists (
          select 1 from public.match_substitutions sub where sub.match_id=p_match and sub.team_id=p_team
            and sub.player_on_id=e.player_id
        ))
      )
  ) then
    raise exception 'Clear the saved statistics for any player who will no longer participate before changing the lineup' using errcode='22023';
  end if;
  -- Make any reviewer using an older pending revision reload before approving.
  if m.status='pending' then
    update public.real_matches set version=version+1,updated_at=now() where id=p_match;
  end if;

  delete from match_lineups old where old.match_id=p_match and old.league_id=m.league_id and old.team_id=p_team
    and not exists (select 1 from jsonb_to_recordset(p_entries) e(player_id text) where e.player_id=old.player_id);
  insert into league_activity(id,league_id,profile_id,action,summary)
    values(gen_random_uuid()::text,m.league_id,auth.uid()::text,'match.lineup','Lineup set for ' || m.title);
  return query insert into match_lineups(id,match_id,league_id,team_id,player_id,slot,"order")
    select gen_random_uuid()::text,p_match,m.league_id,p_team,e.player_id,e.slot,e."order"
    from jsonb_to_recordset(p_entries) e(player_id text,slot text,"order" int)
    on conflict (match_id,player_id) do update set slot=excluded.slot,"order"=excluded."order"
    returning *;
end;
$$;
create or replace function public.clear_match_lineups(p_match text)
returns int language plpgsql security definer set search_path = pg_catalog, public as $$
declare m real_matches%rowtype; removed int;
begin
  select * into m from real_matches where id=p_match for update;
  if auth.uid() is null or not found or not (public.is_leader(m.league_id) or public.is_match_organizer(p_match)) then
    raise insufficient_privilege;
  end if;
  if m.status not in ('draft','rejected') then raise exception 'Lineups are locked'; end if;
  if exists (select 1 from public.match_events where match_id=p_match)
    or exists (select 1 from public.match_substitutions where match_id=p_match)
    or exists (select 1 from public.match_player_statistics where match_id=p_match and (saves<>0 or defensive_contributions<>0)) then
    raise exception 'Cannot clear lineups with recorded events, substitutions or statistics' using errcode='22023';
  end if;
  delete from match_lineups where match_id=p_match and league_id=m.league_id;
  get diagnostics removed = row_count;
  if removed > 0 then
    insert into league_activity(id,league_id,profile_id,action,summary)
      values(gen_random_uuid()::text,m.league_id,auth.uid()::text,'match.lineup.cleared','Lineup cleared');
  end if;
  return removed;
end;
$$;

create or replace function public.ff_match_participants(p_match text)
returns table(player_id text,"position" text) language sql stable set search_path=pg_catalog,public as $$
  select l.player_id,coalesce(l.match_position,p.position) from public.match_scoring_lineups l
  join public.real_matches m on m.id=l.match_id and m.league_id=l.league_id and l.team_id in (m.team_a_id,m.team_b_id)
  join public.players p on p.id=l.player_id and p.league_id=m.league_id
  where l.match_id=p_match and (l.slot='starter' or exists (
    select 1 from public.match_substitutions s where s.match_id=l.match_id and s.league_id=l.league_id
      and s.team_id=l.team_id and s.player_on_id=l.player_id
  ));
$$;

create or replace function public.player_finalized_games(
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
    select l.match_id from allowed a join public.match_scoring_lineups l on l.player_id = a.id where l.league_id = p_league
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
  left join public.match_scoring_lineups l on l.match_id = m.id and l.league_id = p_league and l.player_id = p_player
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
    select l.match_id from allowed a join public.match_scoring_lineups l on l.player_id = a.id where l.league_id = p_league
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
  left join public.match_scoring_lineups l on l.match_id = m.id and l.league_id = p_league and l.player_id = p_player
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


-- Only official participant ledger rows: a more recent unused real bench slot must
-- not hide a player's last completed appearance. Keep the captain contribution separate.
create function public.latest_squad_scored_matches(p_league text,p_players text[])
returns table(player_id text,match_id text,title text,kick_off timestamptz,points numeric,captain_points numeric)
language sql stable security invoker set search_path=pg_catalog,public as $$
  select p.id,g.match_id,g.title,g.kick_off,g.points,captain.points
  from (select distinct ids.id from unnest(p_players) ids(id)
        where ids.id is not null and public.is_member(p_league) order by ids.id limit 15) p
  cross join lateral (
    select m.id as match_id,m.title,m.kick_off,m.version,pm.points
    from public.player_match_points pm join public.real_matches m
      on m.id=pm.match_id and m.league_id=pm.league_id and m.version=pm.match_version
    where pm.league_id=p_league and pm.player_id=p.id and m.status='approved'
    order by m.kick_off desc,m.id desc limit 1
  ) g
  left join public.manager_points mp on mp.match_id=g.match_id and mp.league_id=p_league
    and mp.match_version=g.version and mp.profile_id=auth.uid()::text and mp.breakdown->>'captainId'=p.id
  left join lateral (
    select e.points from jsonb_to_recordset(case when jsonb_typeof(mp.breakdown->'lines')='array'
      then mp.breakdown->'lines' else '[]'::jsonb end) e("playerId" text,multiplier numeric,points numeric)
    where e."playerId"=p.id and e.multiplier=2 limit 1
  ) captain on true;
$$;
revoke all on function public.latest_squad_scored_matches(text,text[]) from public,anon,authenticated;
grant execute on function public.latest_squad_scored_matches(text,text[]) to authenticated;

-- New match events can omit the minute. Keep old recorded minutes and require
-- substitution minutes as before. Existing event RPC already accepts an absent minute.
alter table public.match_events alter column minute drop not null;

commit;
