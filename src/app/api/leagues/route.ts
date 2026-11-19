import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, handler, operationId, requireUser, withIdempotency } from "@/lib/server";
import { FORMATS, STARTERS_BY_FORMAT } from "@/lib/domain";
import { seedLeagueRules } from "@/lib/rules";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(3).max(60),
  description: z.string().max(280).optional(),
  format: z.enum(FORMATS),
  subsCount: z.number().int().min(1).max(10).default(5),
  teamName: z.string().min(2).max(40).optional(),
});

export const GET = handler(async () => {
  const user = await requireUser();
  const supabase = await getSupabase();

  const { data: rows } = await supabase
    .from("league_members")
    .select("role, team_name, leagues(id, name, format, starters, subs_count, invite_code, created_at)")
    .eq("profile_id", user.id);

  return Response.json({
    leagues: (rows ?? []).map((r: any) => ({
      id: r.leagues.id,
      name: r.leagues.name,
      format: r.leagues.format,
      starters: r.leagues.starters,
      subsCount: r.leagues.subs_count,
      inviteCode: r.leagues.invite_code,
      role: r.role,
      teamName: r.team_name,
      createdAt: r.leagues.created_at,
    })),
  });
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireUser();
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("Check the league details", 422, parsed.error.flatten().fieldErrors);
  }
  const input = parsed.data;

  const outcome = await withIdempotency(
    {
      route: "POST /api/leagues",
      profileId: user.id,
      operationId: operationId(req),
      payload: input,
    },
    async () => {
      const supabase = await getSupabase();

      // Atomic league creation via SECURITY DEFINER RPC:
      // league + leader membership + standings + activity in one transaction.
      const { data: created, error: rpcError } = await supabase.rpc(
        "create_league",
        {
          p_name: input.name,
          p_description: input.description ?? null,
          p_format: input.format,
          p_starters: STARTERS_BY_FORMAT[input.format],
          p_subs_count: input.subsCount,
          p_team_name: input.teamName ?? null,
        },
      );

    if (rpcError || !created) {
  console.error("[CREATE_LEAGUE_RPC_ERROR]", {
    code: rpcError?.code,
    message: rpcError?.message,
    details: rpcError?.details,
    hint: rpcError?.hint,
    created,
  });

  throw new ApiError("Could not create the league", 500);
}

      const leagueId = created as string;

      // Seed scoring rules (draft) — best-effort after atomic core creation.
      await seedLeagueRules(leagueId);

      return { id: leagueId };
    },
  );

  if (outcome.state === "unknown") throw new ApiError("League creation is still in progress", 409);
  const league = outcome.data as any;
  if (outcome.state === "duplicate") {
    // Fetch the existing league to return full data
    const supabase = await getSupabase();
    const { data: existing } = await supabase
      .from("leagues")
      .select("*")
      .eq("created_by", user.id)
      .eq("name", input.name)
      .maybeSingle();
    return Response.json(existing ?? league, { status: 200 });
  }
  return Response.json(league, { status: 201 });
});