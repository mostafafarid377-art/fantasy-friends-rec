/**
 * Points service — the only place official fantasy points are produced.
 *
 * Called exclusively after a League Leader approves a real match, inside a
 * single transaction. Upserts are keyed on (match, player) and
 * (match, manager), so re-running never duplicates points. Standings are
 * rebuilt from the aggregated ledger rather than incremented in place.
 *
 * All writes go through Supabase SECURITY DEFINER RPCs that run as the
 * function owner, so clients never need direct write access to point
 * ledgers.
 */

import { getSupabase } from "@/db";
import type { Position } from "@/lib/domain";

export class PointsError extends Error {}

export type PointsSummary = {
  matchId: string;
  version: number;
  players: number;
  managers: number;
  rulesApproved: boolean;
};

/**
 * Recalculates player and manager points for an approved match, then
 * rebuilds standings. Delegates to the `calculate_match_points` RPC which
 * runs server-side with LEADER authorization and point-ledger write access.
 */
export async function recalculateMatchPoints(
  matchId: string,
  opts: { actorId: string },
): Promise<PointsSummary> {
  const supabase = await getSupabase();

  const { data, error } = await supabase.rpc("calculate_match_points", {
    p_match: matchId,
  });

  if (error) throw new PointsError(error.message || "Points calculation failed");

  return {
    matchId,
    version: data?.version ?? 0,
    players: data?.players ?? 0,
    managers: data?.managers ?? 0,
    rulesApproved: true,
  };
}

/** Recalculates standings for a league from the manager_points ledger. */
export async function recalculateStandings(leagueId: string) {
  const supabase = await getSupabase();

  const { data, error } = await supabase.rpc("recalculate_standings", {
    p_league: leagueId,
  });

  if (error) throw new Error(error.message || "Standings recalculation failed");

  return data?.length ?? 0;
}

/** Guard used by API routes — confirms a profile really belongs to a league. */
export async function assertLeagueAccess(leagueId: string, profileId: string) {
  const supabase = await getSupabase();
  const { data } = await supabase
    .from("league_members")
    .select("role")
    .eq("league_id", leagueId)
    .eq("profile_id", profileId)
    .maybeSingle();
  return data?.role ?? null;
}

export const pointsTableNames = {
  playerMatchPoints: "player_match_points",
  managerPoints: "manager_points",
  leagueStandings: "league_standings",
  fantasyPointsHistory: "fantasy_points_history",
  scoringRules: "scoring_rules",
  matchEvents: "match_events",
  matchLineups: "match_lineups",
  matchSubstitutions: "match_substitutions",
  realMatches: "real_matches",
  fantasySquads: "fantasy_squads",
  fantasySquadPlayers: "fantasy_squad_players",
  profiles: "profiles",
};