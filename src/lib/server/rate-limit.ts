import "server-only";
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/db/service";

/**
 * Shared, database-backed rate limiting — trusted server-side execution path.
 *
 * TRUST BOUNDARY
 * --------------
 * The limiter function (ff_rate_limit_hit, migrations 0034+0035) is revoked
 * from PUBLIC, anon and authenticated: untrusted clients must never call it
 * directly, because the identity argument is chosen by the caller and a
 * client could burn a victim's budget (e.g. their login attempts). The only
 * execution path is this module, which talks to the database through the
 * service-role client (src/db/service.ts). The service key is a server-only
 * environment variable (never NEXT_PUBLIC_), and this module is marked
 * server-only so a client-component import fails the build.
 *
 * The database still owns the limit policy (scope → max/window table inside
 * the function): routes choose a scope and an identity, never a budget, and
 * identities are SHA-256 hashed here before they leave the process, so the
 * internal table stores pseudonymous bucket keys — not emails or IPs.
 *
 * Serverless safety: budgets live in PostgreSQL, shared by every instance.
 *
 * FAILURE POLICY (fail open, per category)
 * ----------------------------------------
 * If the limiter itself fails (migration not yet applied, transient DB
 * error), the request is ALLOWED and the failure is logged as
 * `[rate-limit] <scope> <message>` — no identity material is logged. This is
 * deliberate for every category, because each has an independent backstop:
 *   - login/signup/forgot/reset/resend — Supabase Auth enforces its own
 *     server-side limits; a limiter outage must never lock out all sign-ins.
 *   - league/match/profile/notification writes — RLS authorization, role
 *     checks and the idempotency ledger still constrain every mutation.
 * The limiter denies only on a definitive "allowed = false" answer.
 *
 * Usage in a route — works with or without the `handler` wrapper:
 *
 *   const limited = await rateLimitUser("match.create", user.id);
 *   if (limited) return limited;
 */

type LimitVerdict = { allowed?: unknown; retryAfterSeconds?: unknown };

function hashIdentity(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function tooManyRequests(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: "Too many attempts. Please wait and try again." },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

/** Returns a 429 response when the budget is spent, otherwise null. */
async function hit(scope: string, rawIdentity: string): Promise<NextResponse | null> {
  try {
    const supabase = await getServiceSupabase();
    const { data, error } = (await supabase.rpc("ff_rate_limit_hit", {
      p_scope: scope,
      p_identity: hashIdentity(rawIdentity),
    })) as { data: LimitVerdict | null; error: { message?: string } | null };
    if (error) {
      console.error("[rate-limit]", scope, error.message);
      return null;
    }
    if (data?.allowed === false) {
      const retry =
        typeof data.retryAfterSeconds === "number" && data.retryAfterSeconds > 0
          ? Math.min(Math.ceil(data.retryAfterSeconds), 86400)
          : 60;
      return tooManyRequests(retry);
    }
    return null;
  } catch (err) {
    // Fail open per the policy above: an unavailable limiter must not take
    // the app down with it.
    console.error("[rate-limit]", scope, err instanceof Error ? err.message : "unknown");
    return null;
  }
}

/** Rate-limit an authenticated action by the verified user id (never a body-supplied id). */
export function rateLimitUser(scope: string, userId: string): Promise<NextResponse | null> {
  return hit(scope, `user:${userId}`);
}

/**
 * Best-effort source IP — the secondary, wider budget for auth endpoints.
 *
 * Trusted-proxy strategy: on Vercel the platform sets
 * `x-vercel-forwarded-for` and `x-real-ip` from the actual TCP peer and
 * overwrites any client-supplied values, so those headers are trustworthy
 * there. The raw `x-forwarded-for` chain is client-extensible and is only
 * used as a local-development fallback; where no platform header exists the
 * IP budget is skipped rather than trusting a spoofable value in
 * production. IP limits sit alongside (never instead of) per-account limits,
 * and are deliberately wide so shared networks (offices, carrier NAT) are
 * not locked out.
 */
export function clientIp(req: NextRequest): string | null {
  const vercel = req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  if (vercel && vercel.length <= 64) return vercel;
  const real = req.headers.get("x-real-ip")?.trim();
  if (real && real.length <= 64) return real;
  if (process.env.VERCEL) return null; // platform headers must exist on Vercel; absent = distrust
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded && forwarded.length <= 64 ? forwarded : null;
}

/**
 * Auth-endpoint limiting: a tight per-account budget plus a wider per-IP
 * budget. The email identity slows credential stuffing against one account;
 * the IP budget slows sprays across many accounts from one source.
 */
export async function rateLimitAuth(
  req: NextRequest,
  scope: string,
  email: string,
): Promise<NextResponse | null> {
  const limited = await hit(scope, `email:${email.trim().toLowerCase()}`);
  if (limited) return limited;
  const ip = clientIp(req);
  if (ip) return hit(`${scope}.ip`, `ip:${ip}`);
  return null;
}
