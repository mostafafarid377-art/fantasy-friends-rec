begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('team-logos','team-logos',false,1048576,array['image/webp']) on conflict(id) do nothing;
do $$ begin
  if exists (select 1 from storage.buckets where id='team-logos' and public) then
    raise exception 'The team-logos bucket must be private';
  end if;
end $$;

create policy ff_team_logo_read on storage.objects for select to authenticated using (
  bucket_id='team-logos' and exists (select 1 from public.teams t
    where t.league_id=split_part(storage.objects.name,'/',1) and t.id=split_part(storage.objects.name,'/',2)
      and (public.is_leader(t.league_id) or (public.is_member(t.league_id) and t.crest_url='team-logos/'||storage.objects.name))));
create policy ff_team_logo_insert on storage.objects for insert to authenticated with check (
  bucket_id='team-logos' and name ~ '^[^/]+/[^/]+/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.webp$' and exists (select 1 from public.teams t
    where t.league_id=split_part(storage.objects.name,'/',1) and t.id=split_part(storage.objects.name,'/',2) and public.is_leader(t.league_id)));
create policy ff_team_logo_delete on storage.objects for delete to authenticated using (
  bucket_id='team-logos' and exists (select 1 from public.teams t where t.league_id=split_part(storage.objects.name,'/',1)
    and t.id=split_part(storage.objects.name,'/',2) and public.is_leader(t.league_id) and t.crest_url is distinct from 'team-logos/'||storage.objects.name));

-- Retain the existing crest column and legacy external links.
create function public.ff_validate_team_logo() returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare key text;
begin
  if new.crest_url is null or left(new.crest_url,11)<>'team-logos/' then return new; end if;
  if tg_op='UPDATE' and (new.crest_url,new.id,new.league_id) is not distinct from (old.crest_url,old.id,old.league_id) then return new; end if;
  key := substr(new.crest_url,12);
  if key !~ '^[^/]+/[^/]+/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.webp$' or split_part(key,'/',1)<>new.league_id
    or split_part(key,'/',2)<>new.id or not exists(select 1 from storage.objects o where o.bucket_id='team-logos' and o.name=key) then
    raise invalid_parameter_value using message='The logo must exist in this team''s storage folder';
  end if;
  return new;
end $$;
revoke all on function public.ff_validate_team_logo() from public,anon,authenticated;
create trigger ff_team_logo_scope before insert or update of crest_url,id,league_id on public.teams
  for each row execute function public.ff_validate_team_logo();
-- Keep the older RPC signature intact for squad and legacy clients.
create function public.player_finalized_games_with_logos(
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
    pm.points, case when p_include_breakdown then pm.breakdown end, opponent.id, opponent.crest_url
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

revoke all on function public.player_finalized_games_with_logos(text,text,int,timestamptz,text,boolean) from public,anon,authenticated;
grant execute on function public.player_finalized_games_with_logos(text,text,int,timestamptz,text,boolean) to authenticated;
commit;
