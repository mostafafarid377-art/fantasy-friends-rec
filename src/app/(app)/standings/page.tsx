"use client";

import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Minus, Trophy } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { Avatar, Badge, EmptyState, ErrorNote, Panel, Skeleton, Slate, TableSkeleton } from "@/components/ui";
import { useActiveLeague } from "@/components/LeagueContext";
import { useLiveLeaguePoints } from "@/lib/client/league-updates";
import { useApi } from "@/lib/client/api";

type StandingRow = {
  profileId: string;
  rank: number;
  prevRank: number | null;
  totalPoints: number;
  livePoints?: number;
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
  provisional?: boolean;
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
  useLiveLeaguePoints(league?.id, reload);
  const [view, setView] = useState<"table" | "weekly">("table");

  if (leagueLoading || (loading && !data))
    return (
      <div className="mx-auto w-full min-w-0 max-w-5xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <TableSkeleton rows={8} />
      </div>
    );
  if (error)
    return (
      <div className="mx-auto w-full min-w-0 max-w-5xl px-4 py-8">
        <ErrorNote message={error} onRetry={reload} />
      </div>
    );
  if (!data) return null;

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl [overflow-wrap:anywhere] px-2 py-6 sm:px-4 md:px-8 md:py-8">
      <PageHeader
        eyebrow={`${league?.name} · ${league?.format}`}
        title="League table"
        subtitle="Live event points update the table before approval. Matches played and form reflect approved results."
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

      {data.provisional && <p role="status" className="mb-3 text-sm text-card-y">Live standings include provisional points.</p>}
      {data.standings.length === 0 ? (
        <EmptyState
          title="The table is empty"
          body="Standings appear when managers join and results or live points come in."
          action={{ label: "Invite managers", href: "/members" }}
          icon={<Trophy className="h-5 w-5" />}
        />
      ) : view === "table" ? (
        <Panel className="min-w-0">
          <table aria-label="League standings" className="w-full table-fixed border-collapse">
            <colgroup>
              <col className="w-[12%] sm:w-[10%]" />
              <col className="w-[25%] sm:w-[27%]" />
              <col className="w-[21%]" />
              <col className="w-[9%] sm:w-[8%]" />
              <col className="w-[18%] sm:w-[21%]" />
              <col className="w-[15%] sm:w-[13%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-line">
                {["Rank", "Manager", "Team", "MP", "Form", "Points"].map((h) => (
                  <th key={h} scope="col" className={`slate px-1 py-2 text-[10px] tracking-normal sm:px-2 sm:py-3 sm:text-[11px] sm:tracking-wider xl:px-4 ${h === "MP" || h === "Points" ? "text-right" : "text-left"}`}>
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
                    <td className="px-1 py-2 align-top sm:px-2 sm:py-3.5 xl:px-4">
                      <span className="flex flex-wrap items-center gap-x-1 sm:gap-x-2">
                        <span className={`num text-xs font-semibold sm:text-base ${row.rank <= 3 ? "text-green" : "text-chalk"}`}>
                          {row.rank}
                        </span>
                        {movement === "up" && <ArrowUpRight className="h-3 w-3 shrink-0 sm:h-3.5 sm:w-3.5 text-green" />}
                        {movement === "down" && <ArrowDownRight className="h-3 w-3 shrink-0 sm:h-3.5 sm:w-3.5 text-card-r" />}
                        {movement === "same" && <Minus className="h-3 w-3 shrink-0 sm:h-3.5 sm:w-3.5 text-sage-dim" />}
                        {movement === null && <span className="num text-[10px] text-sage-dim">new</span>}
                      </span>
                    </td>
                    <td className="px-1 py-2 align-top sm:px-2 sm:py-3.5 xl:px-4">
                      <div className="flex min-w-0 items-start gap-2">
                        <span className="hidden shrink-0 sm:inline-flex"><Avatar name={row.displayName} url={row.avatarUrl} size={30} decorative /></span>
                        <div className="min-w-0 flex-1">
                          <StandingName className="text-xs font-semibold text-chalk sm:text-sm" value={row.displayName} />
                          <StandingName className="text-[10px] text-sage-dim sm:text-xs" value={`@${row.username}`} />
                          {me && <span className="text-[9px] uppercase tracking-wider text-green">you</span>}
                        </div>
                      </div>
                    </td>
                    <td className="px-1 py-2 align-top sm:px-2 sm:py-3.5 xl:px-4">
                      <StandingName className="text-[11px] text-sage sm:text-sm" value={row.teamName ?? "—"} />
                      {row.role === "leader" && (
                        <Badge tone="info" className="mt-1 max-w-full px-0.5 py-0 text-[8px] tracking-normal sm:px-2 sm:text-[10px]">
                          Leader
                        </Badge>
                      )}
                    </td>
                    <td className="num px-1 py-2 text-right align-top text-[11px] text-sage sm:px-2 sm:py-3.5 sm:text-sm xl:px-4">{row.matchesPlayed}</td>
                    <td className="px-1 py-2 align-top sm:px-2 sm:py-3.5 xl:px-4">
                      <span className="flex flex-wrap justify-start gap-0.5 sm:gap-1">
                        {form.slice(-5).map((f, idx) => (
                          <span
                            key={idx}
                            title={`${Number(f.points)} pts`}
                            className={`num max-w-full rounded px-0.5 py-0.5 text-[9px] sm:px-1.5 sm:text-[10.5px] ${
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
                    <td className="num px-1 py-2 text-right align-top text-xs font-semibold text-chalk sm:px-2 sm:py-3.5 sm:text-lg xl:px-4">
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

// Tap/click or use the keyboard to expand a name inline; tooltips alone
// aren't accessible on touch screens.
function StandingName({ value, className }: { value: string; className: string }) {
  const [expanded, setExpanded] = useState(false);
  if (value === "—") return <span className={className}>{value}</span>;
  return <button type="button" aria-expanded={expanded} title={value} onClick={() => setExpanded((previous) => !previous)}
    className={`block w-full text-left leading-snug hover:underline focus-visible:underline ${expanded ? "[overflow-wrap:anywhere]" : "truncate"} ${className}`}>
    {value}
  </button>;
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
  const officialTotals = new Map(standings.map((s) => [s.profileId, Number(s.totalPoints) - (s.livePoints ?? 0)]));
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
                    officialTotals.get(mgr.id) ?? 0,
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
