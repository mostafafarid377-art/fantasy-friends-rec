import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { safeAuthPath } from "@/lib/auth-redirect";
import { authRedirect, GOOGLE_CALLBACK, GOOGLE_FLOW_COOKIE, googleAppOrigin, googleCookieOptions, googleError, googleFlowId, googleRequestOrigin, isGoogleStartFromApp } from "@/lib/supabase/google-oauth";

export async function POST(request: NextRequest) {
  const configured = googleAppOrigin();
  if (!configured) return googleError("google_unavailable", "/dashboard");
  const origin = googleRequestOrigin(request, configured);
  if (!origin || !isGoogleStartFromApp(request, origin)) {
    return new NextResponse("Start Google sign-in from the Fantasy Friends sign-in page.", {
      status: 403, headers: { "Cache-Control": "no-store" },
    });
  }
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return new NextResponse("Invalid sign-in request.", { status: 415, headers: { "Cache-Control": "no-store" } });
  }
  const form = await request.formData().catch(() => null);
  const target = form?.get("next");
  const next = safeAuthPath(typeof target === "string" ? target : null);

  try {
    const supabase = await createClient({ secure: origin.startsWith("https:") });
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
