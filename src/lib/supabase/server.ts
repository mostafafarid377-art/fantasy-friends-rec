import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authCookieOptions } from "./auth-cookies";
import { getSupabasePublicConfig } from "./config";

export async function createClient(oauth?: { secure: boolean }) {
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
