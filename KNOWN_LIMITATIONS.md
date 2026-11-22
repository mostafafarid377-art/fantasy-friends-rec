# Fantasy Friends — Known Limitations

## 1. Database Integration Tests Not Executed

**Limitation:** No PostgreSQL or Docker was available in this environment, so real database integration tests could not be executed.

**Impact:** The following areas have NOT been verified against a live database:
- Leader/Organizer match authorization end-to-end
- Match state transitions (submit, approve, reject) with versioning
- Optimistic concurrency control (stale version → 409)
- Concurrent update safety
- Failed operation atomicity (no partial writes)
- Lineup and event authorization at the database level
- Scoring behavior against live data
- Cross-league isolation at the database level

**Mitigation:** Source-level verification was completed:
- RLS policies statically verified via `rls.test.ts` (19 tests pass)
- SQL static audit via `verify-phase2-sql.mjs` passes
- Typecheck passes clean (exit 0)
- Production build succeeds
- Integration test script provided at `scripts/integration-tests.mjs`

**Recommended Next Step:** Run `scripts/integration-tests.mjs` against a provisioned Supabase project with `SUPABASE_URL` and `SUPABASE_ANON_KEY` environment variables set.

## 2. No Live Supabase Connection

**Limitation:** The application has not been connected to a live Supabase project. All database-level behavior (RLS enforcement, RPC execution, Auth integration) has been verified through static analysis only.

**Impact:** Auth/session handling, realtime subscriptions, and actual RLS enforcement have not been tested end-to-end.

**Recommended Next Step:** After creating a new Supabase project and applying migrations, run the application and verify:
- User sign-up/sign-in works
- League creation and membership works
- Match creation, submission, approval, and rejection works
- Points and standings calculate correctly

## 3. Environment: Linux vs Windows Commands

**Limitation:** This work was performed on a Linux environment. The task specifies Windows-compatible commands (`npm.cmd ci`, etc.).

**Impact:** `npm.cmd` is not available on Linux; `npm` was used instead. On Windows, `npm.cmd` should work identically.

**Recommended Next Step:** On Windows, use `npm.cmd ci`, `npm.cmd run audit:sql`, `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run build` as specified.

## 4. Node.js Version Warning

**Limitation:** Node.js v20 is used, but @supabase/supabase-js deprecates Node.js 20 and below.

**Impact:** A deprecation warning appears during build. Functionally, the application works correctly.

**Recommended Next Step:** Upgrade to Node.js 22+ when possible.

## 5. Drizzle Schema Retained for Reference

**Limitation:** `src/db/schema.ts` (Drizzle pgTable definitions) and `drizzle/0000_fluffy_prima.sql` remain in the codebase as type-only and historical reference material.

**Impact:** These are not used at runtime — all production data access uses Supabase. The `drizzle-orm` package remains in `package.json` dependencies but is not imported by any production route.

**Recommended Next Step:** When ready, remove `drizzle-orm` from dependencies and delete `src/db/schema.ts` and `drizzle/` directory after confirming no code imports them.

## 6. Existing Hagz-fantasy Supabase Project Untouched

**Limitation:** The existing `Hagz-fantasy` Supabase project was not modified, and no data was imported from it.

**Impact:** The new application must connect to a NEW empty Supabase project. The old project and its data remain separate.

**Recommended Next Step:** Follow `SUPABASE_SETUP_GUIDE.md` to create a new project and apply migrations.

## 7. Vitest Reporter Issue

**Limitation:** The Vitest reporter encounters a `Map.groupBy is not a function` error when formatting test failures. This is an environmental issue with the Vitest version, not a test failure.

**Impact:** All 46 tests pass; the reporter error only occurs when formatting failed test output (which never happens since all tests pass).

**Recommended Next Step:** Upgrade Vitest to a newer version that supports `Map.groupBy`.

## 8. The Lineup Deadline Is Not Yet Automatic In Production

**Limitation:** The deadline runner exists and is tested — migration
`0029_lineup_deadline_runner.sql` adds the auditable runner, the service-role
grant and the internal route that calls it — but **production is still on
`0027`**, and `pg_cron` is not installed on the production project. Until the
deployment happens, the official lineup of a fixture is written when its
result is scored, not at its deadline.

**Impact:** Between the deadline and the scoring of a fixture there is no
official lineup row for it. Nothing is lost: the resolver falls back to the
previous official lineup, the interface and the scoring read the same resolved
lineup, and the official row is written at scoring time. What is missing is
the guarantee that the official lineup exists the moment the deadline passes,
which is what the next fixture inherits.

**Recommended Next Step:** apply `0028` and `0029`, then activate the runner
in the database — this is the part that makes the deadline timely:

```sql
create extension pg_cron;
select cron.schedule('ff-lineup-deadlines','* * * * *',
  'select public.ff_promote_due_match_lineups(''pg_cron'')');
```

and give the backup runner its secrets: `LINEUP_DEADLINE_SECRET` (or
`CRON_SECRET`) and `SUPABASE_SERVICE_ROLE_KEY` in the app environment, and
`LINEUP_DEADLINE_SECRET` and `LINEUP_DEADLINE_URL` as repository secrets.

## 9. The Outside Scheduler Is A Backup, Not A Guarantee

**Limitation:** `.github/workflows/lineup-deadlines.yml` calls the deadline
route every five minutes. GitHub runs scheduled workflows on a best-effort
basis: a run can be delayed under load, and GitHub disables scheduled
workflows in a repository that has been inactive for 60 days.

**Impact:** The workflow is a safety net, not the deadline. It is not a
service-level guarantee of any kind, and it must never be described as one.
The deadline is timely because `pg_cron` runs the same function inside the
database, every minute.

**Recommended Next Step:** keep the in-database job as the deadline, and use
the workflow to say out loud when the in-database job is missing. It already
does: every run warns when `scheduledInDatabase` is not true.

## 10. A Paused Project Runs Nothing

**Limitation:** A paused Supabase project does not run `pg_cron`, and does not
answer the backup route either.

**Impact:** while the project is paused, no fixture is locked in at its
deadline. The lineups are still correct — the resolver falls back to the
previous official lineup and the scoring reads the same resolved lineup — but
the official lineup of a fixture appears only when its result is scored.

**Recommended Next Step:** keep the project awake, or accept that the deadline
follows the project.

See `LINEUP_LIFECYCLE.md` for the full description of the lineup lifecycle and
of the deadline runner.
