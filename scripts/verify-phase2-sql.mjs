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

console.log('Phase 2 SQL static checks passed.');
console.log('NOTE: This is a source-level audit only; it does not parse or execute PostgreSQL migrations.');
