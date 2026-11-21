import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { safeAuthPath } from "@/lib/auth-redirect";
import { authCookieOptions } from "@/lib/supabase/auth-cookies";
import { getSupabasePublicConfig } from "@/lib/supabase/config";

/**
 * Refreshes Supabase Auth cookies for Next.js 16.
 * API handlers use writable request-scoped cookies directly. Page renders
 * need the proxy to persist rotated tokens before Server Components run.
 */
export async function proxy(request: NextRequest) {
  let config: ReturnType<typeof getSupabasePublicConfig>;
  try {
    config = getSupabasePublicConfig();
  } catch {
    return NextResponse.next({ request });
  }

  const pending = new Map<string, { value: string; options: CookieOptions }>();
  const withCookies = (response: NextResponse) => {
    for (const [name, { value, options }] of pending) response.cookies.set(name, value, options);
    if (pending.size) response.headers.set("Cache-Control", "private, no-store");
    return response;
  };
  const supabase = createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          if (options.maxAge === 0) request.cookies.delete(name);
          else request.cookies.set(name, value);
          pending.set(name, { value, options: authCookieOptions(name, options) });
        }
      },
    },
  });

  const { pathname, searchParams } = request.nextUrl;
  if ((pathname === "/" || pathname === "/login") && !searchParams.has("auth_error")) {
    // Verify with Auth, rather than trusting a cookie or JWT alone to redirect.
    // This avoids sending a revoked session back to a protected route in a loop.
    const { data, error } = await supabase.auth.getUser();
    if (!error && data.user) {
      const next = pathname === "/login" ? safeAuthPath(searchParams.get("next")) : "/dashboard";
      const destination = /^\/login\/?(?:[?#]|$)/.test(next) ? "/dashboard" : next;
      return withCookies(new NextResponse(null, { status: 307, headers: { Location: destination, "Cache-Control": "private, no-store" } }));
    }
  } else {
    await supabase.auth.getClaims();
  }
  return withCookies(NextResponse.next({ request }));
}

export const config = {
  matcher: [
    "/((?!api/|auth/callback(?:/|$)|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
