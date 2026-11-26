import { findFormation, OUTFIELD, orderedBench, type Position } from "@/lib/domain";
import type { SquadEntry } from "@/lib/squad";

export const FORMAT = "7v7";
export const FORMATION_OPTIONS = ["2-2-2", "3-2-1", "2-3-1", "2-1-3", "1-3-2"].map((label) => findFormation(label, FORMAT)!);
export const POSITION_LABEL: Record<Position, string> = { GK: "Goalkeeper", DEF: "Defender", MID: "Midfielder", FWD: "Forward" };

export type SampleDraft = {
  formation: string;
  players: SquadEntry[];
  captainId: string | null;
  viceId: string | null;
};

const samplePlayer = (id: string, name: string, position: Position, slot: SquadEntry["slot"], order: number): SquadEntry => ({
  id, name, position, slot, order,
  photoUrl: null, shirtNumber: null, status: "active", availability: "available", teamId: null,
});

const SAMPLE_PLAYERS = [
  samplePlayer("adam", "Adam Nasser", "GK", "starter", 0),
  samplePlayer("karim", "Karim Fathy", "DEF", "starter", 1),
  samplePlayer("malik", "Malik Adel", "DEF", "starter", 2),
  samplePlayer("omar", "Omar Salah", "MID", "starter", 3),
  samplePlayer("tarek", "Tarek Amin", "MID", "starter", 4),
  samplePlayer("zayd", "Zayd Hassan", "FWD", "starter", 5),
  samplePlayer("sami", "Sami Nabil", "FWD", "starter", 6),
  samplePlayer("rami", "Rami Saad", "GK", "sub", 0),
  samplePlayer("youssef", "Youssef Ali", "MID", "sub", 1),
  samplePlayer("hamza", "Hamza Samir", "FWD", "sub", 2),
  samplePlayer("nour", "Nour Khaled", "DEF", "sub", 3),
];

export const PREVIOUS_SAVED_LINEUP: SampleDraft = {
  formation: "2-2-2",
  captainId: "zayd",
  viceId: "omar",
  players: SAMPLE_PLAYERS,
};

function updatePlayers(draft: SampleDraft, players: SquadEntry[]): SampleDraft {
  const starts = (id: string | null) => players.some((p) => p.id === id && p.slot === "starter");
  return { ...draft, players, captainId: starts(draft.captainId) ? draft.captainId : null, viceId: starts(draft.viceId) ? draft.viceId : null };
}

export function swapPlayers(draft: SampleDraft, out: SquadEntry, into: SquadEntry): SampleDraft {
  return updatePlayers(draft, draft.players.map((p) => p.id === out.id ? { ...p, slot: into.slot, order: into.order }
    : p.id === into.id ? { ...p, slot: out.slot, order: out.order } : p));
}

export function changeSampleFormation(draft: SampleDraft, label: string): SampleDraft {
  const shape = FORMATION_OPTIONS.find((f) => f.label === label);
  if (!shape || draft.formation === label) return draft;
  const outgoing: SquadEntry[] = [];
  const incoming: SquadEntry[] = [];
  const bench = orderedBench(draft.players);
  OUTFIELD.forEach((position, i) => {
    const starters = draft.players.filter((p) => p.slot === "starter" && p.position === position).sort((a, b) => a.order - b.order);
    const count = shape.lines[i];
    outgoing.push(...starters.slice(count));
    incoming.push(...bench.filter((p) => p.position === position).slice(0, Math.max(0, count - starters.length)));
  });
  if (outgoing.length !== incoming.length) return draft;
  return { ...outgoing.reduce((next, player, index) => swapPlayers(next, player, incoming[index]), draft), formation: label };
}

// The editable squad is not the historical lineup. In this scenario a keeper
// has changed since the previous match, so the source is visible in the demo.
export function copySampleLineup(lineup: SampleDraft): SampleDraft {
  return { ...lineup, players: lineup.players.map((p) => ({ ...p })) };
}

export function createSampleSquad(): SampleDraft {
  return { formation: "2-2-2", captainId: "zayd", viceId: "omar", players: SAMPLE_PLAYERS.map((p) => ({
    ...p, slot: p.id === "rami" ? "starter" : p.id === "adam" ? "sub" : p.slot,
  })) };
}
