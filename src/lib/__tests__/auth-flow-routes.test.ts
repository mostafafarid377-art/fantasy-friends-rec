import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Regression coverage for the real email-auth flow after the dead-code
// cleanup: signup/forgot/resend must respond with the live contract
// (requiresEmailVerification / ok), forward a Turnstile token when one is
// supplied, and never return the removed legacy `devLink` field. The removed
// /api/auth/verify route and /verify page must stay gone.

const auth = vi.hoisted(() => ({
  signUp: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  resend: vi.fn(),
  getUser: vi.fn(),
  exchangeCodeForSession: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth }) }));

import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as forgot } from "@/app/api/auth/forgot/route";
import { POST as resend } from "@/app/api/auth/resend/route";
import { GET as emailCallback } from "@/app/auth/callback/route";

beforeEach(() => {
  vi.resetAllMocks();
  auth.getUser.mockResolvedValue({ data: { user: { id: "u1", email: "mo@example.test" } }, error: null });
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://local.test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("signup route contract", () => {
  it("returns requiresEmailVerification (202) with no devLink when confirmation is pending", async () => {
    auth.signUp.mockResolvedValue({ data: { user: { id: "u1" }, session: null }, error: null });
    const res = await signup(post("/api/auth/signup", {
      email: "mo@example.test", username: "mosalah", displayName: "Mo Salah", password: "hunter2pass",
    }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ requiresEmailVerification: true });
    expect(body).not.toHaveProperty("devLink");
    expect(auth.signUp.mock.calls[0][0].options.emailRedirectTo).toContain("/auth/callback");
  });

  it("returns the user (201) with no devLink when a session is issued", async () => {
    auth.signUp.mockResolvedValue({ data: { user: { id: "u1" }, session: { user: { id: "u1" } } }, error: null });
    const res = await signup(post("/api/auth/signup", {
      email: "mo@example.test", username: "mosalah", displayName: "Mo Salah", password: "hunter2pass",
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.id).toBe("u1");
    expect(body).not.toHaveProperty("devLink");
  });

  it("forwards a Turnstile captchaToken to Supabase when provided", async () => {
    auth.signUp.mockResolvedValue({ data: { user: { id: "u1" }, session: null }, error: null });
    await signup(post("/api/auth/signup", {
      email: "mo@example.test", username: "mosalah", displayName: "Mo Salah", password: "hunter2pass",
      captchaToken: "cf-token-1",
    }));
    expect(auth.signUp.mock.calls[0][0].options.captchaToken).toBe("cf-token-1");
  });
});

describe("forgot route contract", () => {
  it("returns ok with no devLink and forwards the captcha token", async () => {
    auth.resetPasswordForEmail.mockResolvedValue({ error: null });
    const res = await forgot(post("/api/auth/forgot", { email: "mo@example.test", captchaToken: "cf-token-2" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(body).not.toHaveProperty("devLink");
    expect(auth.resetPasswordForEmail.mock.calls[0][1]).toMatchObject({
      captchaToken: "cf-token-2",
      redirectTo: expect.stringContaining("/auth/callback?next=/reset"),
    });
  });

  it("does not reveal whether the account exists", async () => {
    auth.resetPasswordForEmail.mockResolvedValue({ error: null });
    const res = await forgot(post("/api/auth/forgot", { email: "nobody@example.test" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("resend route contract", () => {
  it("requires a signed-in user", async () => {
    auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: "no session" } });
    const res = await resend(post("/api/auth/resend", { kind: "verify_email" }));
    expect(res.status).toBe(401);
  });

  it("returns ok with no devLink and forwards an optional captcha token", async () => {
    auth.resend.mockResolvedValue({ error: null });
    const res = await resend(post("/api/auth/resend", { kind: "verify_email", captchaToken: "cf-token-3" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(body).not.toHaveProperty("devLink");
    expect(auth.resend.mock.calls[0][0]).toMatchObject({
      type: "signup",
      email: "mo@example.test",
      options: expect.objectContaining({ captchaToken: "cf-token-3" }),
    });
  });
});

describe("email confirmation callback (the live verification flow)", () => {
  it("exchanges the code and redirects to the safe next path", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null });
    const res = await emailCallback(new NextRequest("http://local.test/auth/callback?code=valid&next=/team"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/team");
  });

  it("rejects external redirect targets and missing codes", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null });
    const external = await emailCallback(new NextRequest("http://local.test/auth/callback?code=valid&next=https://evil.test"));
    expect(external.headers.get("location")).toBe("/dashboard");
    const missing = await emailCallback(new NextRequest("http://local.test/auth/callback"));
    expect(missing.headers.get("location")).toBe("/login?auth_error=email_missing_code");
  });
});

describe("removed legacy verification surface", () => {
  it("the legacy /api/auth/verify route and /verify page no longer exist", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.join(__dirname, "../..");
    expect(fs.existsSync(path.join(root, "app/api/auth/verify/route.ts"))).toBe(false);
    expect(fs.existsSync(path.join(root, "app/(auth)/verify/page.tsx"))).toBe(false);
  });
});
