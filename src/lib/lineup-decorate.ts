import type { SupabaseClient } from "@/db";
import { checkDb } from "@/lib/db-result";
import { playerPhotoUrl } from "@/lib/player-photo";
import type { MatchLineup } from "@/lib/next-match-lineup";

/**
 * Keep historical positions, names and order from the verified snapshot.
 * Photos and active status are display data only; a missing current player is
 * archived. Shared by every route that renders a match lineup so the My Team
 * page and the Dashboard can never drift apart on the same snapshot.
 */
export async function decorateLineupPlayers(sb: SupabaseClient, league: string, lineups: MatchLineup[]) {
  const ids = [...new Set(lineups.flatMap((l) => l.players.map((p) => p.id)))];
  if (!ids.length) return;
  const { data, error } = await sb.from("players").select("id,photo_url,shirt_number,status,availability,team_id,position")
    .eq("league_id", league).in("id", ids);
  checkDb(error, "Could not load lineup players");
  const byId = new Map((data ?? []).map((p) => [p.id, p]));
  for (const l of lineups) l.players = l.players.map((p) => {
    const row = byId.get(p.id);
    return { ...p, photoUrl: playerPhotoUrl(row?.photo_url ?? null, league, p.id), shirtNumber: row?.shirt_number ?? null,
      status: row?.position === p.position ? row.status : "archived", availability: row?.availability ?? "unavailable", teamId: row?.team_id ?? null };
  });
}
