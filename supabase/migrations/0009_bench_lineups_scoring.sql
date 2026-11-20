-- Forward-only: no historical league, scoring rule, lineup or points rows are changed.
begin;

create or replace function public.initialize_scoring_rules(p_league text)
returns setof public.scoring_rules language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if auth.uid() is null or not public.is_leader(p_league) then raise insufficient_privilege; end if;
  insert into scoring_rules(id, league_id, position, event_type, points, status)
    select gen_random_uuid()::text, p_league, pos, event, points, 'draft'
    from (values ('goal',10,6,5,4),('own_goal',-2,-2,-2,-2),('assist',3,3,3,3),
      ('yellow_card',-1,-1,-1,-1),('red_card',-3,-3,-3,-3),('penalty_saved',5,3,3,3),
      ('penalty_missed',-1,-1,-1,-1),('appearance',1,1,1,1),('clean_sheet',4,4,1,0),
      ('win',0,0,0,0),('draw',0,0,0,0)) d(event,gk,def,mid,fwd)
    cross join lateral (values ('GK',d.gk),('DEF',d.def),('MID',d.mid),('FWD',d.fwd)) r(pos,points)
    on conflict (league_id,position,event_type) do nothing;
  return query select * from scoring_rules where league_id=p_league order by event_type,position;
end;
$$;

create or replace function public.create_league(
  p_name text,
  p_description text default null,
  p_format text default '5v5',
  p_starters integer default 5,
  p_subs_count integer default 5,
  p_team_name text default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_league_id text;
  v_invite_code text;
  v_profile text := auth.uid()::text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Generate a unique invite code
  select gen_random_uuid()::text into v_invite_code;
  -- Use first 8 alphanumeric chars (Crockford-ish, no ambiguous chars)
  select upper(regexp_replace(v_invite_code, '[^A-Z0-9]', '', 'g')) into v_invite_code;
  v_invite_code := left(v_invite_code, 8);

  -- Insert the league
  insert into public.leagues (
    id, name, description, format, starters, subs_count, invite_code,
    vice_policy, created_by, created_at, updated_at
  )
  values (
    gen_random_uuid()::text, p_name, p_description, p_format,
    p_starters, p_subs_count, v_invite_code,
    'auto_captain', v_profile, now(), now()
  )
  returning id into v_league_id;

  -- Insert leader membership
  insert into public.league_members (
    id, league_id, profile_id, role, team_name, created_at
  )
  values (
    gen_random_uuid()::text, v_league_id, v_profile, 'leader',
    coalesce(p_team_name, 'Leader XI'), now()
  );

  -- Insert standings entry
  insert into public.league_standings (
    id, league_id, profile_id, rank, prev_rank, total_points,
    matches_played, form, updated_at
  )
  values (
    gen_random_uuid()::text, v_league_id, v_profile, 1, null, 0,
    0, '[]'::jsonb, now()
  );

  -- Log activity
  insert into public.league_activity (
    id, league_id, profile_id, action, summary, meta, created_at
  )
  values (
    gen_random_uuid()::text, v_league_id, v_profile, 'league.created',
    'League created', jsonb_build_object('format', p_format, 'name', p_name), now()
  );

  perform public.initialize_scoring_rules(v_league_id);
  return v_league_id;
end;
$$;

create or replace function public.create_league_confirmed(
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
  insert into mutation_ops(id, profile_id, route, request_hash, status, result, applied_at)
    values (receipt, actor, 'create_league_confirmed', receipt, 'applied', jsonb_build_object('id',league_key), now());
  return league_key;
end;
$$;

create or replace function public.replace_match_lineup(p_match text, p_team text, p_entries jsonb)
returns setof public.match_lineups language plpgsql security definer set search_path = pg_catalog, public as $$
declare m real_matches%rowtype; l leagues%rowtype; n int; valid int; starters int; keepers int; bench int;
begin
  select * into m from real_matches where id=p_match for update;
  if auth.uid() is null or not found or not (public.is_leader(m.league_id) or public.is_match_organizer(p_match)) then
    raise insufficient_privilege;
  end if;
  if m.status not in ('draft','rejected') then raise exception 'Lineups are locked'; end if;
  if p_team is null or p_team not in (m.team_a_id,m.team_b_id) or not exists
    (select 1 from teams where id=p_team and league_id=m.league_id for share) then
    raise exception 'Team is not part of this match' using errcode='22023';
  end if;
  select * into strict l from leagues where id=m.league_id for share;
  if l.starters is distinct from (case l.format when '5v5' then 5 when '7v7' then 7 end) then
    raise exception 'The league starter count does not match its format' using errcode='22023';
  end if;
  if jsonb_typeof(p_entries) is distinct from 'array' then raise exception 'Expected a lineup list' using errcode='22023'; end if;
  n := jsonb_array_length(p_entries);
  if n > l.squad_size or n < l.starters or exists (
    select 1 from jsonb_to_recordset(p_entries) e(player_id text, slot text, "order" int)
    where e.player_id is null or e.slot is null or e.slot not in ('starter','sub') or e."order" is null or e."order" < 0 or e."order" >= n
  ) or n <> (select count(distinct e.player_id) from jsonb_to_recordset(p_entries) e(player_id text)) or exists (
    select 1 from jsonb_to_recordset(p_entries) e(slot text, "order" int) group by slot
    having count(distinct "order") <> count(*) or min("order") <> 0 or max("order") <> count(*)-1
  ) then raise exception 'Invalid or duplicate lineup entries' using errcode='22023'; end if;

  with eligible as materialized (
    select e.slot,p.position from jsonb_to_recordset(p_entries) e(player_id text,slot text)
    join players p on p.id=e.player_id and p.league_id=m.league_id and p.team_id=p_team
      and p.status='active' and p.availability in ('available','doubt')
    order by p.id for share of p
  ) select count(*),count(*) filter (where slot='starter'),count(*) filter (where slot='starter' and position='GK'),count(*) filter (where slot='sub')
    into valid,starters,keepers,bench from eligible;
  if valid <> n then raise exception 'A selected player is unavailable or not part of this match team' using errcode='22023'; end if;
  if starters <> l.starters or keepers <> 1 or bench > l.subs_count then
    raise exception 'Select exactly % starters, including one goalkeeper, and at most % substitutes', l.starters,l.subs_count using errcode='22023';
  end if;
  if exists (select 1 from match_lineups old join jsonb_to_recordset(p_entries) e(player_id text) on e.player_id=old.player_id
             where old.match_id=p_match and old.team_id<>p_team) then
    raise exception 'A player is already selected for the other team' using errcode='22023';
  end if;

  -- A retry of the same selection does not rewrite player rows or log another action.
  if (select count(*) from match_lineups where match_id=p_match and team_id=p_team)=n and not exists (
    select player_id,slot,"order" from jsonb_to_recordset(p_entries) e(player_id text,slot text,"order" int)
    except select player_id,slot,"order" from match_lineups where match_id=p_match and team_id=p_team
  ) then
    return query select * from match_lineups where match_id=p_match and team_id=p_team;
    return;
  end if;

  delete from match_lineups where match_id=p_match and league_id=m.league_id and team_id=p_team;
  insert into league_activity(id,league_id,profile_id,action,summary)
    values(gen_random_uuid()::text,m.league_id,auth.uid()::text,'match.lineup','Lineup set for ' || m.title);
  return query insert into match_lineups(id,match_id,league_id,team_id,player_id,slot,"order")
    select gen_random_uuid()::text,p_match,m.league_id,p_team,e.player_id,e.slot,e."order"
    from jsonb_to_recordset(p_entries) e(player_id text,slot text,"order" int) returning *;
end;
$$;
-- RLS is unchanged; prevent direct writes from bypassing the locked validation RPC.
revoke insert, update, delete on public.match_lineups from public, anon, authenticated;
revoke update (team_id,player_id,slot,"order") on public.match_lineups from authenticated;

create or replace function public.save_fantasy_squad_v2(
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

-- Position arrays are [GK,DEF,MID,FWD]. Existing leagues allow zero outfield
-- lines; auto-subs preserve each line actually used by the saved formation.
-- Within a line, prefer a like-for-like swap, then original starter order.
create function public.ff_auto_substitutions(p_starters jsonb,p_bench jsonb,p_formation text,p_size int)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare positions text[] := array['GK','DEF','MID','FWD']; counts int[] := array[0,0,0,0];
  shape int[]; used text[] := '{}'; incoming record; outgoing record; picked record;
  src int; dest int; changes jsonb := '[]';
begin
  if p_size not in (5,7) or jsonb_array_length(p_starters)<>p_size or p_formation is null or p_formation !~ '^[0-6]-[0-6]-[0-6]$' then return changes; end if;
  shape := string_to_array(p_formation,'-')::int[];
  for outgoing in select * from jsonb_to_recordset(p_starters) s(position text) loop
    src := array_position(positions,outgoing.position);
    if src is null then return changes; end if;
    counts[src] := counts[src]+1;
  end loop;
  if counts <> array[1,shape[1],shape[2],shape[3]] then return changes; end if;
  for incoming in select * from jsonb_to_recordset(p_bench) b(id text,name text,position text,played boolean,priority int)
    where b.played order by (b.position='GK') desc,b.priority,b.id loop
    dest := array_position(positions,incoming.position);
    if dest is null then continue; end if;
    select * into picked from jsonb_to_recordset(p_starters) s(id text,name text,position text,played boolean,priority int)
      where not s.played and not (s.id=any(used)) and (s.position='GK')=(incoming.position='GK')
        and (s.position=incoming.position or counts[array_position(positions,s.position)] > case
          when shape[array_position(positions,s.position)-1] > 0 then 1 else 0 end)
      order by (s.position=incoming.position) desc,s.priority,s.id limit 1;
    if found then
      src := array_position(positions,picked.position);
      counts[src] := counts[src]-1; counts[dest] := counts[dest]+1;
      used := array_append(used,picked.id);
      changes := changes || jsonb_build_array(jsonb_build_object('outId',picked.id,'outName',picked.name,
        'inId',incoming.id,'inName',incoming.name,'position',incoming.position,'priority',incoming.priority));
    end if;
  end loop;
  return changes;
end;
$$;
revoke all on function public.ff_auto_substitutions(jsonb,jsonb,text,int) from public, anon, authenticated;

-- Private receipt under the same transaction as approval and the points ledger.
create table public.match_scoring_receipts (
  match_id text primary key references public.real_matches(id) on delete cascade,
  match_version int not null,
  result jsonb not null
);
alter table public.match_scoring_receipts enable row level security;
revoke all on public.match_scoring_receipts from public, anon, authenticated;

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
  ), components as (
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
         v_match.version, coalesce(s.total,0), coalesce(s.breakdown,'[]'::jsonb), now()
    from lines l left join scored s on s.player_id=l.player_id
  on conflict (match_id, player_id) do update
    set points = excluded.points,
        breakdown = excluded.breakdown,
        match_version = excluded.match_version,
        computed_at = now();

  get diagnostics v_players = row_count;

  -- Manager points mirror computeManagerPoints(): the captain doubles only
  -- if they participated; otherwise the vice-captain may inherit the double.
  with appearance as (
    select player_id from public.match_lineups
     where match_id = p_match and slot = 'starter'
    union
    select player_on_id as player_id from public.match_substitutions
     where match_id = p_match
  ), squads as materialized (
    select s.id,s.profile_id,s.captain_id,s.vice_captain_id,s.formation,
      jsonb_agg(e.data order by e.priority,e.id) filter (where e.slot='starter') as starters,
      jsonb_agg(e.data order by e.priority,e.id) filter (where e.slot='sub') as bench
    from fantasy_squads s
    join lateral (
      select sp.player_id as id,sp.slot,sp."order" as priority,
        jsonb_build_object('id',p.id,'name',p.full_name,'position',p.position,'priority',sp."order",'played',ap.player_id is not null) as data
      from fantasy_squad_players sp join players p on p.id=sp.player_id and p.league_id=v_match.league_id
      left join appearance ap on ap.player_id=p.id where sp.squad_id=s.id and sp.slot in ('starter','sub')
    ) e on true
    where s.league_id=v_match.league_id
    group by s.id
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
    insert into match_scoring_receipts(match_id,match_version,result) values(p_match,v_match.version,v_result)
      on conflict (match_id) do update set match_version=excluded.match_version,result=excluded.result;
  end if;
  return v_result;
end;
$$;

revoke all on function public.ff_score_match(text,boolean) from public, anon, authenticated;

-- Preserve the explicitly invoked legacy scoring endpoint; it never adds bench
-- substitutions to a pre-upgrade result. Finalized versions return their receipt.
create or replace function public.calculate_match_points(p_match text)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$
  select public.ff_score_match(p_match,false);
$$;

create or replace function public.approve_match(p_match text, p_version int default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v real_matches%rowtype;
  v_result jsonb;
begin
  select * into v from real_matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if not (public.is_leader(v.league_id) or public.is_match_organizer(p_match)) then
    raise exception 'Only the League Leader or Match Organizer can approve results';
  end if;
  if v.status <> 'pending' then
    raise exception 'Match is not pending approval';
  end if;
  if p_version is not null and p_version <> v.version then
    raise exception 'Match changed since you reviewed it';
  end if;
  -- Product rule: the League Leader may approve even when they submitted
  -- the result, and the Match Organizer may approve results for matches
  -- they organize. Neither role is blocked by self-approval.

  update real_matches
     set status = 'approved', decided_by = auth.uid()::text, decided_at = now(),
         rejection_reason = null, version = version + 1, updated_at = now()
   where id = p_match;

  insert into match_approvals (id, match_id, action, actor_id, version, created_at)
  values (gen_random_uuid()::text, p_match, 'approved', auth.uid()::text, v.version + 1, now());

  v_result := public.ff_score_match(p_match,true);
  return v_result;
end;
$$;


-- Only the signed-in member's own finalized substitution history. Filter the
-- version and cap the result in SQL instead of loading all match ledgers.
create function public.recent_fantasy_substitutions(p_league text)
returns table ("matchId" text, title text, substitutions jsonb)
language sql stable security invoker set search_path=pg_catalog,public as $$
  select m.id,m.title,mp.breakdown->'substitutions'
  from manager_points mp join real_matches m on m.id=mp.match_id and m.league_id=mp.league_id and m.version=mp.match_version
  where mp.league_id=p_league and mp.profile_id=auth.uid()::text and public.is_member(p_league)
    and m.status='approved' and coalesce(mp.breakdown->'substitutions','[]'::jsonb)<>'[]'::jsonb
  order by m.kick_off desc,m.id desc limit 5;
$$;
revoke all on function public.recent_fantasy_substitutions(text) from public, anon, authenticated;
grant execute on function public.recent_fantasy_substitutions(text) to authenticated;
create index if not exists manager_points_league_profile_idx on public.manager_points(league_id,profile_id);

commit;
