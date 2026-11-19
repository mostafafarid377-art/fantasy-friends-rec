import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, handler, leagueRules, requireMember, canManageMatch } from "@/lib/server";
import { loadMatch } from "@/lib/matches";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const match = await loadMatch(id);
  if (!match) throw new ApiError("Match not found", 404);
  const membership = await requireMember(match.league_id);

  const supabase = await getSupabase();

  const [
    lineupsResp,
    eventsResp,
    subsResp,
    approvalsResp,
    teamRowsResp,
    rosterResp,
  ] = await Promise.all([
    supabase.from("match_lineups").select("*").eq("match_id", id).order("order", { ascending: true }),
    supabase.from("match_events").select("*").eq("match_id", id).order("minute", { ascending: true }),
    supabase.from("match_substitutions").select("*").eq("match_id", id).order("minute", { ascending: true }),
    supabase.from("match_approvals").select("*").eq("match_id", id).order("created_at", { ascending: true }),
    supabase.from("teams").select("*").eq("league_id", match.league_id),
    supabase.from("players").select("*").eq("league_id", match.league_id),
  ]);

  const lineups = (lineupsResp as any)?.data ?? [];
  const events = (eventsResp as any)?.data ?? [];
  const subs = (subsResp as any)?.data ?? [];
  const approvals = (approvalsResp as any)?.data ?? [];
  const teamRows = (teamRowsResp as any)?.data ?? [];
  const roster = (rosterResp as any)?.data ?? [];

  const teamName = new Map(teamRows.map((t: any) => [t.id, t.name]));
  const playerById = new Map(roster.map((p: any) => [p.id, p]));

  const auth = await canManageMatch(id, membership.profileId);

  return Response.json({
    match: {
      ...match,
      teamAName: teamName.get(match.team_a_id) ?? "Team A",
      teamBName: teamName.get(match.team_b_id) ?? "Team B",
    },
    rules: leagueRules(membership.league),
    role: membership.role,
    canOrganize: auth.authorized,
    canEditEvents:
      auth.authorized &&
      (match.status === "draft" || match.status === "rejected"),
    canApprove: auth.authorized,
    lineups: (lineups ?? []).map((l: any) => ({
      ...l,
      player: playerById.get(l.player_id) ?? null,
    })),
    events: (events ?? []).map((e: any) => ({
      ...e,
      player: playerById.get(e.player_id) ?? null,
      assistPlayer: e.assist_player_id ? (playerById.get(e.assist_player_id) ?? null) : null,
    })),
    substitutions: (subs ?? []).map((s: any) => ({
      ...s,
      playerOn: playerById.get(s.player_on_id) ?? null,
      playerOff: playerById.get(s.player_off_id) ?? null,
    })),
    approvals: approvals ?? [],
    roster: (roster ?? []).filter(
      (p: any) => p.status === "active" || (lineups ?? []).some((l: any) => l.player_id === p.id),
    ),
    teams: teamRows ?? [],
  });
});

const patchSchema = z.object({
  title: z.string().trim().min(3).max(80).optional(),
  kickOff: z.string().datetime().optional(),
  teamAId: z.string().optional(),
  teamBId: z.string().optional(),
  fixtureId: z.string().nullable().optional(),
});

export const PATCH = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const match = await loadMatch(id);
  if (!match) throw new ApiError("Match not found", 404);
  const membership = await requireMember(match.league_id);
  const auth = await canManageMatch(id, membership.profileId);
  if (!auth.authorized) throw new ApiError("Not authorized to edit this match", 403);
  if (match.status === "pending" || match.status === "approved") {
    throw new ApiError("An approved or pending match cannot be edited", 409);
  }

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("Invalid match update", 422);
  const input = parsed.data;

  if (input.teamAId && input.teamBId && input.teamAId === input.teamBId) {
    throw new ApiError("A team cannot play itself", 422);
  }

  const supabase = await getSupabase();
  const { data: updated } = await supabase
    .from("real_matches")
    .update({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.kickOff !== undefined ? { kick_off: new Date(input.kickOff).toISOString() } : {}),
      ...(input.teamAId !== undefined ? { team_a_id: input.teamAId } : {}),
      ...(input.teamBId !== undefined ? { team_b_id: input.teamBId } : {}),
      ...(input.fixtureId !== undefined ? { fixture_id: input.fixtureId } : {}),
      status: match.status === "rejected" ? "draft" : match.status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .maybeSingle();

  return Response.json({ match: updated });
});

export const DELETE = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const match = await loadMatch(id);
  if (!match) throw new ApiError("Match not found", 404);
  const membership = await requireMember(match.league_id);
  const auth = await canManageMatch(id, membership.profileId);
  if (!auth.authorized) throw new ApiError("You cannot delete this match", 403);
  if (match.status === "approved") throw new ApiError("Approved matches are permanent", 409);
  const supabase = await getSupabase();
  await supabase.from("real_matches").delete().eq("id", id);
  return Response.json({ ok: true });
});
