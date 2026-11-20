import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { POST } from "@/app/api/auth/google/route";
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
const project = "https://example-project.supabase.co";
const returnTo = "/matches/example?panel=events#score";
const callbackPath = "/auth/callback/google";
const verifier = /-code-verifier(?:\.\d+)?$/;
const user = { id: "d4d610d0-232a-44b7-86d6-a34f88707570", email: "person@example.test" };
const upstream = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.stubEnv("GOOGLE_OAUTH_APP_ORIGIN", app);
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
const start = async (next = returnTo, origin: string | null = app) => {
  const res = await POST(new NextRequest("http://internal:3000/api/auth/google", {
  method: "POST", headers: { ...(origin === null ? {} : { origin }), "x-forwarded-host": "untrusted.example.test" },
  body: new URLSearchParams({ next }),
  }));
  pendingCookie = res.cookies.get("ff-google-flow")?.value;
  return res;
};
const finish = (query = "code=valid-code", flow: string | null | undefined = pendingCookie) => callback(new NextRequest(`http://internal:3000${callbackPath}?${query}`, {
  headers: flow == null ? {} : { cookie: `ff-google-flow=${encodeURIComponent(flow)}` },
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
    expect((await start(returnTo, "https://untrusted.example.test")).status).toBe(403);
    expect((await start(returnTo, null)).status).toBe(403);
    vi.stubEnv("GOOGLE_OAUTH_APP_ORIGIN", "http://fantasy.example.test");
    expect((await start()).headers.get("location")).toBe("/login?auth_error=google_unavailable");
    expect(writes).not.toHaveBeenCalled();
  });

  it("exchanges the code using the same PKCE verifier and writes the existing app session", async () => {
    const auth = new URL((await start()).headers.get("location")!);
    const res = await finish("code=valid-code&next=https%3A%2F%2Funtrusted.example.test");
    expect(res.headers.get("location")).toBe(returnTo);
    expect(res.cookies.get("ff-google-flow")?.maxAge).toBe(0);
    const [tokenUrl, init] = upstream.mock.calls[0];
    expect(tokenUrl).toBe(`${project}/auth/v1/token?grant_type=pkce`);
    const payload = JSON.parse(String(init?.body));
    expect(payload.auth_code).toBe("valid-code");
    expect(createHash("sha256").update(payload.code_verifier).digest("base64url")).toBe(auth.searchParams.get("code_challenge"));
    expect([...jar.keys()].some((key) => /^sb-.*-auth-token(?:\.\d+)?$/.test(key))).toBe(true);
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
