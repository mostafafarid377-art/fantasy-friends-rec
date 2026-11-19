import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

function safeNextPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/dashboard";
  return value;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNextPath(url.searchParams.get("next"));
  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(new URL(`/login?auth_error=${encodeURIComponent("The link is invalid or expired")}`, url.origin));
    }
  } else {
    // PKCE code exchange is the expected confirmation/recovery flow.
    return NextResponse.redirect(new URL("/login?auth_error=Missing+confirmation+code", url.origin));
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
