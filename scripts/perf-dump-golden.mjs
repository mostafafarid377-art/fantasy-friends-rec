/**
 * Dumps golden outputs of the hot reads being optimized, for before/after parity.
 *
 * Usage: DATABASE_URL=... node scripts/perf-dump-golden.mjs <tag>
 * Produces perf-results/golden-<tag>.json with deterministic, sorted results for:
 *  - player_finalized_games_with_logos for every player in perf-league-a (several
 *    limit / pagination / breakdown variants)
 *  - the points-route event read (league-wide and per-match)
 *  - the standings-route history read
 */
import { Client } from "pg";
import fs from "node:fs";

const url = process.env.DATABASE_URL;
if (!url || !/^postgresql:\/\/.*@127\.0\.0\.1:54329\/ff_test\w*$/.test(url)) {
  throw new Error("Refusing to dump from anything but a disposable local ff_test database");
}
const tag = process.argv[2];
if (!tag) throw new Error("usage: node scripts/perf-dump-golden.mjs <tag>");
const LEAGUE = "perf-league-a";
const CALLER = "00000000-0000-4000-8000-000000000001";

const db = new Client({ connectionString: url });
await db.connect();
await db.query("set role authenticated");
await db.query(`select set_config('auth.uid', '${CALLER}', false)`);

const out = {};
const { rows: players } = await db.query("select id from players where league_id=$1 order by id", [LEAGUE]);

out.player_history = {};
for (const p of players) {
  const variants = {};
  const v1 = await db.query("select * from public.player_finalized_games_with_logos($1,$2,20)", [LEAGUE, p.id]);
  variants.default = v1.rows;
  const v2 = await db.query("select * from public.player_finalized_games_with_logos($1,$2,5,null,null,false)", [LEAGUE, p.id]);
  variants.small_no_breakdown = v2.rows;
  if (v1.rows.length > 5) {
    const fifth = v1.rows[4];
    const v3 = await db.query("select * from public.player_finalized_games_with_logos($1,$2,20,$3,$4)", [LEAGUE, p.id, fifth.kick_off, fifth.match_id]);
    variants.page2 = v3.rows;
  }
  out.player_history[p.id] = variants;
}

const evAll = await db.query("select id,match_id,player_id,event_type,minute,assist_player_id from match_events where league_id=$1", [LEAGUE]);
out.events_league = evAll.rows.map((r) => r.id).sort();
const evOne = await db.query("select id,match_id,player_id,event_type,minute,assist_player_id from match_events where league_id=$1 and match_id=$2", [LEAGUE, `${LEAGUE}-m7`]);
out.events_one_match = evOne.rows.map((r) => r.id).sort();

const hist = await db.query(
  `select h.*, m.title as match_title, m.kick_off as match_kick_off, p.username, p.display_name
   from fantasy_points_history h
   left join real_matches m on m.id = h.match_id and m.league_id = h.league_id
   left join profiles p on p.id = h.profile_id
   where h.league_id=$1 order by h.created_at asc limit 200`, [LEAGUE]);
out.history = hist.rows;

fs.mkdirSync("perf-results", { recursive: true });
fs.writeFileSync(`perf-results/golden-${tag}.json`, JSON.stringify(out, null, 1));
console.log(`golden-${tag}.json:`, Object.keys(out.player_history).length, "players,", out.events_league.length, "league events,", out.history.length, "history rows");
await db.end();
