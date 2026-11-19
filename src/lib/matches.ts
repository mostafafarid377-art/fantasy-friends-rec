import { getSupabase } from "@/db";

export async function loadMatch(matchId: string) {
  const supabase = await getSupabase();
  const { data } = await supabase
    .from("real_matches")
    .select("*")
    .eq("id", matchId)
    .maybeSingle();
  return data ?? null;
}