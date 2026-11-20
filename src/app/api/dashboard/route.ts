import { NextRequest } from "next/server";
import { getSupabase } from "@/db";
import { ApiError, checkDb, handler, leagueRules, requireMember } from "@/lib/server";

import { playerPhotoUrl } from "@/lib/player-photo";
import type { SquadEntry } from "@/lib/squad";
import { deriveFormation, validateSquad, type Position, type SquadPlayer } from "@/lib/domain";

export const dynamic = "force-dynamic";
export const GET = handler(async (req: NextRequest) => {
  const leagueId = new URL(req.url).searchParams.get("leagueId");
  if (!leagueId) throw new ApiError("leagueId is required", 400);
  const sb = await getSupabase();
  const membership = await requireMember(leagueId, sb);
  const user = membership.profileId;
  const [squad, standings, fixtures, matches, notes, rules, members, lastGame] = await Promise.all([
    sb.from("fantasy_squads").select(
      "id,formation,captain_id,vice_captain_id,completed_at,fantasy_squad_players(player_id,slot,order,players(full_name,position,status,photo_url,team_id,shirt_number,availability,league_id))",
    ).eq("league_id", leagueId).eq("profile_id", user).maybeSingle(),
    sb.from("league_standings").select("profile_id,rank,prev_rank,total_points,matches_played,profiles(display_name)")
      .eq("league_id", leagueId).or(`rank.lte.8,profile_id.eq.${user}`).order("rank").order("profile_id"),
    sb.from("fantasy_fixtures").select("id,title,gameweek,scheduled_at,status")
      .eq("league_id", leagueId).order("gameweek", { ascending: false }).order("scheduled_at", { ascending: false }).limit(4),
    sb.from("real_matches").select("id,title,status,kick_off,match_events(count)")
      .eq("league_id", leagueId).order("kick_off", { ascending: false }).limit(4),
    sb.from("notifications").select("id,title,body,read_at,created_at")
      .eq("profile_id", user).eq("league_id", leagueId).order("created_at", { ascending: false }).limit(4),
    sb.from("scoring_rules").select("status").eq("league_id", leagueId),
    sb.from("league_members").select("profile_id,team_name", { count: "exact" }).eq("league_id", leagueId),
    sb.rpc("last_game_points", { p_league: leagueId }).maybeSingle<{ matchId: string; title: string; points: number | null }>(),
  ]);
  for (const result of [squad, standings, fixtures, matches, notes, rules, members, lastGame]) {
    checkDb(result.error, "Could not load dashboard");
  }
  const names = new Map((members.data ?? []).map((m) => [m.profile_id, m.team_name]));
  const myStanding = standings.data?.find((s) => s.profile_id === user);
  const entries = (squad.data?.fantasy_squad_players ?? []) as unknown as {
    player_id: string; slot: SquadPlayer["slot"]; order: number;
    players: { full_name: string; position: Position; status: string; photo_url: string | null; team_id: string | null; shirt_number: number | null; availability: string; league_id: string } | null;
  }[];
  const league = membership.league;
  const settings = leagueRules(league);
  const players: SquadEntry[] = entries.flatMap((p) => p.players?.league_id === leagueId ? [{
    id: p.player_id, slot: p.slot, order: p.order, name: p.players.full_name, position: p.players.position, status: p.players.status, teamId: p.players.team_id,
    shirtNumber: p.players.shirt_number, availability: p.players.availability, photoUrl: playerPhotoUrl(p.players.photo_url, leagueId, p.player_id),
  }] : []).sort((a,b) => a.order-b.order || a.id.localeCompare(b.id));
  const shape = deriveFormation(settings, players, squad.data?.formation);
  const complete = Boolean(squad.data?.completed_at && shape && entries.every((p) => p.players?.status === "active") &&
    validateSquad(settings, players, { formation: shape.label, captainId: squad.data.captain_id, viceId: squad.data.vice_captain_id }).ok);
  return Response.json({
    league: { id: league.id, name: league.name, format: league.format, starters: league.starters, subsCount: league.subs_count, squadSize: league.squad_size, inviteCode: league.invite_code, role: membership.role },
    squad: squad.data && players.length > 0 ? { id: squad.data.id, formation: shape?.label ?? "—", captainId: squad.data.captain_id, viceCaptainId: squad.data.vice_captain_id,
      players, size: players.length, starters: players.filter((p) => p.slot === "starter").length,
      subs: players.filter((p) => p.slot === "sub").length,
      complete } : null,
    standings: (standings.data ?? []).slice(0, 8).map((s: any) => ({
      profileId: s.profile_id, rank: s.rank, prevRank: s.prev_rank, totalPoints: s.total_points,
      matchesPlayed: s.matches_played, displayName: s.profiles?.display_name, teamName: names.get(s.profile_id) ?? null,
    })),
    myRank: myStanding?.rank ?? null, lastGame: lastGame.data,
    fixtures: (fixtures.data ?? []).map((r) => ({ id: r.id, title: r.title, gameweek: r.gameweek, scheduledAt: r.scheduled_at, status: r.status })),
    matches: (matches.data ?? []).map((r) => ({ id: r.id, title: r.title, status: r.status, kickOff: r.kick_off, eventCount: r.match_events?.[0]?.count ?? 0 })),
    notifications: (notes.data ?? []).map((r) => ({ id: r.id, title: r.title, body: r.body, readAt: r.read_at, createdAt: r.created_at })),
    rulesApproved: Boolean(rules.data?.length && rules.data.every((r) => r.status === "approved")),
    memberCount: members.count ?? 0, emailVerified: membership.emailVerified,
  });
});
