import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DELETE } from "@/app/api/leagues/[id]/route";

const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), user: vi.fn() }));
vi.mock("@/db", () => ({ getSupabase: async () => ({ ...db, auth: { getUser: db.user } }) }));
const ctx = { params: Promise.resolve({ id: "league" }) };
let creator: string;
beforeEach(() => {
  vi.resetAllMocks();
  creator = "member";
  db.user.mockResolvedValue({ data: { user: { id: "member" } }, error: null });
  db.from.mockImplementation(() => ({ select() { return this; }, eq() { return this; }, maybeSingle: () => (
    { data: { role: "leader", leagues: { id: "league", name: "Friends League", created_by: creator } }, error: null }) }));
  db.rpc.mockResolvedValue({ data: "league", error: null });
});
const remove = (confirmation: string) => DELETE(new NextRequest("http://local.test/api/leagues/league", { method: "DELETE", body: JSON.stringify({ confirmation }) }), ctx);

it("rejects incorrect confirmation and a leader who did not create the league", async () => {
  expect((await remove("friends league")).status).toBe(422);
  creator = "other";
  expect((await remove("Friends League")).status).toBe(403);
  expect(db.rpc).not.toHaveBeenCalled();
});

it("requires the RPC to confirm the exact deleted ID", async () => {
  const response = await remove("Friends League");
  expect(await response.json()).toEqual({ deletedId: "league" });
  expect(db.rpc).toHaveBeenCalledExactlyOnceWith("delete_owned_league", { p_league: "league", p_confirmation: "Friends League" });
  db.rpc.mockResolvedValue({ data: "different", error: null });
  expect((await remove("Friends League")).status).toBe(409);
});
