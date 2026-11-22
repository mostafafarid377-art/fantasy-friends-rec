# Fantasy Friends — the lineup lifecycle

Migration `0028_lineup_lifecycle.sql` gives every manager one effective lineup
per fixture, and makes that lineup the one that is shown, scored and projected.
It is not applied to production yet; production stays on `0027`.

## 1. One resolver

`public.ff_effective_fantasy_lineups(match)` answers "which lineup does this
manager use for this fixture?" for every manager of the league, in this order:

| Order | Source | Meaning |
| --- | --- | --- |
| 1 | `fantasy_match_lineup_drafts` | the lineup the manager saved for this fixture |
| 2 | `fantasy_match_lineup_history` | the lineup that was locked in at the deadline |
| 3 | the last official lineup before this fixture | inherited exactly, never re-derived |
| 4 | the default squad | the fallback |

`public.ff_fantasy_lineup_source(match, profile)` reports which of the four a
lineup came from, so the interface can say where a lineup is from.

The same resolver is read by official scoring (`ff_score_match`), by the live
projection (`ff_live_manager_points_from_live`) and by the lineup in play
(`ff_in_play_fantasy_lineup`). The lineup a manager sees is the lineup that is
scored.

All three are internal to the database: `revoke all ... from public,anon,authenticated`.

## 2. The deadline freezes the lineup

`public.ff_promote_match_lineup(match)` writes the official lineup of a
fixture in one transaction:

- it takes the league deadline lock, in the same order as approval and squad
  saves, so it cannot interleave with a save;
- it writes `on conflict do nothing`, so a lineup that was already locked in is
  never overwritten — running it again promotes nothing;
- it only writes a lineup that fits the league (the right number of starters,
  one goalkeeper, a formation that matches) and whose captaincy can be used;
- it leaves fixtures that are older than the lineup rollout alone.

`public.ff_promote_due_match_lineups()` runs it for every fixture whose
deadline has passed and that has no result yet.

## 3. Captaincy

A lineup a manager writes names a captain and a different vice-captain, and
both of them are starters:

- a next-match lineup (`ff_save_next_match_lineup`) must name both;
- a complete squad (`ff_save_validated_squad`) must name both.

**Existing rows keep whatever they have.** Nothing in this migration invents a
captain for a lineup that never had one, and no historical lineup is rewritten.

`public.ff_valid_fantasy_captaincy(lineup)` is the one place that decides
whether the captaincy of a lineup can be used:

| Captaincy of the lineup | Result |
| --- | --- |
| none at all (grandfathered) | usable |
| a captain that is a starter | usable |
| a captain and a vice-captain that are starters and differ | usable |
| a captain or a vice-captain that is not a starter | not usable |
| the same player as captain and vice-captain | not usable |

The promotion and the scoring capture only lock in a lineup whose captaincy is
usable. The scoring itself stays as it was: a captain that did not play hands
the double to the vice-captain when the league uses the `auto_captain` policy.

## 4. The bench rule of the live squad function

`0028` replaces `ff_save_validated_squad`, the function migration `0014`
produced by renaming the `save_fantasy_squad_v2` that migration `0009` wrote.
The body it replaces therefore has to be the `0009` body: the rule `0009`
added — the goalkeeper keeps the first bench seat and the outfield substitutes
follow in order behind it — is live today and must not be lost by replacing
the function.

`scripts/check-0028-parity.mjs` derives the body from `0009` and compares it
byte for byte with the migration. It also fails when the bench rule or the
captaincy checks are missing.

## 5. The rollout cutoff and the deadline runner

`fantasy_lineup_rollout.enabled_at` is the cutoff. A fixture that starts
before it owns no fantasy lineup: it is never promoted, never captured, and
never offered as the next match.

The promotion has to happen even when nobody opens the app, so it runs on the
database through `pg_cron` every five minutes. Where the extension is not
available the migration still applies, and nothing is lost: the resolver falls
back to the previous official lineup, and the official row is written later,
when the result is scored.

`pg_cron` is available to install on the production project but is **not
installed** today. Until it is, the deadline promotion only happens when a
match is scored. That is the intended fallback, not a failure.

## 6. What is not changed

- No production migration, no deployment, no production data change.
- No historical lineup is updated, deleted or re-scored.
- `pg_cron` is not installed by this migration and is not scheduled anywhere
  else.

## 7. How to check it

```bash
# The bodies of 0028 are the bodies they were built from.
node scripts/check-0028-parity.mjs

# The static SQL audit.
npm run audit:sql

# The database behaviour (needs a local PostgreSQL).
DATABASE_URL="postgresql://ff_test:ff_test@127.0.0.1:54329/ff_test" \
  node scripts/setup-local-integration.mjs 0028
DATABASE_URL="postgresql://ff_test:ff_test@127.0.0.1:54329/ff_test" \
  npx vitest run src/lib/__tests__/integration/

# The rest.
npm test && npm run typecheck && npm run build
```
