import { teamLogoUrl } from "@/lib/team-logo";
import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, checkDb, handler, requireMember } from "@/lib/server";
import { playerPhotoUrl } from "@/lib/player-photo";
import { categoryLabel } from "@/lib/scoring";
import type { DisplayPlayerPoints } from "@/lib/live-points";
import type { PlayerGame, PlayerPerformance } from "@/lib/player-performance";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 20;
const cursor = z.object({ kickOff: z.iso.datetime({ offset: true }), matchId: z.string().min(1).max(128) });

type GameRow = { match_id: string; title: string; kick_off: string; gameweek: number | null; opponent: string | null;
  opponent_id?: string | null; opponent_crest?: string | null;
  participation: PlayerGame["participation"]; points: number | string | null; breakdown: PlayerGame["breakdown"] | null };

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string; playerId: string }> }) => {
  const { id, playerId } = await ctx.params;
  const sb = await getSupabase();
  await requireMember(id, sb);
  const kickOff = req.nextUrl.searchParams.get("before");
  const matchId = req.nextUrl.searchParams.get("match");
  const page = cursor.safeParse({ kickOff, matchId });
  if ((kickOff !== null || matchId !== null) && !page.success) throw new ApiError("Invalid history cursor", 422);
  const [profile, history, live] = await Promise.all([
    sb.from("players").select("id,full_name,position,photo_url,team_id,teams(id,name,crest_url)").eq("league_id", id).eq("id", playerId).maybeSingle(),
    sb.rpc("player_finalized_games_with_logos", { p_league: id, p_player: playerId, p_limit: PAGE_SIZE + 1,
      p_before_kickoff: page.data?.kickOff ?? null, p_before_match: page.data?.matchId ?? null }),
    page.success ? null : sb.rpc("ff_display_player_points", { p_league: id, p_players: [playerId], p_live_only: true }),
  ]);
  checkDb(profile.error, "Could not load player information");
  if (!profile.data) throw new ApiError("Player not found in this league", 404);
  checkDb(history.error, "Could not load finalized games");
  checkDb(live?.error ?? null, "Could not load provisional player points");
  const rows: GameRow[] = history.data ?? [];
  const finalizedIds = new Set(rows.map((r) => r.match_id));
  const liveGames = ((live?.data ?? []) as DisplayPlayerPoints[]).filter((r) => !finalizedIds.has(r.match_id)).map((r): PlayerGame => ({
    matchId: r.match_id, title: r.title, kickOff: r.kick_off, gameweek: null, opponent: null,
    participation: "played", points: Number(r.points), provisional: true,
    breakdown: r.breakdown.map((b) => ({ ...b, label: b.label || categoryLabel(b.category) })),
  })).sort((a, b) => Date.parse(b.kickOff) - Date.parse(a.kickOff));
  const games: PlayerGame[] = rows.slice(0, PAGE_SIZE).map((r) => ({ matchId: r.match_id, title: r.title, kickOff: r.kick_off,
    gameweek: r.gameweek, opponent: r.opponent, opponentLogo: r.opponent_id ? teamLogoUrl(r.opponent_crest, id, r.opponent_id) : null, participation: r.participation, points: r.points == null ? null : Number(r.points),
    breakdown: Array.isArray(r.breakdown) ? r.breakdown.map((b) => ({ ...b, label: b.label || categoryLabel(b.category) })) : [] }));
  const last = games.at(-1);
  const p = profile.data as unknown as { full_name: string; position: PlayerPerformance["player"]["position"]; photo_url: string | null; teams: { id: string; name: string; crest_url: string | null } | null };
  return Response.json({ player: { name: p.full_name, position: p.position, team: p.teams?.name ?? null, teamLogo: p.teams?.id ? teamLogoUrl(p.teams.crest_url, id, p.teams.id) : null,
    photoUrl: playerPhotoUrl(p.photo_url, id, playerId) }, games, ...(liveGames.length ? { liveGames } : {}),
    next: rows.length > PAGE_SIZE && last ? { kickOff: last.kickOff, matchId: last.matchId } : null,
  } satisfies PlayerPerformance, { headers: { "Cache-Control": "private, no-store" } });
});
