"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, CalendarDays, Lock, Pencil, Save, Unlock } from "lucide-react";
import { PageHeader } from "./AppShell";
import { Pitch } from "./Pitch";
import { useLatestPlayerGames } from "./PlayerPerformance";
import { fieldClass, SquadPicker } from "./SquadPicker";
import { Avatar, Badge, Button, ErrorNote, Modal, Panel } from "./ui";
import { api, ApiRequestError, useApi } from "@/lib/client/api";
import { useKickoffClock } from "@/lib/match-deadline";
import { canSelectPlayer, findFormation, FORMATIONS, layoutFormation, normalizeBench, OUTFIELD, orderedBench, validateMatchLineup, type LeagueRules } from "@/lib/domain";
import { lineupEntries, lineupForFormation, matchLineupFormations, swapLineupPlayers, withLineupPlayers, type MatchLineup, type NextMatchLineup, type SavedMatchLineup } from "@/lib/next-match-lineup";
import type { PlayerPool, PoolPlayer, SquadEntry } from "@/lib/squad";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const arrowClass = "grid size-11 shrink-0 place-items-center rounded border border-line text-chalk hover:border-green disabled:opacity-35";

type Props = {
  leagueId: string; leagueName: string; rules: LeagueRules; data: NextMatchLineup; fallback: MatchLineup;
  onBack: () => void; refresh: () => Promise<void>; route: string; loadError: string | null;
};

export function NextMatchLineupScreen(props: Props) {
  const { data } = props;
  // One lineup only: the next match's. When the current fixture has started it
  // is already on My Team, so this screen leads with the prepared lineup.
  const preparing = Boolean(data.match?.locked && data.canPrepare);
  return <LineupEditor {...props} key={preparing ? "preparation" : "fixture"}
    data={preparing ? { ...data, match: null, saved: data.preparation ?? null } : data} />;
}

function LineupEditor({ leagueId, leagueName, rules, data, fallback, onBack, refresh, route, loadError }: Props) {
  const [edit, setEdit] = useState<{ lineup: MatchLineup; revision: string | null } | null>(null);
  const [confirmed, setConfirmed] = useState<SavedMatchLineup | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [benchAdd, setBenchAdd] = useState<"GK" | "outfield" | null>(null);
  const [poolOpen, setPoolOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const { previous, match } = data;
  const preparing = !match && Boolean(data.canPrepare);
  const targetMatchId = match?.id ?? null;
  const remaining = useKickoffClock(data.serverNow, match?.kickOff);
  const locked = Boolean(match?.locked || remaining === 0);
  const needsDeadlineRefresh = match?.locked === false && remaining === 0;
  useEffect(() => { if (needsDeadlineRefresh) void refresh(); }, [needsDeadlineRefresh, refresh]);
  // A confirmed response may arrive while GET still contains the earlier value.
  const saved = confirmed && (!data.saved || confirmed.revision >= data.saved.revision) ? confirmed : data.saved;
  const lineup = ((locked ? null : edit?.lineup) ?? saved?.lineup ?? (locked ? fallback : previous?.lineup)) ?? fallback;
  const revision = edit ? edit.revision : saved?.revision ?? null;
  const shape = findFormation(lineup.formation, rules.format) ?? FORMATIONS[rules.format][0];
  const starters = lineup.players.filter((p) => p.slot === "starter");
  const scores = useLatestPlayerGames(leagueId, match ? starters : [], match?.id);
  const bench = orderedBench(lineup.players);
  const outfield = bench.filter((p) => p.position !== "GK");
  const placed = new Set(layoutFormation(lineup.players, shape).map((p) => p.playerId));
  const unplaced = starters.filter((p) => !placed.has(p.id));
  const target = !locked && !saving ? lineup.players.find((p) => p.id === targetId) : undefined;
  // A match lineup is always played, so it always names its captaincy.
  const validation = validateMatchLineup(rules, lineup.players, { formation: shape.label, captainId: lineup.captainId, viceId: lineup.viceId });
  const unavailable = lineup.players.filter((p) => p.status !== "active");
  const adding = !locked && !saving ? benchAdd : null;
  const pool = useApi<PlayerPool>((target && poolOpen) || adding ? `/api/leagues/${leagueId}/players?archived=1` : null);
  const availableSwaps = target ? lineup.players.filter((p) => p.slot !== target.slot && canSelectPlayer(p) && p.position === target.position) : [];

  function update(next: MatchLineup) {
    if (locked || saving) return;
    setEdit({ lineup: next, revision });
    setNotice(null);
    if (!conflict) setMessage(null);
  }
  function closePicker() { setTargetId(null); setPoolOpen(false); setBenchAdd(null); }
  function addSubstitute(player: PoolPlayer) {
    if (!adding || !canSelectPlayer(player) || bench.length >= rules.subsCount || lineup.players.length >= rules.squadSize
      || lineup.players.some((p) => p.id === player.id) || (adding === "GK" ? player.position !== "GK" || bench.some((p) => p.position === "GK")
        : player.position === "GK" || outfield.length >= rules.subsCount - 1)) return;
    update(withLineupPlayers(lineup, normalizeBench([...lineup.players, { ...player, name: player.fullName,
      slot: "sub", order: player.position === "GK" ? 0 : outfield.length + 1 }])));
    closePicker();
  }
  function replace(player: PoolPlayer) {
    if (!target || !canSelectPlayer(player) || player.position !== target.position || lineup.players.some((p) => p.id === player.id)) return;
    update(withLineupPlayers(lineup, lineup.players.map((p) => p.id === target.id
      ? { ...player, name: player.fullName, slot: p.slot, order: p.order } : p)));
    closePicker();
  }
  async function save() {
    // A manager without an official lineup to inherit prepares the next
    // fixture from their own saved squad. The editor and the resolver read
    // the same sources in the same order.
    if ((!match && !preparing) || locked || saving || conflict || loadError || !validation.ok || unavailable.length || starters.length !== rules.starters) return;
    setSaving(true); setMessage(null); setNotice(null);
    try {
      const normalized = normalizeBench(lineup.players);
      const result = await api<SavedMatchLineup & { matchId: string | null }>(route, { method: "PUT", body: {
        matchId: targetMatchId, formation: shape.label, captainId: lineup.captainId, viceId: lineup.viceId,
        expectedUpdatedAt: revision, entries: lineupEntries(normalized),
      } });
      if (result.matchId !== targetMatchId || !result.revision || !result.lineup) throw new ApiRequestError("Save could not be confirmed. Reload before retrying.", 409);
      const byId = new Map(normalized.map((p) => [p.id, p]));
      setConfirmed({ revision: result.revision, lineup: { ...result.lineup, players: result.lineup.players.map((p) => ({ ...byId.get(p.id)!, ...p })) } });
      setEdit(null);
      setNotice(preparing ? "Lineup prepared. My Squad is unchanged." : "Lineup saved for this match only.");
      void refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save the match lineup.");
      setConflict(err instanceof ApiRequestError && (err.status === 409 || err.status === 0));
      void refresh();
    } finally { setSaving(false); }
  }

  return <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
    <PageHeader eyebrow={`${leagueName} · ${rules.format} fantasy`} title="Next Match Lineup"
      subtitle={preparing ? "Prepare your next lineup without changing your current saved squad."
        : "This lineup is separate from Edit Squad. Until you save it, the match uses your current saved squad."}
      actions={<><Button variant="outline" onClick={onBack}><Pencil aria-hidden="true" className="size-4" />Edit Squad</Button><Button disabled><CalendarDays aria-hidden="true" className="size-4" />Next Match</Button></>} />
    {loadError && <div className="mb-4"><ErrorNote message={loadError} onRetry={() => void refresh()} /></div>}
    {!match && <Panel className="floodlight mb-5 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2"><h2 className="text-xl">No next match scheduled</h2>{preparing && <Badge tone="live">Editable</Badge>}</div>
      <p className="mt-2 text-sm text-sage">{preparing
        ? "Save your lineup now. It will be applied when a match with a future kickoff is created in this league. Your current squad and previous lineups won’t change."
        : "When a match is scheduled, you can prepare its lineup here."}</p>
    </Panel>}
    {(match || preparing) && <>
      {match && <Panel className="floodlight mb-5 flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2"><span className="slate text-sage">Next fixture</span><Badge tone={locked ? "warn" : "live"}>{locked ? <Lock aria-hidden="true" className="size-3" /> : <Unlock aria-hidden="true" className="size-3" />}{locked ? "Locked" : "Editable"}</Badge></div>
          <h2 className="break-words text-2xl sm:text-3xl">{match.title}</h2>
          <p className="mt-2 text-sm text-sage"><time dateTime={match.kickOff}>{dateTime.format(new Date(match.kickOff))}</time></p>
        </div>
        <div className="w-full sm:w-auto"><p className="slate mb-2 text-sage">{locked ? "Lineup deadline" : "Time until kickoff"}</p>
          {locked ? <p className="num text-2xl font-semibold text-sage">Closed</p> : <KickoffCountdown remaining={remaining} />}
        </div>
      </Panel>}
      {locked && <p role="status" className="mb-4 rounded border border-card-y/35 bg-card-y/5 p-3 text-sm">{saved ? "This match’s saved lineup is locked." : "No match-specific lineup was saved. This match uses your current saved squad."}</p>}
      {message && <div className="mb-4" role="alert"><ErrorNote message={message} />{conflict && <Button variant="outline" className="mt-2" onClick={async () => {
        await refresh(); setEdit(null); setConfirmed(null); setConflict(false); setMessage(null);
      }}>Reload lineup</Button>}</div>}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)] lg:gap-6">
        <section aria-label={preparing ? "Next match starters" : "Starting lineup"} className="mx-auto w-full max-w-[520px] min-w-0 lg:max-w-none">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2"><h2 className="text-xl">{preparing ? "Next match starters" : "Starting lineup"}</h2><Badge tone="live">{starters.length}/{rules.starters}</Badge></div>
            <label className="flex items-center gap-2"><span className="text-xs font-semibold text-sage">Formation</span>
              <select className={fieldClass} value={shape.label} disabled={locked || saving} onChange={(e) => {
                const formation = findFormation(e.target.value, rules.format);
                const next = formation && lineupForFormation(lineup, formation);
                if (next) update(next);
              }}>{(locked ? [shape] : matchLineupFormations(lineup, rules.format)).map((f) => <option key={f.label}>{f.label}</option>)}</select>
            </label>
          </div>
          <Pitch players={lineup.players} formation={shape} format={rules.format} captainId={lineup.captainId} viceCaptainId={lineup.viceId} onSelect={locked ? undefined : setTargetId} disabled={saving} latest={scores.data ?? undefined} />
          {!locked && <p className="mt-2 text-xs text-sage">Tap a player to swap or replace them. Formation changes use available players on your bench.</p>}
          {!locked && unplaced.length > 0 && <Panel className="mt-3 p-3"><p className="mb-2 text-sm text-card-y">Some starters do not fit the formation.</p>{unplaced.map((p) => <Button key={p.id} variant="outline" onClick={() => setTargetId(p.id)} disabled={saving}>{p.name} · {p.position}</Button>)}</Panel>}
        </section>
        <div className="mx-auto w-full max-w-[520px] min-w-0 space-y-4 lg:max-w-none">
          <Panel className="p-4">
            <h2 className="text-xl">Captaincy</h2>
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              {(["captainId", "viceId"] as const).map((role) => <label key={role} className="min-w-0">
                <span className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold"><span aria-hidden="true" className={`num grid h-5 min-w-5 place-items-center rounded-full text-[9px] font-bold text-pitch-950 ${role === "captainId" ? "bg-card-y" : "bg-green-glow"}`}>{role === "captainId" ? "C" : "VC"}</span>{role === "captainId" ? "Captain" : "Vice-captain"}</span>
                <select className={`${fieldClass} min-h-11 w-full px-2`} value={lineup[role] ?? ""} disabled={locked || saving} onChange={(e) => update({ ...lineup, [role]: e.target.value || null })}>
                  <option value="">Not assigned</option>
                  {starters.map((p) => <option key={p.id} value={p.id} disabled={p.id === lineup[role === "captainId" ? "viceId" : "captainId"]}>{p.name}</option>)}
                </select>
              </label>)}
            </div>
          </Panel>
          <Panel className="p-4">
            <div className="flex items-center gap-2"><h2 className="text-xl">Substitutes</h2><Badge>{bench.length}/{rules.subsCount}</Badge></div>
            {bench.length === 0 ? <p className="mt-2 text-sm text-sage">No substitutes in this lineup.</p> : <ol aria-label="Bench order" className="mt-3 space-y-1.5">
              {bench.map((p) => {
                const keeper = p.position === "GK";
                const row = <><span className="num w-5 shrink-0 text-center text-[11px] font-semibold text-green">{keeper ? "GK" : p.order}</span><Avatar name={p.name} url={p.photoUrl} size={28} decorative /><span className="min-w-0 grow break-words text-sm font-semibold">{p.name}</span><span className="num text-xs text-sage">{p.position}</span></>;
                const rowClass = "flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded border border-line bg-pitch-900 px-1.5 py-1 text-left";
                function shift(delta: number) { const swap = outfield[outfield.indexOf(p) + delta]; if (swap) update(swapLineupPlayers(lineup, p, swap)); }
                return <li key={p.id} className="flex items-center gap-1">
                  {locked ? <div className={rowClass}>{row}</div> : <button type="button" disabled={saving} className={`${rowClass} hover:border-green`} onClick={() => setTargetId(p.id)}>{row}</button>}
                  {!keeper && <><button type="button" className={arrowClass} disabled={locked || saving || p === outfield[0]} aria-label={`Raise ${p.name} priority`} onClick={() => shift(-1)}><ArrowUp aria-hidden="true" className="size-4" /></button>
                    <button type="button" className={arrowClass} disabled={locked || saving || p === outfield.at(-1)} aria-label={`Lower ${p.name} priority`} onClick={() => shift(1)}><ArrowDown aria-hidden="true" className="size-4" /></button></>}
                </li>;
              })}
            </ol>}
            {!locked && lineup.players.length < rules.squadSize && bench.length < rules.subsCount && <div className="mt-3 flex flex-wrap gap-2">
              {!bench.some((p) => p.position === "GK") && <Button size="sm" variant="outline" disabled={saving} onClick={() => setBenchAdd("GK")}>Add bench keeper</Button>}
              {outfield.length < rules.subsCount - 1 && <Button size="sm" variant="outline" disabled={saving} onClick={() => setBenchAdd("outfield")}>Add outfield sub</Button>}
            </div>}
          </Panel>
          {!locked && unavailable.length > 0 && <Panel className="p-3">
            <p className="mb-2 text-sm text-card-y">Replace players who are no longer eligible for their saved position.</p>
            {unavailable.map((p) => <Button key={p.id} variant="outline" onClick={() => setTargetId(p.id)} disabled={saving}>{p.name} · {p.position}</Button>)}
          </Panel>}
          {!locked && !validation.ok && <ul className="space-y-1 text-sm text-card-y">{validation.errors.map((error) => <li key={error}>{error}</li>)}</ul>}
          <Panel className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-sage">{locked ? "Read-only lineup" : edit ? "Unsaved changes" : saved ? (preparing ? "Prepared for the next fixture" : "Saved for this match")
                : previous ? "Draft copied from your previous match" : "Starting from your saved squad"}</p>
              <Button className="min-h-11" disabled={locked || conflict || Boolean(loadError) || unavailable.length > 0 || !validation.ok || starters.length !== rules.starters} loading={saving} onClick={save}><Save aria-hidden="true" className="size-4" />{preparing ? "Save next lineup" : "Save changes"}</Button>
            </div>
            {notice && <p role="status" className="mt-2 text-sm text-green-glow">{notice}</p>}
          </Panel>
        </div>
      </div>
      {target && !poolOpen && <Modal open manageFocus title={`Replace ${target.name}`} onClose={closePicker}>
        <p className="mb-3 text-sm text-sage">Choose a player of the same position to keep the formation.</p>
        <ul className="mb-3 space-y-2">{availableSwaps.map((p) => <li key={p.id}><Button variant="outline" className="w-full justify-start" onClick={() => { update(swapLineupPlayers(lineup, target, p)); closePicker(); }}>{p.name} · {p.slot === "sub" ? "Bench" : p.slot === "starter" ? "Starter" : "Reserve"}</Button></li>)}</ul>
        <Button variant="outline" onClick={() => setPoolOpen(true)}>Choose from player pool</Button>
      </Modal>}
      {adding && <SquadPicker title={adding === "GK" ? "Pick a bench goalkeeper" : "Pick an outfield substitute"} replacement allowed={adding === "GK" ? ["GK"] : OUTFIELD} selected={new Set(lineup.players.map((p) => p.id))} pool={pool.data} error={pool.error} reload={() => void pool.reload()} onClose={closePicker} onPick={addSubstitute} />}
      {target && poolOpen && <SquadPicker title={`Replace ${target.name}`} replacement allowed={[target.position]} selected={new Set(lineup.players.map((p) => p.id))} pool={pool.data} error={pool.error} reload={() => void pool.reload()} onClose={closePicker} onPick={replace} />}
    </>}
  </div>;
}

function KickoffCountdown({ remaining }: { remaining: number | null }) {
  const time = Math.max(0, Math.ceil((remaining ?? 0) / 1000));
  const units = [["Days", Math.floor(time / 86400)], ["Hours", Math.floor(time / 3600) % 24], ["Mins", Math.floor(time / 60) % 60], ["Secs", time % 60]] as const;
  return <div role="timer" className="grid grid-cols-4 gap-1.5 sm:gap-2">
    {units.map(([unit, value]) => <div key={unit} className="rounded-md border border-line bg-pitch-950/75 px-1 py-2 text-center sm:min-w-15">
      <span className="num block text-xl font-semibold leading-none text-green-glow sm:text-2xl">{remaining == null ? "—" : String(value).padStart(2, "0")}</span>
      <span className="mt-1 block text-[10px] font-semibold uppercase tracking-wider text-sage">{unit}</span>
    </div>)}
  </div>;
}
