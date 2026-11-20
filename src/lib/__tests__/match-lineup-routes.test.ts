import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PUT } from "@/app/api/matches/[id]/lineup/route";
import { lineupPayload, lineupSelection } from "@/lib/match-lineup";

const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), user: vi.fn() }));
vi.mock("@/db", () => ({ getSupabase: async () => ({ ...db, auth: { getUser: db.user } }) }));
const ctx = { params: Promise.resolve({ id: "match-a" }) };
const selection = { starters: ["gk","d","m1","m2","f"], subs: ["sub"] };
const payload = lineupPayload("home", selection);
const positions = ["GK","DEF","MID","MID","FWD","MID"];
let role: string, organizer: string, corrupt: boolean, readError: boolean, availability: string;
const filters = vi.fn();
beforeEach(() => {
  vi.resetAllMocks(); role = "organizer"; organizer = "me"; corrupt = false; readError = false; availability = "available";
  db.user.mockResolvedValue({ data: { user: { id: "me" } }, error: null });
  db.rpc.mockResolvedValue({ data: [], error: null });
  db.from.mockImplementation((table: string) => ({
    select() { return this; }, eq(...a: unknown[]) { filters(table,...a); return this; },
    maybeSingle() { return { data: table === "real_matches" ? { id: "match-a", league_id: "league-a", team_a_id: "home", team_b_id: "away", organizer_id: organizer, status: "draft" }
      : { role, leagues: { format: "5v5", starters: 5, subs_count: 2, squad_size: 10 } }, error: null }; },
    in() { return { data: [...selection.starters,...selection.subs].map((id,i) => ({ id, position: positions[i], team_id: "home", status: "active", availability: i ? "available" : availability })), error: null }; },
    order() { return { data: db.rpc.mock.calls[0][1].p_entries.map((r: object,i: number) => ({ id: `${i}`, match_id: "match-a", league_id: "league-a", team_id: "home", ...r, ...(corrupt && i === 0 ? { order: 99 } : {}) })),
      error: readError ? { code: "42501", message: "Permission denied" } : null }; },
  }));
});
afterEach(() => vi.restoreAllMocks());
const put = (body: unknown = payload) => PUT(new NextRequest("http://local.test/api/matches/match-a/lineup", { method: "PUT", body: JSON.stringify(body) }), ctx);

it("rejects the old string-array payload and confirms an organizer's saved rows by reading the scoped match lineup", async () => {
  expect((await put({ teamId: "home", ...selection })).status).toBe(422);
  expect(db.rpc).not.toHaveBeenCalled();
  const saved = await put();
  expect(saved.status).toBe(200);
  expect(lineupSelection((await saved.json()).lineups, "home")).toEqual(selection);
  expect(db.rpc).toHaveBeenCalledExactlyOnceWith("replace_match_lineup", { p_match:"match-a",p_team:"home",p_entries: expect.arrayContaining([{ player_id:"gk",slot:"starter",order:0 }]) });
  expect(filters).toHaveBeenCalledWith("match_lineups","match_id","match-a");
  expect(filters).toHaveBeenCalledWith("match_lineups","league_id","league-a");
  expect(filters).toHaveBeenCalledWith("match_lineups","team_id","home");
  expect(db.from.mock.calls.map(([table]) => table)).not.toContain("fantasy_squad_players");
});

it("blocks an unauthorized member, permits the leader, and rejects unavailable players", async () => {
  role = "manager";
  expect((await put()).status).toBe(403);
  role = "organizer"; organizer = "other";
  expect((await put()).status).toBe(403);
  role = "leader"; availability = "injured";
  expect((await put()).status).toBe(422);
  expect(db.rpc).not.toHaveBeenCalled();
  availability = "available";
  expect((await put()).status).toBe(200);
});

it("never confirms a rejected mutation, unreadable result, or a mismatched read-back", async () => {
  db.rpc.mockResolvedValueOnce({ data:null,error:{code:"42501",message:"Permission denied"} });
  expect((await put()).status).toBe(403);
  expect(db.from).not.toHaveBeenCalledWith("match_lineups");
  readError = true;
  expect((await put()).status).toBe(403);
  readError = false; corrupt = true;
  const mismatch = await put();
  expect(mismatch.status).toBe(409);
  expect((await mismatch.json()).lineups).toBeUndefined();
});

it("returns a conflict instead of pretending a direct lineup request after kickoff saved", async () => {
  db.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "Lineup Locked: the match has started" } });
  const result = await put();
  expect(result.status).toBe(409);
  expect((await result.json()).error).toContain("Lineup Locked");
  expect(db.from).not.toHaveBeenCalledWith("match_lineups");
});
