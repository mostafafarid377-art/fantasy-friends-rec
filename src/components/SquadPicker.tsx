"use client";

import { useMemo, useState } from "react";
import { Check, Plus } from "lucide-react";
import { Avatar, Button, ErrorNote, Modal, Skeleton } from "./ui";
import { POSITIONS, type Position } from "@/lib/domain";
import { filterSquadPool, type PlayerPool, type PoolPlayer } from "@/lib/squad";

export const fieldClass = "min-w-0 rounded-md border border-line bg-pitch-900 px-3 py-2.5 text-sm text-chalk";
const PAGE = 30;

export function SquadPicker({ title, allowed, selected, pool, error, reload, onPick, onClose }: {
  title: string; allowed: readonly Position[]; selected: ReadonlySet<string>; pool: PlayerPool | null;
  error: string | null; reload: () => void; onPick: (player: PoolPlayer) => void; onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState<Position | "all">("all");
  const [team, setTeam] = useState("all");
  const [sort, setSort] = useState<"name" | "reverse" | "team">("name");
  const [limit, setLimit] = useState(PAGE);
  const teams = useMemo(() => new Map(pool?.teams.map((t) => [t.id, t.name])), [pool]);
  const eligible = useMemo(() => (pool?.players ?? []).filter((p) => allowed.includes(p.position)), [pool, allowed]);
  const matches = useMemo(() => filterSquadPool(eligible, teams, search, position, team, sort), [eligible, teams, search, position, team, sort]);
  return (
    <Modal open title={title} onClose={onClose}>
      <input autoFocus type="search" aria-label="Search players" placeholder="Search by player or team"
        className={`${fieldClass} w-full`} value={search} onChange={(e) => { setSearch(e.target.value); setLimit(PAGE); }} />
      <div className="my-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <select aria-label="Position" className={fieldClass} value={position} onChange={(e) => { setPosition(e.target.value as typeof position); setLimit(PAGE); }}>
          <option value="all">{allowed.length === 1 ? allowed[0] : "Eligible positions"}</option>
          {POSITIONS.filter((p) => allowed.length > 1 && allowed.includes(p)).map((p) => <option key={p}>{p}</option>)}
        </select>
        <select aria-label="Real team" className={fieldClass} value={team} onChange={(e) => { setTeam(e.target.value); setLimit(PAGE); }}>
          <option value="all">All teams</option><option value="free">Free agents</option>
          {pool?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select aria-label="Sort players" className={`${fieldClass} col-span-2 sm:col-span-1`} value={sort} onChange={(e) => { setSort(e.target.value as typeof sort); setLimit(PAGE); }}>
          <option value="name">Name: A–Z</option><option value="reverse">Name: Z–A</option><option value="team">Team then name</option>
        </select>
      </div>
      {error ? <ErrorNote message={error} onRetry={reload} /> : !pool ? <Skeleton className="h-40" /> : (
        <>
          <p className="mb-2 text-xs text-sage" aria-live="polite">{matches.length} matching players</p>
          {matches.length === 0 && <p className="py-4 text-sm text-sage">No eligible players match these filters. Change the filters or close the picker and try a different formation.</p>}
          <ul className="max-h-[48dvh] space-y-1 overflow-y-auto overscroll-contain">
            {matches.slice(0, limit).map((p) => {
              const picked = selected.has(p.id);
              const inactive = p.status !== "active";
              return (
                <li key={p.id}>
                  <button type="button" disabled={picked || inactive} onClick={() => onPick(p)}
                    className="flex w-full items-center gap-3 rounded-md border border-line bg-pitch-900 px-2.5 py-2 text-left hover:border-green disabled:opacity-70">
                    <Avatar name={p.fullName} url={p.photoUrl} size={34} />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-semibold text-chalk">{p.fullName}</span>
                      <span className="block text-xs text-sage">{p.position} · {p.teamId ? (teams.get(p.teamId) ?? "Unassigned team") : "Free agent"}</span>
                      {inactive && <span className="block text-xs text-card-y">Archived</span>}
                      {p.availability !== "available" && <span className="block text-xs capitalize text-card-y">{p.availability}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-green-glow">
                      {picked ? <><Check className="h-4 w-4" />Selected</> : inactive ? "Unavailable" : <><Plus className="h-4 w-4" />Pick</>}
                    </span>
                  </button>
                </li>
              );
            })}
            {matches.length > limit && <li className="p-2"><Button variant="outline" onClick={() => setLimit(limit + PAGE)}>Show more players</Button></li>}
          </ul>
        </>
      )}
    </Modal>
  );
}
