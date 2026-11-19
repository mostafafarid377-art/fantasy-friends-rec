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

console.log('Phase 2 SQL static checks passed.');
console.log('NOTE: This is a source-level audit only; it does not parse or execute PostgreSQL migrations.');
