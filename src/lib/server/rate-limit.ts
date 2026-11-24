import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/db";

/**
 * Shared, database-backed rate limiting.
 *
 * The limiter lives in PostgreSQL (migration 0034, function
 * ff_rate_limit_hit) because the app runs on serverless instances — an
 * in-memory limiter would hand every instance its own budget. The database
 * owns the limit policy; routes choose only the scope and the identity.
 *
 * Identities are hashed before they leave the route, so the internal table
 * stores pseudonymous bucket keys, not emails or IP addresses.
 *
 * Failure posture: if the limiter itself fails (e.g. the migration has not
 * been applied yet), the request is allowed and the failure is logged. The
 * app stays available; Supabase Auth's own limits still backstop the auth
 * routes, and RLS still constrains every write. The limiter denies only on a
 * definitive "allowed = false" answer.
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
    const supabase = await getSupabase();
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
    // Fail open: an unavailable limiter must not take the app down with it.
    console.error("[rate-limit]", scope, err instanceof Error ? err.message : "unknown");
    return null;
  }
}

/** Rate-limit an authenticated action by the verified user id. */
export function rateLimitUser(scope: string, userId: string): Promise<NextResponse | null> {
  return hit(scope, `user:${userId}`);
}

/**
 * Best-effort source IP. Vercel sets x-forwarded-for; the first hop is the
 * client. Treated as a secondary signal only — absent locally and in some
 * proxies, and spoofable where the platform does not overwrite it, which is
 * why IP limits sit alongside (never instead of) identity limits.
 */
export function clientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (!forwarded) return null;
  const ip = forwarded.split(",")[0]?.trim();
  return ip && ip.length <= 64 ? ip : null;
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
