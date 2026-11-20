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
let membershipRow: unknown, players: unknown, squad: unknown;
beforeEach(() => {
  vi.resetAllMocks();
  membershipRow = membership;
  players = [keeper];
  squad = null;
  db.getUser.mockResolvedValue({ data: { user: { id: "me" } }, error: null });
  db.from.mockImplementation((table: string) => query(({ league_members: membershipRow, players, fantasy_squads: squad } as Record<string, unknown>)[table], table));
  db.rpc.mockResolvedValue({ data: receipt, error: null });
});

describe("league squad route", () => {
  it("reads only this member's squad and never creates one on an empty GET", async () => {
    const res = await GET(request(), ctx);
    expect(await res.json()).toMatchObject({ squad: null, players: [], rules: { squadSize: 8, subsCount: 2 } });
    expect(filters).toHaveBeenCalledWith("fantasy_squads", "league_id", "league-a");
    expect(filters).toHaveBeenCalledWith("fantasy_squads", "profile_id", "me");
    expect(db.rpc).not.toHaveBeenCalled();
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
