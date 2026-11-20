import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeAuthPath } from "@/lib/auth-redirect";
import { authRedirect, GOOGLE_FLOW_COOKIE, googleAppOrigin, googleCookieOptions, googleError, googleFlowId } from "@/lib/supabase/google-oauth";

export async function GET(request: NextRequest) {
  const origin = googleAppOrigin();
  if (!origin) return googleError("google_unavailable", "/dashboard");

  const pending = request.cookies.get(GOOGLE_FLOW_COOKIE)?.value ?? "";
  const flowId = pending.slice(0, 32);
  const next = safeAuthPath(pending.slice(33));
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const clear = (response: ReturnType<typeof authRedirect>) => {
    response.cookies.set(GOOGLE_FLOW_COOKIE, "", googleCookieOptions(origin, 0));
    return response;
  };

  if (!googleFlowId.test(flowId) || pending[32] !== ":") return clear(googleError("google_failed", "/dashboard"));
  if (params.has("error") || params.has("error_code") || params.has("error_description") || !code) {
    return clear(googleError(params.get("error") === "access_denied" ? "google_cancelled" : "google_failed", next));
  }
  try {
    const supabase = await createClient({ secure: origin.startsWith("https:") });
    const { data, error } = await supabase.auth.exchangeCodeForSession(code, { flowId });
    if (!error && data.session && data.user) return clear(authRedirect(next));
  } catch {
    // Do not expose provider details or the authorization code.
  }
  return clear(googleError("google_failed", next));
}
