import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/leagues/route";

const db = vi.hoisted(() => ({ getUser: vi.fn(), from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/db", () => ({ getSupabase: async () => ({ ...db, auth: { getUser: db.getUser } }) }));

const request = (body: unknown) => new NextRequest("http://local.test/api/leagues", { method: "POST", body: JSON.stringify(body) });
const membership = { profile_id: "me", role: "leader",
  leagues: { id: "league-new", name: "Night Owls", format: "5v5", starters: 5, subs_count: 4, invite_code: "CODE" } };

function query(data: unknown) {
  return { select() { return this; }, eq() { return this; }, maybeSingle: () => ({ data, error: null }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.getUser.mockResolvedValue({ data: { user: { id: "me", email: "me@example.com", user_metadata: {} } }, error: null });
  db.from.mockImplementation((table: string) => query(table === "profiles" ? { id: "me", username: "me" } : membership));
  db.rpc.mockResolvedValue({ data: "league-new", error: null });
});

describe("league creation", () => {
  it("defaults to four substitutes when the creator does not choose a bench size", async () => {
    const res = await POST(request({ name: "Night Owls", format: "5v5" }));
    expect(res.status).toBe(201);
    expect(db.rpc).toHaveBeenCalledWith("create_league_confirmed", expect.objectContaining({ p_starters: 5, p_subs_count: 4 }));
  });

  it("uses the substitutes count the creator selected, for either format", async () => {
    const res = await POST(request({ name: "Night Owls", format: "7v7", subsCount: 7 }));
    expect(res.status).toBe(201);
    expect(db.rpc).toHaveBeenCalledWith("create_league_confirmed", expect.objectContaining({ p_starters: 7, p_subs_count: 7 }));
  });

  it("rejects out-of-range substitutes counts before any write", async () => {
    for (const subsCount of [0, 11, 2.5, "four"]) {
      expect((await POST(request({ name: "Night Owls", format: "5v5", subsCount }))).status).toBe(422);
    }
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
