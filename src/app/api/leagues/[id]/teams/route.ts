import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, assertRole, checkDb, confirmedRow, creationId, handler, requireMember } from "@/lib/server";

import { TEAM_FIELDS, teamDto } from "@/lib/roster";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireMember(id);
  const supabase = await getSupabase();
  const { data: rows, error } = await supabase
    .from("teams")
    .select(TEAM_FIELDS)
    .eq("league_id", id)
    .order("name", { ascending: true });
  checkDb(error, "Could not load teams");
  return Response.json({ teams: (rows ?? []).map(teamDto) });
});

const schema = z.object({
  name: z.string().trim().min(2).max(50),
  shortName: z.string().trim().max(12).optional(),
  crestUrl: z.string().url().nullable().optional().or(z.literal("").transform(() => null)),
});

export const POST = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);
  assertRole(membership, "leader");

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError("Check the team details", 422, parsed.error.flatten().fieldErrors);

  const supabase = await getSupabase();
  const teamId = creationId(req, membership.profileId, `teams/${id}`, parsed.data);
  const { data, error } = await supabase.from("teams").insert({
    id: teamId, league_id: id, name: parsed.data.name,
    short_name: parsed.data.shortName ?? null, crest_url: parsed.data.crestUrl ?? null,
  }).select(TEAM_FIELDS).maybeSingle();
  if (error?.code === "23505") {
    const existing = await supabase.from("teams").select(TEAM_FIELDS).eq("league_id", id).eq("id", teamId).maybeSingle();
    checkDb(existing.error, "Could not check the earlier team request");
    if (existing.data?.id) return Response.json({ team: teamDto(existing.data) });
    throw new ApiError("A team with that name already exists in this league", 409);
  }
  const created = confirmedRow(data, error, "Could not create team", id);
  if (created.id !== teamId) throw new ApiError("The saved team ID could not be confirmed", 409);
  return Response.json({ team: teamDto(created) }, { status: 201 });
});
