import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, checkDb, handler, leagueRules, requireMember, requireUser, canManageMatch } from "@/lib/server";
import { validateLineup, type Position } from "@/lib/domain";
import { loadMatch } from "@/lib/matches";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  teamId: z.string().min(1),
  starters: z.array(
    z.object({ playerId: z.string().min(1), order: z.number().int().min(0).max(30) })),
  subs: z.array(
    z.object({ playerId: z.string().min(1), order: z.number().int().min(0).max(30) })),
});

/**
 * Verifies the user is authorized to manage match lineups. Both the League
 * Leader and the assigned Match Organizer have full authority.
 */
async function canTouch(matchId: string, profileId: string) {
  const auth = await canManageMatch(matchId, profileId);
  if (!auth.authorized) throw new ApiError("Not authorized to manage this match", 403);
  if (auth.match.status === "pending" || auth.match.status === "approved") {
    throw new ApiError("Lineups are locked once the match is pending", 409);
  }
  return { match: auth.match, membership: auth.membership };
}

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const user = await requireUser();
  const { match } = await canTouch(id, user.id);

  const supabase = await getSupabase();
  const [
    lineupsResp,
    rosterResp,
  ] = await Promise.all([
    supabase.from("match_lineups").select("*").eq("match_id", id).order("order", { ascending: true }),
    supabase.from("players").select("*").eq("league_id", match.league_id),
  ]);
  const lineups = (lineupsResp as any)?.data ?? [];
  const roster = (rosterResp as any)?.data ?? [];
  const byId = new Map<string, any>(roster.map((p: any) => [p.id, p]));

  return Response.json({
    lineups: lineups.map((l: any) => ({
      ...l,
      playerName: byId.get(l.player_id)?.full_name ?? "Unknown",
      position: byId.get(l.player_id)?.position ?? null,
    })),
    teamAId: match.team_a_id,
    teamBId: match.team_b_id,
  });
});

export const PUT = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError("Invalid lineup payload", 422, parsed.error.flatten().fieldErrors);
  const input = parsed.data;

  const user = await requireUser();
  const { match, membership } = await canTouch(id, user.id);
  const rules = leagueRules(membership.league);
  if (![match.team_a_id, match.team_b_id].includes(input.teamId)) throw new ApiError("Team is not part of this match", 422);
  const ids = [...input.starters, ...input.subs].map((e) => e.playerId);
  if (!ids.length || new Set(ids).size !== ids.length) throw new ApiError("Lineups must contain distinct players", 422);

  const supabase = await getSupabase();
  const { data: roster, error: rosterError } = await supabase
    .from("players")
    .select("id,position,team_id")
    .eq("league_id", match.league_id).in("id", ids);
  checkDb(rosterError, "Could not verify lineup players");
  if (roster?.length !== ids.length || roster.some((p) => p.team_id && p.team_id !== input.teamId)) {
    throw new ApiError("Every player must belong to this league and match team", 422);
  }
  const posOf = new Map<string, Position>((roster ?? []).map((p: any) => [p.id, p.position as Position]));

  const starters = input.starters.map((s) => ({ position: posOf.get(s.playerId) ?? "DEF" }));
  const subs = input.subs.map((s) => ({ position: posOf.get(s.playerId) ?? "DEF" }));
  const result = validateLineup(rules, starters, subs);
  if (!result.ok) throw new ApiError("Lineup is not valid", 422, result.errors);

  const entries = [
    ...input.starters.map((s) => ({ player_id: s.playerId, slot: "starter", order: s.order })),
    ...input.subs.map((s) => ({ player_id: s.playerId, slot: "sub", order: s.order })),
  ];
  const { data: inserted, error } = await supabase.rpc("replace_match_lineup", {
    p_match: id, p_team: input.teamId, p_entries: entries,
  });
  checkDb(error, "Could not save lineup");
  if (!Array.isArray(inserted) || inserted.length !== entries.length ||
      inserted.some((r) => !r.id || r.league_id !== match.league_id || r.match_id !== id || r.team_id !== input.teamId)) {
    throw new ApiError("The saved lineup could not be confirmed", 409);
  }


  return Response.json({ lineups: inserted ?? [] });
});

export const DELETE = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const user = await requireUser();
  await canTouch(id, user.id);
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc("clear_match_lineups", { p_match: id });
  checkDb(error, "Could not clear lineup");
  if (!Number.isInteger(data)) throw new ApiError("Lineup clear could not be confirmed", 409);
  return Response.json({ ok: true, removed: data });
});
