import { NextRequest } from "next/server";
import { getSupabase } from "@/db";
import { checkDb, handler, requireMember } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const supabase = await getSupabase();
  const membership = await requireMember(id, supabase);

  // The three reads below do not depend on each other, so they run together.
  // The member read used to run after this batch, which put a second database
  // round trip in front of every standings page load.
  const [standingsResp, historyResp, membersResp] = await Promise.all([
    supabase.rpc("ff_display_standings", { p_league: id }).order("rank"),
    // The scoped RPC returns the same history rows (with the match title,
    // kickoff and profile names already joined) that the direct table read
    // returned, but checks the caller's membership once per request instead
    // of once per scanned row.
    supabase.rpc("ff_league_points_history", { p_league: id, p_limit: 200 }),
    // The standings row already carries the display name, username and
    // avatar, so only the team name and the role are still missing.
    supabase.from("league_members").select("profile_id,role,team_name").eq("league_id", id),
  ]);
  for (const result of [standingsResp, historyResp, membersResp]) checkDb(result.error, "Could not load league standings");
  const members = new Map((membersResp.data ?? []).map((m: any) => [m.profile_id, m]));
  const rows = (standingsResp as any)?.data ?? [];
  const history = (historyResp as any)?.data ?? [];

  return Response.json({
    provisional: rows.some((row: { provisional: boolean }) => row.provisional),
    standings: rows.map((s: any) => ({
      profileId: s.profile_id,
      rank: s.rank,
      prevRank: s.prev_rank,
      totalPoints: Number(s.total_points),
      livePoints: Number(s.live_points ?? 0),
      matchesPlayed: s.matches_played,
      form: s.form,
      username: s.profiles?.username,
      displayName: s.profiles?.display_name,
      avatarUrl: s.profiles?.avatar_url,
      teamName: members.get(s.profile_id)?.team_name ?? null,
      role: members.get(s.profile_id)?.role ?? "manager",
    })),
    history: (history ?? []).map((h: any) => ({
      matchId: h.match_id,
      gameweek: h.gameweek,
      points: h.points,
      matchTitle: h.match_title,
      kickOff: h.kick_off,
      profileId: h.profile_id,
      displayName: h.display_name,
      username: h.username,
    })),
    you: membership.profileId,
  });
});
