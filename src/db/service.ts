import { createClient } from "@supabase/supabase-js";
import { normalizeSupabaseUrl } from "@/lib/supabase/config";

/**
 * The service-role client.
 *
 * It bypasses row level security, so it is only used by the server-side
 * deadline runner. The key is a server-only environment variable: it is not
 * a `NEXT_PUBLIC_` one, so it can never be inlined into the browser bundle.
 *
 * The runner needs it because the promotion is internal to the database: it
 * is revoked from `anon`, `authenticated` and `public`, and only the
 * `service_role` role may call it.
 *
 * Two names are accepted for the key. `SUPABASE_SERVICE_ROLE_KEY` is the
 * legacy `service_role` JWT, `SUPABASE_SECRET_KEY` is the newer `sb_secret_`
 * key. Both map to the same database role.
 */
export async function getServiceSupabase() {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!rawUrl) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  return createClient(normalizeSupabaseUrl(rawUrl), serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
