import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import {
  ApiError,
  assertRole,
  handler,
  logActivity,
  notifyMembers,
  operationId,
  requireMember,
  withIdempotency,
} from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireMember(id);
  const supabase = await getSupabase();

  const { data: rows } = await supabase
    .from("fantasy_fixtures")
    .select("*, real_matches(*)")
    .eq("league_id", id)
    .order("gameweek", { ascending: true })
    .order("scheduled_at", { ascending: true });

  return Response.json({
    fixtures: (rows ?? []).map((r: any) => ({ ...r.fixture, match: r.real_matches })),
  });
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

  const outcome = await withIdempotency(
    {
      route: "POST /api/leagues/[id]/fixtures",
      profileId: membership.profileId,
      operationId: operationId(req),
      payload: { leagueId: id, ...input },
    },
    async () => {
      const supabase = await getSupabase();
      const { data: created, error } = await supabase
        .from("fantasy_fixtures")
        .insert({
          league_id: id,
          title: input.title,
          gameweek: input.gameweek,
          scheduled_at: input.scheduledAt ? new Date(input.scheduledAt).toISOString() : null,
          notes: input.notes ?? null,
          created_by: membership.profileId,
        })
        .select()
        .maybeSingle();

      if (error || !created) throw new ApiError("Could not create fixture", 500);

      await logActivity(id, membership.profileId, "fixture.created", `Fixture scheduled: ${input.title}`);
      await notifyMembers(id, {
        type: "fixture_created",
        title: "New fixture",
        body: input.title,
        link: `/leagues/${id}/fixtures`,
        exceptProfileId: membership.profileId,
      });

      return { fixture: created };
    },
  );

  if (outcome.state === "unknown") throw new ApiError("Fixture creation is still in progress", 409);
  return Response.json(outcome.data, { status: outcome.state === "duplicate" ? 200 : 201 });
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
  const { fixtureId, scheduledAt, ...rest } = parsed.data;

  const supabase = await getSupabase();
  const { data: updated } = await supabase
    .from("fantasy_fixtures")
    .update({
      ...rest,
      ...(scheduledAt !== undefined
        ? { scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", fixtureId)
    .select()
    .maybeSingle();

  if (!updated || updated.league_id !== id) throw new ApiError("Fixture not found", 404);

  await logActivity(id, membership.profileId, "fixture.updated", `Fixture updated: ${updated.title}`);
  return Response.json({ fixture: updated });
});

export const DELETE = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);
  assertRole(membership, "leader");

  const fixtureId = new URL(req.url).searchParams.get("fixtureId");
  if (!fixtureId) throw new ApiError("fixtureId is required", 400);

  const supabase = await getSupabase();
  const { data: rows } = await supabase
    .from("fantasy_fixtures")
    .delete()
    .eq("id", fixtureId)
    .select();
  if (!rows?.length || rows[0].league_id !== id) throw new ApiError("Fixture not found", 404);

  await logActivity(id, membership.profileId, "fixture.deleted", `Fixture removed: ${rows[0].title}`);
  return Response.json({ ok: true });
});