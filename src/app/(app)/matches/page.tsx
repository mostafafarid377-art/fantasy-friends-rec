"use client";

import Link from "next/link";
import { CalendarClock, ChevronRight, Plus, Swords } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { Badge, Button, EmptyState, ErrorNote, Panel, Skeleton, Slate } from "@/components/ui";
import { useActiveLeague, useLeague } from "@/components/LeagueContext";
import { useApi } from "@/lib/client/api";

type Match = {
  id: string;
  title: string;
  status: string;
  kickOff: string;
  teamAName: string;
  teamBName: string;
  organizerId: string;
  rejectionReason: string | null;
  events: unknown[];
};

type Data = {
  matches: Match[];
  role: string;
  canOrganize: boolean;
  canApprove: boolean;
};

const TONE: Record<string, "neutral" | "live" | "warn" | "danger" | "info"> = {
  draft: "neutral",
  pending: "warn",
  approved: "live",
  rejected: "danger",
};

export default function MatchesPage() {
  const { league, loading: leagueLoading } = useActiveLeague();
  const { canOrganize, user } = useLeague();
  const { data, loading, error, reload } = useApi<Data>(
    league ? `/api/matches?leagueId=${league.id}` : null,
    [league?.id],
  );

  if (leagueLoading || (loading && !data))
    return (
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
      </div>
    );
  if (error)
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <ErrorNote message={error} onRetry={reload} />
      </div>
    );

  const matches = data?.matches ?? [];
  const pendingReview = matches.filter((m) => m.status === "pending").length;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow={`${league?.name} · ${league?.format} · ${league?.starters} starters per side`}
        title="Match centre"
        subtitle="Real matches, recorded minute by minute. Results only reach the table after the League Leader approves them."
        actions={
          canOrganize ? (
            <Button href="/matches/new">
              <Plus className="h-4 w-4" /> New match
            </Button>
          ) : undefined
        }
      />

      {pendingReview > 0 && data?.canApprove && (
        <div className="mb-5 flex items-center gap-3 rounded-lg border border-card-y/40 bg-card-y/8 px-4 py-3">
          <span className="h-2 w-2 animate-pulse-dot rounded-full bg-card-y" />
          <span className="flex-1 text-[14px] text-chalk">
            {pendingReview} result{pendingReview > 1 ? "s" : ""} waiting for your review.
          </span>
          <Link href={`/matches/${matches.find((m) => m.status === "pending")?.id ?? ""}`} className="slate text-card-y hover:text-chalk">
            Review now
          </Link>
        </div>
      )}

      {!matches.length ? (
        <EmptyState
          title="No matches yet"
          body={
            canOrganize
              ? "Create the first real match, pick both sides' line-ups and start recording events."
              : "Your Match Organizer has not created a match yet."
          }
          action={canOrganize ? { label: "Create match", href: "/matches/new" } : { label: "Dashboard", href: "/dashboard" }}
          icon={<Swords className="h-5 w-5" />}
        />
      ) : (
        <ul className="space-y-2.5">
          {matches.map((m) => (
            <li key={m.id}>
              <Link
                href={`/matches/${m.id}`}
                className="group flex flex-col gap-3 rounded-xl border border-line bg-pitch-850 p-4 transition-all hover:border-green-dim sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge tone={TONE[m.status] ?? "neutral"}>{m.status}</Badge>
                    <span className="num text-[11.5px] uppercase tracking-[0.1em] text-sage-dim">
                      {new Date(m.kickOff).toLocaleString(undefined, {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <div className="mt-2 font-display text-[21px] font-bold uppercase leading-tight text-chalk">
                    {m.teamAName} <span className="text-green">v</span> {m.teamBName}
                  </div>
                  <div className="mt-0.5 truncate text-[13px] text-sage">{m.title}</div>
                  {m.status === "rejected" && m.rejectionReason && (
                    <div className="mt-2 text-[13px] text-card-r">Rejected: {m.rejectionReason}</div>
                  )}
                </div>

                <div className="flex items-center gap-4 sm:flex-col sm:items-end">
                  <span className="num text-[13px] text-sage">
                    {m.events.length} event{m.events.length === 1 ? "" : "s"}
                  </span>
                  <span className="flex items-center gap-1.5 text-[13px] text-sage-dim sm:hidden">
                    <CalendarClock className="h-3.5 w-3.5" /> Open
                  </span>
                  <ChevronRight className="h-4 w-4 text-sage-dim transition-transform group-hover:translate-x-1 group-hover:text-green" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Slate className="mt-6 block">
        {user ? `Organizer access: ${canOrganize ? "yes" : "no"}` : ""}
      </Slate>
    </div>
  );
}
