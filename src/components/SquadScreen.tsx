"use client";

import { useState } from "react";
import { ArrowLeftRight, Ellipsis, Plus, Save } from "lucide-react";
import { useActiveLeague, useLeague } from "./LeagueContext";
import { PageHeader } from "./AppShell";
import { Pitch } from "./Pitch";
import { fieldClass, SquadPicker } from "./SquadPicker";
import { Avatar, Badge, Button, ErrorNote, Modal, Panel, Skeleton, Toast } from "./ui";
import { notifyLeagueContentChanged, useLeagueContentUpdates } from "@/lib/client/league-updates";
import { api, ApiRequestError, useApi } from "@/lib/client/api";
import {
  compatibleFormations, deriveFormation, findFormation, FORMATIONS, layoutFormation, moveSquadPlayer,
  nextSquadOrder, OUTFIELD, POSITIONS, squadCaps, validateSquad, validateSquadDraft,
  type LeagueRules, type Position, type SquadPlayer,
} from "@/lib/domain";
import type { PlayerPool, PoolPlayer, SquadEntry, SquadResponse } from "@/lib/squad";

type Slot = SquadPlayer["slot"];
const LABEL: Record<Slot, string> = { starter: "Starters", sub: "Substitutes", reserve: "Reserves" };
const SLOTS = ["starter", "sub", "reserve"] as const;
type Draft = { players: SquadEntry[]; formation: string; captainId: string | null; viceId: string | null; revision: string | null };
type PickTarget = { slot: Slot; position?: Position; replace?: SquadEntry };

function snapshot(data: SquadResponse): Draft {
  const starting = new Set(data.players.filter((p) => p.slot === "starter").map((p) => p.id));
  const captain = data.squad?.captainId ?? null;
  const vice = data.squad?.viceCaptainId ?? null;
  return { players: data.players,
    formation: (deriveFormation(data.rules, data.players, data.squad?.formation) ?? FORMATIONS[data.rules.format][0]).label,
    captainId: captain && starting.has(captain) ? captain : null,
    viceId: vice && vice !== captain && starting.has(vice) ? vice : null,
    revision: data.squad?.updatedAt ?? null };
}

export function SquadScreen({ editInitially = false }: { editInitially?: boolean }) {
  const { league } = useActiveLeague();
  if (!league) return <div className="mx-auto max-w-5xl p-5"><Skeleton className="h-64" /></div>;
  return <LeagueSquad key={league.id} leagueId={league.id} leagueName={league.name} editInitially={editInitially} />;
}

function LeagueSquad({ leagueId, leagueName, editInitially }: { leagueId: string; leagueName: string; editInitially: boolean }) {
  const { isLeader } = useLeague();
  const route = `/api/leagues/${leagueId}/squad`;
  const squad = useApi<SquadResponse>(route);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [initialMode, setInitialMode] = useState(editInitially);
  const [pick, setPick] = useState<PickTarget | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [moving, setMoving] = useState<Slot | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const editing = initialMode || edit !== null;
  const pool = useApi<PlayerPool>(editing ? `/api/leagues/${leagueId}/players?archived=1` : null);

  useLeagueContentUpdates(leagueId, squad.reload, false);
  useLeagueContentUpdates(leagueId, pool.reload, false);

  if (squad.error && !squad.data) return <div className="mx-auto max-w-5xl p-5"><ErrorNote message={squad.error} onRetry={() => void squad.reload()} /></div>;
  if (!squad.data) return <div className="mx-auto max-w-5xl space-y-4 p-5"><Skeleton className="h-24" /><Skeleton className="h-80" /></div>;
  const stored = squad.data;
  const current = edit ?? snapshot(stored);
  const { formation, captainId, viceId } = current;
  // Refresh photo presentation without touching the unsaved slot choices or
  // the revision guarding concurrent squad edits.
  const photos = new Map([...stored.players, ...(pool.data?.players ?? [])].map((p) => [p.id, p.photoUrl]));
  const players = edit ? current.players.map((p) => photos.has(p.id) ? { ...p, photoUrl: photos.get(p.id) ?? null } : p) : current.players;
  const { rules } = stored;
  const caps = squadCaps(rules);
  const shape = findFormation(formation, rules.format) ?? FORMATIONS[rules.format][0];
  const canUse = compatibleFormations(rules, players);
  const placed = new Set(layoutFormation(players, shape).map((p) => p.playerId));
  const unplaced = players.filter((p) => p.slot === "starter" && !placed.has(p.id));
  const selected = players.find((p) => p.id === playerId);
  const complete = players.length === rules.squadSize;
  const validation = (complete ? validateSquad : validateSquadDraft)(rules, players, { formation: shape.label, captainId, viceId });
  const archived = players.filter((p) => p.status !== "active");
  const savedComplete = Boolean(stored.squad?.completedAt) && complete && validation.ok && archived.length === 0;

  function begin() {
    setEdit(current);
    setMessage(null);
    setNotice(null);
  }
  function cancel() {
    setEdit(null); setInitialMode(false); setMessage(null); setConflict(false); setPick(null); setPlayerId(null); setMoving(null);
  }
  function openPicker(target: PickTarget) {
    if (!editing) begin();
    setPick(target); setPlayerId(null); setMoving(null);
  }
  function changePlayers(next: SquadEntry[], nextFormation?: string) {
    const starting = new Set(next.filter((p) => p.slot === "starter").map((p) => p.id));
    const captain = captainId && starting.has(captainId) ? captainId : null;
    const vice = viceId && starting.has(viceId) ? viceId : null;
    setEdit({ ...current, players: next, formation: nextFormation ?? deriveFormation(rules, next, formation)?.label ?? formation, captainId: captain, viceId: vice });
    setMessage(null);
    setNotice((captain !== captainId || vice !== viceId) ? "Captaincy was cleared for the player who left the starting lineup. Choose a starter to take over." : null);
    setPick(null); setPlayerId(null); setMoving(null);
  }
  function pickPlayer(player: PoolPlayer) {
    if (!pick || players.some((p) => p.id === player.id) || player.status !== "active" || player.leagueId !== leagueId) return;
    const allowed = eligiblePositions(pick);
    if (!allowed.includes(player.position)) return;
    const nextEntry = { ...player, name: player.fullName, slot: pick.slot, order: pick.replace?.order ?? nextSquadOrder(players, pick.slot) };
    const next = pick.replace ? players.map((p) => p.id === pick.replace?.id ? nextEntry : p) : [...players, nextEntry];
    const candidate = deriveFormation(rules, next, formation);
    if (!candidate) { setPick(null); setMessage("That player cannot fit this starting lineup. Choose a goalkeeper for the keeper spot or an eligible outfield player."); return; }
    const check = validateSquadDraft(rules, next, { formation: candidate.label });
    if (!check.ok) { setPick(null); setMessage(check.errors.join(" ")); return; }
    changePlayers(next, candidate.label);
  }
  async function save() {
    if (saving || conflict || !validation.ok || archived.length) return;
    setSaving(true); setMessage(null); setNotice(null);
    try {
      const result = await api<SquadResponse & { state: string }>(route, { method: "PUT", body: {
        formation: shape.label, captainId, viceCaptainId: viceId, expectedUpdatedAt: current.revision,
        entries: players.map((p) => ({ playerId: p.id, slot: p.slot, order: p.order })),
      } });
      if (result.state !== "applied" || !result.squad?.id || !result.squad.updatedAt) throw new ApiRequestError("Save was not confirmed. Reload before retrying.", 409);
      squad.setData(result);
      notifyLeagueContentChanged(leagueId);
      cancel();
      setNotice(result.squad.completedAt ? "Squad saved." : "Squad draft saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save squad. Reload before retrying.");
      setConflict(err instanceof ApiRequestError && (err.status === 409 || err.status === 0));
    } finally { setSaving(false); }
  }
  function assign(role: "captain" | "vice", p: SquadEntry) {
    if (p.slot !== "starter" || p.status !== "active") return;
    setEdit({ ...current,
      captainId: role === "captain" ? (captainId === p.id ? null : p.id) : (captainId === p.id ? null : captainId),
      viceId: role === "vice" ? (viceId === p.id ? null : p.id) : (viceId === p.id ? null : viceId),
    });
    setPlayerId(null); setMessage(null);
  }
  const addStarter = (position: Position) => openPicker({ slot: "starter", position });
  const pickActions = editing ? <>
    <Button variant="outline" onClick={cancel} disabled={saving}>Cancel</Button>
    <Button onClick={save} loading={saving} disabled={conflict || !validation.ok || archived.length > 0 || (!players.length && !current.revision)}>
      <Save className="h-4 w-4" /> {complete ? "Save squad" : "Save draft"}
    </Button>
  </> : (
    <Button onClick={begin}><Plus className="h-4 w-4" />{players.length === 0 ? "Pick squad" : "Edit squad"}</Button>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader eyebrow={`${leagueName} · ${rules.format} fantasy`} title={editing ? (stored.players.length ? "Edit squad" : "Pick squad") : "My squad"}
        subtitle={editing ? "Tap a pitch slot to pick. Tap a player to set captaincy, move, remove or replace them. Changes only count after saving."
          : players.length ? "View your saved lineup, substitutes and reserves." : "You haven’t picked a squad in this league. Start with any plus on the pitch."}
        actions={<>{pickActions}<Button href="/players" variant="outline">{isLeader ? "Manage players & teams" : "Player pool"}</Button></>} />
      {(message || squad.error) && <div className="mb-4" role="alert">
        <ErrorNote message={message ?? squad.error!} onRetry={squad.error ? () => void squad.reload() : undefined} />
        {conflict && <Button variant="outline" className="mt-2" onClick={() => { cancel(); void squad.reload(); }}>Discard changes & reload</Button>}
      </div>}
      {notice && editing && <p role="status" className="mb-4 text-sm text-card-y">{notice}</p>}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <section className="mx-auto w-full max-w-[470px] space-y-3" aria-label="Starting lineup">
          <div className="flex min-h-10 flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2"><h2 className="text-xl text-chalk">Starting lineup</h2><Badge tone="live">{players.filter((p) => p.slot === "starter").length}/{rules.starters}</Badge></div>
            {editing ? <select aria-label="Formation" className={fieldClass} value={shape.label} disabled={saving || !canUse.length}
              onChange={(e) => { setEdit({ ...current, formation: e.target.value }); setMessage(null); }}>
              {!canUse.length && <option value={shape.label}>{shape.label}</option>}
              {canUse.map((f) => <option key={f.label}>{f.label}</option>)}
            </select> : <Badge>{shape.label}</Badge>}
          </div>
          <Pitch players={players} formation={shape} format={rules.format} captainId={captainId} viceCaptainId={viceId}
            disabled={saving} onAdd={addStarter} onSelect={setPlayerId} />
          {!!unplaced.length && <Panel className="p-3">
            <p className="mb-2 text-sm text-card-y">Some saved starters no longer fit. Move, replace or remove them to repair the lineup.</p>
            {unplaced.map((p) => <Button key={p.id} variant="ghost" onClick={() => setPlayerId(p.id)}>{p.name} · {p.position}</Button>)}
          </Panel>}
        </section>
        <div className="space-y-4">
          <Panel className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl text-chalk">Squad <span className="num text-green">{players.length}/{rules.squadSize}</span></h2>
              <Badge tone={savedComplete && !editing ? "live" : "neutral"}>{editing ? "Editing" : savedComplete ? "Complete" : players.length ? "Saved draft" : "Not picked"}</Badge>
            </div>
            <p className="mt-2 text-sm text-sage">Captain scores double. {stored.vicePolicy === "auto_captain" ? "If your captain doesn't play, an eligible vice-captain takes over." : "This league does not auto-promote the vice-captain."}</p>
            <p className="mt-2 text-sm text-chalk">Captain: {players.find((p) => p.id === captainId)?.name ?? "Not set"} · Vice: {players.find((p) => p.id === viceId)?.name ?? "Not set"}</p>
            {archived.length > 0 && <p className="mt-2 text-sm text-card-y">Replace or remove archived players before saving: {archived.map((p) => p.name).join(", ")}.</p>}
            {!validation.ok && <ul className="mt-2 space-y-1 text-sm text-card-y">{validation.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
          </Panel>
          {(["sub", "reserve"] as const).filter((slot) => caps[slot] > 0 || players.some((p) => p.slot === slot)).map((slot) => {
            const group = players.filter((p) => p.slot === slot).sort((a,b) => a.order-b.order || a.id.localeCompare(b.id));
            return <Panel key={slot} className="p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-xl text-chalk">{LABEL[slot]} <span className="num text-sm text-sage">{group.length}/{caps[slot]}</span></h2>
                {group.length < caps[slot] && players.length < rules.squadSize && <Button size="sm" variant="outline" disabled={saving}
                  onClick={() => openPicker({ slot })}><Plus className="h-4 w-4" /> {slot === "sub" ? "Add sub" : "Add reserve"}</Button>}
              </div>
              {group.length ? <ul className="space-y-1">{group.map((p) => <li key={p.id}><button type="button" onClick={() => setPlayerId(p.id)} disabled={saving}
                className="flex w-full items-center gap-3 rounded border border-line px-2 py-2 text-left text-chalk hover:border-green">
                <Avatar name={p.name} url={p.photoUrl} size={28} /><span className="min-w-0 flex-1 break-words text-sm">{p.name}</span>
                <span className="text-xs text-sage">{p.position}</span><Ellipsis className="h-4 w-4" />
              </button></li>)}</ul> : <p className="text-sm text-sage">No {LABEL[slot].toLowerCase()} picked yet.</p>}
            </Panel>;
          })}
          {editing && <div className="flex flex-wrap gap-2 lg:hidden">{pickActions}</div>}
        </div>
      </div>
      {pick && <SquadPicker title={pick.replace ? `Replace ${pick.replace.name}` : pick.position ? `Pick a ${pick.position}` : pick.slot === "sub" ? "Pick a substitute" : "Pick a reserve"}
        allowed={eligiblePositions(pick)} selected={new Set(players.map((p) => p.id))} pool={pool.data} error={pool.error} reload={() => void pool.reload()}
        onPick={pickPlayer} onClose={() => setPick(null)} />}
      {selected && !moving && <Modal open title={selected.name} onClose={() => setPlayerId(null)}>
        <div className="mb-4 flex items-center gap-3"><Avatar name={selected.name} url={selected.photoUrl} size={44} />
          <p className="text-sm text-sage">{selected.position} · {LABEL[selected.slot]} · {selected.status !== "active" ? "Archived" : selected.availability}</p></div>
        {editing ? <div className="grid grid-cols-2 gap-2">
          {selected.slot === "starter" && selected.status === "active" && <>
            <Button variant="outline" onClick={() => assign("captain", selected)}>{captainId === selected.id ? "Clear captain" : "Make captain"}</Button>
            <Button variant="outline" onClick={() => assign("vice", selected)}>{viceId === selected.id ? "Clear vice" : "Make vice"}</Button>
          </>}
          {SLOTS.filter((slot) => slot !== selected.slot && caps[slot] > 0).map((slot) => <Button key={slot} variant="outline" onClick={() => setMoving(slot)}>
            <ArrowLeftRight className="h-4 w-4" /> {slot === "starter" ? "Move to pitch" : slot === "sub" ? "Move to bench" : "Move to reserves"}
          </Button>)}
          <Button variant="outline" onClick={() => openPicker({ slot: selected.slot, replace: selected })}>Replace player</Button>
          <Button variant="danger" onClick={() => changePlayers(players.filter((p) => p.id !== selected.id))}>Remove player</Button>
        </div> : <Button onClick={begin}>Edit squad</Button>}
      </Modal>}
      {selected && moving && <MoveDialog player={selected} destination={moving} rules={rules} players={players} formation={shape.label}
        onMove={changePlayers} onBack={() => setMoving(null)} />}
      {notice && !editing && <Toast message={notice} onClose={() => setNotice(null)} />}
    </div>
  );
}

function eligiblePositions(pick: PickTarget): readonly Position[] {
  if (pick.position) return [pick.position];
  if (pick.slot === "starter" && pick.replace) return pick.replace.position === "GK" ? ["GK"] : OUTFIELD;
  return POSITIONS;
}

function MoveDialog({ player, destination, rules, players, formation, onMove, onBack }: {
  player: SquadEntry; destination: Slot; rules: LeagueRules; players: SquadEntry[]; formation: string;
  onMove: (players: SquadEntry[], next: string) => void; onBack: () => void;
}) {
  const group = players.filter((p) => p.slot === destination);
  const space = group.length < squadCaps(rules)[destination];
  const options = [...(space ? [null] : []), ...group].map((swap) => ({ swap,
    result: moveSquadPlayer(rules, players, player.id, destination, formation, swap?.id) }));
  return <Modal open title={`Move ${player.name} · ${LABEL[destination]}`} onClose={onBack}>
    <p className="mb-3 text-sm text-sage">{space ? "Move to an empty spot or swap with another squad member." : "This group is full. Choose a player to swap with."}</p>
    <ul className="space-y-2">{options.map(({ swap, result }) => (
      <li key={swap?.id ?? "space"}>
        <Button className="min-h-10 w-full !h-auto justify-start py-2 text-left" variant="outline" disabled={"error" in result} onClick={() => {
          if (!("error" in result)) onMove(result.players, result.formation);
        }}>{swap ? `Swap with ${swap.name} (${swap.position})` : "Move to empty spot"}</Button>
        {"error" in result ? <p className="mt-1 text-xs text-card-y">{result.error}</p>
          : formation !== result.formation && <p className="mt-1 text-xs text-sage">New formation: {result.formation}</p>}
      </li>
    ))}</ul>
    <Button className="mt-3" variant="ghost" onClick={onBack}>Back to player actions</Button>
  </Modal>;
}
