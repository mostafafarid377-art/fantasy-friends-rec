-- 0036: retire the fantasy reserve slot. A squad is starters plus
-- substitutes — nothing else.
--
-- The reserve tier never played, never scored and never auto-subbed; it was
-- a third storage group between the bench and the player pool. The app no
-- longer offers it, so the database — the final authority on squad writes —
-- stops accepting it here:
--
--   * Entries with slot 'reserve' are rejected like any other invalid slot.
--   * The slot caps are the exact group sizes: starters and subs_count. The
--     old headroom (squad_size - starters - subs_count) is gone, and with it
--     every use of the legacy squad_size column in squad validation. That
--     column stays on the leagues row (the real-team match lineup writer
--     still uses it as its upper bound, and historical rows keep it), but
--     the fantasy squad no longer derives anything from it.
--   * A complete squad is exactly starters + subs_count players (5v5: 10,
--     7v7: 12): is_complete now compares the total against that sum.
--
-- Legacy data: squads that still hold reserve players keep those rows —
-- nothing is deleted or rewritten here. The squad read in the app simply
-- skips reserve slots, and the manager's next save replaces the entry list
-- without them (the delete-by-diff below then removes only what the new
-- list omits, exactly as it does for any dropped player). Historical match
-- lineups and snapshots are jsonb copies and are untouched.
--
-- Both function bodies are their latest definitions verbatim except for the
-- reserve removal: ff_save_validated_squad is the 0035 body (so the
-- is_complete-gated starting-lineup coverage rule, the bench rule, the
-- captaincy checks and the PT409 optimistic lock all carry over unchanged)
-- and ff_save_next_match_lineup is the 0030 body. Rollback: recreate both
-- from 0035_squad_position_coverage.sql and 0030_next_match_lineup_availability.sql.

create or replace function public.ff_save_validated_squad(
  p_league text, p_formation text, p_captain text, p_vice text,
  p_expected_updated_at timestamptz, p_entries jsonb
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  actor text := auth.uid()::text;
  settings public.leagues%rowtype;
  saved public.fantasy_squads%rowtype;
  total int; selected_count int; starters int; subs int;
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
  if total > settings.starters + settings.subs_count or (saved.id is null and total = 0) then
    raise exception 'Invalid squad size' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_entries) e(player_id text, slot text, "order" int)
      where e.player_id is null or e.slot is null or e.slot not in ('starter','sub') or e."order" is null or e."order" < 0)
      or total <> (select count(distinct e.player_id) from jsonb_to_recordset(p_entries) e(player_id text)) then
    raise exception 'Invalid or duplicate squad entries' using errcode = '22023';
  end if;

  with selected as materialized (
    select e.slot, p.position from jsonb_to_recordset(p_entries) e(player_id text, slot text)
    join public.players p on p.id = e.player_id and p.league_id = p_league and p.status = 'active'
    order by p.id for share of p
  )
  select count(*), count(*) filter (where slot='starter'), count(*) filter (where slot='sub'),
    count(*) filter (where slot='starter' and position='GK'), count(*) filter (where slot='starter' and position='DEF'),
    count(*) filter (where slot='starter' and position='MID'), count(*) filter (where slot='starter' and position='FWD')
    into selected_count, starters, subs, keepers, defenders, mids, forwards from selected;
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

  if starters > settings.starters or subs > settings.subs_count
      or keepers > 1 or (starters = settings.starters and keepers <> 1)
      or defenders > shape[1] or mids > shape[2] or forwards > shape[3] then
    raise exception 'Squad positions or slot counts do not fit this league' using errcode = '22023';
  end if;
  if (p_captain is not null and p_captain = p_vice)
      or (p_captain is not null and not exists (select 1 from jsonb_to_recordset(p_entries) e(player_id text,slot text) where e.player_id=p_captain and e.slot='starter'))
      or (p_vice is not null and not exists (select 1 from jsonb_to_recordset(p_entries) e(player_id text,slot text) where e.player_id=p_vice and e.slot='starter')) then
    raise exception 'Captain and vice must be distinct starters' using errcode = '22023';
  end if;
  is_complete := total = settings.starters + settings.subs_count and starters = settings.starters and subs = settings.subs_count and keepers = 1;
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

create or replace function public.ff_save_next_match_lineup(p_league text,p_match text,p_formation text,p_captain text,p_vice text,
  p_expected_updated_at timestamptz,p_entries jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor text := auth.uid()::text; m real_matches%rowtype; l leagues%rowtype;
  revision timestamptz; checked_at timestamptz; entries jsonb; shape int[]; result jsonb;
begin
  if actor is null or not public.is_member(p_league) then raise insufficient_privilege; end if;
  -- Lock in the same order as match approval and league-wide squad saves.
  if p_match is not null then
    select * into m from real_matches where id=p_match and league_id=p_league for update;
    if not found then raise insufficient_privilege; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ff-deadline:'||p_league,0));
  perform 1 from league_members where league_id=p_league and profile_id=actor for share;
  if not found then raise insufficient_privilege; end if;
  checked_at := clock_timestamp();
  if (p_match is not null and (m.kick_off <= checked_at or m.status='approved')) or p_match is distinct from (
    select id from real_matches where league_id=p_league and status <> 'approved'
      and kick_off > checked_at and kick_off >= (select enabled_at from fantasy_lineup_rollout) order by kick_off,id limit 1
  ) then raise exception 'This lineup is locked or the next match has changed. Reload before saving.' using errcode='PT409'; end if;
  if p_match is null then
    select updated_at into revision from fantasy_next_lineup_preparations where league_id=p_league and profile_id=actor;
  else
    select updated_at into revision from fantasy_match_lineup_drafts where match_id=m.id and profile_id=actor;
  end if;
  if revision is distinct from p_expected_updated_at then
    raise exception 'This lineup changed since it was opened. Reload before saving.' using errcode='PT409';
  end if;
  select * into strict l from leagues where id=p_league for share;
  if p_formation is null or p_formation !~ '^[0-6]-[0-6]-[0-6]$' then raise exception 'Invalid formation' using errcode='22023'; end if;
  shape := string_to_array(p_formation,'-')::int[];
  if shape[1]+shape[2]+shape[3] <> l.starters-1 or jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'Invalid lineup for this league' using errcode='22023'; end if;
  if jsonb_array_length(p_entries) > l.starters + l.subs_count or exists (
    select 1 from jsonb_to_recordset(p_entries) e(id text,slot text,"order" int)
    where e.id is null or e.slot is null or e.slot not in ('starter','sub') or e."order" is null or e."order" < 0
  ) or jsonb_array_length(p_entries) <> (select count(distinct id) from jsonb_to_recordset(p_entries) e(id text)) then
    raise exception 'Invalid or duplicate lineup entries' using errcode='22023'; end if;
  with selected as materialized (
    select p.id,p.full_name as name,p.position,e.slot,e."order"
    from jsonb_to_recordset(p_entries) e(id text,slot text,"order" int)
    join players p on p.id=e.id and p.league_id=p_league and p.status='active' order by p.id for share of p
  ) select coalesce(jsonb_agg(to_jsonb(selected) order by slot,"order",id),'[]') into entries from selected;
  if p_captain is null or p_vice is null then
    raise exception 'Choose a captain and a vice-captain for this lineup' using errcode='22023';
  end if;
  if p_captain=p_vice then
    raise exception 'Captain and vice-captain must be different players' using errcode='22023';
  end if;
  if jsonb_array_length(entries) <> jsonb_array_length(p_entries) or not exists (
    select 1 from jsonb_to_recordset(entries) e(id text,position text,slot text,"order" int)
    having count(*) filter(where slot='starter')=l.starters
      and count(*) filter(where slot='starter' and position='GK')=1
      and count(*) filter(where slot='starter' and position='DEF')=shape[1]
      and count(*) filter(where slot='starter' and position='MID')=shape[2]
      and count(*) filter(where slot='starter' and position='FWD')=shape[3]
      and count(*) filter(where slot='sub' and position='GK')<=least(1,l.subs_count)
      and count(*) filter(where slot='sub' and position<>'GK')<=greatest(0,l.subs_count-1)
      and count(*) filter(where slot='starter' and id=p_captain)=1
      and count(*) filter(where slot='starter' and id=p_vice)=1
  ) or (p_captain is not null and p_captain=p_vice) or exists (
    select 1 from (
      select e."order",case when e.position='GK' then 0 else row_number() over(partition by (e.position='GK') order by e."order",e.id) end as priority
      from jsonb_to_recordset(entries) e(id text,position text,slot text,"order" int) where e.slot='sub'
    ) b where b."order"<>b.priority
  ) then raise exception 'Selected players, captaincy or bench order do not fit this lineup' using errcode='22023'; end if;
  result := jsonb_build_object('formation',p_formation,'captainId',p_captain,'viceId',p_vice,'players',entries);
  revision := clock_timestamp();
  if p_match is null then
    insert into fantasy_next_lineup_preparations(league_id,profile_id,lineup,updated_at)
      values(p_league,actor,result,revision)
      on conflict(league_id,profile_id) do update set lineup=excluded.lineup,updated_at=excluded.updated_at;
  else
    insert into fantasy_match_lineup_drafts(match_id,profile_id,lineup,updated_at)
      values(m.id,actor,result,revision)
      on conflict(match_id,profile_id) do update set lineup=excluded.lineup,updated_at=excluded.updated_at;
    if clock_timestamp() >= m.kick_off then raise exception 'Kickoff has passed. This lineup is locked.' using errcode='PT409'; end if;
  end if;
  return jsonb_build_object('revision',revision,'lineup',result,'matchId',m.id);
end $$;
