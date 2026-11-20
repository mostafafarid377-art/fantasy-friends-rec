import type { LeagueRules, Position, SquadPlayer } from "./domain";
import type { playerDto, teamDto } from "./roster";

export type PoolPlayer = ReturnType<typeof playerDto>;
export type PlayerPool = { players: PoolPlayer[]; teams: ReturnType<typeof teamDto>[] };
export type SquadEntry = SquadPlayer & Pick<PoolPlayer, "photoUrl" | "shirtNumber" | "availability" | "status" | "teamId">;
export type SquadResponse = {
  squad: { id: string; formation: string; captainId: string | null; viceCaptainId: string | null; completedAt: string | null; updatedAt: string } | null;
  players: SquadEntry[];
  rules: LeagueRules;
  vicePolicy: string;
};

export function filterSquadPool<T extends Pick<PoolPlayer, "fullName" | "position" | "teamId">>(
  players: T[], teams: ReadonlyMap<string, string>, query: string,
  position: Position | "all", team: string, sort: "name" | "reverse" | "team",
) {
  const nameOf = (id: string | null) => (id && teams.get(id)) || "Free agent";
  const text = query.trim().toLocaleLowerCase();
  return players.filter((p) => (position === "all" || p.position === position)
    && (team === "all" || (p.teamId ?? "free") === team)
    && `${p.fullName} ${nameOf(p.teamId)}`.toLocaleLowerCase().includes(text))
    .sort((a,b) => (sort === "team" ? nameOf(a.teamId).localeCompare(nameOf(b.teamId)) : 0)
      || (sort === "reverse" ? -1 : 1) * a.fullName.localeCompare(b.fullName));
}
