-- ============================================================================
-- 0002_rls.sql — Row Level Security for Fantasy Friends
-- ============================================================================
-- Target: Supabase project `Hagz-fantasy`, executed AFTER 0001_schema.sql.
--
-- Principles enforced here (never trusted from the client):
--   * A user id or role claim supplied by the client is never used for
--     authorization. Every policy resolves membership from league_members.
--   * League data is invisible to non-members (no cross-league reads).
--   * Only a League Leader can change league settings, roles or approve
--     results; only the recorded Match Organizer (or a leader) can write
--     match events while a match is a draft.
--   * Nobody can grant themselves an elevated role (see trigger in 0003).
--   * Point and standing tables are write-protected: only SECURITY DEFINER
--     functions may modify them, which prevents duplicate aggregation.
-- ============================================================================

-- Helper functions ----------------------------------------------------------
-- SECURITY DEFINER avoids the RLS recursion you get when a policy on
-- league_members queries league_members itself.
create or replace function public.is_member(p_league text)
returns boolean
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select exists (
    select 1 from league_members m
    where m.league_id = p_league and m.profile_id = auth.uid()::text
  );
$$;

create or replace function public.is_leader(p_league text)
returns boolean
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select exists (
    select 1 from league_members m
    where m.league_id = p_league
      and m.profile_id = auth.uid()::text
      and m.role = 'leader'
  );
$$;

create or replace function public.is_organizer(p_league text)
returns boolean
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select exists (
    select 1 from league_members m
    where m.league_id = p_league
      and m.profile_id = auth.uid()::text
      and m.role in ('leader','organizer')
  );
$$;

create or replace function public.is_match_organizer(p_match text)
returns boolean
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select exists (
    select 1 from real_matches r
    where r.id = p_match
      and r.organizer_id = auth.uid()::text
      and exists (
        select 1 from league_members m
        where m.league_id = r.league_id
          and m.profile_id = auth.uid()::text
          and m.role in ('leader','organizer')
      )
  );
$$;

create or replace function public.match_is_editable(p_match text)
returns boolean
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select exists (
    select 1 from real_matches r
    where r.id = p_match
      and public.is_member(r.league_id)
      and r.status in ('draft','rejected')
  );
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS on every application table
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','sessions','auth_tokens','mail_outbox',
    'leagues','league_members','invitations',
    'teams','players',
    'fantasy_squads','fantasy_squad_players','fantasy_fixtures',
    'real_matches','match_lineups','match_events','match_substitutions',
    'match_approvals','scoring_rules',
    'player_match_points','manager_points','league_standings',
    'fantasy_points_history','notifications','league_activity',
    'audit_logs','mutation_ops'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    -- existing policies from a previous run are replaced
    execute format('drop policy if exists %I on public.%I', 'p_all_'||t, t);
  end loop;
end $$;

-- profiles ------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = auth.uid()::text
    or exists (
      select 1 from league_members a
      join league_members b on a.league_id = b.league_id
      where a.profile_id = auth.uid()::text and b.profile_id = profiles.id
    )
  );

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid()::text)
  with check (id = auth.uid()::text);

-- Never allow a client to insert somebody else's profile or change its id.
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (id = auth.uid()::text);

-- sessions / tokens / outbox ------------------------------------------------
drop policy if exists sessions_own on public.sessions;
create policy sessions_own on public.sessions
  for all to authenticated
  using (profile_id = auth.uid()::text)
  with check (profile_id = auth.uid()::text);

drop policy if exists auth_tokens_own on public.auth_tokens;
create policy auth_tokens_own on public.auth_tokens
  for all to authenticated
  using (profile_id = auth.uid()::text)
  with check (profile_id = auth.uid()::text);

drop policy if exists mail_outbox_own on public.mail_outbox;
create policy mail_outbox_own on public.mail_outbox
  for select to authenticated
  using (to_email = (select email from profiles where id = auth.uid()::text));

-- leagues -------------------------------------------------------------------
drop policy if exists leagues_select on public.leagues;
create policy leagues_select on public.leagues
  for select to authenticated
  using (public.is_member(id) or created_by = auth.uid()::text);

drop policy if exists leagues_insert on public.leagues;
create policy leagues_insert on public.leagues
  for insert to authenticated
  with check (created_by = auth.uid()::text);

drop policy if exists leagues_update on public.leagues;
create policy leagues_update on public.leagues
  for update to authenticated
  using (public.is_leader(id))
  with check (public.is_leader(id));

drop policy if exists leagues_delete on public.leagues;
create policy leagues_delete on public.leagues
  for delete to authenticated
  using (created_by = auth.uid()::text);

-- league members ------------------------------------------------------------
drop policy if exists members_select on public.league_members;
create policy members_select on public.league_members
  for select to authenticated
  using (profile_id = auth.uid()::text or public.is_member(league_id));

-- Self-joins go through public.join_league(code) so the invite is checked
-- server side. Direct inserts are allowed only for the creator of a league.
drop policy if exists members_insert on public.league_members;
create policy members_insert on public.league_members
  for insert to authenticated
  with check (
    profile_id = auth.uid()::text
    and (
      exists (
        select 1 from leagues l
        where l.id = league_members.league_id and l.created_by = auth.uid()::text
      )
      or public.is_leader(league_id)
    )
  );

drop policy if exists members_update on public.league_members;
create policy members_update on public.league_members
  for update to authenticated
  using (public.is_leader(league_id))
  with check (public.is_leader(league_id));

drop policy if exists members_delete on public.league_members;
create policy members_delete on public.league_members
  for delete to authenticated
  using (profile_id = auth.uid()::text or public.is_leader(league_id));

-- invitations ---------------------------------------------------------------
drop policy if exists invitations_select on public.invitations;
create policy invitations_select on public.invitations
  for select to authenticated
  using (public.is_member(league_id) or created_by = auth.uid()::text);

drop policy if exists invitations_manage on public.invitations;
create policy invitations_manage on public.invitations
  for all to authenticated
  using (public.is_leader(league_id))
  with check (public.is_leader(league_id) and created_by = auth.uid()::text);

-- teams & players (league scoped) -------------------------------------------
drop policy if exists teams_select on public.teams;
create policy teams_select on public.teams
  for select to authenticated
  using (public.is_member(league_id));

drop policy if exists teams_write on public.teams;
create policy teams_write on public.teams
  for all to authenticated
  using (public.is_leader(league_id))
  with check (public.is_leader(league_id));

drop policy if exists players_select on public.players;
create policy players_select on public.players
  for select to authenticated
  using (public.is_member(league_id));

drop policy if exists players_write on public.players;
create policy players_write on public.players
  for all to authenticated
  using (public.is_leader(league_id))
  with check (public.is_leader(league_id) and created_by = auth.uid()::text);

-- fantasy squads (own squad only for writes) --------------------------------
drop policy if exists squads_select on public.fantasy_squads;
create policy squads_select on public.fantasy_squads
  for select to authenticated
  using (public.is_member(league_id));

drop policy if exists squads_insert on public.fantasy_squads;
create policy squads_insert on public.fantasy_squads
  for insert to authenticated
  with check (
    profile_id = auth.uid()::text and public.is_member(league_id)
    and (captain_id is null or exists (
      select 1 from public.players p where p.id = fantasy_squads.captain_id and p.league_id = fantasy_squads.league_id
    ))
    and (vice_captain_id is null or exists (
      select 1 from public.players p where p.id = fantasy_squads.vice_captain_id and p.league_id = fantasy_squads.league_id
    ))
  );

drop policy if exists squads_update on public.fantasy_squads;
create policy squads_update on public.fantasy_squads
  for update to authenticated
  using (profile_id = auth.uid()::text and public.is_member(league_id))
  with check (
    profile_id = auth.uid()::text and public.is_member(league_id)
    and (captain_id is null or exists (
      select 1 from public.players p where p.id = fantasy_squads.captain_id and p.league_id = fantasy_squads.league_id
    ))
    and (vice_captain_id is null or exists (
      select 1 from public.players p where p.id = fantasy_squads.vice_captain_id and p.league_id = fantasy_squads.league_id
    ))
  );

drop policy if exists squads_delete on public.fantasy_squads;
create policy squads_delete on public.fantasy_squads
  for delete to authenticated
  using (profile_id = auth.uid()::text and public.is_member(league_id));

drop policy if exists squad_players_rw on public.fantasy_squad_players;
create policy squad_players_rw on public.fantasy_squad_players
  for all to authenticated
  using (
    exists (
      select 1 from public.fantasy_squads s
      join public.players p on p.id = fantasy_squad_players.player_id
      where s.id = fantasy_squad_players.squad_id
        and s.profile_id = auth.uid()::text
        and public.is_member(s.league_id)
        and p.league_id = s.league_id
    )
  )
  with check (
    exists (
      select 1 from public.fantasy_squads s
      join public.players p on p.id = fantasy_squad_players.player_id
      where s.id = fantasy_squad_players.squad_id
        and s.profile_id = auth.uid()::text
        and public.is_member(s.league_id)
        and p.league_id = s.league_id
    )
  );

-- fixtures ------------------------------------------------------------------
drop policy if exists fixtures_select on public.fantasy_fixtures;
create policy fixtures_select on public.fantasy_fixtures
  for select to authenticated
  using (public.is_member(league_id));

drop policy if exists fixtures_insert on public.fantasy_fixtures;
create policy fixtures_insert on public.fantasy_fixtures
  for insert to authenticated
  with check (public.is_leader(league_id) and created_by = auth.uid()::text);

drop policy if exists fixtures_update on public.fantasy_fixtures;
create policy fixtures_update on public.fantasy_fixtures
  for update to authenticated
  using (public.is_leader(league_id))
  with check (public.is_leader(league_id));

drop policy if exists fixtures_delete on public.fantasy_fixtures;
create policy fixtures_delete on public.fantasy_fixtures
  for delete to authenticated
  using (public.is_leader(league_id));

-- real matches --------------------------------------------------------------
drop policy if exists matches_select on public.real_matches;
create policy matches_select on public.real_matches
  for select to authenticated
  using (public.is_member(league_id));

drop policy if exists matches_insert on public.real_matches;
create policy matches_insert on public.real_matches
  for insert to authenticated
  with check (
    public.is_leader(league_id)
    or (public.is_organizer(league_id) and organizer_id = auth.uid()::text)
  );

drop policy if exists matches_update on public.real_matches;
create policy matches_update on public.real_matches
  for update to authenticated
  using (
    (public.is_leader(league_id) or public.is_match_organizer(id))
    and status <> 'approved'
  )
  with check (public.is_member(league_id));

drop policy if exists matches_delete on public.real_matches;
create policy matches_delete on public.real_matches
  for delete to authenticated
  using (public.is_leader(league_id) and status <> 'approved');

-- lineups / events / substitutions ------------------------------------------
drop policy if exists lineups_select on public.match_lineups;
create policy lineups_select on public.match_lineups
  for select to authenticated
  using (public.is_member(league_id));

drop policy if exists lineups_write on public.match_lineups;
create policy lineups_write on public.match_lineups
  for all to authenticated
  using (
    public.is_match_organizer(match_id) and public.match_is_editable(match_id)
  )
  with check (
    public.is_match_organizer(match_id) and public.match_is_editable(match_id)
  );

drop policy if exists events_select on public.match_events;
create policy events_select on public.match_events
  for select to authenticated
  using (public.is_member(league_id));

drop policy if exists events_write on public.match_events;
create policy events_write on public.match_events
  for all to authenticated
  using (
    public.is_match_organizer(match_id) and public.match_is_editable(match_id)
  )
  with check (
    public.is_match_organizer(match_id)
    and public.match_is_editable(match_id)
    and created_by = auth.uid()::text
  );

drop policy if exists subs_select on public.match_substitutions;
create policy subs_select on public.match_substitutions
  for select to authenticated
  using (public.is_member(league_id));

drop policy if exists subs_write on public.match_substitutions;
create policy subs_write on public.match_substitutions
  for all to authenticated
  using (
    public.is_match_organizer(match_id) and public.match_is_editable(match_id)
  )
  with check (
    public.is_match_organizer(match_id)
    and public.match_is_editable(match_id)
    and created_by = auth.uid()::text
  );

-- approvals: rows are append-only and leader driven -------------------------
drop policy if exists approvals_select on public.match_approvals;
create policy approvals_select on public.match_approvals
  for select to authenticated
  using (exists (
    select 1 from real_matches r
    where r.id = match_approvals.match_id and public.is_member(r.league_id)
  ));

drop policy if exists approvals_insert on public.match_approvals;
create policy approvals_insert on public.match_approvals
  for insert to authenticated
  with check (
    actor_id = auth.uid()::text
    and exists (
      select 1 from real_matches r
      where r.id = match_approvals.match_id
        and (
          public.is_leader(r.league_id)
          or public.is_match_organizer(r.id)
        )
    )
  );

-- scoring rules -------------------------------------------------------------
drop policy if exists rules_select on public.scoring_rules;
create policy rules_select on public.scoring_rules
  for select to authenticated
  using (public.is_member(league_id));

drop policy if exists rules_write on public.scoring_rules;
create policy rules_write on public.scoring_rules
  for all to authenticated
  using (public.is_leader(league_id))
  with check (public.is_leader(league_id)
    and (status <> 'approved' or approved_by = auth.uid()::text));

-- points & standings: read for members, writes only via definer functions ---
drop policy if exists pmp_select on public.player_match_points;
create policy pmp_select on public.player_match_points
  for select to authenticated
  using (public.is_member(league_id));

drop policy if exists pmp_insert on public.player_match_points;
create policy pmp_insert on public.player_match_points
  for insert to authenticated
  with check (false); -- only security definer functions write points

drop policy if exists mp_select on public.manager_points;
create policy mp_select on public.manager_points
  for select to authenticated
  using (public.is_member(league_id));

drop policy if exists mp_insert on public.manager_points;
create policy mp_insert on public.manager_points
  for insert to authenticated
  with check (false);

drop policy if exists standings_select on public.league_standings;
create policy standings_select on public.league_standings
  for select to authenticated
  using (public.is_member(league_id));

drop policy if exists standings_insert on public.league_standings;
create policy standings_insert on public.league_standings
  for insert to authenticated
  with check (false);

drop policy if exists standings_update on public.league_standings;
create policy standings_update on public.league_standings
  for update to authenticated
  using (false);

drop policy if exists history_select on public.fantasy_points_history;
create policy history_select on public.fantasy_points_history
  for select to authenticated
  using (public.is_member(league_id));

drop policy if exists history_insert on public.fantasy_points_history;
create policy history_insert on public.fantasy_points_history
  for insert to authenticated
  with check (false);

-- notifications -------------------------------------------------------------
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (profile_id = auth.uid()::text);

drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications
  for update to authenticated
  using (profile_id = auth.uid()::text)
  with check (profile_id = auth.uid()::text);

drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications
  for delete to authenticated
  using (profile_id = auth.uid()::text);

-- activity, audit, ops ------------------------------------------------------
drop policy if exists activity_select on public.league_activity;
create policy activity_select on public.league_activity
  for select to authenticated
  using (public.is_member(league_id));

drop policy if exists activity_insert on public.league_activity;
create policy activity_insert on public.league_activity
  for insert to authenticated
  with check (public.is_member(league_id) and profile_id = auth.uid()::text);
-- No direct INSERT grant is issued; trusted RPCs write activity records.

drop policy if exists audit_select on public.audit_logs;
create policy audit_select on public.audit_logs
  for select to authenticated
  using (league_id is null and actor_id = auth.uid()::text or public.is_leader(league_id));

drop policy if exists ops_own on public.mutation_ops;
drop policy if exists ops_select on public.mutation_ops;
create policy ops_select on public.mutation_ops
  for select to authenticated
  using (profile_id = auth.uid()::text);

-- Realtime -------------------------------------------------------------------
alter publication supabase_realtime add table public.league_standings;
alter publication supabase_realtime add table public.match_events;
alter publication supabase_realtime add table public.real_matches;
alter publication supabase_realtime add table public.notifications;


-- ---------------------------------------------------------------------------
-- Explicit API privileges. RLS policies filter rows; SQL grants determine
-- which operations the API roles may attempt. Point ledgers remain read-only
-- to clients and are written only by owner-context RPCs.
-- ---------------------------------------------------------------------------
revoke all on table
  public.profiles, public.sessions, public.auth_tokens, public.mail_outbox,
  public.leagues, public.league_members, public.invitations,
  public.teams, public.players, public.fantasy_squads,
  public.fantasy_squad_players, public.fantasy_fixtures, public.real_matches,
  public.match_lineups, public.match_events, public.match_substitutions,
  public.match_approvals, public.scoring_rules, public.player_match_points,
  public.manager_points, public.league_standings, public.fantasy_points_history,
  public.notifications, public.league_activity, public.audit_logs,
  public.mutation_ops
from public, anon, authenticated;
grant usage on schema public to authenticated;
revoke create on schema public from public, anon, authenticated;

grant select on table
  public.profiles, public.leagues, public.league_members, public.invitations,
  public.teams, public.players, public.fantasy_squads,
  public.fantasy_squad_players, public.fantasy_fixtures, public.real_matches,
  public.match_lineups, public.match_events, public.match_substitutions,
  public.match_approvals, public.scoring_rules, public.player_match_points,
  public.manager_points, public.league_standings, public.fantasy_points_history,
  public.notifications, public.league_activity, public.audit_logs,
  public.mutation_ops, public.mail_outbox
to authenticated;

-- Profile self-service: Auth-owned identity/verification fields are not client-writable.
grant update (username, display_name, avatar_url, bio) on table public.profiles to authenticated;

-- League and membership management. Immutable identity/ownership columns are
-- excluded from UPDATE grants; role changes use set_member_role().
grant insert, delete on table public.leagues to authenticated;
grant update (name, description, format, squad_size, starters, subs_count,
               invite_code, vice_policy, updated_at)
  on table public.leagues to authenticated;
grant insert, delete on table public.league_members to authenticated;
grant update (team_name) on table public.league_members to authenticated;
grant insert, delete on table public.invitations to authenticated;
grant update (code, note, revoked_at, expires_at)
  on table public.invitations to authenticated;
grant insert, delete on table public.teams to authenticated;
grant update (name, short_name, crest_url) on table public.teams to authenticated;
grant insert, delete on table public.players to authenticated;
grant update (team_id, full_name, photo_url, position, shirt_number,
               availability, status, description, updated_at)
  on table public.players to authenticated;

-- User-owned fantasy squad and fixture operations; league/profile ownership
-- and immutable IDs cannot be changed by direct client updates.
grant insert, delete on table public.fantasy_squads to authenticated;
grant update (formation, captain_id, vice_captain_id, completed_at, updated_at)
  on table public.fantasy_squads to authenticated;
grant insert, delete on table public.fantasy_squad_players to authenticated;
grant update (slot, "order") on table public.fantasy_squad_players to authenticated;
grant insert, delete on table public.fantasy_fixtures to authenticated;
grant update (gameweek, title, scheduled_at, status, real_match_id, notes, updated_at)
  on table public.fantasy_fixtures to authenticated;
grant insert, delete on table public.real_matches to authenticated;
-- Match status and approval columns are writable only through guarded RPCs.
grant insert, delete on table public.match_lineups to authenticated;
grant update (team_id, player_id, slot, "order") on table public.match_lineups to authenticated;
grant insert, delete on table public.match_events to authenticated;
grant update (team_id, player_id, assist_player_id, event_type, minute, note, updated_at)
  on table public.match_events to authenticated;
grant insert, delete on table public.match_substitutions to authenticated;
grant update (team_id, player_on_id, player_off_id, minute)
  on table public.match_substitutions to authenticated;
-- Match approval rows are append-only through SECURITY DEFINER state-machine RPCs.
grant insert, delete on table public.scoring_rules to authenticated;
grant update (points, status, approved_by, approved_at, updated_at)
  on table public.scoring_rules to authenticated;

-- Read-only to clients: points, standings, history, and audit records.
-- No direct grants are issued for sessions/auth_tokens/mail_outbox writes.
grant update (read_at) on table public.notifications to authenticated;
grant delete on table public.notifications to authenticated;
-- Activity and idempotency ledger writes are server/RPC-only.
-- Authenticated clients may inspect only their own mutation operation records.

-- RLS helper functions are callable by authenticated policies and RPCs only.
revoke all on function public.is_member(text) from public, anon;
revoke all on function public.is_leader(text) from public, anon;
revoke all on function public.is_organizer(text) from public, anon;
revoke all on function public.is_match_organizer(text) from public, anon;
revoke all on function public.match_is_editable(text) from public, anon;
grant execute on function public.is_member(text) to authenticated;
grant execute on function public.is_leader(text) to authenticated;
grant execute on function public.is_organizer(text) to authenticated;
grant execute on function public.is_match_organizer(text) to authenticated;
grant execute on function public.match_is_editable(text) to authenticated;
