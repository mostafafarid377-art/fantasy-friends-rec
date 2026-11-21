import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/db";
import { ApiError, checkDb, confirmedRow, creationId, handler, requireMember, requireIdentity, canManageMatch } from "@/lib/server";
import { EVENT_TYPES } from "@/lib/domain";
import { loadMatch } from "@/lib/matches";

type Ctx = { params: Promise<{ id: string }> };

const eventSchema = z.object({
  teamId: z.string().min(1),
  playerId: z.string().min(1),
  assistPlayerId: z.string().min(1).nullable().optional(),
  eventType: z.enum(EVENT_TYPES),
  minute: z.number().int().min(0).max(200).optional(),
  note: z.string().max(240).nullable().optional(),
});

const subSchema = z.object({
  kind: z.literal("substitution"),
  teamId: z.string().min(1),
  playerOnId: z.string().min(1),
  playerOffId: z.string().min(1),
  minute: z.number().int().min(0).max(200),
});

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
    supabase.from("match_events").select("*").eq("match_id", id).order("created_at").order("id"),
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
  const sub = subSchema.safeParse(body);
  const event = eventSchema.safeParse(body);
  if (!sub.success && !event.success) throw new ApiError("Invalid match event", 422, event.error.flatten().fieldErrors);
  const sb = await getSupabase();
  const actor = await requireIdentity(sb);
  const { match } = await canManageMatch(id, actor.id);
  const kind = sub.success ? "substitution" : "event";
  const input = sub.success ? sub.data : event.data!;
  const operationId = creationId(req, actor.id, `${kind}/${id}`, input);
  const payload = sub.success ? { teamId: sub.data.teamId, playerId: sub.data.playerOnId,
    otherId: sub.data.playerOffId, minute: sub.data.minute }
    : { ...event.data, otherId: event.data?.assistPlayerId ?? null };
  const { data, error } = await sb.rpc("write_match_event", { p_match: id, p_id: operationId, p_action: kind, p_data: payload });
  const saved = confirmedRow(data, error, `Could not record ${kind}`, match.league_id);
  if (saved.id !== operationId) throw new ApiError(`The saved ${kind} could not be confirmed`, 409);
  return Response.json({ [kind]: saved }, { status: 201 });
});

const patchSchema = z.object({
  action: z.enum(["update", "delete"]), eventId: z.string().min(1),
  data: eventSchema.omit({ teamId: true }).partial().optional(),
});

async function editMatchEvent(id: string, eventId: string, action: "update" | "delete", input?: z.infer<typeof patchSchema>["data"]) {
  const sb = await getSupabase();
  const user = await requireIdentity(sb);
  const { match } = await canManageMatch(id, user.id);
  const { data, error } = await sb.rpc("write_match_event", {
    p_match: id, p_id: eventId, p_action: action,
    p_data: { ...input, ...(input?.assistPlayerId !== undefined ? { otherId: input.assistPlayerId } : {}) },
  });
  const row = confirmedRow(data, error, `Could not ${action} event`, match.league_id);
  return Response.json(action === "delete" ? { ok: true, deleted: true } : { event: row });
}

export const PATCH = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const result = patchSchema.safeParse(await req.json().catch(() => null));
  if (!result.success) throw new ApiError("Invalid event update", 422);
  return editMatchEvent(id, result.data.eventId, result.data.action, result.data.data);
});

export const DELETE = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const eventId = new URL(req.url).searchParams.get("eventId");
  if (!eventId) throw new ApiError("eventId is required", 400);
  return editMatchEvent(id, eventId, "delete");
});
