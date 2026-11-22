import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as notifications } from "@/app/api/notifications/route";
import { GET as standings } from "@/app/api/leagues/[id]/standings/route";
import { GET as me } from "@/app/api/me/route";

/**
 * The request path must identify the caller from the signed access token.
 * These tests cover the rejected sessions (signed out, expired, mismatched
 * profile) and the membership check that protects league data.
 */
const db = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  getClaims: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("@/db", () => ({
  getSupabase: async () => ({ from: db.from, rpc: db.rpc, auth: { getClaims: db.getClaims, getUser: db.getUser } }),
}));

const SUBJECT = "profile-1";

function table(name: string, row: unknown) {
  const chain: any = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    is: vi.fn(() => chain),
    in: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: name === "league_members" ? row : row, error: null })),
    then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null, count: 0 }),
  };
  return chain;
}

beforeEach(() => {
  vi.resetAllMocks();
  db.getClaims.mockResolvedValue({ data: { claims: { sub: SUBJECT, email: "manager@example.test" } }, error: null });
  db.getUser.mockResolvedValue({ data: null, error: { message: "should not be reached" } });
  db.from.mockImplementation((name: string) =>
    table(name, name === "profiles" ? { id: SUBJECT, username: "manager", email_verified_at: "2026-01-01" } : { role: "manager", leagues: { id: "league-1" }, profiles: { email_verified_at: "2026-01-01" } }));
  db.rpc.mockImplementation(() => {
    const chain: any = { order: vi.fn(() => chain), then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }) };
    return chain;
  });
});

const notificationsRequest = () => notifications(new NextRequest("http://local.test/api/notifications"));
const standingsRequest = () => standings(new NextRequest("http://local.test/api/leagues/league-1/standings"), { params: Promise.resolve({ id: "league-1" }) });
const meRequest = () => me(new NextRequest("http://local.test/api/me"));

it("accepts a signed-in caller from the verified token without asking the Auth server", async () => {
  const response = await notificationsRequest();
  expect(response.status).toBe(200);
  expect(db.getUser).not.toHaveBeenCalled();
});

it("rejects a request without a session", async () => {
  db.getClaims.mockResolvedValue({ data: null, error: null });
  db.getUser.mockResolvedValue({ data: null, error: { message: "no session" } });
  expect((await notificationsRequest()).status).toBe(401);
  expect((await standingsRequest()).status).toBe(401);
});

it("rejects an expired token even when the profile claims look valid", async () => {
  db.getClaims.mockResolvedValue({ data: null, error: { name: "AuthInvalidJwtError", message: "JWT validation failed" } });
  db.getUser.mockResolvedValue({ data: null, error: { name: "AuthSessionMissingError", message: "Auth session missing!" } });
  expect((await notificationsRequest()).status).toBe(401);
});

it("refuses league data to a caller who is not a member", async () => {
  db.from.mockImplementation((name: string) =>
    table(name, name === "league_members" ? null : { id: SUBJECT, username: "manager", email_verified_at: "2026-01-01" }));
  expect((await standingsRequest()).status).toBe(403);
});

it("refuses a profile that does not belong to the signed-in subject", async () => {
  db.from.mockImplementation((name: string) =>
    table(name, name === "profiles" ? null : { role: "manager", leagues: { id: "league-1" } }));
  expect((await meRequest()).status).toBe(404);
});
