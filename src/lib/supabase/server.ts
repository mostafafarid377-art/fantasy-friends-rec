import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authCookieOptions, unreadableAuthCookies } from "./auth-cookies";
import { getSupabasePublicConfig } from "./config";

export async function createClient(oauth?: { secure: boolean }) {
  const { url, publishableKey } = getSupabasePublicConfig();
  const cookieStore = await cookies();
  const unreadable = await unreadableAuthCookies(url, cookieStore.getAll());
  for (const [name] of unreadable) {
    try { cookieStore.set(name, "", authCookieOptions(name, { maxAge: 0 }, oauth)); }
    catch { /* A Server Component cannot write cookies; proxy handles page requests. */ }
  }

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll().filter(({ name, value }) => unreadable.get(name) !== value);
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, authCookieOptions(name, options, oauth)),
          );
        } catch (error) {
          if (oauth) throw error;
          // Server Components cannot write cookies. The proxy refreshes them.
        }
      },
    },
  });
}
