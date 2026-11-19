import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, assertRole, handler, logActivity, requireMember } from "@/lib/server";
import { POSITIONS } from "@/lib/domain";

type Ctx = { params: Promise<{ id: string; playerId: string }> };

const patchSchema = z.object({
  fullName: z.string().trim().min(2).max(80).optional(),
  position: z.enum(POSITIONS).optional(),
  teamId: z.string().nullable().optional(),
  shirtNumber: z.number().int().min(1).max(99).nullable().optional(),
  photoUrl: z.string().url().nullable().optional().or(z.literal("").transform(() => null)),
  availability: z.enum(["available", "doubt", "injured", "suspended"]).optional(),
  status: z.enum(["active", "archived"]).optional(),
  description: z.string().max(400).nullable().optional(),
});

async function loadScoped(supabase: any, leagueId: string, playerId: string) {
  const { data: player } = await supabase.from("players").select("*").eq("id", playerId).maybeSingle();
  if (!player) throw new ApiError("Player not found", 404);
  if (player.league_id !== leagueId) throw new ApiError("Player belongs to another league", 403);
  return player;
}

export const PATCH = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id, playerId } = await ctx.params;
  const membership = await requireMember(id);
  assertRole(membership, "leader");
  const supabase = await getSupabase();
  const player = await loadScoped(supabase, id, playerId);

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("Check the player details", 422, parsed.error.flatten().fieldErrors);

  const { data: updated } = await supabase
    .from("players")
    .update({
      ...(parsed.data.fullName !== undefined ? { full_name: parsed.data.fullName } : {}),
      ...(parsed.data.position !== undefined ? { position: parsed.data.position } : {}),
      ...(parsed.data.teamId !== undefined ? { team_id: parsed.data.teamId } : {}),
      ...(parsed.data.shirtNumber !== undefined ? { shirt_number: parsed.data.shirtNumber } : {}),
      ...(parsed.data.photoUrl !== undefined ? { photo_url: parsed.data.photoUrl } : {}),
      ...(parsed.data.availability !== undefined ? { availability: parsed.data.availability } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", playerId)
    .select()
    .maybeSingle();

  await logActivity(id, membership.profileId, "player.updated", `Updated ${player.full_name}`);

  return Response.json({ player: updated });
});

export const DELETE = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id, playerId } = await ctx.params;
  const membership = await requireMember(id);
  assertRole(membership, "leader");
  const supabase = await getSupabase();
  const player = await loadScoped(supabase, id, playerId);

  const { data: updated } = await supabase
    .from("players")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("id", playerId)
    .select()
    .maybeSingle();

  await logActivity(id, membership.profileId, "player.archived", `Archived ${player.full_name}`);

  return Response.json({ player: updated, archived: true });
});