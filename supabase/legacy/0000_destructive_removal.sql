-- ============================================================================
-- 0000_destructive_removal.sql
-- ============================================================================
-- ⚠️  DESTRUCTIVE MIGRATION — DO NOT RUN WITHOUT EXPLICIT WRITTEN APPROVAL ⚠️
--
-- This file exists so the rebuild of the Hagz-fantasy project's Fantasy
-- Friends application tables is reproducible and reviewable. It is NOT
-- executed by any part of the application, the CI pipeline or the local
-- development setup.
--
-- Scope rules:
--   * Only objects that belonged to the PREVIOUS Fantasy Friends
--     application implementation are listed.
--   * auth.users, storage.objects, storage.buckets, realtime.* and any
--     other Supababase platform infrastructure are deliberately untouched.
--   * Each statement is guarded by IF EXISTS so the script is a no-op on a
--     database that has already been rebuilt.
--
-- Approval workflow:
--   1. Review this file.
--   2. Take a logical backup:
--        pg_dump --data-only --table=old_table ... > backup.sql
--   3. Obtain explicit approval from the project owner.
--   4. Apply with:  supabase db push   (or psql -f this file)
-- ============================================================================

begin;

-- Old application tables (previous Fantasy Friends implementation)
drop table if exists public.match_status_history cascade;
drop table if exists public.match_versions cascade;
drop table if exists public.player_match_stats cascade;
drop table if exists public.fantasy_points cascade;
drop table if exists public.manager_standings cascade;
drop table if exists public.match_results cascade;
drop table if exists public.match_players cascade;
drop table if exists public.squad_players cascade;
drop table if exists public.squads cascade;
drop table if exists public.invite_codes cascade;
drop table if exists public.league_settings cascade;
drop table if exists public.players_old cascade;
drop table if exists public.clubs cascade;
drop table if exists public.notifications_old cascade;
drop table if exists public.user_profiles_old cascade;

-- Old application functions, triggers and policies
drop function if exists public.handle_new_user() cascade;
drop function if exists public.award_fantasy_points(uuid, uuid) cascade;
drop function if exists public.update_standings(uuid) cascade;
drop trigger if exists on_auth_user_created on auth.users cascade;
drop trigger if exists recompute_points_after_approval on public.real_matches cascade;

-- Old row level security policies are dropped with their tables above.
-- Policies on tables that survive the rebuild are dropped explicitly in
-- 0002_rls.sql before being recreated.

commit;

-- ============================================================================
-- End of destructive migration. Continue with 0001_schema.sql
-- ============================================================================
