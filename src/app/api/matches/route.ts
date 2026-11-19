import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import {
  ApiError,
  handler,
  leagueRules,
  logActivity,
  notifyMembers,
  operationId,
  requireMember,
  withIdempotency,
} from "@/lib/server";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  leagueId: z.string().min(1),
  teamAId: z.string().min(1),
  teamBId: z.string().min(1),
  title: z.string().trim().min(3).max(80),
  kickOff: z.string().datetime(),
  fixtureId: z.string().nullable().optional(),
});

export const GET = handler(async (req: NextRequest) => {
  const url = new URL(req.url);
  const leagueId = url.searchParams.get("leagueId");
  if (!leagueId) throw new ApiError("leagueId is required", 400);
  const membership = await requireMember(leagueId);

  const supabase = await getSupabase();

  const { data: rows } = await supabase
    .from("real_matches")
    .select("*, teams(team_a_id, team_b_id)")
    .eq("league_id", leagueId)
    .order("kick_off", { ascending: false });

  const { data: teamB } = await supabase.from("teams").select("*").eq("league_id", leagueId);
  const teamName = new Map((teamB ?? []).map((t: any) => [t.id, t.name]));

  const ids = (rows ?? []).map((r: any) => r.id);

  const { data: events } = ids.length
    ? await supabase
        .from("match_events")
        .select("*")
        .in("match_id", ids)
        .order("minute", { ascending: false })
    : { data: [] };

  return Response.json({
    matches: (rows ?? [])
      .map((r: any) => ({
        ...r,
        teamAName: teamName.get(r.team_a_id) ?? "Team A",
        teamBName: teamName.get(r.team_b_id) ?? "Team B",
        events: (events ?? []).filter((e: any) => e.match_id === r.id),
      }))
      .reverse(),
    role: membership.role,
    rules: leagueRules(membership.league),
    canOrganize: membership.role === "leader" || membership.role === "organizer",
    canApprove: membership.role === "leader",
  });
});

export const POST = handler(async (req: NextRequest) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("Check the match details", 422, parsed.error.flatten().fieldErrors);
  const input = parsed.data;

  const membership = await requireMember(input.leagueId);
  if (membership.role !== "leader" && membership.role !== "organizer") {
    throw new ApiError("Only a Match Organizer or League Leader can create matches", 403);
  }

  const supabase = await getSupabase();

  const { data: leagueTeams } = await supabase
    .from("teams")
    .select("id")
    .eq("league_id", input.leagueId);
  const ids = new Set((leagueTeams ?? []).map((t: any) => t.id));
  if (!ids.has(input.teamAId) || !ids.has(input.teamBId)) {
    throw new ApiError("Both teams must belong to this league", 422);
  }
  if (input.teamAId === input.teamBId) throw new ApiError("A team cannot play itself", 422);

  const outcome = await withIdempotency(
    {
      route: "POST /api/matches",
      profileId: membership.profileId,
      operationId: operationId(req),
      payload: input,
    },
    async () => {
      const { data: created, error } = await supabase
        .from("real_matches")
        .insert({
          league_id: input.leagueId,
          team_a_id: input.teamAId,
          team_b_id: input.teamBId,
          title: input.title,
          kick_off: new Date(input.kickOff).toISOString(),
          organizer_id: membership.profileId,
          fixture_id: input.fixtureId ?? null,
        })
        .select()
        .maybeSingle();

      if (error || !created) throw new ApiError("Could not create match", 500);

      if (input.fixtureId) {
        await supabase
          .from("fantasy_fixtures")
          .update({ real_match_id: created.id, updated_at: new Date().toISOString() })
          .eq("id", input.fixtureId);
      }

      return { match: created };
    },
  );

  if (outcome.state === "unknown") throw new ApiError("Match creation is still in progress", 409);
  const match = (outcome.data as any)?.match;
  await logActivity(input.leagueId, membership.profileId, "match.created", `Match created: ${input.title}`);
  await notifyMembers(input.leagueId, {
    type: "match_created",
    title: "New real match",
    body: input.title,
    link: `/matches/${match.id}`,
    exceptProfileId: membership.profileId,
  });

  return Response.json(outcome.data, { status: outcome.state === "duplicate" ? 200 : 201 });
});