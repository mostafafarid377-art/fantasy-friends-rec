"use client";
import { useState } from "react";
import { api } from "@/lib/client/api";
import { Button, ErrorNote, Field, Panel, Select, TextInput } from "./ui";

export type MatchStat = { playerId: string; saves: number; defensiveContributions: number; bonusRank: number | null; position: string };
type Participant = { id: string; name: string; position: string; team?: string };

export function MatchStatistics({ matchId, version, started, status, correctable, canManage, players, saved, workflowBusy, onDirty, onSaved }: {
  matchId: string; version: number; started: boolean; status: string; correctable: boolean; canManage: boolean;
  players: Participant[]; saved: MatchStat[]; workflowBusy: boolean; onDirty: (dirty: boolean) => void; onSaved: () => Promise<unknown>;
}) {
  const finalized = status === "approved";
  const [draft, setDraft] = useState(() => Object.fromEntries(saved.map((s) => [s.playerId, [String(s.saves), String(s.defensiveContributions)]])));
  const initialAwards = () => [1, 2, 3].map((rank) => saved.find((s) => s.bonusRank === rank)?.playerId ?? "");
  const [awards, setAwards] = useState(initialAwards);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = started && canManage && (status === "draft" || status === "rejected" || (finalized && correctable));
  const known = new Map(players.map((p) => [p.id, p]));
  const name = (p: Participant) => `${p.name} (${p.position}${p.team ? ` · ${p.team}` : ""})`;
  const selected = awards.filter(Boolean);
  const validAwards = finalized || !selected.length || (selected.length === 3 && new Set(selected).size === 3 && selected.every((id) => known.has(id)));
  const validCounts = players.every((p) => (draft[p.id] ?? []).every((n) => /^\d{0,3}$/.test(n)));
  const changed = (value: boolean) => { setDirty(value); onDirty(value); };
  const locked = busy || workflowBusy;
  const save = async () => {
    if (locked || !edit || !validAwards || !validCounts || (finalized && !reason.trim())) return;
    setBusy(true); setError(null);
    try {
      const stats = players.flatMap((p) => {
        const [saves = "0", defensiveContributions = "0"] = draft[p.id] ?? [];
        return Number(saves) || Number(defensiveContributions) ? [{ playerId: p.id, saves: Number(saves), defensiveContributions: Number(defensiveContributions) }] : [];
      });
      await api(`/api/matches/${matchId}/statistics`, { method: "PUT", body: {
        version, stats, ...(finalized ? { reason: reason.trim() } : { bonus: selected }),
      } });
      await onSaved();
      changed(false);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save match statistics"); }
    finally { setBusy(false); }
  };
  const update = (id: string, index: number, value: string) => {
    setDraft((old) => { const row = [...(old[id] ?? ["", ""])]; row[index] = value; return { ...old, [id]: row }; });
    changed(true);
  };
  const labels = ["1st: +3 points", "2nd: +2 points", "3rd: +1 point"];
  return <Panel className="mb-5 space-y-4 p-4">
    <details open={dirty || undefined}>
      <summary className="cursor-pointer text-lg text-chalk">Match statistics</summary>
      {!started && <p className="mt-2 text-sm text-sage">Statistics and bonus awards can be recorded after kickoff.</p>}
      {!players.length && started && <p className="mt-2 text-sm text-sage">No participants yet. Saved starters and players recorded as substituted on will appear here.</p>}
      {!edit && !!saved.length && <ul className="mt-2 space-y-1 text-sm text-sage">{saved.filter((s) => s.saves || s.defensiveContributions).map((s) => <li key={s.playerId}>{known.get(s.playerId)?.name ?? "Player"}: {s.saves} saves · {s.defensiveContributions} defensive contributions</li>)}</ul>}
      {edit && <div className="mt-3 grid gap-2 sm:grid-cols-2">{players.map((p) => <div key={p.id} className="rounded border border-line p-2">
        <p className="mb-1 text-sm text-chalk">{name(p)}</p>
        <div className={`grid gap-2 ${p.position === "GK" ? "grid-cols-2" : "grid-cols-1"}`}>
          {p.position === "GK" && <Field label="Saves"><TextInput aria-label={`${p.name} saves`} inputMode="numeric" maxLength={3} placeholder="0" value={draft[p.id]?.[0] ?? ""} disabled={locked} onChange={(e) => update(p.id, 0, e.target.value)} /></Field>}
          <Field label="Defensive contributions"><TextInput aria-label={`${p.name} defensive contributions`} inputMode="numeric" maxLength={3} placeholder="0" value={draft[p.id]?.[1] ?? ""} disabled={locked} onChange={(e) => update(p.id, 1, e.target.value)} /></Field>
        </div>
      </div>)}</div>}
    </details>
    <section aria-label="Match Bonus Points" className="space-y-2 border-t border-line pt-3">
      <h2 className="text-lg text-chalk">Match Bonus Points</h2>
      {edit && !finalized ? <div className="grid gap-2 sm:grid-cols-3">{labels.map((label, index) => <Field key={label} label={label}>
        <Select value={awards[index]} disabled={locked || !players.length} onChange={(e) => {
          setAwards(awards.map((id, i) => i === index ? e.target.value : id)); changed(true);
        }}>
          <option value="">Choose a player</option>
          {awards[index] && !known.has(awards[index]) && <option value={awards[index]}>No longer eligible</option>}
          {players.map((p) => <option key={p.id} disabled={awards.some((id, i) => i !== index && id === p.id)} value={p.id}>{name(p)}</option>)}
        </Select>
      </Field>)}</div> : <p className="text-sm text-sage">{selected.length ? labels.map((label, i) => `${label} · ${known.get(awards[i])?.name ?? "Player"}`).join(" / ") : "No bonus awards saved."}</p>}
      {!validAwards && <p className="text-sm text-card-y">Choose three different participants or clear all three awards.</p>}
    </section>
    {error && <ErrorNote message={error} />}
    {!validCounts && <p className="text-sm text-card-y">Use whole numbers from 0 to 999.</p>}
    {edit && finalized && dirty && <Field label="Statistics correction reason"><TextInput value={reason} maxLength={400} disabled={locked} onChange={(e) => setReason(e.target.value)} /></Field>}
    {edit && <div className="flex flex-wrap gap-2"><Button onClick={save} loading={busy} disabled={!dirty || locked || !validCounts || !validAwards || (finalized && !reason.trim())}>{finalized ? "Save statistics correction" : "Save statistics & bonuses"}</Button>
      {dirty && <Button variant="ghost" disabled={locked} onClick={() => { setDraft(Object.fromEntries(saved.map((s) => [s.playerId, [String(s.saves), String(s.defensiveContributions)]]))); setAwards(initialAwards()); setReason(""); setError(null); changed(false); }}>Discard changes</Button>}</div>}
  </Panel>;
}
