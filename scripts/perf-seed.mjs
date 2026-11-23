/**
 * Seeds a representative dataset for performance measurement.
 *
 * League A: 12 managers, 4 teams, 44 players, 300 approved matches over two
 * years, one live match, two future fixtures — about 7,500 events, 6,600
 * player-point rows and 3,600 manager-point/lineup-history rows.
 * League B: 6 managers, 10 matches, to keep cross-league checks honest.
 *
 * Scratch tooling: never runs against production. Usage:
 *   DATABASE_URL=postgresql://ff_test:ff_test@127.0.0.1:54329/ff_test node scripts/perf-seed.mjs
 */
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url || !/^postgresql:\/\/.*@127\.0\.0\.1:54329\/ff_test\w*$/.test(url)) {
  throw new Error("Refusing to seed anything but a disposable local ff_test database");
}
const raw = new Client({ connectionString: url });
const db = { query: async (text, params) => { try { return await raw.query(text, params); } catch (e) { console.error("FAILED SQL:", text.slice(0, 300)); throw e; } }, connect: () => raw.connect(), end: () => raw.end() };

const LEAGUE_A = "perf-league-a";
const LEAGUE_B = "perf-league-b";
const MANAGERS_A = 12;
const MATCHES_A = 300;
const positions = ["GK", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "MID", "FWD", "FWD"];
const eventTypes = ["goal", "assist", "yellow_card", "own_goal", "penalty_saved"];

const lineupJson = (players, captain, vice) => JSON.stringify({
  formation: "1-2-1", captainId: captain, viceId: vice,
  players: players.map((p, i) => ({ id: p.id, name: p.full_name, position: p.position, slot: i < 5 ? "starter" : "sub", order: i })),
});
const breakdownJson = (players, captain) => ({
  captainId: captain,
  lines: players.slice(0, 5).map((p) => ({ playerId: p.id, base: 4, multiplier: p.id === captain ? 2 : 1, points: p.id === captain ? 8 : 4 })),
  substitutions: [],
});

await db.connect();
console.time("seed");
await db.query("begin");
try {
  // Managers (auth trigger creates their profiles).
  const managerIds = [];
  for (let i = 0; i < MANAGERS_A + 6; i++) {
    const id = `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`;
    await db.query(
      "INSERT INTO auth.users(id,email,email_confirmed_at,created_at,updated_at) VALUES($1,$2,now(),now(),now()) ON CONFLICT (id) DO NOTHING",
      [id, `perf-user-${i}@example.test`],
    );
    managerIds.push(id);
  }
  await db.query("UPDATE profiles SET display_name='Perf ' || substring(id from 1 for 8) WHERE id LIKE '%-0000-4000-8000-000000000001'");

  const mkLeague = async (id, name, managers) => {
    await db.query("INSERT INTO leagues(id,name,invite_code,created_by,format,starters,subs_count,squad_size) VALUES($1,$2,$3,$4,'5v5',5,3,8) ON CONFLICT (id) DO NOTHING",
      [id, name, `PERF${id.slice(-1).toUpperCase()}`, managers[0]]);
    for (const [i, m] of managers.entries()) {
      await db.query("INSERT INTO league_members(id,league_id,profile_id,role,team_name) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [`${id}-member-${i}`, id, m, i === 0 ? "leader" : "manager", `Perf XI ${i}`]);
      await db.query("INSERT INTO league_standings(id,league_id,profile_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [`${id}-st-${i}`, id, m]);
    }
    await db.query(`INSERT INTO scoring_rules(id,league_id,position,event_type,points,status,approved_by,approved_at)
      SELECT gen_random_uuid()::text,$1,pos,ev,1,'approved',$2,now()
      FROM unnest(ARRAY['GK','DEF','MID','FWD']) pos CROSS JOIN unnest(ARRAY['goal','assist','yellow_card']) ev ON CONFLICT DO NOTHING`, [id, managers[0]]);
  };
  await mkLeague(LEAGUE_A, "Perf League A", managerIds.slice(0, MANAGERS_A));
  await mkLeague(LEAGUE_B, "Perf League B", managerIds.slice(MANAGERS_A));

  // Teams and players.
  const teamsByLeague = {};
  const playersByLeague = {};
  for (const league of [LEAGUE_A, LEAGUE_B]) {
    const teams = [];
    for (let t = 0; t < 4; t++) {
      const teamId = `${league}-team-${t}`;
      await db.query("INSERT INTO teams(id,league_id,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [teamId, league, `Team ${t}`]);
      teams.push(teamId);
    }
    const players = [];
    for (const [t, teamId] of teams.entries()) {
      for (const [i, position] of positions.entries()) {
        const pid = `${league}-p${t}-${i}`;
        await db.query("INSERT INTO players(id,league_id,team_id,full_name,position,shirt_number,status,availability) VALUES($1,$2,$3,$4,$5,$6,'active','available') ON CONFLICT DO NOTHING",
          [pid, league, teamId, `Player ${t}-${i}`, position, i + 1]);
        players.push({ id: pid, full_name: `Player ${t}-${i}`, position, team_id: teamId });
      }
    }
    teamsByLeague[league] = teams;
    playersByLeague[league] = players;
  }

  // Squads: every manager picks 8 players (5 starters + 3 subs).
  const squadByManager = {};
  for (const [i, m] of managerIds.slice(0, MANAGERS_A).entries()) {
    const squadId = `${LEAGUE_A}-squad-${i}`;
    const picked = playersByLeague[LEAGUE_A].slice((i * 3) % 20, (i * 3) % 20 + 8);
    await db.query("INSERT INTO fantasy_squads(id,league_id,profile_id,formation,captain_id,vice_captain_id,completed_at) VALUES($1,$2,$3,'1-2-1',$4,$5,now()) ON CONFLICT DO NOTHING",
      [squadId, LEAGUE_A, m, picked[0].id, picked[1].id]);
    for (const [o, p] of picked.entries()) {
      await db.query("INSERT INTO fantasy_squad_players(id,squad_id,player_id,slot,\"order\") VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [`${squadId}-${o}`, squadId, p.id, o < 5 ? "starter" : "sub", o]);
    }
    squadByManager[m] = picked;
  }

  // Matches for league A: 300 approved, 1 live, 2 future.
  const now = Date.now();
  const week = 7 * 24 * 3600 * 1000;
  for (let g = 0; g < MATCHES_A; g++) {
    const mid = `${LEAGUE_A}-m${g}`;
    const kickoff = new Date(now - (MATCHES_A - g) * week).toISOString();
    const [ta, tb] = [teamsByLeague[LEAGUE_A][g % 4], teamsByLeague[LEAGUE_A][(g + 1) % 4]];
    await db.query("INSERT INTO real_matches(id,league_id,team_a_id,team_b_id,title,kick_off,organizer_id,status,version,home_score,away_score,decided_at) VALUES($1,$2,$3,$4,$5,$6,$7,'approved',2,2,1,$6)",
      [mid, LEAGUE_A, ta, tb, `Perf matchday ${g + 1}`, kickoff, managerIds[0]]);
    await db.query("INSERT INTO match_scoring_receipts(match_id,match_version,result) VALUES($1,1,'{}') ON CONFLICT DO NOTHING", [mid]);
    const home = playersByLeague[LEAGUE_A].filter((p) => p.team_id === ta);
    const away = playersByLeague[LEAGUE_A].filter((p) => p.team_id === tb);
    const lineups = [...home, ...away];
    await db.query(
      `INSERT INTO match_lineups(id,match_id,league_id,team_id,player_id,slot,"order")
       SELECT $1 || '-lu-' || row_number() OVER (), $1, $2, p.team_id, p.id, 'starter', row_number() OVER ()
       FROM unnest($3::text[]) WITH ORDINALITY AS u(pid, ord) JOIN players p ON p.id = u.pid`,
      [mid, LEAGUE_A, lineups.map((p) => p.id)],
    );
    // ~25 events spread over both teams.
    const evRows = [];
    for (let e = 0; e < 25; e++) {
      const p = lineups[(g + e) % lineups.length];
      evRows.push([`${mid}-ev-${e}`, mid, LEAGUE_A, p.team_id, p.id, eventTypes[e % eventTypes.length], (e * 3) % 90 || null]);
    }
    await db.query(
      `INSERT INTO match_events(id,match_id,league_id,team_id,player_id,event_type,minute)
       SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::int[])`,
      [evRows.map((r) => r[0]), evRows.map((r) => r[1]), evRows.map((r) => r[2]), evRows.map((r) => r[3]), evRows.map((r) => r[4]), evRows.map((r) => r[5]), evRows.map((r) => r[6])],
    );
    await db.query(
      `INSERT INTO player_match_points(id,league_id,match_id,player_id,match_version,points,breakdown)
       SELECT $1 || '-pmp-' || p.id, $2, $1, p.id, 2, 7, '[{"category":"appearance","points":1}]'
       FROM unnest($3::text[]) pid JOIN players p ON p.id = pid`,
      [mid, LEAGUE_A, lineups.map((p) => p.id)],
    );
    for (const [i, m] of managerIds.slice(0, MANAGERS_A).entries()) {
      const squad = squadByManager[m];
      await db.query("INSERT INTO manager_points(id,league_id,match_id,profile_id,match_version,points,breakdown) VALUES($1,$2,$3,$4,2,$5,$6)",
        [`${mid}-mp-${i}`, LEAGUE_A, mid, m, 20 + ((g + i) % 30), breakdownJson(squad, squad[0].id)]);
      await db.query("INSERT INTO fantasy_points_history(id,league_id,profile_id,match_id,points) VALUES($1,$2,$3,$4,$5)",
        [`${mid}-fph-${i}`, LEAGUE_A, m, mid, 20 + ((g + i) % 30)]);
      await db.query("INSERT INTO fantasy_match_lineup_history(match_id,profile_id,lineup) VALUES($1,$2,$3)",
        [mid, m, lineupJson(squad, squad[0].id, squad[1].id)]);
    }
    if (g % 50 === 0) console.log(`  matchday ${g}`);
  }

  // Live match (kickoff passed, no result yet) with events for the live projection.
  const liveId = `${LEAGUE_A}-live`;
  await db.query("INSERT INTO real_matches(id,league_id,team_a_id,team_b_id,title,kick_off,organizer_id,status) VALUES($1,$2,$3,$4,'Perf live match',now()-interval '30 minutes',$5,'draft')",
    [liveId, LEAGUE_A, teamsByLeague[LEAGUE_A][0], teamsByLeague[LEAGUE_A][1], managerIds[0]]);
  const livePlayers = playersByLeague[LEAGUE_A].filter((p) => [teamsByLeague[LEAGUE_A][0], teamsByLeague[LEAGUE_A][1]].includes(p.team_id));
  await db.query(
    `INSERT INTO match_events(id,match_id,league_id,team_id,player_id,event_type,minute)
     SELECT $1 || '-ev-' || e, $1, $2, p.team_id, p.id, 'goal', 10 + e
     FROM generate_series(1, 8) e CROSS JOIN LATERAL (SELECT * FROM unnest($3::text[]) WITH ORDINALITY AS u(pid, ord) JOIN players p ON p.id = u.pid WHERE u.ord = e) p`,
    [liveId, LEAGUE_A, livePlayers.map((p) => p.id)],
  );
  for (const f of ["future-1", "future-2"]) {
    await db.query("INSERT INTO real_matches(id,league_id,team_a_id,team_b_id,title,kick_off,organizer_id,status) VALUES($1,$2,$3,$4,$5,now()+interval '3 days',$6,'draft')",
      [`${LEAGUE_A}-${f}`, LEAGUE_A, teamsByLeague[LEAGUE_A][0], teamsByLeague[LEAGUE_A][2], `Perf ${f}`, managerIds[0]]);
  }

  // League B: 10 approved matches.
  for (let g = 0; g < 10; g++) {
    const mid = `${LEAGUE_B}-m${g}`;
    await db.query("INSERT INTO real_matches(id,league_id,team_a_id,team_b_id,title,kick_off,organizer_id,status,version,home_score,away_score) VALUES($1,$2,$3,$4,$5,$6,$7,'approved',2,1,0)",
      [mid, LEAGUE_B, teamsByLeague[LEAGUE_B][0], teamsByLeague[LEAGUE_B][1], `B matchday ${g}`, new Date(now - (10 - g) * week).toISOString(), managerIds[MANAGERS_A]]);
  }

  // Notifications: 20 per manager in league A.
  await db.query(
    `INSERT INTO notifications(id,profile_id,league_id,type,title,body)
     SELECT 'perf-note-' || m || '-' || n, m, $1, 'match_created', 'Perf note', 'Body'
     FROM unnest($2::text[]) m CROSS JOIN generate_series(1, 20) n`,
    [LEAGUE_A, managerIds.slice(0, MANAGERS_A)],
  );

  // Approved matches keep a finalized lineup snapshot (what the app writes when a
  // lineup is saved on an approved match) — this is the shape production data has.
  await db.query(
    `insert into public.finalized_match_lineups(match_id,league_id,entries)
       select ml.match_id, ml.league_id, jsonb_agg(jsonb_build_object(
         'player_id',ml.player_id,'team_id',ml.team_id,'slot',ml.slot,'match_position',ml.match_position))
       from public.match_lineups ml join public.real_matches m on m.id=ml.match_id and m.status='approved'
       group by ml.match_id, ml.league_id on conflict (match_id) do nothing`
  );

  await db.query("commit");
  console.timeEnd("seed");
  const { rows } = await db.query(`SELECT (SELECT count(*) FROM real_matches) matches, (SELECT count(*) FROM match_events) events,
    (SELECT count(*) FROM player_match_points) pmp, (SELECT count(*) FROM manager_points) mp,
    (SELECT count(*) FROM fantasy_match_lineup_history) lineups, (SELECT count(*) FROM match_lineups) ml`);
  console.log(rows[0]);
} catch (e) {
  await db.query("rollback");
  throw e;
} finally {
  await db.end();
}
