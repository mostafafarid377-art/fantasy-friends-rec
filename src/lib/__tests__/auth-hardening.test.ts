import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetMemoryLimits } from "@/lib/request-guard";

const sb = vi.hoisted(() => ({
  signUp: vi.fn(),
  signIn: vi.fn(),
  reset: vi.fn(),
  aal: vi.fn(),
  factors: vi.fn(),
  from: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      signUp: sb.signUp,
      signInWithPassword: sb.signIn,
      resetPasswordForEmail: sb.reset,
      mfa: { getAuthenticatorAssuranceLevel: sb.aal, listFactors: sb.factors },
    },
    from: sb.from,
  }),
}));

const healthDb = vi.hoisted(() => ({ error: null as { message: string } | null }));
vi.mock("@/db", () => ({
  getSupabase: async () => ({
    from: () => ({ select: () => ({ limit: async () => ({ error: healthDb.error }) }) }),
  }),
}));

import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as forgot } from "@/app/api/auth/forgot/route";
import { GET as health } from "@/app/api/supabase/health/route";

const APP = "https://app.example.test";
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${APP}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "app.example.test", ...headers },
    body: JSON.stringify(body),
  });
}
const signupBody = { email: "New@Example.test", username: "newbie", displayName: "New Manager", password: "correct-horse-1" };

beforeEach(() => {
  vi.resetAllMocks();
  resetMemoryLimits();
  delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  delete process.env.GOOGLE_OAUTH_APP_ORIGIN;
  healthDb.error = null;
  sb.aal.mockResolvedValue({ data: { currentLevel: "aal1", nextLevel: "aal1" } });
});

describe("sign-up does not reveal which emails have accounts", () => {
  it("answers an existing email exactly like a new signup", async () => {
    sb.signUp.mockResolvedValue({ data: {}, error: { message: "User already registered" } });
    const res = await signup(post("/api/auth/signup", signupBody));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ requiresEmailVerification: true });
  });

  it("returns a plain message for a weak password and hides other provider errors", async () => {
    sb.signUp.mockResolvedValueOnce({ data: {}, error: { code: "weak_password", message: "Password is too weak" } });
    const weak = await signup(post("/api/auth/signup", signupBody));
    expect(weak.status).toBe(422);
    expect((await weak.json()).error).toBe("Choose a stronger password");

    sb.signUp.mockResolvedValueOnce({ data: {}, error: { message: "duplicate key value violates unique constraint users_pkey" } });
    const other = await signup(post("/api/auth/signup", signupBody));
    expect(other.status).toBe(400);
    expect(JSON.stringify(await other.json())).not.toMatch(/constraint|users_pkey/);
  });
});

describe("cross-site and captcha protection on auth routes", () => {
  it("refuses a cross-site sign-up before talking to Supabase", async () => {
    const res = await signup(post("/api/auth/signup", signupBody, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(sb.signUp).not.toHaveBeenCalled();
  });

  it("refuses a cross-site login", async () => {
    const res = await login(post("/api/auth/login", { email: "a@b.test", password: "x" }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(sb.signIn).not.toHaveBeenCalled();
  });

  it("requires the captcha token when Turnstile is configured", async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "site-key";
    const res = await login(post("/api/auth/login", { email: "a@b.test", password: "x" }));
    expect(res.status).toBe(422);
    expect(sb.signIn).not.toHaveBeenCalled();
  });
});

describe("rate limiting", () => {
  it("stops repeated sign-in attempts for one email", async () => {
    sb.signIn.mockResolvedValue({ data: {}, error: { message: "Invalid login credentials" } });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      statuses.push((await login(post("/api/auth/login", { email: "victim@example.test", password: `guess-${i}` }))).status);
    }
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(401));
    expect(statuses.slice(8)).toEqual([429, 429]);
  });
});

describe("two-step verification at sign-in", () => {
  it("asks for the code instead of finishing sign-in, and does not load the profile", async () => {
    sb.signIn.mockResolvedValue({ data: { user: { id: "u1", email: "a@b.test" } }, error: null });
    sb.aal.mockResolvedValue({ data: { currentLevel: "aal1", nextLevel: "aal2" } });
    sb.factors.mockResolvedValue({ data: { totp: [{ id: "factor-1" }] } });
    const res = await login(post("/api/auth/login", { email: "a@b.test", password: "right" }));
    expect(await res.json()).toEqual({ mfaRequired: true, factorId: "factor-1" });
    expect(sb.from).not.toHaveBeenCalled();
  });
});

describe("password reset links", () => {
  it("point at the configured app origin even when the request forges Origin", async () => {
    process.env.GOOGLE_OAUTH_APP_ORIGIN = APP;
    sb.reset.mockResolvedValue({ error: null });
    const res = await forgot(post("/api/auth/forgot", { email: "a@b.test" }, { origin: APP }));
    expect(res.status).toBe(200);
    expect(sb.reset.mock.calls[0][1].redirectTo).toBe(`${APP}/auth/callback?next=/reset`);
  });
});

describe("health probe", () => {
  it("reports only up or down, never the database error", async () => {
    healthDb.error = { message: 'relation "profiles" does not exist' };
    const res = await health();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false });
  });
});
