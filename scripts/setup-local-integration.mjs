// Prepare an empty local PostgreSQL database for integration tests. Supabase
// Auth and Realtime objects here are test scaffolding, not deployment SQL.
import { readdir, readFile } from "node:fs/promises";
import { Client } from "pg";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/unspecified");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/ff_test\w*$/.test(url.pathname)) {
  throw new Error("DATABASE_URL must point to an empty local ff_test database");
}
const db = new Client({ connectionString: url.href });
await db.connect();
try {
  await db.query(`
    DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE PUBLICATION supabase_realtime;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('auth.uid', true), '')::uuid
    $$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz,
      raw_user_meta_data jsonb, created_at timestamptz, updated_at timestamptz);
  `);
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const name of (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort()) {
    await db.query(await readFile(new URL(name, dir), "utf8"));
    console.log(`Applied ${name}`);
  }
} finally {
  await db.end();
}
