import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, handler, logActivity, requireMember, requireUser, canManageMatch } from "@/lib/server";
import { EVENT_TYPES } from "@/lib/domain";
import { loadMatch } from "@/lib/matches";

type Ctx = { params: Promise<{ id: string }> };

const eventSchema = z.object({
  teamId: z.string().min(1),
  playerId: z.string().min(1),
  assistPlayerId: z.string().min(1).nullable().optional(),
  eventType: z.enum(EVENT_TYPES),
  minute: z.number().int().min(0).max(200),
  note: z.string().max(240).nullable().optional(),
});

const subSchema = z.object({
  kind: z.literal("substitution"),
  teamId: z.string().min(1),
  playerOnId: z.string().min(1),
  playerOffId: z.string().min(1),
  minute: z.number().int().min(0).max(200),
});

/**
 * Verifies the user is authorized to manage match events. Both the League
 * Leader and the assigned Match Organizer have full authority.
 */
async function assertEditable(matchId: string, profileId: string) {
  const auth = await canManageMatch(matchId, profileId);
  if (!auth.authorized) throw new ApiError("Not authorized to manage this match", 403);
  if (auth.match.status === "pending" || auth.match.status === "approved") {
    throw new ApiError("Events are locked while the match is pending or approved", 409);
  }
  return { matchId, leagueId: auth.match.league_id, organizerId: auth.match.organizer_id, status: auth.match.status, actorRole: auth.membership.role, profileId };
}

async function assertInLineup(matchId: string, teamId: string, playerId: string) {
  const supabase = await getSupabase();
  const { data: rows } = await supabase
    .from("match_lineups")
    .select("*")
    .eq("match_id", matchId)
    .eq("team_id", teamId)
    .eq("player_id", playerId)
    .maybeSingle();
  if (!rows) throw new ApiError("That player is not in the team's matchday selection", 422);
}

async function sideOf(matchId: string, teamId: string) {
  const match = await loadMatch(matchId);
  return match && (match.team_a_id === teamId || match.team_b_id === teamId);
}

export const GET = handler(async (_req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const match = await loadMatch(id);
  if (!match) throw new ApiError("Match not found", 404);
  await requireMember(match.league_id);

  const supabase = await getSupabase();
  const [
    eventsResp,
    subsResp,
    rosterResp,
  ] = await Promise.all([
    supabase.from("match_events").select("*").eq("match_id", id).order("minute", { ascending: true }),
    supabase.from("match_substitutions").select("*").eq("match_id", id).order("minute", { ascending: true }),
    supabase.from("players").select("*").eq("league_id", match.league_id),
  ]);
  const events = (eventsResp as any)?.data ?? [];
  const subs = (subsResp as any)?.data ?? [];
  const roster = (rosterResp as any)?.data ?? [];
  const byId = new Map<string, any>(roster.map((p: any) => [p.id, p]));

  return Response.json({
    events: events.map((e: any) => ({
      ...e,
      playerName: byId.get(e.player_id)?.full_name ?? "Unknown",
      assistName: e.assist_player_id ? (byId.get(e.assist_player_id)?.full_name ?? null) : null,
    })),
    substitutions: subs.map((s: any) => ({
      ...s,
      onName: byId.get(s.player_on_id)?.full_name ?? "Unknown",
      offName: byId.get(s.player_off_id)?.full_name ?? "Unknown",
    })),
  });
});

export const POST = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!body) throw new ApiError("Request body is required", 400);

  const subParsed = subSchema.safeParse(body);
  if (subParsed.success) {
    const input = subParsed.data as z.infer<typeof subSchema>;
    const user = await requireUser();
    const actor = user.id;
    const edit = await assertEditable(id, actor);
    const { matchId, leagueId } = edit;

    if (!(await sideOf(matchId, input.teamId))) {
      throw new ApiError("Team is not part of this match", 422);
    }
    await assertInLineup(matchId, input.teamId, input.playerOnId);
    await assertInLineup(matchId, input.teamId, input.playerOffId);

    const supabase = await getSupabase();
    const { data: created } = await supabase
      .from("match_substitutions")
      .insert({
        match_id: matchId,
        league_id: leagueId,
        team_id: input.teamId,
        player_on_id: input.playerOnId,
        player_off_id: input.playerOffId,
        minute: input.minute,
        created_by: actor,
      })
      .select()
      .maybeSingle();
    await logActivity(leagueId, actor, "match.substitution", `Substitution recorded at ${input.minute}'`);
    return Response.json({ substitution: created }, { status: 201 });
  }

  const parsed = eventSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("Invalid event payload", 422, parsed.error.flatten().fieldErrors);
  const input = parsed.data;

  const user = await requireUser();
  const actor = user.id;
  const edit = await assertEditable(id, actor);
  const { matchId, leagueId } = edit;

  if (!(await sideOf(matchId, input.teamId))) throw new ApiError("Team is not part of this match", 422);
  await assertInLineup(matchId, input.teamId, input.playerId);
  if (input.assistPlayerId) await assertInLineup(matchId, input.teamId, input.assistPlayerId);

  const supabase = await getSupabase();
  const { data: created } = await supabase
    .from("match_events")
    .insert({
      match_id: matchId,
      league_id: leagueId,
      team_id: input.teamId,
      player_id: input.playerId,
      assist_player_id: input.assistPlayerId ?? null,
      event_type: input.eventType,
      minute: input.minute,
      note: input.note ?? null,
      created_by: actor,
    })
    .select()
    .maybeSingle();

  await logActivity(leagueId, actor, `match.event.${input.eventType}`, `Event recorded at ${input.minute}'`);
  return Response.json({ event: created }, { status: 201 });
});

export const PATCH = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = z
    .object({
      action: z.enum(["update", "delete"]),
      eventId: z.string().min(1),
      data: z
        .object({
          minute: z.number().int().min(0).max(200),
          eventType: z.enum(EVENT_TYPES),
          playerId: z.string().min(1),
          assistPlayerId: z.string().min(1).nullable(),
          note: z.string().max(240).nullable(),
        })
        .partial()
        .optional(),
    })
    .safeParse(body);
  if (!parsed.success) throw new ApiError("Invalid event update", 422);
  const { action, eventId, data } = parsed.data;

  const user = await requireUser();
  const actor = user.id;
  const edit = await assertEditable(id, actor);

  const supabase = await getSupabase();
  const { data: existing } = await supabase
    .from("match_events")
    .select("*")
    .eq("id", eventId)
    .eq("match_id", id)
    .maybeSingle();
  if (!existing) throw new ApiError("Event not found", 404);

  if (action === "delete") {
    await supabase.from("match_events").delete().eq("id", eventId);
    await logActivity(edit.leagueId, actor, "match.event.deleted", "Event removed");
    return Response.json({ ok: true, deleted: true });
  }

  const { data: updated } = await supabase
    .from("match_events")
    .update({
      ...data,
      updated_at: new Date().toISOString(),
    })
    .eq("id", eventId)
    .select()
    .maybeSingle();
  await logActivity(edit.leagueId, actor, "match.event.updated", "Event corrected");
  return Response.json({ event: updated });
});

export const DELETE = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const eventId = new URL(req.url).searchParams.get("eventId");
  if (!eventId) throw new ApiError("eventId is required", 400);
  const user = await requireUser();
  const actor = user.id;
  const edit = await assertEditable(id, actor);
  const supabase = await getSupabase();
  const { data: rows } = await supabase
    .from("match_events")
    .delete()
    .eq("id", eventId)
    .eq("match_id", id)
    .select();
  if (!rows?.length) throw new ApiError("Event not found", 404);
  await logActivity(edit.leagueId, actor, "match.event.deleted", "Event removed");
  return Response.json({ ok: true });
});
