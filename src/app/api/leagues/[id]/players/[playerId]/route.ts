import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, assertRole, checkDb, confirmedRow, handler, requireMember } from "@/lib/server";
import { managedPhotoKey } from "@/lib/player-photo";
import { removeUnlinkedPlayerPhoto } from "@/lib/player-photo-storage";
import { POSITIONS } from "@/lib/domain";

import { PLAYER_FIELDS, playerDto } from "@/lib/roster";

type Ctx = { params: Promise<{ id: string; playerId: string }> };

const patchSchema = z.object({
  fullName: z.string().trim().min(2).max(80).optional(),
  position: z.enum(POSITIONS).optional(),
  teamId: z.string().nullable().optional(),
  shirtNumber: z.number().int().min(1).max(99).nullable().optional(),
  photoUrl: z.url({ protocol: /^https?$/ }).nullable().optional().or(z.literal("").transform(() => null)),
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

  let priorPhoto: string | null | undefined;
  if (parsed.data.photoUrl !== undefined) {
    const prior = await supabase.from("players").select("photo_url").eq("id", playerId).eq("league_id", id).maybeSingle();
    checkDb(prior.error, "Could not verify the current player photo");
    if (!prior.data) throw new ApiError("Player not found", 404);
    priorPhoto = prior.data.photo_url as string | null;
  }
  const update = supabase
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
    .eq("league_id", id);
  const guarded = priorPhoto === undefined ? update : priorPhoto === null ? update.is("photo_url", null) : update.eq("photo_url", priorPhoto);
  const { data, error } = await guarded.select(PLAYER_FIELDS).maybeSingle();
  const updated = confirmedRow(data, error, "Could not update player", id);
  if (updated.id !== playerId || (parsed.data.photoUrl !== undefined && updated.photo_url !== parsed.data.photoUrl)) {
    throw new ApiError("The updated player could not be confirmed", 409);
  }
  if (priorPhoto && priorPhoto !== updated.photo_url) await removeUnlinkedPlayerPhoto(supabase, managedPhotoKey(priorPhoto, id, playerId));
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