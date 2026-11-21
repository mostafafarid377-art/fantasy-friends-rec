import { NextRequest } from "next/server";
import { getSupabase } from "@/db";
import { handler, requireMember } from "@/lib/server";
import { categoryLabel } from "@/lib/scoring";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const membership = await requireMember(id);
  const matchId = new URL(req.url).searchParams.get("matchId");

  const supabase = await getSupabase();

  let query = supabase.from("player_match_points").select("*").eq("league_id", id);
  if (matchId) {
    query = query.eq("match_id", matchId);
  }
  query = query.order("computed_at", { ascending: true });

  const { data: points } = await query;

  if (!points?.length) {
    return Response.json({ rows: [], matches: [], approvedRules: false });
  }

  const playerIds = [...new Set(points.map((p: any) => p.player_id))];
  const matchIds = [...new Set(points.map((p: any) => p.match_id))];

  const [
    playerRowsResp,
    matchRowsResp,
    ruleRowsResp,
    eventRowsResp,
    lineupRowsResp,
  ] = await Promise.all([
    supabase.from("players").select("*").eq("league_id", id),
    supabase.from("real_matches").select("*").eq("league_id", id),
    supabase.from("scoring_rules").select("*").eq("league_id", id),
    supabase.from("match_events").select("*").eq("league_id", id),
    supabase.from("match_scoring_lineups").select("*").eq("league_id", id),
  ]);
  const playerRows = (playerRowsResp as any)?.data ?? [];
  const matchRows = (matchRowsResp as any)?.data ?? [];
  const ruleRows = (ruleRowsResp as any)?.data ?? [];
  const eventRows = (eventRowsResp as any)?.data ?? [];
  const lineupRows = (lineupRowsResp as any)?.data ?? [];

  const playerById = new Map<string, any>(playerRows.map((p: any) => [p.id, p]));
  const matchById = new Map<string, any>(matchRows.map((m: any) => [m.id, m]));

  return Response.json({
    approvedRules: ruleRows.every((r: any) => r.status === "approved"),
    rules: ruleRows,
    rows: points.map((p: any) => {
      const breakdown = Array.isArray(p.breakdown)
        ? (p.breakdown as { category: string; label?: string; count: number; pointsPer: number; points: number }[])
        : [];
      const match = matchById.get(p.match_id);
      const player = playerById.get(p.player_id);
      const events = eventRows.filter(
        (e: any) => e.match_id === p.match_id && e.player_id === p.player_id,
      );
      const started = lineupRows.some(
        (l: any) => l.match_id === p.match_id && l.player_id === p.player_id && l.slot === "starter",
      );
      return {
        matchId: p.match_id,
        matchTitle: match?.title ?? "Match",
        kickOff: match?.kick_off ?? null,
        playerId: p.player_id,
        playerName: player?.full_name ?? "Unknown",
        position: player?.position ?? null,
        points: p.points,
        started,
        breakdown: breakdown.map((b: any) => ({
          ...b,
          label: b.label ?? categoryLabel(b.category),
        })),
        events: events.map((e: any) => ({
          id: e.id,
          type: e.event_type,
          minute: e.minute,
          assistPlayerId: e.assist_player_id,
        })),
        computedAt: p.computed_at,
      };
    }),
    matches: (matchRows as any[])
      .filter((m: any) => matchIds.includes(m.id))
      .map((m: any) => ({ id: m.id, title: m.title, kickOff: m.kick_off, status: m.status })),
  });
});