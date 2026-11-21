import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { authCookieOptions, unreadableAuthCookies } from "@/lib/supabase/auth-cookies";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { googleAppOrigin, googleRequestOrigin, googleStartCookieName, googleStartCookieOptions, googleStartTokenPattern, newGoogleStartToken } from "@/lib/supabase/google-oauth";

/**
 * Refreshes Supabase Auth cookies for Next.js 16.
 * API handlers use writable request-scoped cookies directly. Page renders
 * need the proxy to persist rotated tokens before Server Components run.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Never put an Auth network call or a session redirect in front of the
  // shared homepage. The page resumes a session in the background instead.
  if (pathname === "/") return NextResponse.next();

  let config: ReturnType<typeof getSupabasePublicConfig>;
  try {
    config = getSupabasePublicConfig();
  } catch {
    return NextResponse.next();
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
  const isSignInPage = pathname === "/login" || pathname === "/signup";
  if (!isSignInPage) {
    try {
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
      await supabase.auth.getClaims();
    } catch {
      // Protected pages and APIs verify their own session independently.
      // Do not delete a readable session merely because Auth was unavailable.
    }
  }
  // Mint the nonce before rendering, so the browser receives the same value
  // in its host-only cookie and in the form without an extra fetch.
  const googleConfigured = isSignInPage && request.method === "GET" ? googleAppOrigin() : null;
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
  // Forward request-header overrides only after a cookie actually changed.
  const response = withCookies(pending.size ? NextResponse.next({ request }) : NextResponse.next());
  if (googleOrigin) response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: [
    "/((?!$|api/|auth/callback(?:/|$)|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
