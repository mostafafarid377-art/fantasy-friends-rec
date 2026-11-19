import { NextRequest } from "next/server";
import { getSupabase } from "@/db";
import { ApiError, handler, requireMember, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const leagueId = new URL(req.url).searchParams.get("leagueId");
  if (!leagueId) throw new ApiError("leagueId is required", 400);
  const membership = await requireMember(leagueId);

  const supabase = await getSupabase();

  const [squadResult, standingsResult, fixturesResult, matchesResult, notesResult, rulesResult, unreadResult] =
    await Promise.all([
      supabase
        .from("fantasy_squads")
        .select("*")
        .eq("league_id", leagueId)
        .eq("profile_id", user.id)
        .limit(1),
      supabase
        .from("league_standings")
        .select("*, profiles(display_name, username)")
        .eq("league_id", leagueId)
        .order("rank", { ascending: true }),
      supabase
        .from("fantasy_fixtures")
        .select("*")
        .eq("league_id", leagueId)
        .order("gameweek", { ascending: false })
        .limit(8),
      supabase
        .from("real_matches")
        .select("*")
        .eq("league_id", leagueId)
        .order("kick_off", { ascending: false })
        .limit(6),
      supabase
        .from("notifications")
        .select("*")
        .eq("profile_id", user.id)
        .order("created_at", { ascending: false })
        .limit(6),
      supabase.from("scoring_rules").select("*").eq("league_id", leagueId),
      supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .eq("profile_id", user.id)
        .is("read_at", null),
    ]);

  const squad = squadResult.data?.[0] ?? null;

  let squadPlayers: {
    playerId: string;
    slot: string;
    order: number;
    fullName: string | null;
    position: string | null;
    photoUrl: string | null;
  }[] = [];
  if (squad) {
    const { data: playersRows } = await supabase
      .from("fantasy_squad_players")
      .select(
        "player_id, slot, \"order\", players(full_name, position, photo_url)",
      )
      .eq("squad_id", squad.id)
      .order("order", { ascending: true });

    squadPlayers = (playersRows ?? []).map((p: any) => ({
      playerId: p.player_id,
      slot: p.slot,
      order: p.order,
      fullName: p.players?.full_name ?? null,
      position: p.players?.position ?? null,
      photoUrl: p.players?.photo_url ?? null,
    }));
  }

  const matchIds = (matchesResult.data ?? []).map((m: any) => m.id);
  const [eventsResult] = await Promise.all([
    matchIds.length
      ? supabase
          .from("match_events")
          .select("*")
          .in("match_id", matchIds)
          .order("minute", { ascending: false })
          .limit(40)
      : { data: [] },
  ]);

  const rulesApproved = Boolean(
    rulesResult.data?.length && rulesResult.data.every((r: any) => r.status === "approved"),
  );

  const teamNameMap = new Map(
    (membership.league?.members ?? []).map((m: any) => [m.profile_id, m.team_name]),
  );

  return Response.json({
    league: {
      id: membership.league.id,
      name: membership.league.name,
      format: membership.league.format,
      starters: membership.league.starters,
      subsCount: membership.league.subs_count,
      squadSize: membership.league.subs_count + membership.league.starters,
      inviteCode: membership.league.invite_code,
      role: membership.role,
    },
    squad: squad
      ? {
          id: squad.id,
          formation: squad.formation,
          captainId: squad.captain_id,
          viceCaptainId: squad.vice_captain_id,
          players: squadPlayers,
          size: squadPlayers.length,
          starters: squadPlayers.filter((p) => p.slot === "starter").length,
          subs: squadPlayers.filter((p) => p.slot === "sub").length,
          complete: squadPlayers.length === membership.league.starters + membership.league.subs_count,
        }
      : null,
    standings: (standingsResult.data ?? []).map((s: any) => ({
      profileId: s.profile_id,
      rank: s.rank,
      prevRank: s.prev_rank,
      totalPoints: s.total_points,
      matchesPlayed: s.matches_played,
      form: s.form,
      displayName: s.profiles?.display_name,
      username: s.profiles?.username,
      teamName: teamNameMap.get(s.profile_id) ?? null,
    })),
    myRank:
      (standingsResult.data ?? []).find((s: any) => s.profile_id === user.id)?.rank ?? null,
    myPoints:
      (standingsResult.data ?? []).find((s: any) => s.profile_id === user.id)?.total_points ?? "0",
    fixtures: (fixturesResult.data ?? []).slice(0, 5),
    matches: (matchesResult.data ?? []).map((m: any) => ({
      ...m,
      eventCount: (eventsResult.data ?? []).filter((e: any) => e.match_id === m.id).length,
    })),
    recentEvents: (eventsResult.data ?? []).slice(0, 12),
    notifications: notesResult.data ?? [],
    unread: unreadResult.count ?? 0,
    rulesApproved,
    memberCount: membership.league?.members?.length ?? 0,
    emailVerified: user.emailVerified,
  });
});
