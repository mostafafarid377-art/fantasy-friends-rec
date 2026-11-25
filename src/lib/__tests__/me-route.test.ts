import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PATCH } from "@/app/api/me/route";

/**
 * Regression coverage for J18 (run 45657284354): PATCH /api/me used to write
 * `updated_at` in the profiles update payload, but 0002_rls.sql grants the
 * authenticated role UPDATE on exactly (username, display_name, avatar_url,
 * bio). Postgres rejects any column outside the grant with 42501
 * "permission denied", so every profile save failed with a toast that
 * auto-dismissed before the assertion timed out. This pins the payload to
 * the granted columns only.
 */
const GRANTED_COLUMNS = ["username", "display_name", "avatar_url", "bio"];

const db = vi.hoisted(() => ({ user: vi.fn(), from: vi.fn(), updates: [] as Record<string, unknown>[] }));
vi.mock("@/db", () => ({ getSupabase: async () => ({ from: db.from, auth: { getUser: db.user } }) }));
vi.mock("@/lib/server/rate-limit", () => ({ rateLimitUser: vi.fn(async () => null) }));

const PROFILE = {
  id: "me",
  email: "e2e-manager@example.invalid",
  username: "e2e_manager_ffr",
  display_name: "E2E Manager",
  avatar_url: null,
  bio: null,
  email_verified_at: "2026-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  db.updates.length = 0;
  db.user.mockResolvedValue({ data: { user: { id: "me", email: PROFILE.email, user_metadata: {} } }, error: null });
  db.from.mockImplementation(() => {
    let updated: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      update: (payload: Record<string, unknown>) => {
        updated = payload;
        db.updates.push(payload);
        return chain;
      },
      maybeSingle: () => ({ data: { ...PROFILE, ...(updated ?? {}) }, error: null }),
    };
    return chain;
  });
});
afterEach(() => vi.restoreAllMocks());

const patch = (body: unknown) =>
  PATCH(new NextRequest("http://local.test/api/me", { method: "PATCH", body: JSON.stringify(body) }));

it("updates only the columns the authenticated role is granted (0002_rls)", async () => {
  const res = await patch({ displayName: "Renamed Manager", username: "e2e_manager_ffr", avatarUrl: null, bio: null });
  expect(res.status).toBe(200);
  expect(db.updates).toHaveLength(1);
  for (const column of Object.keys(db.updates[0])) {
    expect(GRANTED_COLUMNS, `column "${column}" is outside the profiles UPDATE grant`).toContain(column);
  }
  expect(db.updates[0].display_name).toBe("Renamed Manager");
  expect(db.updates[0]).not.toHaveProperty("updated_at");
});

it("returns the confirmed profile row", async () => {
  const res = await patch({ bio: "Gaffer" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.profile.displayName).toBe("E2E Manager");
  expect(body.profile.bio).toBe("Gaffer");
});
