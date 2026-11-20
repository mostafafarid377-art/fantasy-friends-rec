import { NextResponse } from "next/server";

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

export function googleCookieOptions(origin: string, maxAge: number) {
  return { path: GOOGLE_CALLBACK, maxAge, httpOnly: true, sameSite: "lax" as const, secure: origin.startsWith("https:") };
}

// Relative Locations keep the callback on the browser's origin, including behind a proxy.
export function authRedirect(location: string) {
  return new NextResponse(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

export function googleError(error: "google_unavailable" | "google_cancelled" | "google_failed", next: string) {
  const params = new URLSearchParams({ auth_error: error });
  if (next !== "/dashboard") params.set("next", next);
  return authRedirect(`/login?${params}`);
}
