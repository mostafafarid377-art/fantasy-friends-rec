# Deployment readiness — Fantasy Friends Phase 2

**Decision: NO-GO.**

This remediation ZIP has not been deployed or executed against any database. The local static source audit passed, but PostgreSQL syntax/runtime behavior and actual RLS behavior remain unverified.

## What is locally corrected

- `league_activity` column references use `profile_id` consistently.
- `build_match_state` checks authenticated league membership and is not executable by `PUBLIC` or `anon`.
- Scoring and standings RPCs are not directly executable by client roles.
- SQL scoring includes all event categories currently handled by the TypeScript engine, own-goal clean-sheet effects, both assist attribution paths, captain/vice-captain fallback, breakdown details, and points history.
- Application-table privileges are explicit and least-privilege by operation; see `RLS_PRIVILEGE_MATRIX.md`.

## Why deployment is still blocked

- No PostgreSQL parser or disposable PostgreSQL/Supabase instance was available to execute the migrations.
- Vitest, typecheck, and Next.js build were not run on this modified package in this environment.
- The non-auth API routes and shared services still depend on Drizzle/PostgreSQL and have not been migrated to Supabase.
- Database-level tests for concurrency, idempotency, RLS, and the approval state machine remain outstanding.
- The actual target project's current schema and objects have not been inspected.

## Safe next step

Run the migrations and tests only in a disposable local Supabase/PostgreSQL project. Do not connect this package to `Hagz-fantasy` and do not run `supabase db push` there until every blocker above has evidence of passing.
