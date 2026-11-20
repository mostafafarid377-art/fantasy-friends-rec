"use client";
import { useState } from "react";
import { api } from "@/lib/client/api";
import { Button, ErrorNote, Field, Panel, TextInput } from "./ui";

export type MatchStat = { playerId: string; saves: number; defensiveContributions: number; position: string };
export type MatchBonusAward = { playerId: string; rank: number | null; points: number };
type Participant = { id: string; name: string; position: string; team?: string };

export function MatchStatistics({ matchId, version, started, status, correctable, canManage, players, saved, bonusAwards = [], workflowBusy, onDirty, onSaved }: {
  matchId: string; version: number; started: boolean; status: string; correctable: boolean; canManage: boolean;
  players: Participant[]; saved: MatchStat[]; bonusAwards?: MatchBonusAward[]; workflowBusy: boolean; onDirty: (dirty: boolean) => void; onSaved: () => Promise<unknown>;
}) {
  const finalized = status === "approved";
  const [draft, setDraft] = useState(() => Object.fromEntries(saved.map((s) => [s.playerId, [String(s.saves), String(s.defensiveContributions)]])));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = started && canManage && (status === "draft" || status === "rejected" || (finalized && correctable));
  const known = new Map(players.map((p) => [p.id, p]));
  const name = (p: Participant) => `${p.name} (${p.position}${p.team ? ` · ${p.team}` : ""})`;
  const validCounts = players.every((p) => (draft[p.id] ?? []).every((n) => /^\d{0,3}$/.test(n)));
  const changed = (value: boolean) => { setDirty(value); onDirty(value); };
  const locked = busy || workflowBusy;
  const save = async () => {
    if (locked || !edit || !validCounts || (finalized && !reason.trim())) return;
    setBusy(true); setError(null);
    try {
      const stats = players.flatMap((p) => {
        const [saves = "0", defensiveContributions = "0"] = draft[p.id] ?? [];
        return Number(saves) || Number(defensiveContributions) ? [{ playerId: p.id, saves: Number(saves), defensiveContributions: Number(defensiveContributions) }] : [];
      });
      await api(`/api/matches/${matchId}/statistics`, { method: "PUT", body: {
        version, stats, ...(finalized ? { reason: reason.trim() } : {}),
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
  return <Panel className="mb-5 space-y-4 p-4">
    <details open={dirty || undefined}>
      <summary className="cursor-pointer text-lg text-chalk">Match statistics</summary>
      {!started && <p className="mt-2 text-sm text-sage">Statistics can be recorded after kickoff.</p>}
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
    {finalized && <section aria-label="Match Bonus Points" className="space-y-2 border-t border-line pt-3">
      <h2 className="text-lg text-chalk">Match Bonus Points</h2>
      {bonusAwards.length ? <ul className="space-y-1 text-sm text-chalk">
        {bonusAwards.map((award) => <li key={award.playerId} className="flex flex-wrap justify-between gap-x-3">
          <span>{award.rank == null ? "Historical award" : `Rank ${award.rank}`} · {known.get(award.playerId)?.name ?? "Player"}</span>
          <span className="num text-green">+{award.points} pts</span>
        </li>)}
      </ul> : <p className="text-sm text-sage">No bonus awards in the finalized result.</p>}
    </section>}
    {error && <ErrorNote message={error} />}
    {!validCounts && <p className="text-sm text-card-y">Use whole numbers from 0 to 999.</p>}
    {edit && finalized && dirty && <Field label="Statistics correction reason"><TextInput value={reason} maxLength={400} disabled={locked} onChange={(e) => setReason(e.target.value)} /></Field>}
    {edit && <div className="flex flex-wrap gap-2"><Button onClick={save} loading={busy} disabled={!dirty || locked || !validCounts || (finalized && !reason.trim())}>{finalized ? "Save statistics correction" : "Save statistics"}</Button>
      {dirty && <Button variant="ghost" disabled={locked} onClick={() => { setDraft(Object.fromEntries(saved.map((s) => [s.playerId, [String(s.saves), String(s.defensiveContributions)]]))); setReason(""); setError(null); changed(false); }}>Discard changes</Button>}</div>}
  </Panel>;
}
