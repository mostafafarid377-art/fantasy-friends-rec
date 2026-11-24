import { NextResponse, type NextRequest } from "next/server";

export const GOOGLE_CALLBACK = "/auth/callback/google";
export const GOOGLE_FLOW_COOKIE = "ff-google-flow";
export const googleFlowId = /^[a-f0-9]{32}$/;

/** Opt in on one canonical origin per deployment. Do not derive it from proxy headers. */
export function googleAppOrigin(): string | null {
  const configured = process.env.GOOGLE_OAUTH_APP_ORIGIN;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Known browser-facing production origins. The first is the canonical domain;
// the legacy domain is kept so redirects and rollback keep working. Neither is
// derived from proxy headers — only an exact host match below selects one.
const stableProductionOrigins = [
  "https://fantasyfriends.vercel.app",
  "https://fantasy-friends-rec.vercel.app",
];

/** Select only a known browser-facing host. Host identifies the request target,
 * not its initiator. Neither Origin nor X-Forwarded-* can nominate a callback. */
export function googleRequestOrigin(request: NextRequest, configured: string): string | null {
  const allowed = process.env.VERCEL_ENV === "production" ? [configured, ...stableProductionOrigins] : [configured];
  const host = (request.headers.get("host") ?? request.nextUrl.host).toLowerCase();
  return allowed.find((origin) => new URL(origin).host === host) ?? null;
}

export const googleStartTokenPattern = /^[a-f0-9]{64}$/;
export const googleStartCookieName = (secure: boolean) => secure ? "__Host-ff-google-start" : "ff-google-start";

export function newGoogleStartToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function googleStartCookieOptions(secure: boolean) {
  return { secure, httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 24 * 60 * 60 };
}

export function googleCookieOptions(origin: string, maxAge: number) {
  return { path: GOOGLE_CALLBACK, maxAge, ...(maxAge === 0 ? { expires: new Date(0) } : {}),
    httpOnly: true, sameSite: "lax" as const, secure: origin.startsWith("https:") };
}

// Relative Locations keep the callback on the browser's origin, including behind a proxy.
export function authRedirect(location: string) {
  return new NextResponse(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

export function googleError(error: "google_unavailable" | "google_cancelled" | "google_failed" | "google_start_failed", next: string) {
  const params = new URLSearchParams({ auth_error: error });
  if (next !== "/dashboard") params.set("next", next);
  return authRedirect(`/login?${params}`);
}
