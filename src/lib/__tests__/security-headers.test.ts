import { describe, expect, it } from "vitest";
import nextConfig from "@/../next.config";

// The production security headers come from next.config.ts. This guards the
// baseline so a future config change cannot silently drop a header that
// protects every route.

describe("security headers (production config)", () => {
  // next.config exports the headers only when not in the e2b preview mode.
  const config: any = nextConfig;

  it("defines a catch-all headers() source", () => {
    // The exported config must be the production branch (no LINEUP_DESIGN_PREVIEW in test).
    expect(typeof config.headers).toBe("function");
  });

  it("sets the full baseline on every path", async () => {
    const blocks = await config.headers();
    const all = blocks.find((b: any) => b.source === "/:path*");
    expect(all).toBeDefined();
    const map = new Map(all.headers.map((h: any) => [h.key.toLowerCase(), h.value as string]));

    // Core anti-XSS / anti-framing / transport headers
    expect(map.get("content-security-policy")).toMatch(/^default-src 'self'/);
    expect(map.get("content-security-policy")).toContain("object-src 'none'");
    expect(map.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(map.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(map.get("x-content-type-options")).toBe("nosniff");
    expect(map.get("strict-transport-security")).toContain("max-age=");
    expect(map.get("referrer-policy")).toBeDefined();
    expect(map.get("permissions-policy")).toContain("camera=()");
  });

  it("keeps connect-src scoped to the app and Supabase only", async () => {
    const blocks = await config.headers();
    const all = blocks.find((b: any) => b.source === "/:path*");
    const csp = String(new Map(all.headers.map((h: any) => [h.key.toLowerCase(), h.value as string])).get("content-security-policy"));
    const connect = csp.split("; ").find((d: string) => d.startsWith("connect-src"))!;
    expect(connect).toContain("'self'");
    expect(connect).toContain("https://*.supabase.co");
    expect(connect).not.toMatch(/connect-src\s+\*/); // never wildcard
  });

  it("form-action allows exactly the Google sign-in redirect chain and nothing else", async () => {
    const blocks = await config.headers();
    const all = blocks.find((b: any) => b.source === "/:path*");
    const csp = String(new Map(all.headers.map((h: any) => [h.key.toLowerCase(), h.value as string])).get("content-security-policy"));
    const formAction = csp.split("; ").find((d: string) => d.startsWith("form-action"))!;

    // 'self' covers every app form (all are same-origin; only the Google
    // start form performs a native POST). Chromium enforces form-action on
    // every hop of a form POST's redirect chain, so the two cross-origin
    // hops of Google sign-in must be named explicitly:
    //   POST /api/auth/google -> 303 <project>.supabase.co/auth/v1/authorize
    //                        -> 302 accounts.google.com (consent document)
    expect(formAction).toContain("'self'");
    expect(formAction).toContain("https://*.supabase.co");
    expect(formAction).toContain("https://accounts.google.com");

    // No other destination, no wildcard-everything, no insecure scheme.
    const sources = formAction.replace(/^form-action\s+/, "").split(/\s+/);
    expect(sources.sort()).toEqual(["'self'", "https://*.supabase.co", "https://accounts.google.com"].sort());
    expect(formAction).not.toContain("http://");
  });
});
