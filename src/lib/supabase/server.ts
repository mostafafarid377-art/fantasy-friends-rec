import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
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
            cookieStore.set(name, value, oauth && /-code-verifier(?:\.\d+)?$/.test(name)
              ? { ...options, httpOnly: true, secure: oauth.secure, maxAge: options.maxAge === 0 ? 0 : 600 }
              : options),
          );
        } catch (error) {
          if (oauth) throw error;
          // Server Components cannot write cookies. The proxy refreshes them.
        }
      },
    },
  });
}
