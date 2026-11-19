"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Wallet } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { Badge, EmptyState, ErrorNote, Panel, Skeleton, Slate, TableSkeleton } from "@/components/ui";
import { useActiveLeague } from "@/components/LeagueContext";
import { useApi } from "@/lib/client/api";

type BreakdownLine = {
  category: string;
  label: string;
  count: number;
  pointsPer: number;
  points: number;
};

type Row = {
  matchId: string;
  matchTitle: string;
  kickOff: string | null;
  playerId: string;
  playerName: string;
  position: string | null;
  points: string;
  started: boolean;
  breakdown: BreakdownLine[];
  events: { id: string; type: string; minute: number }[];
};

type Data = {
  rows: Row[];
  matches: { id: string; title: string; kickOff: string; status: string }[];
  approvedRules: boolean;
};

function PointsInner() {
  const params = useSearchParams();
  const only = params.get("matchId");
  const { league, loading: leagueLoading } = useActiveLeague();
  const { data, loading, error, reload } = useApi<Data>(
    league ? `/api/leagues/${league.id}/points${only ? `?matchId=${only}` : ""}` : null,
    [league?.id, only],
  );

  if (leagueLoading || (loading && !data))
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <TableSkeleton rows={6} />
      </div>
    );
  if (error)
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <ErrorNote message={error} onRetry={reload} />
      </div>
    );
  if (!data) return null;

  const grouped = data.matches
    .map((m) => ({ match: m, rows: data.rows.filter((r) => r.matchId === m.id) }))
    .filter((g) => g.rows.length);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow={`${league?.name} · transparent scoring`}
        title="Points breakdown"
        subtitle="Every point traceable to a rule, a position and an approved match event."
        actions={
          <Badge tone={data.approvedRules ? "live" : "warn"}>
            {data.approvedRules ? "Approved rules" : "Draft rules"}
          </Badge>
        }
      />

      {!grouped.length ? (
        <EmptyState
          title="No calculated points yet"
          body="Points appear once a League Leader approves a real match and the scoring rules have been approved."
          action={{ label: "Match centre", href: "/matches" }}
          icon={<Wallet className="h-5 w-5" />}
        />
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <div key={group.match.id}>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2">
                <h2 className="text-[20px] text-chalk">{group.match.title}</h2>
                <div className="flex items-center gap-2">
                  <Badge tone={group.match.status === "approved" ? "live" : "neutral"}>{group.match.status}</Badge>
                  <span className="num text-[11.5px] text-sage-dim">
                    {group.match.kickOff ? new Date(group.match.kickOff).toLocaleDateString() : ""}
                  </span>
                </div>
              </div>

              <Panel className="divide-y divide-line-soft">
                {[...group.rows]
                  .sort((a, b) => Number(b.points) - Number(a.points))
                  .map((row) => (
                    <details key={`${row.matchId}-${row.playerId}`} className="group">
                      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 transition-colors hover:bg-pitch-800/60">
                        <span className="num w-12 shrink-0 text-right text-[18px] font-semibold text-green">
                          {Math.round(Number(row.points))}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14.5px] font-semibold text-chalk">
                            {row.playerName}
                          </span>
                          <span className="num block text-[11px] uppercase tracking-[0.12em] text-sage-dim">
                            {row.position} · {row.started ? "started" : "sub"}
                          </span>
                        </span>
                        <span className="slate hidden shrink-0 sm:block">Tap for detail</span>
                      </summary>

                      <div className="border-t border-line-soft bg-pitch-900/70 px-4 py-4">
                        {row.breakdown.length === 0 ? (
                          <p className="text-[13.5px] text-sage-dim">
                            No scoring actions in this match under the approved rules.
                          </p>
                        ) : (
                          <table className="w-full border-collapse text-left">
                            <thead>
                              <tr>
                                {["Action", "Count", "Per", "Points"].map((h) => (
                                  <th key={h} className="slate pb-2 font-semibold">
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-line-soft">
                              {row.breakdown.map((line) => (
                                <tr key={line.category}>
                                  <td className="py-2 text-[13.5px] text-chalk">{line.label}</td>
                                  <td className="num py-2 text-[13.5px] text-sage">×{line.count}</td>
                                  <td className="num py-2 text-[13.5px] text-sage">
                                    {line.pointsPer > 0 ? "+" : ""}
                                    {line.pointsPer}
                                  </td>
                                  <td className="num py-2 text-[13.5px] font-semibold text-chalk">
                                    {line.points > 0 ? "+" : ""}
                                    {line.points}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}

                        {row.events.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {row.events.map((e) => (
                              <span
                                key={e.id}
                                className="num rounded border border-line bg-pitch-850 px-2 py-1 text-[11px] uppercase text-sage"
                              >
                                {e.type} {e.minute}&apos;
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </details>
                  ))}
              </Panel>
            </div>
          ))}
        </div>
      )}

      <Slate className="mt-6 block">
        {data.rows.length} player-match calculations
      </Slate>
    </div>
  );
}

export default function PointsPage() {
  return (
    <Suspense fallback={null}>
      <PointsInner />
    </Suspense>
  );
}
