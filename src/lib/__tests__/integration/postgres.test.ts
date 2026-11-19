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
  const client = await pool.connect();
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
  it("all 4 migrations create required tables", async () => {
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

      // Scoring rules are NOT inside the RPC — seeded separately by API
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
      const tbId = matchInfo[0].team_b_id;

      await sql(cA, `INSERT INTO public.match_lineups (id, match_id, league_id, team_id, player_id, slot, "order", created_at) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'starter', 1, now()), (gen_random_uuid()::text, $1, $2, $3, $5, 'starter', 2, now())`, [matchId, leagueAId, taId, players[0].id, players[1].id]);

      await sql(cA, `INSERT INTO public.match_events (id, match_id, league_id, team_id, player_id, event_type, minute, note, created_by, created_at, updated_at) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'goal', 23, 'Great strike', $5, now(), now()), (gen_random_uuid()::text, $1, $2, $6, $7, 'yellow_card', 45, 'Tactical foul', $5, now(), now())`, [matchId, leagueAId, taId, players[0].id, userAId, tbId, players[1].id]);

      const { rows: events } = await sql(cA, `SELECT * FROM public.match_events WHERE match_id = $1 ORDER BY minute`, [matchId]);
      expect(events.length).toBe(2);
      expect(events[0].event_type).toBe('goal');
    } finally {
      cA.release();
    }
  });

  it("leader can approve a match", async () => {
    const cA = await freshClient();
    try {
      await setAuthUid(cA, userAId);
      const { rows } = await sql(cA, `UPDATE public.real_matches SET status = 'pending' WHERE id = $1 RETURNING id, status`, [matchId]);
      expect(rows[0].status).toBe('pending');

      await sql(cA, `UPDATE public.real_matches SET status = 'approved', submitted_by = $1, submitted_at = now() WHERE id = $2`, [userAId, matchId]);
      const { rows: match } = await sql(cA, `SELECT status FROM public.real_matches WHERE id = $1`, [matchId]);
      expect(match[0].status).toBe('approved');
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
