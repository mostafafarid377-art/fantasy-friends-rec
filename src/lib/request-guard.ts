import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/db/service";
import { googleAppOrigin } from "@/lib/supabase/google-oauth";
import { turnstileSiteKey } from "@/lib/turnstile";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function clientIp(req: NextRequest): string {
  const raw =
    req.headers.get("x-vercel-forwarded-for") ??
    req.headers.get("x-forwarded-for") ??
    req.headers.get("x-real-ip") ??
    "";
  return raw.split(",")[0]?.trim() || "unknown";
}

/**
 * CSRF defence in depth on top of SameSite=Lax cookies. A browser always sends
 * `Origin` on a cross-site write, so a mismatching one is rejected. Requests
 * with no `Origin` (curl, cron jobs, server-to-server) carry no browser
 * cookies to abuse, and are allowed unless the browser says it is cross-site.
 */
export function isSameOriginWrite(req: NextRequest): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false; // includes the literal "null" origin
    }
    const allowed = new Set<string>();
    allowed.add((req.headers.get("host") ?? req.nextUrl.host).toLowerCase());
    const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
    if (forwarded) allowed.add(forwarded);
    const configured = googleAppOrigin();
    if (configured) allowed.add(new URL(configured).host);
    return allowed.has(originHost);
  }
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

export function crossSiteBlocked(): NextResponse {
  return NextResponse.json({ error: "Cross-site request blocked" }, { status: 403 });
}

/** Returns a 403 response for a cross-site write, otherwise null. */
export function guardWrite(req: NextRequest): NextResponse | null {
  return isSameOriginWrite(req) ? null : crossSiteBlocked();
}

/** True when a captcha challenge is configured but no token was supplied. */
export function captchaMissing(token: string | undefined | null): boolean {
  return Boolean(turnstileSiteKey()) && !token;
}

// ---- rate limiting -------------------------------------------------------

type Bucket = { count: number; reset: number };
const memory = new Map<string, Bucket>();

/** Per-instance fixed-window counter. Returns true while under the limit. */
export function memoryLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const bucket = memory.get(key);
  if (!bucket || bucket.reset <= now) {
    if (memory.size > 5000) {
      for (const [k, b] of memory) if (b.reset <= now) memory.delete(k);
    }
    memory.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

export function resetMemoryLimits(): void {
  memory.clear();
}

function serviceKeyConfigured(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY);
}

/** Shared counter in Postgres, so the limit holds across serverless instances. */
async function databaseLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  if (serviceKeyConfigured()) {
    try {
      const sb = await getServiceSupabase();
      const { data, error } = await sb.rpc("ff_rate_limit_hit", {
        p_key: key,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
      if (!error && typeof data === "boolean") return data;
      if (error) console.error("[rate-limit]", error.message);
    } catch (err) {
      console.error("[rate-limit]", err instanceof Error ? err.message : "failed");
    }
  }
  return memoryLimit(key, limit, windowSeconds * 1000);
}

export type LimitRule = {
  name: string;
  limit: number;
  windowSeconds: number;
  /** What is counted. Defaults to the client IP. Hashed before it is stored. */
  subject?: string;
};

function limitKey(req: NextRequest, rule: LimitRule): string {
  const subject = rule.subject ?? clientIp(req);
  return `${rule.name}:${createHash("sha256").update(subject).digest("hex").slice(0, 32)}`;
}

/** Applies every rule. Returns a 429 response when any limit is exceeded. */
export async function enforceLimits(req: NextRequest, rules: LimitRule[]): Promise<NextResponse | null> {
  for (const rule of rules) {
    const allowed = await databaseLimit(limitKey(req, rule), rule.limit, rule.windowSeconds);
    if (!allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please wait a few minutes and try again." },
        { status: 429, headers: { "Retry-After": String(rule.windowSeconds) } },
      );
    }
  }
  return null;
}

/** Cheap in-process limit for ordinary API writes (no database round trip). */
export function limitWrites(req: NextRequest): NextResponse | null {
  if (SAFE_METHODS.has(req.method)) return null;
  if (memoryLimit(`writes:${clientIp(req)}`, 120, 60_000)) return null;
  return NextResponse.json(
    { error: "Too many requests. Slow down and try again shortly." },
    { status: 429, headers: { "Retry-After": "60" } },
  );
}
