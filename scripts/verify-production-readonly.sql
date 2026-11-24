-- verify-production-readonly.sql
--
-- Read-only verification that migrations 0001–0034 are correctly applied to
-- a Fantasy Friends database (run against PRODUCTION after a deploy, or
-- against any environment to compare it with the known-good shape).
--
-- STRICTLY READ-ONLY: one SELECT over catalogs and metadata. It writes
-- nothing, locks nothing, and is safe to paste into the Supabase SQL editor
-- or run via psql at any time, on any plan.
--
-- How to read the output: every row is one check. Every row with
-- severity 'FAIL' must have ok = true. 'WARN' rows are operational notes.

with checks(severity, check_name, ok, detail) as (

  -- ------------------------------------------------------------- tables
  select 'FAIL','table exists: ' || t,
         to_regclass('public.' || t) is not null, ''::text
  from (values
    ('profiles'),('leagues'),('league_members'),('league_standings'),('league_activity'),
    ('teams'),('players'),('fantasy_squads'),('fantasy_squad_players'),('real_matches'),
    ('match_lineups'),('match_events'),('match_substitutions'),('match_approvals'),
    ('match_scoring_receipts'),('match_player_statistics'),('scoring_rules'),
    ('player_match_points'),('manager_points'),('fantasy_points_history'),
    ('notifications'),('audit_logs'),('mutation_ops'),('invitations'),('fantasy_fixtures'),
    ('ff_rate_limit_windows')
  ) as v(t)

  union all

  -- ------------------------------------------- RLS on every app table
  select 'FAIL','RLS enabled: ' || c.relname, c.relrowsecurity,
         case when c.relrowsecurity then '' else 'missing enable row level security' end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'

  union all

  -- ---------------------------------- the rate-limit table stays internal
  select 'FAIL','ff_rate_limit_windows: no client table privileges',
         not has_table_privilege('authenticated','public.ff_rate_limit_windows','SELECT')
         and not has_table_privilege('authenticated','public.ff_rate_limit_windows','INSERT')
         and not has_table_privilege('anon','public.ff_rate_limit_windows','SELECT'),
         'client roles must reach it only via ff_rate_limit_hit'
  union all
  select 'FAIL','ff_rate_limit_hit executable by client roles',
         has_function_privilege('authenticated','public.ff_rate_limit_hit(text,text)','EXECUTE')
         and has_function_privilege('anon','public.ff_rate_limit_hit(text,text)','EXECUTE'), ''

  union all

  -- ------------------------------------------- critical RPC entry points
  -- Matched by name (not exact signature) so the check survives overloads.
  select 'FAIL','function exists: public.' || f,
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = f), ''
  from (values
    ('create_league_confirmed'),('join_league'),('create_real_match'),
    ('write_match_event'),('submit_match'),('approve_match'),('reject_match'),
    ('correct_match_result'),('save_match_statistics'),('clear_match_lineups'),
    ('save_fantasy_squad_v2'),('ff_rate_limit_hit'),('ff_my_display_standings'),
    ('ff_promote_due_match_lineups'),('ff_score_match'),('recalculate_standings'),
    ('edit_real_match_details'),('set_member_role'),('save_scoring_rules'),
    ('delete_owned_league'),('replace_match_lineup')
  ) as v(f)

  union all

  -- --------------------- SECURITY DEFINER functions pin their search_path
  select 'FAIL','SECURITY DEFINER pins search_path: public.' || p.proname,
         coalesce(array_to_string(p.proconfig,','),'') like '%search_path%',
         coalesce(array_to_string(p.proconfig,','),'(none)')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef

  union all

  -- --------------------------------------------------------- key columns
  select 'FAIL','column exists: ' || t || '.' || c,
         exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name=t and column_name=c), ''
  from (values
    ('profiles','email_lower'),('profiles','email_verified_at'),
    ('real_matches','version'),('real_matches','duration_minutes'),('real_matches','organizer_id'),
    ('match_events','team_id'),('match_lineups','slot'),('fantasy_squads','formation'),
    ('fantasy_squads','captain_id'),('fantasy_squads','vice_captain_id'),
    ('leagues','invite_code'),('leagues','format'),('notifications','read_at')
  ) as v(t,c)

  union all

  -- -------------------------------------------------------- key triggers
  select 'FAIL','trigger exists: on_auth_user_created_ff on auth.users',
         exists (select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
                 join pg_namespace n on n.oid = c.relnamespace
                 where tg.tgname = 'on_auth_user_created_ff' and not tg.tgisinternal
                   and n.nspname = 'auth' and c.relname = 'users'),
         'profile rows are created from auth.users by this trigger'
  union all
  select 'FAIL','trigger exists: ff_fixture_created on fantasy_fixtures',
         exists (select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
                 join pg_namespace n on n.oid = c.relnamespace
                 where tg.tgname = 'ff_fixture_created' and not tg.tgisinternal
                   and n.nspname = 'public' and c.relname = 'fantasy_fixtures'),
         'fixture/approval notifications come from this trigger'

  union all

  -- --------------------------------- 0033 hot-read indexes (informational)
  select 'WARN','index present: ' || indexname,
         true, schemaname || '.' || tablename
  from pg_indexes
  where schemaname = 'public'
    and indexname in ('real_matches_league_id_kick_off_idx','match_events_match_id_idx',
                      'league_members_profile_id_idx','notifications_profile_id_read_at_idx')

  union all

  -- --------------------- deadline scheduling (operational, informational)
  select 'WARN','deadline scheduling channel',
         true,
         case when exists (select 1 from pg_extension where extname='pg_cron')
              then 'pg_cron installed — if it schedules lineups, verify with: select * from cron.job;'
              else 'pg_cron absent — the GitHub Actions lineup-deadlines workflow is the scheduler (expected)'
         end

)
select severity, check_name, ok, detail from checks
order by severity, check_name;

-- Verdict: any FAIL row with ok = false means the deployment is NOT
-- verified. Compare against supabase/migrations/0001–0034, apply what is
-- missing per DATABASE_MIGRATION_GUIDE.md, then re-run this script.
