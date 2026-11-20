import type { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, canManageMatch, checkDb, handler, requireIdentity } from "@/lib/server";

const count = z.number().int().min(0).max(999);
const schema = z.object({ version: z.number().int().min(1).max(2147483646),
  stats: z.array(z.object({ playerId: z.string().min(1), saves: count, defensiveContributions: count })).max(40),
  bonus: z.array(z.string().min(1)).refine((a) => (a.length === 0 || a.length === 3) && new Set(a).size === a.length).optional(),
  reason: z.string().trim().min(1).max(400).optional(),
});

export const PUT = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const sb = await getSupabase();
  const user = await requireIdentity(sb);
  await canManageMatch(id, user.id);
  const input = schema.safeParse(await req.json().catch(() => null));
  if (!input.success) throw new ApiError("Enter whole-number totals and select three distinct bonus players, or clear all awards", 422);
  const { version, stats, bonus, reason } = input.data;
  const { data, error } = await sb.rpc("save_match_statistics", { p_match: id, p_version: version,
    p_stats: stats, p_bonus: bonus ?? null, p_reason: reason ?? null });
  checkDb(error, "Could not save match statistics");
  if (data?.matchId !== id || data.version !== version + 1) throw new ApiError("The save could not be confirmed. Reload before retrying.", 409);
  return Response.json(data);
});
