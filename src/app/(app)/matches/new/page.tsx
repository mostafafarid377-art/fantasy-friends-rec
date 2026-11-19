"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Swords } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { Button, ErrorNote, Field, Panel, Select, Skeleton, Slate, TextInput, Toast } from "@/components/ui";
import { useActiveLeague } from "@/components/LeagueContext";
import { api, assertConfirmed, useApi } from "@/lib/client/api";

type Team = { id: string; name: string };
type Fixture = { id: string; title: string; gameweek: number };

export default function NewMatchPage() {
  const { league, loading: leagueLoading } = useActiveLeague();
  const router = useRouter();
  const teams = useApi<{ teams: Team[] }>(league ? `/api/leagues/${league.id}/teams` : null, [league?.id]);
  const fixtures = useApi<{ fixtures: Fixture[] }>(league ? `/api/leagues/${league.id}/fixtures` : null, [
    league?.id,
  ]);

  const [title, setTitle] = useState("");
  const [teamA, setTeamA] = useState("");
  const [teamB, setTeamB] = useState("");
  const [kickOff, setKickOff] = useState("");
  const [fixtureId, setFixtureId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);

  const teamList = teams.data?.teams ?? [];
  const valid = title.trim().length >= 3 && teamA && teamB && teamA !== teamB && kickOff;

  const create = async () => {
    if (!league) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ match: { id: string } }>("/api/matches", {
        method: "POST",
        body: {
          leagueId: league.id,
          teamAId: teamA,
          teamBId: teamB,
          title: title.trim(),
          kickOff: new Date(kickOff).toISOString(),
          fixtureId: fixtureId || null,
        },
        idempotent: true,
      });
      const match = assertConfirmed(res?.match, "The saved match could not be confirmed");
      setToast({ message: "Match created — set the line-ups", tone: "ok" });
      router.push(`/matches/${match.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the match");
    } finally {
      setBusy(false);
    }
  };

  if (leagueLoading || teams.loading)
    return (
      <div className="mx-auto max-w-2xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );

  if (teamList.length < 2) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6 md:px-8">
        <PageHeader eyebrow={league?.name} title="New match" />
        <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
          <Swords className="mx-auto mb-4 h-6 w-6 text-green-dim" />
          <h2 className="text-2xl text-chalk">Two teams needed</h2>
          <p className="mx-auto mt-2 max-w-md text-[14.5px] leading-relaxed text-sage">
            This league has {teamList.length} team{teamList.length === 1 ? "" : "s"}. The League
            Leader must register at least two real teams before a match can be created.
          </p>
          <Button href="/players" className="mt-5">
            Manage teams & players <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow={`${league?.name} · ${league?.format}`}
        title="New real match"
        subtitle="Both sides field exactly the number of starters your league format requires."
      />

      <Panel className="p-5">
        <div className="space-y-4">
          {error && <ErrorNote message={error} />}

          <Field label="Match title">
            <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Tuesday night — Round 3" />
          </Field>

          <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
            <Field label="Team A">
              <Select value={teamA} onChange={(e) => setTeamA(e.target.value)}>
                <option value="">Select team</option>
                {teamList.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="hidden pb-3 text-center font-display text-[18px] font-bold text-green sm:block">V</div>
            <Field label="Team B">
              <Select value={teamB} onChange={(e) => setTeamB(e.target.value)}>
                <option value="">Select team</option>
                {teamList.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {teamA && teamA === teamB && (
            <p className="text-[13px] text-card-r">A team cannot play itself.</p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Kick-off">
              <TextInput type="datetime-local" value={kickOff} onChange={(e) => setKickOff(e.target.value)} />
            </Field>
            <Field label="Attach to fixture" hint="Optional">
              <Select value={fixtureId} onChange={(e) => setFixtureId(e.target.value)}>
                <option value="">No fixture</option>
                {(fixtures.data?.fixtures ?? []).map((f) => (
                  <option key={f.id} value={f.id}>
                    GW{f.gameweek} — {f.title}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Slate className="block pt-1">
            {league?.format} · {league?.starters} starters per side · {league?.subsCount} substitutes
          </Slate>

          <div className="flex justify-end gap-2.5 pt-1">
            <Button variant="ghost" href="/matches">
              Cancel
            </Button>
            <Button onClick={create} loading={busy} disabled={!valid}>
              Create match <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Panel>

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}
