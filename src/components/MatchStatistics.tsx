import { Panel } from "./ui";

export type MatchStat = { playerId: string; saves: number; defensiveContributions: number; position: string };
export type MatchBonusAward = { playerId: string; rank: number | null; points: number };

export function MatchStatistics({ finalized, players, saved, bonusAwards = [] }: {
  finalized: boolean; players: { id: string; name: string }[]; saved: MatchStat[]; bonusAwards?: MatchBonusAward[];
}) {
  const known = new Map(players.map((p) => [p.id, p.name]));
  const recorded = saved.filter((s) => s.saves || s.defensiveContributions);
  if (!finalized && !recorded.length) return null;
  return <Panel className="mb-5 space-y-4 p-4">
    {!!recorded.length && <details>
      <summary className="cursor-pointer text-lg text-chalk">Match statistics</summary>
      <ul className="mt-2 space-y-1 text-sm text-sage">{recorded.map((s) =>
        <li key={s.playerId}>{known.get(s.playerId) ?? "Player"}: {s.saves} saves · {s.defensiveContributions} defensive contributions</li>)}
      </ul>
    </details>}
    {finalized && <section aria-label="Match Bonus Points" className="space-y-2">
      <h2 className="text-lg text-chalk">Match Bonus Points</h2>
      {bonusAwards.length ? <ul className="space-y-1 text-sm text-chalk">
        {bonusAwards.map((award) => <li key={award.playerId} className="flex flex-wrap justify-between gap-x-3">
          <span>{award.rank == null ? "Historical award" : `Rank ${award.rank}`} · {known.get(award.playerId) ?? "Player"}</span>
          <span className="num text-green">+{award.points} pts</span>
        </li>)}
      </ul> : <p className="text-sm text-sage">No bonus awards in the finalized result.</p>}
    </section>}
  </Panel>;
}
