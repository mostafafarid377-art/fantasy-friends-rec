/**
 * Draft scoring configuration.
 *
 * Every new league is seeded with these values in `draft` status. They are
 * NEVER used for official points until the League Leader approves them from
 * the Scoring Rules screen. Values are configuration, not code — the leader
 * can edit each figure before approving.
 */

import { POSITIONS, SCORING_CATEGORIES, type Position } from "@/lib/domain";
import type { ScoringRule } from "@/lib/scoring";

/** Crockford-style invite code: no 0/O/1/I ambiguity. */
export function inviteCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

type DraftRow = { position: Position; category: string; points: number };

const SEED: Omit<DraftRow, "position">[] = [
  { category: "goal", points: 4 },
  { category: "assist", points: 3 },
  { category: "clean_sheet", points: 2 },
  { category: "appearance", points: 1 },
  { category: "yellow_card", points: -1 },
  { category: "red_card", points: -3 },
  { category: "own_goal", points: -2 },
  { category: "penalty_saved", points: 3 },
  { category: "penalty_missed", points: -1 },
  { category: "win", points: 0 },
  { category: "draw", points: 0 },
];

/** Position-aware starting values — clearly marked DRAFT until approved. */
export const DEFAULT_DRAFT_RULES: DraftRow[] = POSITIONS.flatMap((position) =>
  SEED.map((row) => ({ position, category: row.category, points: row.points })),
);

export const RULE_CATEGORIES = SCORING_CATEGORIES;

export function toScoringRules(
  rows: { position: string; event_type: string; points: string; status: string }[],
): ScoringRule[] {
  return rows.map((r) => ({
    position: r.position as Position,
    category: r.event_type,
    points: Number(r.points),
    status: r.status === "approved" ? "approved" : "draft",
  }));
}