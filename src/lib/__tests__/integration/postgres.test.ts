import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { PUT as saveStatisticsRoute } from "@/app/api/matches/[id]/statistics/route";

const transport = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/db", () => ({ getSupabase: async () => transport.client }));

/**
 * PostgreSQL integration tests for Fantasy Friends.
 *
 * These tests run against a REAL PostgreSQL database (not a mock). They
 * require DATABASE_URL to be set pointing to a fresh database.
 *
 * Auth simulation: Supabase RLS reads auth.uid() from a session-level GUC.
 * Each test user gets their own PoolClient (separate DB session). We use
 * SET ROLE authenticated + SET auth.uid to simulate authenticated users.
 *
 * Admin (ff_test) is the table owner and bypasses RLS by default.
 * RLS is tested by connecting as the `authenticated` role (not a table owner).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required to run PostgreSQL integration tests. " +
      "Set it to a fresh PostgreSQL instance before running vitest.",
  );
}

const target = new URL(DATABASE_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || !/^\/ff_test\w*$/.test(target.pathname)) {
  throw new Error("This suite truncates its fixture tables. Use a disposable local ff_test database.");
}

const pool = new Pool({ connectionString: DATABASE_URL });

let admin: PoolClient;

let leagueAId: string | undefined;
let leagueBId: string | undefined;
let matchId: string | undefined;
let leagueAInviteCode: string | undefined;

const userAId = "11111111-1111-1111-1111-111111111111";
const userBId = "22222222-2222-2222-2222-222222222222";
const userCId = "33333333-3333-3333-3333-333333333333";

async function sql(client: PoolClient, text: string, params?: unknown[]) {
  return client.query(text, params);
}

async function setAuthUid(client: PoolClient, uid: string | null) {
  await sql(client, `SET ROLE authenticated`);
  if (uid) {
    await sql(client, `SET auth.uid = '${uid}'`);
  } else {
    await sql(client, `SET auth.uid = ''`);
  }
}

async function freshClient(): Promise<PoolClient> {
  // A new connection for every role/session, not a reused authenticated socket.
  const client = await pool.connect();
  await sql(client, "RESET ROLE");
  await sql(client, `SET ROLE authenticated`);
  await sql(client, `SET auth.uid = ''`);
  return client;
}

beforeAll(async () => {
  admin = await pool.connect();

  await sql(admin, `TRUNCATE public.league_activity, public.league_standings, public.league_members, public.leagues,
    public.fantasy_squad_players, public.fantasy_squads, public.players, public.teams,
    public.real_matches, public.match_events, public.match_lineups, public.match_substitutions,
    public.match_approvals, public.scoring_rules, public.player_match_points, public.manager_points,
    public.fantasy_points_history, public.notifications, public.audit_logs, public.mutation_ops,
    public.invitations, public.fantasy_fixtures, public.auth_tokens, public.sessions, public.mail_outbox,
    public.profiles CASCADE;
    TRUNCATE auth.users CASCADE;`);

  // Keep the live Auth insert trigger active while seeding deterministic fixture names.
  await sql(admin, `ALTER TABLE auth.users ENABLE TRIGGER on_auth_user_created_ff`);

  await sql(admin, `
    INSERT INTO auth.users (id, email, email_confirmed_at, created_at, updated_at)
    VALUES ($1, 'userA@example.com', now(), now(), now()),
           ($2, 'userB@example.com', now(), now(), now()),
           ($3, 'userC@example.com', now(), now(), now())
    ON CONFLICT (id) DO NOTHING;
  `, [userAId, userBId, userCId]);

  await sql(admin, `
    INSERT INTO profiles (id, email, email_lower, password_hash, username, display_name, email_verified_at, created_at, updated_at)
    VALUES ($1, 'userA@example.com', 'usera@example.com', '', 'usera', 'User A', now(), now(), now()),
           ($2, 'userB@example.com', 'userb@example.com', '', 'userb', 'User B', now(), now(), now()),
           ($3, 'userC@example.com', 'userc@example.com', '', 'userc', 'User C', now(), now(), now())
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, username=EXCLUDED.username, display_name=EXCLUDED.display_name, updated_at = now();
  `, [userAId, userBId, userCId]);
});

afterAll(async () => {
  admin?.release();
  await pool.end();
});

describe("PostgreSQL integration: schema deployment", () => {
  it("migrations create required tables", async () => {
    const { rows } = await sql(admin, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const tables = new Set(rows.map((r: any) => r.table_name));
    const required = [
      "profiles","leagues","league_members","league_standings","league_activity",
      "teams","players","fantasy_squads","fantasy_squad_players","real_matches",
      "match_lineups","match_events","match_substitutions","match_approvals","match_scoring_receipts","match_player_statistics",
      "scoring_rules","player_match_points","manager_points","fantasy_points_history",
      "notifications","audit_logs","mutation_ops","invitations","fantasy_fixtures",
    ];
    for (const table of required) {
      expect(tables.has(table), `missing table: ${table}`).toBe(true);
    }
  });

  it("RLS is enabled on all application tables", async () => {
    const { rows } = await sql(admin, `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public'`);
    for (const row of rows) {
      expect(row.rowsecurity, `RLS not enabled for ${row.tablename}`).toBe(true);
    }
  });

  it("leagues table does NOT have allow_self_approval column", async () => {
    const { rows } = await sql(admin, `SELECT column_name FROM information_schema.columns WHERE table_name = 'leagues' AND table_schema = 'public'`);
    const columns = rows.map((r: any) => r.column_name);
    expect(columns).not.toContain("allow_self_approval");
  });

  it("RPC functions exist and are SECURITY DEFINER", async () => {
    const { rows } = await sql(admin, `SELECT proname, prosecdef FROM pg_proc WHERE pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public') AND proname IN ('calculate_match_points','recalculate_standings','create_league','join_league')`);
    const fns = new Map(rows.map((r: any) => [r.proname, r.prosecdef]));
    for (const fn of ['calculate_match_points','recalculate_standings','create_league','join_league']) {
      expect(fns.has(fn), `missing function: ${fn}`).toBe(true);
      expect(fns.get(fn), `${fn} not security definer`).toBe(true);
    }
  });
});

describe("PostgreSQL integration: RLS policies", () => {
  it("anonymous user cannot read leagues (RLS blocks)", async () => {
    const c = await freshClient();
    try {
      const { rows } = await sql(c, "SELECT count(*) FROM public.leagues");
      expect(parseInt(rows[0].count, 10)).toBe(0);
    } finally {
      c.release();
    }
  });

  it("authenticated user can read leagues they are a member of", async () => {
    const cA = await freshClient();
    try {
      await setAuthUid(cA, userAId);
      const { rows: lr } = await sql(cA, `INSERT INTO public.leagues (id, name, format, starters, subs_count, invite_code, created_by, created_at, updated_at) VALUES (gen_random_uuid()::text, 'Integration League A', '5v5', 5, 5, 'INTABC123', $1, now(), now()) RETURNING id, invite_code`, [userAId]);
      leagueAId = lr[0].id;
      leagueAInviteCode = lr[0].invite_code;
      await sql(cA, `INSERT INTO public.league_members (id, league_id, profile_id, role, team_name, created_at) VALUES (gen_random_uuid()::text, $1, $2, 'leader', 'User A XI', now())`, [leagueAId, userAId]);

      await setAuthUid(cA, userAId);
      const { rows } = await sql(cA, "SELECT id FROM public.leagues WHERE id = $1", [leagueAId]);
      expect(rows.length).toBe(1);

      const cC = await freshClient();
      try {
        await setAuthUid(cC, userCId);
        const { rows: cr } = await sql(cC, "SELECT id FROM public.leagues WHERE id = $1", [leagueAId]);
        expect(cr.length).toBe(0);
      } finally {
        cC.release();
      }
    } finally {
      cA.release();
    }
  });
});

describe("PostgreSQL integration: atomic league creation RPC", () => {
  it("create_league creates league + membership + standings + activity atomically", async () => {
    const cB = await freshClient();
    try {
      await setAuthUid(cB, userBId);
      const { rows } = await sql(cB, `SELECT public.create_league('Integration League B', 'Test league', '5v5', 5, 5, 'User B XI') as league_id`);
      leagueBId = rows[0].league_id;
      expect(leagueBId).toBeDefined();

      const { rows: league } = await sql(cB, `SELECT * FROM public.leagues WHERE id = $1`, [leagueBId]);
      expect(league.length).toBe(1);
      expect(league[0].invite_code).toMatch(/^[A-Z0-9]{8}$/);

      const { rows: members } = await sql(cB, `SELECT * FROM public.league_members WHERE league_id = $1 AND profile_id = $2`, [leagueBId, userBId]);
      expect(members.length).toBe(1);
      expect(members[0].role).toBe('leader');

      const { rows: standings } = await sql(cB, `SELECT * FROM public.league_standings WHERE league_id = $1 AND profile_id = $2`, [leagueBId, userBId]);
      expect(standings.length).toBe(1);

      const { rows: activity } = await sql(cB, `SELECT * FROM public.league_activity WHERE league_id = $1 AND action = 'league.created'`, [leagueBId]);
      expect(activity.length).toBe(1);
    } finally {
      cB.release();
    }
  });

  it("create_league rejects unauthenticated callers", async () => {
    const c = await freshClient();
    try {
      await expect(
        sql(c, "SELECT public.create_league('No Auth League', null, '5v5', 5, 5, null)")
      ).rejects.toThrow();
    } finally {
      c.release();
    }
  });

  it("create_league is atomic (core artifacts exist together)", async () => {
    const cB = await freshClient();
    try {
      await setAuthUid(cB, userBId);
      const { rows } = await sql(cB, `SELECT public.create_league('Atomic Test League', 'Atomicity test', '5v5', 5, 5, null) as league_id`);
      const id = rows[0].league_id;

      const checks = [
        ['leagues', `SELECT id FROM public.leagues WHERE id = $1`],
        ['league_members', `SELECT id FROM public.league_members WHERE league_id = $1`],
        ['league_standings', `SELECT id FROM public.league_standings WHERE league_id = $1`],
        ['league_activity', `SELECT id FROM public.league_activity WHERE league_id = $1 AND action = 'league.created'`],
      ];
      for (const [table, q] of checks) {
        const { rows } = await sql(cB, q, [id]);
        expect(rows.length).toBeGreaterThan(0);
      }

      // Legacy create_league remains available; the app now calls create_league_confirmed.
      const { rows: rules } = await sql(cB, `SELECT id FROM public.scoring_rules WHERE league_id = $1`, [id]);
      expect(rules.length).toBe(44);
    } finally {
      cB.release();
    }
  });
});

describe("PostgreSQL integration: join league", () => {
  it("join_league validates invite code and creates membership", async () => {
    const cC = await freshClient();
    try {
      await setAuthUid(cC, userCId);
      await sql(cC, `SELECT public.join_league($1, 'User C Squad')`, [leagueAInviteCode]);

      const { rows: members } = await sql(cC, `SELECT * FROM public.league_members WHERE league_id = $1 AND profile_id = $2`, [leagueAId, userCId]);
      expect(members.length).toBe(1);
      expect(members[0].role).toBe('manager');
      expect(members[0].team_name).toBe('User C Squad');
    } finally {
      cC.release();
    }
  });

  it("join_league rejects invalid invite code", async () => {
    const cC = await freshClient();
    try {
      await setAuthUid(cC, userCId);
      await expect(
        sql(cC, "SELECT public.join_league('INVALIDCODE', 'X')")
      ).rejects.toThrow();
    } finally {
      cC.release();
    }
  });
});

describe("PostgreSQL integration: squad creation", () => {
  it("user can create a fantasy squad in their league", async () => {
    await sql(admin, `INSERT INTO public.teams (id, league_id, name, created_at) VALUES (gen_random_uuid()::text, $1, 'Team Alpha', now()), (gen_random_uuid()::text, $1, 'Team Beta', now()) RETURNING id`, [leagueAId]);
    const { rows: teams } = await sql(admin, `SELECT id FROM public.teams WHERE league_id = $1 LIMIT 2`, [leagueAId]);

    await sql(admin, `INSERT INTO public.players (id, league_id, team_id, full_name, position, shirt_number, status, availability, created_at, updated_at) VALUES (gen_random_uuid()::text, $1, $2, 'GK One', 'GK', 1, 'active', 'available', now(), now()), (gen_random_uuid()::text, $1, $2, 'DEF One', 'DEF', 2, 'active', 'available', now(), now()), (gen_random_uuid()::text, $1, $3, 'DEF Two', 'DEF', 3, 'active', 'available', now(), now()), (gen_random_uuid()::text, $1, $2, 'MID One', 'MID', 4, 'active', 'available', now(), now()), (gen_random_uuid()::text, $1, $3, 'MID Two', 'MID', 5, 'active', 'available', now(), now()), (gen_random_uuid()::text, $1, $2, 'FWD One', 'FWD', 6, 'active', 'available', now(), now()), (gen_random_uuid()::text, $1, $3, 'FWD Two', 'FWD', 7, 'active', 'available', now(), now())`, [leagueAId, teams[0].id, teams[1].id]);

    await sql(admin, `INSERT INTO players(id,league_id,team_id,full_name,position) VALUES(gen_random_uuid()::text,$1,$2,'Keeper Backup','GK')`, [leagueAId, teams[1].id]);
    const cC = await freshClient();
    try {
      await setAuthUid(cC, userCId);
      await expect(sql(cC, `INSERT INTO public.fantasy_squads (id,league_id,profile_id,formation) VALUES ('bypass',$1,$2,'2-1-1')`,
        [leagueAId, userCId])).rejects.toMatchObject({ code: "42501" });
      const { rows: pool } = await sql(cC, `SELECT id, position FROM public.players WHERE league_id=$1 ORDER BY full_name`, [leagueAId]);
      const starters = new Set(["GK", "DEF", "MID", "FWD"].flatMap((pos) => pool.filter((p) => p.position === pos)
        .slice(0, pos === "DEF" ? 2 : 1).map((p) => p.id)));
      let benchOrder = 1;
      const entries = pool.map((p, order) => ({ player_id: p.id, slot: starters.has(p.id) ? "starter" : "sub", order: starters.has(p.id) ? order : p.position === "GK" ? 0 : benchOrder++ }));
      const { rows: [saved] } = await sql(cC, `SELECT public.save_fantasy_squad_v2($1,'2-1-1',null,null,null,$2) AS result`, [leagueAId, JSON.stringify(entries)]);
      const squadId = saved.result.squad.id;
      expect(saved.result.squad.profile_id).toBe(userCId);
      const { rows: sp } = await sql(cC, `SELECT * FROM public.fantasy_squad_players WHERE squad_id = $1`, [squadId]);
      expect(sp.length).toBe(8);
      await expect(sql(cC, "UPDATE public.fantasy_squad_players SET slot='sub' WHERE squad_id=$1", [squadId])).rejects.toMatchObject({ code: "42501" });
      await expect(sql(cC, "UPDATE public.fantasy_squads SET captain_id=NULL WHERE id=$1", [squadId])).rejects.toMatchObject({ code: "42501" });

    } finally {
      cC.release();
    }
  });
});

describe("PostgreSQL integration: match management", () => {
  let matchTeams: any[];

  it("leader can create a match in their league", async () => {
    const cA = await freshClient();
    try {
      await setAuthUid(cA, userAId);
      const { rows: t } = await sql(admin, `SELECT id FROM public.teams WHERE league_id = $1 LIMIT 2`, [leagueAId]);
      matchTeams = t;
      const { rows: matches } = await sql(cA, `INSERT INTO public.real_matches (id, league_id, fixture_id, team_a_id, team_b_id, title, kick_off, organizer_id, status, created_at, updated_at) VALUES (gen_random_uuid()::text, $1, null, $2, $3, 'Integration Match 1', now() + interval '7 days', $4, 'draft', now(), now()) RETURNING id`, [leagueAId, t[0].id, t[1].id, userAId]);
      matchId = matches[0].id;
      expect(matchId).toBeDefined();
    } finally {
      cA.release();
    }
  });

  it("organizer can submit match events", async () => {
    const cA = await freshClient();
    try {
      await setAuthUid(cA, userAId);
      const { rows: players } = await sql(admin, `SELECT id FROM public.players WHERE league_id = $1 LIMIT 2`, [leagueAId]);

      const { rows: matchInfo } = await sql(cA, `SELECT team_a_id, team_b_id FROM public.real_matches WHERE id = $1`, [matchId]);
      const taId = matchInfo[0].team_a_id;


      await sql(admin, `INSERT INTO public.match_lineups (id, match_id, league_id, team_id, player_id, slot, "order", created_at) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'starter', 1, now()), (gen_random_uuid()::text, $1, $2, $3, $5, 'starter', 2, now())`, [matchId, leagueAId, taId, players[0].id, players[1].id]);

      await sql(cA, `INSERT INTO public.match_events (id, match_id, league_id, team_id, player_id, event_type, minute, note, created_by, created_at, updated_at) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'goal', 23, 'Great strike', $5, now(), now()), (gen_random_uuid()::text, $1, $2, $3, $6, 'yellow_card', 45, 'Tactical foul', $5, now(), now())`, [matchId, leagueAId, taId, players[0].id, userAId, players[1].id]);

      const { rows: events } = await sql(cA, `SELECT * FROM public.match_events WHERE match_id = $1 ORDER BY minute`, [matchId]);
      expect(events.length).toBe(2);
      expect(events[0].event_type).toBe('goal');
    } finally {
      cA.release();
    }
  });

  it("leader can submit and approve via guarded RPCs, not a direct status update", async () => {
    const cA = await freshClient();
    try {
      await setAuthUid(cA, userAId);
      await expect(sql(cA, "UPDATE public.real_matches SET status='pending' WHERE id=$1", [matchId])).rejects.toMatchObject({ code: "42501" });
      const { rows: [match] } = await sql(cA, "SELECT * FROM public.real_matches WHERE id=$1", [matchId]);
      // Use a complete valid lineup and approved rules, as the actual RPC requires.
      await sql(admin, "DELETE FROM public.match_lineups WHERE match_id=$1", [matchId]);
      const { rows: events } = await sql(cA, "SELECT player_id FROM public.match_events WHERE match_id=$1 ORDER BY minute", [matchId]);
      await sql(admin, "UPDATE public.players SET team_id=$1,position='DEF' WHERE id=ANY($2)", [match.team_a_id, events.map((e) => e.player_id)]);
      for (const team of [match.team_a_id, match.team_b_id]) {
        const entries = team === match.team_a_id ? events.map((e, order) => ({ player_id: e.player_id, slot: "starter", order })) : [];
        const existing = entries.length;
        for (let i = existing; i < 5; i++) {
          const id = randomUUID();
          await sql(cA, "INSERT INTO public.players(id,league_id,team_id,full_name,position,created_by) VALUES($1,$2,$3,$4,$5,$6)",
            [id, leagueAId, team, `Lineup ${i}`, i === existing ? "GK" : "MID", userAId]);
          entries.push({ player_id: id, slot: "starter", order: i });
        }
        const lineup = await sql(cA, "SELECT * FROM public.replace_match_lineup($1,$2,$3)", [matchId, team, JSON.stringify(entries)]);
        expect(lineup.rowCount).toBe(5);
      }
      await sql(cA, "INSERT INTO public.scoring_rules(id,league_id,position,event_type,points,status,approved_by) VALUES($1,$2,'DEF','goal',4,'approved',$3)",
        [randomUUID(), leagueAId, userAId]);
      await sql(cA, "SELECT public.submit_match($1,1,1,0)", [matchId]);
      await expect(sql(cA, "SELECT public.approve_match($1,1)", [matchId])).rejects.toThrow(/changed/i);
      await sql(cA, "SELECT public.approve_match($1,2)", [matchId]);
      const refreshed = await sql(cA, "SELECT status FROM public.real_matches WHERE id=$1", [matchId]);
      expect(refreshed.rows[0].status).toBe("approved");
      const approvals = await sql(cA, "SELECT action FROM public.match_approvals WHERE match_id=$1 ORDER BY version", [matchId]);
      expect(approvals.rows.map((r) => r.action)).toEqual(["submitted", "approved"]);
    } finally {
      cA.release();
    }
  });

  it("non-leader cannot update match in another league", async () => {
    const cC = await freshClient();
    try {
      await setAuthUid(cC, userCId);
      await expect(
        sql(cC, `UPDATE public.real_matches SET status = 'approved' WHERE id = $1`, [matchId])
      ).rejects.toThrow();
    } finally {
      cC.release();
    }
  });
});

describe("PostgreSQL integration: scoring and standings", () => {
  it("scoring rules seeded for league A", async () => {
    const cA = await freshClient();
    try {
      await setAuthUid(cA, userAId);
      await sql(cA, `INSERT INTO public.scoring_rules (id, league_id, position, event_type, points, status, approved_by, approved_at) VALUES (gen_random_uuid()::text, $1, 'GK', 'goal', '10', 'approved', $2, now())`, [leagueAId, userAId]);
      await sql(cA, `INSERT INTO public.scoring_rules (id, league_id, position, event_type, points, status, approved_by, approved_at) VALUES (gen_random_uuid()::text, $1, 'DEF', 'yellow_card', '-3', 'approved', $2, now())`, [leagueAId, userAId]);
    } finally {
      cA.release();
    }
  });

  it("calculate_match_points computes points for a match", async () => {
    const cA = await freshClient();
    try {
      await setAuthUid(cA, userAId);
      const { rows } = await sql(cA, `SELECT public.calculate_match_points($1) as result`, [matchId]);
      expect(rows[0].result).toBeDefined();
    } finally {
      cA.release();
    }
  });

  it("recalculate_standings updates league standings", async () => {
    const cA = await freshClient();
    try {
      await setAuthUid(cA, userAId);
      await sql(cA, `SELECT public.recalculate_standings($1)`, [leagueAId]);
      const { rows: standings } = await sql(cA, `SELECT * FROM public.league_standings WHERE league_id = $1 ORDER BY rank`, [leagueAId]);
      expect(standings.length).toBeGreaterThan(0);
    } finally {
      cA.release();
    }
  });

  it("standings reflect match results", async () => {
    const cA = await freshClient();
    try {
      await setAuthUid(cA, userAId);
      const { rows: standings } = await sql(cA, `SELECT * FROM public.league_standings WHERE league_id = $1 ORDER BY rank`, [leagueAId]);
      expect(standings.length).toBeGreaterThan(0);
      expect(standings[0].rank).toBe(1);
    } finally {
      cA.release();
    }
  });
});

describe("PostgreSQL integration: RPC grants", () => {
  it("GRANT execute exists on calculate_match_points and recalculate_standings", async () => {
    const { rows } = await sql(admin, `SELECT proname, proacl::text as proacl_text FROM pg_proc WHERE pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public') AND proname IN ('calculate_match_points', 'recalculate_standings')`);
    for (const row of rows) {
      expect(row.proacl_text).toBeDefined();
      expect(row.proacl_text).toContain('authenticated=');
    }
  });
});

describe("PostgreSQL integration: no DATABASE_URL in routes", () => {
  it("no production route imports DATABASE_URL directly", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const apiDir = path.join(process.cwd(), "src", "app", "api");
    let found = false;

    function checkDir(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          checkDir(path.join(dir, entry.name));
        } else if (entry.name === "route.ts") {
          const content = fs.readFileSync(path.join(dir, entry.name), "utf8");
          if (content.includes("DATABASE_URL")) {
            found = true;
          }
        }
      }
    }
    checkDir(apiDir);
    expect(found).toBe(false);
  });
});


describe("Confirmed writes: persistence, retry, and isolation (real PostgreSQL)", () => {
  it("persists a team and player under the authenticated leader, readable in a fresh session", async () => {
    const teamId = randomUUID(), playerId = randomUUID();
    const writer = await freshClient();
    try {
      await setAuthUid(writer, userAId);
      const team = await sql(writer, "INSERT INTO teams (id,league_id,name) VALUES($1,$2,'Persistence FC') RETURNING id,league_id", [teamId, leagueAId]);
      expect(team.rows).toEqual([{ id: teamId, league_id: leagueAId }]);
      const player = await sql(writer, "INSERT INTO players(id,league_id,team_id,full_name,position,created_by) VALUES($1,$2,$3,'Persistence Player','MID',$4) RETURNING id,league_id,team_id", [playerId, leagueAId, teamId, userAId]);
      expect(player.rows).toEqual([{ id: playerId, league_id: leagueAId, team_id: teamId }]);
      await expect(sql(writer, "INSERT INTO teams (id,league_id,name) VALUES($1,$2,'persistence fc')", [randomUUID(), leagueAId])).rejects.toMatchObject({ code: "23505" });
    } finally { writer.release(true); }
    const reader = await freshClient();
    try {
      await setAuthUid(reader, userAId);
      const result = await sql(reader, "SELECT t.name,p.full_name,p.created_by,p.league_id FROM teams t JOIN players p ON p.team_id=t.id AND p.league_id=t.league_id WHERE t.id=$1 AND p.id=$2", [teamId, playerId]);
      expect(result.rows).toEqual([{ name: "Persistence FC", full_name: "Persistence Player", created_by: userAId, league_id: leagueAId }]);
      await setAuthUid(reader, randomUUID());
      expect((await sql(reader, "SELECT id FROM players WHERE id=$1", [playerId])).rowCount).toBe(0);
      expect((await sql(reader, "SELECT id FROM teams WHERE id=$1", [teamId])).rowCount).toBe(0);
    } finally { reader.release(); }
  });

  it("denies both creates to a manager and denies a leader's cross-league team assignment", async () => {
    const client = await freshClient();
    try {
      for (const actor of [userBId, userCId, null]) {
        await setAuthUid(client, actor);
        await expect(sql(client, "INSERT INTO teams(id,league_id,name) VALUES($1,$2,'Unauthorized FC')", [randomUUID(), leagueAId])).rejects.toMatchObject({ code: "42501" });
        await expect(sql(client, "INSERT INTO players(id,league_id,full_name,position,created_by) VALUES($1,$2,'Unauthorized Player','MID',$3)", [randomUUID(), leagueAId, actor])).rejects.toMatchObject({ code: "42501" });
      }
      // Give A visibility in B as a manager so the rejection tests scope, not invisibility alone.
      const foreignId = randomUUID();
      await sql(admin, "INSERT INTO teams(id,league_id,name) VALUES($1,$2,'Foreign FC')", [foreignId, leagueBId]);
      await sql(admin, "INSERT INTO league_members(id,league_id,profile_id,role) VALUES($1,$2,$3,'manager') ON CONFLICT DO NOTHING", [randomUUID(), leagueBId, userAId]);
      await setAuthUid(client, userAId);
      expect((await sql(client, "SELECT id FROM teams WHERE id=$1", [foreignId])).rowCount).toBe(1);
      await expect(sql(client, "INSERT INTO players(id,league_id,team_id,full_name,position,created_by) VALUES($1,$2,$3,'Cross-League Player','MID',$4)", [randomUUID(), leagueAId, foreignId, userAId])).rejects.toMatchObject({ code: "22023" });
    } finally { client.release(); }
  });

  it("creates a league and 44 draft rules exactly once for one retry key", async () => {
    const c = await freshClient();
    try {
      await setAuthUid(c, userAId);
      const args = [randomUUID()];
      const statement = "SELECT public.create_league_confirmed($1,'Confirmed league',null,'5v5',5,5,null) AS league_id";
      const { rows: [first] } = await sql(c, statement, args);
      const { rows: [retry] } = await sql(c, statement, args);
      expect(retry).toEqual(first);
      const rules = await sql(c, "SELECT * FROM scoring_rules WHERE league_id=$1 AND status='draft'", [first.league_id]);
      expect(rules.rowCount).toBe(44);
      const updated = await sql(c, "SELECT * FROM public.save_scoring_rules($1,$2)", [first.league_id, JSON.stringify([{ position: "GK", event_type: "goal", points: 7 }])]);
      expect(updated.rows[0]).toMatchObject({ league_id: first.league_id, points: "7.00", status: "draft" });
    } finally { c.release(); }
  });

  it("initializes missing rules for a legacy league without replacing custom values", async () => {
    const c = await freshClient();
    try {
      await setAuthUid(c, userAId);
      const { rows: [legacy] } = await sql(c, "SELECT public.create_league('Legacy rule repair',null,'5v5',5,5,null) AS id");
      // Simulate a pre-upgrade league created without a seed.
      await sql(admin, "DELETE FROM scoring_rules WHERE league_id=$1", [legacy.id]);
      expect((await sql(c, "SELECT id FROM scoring_rules WHERE league_id=$1", [legacy.id])).rowCount).toBe(0);
      const install = "SELECT * FROM public.initialize_scoring_rules($1)";
      expect((await sql(c, install, [legacy.id])).rowCount).toBe(44);
      await sql(c, "UPDATE scoring_rules SET points=9,status='approved',approved_by=$2 WHERE league_id=$1 AND position='GK' AND event_type='goal'", [legacy.id,userAId]);
      const second = await sql(c, install, [legacy.id]);
      expect(second.rowCount).toBe(44);
      expect(second.rows.find((r) => r.position === "GK" && r.event_type === "goal")).toMatchObject({ points: "9.00", status: "approved" });
      await setAuthUid(c, userBId);
      await expect(sql(c, install, [legacy.id])).rejects.toMatchObject({ code: "42501" });
    } finally { c.release(); }
  });

  it("validates scoped squad writes atomically and protects against stale editors", async () => {
    const c = await freshClient();
    const save = "SELECT public.save_fantasy_squad_v2($1,$2,$3,$4,$5,$6) AS result";
    try {
      await setAuthUid(c, userAId);
      const { rows: [p] } = await sql(c, "SELECT id FROM players WHERE league_id=$1 AND position='GK' LIMIT 1", [leagueAId]);
      const { rows: [foreign] } = await sql(admin,
        "INSERT INTO players(id,league_id,full_name,position,status) VALUES(gen_random_uuid()::text,$1,'Away keeper','GK','active') RETURNING id", [leagueBId]);
      const { rows: [inactive] } = await sql(admin,
        "INSERT INTO players(id,league_id,full_name,position,status) VALUES(gen_random_uuid()::text,$1,'Archived keeper','GK','archived') RETURNING id", [leagueAId]);
      const entry = { player_id: p.id, slot: "starter", order: 0 };
      const initial = [leagueAId, "1-2-1", p.id, null, null, JSON.stringify([entry])];
      const { rows: [saved] } = await sql(c, save, initial);
      expect(saved.result.entries).toHaveLength(1);
      expect(saved.result.entries[0]).toMatchObject(entry);
      expect(saved.result.squad.completed_at).toBeNull();
      const revision = saved.result.squad.updated_at;
      await expect(sql(c, save, initial)).rejects.toMatchObject({ code: "PT409" });
      for (const [formation, captain, vice, entries] of [
        ["1-2-1", null, null, [entry, entry]],
        ["1-2-1", p.id, p.id, [entry]],
        ["1-2-1", p.id, null, [{ ...entry, slot: "sub" }]],
        ["1-2-1", null, "outsider", [entry]],
        ["1-2-3", null, null, [entry]],
        ["1-2-1", null, null, [{ ...entry, player_id: foreign.id }]],
        ["1-2-1", null, null, [{ ...entry, player_id: inactive.id }]],
      ]) await expect(sql(c, save, [leagueAId, formation, captain, vice, revision, JSON.stringify(entries)])).rejects.toMatchObject({ code: "22023" });
      expect((await sql(c, "SELECT player_id,slot,\"order\" FROM fantasy_squad_players WHERE squad_id=$1", [saved.result.squad.id])).rows).toEqual([entry]);
      const updated = (await sql(c, save, [leagueAId, "2-1-1", null, p.id, revision, JSON.stringify([entry])])).rows[0].result;
      expect(updated.entries[0].id).toBe(saved.result.entries[0].id);
      expect(updated.squad).toMatchObject({ id: saved.result.squad.id, vice_captain_id: p.id });
      await expect(sql(c, "SELECT public.save_fantasy_squad($1,'1-2-1',null,null,false,'[]')", [leagueAId])).rejects.toMatchObject({ code: "42501" });
      await expect(sql(c, save, [leagueBId, "1-2-1", null, null, null, JSON.stringify([entry])])).rejects.toMatchObject({ code: "22023" });
      const cleared = (await sql(c, save, [leagueAId, "1-2-1", null, null, updated.squad.updated_at, "[]"])).rows[0].result;
      expect(cleared.entries).toEqual([]);
      await setAuthUid(c, randomUUID());
      await expect(sql(c, save, initial)).rejects.toMatchObject({ code: "42501" });
    } finally { c.release(); }
  });

  it("persists an independent 7v7 squad with a smaller league's bench and position limits", async () => {
    const c = await freshClient();
    try {
      await setAuthUid(c, userAId);
      const other = (await sql(c, "SELECT public.create_league('Seven-side test',null,'7v7',7,2,null) AS id")).rows[0].id;
      await sql(c, "UPDATE leagues SET squad_size=10 WHERE id=$1", [other]);
      await expect(sql(c, "UPDATE leagues SET squad_size=8 WHERE id=$1", [other])).rejects.toMatchObject({ code: "23514" });
      const positions = ["GK", "DEF", "DEF", "DEF", "MID", "MID", "FWD", "GK", "MID", "FWD"];
      const entries: { player_id: string; slot: string; order: number }[] = [];
      for (const [order, position] of positions.entries()) {
        const player_id = randomUUID();
        await sql(c, "INSERT INTO players(id,league_id,full_name,position,created_by) VALUES($1,$2,$3,$4,$5)", [player_id, other, `Seven ${order}`, position, userAId]);
        entries.push({ player_id, slot: order < 7 ? "starter" : order < 9 ? "sub" : "reserve", order: order === 7 ? 0 : order === 8 ? 1 : order });
      }
      const save = (formation: string, picks: typeof entries, revision: string | null, captain = entries[0].player_id) =>
        sql(c, "SELECT public.save_fantasy_squad_v2($1,$2,$3,$4,$5,$6) AS result",
          [other, formation, captain, entries[1].player_id, revision, JSON.stringify(picks)]);
      await expect(save("2-2-2", entries, null)).rejects.toMatchObject({ code: "22023" });
      await expect(save("3-2-1", entries.map((e,i) => i === 9 ? { ...e, slot: "sub" } : e), null)).rejects.toMatchObject({ code: "22023" });
      await expect(save("3-2-1", entries.map((e,i) => i === 8 ? { ...e, slot: "reserve" } : e), null)).rejects.toMatchObject({ code: "22023" });
      await expect(save("3-2-1", entries.map((e,i) => i === 6 ? { ...entries[7], slot: "starter" } : i === 7 ? { ...entries[6], slot: "sub" } : e), null)).rejects.toMatchObject({ code: "22023" });
      const first = (await save("3-2-1", entries, null)).rows[0].result;
      expect(first.squad.completed_at).toBeTruthy();
      const swapped = entries.map((e,i) => i === 2 ? { ...e, slot: "sub", order: 1 } : i === 8 ? { ...e, slot: "starter", order: 2 } : e);
      const edit = (await save("2-3-1", swapped, first.squad.updated_at)).rows[0].result;
      expect(edit.squad).toMatchObject({ id: first.squad.id, formation: "2-3-1", completed_at: first.squad.completed_at });
      expect(edit.entries.find((e: {player_id: string}) => e.player_id === entries[9].player_id)).toEqual(first.entries[9]);
      expect((await sql(c, "SELECT league_id FROM fantasy_squads WHERE profile_id=$1 AND league_id IN ($2,$3)", [userAId, leagueAId, other])).rowCount).toBe(2);
      await setAuthUid(c, userCId);
      expect((await sql(c, "SELECT id FROM fantasy_squads WHERE league_id=$1", [other])).rowCount).toBe(0);
      await expect(save("3-2-1", entries, null)).rejects.toMatchObject({ code: "42501" });
    } finally { c.release(); }
  });

  it("reads only the latest approved version for the current member and preserves vice fallback", async () => {
    const c = await freshClient();
    try {
      await setAuthUid(c, userAId);
      const { rows: [game] } = await sql(c, "SELECT * FROM real_matches WHERE id=$1", [matchId]);
      const { rows: [goal] } = await sql(c, "SELECT player_id FROM match_events WHERE match_id=$1 AND event_type='goal'", [matchId]);
      const { rows: [absent] } = await sql(c, "SELECT id FROM players WHERE league_id=$1 AND position='GK' AND status='active' AND id NOT IN (SELECT player_id FROM match_lineups WHERE match_id=$2) LIMIT 1", [leagueAId, matchId]);
      const { rows: [original] } = await sql(c, "SELECT updated_at::text AS revision FROM fantasy_squads WHERE league_id=$1 AND profile_id=$2", [leagueAId, userAId]);
      const picks = [absent.id, goal.player_id].map((player_id, order) => ({ player_id, slot: "starter", order }));
      const save = (captain: string, vice: string, revision: string) => sql(c,
        "SELECT public.save_fantasy_squad_v2($1,'1-2-1',$2,$3,$4,$5) AS result", [leagueAId, captain, vice, revision, JSON.stringify(picks)]);
      const revised = (await save(absent.id, goal.player_id, original.revision)).rows[0].result;
      // Exercise the explicit recalculation path for a pre-receipt historical match.
      await sql(admin, "DELETE FROM match_scoring_receipts WHERE match_id=$1", [matchId]);
      await sql(c, "SELECT public.calculate_match_points($1)", [matchId]);
      const latest = (arg = leagueAId) => sql(c, "SELECT * FROM public.last_game_points($1)", [arg]);
      const fresh = (await latest()).rows[0];
      expect(fresh).toMatchObject({ matchId, points: "14.00" });
      const { rows: [{ breakdown }] } = await sql(c, "SELECT breakdown FROM manager_points WHERE match_id=$1 AND profile_id=$2", [matchId, userAId]);
      expect(breakdown).toMatchObject({ captainId: goal.player_id });
      expect(breakdown.lines).toContainEqual(expect.objectContaining({ playerId: goal.player_id, multiplier: 2 }));
      await save(goal.player_id, absent.id, revised.squad.updated_at);
      expect((await latest()).rows[0]).toEqual(fresh); // a future squad edit doesn't change a finalized result
      expect((await latest(leagueBId)).rows).toEqual([]);
      const pending = randomUUID();
      await sql(admin, "INSERT INTO real_matches(id,league_id,title,kick_off,team_a_id,team_b_id,organizer_id,status,version) VALUES($1,$2,'Future pending',$3::timestamptz+interval '1 day',$4,$5,$6,'pending',2)",
        [pending, leagueAId, game.kick_off, game.team_a_id, game.team_b_id, userAId]);
      expect((await latest()).rows[0]).toEqual(fresh);
      await sql(admin, "UPDATE real_matches SET status='approved',version=3 WHERE id=$1", [pending]);
      await sql(admin, "INSERT INTO manager_points(id,league_id,match_id,profile_id,match_version,points,breakdown) VALUES(gen_random_uuid()::text,$1,$2,$3,2,99,'{}')", [leagueAId, pending, userAId]);
      expect((await latest()).rows).toEqual([{ matchId: pending, title: "Future pending", points: null }]);
      await sql(admin, "UPDATE manager_points SET match_version=3,points=0 WHERE match_id=$1 AND profile_id=$2", [pending, userAId]);
      expect((await latest()).rows[0]).toMatchObject({ matchId: pending, points: "0.00" });
      await setAuthUid(c, userCId);
      expect((await latest()).rows[0]).toMatchObject({ matchId: pending, points: null });
      await setAuthUid(c, randomUUID());
      expect((await latest()).rows).toEqual([]);
    } finally { c.release(); }
  });

  it("creates a same-league match and fixture link atomically; manager cannot create one", async () => {
    const c = await freshClient();
    try {
      await setAuthUid(c, userAId);
      const { rows: teams } = await sql(c, "SELECT id FROM teams WHERE league_id=$1 LIMIT 2", [leagueAId]);
      const fixture = randomUUID();
      await sql(c, "INSERT INTO fantasy_fixtures(id,league_id,title,created_by) VALUES($1,$2,'Test fixture',$3)", [fixture, leagueAId, userAId]);
      const statement = "SELECT public.create_real_match($1,$2,$3,$4,'Confirmed match',now(),$5) AS result";
      const args = [randomUUID(), leagueAId, teams[0].id, teams[1].id, fixture];
      const first = await sql(c, statement, args);
      const retry = await sql(c, statement, args);
      expect(retry.rows).toEqual(first.rows);
      expect(first.rows[0].result).toMatchObject({ id: args[0], league_id: leagueAId, fixture_id: fixture, organizer_id: userAId });
      const { rows } = await sql(c, "SELECT real_match_id FROM fantasy_fixtures WHERE id=$1", [fixture]);
      expect(rows[0].real_match_id).toBe(args[0]);
      const memberNote = await sql(admin, "SELECT type,league_id FROM notifications WHERE league_id=$1 AND type='match_created' AND profile_id=$2 AND link=$3", [leagueAId, userCId, `/matches/${args[0]}`]);
      expect(memberNote.rows).toEqual([{ type: "match_created", league_id: leagueAId }]);
      const edit = await sql(c, "SELECT public.edit_real_match_details($1,1,$2) AS result", [args[0], JSON.stringify({ title: "Renamed test match", fixtureId: null })]);
      expect(edit.rows[0].result).toMatchObject({ title: "Renamed test match", version: 2, fixture_id: null });
      expect((await sql(c, "SELECT real_match_id FROM fantasy_fixtures WHERE id=$1", [fixture])).rows[0].real_match_id).toBeNull();
      await setAuthUid(c, userBId);
      await expect(sql(c, statement, [randomUUID(), ...args.slice(1)])).rejects.toMatchObject({ code: "42501" });
    } finally { c.release(); }
  });

  it("permits a leader to record an event on the assigned organizer's draft and rejects invalid or unauthorized events", async () => {
    const c = await freshClient();
    try {
      await setAuthUid(c, userAId);
      await sql(c, "SELECT public.set_member_role($1,$2,'organizer')", [leagueAId, userCId]);
      const { rows: teams } = await sql(c, "SELECT id FROM teams WHERE league_id=$1 ORDER BY id LIMIT 2", [leagueAId]);
      await setAuthUid(c, userCId);
      const id = randomUUID();
      await sql(c, "SELECT public.create_real_match($1,$2,$3,$4,'Organizer draft',now()+interval '1 hour',null)", [id, leagueAId, teams[0].id, teams[1].id]);
      await setAuthUid(c, userAId);
      const playerId = randomUUID();
      await sql(c, "INSERT INTO players(id,league_id,team_id,full_name,position,created_by) VALUES($1,$2,$3,'Event scorer','MID',$4)",
        [playerId, leagueAId, teams[0].id, userAId]);
      const entries = [{ player_id: playerId, slot: "starter", order: 0 }];
      for (let order = 1; order < 5; order++) {
        const player_id = randomUUID();
        await sql(c, "INSERT INTO players(id,league_id,team_id,full_name,position,created_by) VALUES($1,$2,$3,$4,$5,$6)", [player_id, leagueAId, teams[0].id, `Event lineup ${order}`, order === 1 ? "GK" : "DEF", userAId]);
        entries.push({ player_id, slot: "starter", order });
      }
      await sql(c, "SELECT * FROM public.replace_match_lineup($1,$2,$3)", [id, teams[0].id, JSON.stringify(entries)]);
      const eventId = randomUUID();
      const statement = "SELECT public.write_match_event($1,$2,'event',$3) AS result";
      const payload = { teamId: teams[0].id, playerId, eventType: "goal", minute: 9 };
      const args = [id, eventId, JSON.stringify(payload)];
      const made = await sql(c, statement, args);
      expect(made.rows[0].result).toMatchObject({ id: eventId, league_id: leagueAId, created_by: userAId });
      expect((await sql(c, statement, args)).rows).toEqual(made.rows);
      await expect(sql(c, statement, [id, randomUUID(), JSON.stringify({ ...payload, teamId: teams[1].id })])).rejects.toMatchObject({ code: "22023" });
      await setAuthUid(c, userBId);
      await expect(sql(c, statement, [id, randomUUID(), args[2]])).rejects.toMatchObject({ code: "42501" });
    } finally { c.release(); }
  });

});

describe("Player photo Storage policies and player linkage", () => {
  it("uses a private bucket, scopes upload/read/removal, and preserves a linked photo on other edits", async () => {
    const c = await freshClient();
    try {
      const { rows: [bucket] } = await sql(admin, "SELECT public, file_size_limit FROM storage.buckets WHERE id='player-images'");
      expect(bucket).toEqual({ public: false, file_size_limit: "5242880" });
      const playerId = randomUUID(), sameLeagueOther = randomUUID(), outsider = randomUUID();
      const key = `${leagueAId}/${playerId}/${randomUUID()}.jpg`;
      const nextKey = `${leagueAId}/${playerId}/${randomUUID()}.jpg`;
      const otherKey = `${leagueAId}/${sameLeagueOther}/${randomUUID()}.jpg`;
      const add = (path: string) => sql(c, "INSERT INTO storage.objects(bucket_id,name) VALUES('player-images',$1)", [path]);
      const read = (path: string) => sql(c, "SELECT name FROM storage.objects WHERE bucket_id='player-images' AND name=$1", [path]);
      const remove = (path: string) => sql(c, "DELETE FROM storage.objects WHERE bucket_id='player-images' AND name=$1", [path]);
      const photo = (path: string | null) => sql(c, "UPDATE players SET photo_url=$2 WHERE id=$1 RETURNING photo_url", [playerId, path]);
      await setAuthUid(c, userAId);
      for (const p of [playerId, sameLeagueOther]) await sql(c, "INSERT INTO players(id,league_id,full_name,position,created_by) VALUES($1,$2,$3,'DEF',$4)", [p, leagueAId, `Photo ${p}`, userAId]);
      await expect(photo(`player-images/${key}`)).rejects.toMatchObject({ code: "22023" });
      await expect(add(`${leagueBId}/${playerId}/${randomUUID()}.jpg`)).rejects.toMatchObject({ code: "42501" });
      await expect(add(`${leagueAId}/${playerId}/not-a-photo.svg`)).rejects.toMatchObject({ code: "42501" });
      await add(key); await add(otherKey); await add(nextKey);
      await expect(photo(`player-images/${otherKey}`)).rejects.toMatchObject({ code: "22023" });
      expect((await photo(`player-images/${key}`)).rows[0].photo_url).toBe(`player-images/${key}`);
      expect((await remove(key)).rowCount).toBe(0);
      expect((await sql(c, "UPDATE players SET full_name='Photo retained', team_id=NULL WHERE id=$1 RETURNING photo_url", [playerId])).rows[0].photo_url).toBe(`player-images/${key}`);
      await setAuthUid(c, userCId);
      expect((await read(key)).rowCount).toBe(1);
      expect((await read(nextKey)).rowCount).toBe(0);
      expect((await remove(key)).rowCount).toBe(0);
      await expect(add(`${leagueAId}/${playerId}/${randomUUID()}.jpg`)).rejects.toMatchObject({ code: "42501" });
      await setAuthUid(c, outsider);
      expect((await read(key)).rowCount).toBe(0);
      await setAuthUid(c, null);
      expect((await read(key)).rowCount).toBe(0);
      await setAuthUid(c, userAId);
      await photo(`player-images/${nextKey}`);
      expect((await remove(key)).rowCount).toBe(1);
      expect((await remove(nextKey)).rowCount).toBe(0);
      await photo(null);
      expect((await remove(nextKey)).rowCount).toBe(1);
      await remove(otherKey);
    } finally { c.release(); }
  });
});

const defaults: Record<string, number[]> = {
  goal: [10,6,5,4], own_goal: [-2,-2,-2,-2], assist: [3,3,3,3], yellow_card: [-1,-1,-1,-1], red_card: [-3,-3,-3,-3],
  penalty_saved: [5,3,3,3], penalty_missed: [-1,-1,-1,-1], appearance: [1,1,1,1], clean_sheet: [4,4,1,0], win: [0,0,0,0], draw: [0,0,0,0],
};
const positions = ["GK","DEF","MID","FWD"];
async function releaseLeague(c: PoolClient, size: number) {
  await setAuthUid(c, userAId);
  const { rows: [{ id }] } = await sql(c, "SELECT public.create_league_confirmed($1,$2,null,$3,$4,3,null) as id", [randomUUID(), `Release ${size}`, `${size}v${size}`, size]);
  await sql(admin, "INSERT INTO league_members(id,league_id,profile_id,role) VALUES($1,$2,$3,'organizer'),($4,$2,$5,'manager')", [randomUUID(),id,userCId,randomUUID(),userBId]);
  const [home, away] = [randomUUID(), randomUUID()];
  await sql(c, "INSERT INTO teams(id,league_id,name) VALUES($1,$3,'Home'),($2,$3,'Away')", [home,away,id]);
  const makePlayer = async (position: string, team: string, name = position) => {
    const player = randomUUID();
    await sql(admin, "INSERT INTO players(id,league_id,team_id,position,full_name,created_by) VALUES($1,$2,$3,$4,$5,$6)", [player,id,team,position,name,userAId]);
    return player;
  };
  const makeMatch = async () => {
    await setAuthUid(c,userCId);
    const match = randomUUID();
    await sql(c,"SELECT public.create_real_match($1,$2,$3,$4,'Release match',now()+interval '1 hour',null)",[match,id,home,away]);
    return match;
  };
  return { id, home, away, makePlayer, makeMatch };
}
const matchEntries = (start: string[], bench: string[] = []) => [
  ...start.map((player_id,order)=>({player_id,order,slot:"starter"})),
  ...bench.map((player_id,order)=>({player_id,order,slot:"sub"})),
];
const persistLineup = (c: PoolClient, match: string, team: string, entries: ReturnType<typeof matchEntries>) =>
  sql(c,"SELECT * FROM public.replace_match_lineup($1,$2,$3)",[match,team,JSON.stringify(entries)]);

describe("bench, match lineups and final scoring (real PostgreSQL)", () => {
  it.each([5,7])("saves an atomic %s-a-side lineup with scoped role checks and never touches fantasy picks", async (size) => {
    const c = await freshClient();
    try {
      const league = await releaseLeague(c,size);
      const players = await Promise.all(Array.from({length:size+2},(_,i) => league.makePlayer(i===0||i===size+1 ? "GK" : "DEF",league.home,`Lineup player ${i}`)));
      const match = await league.makeMatch();
      const first = matchEntries(players.slice(0,size), [players[size]]);
      await expect(persistLineup(c,match,league.home,first.slice(1))).rejects.toMatchObject({code:"22023"});
      await expect(persistLineup(c,match,league.home,matchEntries(players.slice(1,size+1)))).rejects.toMatchObject({code:"22023"});
      await expect(persistLineup(c,match,league.home,matchEntries([players[0],players[0],...players.slice(2,size)]))).rejects.toMatchObject({code:"22023"});
      const saved = await persistLineup(c,match,league.home,first); // assigned organizer
      expect(saved.rowCount).toBe(size+1);
      expect((await persistLineup(c,match,league.home,first)).rows).toEqual(saved.rows);
      await setAuthUid(c,userBId);
      await expect(persistLineup(c,match,league.home,first)).rejects.toMatchObject({code:"42501"});
      await setAuthUid(c,userAId);
      await expect(sql(c,"DELETE FROM match_lineups WHERE match_id=$1",[match])).rejects.toMatchObject({code:"42501"});
      const next = matchEntries([players[size+1],...players.slice(1,size)], [players[size]]);
      await sql(admin,"UPDATE players SET availability='suspended' WHERE id=$1",[players[size+1]]);
      await expect(persistLineup(c,match,league.home,next)).rejects.toMatchObject({code:"22023"});
      const read = (conn: PoolClient) => sql(conn,"SELECT player_id,slot,\"order\" FROM match_lineups WHERE match_id=$1 AND team_id=$2 ORDER BY slot,\"order\"",[match,league.home]);
      expect((await read(c)).rows).toEqual(first);
      await sql(admin,"UPDATE players SET availability='available',team_id=NULL WHERE id=$1",[players[size+1]]);
      await expect(persistLineup(c,match,league.home,next)).rejects.toMatchObject({code:"22023"});
      await sql(admin,"UPDATE players SET team_id=$2 WHERE id=$1",[players[size+1],league.home]);
      if (size === 5) {
        // Fail after DELETE and after INSERT is attempted, not just validation.
        await sql(admin,`CREATE FUNCTION public.ff_test_fail_lineup() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'Injected write failure'; END; $$;
          CREATE TRIGGER ff_test_fail_lineup AFTER INSERT ON public.match_lineups FOR EACH STATEMENT EXECUTE FUNCTION public.ff_test_fail_lineup();`);
        try {
          await expect(persistLineup(c,match,league.home,next)).rejects.toThrow(/Injected write failure/);
          expect((await read(c)).rows).toEqual(first);
        } finally {
          await sql(admin,"DROP TRIGGER ff_test_fail_lineup ON public.match_lineups; DROP FUNCTION public.ff_test_fail_lineup()");
        }
      }
      await persistLineup(c,match,league.home,next); // leader not organizer
      const reader = await freshClient();
      try { await setAuthUid(reader,userBId); expect((await read(reader)).rows).toEqual(next); }
      finally { reader.release(true); }
      expect((await sql(c,"SELECT id FROM fantasy_squads WHERE league_id=$1",[league.id])).rowCount).toBe(0);
    } finally { c.release(); }
  });

  it("skips an ineligible priority, preserves starters who played, and keeps 5- and 7-a-side shapes valid", async () => {
    const draft = (ids: string[], pos: string[], absent: Set<string>) => ids.map((id,priority) => ({id,name:id,position:pos[priority],priority,played:!absent.has(id)}));
    const auto = async (starters: ReturnType<typeof draft>,bench: ReturnType<typeof draft>,shape: string,size: number) =>
      (await sql(admin,"SELECT public.ff_auto_substitutions($1,$2,$3,$4) as result",[JSON.stringify(starters),JSON.stringify(bench),shape,size])).rows[0].result;
    const ids = ["keeper","one-def","mid-one","mid-two","fwd-one"];
    const five = ["GK","DEF","MID","MID","FWD"];
    const bench = draft(["bench-gk","bench-fwd","bench-def"],["GK","FWD","DEF"],new Set());
    expect(await auto(draft(ids,five,new Set(["keeper","one-def"])),bench,"1-2-1",5)).toEqual([
      expect.objectContaining({outId:"keeper",inId:"bench-gk"}),expect.objectContaining({outId:"one-def",inId:"bench-def"}),
    ]);
    expect(await auto(draft(ids,five,new Set(["one-def"])),bench,"1-2-1",5)).toEqual([expect.objectContaining({outId:"one-def",inId:"bench-def"})]);
    expect(await auto(draft(ids,five,new Set(["one-def","keeper"])),bench.slice(1,2),"1-2-1",5)).toEqual([]);
    expect(await auto(draft(ids,five,new Set(["mid-one","one-def"])),bench,"1-2-1",5)).toEqual([
      expect.objectContaining({outId:"mid-one",inId:"bench-fwd"}),expect.objectContaining({outId:"one-def",inId:"bench-def"}),
    ]);
    expect(await auto(draft([...ids,"two-def","fwd-two"],[...five,"DEF","FWD"],new Set(["mid-one","one-def"])),bench,"2-2-2",7)).toHaveLength(2);
    expect(await auto(draft(ids,five,new Set(["keeper"])),bench,"2-1-1",5)).toEqual([]);
  });

  it("matches all 44 new defaults; scores every event by position; only awards clean sheets to participating starters", async () => {
    const c = await freshClient();
    try {
      const league = await releaseLeague(c,5);
      const config = (await sql(c,"SELECT position,event_type,points,status FROM scoring_rules WHERE league_id=$1",[league.id])).rows;
      expect(config).toHaveLength(44);
      for (const row of config) {
        expect(row.status).toBe("draft");
        expect(Number(row.points)).toBe(defaults[row.event_type][positions.indexOf(row.position)]);
      }
      await sql(c,"UPDATE scoring_rules SET status='approved',approved_by=$2,approved_at=now() WHERE league_id=$1",[league.id,userAId]);
      const home = await Promise.all([...positions,"MID","DEF","FWD"].map((pos) => league.makePlayer(pos,league.home)));
      const away = await Promise.all([...positions,"MID"].map((pos) => league.makePlayer(pos,league.away)));
      const create = async () => {
        const match = await league.makeMatch();
        await persistLineup(c,match,league.home,matchEntries(home.slice(0,5),home.slice(5)));
        await persistLineup(c,match,league.away,matchEntries(away));
        return match;
      };
      const approve = async (match: string, home = 0, away = 0) => { await sql(c,"SELECT public.submit_match($1,1,$2,$3)",[match,home,away]); await sql(c,"SELECT public.approve_match($1,2)",[match]); };
      const eventMatch = await create();
      const eventTypes = ["goal","own_goal","assist","yellow_card","red_card","penalty_saved","penalty_missed"];
      for (const playerId of home.slice(0,4)) for (const eventType of eventTypes) {
        const args = [eventMatch,randomUUID(),JSON.stringify({teamId:league.home,playerId,eventType,minute:10})];
        const statement = "SELECT public.write_match_event($1,$2,'event',$3)";
        await sql(c,statement,args); await sql(c,statement,args); // request retry must not duplicate points
      }
      await approve(eventMatch,4,4);
      const ledger = (await sql(c,"SELECT * FROM player_match_points WHERE match_id=$1",[eventMatch])).rows;
      for (const [i,id] of home.slice(0,4).entries()) {
        const row = ledger.find((r)=>r.player_id===id);
        for (const event of [...eventTypes,"appearance"]) expect(row.breakdown).toContainEqual(expect.objectContaining({category:event,count:1,points:defaults[event][i]}));
        expect(basePoints(row)).toBe([...eventTypes,"appearance"].reduce((sum,event)=>sum+defaults[event][i],0));
        expect(row.breakdown.find((line:{category:string})=>line.category==="draw" || line.category==="win" || line.category==="clean_sheet")).toBeUndefined();
      }
      const cleanMatch = await create();
      await sql(c,"SELECT public.write_match_event($1,$2,'substitution',$3)",[cleanMatch,randomUUID(),JSON.stringify({teamId:league.home,playerId:home[5],otherId:home[1],minute:19})]);
      await approve(cleanMatch);
      const clean = (await sql(c,"SELECT * FROM player_match_points WHERE match_id=$1",[cleanMatch])).rows;
      for (const [i,id] of home.slice(0,4).entries()) {
        const row = clean.find((r)=>r.player_id===id);
        expect(basePoints(row)).toBe(1+defaults.clean_sheet[i]);
      }
      expect(clean.find((r)=>r.player_id===home[5]).breakdown).toEqual([expect.objectContaining({category:"appearance",points:1})]);
      expect(clean.some((r)=>r.player_id===home[6])).toBe(false);
      const before = (await sql(c,"SELECT player_id,points,breakdown FROM player_match_points WHERE match_id=$1 ORDER BY player_id",[cleanMatch])).rows;
      await setAuthUid(c,userAId);
      await sql(c,"UPDATE scoring_rules SET points=37 WHERE league_id=$1 AND event_type='clean_sheet'",[league.id]);
      await sql(c,"SELECT public.initialize_scoring_rules($1)",[league.id]);
      await sql(c,"SELECT public.calculate_match_points($1)",[cleanMatch]);
      expect((await sql(c,"SELECT player_id,points,breakdown FROM player_match_points WHERE match_id=$1 ORDER BY player_id",[cleanMatch])).rows).toEqual(before);
      // The zero default is a league setting, not a missing calculation.
      await sql(c,"UPDATE scoring_rules SET points=CASE event_type WHEN 'win' THEN 2 ELSE 3 END WHERE league_id=$1 AND event_type IN ('win','draw')",[league.id]);
      const drawMatch = await create();
      await approve(drawMatch);
      const draw = (await sql(c,"SELECT breakdown FROM player_match_points WHERE match_id=$1",[drawMatch])).rows;
      expect(draw.every((r)=>r.breakdown.some((line: {category: string; points: number})=>line.category==='draw' && line.points===3))).toBe(true);
      const winMatch = await create();
      await sql(c,"SELECT public.write_match_event($1,$2,'event',$3)",[winMatch,randomUUID(),JSON.stringify({teamId:league.home,playerId:home[3],eventType:'goal',minute:6})]);
      await approve(winMatch,1);
      const win = (await sql(c,"SELECT player_id,breakdown FROM player_match_points WHERE match_id=$1",[winMatch])).rows;
      expect(win.filter((r)=>r.breakdown.some((line: {category: string; points: number})=>line.category==='win' && line.points===2))
        .map((r)=>r.player_id).sort()).toEqual(home.slice(0,5).sort());
    } finally {c.release();}
  });

  it("finalizes a 7-a-side replacement and rolls back all scoring if a receipt cannot be written", async () => {
    const c = await freshClient();
    try {
      const league = await releaseLeague(c,7);
      const shape = ["GK","DEF","DEF","MID","MID","FWD","FWD"];
      const home = await Promise.all(shape.map((pos)=>league.makePlayer(pos,league.home)));
      const away = await Promise.all(shape.map((pos)=>league.makePlayer(pos,league.away)));
      const missing = await league.makePlayer("DEF",league.home);
      const starters = [home[0],missing,...home.slice(2)];
      await sql(c,"UPDATE scoring_rules SET status='approved',approved_by=$2,approved_at=now() WHERE league_id=$1",[league.id,userAId]);
      await sql(c,"SELECT public.save_fantasy_squad_v2($1,'2-2-2',$2,$3,null,$4)",
        [league.id,home[0],home[3],JSON.stringify(matchEntries(starters,[away[0],home[1]]))]);
      const match = await league.makeMatch();
      await persistLineup(c,match,league.home,matchEntries(home));
      await persistLineup(c,match,league.away,matchEntries(away));
      await sql(c,"SELECT public.submit_match($1,1,0,0)",[match]);
      const approve = () => sql(c,"SELECT public.approve_match($1,2)",[match]);
      await sql(admin,`CREATE FUNCTION public.ff_test_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Injected receipt failure'; END; $$;
        CREATE TRIGGER ff_test_fail_receipt BEFORE INSERT ON public.match_scoring_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.ff_test_fail_receipt();`);
      try {
        await expect(approve()).rejects.toThrow(/Injected receipt failure/);
        expect((await sql(c,"SELECT status FROM real_matches WHERE id=$1",[match])).rows).toEqual([{status:"pending"}]);
        for (const table of ["player_match_points","manager_points","fantasy_points_history","match_scoring_receipts"])
          expect((await sql(admin,`SELECT match_id FROM ${table} WHERE match_id=$1`,[match])).rowCount).toBe(0);
        expect((await sql(c,"SELECT matches_played FROM league_standings WHERE league_id=$1 AND profile_id=$2",[league.id,userAId])).rows).toEqual([{matches_played:0}]);
      } finally {
        await sql(admin,"DROP TRIGGER ff_test_fail_receipt ON public.match_scoring_receipts; DROP FUNCTION public.ff_test_fail_receipt()");
      }
      await approve();
      await setAuthUid(c,userAId);
      const {rows:[score]} = await sql(c,"SELECT points,breakdown FROM manager_points WHERE match_id=$1 AND profile_id=$2",[match,userAId]);
      expect(score.breakdown.substitutions).toEqual([expect.objectContaining({outId:missing,inId:home[1]})]);
      expect(score.breakdown.lines).toHaveLength(7);
      expect(Number(score.points)).toBe(38);
    } finally {c.release();}
  });

  it("applies bench at approval, keeps a zero-point player who played, and writes one immutable standings result", async () => {
    const c = await freshClient();
    try {
      const league = await releaseLeague(c,5);
      const home = await Promise.all(["GK","DEF","MID","MID","FWD","FWD","DEF"].map((pos,i)=>league.makePlayer(pos,league.home,`Home ${i}`)));
      const away = await Promise.all(["GK","DEF","MID","MID","FWD"].map((pos)=>league.makePlayer(pos,league.away)));
      const missing = await Promise.all(["GK","DEF","MID"].map((pos,i)=>league.makePlayer(pos,league.home,`Absent ${i}`)));
      await sql(c,"UPDATE scoring_rules SET status='approved',approved_by=$2,approved_at=now() WHERE league_id=$1",[league.id,userAId]);
      // FWD scores exactly zero without bonus events; this playing starter must remain.
      await sql(c,"UPDATE scoring_rules SET points=0 WHERE league_id=$1 AND position='FWD' AND event_type='appearance'",[league.id]);
      const starters = [missing[0],missing[1],missing[2],home[3],home[4]];
      const picks = matchEntries(starters,[home[0],home[5],home[6]]);
      const save = (revision: string|null, entries=picks) => sql(c,"SELECT public.save_fantasy_squad_v2($1,'1-2-1',$2,$3,$4,$5) as result",[league.id,missing[0],home[3],revision,JSON.stringify(entries)]);
      const squad = (await save(null)).rows[0].result;
      await sql(c,"UPDATE scoring_rules SET points=0 WHERE league_id=$1 AND position='GK' AND event_type IN ('appearance','clean_sheet')",[league.id]);
      await setAuthUid(c,userBId);
      await sql(c,"SELECT public.save_fantasy_squad_v2($1,'1-2-1',$2,$3,null,$4)",
        [league.id,home[0],home[3],JSON.stringify(matchEntries(home.slice(0,5),[away[0]]))]);
      const match = await league.makeMatch();
      await persistLineup(c,match,league.home,matchEntries(home.slice(0,5),home.slice(5)));
      await persistLineup(c,match,league.away,matchEntries(away));
      for (const [i,id] of home.slice(5).entries()) await sql(c,"SELECT public.write_match_event($1,$2,'substitution',$3)",[match,randomUUID(),JSON.stringify({teamId:league.home,playerId:id,otherId:home[i+1],minute:19})]);
      await sql(c,"SELECT public.submit_match($1,1,0,0)",[match]);
      const official = (await sql(c,"SELECT public.approve_match($1,2) as result",[match])).rows[0].result;
      await setAuthUid(c,userAId);
      const scores = () => sql(c,"SELECT id,points,breakdown,computed_at FROM manager_points WHERE match_id=$1 AND profile_id=$2",[match,userAId]);
      const saved = (await scores()).rows[0];
      expect(saved.breakdown).toMatchObject({captainId:home[3],substitutions:[
        expect.objectContaining({inId:home[0],outId:missing[0]}),expect.objectContaining({inId:home[5],outId:missing[2]}),expect.objectContaining({inId:home[6],outId:missing[1]}),
      ]});
      expect(saved.breakdown.lines).toContainEqual({playerId:home[4],base:0,multiplier:1,points:0});
      expect(saved.breakdown.lines).toContainEqual({playerId:home[3],base:3,multiplier:2,points:6});
      expect(Number(saved.points)).toBe(7);
      expect((await sql(c,"SELECT * FROM public.recent_fantasy_substitutions($1)",[league.id])).rows[0]).toMatchObject({matchId:match,substitutions:saved.breakdown.substitutions});
      expect((await sql(c,"SELECT * FROM fantasy_squad_players WHERE squad_id=$1 AND slot='starter'",[squad.squad.id])).rows.map(r=>r.player_id).sort()).toEqual([...starters].sort());
      const reordered = picks.map((e)=>e.slot==='sub' && e.order > 0 ? {...e,order:3-e.order}:e);
      await save(squad.squad.updated_at,reordered);
      expect((await sql(c,"SELECT public.calculate_match_points($1) as result",[match])).rows[0].result).toEqual(official);
      expect((await sql(c,"SELECT public.approve_match($1,2) as result",[match])).rows[0].result).toEqual(official);
      expect((await scores()).rows).toEqual([saved]);
      expect((await sql(c,"SELECT points FROM fantasy_points_history WHERE match_id=$1 AND profile_id=$2",[match,userAId])).rows).toEqual([{points:saved.points}]);
      expect((await sql(c,"SELECT matches_played,total_points FROM league_standings WHERE league_id=$1 AND profile_id=$2",[league.id,userAId])).rows).toEqual([{matches_played:1,total_points:saved.points}]);
      await setAuthUid(c,userBId);
      const { rows: [zero] } = await sql(c,"SELECT breakdown FROM manager_points WHERE match_id=$1 AND profile_id=$2",[match,userBId]);
      expect(zero.breakdown).toMatchObject({ captainId: home[0], substitutions: [] });
      expect(zero.breakdown.lines).toContainEqual({ playerId: home[0], base: 0, multiplier: 2, points: 0 });
      expect((await sql(c,"SELECT * FROM public.recent_fantasy_substitutions($1)",[league.id])).rowCount).toBe(0);
    } finally {c.release();}
  });
});

const playerHistorySql = "SELECT * FROM public.player_finalized_games($1,$2,$3,$4,$5)";
const latestPlayerSql = "SELECT * FROM public.latest_player_games($1,$2)";

describe("individual player performance (real PostgreSQL)", () => {
  it("reads the official individual ledger and actual participation, ignoring pending, unrelated and stale results", async () => {
    const c = await freshClient();
    try {
      const league = await releaseLeague(c, 5);
      const shape = ["GK", "DEF", "MID", "MID", "FWD"];
      const home = await Promise.all([...shape, "GK", "DEF", "MID"].map((pos, i) => league.makePlayer(pos, league.home, `Home ${i}`)));
      const away = await Promise.all(shape.map((pos) => league.makePlayer(pos, league.away)));
      const unused = home[5], subbedOn = home[6], neverNamed = home[7];
      const fixture = randomUUID();
      await sql(admin, "INSERT INTO fantasy_fixtures(id,league_id,gameweek,title) VALUES($1,$2,17,'GW 17')", [fixture, league.id]);
      await sql(c, "UPDATE scoring_rules SET points=0 WHERE league_id=$1 AND position='FWD' AND event_type='appearance'", [league.id]);
      await sql(c, "UPDATE scoring_rules SET status='approved',approved_by=$2,approved_at=now() WHERE league_id=$1", [league.id, userAId]);
      await sql(c, "SELECT public.save_fantasy_squad_v2($1,'1-2-1',$2,$3,null,$4)", [league.id, home[1], home[2], JSON.stringify(matchEntries(home.slice(0, 5), [unused]))]);
      const makeMatch = async (date: string, starters = home.slice(0, 5), bench: string[] = []) => {
        const id = await league.makeMatch();
        await persistLineup(c, id, league.home, matchEntries(starters, bench));
        await persistLineup(c, id, league.away, matchEntries(away));
        await sql(admin, "UPDATE real_matches SET kick_off=$2 WHERE id=$1", [id, date]);
        return id;
      };
      const finalize = async (id: string, home = 0) => {
        await sql(c, "SELECT public.submit_match($1,1,$2,0)", [id, home]);
        await sql(c, "SELECT public.approve_match($1,2)", [id]);
      };
      // Approve out of kickoff order; history follows the match date, not the recording date.
      const latest = await makeMatch("2026-11-08T19:00:00Z", home.slice(0, 5), [unused, subbedOn]);
      await sql(admin, "UPDATE real_matches SET title='Week 17 match',fixture_id=$2 WHERE id=$1", [latest, fixture]);
      for (const playerId of [home[1], home[2]]) {
        await sql(c, "SELECT public.write_match_event($1,$2,'event',$3)", [latest, randomUUID(), JSON.stringify({ teamId: league.home, playerId, eventType: "goal", minute: 10 })]);
      }
      await sql(c, "SELECT public.write_match_event($1,$2,'substitution',$3)", [latest, randomUUID(), JSON.stringify({ teamId: league.home, playerId: subbedOn, otherId: home[1], minute: 16 })]);
      await finalize(latest, 2);
      const earlier = await makeMatch("2026-11-01T19:00:00Z", [unused, ...home.slice(1, 5)]);
      await finalize(earlier);
      const unrelated = await makeMatch("2026-11-09T19:00:00Z", [home[0], subbedOn, ...home.slice(2, 5)]);
      await finalize(unrelated);
      const pending = await makeMatch("2026-11-11T19:00:00Z", [unused, ...home.slice(1, 5)]);
      await sql(c, "SELECT public.submit_match($1,1,0,0)", [pending]);
      // A stale-version score must not be exposed as the latest player's game.
      await sql(admin, `INSERT INTO player_match_points(id,league_id,match_id,player_id,match_version,points,breakdown)
        VALUES($1,$2,$3,$4,1,83,'[]'),($5,$2,$6,$4,2,99,'[]')`, [randomUUID(), league.id, unrelated, home[1], randomUUID(), pending]);
      // Transfer after the games: historical opposition is based on the match's recorded team.
      await sql(admin, "UPDATE players SET team_id=$2 WHERE id=$1", [home[1], league.away]);
      await setAuthUid(c, userAId);
      const summary = (await sql(c, latestPlayerSql, [league.id, [home[1], home[2], home[4], unused, neverNamed, home[1]]])).rows;
      expect(summary).toHaveLength(4);
      expect(summary).toContainEqual({ player_id: home[1], match_id: latest, points: "14.00" });
      expect(summary).toContainEqual({ player_id: home[2], match_id: unrelated, points: "2.00" });
      expect(summary).toContainEqual({ player_id: home[4], match_id: unrelated, points: "0.00" });
      expect(summary).toContainEqual({ player_id: unused, match_id: latest, points: null });
      const first = (await sql(c, playerHistorySql, [league.id, home[1], 10, null, null])).rows;
      expect(first.map((row) => row.match_id)).toEqual([latest, earlier]);
      expect(first[0]).toMatchObject({ title: "Week 17 match", kick_off: new Date("2026-11-08T19:00:00Z"), gameweek: 17,
        opponent: "Away", participation: "played", points: "14.00", breakdown: expect.arrayContaining([
          { category: "goal", label: "Goal", count: 1, pointsPer: 6, points: 6 },
          { category: "clean_sheet", label: "Clean sheet", count: 1, pointsPer: 4, points: 4 },
          { category: "appearance", label: "Appearance", count: 1, pointsPer: 1, points: 1 },
        ]) });
      expect((await sql(c, playerHistorySql, [league.id, home[1], 1, first[0].kick_off, latest])).rows).toEqual([first[1]]);
      const mids = (await sql(c, playerHistorySql, [league.id, home[2], 10, null, null])).rows;
      expect(mids.find((row) => row.match_id === latest)).toMatchObject({ points: "9.00", breakdown: expect.arrayContaining([expect.objectContaining({ category: "goal", points: 5 })]) });
      expect((await sql(c, "SELECT breakdown FROM manager_points WHERE match_id=$1 AND profile_id=$2", [latest, userAId])).rows[0].breakdown.lines)
        .toContainEqual({ playerId: home[1], base: 14, multiplier: 2, points: 28 });
      expect((await sql(c, playerHistorySql, [league.id, neverNamed, 10, null, null])).rows).toEqual([]);
      expect((await sql(c, playerHistorySql, [league.id, unused, 10, null, null])).rows).toMatchObject([
        { match_id: latest, participation: "did_not_play", points: null }, { match_id: earlier, participation: "played", points: "8.00" },
      ]);
      expect((await sql(c, playerHistorySql, [league.id, home[4], 1, null, null])).rows[0]).toMatchObject({ participation: "played", points: "0.00" });
      const benchHistory = (await sql(c, playerHistorySql, [league.id, subbedOn, 10, null, null])).rows;
      expect(benchHistory.find((row) => row.match_id === latest)).toMatchObject({ participation: "played", points: "1.00" });
      await setAuthUid(c, null);
      expect((await sql(c, latestPlayerSql, [league.id, home])).rows).toEqual([]);
    } finally { c.release(); }
  });

  it("uses each league's frozen scores and never returns foreign player IDs or nonmember history", async () => {
    const c = await freshClient();
    try {
      async function score(goal: number) {
        const l = await releaseLeague(c, 5);
        await sql(c, "UPDATE scoring_rules SET points=$2 WHERE league_id=$1 AND position='MID' AND event_type='goal'", [l.id, goal]);
        await sql(c, "UPDATE scoring_rules SET status='approved',approved_by=$2,approved_at=now() WHERE league_id=$1", [l.id, userAId]);
        const shape = ["GK", "DEF", "MID", "MID", "FWD"];
        const home = await Promise.all(shape.map((pos) => l.makePlayer(pos, l.home, "Same name")));
        const away = await Promise.all(shape.map((pos) => l.makePlayer(pos, l.away)));
        const match = await l.makeMatch();
        await persistLineup(c, match, l.home, matchEntries(home));
        await persistLineup(c, match, l.away, matchEntries(away));
        await sql(c, "SELECT public.write_match_event($1,$2,'event',$3)", [match, randomUUID(), JSON.stringify({ teamId: l.home, playerId: home[2], eventType: "goal", minute: 10 })]);
        await sql(c, "SELECT public.submit_match($1,1,1,0)", [match]);
        await sql(c, "SELECT public.approve_match($1,2)", [match]);
        return { id: l.id, player: home[2], match };
      }
      const low = await score(2), high = await score(13);
      await setAuthUid(c, userAId);
      await sql(c, "UPDATE scoring_rules SET points=19 WHERE league_id=$1 AND position='MID' AND event_type='goal'", [low.id]);
      for (const [current, other, expected] of [[low, high, "5.00"], [high, low, "18.00"]] as const) {
        expect((await sql(c, latestPlayerSql, [current.id, [current.player, other.player]])).rows)
          .toEqual([{ player_id: current.player, match_id: current.match, points: expected }]);
        expect((await sql(c, playerHistorySql, [current.id, other.player, 10, null, null])).rows).toEqual([]);
      }
      await sql(admin, "DELETE FROM league_members WHERE league_id=$1 AND profile_id=$2", [high.id, userBId]);
      await setAuthUid(c, userBId);
      expect((await sql(c, playerHistorySql, [high.id, high.player, 10, null, null])).rows).toEqual([]);
      expect((await sql(c, latestPlayerSql, [high.id, [high.player]])).rows).toEqual([]);
      expect((await sql(admin, "SELECT has_function_privilege('anon','public.latest_player_games(text,text[])','execute') AS allowed")).rows).toEqual([{ allowed: false }]);
    } finally { c.release(); }
  });
});

const submitScore = (c: PoolClient, match: string, home: number | null, away: number | null, version = 1) =>
  sql(c, "SELECT public.submit_match($1,$2,$3,$4) AS result", [match, version, home, away]);
const approveScore = (c: PoolClient, match: string, version = 2) =>
  sql(c, "SELECT public.approve_match($1,$2) AS result", [match, version]);
const correctScore = (c: PoolClient, match: string, home: number, away: number, version: number, reason = "Verified with the referee") =>
  sql(c, "SELECT public.correct_match_result($1,$2,$3,$4,$5) AS result", [match, version, home, away, reason]);
const basePoints = (row: { breakdown: { category: string; points: number }[] }) => row.breakdown.filter((line) => line.category !== "match_bonus").reduce((total, line) => total + line.points, 0);
const hasCleanSheet = (row: { breakdown: { category: string }[] }) => row.breakdown.some((b) => b.category === "clean_sheet");

async function recordedResultFixture(c: PoolClient, setup?: (id: string) => Promise<unknown>) {
  const league = await releaseLeague(c, 5);
  const positions = ["GK", "DEF", "MID", "MID", "FWD"];
  const home = await Promise.all([...positions, "DEF", "GK"].map((pos, i) => league.makePlayer(pos, league.home, `Home ${i}`)));
  const away = await Promise.all(positions.map((pos, i) => league.makePlayer(pos, league.away, `Away ${i}`)));
  await setup?.(league.id);
  await sql(c, "UPDATE scoring_rules SET status='approved',approved_by=$2,approved_at=now() WHERE league_id=$1", [league.id, userAId]);
  const match = await league.makeMatch();
  await persistLineup(c, match, league.home, matchEntries(home.slice(0,5), home.slice(5)));
  await persistLineup(c, match, league.away, matchEntries(away));
  return { league, match, home, away };
}

describe("automatic scoring from the recorded final result", () => {
  it.each([[2,0],[0,0],[2,1],[3,0],[0,3]])("scores %i–%i from the official score, not a count of events", async (homeScore, awayScore) => {
    const c = await freshClient();
    try {
      const { league, match, home, away } = await recordedResultFixture(c);
      await sql(c, "SELECT public.write_match_event($1,$2,'substitution',$3)", [match, randomUUID(),
        JSON.stringify({ teamId: league.home, playerId: home[5], otherId: home[1], minute: 5 })]);
      // In 2–1 the starter left before the goal. In 3–0 this logged event
      // deliberately disagrees with the scoreboard; only individual goal points follow it.
      if (awayScore > 0 || homeScore === 3) {
        await sql(c, "SELECT public.write_match_event($1,$2,'event',$3)", [match, randomUUID(),
          JSON.stringify({ teamId: league.away, playerId: away[4], eventType: "goal", minute: 50 })]);
      }
      expect((await submitScore(c, match, homeScore, awayScore)).rows[0].result)
        .toMatchObject({ status: "pending", home_score: homeScore, away_score: awayScore, version: 2 });
      expect((await submitScore(c, match, homeScore, awayScore)).rows[0].result.version).toBe(2);
      expect((await sql(c, "SELECT id FROM player_match_points WHERE match_id=$1", [match])).rowCount).toBe(0);
      const result = (await approveScore(c, match)).rows[0].result;
      expect((await approveScore(c, match)).rows[0].result).toEqual(result);
      const { rows } = await sql(c, "SELECT player_id,points,breakdown FROM player_match_points WHERE match_id=$1", [match]);
      expect(rows).toHaveLength(11);
      expect(rows.filter(hasCleanSheet).map((row) => row.player_id).sort()).toEqual([
        ...(awayScore === 0 ? home.slice(0,4) : []), ...(homeScore === 0 ? away.slice(0,4) : []),
      ].sort());
      for (const row of rows.filter(hasCleanSheet)) {
        const pos = home.includes(row.player_id) ? home.indexOf(row.player_id) : away.indexOf(row.player_id);
        expect(row.breakdown.filter((b: {category: string}) => b.category === "clean_sheet"))
          .toEqual([{ category: "clean_sheet", label: "Clean sheet", count: 1, pointsPer: pos < 2 ? 4 : 1, points: pos < 2 ? 4 : 1 }]);
      }
      expect(rows.find((r) => r.player_id === home[5])).toMatchObject({ breakdown: expect.arrayContaining([expect.objectContaining({ category: "appearance", points: 1 })]) });
      expect(rows.some((r) => r.player_id === home[6])).toBe(false);
      expect((await sql(c, "SELECT action FROM match_approvals WHERE match_id=$1 ORDER BY version", [match])).rows)
        .toEqual([{ action: "submitted" }, { action: "approved" }]);
    } finally { c.release(); }
  });

  it("corrects only score-derived points using the original rules and manager picks; retries and failures never duplicate points", async () => {
    const c = await freshClient();
    try {
      const { league, match, home, away } = await recordedResultFixture(c, (id) =>
        sql(c, `UPDATE scoring_rules SET points=CASE event_type WHEN 'win' THEN 2 WHEN 'draw' THEN 3 ELSE 6 END
          WHERE league_id=$1 AND (event_type IN ('win','draw') OR (position='DEF' AND event_type='clean_sheet'))`, [id]));
      await sql(c, "SELECT public.write_match_event($1,$2,'event',$3)", [match, randomUUID(),
        JSON.stringify({ teamId: league.home, playerId: home[1], eventType: "goal", minute: 33 })]);
      await setAuthUid(c, userAId);
      const save = (captain: string, revision: string | null) => sql(c, "SELECT public.save_fantasy_squad_v2($1,'1-2-1',$2,$3,$4,$5) AS result",
        [league.id, captain, home[2], revision, JSON.stringify(matchEntries(home.slice(0,5), [home[6]]))]);
      const { rows: [{ result: originalSquad }] } = await save(home[1], null);
      await setAuthUid(c, userBId);
      await expect(submitScore(c, match, 2, 0)).rejects.toMatchObject({ code: "42501" });
      await setAuthUid(c, userCId);
      await expect(submitScore(c, match, 2, null)).rejects.toMatchObject({ code: "22023" });
      await expect(submitScore(c, match, -1, 0)).rejects.toMatchObject({ code: "22023" });
      await expect(submitScore(c, match, 2, 0, 3)).rejects.toMatchObject({ code: "40001" });
      await expect(sql(c, "SELECT public.ff_submit_validated_match($1)", [match])).rejects.toMatchObject({ code: "42501" });
      await expect(sql(c, "UPDATE real_matches SET home_score=99 WHERE id=$1", [match])).rejects.toMatchObject({ code: "42501" });
      await expect(sql(c, `INSERT INTO real_matches(id,league_id,team_a_id,team_b_id,title,kick_off,organizer_id,status,home_score,away_score)
        VALUES($1,$2,$3,$4,'Unvalidated result',now(),$5,'approved',2,0)`, [randomUUID(), league.id, league.home, league.away, userCId]))
        .rejects.toMatchObject({ code: "42501" });
      await expect(sql(c,"SELECT public.write_match_event($1,$2,'event',$3)",[match, randomUUID(),
        JSON.stringify({ teamId: league.home, playerId: home[1], eventType: "clean_sheet", minute: 90 })])).rejects.toThrow();
      await submitScore(c, match, 2, 0);
      await approveScore(c, match);
      const manager = async () => (await sql(c, "SELECT id,match_version,points,breakdown,computed_at FROM manager_points WHERE match_id=$1", [match])).rows[0];
      const individual = (playerId: string) => sql(c, "SELECT id,match_version,points,breakdown FROM player_match_points WHERE match_id=$1 AND player_id=$2", [match, playerId]);
      const standings = () => sql(c, "SELECT total_points,matches_played FROM league_standings WHERE league_id=$1 AND profile_id=$2", [league.id, userAId]);
      await setAuthUid(c, userAId);
      const original = await manager();
      expect(original).toMatchObject({ points: "58.00", breakdown: { captainId: home[1] } });
      const originalPlayer = (await individual(home[1])).rows[0];
      await save(home[0], originalSquad.squad.updated_at);
      await sql(c, "UPDATE scoring_rules SET points=40,status='draft' WHERE league_id=$1", [league.id]);
      await sql(admin, "UPDATE players SET position='FWD' WHERE id=$1", [home[1]]);
      await setAuthUid(c, userBId);
      await expect(correctScore(c, match, 2, 1, 3)).rejects.toMatchObject({ code: "42501" });
      await setAuthUid(c, userAId);
      await expect(correctScore(c, match, 2, 1, 2)).rejects.toMatchObject({ code: "40001" });
      // An audit write failure must roll back score, manager and individual points together.
      await sql(admin, `CREATE FUNCTION public.ff_test_correction_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Injected correction failure'; END; $$;
        CREATE TRIGGER ff_test_correction_failure BEFORE INSERT ON public.match_approvals FOR EACH STATEMENT EXECUTE FUNCTION public.ff_test_correction_failure();`);
      try {
        await expect(correctScore(c, match, 2, 1, 3)).rejects.toThrow(/Injected correction failure/);
        expect(await manager()).toEqual(original);
        expect((await individual(home[1])).rows[0]).toEqual(originalPlayer);
        expect((await standings()).rows[0]).toEqual({ total_points: "58.00", matches_played: 1 });
      } finally {
        await sql(admin, "DROP TRIGGER ff_test_correction_failure ON public.match_approvals; DROP FUNCTION public.ff_test_correction_failure()");
      }
      const corrected = (await correctScore(c, match, 2, 1, 3)).rows[0].result;
      expect(corrected.version).toBe(4);
      expect((await correctScore(c, match, 2, 1, 3)).rows[0].result).toEqual(corrected);
      expect((await individual(home[1])).rows[0]).toMatchObject({ id: originalPlayer.id, points: "12.00", match_version: 4 });
      expect(hasCleanSheet((await individual(home[1])).rows[0])).toBe(false);
      expect(await manager()).toMatchObject({ id: original.id, points: "44.00", match_version: 4, computed_at: original.computed_at,
        breakdown: { captainId: home[1], lines: expect.arrayContaining([{ playerId: home[1], base: 12, multiplier: 2, points: 24 }]) } });
      expect((await standings()).rows[0]).toEqual({ total_points: "44.00", matches_played: 1 });
      const lastMatchTotal = () => sql(c, "SELECT * FROM public.last_game_points($1)", [league.id]);
      expect((await lastMatchTotal()).rows).toMatchObject([{matchId:match,points:"44.00"}]);
      // The assigned organizer can correct too. A draw restores both sides' clean sheets.
      await setAuthUid(c, userCId);
      await correctScore(c, match, 0, 0, 4, "Corrected final score");
      await setAuthUid(c, userAId);
      const def = (await individual(home[1])).rows[0];
      expect(def).toMatchObject({ points: "19.00", match_version: 5, breakdown: expect.arrayContaining([
        expect.objectContaining({ category: "goal", points: 6 }), expect.objectContaining({ category: "clean_sheet", points: 6 }),
        expect.objectContaining({ category: "draw", points: 3 }),
      ]) });
      expect(hasCleanSheet((await individual(away[0])).rows[0])).toBe(true);
      expect((await standings()).rows[0]).toEqual({ total_points: "61.00", matches_played: 1 });
      expect((await lastMatchTotal()).rows).toMatchObject([{matchId:match,points:"61.00"}]);
      expect((await sql(c, "SELECT points FROM fantasy_points_history WHERE match_id=$1", [match])).rows).toEqual([{ points: "61.00" }]);
      expect((await sql(c, playerHistorySql, [league.id, home[1], 1, null, null])).rows[0]).toMatchObject({ points: "19.00", breakdown: def.breakdown });
      expect((await sql(c, "SELECT home_score,away_score,status,version FROM real_matches WHERE id=$1", [match])).rows[0])
        .toEqual({ home_score: 0, away_score: 0, status: "approved", version: 5 });
      expect((await sql(c, "SELECT version,reason,snapshot FROM match_approvals WHERE action='corrected' AND match_id=$1 ORDER BY version", [match])).rows)
        .toEqual([{ version: 4, reason: "Verified with the referee", snapshot: { previousHomeScore: 2, previousAwayScore: 0, homeScore: 2, awayScore: 1 } },
          { version: 5, reason: "Corrected final score", snapshot: { previousHomeScore: 2, previousAwayScore: 1, homeScore: 0, awayScore: 0 } }]);
    } finally { c.release(); }
  });
});

it("leaves previously approved scoreless matches unchanged and requires resubmission of legacy pending matches", async () => {
  const c = await freshClient();
  try {
    const { match } = await recordedResultFixture(c);
    await sql(admin,"UPDATE real_matches SET status='pending',version=2 WHERE id=$1",[match]);
    await expect(approveScore(c, match)).rejects.toThrow(/record both scores/);
    await sql(c,"SELECT public.reject_match($1,'Record the score',2)",[match]);
    expect((await submitScore(c, match, 0, 0, 3)).rows[0].result).toMatchObject({ version: 4, home_score: 0, away_score: 0 });
    await approveScore(c, match, 4);
    // This fixture models a result approved before score input existed.
    const old = await recordedResultFixture(c);
    await sql(admin,"UPDATE real_matches SET status='approved',version=3 WHERE id=$1",[old.match]);
    await sql(c,"SELECT public.calculate_match_points($1)",[old.match]);
    const before = (await sql(c,"SELECT id,points,breakdown FROM player_match_points WHERE match_id=$1 ORDER BY id",[old.match])).rows;
    expect(before.some(hasCleanSheet)).toBe(true);
    await expect(correctScore(c, old.match, 1, 1, 3)).rejects.toThrow(/recorded result/);
    expect((await sql(c,"SELECT id,points,breakdown FROM player_match_points WHERE match_id=$1 ORDER BY id",[old.match])).rows).toEqual(before);
  } finally {c.release();}
});

it.each(["captain", "vice fallback"])("shows only the signed-in manager's applied %s contribution", async (scenario) => {
  const c = await freshClient();
  try {
    const { league, match, home } = await recordedResultFixture(c);
    const save = (starters: string[], captain: string, vice: string) => sql(c,
      "SELECT public.save_fantasy_squad_v2($1,'1-2-1',$2,$3,null,$4)",
      [league.id, captain, vice, JSON.stringify(matchEntries(starters, [home[6]]))]);
    await setAuthUid(c, userAId);
    await save(scenario === "captain" ? home.slice(0, 5) : [home[0], home[5], ...home.slice(2, 5)],
      scenario === "captain" ? home[0] : home[5], scenario === "captain" ? home[2] : home[0]);
    await setAuthUid(c, userBId);
    await save(home.slice(0, 5), home[1], home[2]);
    const latest = () => sql(c, "SELECT * FROM public.latest_squad_player_games($1,$2) ORDER BY player_id", [league.id, home]);
    await setAuthUid(c, userCId);
    await submitScore(c, match, 2, 0);
    expect((await latest()).rows).toEqual([]); // pending scores are not captain contributions
    await approveScore(c, match);
    await setAuthUid(c, userAId);
    const mine = (await latest()).rows;
    expect(mine.find((row) => row.player_id === home[0])).toMatchObject({ match_id: match, points: "8.00", captain_points: "16.00" });
    expect(mine.find((row) => row.player_id === home[1]).captain_points).toBeNull();
    const history = await sql(c, playerHistorySql, [league.id, home[0], 1, null, null]);
    expect(history.rows[0].points).toBe("8.00");
    await setAuthUid(c, userBId);
    const other = (await latest()).rows;
    expect(other.find((row) => row.player_id === home[1])).toMatchObject({ points: "8.00", captain_points: "16.00" });
    expect(other.find((row) => row.player_id === home[0]).captain_points).toBeNull();
    await setAuthUid(c, userCId);
    expect((await latest()).rows.every((row) => row.captain_points === null)).toBe(true);
    await correctScore(c, match, 2, 1, 3);
    await setAuthUid(c, userAId);
    expect((await latest()).rows.find((row) => row.player_id === home[0])).toMatchObject({ points: "4.00", captain_points: "8.00" });
  } finally { c.release(); }
});

it("deletes a populated league only for its confirmed creator, leaving profiles and other leagues intact", async () => {
  const c = await freshClient();
  try {
    const { league, match, home } = await recordedResultFixture(c);
    await setAuthUid(c, userAId);
    await sql(c, "SELECT public.save_fantasy_squad_v2($1,'1-2-1',$2,$3,null,$4)",
      [league.id, home[0], home[1], JSON.stringify(matchEntries(home.slice(0, 5), [home[6]]))]);
    await submitScore(c, match, 2, 0);
    await approveScore(c, match);
    const other = await releaseLeague(c, 7);
    const deleteLeague = (confirmation = "Release 5") => sql(c, "SELECT public.delete_owned_league($1,$2) AS deleted", [league.id, confirmation]);
    await expect(sql(c, "DELETE FROM leagues WHERE id=$1", [league.id])).rejects.toMatchObject({ code: "42501" });
    await sql(admin, "UPDATE league_members SET role='leader' WHERE profile_id=$1 AND league_id=$2", [userCId, league.id]);
    await setAuthUid(c, userCId);
    await expect(deleteLeague()).rejects.toMatchObject({ code: "42501" });
    await setAuthUid(c, userBId);
    await expect(deleteLeague()).rejects.toMatchObject({ code: "42501" });
    await setAuthUid(c, userAId);
    await expect(deleteLeague("release 5")).rejects.toMatchObject({ code: "22023" });
    expect((await sql(c, "SELECT id FROM real_matches WHERE id=$1", [match])).rowCount).toBe(1);
    expect((await deleteLeague()).rows).toEqual([{ deleted: league.id }]);
    for (const table of ["league_members", "teams", "players", "real_matches", "fantasy_squads", "player_match_points", "manager_points", "fantasy_points_history", "league_standings", "scoring_rules"]) {
      expect((await sql(admin, `SELECT 1 FROM ${table} WHERE league_id=$1`, [league.id])).rowCount).toBe(0);
    }
    expect((await sql(admin, "SELECT 1 FROM match_scoring_receipts WHERE match_id=$1", [match])).rowCount).toBe(0);
    expect((await sql(admin, "SELECT id FROM leagues WHERE id=$1", [other.id])).rows).toEqual([{ id: other.id }]);
    expect((await sql(admin, "SELECT id FROM profiles WHERE id=ANY($1)", [[userAId, userBId, userCId]])).rowCount).toBe(3);
  } finally { c.release(); }
});

it("stores a match's chosen duration atomically, rejects invalid values, and leaves legacy duration unknown", async () => {
  const c = await freshClient();
  try {
    const league = await releaseLeague(c, 5);
    const legacy = await league.makeMatch();
    const id60 = randomUUID(), id90 = randomUUID(), invalid = randomUUID();
    const create = (id: string, minutes: number) => sql(c,
      "SELECT public.create_real_match($1,$2,$3,$4,'Timed match',now(),null,$5) AS result",
      [id, league.id, league.home, league.away, minutes]);
    await expect(create(invalid, 0)).rejects.toMatchObject({ code: "22023" });
    await expect(create(invalid, 201)).rejects.toMatchObject({ code: "22023" });
    expect((await create(id60, 60)).rows[0].result).toMatchObject({ id: id60, duration_minutes: 60 });
    expect((await create(id60, 60)).rows[0].result.duration_minutes).toBe(60);
    await expect(create(id60, 90)).rejects.toMatchObject({ code: "40001" });
    await create(id90, 90);
    await setAuthUid(c, userBId);
    expect((await sql(c, "SELECT id,duration_minutes FROM real_matches WHERE league_id=$1", [league.id])).rows)
      .toEqual(expect.arrayContaining([{ id: legacy, duration_minutes: null }, { id: id60, duration_minutes: 60 }, { id: id90, duration_minutes: 90 }]));
    await expect(create(invalid, 60)).rejects.toMatchObject({ code: "42501" });
    expect((await sql(c, "SELECT id FROM real_matches WHERE id=$1", [invalid])).rowCount).toBe(0);
  } finally { c.release(); }
});

it("enforces the fantasy-only kickoff deadline with database time, honors rescheduling, and preserves squad rows", async () => {
  const c = await freshClient();
  try {
    const { league, match, home } = await recordedResultFixture(c);
    const save = (revision: string | null) => sql(c, "SELECT public.save_fantasy_squad_v2($1,'1-2-1',$2,$3,$4,$5) AS saved",
      [league.id, home[1], home[0], revision, JSON.stringify(matchEntries(home.slice(0, 5), [home[6]]))]);
    const deadline = async () => (await sql(c, "SELECT public.ff_squad_deadline($1) AS info", [league.id])).rows[0].info;
    await setAuthUid(c, userBId);
    const saved = (await save(null)).rows[0].saved;
    await setAuthUid(c, userCId);
    const edit = (kickOff: string, version: number) => sql(c, "SELECT public.edit_real_match_details($1,$2,$3) AS match", [match, version, JSON.stringify({ kickOff })]);
    const { rows: [clock] } = await sql(c, "SELECT (clock_timestamp()+interval '2 hours') AT TIME ZONE 'Africa/Cairo' AS local");
    const cairo = clock.local.toISOString().slice(0,-1) + "+02:00";
    await edit(cairo, 1);
    expect(Date.parse((await deadline()).kickOff)).toBe(Date.parse(cairo));
    expect(await deadline()).toMatchObject({ locked: false, matchId: match });
    await setAuthUid(c, userBId);
    const revised = (await save(saved.squad.updated_at)).rows[0].saved;
    await expect(persistLineup(c,match,league.home,matchEntries(home.slice(0, 5)))).rejects.toMatchObject({ code: "42501" });
    // At the cutoff, use the database's wall clock, not the caller's timezone or transaction start.
    await sql(admin, "UPDATE real_matches SET kick_off=clock_timestamp() WHERE id=$1", [match]);
    expect(await deadline()).toMatchObject({ locked: true, matchId: match });
    await expect(save(revised.squad.updated_at)).rejects.toThrow(/Squad Locked/);
    await expect(sql(c,"UPDATE fantasy_squad_players SET slot='reserve' WHERE squad_id=$1",[saved.squad.id])).rejects.toMatchObject({ code:"42501" });
    expect((await sql(c,"SELECT captain_id,vice_captain_id,formation FROM fantasy_squads WHERE id=$1",[saved.squad.id])).rows[0])
      .toEqual({ captain_id: home[1], vice_captain_id: home[0], formation: "1-2-1" });
    expect((await sql(c,"SELECT player_id,slot,\"order\" FROM fantasy_squad_players WHERE squad_id=$1",[saved.squad.id])).rows)
      .toEqual(expect.arrayContaining(matchEntries(home.slice(0,5),[home[6]])));
    await setAuthUid(c, userCId);
    await expect(edit(cairo, 2)).rejects.toThrow(/cannot change after/);
    expect(await deadline()).toMatchObject({locked:true, matchId:match});
    const next = await league.makeMatch();
    expect(await deadline()).toMatchObject({ locked: true, matchId: match });
    await submitScore(c,match,1,0,2);
    await approveScore(c,match,3);
    expect(await deadline()).toMatchObject({ locked: false, matchId: next });
  } finally { c.release(); }
});

it("persists authorized post-kickoff real lineups during and after review without rewriting the historical scoring basis", async () => {
  const c = await freshClient();
  try {
    const { league, match, home } = await recordedResultFixture(c);
    const statsRow = (count: number) => JSON.stringify([{playerId:home[1],saves:0,defensiveContributions:count}]);
    const original = matchEntries(home.slice(0,5),home.slice(5));
    const replacement = matchEntries([home[0], home[5], ...home.slice(2,5)], [home[6]]);
    await setAuthUid(c,userBId);
    await expect(persistLineup(c,match,league.home,replacement)).rejects.toMatchObject({code:"42501"});
    await sql(admin,"UPDATE real_matches SET kick_off=clock_timestamp() WHERE id=$1",[match]);
    await expect(persistLineup(c,match,league.home,replacement)).rejects.toMatchObject({code:"42501"});
    await setAuthUid(c,userCId);
    await persistLineup(c,match,league.home,replacement);
    await submitScore(c,match,1,1);
    await setAuthUid(c,userAId);
    await persistLineup(c,match,league.home,original);
    await expect(approveScore(c,match,2)).rejects.toThrow(/Match changed since you reviewed it/);
    await approveScore(c,match,3);
    const official = async () => (await sql(c,`SELECT player_id,points,breakdown FROM player_match_points
      WHERE match_id=$1 ORDER BY player_id`,[match])).rows;
    await sql(c,"SELECT save_match_statistics($1,4,$2,'Verified below threshold')",[match,statsRow(9)]);
    const before = await official();
    await setAuthUid(c,userCId);
    await persistLineup(c,match,league.home,replacement);
    const reader = await freshClient();
    try {
      await setAuthUid(reader,userBId);
      const persisted = (await sql(reader,`SELECT player_id,slot,"order" FROM match_lineups
        WHERE match_id=$1 AND team_id=$2 ORDER BY slot,"order"`,[match,league.home])).rows;
      expect(persisted).toEqual(replacement);
      expect((await sql(reader,"SELECT player_id,position,defensive_contributions FROM match_player_statistics WHERE match_id=$1",[match])).rows)
        .toEqual([{player_id:home[1],position:"DEF",defensive_contributions:9}]);
      await expect(persistLineup(reader,match,league.home,original)).rejects.toMatchObject({code:"42501"});
      await expect(sql(reader,"UPDATE finalized_match_lineups SET entries='[]' WHERE match_id=$1",[match])).rejects.toMatchObject({code:"42501"});
      const history = (player: string) => sql(reader,"SELECT participation,points,opponent_id FROM player_finalized_games_with_logos($1,$2,1)",[league.id,player]);
      expect((await history(home[1])).rows).toMatchObject([{participation:"played",points:"4.00",opponent_id:league.away}]);
      expect((await history(home[5])).rows).toMatchObject([{participation:"did_not_play",points:null}]);
      await setAuthUid(reader,null);
      expect((await sql(reader,"SELECT * FROM match_scoring_lineups WHERE match_id=$1",[match])).rowCount).toBe(0);
    } finally { reader.release(true); }
    expect(await official()).toEqual(before);
    // Correction still uses the frozen participant and registered position, not the replacement.
    await expect(sql(c,"SELECT save_match_statistics($1,5,$2,'Verified')",[match,JSON.stringify([{playerId:home[5],saves:0,defensiveContributions:10}])]))
      .rejects.toMatchObject({code:"22023"});
    await sql(c,"SELECT save_match_statistics($1,5,$2,'Verified')",[match,statsRow(10)]);
    const corrected = await official();
    expect(corrected.find((row) => row.player_id === home[5])).toBeUndefined();
    expect(corrected.find((row) => row.player_id === home[1])).toMatchObject({points:"6.00",breakdown: expect.arrayContaining([
      expect.objectContaining({category:"defensive_contributions",points:2}),expect.objectContaining({category:"match_bonus",points:3}),
    ])});
  } finally { c.release(); }
});

it("records a match event without a minute and leaves historical event minutes intact", async () => {
  const c = await freshClient();
  try {
    const {league,match,home} = await recordedResultFixture(c);
    const payload = {teamId:league.home,playerId:home[1],eventType:"goal"};
    const makeEvent = (data: object, id = randomUUID()) => sql(c,"SELECT write_match_event($1,$2,'event',$3) AS event",[match,id,JSON.stringify(data)]);
    await setAuthUid(c,userBId);
    await expect(makeEvent(payload)).rejects.toMatchObject({code:"42501"});
    await setAuthUid(c,userCId);
    const legacy = (await makeEvent({...payload,minute:27})).rows[0].event;
    const current = (await makeEvent(payload)).rows[0].event;
    expect((await makeEvent(payload,current.id)).rows[0].event).toEqual(current);
    expect((await sql(c,"SELECT id,minute FROM match_events WHERE match_id=$1",[match])).rows)
      .toEqual(expect.arrayContaining([{id:legacy.id,minute:27},{id:current.id,minute:null}]));
  } finally { c.release(); }
});

it("scores per-match thresholds and automatic tied bonus ranks through approval and atomic statistics correction", async () => {
  const c = await freshClient();
  try {
    const { league, match, home, away } = await recordedResultFixture(c);
    await setAuthUid(c,userAId);
    await sql(c, "SELECT public.save_fantasy_squad_v2($1,'1-2-1',$2,$3,null,$4)", [league.id, home[0], home[1], JSON.stringify(matchEntries(home.slice(0,5),[home[6]]))]);
    const second = await league.makeMatch();
    await persistLineup(c,second,league.home,matchEntries(home.slice(0,5),home.slice(5)));
    await persistLineup(c,second,league.away,matchEntries(away));
    await sql(admin,"UPDATE real_matches SET kick_off=clock_timestamp() WHERE id=ANY($1)",[[match,second]]);
    const stats = (saves: number, def: number, other: number) => [
      {playerId: home[0], saves, defensiveContributions: 120},
      ...[home[1],home[2],home[4]].map((playerId,i) => ({playerId,saves:0,defensiveContributions:i===0?def:other})),
    ];
    const save = (target: string, version: number, rows: unknown[], reason: string | null = null) => sql(c,
      "SELECT public.save_match_statistics($1,$2,$3,$4) AS result", [target,version,JSON.stringify(rows),reason]);
    await setAuthUid(c,userBId);
    await expect(save(match,1,stats(2,9,11))).rejects.toMatchObject({code:"42501"});
    await expect(sql(c,"UPDATE match_player_statistics SET saves=99 WHERE match_id=$1",[match])).rejects.toMatchObject({code:"42501"});
    await setAuthUid(c,userCId);
    await expect(sql(c,"SELECT public.save_match_statistics($1,1,'[]', $2, null)",[match,home.slice(0,3)])).rejects.toMatchObject({code:"42501"});
    await expect(sql(c,"SELECT public.ff_apply_match_bonus($1,$2,1)",[match,league.id])).rejects.toMatchObject({code:"42501"});
    const outsider = await league.makePlayer("DEF",league.home,"Not in lineup");
    for (const playerId of [home[5],outsider,randomUUID()]) {
      await expect(save(match,1,[{playerId,saves:0,defensiveContributions:10}])).rejects.toMatchObject({code:"22023"});
    }
    await expect(save(match,1,[...stats(2,9,11),...stats(2,9,11)])).rejects.toMatchObject({code:"22023"});
    await sql(admin,"UPDATE players SET position='MID' WHERE id=$1",[home[1]]);
    await sql(c,"SELECT public.write_match_event($1,$2,'substitution',$3)",[match,randomUUID(),
      JSON.stringify({teamId:league.home,playerId:home[5],otherId:home[1],minute:25})]);
    const viaRoute = async (version: number, rows: unknown[], reason?: string, identity = userCId) => {
      transport.client = {
        auth: {getUser: async () => ({data:{user:{id:identity}},error:null})},
        from: (table: string) => {
          const keys: Record<string,string> = {};
          return {
            select() { return this; },
            eq(column: string, value: string) { keys[column] = value; return this; },
            async maybeSingle() {
              const result = table === "real_matches" ? await sql(c,"SELECT * FROM real_matches WHERE id=$1",[keys.id])
                : await sql(c,`SELECT m.role,to_jsonb(l) AS leagues FROM league_members m JOIN leagues l ON l.id=m.league_id
                  WHERE m.league_id=$1 AND m.profile_id=$2`,[keys.league_id,keys.profile_id]);
              return {data:result.rows[0] ?? null,error:null};
            },
          };
        },
        rpc: async (name: string, args: {p_match: string; p_version: number; p_stats: unknown[]; p_reason: string | null}) => {
          expect(name).toBe("save_match_statistics");
          return {data:(await save(args.p_match,args.p_version,args.p_stats,args.p_reason)).rows[0].result,error:null};
        },
      };
      try {
        const response = await saveStatisticsRoute(new NextRequest(`http://local.test/api/matches/${match}/statistics`, {
          method:"PUT", body:JSON.stringify({version,stats:rows,reason}),
        }), {params:Promise.resolve({id:match})});
        return {status:response.status,body:await response.json()};
      } finally { transport.client = null; }
    };
    await setAuthUid(c,userBId);
    expect((await viaRoute(1,stats(2,9,11),undefined,userBId)).status).toBe(403);
    await setAuthUid(c,userCId);
    expect(await viaRoute(1,stats(2,9,11))).toMatchObject({status:200,body:{matchId:match,version:2}});
    expect((await sql(c,"SELECT player_id,position,saves,defensive_contributions FROM match_player_statistics WHERE match_id=$1",[match])).rows)
      .toEqual(expect.arrayContaining([{player_id:home[0],position:"GK",saves:2,defensive_contributions:120},
        {player_id:home[1],position:"DEF",saves:0,defensive_contributions:9},{player_id:home[2],position:"MID",saves:0,defensive_contributions:11},
        {player_id:home[4],position:"FWD",saves:0,defensive_contributions:11}]));
    // Changing the order keeps the submitted statistics and captured positions; moving
    // a player with saved stats out of actual participation requires clearing their stats first.
    await expect(persistLineup(c,match,league.home,matchEntries([home[0],home[5],...home.slice(2,5)],[home[6]])))
      .rejects.toThrow(/recorded events or substitutions/);
    await expect(persistLineup(c,match,league.home,matchEntries([home[0],home[1],home[5],home[3],home[4]],[home[6]])))
      .rejects.toThrow(/Clear the saved statistics/);
    await persistLineup(c,match,league.home,matchEntries([home[0],home[2],home[1],home[3],home[4]],home.slice(5)));
    expect((await sql(c,"SELECT position,defensive_contributions FROM match_player_statistics WHERE match_id=$1 AND player_id=$2",[match,home[1]])).rows)
      .toEqual([{position:"DEF",defensive_contributions:9}]);
    await save(second,1,stats(2,9,11));
    await submitScore(c,match,1,1,2);
    await expect(save(match,3,stats(9,10,12))).rejects.toThrow(/locked during review/);
    await approveScore(c,match,3);
    await submitScore(c,second,1,1,2);
    await approveScore(c,second,3);
    const ledger = async (id: string) => (await sql(c,"SELECT player_id,points,breakdown FROM player_match_points WHERE match_id=$1",[id])).rows;
    const lines = (row: {breakdown:{category:string;points:number;rank?:number}[]}) => row.breakdown.filter((x) => x.category !== "appearance");
    const before = await ledger(match);
    expect(before).toHaveLength(11);
    expect(before.some((r) => r.player_id === home[6])).toBe(false);
    expect(before.every((r) => r.points === "4.00" && lines(r).length === 1 && lines(r)[0].rank === 1)).toBe(true);
    const otherMatch = await ledger(second);
    expect(otherMatch).toHaveLength(10);
    expect(otherMatch.every((r) => basePoints(r) === 1)).toBe(true); // No cross-match accumulation.
    const latestPlayed = async (player: string) => (await sql(c,"SELECT * FROM latest_squad_scored_matches($1,$2)",[league.id,[player]])).rows;
    expect(await latestPlayed(home[5])).toMatchObject([{match_id:match,title:"Release match",points:"4.00",kick_off:expect.any(Date)}]);
    expect(await latestPlayed(home[6])).toEqual([]);
    await setAuthUid(c,null);
    expect(await latestPlayed(home[5])).toEqual([]);
    await setAuthUid(c,userCId);
    const totals = async () => (await sql(c,"SELECT points FROM manager_points WHERE match_id=$1 AND profile_id=$2",[match,userAId])).rows[0];
    let version = 4;
    for (const [saves,points,keeperRank,otherRank,total] of [[3,1,null,1,23],[5,1,null,1,23],[6,2,1,1,31],[9,3,1,2,30]] as const) {
      expect((await viaRoute(version++,stats(saves,10,12),"Verified stats")).status).toBe(200);
      const rows = await ledger(match);
      const keeper = rows.find((r) => r.player_id === home[0]);
      expect(lines(keeper).find((r) => r.category === "goalkeeper_saves")?.points).toBe(points);
      expect(lines(keeper).some((r) => r.category === "defensive_contributions")).toBe(false);
      const awards = (r: typeof keeper) => lines(r).filter((x) => x.category === "match_bonus");
      if (keeperRank === null) expect(awards(keeper)).toEqual([]);
      else expect(awards(keeper)).toMatchObject([{rank:keeperRank,points:4-keeperRank}]);
      for (const playerId of [home[1],home[2],home[4]]) {
        const row = rows.find((r) => r.player_id === playerId);
        expect(lines(row).find((r) => r.category === "defensive_contributions")?.points).toBe(2);
        expect(awards(row)).toMatchObject([{rank:otherRank,points:4-otherRank}]);
      }
      expect(Number((await totals()).points)).toBe(total);
    }
    const final = (await ledger(match)).sort((a,b) => a.player_id.localeCompare(b.player_id));
    expect((await viaRoute(version++,stats(9,10,12),"Repeated verified stats")).status).toBe(200);
    expect((await ledger(match)).sort((a,b) => a.player_id.localeCompare(b.player_id))).toEqual(final);
    await expect(save(match,version-1,stats(2,9,11),"Stale write")).rejects.toMatchObject({code:"40001"});
    expect(await ledger(second)).toEqual(otherMatch);
    expect((await sql(c,"SELECT points FROM fantasy_points_history WHERE match_id=$1 AND profile_id=$2",[match,userAId])).rows[0]).toEqual(await totals());
    const standings = await sql(c,"SELECT total_points FROM league_standings WHERE league_id=$1 AND profile_id=$2",[league.id,userAId]);
    const aggregate = await sql(c,"SELECT sum(points) AS total FROM manager_points WHERE league_id=$1 AND profile_id=$2",[league.id,userAId]);
    expect(Number(standings.rows[0].total_points)).toBe(Number(aggregate.rows[0].total));
    await sql(admin,"UPDATE teams SET crest_url='https://example.test/opponent.webp' WHERE id=$1",[league.away]);
    const history = await sql(c,"SELECT * FROM public.player_finalized_games_with_logos($1,$2,2)",[league.id,home[0]]);
    expect(history.rows).toHaveLength(2);
    expect(history.rows.every((r) => r.opponent_id===league.away && r.opponent_crest==="https://example.test/opponent.webp")).toBe(true);
  } finally { c.release(); }
});

it("scopes private team logo objects to league roles and protects the linked reference", async () => {
  const c = await freshClient();
  try {
    const { id,home,away } = await releaseLeague(c,5);
    const key = () => `${id}/${home}/${randomUUID()}.webp`;
    const [first,next] = [key(),key()];
    const add = (path: string) => sql(c,"INSERT INTO storage.objects(bucket_id,name) VALUES('team-logos',$1)",[path]);
    const read = () => sql(c,"SELECT name FROM storage.objects WHERE bucket_id='team-logos' AND name=ANY($1)",[[first,next]]);
    const link = (path: string | null,team=home) => sql(c,"UPDATE teams SET crest_url=$2 WHERE id=$1",[team,path && `team-logos/${path}`]);
    const remove = (path: string) => sql(c,"DELETE FROM storage.objects WHERE bucket_id='team-logos' AND name=$1",[path]);
    await add(first); await add(next);
    await expect(link(first,away)).rejects.toMatchObject({code:"22023"});
    await link(first);
    expect((await remove(first)).rowCount).toBe(0);
    await setAuthUid(c,userBId);
    expect((await link(null)).rowCount).toBe(0);
    await expect(add(key())).rejects.toMatchObject({code:"42501"});
    expect((await read()).rows).toEqual([{name:first}]);
    await setAuthUid(c,null);
    expect((await read()).rowCount).toBe(0);
    await setAuthUid(c,userAId);
    await link(next);
    expect((await remove(first)).rowCount).toBe(1);
    expect((await sql(c,"SELECT crest_url FROM teams WHERE id=$1",[home])).rows[0].crest_url).toBe(`team-logos/${next}`);
    await link(null);
    expect((await remove(next)).rowCount).toBe(1);
  } finally { c.release(); }
});

it("initializes Google profiles from the trusted provider and preserves custom and email names", async () => {
  const ids = Array.from({length:4},()=>randomUUID());
  const make = (id: string, provider: string, meta: unknown) => sql(admin,
    "INSERT INTO auth.users(id,email,raw_app_meta_data,raw_user_meta_data,email_confirmed_at) VALUES($1,$2,$3,$4,now())",
    [id,`${id}@example.test`,JSON.stringify({provider}),JSON.stringify(meta)]);
  await make(ids[0],"google",{full_name:"  Provided Full Name  ",name:"Second Choice"});
  await make(ids[1],"google",{full_name:"\t ",name:"Short Name"});
  await make(ids[2],"google",{full_name:{unexpected:1}});
  await make(ids[3],"email",{display_name:"Chosen on Signup",username:"email_member",full_name:"Ignore Me"});
  const names = async () => (await sql(admin,"SELECT display_name FROM profiles WHERE id=ANY($1) ORDER BY array_position($1,id)",[ids])).rows.map((r) => r.display_name);
  expect(await names()).toEqual(["Provided Full Name","Short Name",`user_${ids[2].replaceAll("-","").slice(0,10)}`,"Chosen on Signup"]);
  const c = await freshClient();
  try { await setAuthUid(c,ids[0]); await sql(c,"UPDATE profiles SET display_name='My Custom Name' WHERE id=$1",[ids[0]]); }
  finally { c.release(); }
  await sql(admin,"UPDATE auth.users SET raw_user_meta_data='{\"full_name\":\"Changed Google Name\"}',email=$2 WHERE id=$1",[ids[0],`updated-${ids[0]}@example.test`]);
  expect((await names())[0]).toBe("My Custom Name");
});

it("awards competition ranks per match and reranks on a score correction without carrying old bonus points forward", async () => {
  const c = await freshClient();
  try {
    const { league, match, home, away } = await recordedResultFixture(c);
    for (const [teamId, playerId] of [[league.home, home[2]], [league.home, home[4]], [league.away, away[2]]]) {
      await sql(c,"SELECT public.write_match_event($1,$2,'event',$3)",[match,randomUUID(),JSON.stringify({teamId,playerId,eventType:"goal",minute:25})]);
    }
    // An in-progress match created before the migration can have manual metadata.
    await sql(admin,"INSERT INTO match_player_statistics(match_id,player_id,position,bonus_rank) VALUES($1,$2,'MID',1)",[match,home[3]]);
    const awards = async () => (await sql(c,`SELECT player_id AS player,(line->>'rank')::int AS rank,(line->>'points')::int AS points
      FROM player_match_points CROSS JOIN LATERAL jsonb_array_elements(breakdown) AS line
      WHERE match_id=$1 AND line->>'category'='match_bonus' ORDER BY player_id`,[match])).rows;
    await submitScore(c,match,2,1);
    expect(await awards()).toEqual([]);
    await approveScore(c,match);
    const first = await awards();
    expect(first).toHaveLength(3);
    expect(first).toEqual(expect.arrayContaining([
      {player:home[2],rank:1,points:3},{player:away[2],rank:1,points:3},{player:home[4],rank:3,points:1},
    ]));
    await approveScore(c,match);
    expect(await awards()).toEqual(first);
    await correctScore(c,match,2,0,3);
    const revised = await awards();
    expect(revised).toHaveLength(5);
    expect(revised).toEqual(expect.arrayContaining([
      {player:home[2],rank:1,points:3},{player:away[2],rank:2,points:2},
      ...[home[0],home[1],home[4]].map((player) => ({player,rank:3,points:1})),
    ]));
    await correctScore(c,match,2,0,3);
    expect(await awards()).toEqual(revised);
    // Migrated manual metadata is neither counted nor rewritten by scoring.
    expect((await sql(c,"SELECT player_id,bonus_rank FROM match_player_statistics WHERE match_id=$1",[match])).rows)
      .toEqual([{player_id:home[3],bonus_rank:1}]);
  } finally { c.release(); }
});
