import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import {
  ApiError,
  handler,
  leagueRules,
  loadSquad,
  requireMember,
  withIdempotency,
  operationId,
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
  const { data: rows } = await supabase
    .from("fantasy_squad_players")
    .select(
      "id, player_id, slot, \"order\", players(full_name, position, photo_url, shirt_number, availability, status, team_id)",
    )
    .eq("squad_id", squad.id)
    .order("order", { ascending: true });

  return Response.json({
    squad,
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

  const outcome = await withIdempotency(
    {
      route: "PUT /api/leagues/[id]/squad",
      profileId: membership.profileId,
      operationId: operationId(req),
      payload: { leagueId: id, ...input },
    },
    async () => {
      const supabase = await getSupabase();
      const ids = input.entries.map((e) => e.playerId);
      if (new Set(ids).size !== ids.length) throw new ApiError("Duplicate players in squad", 422);

      const { data: owned } = await supabase
        .from("players")
        .select("*")
        .eq("league_id", id)
        .in("id", ids);
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

      let squadId: string;
      const existing = await loadSquad(id, membership.profileId);
      if (existing) {
        await supabase
          .from("fantasy_squads")
          .update({
            formation: input.formation,
            captain_id: input.captainId ?? null,
            vice_captain_id: input.viceCaptainId ?? null,
            completed_at: complete ? new Date().toISOString() : null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
        squadId = existing.id;
        await supabase.from("fantasy_squad_players").delete().eq("squad_id", squadId);
      } else {
        const { data: created } = await supabase
          .from("fantasy_squads")
          .insert({
            league_id: id,
            profile_id: membership.profileId,
            formation: input.formation,
            captain_id: input.captainId ?? null,
            vice_captain_id: input.viceCaptainId ?? null,
            completed_at: complete ? new Date().toISOString() : null,
          })
          .select("id")
          .maybeSingle();
        squadId = created!.id;
      }
      await supabase.from("fantasy_squad_players").insert(
        input.entries.map((e) => ({
          squad_id: squadId,
          player_id: e.playerId,
          slot: e.slot,
          order: e.order,
        })),
      );

      return {
        squadId,
        formation: input.formation,
        starters: input.entries.filter((e) => e.slot === "starter").length,
        subs: input.entries.filter((e) => e.slot === "sub").length,
        reserves: input.entries.filter((e) => e.slot === "reserve").length,
        valid: true,
        complete,
      };
    },
  );

  if (outcome.state === "unknown") {
    const existingSquad = await loadSquad(id, membership.profileId);
    return Response.json({ state: "unknown", ...(existingSquad ? {} : {}) });
  }
  return Response.json({ state: outcome.state, ...outcome.data });
});