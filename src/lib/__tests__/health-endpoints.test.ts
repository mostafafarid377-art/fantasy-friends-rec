import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Health endpoints are unauthenticated by design, so they must never leak
// internal error detail — SQL fragments, schema names, connection strings —
// to the client. The client learns only ok:true / ok:false; the full error
// is logged server-side.

const { queryResult, fromMock } = vi.hoisted(() => {
  const queryResult = { error: null as { message: string } | null };
  const fromMock = vi.fn(() => ({
    select: () => ({ limit: async () => ({ error: queryResult.error }) }),
  }));
  return { queryResult, fromMock };
});

vi.mock("@/db", () => ({ getSupabase: async () => ({ from: fromMock }) }));

import { GET as appHealth } from "@/app/api/health/route";
import { GET as supabaseHealth } from "@/app/api/supabase/health/route";

afterEach(() => {
  queryResult.error = null;
  fromMock.mockClear();
  vi.restoreAllMocks();
});

const call = (route: () => Promise<Response>) => route();

describe("health endpoints", () => {
  it("reports ok:true when the database answers", async () => {
    for (const route of [appHealth, supabaseHealth]) {
      const res = await call(route);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
  });

  it("reports a bare ok:false on database failure, leaking nothing", async () => {
    const secret = 'duplicate key value violates unique constraint "profiles_pkey" on relation "public.profiles"';
    queryResult.error = { message: secret };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const route of [appHealth, supabaseHealth]) {
      const res = await call(route);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ ok: false });
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(JSON.stringify(body)).not.toContain("profiles_pkey");
    }
    // The full detail is still available to operators in the server log.
    expect(log).toHaveBeenCalledWith("[health:supabase]", secret);
  });

  it("reports ok:false and logs when the client itself throws", async () => {
    fromMock.mockImplementationOnce(() => { throw new Error("connectionstring postgres://user:pass@host/db"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(supabaseHealth);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ ok: false });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(log).toHaveBeenCalledWith("[health:supabase]", expect.stringContaining("postgres://"));
  });
});
