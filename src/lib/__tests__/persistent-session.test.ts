import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { config, proxy } from "@/proxy";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { GET as session } from "@/app/api/auth/session/route";

// Use the real Supabase SSR cookie storage with a fake Auth service. A new
// request after restart receives only cookies with a positive lifetime.
const { browser } = vi.hoisted(() => ({ browser: new Map<string, { value: string; options: { maxAge?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string | boolean; path?: string } }>() }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  getAll: () => Array.from(browser, ([name, { value }]) => ({ name, value })),
  set: (name: string, value: string, options: object) => browser.set(name, { value, options }),
}) }));

const app = "https://fantasy.example.test";
const user = { id: "d4d610d0-232a-44b7-86d6-a34f88707570", email: "person@example.test", aud: "authenticated", role: "authenticated" };
const upstream = vi.fn();
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (exp: number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp, sub: user.id })}.dGVzdA`;
const restart = () => {
  for (const [name, cookie] of browser) if (!cookie.options.maxAge || cookie.options.maxAge < 0) browser.delete(name);
};
const navigate = (path: string) => proxy(new NextRequest(`${app}${path}`, {
  headers: { cookie: [...browser].map(([name, { value }]) => `${name}=${value}`).join("; ") },
}));
const readSession = () => session(new NextRequest(`${app}/api/auth/session`));
const signIn = () => login(new NextRequest(`${app}/api/auth/login`, { method: "POST", body: JSON.stringify({ email: user.email, password: "test-password" }) }));

let initialExpiry: number;
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  browser.clear();
  initialExpiry = Math.floor(Date.now() / 1000) + 3600;
  upstream.mockReset().mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const grant = url.searchParams.get("grant_type");
    if (url.pathname.endsWith("/token") && grant === "password") return Response.json({ access_token: token(initialExpiry), refresh_token: "first-refresh", token_type: "bearer", expires_in: 3600, expires_at: initialExpiry, user });
    if (url.pathname.endsWith("/token") && grant === "refresh_token") {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      return Response.json({ access_token: token(exp), refresh_token: "rotated-refresh", token_type: "bearer", expires_in: 3600, expires_at: exp, user });
    }
    if (url.pathname.endsWith("/user")) return Response.json(user);
    if (url.pathname.endsWith("/logout")) return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/notifications")) return new Response(null, { headers: { "content-range": "*/0" } });
    if (url.pathname.endsWith("/league_members") || url.pathname.endsWith("/league_standings")) return Response.json([]);
    return Response.json({ username: "person", display_name: "Person" });
  });
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("serves shared homepage links without running the proxy", () => {
  expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: `${app}/?from=share` })).toBe(false);
  expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: `${app}/login` })).toBe(true);
  expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: `${app}/dashboard` })).toBe(true);
});

it("keeps sign-in persistent and verifies the reopened session separately from the public pages", async () => {
  expect((await signIn()).status).toBe(200);
  expect([...browser.values()].length).toBeGreaterThan(0);
  for (const { options } of browser.values()) {
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    expect(options.maxAge).toBeGreaterThan(86400);
  }
  restart();
  upstream.mockClear();
  for (const path of ["/", "/login?next=%2Fteam"]) {
    const response = await navigate(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.has("x-middleware-override-headers")).toBe(false);
  }
  expect(upstream).not.toHaveBeenCalled();
  expect(await (await readSession()).json()).toMatchObject({ user: { id: user.id }, leagues: [], unread: 0 });
  expect((await logout()).status).toBe(200);
  expect([...browser.values()].every(({ options }) => options.maxAge === 0)).toBe(true);
  restart();
  expect(await (await readSession()).json()).toMatchObject({ user: null });
});

it("keeps cookie rotation on protected navigation", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  expect((await signIn()).status).toBe(200);
  vi.setSystemTime(new Date((initialExpiry + 60) * 1000));
  restart();
  const response = await navigate("/dashboard");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const rotated = response.cookies.getAll();
  expect(rotated.length).toBeGreaterThan(0);
  for (const { name, value, ...options } of rotated) {
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    expect(options.maxAge).toBeGreaterThan(86400);
    browser.set(name, { value, options });
  }
  restart();
  const count = () => upstream.mock.calls.filter(([url]) => String(url).includes("grant_type=refresh_token")).length;
  expect(count()).toBe(1);
  expect(await (await readSession()).json()).toMatchObject({ user: { id: user.id } });
  expect(count()).toBe(1);
});

it("does not resume a revoked session just because a cookie remains", async () => {
  expect((await signIn()).status).toBe(200);
  restart();
  upstream.mockImplementation(async () => Response.json({ code: "session_not_found", message: "Session ended" }, { status: 403 }));
  expect(await (await readSession()).json()).toMatchObject({ user: null });
});

it("opens an old shared homepage link even with a malformed session cookie and clears it on the background check", async () => {
  const key = "sb-example-project-auth-token";
  const options = { maxAge: 86400 };
  browser.set(`${key}.0`, { value: "base64-not%21", options });
  browser.set(`${key}.1`, { value: "valid", options });
  browser.set("unrelated", { value: "keep", options });
  const response = await navigate("/");
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(response.cookies.getAll()).toEqual([]);
  expect(await (await readSession()).json()).toMatchObject({ user: null });
  expect(browser.get(`${key}.0`)?.options.maxAge).toBe(0);
  expect(browser.get(`${key}.1`)?.options.maxAge).toBe(0);
  expect(browser.get("unrelated")?.value).toBe("keep");
  expect(upstream).not.toHaveBeenCalled();
});

it("can sign in again directly when the browser sends an unreadable session cookie", async () => {
  const key = "sb-example-project-auth-token";
  browser.set(key, { value: "base64-!", options: { maxAge: 86400 } });
  expect((await signIn()).status).toBe(200);
  expect(browser.get(key)?.options.maxAge).toBeGreaterThan(86400);
  expect(await (await readSession()).json()).toMatchObject({ user: { id: user.id } });
});

it("keeps readable cookies and the homepage during a temporary Auth outage", async () => {
  expect((await signIn()).status).toBe(200);
  upstream.mockResolvedValueOnce(Response.json({ message: "Unavailable" }, { status: 503 }));
  const response = await navigate("/");
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(await (await readSession()).json()).toMatchObject({ user: null });
  expect([...browser.values()].every(({ options }) => (options.maxAge ?? 0) > 0)).toBe(true);
  expect(await (await readSession()).json()).toMatchObject({ user: { id: user.id } });
});
