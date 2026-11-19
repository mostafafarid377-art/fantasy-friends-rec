
# Fantasy Friends Supabase deployment

## Current status (2026-11-19)

All application data APIs (leagues, players, squads, matches, points,
standings, notifications) use Supabase exclusively via `@/db`
(`getSupabase()` → `createServerClient`). No production route depends on
`DATABASE_URL` or legacy Drizzle. The SQL migrations have been audited and
applied successfully against a fresh PostgreSQL database.

## Important status

**DO NOT RUN `supabase db push` against the Hagz-fantasy project.** The
migrations are designed for fresh-database deployment only. Use
`scripts/deploy-fresh-db.sh` against a local or disposable PostgreSQL instance.

## Migration order

For a brand-new, empty project only:

1. `0001_schema.sql`
2. `0002_rls.sql`
3. `0003_functions.sql`
4. `0004_native_auth_profiles.sql`

Do not run `supabase/legacy/0000_destructive_removal.sql`.
Do not use `supabase db reset` or any DROP/TRUNCATE operation.

## Fresh-database deployment

```
DATABASE_URL="postgres://user:pass@host:5432/dbname" \
  CONFIRM_DEPLOY=yes \
  ./scripts/deploy-fresh-db.sh
```

The script requires `CONFIRM_DEPLOY=yes` and refuses to run against denylisted
Supabase project refs (including `zkrfgdiujpagaddsxbcb` / Hagz-fantasy).

## Local environment

Keep `.env.local` out of Git and ZIP archives. Set:

- `NEXT_PUBLIC_SUPABASE_URL` to the project root URL (without `/rest/v1`)
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to the publishable key

No `DATABASE_URL` is needed by application routes.

## Verification

1. `npm.cmd install`
2. `npm.cmd run typecheck` — must pass
3. `npm.cmd run audit:sql` — must pass
4. `npm.cmd run build` — must pass
5. `npm.cmd test` — unit tests (46/46) must pass
6. `npm.cmd run test:integration` — PostgreSQL integration tests (requires DATABASE_URL)

## Integration tests

`src/lib/__tests__/integration/postgres.test.ts` covers:
- Schema deployment (all 4 migrations)
- RLS policies with separate authenticated sessions
- Atomic league creation via `create_league()` RPC
- Join league via invite code
- Squad creation
- Match management (create, events, approve/reject)
- Scoring and standings
- RPC grants for `authenticated` role

