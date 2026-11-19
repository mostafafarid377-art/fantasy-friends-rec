import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, assertRole, checkDb, handler, requireMember } from "@/lib/server";
import { POSITIONS, SCORING_CATEGORIES } from "@/lib/domain";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

function ruleDto(row: { id: string; position: string; event_type: string; points: number | string; status: string }) {
  return { id: row.id, position: row.position, eventType: row.event_type, points: String(row.points), status: row.status };
}

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);
  const supabase = await getSupabase();

  const { data: rows, error } = await supabase
    .from("scoring_rules")
    .select("*")
    .eq("league_id", id)
    .order("event_type", { ascending: true })
    .order("position", { ascending: true });

  checkDb(error, "Could not load scoring rules");
  const approved = Boolean(rows?.length) && (rows ?? []).every((r: any) => r.status === "approved");
  return Response.json({
    rules: (rows ?? []).map(ruleDto),
    approved,
    isLeader: membership.role === "leader",
    categories: SCORING_CATEGORIES,
    positions: POSITIONS,
  });
});

const putSchema = z.object({
  action: z.enum(["update", "approve", "initialize"]),
  rules: z
    .array(
      z.object({
        position: z.enum(POSITIONS),
        eventType: z.enum(SCORING_CATEGORIES as [string, ...string[]]),
        points: z.number().min(-20).max(50),
      }),
    )
    .min(1)
    .optional(),
});

export const PUT = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);
  assertRole(membership, "leader");

  const body = await req.json().catch(() => null);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("Invalid scoring configuration", 422, parsed.error.flatten().fieldErrors);

  const input = parsed.data;
  const supabase = await getSupabase();

  if (input.action === "initialize") {
    const { data, error } = await supabase.rpc("initialize_scoring_rules", { p_league: id });
    checkDb(error, "Could not initialize draft rules");
    if (!Array.isArray(data) || data.length < POSITIONS.length * SCORING_CATEGORIES.length ||
        data.some((row) => !row.id || row.league_id !== id)) {
      throw new ApiError("The draft rules could not be confirmed", 409);
    }
    return Response.json({ rules: data.map(ruleDto), approved: data.every((row) => row.status === "approved") });
  }

  if (input.action === "update") {
    const rules = input.rules ?? [];
    if (!rules.length) throw new ApiError("At least one scoring rule is required", 422);
    const { data, error } = await supabase.rpc("save_scoring_rules", {
      p_league: id, p_rules: rules.map((rule) => ({ position: rule.position, event_type: rule.eventType, points: rule.points })),
    });
    checkDb(error, "Could not save scoring rules");
    if (!Array.isArray(data) || data.length !== rules.length || data.some((r) => !r.id || r.league_id !== id)) {
      throw new ApiError("The scoring rules could not be confirmed", 409);
    }
    const result = await supabase.from("scoring_rules").select("*").eq("league_id", id);
    checkDb(result.error, "Rules were saved, but could not be reloaded");
    return Response.json({ rules: (result.data ?? []).map(ruleDto), approved: false });
  }

  const { data: updated, error } = await supabase
    .from("scoring_rules")
    .update({ status: "approved", approved_by: membership.profileId, approved_at: new Date().toISOString() })
    .eq("league_id", id).select();
  checkDb(error, "Could not approve scoring rules");
  if (!updated?.length || updated.some((r) => r.status !== "approved")) {
    throw new ApiError("No scoring rules were confirmed as approved", 409);
  }


  return Response.json({ rules: updated.map(ruleDto), approved: true });
});
