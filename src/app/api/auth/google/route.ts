import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { GOOGLE_START_FIELD } from "@/lib/google-sign-in";
import { safeAuthPath } from "@/lib/auth-redirect";
import { authRedirect, GOOGLE_CALLBACK, GOOGLE_FLOW_COOKIE, googleAppOrigin, googleCookieOptions, googleError, googleFlowId, googleRequestOrigin, googleStartCookieName, googleStartTokenPattern } from "@/lib/supabase/google-oauth";

export function OPTIONS() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const configured = googleAppOrigin();
  if (!configured) return googleError("google_unavailable", "/dashboard");
  const origin = googleRequestOrigin(request, configured);
  if (!origin || !request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return googleError("google_start_failed", "/dashboard");
  }
  // Some browsers omit navigation headers. A nonce matching the cookie issued
  // to the form proves the request came from this browser on this host.
  const statedOrigin = request.headers.get("origin");
  if (statedOrigin && statedOrigin !== "null" && statedOrigin !== origin) return googleError("google_start_failed", "/dashboard");
  const form = await request.formData().catch(() => null);
  const target = form?.get("next");
  const next = safeAuthPath(typeof target === "string" ? target : null);
  const secure = origin.startsWith("https:");
  const cookie = request.cookies.get(googleStartCookieName(secure))?.value ?? "";
  const token = form?.get(GOOGLE_START_FIELD);
  if (typeof token !== "string" || !googleStartTokenPattern.test(token) || !googleStartTokenPattern.test(cookie)
      || !timingSafeEqual(Buffer.from(token), Buffer.from(cookie))) {
    return googleError("google_start_failed", next);
  }

  try {
    const supabase = await createClient({ secure });
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${origin}${GOOGLE_CALLBACK}`, skipBrowserRedirect: true, queryParams: { prompt: "select_account" } },
    });
    if (error || !data.url || !data.flowId || !googleFlowId.test(data.flowId)) return googleError("google_unavailable", next);
    const authorize = new URL(data.url);
    const expected = new URL(`${getSupabasePublicConfig().url}/auth/v1/authorize`);
    if (authorize.origin !== expected.origin || authorize.pathname !== expected.pathname || authorize.username || authorize.password) {
      return googleError("google_unavailable", next);
    }
    const response = authRedirect(authorize.href);
    // Carry the SDK flow ID in a cookie so the Supabase allowlist can use an exact callback URL.
    response.cookies.set(GOOGLE_FLOW_COOKIE, `${data.flowId}:${next}`, googleCookieOptions(origin, 600));
    return response;
  } catch {
    return googleError("google_unavailable", next);
  }
}
