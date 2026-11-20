begin;

-- No backfill: an older match's duration may not be known.
alter table public.real_matches add column duration_minutes integer
  constraint real_matches_duration_ck check (duration_minutes between 1 and 200);

-- Replace the signature with a trailing optional argument so older callers
-- and queued creation requests still work without inventing a duration.
drop function public.create_real_match(text,text,text,text,text,timestamptz,text);
create function public.create_real_match(p_id text, p_league text, p_team_a text, p_team_b text,
  p_title text, p_kickoff timestamptz, p_fixture text, p_duration_minutes integer default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  actor text := auth.uid()::text;
  m real_matches%rowtype;
  linked text;
begin
  if actor is null or not (public.is_leader(p_league) or public.is_organizer(p_league)) then raise insufficient_privilege; end if;
  if length(p_id) not between 1 and 80 or length(trim(p_title)) not between 3 and 80 then raise invalid_parameter_value; end if;
  if p_duration_minutes is not null and p_duration_minutes not between 1 and 200 then
    raise invalid_parameter_value using message='Match duration must be between 1 and 200 minutes';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('create-match:' || p_id, 0));
  select * into m from real_matches where id=p_id and league_id=p_league and organizer_id=actor;
  if found then
    if p_duration_minutes is not null and m.duration_minutes is distinct from p_duration_minutes then
      raise serialization_failure using message='This match was already created with a different duration';
    end if;
    return to_jsonb(m);
  end if;
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
  insert into real_matches(id, league_id, team_a_id, team_b_id, title, kick_off, organizer_id, fixture_id, duration_minutes)
    values (p_id,p_league,p_team_a,p_team_b,p_title,p_kickoff,actor,p_fixture,p_duration_minutes) returning * into strict m;
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

revoke all on function public.create_real_match(text,text,text,text,text,timestamptz,text,int) from public, anon, authenticated;
grant execute on function public.create_real_match(text,text,text,text,text,timestamptz,text,int) to authenticated;

commit;
