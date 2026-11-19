import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, assertRole, handler, logActivity, requireMember } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireMember(id);
  const supabase = await getSupabase();
  const { data: rows } = await supabase
    .from("teams")
    .select("*")
    .eq("league_id", id)
    .order("name", { ascending: true });
  return Response.json({ teams: rows ?? [] });
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
  const { data: all } = await supabase.from("teams").select("name").eq("league_id", id);
  if (all?.some((t: any) => t.name.toLowerCase() === parsed.data.name.toLowerCase())) {
    throw new ApiError("A team with that name already exists in this league", 409);
  }

  const { data: created } = await supabase
    .from("teams")
    .insert({
      league_id: id,
      name: parsed.data.name,
      short_name: parsed.data.shortName ?? null,
      crest_url: parsed.data.crestUrl ?? null,
    })
    .select()
    .maybeSingle();

  await logActivity(id, membership.profileId, "team.created", `Added team ${parsed.data.name}`);

  return Response.json({ team: created }, { status: 201 });
});