import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { safeAuthPath } from "@/lib/auth-redirect";
import { authCookieOptions, unreadableAuthCookies } from "@/lib/supabase/auth-cookies";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { googleAppOrigin, googleRequestOrigin, googleStartCookieName, googleStartCookieOptions, googleStartTokenPattern, newGoogleStartToken } from "@/lib/supabase/google-oauth";

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
  for (const [name] of await unreadableAuthCookies(config.url, request.cookies.getAll())) {
    request.cookies.delete(name);
    pending.set(name, { value: "", options: authCookieOptions(name, { maxAge: 0 }) });
  }
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
  try {
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
  } catch {
    // A failed Auth check never grants access. Public pages can still render;
    // protected pages and APIs verify their own session independently.
    // Do not delete a readable session merely because Auth was unavailable.
  }
  // Mint the nonce before rendering, so the browser receives the same value
  // in its host-only cookie and in the form without an extra fetch.
  const googleConfigured = (pathname === "/login" || pathname === "/signup") && request.method === "GET" ? googleAppOrigin() : null;
  const googleOrigin = googleConfigured && googleRequestOrigin(request, googleConfigured);
  if (googleOrigin) {
    const secure = googleOrigin.startsWith("https:");
    const name = googleStartCookieName(secure);
    if (!googleStartTokenPattern.test(request.cookies.get(name)?.value ?? "")) {
      const value = newGoogleStartToken();
      request.cookies.set(name, value);
      pending.set(name, { value, options: googleStartCookieOptions(secure) });
    }
  }
  const response = withCookies(NextResponse.next({ request }));
  if (googleOrigin) response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: [
    "/((?!api/|auth/callback(?:/|$)|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
