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
10. `0014_match_deadlines.sql` (kickoff guards and lineup positions)
11. `0015_match_statistics_and_bonuses.sql` (match-only totals, bonus ranks and scoring corrections)
12. `0016_team_logos.sql` (private real-team logos and history reads)
13. `0017_google_profile_names.sql` (first-login profile names)
14. `0018_automatic_match_bonus.sql` (automatic competition ranking for bonuses)
15. `0019_squad_points_and_real_lineups.sql` (fantasy-only kickoff lock, independent real lineups, individual player history, optional event minute)
16. `0020_next_match_lineups.sql` (match-specific fantasy lineups and forward-only verified lineup history)
17. `0021_approval_kickoff.sql` (server-enforced approval cutoff at scheduled kickoff)
18. `0022_prepare_next_match_lineup.sql` (prepare the next fantasy lineup before scheduling a fixture)
19. `0023_live_event_points.sql` (provisional scoring and standings from unapproved match events)
20. `0024_in_play_lineup.sql` (locked match lineup in My Team)
21. `0025_read_consolidation.sql` (read consolidation, kickoff in the last-game snapshot and caller-scoped latest player points)
22. `0026_scoped_live_points.sql` (caller-scoped live manager points and tightened live-projection grants)
23. `0027_shared_live_projection.sql` (one live projection per request)

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
`0001_schema.sql` to `0027_shared_live_projection.sql`. The
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

## Match deadlines, statistics, team logos and Google profile names

- Apply `0014`–`0017` in order **on staging first**, after all earlier migrations
  are present. Do not run the fresh-database script against a populated project.
  Deploy the app only after the migrations are verified. The migration creates
  the private `team-logos` bucket, so no manual bucket creation or service-role
  key is needed. If the bucket already exists, verify it is private and permits
  WebP with a 1 MiB size limit. The authenticated app only serves linked logos
  to members; unattached blobs are not visible to ordinary league members.
- Fantasy squads are still shared within a league. A started, unfinalized
  match keeps the squad locked even if another match is upcoming. Review old
  unfinished drafts before rollout: those with past kickoff times also lock the
  squad. Locking never rewrites a squad. Since `0019`, this deadline does not
  apply to real team lineups. For new lineups the saved match position is used
  for the new statistics. Old lineups
  without a recorded position use the current roster position when stats are
  first entered; previous official points are not recalculated by migration.
- Apply `0018` before deploying the automatic bonus UI. Approval and explicit
  corrections rank only participating players by pre-bonus points within each
  match. Ties share a rank (for example, `1, 1, 3`), and ranks 1/2/3 earn
  +3/+2/+1 respectively. The old manual write signature is no longer callable
  by app users. Legacy manual selections on unfinished matches are ignored on
  approval; existing finalized scores and receipts are left unchanged unless
  an authorized user corrects the match. Explicit stat corrections require a
  reason and preserve the original fantasy picks and multipliers. Legacy
  scoreless results are not eligible for this correction path.
- Google names are initialized only when a Google user is first created.
  Existing profile names are not migrated, and OAuth sign-in does not overwrite
  edits. No Google Cloud or Supabase Auth setting change is needed if Google
  sign-in is already configured. For a new environment, use the existing
  Google setup instructions and add that environment's callback allowlist.
- On staging, exercise a Google sign-in with a new account and another sign-in
  after changing its display name; confirm password login still works. Test
  actual Supabase Storage upload, replacement/removal, cross-league access and
  mobile camera/gallery in addition to the automated PostgreSQL policy tests.

## Latest Squad points, real lineup editing and optional event minutes

- Apply `0019_squad_points_and_real_lineups.sql` after `0018` and **before**
  deploying the corresponding app. Test on staging first; do not reset or use
  the fresh-install script on the existing database. `0019` does not recalculate
  historical scores, replace scoring rules or backfill match statistics.
- Assigned organizers and league leaders can save real lineups after kickoff,
  during review, and after approval. A pending lineup change invalidates an older
  approval revision. The first approved lineup edit captures the previous real
  lineup for official participation, history, and explicit score/stat corrections.
  The current real lineup remains editable without changing approved points.
  Existing match statistics no longer cascade on lineup replacement. Clear affected
  statistics explicitly before removing a participant in an unapproved match.
- The Squad page's Last Match Points box uses the existing `last_game_points`
  RPC to show the signed-in manager's official team total for the latest approved
  match, with its title and kickoff date. Individual points remain in each
  player's performance view. Use separate accounts to verify standings,
  correction updates and manager/organizer permissions on staging.
- Newly logged regular match events may omit the minute. Historical event
  minutes stay stored, and substitution minutes are still required.

### Next Match Lineup (`0020`)

Apply `0020_next_match_lineups.sql` after `0019` and **before** releasing the
updated app. Never run the fresh-install script against an existing database.
The migration adds private fantasy lineup tables and caller-scoped RPCs. It
neither backfills old lineups nor revises scores. A previous lineup becomes
eligible after approval of a post-rollout match with a verified full starting
lineup. Kickoffs before migration installation are deliberately excluded.

Before kickoff, a saved match lineup applies only to that fixture. Opening the
editor, making unsaved changes, or never opening it leaves the existing saved
squad as the scoring input. Approval records the selected input atomically
with official scoring. Corrections continue using the official ledger and do
not rewrite the saved historical lineup. Real-team lineup permissions and
scoring formulas are unchanged.

### Match approval kickoff cutoff (`0021`)

Apply `0021_approval_kickoff.sql` after `0020`. The existing approval RPC
checks the current scheduled kickoff against the database clock before writing
an approval or official points. Submitting for review and rejecting are not
restricted by this cutoff. Previously approved matches, scores, and lineup
history are not changed or backfilled.

### Prepare Next Match before scheduling (`0022`)

Apply `0022_prepare_next_match_lineup.sql` after `0021`. The Next Match editor
can save a separate preparation when no eligible match exists and the manager
has verified lineup history. Creating a match with a future kickoff moves the
preparation into that match's lineup in the same transaction. It does not
move again when a later match is added or when kickoff changes. A locked
match awaiting approval does not prevent preparation for a future match.
Backdated/approved fixtures do not consume preparations. No default squads,
previous lineups, scoring rules, or existing points are changed by the upgrade.

### Live event points (`0023`)

Apply `0023_live_event_points.sql` before deploying the app version that calls
its RPCs. It adds read-only projections, with no backfill or change to official
points, approval, or saved lineup history. Saved scoring events and statistics
for participants count immediately under approved scoring rules. Live fantasy
points use the fixture's saved lineup or the default squad and the league's
captain/vice policy. Appearance, result and bonus points and automatic fantasy
substitutions are finalized on approval. An approved match is excluded from
the live projection and is shown only from the official ledger.

### Locked match lineup (`0024`)

Apply `0024_in_play_lineup.sql` after `0023`. It adds
`ff_in_play_fantasy_lineup` and returns its result as `inPlay` from
`ff_next_match_lineup`. Once a fixture starts and until it is approved, My Team
shows that fixture's saved match lineup, or the default squad when none was
saved. The previous verified lineup, default squad, and verified history are
unchanged, and the function is not executable by API roles directly. My Team
also shows the locked match under "Points", starting at zero and following the
`0023` provisional projection until approval.

### Read consolidation and caller-scoped latest player points (`0025`)

Apply `0025_read_consolidation.sql` after `0024` and **before** releasing the
matching app. It is a read-only change: it adds no rows, rewrites no points,
and does not touch approval, saved lineups, or RLS policies.

- `last_game_points` now returns the latest approved match's `kickOff`
  alongside its title and points. The My Team screen reads that snapshot
  instead of issuing a second exact-match lookup for the same fixture.
- `ff_my_latest_display_player_points` answers the latest-points question for
  the caller's own saved squad, deriving the squad inside the function. The
  dashboard shows the latest points of the manager's players from the same
  response as the rest of the page, with no follow-up player-performance
  request. The caller-scoped result is identical to
  `ff_latest_display_player_points` for the caller's squad and excludes other
  members and nonmembers.

### Scoped live points (`0026`)

Apply `0026_scoped_live_points.sql` after `0025` and **before** releasing the
matching app. It only changes how the live projection is computed and who may
call it. It writes no rows, does not change official points, approval, saved
lineups, or the live projection's results.

- The live manager projection now has one implementation,
  `ff_live_manager_points_for`, with an optional manager scope.
  `ff_live_manager_points` (every manager, used by the standings table) and
  `ff_my_live_match_points` (the caller's own live rows) are thin wrappers
  over it. The dashboard, My Team and the player-performance screen only ever
  read the caller's own live row, so they no longer compute and discard every
  other manager's live points.
- `ff_live_manager_points_for` and `ff_live_manager_points` are revoked from
  `public`, `anon` and `authenticated`; they are internal to the database.
  `ff_my_live_match_points` and `ff_latest_display_player_points` remain
  executable by `authenticated` and are not executable by `anon`. An
  unauthenticated or anonymous caller receives no live rows and no latest
  player rows.
- The live projection itself is unchanged: the same matches, the same
  participants, the same scoring rules, and the same captain/vice policy. A
  manager's own live row, the standings' live points, and the captain
  breakdown shown next to a player's latest points all stay the same values.

Apply `0025` and `0026` in the same maintenance window as the app release
that depends on them. Verify after applying: a member sees their own live
match points and their own captain breakdown; a second member sees only their
own; an anonymous caller sees none; the standings still show every manager's
live points; and the all-managers RPC is still unreachable from API roles.

### One live projection per request (`0027`)

Apply `0027_shared_live_projection.sql` after `0026`. It is a read-only
change: it writes no rows and does not change official points, approval,
saved lineups, or the values the live projection produces.

- The latest player points and the captain contribution next to them used to
  build the live projection twice per request. The projection is now built
  once and shared, which makes the latest-player lookup about a quarter
  faster and the dashboard's live reads about 15% faster.
- The captain and vice-captain rules still live in one place. The manager
  fan-out is a single implementation that both the caller-scoped lookup and
  the standings table use.
- The shared helpers are revoked from `public`, `anon` and `authenticated`;
  they are internal to the database. `ff_my_live_match_points`,
  `ff_latest_display_player_points` and `ff_display_player_points` keep the
  same signatures, the same rows in the same order, and the same access rules.
- A player's latest points and the captain's contribution for that player
  still describe the same match, and the display rows and the latest rows
  still agree on every player they share.

Verify after applying: a member's pitch shows the same latest points and the
same captain total as before; the points screen is unchanged; the standings
still show every manager's live points; and the shared helpers are still
unreachable from API roles.

