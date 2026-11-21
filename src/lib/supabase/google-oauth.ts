import { NextResponse, type NextRequest } from "next/server";
import { GOOGLE_START_HEADER } from "@/lib/google-sign-in";

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

const stableProductionOrigin = "https://fantasy-friends-rec.vercel.app";

/** Select only a known browser-facing host. Host identifies the request target,
 * not its initiator. Neither Origin nor X-Forwarded-* can nominate a callback. */
export function googleRequestOrigin(request: NextRequest, configured: string): string | null {
  const allowed = process.env.VERCEL_ENV === "production" ? [configured, stableProductionOrigin] : [configured];
  const host = (request.headers.get("host") ?? request.nextUrl.host).toLowerCase();
  return allowed.find((origin) => new URL(origin).host === host) ?? null;
}

export function isGoogleStartFetch(request: NextRequest): boolean {
  return request.headers.get(GOOGLE_START_HEADER) === "1";
}

export function isGoogleStartFromApp(request: NextRequest, targetOrigin: string): boolean {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const mode = request.headers.get("sec-fetch-mode");
  const destination = request.headers.get("sec-fetch-dest");
  if (site !== null && site !== "same-origin") return false;
  if (origin !== null && origin !== "null" && origin !== targetOrigin) return false;
  // Browser forms cannot set the custom header, and this route does not allow
  // CORS (the header would require a successful cross-origin preflight).
  if (isGoogleStartFetch(request)) {
    return (mode === null || mode === "same-origin") && (destination === null || destination === "empty");
  }
  // Retain the native form for browsers with JavaScript disabled. A null or
  // missing Origin alone is not proof that the form came from this app.
  return origin === targetOrigin || (site === "same-origin" && mode === "navigate" && destination === "document");
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
