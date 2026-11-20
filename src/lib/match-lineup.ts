export type LineupSelection = { starters: string[]; subs: string[] };
export type SavedLineupEntry = { id: string; playerId: string; teamId: string; slot: "starter" | "sub"; order: number };

export function lineupPayload(teamId: string, selection: LineupSelection) {
  const ordered = (ids: string[]) => ids.map((playerId, order) => ({ playerId, order }));
  return { teamId, starters: ordered(selection.starters), subs: ordered(selection.subs) };
}

export function lineupSelection(rows: SavedLineupEntry[], teamId: string): LineupSelection {
  const pick = (slot: SavedLineupEntry["slot"]) => rows.filter((r) => r.teamId === teamId && r.slot === slot)
    .sort((a,b) => a.order - b.order || a.playerId.localeCompare(b.playerId)).map((r) => r.playerId);
  return { starters: pick("starter"), subs: pick("sub") };
}
