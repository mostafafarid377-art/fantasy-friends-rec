import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/auth/google/route";
import { GOOGLE_START_FIELD } from "@/lib/google-sign-in";
import { googleStartCookieName } from "@/lib/supabase/google-oauth";
import nextConfig from "@/../next.config";

// Regression guard for the production failure:
//   "Sending form data to 'https://fantasy-friends-rec.vercel.app/api/auth/google'
//    violates the following Content Security Policy directive: form-action 'self'."
//
// The Google button is a same-origin form POST whose 303 answer points at the
// Supabase authorize endpoint, which itself redirects to accounts.google.com.
// Chromium enforces form-action against EVERY hop of that redirect chain (and
// reports the form action URL, not the blocked hop), so the policy must cover
// the whole chain. This test drives the real route and matches its redirect
// target against the real CSP the deployment emits.

const { jar } = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  getAll: () => Array.from(jar, ([name, value]) => ({ name, value })),
  set: (name: string, value: string, options: { maxAge?: number }) => {
    if (options.maxAge === 0) jar.delete(name);
    else jar.set(name, value);
  },
}) }));

const app = "https://fantasy.example.test";
const project = "https://example-project.supabase.co";
const nonce = "b".repeat(64);

beforeEach(() => {
  vi.stubEnv("GOOGLE_OAUTH_APP_ORIGIN", app);
  vi.stubEnv("VERCEL_ENV", undefined);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", project);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  jar.clear();
});
afterEach(() => { vi.unstubAllEnvs(); });

async function formActionSources(): Promise<string[]> {
  const config: any = nextConfig;
  const blocks = await config.headers();
  const all = blocks.find((b: any) => b.source === "/:path*");
  const csp = String(new Map(all.headers.map((h: any) => [h.key.toLowerCase(), h.value as string])).get("content-security-policy"));
  const directive = csp.split("; ").find((d: string) => d.startsWith("form-action"))!;
  return directive.replace(/^form-action\s+/, "").split(/\s+/);
}

/** CSP host-source matching for the source shapes this policy uses. */
function matches(source: string, url: URL, documentOrigin: string): boolean {
  if (source === "'self'") return url.origin === documentOrigin;
  const parsed = new URL(source);
  if (parsed.protocol !== url.protocol) return false;
  if (parsed.hostname.startsWith("*.")) {
    const suffix = parsed.hostname.slice(1); // ".supabase.co"
    return url.hostname.endsWith(suffix) && url.hostname.length > suffix.length;
  }
  return parsed.host === url.host;
}

describe("Google sign-in form vs Content-Security-Policy", () => {
  it("the form POST target and every redirect hop are allowed by form-action", async () => {
    const res = await POST(new NextRequest("http://internal:3000/api/auth/google", {
      method: "POST",
      headers: {
        host: new URL(app).host,
        origin: app,
        cookie: `${googleStartCookieName(true)}=${nonce}`,
      },
      body: new URLSearchParams({ next: "/dashboard", [GOOGLE_START_FIELD]: nonce }),
    }));
    expect(res.status).toBe(303);
    const authorize = new URL(res.headers.get("location")!);
    // The route must redirect to the Supabase authorize endpoint of the configured project.
    expect(authorize.origin + authorize.pathname).toBe(`${project}/auth/v1/authorize`);

    const sources = await formActionSources();
    const allows = (raw: string, documentOrigin = app) =>
      sources.some((source) => matches(source, new URL(raw), documentOrigin));

    // Hop 0: the form action itself, resolved against the document origin.
    expect(allows(`${app}/api/auth/google`)).toBe(true);
    // Hop 1: the route's 303 to the Supabase authorize endpoint.
    expect(allows(authorize.href)).toBe(true);
    // Hop 2: Supabase's 302 to the Google consent screen.
    expect(allows("https://accounts.google.com/o/oauth2/v2/auth")).toBe(true);
    // The production origins, as seen in the observed error, are covered too:
    // 'self' matches whatever origin served the login page.
    expect(allows("https://fantasy-friends-rec.vercel.app/api/auth/google", "https://fantasy-friends-rec.vercel.app")).toBe(true);

    // And nothing unrelated slips in.
    expect(allows("https://evil.example.com/steal")).toBe(false);
    expect(allows("http://accounts.google.com.evil.test/")).toBe(false);
  });

  it("keeps the start form same-origin and relative (no absolute action, no <base>)", async () => {
    const source = await import("@/components/GoogleSignIn").catch(() => null);
    expect(source).not.toBeNull();
    // The rendered action is pinned to the relative path by google-auth-pages.test.tsx;
    // here we additionally pin that the module never builds an absolute URL.
    const code = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../../components/GoogleSignIn.tsx"), "utf8");
    expect(code).toContain('action="/api/auth/google"');
    expect(code).not.toMatch(/action=\{[^}]*http/);
    expect(code).not.toContain("<base");
  });
});
