# Backup, Restore & Disaster Recovery — Fantasy Friends

All persistent state lives in the production Supabase Postgres database
(auth.users, profiles, leagues, squads, matches, points, notifications).
Player photos/team crests live in Supabase Storage. The app itself is
stateless on Vercel and redeployable from Git at any time.

## 1. What protects you today

| Layer | Coverage | RPO | RTO |
|---|---|---|---|
| Supabase daily backups (Free/Pro) | Whole database, daily, 7 days retained | 24h | Minutes–hours (dashboard restore) |
| Point-in-time recovery (Pro add-on) | Continuous WAL | ~minutes | Minutes–hours |
| This runbook + verify script | Human procedure, tested restore | — | — |

**Action:** confirm which tier the production project is on
(Dashboard → Settings → General). If backups are not visible under
Database → Backups, upgrade or schedule your own dumps (below).

## 2. Backup checklist (do once, review quarterly)

- [ ] Database → Backups shows scheduled daily backups and recent success.
- [ ] If on Pro: enable **Point in Time Recovery** (Database → Backups → PITR).
- [ ] Storage: enable object versioning if available on your plan, or accept
      that photos/crests are re-uploadable cosmetic assets (they are — the
      database holds no irreplaceable binary data).
- [ ] Quarterly: run the restore drill (§3) against a **disposable** project.
- [ ] Quarterly: export one manual logical backup and store it outside
      Supabase:
      `pg_dump "postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres" --format=custom --file=ff-backup-<date>.dump`
      (password = the database password set at project creation; never commit it).

## 3. Restore drill (disposable project only — never drill against prod)

> Practising a restore against production is itself an outage risk. Always
> drill into a fresh throwaway project.

1. Create a new Supabase project (free tier) named e.g. `ff-restore-drill`.
2. Restore/dump-load the latest production backup into it:
   - Dashboard restore: Supabase restores to the same project only — so use
     the logical dump instead:
     `pg_restore --clean --if-exists --dbname "postgresql://postgres:<drill-db-password>@db.<drill-ref>.supabase.co:5432/postgres" ff-backup-<date>.dump`
   - If the dump predates recent migrations, apply the missing
     `supabase/migrations/*.sql` in order (DATABASE_MIGRATION_GUIDE.md).
3. Verify the restored schema and data:
   - Run `scripts/verify-production-readonly.sql` in the drill project's SQL
     editor — every FAIL row must be `ok = true`.
   - Spot-check counts: `select count(*) from profiles; select count(*) from
     real_matches; select max(created_at) from match_events;` and compare
     with production's numbers (same queries — read-only).
4. Record the drill: date, backup age restored, row counts, time taken,
   issues found. File it in your ops notes.
5. Delete the drill project.

**A drill that has never succeeded is a backup you don't have.** If step 2
fails, fix the backup procedure before launch, not during an incident.

## 4. Disaster scenarios & recovery paths

**Bad deploy breaks the app (data fine)**
Vercel → Deployments → ⋯ → **Redeploy** the last good deployment. Instant;
no database involvement. Then `node scripts/ops-smoke.mjs <url>`.

**Bad migration damages schema or data**
1. Stop the app from writing: redeploy is not required — RLS plus the failed
   migration's errors usually block writes anyway; announce the maintenance.
2. Restore the pre-migration backup (dashboard) or PITR to just before the
   migration timestamp.
3. Re-apply migrations one at a time in the drill project first.
4. Verify with `scripts/verify-production-readonly.sql` before reopening.

**Supabase region outage**
Nothing to fix in-app. Health probes fail open with sanitized 500s
(`scripts/ops-smoke.mjs` reports DOWN). Wait for Supabase status to clear;
if the outage exceeds your tolerance, restore the latest backup into a
project in another region and point a redeployed Vercel env at it (env var
change + redeploy — the only step requiring console access).

**Leaked service-role key / credentials**
1. Supabase → Settings → API → **Roll** the service-role key (and anon key
   if indicated). Note: rolling invalidates existing user sessions.
2. Update Vercel env vars, redeploy.
3. Review `audit_logs` and `ff_rate_limit_windows` for suspicious windows.

## 5. What is NOT backed up (by design)

- `ff_rate_limit_windows` — ephemeral throttle state; safe to lose.
- Auth sessions/refresh tokens — users simply sign in again after a
  full restore (refresh tokens older than the restore point are invalid).
