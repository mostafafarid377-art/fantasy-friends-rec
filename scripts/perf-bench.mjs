/**
 * Measures the hot read paths of Fantasy Friends against the seeded dataset.
 *
 * For each case: warms up, then runs N times and reports p50/p95/mean, then
 * prints EXPLAIN (ANALYZE, BUFFERS). Runs as the `authenticated` role with a
 * caller identity set, exactly as PostgREST would.
 *
 * Scratch tooling: local disposable database only. Usage:
 *   DATABASE_URL=postgresql://ff_test:ff_test@127.0.0.1:54329/ff_test node scripts/perf-bench.mjs [label]
 */
import { Client } from "pg";
import fs from "node:fs";

const url = process.env.DATABASE_URL;
if (!url || !/^postgresql:\/\/.*@127\.0\.0\.1:54329\/ff_test\w*$/.test(url)) {
  throw new Error("Refusing to benchmark anything but a disposable local ff_test database");
}
const label = process.argv[2] ?? "run";
const LEAGUE = "perf-league-a";
const CALLER = "00000000-0000-4000-8000-000000000001"; // perf manager 0 (leader)

const cases = [
  { name: "standings", sql: "select * from public.ff_display_standings($1)", params: [LEAGUE] },
  { name: "points_all_history", sql: "select * from public.ff_display_player_points($1,null)", params: [LEAGUE] },
  { name: "points_one_match", sql: "select * from public.ff_display_player_points($1,$2)", params: [LEAGUE, `${LEAGUE}-m299`] },
  { name: "my_live_match_points", sql: "select * from public.ff_my_live_match_points($1)", params: [LEAGUE] },
  { name: "my_latest_player_points", sql: "select * from public.ff_my_latest_display_player_points($1)", params: [LEAGUE] },
  { name: "last_game_points", sql: "select * from public.last_game_points($1)", params: [LEAGUE] },
  { name: "next_match_lineup", sql: "select public.ff_next_match_lineup($1)", params: [LEAGUE] },
  { name: "player_history", sql: "select * from public.player_finalized_games_with_logos($1,$2,20)", params: [LEAGUE, `${LEAGUE}-p0-2`] },
    { name: "squad_deadline", sql: "select public.ff_squad_deadline($1)", params: [LEAGUE] },
  { name: "recent_subs", sql: "select * from public.recent_fantasy_substitutions($1)", params: [LEAGUE] },
  { name: "dashboard_squad_read", sql: `select s.id,s.formation,s.captain_id,s.vice_captain_id,s.completed_at,sp.player_id,sp.slot,sp."order",p.full_name,p.position,p.status
      from fantasy_squads s left join fantasy_squad_players sp on sp.squad_id=s.id left join players p on p.id=sp.player_id and p.league_id=s.league_id
      where s.league_id=$1 and s.profile_id=$2`, params: [LEAGUE, CALLER] },
  { name: "dashboard_notifications", sql: "select id,title,body,read_at,created_at from notifications where profile_id=$1 and league_id=$2 order by created_at desc limit 4", params: [CALLER, LEAGUE] },
  { name: "dashboard_recent_matches", sql: "select m.id,m.title,m.status,m.kick_off,(select count(*) from match_events e where e.match_id=m.id) from real_matches m where m.league_id=$1 order by m.kick_off desc limit 4", params: [LEAGUE] },
  { name: "standings_history_read", sql: "select h.* from fantasy_points_history h where h.league_id=$1 order by h.created_at asc limit 200", params: [LEAGUE] },
];

const db = new Client({ connectionString: url });
await db.connect();
await db.query("set role authenticated");
await db.query(`select set_config('auth.uid', '${CALLER}', false)`);

const report = {};
for (const c of cases) {
  for (let i = 0; i < 3; i++) await db.query(c.sql, c.params); // warmup
  const times = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    await db.query(c.sql, c.params);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  report[c.name] = { p50: +p50.toFixed(2), p95: +p95.toFixed(2), mean: +mean.toFixed(2) };
  console.log(`${c.name.padEnd(26)} p50 ${p50.toFixed(2).padStart(7)}ms  p95 ${p95.toFixed(2).padStart(7)}ms  mean ${mean.toFixed(2).padStart(7)}ms`);
}

fs.mkdirSync("perf-results", { recursive: true });
fs.writeFileSync(`perf-results/${label}.json`, JSON.stringify(report, null, 2));

const plans = [];
for (const c of cases) {
  const { rows } = await db.query(`explain (analyze, buffers, format text) ${c.sql}`, c.params);
  plans.push(`===== ${c.name} =====\n${rows.map((r) => r["QUERY PLAN"]).join("\n")}`);
}
fs.writeFileSync(`perf-results/${label}-plans.txt`, plans.join("\n\n"));
await db.end();
console.log(`\nreport: perf-results/${label}.json, plans: perf-results/${label}-plans.txt`);
