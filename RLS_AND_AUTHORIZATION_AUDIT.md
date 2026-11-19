# Fantasy Friends — RLS and Authorization Audit

## Overview

This document audits the Row Level Security (RLS) policies and authorization model for the Fantasy Friends application. The authorization model is enforced at three layers:

1. **API Layer** — Next.js route handlers with `canManageMatch()` and `requireUser()`
2. **Database Layer** — Supabase RLS policies on all tables
3. **RPC Layer** — SECURITY DEFINER functions for privileged operations

All three layers enforce the same Leader + Organizer match authority model.

## Authorization Model

### League Leader
- Full authority over ALL matches in their league
- Independent of Match Organizer assignment

### Assigned Match Organizer
- Full authority over matches THEY organize only
- Cannot manage matches organized by others (unless also Leader)

### Ordinary League Members
- Read-only access to league data
- No match-management permissions

### Key Security Rules
- No `allow_self_approval` restriction — neither role is blocked from approving their own submission
- Client-supplied profile IDs are never trusted
- Identity is always derived from `auth.uid()` via Supabase Auth session
- Cross-league access is prevented

## RLS Policy Audit

### Helper Functions

| Function | Purpose | Security |
|----------|---------|----------|
| `is_member(p_league)` | Check if user is a league member | SECURITY DEFINER, search_path pg_catalog,public |
| `is_leader(p_league)` | Check if user is League Leader | SECURITY DEFINER, search_path pg_catalog,public |
| `is_organizer(p_league)` | Check if user is Leader or Organizer | SECURITY DEFINER, search_path pg_catalog,public |
| `is_match_organizer(p_match)` | Check if user organizes the match AND is a member | SECURITY DEFINER, search_path pg_catalog,public |
| `match_is_editable(p_match)` | Check if match is in draft/rejected status | SECURITY DEFINER, search_path pg_catalog,public |

### Table-Level Policies

| Table | Select | Insert | Update | Delete |
|-------|--------|--------|--------|--------|
| `profiles` | Own + league members | Own | Own | — |
| `sessions` | Own | — | Own | Own |
| `auth_tokens` | Own | — | Own | Own |
| `leagues` | Member or creator | Creator | Leader | Creator |
| `league_members` | Self or member | Creator or Leader | Leader | Self or Leader |
| `invitations` | Member or creator | — | Leader | — |
| `teams` | Member | — | Leader | — |
| `players` | Member | — | Leader | — |
| `fantasy_squads` | Member | Owner + member | Owner + member | Owner + member |
| `fantasy_squad_players` | — | Via squad ownership | Via squad ownership | — |
| `fantasy_fixtures` | Member | Leader | Leader | Leader |
| `real_matches` | Member | Leader OR (Organizer AND organizer_id=auth.uid()) | (Leader OR Organizer) AND status<>'approved' | Leader AND status<>'approved' |
| `match_lineups` | Member | — | is_match_organizer AND editable | — |
| `match_events` | Member | — | is_match_organizer AND editable AND created_by=auth.uid() | — |
| `match_substitutions` | Member | — | is_match_organizer AND editable AND created_by=auth.uid() | — |
| `match_approvals` | Via match league membership | actor_id=auth.uid() AND (Leader OR Organizer) | — | — |
| `scoring_rules` | Member | Leader | Leader | — |
| `player_match_points` | Member | WITH CHECK false (RPC only) | — | — |
| `manager_points` | Member | WITH CHECK false (RPC only) | — | — |
| `league_standings` | Member | WITH CHECK false (RPC only) | WITH CHECK false | — |
| `fantasy_points_history` | Member | WITH CHECK false (RPC only) | — | — |
| `notifications` | Own | — | Own (read_at) | Own |
| `league_activity` | Member | is_member AND profile_id=auth.uid() | — | — |
| `audit_logs` | Own or Leader | — | — | — |
| `mutation_ops` | Own | — | — | — |

### RPC Function Audit

| Function | Security Model | Authorization Check | Granted To |
|----------|---------------|---------------------|-------------|
| `join_league` | SECURITY DEFINER | auth.uid() not null | authenticated |
| `set_member_role` | SECURITY DEFINER | is_leader(p_league) | authenticated |
| `prevent_self_promotion` | SECURITY DEFINER trigger | is_leader(old.league_id) | — (revoked all) |
| `calculate_match_points` | SECURITY DEFINER | is_leader OR is_match_organizer | authenticated |
| `recalculate_standings` | SECURITY DEFINER | — | authenticated |
| `submit_match` | SECURITY DEFINER | is_leader OR is_match_organizer | authenticated |
| `approve_match` | SECURITY DEFINER | is_leader OR is_match_organizer | authenticated |
| `reject_match` | SECURITY DEFINER | is_leader OR is_match_organizer | authenticated |
| `build_match_state` | SECURITY DEFINER | is_member(v_league_id) | authenticated |

### Key Security Properties

1. **No client-supplied identity trust** — All authorization uses `auth.uid()` from the verified Supabase session
2. **League isolation** — All policies scope data to the user's league membership
3. **Defense in depth** — API authorization (`canManageMatch`) and database authorization (RLS) enforce the same model
4. **No self-approval restriction** — Both Leader and Organizer can approve their own submissions
5. **Points/standings protection** — Direct client writes are blocked (WITH CHECK false); only SECURITY DEFINER RPCs can write
6. **Search path safety** — All SECURITY DEFINER functions use `set search_path = pg_catalog, public`
7. **Minimal grants** — EXECUTE on RPCs granted only to `authenticated` role; no PUBLIC access

## Known Gaps

- Database integration tests could not be executed (no PostgreSQL/Docker available in this environment)
- RLS policies are statically verified via `rls.test.ts` and `verify-phase2-sql.mjs`
