import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeAuthPath } from "@/lib/auth-redirect";
import { authRedirect } from "@/lib/supabase/google-oauth";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  if (!code) return authRedirect("/login?auth_error=email_missing_code");

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.session) return authRedirect(safeAuthPath(params.get("next")));
  } catch {
    // Show an actionable message without forwarding provider errors.
  }
  return authRedirect("/login?auth_error=email_invalid_link");
}
