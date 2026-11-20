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

export function canSelectPlayer(player: { status: string; availability: string }) {
  return player.status === "active" && ["available", "doubt"].includes(player.availability);
}

export const AVAILABILITY = ["available", "doubt", "injured", "suspended"];

/* ------------------------------------------------------------------ */
/* Formations                                                          */
/* ------------------------------------------------------------------ */

export const OUTFIELD = ["DEF", "MID", "FWD"] as const;
export type Formation = {
  /** Defender–midfielder–forward counts; the one goalkeeper is implicit. */
  label: string;
  lines: number[];
};

function shapes(starters: number): Formation[] {
  const n = starters - 1;
  const result: Formation[] = [];
  for (let d = 0; d <= n; d++) {
    for (let m = 0; m <= n - d; m++) {
      const lines = [d, m, n - d - m];
      result.push({ label: lines.join("-"), lines });
    }
  }
  // Default to balanced templates. Zero counts are legal: league rules
  // require one GK but don't impose a minimum for other positions.
  const balance = ({ lines: [d, m, f] }: Formation) => (d-f)**2 + (d-m)**2 + (m-f)**2;
  return result.sort((a,b) => balance(a)-balance(b) || b.lines[1]-a.lines[1] || b.lines[0]-a.lines[0]);
}

export const FORMATIONS: Record<LeagueFormat, Formation[]> = {
  "5v5": shapes(STARTERS_BY_FORMAT["5v5"]),
  "7v7": shapes(STARTERS_BY_FORMAT["7v7"]),
};

export function findFormation(label: string, format: LeagueFormat) {
  return FORMATIONS[format]?.find((f) => f.label === label);
}

export function isFormationForFormat(label: string, format: LeagueFormat) {
  return Boolean(findFormation(label, format));
}

export type SquadPlayer = {
  id: string;
  position: Position;
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

export function squadCaps(rules: LeagueRules): Record<SquadPlayer["slot"], number> {
  return { starter: rules.starters, sub: rules.subsCount, reserve: rules.squadSize - rules.starters - rules.subsCount };
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };
const pass = { ok: true } as const;
const fail = (errors: string[]): ValidationResult => ({ ok: false, errors });
type SquadOptions = { formation: string; captainId?: string | null; viceId?: string | null };

export function compatibleFormations(rules: LeagueRules, players: Pick<SquadPlayer, "slot" | "position">[]) {
  const starters = players.filter((p) => p.slot === "starter");
  if (starters.length > rules.starters || starters.filter((p) => p.position === "GK").length > 1) return [];
  const counts = OUTFIELD.map((position) => starters.filter((p) => p.position === position).length);
  return (FORMATIONS[rules.format] ?? []).filter((f) =>
    f.lines.reduce((a,b) => a+b, 0) === rules.starters - 1 && f.lines.every((cap,i) => counts[i] <= cap));
}

export function deriveFormation(rules: LeagueRules, players: Pick<SquadPlayer, "slot" | "position">[], current?: string | null) {
  const allowed = compatibleFormations(rules, players);
  return allowed.find((f) => f.label === current) ?? allowed[0];
}

/** Keeper first; outfield priority is independent of starter/reserve order. */
export function orderedBench<T extends SquadPlayer>(players: T[]): T[] {
  return players.filter((p) => p.slot === "sub").sort((a,b) =>
    Number(b.position === "GK") - Number(a.position === "GK") || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function normalizeBench<T extends SquadPlayer>(players: T[]): T[] {
  let priority = 1;
  const priorities = new Map(orderedBench(players).map((p) => [p.id, p.position === "GK" ? 0 : priority++]));
  return players.map((p) => p.slot === "sub" ? { ...p, order: priorities.get(p.id)! } : p);
}

export function validateSquadDraft(rules: LeagueRules, players: SquadPlayer[], opts: SquadOptions): ValidationResult {
  const errors: string[] = [];
  const caps = squadCaps(rules);
  const starters = players.filter((p) => p.slot === "starter");
  const ids = new Set(players.map((p) => p.id));
  if (caps.reserve < 0 || rules.starters !== STARTERS_BY_FORMAT[rules.format]) errors.push("Invalid league squad settings.");
  if (players.length > rules.squadSize) errors.push(`A squad cannot exceed ${rules.squadSize} players.`);
  if (ids.size !== players.length) errors.push("Duplicate players in squad.");
  for (const slot of ["starter", "sub", "reserve"] as const) {
    if (players.filter((p) => p.slot === slot).length > caps[slot]) {
      errors.push(`At most ${caps[slot]} ${slot === "sub" ? "substitutes" : `${slot}s`} are allowed.`);
    }
  }
  const bench = orderedBench(players);
  if (bench.filter((p) => p.position === "GK").length > 1) errors.push("Only one goalkeeper is allowed on the bench.");
  if (bench.filter((p) => p.position !== "GK").length > Math.max(0, rules.subsCount - 1)) {
    errors.push("The first bench spot is reserved for a goalkeeper.");
  }
  const gks = starters.filter((p) => p.position === "GK").length;
  if (gks > 1 || (starters.length === rules.starters && gks !== 1)) errors.push("The starting lineup must have exactly one goalkeeper when full.");
  if (!compatibleFormations(rules, players).some((f) => f.label === opts.formation)) {
    errors.push("The formation must match the starting positions in this league format.");
  }
  if (opts.captainId && !starters.some((p) => p.id === opts.captainId)) errors.push("Captain must be a starter.");
  if (opts.viceId && !starters.some((p) => p.id === opts.viceId)) errors.push("Vice-captain must be a starter.");
  if (opts.captainId && opts.captainId === opts.viceId) errors.push("Captain and vice-captain must be different players.");
  return errors.length ? { ok: false, errors } : pass;
}

export function validateSquad(rules: LeagueRules, players: SquadPlayer[], opts: SquadOptions): ValidationResult {
  const draft = validateSquadDraft(rules, players, opts);
  const errors = draft.ok ? [] : draft.errors;
  if (players.length !== rules.squadSize) errors.push(`Squad must contain exactly ${rules.squadSize} players.`);
  if (players.filter((p) => p.slot === "starter").length !== rules.starters) errors.push(`Exactly ${rules.starters} starters required.`);
  if (players.filter((p) => p.slot === "starter" && p.position === "GK").length !== 1) errors.push("A complete lineup needs exactly one goalkeeper.");
  if (players.filter((p) => p.slot === "sub").length !== rules.subsCount) errors.push(`Exactly ${rules.subsCount} substitutes required.`);
  return errors.length ? { ok: false, errors } : pass;
}

export type PitchSlot = { playerId: string | null; position: Position; index: number; x: number; y: number; width: number };

/** Fixed positional rows, including explicit empty slots and the single GK. */
export function layoutFormation(players: SquadPlayer[], formation: Formation): PitchSlot[] {
  return (["GK", ...OUTFIELD] as const).flatMap((position, row) => {
    const size = row === 0 ? 1 : formation.lines[row - 1];
    const pool = players.filter((p) => p.slot === "starter" && p.position === position)
      .sort((a,b) => a.order-b.order || a.id.localeCompare(b.id));
    return Array.from({ length: size }, (_, index) => ({
      playerId: pool[index]?.id ?? null, position, index,
      x: 2 + (index + 0.5) * 96 / size, y: [85, 64, 43, 22][row], width: 94 / size,
    }));
  });
}

/** A move or swap only changes the involved players; other entries keep their order. */
export function moveSquadPlayer<T extends SquadPlayer>(
  rules: LeagueRules, players: T[], playerId: string, destination: SquadPlayer["slot"],
  current: string, swapId?: string,
): { players: T[]; formation: string } | { error: string } {
  const player = players.find((p) => p.id === playerId);
  const swap = swapId ? players.find((p) => p.id === swapId) : undefined;
  if (!player || player.slot === destination || (swapId && swap?.slot !== destination)) return { error: "Choose a player in the destination group." };
  if ((player.slot === "starter" || destination === "starter") && swap && (player.position === "GK") !== (swap.position === "GK")) {
    return { error: "A starting goalkeeper can only swap with another goalkeeper." };
  }
  const next = players.map((p) => p.id === player.id
    ? { ...p, slot: destination, order: swap?.order ?? nextSquadOrder(players, destination) }
    : p.id === swap?.id ? { ...p, slot: player.slot, order: player.order } : p);
  const shape = deriveFormation(rules, next, current);
  if (!shape) return { error: "This move cannot fit the starting formation. Try a goalkeeper for a keeper or another outfield player." };
  const check = validateSquadDraft(rules, next, { formation: shape.label });
  return check.ok ? { players: next, formation: shape.label } : { error: check.errors.join(" ") };
}

export function nextSquadOrder(players: SquadPlayer[], slot: SquadPlayer["slot"]) {
  const taken = new Set(players.filter((p) => p.slot === slot).map((p) => p.order));
  let order = 0;
  while (taken.has(order)) order++;
  return order;
}

/** Validates that a real-match lineup respects the league format. */
export function validateLineup(
  rules: LeagueRules,
  starters: { position: Position }[],
  subs: { position: Position }[],
): ValidationResult {
  const errors: string[] = [];
  if (rules.starters !== (rules.format === "5v5" ? 5 : 7))
    errors.push("The league's starter count does not match its format.");
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
