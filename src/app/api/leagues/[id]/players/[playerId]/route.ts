import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, assertRole, checkDb, confirmedRow, handler, requireMember } from "@/lib/server";
import { POSITIONS } from "@/lib/domain";

import { PLAYER_FIELDS, playerDto } from "@/lib/roster";

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

export const PATCH = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id, playerId } = await ctx.params;
  const membership = await requireMember(id);
  assertRole(membership, "leader");
  const supabase = await getSupabase();

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("Check the player details", 422, parsed.error.flatten().fieldErrors);

  if (parsed.data.teamId) {
    const team = await supabase.from("teams").select("id").eq("league_id", id).eq("id", parsed.data.teamId).maybeSingle();
    checkDb(team.error, "Could not verify the team");
    if (!team.data) throw new ApiError("That team does not exist in this league", 422);
  }

  const { data, error } = await supabase
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
    .eq("league_id", id)
    .select(PLAYER_FIELDS)
    .maybeSingle();

  const updated = confirmedRow(data, error, "Could not update player", id);

  return Response.json({ player: playerDto(updated) });
});

export const DELETE = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id, playerId } = await ctx.params;
  const membership = await requireMember(id);
  assertRole(membership, "leader");
  const supabase = await getSupabase();

  const { data, error } = await supabase
    .from("players")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("id", playerId)
    .eq("league_id", id)
    .select(PLAYER_FIELDS)
    .maybeSingle();

  const updated = confirmedRow(data, error, "Could not archive player", id);

  return Response.json({ player: playerDto(updated), archived: true });
});