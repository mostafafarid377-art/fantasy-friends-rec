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
    // Only the approval state of the rules is shown on this screen, so the
    // rule table is read as a status column instead of as every rule value.
    sb.from("scoring_rules").select("status").eq("league_id", id),
    // The scoped RPC returns the same rows and columns the direct table read
    // returned, but checks the caller's membership once per request instead of
    // once per scanned row (row-level security stays as-is for direct reads).
    matchId ? sb.rpc("ff_league_match_events", { p_league: id, p_match: matchId })
      : sb.rpc("ff_league_match_events", { p_league: id }),
  ]);
  for (const result of [points, players, rules, events]) checkDb(result.error, "Could not load player points");
  const byPlayer = new Map((players.data ?? []).map((p) => [p.id, p]));
  // Group the events once by (match, involved player); matching them per
  // points row with a filter over the whole league history was quadratic.
  type LeagueEvent = { id: string; match_id: string; player_id: string; event_type: string; minute: number | null; assist_player_id: string | null };
  const eventsByPlayer = new Map<string, LeagueEvent[]>();
  for (const e of (events.data ?? []) as LeagueEvent[]) {
    const keys = [`${e.match_id}|${e.player_id}`];
    if (e.assist_player_id && e.assist_player_id !== e.player_id) keys.push(`${e.match_id}|${e.assist_player_id}`);
    for (const key of keys) {
      const bucket = eventsByPlayer.get(key);
      if (bucket) bucket.push(e);
      else eventsByPlayer.set(key, [e]);
    }
  }
  const matches = new Map<string, { id: string; title: string; kickOff: string; status: string }>();
  const rows = ((points.data ?? []) as DisplayPlayerPoints[]).map((p) => {
    matches.set(p.match_id, { id: p.match_id, title: p.title, kickOff: p.kick_off, status: p.status });
    const player = byPlayer.get(p.player_id);
    return { matchId: p.match_id, matchTitle: p.title, kickOff: p.kick_off, playerId: p.player_id,
      playerName: player?.full_name ?? "Unknown", position: player?.position ?? null, points: Number(p.points),
      started: p.started, computedAt: p.computed_at, provisional: p.provisional,
      breakdown: (Array.isArray(p.breakdown) ? p.breakdown : []).map((b) => ({ ...b, label: b.label ?? categoryLabel(b.category) })),
      events: (eventsByPlayer.get(`${p.match_id}|${p.player_id}`) ?? [])
        .map((e) => ({ id: e.id, type: e.player_id === p.player_id ? e.event_type : "assist", minute: e.minute, assistPlayerId: e.assist_player_id })),
    };
  });
  return Response.json({ approvedRules: Boolean(rules.data?.length && rules.data.every((r) => r.status === "approved")),
    rows, matches: [...matches.values()] });
});
