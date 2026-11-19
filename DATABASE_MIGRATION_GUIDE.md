# Fantasy Friends — Database Migration Guide

This guide documents the Supabase migration sequence and how to safely apply it to a new empty database.

## Migration Sequence

Migrations must be applied in the following order:

| # | File | Description |
|---|------|-------------|
| 1 | `supabase/migrations/0001_schema.sql` | 26-table schema with foreign keys, constraints, and indexes |
| 2 | `supabase/migrations/0002_rls.sql` | Row Level Security policies, helper functions, table privileges |
| 3 | `supabase/migrations/0003_functions.sql` | SECURITY DEFINER RPC functions and integrity triggers |
| 4 | `supabase/migrations/0004_native_auth_profiles.sql` | Native Auth profile triggers |

## Applying Migrations

### Option A: Supabase CLI (Recommended)

```bash
# Link to your project
supabase link --project-ref your-project-ref

# Push migrations
supabase db push
```

### Option B: Manual via Supabase SQL Editor

1. Open the Supabase dashboard → SQL Editor
2. Paste and run each migration file in order
3. Verify no errors after each file

## Forward-Only Policy

- **Never modify already-applied migrations** — if a migration needs to change, create a new migration file
- **Never run `0000_destructive_removal.sql`** — it drops all application data and is kept only as historical reference
- **Never import old application data** into the new project
- **Never connect to or modify the existing `Hagz-fantasy` Supabase project**

## Migration Contents

### 0001_schema.sql — Schema
Creates 26 tables:
- `profiles`, `sessions`, `auth_tokens`, `mail_outbox`
- `leagues`, `league_members`, `invitations`
- `teams`, `players`
- `fantasy_squads`, `fantasy_squad_players`, `fantasy_fixtures`
- `real_matches`, `match_lineups`, `match_events`, `match_substitutions`, `match_approvals`
- `scoring_rules`, `player_match_points`, `manager_points`, `league_standings`
- `fantasy_points_history`, `notifications`, `league_activity`, `audit_logs`, `mutation_ops`

Includes foreign key constraints, check constraints (format, position, lineup slot), and indexes.

### 0002_rls.sql — Row Level Security
- Enables RLS on all 26 tables
- Helper functions: `is_member()`, `is_leader()`, `is_organizer()`, `is_match_organizer()`, `match_is_editable()`
- Policies for all tables enforcing league scope and role-based access
- Table-level GRANT/REVOKE for explicit privilege control
- Points/standings/history tables are read-only to clients (WITH CHECK false)

### 0003_functions.sql — RPC Functions
SECURITY DEFINER functions for privileged operations:
- `join_league(p_code, p_team_name)` — join a league via invite code
- `set_member_role(p_league, p_profile, p_role)` — leader-only role changes
- `prevent_self_promotion()` — trigger preventing self role elevation
- `calculate_match_points(p_match)` — deterministic point calculation
- `recalculate_standings(p_league)` — rebuild standings from ledger
- `submit_match(p_match)` — submit match result with validation
- `approve_match(p_match, p_version)` — approve match result
- `reject_match(p_match, p_reason, p_version)` — reject match result
- `build_match_state(p_match)` — read match state

All functions use `set search_path = pg_catalog, public`, revoke all from public/anon, grant execute to authenticated only.

### 0004_native_auth_profiles.sql — Native Auth
Profile synchronization triggers for Supabase Native Auth.

## Verification Checklist

After applying migrations:
- [ ] All 26 tables exist
- [ ] RLS is enabled on all tables
- [ ] All RPC functions exist and are executable by authenticated users
- [ ] No direct write access to points/standings/history tables
- [ ] `0000_destructive_removal.sql` was NOT executed
- [ ] Existing `Hagz-fantasy` project was NOT modified
