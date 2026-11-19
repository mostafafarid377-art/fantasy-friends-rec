import { getSupabase } from "@/db";
import { getSessionProfile } from "@/lib/auth";
import { checkDb } from "@/lib/db-result";
import type { SessionPayload } from "@/lib/client/api";

export async function getSessionSnapshot(): Promise<SessionPayload> {
  const sb = await getSupabase();
  const user = await getSessionProfile(sb);
  if (!user) return { user: null, leagues: [], unread: 0 };
  const [memberships, standings, unread] = await Promise.all([
    sb.from("league_members")
      .select("league_id,role,team_name,leagues(id,name,format,starters,subs_count,invite_code)")
      .eq("profile_id", user.id).order("created_at").order("league_id"),
    sb.from("league_standings").select("league_id,rank,total_points").eq("profile_id", user.id),
    sb.from("notifications").select("id", { count: "exact", head: true })
      .eq("profile_id", user.id).is("read_at", null),
  ]);
  checkDb(memberships.error, "Could not load your leagues");
  checkDb(standings.error, "Could not load your standings");
  checkDb(unread.error, "Could not load unread notifications");
  const byLeague = new Map((standings.data ?? []).map((s) => [s.league_id, s]));
  return {
    user, unread: unread.count ?? 0,
    leagues: (memberships.data ?? []).flatMap((m: any) => !m.leagues ? [] : [{
      id: m.leagues.id, name: m.leagues.name, format: m.leagues.format, starters: m.leagues.starters,
      subsCount: m.leagues.subs_count, inviteCode: m.leagues.invite_code, role: m.role, teamName: m.team_name,
      rank: byLeague.get(m.league_id)?.rank ?? null, totalPoints: byLeague.get(m.league_id)?.total_points ?? null,
    }]),
  };
}
