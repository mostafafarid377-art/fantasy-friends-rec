import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';

const read = (filePath) => fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf8');
const schema = read('./supabase/migrations/0001_schema.sql');
const drizzle = read('./drizzle/0000_fluffy_prima.sql');
const rls = read('./supabase/migrations/0002_rls.sql');
const functions = read('./supabase/migrations/0003_functions.sql');
const authProfiles = read('./supabase/migrations/0004_native_auth_profiles.sql');

assert.equal(schema, drizzle, 'Supabase schema migration must match the Drizzle baseline byte-for-byte');
assert.match(functions, /insert into league_activity\s*\(id, league_id, profile_id,/i, 'join_league must use league_activity.profile_id');
assert.doesNotMatch(functions, /insert into league_activity\s*\([^)]*actor_id/is, 'league_activity has no actor_id column');
const activityPolicy = rls.match(/create policy activity_insert[\s\S]*?;\s*/i)?.[0] ?? '';
assert.match(activityPolicy, /profile_id\s*=\s*auth\.uid\(\)::text/i, 'activity insert policy must use profile_id');
assert.doesNotMatch(activityPolicy, /actor_id/i, 'activity insert policy must not reference actor_id');

for (const category of ['appearance', 'clean_sheet', 'goal', 'assist', 'own_goal', 'yellow_card', 'red_card', 'penalty_saved', 'penalty_missed']) {
  assert.match(functions, new RegExp(`'${category}'`), `SQL scoring must include ${category}`);
}
assert.match(functions, /e\.event_type\s*=\s*'own_goal'\s+and\s+e\.team_id\s*=\s*t\.team_id/i, 'own goals must count against the offender team for clean sheets');
assert.match(functions, /where match_id = p_match and event_type = 'assist'/i, 'SQL must count explicit assist events');
assert.match(functions, /event_type = 'goal'[\s\S]*?assist_player_id is not null/i, 'SQL must count goal assist_player_id attribution');
assert.match(functions, /s\.vice_captain_id[\s\S]*?v_league\.vice_policy\s*=\s*'auto_captain'/i, 'SQL must implement configured vice-captain fallback');
assert.match(functions, /fantasy_points_history/i, 'SQL must update the fantasy points history ledger');
assert.match(functions, /Both match teams must belong to this league/i, 'match submission must validate same-league teams');
assert.match(functions, /Every lineup player and team must belong to this match league/i, 'match submission must validate lineup ownership');
assert.match(functions, /Every match event and assist must belong to the correct match team/i, 'match submission must validate event and assist ownership');
assert.match(functions, /Substitutions must pair a listed substitute with a starter from the same team/i, 'match submission must validate substitution participants');

assert.match(functions, /revoke all on function public\.calculate_match_points\(text\) from public, anon, authenticated/i, 'clients must not directly execute scoring');
assert.match(functions, /revoke all on function public\.recalculate_standings\(text\) from public, anon, authenticated/i, 'clients must not directly recalculate standings');
assert.match(functions, /if not \(public\.is_leader\(v_match\.league_id\) or public\.is_match_organizer\(p_match\)\)/i, 'official scoring must verify Leader or Organizer authorization');
assert.match(functions, /if not public\.is_member\(v_league_id\)/i, 'match state must verify league membership');
assert.match(functions, /revoke all on function public\.build_match_state\(text\) from public, anon/i, 'match state must not be public or anonymous');
assert.doesNotMatch(rls, /grant insert, update, delete on table public\.real_matches/i, 'match state must not be directly mutable by clients');
assert.doesNotMatch(rls, /grant insert on table public\.match_approvals/i, 'approval history must be written through guarded RPCs');
assert.match(rls, /revoke all on table[\s\S]*?from public, anon, authenticated/i, 'table privileges must be explicitly reset before grants');
assert.match(rls, /grant select on table[\s\S]*?to authenticated/i, 'authenticated read grants must be explicit');
for (const fn of ['handle_new_auth_user', 'sync_auth_user_profile']) {
  assert.match(authProfiles, new RegExp(`revoke all on function public\\.${fn}\\(\\) from public, anon, authenticated`, 'i'), `${fn} must not be directly executable by API roles`);
}
assert.doesNotMatch(authProfiles, /set search_path = public/i, 'auth trigger functions must use a controlled search path');
assert.doesNotMatch(`${rls}\n${functions}`, /\b(drop|truncate)\s+table\b|\bdelete\s+from\s+public\./i, 'migrations must not drop/truncate/delete application data');

// The live projections must stay internal to the database, and the caller
// scoped lookups must stay the only entry points the app can reach.
const scopedLive = read('./supabase/migrations/0026_scoped_live_points.sql');
const sharedLive = read('./supabase/migrations/0027_shared_live_projection.sql');
assert.match(scopedLive, /revoke all on function public\.ff_live_manager_points_for\(text,text,text\),\s*public\.ff_live_manager_points\(text,text\) from public,anon,authenticated/i,
  'the all-managers live projection must not be executable by API roles');
assert.match(scopedLive, /grant execute on function public\.ff_my_live_match_points\(text\),\s*public\.ff_latest_display_player_points\(text,text\[\],text\) to authenticated/i,
  'the caller scoped live lookups must stay executable by authenticated');
assert.match(sharedLive, /revoke all on function public\.ff_approved_display_player_points\(text,text,text\[\]\),\s*public\.ff_live_display_player_points\(jsonb,text\[\]\),\s*public\.ff_live_manager_points_from_live\(jsonb,text,text\)/i,
  'the shared live helpers must not be executable by API roles');
assert.match(sharedLive, /select jsonb_agg\(to_jsonb\(l\)\) as j from public\.ff_live_player_points\(p_league,p_match\) l/i,
  'the latest lookup must build one live projection and share it');
assert.doesNotMatch(sharedLive, /\b(drop|truncate)\s+table\b|\bdelete\s+from\s+public\./i, 'migrations must not drop/truncate/delete application data');

// The hot-read consolidation: the scoped league reads are security definer
// entry points that verify membership inside, stay callable by signed-in
// members, and stay out of reach of anonymous clients.
const hotReads = read('./supabase/migrations/0033_perf_hot_reads.sql');
assert.match(hotReads, /create function public\.ff_league_match_events\(p_league text, p_match text default null\)[\s\S]*?security definer/i,
  'the league events read must be a scoped security definer function');
assert.match(hotReads, /create function public\.ff_league_points_history\(p_league text, p_limit int default 200\)[\s\S]*?security definer/i,
  'the league history read must be a scoped security definer function');
assert.match(hotReads, /where e\.league_id=p_league and \(p_match is null or e\.match_id=p_match\) and public\.is_member\(p_league\)/i,
  'the league events read must verify membership and stay match-scoped when asked');
assert.match(hotReads, /where h\.league_id=p_league and public\.is_member\(p_league\)/i,
  'the league history read must verify membership');
assert.match(hotReads, /revoke all on function public\.ff_league_match_events\(text,text\),\s*public\.ff_league_points_history\(text,int\) from public,anon/i,
  'the scoped league reads must not be executable by anonymous clients');
assert.match(hotReads, /grant execute on function public\.ff_league_match_events\(text,text\),\s*public\.ff_league_points_history\(text,int\) to authenticated/i,
  'the scoped league reads must stay executable by authenticated members');
assert.match(hotReads, /not exists \(select 1 from public\.finalized_match_lineups f\s+where f\.match_id = l\.match_id and f\.league_id = l\.league_id\)/i,
  'player history must keep excluding finalized matches from the open lineup branch');
assert.doesNotMatch(hotReads, /\b(drop|truncate)\s+table\b|\bdelete\s+from\s+public\./i, 'migrations must not drop/truncate/delete application data');

// The lineup lifecycle: one resolver for the lineup of a match, an idempotent
// deadline promotion, and captaincy on every lineup a manager writes.
const lifecycle = read('./supabase/migrations/0028_lineup_lifecycle.sql');
assert.match(lifecycle, /create function public\.ff_effective_fantasy_lineups\(p_match text\)/i,
  'the lineup of a match must be resolved by one function');
assert.match(lifecycle, /coalesce\(fz\.lineup,sv\.lineup,cy\.lineup,sq\.lineup\)/i,
  'the resolver must prefer the lineup locked in at the deadline, then the saved draft, then the inherited lineup, then the default squad');
assert.doesNotMatch(lifecycle, /coalesce\(sv\.lineup,fz\.lineup/i,
  'a saved draft must never win over the lineup that was locked in at the deadline');
assert.match(lifecycle, /create or replace function public\.ff_previous_fantasy_lineup\(p_league text,p_actor text,p_before timestamptz\)/i,
  'the previous official lineup must be redefined so a promoted lineup counts');
const previousLineup = lifecycle.slice(
  lifecycle.indexOf('create or replace function public.ff_previous_fantasy_lineup'),
  lifecycle.indexOf('$$;', lifecycle.indexOf('create or replace function public.ff_previous_fantasy_lineup')),
);
assert.doesNotMatch(previousLineup, /approved/i,
  'an official lineup exists from the deadline, not only once the result is approved');
assert.match(lifecycle, /create function public\.ff_promote_match_lineup\(p_match text\)/i,
  'the deadline must promote the lineup of a match');
assert.match(lifecycle, /on conflict\(match_id,profile_id\) do nothing/i,
  'the promotion must never overwrite a lineup that was already locked in');
assert.match(lifecycle, /create function public\.ff_promote_due_match_lineups\(\)/i,
  'a runner must promote every match whose deadline has passed');
assert.match(lifecycle, /raise exception 'Choose a captain and a vice-captain for this lineup' using errcode='22023'/i,
  'a saved match lineup must name a captain and a vice-captain');
assert.match(lifecycle, /raise exception 'A complete squad needs a captain and a vice-captain' using errcode = '22023'/i,
  'a complete squad must name a captain and a vice-captain');
assert.match(lifecycle, /select r\.profile_id,r\.lineup from public\.ff_effective_fantasy_lineups\(p_match\) r/i,
  'official scoring must read the resolved lineup of the match');
assert.match(lifecycle, /from matches m join public\.ff_effective_fantasy_lineups\(m\.id\) r on true/i,
  'the live projection must read the resolved lineup of the match');
assert.match(lifecycle, /revoke all on function public\.ff_effective_fantasy_lineups\(text\),\s*public\.ff_effective_fantasy_lineup\(text,text\),public\.ff_fantasy_lineup_source\(text,text\)\s*from public,anon,authenticated/i,
  'the resolver must stay internal to the database');
assert.match(lifecycle, /revoke all on function public\.ff_promote_match_lineup\(text\) from public,anon,authenticated/i,
  'the promotion must stay internal to the database');
assert.match(lifecycle, /revoke all on function public\.ff_promote_due_match_lineups\(\) from public,anon,authenticated/i,
  'the deadline runner must stay internal to the database');
assert.doesNotMatch(lifecycle, /\b(drop|truncate)\s+table\b|\bdelete\s+from\s+public\.fantasy_match_lineup/i,
  'the lineup lifecycle must not drop, truncate or delete the official lineups');
assert.doesNotMatch(lifecycle, /update\s+public\.fantasy_match_lineup_history/i,
  'the migration must not rewrite the official lineups that already exist');

// The squad function is replaced by 0028, so it has to keep every rule that
// is live today. Migration 0009 added the bench rule and migration 0014
// renamed the function; losing the bench rule would quietly accept a bench
// that no longer reserves its first seat for the goalkeeper.
const bench = read('./supabase/migrations/0009_bench_lineups_scoring.sql');
const deadlines = read('./supabase/migrations/0014_match_deadlines.sql');
assert.match(deadlines, /alter function public\.save_fantasy_squad_v2\(text,text,text,text,timestamptz,jsonb\) rename to ff_save_validated_squad/i,
  'migration 0014 must keep renaming the squad function to ff_save_validated_squad');
const benchRule = /raise exception 'Bench must reserve position zero for the goalkeeper, followed by ordered outfield substitutes' using errcode='22023'/i;
assert.match(bench, benchRule, 'migration 0009 must hold the bench rule of the live squad function');
assert.match(lifecycle, benchRule,
  'migration 0028 must keep the bench rule when it replaces the live squad function');
const lifecycleSquad = lifecycle.slice(
  lifecycle.indexOf('create or replace function public.ff_save_validated_squad'),
  lifecycle.indexOf('$$;', lifecycle.indexOf('create or replace function public.ff_save_validated_squad')),
);
assert.match(lifecycleSquad, /not exists \(select 1 from jsonb_to_recordset\(p_entries\) e\(player_id text,slot text\) where e\.player_id=p_captain and e\.slot='starter'\)/i,
  'the squad function must keep the captain and vice-captain checks of the live function');
assert.match(lifecycleSquad, /where e\.slot='sub' and p\.position='GK'\) > 1/i,
  'the squad function must keep the bench rule of the live function');

// Migration 0035 adds the starting-lineup coverage rule: a complete squad
// must start at least one Forward, one Midfielder and one Defender. The
// check is gated on is_complete so drafts and pre-existing squads are never
// re-validated.
const coverage = read('./supabase/migrations/0035_squad_position_coverage.sql');
assert.match(coverage, /create or replace function public\.ff_save_validated_squad/i,
  'migration 0035 must replace the squad save function, not create a second write path');
assert.match(coverage, /if is_complete and \(forwards = 0 or mids = 0 or defenders = 0\) then/i,
  'migration 0035 must gate the starter coverage rule on is_complete using the starter-only counters');
assert.match(coverage, /starting lineup must contain at least 1 Forward, 1 Midfielder, and 1 Defender/i,
  'migration 0035 must name the required positions in its error');

// Migration 0036 retires the fantasy reserve slot: a squad is starters plus
// substitutes. Both write functions are replaced — never a second write
// path — and every rule they already enforced has to survive the edit.
const noReserves = read('./supabase/migrations/0036_retire_squad_reserves.sql');
assert.match(noReserves, /create or replace function public\.ff_save_validated_squad/i,
  'migration 0036 must replace the squad save function, not create a second write path');
assert.match(noReserves, /create or replace function public\.ff_save_next_match_lineup/i,
  'migration 0036 must replace the match lineup save function, not create a second write path');
const retiredSquad = noReserves.slice(
  noReserves.indexOf('create or replace function public.ff_save_validated_squad'),
  noReserves.indexOf('$$;', noReserves.indexOf('create or replace function public.ff_save_validated_squad')),
);
assert.match(retiredSquad, /e\.slot not in \('starter','sub'\)/i,
  'the squad function must reject the reserve slot');
assert.doesNotMatch(retiredSquad, /'reserve'/i,
  'the squad function must not accept or count a reserve group');
assert.match(retiredSquad, /is_complete := total = settings\.starters \+ settings\.subs_count and starters = settings\.starters and subs = settings\.subs_count and keepers = 1;/i,
  'a complete squad is exactly starters plus substitutes');
assert.match(retiredSquad, benchRule,
  'migration 0036 must keep the bench rule of the live squad function');
assert.match(retiredSquad, /if is_complete and \(forwards = 0 or mids = 0 or defenders = 0\) then/i,
  'migration 0036 must keep the starting-lineup coverage rule of migration 0035');
assert.match(retiredSquad, /not exists \(select 1 from jsonb_to_recordset\(p_entries\) e\(player_id text,slot text\) where e\.player_id=p_captain and e\.slot='starter'\)/i,
  'migration 0036 must keep the captain and vice-captain checks of the live function');
const retiredLineup = noReserves.slice(
  noReserves.indexOf('create or replace function public.ff_save_next_match_lineup'),
  noReserves.indexOf('end $$;', noReserves.indexOf('create or replace function public.ff_save_next_match_lineup')),
);
assert.match(retiredLineup, /e\.slot not in \('starter','sub'\)/i,
  'the match lineup function must reject the reserve slot');
assert.doesNotMatch(retiredLineup, /slot='reserve'/i,
  'the match lineup function must not count a reserve group');
assert.match(retiredLineup, /jsonb_array_length\(p_entries\) > l\.starters \+ l\.subs_count/i,
  'a match lineup is capped at starters plus substitutes');
assert.doesNotMatch(noReserves, /\b(drop|truncate)\s+table\b|\balter\s+table\b|\bupdate\s+public\.leagues\b|\bdelete\s+from\s+public\.fantasy_match_lineup/i,
  'migration 0036 must not touch tables, league rows or historical lineups — only replace the two functions');

// Migration 0037 changes only the default substitutes count for new leagues:
// four, not five. The creation function is replaced, never duplicated, and no
// existing league row is touched.
const defaultFour = read('./supabase/migrations/0037_default_four_substitutes.sql');
assert.match(defaultFour, /create or replace function public\.create_league\(/i,
  'migration 0037 must replace the league creation function, not create a second write path');
assert.match(defaultFour, /p_subs_count integer default 4/i,
  'migration 0037 must default new leagues to four substitutes');
assert.doesNotMatch(defaultFour, /\b(drop|truncate)\s+table\b|\balter\s+table\b|\bupdate\s+public\.leagues\b|\bdelete\s+from\s+public\./i,
  'migration 0037 must not touch tables or existing league rows — only the function default');

// A lineup that is locked in, and a lineup that is captured while scoring,
// have to carry a captaincy that can be used. A lineup without one is kept
// exactly as it is; a lineup with a broken one is not an official lineup.
assert.match(lifecycle, /create or replace function public\.ff_valid_fantasy_captaincy\(p_lineup jsonb\)/i,
  'the captaincy of a lineup has to be checked in one place');
assert.match(lifecycle, /revoke all on function public\.ff_valid_fantasy_captaincy\(jsonb\) from public,anon,authenticated/i,
  'the captaincy check must stay internal to the database');
const promotion = lifecycle.slice(
  lifecycle.indexOf('create function public.ff_promote_match_lineup'),
  lifecycle.indexOf('$$;', lifecycle.indexOf('create function public.ff_promote_match_lineup')),
);
assert.match(promotion, /public\.ff_valid_fantasy_captaincy\(res\.lineup\)/i,
  'the promotion must only lock in a lineup whose captaincy can be used');
const scoring = lifecycle.slice(
  lifecycle.indexOf('create or replace function public.ff_score_match'),
  lifecycle.indexOf('$$;', lifecycle.indexOf('create or replace function public.ff_score_match')),
);
assert.match(scoring, /public\.ff_valid_fantasy_captaincy\(i\.lineup\)/i,
  'the captured official lineup must only carry a captaincy that can be used');
// The captaincy that is already stored is never invented away.
assert.doesNotMatch(lifecycle, /update\s+public\.fantasy_squads\s+set\s+captain_id/i,
  'the migration must not write a captain onto a lineup that never had one');
assert.doesNotMatch(lifecycle, /coalesce\([^)]*->>'captainId'\s*,\s*[^)]*\)/i,
  'the resolver must not fall back to another player as the captain');

// The deadline runner: migration 0029 makes the promotion automatic, keeps
// an auditable trail of every run, and only the service role may run it.
const runner = read('./supabase/migrations/0029_lineup_deadline_runner.sql');
assert.match(runner, /create table public\.lineup_deadline_runs/i,
  'the deadline runner must record every run it makes');
assert.match(runner, /ran_at timestamptz not null default clock_timestamp\(\)/i,
  'the trail must say when the runner ran');
assert.match(runner, /create table public\.lineup_deadline_failures/i,
  'a fixture the runner could not lock in must be recorded with its error');
assert.match(runner, /drop function public\.ff_promote_due_match_lineups\(\)/i,
  'the runner that takes no argument must be replaced by the one that records its run');
assert.match(runner, /create function public\.ff_promote_due_match_lineups\(p_source text default 'sweep'\)/i,
  'the runner must say where the run came from');
assert.match(runner, /insert into public\.lineup_deadline_runs\(source,matches_scanned,promoted,failed\)/i,
  'every run must be written to the trail');
assert.match(runner, /exception when others then/i,
  'one fixture must never stop the rest of the sweep');
assert.match(runner, /revoke all on function public\.ff_promote_due_match_lineups\(text\) from public,anon,authenticated/i,
  'the deadline runner must stay internal to the database');
assert.match(runner, /grant execute on function public\.ff_promote_due_match_lineups\(text\) to service_role/i,
  'the scheduler route holds the service key and has to be able to run the deadline');
assert.match(runner, /cron\.schedule\('ff-lineup-deadlines','\* \* \* \* \*',\s*'select public\.ff_promote_due_match_lineups\(''pg_cron''\)'\)/i,
  'the deadline promotion must run on the database, without the app being open');
assert.match(runner, /if not exists \(select 1 from pg_extension where extname='pg_cron'\) then/i,
  'the runner must still apply where pg_cron is not installed');
// The comment may name the command an operator runs; the migration may not.
const runnerCode = runner.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
const lifecycleCode = lifecycle.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
assert.doesNotMatch(runnerCode, /create\s+extension/i,
  'the migration must never install pg_cron by itself: installing it is an operational step');
assert.doesNotMatch(lifecycleCode, /create\s+extension/i,
  'the lineup lifecycle must never install pg_cron by itself');
assert.doesNotMatch(lifecycle, /pg_cron is preloaded/i,
  'the migration must not claim that pg_cron is installed where it is not');
assert.doesNotMatch(runner, /\b(drop|truncate)\s+table\b/i,
  'the deadline runner must never drop a table');
const runnerDeletes = [...runner.matchAll(/delete\s+from\s+public\.(\w+)/gi)].map((m) => m[1]);
assert.deepEqual([...new Set(runnerDeletes)].sort(), ['lineup_deadline_failures', 'lineup_deadline_runs'],
  'the deadline runner may only prune its own audit tables');

// Migration 0031: a fixture that is still waiting for its result must never
// fall out of the sweep in silence, and the trail must name the fixtures it
// works on.
const sweep = read('./supabase/migrations/0031_deadline_sweep_no_window.sql');
assert.doesNotMatch(sweep, /interval '14 days'/i,
  'the sweep must not abandon a fixture that has waited longer than a fortnight');
assert.match(sweep, /alter table public\.lineup_deadline_runs add column match_ids text\[\]/i,
  'the run row must name the fixtures it scanned');
assert.match(sweep, /matchIds/i,
  'the run result and the status must name the fixtures they scanned');
assert.match(sweep, /dueMatches/i,
  'the deadline status must name the fixtures the next sweep will scan');
assert.doesNotMatch(sweep, /\b(drop|truncate)\s+table\b/i,
  'the sweep migration must never drop a table');
assert.doesNotMatch(sweep, /delete\s+from\s+public\.fantasy_match_lineup_history/i,
  'the sweep migration must never rewrite a lineup that is already locked in');
const sweepWrites = [...sweep.matchAll(/(?:insert\s+into|update|delete\s+from)\s+public\.(\w+)/gi)].map((m) => m[1]);
assert.deepEqual([...new Set(sweepWrites)].sort(), ['lineup_deadline_failures', 'lineup_deadline_runs'],
  'the sweep migration may only write the runner’s own audit tables');
assert.match(sweep, /revoke all on function public\.ff_promote_due_match_lineups\(text\) from public,anon,authenticated/i,
  'the sweep must stay internal to the database');

// Migration 0032: a preparation is consumed by the fixture that is created
// next, even when that fixture is created when it starts — and never by a
// backfilled one. The resolver must not learn to read preparations: the
// association into a match-specific draft at creation is the fix.
const attach = read('./supabase/migrations/0032_preparation_attach_on_creation.sql');
assert.doesNotMatch(attach, /ff_effective_fantasy_lineups/i,
  'the resolver must stay untouched: a league-level preparation names no fixture');
assert.match(attach, /create or replace function public\.ff_attach_prepared_fantasy_lineups\(\) returns trigger/i,
  'the fix is the attach trigger of migration 0022, replaced');
assert.doesNotMatch(attach, /new\.kick_off\s*>\s*clock_timestamp\(\)/i,
  'a fixture created when it starts must still consume the league’s preparations');
assert.match(attach, /not exists \(select 1 from public\.real_matches/i,
  'a backdated fixture must never consume a preparation');
const attachWrites = [...attach.matchAll(/(?:insert\s+into|update|delete\s+from)\s+public\.(\w+)/gi)].map((m) => m[1]);
assert.deepEqual([...new Set(attachWrites)].sort(), ['fantasy_match_lineup_drafts', 'fantasy_next_lineup_preparations'],
  'the attach may only move a preparation into the new fixture’s drafts');
assert.doesNotMatch(attach, /\b(drop|truncate)\s+table\b/i, 'the attach migration must never drop a table');
assert.doesNotMatch(attach, /fantasy_match_lineup_history/i,
  'the attach migration must never touch a lineup that is already locked in');
assert.doesNotMatch(attach, /create\s+trigger/i,
  'the trigger already exists from 0022: replacing the function body is the whole change');

// Migration 0038: the Man of the Match. One curated record per match, readable
// by every member, writable only through the guarded API. The card's numbers
// come from the scoring record, so the migration stores only the choice and an
// optional photo — never points, goals or assists.
const motm = read('./supabase/migrations/0038_man_of_the_match.sql');
assert.match(motm, /create table if not exists "match_motm"/i,
  'migration 0038 must create the match_motm table');
assert.match(motm, /create unique index if not exists "match_motm_match_uq"[\s\S]*?"match_id"/i,
  'migration 0038 must allow exactly one man of the match per match');
assert.match(motm, /foreign key \("player_id"\) references "public"\."players"/i,
  'the man of the match must be a real player');
assert.match(motm, /create policy match_motm_select[\s\S]*?public\.is_member\(league_id\)/i,
  'every league member must be able to read the man of the match');
assert.doesNotMatch(motm, /grant (insert|update|delete) on (table )?"?public"?\."?match_motm"?/i,
  'clients must not write the man of the match directly — only the guarded API may');
assert.match(motm, /grant select on table "public"\."match_motm" to authenticated/i,
  'authenticated members must keep read access to the man of the match');
assert.doesNotMatch(motm, /\b(drop|truncate)\s+table\b|\bdelete\s+from\s+public\./i,
  'migration 0038 must not drop, truncate or delete application data');
// The photo bucket is private, keyed <league>/<match>/<uuid>.jpg, and a member
// only ever sees the photo currently linked on the MOTM row.
assert.match(motm, /insert into storage\.buckets[\s\S]*?'motm-images'[\s\S]*?false/i,
  'the motm-images bucket must be private');
assert.match(motm, /create policy ff_motm_photo_read[\s\S]*?public\.is_member\(mm\.league_id\)[\s\S]*?mm\.photo_url = 'motm-images\/'/i,
  'a member may only read the photo linked on the man of the match');
assert.match(motm, /create policy ff_motm_photo_insert[\s\S]*?public\.is_leader\(m\.league_id\) or public\.is_match_organizer\(m\.id\)/i,
  'only the leader or match organizer may upload a man-of-the-match photo');

// Migration 0039 moves the man-of-the-match write behind guarded functions.
// 0038 granted only SELECT on the table, so a direct client insert was blocked
// by row level security. The functions own the write and verify authorization,
// the approved status, and the player's participation themselves.
const chooseMotm = read('./supabase/migrations/0039_choose_motm_rpc.sql');
assert.match(chooseMotm, /create or replace function public\.choose_motm\(p_match text, p_player text\)[\s\S]*?security definer/i,
  'the man of the match must be chosen through a guarded security definer function');
assert.match(chooseMotm, /public\.is_leader\(v_match\.league_id\) or public\.is_match_organizer\(p_match\)/i,
  'choosing the man of the match must verify leader or match organizer authority');
assert.match(chooseMotm, /v_match\.status <> 'approved'/i,
  'the man of the match can only be chosen for an approved match');
assert.match(chooseMotm, /not exists \(select 1 from public\.match_scoring_lineups/i,
  'the man of the match must be a player who took part in the match');
assert.match(chooseMotm, /on conflict \(match_id\) do update/i,
  'choosing again must replace the existing pick, not error or duplicate');
assert.match(chooseMotm, /revoke all on function public\.choose_motm\(text, text\) from public, anon/i,
  'the choose function must not be callable by anonymous clients');
assert.match(chooseMotm, /grant execute on function public\.choose_motm\(text, text\) to authenticated/i,
  'the choose function must stay callable by authenticated members');
assert.match(chooseMotm, /create or replace function public\.set_motm_photo\(p_match text, p_photo text\)[\s\S]*?security definer/i,
  'the man-of-the-match photo must be linked through a guarded function');
assert.doesNotMatch(chooseMotm, /grant (insert|update|delete) on (table )?"?public"?\."?match_motm"?/i,
  'migration 0039 must not open direct client writes to match_motm');
assert.doesNotMatch(chooseMotm, /\b(drop|truncate)\s+table\b|\bdelete\s+from\s+public\./i,
  'migration 0039 must not drop, truncate or delete application data');

console.log('Phase 2 SQL static checks passed.');
console.log('NOTE: This is a source-level audit only; it does not parse or execute PostgreSQL migrations.');
