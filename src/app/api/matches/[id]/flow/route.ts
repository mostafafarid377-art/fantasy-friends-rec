import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, checkDb, confirmedRow, handler, requireUser, canManageMatch } from "@/lib/server";
import { loadMatch } from "@/lib/matches";

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({
  action: z.enum(["submit", "approve", "reject"]),
  reason: z.string().trim().max(400).optional(),
  version: z.number().int().min(1).optional(),
});

export const POST = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("Invalid review action", 422, parsed.error.flatten().fieldErrors);
  const { action, reason, version } = parsed.data;
  const user = await requireUser();
  const { match } = await canManageMatch(id, user.id);
  const supabase = await getSupabase();
  if (action === "reject" && !reason) throw new ApiError("A rejection reason is required", 422);
  // The guarded functions check state after locking the match. They write
  // the approval history in the same transaction (and points on approval).
  const result = action === "submit" ? await supabase.rpc("submit_match", { p_match: id })
    : action === "approve" ? await supabase.rpc("approve_match", { p_match: id, p_version: version ?? match.version })
    : await supabase.rpc("reject_match", { p_match: id, p_reason: reason, p_version: version ?? match.version });
  checkDb(result.error, `Could not ${action} match`);
  const status = action === "submit" ? "pending" : action === "approve" ? "approved" : "rejected";
  const updated = confirmedRow(await loadMatch(id), null, `Could not confirm ${action} result`, match.league_id);
  if (updated.status !== status || updated.version <= match.version) throw new ApiError("The match has changed; reload to see its current status", 409);
  return Response.json({ match: updated, status, ...(action === "approve" ? { points: result.data } : {}) });
});
