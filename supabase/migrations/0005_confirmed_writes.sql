-- Forward-only. No existing data is rewritten, and no table privileges or RLS
-- policies are relaxed. Each RPC is either invoker-scoped or narrowly guarded.
begin;

create or replace function public.join_league(p_code text, p_team_name text default null)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_league leagues%rowtype;
  v_member  public.league_members%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_league from leagues where invite_code = upper(trim(p_code)) for update;
  if not found then
    raise exception 'No league found with that code';
  end if;

  select * into v_member from league_members
   where league_id = v_league.id and profile_id = auth.uid()::text;

  if found then
    return v_league.id; -- idempotent: joining twice is a no-op
  end if;

  insert into league_members (id, league_id, profile_id, role, team_name)
  values (gen_random_uuid()::text, v_league.id, auth.uid()::text, 'manager',
          coalesce(p_team_name, 'My XI'));

  insert into league_standings (id, league_id, profile_id, rank, total_points, matches_played, form)
  values (gen_random_uuid()::text, v_league.id, auth.uid()::text, 0, 0, 0, '[]'::jsonb)
  on conflict (league_id, profile_id) do nothing;

  insert into league_activity (id, league_id, profile_id, action, summary, created_at)
  values (gen_random_uuid()::text, v_league.id, auth.uid()::text, 'member.joined',
          'A manager joined the league', now());

  return v_league.id;
end;
$$;

-- Also used by a leader to repair a league created by the old API, without
-- overwriting any existing customized or approved rule.
create function public.initialize_scoring_rules(p_league text)
returns setof public.scoring_rules language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if auth.uid() is null or not public.is_leader(p_league) then raise insufficient_privilege; end if;
  insert into scoring_rules(id, league_id, position, event_type, points, status)
    select gen_random_uuid()::text, p_league, pos, event, points, 'draft'
    from unnest(array['GK','DEF','MID','FWD']) as pos
    cross join (values ('goal',4),('assist',3),('clean_sheet',2),('appearance',1),
      ('yellow_card',-1),('red_card',-3),('own_goal',-2),('penalty_saved',3),
      ('penalty_missed',-1),('win',0),('draw',0)) as defaults(event,points)
    on conflict (league_id,position,event_type) do nothing;
  return query select * from scoring_rules where league_id=p_league order by event_type,position;
end;
$$;

create function public.create_league_confirmed(
  p_operation text, p_name text, p_description text, p_format text,
  p_starters int, p_subs_count int, p_team_name text
) returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  actor text := auth.uid()::text;
  league_key text;
  receipt text;
begin
  if actor is null then raise insufficient_privilege; end if;
  if p_operation is null or length(p_operation) > 80 then raise invalid_parameter_value; end if;
  receipt := md5(jsonb_build_array(actor, p_operation, p_name, p_description, p_format, p_starters, p_subs_count, p_team_name)::text);
  perform pg_advisory_xact_lock(hashtextextended('create-league:' || receipt, 0));
  select result ->> 'id' into league_key from mutation_ops
    where id = receipt and profile_id = actor and route = 'create_league_confirmed' and status = 'applied';
  if found then return league_key; end if;

  if p_starters + p_subs_count > 15 then raise exception 'Starters and substitutes cannot exceed 15 players' using errcode = '22023'; end if;
  -- The existing RPC uses a digit-only code from the first part of a UUID.
  -- Retry its unique-code collision without splitting the transaction.
  for attempt in 1..5 loop
    begin
      league_key := public.create_league(p_name, p_description, p_format, p_starters, p_subs_count, p_team_name);
      exit;
    exception when unique_violation then
      if attempt = 5 then raise; end if;
    end;
  end loop;
  perform public.initialize_scoring_rules(league_key);
  insert into mutation_ops(id, profile_id, route, request_hash, status, result, applied_at)
    values (receipt, actor, 'create_league_confirmed', receipt, 'applied', jsonb_build_object('id',league_key), now());
  return league_key;
end;
$$;

create function public.save_fantasy_squad(
  p_league text, p_formation text, p_captain text, p_vice text, p_complete boolean, p_entries jsonb
) returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  actor text := auth.uid()::text;
  squad_key text;
  entries jsonb;
  cap int;
begin
  if actor is null or not public.is_member(p_league) then raise insufficient_privilege; end if;
  select squad_size into cap from leagues where id = p_league;
  if coalesce(jsonb_array_length(p_entries),0) not between 1 and cap then
    raise exception 'Invalid squad size' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_entries) e(player_id text)
      where not exists (select 1 from players p where p.id=e.player_id and p.league_id=p_league and p.status='active')) then
    raise exception 'Squad players must be active in this league' using errcode = '22023';
  end if;

  insert into fantasy_squads(id, league_id, profile_id, formation, captain_id, vice_captain_id, completed_at)
    values (gen_random_uuid()::text, p_league, actor, p_formation, p_captain, p_vice, case when p_complete then now() end)
    on conflict (league_id, profile_id) do update set formation=excluded.formation,
      captain_id=excluded.captain_id, vice_captain_id=excluded.vice_captain_id,
      completed_at=excluded.completed_at, updated_at=now()
    returning id into strict squad_key;
  delete from fantasy_squad_players where squad_id = squad_key;
  with inserted as (
    insert into fantasy_squad_players(id, squad_id, player_id, slot, "order")
      select gen_random_uuid()::text, squad_key, e.player_id, e.slot, e."order"
      from jsonb_to_recordset(p_entries) e(player_id text, slot text, "order" int)
      returning *
  ) select jsonb_agg(to_jsonb(inserted) order by inserted."order") into entries from inserted;
  return jsonb_build_object('squadId', squad_key, 'entries', entries);
end;
$$;

create function public.replace_match_lineup(p_match text, p_team text, p_entries jsonb)
returns setof public.match_lineups language plpgsql security definer set search_path = pg_catalog, public as $$
declare m real_matches%rowtype;
begin
  select * into m from real_matches where id=p_match for update;
  if auth.uid() is null or not found or not (public.is_leader(m.league_id) or public.is_match_organizer(p_match)) then
    raise insufficient_privilege;
  end if;
  if m.status not in ('draft','rejected') then raise exception 'Lineups are locked'; end if;
  if p_team is null or p_team not in (m.team_a_id,m.team_b_id) or not exists
      (select 1 from teams where id=p_team and league_id=m.league_id) then
    raise exception 'Team is not part of this match' using errcode = '22023';
  end if;
  if coalesce(jsonb_array_length(p_entries),0) not between 1 and 15 or exists (
      select 1 from jsonb_to_recordset(p_entries) e(player_id text)
      where not exists (select 1 from players p where p.id=e.player_id and p.league_id=m.league_id
        and (p.team_id is null or p.team_id=p_team))
  ) then raise exception 'Invalid player for this match team' using errcode = '22023'; end if;

  delete from match_lineups where match_id=p_match and league_id=m.league_id and team_id=p_team;
  insert into league_activity(id,league_id,profile_id,action,summary)
    values(gen_random_uuid()::text,m.league_id,auth.uid()::text,'match.lineup','Lineup set for ' || m.title);
  return query insert into match_lineups(id, match_id, league_id, team_id, player_id, slot, "order")
    select gen_random_uuid()::text, p_match, m.league_id, p_team, e.player_id, e.slot, e."order"
    from jsonb_to_recordset(p_entries) e(player_id text, slot text, "order" int)
    returning *;
end;
$$;

create function public.create_real_match(p_id text, p_league text, p_team_a text, p_team_b text,
  p_title text, p_kickoff timestamptz, p_fixture text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  actor text := auth.uid()::text;
  m real_matches%rowtype;
  linked text;
begin
  if actor is null or not (public.is_leader(p_league) or public.is_organizer(p_league)) then raise insufficient_privilege; end if;
  if length(p_id) not between 1 and 80 or length(trim(p_title)) not between 3 and 80 then raise invalid_parameter_value; end if;
  perform pg_advisory_xact_lock(hashtextextended('create-match:' || p_id, 0));
  select * into m from real_matches where id=p_id and league_id=p_league and organizer_id=actor;
  if found then return to_jsonb(m); end if;
  if p_team_a=p_team_b or (select count(*) from teams where league_id=p_league and id in (p_team_a,p_team_b)) <> 2 then
    raise exception 'Both teams must be different and belong to this league' using errcode = '22023';
  end if;
  if p_fixture is not null then
    select real_match_id into linked from fantasy_fixtures where id=p_fixture and league_id=p_league for update;
    if not found then raise exception 'Fixture not found in this league' using errcode = 'P0002'; end if;
    if linked is not null or exists (select 1 from real_matches where fixture_id=p_fixture) then
      raise exception 'This fixture already has a match';
    end if;
  end if;
  insert into real_matches(id, league_id, team_a_id, team_b_id, title, kick_off, organizer_id, fixture_id)
    values (p_id,p_league,p_team_a,p_team_b,p_title,p_kickoff,actor,p_fixture) returning * into strict m;
  if p_fixture is not null then
    update fantasy_fixtures set real_match_id=m.id, updated_at=now() where id=p_fixture and league_id=p_league;
  end if;
  insert into league_activity(id, league_id, profile_id, action, summary)
    values (gen_random_uuid()::text,p_league,actor,'match.created','Match created: ' || m.title);
  insert into notifications(id,profile_id,league_id,type,title,body,link)
    select gen_random_uuid()::text, profile_id,p_league,'match_created','New real match',m.title,'/matches/' || m.id
    from league_members where league_id=p_league and profile_id<>actor;
  return to_jsonb(m);
end;
$$;

create function public.save_scoring_rules(p_league text, p_rules jsonb)
returns setof public.scoring_rules language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if auth.uid() is null or not public.is_leader(p_league) then raise insufficient_privilege; end if;
  return query insert into scoring_rules(id, league_id, position, event_type, points, status)
    select gen_random_uuid()::text, p_league, r.position, r.event_type, r.points, 'draft'
    from jsonb_to_recordset(p_rules) r(position text, event_type text, points numeric)
    on conflict (league_id,position,event_type) do update set points=excluded.points,
      status='draft', approved_by=null, approved_at=null, updated_at=now()
    returning *;
end;
$$;

-- The API permits league leaders to manage all their matches. The existing
-- direct event policies intentionally still require the assigned organizer.
create function public.write_match_event(p_match text, p_id text, p_action text, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m real_matches%rowtype;
  e match_events%rowtype;
  sub match_substitutions%rowtype;
  actor text := auth.uid()::text;
  team text;
  player text;
  other text;
  event text;
  minute_value int;
  detail text;
  result jsonb;
begin
  select * into m from real_matches where id=p_match for update;
  if actor is null or not found or not (public.is_leader(m.league_id) or public.is_match_organizer(p_match)) then
    raise insufficient_privilege;
  end if;
  if p_action not in ('event','substitution','update','delete') or p_action is null or length(p_id) not between 1 and 80 then
    raise invalid_parameter_value;
  end if;
  if p_action in ('event','substitution') then
    if p_action='event' then
      select to_jsonb(r) into result from match_events r where id=p_id and match_id=p_match and league_id=m.league_id and created_by=actor;
    else
      select to_jsonb(r) into result from match_substitutions r where id=p_id and match_id=p_match and league_id=m.league_id and created_by=actor;
    end if;
    if found then return result; end if;
  end if;
  if m.status not in ('draft','rejected') then raise exception 'Events are locked while the match is pending or approved'; end if;
  if p_action in ('update','delete') then
    select * into e from match_events where id=p_id and match_id=p_match and league_id=m.league_id;
    if not found then raise no_data_found using message='Event not found in this match'; end if;
    if p_action='delete' then
      delete from match_events where id=e.id;
      return to_jsonb(e);
    end if;
  end if;
  team := coalesce(p_data->>'teamId', e.team_id);
  player := coalesce(p_data->>'playerId', e.player_id);
  other := case when p_data ? 'otherId' then p_data->>'otherId' else e.assist_player_id end;
  event := coalesce(p_data->>'eventType', e.event_type);
  minute_value := coalesce((p_data->>'minute')::int, e.minute);
  detail := case when p_data ? 'note' then p_data->>'note' else e.note end;
  if team is null or team not in (m.team_a_id,m.team_b_id) or
     (p_action='update' and team<>e.team_id) or
     not exists (select 1 from teams where id=team and league_id=m.league_id) then
    raise exception 'Team is not part of this match' using errcode='22023';
  end if;
  if player is null or (p_action='substitution' and (other is null or other=player)) or exists (
      select 1 from unnest(array[player,other]) as ids(id) where ids.id is not null and not exists (
        select 1 from match_lineups l join players p on p.id=l.player_id
          where l.match_id=p_match and l.league_id=m.league_id and l.team_id=team and l.player_id=ids.id
          and p.league_id=m.league_id and (p.team_id is null or p.team_id=team))) then
    raise exception 'Each player must be in the match team lineup' using errcode='22023';
  end if;
  if p_action='substitution' then
    insert into match_substitutions(id,match_id,league_id,team_id,player_on_id,player_off_id,minute,created_by)
      values(p_id,p_match,m.league_id,team,player,other,minute_value,actor) returning * into strict sub;
    return to_jsonb(sub);
  end if;
  if p_action='update' then
    update match_events set player_id=player,assist_player_id=other,event_type=event,
      minute=minute_value,note=detail,updated_at=now() where id=e.id returning * into strict e;
  else
    insert into match_events(id,match_id,league_id,team_id,player_id,assist_player_id,event_type,minute,note,created_by)
      values(p_id,p_match,m.league_id,team,player,other,event,minute_value,detail,actor) returning * into strict e;
  end if;
  return to_jsonb(e);
end;
$$;

create function public.clear_match_lineups(p_match text)
returns int language plpgsql security definer set search_path = pg_catalog, public as $$
declare m real_matches%rowtype; removed int;
begin
  select * into m from real_matches where id=p_match for update;
  if auth.uid() is null or not found or not (public.is_leader(m.league_id) or public.is_match_organizer(p_match)) then
    raise insufficient_privilege;
  end if;
  if m.status not in ('draft','rejected') then raise exception 'Lineups are locked'; end if;
  delete from match_lineups where match_id=p_match and league_id=m.league_id;
  get diagnostics removed = row_count;
  if removed > 0 then
    insert into league_activity(id,league_id,profile_id,action,summary)
      values(gen_random_uuid()::text,m.league_id,auth.uid()::text,'match.lineup.cleared','Lineup cleared');
  end if;
  return removed;
end;
$$;

create function public.edit_real_match_details(p_match text, p_version int, p_details jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m real_matches%rowtype;
  a text;
  b text;
  f text;
  linked text;
begin
  select * into m from real_matches where id=p_match for update;
  if auth.uid() is null or not found or not (public.is_leader(m.league_id) or public.is_match_organizer(p_match)) then
    raise insufficient_privilege;
  end if;
  if m.status not in ('draft','rejected') then raise exception 'This match is locked'; end if;
  if m.version is distinct from p_version then raise serialization_failure; end if;
  a := coalesce(p_details->>'teamAId',m.team_a_id);
  b := coalesce(p_details->>'teamBId',m.team_b_id);
  f := case when p_details ? 'fixtureId' then p_details->>'fixtureId' else m.fixture_id end;
  if a=b or (select count(*) from teams where league_id=m.league_id and id in (a,b)) <> 2 then
    raise exception 'Both teams must be different and belong to this league' using errcode='22023';
  end if;
  if (a,b) is distinct from (m.team_a_id,m.team_b_id) and
      (exists (select 1 from match_lineups where match_id=p_match) or
       exists (select 1 from match_events where match_id=p_match) or
       exists (select 1 from match_substitutions where match_id=p_match)) then
    raise exception 'Clear existing lineups and events before changing match teams';
  end if;
  if f is distinct from m.fixture_id then
    if f is not null then
      select real_match_id into linked from fantasy_fixtures where id=f and league_id=m.league_id for update;
      if not found then raise no_data_found using message='Fixture not found in this league'; end if;
      if (linked is not null and linked<>p_match) or exists (select 1 from real_matches where fixture_id=f and id<>p_match) then
        raise exception 'This fixture already has a match';
      end if;
    end if;
    update fantasy_fixtures set real_match_id=null, updated_at=now()
      where id=m.fixture_id and league_id=m.league_id and real_match_id=p_match;
    update fantasy_fixtures set real_match_id=p_match, updated_at=now() where id=f and league_id=m.league_id;
  end if;
  if p_details ? 'title' and length(trim(p_details->>'title')) not between 3 and 80 then raise invalid_parameter_value; end if;
  update real_matches set title=coalesce(p_details->>'title',m.title),
    kick_off=coalesce((p_details->>'kickOff')::timestamptz,m.kick_off), team_a_id=a, team_b_id=b,
    fixture_id=f, status='draft', version=m.version+1, updated_at=now()
    where id=m.id returning * into strict m;
  return to_jsonb(m);
end;
$$;

revoke all on function public.create_league_confirmed(text,text,text,text,int,int,text),
  public.save_fantasy_squad(text,text,text,text,boolean,jsonb), public.replace_match_lineup(text,text,jsonb),
  public.create_real_match(text,text,text,text,text,timestamptz,text), public.save_scoring_rules(text,jsonb), public.initialize_scoring_rules(text),
  public.write_match_event(text,text,text,jsonb), public.clear_match_lineups(text), public.edit_real_match_details(text,int,jsonb) from public, anon;
grant execute on function public.create_league_confirmed(text,text,text,text,int,int,text),
  public.save_fantasy_squad(text,text,text,text,boolean,jsonb), public.replace_match_lineup(text,text,jsonb),
  public.create_real_match(text,text,text,text,text,timestamptz,text), public.save_scoring_rules(text,jsonb), public.initialize_scoring_rules(text),
  public.write_match_event(text,text,text,jsonb), public.clear_match_lineups(text), public.edit_real_match_details(text,int,jsonb) to authenticated;

create index if not exists teams_league_lower_name_idx on public.teams (league_id, lower(name));
create index if not exists players_league_name_id_idx on public.players (league_id, full_name, id);
create index if not exists matches_league_kickoff_id_idx on public.real_matches (league_id, kick_off desc, id desc);
commit;
