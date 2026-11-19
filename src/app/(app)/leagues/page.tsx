"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, KeyRound, Plus, Trophy } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import {
  Badge,
  Button,
  ErrorNote,
  Field,
  Panel,
  Skeleton,
  Slate,
  TextInput,
  Toast,
} from "@/components/ui";
import { useLeague } from "@/components/LeagueContext";
import { api, assertConfirmed } from "@/lib/client/api";

const FORMAT_COPY = {
  "5v5": {
    title: "Five-a-side",
    starters: 5,
    outfield: 4,
    shapes: "1-2-1 · 1-1-2 · 1-3 · 2-2",
    blurb: "Fast, tight, four outfield players behind a keeper.",
  },
  "7v7": {
    title: "Seven-a-side",
    starters: 7,
    outfield: 6,
    shapes: "1-2-3 · 1-3-2 · 1-4-1 · 1-3-1-1",
    blurb: "Room to build a midfield, six outfield players behind a keeper.",
  },
} as const;

export default function LeaguesPage() {
  const { leagues, loading, refresh, selectLeague, user } = useLeague();
  const router = useRouter();

  const [mode, setMode] = useState<"list" | "create" | "join">("list");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [format, setFormat] = useState<"5v5" | "7v7">("5v5");
  const [subs, setSubs] = useState("5");
  const [teamName, setTeamName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ league: { id: string } }>("/api/leagues", {
        method: "POST",
        body: {
          name: name.trim(),
          description: description.trim() || undefined,
          format,
          subsCount: Number(subs) || 5,
          teamName: teamName.trim() || undefined,
        },
        idempotent: true,
      });
      const saved = assertConfirmed(res?.league, "League membership could not be confirmed");
      const session = await refresh();
      if (!session.leagues.some((l) => l.id === saved.id)) throw new Error("Membership was saved, but could not be loaded. Reopen Leagues to check it.");
      selectLeague(saved.id);
      setToast({ message: "League created", tone: "ok" });
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the league");
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ league: { id: string } }>("/api/leagues/join", {
        method: "POST",
        body: { code: code.trim().toUpperCase(), teamName: teamName.trim() || undefined },
        idempotent: true,
      });
      const saved = assertConfirmed(res?.league, "League membership could not be confirmed");
      const session = await refresh();
      if (!session.leagues.some((l) => l.id === saved.id)) throw new Error("Membership was saved, but could not be loaded. Reopen Leagues to check it.");
      selectLeague(saved.id);
      setToast({ message: "Joined the league", tone: "ok" });
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow={user ? `Signed in as @${user.username}` : undefined}
        title="Your leagues"
        subtitle="Each league is private, has its own format and its own player database."
        actions={
          <>
            <Button variant={mode === "join" ? "primary" : "outline"} onClick={() => setMode(mode === "join" ? "list" : "join")}>
              <KeyRound className="h-4 w-4" /> Join with code
            </Button>
            <Button variant={mode === "create" ? "primary" : "outline"} onClick={() => setMode(mode === "create" ? "list" : "create")}>
              <Plus className="h-4 w-4" /> Create league
            </Button>
          </>
        }
      />

      {error && <div className="mb-5"><ErrorNote message={error} /></div>}

      {mode === "create" && (
        <Panel className="mb-6 p-5">
          <Slate className="mb-4 block">New league</Slate>
          <div className="space-y-4">
            <Field label="League name">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Tuesday Night League" />
            </Field>
            <Field label="Description" hint="Optional — what this group is about.">
              <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Six-a-side lads, no mercy" />
            </Field>

            <div>
              <Slate className="mb-2 block">Match format</Slate>
              <div className="grid gap-3 sm:grid-cols-2">
                {(Object.keys(FORMAT_COPY) as ("5v5" | "7v7")[]).map((f) => {
                  const copy = FORMAT_COPY[f];
                  const active = format === f;
                  return (
                    <button
                      key={f}
                      onClick={() => setFormat(f)}
                      className={`rounded-lg border p-4 text-left transition-all ${
                        active
                          ? "border-green bg-green/8 shadow-[0_0_0_1px_rgba(49,224,125,0.35)]"
                          : "border-line bg-pitch-900 hover:border-green-dim"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-display text-[20px] font-bold uppercase text-chalk">
                          {copy.title}
                        </span>
                        <span className={`num text-[26px] font-semibold ${active ? "text-green" : "text-sage"}`}>
                          {f}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[13px] leading-relaxed text-sage">{copy.blurb}</p>
                      <div className="num mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] uppercase tracking-[0.1em] text-sage-dim">
                        <span>{copy.starters} starters</span>
                        <span>1 GK</span>
                        <span>{copy.outfield} outfield</span>
                      </div>
                      <div className="num mt-1 text-[11.5px] text-green-dim">{copy.shapes}</div>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[12.5px] text-sage-dim">
                The format is stored permanently and enforced for every squad, lineup and direct
                database request in this league.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Substitutes per team" hint="Additional players on the bench (1–10).">
                <TextInput type="number" min={1} max={10} value={subs} onChange={(e) => setSubs(e.target.value)} />
              </Field>
              <Field label="Your team name">
                <TextInput value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Your XI" />
              </Field>
            </div>

            <div className="flex justify-end gap-2.5 pt-1">
              <Button variant="ghost" onClick={() => setMode("list")}>
                Cancel
              </Button>
              <Button onClick={create} loading={busy} disabled={name.trim().length < 3}>
                Create league <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Panel>
      )}

      {mode === "join" && (
        <Panel className="mb-6 p-5">
          <Slate className="mb-4 block">Join a league</Slate>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label="Invitation code" hint="Eight characters, printed on the members screen.">
                <TextInput
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="ABCD2345"
                  className="num tracking-[0.3em] uppercase"
                />
              </Field>
            </div>
            <Button onClick={join} loading={busy} disabled={code.trim().length < 4}>
              Join league <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </Panel>
      )}

      {leagues.length === 0 && mode === "list" ? (
        <div className="rounded-xl border border-dashed border-line px-6 py-14 text-center">
          <Trophy className="mx-auto mb-4 h-6 w-6 text-green-dim" />
          <h2 className="text-2xl text-chalk">No leagues yet</h2>
          <p className="mx-auto mt-2 max-w-md text-[14.5px] leading-relaxed text-sage">
            Create one and pick the format, or enter the code a friend sent you.
          </p>
        </div>
      ) : (
        mode === "list" && (
          <ul className="space-y-2.5">
            {leagues.map((l) => (
              <li key={l.id}>
                <Link
                  href="/dashboard"
                  onClick={() => selectLeague(l.id)}
                  className="group flex items-center gap-4 rounded-xl border border-line bg-pitch-850 px-4 py-4 transition-all hover:border-green-dim"
                >
                  <span className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-lg border border-line bg-pitch-900 font-display font-bold leading-none text-green">
                    <span className="text-[15px]">{l.format.replace("v", "-")}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[17px] font-semibold text-chalk">{l.name}</span>
                    <span className="num mt-0.5 block text-[11.5px] uppercase tracking-[0.1em] text-sage-dim">
                      {l.teamName ?? "no team name"} · code {l.inviteCode}
                    </span>
                  </span>
                  <Badge tone={l.role === "leader" ? "info" : "neutral"}>
                    {l.role === "leader" ? "League leader" : l.role}
                  </Badge>
                  {l.rank && <span className="num hidden text-[15px] text-sage sm:block">#{l.rank}</span>}
                  <ArrowRight className="h-4 w-4 shrink-0 text-sage-dim transition-transform group-hover:translate-x-1 group-hover:text-green" />
                </Link>
              </li>
            ))}
          </ul>
        )
      )}

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}
