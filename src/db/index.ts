import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabasePublicConfig } from "@/lib/supabase/config";

/**
 * Create a fresh Supabase server client on every call.
 *
 * IMPORTANT: Do NOT cache the client as a module-level singleton. The
 * `cookies()` store is request-scoped in Next.js; caching the client would
 * capture the first request's cookies and replay them for every subsequent
 * request, causing user sessions to leak across requests.
 *
 * Identity is resolved from the session cookie via Supabase Auth.
 * No DATABASE_URL required.
 */
export async function getSupabase() {
  const { url, publishableKey } = getSupabasePublicConfig();
  const cookieStore = await cookies();
  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Server Components cannot write cookies.
        }
      },
    },
  });
}

export type SupabaseClient = Awaited<ReturnType<typeof getSupabase>>;
