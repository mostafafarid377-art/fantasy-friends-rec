-- 0035: a complete squad's starting lineup must cover every outfield line.
--
-- Rule: every newly saved complete squad starts at least one Forward, one
-- Midfielder and one Defender. Only starters count — a Forward on the bench
-- or in the reserves does not satisfy the rule. Zero-line formations stay
-- selectable while drafting, but a complete squad cannot be saved with an
-- empty starting line.
--
-- Why here: the API route validates this before calling the RPC, but
-- save_fantasy_squad_v2 is executable by any authenticated league member, so
-- the database stays the final authority. The check fires only when the squad
-- becomes complete (is_complete), exactly like the captaincy rule below it:
-- partial drafts remain saveable while they are being built, and squads saved
-- before this rule are never re-validated — they stay readable and keep
-- feeding historical lineups unchanged. Player positions themselves are
-- untouched (the players_position_ck constraint already restricts them to
-- GK/DEF/MID/FWD, so no stored value needs mapping).
--
-- The function body is the 0028 definition verbatim plus the
-- is_complete-gated check (reusing the existing starter counters). Rollback:
-- recreate the function without the check (see 0028_lineup_lifecycle.sql).

create or replace function public.ff_save_validated_squad(
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
  if exists (
    select 1 from (
      select e."order", case when p.position='GK' then 0 else row_number() over (partition by (p.position='GK') order by e."order",p.id) end as priority
      from jsonb_to_recordset(p_entries) e(player_id text,slot text,"order" int)
      join players p on p.id=e.player_id where e.slot='sub'
    ) b where b."order" <> b.priority
  ) or (select count(*) from jsonb_to_recordset(p_entries) e(player_id text,slot text) join players p on p.id=e.player_id
    where e.slot='sub' and p.position='GK') > 1
  or (select count(*) from jsonb_to_recordset(p_entries) e(player_id text,slot text) join players p on p.id=e.player_id
    where e.slot='sub' and p.position<>'GK') > greatest(0,settings.subs_count-1) then
    raise exception 'Bench must reserve position zero for the goalkeeper, followed by ordered outfield substitutes' using errcode='22023';
  end if;

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
  if is_complete and (p_captain is null or p_vice is null) then
    raise exception 'A complete squad needs a captain and a vice-captain' using errcode = '22023';
  end if;
  -- Starting-lineup coverage: defenders/mids/forwards count starters only.
  if is_complete and (forwards = 0 or mids = 0 or defenders = 0) then
    raise exception 'Your starting lineup must contain at least 1 Forward, 1 Midfielder, and 1 Defender. Missing: %.',
      concat_ws(', ',
        case when forwards = 0 then 'Forward' end,
        case when mids = 0 then 'Midfielder' end,
        case when defenders = 0 then 'Defender' end)
      using errcode = '22023';
  end if;
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
