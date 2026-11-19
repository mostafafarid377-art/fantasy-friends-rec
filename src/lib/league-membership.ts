import type { SupabaseClient } from "@/db";
import { ApiError, checkDb } from "@/lib/db-result";

export async function confirmLeagueMembership(supabase: SupabaseClient, id: unknown, actor: string) {
  if (typeof id !== "string" || !id) throw new ApiError("No league ID was confirmed", 409);
  const { data, error } = await supabase.from("league_members")
    .select("profile_id, role, leagues(id,name,format,starters,subs_count,invite_code)")
    .eq("league_id", id).eq("profile_id", actor).maybeSingle();
  checkDb(error, "Could not confirm league membership");
  // The PostgREST FK embeds one league for each membership.
  const league = data?.leagues as unknown as { id: string; name: string; format: string } | null;
  if (!league || league.id !== id || data?.profile_id !== actor) {
    throw new ApiError("The league membership could not be confirmed", 409);
  }
  return league;
}
