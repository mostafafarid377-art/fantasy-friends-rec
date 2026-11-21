import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { safeAuthPath } from "@/lib/auth-redirect";
import { authRedirect, GOOGLE_CALLBACK, GOOGLE_FLOW_COOKIE, googleAppOrigin, googleCookieOptions, googleError, googleFlowId, googleRequestOrigin, isGoogleStartFetch, isGoogleStartFromApp } from "@/lib/supabase/google-oauth";

// Never permit a cross-origin browser to send the sign-in start header.
export function OPTIONS() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const fetchStart = isGoogleStartFetch(request);
  const noStore = { headers: { "Cache-Control": "no-store" } };
  const fail = (error: "google_unavailable" | "google_start_failed", status: number, next = "/dashboard") =>
    fetchStart ? NextResponse.json({ error }, { ...noStore, status }) : googleError(error, next);
  const configured = googleAppOrigin();
  if (!configured) return fail("google_unavailable", 503);
  const origin = googleRequestOrigin(request, configured);
  if (!origin || !isGoogleStartFromApp(request, origin)) return fail("google_start_failed", 403);
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return fail("google_start_failed", 415);
  const form = await request.formData().catch(() => null);
  if (!form) return fail("google_start_failed", 400);
  const target = form.get("next");
  const next = safeAuthPath(typeof target === "string" ? target : null);

  try {
    const supabase = await createClient({ secure: origin.startsWith("https:") });
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${origin}${GOOGLE_CALLBACK}`, skipBrowserRedirect: true, queryParams: { prompt: "select_account" } },
    });
    if (error || !data.url || !data.flowId || !googleFlowId.test(data.flowId)) return fail("google_unavailable", 503, next);
    const authorize = new URL(data.url);
    const expected = new URL(`${getSupabasePublicConfig().url}/auth/v1/authorize`);
    if (authorize.origin !== expected.origin || authorize.pathname !== expected.pathname || authorize.username || authorize.password) {
      return fail("google_unavailable", 503, next);
    }
    const response = fetchStart ? NextResponse.json({ location: authorize.href }, noStore) : authRedirect(authorize.href);
    // Carry the SDK flow ID in a cookie so the Supabase allowlist can use an exact callback URL.
    response.cookies.set(GOOGLE_FLOW_COOKIE, `${data.flowId}:${next}`, googleCookieOptions(origin, 600));
    return response;
  } catch {
    return fail("google_unavailable", 503, next);
  }
}
