import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
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

  let response = NextResponse.next({ request });
  const supabase = createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  await supabase.auth.getClaims();
  return response;
}

export const config = {
  matcher: [
    "/((?!api/|auth/callback(?:/|$)|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
