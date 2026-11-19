import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, handler, leagueRules, logActivity, requireMember, requireUser, canManageMatch } from "@/lib/server";
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
  const rules = leagueRules(match.league_id);

  const supabase = await getSupabase();
  const { data: roster } = await supabase
    .from("players")
    .select("*")
    .eq("league_id", match.league_id);
  const posOf = new Map<string, Position>((roster ?? []).map((p: any) => [p.id, p.position as Position]));

  const starters = input.starters.map((s) => ({ position: posOf.get(s.playerId) ?? "DEF" }));
  const subs = input.subs.map((s) => ({ position: posOf.get(s.playerId) ?? "DEF" }));
  const result = validateLineup(rules, starters, subs);
  if (!result.ok) throw new ApiError("Lineup is not valid", 422, result.errors);

  const upsertLines = input.starters.map((s) => ({
    match_id: id,
    team_id: input.teamId,
    player_id: s.playerId,
    slot: "starter",
    order: s.order,
  }));
  input.subs.forEach((s) => {
    upsertLines.push({
      match_id: id,
      team_id: input.teamId,
      player_id: s.playerId,
      slot: "sub",
      order: s.order,
    });
  });

  const { error } = await supabase.from("match_lineups").delete().eq("match_id", id).eq("team_id", input.teamId);
  if (error) throw new ApiError("Could not reset lineup", 500);

  const { data: inserted } = await supabase.from("match_lineups").insert(upsertLines).select();

  await logActivity(match.league_id, membership.profileId, "match.lineup", `Lineup set for ${match.title}`);

  return Response.json({ lineups: inserted ?? [] });
});

export const DELETE = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const user = await requireUser();
  const profileId = user.id;
  if (!profileId) throw new ApiError("profileId is required", 400);
  const { match } = await canTouch(id, profileId);
  const supabase = await getSupabase();
  await supabase.from("match_lineups").delete().eq("match_id", id);
  await logActivity(match.league_id, profileId, "match.lineup.cleared", "Lineup cleared");
  return Response.json({ ok: true });
});
