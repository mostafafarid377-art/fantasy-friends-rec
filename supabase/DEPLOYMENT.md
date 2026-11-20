# Fantasy Friends Supabase deployment

All application data APIs use the cookie-scoped Supabase client and native
Supabase Auth. The app does not need `DATABASE_URL` or a service-role key.

## Existing Hagz-fantasy deployment

Do not deploy without authorization. Use the existing Hagz-fantasy project
(`zkrfgdiujpagaddsxbcb`). Review the project's migration history and apply only
missing forward migrations, in order:

1. `0005_confirmed_writes.sql` (previous release)
2. `0006_write_side_effects.sql` (previous release)
3. `0007_squad_system.sql` (squad release)
4. `0008_player_photos.sql` (dashboard pitch and photo release)
5. `0009_bench_lineups_scoring.sql` (bench, match lineup and scoring release)
6. `0010_player_performance.sql` (individual points and finalized match history)
7. `0011_recorded_match_results.sql` (recorded scores and automatic clean sheets)
8. `0012_captain_visibility_and_league_deletion.sql` (captain contribution and creator-only league deletion)
9. `0013_match_duration.sql` (planned match duration)

Coordinate `0007` with the matching app rollout: the new app needs both
`save_fantasy_squad_v2` and `last_game_points`; the older app's squad saves will
be unavailable after `0007` revokes the old RPC. Plan this as one maintenance
window. An app-only rollback after `0007` does not restore old squad writes.
Do not restore unchecked grants to recover them; prefer a reviewed forward fix.

Confirm the Vercel variables still point to the same project:
`NEXT_PUBLIC_SUPABASE_URL` (project root, without `/rest/v1`) and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Keep all credentials out of Git.

`0007` does not update, backfill or delete rows. Existing squads and points are
preserved. Squad RLS remains enabled and unchanged; direct authenticated DML
and the old RPC grant are revoked in favor of the checked RPC. Smaller squad
sizes are permitted; 15 remains the default and upper limit. Existing squad
settings aren't rewritten. Leaders changing limits through Settings may need to
ask members to rebalance their squads.

Do not run the legacy destructive migration, reset the database, or run an
unrestricted `supabase db push` against Hagz-fantasy; `0001`–`0004` are the
existing baseline.

After deploying, League Leaders in leagues with an empty Scoring screen can
choose **Initialize draft rules** and review them before approval. This is a
normal, authenticated app action; it does not overwrite existing rules.

## Player photos

Read-only inspection found an existing private `player-images` bucket in
Hagz-fantasy with a 5 MB limit and JPEG, PNG and WebP allowed. Migration `0008`
reuses it without modifying its settings, or creates it on a fresh Supabase
installation. It adds scoped object policies and a validation trigger on
`public.players`; it does not rewrite rows or enable public access. Apply it
before enabling photo uploads. Verify that `player-images` is still private,
accepts JPEG, and has no broader Storage policies. No service-role key is needed.

The app stores `player-images/<league>/<player>/<version>.jpg` in the existing
`players.photo_url` field. The file is served through an authenticated app route;
URLs change after replacement. The existing player-write permissions still
apply. Older external image links remain supported. Replacement or removal
updates the player record first, then attempts to delete the old object. A failed
or unconfirmed write may leave an unlinked object; these aren't visible to
ordinary members. If cleanup is needed, confirm objects are stale and unlinked
and remove them through the Storage API or Dashboard, not with SQL DELETE.

### Required physical-device smoke check

With an authorized leader who can edit the test players, use **iOS Safari** and
**Android Chrome** on physical devices after the migration is applied:

1. In **Players → Add player**, choose an image via **Choose from gallery**;
   check the preview, save, and refresh. Repeat from **Edit player → Take photo**
   on a camera-capable device. If a phone's original format can't be decoded by
   its browser, verify the error and retry with a JPEG.
2. Replace it, rename the player or change their team without touching the
   photo, and then remove it. Verify the dashboard and full squad pitch, picker,
   bench, and player details after each change. On removal, expect the initials
   avatar and the superseded managed URL to no longer serve the image.
3. As a member of the same league, confirm the photo loads but management is
   unavailable; as a nonmember, confirm the photo route and Storage reject
   access. Check both 5v5 and 7v7 dashboard layouts and switch leagues.

## Empty local database setup

For a fresh Supabase-compatible instance only, migrations run in order from
`0001_schema.sql` to `0013_match_duration.sql`. The
`scripts/deploy-fresh-db.sh` helper deliberately refuses remote Supabase hosts,
including Hagz-fantasy.

For an empty disposable **plain PostgreSQL** database named `ff_test*` on
localhost, the integration helper supplies minimal Supabase Auth, Realtime and Storage metadata scaffolding:

```sh
export DATABASE_URL=postgresql://YOUR_LOCAL_DB_USER@localhost:5432/ff_test
node scripts/setup-local-integration.mjs
npm run test:integration
```

The integration suite truncates its fixture tables between runs. Only point
it at a disposable test database. The local scaffolding verifies database
constraints, RLS, grants and RPC transactions. It does not run Supabase Auth, REST or the Storage HTTP service.

See [PRODUCTION_WRITE_AND_PERFORMANCE_AUDIT.md](../PRODUCTION_WRITE_AND_PERFORMANCE_AUDIT.md)
for the verification results and live smoke checklist.

## Squad rollout smoke checks

Use explicitly authorized test accounts/leagues; don't write to production as
part of a read-only check.

- On a phone, switch between a 5v5 and a 7v7 league where the same account has
  different roles. Reload and verify the selected league, roster, role controls
  and pitch. A league with no squad must remain empty until the first save.
- Pick from the league player pool, save players and bench, reopen, then swap
  a defender for a midfielder. Check the new formation, keeper-only swaps,
  distinct captaincy and that Cancel leaves the saved squad unchanged.
- Confirm a League Leader can add/edit players and add/rename real teams. A
  manager cannot manage the roster; a Match Organizer only gets match actions
  they are authorized to perform.
- Compare **Last Game Points** with the member's score for the most recent
  approved match by kickoff. A pending match must not replace it; an approved
  match without a current-version manager score shows no score. Check that
  zero points is shown as `0` and the standings still show season totals.

## Google sign-in

See [Google OAuth setup](GOOGLE_OAUTH.md) for provider configuration, exact
callback URLs, the deployment opt-in setting, and verification steps. It does
not require a database migration.

## Bench, match lineups and scoring

Apply `0009` on staging first and coordinate it with the matching app release.
It replaces the existing lineup and fantasy squad RPC implementations, seeding
and scoring functions; adds a private finalization receipt table, a manager
ledger index and a member-scoped recent substitutions RPC; and removes direct
lineup writes while leaving RLS enabled and its policies unchanged. No additional
project settings, storage or credentials are needed. There is no data backfill;
existing picks, rules and point rows are not rewritten. Older app versions will
not be able to save newly validated benches reliably, so roll out the database
and app together.

- Bench size and reserve capacity are unchanged. When a bench is configured,
  priority 0 is for one goalkeeper and positions 1 onward are outfield. Older
  benches are displayed as saved and may need adjustment the next time a member
  saves. A zero-bench league is unchanged.
- Approval is per real match, the existing finalization unit. It uses the saved
  fantasy squad at approval and recorded real starters/substitutes brought on.
  Bench players enter by priority; outfield swaps can change the formation, but
  cannot remove the last place in any outfield line used by the original shape.
  An unfilled no-show stays on the score sheet with zero. Reserves do not enter.
  Auto-subs never edit the manager's saved squad. Its page shows the most recent
  five matches with automatic substitutions.
- Official scores are written with approval and reused for that finalized match
  version. They include the captain rule and the league's configured vice
  fallback. This release does not add a kickoff lock or combine multiple real
  matches into a new gameweek-level substitution system. Clean sheets keep the
  existing rule: a recorded real starter on a team that conceded no goals;
  no minimum-minutes threshold is configured.
- New leagues get all 44 position/event rules in **draft**, as before. Leaders
  still review/approve them before submitting results. Initializing rules for
  an older league fills missing rows only, without updating custom rules or
  revising historical points.

### Staging smoke check

1. With an assigned Organizer, save a 5v5 and a 7v7 real lineup: exactly one
   starter GK, with at least one sub if allowed. Refresh/reopen the match and
   confirm the same order and selections. Check that a League Leader can also
   edit the match and that a manager without authority cannot. Confirm a bad or
   unavailable selection leaves the old lineup intact.
2. In **My squad**, pick a separate starting lineup and a bench keeper. Where
   the configured bench allows it, reorder two outfield substitutes, save, and
   refresh. Replace a player and verify only eligible unselected players of
   that exact position are offered.
3. Record real starters and each real substitution, then submit and approve the
   match. Leave one fantasy starter out of actual participation; try an
   appearance with zero net points too. Check that **Recent automatic
   substitutions**, player points, manager points, standings and history agree.
   Reopen/retry and confirm there is only one scoring result for the match.
4. Create a new league and inspect its draft matrix. Compare an existing
   customized league and an approved historical match before and after rollout;
   neither should change.

## Individual player performance

Apply `0010` after `0009` on staging before releasing the matching web app.
The migration adds two indexes and two read-only, security-invoker RPCs; it
changes no point rows, rules, or RLS policies. No additional configuration is
needed. The existing fantasy manager's last-game total is unchanged.

- The squad pitch and dashboard preview batch the latest game for the
  displayed starters and bench players. Opening a player loads their finalized
  match history in pages of 20, newest kickoff first.
- History includes approved games where the player has lineup, substitution-on,
  or current-version scoring evidence. An unlisted player is not assumed to have
  been present just because their current team was scheduled. When a named
  substitute never came on, show **Did not play** and `—` unless there is a
  persisted individual score. A real saved zero displays as **0 pts**.
- Confirm that a starter who was captain shows their raw points, not the
  doubled fantasy contribution; tap a starter and bench player, expand an
  event breakdown, and reload. Check an unused substitute, a participating zero,
  and a player with no finalized games. Repeat on a narrow screen and check that
  a nonmember cannot read either endpoint.

## Recorded results and automatic clean sheets

Apply `0011` after `0010` on staging before releasing the matching app. Coordinate
both changes in one rollout: the older app still calls the now-private scoreless
submission path. No new environment variables or credentials are needed. The
migration does not backfill scores or alter any existing points or scoring rules.

- The assigned Match Organizer or League Leader enters both teams' final scores
  on the match page before submitting for review. The recorded score, not the
  list of goal events, determines clean sheets and any configured win/draw
  points. Manual player events remain available and don't change the score.
- Clean-sheet eligibility retains the league's existing starter-only rule:
  a real starter can score a clean sheet if their team concedes zero over the
  match. There is no minimum-minutes or on-pitch-only concession rule. A real
  substitute who came on is eligible for appearance and their usual events,
  but not a clean sheet. A named substitute who never played earns no points.
- An authorized organizer or leader can correct a finalized recorded score
  with a reason. The audit entry shows the old and new scores. Score-derived
  player and fantasy points update in the same transaction as history and
  standings. The correction preserves the original rules, effective fantasy
  lineup, captain/vice multiplier, and individually recorded events.
- Previously approved matches with no recorded score remain unchanged; this
  feature does not retroactively assign them scores. Legacy pending matches
  without scores must be sent back to enter a score and resubmit.

On staging, verify a 2–0 and a 0–0 result, a named substitute who did not play,
then correct a result from 2–0 to 2–1. Confirm the player and fantasy history,
standings and match history agree. Retry the result and check that no ledger or
history entry is duplicated.

## Captain contribution and league deletion

Apply `0012` before releasing the matching app. It does not recalculate
historical results or delete any existing data on deployment.

- The pitch keeps the raw player score and shows a separate captain total where
  your finalized manager ledger applied the multiplier for that same match.
  This includes an applied vice-captain fallback. Saving a captain after
  approval does not change historical points.
- Only a league creator who is still a member can delete it. Use **Settings →
  Delete league** and type the exact current name. The operation permanently
  deletes the league’s database data in one transaction, without deleting
  accounts or any other league. Previously uploaded private Storage blobs
  become inaccessible through the app; physical storage cleanup is separate
  and must use the Storage API, not SQL deletes on `storage.objects`.

## Match duration

Apply `0013` before deploying the duration field. It adds a nullable whole-minute
field (1–200) and extends the match creation RPC with an optional trailing
argument so legacy clients and queued requests still work. Older matches stay
unspecified. Duration is scheduled match information; it does not change
scoring, clean-sheet eligibility or the range allowed for recording match events.
