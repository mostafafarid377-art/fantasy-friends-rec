import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/matches/[id]/flow/route";

const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), user: vi.fn() }));
vi.mock("@/db", () => ({ getSupabase: async () => ({ ...db, auth: { getUser: db.user } }) }));
const ctx = { params: Promise.resolve({ id: "match-a" }) };
const match = { id: "match-a", league_id: "league-a", organizer_id: "me", version: 1, status: "draft", home_score: null, away_score: null };
const submission = { action: "submit", version: 1, homeScore: 2, awayScore: 0 };
const pending = { ...match, version: 2, status: "pending", home_score: 2, away_score: 0 };
let inputMatch: object, readback: object, role: string;
let matchReads: number;
beforeEach(() => {
  vi.resetAllMocks();
  inputMatch = match; readback = pending; role = "organizer"; matchReads = 0;
  db.user.mockResolvedValue({ data: { user: { id: "me" } }, error: null });
  db.rpc.mockResolvedValue({ data: pending, error: null });
  db.from.mockImplementation((table) => ({
    select() { return this; }, eq() { return this; },
    maybeSingle() { return { data: table === "real_matches" ? (matchReads++ ? readback : inputMatch) : { role, leagues: { id: "league-a" } }, error: null }; },
  }));
});
const post = (body: unknown) => POST(new NextRequest("http://local.test/api/matches/match-a/flow", { method: "POST", body: JSON.stringify(body) }), ctx);

it("submits both scores including zero, and only returns success after reading that score back", async () => {
  expect((await post({ action: "submit", version: 1, homeScore: 2 })).status).toBe(422);
  expect((await post({ ...submission, homeScore: -1 })).status).toBe(422);
  expect((await post({ ...submission, awayScore: 0.25 })).status).toBe(422);
  expect((await post({ ...submission, awayScore: "0" })).status).toBe(422);
  expect(db.rpc).not.toHaveBeenCalled();
  const response = await post(submission);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ match: pending, status: "pending" });
  expect(db.rpc).toHaveBeenCalledExactlyOnceWith("submit_match", { p_match: "match-a", p_version: 1, p_home_score: 2, p_away_score: 0 });
  matchReads = 0;
  readback = { ...pending, home_score: 3 };
  expect((await post(submission)).status).toBe(409);
});

it("requires the right role and checks the correction receipt against persisted scores", async () => {
  const correction = { action: "correct", version: 3, homeScore: 0, awayScore: 0, reason: " Referee checked " };
  role = "manager";
  expect((await post(correction)).status).toBe(403);
  expect(db.rpc).not.toHaveBeenCalled();
  matchReads = 0;
  role = "leader";
  inputMatch = { ...pending, status: "approved", version: 3, organizer_id: "other" };
  readback = { ...inputMatch, version: 4, home_score: 0, away_score: 0 };
  expect((await post({ ...correction, reason: " " })).status).toBe(422);
  db.rpc.mockResolvedValue({ data: { matchId: "match-a", version: 4 }, error: null });
  const response = await post(correction);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "approved", match: { home_score: 0, away_score: 0, version: 4 } });
  expect(db.rpc).toHaveBeenCalledExactlyOnceWith("correct_match_result", { p_match: "match-a", p_version: 3, p_home_score: 0, p_away_score: 0, p_reason: "Referee checked" });
  matchReads = 0;
  db.rpc.mockResolvedValue({ data: null, error: { code: "40001", message: "stale" } });
  expect((await post(correction)).status).toBe(409);
  expect(matchReads).toBe(1);
});
