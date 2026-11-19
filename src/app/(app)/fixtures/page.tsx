"use client";

import { useState } from "react";
import { CalendarPlus, ClipboardList, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  Panel,
  Skeleton,
  Slate,
  TextInput,
  Toast,
} from "@/components/ui";
import { useActiveLeague, useLeague } from "@/components/LeagueContext";
import { api, useApi } from "@/lib/client/api";

type Fixture = {
  id: string;
  title: string;
  gameweek: number;
  scheduledAt: string | null;
  status: string;
  notes: string | null;
  realMatchId: string | null;
  match: { id: string; title: string; status: string } | null;
};

const STATUS_TONE: Record<string, "neutral" | "live" | "warn" | "danger" | "info"> = {
  scheduled: "neutral",
  active: "live",
  completed: "info",
  cancelled: "danger",
};

export default function FixturesPage() {
  const { league, loading: leagueLoading } = useActiveLeague();
  const { isLeader } = useLeague();
  const { data, loading, error, reload } = useApi<{ fixtures: Fixture[] }>(
    league ? `/api/leagues/${league.id}/fixtures` : null,
    [league?.id],
  );

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [gameweek, setGameweek] = useState("1");
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);

  const create = async () => {
    if (!league) return;
    setSaving(true);
    try {
      await api(`/api/leagues/${league.id}/fixtures`, {
        method: "POST",
        body: {
          title,
          gameweek: Number(gameweek) || 1,
          scheduledAt: date ? new Date(date).toISOString() : null,
        },
        idempotent: true,
      });
      setToast({ message: "Fixture scheduled", tone: "ok" });
      setOpen(false);
      setTitle("");
      reload();
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Could not create fixture", tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (fixtureId: string, status: string) => {
    if (!league) return;
    try {
      await api(`/api/leagues/${league.id}/fixtures`, { method: "PATCH", body: { fixtureId, status } });
      reload();
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Update failed", tone: "error" });
    }
  };

  const remove = async (fixtureId: string) => {
    if (!league) return;
    try {
      await api(`/api/leagues/${league.id}/fixtures?fixtureId=${fixtureId}`, { method: "DELETE" });
      setToast({ message: "Fixture removed", tone: "ok" });
      reload();
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Delete failed", tone: "error" });
    }
  };

  if (leagueLoading || (loading && !data))
    return (
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
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

  const fixtures = data?.fixtures ?? [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow={`${league?.name} · ${league?.format}`}
        title="Fixtures"
        subtitle="Schedule gameweeks, attach a real match and track what has been played."
        actions={
          isLeader ? (
            <Button onClick={() => setOpen(true)}>
              <CalendarPlus className="h-4 w-4" /> New fixture
            </Button>
          ) : undefined
        }
      />

      {!fixtures.length ? (
        <EmptyState
          title="No fixtures yet"
          body={
            isLeader
              ? "Schedule the first gameweek so managers know what is coming."
              : "Your League Leader has not scheduled any fixtures yet."
          }
          action={isLeader ? undefined : { label: "Dashboard", href: "/dashboard" }}
          icon={<ClipboardList className="h-5 w-5" />}
        />
      ) : (
        <div className="space-y-2">
          {fixtures.map((f, i) => (
            <Panel
              key={f.id}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"
            >
              <div className="flex items-center gap-4">
                <span className="num flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-md border border-line bg-pitch-900 leading-none">
                  <span className="text-[9px] uppercase tracking-[0.14em] text-sage-dim">GW</span>
                  <span className="text-[15px] font-semibold text-green">{f.gameweek}</span>
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[16px] font-semibold text-chalk">{f.title}</div>
                  <div className="num mt-0.5 text-[11.5px] uppercase tracking-[0.1em] text-sage-dim">
                    {f.scheduledAt
                      ? new Date(f.scheduledAt).toLocaleString(undefined, {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "Date TBC"}
                  </div>
                </div>
              </div>

              <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
                <Badge tone={STATUS_TONE[f.status] ?? "neutral"}>{f.status}</Badge>
                {f.match && (
                  <a href={`/matches/${f.match.id}`} className="text-[13px] text-sage underline-offset-4 hover:text-green hover:underline">
                    {f.match.title}
                  </a>
                )}
                {isLeader && (
                  <>
                    {f.status !== "completed" && f.status !== "cancelled" && (
                      <button
                        onClick={() => setStatus(f.id, "completed")}
                        className="slate rounded border border-line px-2 py-1.5 hover:border-green hover:text-green"
                      >
                        Complete
                      </button>
                    )}
                    <button
                      onClick={() => remove(f.id)}
                      aria-label="Delete fixture"
                      className="rounded border border-line p-1.5 text-sage hover:border-card-r hover:text-card-r"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
              <span className="sr-only">{i}</span>
            </Panel>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Schedule a fixture">
        <div className="space-y-4">
          <Field label="Fixture title">
            <TextInput
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Matchday 1 — Tuesday night"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Gameweek">
              <TextInput type="number" min={1} value={gameweek} onChange={(e) => setGameweek(e.target.value)} />
            </Field>
            <Field label="Kick-off" hint="Optional">
              <TextInput type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <div className="flex justify-end gap-2.5 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} loading={saving} disabled={title.trim().length < 3}>
              Create fixture
            </Button>
          </div>
        </div>
      </Modal>

      <Slate className="mt-6 block">
        {fixtures.length} fixture{fixtures.length === 1 ? "" : "s"} scheduled
      </Slate>
      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}
