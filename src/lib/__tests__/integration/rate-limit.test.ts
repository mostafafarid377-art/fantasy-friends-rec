import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * PostgreSQL integration tests for the shared rate limiter (migration 0034).
 *
 * Runs against a REAL local PostgreSQL database — requires DATABASE_URL
 * pointing at a disposable ff_test* database (same guard as postgres.test.ts).
 * The function is exercised through the `authenticated` and `anon` roles so
 * the grants, the SECURITY DEFINER table access and the RLS denial on the
 * internal table are all verified as deployed, not as mocked.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required to run PostgreSQL integration tests.");
}

const target = new URL(DATABASE_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || !/^\/ff_test\w*$/.test(target.pathname)) {
  throw new Error("This suite truncates fixture tables. Use a disposable local ff_test database.");
}

const pool = new Pool({ connectionString: DATABASE_URL });
let admin: PoolClient;

const hit = async (client: PoolClient, scope: string, identity: string) =>
  (await client.query("SELECT public.ff_rate_limit_hit($1, $2) AS r", [scope, identity])).rows[0].r as {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
  };

async function asRole(role: "authenticated" | "anon"): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query(`SET ROLE ${role}`);
  return client;
}

beforeAll(async () => {
  admin = await pool.connect();
  await admin.query("TRUNCATE public.ff_rate_limit_windows");
});

afterAll(async () => {
  admin?.release();
  await pool.end();
});

describe("ff_rate_limit_hit (migration 0034)", () => {
  it("allows hits within the budget and counts the remaining allowance", async () => {
    const client = await asRole("authenticated");
    try {
      const identity = `test:${randomUUID()}`;
      const first = await hit(client, "auth.login", identity);
      expect(first.allowed).toBe(true);
      expect(first.remaining).toBe(9); // auth.login allows 10 per 5 minutes
      expect(first.retryAfterSeconds).toBeGreaterThan(0);
      expect(first.retryAfterSeconds).toBeLessThanOrEqual(300);
      const second = await hit(client, "auth.login", identity);
      expect(second.remaining).toBe(8);
    } finally {
      client.release();
    }
  });

  it("denies once the fixed-window budget is spent, with a Retry-After bound to the window", async () => {
    const client = await asRole("authenticated");
    try {
      const identity = `test:${randomUUID()}`;
      for (let i = 0; i < 10; i++) {
        const r = await hit(client, "auth.login", identity);
        expect(r.allowed).toBe(true);
      }
      const eleventh = await hit(client, "auth.login", identity);
      expect(eleventh.allowed).toBe(false);
      expect(eleventh.remaining).toBe(0);
      expect(eleventh.retryAfterSeconds).toBeGreaterThan(0);
      expect(eleventh.retryAfterSeconds).toBeLessThanOrEqual(300);
    } finally {
      client.release();
    }
  });

  it("keeps budgets independent per identity", async () => {
    const client = await asRole("authenticated");
    try {
      const a = `test:${randomUUID()}`;
      const b = `test:${randomUUID()}`;
      await hit(client, "auth.login", a);
      await hit(client, "auth.login", a);
      const other = await hit(client, "auth.login", b);
      expect(other.remaining).toBe(9);
    } finally {
      client.release();
    }
  });

  it("keeps budgets independent per scope for the same identity", async () => {
    const client = await asRole("authenticated");
    try {
      const identity = `test:${randomUUID()}`;
      await hit(client, "auth.signup", identity); // limit 5
      const other = await hit(client, "auth.forgot", identity);
      expect(other.remaining).toBe(4); // auth.forgot allows 5, untouched by auth.signup
    } finally {
      client.release();
    }
  });

  it("a past window never counts against the current one", async () => {
    const identity = `test:${randomUUID()}`;
    const currentWindow = Math.floor(Date.now() / 1000 / 300);
    // Simulate a previous window that was exhausted to the maximum.
    await admin.query(
      "INSERT INTO public.ff_rate_limit_windows (bucket, hits, window_start) VALUES ($1, 9999, now() - interval '10 minutes')",
      [`auth.login:${identity}:${currentWindow - 1}`],
    );
    const client = await asRole("authenticated");
    try {
      const r = await hit(client, "auth.login", identity);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(9);
    } finally {
      client.release();
    }
  });

  it("counts concurrent hits exactly once each (no lost updates)", async () => {
    const identity = `test:${randomUUID()}`;
    const clients = await Promise.all([asRole("authenticated"), asRole("authenticated")]);
    try {
      // match.manage allows 120, so 6 parallel hits all succeed — the point is
      // the stored count, not the verdicts.
      await Promise.all(Array.from({ length: 6 }, (_, i) => hit(clients[i % 2], "match.manage", identity)));
      const currentWindow = Math.floor(Date.now() / 1000 / 300);
      const { rows } = await admin.query(
        "SELECT hits FROM public.ff_rate_limit_windows WHERE bucket = $1",
        [`match.manage:${identity}:${currentWindow}`],
      );
      // The hit may land in the next window if the window rolled mid-test.
      const { rows: next } = await admin.query(
        "SELECT hits FROM public.ff_rate_limit_windows WHERE bucket = $1",
        [`match.manage:${identity}:${currentWindow + 1}`],
      );
      expect((rows[0]?.hits ?? 0) + (next[0]?.hits ?? 0)).toBe(6);
    } finally {
      clients.forEach((c) => c.release());
    }
  });

  it("rejects unknown scopes and malformed identities", async () => {
    const client = await asRole("authenticated");
    try {
      await expect(hit(client, "admin.unlimited", `test:${randomUUID()}`)).rejects.toMatchObject({ code: "22023" });
      await expect(hit(client, "auth.login", "short")).rejects.toMatchObject({ code: "22023" });
    } finally {
      client.release();
    }
  });

  it("grants execution to both anon and authenticated", async () => {
    const anon = await asRole("anon");
    try {
      const r = await hit(anon, "auth.login", `test:${randomUUID()}`);
      expect(r.allowed).toBe(true);
    } finally {
      anon.release();
    }
  });

  it("keeps the internal table unreachable from client roles (RLS + no grants)", async () => {
    const client = await asRole("authenticated");
    try {
      await expect(client.query("SELECT * FROM public.ff_rate_limit_windows")).rejects.toMatchObject({ code: "42501" });
      await expect(
        client.query("INSERT INTO public.ff_rate_limit_windows (bucket, hits, window_start) VALUES ('x:y:0', 1, now())"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      client.release();
    }
  });

  it("enables RLS on the internal table like every other application table", async () => {
    const { rows } = await admin.query(
      "SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ff_rate_limit_windows'",
    );
    expect(rows[0]?.rowsecurity).toBe(true);
  });
});
