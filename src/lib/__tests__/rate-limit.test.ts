import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { clientIp, rateLimitAuth, rateLimitUser } from "@/lib/server/rate-limit";

/**
 * Unit tests for the shared rate-limit helper. The database function itself
 * (ff_rate_limit_hit) and its grants are covered by the PostgreSQL
 * integration suite (0034+0035); here we verify the route-facing contract:
 * the trusted service-role execution path, when a 429 is produced and what
 * it carries, how identities leave the process, the trusted-proxy IP
 * strategy, and the fail-open posture.
 */

const transport = vi.hoisted(() => ({
  client: null as unknown,
  calls: [] as { scope: string; identity: string }[],
  requestScopedUsed: false,
}));
vi.mock("@/db/service", () => ({ getServiceSupabase: async () => transport.client }));
vi.mock("@/db", () => ({
  getSupabase: async () => {
    transport.requestScopedUsed = true;
    throw new Error("the limiter must not use the request-scoped client");
  },
}));

function rpcReturning(result: { data?: unknown; error?: { message: string } | null } | "throw") {
  transport.calls = [];
  transport.client = {
    rpc: vi.fn(async (name: string, args: { p_scope: string; p_identity: string }) => {
      if (name !== "ff_rate_limit_hit") throw new Error(`unexpected rpc ${name}`);
      transport.calls.push({ scope: args.p_scope, identity: args.p_identity });
      if (result === "throw") throw new Error("connection reset");
      return result;
    }),
  };
}

function req(headers: Record<string, string> = {}) {
  return new NextRequest("https://app.test/api/x", { headers });
}

beforeEach(() => {
  vi.restoreAllMocks();
  transport.client = null;
  transport.calls = [];
  transport.requestScopedUsed = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("rateLimitUser", () => {
  it("allows the request while the budget lasts", async () => {
    rpcReturning({ data: { allowed: true, remaining: 4, retryAfterSeconds: 100 }, error: null });
    expect(await rateLimitUser("match.create", "user-1")).toBeNull();
    expect(transport.calls).toEqual([{ scope: "match.create", identity: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  });

  it("executes only via the service-role client, never the request-scoped client", async () => {
    rpcReturning({ data: { allowed: true, remaining: 4, retryAfterSeconds: 100 }, error: null });
    await rateLimitUser("match.create", "user-1");
    expect(transport.requestScopedUsed).toBe(false);
  });

  it("denies with a sanitized 429 and Retry-After once the budget is spent", async () => {
    rpcReturning({ data: { allowed: false, remaining: 0, retryAfterSeconds: 42 }, error: null });
    const res = await rateLimitUser("match.create", "user-1");
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBe("42");
    const body = await res!.json();
    expect(body.error).toBe("Too many attempts. Please wait and try again.");
    expect(JSON.stringify(body)).not.toContain("user-1");
  });

  it("falls back to a 60s Retry-After when the function omits it", async () => {
    rpcReturning({ data: { allowed: false }, error: null });
    const res = await rateLimitUser("match.create", "user-1");
    expect(res?.headers.get("Retry-After")).toBe("60");
  });

  it("fails open when the limiter errors, and logs the failure without identity material", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcReturning({ data: null, error: { message: "function not found" } });
    expect(await rateLimitUser("match.create", "user-1")).toBeNull();
    expect(spy).toHaveBeenCalledWith("[rate-limit]", "match.create", "function not found");
    expect(spy.mock.calls.flat().join(" ")).not.toContain("user-1");
  });

  it("fails open when the service client throws (e.g. missing service key)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcReturning("throw");
    expect(await rateLimitUser("match.create", "user-1")).toBeNull();
    expect(spy).toHaveBeenCalled();
  });

  it("never sends the raw identity to the database — only its SHA-256 hash", async () => {
    rpcReturning({ data: { allowed: true, remaining: 1, retryAfterSeconds: 5 }, error: null });
    await rateLimitUser("league.join", "user:secret-user-id");
    expect(transport.calls[0].identity).toMatch(/^[0-9a-f]{64}$/);
    expect(transport.calls[0].identity).not.toContain("secret");
  });
});

describe("rateLimitAuth", () => {
  it("checks the per-email budget, then the per-IP budget", async () => {
    rpcReturning({ data: { allowed: true, remaining: 9, retryAfterSeconds: 60 }, error: null });
    const res = await rateLimitAuth(req({ "x-vercel-forwarded-for": "203.0.113.9" }), "auth.login", "User@Example.com");
    expect(res).toBeNull();
    expect(transport.calls.map((c) => c.scope)).toEqual(["auth.login", "auth.login.ip"]);
    // Identities differ: email bucket and ip bucket are hashed independently.
    expect(transport.calls[0].identity).not.toBe(transport.calls[1].identity);
  });

  it("skips the IP budget when no trustworthy IP exists", async () => {
    rpcReturning({ data: { allowed: true, remaining: 9, retryAfterSeconds: 60 }, error: null });
    await rateLimitAuth(req(), "auth.login", "user@example.com");
    expect(transport.calls.map((c) => c.scope)).toEqual(["auth.login"]);
  });

  it("denies immediately when the per-email budget is spent, without touching the IP budget", async () => {
    rpcReturning({ data: { allowed: false, remaining: 0, retryAfterSeconds: 120 }, error: null });
    const res = await rateLimitAuth(req({ "x-vercel-forwarded-for": "203.0.113.9" }), "auth.login", "user@example.com");
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBe("120");
    expect(transport.calls).toHaveLength(1);
  });
});

describe("clientIp (trusted-proxy strategy)", () => {
  it("prefers the Vercel platform header, taking its first hop", () => {
    expect(clientIp(req({ "x-vercel-forwarded-for": " 198.51.100.7 , 10.1.2.3", "x-forwarded-for": "9.9.9.9" })))
      .toBe("198.51.100.7");
  });

  it("falls back to the platform-set x-real-ip", () => {
    expect(clientIp(req({ "x-real-ip": "203.0.113.10" }))).toBe("203.0.113.10");
  });

  it("distrusts a bare client-supplied x-forwarded-for on Vercel", () => {
    vi.stubEnv("VERCEL", "1");
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9" }))).toBeNull();
  });

  it("uses x-forwarded-for only off-platform (local development)", () => {
    expect(clientIp(req({ "x-forwarded-for": " 192.0.2.4 , 10.0.0.1" }))).toBe("192.0.2.4");
  });

  it("returns null without any usable header", () => {
    expect(clientIp(req())).toBeNull();
    expect(clientIp(req({ "x-forwarded-for": " " }))).toBeNull();
  });
});
