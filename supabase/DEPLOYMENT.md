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
`0001_schema.sql` to `0008_player_photos.sql`. The
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
