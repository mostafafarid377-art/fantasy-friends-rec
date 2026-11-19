import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, assertRole, handler, logActivity, notifyMembers, requireMember } from "@/lib/server";
import { POSITIONS, SCORING_CATEGORIES } from "@/lib/domain";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);
  const supabase = await getSupabase();

  const { data: rows } = await supabase
    .from("scoring_rules")
    .select("*")
    .eq("league_id", id)
    .order("event_type", { ascending: true })
    .order("position", { ascending: true });

  const approved = (rows ?? []).every((r: any) => r.status === "approved");
  return Response.json({
    rules: rows ?? [],
    approved,
    isLeader: membership.role === "leader",
    categories: SCORING_CATEGORIES,
    positions: POSITIONS,
  });
});

const putSchema = z.object({
  action: z.enum(["update", "approve"]),
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

  if (input.action === "update") {
    const rules = input.rules ?? [];
    for (const rule of rules) {
      await supabase
        .from("scoring_rules")
        .upsert(
          {
            league_id: id,
            position: rule.position,
            event_type: rule.eventType,
            points: String(rule.points),
            status: "draft",
            approved_by: null,
            approved_at: null,
          },
          { onConflict: "league_id,position,event_type" },
        );
    }
    await logActivity(id, membership.profileId, "rules.updated", "Scoring rules updated (draft)");
    const { data: updatedRows } = await supabase
      .from("scoring_rules")
      .select("*")
      .eq("league_id", id);
    return Response.json({
      rules: updatedRows ?? [],
      approved: (updatedRows ?? []).every((r: any) => r.status === "approved"),
    });
  }

  const { data: existingRows } = await supabase.from("scoring_rules").select("*").eq("league_id", id);
  if (!existingRows?.length) throw new ApiError("There are no scoring rules to approve", 409);

  await supabase
    .from("scoring_rules")
    .update({ status: "approved", approved_by: membership.profileId, approved_at: new Date().toISOString() })
    .eq("league_id", id);

  await logActivity(id, membership.profileId, "rules.approved", "Scoring rules approved");
  await notifyMembers(id, {
    type: "rules_approved",
    title: "Scoring rules approved",
    body: "Official fantasy scoring is now active for this league.",
    exceptProfileId: membership.profileId,
  });

  const { data: updated } = await supabase
    .from("scoring_rules")
    .select("*")
    .eq("league_id", id);
  return Response.json({ rules: updated ?? [], approved: true });
});