/**
 * Domain constants + the pure squad / formation engine.
 * Every rule here is enforced again server-side before any write.
 */

export const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;
export type Position = (typeof POSITIONS)[number];

export const FORMATS = ["5v5", "7v7"] as const;
export type LeagueFormat = (typeof FORMATS)[number];

export const STARTERS_BY_FORMAT: Record<LeagueFormat, number> = {
  "5v5": 5,
  "7v7": 7,
};

export const ROLES = ["leader", "manager", "organizer"] as const;
export type MemberRole = (typeof ROLES)[number];

export const EVENT_TYPES = [
  "goal",
  "own_goal",
  "assist",
  "yellow_card",
  "red_card",
  "penalty_saved",
  "penalty_missed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Derived categories the scoring engine can also award points for. */
export const DERIVED_CATEGORIES = [
  "appearance",
  "clean_sheet",
  "win",
  "draw",
] as const;
export type DerivedCategory = (typeof DERIVED_CATEGORIES)[number];

export type ScoringCategory = EventType | DerivedCategory;

export const SCORING_CATEGORIES: ScoringCategory[] = [
  ...EVENT_TYPES,
  ...DERIVED_CATEGORIES,
];

export const MATCH_STATUSES = ["draft", "pending", "approved", "rejected"];
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const AVAILABILITY = ["available", "doubt", "injured", "suspended"];

/* ------------------------------------------------------------------ */
/* Formations                                                          */
/* ------------------------------------------------------------------ */

export type Formation = {
  /** displayed label, GK included: "1-4-1" */
  label: string;
  /** outfield line counts, back → front */
  lines: number[];
};

const mk = (...lines: number[]): Formation => ({
  label: lines.map(String).join("-"),
  lines,
});

/**
 * Allowed shapes per format. `lines` are outfield lines only — the
 * goalkeeper is always present and never counted in the formation label,
 * so every formation must sum to `starters - 1`.
 */
export const FORMATIONS: Record<LeagueFormat, Formation[]> = {
  "5v5": [
    mk(1, 2, 1),
    mk(1, 1, 2),
    mk(2, 1, 1),
    mk(1, 3),
    mk(3, 1),
    mk(2, 2),
    mk(4),
    mk(1, 1, 1, 1),
  ],
  "7v7": [
    mk(1, 2, 3),
    mk(1, 3, 2),
    mk(2, 2, 2),
    mk(2, 3, 1),
    mk(3, 2, 1),
    mk(1, 4, 1),
    mk(4, 1, 1),
    mk(1, 2, 2, 1),
    mk(1, 3, 1, 1),
    mk(2, 1, 3),
    mk(3, 1, 2),
    mk(3, 3),
    mk(4, 2),
    mk(2, 4),
    mk(1, 5),
    mk(5, 1),
    mk(6),
  ],
};

export function outfieldCount(format: LeagueFormat): number {
  return STARTERS_BY_FORMAT[format] - 1;
}

export function isFormationForFormat(
  label: string,
  format: LeagueFormat,
): boolean {
  return FORMATIONS[format].some((f) => f.label === label);
}

export function findFormation(
  label: string,
  format: LeagueFormat,
): Formation | undefined {
  return FORMATIONS[format].find((f) => f.label === label);
}

/* ------------------------------------------------------------------ */
/* Squad model                                                         */
/* ------------------------------------------------------------------ */

export type SquadPlayer = {
  id: string;
  position: Position;
  /** 'starter' | 'sub' | 'reserve' */
  slot: "starter" | "sub" | "reserve";
  order: number;
  name: string;
};

export type LeagueRules = {
  format: LeagueFormat;
  squadSize: number;
  starters: number;
  subsCount: number;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

const fail = (errors: string[]): ValidationResult => ({ ok: false, errors });
const pass: ValidationResult = { ok: true };

/**
 * Draft validation for an in-progress squad: caps are enforced so a manager
 * can never overshoot the format, but exact counts are only required once
 * the squad is complete.
 */
export function validateSquadDraft(
  rules: LeagueRules,
  players: SquadPlayer[],
): ValidationResult {
  const errors: string[] = [];
  const starters = players.filter((p) => p.slot === "starter");
  const subs = players.filter((p) => p.slot === "sub");
  const ids = new Set(players.map((p) => p.id));

  if (players.length > rules.squadSize)
    errors.push(`A squad cannot exceed ${rules.squadSize} players.`);
  if (ids.size !== players.length) errors.push("Duplicate players in squad.");
  if (starters.length > rules.starters)
    errors.push(`A ${rules.format} league fields at most ${rules.starters} starters.`);
  if (starters.filter((p) => p.position === "GK").length > 1)
    errors.push("Only one goalkeeper may be in the starting line-up.");
  if (subs.length > rules.subsCount)
    errors.push(`At most ${rules.subsCount} substitutes are allowed.`);
  if (starters.length + subs.length > rules.squadSize)
    errors.push("Matchday selection exceeds the squad size limit.");

  return errors.length ? fail(errors) : pass;
}

/**
 * Full squad validation: size, starter count, exactly one GK among
 * starters, substitute count, formation validity, captaincy.
 */
export function validateSquad(
  rules: LeagueRules,
  players: SquadPlayer[],
  opts: { formation: string; captainId?: string | null; viceId?: string | null },
): ValidationResult {
  const errors: string[] = [];

  if (players.length !== rules.squadSize) {
    errors.push(
      `Squad must contain exactly ${rules.squadSize} players (has ${players.length}).`,
    );
  }

  const starters = players.filter((p) => p.slot === "starter");
  const subs = players.filter((p) => p.slot === "sub");
  const ids = new Set(players.map((p) => p.id));
  if (ids.size !== players.length) errors.push("Duplicate players in squad.");

  if (starters.length !== rules.starters) {
    errors.push(
      `Exactly ${rules.starters} starters required for a ${rules.format} league (has ${starters.length}).`,
    );
  }

  const gks = starters.filter((p) => p.position === "GK");
  if (gks.length !== 1) {
    errors.push(
      `Starting XI must contain exactly one goalkeeper (has ${gks.length}).`,
    );
  }

  if (subs.length !== rules.subsCount) {
    errors.push(
      `Exactly ${rules.subsCount} substitutes required (has ${subs.length}).`,
    );
  }

  if (starters.length + subs.length > rules.squadSize) {
    errors.push("Matchday squad exceeds the squad size limit.");
  }

  if (starters.length === rules.starters && gks.length === 1) {
    const formation = findFormation(opts.formation, rules.format);
    if (!formation) {
      errors.push(
        `Formation ${opts.formation} is not valid for ${rules.format}.`,
      );
    } else if (formation.lines.reduce((a, b) => a + b, 0) !== rules.starters - 1) {
      errors.push(
        `Formation ${opts.formation} does not field ${rules.starters - 1} outfield players.`,
      );
    }
  }

  if (opts.captainId && !starters.some((p) => p.id === opts.captainId)) {
    errors.push("Captain must be one of the starting players.");
  }
  if (opts.viceId && !starters.some((p) => p.id === opts.viceId)) {
    errors.push("Vice-captain must be one of the starting players.");
  }
  if (opts.captainId && opts.captainId === opts.viceId) {
    errors.push("Captain and vice-captain must be different players.");
  }

  return errors.length ? fail(errors) : pass;
}

/* ------------------------------------------------------------------ */
/* Formation assignment + automatic recalculation                      */
/* ------------------------------------------------------------------ */

type LinePlan = { index: number; size: number; want: Position | "ANY" };

/** Which position each line should hold, back → front. */
function planLines(lines: number[]): LinePlan[] {
  return lines.map((size, index) => {
    if (lines.length === 1) return { index, size, want: "ANY" };
    const t = index / (lines.length - 1);
    let want: Position = "MID";
    if (t < 0.34) want = "DEF";
    else if (t > 0.66) want = "FWD";
    return { index, size, want };
  });
}

export type PitchSlot = { playerId: string; line: number; x: number; y: number };

/**
 * Places outfield starters onto the given formation, back → front.
 * Deterministic: always prefers a line's wanted position, then the
 * position order DEF → MID → FWD, then the player's `order` field.
 */
export function layoutFormation(
  outfield: SquadPlayer[],
  formation: Formation,
): { slots: PitchSlot[]; unplaced: string[] } {
  const remaining = [...outfield].sort((a, b) => {
    const rank = { DEF: 0, MID: 1, FWD: 2 } as Record<string, number>;
    const d = (rank[a.position] ?? 3) - (rank[b.position] ?? 3);
    return d !== 0 ? d : a.order - b.order;
  });

  const plan = planLines(formation.lines);
  const buckets: SquadPlayer[][] = formation.lines.map(() => []);
  const unplaced: string[] = [];

  for (const line of plan) {
    while (buckets[line.index].length < line.size && remaining.length) {
      let idx = remaining.findIndex((p) => p.position === line.want);
      if (idx === -1) idx = 0;
      const [picked] = remaining.splice(idx, 1);
      if (!picked) break;
      buckets[line.index].push(picked);
    }
  }
  for (const p of remaining) unplaced.push(p.id);

  const slots: PitchSlot[] = [];
  const totalLines = formation.lines.length;
  buckets.forEach((bucket, lineIndex) => {
    bucket.forEach((p, i) => {
      const n = bucket.length;
      const x = ((i + 1) / (n + 1)) * 100;
      // GK sits on 8%, then lines spread from 30% → 88%
      const y =
        totalLines === 1
          ? 55
          : 30 + (lineIndex / Math.max(totalLines - 1, 1)) * 58;
      slots.push({ playerId: p.id, line: lineIndex, x, y });
    });
  });

  return { slots, unplaced };
}

export function positionCounts(players: SquadPlayer[]): Record<Position, number> {
  return players.reduce(
    (acc, p) => {
      acc[p.position] = (acc[p.position] ?? 0) + 1;
      return acc;
    },
    { GK: 0, DEF: 0, MID: 0, FWD: 0 } as Record<Position, number>,
  );
}

/**
 * Chooses the best formation for a set of outfield players.
 * Prefers the current shape when it still fits, otherwise scores every
 * allowed formation by how well its line plan matches the players.
 */
export function suggestFormation(
  outfield: SquadPlayer[],
  format: LeagueFormat,
  currentLabel?: string | null,
): Formation {
  const allowed = FORMATIONS[format];
  if (!allowed.length) return mk(outfieldCount(format));

  const current = currentLabel
    ? allowed.find((f) => f.label === currentLabel)
    : undefined;

  const currentLines = current?.lines.length ?? 2;

  const score = (f: Formation) => {
    const plan = planLines(f.lines);
    const pool = [...outfield];
    let hits = 0;
    for (const line of plan) {
      for (let i = 0; i < line.size; i++) {
        const idx =
          line.want === "ANY" ? 0 : pool.findIndex((p) => p.position === line.want);
        if (idx === -1) continue;
        const [picked] = pool.splice(idx, 1);
        if (picked && (line.want === "ANY" || picked.position === line.want)) hits++;
      }
    }
    const order = allowed.findIndex((a) => a.label === f.label);
    return (
      hits * 100 +
      (current && current.label === f.label ? 12 : 0) -
      Math.abs(f.lines.length - currentLines) * 4 -
      order
    );
  };

  const scored = allowed
    .map((f) => ({ f, s: score(f) }))
    .sort((a, b) => b.s - a.s || a.f.label.localeCompare(b.f.label));

  return scored[0].f;
}

/**
 * Guided substitution: swap a starter for a substitute, keep the shape
 * legal, and recalculate the formation when the position mix changed.
 * Returns the complete next squad state.
 */
export function applySubstitution(
  rules: LeagueRules,
  players: SquadPlayer[],
  starterId: string,
  subId: string,
  currentFormationLabel?: string | null,
): { players: SquadPlayer[]; formation: string } | { error: string } {
  const starter = players.find((p) => p.id === starterId);
  const sub = players.find((p) => p.id === subId);
  if (!starter || starter.slot !== "starter") return { error: "Player is not a starter." };
  if (!sub || sub.slot !== "sub") return { error: "Replacement must be a substitute." };
  if (starter.position === "GK") {
    return { error: "Use the dedicated goalkeeper swap to change your keeper." };
  }
  if (sub.position === "GK") {
    return { error: "A goalkeeper cannot replace an outfield player." };
  }

  const next = players.map((p) => {
    if (p.id === starter.id) return { ...p, slot: "sub" as const, order: sub.order };
    if (p.id === sub.id) return { ...p, slot: "starter" as const, order: starter.order };
    return p;
  });

  const outfield = next.filter((p) => p.slot === "starter" && p.position !== "GK");
  const currentLabel =
    players.find((p) => p.id === starterId)?.slot === "starter" ? currentFormationLabel : null;
  const formation = suggestFormation(outfield, rules.format, currentLabel);
  return { players: next, formation: formation.label };
}

/** Validates that a real-match lineup respects the league format. */
export function validateLineup(
  rules: LeagueRules,
  starters: { position: Position }[],
  subs: { position: Position }[],
): ValidationResult {
  const errors: string[] = [];
  if (starters.length !== rules.starters)
    errors.push(
      `Team must start exactly ${rules.starters} players (has ${starters.length}).`,
    );
  const gks = starters.filter((s) => s.position === "GK").length;
  if (starters.length === rules.starters && gks !== 1)
    errors.push(`Team must start exactly one goalkeeper (has ${gks}).`);
  if (subs.length > rules.subsCount)
    errors.push(`A team may name at most ${rules.subsCount} substitutes.`);
  if (starters.length + subs.length > rules.squadSize)
    errors.push("Matchday selection exceeds the squad size limit.");
  return errors.length ? fail(errors) : pass;
}
