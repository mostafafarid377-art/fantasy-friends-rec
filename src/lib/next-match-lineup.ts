import { FORMATIONS, OUTFIELD, orderedBench, type Formation, type LeagueFormat, type SquadPlayer } from "@/lib/domain";
import type { SquadEntry } from "@/lib/squad";

export type MatchLineup = { formation: string; captainId: string | null; viceId: string | null; players: SquadEntry[] };
export type PreviousMatchLineup = { matchId: string; title: string; kickOff: string; lineup: MatchLineup };
// The lineup that is in play once a fixture starts: the draft saved for that
// match, or the default squad official scoring falls back to.
export type InPlayMatchLineup = PreviousMatchLineup & { source: "saved" | "default" };
export type SavedMatchLineup = { revision: string; lineup: MatchLineup };
export type NextMatchLineup = {
  serverNow: string;
  canPrepare?: boolean;
  preparation?: SavedMatchLineup | null;
  previous: PreviousMatchLineup | null;
  inPlay?: InPlayMatchLineup | null;
  match: { id: string; title: string; kickOff: string; locked: boolean } | null;
  saved: SavedMatchLineup | null;
};

export function withLineupPlayers(lineup: MatchLineup, players: SquadEntry[]): MatchLineup {
  const starts = (id: string | null) => players.some((p) => p.id === id && p.slot === "starter");
  return { ...lineup, players,
    captainId: starts(lineup.captainId) ? lineup.captainId : null,
    viceId: starts(lineup.viceId) ? lineup.viceId : null };
}

export function swapLineupPlayers(lineup: MatchLineup, out: SquadEntry, incoming: SquadEntry): MatchLineup {
  return withLineupPlayers(lineup, lineup.players.map((p) => p.id === out.id ? { ...p, slot: incoming.slot, order: incoming.order }
    : p.id === incoming.id ? { ...p, slot: out.slot, order: out.order } : p));
}

/** Formation changes promote eligible players from the bench, in bench order. */
export function lineupForFormation(lineup: MatchLineup, formation: Formation): MatchLineup | null {
  const outgoing: SquadEntry[] = [];
  const incoming: SquadEntry[] = [];
  const bench = orderedBench(lineup.players);
  for (const [i, position] of OUTFIELD.entries()) {
    const starters = lineup.players.filter((p) => p.slot === "starter" && p.position === position)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const count = formation.lines[i];
    const needed = Math.max(0, count - starters.length);
    const candidates = bench.filter((p) => p.position === position && p.status === "active").slice(0, needed);
    if (candidates.length !== needed) return null;
    outgoing.push(...starters.slice(count));
    incoming.push(...candidates);
  }
  if (outgoing.length !== incoming.length) return null;
  return { ...outgoing.reduce((next, player, i) => swapLineupPlayers(next, player, incoming[i]), lineup), formation: formation.label };
}

export function matchLineupFormations(lineup: MatchLineup, format: LeagueFormat) {
  return FORMATIONS[format].filter((f) => f.label === lineup.formation || lineupForFormation(lineup, f) !== null);
}

export function lineupEntries(players: SquadPlayer[]) {
  return players.map((p) => ({ id: p.id, slot: p.slot, order: p.order }));
}
