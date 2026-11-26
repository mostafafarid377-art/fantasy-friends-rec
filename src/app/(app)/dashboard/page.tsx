"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronRight,
  CircleAlert,
  MailWarning,
  Minus,
  Plus,
  Trophy,
} from "lucide-react";
import { useActiveLeague, useLeague } from "@/components/LeagueContext";
import { PageHeader } from "@/components/AppShell";
import {
  Avatar,
  Button,
  EmptyState,
  ErrorNote,
  Panel,
  Slate,
} from "@/components/ui";
import { Pitch } from "@/components/Pitch";
import { PlayerPerformanceDialog, PlayerPointsLabel } from "@/components/PlayerPerformance";
import { deriveFormation, FORMATIONS, orderedBench, type LeagueFormat } from "@/lib/domain";
import type { LiveMatchPoints } from "@/lib/live-points";
import type { LatestPlayerGames } from "@/lib/player-performance";
import type { SquadEntry } from "@/lib/squad";
import { useLiveLeaguePoints } from "@/lib/client/league-updates";
import { useApi } from "@/lib/client/api";
import { MotmCard } from "@/components/MotmCard";
import type { Motm } from "@/lib/motm";

type DashboardData = {
  league: { id: string; name: string; format: LeagueFormat; starters: number; subsCount: number; squadSize: number; inviteCode: string; role: string };
  squad: {
    formation: string;
    captainId: string | null;
    viceCaptainId: string | null;
    size: number;
    starters: number;
    subs: number;
    complete: boolean;
    players: SquadEntry[];
  } | null;
  /** The squad in force: lineup in play or previous match's official lineup. */
  lineup?: {
    matchId: string;
    title: string;
    kickOff: string;
    inPlay: boolean;
    formation: string;
    captainId: string | null;
    viceCaptainId: string | null;
    players: SquadEntry[];
  } | null;
  standings: {
    profileId: string;
    rank: number;
    prevRank: number | null;
    totalPoints: number;
    matchesPlayed: number;
    displayName: string;
    teamName: string | null;
  }[];
  liveMatches?: LiveMatchPoints[];
  latestPlayerGames?: LatestPlayerGames;
  provisional?: boolean;
  myRank: number | null;
  lastGame: { matchId: string; title: string; points: number | null } | null;
  fixtures: { id: string; title: string; gameweek: number; scheduledAt: string | null; status: string }[];
  matches: { id: string; title: string; status: string; kickOff: string; eventCount: number }[];
  notifications: { id: string; title: string; body: string; readAt: string | null; createdAt: string }[];
  rulesApproved: boolean;
  memberCount: number;
  emailVerified: boolean;
  motm: Motm | null;
};

export default function DashboardPage() {
  const { league, loading: leagueLoading } = useActiveLeague();
  const { unread } = useLeague();
  const { data, error, loading, reload } = useApi<DashboardData>(
    league ? `/api/dashboard?leagueId=${league.id}` : null,
    [league?.id],
  );

  useLiveLeaguePoints(league?.id, reload);

  if (leagueLoading || (loading && !data)) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
        <div className="mb-6 h-24 animate-pulse rounded-lg bg-pitch-800" />
        <div className="grid gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-56 animate-pulse rounded-lg bg-pitch-800" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <ErrorNote message={error} onRetry={reload} />
      </div>
    );
  }
  if (!data) return null;

  const me = data.standings.find((s) => s.rank === data.myRank);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow={`${data.league.name} · ${data.league.format}`}
        title={`Matchday HQ`}
        subtitle="Your squad, the table and everything that has just happened in your league."
        actions={
          <>
            <Button href="/team" variant="outline">
              My team <ChevronRight className="h-4 w-4" />
            </Button>
            <Button href="/matches">
              Match centre <ChevronRight className="h-4 w-4" />
            </Button>
          </>
        }
      />

      {!data.emailVerified && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-card-y/40 bg-card-y/8 px-4 py-3">
          <MailWarning className="h-4 w-4 shrink-0 text-card-y" />
          <span className="flex-1 text-[14px] text-chalk">
            Confirm your email to secure your account.
          </span>
          <VerifyButton />
        </div>
      )}

      {!data.rulesApproved && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-card-y/40 bg-card-y/8 px-4 py-3">
          <CircleAlert className="h-4 w-4 shrink-0 text-card-y" />
          <span className="flex-1 text-[14px] text-chalk">
            Scoring rules are still a draft. No official points can be awarded until the
            League Leader approves them.
          </span>
          <Button href="/rules" size="sm" variant="outline">
            Review rules
          </Button>
        </div>
      )}

      {/* ---- headline stats ---- */}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={data.provisional ? "League rank · live" : "League rank"} value={data.myRank ? `#${data.myRank}` : "—"} accent />
        {data.liveMatches?.[0] ? <Stat label="Live Match Points" value={String(data.liveMatches[0].points)} detail={`${data.liveMatches[0].title} · Provisional`} /> :
          <Stat label="Last Game Points" value={data.lastGame?.points == null ? "—" : String(data.lastGame.points)} detail={data.lastGame ? `${data.lastGame.title}${data.lastGame.points == null ? " · No score" : ""}` : "No finalized game yet"} />}
        <Stat label="Managers" value={String(data.memberCount)} />
        <Stat label="Squad" value={`${data.squad?.size ?? 0}/${data.league.squadSize}`} />
      </div>

      {/* ---- Man of the Match: latest pick for the league, between the stats and the table ---- */}
      {data.motm && (
        <section aria-label="Man of the match" className="mb-6">
          <MotmCard motm={data.motm} href={`/matches/${data.motm.matchId}`} />
        </section>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        {/* ---- league table (hero) ---- */}
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
            <div className="flex items-center gap-2">
              <Trophy className="h-4 w-4 text-green" />
              <Slate>League table</Slate>
            </div>
            <Link href="/standings" className="text-[13px] text-sage hover:text-green">
              Full table
            </Link>
          </div>

          {data.provisional && <p className="mb-2 text-xs text-card-y">Includes provisional live points</p>}
          {data.standings.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No managers yet"
                body="Share your invitation code to bring the group in."
                action={{ label: "Invite friends", href: "/members" }}
                icon={<Plus className="h-5 w-5" />}
              />
            </div>
          ) : (
            <table className="w-full table-fixed border-collapse">
              <thead>
                <tr className="border-b border-line-soft">
                  <th className="slate w-16 px-4 py-2.5 text-left">#</th>
                  <th className="slate px-2 py-2.5 text-left">Manager</th>
                  <th className="slate w-11 px-2 py-2.5 text-right">MP</th>
                  <th className="slate w-[60px] px-4 py-2.5 text-right">Pts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {data.standings.slice(0, 8).map((row, i) => {
                  const movement =
                    row.prevRank == null
                      ? null
                      : row.prevRank > row.rank
                        ? "up"
                        : row.prevRank < row.rank
                          ? "down"
                          : "same";
                  const isMe = row.rank === data.myRank;
                  return (
                    <tr
                      key={row.profileId}
                      className={`transition-colors hover:bg-pitch-800/70 ${isMe ? "bg-green/6" : ""}`}
                      style={{ animation: `rise .4s cubic-bezier(.2,.8,.2,1) ${i * 24}ms both` }}
                    >
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-1.5">
                          <span className={`num text-[15px] font-semibold ${row.rank <= 3 ? "text-green" : "text-chalk"}`}>
                            {row.rank}
                          </span>
                          <Movement kind={movement} />
                        </span>
                      </td>
                      <td className="px-2 py-3">
                        <div className="truncate text-[14.5px] font-semibold text-chalk">
                          {row.displayName}
                          {isMe && <span className="ml-1.5 text-[11px] uppercase tracking-wider text-green">you</span>}
                        </div>
                        <div className="truncate text-[12px] text-sage-dim">{row.teamName ?? "—"}</div>
                      </td>
                      <td className="num px-2 py-3 text-right text-[13.5px] text-sage">{row.matchesPlayed}</td>
                      <td className="num px-4 py-3 text-right text-[16px] font-semibold text-chalk">
                        {Number(row.totalPoints)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        {/* ---- right rail ---- */}
        <div className="min-w-0 space-y-5">
          <SquadPreview key={data.league.id} league={data.league} squad={data.squad} lineup={data.lineup ?? null} latestPlayerGames={data.latestPlayerGames} />

          {/* fixtures */}
          <Panel className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <Slate>Upcoming fixtures</Slate>
              <Link href="/fixtures" className="text-[13px] text-sage hover:text-green">
                All
              </Link>
            </div>
            {data.fixtures.length === 0 ? (
              <p className="text-[13.5px] text-sage-dim">No fixtures scheduled yet.</p>
            ) : (
              <ul className="space-y-2.5">
                {data.fixtures.slice(0, 4).map((f) => (
                  <li key={f.id} className="flex items-center gap-3 border-b border-line-soft pb-2.5 last:border-0">
                    <span className="num rounded bg-pitch-800 px-1.5 py-0.5 text-[11px] text-green">GW{f.gameweek}</span>
                    <span className="min-w-0 flex-1 truncate text-[14px] text-chalk">{f.title}</span>
                    <span className="num text-[11.5px] text-sage-dim">
                      {f.scheduledAt ? new Date(f.scheduledAt).toLocaleDateString() : "TBC"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {/* results */}
          <Panel className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <Slate>Latest results</Slate>
              <Link href="/matches" className="text-[13px] text-sage hover:text-green">
                Matches
              </Link>
            </div>
            {data.matches.length === 0 ? (
              <p className="text-[13.5px] text-sage-dim">No matches created yet.</p>
            ) : (
              <ul className="space-y-2.5">
                {data.matches.slice(0, 4).map((m) => (
                  <li key={m.id}>
                    <Link
                      href={`/matches/${m.id}`}
                      className="flex items-center gap-3 rounded-md px-1 py-1.5 transition-colors hover:bg-pitch-800"
                    >
                      <StatusDot status={m.status} />
                      <span className="min-w-0 flex-1 truncate text-[14px] text-chalk">{m.title}</span>
                      <span className="num text-[11.5px] text-sage-dim">{m.eventCount} ev</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      {/* ---- activity ---- */}
      <Panel className="mt-5 p-4">
        <div className="mb-3 flex items-center justify-between">
          <Slate>Notifications</Slate>
          <Link href="/notifications" className="text-[13px] text-sage hover:text-green">
            {unread} unread
          </Link>
        </div>
        {data.notifications.length === 0 ? (
          <p className="text-[13.5px] text-sage-dim">Nothing new. You are all caught up.</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {data.notifications.slice(0, 4).map((n) => (
              <li key={n.id} className="flex items-start gap-3 py-2.5">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${n.readAt ? "bg-line" : "bg-green"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold text-chalk">{n.title}</span>
                  <span className="block text-[13px] text-sage">{n.body}</span>
                </span>
                <span className="num shrink-0 text-[11px] text-sage-dim">
                  {new Date(n.createdAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function SquadPreview({ league, squad, lineup, latestPlayerGames }: Pick<DashboardData, "league" | "squad" | "lineup" | "latestPlayerGames">) {
  // The pitch shows the squad in force: the locked lineup of the match in
  // play or the previous match's official lineup when either exists, exactly
  // like My Team. The default squad is the fallback while no match has
  // locked a lineup yet. Editable next-match drafts never appear here.
  const players = lineup?.players ?? squad?.players ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = players.find((p) => p.id === selectedId);
  // The latest points of the squad players arrive with the dashboard itself,
  // so the pitch never waits for a second request.
  const latest = latestPlayerGames ?? {};
  const formation = deriveFormation(league, players, lineup?.formation ?? squad?.formation);
  const bench = orderedBench(players);
  const hasBenchKeeper = bench.some((p) => p.position === "GK");
  return (
    <Panel className="min-w-0 p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Slate>Your squad</Slate>
        <Link href="/team" className="text-xs font-semibold text-green hover:text-green-glow">View Full Squad</Link>
      </div>
      {lineup && <p className="mb-3 text-xs text-sage">
        {lineup.inPlay ? "Lineup in play" : "Previous match lineup"} ·{" "}
        <Link href={`/matches/${lineup.matchId}`} className="hover:text-green">{lineup.title}</Link> · Read-only
      </p>}
      <Pitch compact players={players} formation={formation ?? FORMATIONS[league.format][0]} format={league.format}
        captainId={lineup?.captainId ?? squad?.captainId ?? null} viceCaptainId={lineup?.viceCaptainId ?? squad?.viceCaptainId ?? null} latest={latest} onSelect={setSelectedId} />
      {!squad && !lineup ? <div className="mt-3 text-center">
        <p className="text-sm text-sage">You haven’t picked a squad in this league.</p>
        <Button href="/team/pick" size="sm" className="mt-2">Pick Your Squad <ChevronRight className="h-4 w-4" /></Button>
      </div> : <>
        {!lineup && !formation && <p className="mt-2 text-xs text-card-y">Some starters no longer fit. Review the full squad to fix the lineup.</p>}
        {bench.length > 0 && <div className="mt-3 border-t border-line pt-2">
          <Slate>Bench</Slate>
          <ul className="mt-2 grid grid-cols-2 gap-1.5">
            {bench.map((p, i) => <li key={p.id} className="min-w-0"><button type="button" onClick={() => setSelectedId(p.id)}
              className="flex min-h-10 w-full min-w-0 items-center gap-1.5 rounded bg-pitch-900 px-1.5 py-1 text-left hover:bg-pitch-800" title={p.name}>
              <span className="num text-[9px] text-green">{p.position === "GK" ? "GK" : i + (hasBenchKeeper ? 0 : 1)}</span>
              <Avatar name={p.name} url={p.photoUrl} size={23} decorative />
              <span className="min-w-0 flex-1 text-xs text-chalk"><span className="block truncate">{p.name}</span><PlayerPointsLabel game={latest[p.id]} /></span>
              <span className="ml-auto text-[9px] text-sage">{p.position}</span>
            </button></li>)}
          </ul>
        </div>}
        {!lineup && squad && !squad.complete && <Button href="/team/pick" size="sm" variant="outline" className="mt-3 w-full">
          Finish squad ({squad.size}/{league.squadSize})
        </Button>}
      </>}
      {selected && <PlayerPerformanceDialog key={selected.id} leagueId={league.id} entry={selected}
        latest={latest[selected.id]} onClose={() => setSelectedId(null)} />}
    </Panel>
  );
}

function Stat({ label, value, accent, detail }: { label: string; value: string; accent?: boolean; detail?: string }) {
  return (
    <div className={`panel rounded-lg px-4 py-3.5 ${accent ? "border-green/35" : ""}`}>
      <div className="slate">{label}</div>
      <div className={`num mt-1.5 text-[26px] font-semibold ${accent ? "text-green" : "text-chalk"}`}>
        {value}
      </div>
      {detail && <p className="mt-1 truncate text-xs text-sage" title={detail}>{detail}</p>}
    </div>
  );
}

function Movement({ kind }: { kind: "up" | "down" | "same" | null }) {
  if (kind === "up") return <ArrowUpRight className="h-3.5 w-3.5 text-green" />;
  if (kind === "down") return <ArrowDownRight className="h-3.5 w-3.5 text-card-r" />;
  if (kind === "same") return <Minus className="h-3.5 w-3.5 text-sage-dim" />;
  return <span className="num text-[10px] text-sage-dim">new</span>;
}

function StatusDot({ status }: { status: string }) {
  const tone =
    status === "approved"
      ? "bg-green"
      : status === "pending"
        ? "bg-card-y"
        : status === "rejected"
          ? "bg-card-r"
          : "bg-sage-dim";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${tone}`} />;
}

function VerifyButton() {
  const { refresh } = useLeague();
  const [state, setState] = useState("idle");
  return (
    <button
      onClick={async () => {
        setState("working");
        try {
          const res = await fetch("/api/auth/resend", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "verify_email" }),
          }).then((r) => r.json());
          setState("done");
          if (res?.devLink) window.open(res.devLink, "_self");
          void refresh().catch((error) => console.warn("[session refresh]", error));
        } catch {
          setState("idle");
        }
      }}
      className="h-8 rounded-md border border-card-y/50 px-3 text-[13px] font-semibold text-card-y transition-colors hover:bg-card-y/10"
    >
      {state === "working" ? "Sending…" : state === "done" ? "Sent" : "Send link"}
    </button>
  );
}

