# Fantasy Friends Supabase deployment

All application data APIs use the cookie-scoped Supabase client and native
Supabase Auth. The app does not need `DATABASE_URL` or a service-role key.

## Existing Hagz-fantasy deployment

This release adds two forward-only migrations. Apply **only** the following
new files, in order, through the project's reviewed migration process:

1. `0005_confirmed_writes.sql`
2. `0006_write_side_effects.sql`

Then deploy the matching app build to Vercel. Confirm the production variables
still point to Hagz-fantasy (`zkrfgdiujpagaddsxbcb`):
`NEXT_PUBLIC_SUPABASE_URL` (project root, without `/rest/v1`) and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Keep all credentials out of Git.

Neither migration updates or backfills existing rows at deployment. The new
functions and triggers run on subsequent authorized app actions only. RLS
and table grants stay enabled and unchanged. Do not run the legacy destructive
migration, reset the database, or run an unrestricted `supabase db push`
against Hagz-fantasy; migrations `0001`–`0004` are the existing baseline.

After deploying, League Leaders in leagues with an empty Scoring screen can
choose **Initialize draft rules** and review them before approval. This is a
normal, authenticated app action; it does not overwrite existing rules.

## Empty local database setup

For a fresh Supabase-compatible instance only, migrations run in order from
`0001_schema.sql` to `0006_write_side_effects.sql`. The
`scripts/deploy-fresh-db.sh` helper deliberately refuses remote Supabase hosts,
including Hagz-fantasy.

For an empty disposable **plain PostgreSQL** database named `ff_test*` on
localhost, the integration helper supplies minimal Supabase Auth scaffolding:

```sh
export DATABASE_URL=postgresql://YOUR_LOCAL_DB_USER@localhost:5432/ff_test
node scripts/setup-local-integration.mjs
npm run test:integration
```

The integration suite truncates its fixture tables between runs. Only point
it at a disposable test database. The local scaffolding verifies database
constraints, RLS, grants and RPC transactions, not live Supabase Auth or REST.

See [PRODUCTION_WRITE_AND_PERFORMANCE_AUDIT.md](../PRODUCTION_WRITE_AND_PERFORMANCE_AUDIT.md)
for the verification results and live smoke checklist.
