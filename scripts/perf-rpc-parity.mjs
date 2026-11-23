/**
 * Verifies the new scoped RPCs return exactly what the old direct table reads
 * returned (same rows, same columns), for members and non-members.
 * Usage: DATABASE_URL=... node scripts/perf-rpc-parity.mjs
 */
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url || !/^postgresql:\/\/.*@127\.0\.0\.1:54329\/ff_test\w*$/.test(url)) {
  throw new Error("Refusing to run against anything but a disposable local ff_test database");
}
const LEAGUE = "perf-league-a";
const MEMBER = "00000000-0000-4000-8000-000000000001";
const NON_MEMBER = "00000000-0000-4000-8000-0000000000ff"; // exists in auth but not in the league

const db = new Client({ connectionString: url });
await db.connect();
const asUser = async (uid, fn) => {
  await db.query("begin");
  await db.query("set local role authenticated");
  await db.query(`select set_config('auth.uid', '${uid}', true)`);
  try { return await fn(); } finally { await db.query("rollback"); }
};

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log((ok ? "PASS" : "FAIL") + "  " + label + (extra ? ` (${extra})` : ""));
  if (!ok) failures++;
};

// 1. Events: league-wide parity with the direct read (as a member).
await asUser(MEMBER, async () => {
  const rpc = await db.query("select * from public.ff_league_match_events($1, null)", [LEAGUE]);
  const direct = await db.query("select id,match_id,player_id,event_type,minute,assist_player_id from match_events where league_id=$1", [LEAGUE]);
  const dMap = new Map(direct.rows.map((r) => [r.id, r]));
  check("events league-wide row count", rpc.rows.length === direct.rows.length, `${rpc.rows.length} vs ${direct.rows.length}`);
  let colDiffs = 0;
  for (const r of rpc.rows) {
    const d = dMap.get(r.id);
    if (!d) { colDiffs++; continue; }
    for (const k of ["match_id", "player_id", "event_type", "minute", "assist_player_id"])
      if (JSON.stringify(r[k]) !== JSON.stringify(d[k])) colDiffs++;
  }
  check("events league-wide column parity", colDiffs === 0, colDiffs + " diffs");
});

// 2. Events: match-scoped parity.
await asUser(MEMBER, async () => {
  const rpc = await db.query("select * from public.ff_league_match_events($1, $2)", [LEAGUE, `${LEAGUE}-m7`]);
  const direct = await db.query("select id from match_events where league_id=$1 and match_id=$2", [LEAGUE, `${LEAGUE}-m7`]);
  check("events one-match row set", JSON.stringify(rpc.rows.map((r) => r.id).sort()) === JSON.stringify(direct.rows.map((r) => r.id).sort()), `${rpc.rows.length} rows`);
});

// 3. Events: non-member gets zero rows (same as RLS-filtered direct read).
await asUser(NON_MEMBER, async () => {
  const rpc = await db.query("select * from public.ff_league_match_events($1, null)", [LEAGUE]);
  const direct = await db.query("select id from match_events where league_id=$1", [LEAGUE]);
  check("events non-member isolation", rpc.rows.length === 0 && direct.rows.length === 0, `rpc=${rpc.rows.length} direct=${direct.rows.length}`);
});

// 4. Events: league B member cannot read league A events through the RPC.
await asUser("0000000c-0000-4000-8000-000000000001", async () => {
  const rpc = await db.query("select * from public.ff_league_match_events($1, null)", [LEAGUE]);
  check("events cross-league isolation", rpc.rows.length === 0, `${rpc.rows.length} rows leaked`);
});

// 5. History: same rows and columns as the direct read the route used.
await asUser(MEMBER, async () => {
  const rpc = await db.query("select * from public.ff_league_points_history($1, 200)", [LEAGUE]);
  const direct = await db.query(
    `select h.match_id,h.gameweek,h.points,h.profile_id,m.title as match_title,m.kick_off,p.username,p.display_name
     from fantasy_points_history h
     left join real_matches m on m.id=h.match_id and m.league_id=h.league_id
     left join profiles p on p.id=h.profile_id
     where h.league_id=$1 order by h.created_at asc limit 200`, [LEAGUE]);
  const key = (r) => `${r.match_id}|${r.profile_id}|${r.points}`;
  const dMap = new Map(direct.rows.map((r) => [key(r), r]));
  check("history row count", rpc.rows.length === direct.rows.length, `${rpc.rows.length} vs ${direct.rows.length}`);
  let colDiffs = 0, missing = 0;
  for (const r of rpc.rows) {
    const d = dMap.get(key(r));
    if (!d) { missing++; continue; }
    for (const k of Object.keys(d)) if (JSON.stringify(r[k]) !== JSON.stringify(d[k])) { colDiffs++; break; }
  }
  check("history row set", missing === 0, missing + " missing");
  check("history column parity", colDiffs === 0, colDiffs + " diffs");
});

// 6. History: non-member and cross-league isolation.
await asUser(NON_MEMBER, async () => {
  const rpc = await db.query("select * from public.ff_league_points_history($1, 200)", [LEAGUE]);
  check("history non-member isolation", rpc.rows.length === 0, `${rpc.rows.length} rows leaked`);
});
await asUser("0000000c-0000-4000-8000-000000000001", async () => {
  const rpc = await db.query("select * from public.ff_league_points_history($1, 200)", [LEAGUE]);
  check("history cross-league isolation", rpc.rows.length === 0, `${rpc.rows.length} rows leaked`);
});

// 7. Grants: anon must not be able to call the new functions.
await asUser(MEMBER, async () => {});
await db.query("begin");
await db.query("set local role anon");
try {
  await db.query("select * from public.ff_league_match_events($1, null)", [LEAGUE]);
  check("anon denied ff_league_match_events", false, "call succeeded");
} catch { check("anon denied ff_league_match_events", true); }
try {
  await db.query("select * from public.ff_league_points_history($1, 200)", [LEAGUE]);
  check("anon denied ff_league_points_history", false, "call succeeded");
} catch { check("anon denied ff_league_points_history", true); }
await db.query("rollback");

console.log(failures === 0 ? "\nALL RPC PARITY CHECKS PASSED" : `\n${failures} CHECKS FAILED`);
process.exit(failures ? 1 : 0);
await db.end();
