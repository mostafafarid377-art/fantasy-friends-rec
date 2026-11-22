import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT } from "@/app/api/leagues/[id]/next-match-lineup/route";

const db = vi.hoisted(() => ({ getUser: vi.fn(), from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/db", () => ({ getSupabase: async () => ({ ...db, auth: { getUser: db.getUser } }) }));
const ctx = { params: Promise.resolve({ id: "league-a" }) };
const revision = "2026-11-19T11:12:13.012341+00:00";
const keeper = { id: "keeper", position: "GK", full_name: "Morning Keeper", status: "active", availability: "available",
  photo_url: null, shirt_number: 1, team_id: "team-a" };
const defender = { id: "defender", position: "DEF", full_name: "Morning Defender", status: "active", availability: "available",
  photo_url: null, shirt_number: 2, team_id: "team-a" };
const membership = { role: "manager", leagues: { id: "league-a", format: "5v5", starters: 5, squad_size: 15, subs_count: 3, vice_policy: "auto_captain" },
  profiles: { email_verified_at: revision } };
const entries = [{ id: keeper.id, slot: "starter", order: 0 }, { id: defender.id, slot: "starter", order: 1 }];
const lineup = { formation: "1-2-1", captainId: keeper.id, viceId: defender.id,
  players: [{ id: keeper.id, name: "Morning Keeper", position: "GK", slot: "starter", order: 0 },
    { id: defender.id, name: "Morning Defender", position: "DEF", slot: "starter", order: 1 }] };
const input = { matchId: "match-a", formation: "1-2-1", captainId: keeper.id, viceId: defender.id,
  expectedUpdatedAt: null, entries };
const request = (method = "GET", body?: unknown) => new NextRequest("http://local.test/api/leagues/league-a/next-match-lineup", {
  method, body: body === undefined ? undefined : JSON.stringify(body),
});

function query(data: unknown) {
  return { select() { return this; }, eq() { return this; }, in() { return this; },
    maybeSingle: () => ({ data, error: null }) };
}
type SavedLineup = { revision: string; lineup: typeof lineup; matchId: string | null };
let saved: SavedLineup, membershipRow: unknown, players: unknown;
beforeEach(() => {
  vi.resetAllMocks();
  membershipRow = membership;
  players = [keeper, defender];
  saved = { revision, lineup, matchId: "match-a" };
  db.getUser.mockResolvedValue({ data: { user: { id: "me" } }, error: null });
  db.from.mockImplementation((table: string) => {
    if (table === "league_members") return query(membershipRow);
    if (table === "players") return { select() { return this; }, eq() { return this; }, in() { return this; },
      then: (onFulfilled: (value: unknown) => unknown) => Promise.resolve({ data: players, error: null }).then(onFulfilled) };
    return query(null);
  });
  db.rpc.mockImplementation(async (name: string) => name === "ff_next_match_lineup"
    ? { data: { serverNow: revision, previous: null, match: null, saved: null, inPlay: null }, error: null }
    : { data: saved, error: null });
});

describe("next match lineup route", () => {
  it("returns the resolved lineup of the next match", async () => {
    const res = await GET(request(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toMatchObject({ serverNow: revision, previous: null, saved: null });
    expect(db.rpc).toHaveBeenCalledWith("ff_next_match_lineup", { p_league: "league-a" });
  });

  it("requires a captain and a vice-captain before it reaches the database", async () => {
    const put = (body: unknown) => PUT(request("PUT", body), ctx);
    expect((await put({ ...input, captainId: null })).status).toBe(422);
    expect((await put({ ...input, viceId: null })).status).toBe(422);
    expect((await put({ ...input, captainId: "" })).status).toBe(422);
    expect((await put({ ...input, viceId: undefined })).status).toBe(422);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("saves the lineup with its captaincy and confirms what was stored", async () => {
    const res = await PUT(request("PUT", input), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matchId: "match-a", revision, lineup: { captainId: keeper.id, viceId: defender.id } });
    expect(db.rpc).toHaveBeenCalledWith("ff_save_next_match_lineup", expect.objectContaining({
      p_league: "league-a", p_match: "match-a", p_captain: keeper.id, p_vice: defender.id,
    }));
  });

  it("maps a locked or stale save to a conflict and an invalid lineup to a rejection", async () => {
    db.rpc.mockResolvedValueOnce({ data: null, error: { code: "PT409", message: "This lineup is locked." } });
    expect((await PUT(request("PUT", input), ctx)).status).toBe(409);
    db.rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "Choose a captain and a vice-captain" } });
    const rejected = await PUT(request("PUT", input), ctx);
    expect(rejected.status).toBe(422);
    expect((await rejected.json()).error).toContain("captain");
  });

  it("refuses to confirm a save the database did not store exactly", async () => {
    db.rpc.mockResolvedValueOnce({ data: { ...saved, lineup: { ...lineup, captainId: defender.id } }, error: null });
    expect((await PUT(request("PUT", input), ctx)).status).toBe(409);
    db.rpc.mockResolvedValueOnce({ data: { ...saved, lineup: { ...lineup, players: [lineup.players[0]] } }, error: null });
    expect((await PUT(request("PUT", input), ctx)).status).toBe(409);
    db.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect((await PUT(request("PUT", input), ctx)).status).toBe(409);
  });

  it("refuses to confirm a save that went to another fixture", async () => {
    db.rpc.mockResolvedValueOnce({ data: { ...saved, matchId: "match-b" }, error: null });
    expect((await PUT(request("PUT", input), ctx)).status).toBe(409);
    db.rpc.mockResolvedValueOnce({ data: { ...saved, matchId: null }, error: null });
    expect((await PUT(request("PUT", input), ctx)).status).toBe(409);
  });

  it("denies signed-out and non-member requests before any write", async () => {
    membershipRow = null;
    expect((await PUT(request("PUT", input), ctx)).status).toBe(403);
    db.getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await GET(request(), ctx)).status).toBe(401);
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
