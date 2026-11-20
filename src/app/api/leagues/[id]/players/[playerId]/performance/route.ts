import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, checkDb, handler, requireMember } from "@/lib/server";
import { playerPhotoUrl } from "@/lib/player-photo";
import { categoryLabel } from "@/lib/scoring";
import type { PlayerGame, PlayerPerformance } from "@/lib/player-performance";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 20;
const cursor = z.object({ kickOff: z.iso.datetime({ offset: true }), matchId: z.string().min(1).max(128) });

type GameRow = { match_id: string; title: string; kick_off: string; gameweek: number | null; opponent: string | null;
  participation: PlayerGame["participation"]; points: number | string | null; breakdown: PlayerGame["breakdown"] | null };

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string; playerId: string }> }) => {
  const { id, playerId } = await ctx.params;
  const sb = await getSupabase();
  await requireMember(id, sb);
  const kickOff = req.nextUrl.searchParams.get("before");
  const matchId = req.nextUrl.searchParams.get("match");
  const page = cursor.safeParse({ kickOff, matchId });
  if ((kickOff !== null || matchId !== null) && !page.success) throw new ApiError("Invalid history cursor", 422);
  const [profile, history] = await Promise.all([
    sb.from("players").select("id,full_name,position,photo_url,team_id,teams(name)").eq("league_id", id).eq("id", playerId).maybeSingle(),
    sb.rpc("player_finalized_games", { p_league: id, p_player: playerId, p_limit: PAGE_SIZE + 1,
      p_before_kickoff: page.data?.kickOff ?? null, p_before_match: page.data?.matchId ?? null }),
  ]);
  checkDb(profile.error, "Could not load player information");
  if (!profile.data) throw new ApiError("Player not found in this league", 404);
  checkDb(history.error, "Could not load finalized games");
  const rows: GameRow[] = history.data ?? [];
  const games: PlayerGame[] = rows.slice(0, PAGE_SIZE).map((r) => ({ matchId: r.match_id, title: r.title, kickOff: r.kick_off,
    gameweek: r.gameweek, opponent: r.opponent, participation: r.participation, points: r.points == null ? null : Number(r.points),
    breakdown: Array.isArray(r.breakdown) ? r.breakdown.map((b) => ({ ...b, label: b.label || categoryLabel(b.category) })) : [] }));
  const last = games.at(-1);
  const p = profile.data as unknown as { full_name: string; position: PlayerPerformance["player"]["position"]; photo_url: string | null; teams: { name: string } | null };
  return Response.json({ player: { name: p.full_name, position: p.position, team: p.teams?.name ?? null,
    photoUrl: playerPhotoUrl(p.photo_url, id, playerId) }, games,
    next: rows.length > PAGE_SIZE && last ? { kickOff: last.kickOff, matchId: last.matchId } : null,
  } satisfies PlayerPerformance, { headers: { "Cache-Control": "private, no-store" } });
});
