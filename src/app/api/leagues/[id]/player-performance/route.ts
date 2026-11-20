import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, checkDb, handler, requireMember } from "@/lib/server";
import type { LatestPlayerGames } from "@/lib/player-performance";

export const dynamic = "force-dynamic";
const playerIds = z.array(z.string().min(1).max(128)).min(1).max(15);

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const sb = await getSupabase();
  await requireMember(id, sb);
  const players = playerIds.safeParse(req.nextUrl.searchParams.getAll("player"));
  if (!players.success) throw new ApiError("Invalid player selection", 422);
  const result = await sb.rpc("latest_player_games", { p_league: id, p_players: [...new Set(players.data)] });
  checkDb(result.error, "Could not load latest player points");
  const latest: LatestPlayerGames = Object.fromEntries((result.data ?? []).map((r: { player_id: string; match_id: string; points: number | string | null }) =>
    [r.player_id, { matchId: r.match_id, points: r.points == null ? null : Number(r.points) }]));
  return Response.json(latest, { headers: { "Cache-Control": "private, no-store" } });
});
