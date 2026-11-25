import { request } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { E2E_PASSWORD, E2E_USERS, e2eBaseURL, supabaseAdminEnv } from "./env";

/**
 * Provisions the deterministic test accounts on the disposable Supabase
 * project, then signs each one in ONCE through the app's real login API and
 * stores the resulting browser state under e2e/.auth/. Journeys reuse those
 * states instead of re-authenticating — the login form itself is exercised
 * by its own journeys (J04, J05, J19), and reusing state keeps the suite
 * comfortably inside the auth rate limits (migration 0034).
 *
 * Accounts are created already email-confirmed via the Admin API — the same
 * state a real user reaches after clicking the confirmation link. This does
 * not weaken auth: every journey still runs as a real session, and every
 * authorization rule applies. The `.test` addresses cannot exist in
 * production, so a misconfigured run fails to authenticate rather than
 * touching real data.
 */
export default async function globalSetup() {
  const baseURL = e2eBaseURL();
  const { url, serviceRoleKey } = supabaseAdminEnv();
  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: listed, error: listError } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (listError) throw new Error(`Could not list users on the disposable project: ${listError.message}`);
  const byEmail = new Map((listed?.users ?? []).map((u) => [(u.email ?? "").toLowerCase(), u.id]));

  for (const user of Object.values(E2E_USERS)) {
    const existing = byEmail.get(user.email);
    if (existing) {
      // Keep the password deterministic across reruns.
      const { error } = await admin.auth.admin.updateUserById(existing, {
        password: E2E_PASSWORD,
        email_confirm: true,
        user_metadata: { username: user.username, display_name: user.displayName },
      });
      if (error) throw new Error(`Could not refresh E2E user ${user.email}: ${error.message}`);
    } else {
      const { error } = await admin.auth.admin.createUser({
        email: user.email,
        password: E2E_PASSWORD,
        email_confirm: true,
        user_metadata: { username: user.username, display_name: user.displayName },
      });
      if (error) {
        const hint = /database error/i.test(error.message)
          ? " Hint: a stale profile row on the disposable project may already claim this username (profiles_username_uq) — pick a fresh username in e2e/env.ts; the suite never deletes existing data."
          : "";
        throw new Error(`Could not create E2E user ${user.email}: ${error.message}.${hint}`);
      }
    }
  }

  // Fail fast with a clear message when the app server is not up.
  let detail = "";
  try {
    const res = await fetch(`${baseURL}/login`, { redirect: "manual" });
    if (res.status === 200) detail = "";
    else detail = `status ${res.status}`;
  } catch (error) {
    detail = error instanceof Error ? error.message : "connection failed";
  }
  if (detail) {
    throw new Error(
      `The app under test did not serve /login at ${baseURL} (${detail}). ` +
        "Start it with the disposable project's env, or let the Playwright webServer start `npm run dev`.",
    );
  }

  // One real login per reused identity; the session cookies are stored as
  // Playwright storage states. e2e/.auth is gitignored (session material).
  const dir = path.join(__dirname, ".auth");
  mkdirSync(dir, { recursive: true });
  // Per-file unique-name seeds (helpers.uniqueSuffix) belong to one run only;
  // dropping them keeps reruns from colliding with leagues of a previous run.
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("seed-")) unlinkSync(path.join(dir, entry));
  }
  for (const key of ["leader", "manager"] as const) {
    const ctx = await request.newContext({ baseURL });
    const res = await ctx.post("/api/auth/login", {
      data: { email: E2E_USERS[key].email, password: E2E_PASSWORD },
    });
    if (!res.ok()) {
      throw new Error(`E2E setup login failed for ${E2E_USERS[key].email}: ${res.status()} ${await res.text()}`);
    }
    await ctx.storageState({ path: path.join(dir, `${key}.json`) });
    await ctx.dispose();
  }
}
