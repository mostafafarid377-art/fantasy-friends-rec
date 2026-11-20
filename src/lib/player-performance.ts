import type { BreakdownLine } from "./scoring";
import type { Position } from "./domain";

export type LatestPlayerGame = { matchId: string; points: number | null; captainPoints?: number };
export type LatestPlayerGames = Record<string, LatestPlayerGame>;
export type PlayerGame = LatestPlayerGame & {
  title: string;
  kickOff: string;
  gameweek: number | null;
  opponent: string | null;
  participation: "played" | "did_not_play" | "unknown";
  breakdown: BreakdownLine[];
};
export type PlayerHistory = {
  games: PlayerGame[];
  next: { kickOff: string; matchId: string } | null;
};
export type PlayerPerformance = PlayerHistory & {
  player: { name: string; position: Position; photoUrl: string | null; team: string | null };
};

export function formatPlayerPoints(points: number | null | undefined) {
  return points == null ? "—" : `${points} pts`;
}
