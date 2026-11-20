import { SCORING_CATEGORIES, type Position } from "@/lib/domain";
import type { ScoringRule } from "@/lib/scoring";

/** Crockford-style invite code: no 0/O/1/I ambiguity. */
export function inviteCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

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