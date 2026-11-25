/**
 * Environment contract for the E2E suite. Everything here is test-only;
 * nothing weakens or bypasses the app's auth — the Admin API is used once,
 * in Node during global setup, to provision confirmed test accounts on a
 * disposable Supabase project.
 */

/** Production app origins the suite must never exercise. */
const FORBIDDEN_ORIGINS = [
  "https://fantasyfriends.vercel.app",
  "https://fantasy-friends-rec.vercel.app",
  "https://www.fantasyfriends.vercel.app",
];

export function e2eBaseURL(): string {
  const url = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
  if (FORBIDDEN_ORIGINS.some((origin) => url.toLowerCase().startsWith(origin))) {
    throw new Error(
      `Refusing to run E2E journeys against a production origin (${url}). ` +
        "Point E2E_BASE_URL at a disposable environment.",
    );
  }
  return url;
}

export const E2E_PASSWORD = process.env.E2E_USER_PASSWORD ?? "E2E-Test-Passw0rd!";

/**
 * Mailbox domain for E2E accounts. Supabase's hosted mailer validates the
 * recipient host before sending (supabase/auth validateclient): it rejects
 * RFC 2606 reserved suffixes (.test/.example/.invalid/.local/.localhost),
 * an explicit blocklist (example.com/.net/.org, test.com, …) and any host
 * with neither MX nor A DNS records. That is why `@fantasyfriends.test`
 * signups fail with `Email address "…" is invalid` (email_address_invalid)
 * even though the Admin API accepts them. The disposable project's own
 * ref domain always resolves while the project exists, so it is the one
 * domain guaranteed to pass validation without ever being a real mailbox.
 */
export const E2E_EMAIL_DOMAIN = "ssvwzakelcumisccsuly.supabase.co";

/**
 * Deterministic test accounts, provisioned by global-setup.ts. Addresses are
 * random-collision-proof and can only ever belong to the disposable project.
 */
export const E2E_USERS = {
  leader: { email: `e2e-leader@${E2E_EMAIL_DOMAIN}`, username: "e2e_leader", displayName: "E2E Leader" },
  manager: { email: `e2e-manager@${E2E_EMAIL_DOMAIN}`, username: "e2e_manager", displayName: "E2E Manager" },
  outsider: { email: `e2e-outsider@${E2E_EMAIL_DOMAIN}`, username: "e2e_outsider", displayName: "E2E Outsider" },
} as const;

export type E2EUser = (typeof E2E_USERS)[keyof typeof E2E_USERS];

/** Admin credentials of the DISPOSABLE Supabase project (Node setup only, never shipped to the browser). */
export function supabaseAdminEnv(): { url: string; serviceRoleKey: string } {
  const url = process.env.E2E_SUPABASE_URL;
  const serviceRoleKey = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "E2E setup requires E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_ROLE_KEY of a DISPOSABLE Supabase project. " +
        "See E2E_TESTING.md — never use production credentials.",
    );
  }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url) && !url.includes("127.0.0.1") && !url.includes("localhost")) {
    throw new Error(`E2E_SUPABASE_URL does not look like a Supabase project URL: ${url}`);
  }
  return { url, serviceRoleKey };
}
