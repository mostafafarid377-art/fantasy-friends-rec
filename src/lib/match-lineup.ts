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

/**
 * Canonical form of a lineup selection for change detection: drop duplicate
 * assignments and keep each player in a single slot (starters win).
 */
export function normalizeLineup(selection: LineupSelection): LineupSelection {
  const starters = selection.starters.filter((id, index) => id && selection.starters.indexOf(id) === index);
  const inXi = new Set(starters);
  const subs = selection.subs.filter((id, index) => id && !inXi.has(id) && selection.subs.indexOf(id) === index);
  return { starters, subs };
}

/**
 * Value equality on normalized selections — never a reference comparison.
 * Membership per slot is what matters: this editor has no way to reorder
 * within a slot, so a player removed and re-added ends up in the same saved
 * lineup and must read as "unchanged" (revert-to-saved restores the saved
 * state).
 */
export function lineupEquals(a: LineupSelection, b: LineupSelection): boolean {
  const x = normalizeLineup(a);
  const y = normalizeLineup(b);
  const sameMembers = (p: string[], q: string[]) => p.length === q.length && p.every((id) => q.includes(id));
  return sameMembers(x.starters, y.starters) && sameMembers(x.subs, y.subs);
}
