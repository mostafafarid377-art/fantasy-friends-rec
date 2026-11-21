import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, checkDb, handler, leagueRules, requireIdentity, canManageMatch } from "@/lib/server";
import { canSelectPlayer, validateLineup, type Position } from "@/lib/domain";
import type { SavedLineupEntry } from "@/lib/match-lineup";

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
  return { match: auth.match, membership: auth.membership };
}

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const user = await requireIdentity();
  const { match } = await canTouch(id, user.id);

  const supabase = await getSupabase();
  const [
    lineupsResp,
    rosterResp,
  ] = await Promise.all([
    supabase.from("match_lineups").select("*").eq("match_id", id).order("order", { ascending: true }),
    supabase.from("players").select("*").eq("league_id", match.league_id),
  ]);
  checkDb(lineupsResp.error, "Could not load saved lineups");
  checkDb(rosterResp.error, "Could not load lineup players");
  const lineups = lineupsResp.data ?? [];
  const roster = rosterResp.data ?? [];
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

  const user = await requireIdentity();
  const { match, membership } = await canTouch(id, user.id);
  const rules = leagueRules(membership.league);
  if (![match.team_a_id, match.team_b_id].includes(input.teamId)) throw new ApiError("Team is not part of this match", 422);
  if ([input.starters, input.subs].some((group) => group.some((entry, i) => entry.order !== i))) {
    throw new ApiError("Lineup orders must be consecutive within each group", 422);
  }
  const ids = [...input.starters, ...input.subs].map((e) => e.playerId);
  if (!ids.length || new Set(ids).size !== ids.length) throw new ApiError("Lineups must contain distinct players", 422);

  const supabase = await getSupabase();
  const { data: roster, error: rosterError } = await supabase
    .from("players")
    .select("id,position,team_id,status,availability")
    .eq("league_id", match.league_id).in("id", ids);
  checkDb(rosterError, "Could not verify lineup players");
  if (roster?.length !== ids.length || roster.some((p) => p.team_id !== input.teamId)) {
    throw new ApiError("Every player must belong to this league and match team", 422);
  }
  if (roster.some((p) => !canSelectPlayer(p))) throw new ApiError("Archived, injured or suspended players cannot be selected", 422);
  const posOf = new Map<string, Position>((roster ?? []).map((p: any) => [p.id, p.position as Position]));

  const starters = input.starters.map((s) => ({ position: posOf.get(s.playerId) ?? "DEF" }));
  const subs = input.subs.map((s) => ({ position: posOf.get(s.playerId) ?? "DEF" }));
  const result = validateLineup(rules, starters, subs);
  if (!result.ok) throw new ApiError("Lineup is not valid", 422, result.errors);

  const entries = [
    ...input.starters.map((s) => ({ player_id: s.playerId, slot: "starter", order: s.order })),
    ...input.subs.map((s) => ({ player_id: s.playerId, slot: "sub", order: s.order })),
  ];
  const { error } = await supabase.rpc("replace_match_lineup", {
    p_match: id, p_team: input.teamId, p_entries: entries,
  });
  checkDb(error, "Could not save lineup");
  const { data: persisted, error: readError } = await supabase.from("match_lineups")
    .select("id,league_id,match_id,team_id,player_id,slot,order").eq("match_id", id)
    .eq("league_id", match.league_id).eq("team_id", input.teamId).order("order", { ascending: true });
  checkDb(readError, "Could not verify the saved lineup. Reload before retrying");
  const byPlayer = new Map(persisted?.map((r) => [r.player_id, r]));
  if (persisted?.length !== entries.length || !entries.every((e) => {
    const r = byPlayer.get(e.player_id);
    return r?.id && r.match_id === id && r.league_id === match.league_id && r.team_id === input.teamId
      && r.slot === e.slot && r.order === e.order;
  })) throw new ApiError("The saved lineup could not be confirmed. Reload before retrying", 409);

  const lineups: SavedLineupEntry[] = persisted.map((r) => ({ id: r.id, playerId: r.player_id, teamId: r.team_id, slot: r.slot, order: r.order }));
  return Response.json({ lineups });
});

export const DELETE = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const user = await requireIdentity();
  await canTouch(id, user.id);
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc("clear_match_lineups", { p_match: id });
  checkDb(error, "Could not clear lineup");
  if (!Number.isInteger(data)) throw new ApiError("Lineup clear could not be confirmed", 409);
  return Response.json({ ok: true, removed: data });
});
