"use client";

import { RealTeamName } from "@/components/TeamLogo";

import { useState } from "react";
import Link from "next/link";
import { History as HistoryIcon } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { Badge, EmptyState, ErrorNote, Panel, Skeleton, Slate } from "@/components/ui";
import { useActiveLeague } from "@/components/LeagueContext";
import { useApi } from "@/lib/client/api";

type Data = {
  standings: {
    profileId: string;
    rank: number;
    totalPoints: string;
    matchesPlayed: number;
    displayName: string;
    form: unknown;
  }[];
  history: {
    matchId: string;
    gameweek: number;
    points: string;
    matchTitle: string;
    kickOff: string | null;
    profileId: string;
    displayName: string;
  }[];
  you: string;
};

export default function HistoryPage() {
  const { league, loading: leagueLoading } = useActiveLeague();
  const [paging, setPaging] = useState<{ leagueId: string; page: number } | null>(null);
  const page = paging && paging.leagueId === league?.id ? paging.page : 1;
  const setPage = (next: number) => { if (league) setPaging({ leagueId: league.id, page: next }); };
  const { data, loading, error, reload } = useApi<Data>(
    league ? `/api/leagues/${league.id}/standings` : null,
    [league?.id],
  );
  const matches = useApi<{ total: number; hasMore: boolean; matches: { id: string; title: string; status: string; kickOff: string; teamAName: string; teamALogo?: string | null; teamBLogo?: string | null; teamBName: string }[] }>(
    league ? `/api/matches?leagueId=${league.id}&status=approved&page=${page}` : null,
    [league?.id],
  );

  if (leagueLoading || (loading && !data))
    return (
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  if (error)
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <ErrorNote message={error} onRetry={reload} />
      </div>
    );
  if (!data) return null;

  const mine = data.history.filter((h) => h.profileId === data.you);
  const byMatch = new Map<string, typeof mine>();
  mine.forEach((h) => {
    const list = byMatch.get(h.matchId) ?? [];
    list.push(h);
    byMatch.set(h.matchId, list);
  });

  const approvedMatches = matches.data?.matches ?? [];

  const me = data.standings.find((s) => s.profileId === data.you);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow={`${league?.name} · archive`}
        title="History"
        subtitle="Past results, your points per match and how your rank has moved over the season."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Box label="Matches played" value={String(me?.matchesPlayed ?? 0)} />
        <Box label="Total points" value={String(Math.round(Number(me?.totalPoints ?? 0)))} />
        <Box label="Current rank" value={me ? `#${me.rank}` : "—"} />
        <Box label="Approved matches" value={String(matches.data?.total ?? 0)} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel className="p-4">
          <Slate className="mb-3 block">Your points history</Slate>
          {!mine.length ? (
            <p className="text-[13.5px] text-sage-dim">
              No approved matches yet — your first scores will be listed here.
            </p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {[...mine]
                .sort((a, b) => new Date(b.kickOff ?? 0).getTime() - new Date(a.kickOff ?? 0).getTime())
                .map((h, i) => (
                  <li key={`${h.matchId}-${i}`} className="flex items-center gap-3 py-2.5">
                    <span className="num w-12 shrink-0 text-right text-[17px] font-semibold text-green">
                      {Math.round(Number(h.points))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <Link href={`/matches/${h.matchId}`} className="block truncate text-[14px] text-chalk hover:text-green">
                        {h.matchTitle}
                      </Link>
                      <span className="num block text-[11px] uppercase tracking-[0.1em] text-sage-dim">
                        GW{h.gameweek}
                        {h.kickOff ? ` · ${new Date(h.kickOff).toLocaleDateString()}` : ""}
                      </span>
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </Panel>

        <Panel className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <Slate>Approved matches</Slate>
            <Link href="/matches" className="text-[13px] text-sage hover:text-green">
              Open
            </Link>
          </div>
          {matches.loading ? <Skeleton className="h-28" /> : matches.error ? (
            <ErrorNote message={matches.error} onRetry={matches.reload} />
          ) : !approvedMatches.length ? (
            <p className="text-[13.5px] text-sage-dim">Nothing approved yet.</p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {approvedMatches.map((m) => (
                <li key={m.id}>
                  <Link href={`/matches/${m.id}`} className="flex items-center gap-3 py-2.5 hover:text-green">
                    <Badge tone="live">final</Badge>
                    <span className="min-w-0 flex-1 truncate text-[14px] text-chalk">
                      <RealTeamName name={m.teamAName} logo={m.teamALogo} /> v <RealTeamName name={m.teamBName} logo={m.teamBLogo} />
                    </span>
                    <span className="num text-[11.5px] text-sage-dim">
                      {new Date(m.kickOff).toLocaleDateString()}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {(page > 1 || matches.data?.hasMore) && !matches.loading && (
            <div className="mt-4 flex justify-between text-[13px] text-sage">
              <button disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
              <span>Page {page}</span>
              <button disabled={!matches.data?.hasMore} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
        </Panel>
      </div>

      <Panel className="mt-5 p-4">
        <Slate className="mb-3 block">Standings snapshot</Slate>
        <ul className="divide-y divide-line-soft">
          {data.standings.map((s) => (
            <li key={s.profileId} className="flex items-center gap-3 py-2.5">
              <span className="num w-7 text-[14px] text-green">{s.rank}</span>
              <span className={`min-w-0 flex-1 truncate text-[14px] ${s.profileId === data.you ? "text-chalk" : "text-sage"}`}>
                {s.displayName}
              </span>
              <span className="num text-[13.5px] text-sage">{s.matchesPlayed} MP</span>
              <span className="num w-12 text-right text-[15px] font-semibold text-chalk">
                {Math.round(Number(s.totalPoints))}
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      {!mine.length && !approvedMatches.length && (
        <div className="mt-5">
          <EmptyState
            title="The archive is empty"
            body="Approve a match and its result becomes part of the permanent record."
            icon={<HistoryIcon className="h-5 w-5" />}
          />
        </div>
      )}
    </div>
  );
}

function Box({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel rounded-lg px-4 py-3.5">
      <div className="slate">{label}</div>
      <div className="num mt-1.5 text-[24px] font-semibold text-chalk">{value}</div>
    </div>
  );
}
