import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Static verification of the Supabase security migrations.
 *
 * The destructive rebuild (0000) requires explicit approval before it may be
 * applied, so these tests assert the policies that WILL be applied rather
 * than executing anything destructive against a live project.
 */
const dir = join(process.cwd(), "supabase", "migrations");
const rls = readFileSync(join(dir, "0002_rls.sql"), "utf8");
const fns = readFileSync(join(dir, "0003_functions.sql"), "utf8");
const schema = readFileSync(join(dir, "0001_schema.sql"), "utf8");
const destructive = readFileSync(
  join(dir, "..", "legacy", "0000_destructive_removal.sql"),
  "utf8"
);
const matchFlow = readFileSync(join(process.cwd(), "src", "app", "api", "matches", "[id]", "flow", "route.ts"), "utf8");
const matchPage = readFileSync(join(process.cwd(), "src", "app", "(app)", "matches", "[id]", "page.tsx"), "utf8");
const membersPage = readFileSync(join(process.cwd(), "src", "app", "(app)", "members", "page.tsx"), "utf8");
const leagueRoute = readFileSync(join(process.cwd(), "src", "app", "api", "leagues", "[id]", "route.ts"), "utf8");
const PROTECTED_TABLES = [
  "profiles",
  "sessions",
  "auth_tokens",
  "leagues",
  "league_members",
  "invitations",
  "teams",
  "players",
  "fantasy_squads",
  "fantasy_squad_players",
  "fantasy_fixtures",
  "real_matches",
  "match_lineups",
  "match_events",
  "match_substitutions",
  "match_approvals",
  "scoring_rules",
  "player_match_points",
  "manager_points",
  "league_standings",
  "fantasy_points_history",
  "notifications",
  "league_activity",
  "audit_logs",
  "mutation_ops",
];

describe("schema migration", () => {
  it("creates every table the application depends on", () => {
    for (const table of PROTECTED_TABLES) {
      expect(schema, `missing table ${table}`).toMatch(
        new RegExp(`CREATE TABLE "${table}"`, "i"),
      );
    }
  });

  it("enforces league scope on the player database", () => {
    expect(schema).toMatch(/CREATE TABLE "players"/);
    const playersBlock = schema.slice(schema.indexOf('CREATE TABLE "players"'));
    const nextTable = playersBlock.indexOf("CREATE TABLE", 1);
    const block = playersBlock.slice(0, nextTable === -1 ? undefined : nextTable);
    expect(block).toMatch(/"league_id" text NOT NULL/);
    // Drizzle emits foreign keys as trailing ALTER TABLE statements
    expect(schema).toMatch(
      /ALTER TABLE "players" ADD CONSTRAINT "players_league_id_leagues_id_fk" FOREIGN KEY \("league_id"\) REFERENCES "public"\."leagues"\("id"\)/,
    );
    expect(schema).toMatch(/ON DELETE cascade/);
  });

  it("declares the format constraints", () => {
    expect(schema).toMatch(/leagues_format_ck/);
    expect(schema).toMatch(/players_position_ck/);
    expect(schema).toMatch(/lineup_slot_ck/);
  });
});

describe("row level security", () => {
  it("enables RLS on every application table", () => {
    const block = rls.slice(rls.indexOf("foreach t in array array["), rls.indexOf("end loop;"));
    for (const table of PROTECTED_TABLES) {
      expect(block, `RLS not enabled for ${table}`).toContain(`'${table}'`);
    }
  });

  it("scopes league reads to members", () => {
    expect(rls).toMatch(/create policy leagues_select[\s\S]*?public\.is_member\(id\)/);
    expect(rls).toMatch(/create policy players_select[\s\S]*?public\.is_member\(league_id\)/);
    expect(rls).toMatch(/create policy matches_select[\s\S]*?public\.is_member\(league_id\)/);
  });

  it("restricts writes to the owning role", () => {
    expect(rls).toMatch(/create policy leagues_update[\s\S]*?public\.is_leader\(id\)/);
    expect(rls).toMatch(/create policy rules_write[\s\S]*?public\.is_leader\(league_id\)/);
    expect(rls).toMatch(/create policy squads_update[\s\S]*?profile_id = auth\.uid\(\)/);
    expect(rls).toMatch(/create policy events_write[\s\S]*?public\.is_match_organizer\(match_id\)/);
    expect(rls).toMatch(/create policy approvals_insert[\s\S]*?actor_id = auth\.uid\(\)/);
    const approvalsPolicy = rls.slice(rls.indexOf("create policy approvals_insert"), rls.indexOf("-- scoring rules"));
    expect(approvalsPolicy).toMatch(/public\.is_leader\(r\.league_id\)/);
    expect(approvalsPolicy).not.toMatch(/allow_self_approval/);
  });

  it("blocks clients from writing points, standings or history directly", () => {
    expect(rls).toMatch(/create policy pmp_insert[\s\S]*?with check \(false\)/);
    expect(rls).toMatch(/create policy mp_insert[\s\S]*?with check \(false\)/);
    expect(rls).toMatch(/create policy standings_insert[\s\S]*?with check \(false\)/);
    expect(rls).toMatch(/create policy history_insert[\s\S]*?with check \(false\)/);
  });

  it("never opens a table to everyone", () => {
    expect(rls).not.toMatch(/using\s*\(\s*true\s*\)/i);
    expect(rls).not.toMatch(/for all to public/i);
  });

  it("keeps notification rows private to their owner", () => {
    expect(rls).toMatch(/create policy notifications_select[\s\S]*?profile_id = auth\.uid\(\)/);
    expect(rls).toMatch(/create policy notifications_delete[\s\S]*?profile_id = auth\.uid\(\)/);
  });
});

describe("privileged functions", () => {
  it("authorize from the authenticated identity only", () => {
    expect(fns).not.toMatch(/auth\.jwt\(\)/i);
    expect(fns).not.toMatch(/current_setting\('request\.jwt\.claims'/i);
    expect(fns).toMatch(/security definer/);
    expect(fns).toMatch(/public\.is_leader\(/);
    expect(fns).toMatch(/public\.is_match_organizer\(/);
  });

  it("implements the approval state machine with guards", () => {
    expect(fns).toMatch(/function public\.approve_match/);
    expect(fns).toMatch(/Only the League Leader or Match Organizer can approve results/);
    expect(fns).not.toMatch(/You cannot approve your own submission/);
    expect(fns).toMatch(/may approve even when they submitted/i);
    expect(matchFlow).not.toMatch(/allowSelfApproval/);
    expect(matchFlow).toMatch(/rpc\("submit_match"/);
    expect(matchFlow).toMatch(/rpc\("approve_match"/);
    expect(matchFlow).toMatch(/rpc\("reject_match"/);
    expect(matchFlow).toMatch(/p_version: version \?\? match.version/);
    expect(matchFlow).not.toMatch(/\.from\("(?:real_matches|match_approvals)"\)\s*\.(?:update|insert)/);
    expect(fns).toMatch(/Match changed since you reviewed it/);
    expect(fns).toMatch(/function public\.reject_match/);
    expect(fns).toMatch(/A rejection reason is required/);
  });

  it("keeps League Leader self-approval enabled consistently in the UI and API", () => {
    expect(matchPage).toMatch(/data\.canApprove && m\.status === "pending"/);
    expect(matchPage).not.toMatch(/allowSelfApproval|cannot approve their own submission/i);
    expect(membersPage).not.toMatch(/allowSelfApproval|Self-approval/i);
    expect(leagueRoute).not.toMatch(/allowSelfApproval/);
  });

  it("increments the match version on submit, approve and reject", () => {
    const approve = fns.slice(fns.indexOf("function public.approve_match"), fns.indexOf("function public.reject_match"));
    const reject = fns.slice(fns.indexOf("function public.reject_match"), fns.indexOf("function public.submit_match"));
    const submit = fns.slice(fns.indexOf("function public.submit_match"), fns.indexOf("function public.build_match_state"));
    expect(approve).toMatch(/version\s*=\s*version\s*\+\s*1/i);
    expect(reject).toMatch(/version\s*=\s*version\s*\+\s*1/i);
    expect(submit).toMatch(/version\s*=\s*version\s*\+\s*1/i);
    expect(approve).toMatch(/v\.version\s*\+\s*1/);
    expect(reject).toMatch(/v\.version\s*\+\s*1/);
    expect(submit).toMatch(/v\.version\s*\+\s*1/);
  });

  it("validates lineups against the league format before submission", () => {
    expect(fns).toMatch(/Each team must field exactly % starters/);
    expect(fns).toMatch(/exactly one goalkeeper/);
    expect(fns).toMatch(/All scoring rules must be approved before submitting/);
  });

  it("produces points idempotently and rebuilds standings", () => {
    expect(fns).toMatch(/on conflict \(match_id, player_id\) do update/i);
    expect(fns).toMatch(/on conflict \(match_id, profile_id\) do update/i);
    expect(fns).toMatch(/function public\.recalculate_standings/);
    expect(fns).toMatch(/prev_rank\s*=\s*league_standings\.rank/);
  });

  it("prevents privilege escalation through role changes", () => {
    expect(fns).toMatch(/function public\.prevent_self_promotion/);
    expect(fns).toMatch(/You cannot change your own role/);
    expect(fns).toMatch(/function public\.set_member_role/);
    expect(fns).toMatch(/Only a League Leader can change roles/);
  });
});

describe("destructive migration safety", () => {
  it("is clearly marked as approval-gated", () => {
    expect(destructive).toMatch(/DO NOT RUN WITHOUT EXPLICIT WRITTEN APPROVAL/);
    expect(destructive).toMatch(/EXPLICIT APPROVAL/i);
  });

  it("never touches auth, storage or other Supabase infrastructure", () => {
    expect(destructive).not.toMatch(/drop\s+schema\s+auth/i);
    expect(destructive).not.toMatch(/drop\s+schema\s+storage/i);
    expect(destructive).not.toMatch(/drop\s+table\s+if\s+exists\s+auth\./i);
    expect(destructive).not.toMatch(/drop\s+table\s+if\s+exists\s+storage\./i);
    expect(destructive).toMatch(/auth\.users, storage\.objects/);
  });

  it("only drops objects guarded by IF EXISTS", () => {
    const drops = destructive.match(/^\s*drop\s+.*$/gim) ?? [];
    expect(drops.length).toBeGreaterThan(0);
    for (const statement of drops) {
      expect(statement.toLowerCase()).toMatch(/if exists/);
    }
  });
});
