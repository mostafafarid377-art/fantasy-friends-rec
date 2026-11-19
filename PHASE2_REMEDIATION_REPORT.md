# Fantasy Friends — Phase 2 remediation report

## Status

**Local remediation pass completed for the identified SQL/RLS/scoring defects. Database deployment remains NO-GO.** No Supabase project was contacted. No SQL was executed. No application data was read, imported, changed, or deleted.

## Source baseline

- Input: `fantasy-friends-phase2-step1-audited(1).zip` supplied in this conversation.
- The Supabase schema migration `supabase/migrations/0001_schema.sql` was compared byte-for-byte with `drizzle/0000_fluffy_prima.sql`; they are identical in this package.
- The package's existing Phase 2 audit still correctly identifies the remaining Drizzle-backed API routes. This remediation does not claim the application data layer has been migrated.

## Additional corrections in this revision

### 7. League Leader self-approval behavior

- Confirmed product requirement: the League Leader can approve even when they are also the Match Organizer.
- Removed the conditional self-approval rejection from `approve_match`; no separate toggle is required for this behavior.
- Updated the static RLS test to assert the approved behavior rather than expecting a self-approval error.

### 8. Match versioning and scoring-rule readiness

- `submit_match`, `approve_match`, and `reject_match` now increment `real_matches.version` atomically during each successful state transition.
- The still-active Drizzle `/api/matches/[id]/flow` path was updated too: all three transitions increment the version, updates use compare-and-swap predicates on the previously read version and state, and a concurrent loser receives HTTP 409 rather than silently overwriting the winner.
- Their `match_approvals.version` audit entries record the resulting version (`old version + 1`).
- Submission now requires at least one scoring rule and requires every scoring rule in the league to be approved, matching `calculate_match_points`.
- Added source-level assertions for all three version increments and their audit versions.

## Defects corrected locally

### 1. League activity column mismatch

- `join_league` inserted into `league_activity.actor_id`, but the schema defines `league_activity.profile_id`.
- The `activity_insert` RLS policy also referenced `actor_id` on `league_activity`.
- Both now use `profile_id`; `join_league` also rejects unauthenticated invocation before attempting membership writes.

### 2. `build_match_state` authorization and execution grants

- Reworked it as a read-only PL/pgSQL function that first resolves the match's league and verifies `public.is_member(league_id)` against `auth.uid()`.
- Explicitly revoked execution from `PUBLIC` and `anon`; only `authenticated` receives execute permission.
- The function uses a controlled `pg_catalog, public` search path.

### 3. Scoring and standings RPC exposure

- `calculate_match_points` now checks that the caller is authenticated and is a League Leader for the match's league.
- Direct execution of `calculate_match_points` and `recalculate_standings` is revoked from `PUBLIC`, `anon`, and `authenticated`. They remain internal owner-context operations invoked from the guarded approval flow.
- `approve_match` remains the public entry point for League Leader approval and invokes the scoring function after the match enters `approved` state.
- Product rule confirmed by the user: the League Leader may approve a result even when they are also its Match Organizer. The prior `allow_self_approval` rejection branch has been removed from the approval RPC; the approval action remains an explicit state transition.

### 4. SQL scoring parity with the TypeScript engine

Reworked SQL scoring to mirror `src/lib/scoring.ts` and the data flow in `src/lib/points.ts`:

- Includes `penalty_saved` and `penalty_missed`.
- Counts assists both from `goal.assist_player_id` and explicit `assist` events attributed to `player_id`.
- Counts own goals against the offender's team for clean-sheet eligibility.
- Preserves position-specific rule lookup for every scoring category.
- Produces a breakdown array with `category`, `label`, `count`, `pointsPer`, and `points`, matching the TypeScript breakdown shape.
- Calculates participants as starters plus players substituted on.
- Applies captain double only if the captain participated; applies vice-captain fallback only when `vice_policy = 'auto_captain'` and the vice-captain participated.
- Writes `fantasy_points_history` idempotently, which the old SQL implementation omitted.
- Rebuilds standings from the points ledger after manager points are updated.

No numerical scoring values were invented or changed; SQL reads approved `scoring_rules` rows.

### 5. Explicit SQL table privileges

- Added explicit revokes and least-privilege grants for application tables.
- `anon` receives no application-table grants.
- Point ledgers, standings, history, and match approval records are read-only to direct authenticated clients; privileged writes remain inside guarded RPCs.
- Direct UPDATE on `real_matches` is not granted, so state transitions must use the guarded match RPCs.
- Direct UPDATE on `league_members` is limited to the `team_name` column; role changes remain through `set_member_role`.
- Profile edits are column-limited; Auth-owned email/password/verification fields cannot be directly changed by clients.
- Squad player/captain references are checked against the same league. Match submission validates that teams, lineup players, events, assists, and substitutions belong to the correct match league/team.
- Activity and mutation-operation ledger writes are withheld from direct clients until trusted server/RPC paths are implemented.
- Session and auth-token tables have no direct client grants.

See `RLS_PRIVILEGE_MATRIX.md` for the full 26-table matrix.

### 6. Security-definer search paths

- Updated helper/RPC functions in the RLS and functions migrations to use `pg_catalog, public` rather than `public` alone.
- Revoked direct execution of the trigger function `prevent_self_promotion` from client roles.

## Tests and verification performed

- `node scripts/verify-phase2-sql.mjs` — **passed**. This checks source-level invariants, including schema parity, corrected activity column references, presence of scoring categories, internal-only scoring/standings RPC grants, match-state membership checks, explicit table grants, and absence of table-drop/truncate/data-delete statements in the active migrations.
- Schema parity check — **passed**; `0001_schema.sql` and the Drizzle baseline are byte-for-byte identical.
- `node scripts/verify-phase2-sql.mjs` — **passed** after this revision. It remains a source-level audit, not PostgreSQL execution.
- `node node_modules/typescript/bin/tsc --noEmit` — **passed** after the API route changes.
- Vitest — **not run in this Linux review container** because the uploaded `node_modules` contains Windows-installed optional native packages and the Linux Rolldown binding is missing. Run the test suite on the user's Windows environment after extracting this package.
- Next.js production build — **not run on this revised package**. The user should run it locally after the test suite.
- PostgreSQL migration execution — **not run**; no local PostgreSQL/Supabase runtime was available in this environment.

## Remaining blockers

1. Execute migrations against a disposable local PostgreSQL/Supabase environment and fix any runtime SQL errors.
2. Run the new scoring unit tests and the existing RLS/static test suite in a dependency-complete environment.
3. Review the full app route/API contracts and migrate the remaining Drizzle-backed route groups to Supabase. The existing Phase 2 audit lists those routes; this remediation has not migrated them.
4. Test the two-party approval state machine, retries, concurrent submissions/approvals, and mutation idempotency with database-level tests.
5. Implement trusted server/RPC writes for `league_activity` and `mutation_ops` as part of the idempotency/activity migration.
7. Review every table/column-level mutation path against the eventual Supabase data-access layer before deployment.
6. Inspect the actual target project's schema non-destructively before any deployment decision.

## Final decision

**NO-GO for deployment.** This package is a corrected local remediation candidate, not a production-ready migration set. Do not run `supabase db push` against `Hagz-fantasy`.

### 9. UI and settings consistency for League Leader approval

- Removed the obsolete self-approval warning from match details.
- Removed the configurable self-approval toggle from League settings and stopped accepting it through the league PATCH API.
- Match detail API responses no longer expose the obsolete flag.
- The legacy `allow_self_approval` database column is retained for schema compatibility and is no longer consulted by the approval flow or exposed as an application setting. No destructive schema change was introduced.

### 10. Production build bundler workaround

- Changed the production build script to `next build --webpack`. Next.js 16 defaults production builds to Turbopack; the supplied build log showed a failure in Turbopack's internal `next/font/google` loader. Webpack is an officially supported opt-out in Next.js 16.
- Font declarations and visual styling were left unchanged.
- The updated production build has **not** been executed in this review environment because dependency installation did not complete before timeout. Verify it on the Windows environment with the commands below.
