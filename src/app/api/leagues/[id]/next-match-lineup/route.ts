import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase, type SupabaseClient } from "@/db";
import { ApiError, checkDb, handler, requireMember } from "@/lib/server";
import { playerPhotoUrl } from "@/lib/player-photo";
import type { MatchLineup, NextMatchLineup, SavedMatchLineup } from "@/lib/next-match-lineup";

type Ctx = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";
const noStore = { headers: { "Cache-Control": "private, no-store" } };

// Keep historical positions, names and order from the verified snapshot. Photos
// and active status are display data only; a missing current player is archived.
async function decorate(sb: SupabaseClient, league: string, lineups: MatchLineup[]) {
  const ids = [...new Set(lineups.flatMap((l) => l.players.map((p) => p.id)))];
  if (!ids.length) return;
  const { data, error } = await sb.from("players").select("id,photo_url,shirt_number,status,availability,team_id,position")
    .eq("league_id", league).in("id", ids);
  checkDb(error, "Could not load lineup players");
  const byId = new Map((data ?? []).map((p) => [p.id, p]));
  for (const l of lineups) l.players = l.players.map((p) => {
    const row = byId.get(p.id);
    return { ...p, photoUrl: playerPhotoUrl(row?.photo_url ?? null, league, p.id), shirtNumber: row?.shirt_number ?? null,
      status: row?.position === p.position ? row.status : "archived", availability: row?.availability ?? "unavailable", teamId: row?.team_id ?? null };
  });
}

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const sb = await getSupabase();
  await requireMember(id, sb);
  const { data, error } = await sb.rpc("ff_next_match_lineup", { p_league: id });
  checkDb(error, "Could not load the next match lineup");
  if (!data?.serverNow) throw new ApiError("Could not confirm the next match lineup", 503);
  const result = data as NextMatchLineup;
  await decorate(sb, id, [result.previous?.lineup, result.inPlay?.lineup, result.saved?.lineup, result.preparation?.lineup].filter((l): l is MatchLineup => Boolean(l)));
  return Response.json(result, noStore);
});

const input = z.object({
  matchId: z.string().min(1).nullable(), formation: z.string().regex(/^[0-6]-[0-6]-[0-6]$/),
  // A lineup that is played always names its captaincy.
  captainId: z.string().min(1), viceId: z.string().min(1),
  expectedUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
  entries: z.array(z.object({ id: z.string().min(1), slot: z.enum(["starter", "sub", "reserve"]), order: z.number().int().min(0).max(2147483647) })).max(15),
}).strict();

export const PUT = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const sb = await getSupabase();
  await requireMember(id, sb);
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("Invalid match lineup payload", 422);
  const p = parsed.data;
  const { data, error } = await sb.rpc("ff_save_next_match_lineup", { p_league: id, p_match: p.matchId,
    p_formation: p.formation, p_captain: p.captainId, p_vice: p.viceId, p_expected_updated_at: p.expectedUpdatedAt, p_entries: p.entries });
  if (error?.code === "PT409") throw new ApiError(error.message, 409);
  if (error?.code === "22023") throw new ApiError(error.message, 422);
  checkDb(error, "Could not save the match lineup");
  const result = data as (SavedMatchLineup & { matchId?: string | null }) | null;
  const entries = Array.isArray(result?.lineup?.players) ? new Map(result.lineup.players.map((player) => [player.id, player])) : null;
  if (!result?.revision || !entries || result.lineup.players.length !== p.entries.length || entries.size !== p.entries.length
    || result.lineup.formation !== p.formation || result.lineup.captainId !== p.captainId || result.lineup.viceId !== p.viceId
    || p.entries.some((e) => entries.get(e.id)?.slot !== e.slot || entries.get(e.id)?.order !== e.order)) {
    throw new ApiError("The saved match lineup could not be confirmed. Reload before retrying.", 409);
  }
  // The database reports the fixture it wrote to. A lineup that went to
  // another fixture is not the one the caller asked for.
  if ((result.matchId ?? null) !== p.matchId) {
    throw new ApiError("The saved match lineup went to another fixture. Reload before retrying.", 409);
  }
  // The client refreshes display metadata via GET; no additional read is needed
  // after a successful write to confirm its revision and exact entries.
  return Response.json({ ...result, matchId: result.matchId ?? null }, noStore);
});
