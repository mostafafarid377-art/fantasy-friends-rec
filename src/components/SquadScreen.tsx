"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowLeftRight, ArrowUp, CalendarDays, Ellipsis, FlaskConical, Plus, Save } from "lucide-react";
import { useActiveLeague, useLeague } from "./LeagueContext";
import { PageHeader } from "./AppShell";
import { Pitch } from "./Pitch";
import { NextMatchLineupScreen } from "./NextMatchLineupScreen";
import { lineupEntries, type NextMatchLineup, type SavedMatchLineup } from "@/lib/next-match-lineup";
import { PlayerPerformanceDialog, PlayerPointsLabel, useLatestPlayerGames } from "./PlayerPerformance";
import { formatPlayerPoints } from "@/lib/player-performance";
import { countdown, useKickoffClock } from "@/lib/match-deadline";
import { fieldClass, SquadPicker } from "./SquadPicker";
import { Avatar, Badge, Button, ErrorNote, Modal, Panel, Skeleton, Toast } from "./ui";
import { notifyLeagueContentChanged, useLeagueContentUpdates } from "@/lib/client/league-updates";
import { api, ApiRequestError, useApi } from "@/lib/client/api";
import {
  canSelectPlayer, normalizeBench, orderedBench, compatibleFormations, deriveFormation, findFormation, FORMATIONS, layoutFormation, moveSquadPlayer,
  nextSquadOrder, OUTFIELD, POSITIONS, squadCaps, validateSquad, validateSquadDraft,
  type LeagueRules, type Position, type SquadPlayer,
} from "@/lib/domain";
import type { PlayerPool, PoolPlayer, SquadEntry, SquadResponse } from "@/lib/squad";

const MATCH_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

type Slot = SquadPlayer["slot"];
const LABEL: Record<Slot, string> = { starter: "Starters", sub: "Substitutes", reserve: "Reserves" };
const SLOTS = ["starter", "sub", "reserve"] as const;
type Draft = { players: SquadEntry[]; formation: string; captainId: string | null; viceId: string | null; revision: string | null; matchId?: string | null };
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

export function SquadScreen({ editInitially = false, showLineupPreview = false, enableNextMatch = false }: { editInitially?: boolean; showLineupPreview?: boolean; enableNextMatch?: boolean }) {
  const { league } = useActiveLeague();
  if (!league) return <div className="mx-auto max-w-5xl p-5"><Skeleton className="h-64" /></div>;
  return <LeagueSquad key={league.id} leagueId={league.id} leagueName={league.name} editInitially={editInitially} showLineupPreview={showLineupPreview} enableNextMatch={enableNextMatch} />;
}

function LeagueSquad({ leagueId, leagueName, editInitially, showLineupPreview, enableNextMatch }: { leagueId: string; leagueName: string; editInitially: boolean; showLineupPreview: boolean; enableNextMatch: boolean }) {
  const { isLeader } = useLeague();
  const route = `/api/leagues/${leagueId}/squad`;
  const squad = useApi<SquadResponse>(route);
  const nextRoute = `/api/leagues/${leagueId}/next-match-lineup`;
  const nextLineup = useApi<NextMatchLineup>(enableNextMatch ? nextRoute : null);
  const [viewNext, setViewNext] = useState(false);
  const [hasOpenedNext, setHasOpenedNext] = useState(false);
  const [viewDefault, setViewDefault] = useState(false);
  useEffect(() => {
    if (!enableNextMatch) return;
    const refresh = () => { if (document.visibilityState === "visible") void nextLineup.reload(); };
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [enableNextMatch, nextLineup.reload]);
  useLeagueContentUpdates(enableNextMatch ? leagueId : undefined, nextLineup.reload);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [initialMode, setInitialMode] = useState(editInitially);
  const [pick, setPick] = useState<PickTarget | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [moving, setMoving] = useState<Slot | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const deadline = squad.data?.deadline;
  const remaining = useKickoffClock(deadline?.serverNow, deadline?.kickOff);
  const hasDeadline = Boolean(deadline);
  const squadLocked = Boolean(deadline?.locked || remaining === 0);
  const nextData = nextLineup.data;
  const nextFixture = nextData?.match;
  const nextRemaining = useKickoffClock(nextData?.serverNow, nextFixture?.kickOff);
  const editsNext = Boolean(nextData?.previous);
  const scheduled = nextFixture && !nextFixture.locked ? nextFixture : null;
  const checkingTarget = enableNextMatch && (!nextData || Boolean(nextLineup.error));
  const locked = editsNext ? (scheduled ? nextRemaining === 0 : !nextData?.canPrepare) : squadLocked;
  const nextSaved = nextFixture?.locked ? nextData?.preparation : nextData?.saved;
  const nextSeed: Draft | null = nextData?.previous ? {
    ...(nextSaved?.lineup ?? nextData.previous.lineup),
    revision: nextSaved?.revision ?? null, matchId: scheduled?.id ?? null,
  } : null;
  // Keep a dirty draft tied to the scope and revision the editor opened with.
  // If a fixture appears or starts, the draft must not be saved to a different match.
  const targetChanged = edit !== null && edit.matchId !== nextSeed?.matchId;
  const editingNext = edit ? edit.matchId !== undefined : editsNext;
  const editing = edit !== null || (initialMode && !locked && !checkingTarget);
  const editingBlocked = locked || checkingTarget || targetChanged;
  const nextKickoffReached = Boolean(scheduled && nextRemaining === 0);
  useEffect(() => { if (nextKickoffReached) void nextLineup.reload(); }, [nextKickoffReached, nextLineup.reload]);
  useEffect(() => {
    if (!hasDeadline) return;
    const refresh = () => { if (document.visibilityState === "visible") void squad.reload(); };
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [hasDeadline, squad.reload]);
  useEffect(() => {
    if (!squadLocked || editsNext || editingNext) return;
    setEdit(null); setInitialMode(false); setPick(null); setMoving(null);
  }, [squadLocked, editsNext, editingNext]);
  const pool = useApi<PlayerPool>(editing ? `/api/leagues/${leagueId}/players?archived=1` : null);

  // The last verified match's lineup is independent of both the default
  // squad and the draft for the upcoming match. Never render either as history.
  const previous = nextData?.previous;
  const historical = !editing && !viewDefault ? previous : null;
  const readOnlyLineup = !editing && Boolean(previous);
  const activePlayers = (editing ? (edit ?? nextSeed)?.players : historical?.lineup.players) ?? squad.data?.players ?? [];
  const lineupScores = useLatestPlayerGames(leagueId, activePlayers.filter((player) => player.slot !== "reserve"));
  const inspectedPlayer = activePlayers.find((player) => player.id === playerId && player.slot === "reserve");
  const inspectedScores = useLatestPlayerGames(leagueId, inspectedPlayer && !moving ? [inspectedPlayer] : []);
  useLeagueContentUpdates(leagueId, squad.reload, false);
  useLeagueContentUpdates(leagueId, pool.reload, false);

  if (squad.error && !squad.data) return <div className="mx-auto max-w-5xl p-5"><ErrorNote message={squad.error} onRetry={() => void squad.reload()} /></div>;
  if (!squad.data) return <div className="mx-auto max-w-5xl space-y-4 p-5"><Skeleton className="h-24" /><Skeleton className="h-80" /></div>;
  const stored = squad.data;
  const showingNext = viewNext && editsNext;
  const current = (editing ? edit ?? nextSeed : historical ? { ...historical.lineup, revision: null } : null) ?? snapshot(stored);
  const lineupTitle = historical ? "Previous match starting lineup" : editing && editingNext ? "Next match starters"
    : !editing && enableNextMatch && (previous || stored.lastMatch) ? "Default starting lineup" : "Starting lineup";
  const latest = lineupScores.data && historical
    ? Object.fromEntries(Object.entries(lineupScores.data).filter(([, game]) => game.matchId === historical.matchId))
    : lineupScores.data ?? undefined;
  const { formation, captainId, viceId } = current;
  // Refresh photo presentation without touching the unsaved slot choices or
  // the revision guarding concurrent squad edits.
  const photos = new Map([...stored.players, ...(pool.data?.players ?? [])].map((p) => [p.id, p.photoUrl]));
  const players = editing && edit ? current.players.map((p) => photos.has(p.id) ? { ...p, photoUrl: photos.get(p.id) ?? null } : p) : current.players;
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
  const missingStarters = editingNext && players.filter((p) => p.slot === "starter").length !== rules.starters;
  const savedComplete = Boolean(stored.squad?.completedAt) && complete && validation.ok && archived.length === 0;

  function begin() {
    if (editingBlocked || saving) return;
    setEdit(edit ?? nextSeed ?? snapshot(stored));
    if (previous) {
      setViewDefault(false);
      setPlayerId(null);
    }
    setMessage(null);
    setNotice(null);
  }
  function cancel() {
    setEdit(null); setInitialMode(false); setMessage(null); setConflict(false); setPick(null); setPlayerId(null); setMoving(null);
  }
  function openPicker(target: PickTarget) {
    if (readOnlyLineup || editingBlocked || saving) return;
    if (!editing) begin();
    setPick(target); setPlayerId(null); setMoving(null);
  }
  function changePlayers(next: SquadEntry[], nextFormation?: string) {
    next = normalizeBench(next);
    const starting = new Set(next.filter((p) => p.slot === "starter").map((p) => p.id));
    const captain = captainId && starting.has(captainId) ? captainId : null;
    const vice = viceId && starting.has(viceId) ? viceId : null;
    setEdit({ ...current, players: next, formation: nextFormation ?? deriveFormation(rules, next, formation)?.label ?? formation, captainId: captain, viceId: vice });
    setMessage(null);
    setNotice((captain !== captainId || vice !== viceId) ? "Captaincy was cleared for the player who left the starting lineup. Choose a starter to take over." : null);
    setPick(null); setPlayerId(null); setMoving(null);
  }
  function pickPlayer(player: PoolPlayer) {
    if (editingBlocked || !pick || players.some((p) => p.id === player.id) || player.status !== "active" || player.leagueId !== leagueId) return;
    const allowed = eligiblePositions(pick);
    if (!allowed.includes(player.position) || (pick.replace && !canSelectPlayer(player))) return;
    const nextEntry = { ...player, name: player.fullName, slot: pick.slot, order: pick.replace?.order ?? nextSquadOrder(players, pick.slot) };
    const next = pick.replace ? players.map((p) => p.id === pick.replace?.id ? nextEntry : p) : [...players, nextEntry];
    const candidate = deriveFormation(rules, next, formation);
    if (!candidate) { setPick(null); setMessage("That player cannot fit this starting lineup. Choose a goalkeeper for the keeper spot or an eligible outfield player."); return; }
    const check = validateSquadDraft(rules, next, { formation: candidate.label });
    if (!check.ok) { setPick(null); setMessage(check.errors.join(" ")); return; }
    changePlayers(next, pick.replace ? formation : candidate.label);
  }
  async function save() {
    if (editingBlocked || saving || conflict || !validation.ok || archived.length || missingStarters || (!players.length && !current.revision)) return;
    setSaving(true); setMessage(null); setNotice(null);
    try {
      if (current.matchId !== undefined) {
        const result = await api<SavedMatchLineup & { matchId: string | null }>(nextRoute, { method: "PUT", body: {
          matchId: current.matchId, formation: shape.label, captainId, viceId, expectedUpdatedAt: current.revision,
          entries: lineupEntries(normalizeBench(players)),
        } });
        if (result.matchId !== current.matchId || !result.revision || !result.lineup) throw new ApiRequestError("Save was not confirmed. Reload before retrying.", 409);
        // Both entry points use the same server draft; reload it for Next Match.
        void nextLineup.reload();
        cancel();
        setNotice("Lineup saved for the next match only. My Squad is unchanged.");
        return;
      }
      // Setup is the only default-squad write from My Team. Check again in
      // case a result was finalized since the setup editor was opened.
      if (enableNextMatch) {
        const latest = await api<NextMatchLineup>(nextRoute);
        if (latest.previous) {
          void nextLineup.reload();
          throw new ApiRequestError("A previous lineup is now available. Reopen Edit Squad to save for the next match only.", 409);
        }
      }
      const result = await api<SquadResponse & { state: string }>(route, { method: "PUT", body: {
        formation: shape.label, captainId, viceCaptainId: viceId, expectedUpdatedAt: current.revision,
        entries: players.map((p) => ({ playerId: p.id, slot: p.slot, order: p.order })),
      } });
      if (result.state !== "applied" || !result.squad?.id || !result.squad.updatedAt) throw new ApiRequestError("Save was not confirmed. Reload before retrying.", 409);
      squad.setData((previous) => ({ ...result, deadline: previous?.deadline, recentSubs: previous?.recentSubs, lastMatch: previous?.lastMatch }));
      notifyLeagueContentChanged(leagueId);
      cancel();
      setNotice(result.squad.completedAt ? "Squad saved." : "Squad draft saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : editingNext ? "Could not save the next-match lineup." : "Could not save squad. Reload before retrying.");
      setConflict(err instanceof ApiRequestError && (err.status === 409 || err.status === 0));
      if (current.matchId !== undefined) void nextLineup.reload();
      else if (err instanceof ApiRequestError && err.message.includes("Squad Locked")) void squad.reload();
    } finally { setSaving(false); }
  }
  function assign(role: "captain" | "vice", p: SquadEntry) {
    if (editingBlocked || p.slot !== "starter" || p.status !== "active") return;
    setEdit({ ...current,
      captainId: role === "captain" ? (captainId === p.id ? null : p.id) : (captainId === p.id ? null : captainId),
      viceId: role === "vice" ? (viceId === p.id ? null : p.id) : (viceId === p.id ? null : viceId),
    });
    setPlayerId(null); setMessage(null);
  }
  const bench = orderedBench(players);
  const keeper = bench.find((p) => p.position === "GK");
  const outfield = bench.filter((p) => p.position !== "GK");
  function shiftBench(index: number, direction: number) {
    const target = index + direction;
    if (editingBlocked || target < 0 || target >= outfield.length) return;
    const ids = outfield.map((p) => p.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    changePlayers(players.map((p) => ids.includes(p.id) ? { ...p, order: ids.indexOf(p.id) + 1 } : p), formation);
  }
  const benchRow = (p: SquadEntry, label: string) => <button type="button" disabled={saving} onClick={() => setPlayerId(p.id)}
    className="flex min-w-0 flex-1 items-center gap-2 rounded border border-line px-2 py-2 text-left text-chalk hover:border-green">
    <span className="num text-xs text-green">{label}</span><Avatar name={p.name} url={p.photoUrl} size={28} />
    <span className="min-w-0 flex-1 break-words text-sm">{p.name}{lineupScores.data && <PlayerPointsLabel game={latest?.[p.id]} />}</span><span className="text-xs text-sage">{p.position}</span>
  </button>;
  const priorityButton = "grid min-h-10 min-w-10 shrink-0 place-items-center rounded border border-line text-chalk hover:border-green disabled:opacity-40";
  const addStarter = (position: Position) => openPicker({ slot: "starter", position });
  const pickActions = editing ? <>
    <Button variant="outline" onClick={cancel} disabled={saving}>Cancel</Button>
    <Button onClick={save} loading={saving} disabled={editingBlocked || conflict || !validation.ok || archived.length > 0 || missingStarters || (!players.length && !current.revision)}>
      <Save className="h-4 w-4" /> {editingNext ? "Save for next match" : complete ? "Save squad" : "Save draft"}
    </Button>
  </> : locked && !editsNext ? null : (
    <Button onClick={begin} disabled={editingBlocked}><Plus className="h-4 w-4" />{players.length === 0 && !enableNextMatch ? "Pick squad" : "Edit squad"}</Button>
  );

  return (
    <>
    {hasOpenedNext && nextLineup.data?.previous && <div hidden={!showingNext}><NextMatchLineupScreen key={nextLineup.data.match?.id ?? "unscheduled"}
      leagueId={leagueId} leagueName={leagueName} rules={stored.rules} data={nextLineup.data} fallback={snapshot(stored)}
      route={nextRoute} refresh={nextLineup.reload} loadError={nextLineup.error}
      onBack={() => { if (!editing && !editingBlocked) begin(); setViewNext(false); }} /></div>}
    <div hidden={showingNext} className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader eyebrow={`${leagueName} · ${rules.format} fantasy`} title={editing ? (editingNext || stored.players.length ? "Edit squad" : "Pick squad") : "My squad"}
        subtitle={editing ? (editingNext ? "Changes save for the next match only. Your default squad and previous lineups won’t change."
          : "Tap a pitch slot to pick, or tap a player for their performance and squad actions. Changes only count after saving.")
          : historical ? "View the lineup saved for your previous match. Edit Squad only changes the next match."
          : players.length ? "View your saved lineup, substitutes and reserves." : "You haven’t picked a squad in this league. Start with any plus on the pitch."}
        actions={<>{pickActions}{nextLineup.data?.previous && <Button variant="outline" onClick={() => { setHasOpenedNext(true); setViewNext(true); setPlayerId(null); setPick(null); setMoving(null); }}><CalendarDays aria-hidden="true" className="size-4" />Next Match</Button>}<Button href="/players" variant="outline">{isLeader ? "Manage players & teams" : "Player pool"}</Button></>} />
      {enableNextMatch && nextLineup.error && <div className="mb-4"><ErrorNote message={nextLineup.error} onRetry={() => void nextLineup.reload()} /></div>}
      {showLineupPreview && <Button className="mb-4" href="/team/next-match-preview?from=squad" variant="ghost"><FlaskConical aria-hidden="true" className="size-4" />Lineup design preview</Button>}
      {editing && (targetChanged || (editingNext && locked)) && <p role="status" className="mb-4 rounded border border-card-y/35 p-3 text-sm">The next-match target has changed or locked. Cancel and reopen Edit Squad to edit the current target.</p>}
      {editing && missingStarters && <p className="mb-4 text-sm text-card-y">Fill all starting positions before saving for the next match.</p>}
      {editing && editingNext && !editingBlocked && <p className="mb-4 text-sm text-sage">{scheduled ? <>For {scheduled.title} only.{nextRemaining != null && <> Kickoff in <span className="num text-green">{countdown(nextRemaining)}</span>.</>}</> : "No next match scheduled. This lineup will apply to the first future match created in this league."}</p>}
      {!editsNext && (locked ? <p role="status" className="mb-4 rounded border border-line p-3 text-sm text-chalk"><strong>Squad Locked.</strong> {deadline?.title ?? "The match"} has started. Your saved squad stays unchanged until the match is finalized.</p>
        : remaining != null && <p className="mb-4 text-sm text-chalk">{deadline?.title} kicks off in <span className="num text-green">{countdown(remaining)}</span>.</p>)}
      {(message || squad.error) && <div className="mb-4" role="alert">
        <ErrorNote message={message ?? squad.error!} onRetry={squad.error ? () => void squad.reload() : undefined} />
        {conflict && <Button variant="outline" className="mt-2" onClick={() => { cancel(); void squad.reload(); if (enableNextMatch) void nextLineup.reload(); }}>Discard changes & reload</Button>}
      </div>}
      {notice && editing && <p role="status" className="mb-4 text-sm text-card-y">{notice}</p>}
      <section aria-labelledby="last-squad-match" className="mb-5">
        <Panel className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 p-4">
          <div className="min-w-0 break-words">
            <h2 id="last-squad-match" className="text-xl text-chalk">Last match points</h2>
            <p className="mt-1 text-sm text-sage">{stored.lastMatch ? <>{stored.lastMatch.title}
              {stored.lastMatch.kickOff && <> · <time dateTime={stored.lastMatch.kickOff}>{MATCH_DATE.format(new Date(stored.lastMatch.kickOff))}</time></>}
            </> : "No finalized match yet"}</p>
          </div>
          <div aria-live="polite" className="min-w-0 text-left sm:text-right">
            <p className="num break-words text-3xl font-bold text-green">{formatPlayerPoints(stored.lastMatch?.points)}</p>
            <p className="text-xs text-sage">{stored.lastMatch && stored.lastMatch.points == null ? "No squad score recorded" : "Fantasy squad total"}</p>
          </div>
        </Panel>
      </section>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <section className="mx-auto w-full max-w-[470px] space-y-3" aria-label={lineupTitle}>
          <div className="flex min-h-10 flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2"><h2 className="text-xl text-chalk">{lineupTitle}</h2><Badge tone="live">{players.filter((p) => p.slot === "starter").length}/{rules.starters}</Badge></div>
            {editing ? <select aria-label="Formation" className={fieldClass} value={shape.label} disabled={editingBlocked || saving || !canUse.length}
              onChange={(e) => { setEdit({ ...current, formation: e.target.value }); setMessage(null); }}>
              {!canUse.length && <option value={shape.label}>{shape.label}</option>}
              {canUse.map((f) => <option key={f.label}>{f.label}</option>)}
            </select> : <Badge>{shape.label}</Badge>}
          </div>
          {historical && <p className="text-sm text-sage"><Link className="underline-offset-4 hover:underline" href={`/matches/${historical.matchId}`}>{historical.title}</Link> · <time dateTime={historical.kickOff}>{MATCH_DATE.format(new Date(historical.kickOff))}</time> · Read-only</p>}
          {!editing && enableNextMatch && nextData && !nextLineup.error && stored.lastMatch && previous?.matchId !== stored.lastMatch.matchId &&
            <p className="text-sm text-sage">No verified lineup saved for {stored.lastMatch.title}.</p>}
          {previous && !editing && <Button size="sm" variant="outline" onClick={() => { setViewDefault(!viewDefault); setPlayerId(null); }}>
            {historical ? "View default squad" : "View previous lineup"}
          </Button>}
          <Pitch players={players} formation={shape} format={rules.format} captainId={captainId} viceCaptainId={viceId}
            disabled={saving} latest={latest} onAdd={readOnlyLineup || editingBlocked ? undefined : addStarter} onSelect={setPlayerId} />
          {!!unplaced.length && <Panel className="p-3">
            <p className="mb-2 text-sm text-card-y">{historical ? "Some starters from this match could not be placed on the pitch." : "Some saved starters no longer fit. Move, replace or remove them to repair the lineup."}</p>
            {unplaced.map((p) => <Button key={p.id} variant="ghost" onClick={() => setPlayerId(p.id)}>{p.name} · {p.position}</Button>)}
          </Panel>}
          {caps.sub > 0 && <Panel className="p-3">
            <h2 className="mb-2 text-lg text-chalk">Bench <span className="num text-sm text-sage">{bench.length}/{caps.sub}</span></h2>
            <p className="mb-2 text-xs text-sage">Goalkeeper first. Outfield priorities are checked from 1 down.</p>
            {readOnlyLineup && !bench.length && <p className="text-sm text-sage">No substitutes in this lineup.</p>}
            <ol className="space-y-2">
              {(keeper || !readOnlyLineup) && <li className="flex">{keeper ? benchRow(keeper, "GK") : <Button size="sm" variant="outline" disabled={editingBlocked || saving || players.length >= rules.squadSize || bench.length >= caps.sub}
                onClick={() => openPicker({ slot: "sub", position: "GK" })}>Pick bench goalkeeper</Button>}</li>}
              {bench.filter((p) => p.position === "GK" && p !== keeper).map((p) => <li key={p.id} className="flex">{benchRow(p, "Extra GK")}</li>)}
              {outfield.map((p, index) => <li key={p.id} className="flex items-stretch gap-1">
                {benchRow(p, `${index + 1}`)}
                {editing && <><button type="button" className={priorityButton} aria-label={`Raise ${p.name} priority`} disabled={saving || index === 0} onClick={() => shiftBench(index, -1)}><ArrowUp aria-hidden="true" className="h-4 w-4" /></button>
                  <button type="button" className={priorityButton} aria-label={`Lower ${p.name} priority`} disabled={saving || index === outfield.length - 1} onClick={() => shiftBench(index, 1)}><ArrowDown aria-hidden="true" className="h-4 w-4" /></button></>}
              </li>)}
            </ol>
            {!readOnlyLineup && outfield.length < caps.sub - 1 && bench.length < caps.sub && players.length < rules.squadSize && <Button size="sm" variant="outline" className="mt-2" disabled={editingBlocked || saving}
              onClick={() => openPicker({ slot: "sub" })}><Plus className="h-4 w-4" /> Add outfield sub</Button>}
          </Panel>}
        </section>
        <div className="min-w-0 space-y-4">
          <Panel className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl text-chalk">Squad <span className="num text-green">{players.length}/{rules.squadSize}</span></h2>
              <Badge tone={savedComplete && !editing ? "live" : "neutral"}>{historical ? "Read-only" : editing ? "Editing" : savedComplete ? "Complete" : players.length ? "Saved draft" : "Not picked"}</Badge>
            </div>
            <p className="mt-2 text-sm text-sage">A saved captain who plays scores double for your fantasy squad. Individual points stay unchanged; the captain contribution is shown separately. {stored.vicePolicy === "auto_captain" ? "If your captain doesn't play, an eligible vice-captain takes over." : "This league does not auto-promote the vice-captain."}</p>
            <p className="mt-2 text-sm text-chalk">Captain: {players.find((p) => p.id === captainId)?.name ?? "Not set"} · Vice: {players.find((p) => p.id === viceId)?.name ?? "Not set"}</p>
            {!historical && archived.length > 0 && <p className="mt-2 text-sm text-card-y">Replace or remove archived players before saving: {archived.map((p) => p.name).join(", ")}.</p>}
            {!historical && !validation.ok && <ul className="mt-2 space-y-1 text-sm text-card-y">{validation.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
          </Panel>
          {(["reserve"] as const).filter((slot) => caps[slot] > 0 || players.some((p) => p.slot === slot)).map((slot) => {
            const group = players.filter((p) => p.slot === slot).sort((a,b) => a.order-b.order || a.id.localeCompare(b.id));
            return <Panel key={slot} className="p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-xl text-chalk">{LABEL[slot]} <span className="num text-sm text-sage">{group.length}/{caps[slot]}</span></h2>
                {!readOnlyLineup && group.length < caps[slot] && players.length < rules.squadSize && <Button size="sm" variant="outline" disabled={editingBlocked || saving}
                  onClick={() => openPicker({ slot })}><Plus className="h-4 w-4" /> Add reserve</Button>}
              </div>
              {group.length ? <ul className="space-y-1">{group.map((p) => <li key={p.id}><button type="button" onClick={() => setPlayerId(p.id)} disabled={saving}
                className="flex w-full items-center gap-3 rounded border border-line px-2 py-2 text-left text-chalk hover:border-green">
                <Avatar name={p.name} url={p.photoUrl} size={28} /><span className="min-w-0 flex-1 break-words text-sm">{p.name}</span>
                <span className="text-xs text-sage">{p.position}</span><Ellipsis className="h-4 w-4" />
              </button></li>)}</ul> : <p className="text-sm text-sage">No {LABEL[slot].toLowerCase()} picked yet.</p>}
            </Panel>;
          })}
          {!!stored.recentSubs?.length && <Panel className="space-y-3 p-4">
            <h2 className="text-xl text-chalk">Recent automatic substitutions</h2>
            {stored.recentSubs.map((report) => <div key={report.matchId}>
              <Button href={`/matches/${report.matchId}`} variant="ghost" size="sm">{report.title}</Button>
              <ul className="pl-2 text-sm text-sage">{report.substitutions.map((sub) => <li key={sub.inId}>{sub.inName} <span className="text-green">replaced</span> {sub.outName}</li>)}</ul>
            </div>)}
          </Panel>}
          {editing && <div className="flex flex-wrap gap-2 lg:hidden">{pickActions}</div>}
        </div>
      </div>
      {editing && !editingBlocked && pick && <SquadPicker title={pick.replace ? `Replace ${pick.replace.name}` : pick.position ? `Pick a ${pick.position}` : pick.slot === "sub" ? "Pick a substitute" : "Pick a reserve"}
        replacement={Boolean(pick.replace)} allowed={eligiblePositions(pick)} selected={new Set(players.map((p) => p.id))} pool={pool.data} error={pool.error} reload={() => void pool.reload()}
        onPick={pickPlayer} onClose={() => setPick(null)} />}
      {selected && !moving && <PlayerPerformanceDialog key={selected.id} leagueId={leagueId} entry={selected}
        latest={lineupScores.data?.[selected.id] ?? inspectedScores.data?.[selected.id]} onClose={() => setPlayerId(null)} actions={<>
        <p className="mb-2 text-xs text-sage">{LABEL[selected.slot]} · {selected.status !== "active" ? "Archived" : selected.availability}</p>
        {editing && !editingBlocked ? <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
          {selected.slot === "starter" && selected.status === "active" && <>
            <Button variant="outline" onClick={() => assign("captain", selected)}>{captainId === selected.id ? "Clear captain" : "Make captain"}</Button>
            <Button variant="outline" onClick={() => assign("vice", selected)}>{viceId === selected.id ? "Clear vice" : "Make vice"}</Button>
          </>}
          {SLOTS.filter((slot) => slot !== selected.slot && caps[slot] > 0).map((slot) => <Button key={slot} variant="outline" onClick={() => setMoving(slot)}>
            <ArrowLeftRight className="h-4 w-4" /> {slot === "starter" ? "Move to pitch" : slot === "sub" ? "Move to bench" : "Move to reserves"}
          </Button>)}
          <Button variant="outline" onClick={() => openPicker({ slot: selected.slot, replace: selected })}>Replace player</Button>
          <Button variant="danger" onClick={() => changePlayers(players.filter((p) => p.id !== selected.id))}>Remove player</Button>
        </div> : !editingBlocked && <Button onClick={begin}>Edit squad</Button>}
      </>} />}
      {editing && !editingBlocked && selected && moving && <MoveDialog player={selected} destination={moving} rules={rules} players={players} formation={shape.label}
        onMove={changePlayers} onBack={() => setMoving(null)} />}
      {notice && !editing && <Toast message={notice} onClose={() => setNotice(null)} />}
    </div>
    </>
  );
}

function eligiblePositions(pick: PickTarget): readonly Position[] {
  if (pick.position) return [pick.position];
  if (pick.replace) return [pick.replace.position];
  if (pick.slot === "sub") return OUTFIELD;
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
