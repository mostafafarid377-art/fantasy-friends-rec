import { TEAM_FIELDS, teamDto } from "@/lib/roster";
import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, checkDb, confirmedRow, handler, leagueRules, requireMember, canManageMatch } from "@/lib/server";
import { loadMatch } from "@/lib/matches";

import { PLAYER_FIELDS, playerDto } from "@/lib/roster";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const supabase = await getSupabase();
  const match = await loadMatch(id, supabase);
  if (!match) throw new ApiError("Match not found", 404);
  const membership = await requireMember(match.league_id, supabase);

  const [
    lineupsResp,
    eventsResp,
    subsResp,
    approvalsResp,
    teamRowsResp,
    rosterResp,
    statisticsResp,
    pointsResp,
    scoringLineupsResp,
  ] = await Promise.all([
    supabase.from("match_lineups").select("*").eq("match_id", id).order("order", { ascending: true }),
    supabase.from("match_events").select("*").eq("match_id", id).order("created_at").order("id"),
    supabase.from("match_substitutions").select("*").eq("match_id", id).order("minute", { ascending: true }),
    supabase.from("match_approvals").select("*").eq("match_id", id).order("created_at", { ascending: true }),
    supabase.from("teams").select(TEAM_FIELDS).eq("league_id", match.league_id).in("id", [match.team_a_id, match.team_b_id]),
    supabase.from("players").select(PLAYER_FIELDS).eq("league_id", match.league_id),
    supabase.from("match_player_statistics").select("player_id,position,saves,defensive_contributions").eq("match_id", id),
    match.status === "approved" ? supabase.from("player_match_points").select("player_id,breakdown")
      .eq("league_id", match.league_id).eq("match_id", id).eq("match_version", match.version) : { data: [], error: null },
    match.status === "approved" ? supabase.from("match_scoring_lineups").select("team_id,player_id,slot,match_position").eq("match_id", id)
      .eq("league_id", match.league_id) : { data: null, error: null },
  ]);

  for (const result of [lineupsResp, eventsResp, subsResp, approvalsResp, teamRowsResp, rosterResp, statisticsResp, pointsResp, scoringLineupsResp]) {
    checkDb(result.error, "Could not load match details");
  }
  const lineups = lineupsResp.data ?? [];
  const events = eventsResp.data ?? [];
  const subs = subsResp.data ?? [];
  const approvals = approvalsResp.data ?? [];
  const teamRows = teamRowsResp.data ?? [];
  const roster = (rosterResp.data ?? []).map(playerDto);
  const teamName = new Map(teamRows.map((t) => [t.id, t.name]));
  const playerById = new Map(roster.map((p) => [p.id, p]));
  const linePlayerIds = new Set(lineups.map((l) => l.player_id));
  const bonusAwards = (pointsResp.data ?? []).flatMap((p) => {
    const line = Array.isArray(p.breakdown) && p.breakdown.find((b: { category?: string }) => b?.category === "match_bonus");
    return line && typeof line.points === "number" ? [{ playerId: p.player_id, rank: typeof line.rank === "number" ? line.rank : null, points: line.points }] : [];
  }).sort((a, b) => (a.rank ?? 4) - (b.rank ?? 4) || b.points - a.points || a.playerId.localeCompare(b.playerId));
  const authorized = membership.role === "leader" ||
      (membership.role === "organizer" && match.organizer_id === membership.profileId);

  return Response.json({
    match: {
      id: match.id, title: match.title, status: match.status, version: match.version,
      homeScore: match.home_score ?? null, awayScore: match.away_score ?? null,
      leagueId: match.league_id, teamAId: match.team_a_id, teamBId: match.team_b_id,
      kickOff: match.kick_off, durationMinutes: match.duration_minutes ?? null, organizerId: match.organizer_id, fixtureId: match.fixture_id,
      submittedBy: match.submitted_by, submittedAt: match.submitted_at, decidedBy: match.decided_by,
      decidedAt: match.decided_at, rejectionReason: match.rejection_reason,
      teamAName: teamName.get(match.team_a_id) ?? "Team A",
      teamBName: teamName.get(match.team_b_id) ?? "Team B",
    },
    serverNow: new Date().toISOString(),
    statistics: (statisticsResp.data ?? []).map((r) => ({ playerId: r.player_id, position: r.position, saves: r.saves,
      defensiveContributions: r.defensive_contributions })),
    bonusAwards,
    rules: leagueRules(membership.league),
    role: membership.role,
    canOrganize: authorized,
    canEditEvents:
      authorized &&
      (match.status === "draft" || match.status === "rejected"),
    canApprove: authorized,
    lineups: (lineups ?? []).map((l: any) => ({
      id: l.id, playerId: l.player_id, teamId: l.team_id, slot: l.slot, order: l.order, matchPosition: l.match_position ?? playerById.get(l.player_id)?.position,
      player: playerById.get(l.player_id) ?? null,
    })),
    ...(scoringLineupsResp.data && { scoringLineups: scoringLineupsResp.data.map((l) => ({
      playerId: l.player_id, teamId: l.team_id, slot: l.slot, matchPosition: l.match_position,
      player: playerById.get(l.player_id) ?? null,
    })) }),
    events: (events ?? []).map((e: any) => ({
      id: e.id, teamId: e.team_id, playerId: e.player_id, assistPlayerId: e.assist_player_id,
      eventType: e.event_type, note: e.note,
      player: playerById.get(e.player_id) ?? null,
      assistPlayer: e.assist_player_id ? (playerById.get(e.assist_player_id) ?? null) : null,
    })),
    substitutions: (subs ?? []).map((s: any) => ({
      id: s.id, teamId: s.team_id, playerOnId: s.player_on_id, playerOffId: s.player_off_id, minute: s.minute,
      playerOn: playerById.get(s.player_on_id) ?? null,
      playerOff: playerById.get(s.player_off_id) ?? null,
    })),
    approvals: approvals.map((a) => ({ id: a.id, action: a.action, actorId: a.actor_id,
      reason: a.reason, version: a.version, createdAt: a.created_at,
      scoreChange: a.action === "corrected" ? a.snapshot : null })),
    roster: roster.filter((p) => p.status === "active" || linePlayerIds.has(p.id)),
    teams: teamRows.map(teamDto),
  });
});

const patchSchema = z.object({
  title: z.string().trim().min(3).max(80).optional(),
  kickOff: z.iso.datetime({ offset: true }).optional(),
  teamAId: z.string().optional(),
  teamBId: z.string().optional(),
  fixtureId: z.string().nullable().optional(),
});

export const PATCH = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const supabase = await getSupabase();
  const match = await loadMatch(id, supabase);
  if (!match) throw new ApiError("Match not found", 404);
  const membership = await requireMember(match.league_id, supabase);
  const auth = await canManageMatch(id, membership.profileId);
  if (!auth.authorized) throw new ApiError("Not authorized to edit this match", 403);
  if (match.status === "pending" || match.status === "approved") {
    throw new ApiError("An approved or pending match cannot be edited", 409);
  }

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("Invalid match update", 422);
  const input = parsed.data;

  const { data, error } = await supabase.rpc("edit_real_match_details", { p_match: id, p_version: match.version, p_details: input });
  return Response.json({ match: confirmedRow(data, error, "Could not edit match", match.league_id) });
});

export const DELETE = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const supabase = await getSupabase();
  const match = await loadMatch(id, supabase);
  if (!match) throw new ApiError("Match not found", 404);
  const membership = await requireMember(match.league_id, supabase);
  const auth = await canManageMatch(id, membership.profileId);
  if (!auth.authorized) throw new ApiError("You cannot delete this match", 403);
  if (match.status === "approved") throw new ApiError("Approved matches are permanent", 409);
  const result = await supabase.from("real_matches").delete().eq("id", id).eq("league_id", match.league_id).select("id").maybeSingle();
  confirmedRow(result.data, result.error, "Could not delete match");
  return Response.json({ ok: true });
});
