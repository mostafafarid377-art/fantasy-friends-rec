import { NextRequest } from "next/server";
import { getSupabase } from "@/db";
import { handler, memberProfiles, requireMember } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);
  const supabase = await getSupabase();

  const [standingsResp, historyResp, ledgerResp] = await Promise.all([
    supabase
      .from("league_standings")
      .select("*, profiles(username, display_name, avatar_url)")
      .eq("league_id", id)
      .order("rank", { ascending: true }),
    supabase
      .from("fantasy_points_history")
      .select("*, real_matches(title, kick_off), profiles(username, display_name)")
      .eq("league_id", id)
      .order("created_at", { ascending: true })
      .limit(200),
    supabase
      .from("manager_points")
      .select("profile_id, match_id, points, computed_at, breakdown")
      .eq("league_id", id),
  ]);
  const members = await memberProfiles(id);
  const rows = (standingsResp as any)?.data ?? [];
  const history = (historyResp as any)?.data ?? [];
  const ledger = (ledgerResp as any)?.data ?? [];

  return Response.json({
    standings: rows.map((s: any) => ({
      profileId: s.profile_id,
      rank: s.rank,
      prevRank: s.prev_rank,
      totalPoints: s.total_points,
      matchesPlayed: s.matches_played,
      form: s.form,
      username: s.profiles?.username,
      displayName: s.profiles?.display_name,
      avatarUrl: s.profiles?.avatar_url,
      teamName: members.find((m: any) => m.profileId === s.profile_id)?.teamName ?? null,
      role: members.find((m: any) => m.profileId === s.profile_id)?.role ?? "manager",
    })),
    history: (history ?? []).map((h: any) => ({
      matchId: h.match_id,
      gameweek: h.gameweek,
      points: h.points,
      matchTitle: h.real_matches?.title,
      kickOff: h.real_matches?.kick_off,
      profileId: h.profile_id,
      displayName: h.profiles?.display_name,
      username: h.profiles?.username,
    })),
    ledger: ledger ?? [],
    you: membership.profileId,
  });
});