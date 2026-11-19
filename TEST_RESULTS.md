# Fantasy Friends — Test Results

**Date:** 2026-11-19
**Environment:** Linux (Node.js v20.20.2, npm v10.8.2)
**No PostgreSQL or Docker available** — database integration tests could not be executed

## 1. Static Tests (Vitest)

| Test File | Tests | Passed | Failed | Result |
|-----------|-------|--------|--------|--------|
| `src/lib/__tests__/rls.test.ts` | 19 | 19 | 0 | ✅ Pass |
| `src/lib/__tests__/scoring.test.ts` | 13 | 13 | 0 | ✅ Pass |
| `src/lib/__tests__/squad.test.ts` | 14 | 14 | 0 | ✅ Pass |
| **Total** | **46** | **46** | **0** | ✅ **All pass** |

### rls.test.ts — 19 Tests
| Category | Tests | Result |
|----------|-------|--------|
| schema migration | 3 | ✅ Pass |
| row level security | 6 | ✅ Pass |
| privileged functions | 7 | ✅ Pass |
| destructive migration safety | 3 | ✅ Pass |

### scoring.test.ts — 13 Tests
Position-based scoring, appearances, clean sheets, goals, assists, cards, penalties, determinism, draft rules.

### squad.test.ts — 14 Tests
League format rules, formation validation, captain/vice-captain, lineup validation.

## 2. Typecheck

| Command | Exit Code | Result |
|---------|-----------|--------|
| `tsc --noEmit` | 0 | ✅ Clean |

## 3. SQL Audit

| Command | Exit Code | Result |
|---------|-----------|--------|
| `node scripts/verify-phase2-sql.mjs` | 0 | ✅ Passed |

Static source-level audit checks:
- Supabase schema matches Drizzle baseline byte-for-byte
- RPC functions use correct column names (profile_id, not actor_id)
- Activity insert policy uses profile_id, not actor_id
- All 9 scoring categories present in SQL
- Own goals counted against offender team for clean sheets
- SQL counts explicit assist events and goal assist_player_id attribution
- SQL implements configured vice-captain fallback
- SQL updates fantasy points history ledger
- Match submission validates same-league teams, lineup ownership, event/assist ownership, substitution participants
- `calculate_match_points` and `recalculate_standings` revoked from public/anon/authenticated, then granted to authenticated
- `calculate_match_points` verifies Leader or Organizer authorization
- `build_match_state` verifies league membership
- `build_match_state` not executable by public or anonymous
- No direct mutable grants on real_matches or match_approvals tables
- Table privileges explicitly reset before grants
- Authenticated read grants are explicit
- Auth trigger functions not directly executable by API roles
- Auth trigger functions use controlled search path
- No DROP/TRUNCATE/DELETE in migrations

## 4. Production Build

| Command | Exit Code | Result |
|---------|-----------|--------|
| `next build --webpack` | 0 | ✅ Success |

All 50+ routes compiled successfully:
- 27 API routes (all Supabase-backed)
- 20+ frontend pages
- No build warnings related to application code

## 5. Database Integration Tests

| Status | Details |
|--------|---------|
| ⚠️ Not executed | No PostgreSQL or Docker available in this environment |

The following integration test areas remain unverified against a live database:
1. Leader manages a match in their league
2. Leader manages a match organized by another member
3. Assigned Organizer manages their match
4. Assigned Organizer cannot manage an unrelated match
5. Ordinary member cannot manage matches
6. User from another league cannot access the match
7. Unauthenticated user cannot access protected operations
8. Client-supplied profile ID cannot impersonate another user
9. Leader submits a result
10. Leader approves their own submitted result
11. Organizer submits a result
12. Organizer approves their own submitted result
13. Organizer rejects a result
14. Leader rejects a result
15. Invalid state transitions are rejected
16. Successful transitions increment versions
17. Stale updates return 409
18. Concurrent updates cannot overwrite each other
19. Failed operations do not partially write data
20-24. Lineups and events authorization
25-28. Scoring and isolation

An integration test script is provided at `scripts/integration-tests.mjs` for execution when a PostgreSQL/Supabase instance is available.

## 6. Source-Level Verification (Completed)

The following areas were verified through static analysis and unit tests:

- ✅ All production routes use Supabase (no Drizzle, no DATABASE_URL)
- ✅ API, RLS, and RPC enforce the same Leader/Organizer authorization model
- ✅ Leader and Organizer have exact permissions as specified
- ✅ Neither role is blocked from approving their own submitted result
- ✅ Lineup identity and authorization bugs fixed (GET, DELETE, PUT)
- ✅ Match transitions, versioning, and audit history implemented
- ✅ Existing scoring and application features preserved
- ✅ Typecheck, test suite, SQL audit, and production build pass
- ✅ Clean Supabase migration and setup guide prepared
- ✅ No remote project was modified
- ✅ No old data was imported
