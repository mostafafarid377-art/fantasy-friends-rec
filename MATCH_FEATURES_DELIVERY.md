# Fantasy Friends match features — delivery and verification

Branch: `arena/9da30ef6-fantasy-friends-rec` (base `afc242d`). No deployment, production migration, production-data change, or external configuration change was performed.

## Implemented

- **Kickoff deadlines:** PostgreSQL checks `timestamptz` against its own wall clock before and after squad/lineup writes. Squad writes are serialized with match schedule changes, and direct table writes cannot skip validation. The squad UI shows a live countdown and read-only saved picks at kickoff. Authorized real-lineup editing and kickoff rescheduling stop when the match starts.
- **Scoring:** Goalkeepers receive one point per full three saves. Defenders receive two per full ten defensive contributions; midfielders and forwards receive two per full twelve. Stats are isolated by match and use the position registered on the real lineup. An explicit stat correction atomically updates player points, manager points, history, standings and the receipt without changing frozen picks or multipliers.
- **Bonus:** Match organizers assigned to the match or league leaders can save +3/+2/+1 for three distinct participants during result preparation. The workflow rejects unused bench players, foreign players and duplicate ranks. Awards remain frozen once finalized. Points are included in the official ledger and have a separate breakdown line.
- **Real-team logos:** Team create/edit offers gallery/file upload and mobile camera capture, preview, replace and remove. The browser optimizes the image and the backend verifies, re-encodes and strips metadata before writing WebP to a private bucket. Existing external crests still work. The logo component uses a shield on missing/broken images. Logos appear in real-team lists, match cards, details and results, and player/team and opponent displays. Standings show fantasy squad names, not real teams, and intentionally don't attach real-team logos to those names.
- **Google names:** The database profile-creation trigger reads Google `full_name`, then `name`, then the existing fallback. Future sign-ins never replace a customized display name; email/password initialization is unchanged. Existing profile readers already use the saved display name in session, profile, members and rankings.

No Gameweek tables, screens, scheduling, or scoring dependencies were added. Legacy fields and historical projections were left intact.

## New migrations

| Migration | Purpose |
| --- | --- |
| `0014_match_deadlines.sql` | Trusted kickoff guards, protected write RPCs, deadline index, and captured real-lineup positions. |
| `0015_match_statistics_and_bonuses.sql` | Per-match stat totals and unique ranks, read-only member RLS, participation checks, official ledger integration, and atomic finalized stat corrections. |
| `0016_team_logos.sql` | Private Storage bucket and role-scoped policies, same-team crest reference validation, and opponent crest reads. |
| `0017_google_profile_names.sql` | First-time Google display name initialization without rewriting existing profiles. |

## Verification commands and results

These are the final verification commands. The two `DATABASE_URL` values are local, disposable databases on a PostgreSQL 18.7 server used for this branch, not credentials or URLs for a hosted project.

| Command | Actual result |
| --- | --- |
| `npm ci` | Installed lockfile dependencies. |
| `npm test` | 130 passed in 21 files. Includes pure scoring/squad tests and mocked HTTP, UI, OAuth and Storage tests. Logo route tests use real Sharp image processing with mocked Storage; preview tests mock browser canvas/image decoding. |
| `DATABASE_URL=postgresql://user@localhost:55432/ff_test_match_features node scripts/setup-local-integration.mjs` | Applied all migrations `0001`–`0017` on fresh local PostgreSQL. |
| `DATABASE_URL=postgresql://user@localhost:55432/ff_test_match_features npm run test:integration` | 55 passed against real PostgreSQL. Tests execute real RPCs, triggers, constraints, scoring and RLS as authenticated roles. Auth sessions and Storage object metadata are locally simulated; the suite does not contact Google, Supabase Auth, PostgREST or the hosted Storage service. |
| `DATABASE_URL=postgresql://user@localhost:55432/ff_test_match_upgrade node scripts/setup-local-integration.mjs 0013` | Prepared a separate local database through the base schema. |
| `DATABASE_URL=postgresql://user@localhost:55432/ff_test_match_upgrade node scripts/verify-match-features-upgrade.mjs` | Applied `0014`–`0017` and verified unchanged existing records in 12 seeded tables, including customized profiles and league rules, squads, match results, player points, and the receipt. No new statistics were invented. |
| `npm run typecheck` | Passed. |
| `npm run lint` | Could not run: the repository has a lint script and ESLint 9.39.4 but no `eslint.config.*`. No lint pass is claimed. |
| `npm run build` | Production Next.js webpack build passed. |
| `npm run audit:sql` | Static SQL checks passed. |
| `bash -n scripts/deploy-fresh-db.sh` | Passed. |
| `node --check scripts/setup-local-integration.mjs` | Passed. |
| `node --check scripts/verify-match-features-upgrade.mjs` | Passed. |
| `git diff --check` | Passed. |

## Rollout, manual setup, and remaining checks

1. **Ready for staging, not yet production-verified.** Apply migrations `0014`–`0017` in order to a staging project that already has `0001`–`0013`, then deploy the app there. Review existing past unfinished matches first: the current squad is shared within each league and stays read-only while any started match is awaiting finalization. Review or legitimately finalize old open matches rather than moving kickoff to circumvent the lock.
2. The migration creates `team-logos`; no manual bucket or service-role configuration is required on a fresh environment. If a bucket of that name already exists, confirm it is private and configured for WebP and a 1 MiB cap. Smoke-test upload, replacement, removal and cross-league access with the actual staging Storage endpoint and a mobile device.
3. No new Google Cloud/Supabase Auth configuration is required for a working Google sign-in. A new staging environment needs the project's normal Google provider setup and redirect allowlist. Sign in with a new Google account, customize its name, sign in again, and verify password sign-in separately. **Live Google OAuth, hosted Storage, and mobile camera capture were not tested.**
4. Old lineups without a stored match position use the current roster position when stats are first added. No old position or statistics are inferred in the migration. Legacy approved scoreless matches remain unchanged and are not eligible for the finalized statistic correction path.

See `supabase/DEPLOYMENT.md` for the ordered rollout and smoke checks. Production changes require explicit approval.

## Every file changed

- `MATCH_FEATURES_DELIVERY.md`
- `scripts/deploy-fresh-db.sh`
- `scripts/setup-local-integration.mjs`
- `scripts/verify-match-features-upgrade.mjs`
- `src/app/(app)/history/page.tsx`
- `src/app/(app)/matches/[id]/page.tsx`
- `src/app/(app)/matches/new/page.tsx`
- `src/app/(app)/matches/page.tsx`
- `src/app/(app)/players/page.tsx`
- `src/app/api/leagues/[id]/players/[playerId]/performance/route.ts`
- `src/app/api/leagues/[id]/squad/route.ts`
- `src/app/api/leagues/[id]/teams/[teamId]/logo/route.ts`
- `src/app/api/matches/[id]/route.ts`
- `src/app/api/matches/[id]/statistics/route.ts`
- `src/app/api/matches/route.ts`
- `src/components/AppShell.tsx`
- `src/components/MatchResult.tsx`
- `src/components/MatchStatistics.tsx`
- `src/components/PlayerPerformance.tsx`
- `src/components/PlayerPhotoField.tsx`
- `src/components/SquadPicker.tsx`
- `src/components/SquadScreen.tsx`
- `src/components/TeamLogo.tsx`
- `src/db/schema.ts`
- `src/lib/__tests__/integration/postgres.test.ts`
- `src/lib/__tests__/match-lineup-page.test.tsx`
- `src/lib/__tests__/match-lineup-routes.test.ts`
- `src/lib/__tests__/match-statistics-route.test.ts`
- `src/lib/__tests__/match-statistics-ui.test.tsx`
- `src/lib/__tests__/player-performance-routes.test.ts`
- `src/lib/__tests__/squad-page.test.tsx`
- `src/lib/__tests__/squad-routes.test.ts`
- `src/lib/__tests__/team-logo-routes.test.ts`
- `src/lib/__tests__/team-logo-ui.test.tsx`
- `src/lib/client/api.ts`
- `src/lib/match-deadline.ts`
- `src/lib/player-performance.ts`
- `src/lib/roster.ts`
- `src/lib/scoring.ts`
- `src/lib/squad.ts`
- `src/lib/team-logo.ts`
- `supabase/DEPLOYMENT.md`
- `supabase/migrations/0014_match_deadlines.sql`
- `supabase/migrations/0015_match_statistics_and_bonuses.sql`
- `supabase/migrations/0016_team_logos.sql`
- `supabase/migrations/0017_google_profile_names.sql`
