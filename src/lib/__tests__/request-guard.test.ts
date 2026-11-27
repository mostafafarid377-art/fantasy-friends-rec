import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { captchaMissing, clientIp, isSameOriginWrite, limitWrites, memoryLimit, resetMemoryLimits } from "@/lib/request-guard";
import { siteOrigin } from "@/lib/site-origin";

function post(headers: Record<string, string> = {}, url = "https://app.example.test/api/leagues") {
  return new NextRequest(url, { method: "POST", headers });
}

describe("same-origin check for writes", () => {
  it("allows a write from the app's own origin", () => {
    expect(isSameOriginWrite(post({ origin: "https://app.example.test", host: "app.example.test" }))).toBe(true);
  });

  it("blocks a write whose Origin is another site", () => {
    expect(isSameOriginWrite(post({ origin: "https://evil.example", host: "app.example.test" }))).toBe(false);
  });

  it("blocks the literal null origin and malformed origins", () => {
    expect(isSameOriginWrite(post({ origin: "null", host: "app.example.test" }))).toBe(false);
    expect(isSameOriginWrite(post({ origin: "not a url", host: "app.example.test" }))).toBe(false);
  });

  it("allows server-to-server calls with no Origin, but not ones the browser marks cross-site", () => {
    expect(isSameOriginWrite(post({ host: "app.example.test" }))).toBe(true);
    expect(isSameOriginWrite(post({ host: "app.example.test", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOriginWrite(post({ host: "app.example.test", "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it("never blocks reads", () => {
    const get = new NextRequest("https://app.example.test/api/x", { headers: { origin: "https://evil.example" } });
    expect(isSameOriginWrite(get)).toBe(true);
  });
});

describe("rate limiting", () => {
  beforeEach(() => resetMemoryLimits());

  it("allows up to the limit inside a window and then refuses", () => {
    const now = 1_000_000;
    expect([1, 2, 3].map(() => memoryLimit("k", 3, 60_000, now))).toEqual([true, true, true]);
    expect(memoryLimit("k", 3, 60_000, now + 1)).toBe(false);
  });

  it("starts a fresh window once the old one has expired", () => {
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) memoryLimit("k", 3, 60_000, now);
    expect(memoryLimit("k", 3, 60_000, now + 60_001)).toBe(true);
  });

  it("counts separate keys separately", () => {
    expect(memoryLimit("a", 1, 60_000, 5)).toBe(true);
    expect(memoryLimit("b", 1, 60_000, 5)).toBe(true);
  });

  it("answers 429 with Retry-After to a write flood but never limits reads", async () => {
    const req = () => post({ "x-forwarded-for": "203.0.113.9" });
    let last: Response | null = null;
    for (let i = 0; i < 121; i++) last = limitWrites(req());
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).toBe("60");
    expect(limitWrites(new NextRequest("https://app.example.test/api/x", { headers: { "x-forwarded-for": "203.0.113.9" } }))).toBeNull();
  });

  it("takes the client address from the first forwarded entry", () => {
    expect(clientIp(post({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientIp(post())).toBe("unknown");
  });
});

describe("captcha requirement", () => {
  it("is not enforced when no Turnstile site key is configured", () => {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    expect(captchaMissing(undefined)).toBe(false);
  });

  it("requires a token once a site key is configured", () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "site-key";
    try {
      expect(captchaMissing(undefined)).toBe(true);
      expect(captchaMissing("token")).toBe(false);
    } finally {
      delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    }
  });
});

describe("origin used in emailed links", () => {
  it("ignores a forged Origin header and uses the configured app origin", () => {
    process.env.GOOGLE_OAUTH_APP_ORIGIN = "https://app.example.test";
    try {
      const req = post({ origin: "https://evil.example", host: "app.example.test" });
      expect(siteOrigin(req)).toBe("https://app.example.test");
    } finally {
      delete process.env.GOOGLE_OAUTH_APP_ORIGIN;
    }
  });
});
