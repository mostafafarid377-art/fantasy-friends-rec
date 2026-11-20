// Run only on a disposable local database initialized through migration 0013.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { Client } from "pg";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/unspecified");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/ff_test\w*$/.test(url.pathname)) {
  throw new Error("Use a disposable local ff_test database at migration 0013");
}
const db = new Client({ connectionString: url.href });
await db.connect();
const actor = "46541f7a-4ae9-466b-920e-f03966faf900";
try {
  const schema = await db.query("select to_regclass('public.match_player_statistics') as upgraded");
  assert.equal(schema.rows[0].upgraded, null, "Already upgraded");
  await db.query(`insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
    values($1,'upgrade@example.test','{"provider":"google"}','{"full_name":"Google Name"}')`, [actor]);
  await db.query(`update profiles set display_name='My Saved Name' where id=$1`, [actor]);
  await db.query(`insert into leagues(id,name,invite_code,created_by) values('league','Upgrade test','UPGTEST1',$1)`, [actor]);
  await db.query(`insert into league_members(id,league_id,profile_id,role) values('member','league',$1,'leader')`, [actor]);
  await db.query(`insert into teams(id,league_id,name,crest_url) values('home','league','Home','https://example.test/crest.png'),('away','league','Away',null);
    insert into players(id,league_id,team_id,full_name,position) values('player','league','home','Old Keeper','GK');
    insert into scoring_rules(id,league_id,position,event_type,points,status) values('rule','league','GK','goal',17,'approved');`);
  await db.query(`insert into real_matches(id,league_id,team_a_id,team_b_id,title,kick_off,status,organizer_id,home_score,away_score,duration_minutes,version)
    values('match','league','home','away','Past match',now()-interval '2 days','approved',$1,1,0,60,3)`, [actor]);
  await db.query(`insert into match_lineups(id,league_id,match_id,team_id,player_id,slot) values('line','league','match','home','player','starter');
    insert into player_match_points(id,league_id,match_id,player_id,match_version,points,breakdown)
      values('points','league','match','player',3,17,'[{"category":"goal","points":17}]');
    insert into match_scoring_receipts(match_id,match_version,result,result_basis)
      values('match',3,'{"version":3,"matchId":"match","players":1,"managers":0}','[]');`);
  await db.query(`insert into fantasy_squads(id,league_id,profile_id,formation,captain_id) values('squad','league',$1,'1-2-1','player')`, [actor]);
  await db.query(`insert into fantasy_squad_players(id,squad_id,player_id,slot) values('pick','squad','player','starter')`);
  const snapshots = ["leagues","league_members","profiles","teams","players","real_matches","match_lineups",
    "scoring_rules","player_match_points","match_scoring_receipts","fantasy_squads","fantasy_squad_players"];
  const read = async () => Object.fromEntries(await Promise.all(snapshots.map(async (table) => [table,
    (await db.query(`select to_jsonb(t) - 'match_position' as row from public.${table} t order by 1`)).rows])));
  const before = await read();
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((f) => /^001[4-7]_.*\.sql$/.test(f)).sort()) {
    await db.query(await readFile(new URL(file, dir), "utf8"));
    console.log(`Applied ${file}`);
  }
  assert.deepEqual(await read(), before);
  assert.deepEqual((await db.query("select match_position from match_lineups")).rows, [{ match_position:null }]);
  assert.equal((await db.query("select count(*)::int as n from match_player_statistics")).rows[0].n, 0);
  console.log(`Upgrade preserved all existing data in ${snapshots.length} seeded tables; no historical statistics synthesized.`);
} finally { await db.end(); }
