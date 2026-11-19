# Fantasy Friends — Phase 2 migration audit

**Current status: NO-GO for database deployment.** A local remediation pass has corrected the identified SQL/RLS/scoring defects. No Supabase project was contacted, no SQL was executed, and no application data was read, imported, changed, or deleted.

## What is already working

- Native Supabase Auth signup, email verification, sign-in, sign-out, and recovery routes are present.
- The app's session adapter resolves the identity from `supabase.auth.getUser()`.
- The original Phase 2 package passed the user's local `npm.cmd run typecheck` and `npm.cmd run build` checks. Those results predate the remediation edits and must not be treated as verification of this updated ZIP.

## Remediation completed locally

- Corrected `league_activity` column references in `join_league` and the activity insert policy from `actor_id` to the schema's `profile_id`.
- Added authentication and membership checks to `build_match_state`; restricted its execute grants.
- Restricted direct execution of scoring and standings recalculation RPCs to internal owner-context calls.
- Reworked SQL scoring to cover all categories in the TypeScript engine, both assist attribution forms, own-goal clean-sheet effects, captain/vice-captain fallback, detailed breakdowns, and points history.
- Added same-league validation for match teams, lineup players, events, assists, and substitutions at submission time; squad player/captain references are also league-scoped.
- Added explicit least-privilege SQL table and column grants, kept Auth-owned profile fields protected, and documented the 26-table policy/grant matrix. Activity and idempotency writes are withheld from direct clients pending trusted RPC implementation.
- Standardized `SECURITY DEFINER` search paths across RLS helpers, application RPCs, and native Auth profile triggers; restricted direct trigger-function execution.

See `PHASE2_REMEDIATION_REPORT.md` and `RLS_PRIVILEGE_MATRIX.md` for details.

## Remaining legacy database dependencies

The following route groups still import Drizzle or call shared helpers that use Drizzle/PostgreSQL. They will continue to fail without `DATABASE_URL` until migrated:

- Dashboard, health, and profile/session support.
- Leagues: create/list/detail/join, members, teams, players, fixtures, rules, squads, points, standings.
- Matches: list/create/detail, lineups, events, substitutions, match flow and approval.
- Notifications.
- Shared server helpers: membership checks, notifications, activity/audit logging, and mutation idempotency.
- Domain services: match loading, points calculation, and rule seeding.

The current `/api/health` endpoint is also still Drizzle-backed; `/api/supabase/health` only proves the Supabase Auth endpoint is reachable.

## Verification status

- Schema parity: `0001_schema.sql` matches `drizzle/0000_fluffy_prima.sql` byte-for-byte.
- Source-level SQL audit: `node scripts/verify-phase2-sql.mjs` passed.
- Scoring unit tests were added but have not been run in this environment.
- PostgreSQL migrations were not parsed or executed against a database.
- Updated package typecheck and production build have not been run.

## Deployment blockers

- The 22 non-auth API route files and shared services have not been migrated from Drizzle to Supabase.
- Database-level tests for RLS, RPC authorization, idempotency, concurrency, match approval, scoring, and standings remain outstanding.
- The legacy `allow_self_approval` column remains in the schema for compatibility but is no longer exposed or consulted; League Leader self-approval is permitted by the confirmed product rule.
- The updated SQL has not been executed against disposable PostgreSQL/Supabase.
- The target project's existing schema has not been inspected non-destructively.

## Data safety constraints

- No legacy user or application data import is planned.
- No table drop, project reset, destructive migration, or data cleanup is authorized.
- Do not run `supabase db push` against `Hagz-fantasy` yet.
