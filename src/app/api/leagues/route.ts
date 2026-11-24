import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, checkDb, creationId, handler, requireUser } from "@/lib/server";
import { rateLimitUser } from "@/lib/server/rate-limit";
import { confirmLeagueMembership } from "@/lib/league-membership";
import { FORMATS, STARTERS_BY_FORMAT } from "@/lib/domain";

import type { MyDisplayStanding } from "@/lib/live-points";

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

  const [memberships, standings] = await Promise.all([
    supabase.from("league_members").select("role, team_name, leagues(id, name, format, starters, subs_count, invite_code, created_at)").eq("profile_id", user.id),
    supabase.rpc("ff_my_display_standings"),
  ]);
  checkDb(memberships.error, "Could not load leagues");
  checkDb(standings.error, "Could not load your league standings");
  const byLeague = new Map(((standings.data ?? []) as MyDisplayStanding[]).map((s) => [s.league_id, s]));
  return Response.json({
    leagues: (memberships.data ?? []).map((r: any) => ({
      id: r.leagues.id,
      name: r.leagues.name,
      format: r.leagues.format,
      starters: r.leagues.starters,
      subsCount: r.leagues.subs_count,
      inviteCode: r.leagues.invite_code,
      role: r.role,
      teamName: r.team_name,
      rank: byLeague.get(r.leagues.id)?.rank ?? null,
      provisional: byLeague.get(r.leagues.id)?.provisional ?? false,
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

  const limited = await rateLimitUser("league.create", user.id);
  if (limited) return limited;

  const supabase = await getSupabase();
  const { data: leagueId, error } = await supabase.rpc("create_league_confirmed", {
    p_operation: creationId(req, user.id, "create-league", input),
    p_name: input.name,
    p_description: input.description ?? null,
    p_format: input.format,
    p_starters: STARTERS_BY_FORMAT[input.format],
    p_subs_count: input.subsCount,
    p_team_name: input.teamName ?? null,
  });
  checkDb(error, "Could not create league");
  const league = await confirmLeagueMembership(supabase, leagueId, user.id);
  return Response.json({ league }, { status: 201 });
});
