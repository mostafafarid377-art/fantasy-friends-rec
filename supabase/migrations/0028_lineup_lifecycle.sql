begin;

-- The fantasy lineup lifecycle, end to end.
--
-- Until now a manager's lineup for a match only existed if they opened the
-- app and pressed Save. Everything else fell back to the default squad, so an
-- inherited lineup that nobody touched was never scored, and the lineup that
-- was shown was not the lineup that was scored.
--
-- Three rules hold for every match from here on:
--
--   1. A match always has an effective lineup for every manager. It is the
--      draft they saved for that match, else the lineup that was locked in
--      when the deadline passed, else their last official lineup (inherited
--      exactly, never re-derived), else their default squad.
--   2. The deadline freezes that lineup. `ff_promote_match_lineup` writes the
--      official lineup of a match in one transaction and is idempotent:
--      running it again never changes a lineup that was already locked in.
--   3. A lineup a manager writes always names a captain and a vice-captain.
--      Rows that already exist are left exactly as they are; nothing here
--      invents a captain for a lineup that never had one.
--
-- `ff_effective_fantasy_lineups` is the single resolver used by official
-- scoring, by the live projection and by the lineup in play, so the lineup a
-- manager sees is the lineup that is scored.
--
-- The two long function bodies at the end of this file are copied from the
-- migration that owns them and carry the smallest possible edit. The squad
-- function is the body migration 0009 wrote, under the name migration 0014
-- gave it; the scorer is the body migration 0020 wrote.
-- `scripts/check-0028-parity.mjs` derives them the same way and reports any
-- drift between this file and the migrations it was built from.

-- ------------------------------------------------------------------
-- The resolver
-- ------------------------------------------------------------------

-- The lineup every manager of the match's league uses for that match.
create function public.ff_effective_fantasy_lineups(p_match text)
returns table(profile_id text, lineup jsonb)
language sql stable security definer set search_path=pg_catalog,public as $$
  with m as materialized (
    select r.id,r.league_id,r.kick_off from public.real_matches r where r.id=p_match
  ), members as materialized (
    select lm.profile_id from public.league_members lm join m on m.league_id=lm.league_id
  ), saved as materialized (
    -- The lineup the manager saved for this match.
    select d.profile_id,d.lineup from public.fantasy_match_lineup_drafts d join m on m.id=d.match_id
  ), frozen as materialized (
    -- The lineup that was locked in when the deadline passed.
    select h.profile_id,h.lineup from public.fantasy_match_lineup_history h join m on m.id=h.match_id
  ), carried as materialized (
    -- The last official lineup before this match: inherited exactly.
    select distinct on (h.profile_id) h.profile_id,h.lineup
      from public.fantasy_match_lineup_history h
      join public.real_matches pm on pm.id=h.match_id
      join m on m.league_id=pm.league_id and pm.kick_off < m.kick_off
      join members mb on mb.profile_id=h.profile_id
      order by h.profile_id,pm.kick_off desc,pm.id desc
  ), squad as materialized (
    select s.profile_id,
      jsonb_build_object('formation',s.formation,'captainId',s.captain_id,'viceId',s.vice_captain_id,
        'players',jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name,'position',p.position,'slot',sp.slot,'order',sp."order") order by sp.slot,sp."order",p.id)) as lineup
    from public.fantasy_squads s
    join public.fantasy_squad_players sp on sp.squad_id=s.id
    join public.players p on p.id=sp.player_id and p.league_id=s.league_id
    join m on m.league_id=s.league_id
    group by s.id,s.profile_id
  )
  select mb.profile_id,coalesce(sv.lineup,fz.lineup,cy.lineup,sq.lineup)
  from members mb
  left join saved sv on sv.profile_id=mb.profile_id
  left join frozen fz on fz.profile_id=mb.profile_id
  left join carried cy on cy.profile_id=mb.profile_id
  left join squad sq on sq.profile_id=mb.profile_id
$$;

-- The same lineup for one manager.
create function public.ff_effective_fantasy_lineup(p_match text,p_profile text)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  select l.lineup from public.ff_effective_fantasy_lineups(p_match) l where l.profile_id=p_profile
$$;

-- Where the lineup in play came from, for the interface that shows it.
create function public.ff_fantasy_lineup_source(p_match text,p_profile text)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
  select case
    when exists (select 1 from public.fantasy_match_lineup_drafts d where d.match_id=p_match and d.profile_id=p_profile)
      then 'saved'
    when exists (select 1 from public.fantasy_match_lineup_history h where h.match_id=p_match and h.profile_id=p_profile)
      then 'official'
    when exists (
      select 1 from public.fantasy_match_lineup_history h
      join public.real_matches pm on pm.id=h.match_id
      join public.real_matches m on m.id=p_match
      where h.profile_id=p_profile and pm.league_id=m.league_id and pm.kick_off < m.kick_off
    ) then 'inherited'
    else 'default' end
$$;

revoke all on function public.ff_effective_fantasy_lineups(text),
  public.ff_effective_fantasy_lineup(text,text),public.ff_fantasy_lineup_source(text,text)
  from public,anon,authenticated;

-- ------------------------------------------------------------------
-- The last official lineup
-- ------------------------------------------------------------------

-- An official lineup exists from the moment the deadline passes, not only
-- once the result is approved. A match that is still awaiting its result
-- already froze the lineup its managers used, so it is the lineup the next
-- fixture inherits.
create or replace function public.ff_previous_fantasy_lineup(p_league text,p_actor text,p_before timestamptz)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('matchId',m.id,'title',m.title,'kickOff',m.kick_off,'lineup',h.lineup)
  from public.fantasy_match_lineup_history h join public.real_matches m on m.id=h.match_id
  where m.league_id=p_league and h.profile_id=p_actor and m.kick_off < p_before
  order by m.kick_off desc,m.id desc limit 1
$$;
revoke all on function public.ff_previous_fantasy_lineup(text,text,timestamptz) from public,anon,authenticated;

-- ------------------------------------------------------------------
-- The lineup in play
-- ------------------------------------------------------------------

-- Once a fixture starts, My Team shows the lineup that is actually in play
-- for it. That is the resolved lineup of that match, not a guess.
create or replace function public.ff_in_play_fantasy_lineup(p_league text, p_actor text, p_at timestamptz)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare m real_matches%rowtype; lineup jsonb;
begin
  select * into m from real_matches where league_id=p_league and status <> 'approved'
    and kick_off <= p_at and kick_off >= (select enabled_at from fantasy_lineup_rollout)
    order by kick_off desc,id desc limit 1;
  if m.id is null then return null; end if;
  lineup := public.ff_effective_fantasy_lineup(m.id,p_actor);
  if lineup is null then return null; end if;
  return jsonb_build_object('matchId',m.id,'title',m.title,'kickOff',m.kick_off,'lineup',lineup,
    'source',public.ff_fantasy_lineup_source(m.id,p_actor));
end $$;
revoke all on function public.ff_in_play_fantasy_lineup(text,text,timestamptz) from public,anon,authenticated;

-- ------------------------------------------------------------------
-- The captaincy of a lineup
-- ------------------------------------------------------------------

-- Whether the captaincy of a lineup can be used as it is.
--
-- A lineup a manager writes names a captain and a different vice-captain,
-- and both of them are starters. Lineups that were written before that rule
-- existed may name no captain at all, or only one of the two. Those rows
-- are kept exactly as they are: this never invents a captain for a lineup
-- that never had one.
--
-- The result is false only when the lineup names a captain or a
-- vice-captain that is not one of its starters, or names the same player as
-- both captain and vice-captain. Such a lineup cannot be locked in as an
-- official lineup, and cannot be captured as one either.
create or replace function public.ff_valid_fantasy_captaincy(p_lineup jsonb)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  with c as materialized (
    select nullif(p_lineup->>'captainId','') as captain,nullif(p_lineup->>'viceId','') as vice
  ), starters as materialized (
    select e.id from jsonb_to_recordset(
      case when jsonb_typeof(p_lineup->'players')='array' then p_lineup->'players' else '[]'::jsonb end
    ) e(id text,slot text) where e.slot='starter'
  )
  select p_lineup is not null
    and (c.captain is null or exists (select 1 from starters s where s.id=c.captain))
    and (c.vice is null or exists (select 1 from starters s where s.id=c.vice))
    and (c.captain is null or c.vice is null or c.captain<>c.vice)
  from c;
$$;
revoke all on function public.ff_valid_fantasy_captaincy(jsonb) from public,anon,authenticated;

-- ------------------------------------------------------------------
-- The deadline promotion
-- ------------------------------------------------------------------

-- Lock the lineup of a match in. The lineup is resolved exactly once, at the
-- deadline, and written as the official lineup of that match. Re-running it
-- never overwrites a lineup that was already locked in, so the promotion is
-- safe to repeat and safe to interrupt.
create function public.ff_promote_match_lineup(p_match text)
returns int language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  m public.real_matches%rowtype;
  l public.leagues%rowtype;
  promoted int := 0;
begin
  select * into m from public.real_matches where id=p_match for update;
  if not found or m.status='approved' then return 0; end if;
  if m.kick_off > clock_timestamp() then return 0; end if;
  -- Only fixtures created after the lineup rollout own a fantasy lineup.
  if m.kick_off < (select enabled_at from public.fantasy_lineup_rollout) then return 0; end if;
  -- Serialize with the saves that take the same league deadline lock.
  perform pg_advisory_xact_lock(hashtextextended('ff-deadline:'||m.league_id,0));
  select * into l from public.leagues where id=m.league_id for share;
  if not found then return 0; end if;
  with resolved as materialized (
    select r.profile_id,r.lineup from public.ff_effective_fantasy_lineups(m.id) r
  ), valid as materialized (
    -- Only a lineup that fits the league is an official lineup.
    select res.profile_id,res.lineup from resolved res
    where public.ff_valid_fantasy_captaincy(res.lineup)
      and exists (
        select 1 from jsonb_to_recordset(res.lineup->'players') e(slot text,position text) where e.slot='starter'
        having count(*)=l.starters and count(*) filter(where position='GK')=1
          and concat_ws('-',count(*) filter(where position='DEF'),count(*) filter(where position='MID'),count(*) filter(where position='FWD'))=res.lineup->>'formation'
      )
  )
  insert into public.fantasy_match_lineup_history(match_id,profile_id,lineup)
  select m.id,v.profile_id,v.lineup from valid v
  on conflict(match_id,profile_id) do nothing;
  get diagnostics promoted = row_count;
  return promoted;
end $$;
revoke all on function public.ff_promote_match_lineup(text) from public,anon,authenticated;

-- Promote every match whose deadline has passed and that has no result yet.
create function public.ff_promote_due_match_lineups()
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r record; promoted int := 0; scanned int := 0;
begin
  for r in select id from public.real_matches where status <> 'approved' and kick_off <= clock_timestamp()
    and kick_off >= (select enabled_at from public.fantasy_lineup_rollout)
    order by kick_off,id loop
    scanned := scanned + 1;
    promoted := promoted + public.ff_promote_match_lineup(r.id);
  end loop;
  return jsonb_build_object('matches',scanned,'promoted',promoted,'at',clock_timestamp());
end $$;
revoke all on function public.ff_promote_due_match_lineups() from public,anon,authenticated;

-- The runner only looks at matches that are open and already started.
create index if not exists ff_open_started_match_idx on public.real_matches(kick_off,id)
  where status <> 'approved';

-- ------------------------------------------------------------------
-- The captaincy of a saved lineup
-- ------------------------------------------------------------------

-- A lineup a manager writes names a captain and a different vice-captain.
-- Existing rows keep whatever they have; no captain is ever invented.
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
  if public.ff_previous_fantasy_lineup(p_league,actor,checked_at) is null then raise exception 'No previous saved starting lineup' using errcode='PT409'; end if;
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
  if jsonb_array_length(p_entries) > l.squad_size or exists (
    select 1 from jsonb_to_recordset(p_entries) e(id text,slot text,"order" int)
    where e.id is null or e.slot is null or e.slot not in ('starter','sub','reserve') or e."order" is null or e."order" < 0
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
      and count(*) filter(where slot='reserve')<=l.squad_size-l.starters-l.subs_count
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

-- ------------------------------------------------------------------
-- Scoring and the live projection read the resolver
-- ------------------------------------------------------------------

-- Official scoring and the live projection used to read the draft of a match
-- and fall back to the default squad. They read the resolved lineup now, so
-- an inherited lineup is scored exactly as it was shown.
create or replace function public.ff_score_match(p_match text, p_finalize boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_match     public.real_matches%rowtype;
  v_league    public.leagues%rowtype;
  v_rules_ok  boolean;
  v_players   int;
  v_managers  int;
  v_gameweek  int;
  v_result jsonb;
  v_basis jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_match from public.real_matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if not (public.is_leader(v_match.league_id) or public.is_match_organizer(p_match)) then
    raise exception 'Only the League Leader or Match Organizer can calculate official points';
  end if;
  if v_match.status <> 'approved' then
    raise exception 'Points may only be calculated for approved matches';
  end if;

  select result into v_result from public.match_scoring_receipts where match_id=p_match and match_version=v_match.version;
  if found then return v_result; end if;
  -- Serialize finalization in the same league so simultaneous approvals do not
  -- publish standings computed before the other match's ledger commits.
  perform pg_advisory_xact_lock(hashtextextended('ff-score:' || v_match.league_id,0));

  select * into v_league from public.leagues where id = v_match.league_id;
  if not found then raise exception 'League not found'; end if;

  select count(*) > 0 and bool_and(status = 'approved')
    into v_rules_ok
    from public.scoring_rules where league_id = v_match.league_id;
  if not coalesce(v_rules_ok, false) then
    raise exception 'Scoring rules are still in draft';
  end if;

  perform public.ff_validate_match_extras(p_match);

  -- Snapshot the result-only scoring rules and actual starters/participants
  -- once. Future score edits must not depend on today's rules or roster.
  if v_match.home_score is not null then
    select coalesce(jsonb_agg(to_jsonb(b) order by b.player_id),'[]') into v_basis
    from (
      select l.player_id, l.team_id=v_match.team_a_id as is_home, l.slot='starter' as started,
        max(r.points) filter (where r.event_type='clean_sheet') as clean,
        max(r.points) filter (where r.event_type='win') as win,
        max(r.points) filter (where r.event_type='draw') as draw
      from match_lineups l
      join players p on p.id=l.player_id
      left join scoring_rules r on r.league_id=v_match.league_id and r.position=p.position
        and r.status='approved' and r.event_type in ('clean_sheet','win','draw')
      where l.match_id=p_match and (l.slot='starter' or exists (
        select 1 from match_substitutions s where s.match_id=p_match and s.player_on_id=l.player_id
      ))
      group by l.player_id,l.team_id,l.slot
    ) b;
  end if;

  -- Participants match src/lib/points.ts: starters plus players substituted on.
  with appearance as (
    select player_id from public.match_lineups
     where match_id = p_match and slot = 'starter'
    union
    select player_on_id as player_id from public.match_substitutions
     where match_id = p_match
  ), recorded_events as materialized (
    select e.* from match_events e join appearance a using (player_id) where e.match_id=p_match
  ), event_counts as (
    select player_id,
           count(*) filter (where event_type = 'goal') as goals,
           count(*) filter (where event_type = 'own_goal') as own_goals,
           count(*) filter (where event_type = 'yellow_card') as yellows,
           count(*) filter (where event_type = 'red_card') as reds,
           count(*) filter (where event_type = 'penalty_saved') as penalties_saved,
           count(*) filter (where event_type = 'penalty_missed') as penalties_missed
      from recorded_events
     group by player_id
  ), assist_counts as (
    select player_id, sum(n)::int as assists
      from (
        select player_id, count(*)::int as n
          from recorded_events
         where event_type = 'assist'
         group by player_id
        union all
        select assist_player_id as player_id, count(*)::int as n
          from recorded_events
         where event_type = 'goal'
           and assist_player_id is not null
         group by assist_player_id
      ) a
     group by player_id
  ), team_ids as (
    select unnest(array[v_match.team_a_id,v_match.team_b_id]) as team_id
  ), conceded as (
    select t.team_id,
           count(e.id) filter (
             where (e.event_type = 'goal' and e.team_id <> t.team_id)
                or (e.event_type = 'own_goal' and e.team_id = t.team_id)
           )::int as against
      from team_ids t
      left join recorded_events e on true
     group by t.team_id
  ), lines as (
    select l.player_id,
           p.position,
           l.slot,
           case when c.against < opponent.against then 1 else 0 end as won,
           case when c.against = opponent.against then 1 else 0 end as drawn,
           coalesce(ec.goals, 0)::int as goals,
           coalesce(ac.assists, 0)::int as assists,
           coalesce(ec.own_goals, 0)::int as own_goals,
           coalesce(ec.yellows, 0)::int as yellows,
           coalesce(ec.reds, 0)::int as reds,
           coalesce(ec.penalties_saved, 0)::int as penalties_saved,
           coalesce(ec.penalties_missed, 0)::int as penalties_missed,
           case when coalesce(c.against, 0) = 0 and l.slot = 'starter'
                then 1 else 0 end as clean_sheet
      from public.match_lineups l
      join public.players p on p.id = l.player_id
      join appearance ap on ap.player_id = l.player_id
      left join event_counts ec on ec.player_id = l.player_id
      left join assist_counts ac on ac.player_id = l.player_id
      left join conceded c on c.team_id = l.team_id
      left join conceded opponent on opponent.team_id = case when l.team_id=v_match.team_a_id then v_match.team_b_id else v_match.team_a_id end
     where l.match_id = p_match
  ), components as materialized (
    select x.player_id, x.position, v.category, v.category_order,
           v.event_count as event_count, r.points as points_per,
           case v.category
             when 'appearance' then 'Appearance'
             when 'clean_sheet' then 'Clean sheet'
             when 'goal' then 'Goal'
             when 'assist' then 'Assist'
             when 'own_goal' then 'Own goal'
             when 'yellow_card' then 'Yellow card'
             when 'red_card' then 'Red card'
             when 'penalty_saved' then 'Penalty saved'
             when 'penalty_missed' then 'Penalty missed'
             when 'win' then 'Match win'
             when 'draw' then 'Match draw'
             else v.category
           end as label
      from lines x
      cross join lateral (values
        ('appearance', 1, 1),
        ('clean_sheet', 2, x.clean_sheet),
        ('goal', 3, x.goals),
        ('assist', 4, x.assists),
        ('own_goal', 5, x.own_goals),
        ('yellow_card', 6, x.yellows),
        ('red_card', 7, x.reds),
        ('penalty_saved', 8, x.penalties_saved),
        ('penalty_missed', 9, x.penalties_missed),
        ('win',10,x.won), ('draw',11,x.drawn)
      ) as v(category, category_order, event_count)
      join public.scoring_rules r
        on r.league_id = v_match.league_id
       and r.position = x.position
       and r.event_type = v.category
       and r.status = 'approved'
     where v.event_count > 0 and r.points <> 0
       and (v_basis is null or v.category not in ('clean_sheet','win','draw'))
  ), result_components as (
    select b.player_id, entries.lines,
      (select coalesce(sum((e->>'points')::numeric),0) from jsonb_array_elements(entries.lines) e) as total
    from jsonb_to_recordset(v_basis) b(player_id text,is_home boolean,started boolean,clean numeric,win numeric,draw numeric)
    cross join lateral (select public.ff_result_breakdown(
      case when b.is_home then v_match.home_score else v_match.away_score end,
      case when b.is_home then v_match.away_score else v_match.home_score end,
      b.started,b.clean,b.win,b.draw) as lines) entries
  ), scored as (
    select player_id,
           coalesce(sum(event_count * points_per), 0)::numeric as total,
           coalesce(jsonb_agg(jsonb_build_object(
             'category', category,
             'label', label,
             'count', event_count,
             'pointsPer', points_per,
             'points', event_count * points_per
           ) order by category_order), '[]'::jsonb) as breakdown
      from components
     group by player_id
  )
  insert into public.player_match_points
    (id, league_id, match_id, player_id, match_version, points, breakdown, computed_at)
  select gen_random_uuid()::text, v_match.league_id, p_match, l.player_id,
         v_match.version, coalesce(s.total,0)+coalesce(rc.total,0)
           +(select coalesce(sum((e->>'points')::numeric),0) from jsonb_array_elements(extra.lines) e),
         coalesce(s.breakdown,'[]'::jsonb)||coalesce(rc.lines,'[]'::jsonb)||extra.lines, now()
    from lines l left join scored s on s.player_id=l.player_id
    left join result_components rc on rc.player_id=l.player_id
    cross join lateral (select public.ff_match_extra_breakdown(p_match,l.player_id) as lines) extra
  on conflict (match_id, player_id) do update
    set points = excluded.points,
        breakdown = excluded.breakdown,
        match_version = excluded.match_version,
        computed_at = now();

  get diagnostics v_players = row_count;
  if v_match.home_score is not null then
    perform public.ff_apply_match_bonus(p_match,v_match.league_id,v_match.version);
  end if;

  -- Manager points mirror computeManagerPoints(): the captain doubles only
  -- if they participated; otherwise the vice-captain may inherit the double.
  with appearance as (
    select player_id from public.match_lineups
     where match_id = p_match and slot = 'starter'
    union
    select player_on_id as player_id from public.match_substitutions
     where match_id = p_match
  ), inputs as materialized (
    -- The lineup a manager actually uses for this match: the draft they saved,
    -- else the lineup locked in at the deadline, else the lineup inherited
    -- from their previous official lineup, else their default squad.
    select r.profile_id,r.lineup from public.ff_effective_fantasy_lineups(p_match) r
  ), captured as (
    insert into public.fantasy_match_lineup_history(match_id,profile_id,lineup)
    select p_match,i.profile_id,i.lineup from inputs i
    where p_finalize and v_match.kick_off <= clock_timestamp()
      and v_match.kick_off >= (select enabled_at from public.fantasy_lineup_rollout)
      and public.ff_valid_fantasy_captaincy(i.lineup)
      and exists (
        select 1 from jsonb_to_recordset(i.lineup->'players') e(slot text,position text) where e.slot='starter'
        having count(*)=v_league.starters and count(*) filter(where position='GK')=1
          and concat_ws('-',count(*) filter(where position='DEF'),count(*) filter(where position='MID'),count(*) filter(where position='FWD'))=i.lineup->>'formation'
      )
    on conflict(match_id,profile_id) do nothing
    returning match_id
  ), squads as materialized (
    select i.profile_id,i.lineup->>'captainId' as captain_id,i.lineup->>'viceId' as vice_captain_id,i.lineup->>'formation' as formation,
      jsonb_agg(e.data order by e.priority,e.id) filter (where e.slot='starter') as starters,
      jsonb_agg(e.data order by e.priority,e.id) filter (where e.slot='sub') as bench
    from inputs i
    join lateral (
      select p.id,p.slot,p."order" as priority,
        jsonb_build_object('id',p.id,'name',p.name,'position',p.position,'priority',p."order",'played',ap.player_id is not null) as data
      from jsonb_to_recordset(i.lineup->'players') p(id text,name text,position text,slot text,"order" int)
      left join appearance ap on ap.player_id=p.id where p.slot in ('starter','sub')
    ) e on true
    group by i.profile_id,i.lineup
  ), squad_caps as materialized (
    select s.profile_id,s.starters,
           case when p_finalize then public.ff_auto_substitutions(s.starters,coalesce(s.bench,'[]'),s.formation,v_league.starters)
             else '[]'::jsonb end as substitutions,
           case
             when s.captain_id is not null and exists (
               select 1 from appearance ap where ap.player_id = s.captain_id
             ) and s.starters @> jsonb_build_array(jsonb_build_object('id',s.captain_id)) then s.captain_id
             when v_league.vice_policy = 'auto_captain'
               and s.vice_captain_id is not null and exists (
                 select 1 from appearance ap where ap.player_id = s.vice_captain_id
               ) and s.starters @> jsonb_build_array(jsonb_build_object('id',s.vice_captain_id)) then s.vice_captain_id
             else null
           end as active_captain_id
      from squads s
     where s.starters is not null
  ), manager_lines as (
    select sc.profile_id,sc.active_captain_id,sc.substitutions, effective.player_id,
           coalesce(pmp.points,0) as base,
           case when effective.player_id = sc.active_captain_id then 2 else 1 end as multiplier
    from squad_caps sc cross join lateral jsonb_array_elements(sc.starters) starter
    left join lateral (select value->>'inId' as incoming from jsonb_array_elements(sc.substitutions)
      where value->>'outId'=starter->>'id') swap on true
    cross join lateral (select coalesce(swap.incoming,starter->>'id') as player_id) effective
    left join player_match_points pmp on pmp.match_id=p_match and pmp.player_id=effective.player_id and pmp.match_version=v_match.version
  ), manager_totals as (
    select profile_id, active_captain_id, substitutions,
           coalesce(sum(base * multiplier), 0)::numeric as total,
           coalesce(jsonb_agg(jsonb_build_object(
             'playerId', player_id,
             'base', base,
             'multiplier', multiplier,
             'points', base * multiplier
           ) order by player_id), '[]'::jsonb) as lines
      from manager_lines
     group by profile_id, active_captain_id, substitutions
  )
  insert into public.manager_points
    (id, league_id, match_id, profile_id, match_version, points, breakdown, computed_at)
  select gen_random_uuid()::text, v_match.league_id, p_match, mt.profile_id,
         v_match.version, mt.total,
         jsonb_build_object('lines', mt.lines, 'captainId', mt.active_captain_id, 'substitutions', mt.substitutions), now()
    from manager_totals mt
  on conflict (match_id, profile_id) do update
    set points = excluded.points,
        breakdown = excluded.breakdown,
        match_version = excluded.match_version,
        computed_at = now();

  get diagnostics v_managers = row_count;

  select gameweek into v_gameweek from fantasy_fixtures where id=v_match.fixture_id and league_id=v_match.league_id;
  if v_gameweek is null then
    select coalesce(max(gameweek),1)::int into v_gameweek from fantasy_fixtures where league_id=v_match.league_id;
  end if;

  insert into public.fantasy_points_history
    (id, league_id, profile_id, match_id, gameweek, points, created_at)
  select gen_random_uuid()::text, v_match.league_id, mp.profile_id,
         p_match, v_gameweek, mp.points, now()
    from public.manager_points mp
   where mp.match_id = p_match and mp.league_id = v_match.league_id
  on conflict (profile_id, match_id) do update
    set points = excluded.points, gameweek = excluded.gameweek;

  perform public.recalculate_standings(v_match.league_id);

  v_result := jsonb_build_object('players',v_players,'managers',v_managers,'matchId',p_match,'version',v_match.version);
  if p_finalize then
    insert into match_scoring_receipts(match_id,match_version,result,result_basis) values(p_match,v_match.version,v_result,v_basis)
      on conflict (match_id) do update set match_version=excluded.match_version,result=excluded.result,result_basis=excluded.result_basis;
  end if;
  return v_result;
end;
$$;

create or replace function public.ff_live_manager_points_from_live(p_live jsonb, p_league text, p_profile text)
returns table(profile_id text, match_id text, points numeric, breakdown jsonb, computed_at timestamptz)
language sql stable security definer set search_path=pg_catalog,public as $$
  with live as materialized (
    select l.match_id,l.player_id,l.points
    from jsonb_to_recordset(p_live) l(match_id text,player_id text,points numeric)
  ),
  matches as (
    select m.id,m.kick_off from real_matches m where m.id in (select l.match_id from live l)
  ),
  starters as (
    -- Same input precedence as official scoring: the shared resolver returns
    -- the lineup each manager actually uses for this match.
    select m.id as match_id,r.profile_id,e.id as player_id,r.lineup->>'captainId' as captain,r.lineup->>'viceId' as vice
    from matches m join public.ff_effective_fantasy_lineups(m.id) r on true
    cross join lateral jsonb_to_recordset(r.lineup->'players') e(id text,slot text) where e.slot='starter'
  ),
  -- A null scope means every manager, which is what the standings table needs.
  scoped as (
    select s.* from starters s where p_profile is null or s.profile_id=p_profile
  ),
  captaincy as (
    select s.profile_id,s.match_id,
      coalesce(max(s.player_id) filter (where s.player_id=s.captain),max(s.player_id) filter (where s.player_id=s.vice and l.vice_policy='auto_captain')) as captain
    from scoped s join leagues l on l.id=p_league
    where exists (select 1 from match_lineups r where r.match_id=s.match_id and r.player_id=s.player_id and r.slot='starter')
       or exists (select 1 from match_substitutions r where r.match_id=s.match_id and r.player_on_id=s.player_id)
    group by s.profile_id,s.match_id
  ),
  lines as (
    select s.profile_id,s.match_id,s.player_id,l.points as base,c.captain,
      case when s.player_id=c.captain then 2 else 1 end as multiplier
    from scoped s join live l using(match_id,player_id) left join captaincy c using(profile_id,match_id)
  )
  select l.profile_id,l.match_id,sum(l.base*l.multiplier),jsonb_build_object('captainId',l.captain,
    'lines',jsonb_agg(jsonb_build_object('playerId',l.player_id,'base',l.base,'multiplier',l.multiplier,
      'points',l.base*l.multiplier) order by l.player_id)),m.kick_off
  from lines l join matches m on m.id=l.match_id group by l.profile_id,l.match_id,l.captain,m.kick_off;
$$;

-- ------------------------------------------------------------------
-- The deadline runner
-- ------------------------------------------------------------------

-- The promotion has to happen even when nobody opens the app, so it runs on
-- the database itself through pg_cron, every five minutes. Where the
-- extension is not available the migration still applies, and the lineup a
-- match is scored with is still the resolved one: the resolver falls back to
-- the previous official lineup, so nothing is lost, only the official row is
-- written later, when the result is scored.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name='pg_cron') then
    raise notice 'pg_cron is not available: the lineup deadline promotion runs when the match is scored.';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron could not be installed: %', sqlerrm;
    return;
  end;
  begin
    perform cron.unschedule('ff-lineup-deadlines');
  exception when others then
    null; -- the job does not exist yet
  end;
  perform cron.schedule('ff-lineup-deadlines','*/5 * * * *','select public.ff_promote_due_match_lineups()');
exception when others then
  raise notice 'The lineup deadline promotion could not be scheduled: %', sqlerrm;
end $$;

-- PostgREST caches the database schema. Reload it so the new functions are
-- visible to the API.
notify pgrst, 'reload schema';

commit;
