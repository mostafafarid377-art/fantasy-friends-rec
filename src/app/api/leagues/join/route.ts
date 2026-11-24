import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, checkDb, handler, requireUser } from "@/lib/server";
import { rateLimitUser } from "@/lib/server/rate-limit";
import { confirmLeagueMembership } from "@/lib/league-membership";

const schema = z.object({
  code: z.string().trim().min(4).max(20),
  teamName: z.string().trim().min(2).max(40).optional(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("Enter a valid invitation code", 422);
  const limited = await rateLimitUser("league.join", user.id);
  if (limited) return limited;
  const supabase = await getSupabase();
  // Non-members cannot look up private leagues or create standings directly.
  const { data: leagueId, error } = await supabase.rpc("join_league", {
    p_code: parsed.data.code.toUpperCase(),
    p_team_name: parsed.data.teamName ?? `${user.displayName}'s XI`,
  });
  if (error?.code === "P0001" && error.message === "No league found with that code") {
    throw new ApiError(error.message, 404);
  }
  checkDb(error, "Could not join league");
  return Response.json({ league: await confirmLeagueMembership(supabase, leagueId, user.id) });
});
