import { getSupabase, type SupabaseClient } from "@/db";

import { checkDb } from "@/lib/db-result";

export async function loadMatch(matchId: string, supabase?: SupabaseClient) {
  supabase ??= await getSupabase();
  const { data, error } = await supabase
    .from("real_matches")
    .select("*")
    .eq("id", matchId)
    .maybeSingle();
  checkDb(error, "Could not load match");
  return data ?? null;
}