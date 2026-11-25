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

/** Project refs: the disposable E2E project (only valid target) and production (always refused). */
export const DISPOSABLE_PROJECT_REF = "ssvwzakelcumisccsuly";
export const PRODUCTION_PROJECT_REF = "zkrfgdiujpagaddsxbcb";

/**
 * Admin credentials of the DISPOSABLE Supabase project (Node setup only, never shipped to the browser).
 *
 * The only accepted hosted URL is the disposable project's origin
 * `https://ssvwzakelcumisccsuly.supabase.co`. Formatting variants that still
 * unambiguously name that project — surrounding whitespace, a trailing
 * slash, or a standard API path such as `/rest/v1/` (a common copy-paste
 * from connection settings) — are normalized to the bare origin via
 * `URL.origin`. What is accepted never changes: same host, same project,
 * HTTPS only. The production project ref is refused explicitly, before any
 * other check, and any other Supabase ref is refused as well.
 * localhost/127.0.0.1 remain allowed for local `supabase start` development.
 *
 * Error messages deliberately describe only the SHAPE of the configured
 * value (scheme/host-suffix booleans, length) and never echo the value
 * itself: this function runs in CI where logs become PR comments.
 */
export function supabaseAdminEnv(): { url: string; serviceRoleKey: string } {
  const rawUrl = (process.env.E2E_SUPABASE_URL ?? "").trim();
  const serviceRoleKey = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !serviceRoleKey) {
    throw new Error(
      "E2E setup requires E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_ROLE_KEY of a DISPOSABLE Supabase project. " +
        "See E2E_TESTING.md — never use production credentials.",
    );
  }
  // Production is refused by substring, before any parsing or normalization.
  if (rawUrl.toLowerCase().includes(PRODUCTION_PROJECT_REF)) {
    throw new Error(`E2E_SUPABASE_URL points at the PRODUCTION project (${PRODUCTION_PROJECT_REF}) — refused.`);
  }
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(rawUrl);
  if (isLocal) {
    return { url: rawUrl.replace(/\/+$/, ""), serviceRoleKey };
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(rawUrl);
  } catch {
    parsed = null;
  }
  const disposableHost = `${DISPOSABLE_PROJECT_REF}.supabase.co`;
  if (!parsed || parsed.protocol !== "https:" || parsed.hostname !== disposableHost) {
    const shape = [
      `https=${parsed?.protocol === "https:" ? "yes" : "no"}`,
      `hostIsDisposableProject=${parsed?.hostname === disposableHost ? "yes" : "no"}`,
      `hostIsSupabase=${parsed?.hostname.endsWith(".supabase.co") === true ? "yes" : "no"}`,
      `length=${rawUrl.length}`,
    ].join(" ");
    throw new Error(
      `E2E_SUPABASE_URL is not the disposable project's URL (${shape}). ` +
        `Expected ${disposableHost} (paths like /rest/v1 are fine and are normalized away).`,
    );
  }
  // Canonical origin: strips any path/query/trailing slash (e.g. /rest/v1/).
  return { url: parsed.origin, serviceRoleKey };
}
