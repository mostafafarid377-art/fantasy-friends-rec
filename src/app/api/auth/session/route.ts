import { getSupabase } from "@/db";
import { getSessionProfile } from "@/lib/auth";
import { handler } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const user = await getSessionProfile();
  if (!user) return Response.json({ user: null, leagues: [], unread: 0 });

  const supabase = await getSupabase();

  const { data: memberships } = await supabase
    .from("league_members")
    .select("league_id, role, team_name, leagues(id, name, format, starters, subs_count, invite_code)")
    .eq("profile_id", user.id);

  const { data: standings } = await supabase
    .from("league_standings")
    .select("league_id, rank, total_points")
    .eq("profile_id", user.id);
  const byLeague = new Map<string, { rank: number; total_points: string }>(
    (standings ?? []).map((s: any) => [s.league_id, { rank: s.rank, total_points: s.total_points }]),
  );

  const { count: unread } = await supabase
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .eq("profile_id", user.id)
    .is("read_at", null);

  return Response.json({
    user,
    leagues: (memberships ?? []).map((m: any) => ({
      id: m.leagues.id,
      name: m.leagues.name,
      format: m.leagues.format,
      starters: m.leagues.starters,
      subsCount: m.leagues.subs_count,
      inviteCode: m.leagues.invite_code,
      role: m.role,
      teamName: m.team_name,
      rank: byLeague.get(m.league_id)?.rank ?? null,
      totalPoints: byLeague.get(m.league_id)?.total_points ?? null,
    })),
    unread: unread ?? 0,
  });
});
