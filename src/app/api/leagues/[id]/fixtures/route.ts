import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import {
  ApiError,
  assertRole,
  handler,
  checkDb,
  confirmedRow,
  creationId,
  requireMember,
} from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireMember(id);
  const supabase = await getSupabase();

  const { data: rows, error } = await supabase
    .from("fantasy_fixtures")
    .select("id,title,gameweek,scheduled_at,status,notes,real_match_id")
    .eq("league_id", id)
    .order("gameweek", { ascending: true })
    .order("scheduled_at", { ascending: true });

  checkDb(error, "Could not load fixtures");
  const matchIds = [...new Set((rows ?? []).flatMap((r) => r.real_match_id ? [r.real_match_id] : []))];
  const matches = matchIds.length ? await supabase.from("real_matches").select("id,title,status")
    .eq("league_id", id).in("id", matchIds) : null;
  checkDb(matches?.error ?? null, "Could not load linked matches");
  const byId = new Map(matches?.data?.map((m) => [m.id, m]));
  return Response.json({ fixtures: (rows ?? []).map((r) => ({
    id: r.id, title: r.title, gameweek: r.gameweek, scheduledAt: r.scheduled_at,
    status: r.status, notes: r.notes, realMatchId: r.real_match_id, match: byId.get(r.real_match_id) ?? null,
  })) });
});

const createSchema = z.object({
  title: z.string().trim().min(3).max(80),
  gameweek: z.number().int().min(1).max(999).default(1),
  scheduledAt: z.string().datetime().nullable().optional(),
  notes: z.string().max(400).nullable().optional(),
});

export const POST = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);
  assertRole(membership, "leader");

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("Check the fixture details", 422, parsed.error.flatten().fieldErrors);
  const input = parsed.data;

  const supabase = await getSupabase();
  const fixtureId = creationId(req, membership.profileId, `fixtures/${id}`, input);
  const { data, error } = await supabase.from("fantasy_fixtures").insert({
    id: fixtureId, league_id: id, title: input.title, gameweek: input.gameweek,
    scheduled_at: input.scheduledAt ?? null, notes: input.notes ?? null, created_by: membership.profileId,
  }).select().maybeSingle();
  if (error?.code === "23505") {
    const existing = await supabase.from("fantasy_fixtures").select("*").eq("id", fixtureId).eq("league_id", id).maybeSingle();
    checkDb(existing.error, "Could not check the earlier fixture request");
    if (existing.data?.id) return Response.json({ fixture: existing.data });
  }
  const fixture = confirmedRow(data, error, "Could not create fixture", id);
  return Response.json({ fixture }, { status: 201 });
});

const patchSchema = z.object({
  fixtureId: z.string().min(1),
  title: z.string().trim().min(3).max(80).optional(),
  gameweek: z.number().int().min(1).max(999).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  status: z.enum(["scheduled", "active", "completed", "cancelled"]).optional(),
  realMatchId: z.string().nullable().optional(),
  notes: z.string().max(400).nullable().optional(),
});

export const PATCH = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);
  assertRole(membership, "leader");

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("Invalid fixture update", 422, parsed.error.flatten().fieldErrors);
  const { fixtureId, scheduledAt, realMatchId, ...rest } = parsed.data;

  const supabase = await getSupabase();
  if (realMatchId) {
    const match = await supabase.from("real_matches").select("id").eq("league_id", id).eq("id", realMatchId).maybeSingle();
    checkDb(match.error, "Could not verify the linked match");
    if (!match.data) throw new ApiError("Match not found in this league", 422);
  }
  const { data, error } = await supabase
    .from("fantasy_fixtures")
    .update({
      ...rest,
      ...(realMatchId !== undefined ? { real_match_id: realMatchId } : {}),
      ...(scheduledAt !== undefined
        ? { scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", fixtureId)
    .eq("league_id", id)
    .select()
    .maybeSingle();

  const updated = confirmedRow(data, error, "Could not update fixture", id);

  return Response.json({ fixture: updated });
});

export const DELETE = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);
  assertRole(membership, "leader");

  const fixtureId = new URL(req.url).searchParams.get("fixtureId");
  if (!fixtureId) throw new ApiError("fixtureId is required", 400);

  const supabase = await getSupabase();
  const { data: rows, error } = await supabase
    .from("fantasy_fixtures")
    .delete()
    .eq("id", fixtureId)
    .eq("league_id", id)
    .select();
  checkDb(error, "Could not delete fixture");
  if (!rows?.length || rows[0].league_id !== id) throw new ApiError("Fixture not found", 404);

  return Response.json({ ok: true });
});