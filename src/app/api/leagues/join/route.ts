import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import {
  ApiError,
  handler,
  logActivity,
  notifyMembers,
  operationId,
  requireUser,
  withIdempotency,
} from "@/lib/server";

const schema = z.object({
  code: z.string().trim().min(4).max(20),
  teamName: z.string().min(2).max(40).optional(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError("Enter a valid invitation code", 422);
  const code = parsed.data.code.toUpperCase();

  const outcome = await withIdempotency(
    {
      route: "POST /api/leagues/join",
      profileId: user.id,
      operationId: operationId(req),
      payload: { code },
    },
    async () => {
      const supabase = await getSupabase();

      const { data: found } = await supabase
        .from("leagues")
        .select("*")
        .eq("invite_code", code)
        .maybeSingle();
      const league = found;
      if (!league) throw new ApiError("No league found with that code", 404);

      const { data: existing } = await supabase
        .from("league_members")
        .select("id")
        .eq("league_id", league.id)
        .eq("profile_id", user.id)
        .maybeSingle();
      if (existing) {
        return {
          league: { id: league.id, name: league.name, format: league.format },
          joined: false,
        };
      }

      await supabase.from("league_members").insert({
        league_id: league.id,
        profile_id: user.id,
        role: "manager",
        team_name: parsed.data.teamName ?? `${user.displayName}'s XI`,
      });

      await supabase.from("league_standings").insert({
        league_id: league.id,
        profile_id: user.id,
        rank: 0,
        total_points: "0",
        matches_played: 0,
        form: [],
      });

      await supabase
        .from("invitations")
        .update({ accepted_by: user.id, accepted_at: new Date().toISOString() })
        .eq("league_id", league.id);

      return {
        league: { id: league.id, name: league.name, format: league.format },
        joined: true,
      };
    },
  );

  if (outcome.state === "unknown") throw new ApiError("Join request is still in progress", 409);
  return Response.json(outcome.data, {
    status: outcome.state === "duplicate" ? 200 : 201,
  });
});