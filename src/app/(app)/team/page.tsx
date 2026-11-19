"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  ChevronRight,
  Crown,
  Save,
  Sparkles,
} from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { Pitch, type PitchPlayer } from "@/components/Pitch";
import { Badge, Button, EmptyState, ErrorNote, Panel, Select, Skeleton, Slate, Toast } from "@/components/ui";
import { useActiveLeague, useLeague } from "@/components/LeagueContext";
import { api, useApi } from "@/lib/client/api";
import {
  applySubstitution,
  FORMATIONS,
  suggestFormation,
  validateSquad,
  type LeagueFormat,
  type LeagueRules,
  type SquadPlayer,
} from "@/lib/domain";

type SquadResponse = {
  squad: { id: string; formation: string; captainId: string | null; viceCaptainId: string | null } | null;
  rules: LeagueRules;
  vicePolicy: string;
  players: {
    playerId: string;
    slot: "starter" | "sub" | "reserve";
    order: number;
    fullName: string;
    position: SquadPlayer["position"];
    photoUrl: string | null;
    shirtNumber: number | null;
    availability: string;
    status: string;
  }[];
};

export default function TeamPage() {
  const { league, loading: leagueLoading } = useActiveLeague();
  const { isLeader } = useLeague();
  const router = useRouter();
  const { data, loading, error, reload, setData } = useApi<SquadResponse>(
    league ? `/api/leagues/${league.id}/squad` : null,
    [league?.id],
  );

  const [players, setPlayers] = useState<SquadPlayer[]>([]);
  const [formation, setFormation] = useState("1-2-1");
  const [captainId, setCaptainId] = useState<string | null>(null);
  const [viceId, setViceId] = useState<string | null>(null);
  const [pendingSub, setPendingSub] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);

  useEffect(() => {
    if (!data) return;
    setPlayers(
      data.players.map((p) => ({
        id: p.playerId,
        position: p.position,
        slot: p.slot,
        order: p.order,
        name: p.fullName,
        photoUrl: p.photoUrl,
        shirtNumber: p.shirtNumber,
        availability: p.availability,
      })) as PitchPlayer[],
    );
    setFormation(data.squad?.formation ?? "");
    setCaptainId(data.squad?.captainId ?? null);
    setViceId(data.squad?.viceCaptainId ?? null);
    setDirty(false);
  }, [data]);

  const rules = data?.rules;
  const complete = players.length === (rules?.squadSize ?? 15);

  const validation = useMemo(() => {
    if (!rules || !complete) return { ok: true, errors: [] as string[] };
    return validateSquad(rules, players, { formation, captainId, viceId });
  }, [rules, players, formation, captainId, viceId, complete]);

  const starters = useMemo(() => players.filter((p) => p.slot === "starter"), [players]);
  const bench = useMemo(() => players.filter((p) => p.slot === "sub"), [players]);
  const reserves = useMemo(() => players.filter((p) => p.slot === "reserve"), [players]);

  const selectedPlayer = players.find((p) => p.id === selected) ?? null;
  const pendingPlayer = players.find((p) => p.id === pendingSub) ?? null;

  const touch = () => setDirty(true);

  /** Guided substitution: swap a starter for a bench player, then the
   *  formation recalculates and the pitch physically re-forms. */
  const swap = (starterId: string) => {
    if (!rules || !pendingSub) return;
    const result = applySubstitution(rules, players, starterId, pendingSub);
    if ("error" in result) {
      setToast({ message: result.error, tone: "error" });
      setPendingSub(null);
      return;
    }
    setPlayers(result.players);
    setFormation(result.formation);
    setPendingSub(null);
    setSelected(null);
    touch();
    setToast({ message: `Line-up reshaped to ${result.formation}`, tone: "ok" });
  };

  const changeFormation = (label: string) => {
    setFormation(label);
    touch();
  };

  const autoPickShape = () => {
    const outfield = players.filter((p) => p.slot === "starter" && p.position !== "GK");
    const best = suggestFormation(outfield, (rules?.format ?? "5v5") as LeagueFormat, formation);
    setFormation(best.label);
    touch();
    setToast({ message: `Formation set to ${best.label}`, tone: "ok" });
  };

  const assign = (id: string, role: "captain" | "vice" | "clear-captain" | "clear-vice") => {
    if (role === "captain") {
      setCaptainId(id);
      if (viceId === id) setViceId(null);
    } else if (role === "vice") {
      setViceId(id);
      if (captainId === id) setCaptainId(null);
    } else if (role === "clear-captain") setCaptainId(null);
    else setViceId(null);
    touch();
  };

  const save = async () => {
    if (!league || !rules) return;
    setSaving(true);
    try {
      const entries = players.map((p) => ({ playerId: p.id, slot: p.slot, order: p.order }));
      await api(`/api/leagues/${league.id}/squad`, {
        method: "PUT",
        body: { formation, captainId, viceCaptainId: viceId, entries },
        idempotent: true,
      });
      setDirty(false);
      setToast({ message: "Squad saved", tone: "ok" });
      reload();
    } catch (err) {
      const details = (err as { details?: unknown }).details;
      const list = Array.isArray(details)
        ? details.join(" ")
        : err instanceof Error
          ? err.message
          : "Could not save";
      setToast({ message: list, tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  if (leagueLoading || (loading && !data)) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
          <Skeleton className="aspect-[3/4] rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
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

  if (!league || !rules) return null;

  if (!data?.squad || players.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 md:px-8">
        <PageHeader eyebrow={league.name} title="Build your squad" />
        <EmptyState
          title={`Every manager owns exactly ${rules.squadSize} players`}
          body={`Pick from your league's own player database, then name ${rules.starters} starters and ${rules.subsCount} substitutes for the ${rules.format} format.`}
          action={{ label: "Start picking", href: "/team/pick" }}
          icon={<Sparkles className="h-5 w-5" />}
        />
      </div>
    );
  }

  const allowedFormations = FORMATIONS[rules.format as LeagueFormat] ?? [];

  return (
    <div className="mx-auto max-w-[1240px] px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow={`${league.name} · ${rules.format} · ${rules.starters} starters`}
        title="My team"
        subtitle="Drag the shape into line, guide your substitutions and confirm your captain."
        actions={
          <>
            <Button href="/team/pick" variant="outline">
              Edit squad list
            </Button>
            <Button onClick={save} loading={saving} disabled={!dirty || !validation.ok}>
              <Save className="h-4 w-4" /> Save
            </Button>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        {/* ------------- pitch ------------- */}
        <div className="relative">
          <Pitch
            players={players as PitchPlayer[]}
            formation={formation}
            format={rules.format as LeagueFormat}
            captainId={captainId}
            viceCaptainId={viceId}
            selectedId={pendingSub ? null : selected}
            benchId={pendingSub}
            onSelect={(id) => {
              if (pendingSub) swap(id);
              else setSelected((cur) => (cur === id ? null : id));
            }}
          />

          {pendingSub && (
            <div className="mt-3 flex items-center gap-3 rounded-lg border border-card-y/45 bg-card-y/10 px-4 py-3">
              <ArrowLeftRight className="h-4 w-4 shrink-0 text-card-y" />
              <span className="flex-1 text-[13.5px] text-chalk">
                Bring on <strong className="text-card-y">{pendingPlayer?.name}</strong> — choose the
                starter to replace. The formation recalculates automatically.
              </span>
              <button onClick={() => setPendingSub(null)} className="slate text-card-y hover:text-chalk">
                Cancel
              </button>
            </div>
          )}

          <div className="mt-3 grid grid-cols-3 gap-2">
            <MiniStat label="Starters" value={`${starters.length}/${rules.starters}`} ok={starters.length === rules.starters} />
            <MiniStat label="Subs" value={`${bench.length}/${rules.subsCount}`} ok={bench.length === rules.subsCount} />
            <MiniStat label="Squad" value={`${players.length}/${rules.squadSize}`} ok={players.length === rules.squadSize} />
          </div>
        </div>

        {/* ------------- controls ------------- */}
        <div className="space-y-4">
          {/* formation */}
          <Panel className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <Slate>Formation</Slate>
              <button
                onClick={autoPickShape}
                className="flex items-center gap-1.5 text-[12.5px] text-sage transition-colors hover:text-green"
              >
                <Sparkles className="h-3.5 w-3.5" /> Auto shape
              </button>
            </div>
            <div className="flex items-center gap-3">
              <div className="num text-4xl font-semibold text-green">{formation}</div>
              <div className="flex-1">
                <Select value={formation} onChange={(e) => changeFormation(e.target.value)}>
                  {allowedFormations.map((f) => (
                    <option key={f.label} value={f.label}>
                      {f.label}
                      {f.label === formation ? "  ◂ current" : ""}
                    </option>
                  ))}
                </Select>
                <p className="mt-2 text-[12px] leading-relaxed text-sage-dim">
                  The goalkeeper is always included and never counts as an outfield position.
                </p>
              </div>
            </div>
          </Panel>

          {/* selected player actions */}
          <Panel className="p-4">
            <Slate>Line-up actions</Slate>
            {!selectedPlayer ? (
              <p className="mt-3 text-[13.5px] leading-relaxed text-sage">
                Tap a player on the pitch to make them captain or vice-captain, or use{" "}
                <span className="text-chalk">Bring on</span> next to a substitute to run a guided
                substitution.
              </p>
            ) : (
              <div className="mt-3">
                <div className="flex items-center gap-3">
                  <span className="num flex h-10 w-10 items-center justify-center rounded-full border border-green-dim bg-pitch-900 text-[13px] text-green-glow">
                    {selectedPlayer.position}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[16px] font-semibold text-chalk">
                      {selectedPlayer.name}
                    </div>
                    <div className="slate">
                      {selectedPlayer.slot === "starter" ? "Starting" : selectedPlayer.slot === "sub" ? "Substitute" : "Reserve"}
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {captainId === selectedPlayer.id ? (
                    <Button size="sm" variant="outline" onClick={() => assign(selectedPlayer.id, "clear-captain")}>
                      <CheckCircle2 className="h-3.5 w-3.5" /> Captain — remove
                    </Button>
                  ) : (
                    <Button size="sm" variant="quiet" onClick={() => assign(selectedPlayer.id, "captain")}>
                      <Crown className="h-3.5 w-3.5" /> Make captain
                    </Button>
                  )}
                  {viceId === selectedPlayer.id ? (
                    <Button size="sm" variant="outline" onClick={() => assign(selectedPlayer.id, "clear-vice")}>
                      <CheckCircle2 className="h-3.5 w-3.5" /> Vice — remove
                    </Button>
                  ) : (
                    <Button size="sm" variant="quiet" onClick={() => assign(selectedPlayer.id, "vice")}>
                      Make vice-captain
                    </Button>
                  )}
                </div>
              </div>
            )}
          </Panel>

          {/* bench */}
          <Panel className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <Slate>Substitutes ({bench.length}/{rules.subsCount})</Slate>
            </div>
            <ul className="space-y-1.5">
              {bench.map((p) => (
                <li
                  key={p.id}
                  className={`flex items-center gap-3 rounded-md border px-3 py-2 transition-colors ${
                    pendingSub === p.id ? "border-card-y bg-card-y/10" : "border-line hover:border-green-dim"
                  }`}
                >
                  <span className="num w-9 text-[11px] text-green-glow/80">{p.position}</span>
                  <span className="min-w-0 flex-1 truncate text-[14px] text-chalk">{p.name}</span>
                  <button
                    onClick={() => setPendingSub((cur) => (cur === p.id ? null : p.id))}
                    className="flex items-center gap-1.5 rounded border border-line px-2 py-1 text-[11.5px] font-semibold uppercase tracking-[0.1em] text-sage transition-colors hover:border-card-y hover:text-card-y"
                  >
                    <ArrowLeftRight className="h-3.5 w-3.5" /> Bring on
                  </button>
                </li>
              ))}
              {bench.length === 0 && (
                <li className="text-[13.5px] text-sage-dim">No substitutes selected.</li>
              )}
            </ul>

            {reserves.length > 0 && (
              <div className="mt-4 border-t border-line pt-3">
                <Slate>Reserves ({reserves.length})</Slate>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {reserves.map((p) => (
                    <span
                      key={p.id}
                      className="rounded border border-line bg-pitch-900 px-2 py-1 text-[12px] text-sage"
                    >
                      {p.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </Panel>

          {/* validation */}
          {!validation.ok && (
            <div className="rounded-lg border border-card-r/40 bg-card-r/10 p-4">
              <div className="mb-2 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-card-r" />
                <Slate className="text-card-r">Line-up cannot be saved yet</Slate>
              </div>
              <ul className="space-y-1 text-[13.5px] text-chalk">
                {validation.errors.map((e) => (
                  <li key={e}>• {e}</li>
                ))}
              </ul>
            </div>
          )}

          {!isLeader && (
            <p className="text-[12.5px] text-sage-dim">
              Scoring rules for this league are managed by the League Leader.
            </p>
          )}

          {!complete && (
            <div className="rounded-lg border border-card-y/40 bg-card-y/8 p-4 text-[13.5px] text-chalk">
              Your squad is still a draft ({players.length}/{rules.squadSize}).{" "}
              <Link href="/team/pick" className="text-green underline underline-offset-4">
                Finish picking
              </Link>{" "}
              — captaincy and exact counts are enforced once all {rules.squadSize} players are in.
            </div>
          )}
        </div>
      </div>

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}

function MiniStat({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className={`panel rounded-lg px-3 py-2.5 ${ok ? "border-green/40" : ""}`}>
      <div className="slate">{label}</div>
      <div className={`num mt-1 text-[17px] font-semibold ${ok ? "text-green" : "text-chalk"}`}>{value}</div>
    </div>
  );
}
