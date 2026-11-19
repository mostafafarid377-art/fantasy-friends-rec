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
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Panel,
  Slate,
} from "@/components/ui";
import { useApi } from "@/lib/client/api";

type DashboardData = {
  league: { id: string; name: string; format: string; starters: number; inviteCode: string; role: string };
  squad: {
    formation: string;
    captainId: string | null;
    size: number;
    starters: number;
    subs: number;
    complete: boolean;
    players: { playerId: string; slot: string; fullName: string; position: string }[];
  } | null;
  standings: {
    profileId: string;
    rank: number;
    prevRank: number | null;
    totalPoints: string;
    matchesPlayed: number;
    displayName: string;
    teamName: string | null;
  }[];
  myRank: number | null;
  myPoints: string;
  fixtures: { id: string; title: string; gameweek: number; scheduledAt: string | null; status: string }[];
  matches: { id: string; title: string; status: string; kickOff: string; eventCount: number }[];
  notifications: { id: string; title: string; body: string; readAt: string | null; createdAt: string }[];
  rulesApproved: boolean;
  memberCount: number;
  emailVerified: boolean;
};

export default function DashboardPage() {
  const { league, loading: leagueLoading } = useActiveLeague();
  const { unread } = useLeague();
  const { data, error, loading, reload } = useApi<DashboardData>(
    league ? `/api/dashboard?leagueId=${league.id}` : null,
    [league?.id],
  );

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
  const myPoints = Number(data.myPoints ?? 0);

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
        <Stat label="League rank" value={data.myRank ? `#${data.myRank}` : "—"} accent />
        <Stat label="Total points" value={String(myPoints)} />
        <Stat label="Managers" value={String(data.memberCount)} />
        <Stat label="Squad" value={`${data.squad?.size ?? 0}/15`} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
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
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line-soft">
                  <th className="slate px-4 py-2.5 text-left">#</th>
                  <th className="slate px-2 py-2.5 text-left">Manager</th>
                  <th className="slate px-2 py-2.5 text-right">MP</th>
                  <th className="slate px-4 py-2.5 text-right">Pts</th>
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
        <div className="space-y-5">
          {/* squad snapshot */}
          <Panel className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <Slate>Your squad</Slate>
              <Link href="/team" className="text-[13px] text-sage hover:text-green">
                Manage
              </Link>
            </div>
            {!data.squad ? (
              <div className="rounded-lg border border-dashed border-line p-4 text-center">
                <p className="text-[14px] text-sage">You have not built a squad yet.</p>
                <Button href="/team/pick" size="sm" className="mt-3">
                  Pick your 15 <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <>
                <div className="flex items-end justify-between">
                  <div>
                    <div className="num text-3xl font-semibold text-green">{data.squad.formation}</div>
                    <div className="slate mt-1">Formation</div>
                  </div>
                  <div className="text-right">
                    <div className="num text-3xl font-semibold text-chalk">
                      {data.squad.starters}/{data.league.starters}
                    </div>
                    <div className="slate mt-1">Starters</div>
                  </div>
                </div>
                <div className="mt-4 space-y-1.5">
                  {data.squad.players
                    .filter((p) => p.slot === "starter")
                    .slice(0, 7)
                    .map((p) => (
                      <div key={p.playerId} className="flex items-center gap-2 text-[13.5px]">
                        <span className="num w-9 text-[11px] text-green-glow/80">{p.position}</span>
                        <span className="truncate text-chalk">{p.fullName}</span>
                        {p.playerId === data.squad?.captainId && <Badge tone="warn">C</Badge>}
                      </div>
                    ))}
                </div>
                {!data.squad.complete && (
                  <Button href="/team/pick" size="sm" variant="outline" className="mt-4 w-full">
                    Finish squad ({data.squad.size}/15)
                  </Button>
                )}
              </>
            )}
          </Panel>

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

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`panel rounded-lg px-4 py-3.5 ${accent ? "border-green/35" : ""}`}>
      <div className="slate">{label}</div>
      <div className={`num mt-1.5 text-[26px] font-semibold ${accent ? "text-green" : "text-chalk"}`}>
        {value}
      </div>
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

