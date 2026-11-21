import { NextRequest } from "next/server";
import { getSupabase } from "@/db";
import { checkDb, handler, requireMember } from "@/lib/server";
import { categoryLabel } from "@/lib/scoring";
import type { DisplayPlayerPoints } from "@/lib/live-points";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const sb = await getSupabase();
  await requireMember(id, sb);
  const matchId = req.nextUrl.searchParams.get("matchId");
  const [points, players, rules, events] = await Promise.all([
    sb.rpc("ff_display_player_points", { p_league: id, p_match: matchId }).order("provisional", { ascending: false }).order("computed_at").order("match_id").order("player_id"),
    sb.from("players").select("id,full_name,position").eq("league_id", id),
    sb.from("scoring_rules").select("*").eq("league_id", id),
    matchId ? sb.from("match_events").select("id,match_id,player_id,event_type,minute,assist_player_id").eq("league_id", id).eq("match_id", matchId)
      : sb.from("match_events").select("id,match_id,player_id,event_type,minute,assist_player_id").eq("league_id", id),
  ]);
  for (const result of [points, players, rules, events]) checkDb(result.error, "Could not load player points");
  const byPlayer = new Map((players.data ?? []).map((p) => [p.id, p]));
  const matches = new Map<string, { id: string; title: string; kickOff: string; status: string }>();
  const rows = ((points.data ?? []) as DisplayPlayerPoints[]).map((p) => {
    matches.set(p.match_id, { id: p.match_id, title: p.title, kickOff: p.kick_off, status: p.status });
    const player = byPlayer.get(p.player_id);
    return { matchId: p.match_id, matchTitle: p.title, kickOff: p.kick_off, playerId: p.player_id,
      playerName: player?.full_name ?? "Unknown", position: player?.position ?? null, points: Number(p.points),
      started: p.started, computedAt: p.computed_at, provisional: p.provisional,
      breakdown: (Array.isArray(p.breakdown) ? p.breakdown : []).map((b) => ({ ...b, label: b.label ?? categoryLabel(b.category) })),
      events: (events.data ?? []).filter((e) => e.match_id === p.match_id && (e.player_id === p.player_id || e.assist_player_id === p.player_id))
        .map((e) => ({ id: e.id, type: e.player_id === p.player_id ? e.event_type : "assist", minute: e.minute, assistPlayerId: e.assist_player_id })),
    };
  });
  return Response.json({ approvedRules: Boolean(rules.data?.length && rules.data.every((r) => r.status === "approved")),
    rules: rules.data ?? [], rows, matches: [...matches.values()] });
});
