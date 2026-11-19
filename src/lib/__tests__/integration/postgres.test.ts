import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

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

  await sql(admin, `DROP TRIGGER IF EXISTS on_auth_user_created_ff ON auth.users`);

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
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now();
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
      "match_lineups","match_events","match_substitutions","match_approvals",
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
      expect(rules.length).toBe(0);
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

    const cC = await freshClient();
    try {
      await setAuthUid(cC, userCId);
      const { rows: squads } = await sql(cC, `INSERT INTO public.fantasy_squads (id, league_id, profile_id, formation, created_at, updated_at) VALUES (gen_random_uuid()::text, $1, $2, '4-4-2', now(), now()) RETURNING id`, [leagueAId, userCId]);
      const squadId = squads[0].id;

      const { rows: players } = await sql(admin, `SELECT id FROM public.players WHERE league_id = $1 LIMIT 7`, [leagueAId]);
      const slots = ['starter','starter','starter','starter','starter','sub','sub'];
      for (let i = 0; i < players.length; i++) {
        await sql(cC, `INSERT INTO public.fantasy_squad_players (id, squad_id, player_id, slot, "order", created_at) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, now())`, [squadId, players[i].id, slots[i], i]);
      }

      const { rows: sp } = await sql(cC, `SELECT * FROM public.fantasy_squad_players WHERE squad_id = $1`, [squadId]);
      expect(sp.length).toBe(7);
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


      await sql(cA, `INSERT INTO public.match_lineups (id, match_id, league_id, team_id, player_id, slot, "order", created_at) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'starter', 1, now()), (gen_random_uuid()::text, $1, $2, $3, $5, 'starter', 2, now())`, [matchId, leagueAId, taId, players[0].id, players[1].id]);

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
        const entries = team === match.team_a_id ? events.map((e) => ({ player_id: e.player_id, slot: "starter", order: 0 })) : [];
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
      await sql(cA, "SELECT public.submit_match($1)", [matchId]);
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

  it("replaces squad entries atomically and leaves the old squad unchanged on failure", async () => {
    const c = await freshClient();
    try {
      await setAuthUid(c, userAId);
      const { rows: [p] } = await sql(c, "SELECT id FROM players WHERE league_id=$1 LIMIT 1", [leagueAId]);
      const save = "SELECT public.save_fantasy_squad($1,'1-2-1',null,null,false,$2) AS result";
      const entry = { player_id: p.id, slot: "starter", order: 0 };
      const { rows: [saved] } = await sql(c, save, [leagueAId, JSON.stringify([entry])]);
      expect(saved.result.entries).toHaveLength(1);
      expect(saved.result.entries[0]).toMatchObject(entry);
      await expect(sql(c, save, [leagueAId, JSON.stringify([entry, entry])])).rejects.toMatchObject({ code: "23505" });
      const entries = await sql(c, "SELECT player_id,slot,\"order\" FROM fantasy_squad_players WHERE squad_id=$1", [saved.result.squadId]);
      expect(entries.rows).toEqual([entry]);
      await setAuthUid(c, randomUUID());
      await expect(sql(c, save, [leagueAId, JSON.stringify([entry])])).rejects.toMatchObject({ code: "42501" });
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
      await sql(c, "SELECT public.create_real_match($1,$2,$3,$4,'Organizer draft',now(),null)", [id, leagueAId, teams[0].id, teams[1].id]);
      await setAuthUid(c, userAId);
      const playerId = randomUUID();
      await sql(c, "INSERT INTO players(id,league_id,team_id,full_name,position,created_by) VALUES($1,$2,$3,'Event scorer','MID',$4)",
        [playerId, leagueAId, teams[0].id, userAId]);
      await sql(c, "SELECT * FROM public.replace_match_lineup($1,$2,$3)", [id, teams[0].id, JSON.stringify([{ player_id: playerId, slot: "starter", order: 0 }])]);
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
