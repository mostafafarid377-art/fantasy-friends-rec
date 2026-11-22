# Fantasy Friends — the lineup lifecycle

Migration `0028_lineup_lifecycle.sql` gives every manager one effective lineup
per fixture, and makes that lineup the one that is shown, scored and projected.
Migration `0029_lineup_deadline_runner.sql` makes the deadline automatic: it
runs the promotion without anybody opening the app, and it leaves a trail of
every run. Migration `0030_next_match_lineup_availability.sql` opens the
next-match editor from the first scheduled fixture on: it no longer waits for
an official lineup to exist.

None of them is applied to production yet; production stays on `0027`.

## 1. One resolver

`public.ff_effective_fantasy_lineups(match)` answers "which lineup does this
manager use for this fixture?" for every manager of the league, in this order:

| Order | Source | Meaning |
| --- | --- | --- |
| 1 | `fantasy_match_lineup_history` | the lineup that was locked in at the deadline |
| 2 | `fantasy_match_lineup_drafts` | the lineup the manager saved for this fixture |
| 3 | the last official lineup before this fixture | inherited exactly, never re-derived |
| 4 | the default squad | the fallback |

The lineup that was locked in wins over the draft: from the deadline on, the
draft is frozen and the official lineup is the one and only lineup the fixture
is played with.

`public.ff_fantasy_lineup_source(match, profile)` reports which of the four a
lineup came from, so the interface can say where a lineup is from.

The same resolver is read by official scoring (`ff_score_match`), by the live
projection (`ff_live_manager_points_from_live`) and by the lineup in play
(`ff_in_play_fantasy_lineup`). The lineup a manager sees is the lineup that is
scored.

Every path that scores a manager goes through it, and nothing else reads a
draft to score one:

```
ff_score_match                       -> ff_effective_fantasy_lineups
ff_live_manager_points_from_live     -> ff_effective_fantasy_lineups
ff_live_manager_points_for           -> ff_live_manager_points_from_live
ff_live_manager_points               -> ff_live_manager_points_for
ff_my_live_match_points              -> ff_live_manager_points_for
```

The only functions that still read `fantasy_match_lineup_drafts` are the
resolver itself, the source reporter, the interface read
(`ff_next_match_lineup`), the save, and the trigger that attaches a prepared
lineup to a new fixture.

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

`public.ff_promote_due_match_lineups(source)` runs it for every fixture whose
deadline has passed and that has no result yet, oldest fixture first, so a
fixture that inherits the lineup of the one before it always finds that lineup
already locked in — even when the runner was down for both deadlines.

**The deadline is the kickoff.** `real_matches.kick_off` is a
`timestamp with time zone`, and every deadline comparison
(`kick_off <= clock_timestamp()`) is a comparison of two instants. The
deadline is therefore the same moment for every server, whatever the timezone
of the server is. The interface shows the kickoff in the timezone of the
reader, which is a presentation choice and never a second deadline.

## 3. The inherited lineup is created and preserved on the server

A manager who never opens the app still has a lineup for the next fixture, and
it is the server that creates it:

- the resolver reads the last official lineup of the manager in that league
  and inherits it **exactly** — the same players, the same order, the same
  captain and vice-captain. It is never re-derived from the squad;
- `ff_next_match_lineup` hands that lineup to the interface as `previous`, so
  what the manager sees is what will be played;
- the promotion writes it into `fantasy_match_lineup_history` at the deadline.
  That row is the official lineup of the fixture, and it is never rewritten:
  the promotion, the scoring capture and every other writer use
  `on conflict do nothing`.

So the inherited lineup exists in three places, all on the server: as the
resolved lineup of the fixture, as the lineup the interface shows, and as the
immutable official lineup the next fixture inherits in turn.

Saving a lineup for the fixture replaces the inherited one: the draft then
wins over the inheritance, and the draft is what is locked in at the deadline.

## 3a. The editor is available from the first scheduled fixture on

Before `0030`, `ff_next_match_lineup` answered "there is nothing to show"
whenever the manager had no official lineup yet, and `ff_save_next_match_lineup`
refused the save for the same reason. The whole feature was locked behind the
deadline of the match in play: its countdown had to reach zero — and its
lineup had to be locked in — before the lineup of the next one could be
prepared.

`0030` removes both refusals:

- the read always reports the scheduled fixture. `previous` is simply null
  when there is no official lineup to inherit, and the editor seeds from the
  saved squad — the same source the resolver falls back to;
- the save accepts the lineup of a manager without history, with every other
  check unchanged (membership, target, revision, formation, captaincy).

The editor and the resolver read the same four sources in the same order, so
the seed the editor shows is the lineup the resolver would pick:

- when an official lineup exists, `previous` carries it, and the resolver
  inherits it;
- when none exists, the resolver falls back to the default squad, which is
  exactly the fallback the editor shows.

A lineup saved for the fixture always wins over both.

## 4. Captaincy

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

## 5. The bench rule of the live squad function

`0028` replaces `ff_save_validated_squad`, the function migration `0014`
produced by renaming the `save_fantasy_squad_v2` that migration `0009` wrote.
The body it replaces therefore has to be the `0009` body: the rule `0009`
added — the goalkeeper keeps the first bench seat and the outfield substitutes
follow in order behind it — is live today and must not be lost by replacing
the function.

`scripts/check-0028-parity.mjs` derives the body from `0009` and compares it
byte for byte with the migration. It also fails when the bench rule or the
captaincy checks are missing.

## 6. The rollout cutoff

`fantasy_lineup_rollout.enabled_at` is the cutoff. A fixture that starts
before it owns no fantasy lineup: it is never promoted, never captured, and
never offered as the next match.

## 7. The deadline runner

The promotion has to happen even when nobody opens the app. Two runners call
the same function.

### The runner in the database (the one that matters)

`0029` schedules `ff_promote_due_match_lineups('pg_cron')` inside PostgreSQL
through `pg_cron`, every minute. This is the runner that makes the deadline
timely: it is in the database, it does not depend on the app, on a deploy, on
a browser, or on an outside scheduler.

The extension is **not** installed by the migration. Installing it is one
explicit operational step on the target database:

```sql
create extension pg_cron;
```

Then re-run the scheduling block of `0029` (or the whole migration on a
database that has not applied it yet):

```sql
select cron.schedule('ff-lineup-deadlines','* * * * *',
  'select public.ff_promote_due_match_lineups(''pg_cron'')');
```

After that the official lineup of a fixture exists within a minute of its
deadline, and the next fixture inherits it.

`0029` also does this by itself when the extension is already installed: it
unschedules the old job and schedules the new one, so applying the migration
a second time is harmless.

**What was verified.** The two steps above were run against a real Supabase
project: `create extension pg_cron;` succeeds, `cron.schedule` accepts the
named per-minute job, and the job fires on the minute — the recorded run
started 0.17 s after the minute boundary and finished in 7 ms. The extension
and the test job were removed again afterwards; nothing was installed on the
production project.

The runner itself is verified against a real PostgreSQL: it promotes what is
due, picks up a run that was missed, never changes a lineup that is already
locked in, produces exactly one official lineup when two runs happen at the
same time, and records every run and every fixture it could not lock in.

### The runner outside the database (the backup)

`src/app/api/internal/lineup-deadlines/route.ts` is a server-only route that
runs the same function through a service-role client. It is authenticated
with a bearer secret (`LINEUP_DEADLINE_SECRET`, or `CRON_SECRET`), it is
outside the Auth proxy (`/api/...` is not matched by `src/proxy.ts`), and it
never sends the secret to the browser.

`.github/workflows/lineup-deadlines.yml` calls it every five minutes. That
workflow is the **backup**, not the guarantee: GitHub runs scheduled
workflows on a best-effort basis, a run can be delayed under load, and GitHub
disables scheduled workflows in a repository that has been inactive for 60
days. It also warns, on every run, when the database job is missing.

Set up:

```bash
gh secret set LINEUP_DEADLINE_SECRET   # the same value as in the app
gh secret set LINEUP_DEADLINE_URL       # the address of the route
```

and in the app environment:

| Variable | Meaning |
| --- | --- |
| `LINEUP_DEADLINE_SECRET` (or `CRON_SECRET`) | the bearer secret of the route |
| `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) | the server-only key of the database |

### What the runner leaves behind

| Table | What it holds |
| --- | --- |
| `lineup_deadline_runs` | every run: when, where it came from, how many fixtures it scanned, how many it locked in, how many it could not |
| `lineup_deadline_failures` | the fixtures it could not lock in, with the reason and how often it tried |

`public.ff_lineup_deadline_status()` reports the health of the deadline in
one call: the last run, how long ago that was, how many fixtures are open
failures, and whether the database itself runs the job.

A fixture that is due but has no official lineup is recorded as a failure:
its lineup does not fit the league, or its captaincy cannot be used. That is
a question for a person, not for another run.

### What is not guaranteed

- The deadline is only as timely as the runner. Without `pg_cron` the
  deadline depends on the outside scheduler, and GitHub does not promise a
  five-minute turnaround.
- A paused Supabase project does not run anything. The deadline needs a
  project that is awake.
- A fixture whose lineup cannot be locked in never gets an official lineup
  until a person fixes it. It is recorded, not hidden.

## 8. The order of the locks

Every writer takes the same locks in the same order, so two of them cannot
deadlock:

1. the `real_matches` row of the fixture (`for update`);
2. the league deadline lock, `ff-deadline:<league>`;
3. the league, the membership and the players (`for share`).

The official scoring takes the `ff-score:<league>` lock, and the squad save
takes the `squad-v2:<league, actor>` lock; neither is held while waiting for
something the others hold.

The runner walks the fixtures in kickoff order, so two runners that run at the
same time take the same locks in the same order: the second one waits, finds
the lineups already locked in, and promotes nothing.

## 9. What is not changed

- No production migration, no deployment, no production data change.
- No historical lineup is updated, deleted or re-scored.
- `pg_cron` is not installed by the migration and is not scheduled anywhere
  else.

## 10. How to check it

```bash
# The bodies of 0028 are the bodies they were built from.
node scripts/check-0028-parity.mjs

# The bodies of 0030 are the bodies of 0024 and 0028, minus the refusals.
node scripts/check-0030-parity.mjs

# The static SQL audit.
npm run audit:sql

# The database behaviour (needs a local PostgreSQL).
DATABASE_URL="postgresql://ff_test:ff_test@127.0.0.1:54329/ff_test" \
  node scripts/setup-local-integration.mjs 0030
DATABASE_URL="postgresql://ff_test:ff_test@127.0.0.1:54329/ff_test" \
  npx vitest run src/lib/__tests__/integration/

# The rest.
npm test && npm run typecheck && npm run build
```
