"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowLeftRight, ArrowUp, CalendarDays, ChevronRight, FlaskConical, History, Info, Lock, Pencil, Save, Unlock } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { Wordmark } from "@/components/Mark";
import { Pitch } from "@/components/Pitch";
import { fieldClass } from "@/components/SquadPicker";
import { Avatar, Badge, Button, Modal, Panel } from "@/components/ui";
import { orderedBench } from "@/lib/domain";
import type { SquadEntry } from "@/lib/squad";
import { changeSampleFormation, FORMAT, FORMATION_OPTIONS, PREVIOUS_SAVED_LINEUP, POSITION_LABEL, copySampleLineup, createSampleSquad, swapPlayers, type SampleDraft } from "./sample-lineup";

type View = "squad" | "next";
type Scenario = "new" | "existing";
type Edits = { draft: SampleDraft; saved: SampleDraft };
type Notice = { area: "pitch" | "bench" | "save"; message: string };
const DEMO_SECONDS = 109448; // 1 day, 6 hours, 24 minutes and 8 seconds in the sample scenario.
const DEMO_KICKOFF = "2026-11-21T20:00:00+02:00";
const SLOT_LABEL = { starter: "Starting lineup", sub: "Bench", reserve: "Reserve" };
const segment = "inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-center font-display text-sm font-bold uppercase leading-tight tracking-wide transition sm:px-3";
const segmentTone = (active: boolean) => active ? "bg-green text-pitch-950" : "text-chalk hover:bg-pitch-800 hover:text-green";
const priorityButton = "grid size-11 shrink-0 place-items-center rounded border border-line text-chalk hover:border-green disabled:opacity-35";

function DemoCountdown({ locked }: { locked: boolean }) {
  const [remaining, setRemaining] = useState(DEMO_SECONDS);
  useEffect(() => {
    // A relative sample clock only. It never decides if the lineup is locked.
    if (locked) return;
    const start = performance.now();
    const timer = window.setInterval(() => setRemaining(Math.max(0, DEMO_SECONDS - Math.floor((performance.now() - start) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, [locked]);
  const time = locked ? 0 : remaining;
  const units = [["Days", Math.floor(time / 86400)], ["Hours", Math.floor(time / 3600) % 24], ["Mins", Math.floor(time / 60) % 60], ["Secs", time % 60]] as const;
  return (
    <div>
      <p className="slate mb-2 text-sage">Sample countdown</p>
      <div role="timer" className="grid grid-cols-4 gap-1.5 sm:gap-2">
        {units.map(([unit, value]) => <div key={unit} className="rounded-md border border-line bg-pitch-950/75 px-1 py-2 text-center sm:min-w-15">
          <span className={`num block text-xl font-semibold leading-none sm:text-2xl ${locked ? "text-sage" : "text-green-glow"}`}>{String(value).padStart(2, "0")}</span>
          <span className="mt-1 block text-[10px] font-semibold uppercase tracking-wider text-sage">{unit}</span>
        </div>)}
      </div>
    </div>
  );
}

function PlayerPicker({ player, players, onPick, onClose }: { player: SquadEntry; players: SquadEntry[]; onPick: (p: SquadEntry) => void; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const candidates = players.filter((p) => p.position === player.position && p.id !== player.id && p.slot !== player.slot && p.name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(a.slot === "reserve") - Number(b.slot === "reserve") || a.name.localeCompare(b.name));
  return (
    <Modal open manageFocus title={`Replace ${player.name}`} onClose={onClose} width="max-w-md">
      <p className="mb-4 text-sm text-sage">Swap with another sample {POSITION_LABEL[player.position].toLowerCase()} to keep this formation.</p>
      <input type="search" aria-label="Search sample players" placeholder="Search sample players" className={`${fieldClass} w-full`} value={search} onChange={(event) => setSearch(event.target.value)} />
      <p className="my-2 text-xs text-sage" aria-live="polite">{candidates.length ? `${candidates.length} eligible sample ${candidates.length === 1 ? "player" : "players"}` : "No sample players match your search."}</p>
      <ul className="space-y-2">
        {candidates.map((p) => <li key={p.id}>
          <button type="button" className="flex w-full items-center gap-3 rounded-md border border-line bg-pitch-900 p-2.5 text-left hover:border-green" onClick={() => onPick(p)}>
            <Avatar name={p.name} size={34} decorative />
            <span className="min-w-0 grow"><span className="block text-sm font-semibold text-chalk">{p.name}</span><span className="block text-xs text-sage">{p.position} · {SLOT_LABEL[p.slot]}</span></span>
            <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-green-glow">Swap <ArrowLeftRight aria-hidden="true" className="size-3.5" /></span>
          </button>
        </li>)}
      </ul>
    </Modal>
  );
}

export function LineupPreview({ fromMySquad = false }: { fromMySquad?: boolean }) {
  const [scenario, setScenario] = useState<Scenario>("existing");
  const [view, setView] = useState<View>("squad");
  const [squad, setSquad] = useState<Edits>(() => {
    const initial = createSampleSquad();
    return { draft: initial, saved: initial };
  });
  const [nextMatch, setNextMatch] = useState<Edits | null>(null);
  const [simulatedLock, setSimulatedLock] = useState(false);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const previous = scenario === "existing" ? PREVIOUS_SAVED_LINEUP : null;
  const activeNext = view === "next" && previous ? nextMatch : null;
  const isNext = activeNext !== null;
  const locked = isNext && simulatedLock;
  const { draft, saved } = activeNext ?? squad;
  const dirty = draft !== saved;
  const starters = draft.players.filter((p) => p.slot === "starter");
  const bench = orderedBench(draft.players);
  const outfield = bench.filter((p) => p.position !== "GK");
  const target = locked ? undefined : draft.players.find((p) => p.id === targetId);
  const shape = FORMATION_OPTIONS.find((f) => f.label === draft.formation) ?? FORMATION_OPTIONS[0];

  function selectScenario(next: Scenario) {
    if (next === scenario) return;
    setScenario(next);
    const initial = createSampleSquad();
    setSquad({ draft: initial, saved: initial });
    setNextMatch(null);
    setSimulatedLock(false);
    show("squad");
  }
  function show(next: View) {
    if (next === "next") {
      if (!previous) return;
      if (!nextMatch) {
        const initial = copySampleLineup(previous);
        setNextMatch({ draft: initial, saved: initial });
      }
    }
    setView(next);
    setTargetId(null);
    setNotice(null);
  }
  function setEdits(edits: Edits) {
    if (isNext) setNextMatch(edits);
    else setSquad(edits);
  }
  function update(next: SampleDraft, message?: string, area: Notice["area"] = "pitch") {
    if (locked) return;
    setEdits({ draft: next, saved });
    setNotice(message ? { area, message } : null);
  }
  function simulate(lock: boolean) {
    setSimulatedLock(lock);
    setTargetId(null);
    setNotice(null);
  }
  function assign(role: "captainId" | "viceId", id: string) {
    if (id && (id === draft[role === "captainId" ? "viceId" : "captainId"] || !starters.some((p) => p.id === id))) return;
    update({ ...draft, [role]: id || null });
  }
  function shift(player: SquadEntry, delta: number) {
    const neighbor = outfield[outfield.indexOf(player) + delta];
    if (!neighbor) return;
    update(swapPlayers(draft, player, neighbor), `Moved ${player.name} to bench priority ${neighbor.order}.`, "bench");
  }
  function save() {
    if (locked) return;
    setEdits({ draft, saved: draft });
    setNotice({ area: "save", message: "Saved for this open preview only. Nothing was sent to a server." });
  }

  return (
    <>
      <header className="border-b border-line bg-pitch-900">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-3 md:px-8">
          <Wordmark />
          <Badge tone="info"><FlaskConical aria-hidden="true" className="size-3" /> Design preview</Badge>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-5 md:px-8 md:py-8">
        <Panel className="mb-5 flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
          <div className="flex items-start gap-2">
            <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-green" />
            <div><p className="text-xs font-semibold text-chalk">Preview scenario</p><p className="text-xs text-sage">Switching scenarios resets sample edits.</p></div>
          </div>
          <div role="group" aria-label="Preview scenario" className="grid w-full grid-cols-2 gap-1 rounded-md border border-line bg-pitch-950 p-1 sm:w-auto">
            <button type="button" aria-pressed={scenario === "new"} onClick={() => selectScenario("new")} className={`${segment} ${segmentTone(scenario === "new")}`}>New user</button>
            <button type="button" aria-pressed={scenario === "existing"} onClick={() => selectScenario("existing")} className={`${segment} ${segmentTone(scenario === "existing")}`}>Existing user</button>
          </div>
        </Panel>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-sage">{fromMySquad ? <Link href="/team" className="hover:text-green">My Squad</Link> : <span>My Squad</span>}<ChevronRight aria-hidden="true" className="size-3.5" /><span className="text-chalk">{isNext ? "Next Match" : "Edit Squad"}</span></div>
          <div role="group" aria-label="My Squad views" className={`grid w-full gap-1 rounded-lg border border-line bg-pitch-900 p-1 min-[440px]:w-auto ${previous ? "grid-cols-2" : "grid-cols-1"}`}>
            <button type="button" aria-pressed={!isNext} onClick={() => show("squad")} className={`${segment} ${segmentTone(!isNext)}`}><Pencil aria-hidden="true" className="size-4 shrink-0" />Edit Squad</button>
            {previous && <button type="button" aria-pressed={isNext} onClick={() => show("next")} className={`${segment} ${segmentTone(isNext)}`}><CalendarDays aria-hidden="true" className="size-4 shrink-0" />Next Match</button>}
          </div>
        </div>
        <PageHeader eyebrow="Sample league · 7v7 Fantasy" title={isNext ? "Next Match Lineup" : "Edit Squad"}
          subtitle={isNext ? "Your draft starts as a copy of the previous match’s saved lineup. Changes here don’t affect that lineup or your real team."
            : "Try the squad controls with sample players. Nothing here changes your real squad."} />

        {!previous && <Panel className="mb-5 flex items-start gap-3 border-green-dim/40 p-4">
          <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-green" />
          <div><h2 className="text-lg text-chalk">No previous lineup yet</h2><p className="mt-1 text-sm text-sage">Next Match appears after you have a saved starting lineup from a previous match. Until then, use Edit Squad. Saving sample squad edits here does not create a match record.</p></div>
        </Panel>}
        {previous && <Panel className="mb-5 p-4">
          <details>
            <summary className="cursor-pointer rounded text-sm font-semibold text-chalk"><History aria-hidden="true" className="mr-1.5 inline size-4 align-text-bottom text-green" />Previous saved lineup <span className="ml-1 text-xs font-normal text-sage">· Sample · Read-only</span></summary>
            <p className="mt-2 text-xs text-sage">Cairo Rovers vs Nile Athletic · 14 Nov 2026 · {previous.formation}</p>
            <ul aria-label="Previous saved starters" className="mt-2 grid gap-1 text-xs text-chalk sm:grid-cols-2">
              {previous.players.filter((p) => p.slot === "starter").map((p) => <li key={p.id}><span className="num mr-2 text-sage">{p.position}</span>{p.name}{p.id === previous.captainId ? " (C)" : p.id === previous.viceId ? " (VC)" : ""}</li>)}
            </ul>
          </details>
        </Panel>}
        {isNext ? (
          <Panel className="mb-5 overflow-hidden">
            <div className="floodlight grid items-center gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:p-5">
              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="slate text-sage">Upcoming sample fixture</span>
                  <Badge tone={locked ? "warn" : "live"}>{locked ? <Lock aria-hidden="true" className="size-3" /> : <Unlock aria-hidden="true" className="size-3" />}{locked ? "Locked" : "Editable"}</Badge>
                </div>
                <h2 className="text-2xl sm:text-3xl">Cairo Rovers <span className="px-0.5 text-green">vs</span> Giza United</h2>
                <p className="mt-2 flex items-start gap-2 text-sm text-sage"><CalendarDays aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-green" /><time dateTime={DEMO_KICKOFF}>Sat, 21 Nov 2026 · 8:00 PM (Cairo)</time></p>
              </div>
              <DemoCountdown key={String(locked)} locked={locked} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-pitch-900/70 p-3 sm:px-5">
              <div><p className="text-xs font-semibold text-chalk">Simulate kickoff</p><p className="mt-0.5 text-xs text-sage">Only this switch changes the lock state.</p></div>
              <div role="group" aria-label="Simulated deadline state" className="grid w-full grid-cols-2 gap-1 rounded-md border border-line bg-pitch-950 p-1 min-[480px]:w-auto">
                <button type="button" aria-pressed={!locked} onClick={() => simulate(false)} className={`${segment} ${segmentTone(!locked)}`}>Before kickoff</button>
                <button type="button" aria-pressed={locked} onClick={() => simulate(true)} className={`${segment} ${segmentTone(locked)}`}>After kickoff</button>
              </div>
            </div>
          </Panel>
        ) : (
          <Panel className="mb-5 flex flex-wrap items-center justify-between gap-2 p-4">
            <div><h2 className="text-xl text-chalk">Last match points</h2><p className="mt-1 text-sm text-sage">No scored matches in this sample league</p></div>
            <div><p className="num text-3xl font-bold text-green">—</p><p className="text-xs text-sage">Fantasy squad total</p></div>
          </Panel>
        )}
        {locked && <p role="status" className="mb-5 flex items-start gap-2 rounded-md border border-card-y/35 bg-card-y/5 p-3 text-sm text-chalk"><Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-card-y" /><span><strong>Simulated lock.</strong> Your preview lineup is read-only. Switch back to Before kickoff to continue editing the same draft.</span></p>}

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)] lg:gap-6">
          <section aria-label="Starting lineup" className="mx-auto w-full max-w-[520px] min-w-0 lg:max-w-none">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2"><h2 className="text-xl text-chalk">Starting lineup</h2><Badge tone="live">{starters.length}/7</Badge></div>
              <label className="flex items-center gap-2"><span className="text-xs font-semibold text-sage">Formation</span>
                <select className={`${fieldClass} min-h-11 disabled:opacity-65`} disabled={locked} value={shape.label} onChange={(event) => {
                  const next = changeSampleFormation(draft, event.target.value);
                  const roleCleared = next.captainId !== draft.captainId || next.viceId !== draft.viceId;
                  update(next, roleCleared ? "Formation updated. A player moved to the bench; choose a new captain or vice-captain." : "Formation updated using your sample bench.");
                }}>
                  {FORMATION_OPTIONS.map((f) => <option key={f.label}>{f.label}</option>)}
                </select>
              </label>
            </div>
            <Pitch players={draft.players} formation={shape} format={FORMAT} captainId={draft.captainId} viceCaptainId={draft.viceId} onSelect={locked ? undefined : setTargetId} />
            <p className="mt-2 text-xs text-sage">{locked ? "The starting seven stay visible after the simulated deadline." : "Tap a player on the pitch to open the sample player picker."}</p>
            <p role="status" className="mt-1 text-xs text-green-glow empty:hidden">{notice?.area === "pitch" ? notice.message : ""}</p>
          </section>

          <div className="mx-auto w-full max-w-[520px] min-w-0 space-y-4 lg:max-w-none">
            <Panel className="p-4">
              <h2 className="text-xl text-chalk">Captaincy</h2>
              <p className="mt-1 text-xs text-sage">Choose two different players from your starting seven.</p>
              <div className="mt-3 grid grid-cols-2 gap-2.5">
                {(["captainId", "viceId"] as const).map((role) => <label key={role} className="min-w-0">
                  <span className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-chalk">
                    <span aria-hidden="true" className={`num grid h-5 min-w-5 place-items-center rounded-full px-0.5 text-[9px] font-bold text-pitch-950 ${role === "captainId" ? "bg-card-y" : "bg-green-glow"}`}>{role === "captainId" ? "C" : "VC"}</span>{role === "captainId" ? "Captain" : "Vice-captain"}
                  </span>
                  <select disabled={locked} className={`${fieldClass} min-h-11 w-full px-2 disabled:opacity-65`} value={draft[role] ?? ""} onChange={(event) => assign(role, event.target.value)}>
                    <option value="">Not assigned</option>
                    {starters.map((p) => <option key={p.id} value={p.id} disabled={p.id === draft[role === "captainId" ? "viceId" : "captainId"]}>{p.name}</option>)}
                  </select>
                </label>)}
              </div>
            </Panel>

            <Panel className="p-4">
              <div className="flex items-center gap-2"><h2 className="text-xl text-chalk">Substitutes</h2><Badge>{bench.length}/4</Badge></div>
              <p className="mt-1 text-xs text-sage">The keeper is fixed. Use the arrows to set outfield bench order.</p>
              <ol aria-label="Bench order" className="mt-3 space-y-1.5">
                {bench.map((p) => {
                  const keeper = p.position === "GK";
                  const row = <>
                    <span className="num w-5 shrink-0 text-center text-[11px] font-semibold text-green">{keeper ? "GK" : p.order}</span>
                    <Avatar name={p.name} size={28} decorative />
                    <span className="min-w-0 grow break-words text-sm font-semibold text-chalk">{p.name}</span>
                    <span className="num shrink-0 rounded border border-line px-1 py-0.5 text-[9px] text-sage">{p.position}</span>
                  </>;
                  const rowClass = "flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded border border-line bg-pitch-900 px-1.5 py-1 text-left sm:gap-2 sm:px-2";
                  return <li key={p.id} className="flex items-center gap-1">
                    {locked ? <div className={rowClass}>{row}</div> : <button type="button" className={`${rowClass} hover:border-green`} aria-label={`Replace ${p.name}, ${keeper ? "bench goalkeeper" : `bench priority ${p.order}`}`} onClick={() => setTargetId(p.id)}>{row}</button>}
                    {!keeper && <>
                      <button type="button" className={priorityButton} disabled={locked || p.order === 1} aria-label={`Raise ${p.name} priority`} onClick={() => shift(p, -1)}><ArrowUp aria-hidden="true" className="size-4" /></button>
                      <button type="button" className={priorityButton} disabled={locked || p.order === outfield.length} aria-label={`Lower ${p.name} priority`} onClick={() => shift(p, 1)}><ArrowDown aria-hidden="true" className="size-4" /></button>
                    </>}
                  </li>;
                })}
              </ol>
              <p role="status" className="mt-2 text-xs text-green-glow empty:hidden">{notice?.area === "bench" ? notice.message : ""}</p>
            </Panel>

            <Panel className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><p className="text-sm font-semibold text-chalk">{locked ? "Read-only preview" : dirty ? "Unsaved preview changes" : "No unsaved changes"}</p><p className="mt-0.5 text-xs text-sage">Reloading resets the demo.</p></div>
                <Button disabled={locked} variant={locked ? "outline" : "primary"} className="min-h-11 w-full min-[420px]:w-auto" onClick={save}>{locked ? <Lock aria-hidden="true" className="size-4" /> : <Save aria-hidden="true" className="size-4" />}Save changes</Button>
              </div>
              <p role="status" className="mt-2 text-xs text-green-glow empty:hidden">{notice?.area === "save" ? notice.message : ""}</p>
            </Panel>
          </div>
        </div>
        {target && <PlayerPicker key={target.id} player={target} players={draft.players} onClose={() => setTargetId(null)} onPick={(player) => {
          const next = swapPlayers(draft, target, player);
          const roleCleared = next.captainId !== draft.captainId || next.viceId !== draft.viceId;
          update(next, `${player.name} swapped with ${target.name}.${roleCleared ? " Choose a new captain or vice-captain." : ""}`, target.slot === "sub" ? "bench" : "pitch");
          setTargetId(null);
        }} />}
      </main>
    </>
  );
}
