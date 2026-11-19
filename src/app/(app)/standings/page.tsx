"use client";

import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Minus, Trophy } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { Avatar, Badge, Button, EmptyState, ErrorNote, Panel, Skeleton, Slate, TableSkeleton } from "@/components/ui";
import { useActiveLeague } from "@/components/LeagueContext";
import { useApi } from "@/lib/client/api";

type StandingRow = {
  profileId: string;
  rank: number;
  prevRank: number | null;
  totalPoints: string;
  matchesPlayed: number;
  form: unknown;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  teamName: string | null;
  role: string;
};

type HistoryRow = {
  matchId: string;
  gameweek: number;
  points: string;
  matchTitle: string;
  kickOff: string | null;
  profileId: string;
  displayName: string;
};

type Data = {
  standings: StandingRow[];
  history: HistoryRow[];
  ledger: { profileId: string; matchId: string; points: string; computedAt: string }[];
  you: string;
};

export default function StandingsPage() {
  const { league, loading: leagueLoading } = useActiveLeague();
  const { data, error, loading, reload } = useApi<Data>(
    league ? `/api/leagues/${league.id}/standings` : null,
    [league?.id],
  );
  const [view, setView] = useState<"table" | "weekly">("table");

  if (leagueLoading || (loading && !data))
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <TableSkeleton rows={8} />
      </div>
    );
  if (error)
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <ErrorNote message={error} onRetry={reload} />
      </div>
    );
  if (!data) return null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow={`${league?.name} · ${league?.format}`}
        title="League table"
        subtitle="Rebuilt from the approved-results ledger after every decision — never incremented in place."
        actions={
          <div className="flex overflow-hidden rounded-md border border-line">
            {(["table", "weekly"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`h-9 px-4 text-[12.5px] font-semibold uppercase tracking-[0.1em] transition-colors ${
                  view === v ? "bg-green text-[#04120a]" : "bg-pitch-900 text-sage hover:text-chalk"
                }`}
              >
                {v === "table" ? "Overall" : "Weekly"}
              </button>
            ))}
          </div>
        }
      />

      {data.standings.length === 0 ? (
        <EmptyState
          title="The table is empty"
          body="Standings appear as soon as managers join and approved results start coming in."
          action={{ label: "Invite managers", href: "/members" }}
          icon={<Trophy className="h-5 w-5" />}
        />
      ) : view === "table" ? (
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[620px] border-collapse">
            <thead>
              <tr className="border-b border-line">
                {["Rank", "Manager", "Team", "MP", "Form", "Points"].map((h) => (
                  <th key={h} className={`slate px-4 py-3 ${h === "MP" || h === "Points" ? "text-right" : "text-left"}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {data.standings.map((row, i) => {
                const movement =
                  row.prevRank == null ? null : row.prevRank > row.rank ? "up" : row.prevRank < row.rank ? "down" : "same";
                const me = row.profileId === data.you;
                const form = Array.isArray(row.form) ? (row.form as { points: number }[]) : [];
                return (
                  <tr
                    key={row.profileId}
                    className={`transition-colors hover:bg-pitch-800/70 ${me ? "bg-green/6" : ""}`}
                    style={{ animation: `rise .4s cubic-bezier(.2,.8,.2,1) ${i * 24}ms both` }}
                  >
                    <td className="px-4 py-3.5">
                      <span className="flex items-center gap-2">
                        <span className={`num w-6 text-[16px] font-semibold ${row.rank <= 3 ? "text-green" : "text-chalk"}`}>
                          {row.rank}
                        </span>
                        {movement === "up" && <ArrowUpRight className="h-3.5 w-3.5 text-green" />}
                        {movement === "down" && <ArrowDownRight className="h-3.5 w-3.5 text-card-r" />}
                        {movement === "same" && <Minus className="h-3.5 w-3.5 text-sage-dim" />}
                        {movement === null && <span className="num text-[10px] text-sage-dim">new</span>}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="flex items-center gap-2.5">
                        <Avatar name={row.displayName} url={row.avatarUrl} size={30} />
                        <span className="min-w-0">
                          <span className="block truncate text-[14.5px] font-semibold text-chalk">
                            {row.displayName}
                            {me && <span className="ml-2 text-[10.5px] uppercase tracking-widest text-green">you</span>}
                          </span>
                          <span className="block truncate text-[11.5px] text-sage-dim">@{row.username}</span>
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="truncate text-[13.5px] text-sage">{row.teamName ?? "—"}</span>
                      {row.role === "leader" && (
                        <Badge tone="info" className="ml-2">
                          Leader
                        </Badge>
                      )}
                    </td>
                    <td className="num px-4 py-3.5 text-right text-[14px] text-sage">{row.matchesPlayed}</td>
                    <td className="px-4 py-3.5">
                      <span className="flex justify-start gap-1">
                        {form.slice(-5).map((f, idx) => (
                          <span
                            key={idx}
                            title={`${Number(f.points)} pts`}
                            className={`num rounded px-1.5 py-0.5 text-[10.5px] ${
                              Number(f.points) >= 10
                                ? "bg-green/18 text-green"
                                : Number(f.points) > 0
                                  ? "bg-pitch-800 text-sage"
                                  : "bg-card-r/15 text-card-r"
                            }`}
                          >
                            {Math.round(Number(f.points))}
                          </span>
                        ))}
                        {form.length === 0 && <span className="text-[11.5px] text-sage-dim">—</span>}
                      </span>
                    </td>
                    <td className="num px-4 py-3.5 text-right text-[18px] font-semibold text-chalk">
                      {Math.round(Number(row.totalPoints))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      ) : (
        <WeeklyHistory history={data.history} standings={data.standings} you={data.you} />
      )}
    </div>
  );
}

function WeeklyHistory({
  history,
  standings,
  you,
}: {
  history: HistoryRow[];
  standings: StandingRow[];
  you: string;
}) {
  if (!history.length)
    return (
      <EmptyState
        title="No weekly scores yet"
        body="Weekly points appear after the first approved match."
        action={{ label: "Match centre", href: "/matches" }}
      />
    );

  const matchIds = [...new Set(history.map((h) => h.matchId))];
  const managers = standings.map((s) => ({ id: s.profileId, name: s.displayName }));

  return (
    <Panel className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse">
        <thead>
          <tr className="border-b border-line">
            <th className="slate px-4 py-3 text-left">Manager</th>
            {matchIds.map((id) => {
              const m = history.find((h) => h.matchId === id);
              return (
                <th key={id} className="slate px-3 py-3 text-right" title={m?.matchTitle}>
                  {m ? `GW${m.gameweek}` : "—"}
                </th>
              );
            })}
            <th className="slate px-4 py-3 text-right">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {managers.map((mgr) => (
            <tr key={mgr.id} className={mgr.id === you ? "bg-green/6" : undefined}>
              <td className="px-4 py-3 text-[14px] text-chalk">{mgr.name}</td>
              {matchIds.map((id) => {
                const hit = history.find((h) => h.matchId === id && h.profileId === mgr.id);
                return (
                  <td key={id} className="num px-3 py-3 text-right text-[14px] text-sage">
                    {hit ? Math.round(Number(hit.points)) : "–"}
                  </td>
                );
              })}
              <td className="num px-4 py-3 text-right text-[16px] font-semibold text-chalk">
                {Math.round(
                  Number(
                    standings.find((s) => s.profileId === mgr.id)?.totalPoints ?? 0,
                  ),
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
