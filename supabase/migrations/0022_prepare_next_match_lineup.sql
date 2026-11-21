begin;

-- Preparations belong to the manager's league membership, never their default
-- squad. They are consumed once, by the first newly scheduled future fixture.
create table public.fantasy_next_lineup_preparations (
  league_id text not null,
  profile_id text not null,
  lineup jsonb not null check (jsonb_typeof(lineup) = 'object'),
  updated_at timestamptz not null,
  primary key (league_id, profile_id),
  constraint fantasy_next_lineup_preparations_member_fk foreign key (league_id, profile_id)
    references public.league_members(league_id,profile_id) on delete cascade
);
alter table public.fantasy_next_lineup_preparations enable row level security;
revoke all on public.fantasy_next_lineup_preparations from public,anon,authenticated;

create function public.ff_attach_prepared_fantasy_lineups() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  -- ff_match_deadline already holds the same league advisory lock as saves.
  -- Never consume a preparation for a backdated fixture or imported result.
  if new.status <> 'approved' and new.kick_off > clock_timestamp()
    and new.kick_off >= (select enabled_at from public.fantasy_lineup_rollout) then
    with prepared as (
      delete from public.fantasy_next_lineup_preparations p where p.league_id=new.league_id
      returning p.profile_id,p.lineup,p.updated_at
    )
    insert into public.fantasy_match_lineup_drafts(match_id,profile_id,lineup,updated_at)
      select new.id,profile_id,lineup,updated_at from prepared;
  end if;
  return new;
end $$;
revoke all on function public.ff_attach_prepared_fantasy_lineups() from public,anon,authenticated;
create trigger ff_attach_prepared_fantasy_lineups after insert on public.real_matches
  for each row execute function public.ff_attach_prepared_fantasy_lineups();

create or replace function public.ff_next_match_lineup(p_league text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare actor text := auth.uid()::text; t timestamptz := statement_timestamp(); m real_matches%rowtype;
  previous jsonb; saved jsonb; preparation jsonb; can_prepare boolean;
begin
  if actor is null or not public.is_member(p_league) then raise insufficient_privilege; end if;
  select * into m from real_matches where league_id=p_league and status <> 'approved'
    and kick_off >= (select enabled_at from fantasy_lineup_rollout)
    order by (kick_off<=t),kick_off,id limit 1;
  can_prepare := m.id is null or m.kick_off<=t;
  previous := public.ff_previous_fantasy_lineup(p_league,actor,t);
  if previous is null then return jsonb_build_object('previous',null,'match',null,'saved',null,'serverNow',t); end if;
  if can_prepare then
    select jsonb_build_object('revision',d.updated_at,'lineup',d.lineup) into preparation
      from fantasy_next_lineup_preparations d where d.league_id=p_league and d.profile_id=actor;
  end if;
  if m.id is not null then
    select jsonb_build_object('revision',d.updated_at,'lineup',d.lineup) into saved
      from fantasy_match_lineup_drafts d where d.match_id=m.id and d.profile_id=actor;
  end if;
  return jsonb_build_object('previous',previous,'serverNow',t,
    'match',case when m.id is not null then jsonb_build_object('id',m.id,'title',m.title,'kickOff',m.kick_off,
      'locked',m.kick_off<=t) end,
    'saved',case when m.id is null then preparation else saved end,
    'preparation',case when m.id is not null then preparation end,'canPrepare',can_prepare);
end $$;
revoke all on function public.ff_next_match_lineup(text) from public,anon,authenticated;
grant execute on function public.ff_next_match_lineup(text) to authenticated;

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
      and (p_captain is null or count(*) filter(where slot='starter' and id=p_captain)=1)
      and (p_vice is null or count(*) filter(where slot='starter' and id=p_vice)=1)
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
  return jsonb_build_object('revision',revision,'lineup',result);
end $$;
revoke all on function public.ff_save_next_match_lineup(text,text,text,text,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.ff_save_next_match_lineup(text,text,text,text,text,timestamptz,jsonb) to authenticated;

commit;
