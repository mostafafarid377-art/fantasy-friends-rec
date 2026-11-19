import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, assertRole, handler, logActivity, requireMember } from "@/lib/server";
import { POSITIONS } from "@/lib/domain";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireMember(id);

  const url = new URL(_req.url);
  const includeArchived = url.searchParams.get("archived") === "1";

  const supabase = await getSupabase();

  let query = supabase.from("players").select("*").eq("league_id", id);
  if (!includeArchived) {
    query = query.neq("status", "archived");
  }

  const { data: rows } = await query.order("full_name", { ascending: true });
  const { data: teamRows } = await supabase
    .from("teams")
    .select("*")
    .eq("league_id", id)
    .order("name", { ascending: true });

  return Response.json({
    players: rows ?? [],
    teams: teamRows ?? [],
    total: (rows ?? []).length,
  });
});

const createSchema = z.object({
  fullName: z.string().trim().min(2).max(80),
  position: z.enum(POSITIONS),
  teamId: z.string().nullable().optional(),
  shirtNumber: z.number().int().min(1).max(99).nullable().optional(),
  photoUrl: z.string().url().nullable().optional().or(z.literal("").transform(() => null)),
  availability: z.enum(["available", "doubt", "injured", "suspended"]).default("available"),
  description: z.string().max(400).nullable().optional(),
});

export const POST = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);
  assertRole(membership, "leader");

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("Check the player details", 422, parsed.error.flatten().fieldErrors);
  }
  const input = parsed.data;
  const supabase = await getSupabase();

  if (input.teamId) {
    const { data: team } = await supabase
      .from("teams")
      .select("id, league_id")
      .eq("id", input.teamId)
      .maybeSingle();
    if (!team) throw new ApiError("That team does not exist in this league", 422);
    if (team.league_id !== id) throw new ApiError("Team belongs to another league", 403);
  }

  const { data: created } = await supabase
    .from("players")
    .insert({
      league_id: id,
      full_name: input.fullName,
      position: input.position,
      team_id: input.teamId ?? null,
      shirt_number: input.shirtNumber ?? null,
      photo_url: input.photoUrl ?? null,
      availability: input.availability,
      description: input.description ?? null,
      created_by: membership.profileId,
    })
    .select()
    .maybeSingle();

  await logActivity(id, membership.profileId, "player.created", `Added ${input.fullName} to the player database`, {
    playerId: created?.id,
  });

  return Response.json({ player: created }, { status: 201 });
});