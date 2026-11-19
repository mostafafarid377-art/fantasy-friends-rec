import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, assertRole, checkDb, confirmedRow, creationId, handler, requireMember } from "@/lib/server";
import { PLAYER_FIELDS, playerDto, TEAM_FIELDS, teamDto } from "@/lib/roster";
import { POSITIONS } from "@/lib/domain";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireMember(id);

  const url = new URL(_req.url);
  const includeArchived = url.searchParams.get("archived") === "1";

  const supabase = await getSupabase();

  let query = supabase.from("players").select(PLAYER_FIELDS).eq("league_id", id);
  if (!includeArchived) query = query.neq("status", "archived");
  // The squad picker searches the complete league roster. Walk in bounded chunks
  // instead of silently losing rows at the API server's default maximum.
  const chunk = 500;
  const first = query.order("full_name").order("id").range(0, chunk - 1);
  const [page, teams] = await Promise.all([
    first,
    supabase.from("teams").select(TEAM_FIELDS).eq("league_id", id).order("name"),
  ]);
  checkDb(page.error, "Could not load players");
  checkDb(teams.error, "Could not load teams");
  const rows = [...(page.data ?? [])];
  for (let offset = chunk; rows.length === offset; offset += chunk) {
    const more = await query.range(offset, offset + chunk - 1);
    checkDb(more.error, "Could not load the remaining players");
    rows.push(...(more.data ?? []));
  }
  return Response.json({ players: rows.map(playerDto), teams: (teams.data ?? []).map(teamDto), total: rows.length });
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
    const { data: team, error } = await supabase
      .from("teams")
      .select("id, league_id")
      .eq("id", input.teamId)
      .eq("league_id", id)
      .maybeSingle();
    checkDb(error, "Could not verify the team");
    if (!team) throw new ApiError("That team does not exist in this league", 422);
  }

  const playerId = creationId(req, membership.profileId, `players/${id}`, input);
  const { data, error } = await supabase
    .from("players")
    .insert({
      id: playerId,
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
    .select(PLAYER_FIELDS)
    .maybeSingle();

  if (error?.code === "23505") {
    const existing = await supabase.from("players").select(PLAYER_FIELDS).eq("id", playerId).eq("league_id", id).maybeSingle();
    checkDb(existing.error, "Could not check the earlier player request");
    if (existing.data?.id) return Response.json({ player: playerDto(existing.data) });
  }
  const created = confirmedRow(data, error, "Could not create player", id);
  if (created.id !== playerId) throw new ApiError("The saved player ID could not be confirmed", 409);
  return Response.json({ player: playerDto(created) }, { status: 201 });
});
