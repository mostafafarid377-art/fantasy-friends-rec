import type { BreakdownLine } from "./scoring";

/**
 * The public Man-of-the-Match card model. Stats come from the match's scoring
 * record for the chosen player — the MOTM table only stores the choice and an
 * optional photo, never the numbers, so the card can never disagree with the
 * match breakdown.
 */
export type Motm = {
  matchId: string;
  matchTitle: string;
  kickOff: string | null;
  playerId: string;
  playerName: string;
  club: string | null;
  photoUrl: string | null;
  points: number;
  goals: number;
  assists: number;
  createdAt: string | null;
};

function categoryCount(breakdown: BreakdownLine[], category: string): number {
  const line = breakdown.find((b) => b?.category === category);
  return line && typeof line.count === "number" ? line.count : 0;
}

/**
 * Build the card stats from one player's scoring breakdown. Points prefer the
 * authoritative `points` column; goals/assists read the scoring categories.
 */
export function motmStats(points: number | string | null, breakdown: BreakdownLine[] | null | undefined) {
  const lines = Array.isArray(breakdown) ? breakdown : [];
  const computed = points == null || points === "" ? NaN : Number(points);
  return {
    points: Number.isFinite(computed) ? computed : lines.reduce((s, b) => s + (typeof b?.points === "number" ? b.points : 0), 0),
    goals: categoryCount(lines, "goal"),
    assists: categoryCount(lines, "assist"),
  };
}
