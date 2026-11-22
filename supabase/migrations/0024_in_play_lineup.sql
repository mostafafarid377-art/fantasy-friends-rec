begin;

-- Once a fixture starts, My Team shows the lineup that is actually in play for
-- it instead of the previous verified result. The saved match lineup wins;
-- otherwise the default squad (the same input official scoring uses) is shown.
-- Only forward fixtures created after the lineup rollout qualify.
create function public.ff_in_play_fantasy_lineup(p_league text, p_actor text, p_at timestamptz)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare m real_matches%rowtype; draft jsonb; fallback jsonb;
begin
  select * into m from real_matches where league_id=p_league and status <> 'approved'
    and kick_off <= p_at and kick_off >= (select enabled_at from fantasy_lineup_rollout)
    order by kick_off desc,id desc limit 1;
  if m.id is null then return null; end if;
  select d.lineup into draft from fantasy_match_lineup_drafts d
    where d.match_id=m.id and d.profile_id=p_actor;
  if draft is not null then
    return jsonb_build_object('matchId',m.id,'title',m.title,'kickOff',m.kick_off,'lineup',draft,'source','saved');
  end if;
  select jsonb_build_object('formation',s.formation,'captainId',s.captain_id,'viceId',s.vice_captain_id,
    'players',jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name,'position',p.position,'slot',sp.slot,
      'order',sp."order") order by sp.slot,sp."order",p.id))
  into fallback
  from fantasy_squads s
  join fantasy_squad_players sp on sp.squad_id=s.id
  join players p on p.id=sp.player_id and p.league_id=p_league
  where s.league_id=p_league and s.profile_id=p_actor
  group by s.id;
  if fallback is null then return null; end if;
  return jsonb_build_object('matchId',m.id,'title',m.title,'kickOff',m.kick_off,'lineup',fallback,'source','default');
end $$;
revoke all on function public.ff_in_play_fantasy_lineup(text,text,timestamptz) from public,anon,authenticated;

create or replace function public.ff_next_match_lineup(p_league text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare actor text := auth.uid()::text; t timestamptz := statement_timestamp(); m real_matches%rowtype;
  previous jsonb; saved jsonb; preparation jsonb; can_prepare boolean; in_play jsonb;
begin
  if actor is null or not public.is_member(p_league) then raise insufficient_privilege; end if;
  select * into m from real_matches where league_id=p_league and status <> 'approved'
    and kick_off >= (select enabled_at from fantasy_lineup_rollout)
    order by (kick_off<=t),kick_off,id limit 1;
  can_prepare := m.id is null or m.kick_off<=t;
  previous := public.ff_previous_fantasy_lineup(p_league,actor,t);
  in_play := public.ff_in_play_fantasy_lineup(p_league,actor,t);
  if previous is null then
    return jsonb_build_object('previous',null,'match',null,'saved',null,'inPlay',in_play,'serverNow',t);
  end if;
  if can_prepare then
    select jsonb_build_object('revision',d.updated_at,'lineup',d.lineup) into preparation
      from fantasy_next_lineup_preparations d where d.league_id=p_league and d.profile_id=actor;
  end if;
  if m.id is not null then
    select jsonb_build_object('revision',d.updated_at,'lineup',d.lineup) into saved
      from fantasy_match_lineup_drafts d where d.match_id=m.id and d.profile_id=actor;
  end if;
  return jsonb_build_object('previous',previous,'serverNow',t,
    'inPlay',in_play,
    'match',case when m.id is not null then jsonb_build_object('id',m.id,'title',m.title,'kickOff',m.kick_off,
      'locked',m.kick_off<=t) end,
    'saved',case when m.id is null then preparation else saved end,
    'preparation',case when m.id is not null then preparation end,'canPrepare',can_prepare);
end $$;
revoke all on function public.ff_next_match_lineup(text) from public,anon,authenticated;
grant execute on function public.ff_next_match_lineup(text) to authenticated;

commit;
