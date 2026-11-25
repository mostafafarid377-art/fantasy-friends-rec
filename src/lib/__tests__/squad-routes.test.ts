import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT } from "@/app/api/leagues/[id]/squad/route";
import { PATCH as renameTeam } from "@/app/api/leagues/[id]/teams/[teamId]/route";

const db = vi.hoisted(() => ({ getUser: vi.fn(), from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/db", () => ({ getSupabase: async () => ({ ...db, auth: { getUser: db.getUser } }) }));
const ctx = { params: Promise.resolve({ id: "league-a" }) };
const keeper = { id: "keeper", position: "GK", full_name: "Morning Keeper", status: "active" };
const defender = { id: "defender", position: "DEF", full_name: "Morning Defender", status: "active" };
const revision = "2026-11-19T11:12:13.012341+00:00";
const input = { formation: "1-2-1", captainId: keeper.id, viceCaptainId: null, expectedUpdatedAt: null,
  entries: [{ playerId: keeper.id, slot: "starter", order: 0 }] };
const request = (method = "GET", body?: unknown) => new NextRequest("http://local.test/api/leagues/league-a/squad", {
  method, body: body === undefined ? undefined : JSON.stringify(body),
});
const receipt = { squad: { id: "squad-a", league_id: "league-a", profile_id: "me", formation: "1-2-1",
  captain_id: "keeper", vice_captain_id: null, completed_at: null, updated_at: revision },
  entries: [{ id: "entry-a", player_id: "keeper", squad_id: "squad-a", slot: "starter", order: 0 }] };
const filters = vi.fn();
const membership = { role: "manager", leagues: { id: "league-a", format: "5v5", starters: 5, squad_size: 8, subs_count: 2, vice_policy: "auto_captain" } };
function query(data: unknown, table: string) {
  return { select() { return this; }, eq(...args: unknown[]) { filters(table, ...args); return this; },
    in(...args: unknown[]) { filters(table, ...args); return { data, error: null }; }, maybeSingle: () => ({ data, error: null }) };
}
let membershipRow: unknown, players: unknown, squad: unknown, lastGame: unknown;
beforeEach(() => {
  vi.resetAllMocks();
  membershipRow = membership;
  players = [keeper];
  squad = null;
  lastGame = [];
  db.getUser.mockResolvedValue({ data: { user: { id: "me" } }, error: null });
  db.from.mockImplementation((table: string) => query(({ league_members: membershipRow, players, fantasy_squads: squad, real_matches: { kick_off: revision } } as Record<string, unknown>)[table], table));
  db.rpc.mockImplementation(async (name) => ({ data: name === "last_game_points" ? lastGame : ["recent_fantasy_substitutions", "ff_my_live_match_points"].includes(name) ? [] : name === "ff_squad_deadline" ? { locked: false, kickOff: null, matchId: null, title: null, serverNow: revision } : receipt, error: null }));
});

describe("league squad route", () => {
  it("reads only this member's squad and never creates one on an empty GET", async () => {
    const res = await GET(request(), ctx);
    expect(await res.json()).toMatchObject({ squad: null, players: [], lastMatch: null, rules: { squadSize: 8, subsCount: 2 } });
    expect(filters).toHaveBeenCalledWith("fantasy_squads", "league_id", "league-a");
    expect(filters).toHaveBeenCalledWith("fantasy_squads", "profile_id", "me");
    expect(db.rpc).toHaveBeenCalledWith("recent_fantasy_substitutions", { p_league: "league-a" });
    expect(db.rpc).toHaveBeenCalledWith("ff_squad_deadline", { p_league: "league-a" });
  });

  it("loads the official team total and the date of that exact match, preserving zero and unscored results", async () => {
    for (const [stored, points] of [["27.50", 27.5], ["0.00", 0], [null, null]]) {
      lastGame = [{ matchId: "match-a", title: "Cup final", kickOff: revision, points: stored }];
      const res = await GET(request(), ctx);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect((await res.json()).lastMatch).toEqual({matchId:"match-a", title:"Cup final", kickOff:revision, points});
    }
    expect(db.rpc).toHaveBeenCalledWith("last_game_points", {p_league:"league-a"});
    // The kickoff travels with the points, so the match is never looked up again.
    expect(filters).not.toHaveBeenCalledWith("real_matches", "id", "match-a");
  });

  it("returns a kept draft and its full-precision revision from the same read", async () => {
    squad = { ...receipt.squad, fantasy_squad_players: [{ ...receipt.entries[0], players: keeper }] };
    const res = await GET(request(), ctx);
    expect(await res.json()).toMatchObject({ squad: { id: "squad-a", updatedAt: revision }, players: [{ id: keeper.id, position: "GK" }] });
  });

  it("denies signed-out and non-member requests before any squad write", async () => {
    membershipRow = null;
    expect((await PUT(request("PUT", input), ctx)).status).toBe(403);
    db.getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await GET(request(), ctx)).status).toBe(401);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("rejects a complete squad that is missing an outfield position and names them together", async () => {
    // The mock league is 5v5 with squad_size 8 (5 starters, 2 subs, 1 reserve).
    // Each scenario builds a full 8-player squad whose starting lineup lacks
    // one line; the first scenario keeps a Forward on the bench to prove only
    // starters count.
    const full_name = "Player";
    const fill = (position: string, prefix: string, n: number) =>
      [...Array(n).keys()].map((i) => ({ id: `${prefix}-${i}`, position, full_name, status: "active" }));
    const scenarios: { rows: { id: string; position: string; full_name: string; status: string }[]; missing: string; formation: string; starterIds: string[]; benchOutfield?: string }[] = [
      // No Forward in the starting XI — but one sits on the bench. Only
      // starters count, so this must still be rejected. Formation 1-3-0.
      { rows: [keeper, { id: "keeper-2", position: "GK", full_name, status: "active" }, ...fill("DEF", "d", 2), ...fill("MID", "m", 3), ...fill("FWD", "f", 1)],
        missing: "Forward", formation: "1-3-0", starterIds: ["keeper", "d-0", "m-0", "m-1", "m-2"], benchOutfield: "f-0" },
      // 2 GK + 2 DEF + 4 FWD, no Midfielder anywhere; formation 2-0-2.
      { rows: [keeper, { id: "keeper-2", position: "GK", full_name, status: "active" }, ...fill("DEF", "d", 2), ...fill("FWD", "f", 4)],
        missing: "Midfielder", formation: "2-0-2", starterIds: ["keeper", "d-0", "d-1", "f-0", "f-1"] },
      // 2 GK + 4 MID + 2 FWD, no Defender anywhere; formation 0-2-2.
      { rows: [keeper, { id: "keeper-2", position: "GK", full_name, status: "active" }, ...fill("MID", "m", 4), ...fill("FWD", "f", 2)],
        missing: "Defender", formation: "0-2-2", starterIds: ["keeper", "m-0", "m-1", "f-0", "f-1"] },
    ];
    for (const { rows, missing, formation, starterIds, benchOutfield } of scenarios) {
      players = rows;
      expect(rows).toHaveLength(8);
      const byId = new Map(rows.map((p) => [p.id, p]));
      const starters = starterIds.map((id) => byId.get(id)!);
      const benched = [byId.get("keeper-2")!, byId.get(benchOutfield ?? rows.find((p) => p.position !== "GK" && !starterIds.includes(p.id))!.id)!];
      const reserves = rows.filter((p) => !starters.includes(p) && !benched.includes(p));
      const res = await PUT(request("PUT", {
        formation, captainId: keeper.id, viceCaptainId: starters[1].id, expectedUpdatedAt: null,
        entries: [
          ...starters.map((p, i) => ({ playerId: p.id, slot: "starter", order: i })),
          ...benched.map((p, i) => ({ playerId: p.id, slot: "sub", order: i })),
          ...reserves.map((p, i) => ({ playerId: p.id, slot: "reserve", order: i })),
        ],
      }), ctx);
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.error).toContain(`Missing: ${missing}`);
      expect(body.details?.[0]).toContain(`Missing: ${missing}`);
    }
    // Nothing was written: the save RPC was never reached.
    expect(db.rpc).not.toHaveBeenCalledWith("save_fantasy_squad_v2", expect.anything());
  });

  it("keeps partial drafts saveable while positions are still missing", async () => {
    players = [keeper, defender];
    // A two-player draft with no Midfielder or Forward: the composition rule
    // does not fire because the squad is not complete yet. Mirror the
    // revision and receipt of the successful save above.
    const draft = { ...input, captainId: keeper.id,
      entries: [
        { playerId: keeper.id, slot: "starter", order: 0 },
        { playerId: defender.id, slot: "starter", order: 1 },
      ] };
    db.rpc.mockResolvedValue({ data: { squad: receipt.squad, entries: [
      { ...receipt.entries[0] },
      { ...receipt.entries[0], id: "entry-b", player_id: defender.id, order: 1 },
    ] }, error: null });
    const res = await PUT(request("PUT", { ...draft, expectedUpdatedAt: revision }), ctx);
    expect(res.status).toBe(200);
    expect(db.rpc).toHaveBeenCalledWith("save_fantasy_squad_v2", expect.objectContaining({ p_league: "league-a" }));
  });

  it("rejects cross-league players, duplicate selections and incorrect partial formations/captaincy", async () => {
    const put = (body: typeof input) => PUT(request("PUT", body), ctx);
    expect((await put({ ...input, entries: [input.entries[0], input.entries[0]] })).status).toBe(422);
    expect((await put({ ...input, captainId: "missing" })).status).toBe(422);
    players = [];
    expect((await put(input)).status).toBe(403);
    players = [defender];
    expect((await put({ ...input, formation: "0-3-1", captainId: defender.id,
      entries: [{ playerId: defender.id, slot: "starter", order: 0 }] })).status).toBe(422);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("uses the DB revision and only confirms the exact persisted squad and entries", async () => {
    const put = () => PUT(request("PUT", { ...input, expectedUpdatedAt: revision }), ctx);
    const res = await put();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "applied", squad: { captainId: keeper.id }, players: [{ id: keeper.id }] });
    expect(db.rpc).toHaveBeenCalledWith("save_fantasy_squad_v2", expect.objectContaining({ p_league: "league-a", p_expected_updated_at: revision }));
    db.rpc.mockResolvedValue({ data: { ...receipt, squad: { ...receipt.squad, league_id: "league-b" } }, error: null });
    expect((await put()).status).toBe(409);
    db.rpc.mockResolvedValue({ data: { ...receipt, entries: [] }, error: null });
    expect((await put()).status).toBe(409);
    db.rpc.mockResolvedValue({ data: null, error: { code: "PT409", message: "Squad changed since it was opened." } });
    expect((await put()).status).toBe(409);
  });
});

it("restricts real-team renaming to the league leader and scopes both identifiers", async () => {
  const rename = () => renameTeam(request("PATCH", { name: "Reds" }), { params: Promise.resolve({ id: "league-a", teamId: "team-a" }) });
  expect((await rename()).status).toBe(403);
  membershipRow = { ...membership, role: "organizer" };
  expect((await rename()).status).toBe(403);
  membershipRow = { ...membership, role: "leader" };
  const update = vi.fn(() => query({ id: "team-a", league_id: "league-a", name: "Reds" }, "teams"));
  db.from.mockImplementation((table) => table === "teams" ? { update } : query(membershipRow, table));
  expect(await (await rename()).json()).toMatchObject({ team: { id: "team-a", leagueId: "league-a", name: "Reds" } });
  expect(update).toHaveBeenCalledWith({ name: "Reds" });
  expect(filters).toHaveBeenCalledWith("teams", "league_id", "league-a");
  expect(filters).toHaveBeenCalledWith("teams", "id", "team-a");
});

it("propagates the database deadline denial to a direct API caller", async () => {
  db.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "Squad Locked: a match has started" } });
  const result = await PUT(request("PUT", input), ctx);
  expect(result.status).toBe(409);
  expect((await result.json()).error).toContain("Squad Locked");
});
