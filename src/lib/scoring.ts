/**
 * Deterministic fantasy points engine.
 *
 * Points are computed ONLY from approved real-match events + approved
 * scoring rules. Every calculation is a pure function of its inputs, so
 * the same inputs always produce the same output and results can be
 * recomputed safely (upserts keyed by match+player prevent duplicates).
 *
 * IMPORTANT: numerical values are never invented here. Leagues ship with
 * a DRAFT rule set created in code; only rules the League Leader has
 * approved are used for official points.
 */

import type { Position } from "./domain";

export type RuleStatus = "draft" | "approved";

export type ScoringRule = {
  position: Position;
  category: string;
  points: number;
  status: RuleStatus;
};

export type MatchEventInput = {
  playerId: string;
  teamId: string;
  assistPlayerId?: string | null;
  eventType: string;
};

export type LineupEntry = {
  playerId: string;
  teamId: string;
  position: Position;
  slot: "starter" | "sub";
};

export type MatchResult = { teamAId: string; teamBId: string };

export type BreakdownLine = {
  category: string;
  label: string;
  count: number;
  pointsPer: number;
  points: number;
};

export type PlayerPoints = {
  playerId: string;
  points: number;
  breakdown: BreakdownLine[];
};

const LABELS: Record<string, string> = {
  goal: "Goal",
  own_goal: "Own goal",
  assist: "Assist",
  yellow_card: "Yellow card",
  red_card: "Red card",
  penalty_saved: "Penalty saved",
  penalty_missed: "Penalty missed",
  appearance: "Appearance",
  clean_sheet: "Clean sheet",
  win: "Match win",
  draw: "Match draw",
};

export function categoryLabel(category: string): string {
  return LABELS[category] ?? category;
}

/** Rules are usable only when every rule in the league has been approved. */
export function usableRules(rules: ScoringRule[]): ScoringRule[] {
  if (!rules.length) return [];
  if (rules.some((r) => r.status !== "approved")) return [];
  return rules;
}

function lookup(
  rules: ScoringRule[],
  position: Position,
  category: string,
): number {
  const hit = rules.find((r) => r.position === position && r.category === category);
  return hit ? Number(hit.points) : 0;
}

function goalsConceded(teamId: string, events: MatchEventInput[]): number {
  // Goals credited to a side count against the opposing side. Own goals are
  // scored against the offender's own team.
  return events.filter((e) => {
    if (e.eventType === "goal") return e.teamId !== teamId;
    if (e.eventType === "own_goal") return e.teamId === teamId;
    return false;
  }).length;
}

export type ComputeInput = {
  rules: ScoringRule[];
  events: MatchEventInput[];
  lineup: LineupEntry[];
  result: MatchResult;
  /** players who actually took part (started or came on) */
  participants: string[];
};

/**
 * Pure per-player computation for one approved match.
 */
export function computePlayerPoints(input: ComputeInput): PlayerPoints[] {
  const rules = usableRules(input.rules);
  const out: PlayerPoints[] = [];

  for (const entry of input.lineup) {
    const { playerId, position, teamId } = entry;
    if (!input.participants.includes(playerId)) continue;

    const breakdown: BreakdownLine[] = [];
    const push = (category: string, count: number) => {
      if (count <= 0) return;
      const per = lookup(rules, position, category);
      if (per === 0) return;
      breakdown.push({
        category,
        label: categoryLabel(category),
        count,
        pointsPer: per,
        points: per * count,
      });
    };

    push("appearance", 1);

    const conceded = goalsConceded(teamId, input.events);
    if (conceded === 0 && entry.slot === "starter") push("clean_sheet", 1);

    const own = input.events.filter(
      (e) => e.playerId === playerId && e.eventType === "goal",
    ).length;
    push("goal", own);

    const assists = input.events.filter(
      (e) => e.assistPlayerId === playerId && e.eventType === "goal",
    ).length + input.events.filter(
      (e) => e.playerId === playerId && e.eventType === "assist",
    ).length;
    push("assist", assists);

    push(
      "own_goal",
      input.events.filter((e) => e.playerId === playerId && e.eventType === "own_goal").length,
    );
    push(
      "yellow_card",
      input.events.filter((e) => e.playerId === playerId && e.eventType === "yellow_card").length,
    );
    push(
      "red_card",
      input.events.filter((e) => e.playerId === playerId && e.eventType === "red_card").length,
    );
    push(
      "penalty_saved",
      input.events.filter((e) => e.playerId === playerId && e.eventType === "penalty_saved").length,
    );
    push(
      "penalty_missed",
      input.events.filter((e) => e.playerId === playerId && e.eventType === "penalty_missed").length,
    );

    out.push({
      playerId,
      points: breakdown.reduce((s, b) => s + b.points, 0),
      breakdown,
    });
  }

  return out;
}

export type ManagerInput = {
  /** the manager's selected starters for this match */
  starters: { playerId: string; position: Position }[];
  captainId?: string | null;
  viceCaptainId?: string | null;
  /** vice takes the double only when configured to do so */
  vicePolicy: "auto_captain" | "none";
  playerPoints: Map<string, number>;
  playedIds: Set<string>;
  rules: ScoringRule[];
};

export type ManagerPoints = {
  points: number;
  captainId: string | null;
  breakdown: {
    playerId: string;
    base: number;
    multiplier: number;
    points: number;
  }[];
};

/**
 * Sums a manager's starting players, applying the captain ×2 multiplier.
 * If the captain did not play and the league policy allows it, the
 * vice-captain receives the double instead.
 */
export function computeManagerPoints(input: ManagerInput): ManagerPoints {
  const rules = usableRules(input.rules);
  void rules;
  const activeCaptain = input.captainId && input.playedIds.has(input.captainId)
    ? input.captainId
    : input.vicePolicy === "auto_captain" && input.viceCaptainId &&
        input.playedIds.has(input.viceCaptainId)
      ? input.viceCaptainId
      : null;

  const breakdown: ManagerPoints["breakdown"] = [];
  let total = 0;

  for (const s of input.starters) {
    const base = input.playerPoints.get(s.playerId) ?? 0;
    if (!input.playedIds.has(s.playerId)) {
      breakdown.push({ playerId: s.playerId, base: 0, multiplier: 1, points: 0 });
      continue;
    }
    const multiplier = s.playerId === activeCaptain ? 2 : 1;
    const points = base * multiplier;
    total += points;
    breakdown.push({ playerId: s.playerId, base, multiplier, points });
  }

  return { points: total, captainId: activeCaptain, breakdown };
}

/* ------------------------------------------------------------------ */
/* Draft rule set — DRAFT CONFIGURATION, requires League Leader        */
/* approval before it can produce official points.                     */
/* ------------------------------------------------------------------ */

const DRAFT_TEMPLATE: { position: Position; category: string; points: number }[] = [
  { position: "FWD", category: "goal", points: 4 },
  { position: "MID", category: "goal", points: 5 },
  { position: "DEF", category: "goal", points: 6 },
  { position: "GK", category: "goal", points: 8 },
  { position: "FWD", category: "assist", points: 3 },
  { position: "MID", category: "assist", points: 3 },
  { position: "DEF", category: "assist", points: 3 },
  { position: "GK", category: "assist", points: 3 },
  { position: "GK", category: "clean_sheet", points: 2 },
  { position: "DEF", category: "clean_sheet", points: 2 },
  { position: "MID", category: "clean_sheet", points: 1 },
  { position: "FWD", category: "clean_sheet", points: 0 },
  { position: "GK", category: "appearance", points: 1 },
  { position: "DEF", category: "appearance", points: 1 },
  { position: "MID", category: "appearance", points: 1 },
  { position: "FWD", category: "appearance", points: 1 },
  { position: "GK", category: "yellow_card", points: -1 },
  { position: "DEF", category: "yellow_card", points: -1 },
  { position: "MID", category: "yellow_card", points: -1 },
  { position: "FWD", category: "yellow_card", points: -1 },
  { position: "GK", category: "red_card", points: -3 },
  { position: "DEF", category: "red_card", points: -3 },
  { position: "MID", category: "red_card", points: -3 },
  { position: "FWD", category: "red_card", points: -3 },
  { position: "GK", category: "penalty_saved", points: 3 },
  { position: "DEF", category: "penalty_missed", points: -1 },
  { position: "MID", category: "penalty_missed", points: -1 },
  { position: "FWD", category: "penalty_missed", points: -1 },
  { position: "GK", category: "own_goal", points: -2 },
  { position: "DEF", category: "own_goal", points: -2 },
  { position: "MID", category: "own_goal", points: -2 },
  { position: "FWD", category: "own_goal", points: -2 },
];

export const DRAFT_RULE_SET = DRAFT_TEMPLATE.map((r) => ({
  ...r,
  status: "draft" as RuleStatus,
}));
