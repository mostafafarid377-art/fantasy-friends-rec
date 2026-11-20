-- Keep the historical default/maximum of 15, but allow smaller league squads.
-- NOT VALID preserves any legacy rows whose independently editable limits were
-- already inconsistent; subsequent settings writes must use coherent limits.
alter table public.leagues drop constraint leagues_squad_ck,
  add constraint leagues_squad_ck check (squad_size >= starters + subs_count and squad_size <= 15) not valid;

-- One authenticated, league-scoped write path. Keep the existing read RLS and
-- data; legacy formation labels are interpreted from player positions on read.
create function public.save_fantasy_squad_v2(
  p_league text, p_formation text, p_captain text, p_vice text,
  p_expected_updated_at timestamptz, p_entries jsonb
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  actor text := auth.uid()::text;
  settings public.leagues%rowtype;
  saved public.fantasy_squads%rowtype;
  total int; selected_count int; starters int; subs int; reserves int;
  keepers int; defenders int; mids int; forwards int;
  shape int[];
  is_complete boolean;
  entries jsonb;
begin
  if actor is null then raise insufficient_privilege; end if;
  select * into settings from public.leagues where id = p_league for share;
  if not found then raise insufficient_privilege; end if;
  perform 1 from public.league_members where league_id = p_league and profile_id = actor for share;
  if not found then raise insufficient_privilege; end if;
  -- Also serializes first-time writes, before a squad row exists to lock.
  perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array('squad-v2', p_league, actor)::text, 0));
  select * into saved from public.fantasy_squads where league_id = p_league and profile_id = actor for update;
  if saved.updated_at is distinct from p_expected_updated_at then
    raise exception 'Squad changed since it was opened. Reload before saving.' using errcode = 'PT409';
  end if;
  if settings.starters is distinct from (case settings.format when '5v5' then 5 when '7v7' then 7 end)
      or settings.subs_count < 0 or settings.starters + settings.subs_count > settings.squad_size then
    raise exception 'Invalid league squad settings' using errcode = '22023';
  end if;
  if p_formation is null or p_formation !~ '^[0-6]-[0-6]-[0-6]$' then
    raise exception 'Invalid formation' using errcode = '22023';
  end if;
  shape := string_to_array(p_formation, '-')::int[];
  if shape[1] + shape[2] + shape[3] <> settings.starters - 1 then
    raise exception 'Formation does not match league format' using errcode = '22023';
  end if;
  if jsonb_typeof(p_entries) is distinct from 'array' then raise exception 'Expected a squad list' using errcode = '22023'; end if;
  total := jsonb_array_length(p_entries);
  if total > settings.squad_size or (saved.id is null and total = 0) then
    raise exception 'Invalid squad size' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_entries) e(player_id text, slot text, "order" int)
      where e.player_id is null or e.slot is null or e.slot not in ('starter','sub','reserve') or e."order" is null or e."order" < 0)
      or total <> (select count(distinct e.player_id) from jsonb_to_recordset(p_entries) e(player_id text)) then
    raise exception 'Invalid or duplicate squad entries' using errcode = '22023';
  end if;

  with selected as materialized (
    select e.slot, p.position from jsonb_to_recordset(p_entries) e(player_id text, slot text)
    join public.players p on p.id = e.player_id and p.league_id = p_league and p.status = 'active'
    order by p.id for share of p
  )
  select count(*), count(*) filter (where slot='starter'), count(*) filter (where slot='sub'), count(*) filter (where slot='reserve'),
    count(*) filter (where slot='starter' and position='GK'), count(*) filter (where slot='starter' and position='DEF'),
    count(*) filter (where slot='starter' and position='MID'), count(*) filter (where slot='starter' and position='FWD')
    into selected_count, starters, subs, reserves, keepers, defenders, mids, forwards from selected;
  if selected_count <> total then raise exception 'Squad players must be active in this league' using errcode = '22023'; end if;
  if starters > settings.starters or subs > settings.subs_count or reserves > settings.squad_size-settings.starters-settings.subs_count
      or keepers > 1 or (starters = settings.starters and keepers <> 1)
      or defenders > shape[1] or mids > shape[2] or forwards > shape[3] then
    raise exception 'Squad positions or slot counts do not fit this league' using errcode = '22023';
  end if;
  if (p_captain is not null and p_captain = p_vice)
      or (p_captain is not null and not exists (select 1 from jsonb_to_recordset(p_entries) e(player_id text,slot text) where e.player_id=p_captain and e.slot='starter'))
      or (p_vice is not null and not exists (select 1 from jsonb_to_recordset(p_entries) e(player_id text,slot text) where e.player_id=p_vice and e.slot='starter')) then
    raise exception 'Captain and vice must be distinct starters' using errcode = '22023';
  end if;
  is_complete := total = settings.squad_size and starters = settings.starters and subs = settings.subs_count and keepers = 1;
  insert into public.fantasy_squads(id, league_id, profile_id, formation, captain_id, vice_captain_id, completed_at, updated_at)
    values (gen_random_uuid()::text, p_league, actor, p_formation, p_captain, p_vice,
      case when is_complete then clock_timestamp() end, clock_timestamp())
    on conflict (league_id, profile_id) do update set formation=excluded.formation, captain_id=excluded.captain_id,
      vice_captain_id=excluded.vice_captain_id,
      completed_at=case when is_complete then coalesce(fantasy_squads.completed_at, excluded.completed_at) end,
      updated_at=excluded.updated_at returning * into strict saved;

  delete from public.fantasy_squad_players sp where sp.squad_id = saved.id
    and not exists (select 1 from jsonb_to_recordset(p_entries) e(player_id text) where e.player_id = sp.player_id);
  insert into public.fantasy_squad_players as sp(id, squad_id, player_id, slot, "order")
    select gen_random_uuid()::text, saved.id, e.player_id, e.slot, e."order"
    from jsonb_to_recordset(p_entries) e(player_id text, slot text, "order" int)
    on conflict (squad_id, player_id) do update set slot=excluded.slot, "order"=excluded."order"
      where (sp.slot, sp."order") is distinct from (excluded.slot, excluded."order");
  select coalesce(jsonb_agg(to_jsonb(sp) order by sp."order", sp.player_id), '[]') into entries
    from public.fantasy_squad_players sp where sp.squad_id = saved.id;
  return jsonb_build_object('squad', to_jsonb(saved), 'entries', entries);
end;
$$;

revoke all on function public.save_fantasy_squad_v2(text,text,text,text,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.save_fantasy_squad_v2(text,text,text,text,timestamptz,jsonb) to authenticated;
revoke execute on function public.save_fantasy_squad(text,text,text,text,boolean,jsonb) from public, anon, authenticated;
revoke insert, delete, update on public.fantasy_squads, public.fantasy_squad_players from public, anon, authenticated;
revoke update (formation, captain_id, vice_captain_id, completed_at, updated_at) on public.fantasy_squads from authenticated;
revoke update (slot, "order") on public.fantasy_squad_players from authenticated;

-- Read the match and its points in one snapshot. Do not fall back to an older
-- match or a stale version if the latest approved match has no current score.
create index if not exists matches_latest_approved_idx on public.real_matches(league_id, kick_off desc, id desc) where status = 'approved';
create function public.last_game_points(p_league text)
returns table ("matchId" text, title text, points numeric)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select m.id, m.title, mp.points
  from (
    select id, title, version from public.real_matches
    where league_id = p_league and status = 'approved' and public.is_member(p_league)
    order by kick_off desc, id desc limit 1
  ) m
  left join public.manager_points mp on mp.match_id = m.id and mp.league_id = p_league
    and mp.profile_id = auth.uid()::text and mp.match_version = m.version;
$$;
revoke all on function public.last_game_points(text) from public, anon, authenticated;
grant execute on function public.last_game_points(text) to authenticated;
