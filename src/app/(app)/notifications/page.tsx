"use client";

import { Bell, CheckCheck } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { Button, EmptyState, ErrorNote, Panel, Skeleton, Slate, TableSkeleton, Toast } from "@/components/ui";
import { useLeague } from "@/components/LeagueContext";
import { api, useApi } from "@/lib/client/api";
import { useState } from "react";

type Note = {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

export default function NotificationsPage() {
  const { refresh } = useLeague();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const { data, loading, error, reload, setData } = useApi<{ notifications: Note[]; unread: number }>(
    `/api/notifications${filter === "unread" ? "?filter=unread" : ""}`,
    [filter],
  );
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const markAll = async () => {
    setBusy(true);
    try {
      await api("/api/notifications", { method: "PATCH", body: { all: true } });
      setData({ notifications: (data?.notifications ?? []).map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })), unread: 0 });
      setToast("All notifications marked read");
      void refresh();
      reload();
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Could not update");
    } finally {
      setBusy(false);
    }
  };

  const markOne = async (id: string) => {
    try {
      await api("/api/notifications", { method: "PATCH", body: { ids: [id] } });
      setData({
        notifications: (data?.notifications ?? []).map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)),
        unread: Math.max(0, (data?.unread ?? 1) - 1),
      });
      void refresh();
    } catch {
      setToast("Could not update that notification");
    }
  };

  if (loading && !data)
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <TableSkeleton rows={5} />
      </div>
    );
  if (error)
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <ErrorNote message={error} onRetry={reload} />
      </div>
    );

  const notes = data?.notifications ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow={`${data?.unread ?? 0} unread`}
        title="Notifications"
        subtitle="Invitations, fixtures, submissions, approvals and standings updates."
        actions={
          <Button variant="outline" onClick={markAll} loading={busy} disabled={!(data?.unread)}>
            <CheckCheck className="h-4 w-4" /> Mark all read
          </Button>
        }
      />

      <div className="mb-4 flex gap-1.5">
        {(["all", "unread"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`h-8 rounded-md border px-3 text-[12px] font-semibold uppercase tracking-[0.12em] transition-colors ${
              filter === f ? "border-green bg-green/12 text-green" : "border-line bg-pitch-900 text-sage hover:text-chalk"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {!notes.length ? (
        <EmptyState
          title={filter === "unread" ? "Nothing unread" : "No notifications"}
          body="Activity from your leagues will show up here in real time."
          icon={<Bell className="h-5 w-5" />}
        />
      ) : (
        <Panel className="divide-y divide-line-soft">
          {notes.map((n, i) => (
            <article
              key={n.id}
              className={`flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-pitch-800/50 ${
                n.readAt ? "" : "bg-green/4"
              }`}
              style={{ animation: `rise .35s cubic-bezier(.2,.8,.2,1) ${i * 24}ms both` }}
            >
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.readAt ? "bg-line" : "bg-green"}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14.5px] font-semibold text-chalk">{n.title}</span>
                  <span className="slate">{n.type.replace(/_/g, " ")}</span>
                </div>
                <p className="mt-0.5 text-[13.5px] leading-relaxed text-sage">{n.body}</p>
                <div className="mt-1.5 flex items-center gap-3">
                  <span className="num text-[11px] uppercase tracking-[0.1em] text-sage-dim">
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                  {n.link && (
                    <a href={n.link} className="text-[12.5px] text-green underline-offset-4 hover:underline">
                      Open
                    </a>
                  )}
                </div>
              </div>
              {!n.readAt && (
                <button
                  onClick={() => markOne(n.id)}
                  className="slate shrink-0 rounded border border-line px-2 py-1.5 hover:border-green hover:text-green"
                >
                  Read
                </button>
              )}
            </article>
          ))}
        </Panel>
      )}

      <Slate className="mt-5 block">Refreshed live while this page is open</Slate>
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
