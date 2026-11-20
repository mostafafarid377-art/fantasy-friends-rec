import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, checkDb, confirmedRow, creationId, handler, requireMember } from "@/lib/server";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 30;
const createSchema = z.object({
  leagueId: z.string().min(1), teamAId: z.string().min(1), teamBId: z.string().min(1),
  title: z.string().trim().min(3).max(80), kickOff: z.string().datetime(), fixtureId: z.string().nullable().optional(),
});

export const GET = handler(async (req: NextRequest) => {
  const params = new URL(req.url).searchParams;
  const leagueId = params.get("leagueId");
  const page = Number(params.get("page") ?? 1);
  const approved = params.get("status") === "approved";
  if (!leagueId || !Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new ApiError("Invalid league or page", 400);
  const supabase = await getSupabase();
  const membership = await requireMember(leagueId, supabase);
  const canApprove = membership.role === "leader";
  let query = supabase.from("real_matches").select(
    "id,title,status,home_score,away_score,kick_off,organizer_id,rejection_reason,teamA:teams!real_matches_team_a_id_teams_id_fk(name),teamB:teams!real_matches_team_b_id_teams_id_fk(name),match_events(count)",
    approved ? { count: "exact" } : {},
  ).eq("league_id", leagueId);
  if (approved) query = query.eq("status", "approved");
  const [matches, pending] = await Promise.all([
    query.order("kick_off", { ascending: false }).order("id", { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    canApprove && !approved
      ? supabase.from("real_matches").select("id", { count: "exact" })
          .eq("league_id", leagueId).eq("status", "pending").order("kick_off").limit(1)
      : null,
  ]);
  checkDb(matches.error, "Could not load matches");
  checkDb(pending?.error ?? null, "Could not load pending reviews");
  return Response.json({
    matches: (matches.data ?? []).slice(0, PAGE_SIZE).map((r: any) => ({
      id: r.id, title: r.title, status: r.status, kickOff: r.kick_off, homeScore: r.home_score, awayScore: r.away_score,
      organizerId: r.organizer_id, rejectionReason: r.rejection_reason,
      teamAName: r.teamA?.name ?? "Team A", teamBName: r.teamB?.name ?? "Team B",
      eventCount: r.match_events?.[0]?.count ?? 0,
    })),
    canApprove, total: matches.count, hasMore: (matches.data?.length ?? 0) > PAGE_SIZE,
    pendingCount: pending?.count ?? 0, pendingId: pending?.data?.[0]?.id ?? null,
  });
});

export const POST = handler(async (req: NextRequest) => {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("Check the match details", 422, parsed.error.flatten().fieldErrors);
  const input = parsed.data;
  const supabase = await getSupabase();
  const membership = await requireMember(input.leagueId, supabase);
  if (membership.role !== "leader" && membership.role !== "organizer") {
    throw new ApiError("Only a Match Organizer or League Leader can create matches", 403);
  }
  const id = creationId(req, membership.profileId, "create-match", input);
  const { data, error } = await supabase.rpc("create_real_match", {
    p_id: id, p_league: input.leagueId, p_team_a: input.teamAId, p_team_b: input.teamBId,
    p_title: input.title, p_kickoff: input.kickOff, p_fixture: input.fixtureId ?? null,
  });
  const match = confirmedRow(data, error, "Could not create match", input.leagueId);
  if (match.id !== id) throw new ApiError("Match ID could not be confirmed", 409);
  return Response.json({ match }, { status: 201 });
});
