import { NextRequest } from "next/server";
import { getSupabase } from "@/db";
import { ApiError, checkDb, handler, requireMember } from "@/lib/server";

export const dynamic = "force-dynamic";
export const GET = handler(async (req: NextRequest) => {
  const leagueId = new URL(req.url).searchParams.get("leagueId");
  if (!leagueId) throw new ApiError("leagueId is required", 400);
  const sb = await getSupabase();
  const membership = await requireMember(leagueId, sb);
  const user = membership.profileId;
  const [squad, standings, fixtures, matches, notes, rules, members] = await Promise.all([
    sb.from("fantasy_squads").select(
      "id,formation,captain_id,completed_at,fantasy_squad_players(player_id,slot,order,players(full_name,position))",
    ).eq("league_id", leagueId).eq("profile_id", user).maybeSingle(),
    sb.from("league_standings").select("profile_id,rank,prev_rank,total_points,matches_played,profiles(display_name)")
      .eq("league_id", leagueId).or(`rank.lte.8,profile_id.eq.${user}`).order("rank").order("profile_id"),
    sb.from("fantasy_fixtures").select("id,title,gameweek,scheduled_at,status")
      .eq("league_id", leagueId).order("gameweek", { ascending: false }).order("scheduled_at", { ascending: false }).limit(4),
    sb.from("real_matches").select("id,title,status,kick_off,match_events(count)")
      .eq("league_id", leagueId).order("kick_off", { ascending: false }).limit(4),
    sb.from("notifications").select("id,title,body,read_at,created_at")
      .eq("profile_id", user).order("created_at", { ascending: false }).limit(4),
    sb.from("scoring_rules").select("status").eq("league_id", leagueId),
    sb.from("league_members").select("profile_id,team_name", { count: "exact" }).eq("league_id", leagueId),
  ]);
  for (const result of [squad, standings, fixtures, matches, notes, rules, members]) {
    checkDb(result.error, "Could not load dashboard");
  }
  const names = new Map((members.data ?? []).map((m) => [m.profile_id, m.team_name]));
  const myStanding = standings.data?.find((s) => s.profile_id === user);
  const players = ((squad.data?.fantasy_squad_players ?? []) as any[]).map((p) => ({
    playerId: p.player_id, slot: p.slot, order: p.order,
    fullName: p.players?.full_name ?? null, position: p.players?.position ?? null,
  })).sort((a, b) => a.order - b.order);
  const league = membership.league;
  return Response.json({
    league: { id: league.id, name: league.name, format: league.format, starters: league.starters, inviteCode: league.invite_code, role: membership.role },
    squad: squad.data ? { id: squad.data.id, formation: squad.data.formation, captainId: squad.data.captain_id,
      players, size: players.length, starters: players.filter((p) => p.slot === "starter").length,
      subs: players.filter((p) => p.slot === "sub").length,
      complete: Boolean(squad.data.completed_at) && players.length === league.squad_size } : null,
    standings: (standings.data ?? []).slice(0, 8).map((s: any) => ({
      profileId: s.profile_id, rank: s.rank, prevRank: s.prev_rank, totalPoints: s.total_points,
      matchesPlayed: s.matches_played, displayName: s.profiles?.display_name, teamName: names.get(s.profile_id) ?? null,
    })),
    myRank: myStanding?.rank ?? null, myPoints: myStanding?.total_points ?? "0",
    fixtures: (fixtures.data ?? []).map((r) => ({ id: r.id, title: r.title, gameweek: r.gameweek, scheduledAt: r.scheduled_at, status: r.status })),
    matches: (matches.data ?? []).map((r) => ({ id: r.id, title: r.title, status: r.status, kickOff: r.kick_off, eventCount: r.match_events?.[0]?.count ?? 0 })),
    notifications: (notes.data ?? []).map((r) => ({ id: r.id, title: r.title, body: r.body, readAt: r.read_at, createdAt: r.created_at })),
    rulesApproved: Boolean(rules.data?.length && rules.data.every((r) => r.status === "approved")),
    memberCount: members.count ?? 0, emailVerified: membership.emailVerified,
  });
});
