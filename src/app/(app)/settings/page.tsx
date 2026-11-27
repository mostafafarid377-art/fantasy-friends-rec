"use client";

import { useState } from "react";
import { RefreshCw, ShieldCheck, Trash2, Wifi } from "lucide-react";
import { DeleteLeague } from "@/components/DeleteLeague";
import { MfaSettings } from "@/components/MfaSettings";
import { PageHeader } from "@/components/AppShell";
import { Badge, Button, ErrorNote, Field, Panel, Select, Skeleton, Slate, TextInput, Toast } from "@/components/ui";
import { useActiveLeague, useLeague } from "@/components/LeagueContext";
import { api, pendingCount, recoverPendingOperations, useApi } from "@/lib/client/api";

type LeagueData = {
  league: {
    id: string;
    name: string;
    description: string | null;
    subsCount: number;
    starters: number;
    vicePolicy: string;
    format: string;
    inviteCode: string;
  };
  role: string;
  canDelete: boolean;
};

export default function SettingsPage() {
  const { league, loading: leagueLoading } = useActiveLeague();
  const { refresh, recovered } = useLeague();
  const { data, loading, error, reload, setData } = useApi<LeagueData>(league ? `/api/leagues/${league.id}` : null, [league?.id]);

  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [subs, setSubs] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState(pendingCount());

  const value = {
    name: name ?? data?.league.name ?? "",
    description: description ?? data?.league.description ?? "",
    subs: subs ?? String(data?.league.subsCount ?? ""),
  };

  const save = async () => {
    if (!league) return;
    setBusy(true);
    try {
      const saved = await api<{ league: LeagueData["league"] }>(`/api/leagues/${league.id}`, {
        method: "PATCH",
        body: {
          name: value.name.trim(),
          description: value.description.trim() || null,
          subsCount: Number(value.subs),
        },
      });
      if (saved?.league?.id !== league.id) throw new Error("League settings update could not be confirmed");
      setData((old) => old ? { ...old, league: saved.league } : old);
      setName(null); setDescription(null); setSubs(null);
      setToast({ message: "League settings saved", tone: "ok" });
      void refresh().catch((error) => console.warn("[session refresh]", error));
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Could not save", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const recover = async () => {
    try {
      const n = await recoverPendingOperations();
      if (n) await refresh();
      setToast({ message: n ? `Recovered ${n} pending change${n > 1 ? "s" : ""}` : "Nothing pending", tone: "ok" });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Recovery could not be confirmed", tone: "error" });
    } finally { setQueue(pendingCount()); }
  };

  if (leagueLoading || (loading && !data))
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );

  if (error) return <div className="mx-auto max-w-3xl p-5"><ErrorNote message={error} onRetry={reload} /></div>;

  const isLeader = data?.role === "leader";

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow="Account & league"
        title="Settings"
        subtitle="League policy lives here, along with the reliability controls for your own connection."
      />

      <Panel className="mb-5 p-5">
        <div className="mb-4 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-green" />
          <Slate>League settings</Slate>
          <Badge tone="neutral">{data?.league.format}</Badge>
        </div>

        {isLeader ? (
          <div className="space-y-4">
            <Field label="League name">
              <TextInput value={value.name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Description">
              <TextInput
                value={value.description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this group is about"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Substitutes per team" hint={`A squad is ${data?.league.starters ?? 0} starters plus this many substitutes. Existing squads may need rebalancing.`}>
                <TextInput
                  type="number"
                  min={1}
                  max={10}
                  value={value.subs}
                  onChange={(e) => setSubs(e.target.value)}
                />
              </Field>
              <Field label="Invitation code" hint="Permanent for this league.">
                <TextInput value={data?.league.inviteCode ?? ""} readOnly className="num tracking-[0.25em]" />
              </Field>
            </div>
            <div className="flex justify-end">
              <Button onClick={save} loading={busy}>
                Save settings
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-[13.5px] text-sage">
            Only the League Leader can change league settings. You can edit your own squad, profile
            and notifications from here.
          </p>
        )}
      </Panel>

      <Panel className="mb-5 p-5">
        <div className="mb-4 flex items-center gap-2">
          <Wifi className="h-4 w-4 text-green" />
          <Slate>Reliability & recovery</Slate>
        </div>
        <div className="space-y-3 text-[13.5px] leading-relaxed text-sage">
          <p>
            Supported creation requests are saved on this device for your account if the connection drops.
            Recovery reuses the original request ID. Passwords and edits to existing records are never replayed.
          </p>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-pitch-900 px-4 py-3">
            <span className="slate">Pending operations</span>
            <span className="num text-[16px] font-semibold text-chalk">{queue}</span>
            <span className="slate">Recovered this session</span>
            <span className="num text-[16px] font-semibold text-green">{recovered}</span>
            <span className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setQueue(pendingCount())}>
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </Button>
              <Button size="sm" variant="primary" onClick={recover}>
                Replay now
              </Button>
            </span>
          </div>
        </div>
      </Panel>

      <MfaSettings />

      <Panel className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <Trash2 className="h-4 w-4 text-card-r" />
          <Slate>Session</Slate>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13.5px] text-sage">
            Sessions last 30 days on this device. Password changes revoke every session
            immediately.
          </p>
          <Button href="/forgot" variant="outline">
            Change password
          </Button>
        </div>
      </Panel>

      {data?.canDelete && <DeleteLeague key={data.league.id} id={data.league.id} name={data.league.name} disabled={busy} />}
      <Slate className="mt-6 block">
        Format is permanent: {data?.league.format} · {league?.starters} starters
      </Slate>
      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}
