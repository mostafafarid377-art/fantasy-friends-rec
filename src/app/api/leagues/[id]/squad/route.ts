import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import {
  ApiError,
  handler,
  leagueRules,
  loadSquad,
  requireMember,
  checkDb,
} from "@/lib/server";
import { validateSquad, validateSquadDraft, type SquadPlayer } from "@/lib/domain";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);

  const squad = await loadSquad(id, membership.profileId);
  if (!squad) {
    return Response.json({
      squad: null,
      players: [],
      rules: leagueRules(membership.league),
    });
  }

  const supabase = await getSupabase();
  const { data: rows, error } = await supabase
    .from("fantasy_squad_players")
    .select(
      "id, player_id, slot, \"order\", players(full_name, position, photo_url, shirt_number, availability, status, team_id)",
    )
    .eq("squad_id", squad.id)
    .order("order", { ascending: true });

  checkDb(error, "Could not load squad players");
  return Response.json({
    squad: { ...squad, captainId: squad.captain_id, viceCaptainId: squad.vice_captain_id, completedAt: squad.completed_at },
    rules: leagueRules(membership.league),
    vicePolicy: membership.league.vice_policy,
    players: (rows ?? []).map((r: any) => ({
      id: r.player_id,
      playerId: r.player_id,
      slot: r.slot,
      order: r.order,
      fullName: r.players?.full_name,
      position: r.players?.position,
      photoUrl: r.players?.photo_url,
      shirtNumber: r.players?.shirt_number,
      availability: r.players?.availability,
      status: r.players?.status,
      teamId: r.players?.team_id,
    })),
  });
});

const putSchema = z.object({
  formation: z.string().min(3).max(12),
  captainId: z.string().nullable().optional(),
  viceCaptainId: z.string().nullable().optional(),
  entries: z
    .array(
      z.object({
        playerId: z.string().min(1),
        slot: z.enum(["starter", "sub", "reserve"]),
        order: z.number().int().min(0).max(60),
      }),
    )
    .min(1),
});

export const PUT = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);

  const body = await req.json().catch(() => null);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("Invalid squad payload", 422, parsed.error.flatten().fieldErrors);
  }
  const input = parsed.data;
  const rules = leagueRules(membership.league);

  const supabase = await getSupabase();
  const ids = input.entries.map((e) => e.playerId);
  if (new Set(ids).size !== ids.length) throw new ApiError("Duplicate players in squad", 422);

  const { data: owned, error } = await supabase
    .from("players")
    .select("id,full_name,position,status")
    .eq("league_id", id)
    .in("id", ids);
  checkDb(error, "Could not verify the squad players");
  const byId = new Map<string, any>((owned ?? []).map((p: any) => [p.id, p]));
  if ((owned ?? []).length !== ids.length) {
    throw new ApiError("One or more players are not part of this league", 403);
  }

  const squadPlayers: SquadPlayer[] = input.entries.map((e) => {
    const p = byId.get(e.playerId)!;
    if (p.status !== "active") {
      throw new ApiError(`${p.full_name} is archived and cannot be selected`, 422);
    }
    return {
      id: p.id,
      position: p.position as SquadPlayer["position"],
      slot: e.slot,
      order: e.order,
      name: p.full_name,
    };
  });

  const complete = squadPlayers.length === rules.squadSize;
  const validation = complete
    ? validateSquad(rules, squadPlayers, {
        formation: input.formation,
        captainId: input.captainId,
        viceId: input.viceCaptainId,
      })
    : validateSquadDraft(rules, squadPlayers);
  if (!validation.ok) throw new ApiError("Squad is not valid", 422, validation.errors);

  const { data, error: saveError } = await supabase.rpc("save_fantasy_squad", {
    p_league: id,
    p_formation: input.formation,
    p_captain: input.captainId ?? null,
    p_vice: input.viceCaptainId ?? null,
    p_complete: complete,
    p_entries: input.entries.map((e) => ({ player_id: e.playerId, slot: e.slot, order: e.order })),
  });
  checkDb(saveError, "Could not save squad");
  const saved = new Map<string, { id: string; slot: string; order: number; squad_id: string }>(
    Array.isArray(data?.entries) ? data.entries.map((e: any) => [e.player_id, e]) : [],
  );
  if (typeof data?.squadId !== "string" || !data.squadId || saved.size !== input.entries.length || !input.entries.every((e) => {
    const row = saved.get(e.playerId);
    return row?.id && row.squad_id === data.squadId && row.slot === e.slot && row.order === e.order;
  })) throw new ApiError("The saved squad could not be confirmed", 409);
  return Response.json({ state: "applied", squadId: data.squadId, formation: input.formation,
    starters: input.entries.filter((e) => e.slot === "starter").length,
    subs: input.entries.filter((e) => e.slot === "sub").length,
    reserves: input.entries.filter((e) => e.slot === "reserve").length,
    valid: true, complete,
  });
});
