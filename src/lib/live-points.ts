import type { BreakdownLine } from "./scoring";

export type LiveMatchPoints = { matchId: string; title: string; kickOff: string; points: number };
export type DisplayPlayerPoints = {
  match_id: string; player_id: string; title: string; kick_off: string; status: string;
  points: number; breakdown: BreakdownLine[]; started: boolean; provisional: boolean; computed_at: string;
};

export type MyDisplayStanding = {
  league_id: string; rank: number; total_points: number; matches_played: number; provisional: boolean;
};
