import { createClient } from "@/lib/supabase/server";

// Use the same request-scoped cookie storage as all sign-in routes. Never
// share the Supabase client or its cookie store between requests.
export async function getSupabase() {
  return createClient();
}

export type SupabaseClient = Awaited<ReturnType<typeof getSupabase>>;
