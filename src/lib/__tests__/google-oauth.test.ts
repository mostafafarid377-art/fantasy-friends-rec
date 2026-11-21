import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { OPTIONS, POST } from "@/app/api/auth/google/route";
import { GOOGLE_START_FIELD } from "@/lib/google-sign-in";
import { googleStartCookieName } from "@/lib/supabase/google-oauth";
import { proxy } from "@/proxy";
import { GET as callback } from "@/app/auth/callback/google/route";
import { GET as emailCallback } from "@/app/auth/callback/route";
import { safeAuthPath } from "@/lib/auth-redirect";

// Exercise the real Supabase SSR client and PKCE storage, with a fake Auth HTTP
// server and the Next cookie-store boundary in memory.
const { jar, writes } = vi.hoisted(() => ({ jar: new Map<string, string>(), writes: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  getAll: () => Array.from(jar, ([name, value]) => ({ name, value })),
  set: (name: string, value: string, options: { maxAge?: number }) => {
    writes(name, value, options);
    if (options.maxAge === 0) jar.delete(name);
    else jar.set(name, value);
  },
}) }));

const app = "https://fantasy.example.test";
const production = "https://fantasy-friends-rec.vercel.app";
const navigation = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
const project = "https://example-project.supabase.co";
const returnTo = "/matches/example?panel=events#score";
const callbackPath = "/auth/callback/google";
const verifier = /-code-verifier(?:\.\d+)?$/;
const user = { id: "d4d610d0-232a-44b7-86d6-a34f88707570", email: "person@example.test" };
const upstream = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.stubEnv("GOOGLE_OAUTH_APP_ORIGIN", app);
  vi.stubEnv("VERCEL_ENV", undefined);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", project);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  jar.clear(); writes.mockClear(); upstream.mockReset();
  upstream.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.auth_code !== "valid-code" || !body.code_verifier) {
      return Response.json({ code: "bad_code_verifier", message: "upstream-only details" }, { status: 400 });
    }
    return Response.json({ access_token: "test-token", token_type: "bearer", refresh_token: "test-refresh", expires_in: 3600, user });
  });
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

let pendingCookie: string | undefined;
const formNonce = "a".repeat(64);
const start = async ({ next = returnTo, origin = app, target = app, headers = {}, token = formNonce, cookie = formNonce }: {
  next?: string; origin?: string | null; target?: string; headers?: Record<string, string>; token?: string | null; cookie?: string | null;
} = {}) => {
  const res = await POST(new NextRequest("http://internal:3000/api/auth/google", {
    method: "POST",
    headers: { host: new URL(target).host, ...(origin === null ? {} : { origin }), "x-forwarded-host": "untrusted.example.test",
      ...(cookie === null ? {} : { cookie: `${googleStartCookieName(target.startsWith("https:"))}=${cookie}` }), ...headers },
    body: new URLSearchParams({ next, ...(token === null ? {} : { [GOOGLE_START_FIELD]: token }) }),
  }));
  pendingCookie = res.cookies.get("ff-google-flow")?.value;
  return res;
};
const finish = (query = "code=valid-code", flow: string | null | undefined = pendingCookie, target = app) => callback(new NextRequest(`http://internal:3000${callbackPath}?${query}`, {
  headers: { host: new URL(target).host, ...(flow == null ? {} : { cookie: `ff-google-flow=${encodeURIComponent(flow)}` }) },
}));

describe("Google OAuth", () => {
  it("starts PKCE through the configured project with an exact, canonical callback and a short-lived verifier", async () => {
    const res = await start();
    const url = new URL(res.headers.get("location")!);
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(url.origin + url.pathname).toBe(`${project}/auth/v1/authorize`);
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("redirect_to")).toBe(`${app}${callbackPath}`);
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("code_challenge_method")).toBe("s256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    expect(writes).toHaveBeenCalledWith(expect.stringMatching(verifier), expect.any(String), expect.objectContaining({ httpOnly: true, sameSite: "lax", secure: true, maxAge: 600 }));
    expect(res.cookies.get("ff-google-flow")).toMatchObject({ value: expect.stringMatching(/^[a-f0-9]{32}:\/matches\/example/), path: callbackPath, httpOnly: true, sameSite: "lax", secure: true, maxAge: 600 });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses cross-origin and unconfigured starts", async () => {
    expect((await start({ origin: "https://untrusted.example.test" })).headers.get("location")).toBe("/login?auth_error=google_start_failed");
    expect((await start({ origin: null, token: null })).headers.get("location")).toContain("/login?auth_error=google_start_failed");
    vi.stubEnv("GOOGLE_OAUTH_APP_ORIGIN", "http://fantasy.example.test");
    expect((await start()).headers.get("location")).toBe("/login?auth_error=google_unavailable");
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([null, "null"])("accepts a real same-origin document POST with Origin %j on stable production", async (origin) => {
    vi.stubEnv("VERCEL_ENV", "production");
    // Even if the opt-in names another environment, the stable production host
    // matches the pinned production origin and will receive its own cookies.
    const res = await start({ target: production, origin, headers: navigation });
    expect(res.status).toBe(303);
    const redirect = new URL(res.headers.get("location")!);
    expect(redirect.searchParams.get("redirect_to")).toBe(`${production}${callbackPath}`);
    expect(res.cookies.get("ff-google-flow")).toMatchObject({ secure: true, httpOnly: true, sameSite: "lax", path: callbackPath });
    expect(res.cookies.get("ff-google-flow")).not.toHaveProperty("domain");
    expect(writes).toHaveBeenCalledWith(expect.stringMatching(verifier), expect.any(String), expect.objectContaining({ path: "/", secure: true, httpOnly: true, sameSite: "lax" }));
    expect(writes.mock.calls.find(([name]) => verifier.test(name))?.[2]).not.toHaveProperty("domain");
    expect((await finish("code=valid-code", pendingCookie, production)).headers.get("location")).toBe(returnTo);
  });

  it("accepts the explicit browser origin on stable production despite a different configured URL", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const res = await start({ target: production, origin: production, headers: navigation });
    expect(new URL(res.headers.get("location")!).searchParams.get("redirect_to")).toBe(`${production}${callbackPath}`);
  });

  it.each([null, "null"])("starts a native form with Origin %j and no Fetch Metadata when the form token matches", async (origin) => {
    const res = await start({ origin });
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const authorize = new URL(res.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe(`${project}/auth/v1/authorize`);
    expect(authorize.searchParams.get("redirect_to")).toBe(`${app}${callbackPath}`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("s256");
    expect(res.cookies.get("ff-google-flow")).toMatchObject({ httpOnly: true, secure: true, maxAge: 600 });
    expect((await finish()).headers.get("location")).toBe(returnTo);
  });

  it("mints a private token for login and signup and forwards it to the renderer and browser", async () => {
    const name = googleStartCookieName(true);
    const signIn = await proxy(new NextRequest(`${app}/login`));
    expect(signIn.headers.get("cache-control")).toBe("private, no-store");
    const issued = signIn.cookies.get(name)!;
    expect(issued).toMatchObject({ secure: true, httpOnly: true, sameSite: "lax", path: "/" });
    expect(issued).not.toHaveProperty("domain");
    expect(issued.value).toMatch(/^[a-f0-9]{64}$/);
    expect(signIn.headers.get("x-middleware-request-cookie")).toContain(`${name}=${issued.value}`);
    const signup = await proxy(new NextRequest(`${app}/signup`, { headers: { cookie: `${name}=${issued.value}` } }));
    expect(signup.cookies.get(name)).toBeUndefined();
    expect(signup.headers.get("cache-control")).toBe("private, no-store");
    const second = await proxy(new NextRequest(`${app}/login`));
    expect(second.cookies.get(name)?.value).not.toBe(issued.value);
    expect((await start({ origin: null, token: issued.value, cookie: issued.value })).status).toBe(303);
    expect((await finish()).headers.get("location")).toBe(returnTo);
  });

  it("rejects preflights and stops requests with a missing or mismatched token before PKCE", async () => {
    expect(OPTIONS().status).toBe(405);
    expect(OPTIONS().headers.get("access-control-allow-origin")).toBeNull();
    for (const input of [{ token: null }, { cookie: null }, { token: "b".repeat(64) }, { token: "malformed" }]) {
      const res = await start({ ...input, headers: navigation });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("/login?auth_error=google_start_failed");
      expect(res.cookies.get("ff-google-flow")).toBeUndefined();
    }
    expect(writes).not.toHaveBeenCalled();
  });

  it("starts on localhost with host-only, non-Secure OAuth cookies for HTTP", async () => {
    const local = "http://localhost:3000";
    vi.stubEnv("GOOGLE_OAUTH_APP_ORIGIN", local);
    const res = await start({ target: local, origin: local, headers: navigation });
    expect(new URL(res.headers.get("location")!).searchParams.get("redirect_to")).toBe(`${local}${callbackPath}`);
    expect(res.cookies.get("ff-google-flow")).toMatchObject({ secure: false, sameSite: "lax" });
    expect(writes).toHaveBeenCalledWith(expect.stringMatching(verifier), expect.any(String), expect.objectContaining({ secure: false }));
  });

  it("rejects foreign origins and untrusted hosts even if the submitted values match", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    for (const input of [
      { target: production, origin: app },
      { target: production, origin: "https://untrusted.example.test" },
      { target: "https://untrusted.example.test", origin: production, headers: { "x-forwarded-host": new URL(production).host } },
    ]) {
      const res = await start(input);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/login?auth_error=google_start_failed");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(writes).not.toHaveBeenCalled();
  });

  it("does not enable the pinned production domain on a preview deployment", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await start({ target: production, origin: production, headers: navigation })).headers.get("location")).toBe("/login?auth_error=google_start_failed");
    expect((await finish("code=valid-code", "a".repeat(32) + ":/dashboard", production)).headers.get("location")).toBe("/login?auth_error=google_unavailable");
    expect(writes).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("exchanges the code using the same PKCE verifier and writes the existing app session", async () => {
    const auth = new URL((await start()).headers.get("location")!);
    const res = await finish("code=valid-code&next=https%3A%2F%2Funtrusted.example.test");
    expect(res.headers.get("location")).toBe(returnTo);
    expect(res.cookies.get("ff-google-flow")).toMatchObject({ maxAge: 0, expires: new Date(0) });
    expect(res.headers.get("set-cookie")).toMatch(/expires=Thu, 01 Jan 1970/i);
    const [tokenUrl, init] = upstream.mock.calls[0];
    expect(tokenUrl).toBe(`${project}/auth/v1/token?grant_type=pkce`);
    const payload = JSON.parse(String(init?.body));
    expect(payload.auth_code).toBe("valid-code");
    expect(createHash("sha256").update(payload.code_verifier).digest("base64url")).toBe(auth.searchParams.get("code_challenge"));
    expect([...jar.keys()].some((key) => /^sb-.*-auth-token(?:\.\d+)?$/.test(key))).toBe(true);
    expect(writes).toHaveBeenCalledWith(expect.stringMatching(/^sb-.*-auth-token(?:\.\d+)?$/), expect.any(String),
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: "lax", maxAge: expect.any(Number) }));
    const sessionWrites = writes.mock.calls.filter(([name]) => /^sb-.*-auth-token(?:\.\d+)?$/.test(name));
    expect(sessionWrites.every(([, , options]) => options.maxAge > 86400)).toBe(true);
    expect([...jar.keys()].some((key) => verifier.test(key))).toBe(false);
  });

  it("returns actionable errors for cancellation, missing flow, or invalid codes without echoing provider text", async () => {
    await start();
    const cancelled = await finish("error=access_denied&error_description=upstream-only");
    expect(cancelled.headers.get("location")).toContain("/login?auth_error=google_cancelled");
    expect(cancelled.headers.get("location")).not.toContain("upstream-only");
    expect(cancelled.cookies.get("ff-google-flow")?.maxAge).toBe(0);
    expect((await finish("code=valid-code", null)).headers.get("location")).toBe("/login?auth_error=google_failed");
    expect((await finish("")).headers.get("location")).toContain("/login?auth_error=google_failed");
    expect(upstream).not.toHaveBeenCalled();
    expect((await finish("code=bad-code")).headers.get("location")).toContain("/login?auth_error=google_failed");
    expect([...jar.keys()].some((key) => /-auth-token$/.test(key))).toBe(false);
  });
});

it.each(["https://other.test", "//other.test", "/\\other.test", "/.//other.test", "/%2e//other.test", "/%5cother.test", "/\n/other.test"])("rejects an unsafe destination %j", (next) => {
  expect(safeAuthPath(next)).toBe("/dashboard");
});

it("keeps the existing email callback's reset destination and rejects external destinations", async () => {
  const request = (params: string) => emailCallback(new NextRequest(`${app}/auth/callback?${params}`));
  await start();
  expect((await request("code=valid-code&next=/reset")).headers.get("location")).toBe("/reset");
  await start();
  expect((await request("code=valid-code&next=//untrusted.example.test")).headers.get("location")).toBe("/dashboard");
  expect((await request("next=/reset")).headers.get("location")).toBe("/login?auth_error=email_missing_code");
});
