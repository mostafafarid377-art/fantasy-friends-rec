import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, checkDb, confirmedRow, handler, requireIdentity, canManageMatch } from "@/lib/server";
import { rateLimitUser } from "@/lib/server/rate-limit";
import { loadMatch } from "@/lib/matches";

type Ctx = { params: Promise<{ id: string }> };
const revision = z.number().int().min(1).max(2147483647);
const score = z.number().int().min(0).max(999);
const scores = { homeScore: score, awayScore: score };
const reason = z.string().trim().min(1).max(400);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit"), version: revision, ...scores }),
  z.object({ action: z.literal("approve"), version: revision.optional() }),
  z.object({ action: z.literal("reject"), version: revision.optional(), reason }),
  z.object({ action: z.literal("correct"), version: revision, ...scores, reason }),
]);

export const POST = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("Invalid match review action. Check the scores, version, and any required reason.", 422, parsed.error.flatten().fieldErrors);
  const input = parsed.data;
  const { action, version } = input;
  const supabase = await getSupabase();
  const user = await requireIdentity(supabase);
  const { match } = await canManageMatch(id, user.id);
  const limited = await rateLimitUser("match.manage", user.id);
  if (limited) return limited;
  const result = action === "submit" ? await supabase.rpc("submit_match", {
    p_match: id, p_version: input.version, p_home_score: input.homeScore, p_away_score: input.awayScore,
  }) : action === "correct" ? await supabase.rpc("correct_match_result", {
    p_match: id, p_version: input.version, p_home_score: input.homeScore, p_away_score: input.awayScore, p_reason: input.reason,
  }) : action === "approve" ? await supabase.rpc("approve_match", { p_match: id, p_version: version ?? match.version })
    : await supabase.rpc("reject_match", { p_match: id, p_reason: input.reason, p_version: version ?? match.version });
  checkDb(result.error, `Could not ${action} match`);
  const status = action === "submit" ? "pending" : action === "reject" ? "rejected" : "approved";
  const updated = confirmedRow(await loadMatch(id, supabase), null, `Could not confirm ${action} result`, match.league_id);
  const writesScore = action === "submit" || action === "correct";
  const scored = action === "approve" || action === "correct";
  if (updated.id !== id || updated.status !== status || (action === "reject" && updated.version !== (version ?? match.version) + 1)
      || (action === "submit" && (result.data?.id !== id || updated.version !== result.data?.version))
      || (scored && (result.data?.matchId !== id || result.data?.version !== updated.version))
      || (writesScore && (updated.home_score !== input.homeScore || updated.away_score !== input.awayScore))) {
    throw new ApiError("The match result could not be confirmed; reload to see its current status", 409);
  }
  return Response.json({ match: updated, status, ...(scored ? { points: result.data } : {}) });
});
