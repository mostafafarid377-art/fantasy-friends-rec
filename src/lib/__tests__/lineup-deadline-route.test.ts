import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/internal/lineup-deadlines/route";

const service = vi.hoisted(() => ({ rpc: vi.fn(), missing: false }));
vi.mock("@/db/service", () => ({
  getServiceSupabase: async () => {
    if (service.missing) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    return { rpc: service.rpc };
  },
}));

const secret = "a-secret-that-only-the-scheduler-knows";
const request = (method = "GET", token?: string) => new NextRequest("http://local.test/api/internal/lineup-deadlines", {
  method,
  headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
});

beforeEach(() => {
  vi.resetAllMocks();
  service.missing = false;
  process.env.LINEUP_DEADLINE_SECRET = secret;
  service.rpc.mockImplementation(async (name: string) => name === "ff_promote_due_match_lineups"
    ? { data: { matches: 2, promoted: 1, failed: 0, source: "scheduler" }, error: null }
    : { data: { lastRun: { ranAt: "2026-11-19T12:00:00Z", source: "scheduler" }, ageSeconds: 4, openFailures: 0 }, error: null });
});

afterEach(() => {
  delete process.env.LINEUP_DEADLINE_SECRET;
  delete process.env.CRON_SECRET;
});

describe("the internal lineup deadline route", () => {
  it("refuses to run when no secret is configured", async () => {
    delete process.env.LINEUP_DEADLINE_SECRET;
    const res = await GET(request("GET", secret));
    expect(res.status).toBe(503);
    expect(service.rpc).not.toHaveBeenCalled();
  });

  it("refuses a caller that cannot prove itself", async () => {
    expect((await GET(request("GET"))).status).toBe(401);
    expect((await GET(request("GET", "wrong"))).status).toBe(401);
    expect((await POST(request("POST", "wrong"))).status).toBe(401);
    expect(service.rpc).not.toHaveBeenCalled();
  });

  it("runs the deadline with the service role and reports what it did", async () => {
    const res = await POST(request("POST", secret));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      matches: 2, promoted: 1, failed: 0, source: "scheduler",
      status: { openFailures: 0 },
    });
    expect(service.rpc).toHaveBeenCalledWith("ff_promote_due_match_lineups", { p_source: "scheduler" });
    expect(service.rpc).toHaveBeenCalledWith("ff_lineup_deadline_status");
  });

  it("never sends the secret back to the caller", async () => {
    const res = await GET(request("GET", secret));
    const body = await res.text();
    expect(body).not.toContain(secret);
    expect(JSON.parse(body)).not.toHaveProperty("secret");
  });

  it("reports a deadline that could not be run", async () => {
    service.missing = true;
    expect((await GET(request("GET", secret))).status).toBe(503);

    service.missing = false;
    service.rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    expect((await POST(request("POST", secret))).status).toBe(503);
  });
});
