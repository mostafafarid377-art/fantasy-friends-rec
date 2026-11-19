# Fantasy Friends — confirmed writes and performance audit

## Scope and production evidence

I inspected Hagz-fantasy (`zkrfgdiujpagaddsxbcb`) through read-only catalog and
aggregate queries. Production `players.id` and `teams.id` are `NOT NULL` text
primary keys without defaults. The same is true for several other creation
paths. The old routes omitted the IDs, discarded PostgREST errors, returned
HTTP 201 with `null`, and the Players page toasted success based on the HTTP
status alone. Separately, roster GET returned snake_case and the UI read
camelCase. Both existing leagues had zero scoring rules at inspection time;
the old non-atomic seeding path omitted rule IDs and ignored insert errors.
No project, record, setting, key, or deployed Vercel build was changed.

## Write paths and confirmation

| Operation | End-to-end path and result |
| --- | --- |
| Add/edit/archive player | Players form → league-scoped API → cookie-authenticated leader and team/league checks → `players` write with explicit ID on create → check PostgREST and returned row/league/ID → frontend applies the confirmed DTO. List and picker use the same camelCase contract. The database also rejects a player linked to a team outside its league. |
| Add team | Players form → scoped leader API → explicit ID and `INSERT … RETURNING` → apply confirmed row to the team picker and filters. The DB prevents case-insensitive duplicates within a league without changing existing names. |
| Create league | Leagues form → `create_league_confirmed` with an account-scoped retry key → atomic league + leader membership + standings + activity + 44 draft rules → authenticated membership read by the returned ID → refresh league session and select that league. |
| Join league | Join form → `join_league` invite-code RPC → atomic membership + standings + activity, safe to repeat → verify own membership before selection. The old API tried to read a private league and write standings directly, which the authenticated role cannot do. |
| Schedule fixture | Fixtures form → scoped leader API → confirm inserted fixture. The trigger records league activity and notifies league members in the same transaction. Listing, editing, and deletion use the actual fixture fields and league scope. |
| Create/edit match | Match form/API → guarded match function → check role, teams, and fixture belong to the same league → create/edit and link fixture transactionally → confirm returned match. Match detail and list use consistent field names. |
| Create/save squad and players | Squad editor → check membership, selected player IDs and formation → `save_fantasy_squad` writes the user's squad and entries in a single transaction → verify all returned entries. Any failed replacement rolls back instead of deleting the old squad. An unconfirmed save is not a success. |
| Match lineups, events, substitutions | Match detail → guarded match RPCs verify the league, assigned organizer or leader, match status, and relevant team/player IDs → confirm rows. A failed lineup replacement retains the previous lineup. |
| Submit, approve, reject | Review form → existing guarded match-state RPCs → status, approval history and (on approval) points written atomically → read back match state and version. The old path tried to write restricted status/approval columns directly. |
| Scoring configuration | Rules form → leader-only batch RPC, or confirmed approval update → confirmed result. Legacy empty leagues have a leader-only, idempotent **Initialize draft rules** action with no overwrite or automatic approval. |
| Signup/profile | Native Supabase Auth `signUp` and its profile trigger; email verification requested is not treated as proof of a new account. Profile edits confirm the updated row. Auth email flows report requests, not proof of mail delivery. |
| Other created rows | Roles use the existing guarded RPC. Activity, audit, and application notifications come from narrow database functions/triggers tied to actual writes. No new direct grants to write them. Previously, session-scoped inserts into these protected tables and the retry ledger were silently rejected. |

The recovery queue only replays supported creates for the same authenticated
account. Previously queued auth credentials are removed rather than replayed;
a pending edit cannot overwrite a later save. API errors retain their useful
operation/status and, for internal database failures, log diagnostics server-side.

## Performance

Main bottlenecks: two session requests on initial protected load, a full session
refresh on each navigation, sequential reads, repeated auth/profile work for
membership checks, match lists transferring whole event rows, and up to 44
separate writes when saving a full rule set. Some errors were converted into
empty lists. Audit found no interval polling in the app; the route-change
refresh was the repeated work. No broad persistent client cache was added.

| Metric | Before | After |
| --- | ---: | ---: |
| Browser `/api/auth/session` requests on normal first protected load (source trace) | 2 | 0 (one server snapshot, reused by shell) |
| Shell-triggered session requests per internal navigation (source trace) | 1 | 0 (explicit refresh after relevant mutations or on window focus) |
| Supabase round trips for dashboard with a squad and recent matches, excluding proxy and session bootstrap (source trace) | Up to 14 | 9 |
| Rule writes for 44 rows (source trace) | 44 | 1 batch |
| Roster GETs immediately after a confirmed player/team mutation | 1 | 0 (UI regression test verifies direct update) |
| Local warm p50, bounded authenticated match query, 50,000 rows | 429.566 ms | 0.263 ms |
| Initial JS, Dashboard / Players (gzipped build manifests) | 148.7 / 150.5 KiB | 149.4 / 151.6 KiB |

The SQL benchmark is the same ordered `LIMIT 30` query with and without the
new league/kickoff/ID index, under `authenticated` and RLS. PostgreSQL 18.7,
one warmup plus 10 samples per case. It moved from a sort to an index scan
(shared hit blocks 100,962 → 64); this is not end-to-end page latency. The normal
match list retrieves 31 summary rows to check for another page, returns 30,
and doesn't count the full table; History retains its exact approved count.
The roster uses bounded DB reads but keeps complete selection/search semantics;
the Players page renders 50 entries at a time. There are existing loading
skeletons, with route-scoped data/error state to avoid stale content on changes.

Bundle sizes are effectively flat; the reliability changes add about 1 KiB.
The original build failed here because it attempted to download Google fonts.
For the JS comparison only, the baseline checkout was rebuilt with the same
local font configuration. The release uses local, licensed WOFF2 assets for
the existing font families, with only the main typeface preloaded. Roster
and avatar images lazy-load and decode asynchronously. Arbitrary profile and
player image hosts are not added to the server image loader. The base checkout
also references marketing/auth `/images/...` files that are absent from this
repository; their hosting should be verified separately.

## Verification and deployment checklist

- `npm run typecheck`, `npm run build`, `npm run audit:sql` — passed.
- `npm test` — 57 passed (existing suites, route-contract regressions and UI
  regression tests). The UI test verifies immediate visibility, picker options,
  a fresh mount that re-reads both entities, and no success for null, wrong-league,
  or forbidden responses. Its HTTP boundary is a test double, not production code.
- `npm run test:integration` — 29 passed against disposable PostgreSQL with
  all six migrations. This verifies real SQL persistence across sessions,
  ownership, RLS denial and isolation, guarded review, same-key retry,
  rollback, scoped notifications and recovered draft rules. The old approval
  test assumed forbidden direct status writes; it now exercises the actual
  state machine and still asserts the direct write is forbidden.
- Not run: live Vercel/browser smoke against authenticated Hagz-fantasy,
  PostgREST schema-cache/cookie rotation checks, or live timing/Core Web Vitals.
  The connector provided read-only production inspection in this turn, not
  app test accounts or a production browser session. No production test rows
  were created and no migration or Vercel deploy was run.

**Rollout:** Apply only the two new migrations, then deploy the matching app
build. See [supabase/DEPLOYMENT.md](supabase/DEPLOYMENT.md). For the first signed-in
browser smoke, use an approved test league and accounts:

1. As leader, create a team and assign it to a new player. Check the immediate
   list and picker, hard-reload, and sign out/in. Verify both records still
   appear in the correct league and not in a second league.
2. As manager or non-member, attempt to create both records through the API.
   Expect 403 (or 401 signed out), no new rows and no success notification.
3. Verify league create/join, rule initialization on an empty league, an
   organizer creating a fixture-linked match, squad save/reload, both lineups,
   an event/substitution, and submit/reject/approve with notifications.
4. Check session refresh after expiry and measure real page transitions on the
   deployed build. Validate static marketing/auth image hosting separately.

## Changed files
- `PRODUCTION_WRITE_AND_PERFORMANCE_AUDIT.md`
- `scripts/deploy-fresh-db.sh`
- `scripts/setup-local-integration.mjs`
- `src/app/(app)/dashboard/page.tsx`
- `src/app/(app)/fixtures/page.tsx`
- `src/app/(app)/history/page.tsx`
- `src/app/(app)/layout.tsx`
- `src/app/(app)/leagues/page.tsx`
- `src/app/(app)/matches/[id]/page.tsx`
- `src/app/(app)/matches/new/page.tsx`
- `src/app/(app)/matches/page.tsx`
- `src/app/(app)/members/page.tsx`
- `src/app/(app)/notifications/page.tsx`
- `src/app/(app)/players/page.tsx`
- `src/app/(app)/profile/page.tsx`
- `src/app/(app)/rules/page.tsx`
- `src/app/(app)/settings/page.tsx`
- `src/app/(app)/team/page.tsx`
- `src/app/(app)/team/pick/page.tsx`
- `src/app/(auth)/forgot/page.tsx`
- `src/app/(auth)/login/page.tsx`
- `src/app/(auth)/reset/page.tsx`
- `src/app/(auth)/signup/page.tsx`
- `src/app/(auth)/verify/page.tsx`
- `src/app/api/auth/session/route.ts`
- `src/app/api/auth/signup/route.ts`
- `src/app/api/dashboard/route.ts`
- `src/app/api/leagues/[id]/fixtures/route.ts`
- `src/app/api/leagues/[id]/members/route.ts`
- `src/app/api/leagues/[id]/players/[playerId]/route.ts`
- `src/app/api/leagues/[id]/players/route.ts`
- `src/app/api/leagues/[id]/route.ts`
- `src/app/api/leagues/[id]/rules/route.ts`
- `src/app/api/leagues/[id]/squad/route.ts`
- `src/app/api/leagues/[id]/teams/route.ts`
- `src/app/api/leagues/join/route.ts`
- `src/app/api/leagues/route.ts`
- `src/app/api/matches/[id]/events/route.ts`
- `src/app/api/matches/[id]/flow/route.ts`
- `src/app/api/matches/[id]/lineup/route.ts`
- `src/app/api/matches/[id]/route.ts`
- `src/app/api/matches/route.ts`
- `src/app/api/me/route.ts`
- `src/app/api/notifications/route.ts`
- `src/app/fonts/barlow-condensed-LICENSE.txt`
- `src/app/fonts/barlow-condensed-latin-600-normal.woff2`
- `src/app/fonts/barlow-condensed-latin-700-normal.woff2`
- `src/app/fonts/barlow-condensed-latin-800-normal.woff2`
- `src/app/fonts/ibm-plex-mono-LICENSE.txt`
- `src/app/fonts/ibm-plex-mono-latin-400-normal.woff2`
- `src/app/fonts/ibm-plex-mono-latin-500-normal.woff2`
- `src/app/fonts/ibm-plex-mono-latin-600-normal.woff2`
- `src/app/fonts/ibm-plex-mono-latin-700-normal.woff2`
- `src/app/fonts/ibm-plex-sans-latin-wght-normal.woff2`
- `src/app/fonts/variable-ibm-plex-sans-LICENSE.txt`
- `src/app/layout.tsx`
- `src/components/AppShell.tsx`
- `src/components/LeagueContext.tsx`
- `src/components/Pitch.tsx`
- `src/components/ui.tsx`
- `src/lib/__tests__/integration/postgres.test.ts`
- `src/lib/__tests__/players-page.test.tsx`
- `src/lib/__tests__/rls.test.ts`
- `src/lib/__tests__/roster-routes.test.ts`
- `src/lib/auth.ts`
- `src/lib/client/api.ts`
- `src/lib/db-result.ts`
- `src/lib/league-membership.ts`
- `src/lib/matches.ts`
- `src/lib/roster.ts`
- `src/lib/rules.ts`
- `src/lib/server.ts`
- `src/lib/session.ts`
- `src/proxy.ts`
- `supabase/DEPLOYMENT.md`
- `supabase/migrations/0005_confirmed_writes.sql`
- `supabase/migrations/0006_write_side_effects.sql`
