begin;

-- One editable squad per league. Keep it frozen while any started match is
-- awaiting finalization, so the existing scoring ledger reads kickoff picks.
create index ff_open_match_deadline_idx on public.real_matches(league_id,kick_off,id)
  where status <> 'approved';

create function public.ff_squad_deadline(p_league text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare t timestamptz := clock_timestamp(); m real_matches%rowtype;
begin
  if not public.is_member(p_league) then raise insufficient_privilege; end if;
  select * into m from real_matches where league_id=p_league and status <> 'approved'
    order by kick_off,id limit 1;
  return jsonb_build_object('serverNow',t,'matchId',m.id,'title',m.title,'kickOff',m.kick_off,
    'locked',coalesce(m.kick_off<=t,false));
end $$;
revoke all on function public.ff_squad_deadline(text) from public,anon,authenticated;
grant execute on function public.ff_squad_deadline(text) to authenticated;

create function public.ff_serialize_deadline() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('ff-deadline:'||new.league_id,0));
  if tg_op='UPDATE' and old.kick_off<=clock_timestamp()
     and (new.kick_off,new.team_a_id,new.team_b_id) is distinct from (old.kick_off,old.team_a_id,old.team_b_id) then
    raise exception 'Kickoff and teams cannot change after the match starts';
  end if;
  return new;
end $$;
revoke all on function public.ff_serialize_deadline() from public,anon,authenticated;
create trigger ff_match_deadline before insert or update of kick_off,status,team_a_id,team_b_id on public.real_matches
  for each row execute function public.ff_serialize_deadline();

revoke insert,delete on public.fantasy_squads,public.fantasy_squad_players from public,anon,authenticated;
revoke update (formation,captain_id,vice_captain_id,completed_at,updated_at) on public.fantasy_squads from public,anon,authenticated;
revoke update (slot,"order") on public.fantasy_squad_players from public,anon,authenticated;
alter function public.save_fantasy_squad_v2(text,text,text,text,timestamptz,jsonb) rename to ff_save_validated_squad;
revoke all on function public.ff_save_validated_squad(text,text,text,text,timestamptz,jsonb) from public,anon,authenticated;
create function public.save_fantasy_squad_v2(p_league text,p_formation text,p_captain text,p_vice text,p_expected_updated_at timestamptz,p_entries jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare saved jsonb;
begin
  if not public.is_member(p_league) then raise insufficient_privilege; end if;
  perform pg_advisory_xact_lock(hashtextextended('ff-deadline:'||p_league,0));
  if (public.ff_squad_deadline(p_league)->>'locked')::boolean then
    raise exception 'Squad Locked: a match has started and is awaiting finalization';
  end if;
  saved := public.ff_save_validated_squad(p_league,p_formation,p_captain,p_vice,p_expected_updated_at,p_entries);
  -- The validation may wait on roster rows; roll back if kickoff passed while waiting.
  if (public.ff_squad_deadline(p_league)->>'locked')::boolean then
    raise exception 'Squad Locked: a match has started and is awaiting finalization';
  end if;
  return saved;
end $$;
revoke all on function public.save_fantasy_squad_v2(text,text,text,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.save_fantasy_squad_v2(text,text,text,text,timestamptz,jsonb) to authenticated;

alter table public.match_lineups add column match_position text check (match_position in ('GK','DEF','MID','FWD'));
create function public.ff_capture_lineup_position() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  select position into new.match_position from players where id=new.player_id and league_id=new.league_id;
  return new;
end $$;
revoke all on function public.ff_capture_lineup_position() from public,anon,authenticated;
create trigger ff_lineup_position before insert or update of player_id on public.match_lineups
  for each row execute function public.ff_capture_lineup_position();

create function public.ff_assert_lineup_open(p_match text) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare m real_matches%rowtype;
begin
  select * into m from real_matches where id=p_match for update;
  if not found or not (public.is_leader(m.league_id) or public.is_match_organizer(p_match)) then raise insufficient_privilege; end if;
  if m.kick_off<=clock_timestamp() or m.status not in ('draft','rejected') then
    raise exception 'Lineup Locked: the match has started or is under review';
  end if;
end $$;
revoke all on function public.ff_assert_lineup_open(text) from public,anon,authenticated;
alter function public.replace_match_lineup(text,text,jsonb) rename to ff_replace_validated_lineup;
alter function public.clear_match_lineups(text) rename to ff_clear_validated_lineups;
revoke all on function public.ff_replace_validated_lineup(text,text,jsonb),public.ff_clear_validated_lineups(text) from public,anon,authenticated;
create function public.replace_match_lineup(p_match text,p_team text,p_entries jsonb) returns setof public.match_lineups
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.ff_assert_lineup_open(p_match);
  return query select * from public.ff_replace_validated_lineup(p_match,p_team,p_entries);
  perform public.ff_assert_lineup_open(p_match);
end $$;
create function public.clear_match_lineups(p_match text) returns int
language plpgsql security definer set search_path=pg_catalog,public as $$
declare removed int;
begin
  perform public.ff_assert_lineup_open(p_match);
  removed := public.ff_clear_validated_lineups(p_match);
  perform public.ff_assert_lineup_open(p_match);
  return removed;
end $$;
revoke all on function public.replace_match_lineup(text,text,jsonb),public.clear_match_lineups(text) from public,anon,authenticated;
grant execute on function public.replace_match_lineup(text,text,jsonb),public.clear_match_lineups(text) to authenticated;
commit;
