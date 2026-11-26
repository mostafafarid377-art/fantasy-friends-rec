"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  Save,
  Timer,
  Trash2,
  XCircle,
} from "lucide-react";
import { RealTeamName } from "@/components/TeamLogo";
import { useKickoffClock } from "@/lib/match-deadline";
import { MatchStatistics, type MatchStat, type MatchBonusAward } from "@/components/MatchStatistics";
import { MatchResult, type MatchScore } from "@/components/MatchResult";
import { MotmPanel } from "@/components/MotmPanel";
import { PageHeader } from "@/components/AppShell";
import {
  Avatar,
  Badge,
  Button,
  ErrorNote,
  Field,
  Panel,
  Select,
  Skeleton,
  Slate,
  TextInput,
  Toast,
} from "@/components/ui";
import { useActiveLeague } from "@/components/LeagueContext";
import { notifyLeagueContentChanged, useLiveLeaguePoints } from "@/lib/client/league-updates";
import { useAppRefresh } from "@/lib/client/refresh";
import { api, assertConfirmed, useApi } from "@/lib/client/api";
import { lineupEquals, lineupPayload, lineupSelection, type SavedLineupEntry, type LineupSelection } from "@/lib/match-lineup";
import { canSelectPlayer, validateLineup, EVENT_TYPES, type LeagueRules, type Position } from "@/lib/domain";

type Player = {
  id: string;
  fullName: string;
  position: Position;
  photoUrl: string | null;
  shirtNumber: number | null;
  status: string;
  availability: string;
  teamId: string | null;
};

type LineupEntry = SavedLineupEntry;

type MatchData = {
  match: {
    id: string;
    leagueId: string;
    title: string;
    status: string;
    homeScore: number | null;
    awayScore: number | null;
    kickOff: string;
    durationMinutes: number | null;
    teamAId: string;
    teamBId: string;
    teamAName: string;
    teamBName: string;
    organizerId: string;
    submittedBy: string | null;
    submittedAt: string | null;
    decidedBy: string | null;
    decidedAt: string | null;
    rejectionReason: string | null;
    version: number;
    fixtureId: string | null;
  };
  serverNow?: string;
  statistics?: MatchStat[];
  bonusAwards?: MatchBonusAward[];
  scoringLineups?: (Pick<LineupEntry, "playerId" | "teamId" | "slot"> & { matchPosition?: string; player: Player | null })[];
  rules: LeagueRules;
  role: string;
  canOrganize: boolean;
  livePlayerPoints?: { playerId: string; points: number }[];
  canEditEvents: boolean;
  canApprove: boolean;
  lineups: (LineupEntry & { matchPosition?: string; player: Player | null })[];
  events: {
    id: string;
    teamId: string;
    playerId: string;
    assistPlayerId: string | null;
    eventType: string;
    note: string | null;
    player: Player | null;
    assistPlayer: Player | null;
  }[];
  substitutions: {
    id: string;
    teamId: string;
    playerOnId: string;
    playerOffId: string;
    minute: number;
    playerOn: Player | null;
    playerOff: Player | null;
  }[];
  approvals: { id: string; action: string; actorId: string; reason: string | null; version: number; createdAt: string;
    scoreChange?: (MatchScore & { previousHomeScore: number; previousAwayScore: number; statisticsCorrected?: boolean }) | null }[];
  roster: Player[];
  teams: { id: string; name: string; crestUrl?: string | null }[];
};

const STAT_LABEL = { saves: "Goalkeeper saves", defensiveContributions: "Defensive contributions" };
const EVENT_LABEL: Record<string, string> = {
  goal: "Goal",
  own_goal: "Own goal",
  assist: "Assist",
  yellow_card: "Yellow",
  red_card: "Red",
  penalty_saved: "Pen. saved",
  penalty_missed: "Pen. missed",
};

const STATUS_TONE: Record<string, "neutral" | "live" | "warn" | "danger" | "info"> = {
  draft: "neutral",
  pending: "warn",
  approved: "live",
  rejected: "danger",
};

export default function MatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [matchId, setMatchId] = useState<string | null>(null);
  useEffect(() => {
    void params.then((p) => setMatchId(p.id));
  }, [params]);

  const { league } = useActiveLeague();
  const { data, loading, error, reload, setData } = useApi<MatchData>(
    matchId ? `/api/matches/${matchId}` : null,
    [matchId],
  );

  const timeToKickoff = useKickoffClock(data?.serverNow, data?.match.kickOff);
  const started = timeToKickoff === 0;
  // Live matches follow the app-wide focus/visibility coordinator.
  useAppRefresh(() => { void reload(); }, { enabled: Boolean(data?.serverNow) });
  const [newKickoff, setNewKickoff] = useState("");
  const [rescheduling, setRescheduling] = useState(false);
  const [tab, setTab] = useState<"lineups" | "events" | "history">("lineups");
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Keep only local overrides in state; untouched teams always use persisted rows.
  const [draft, setDraft] = useState<{ id: string; teams: Record<string, LineupSelection> } | null>(null);
  const savedSelections = useMemo(() => data ? Object.fromEntries([data.match.teamAId, data.match.teamBId]
    .map((id) => [id, lineupSelection(data.lineups, id)])) : {}, [data]);
  const sel = { ...savedSelections, ...(draft && draft.id === matchId ? draft.teams : {}) };

  // event form
  const [evTeam, setEvTeam] = useState("");
  const [evPlayer, setEvPlayer] = useState("");
  const [evAssist, setEvAssist] = useState("");
  const [evType, setEvType] = useState<string>("goal");
  const [evNote, setEvNote] = useState("");
  const [statCount, setStatCount] = useState<string | null>(null);
  const [statReason, setStatReason] = useState("");
  const [statError, setStatError] = useState<string | null>(null);
  const savingStatistic = useRef(false);
  const statisticsDirty = statCount !== null;
  useLiveLeaguePoints(tab === "events" && !busy && !statisticsDirty ? data?.match.leagueId : undefined, reload, false);
  const resetStatistic = () => { setStatCount(null); setStatReason(""); setStatError(null); };
  useEffect(() => { resetStatistic(); }, [data?.match.id, data?.match.version]);

  // substitution form
  const [subTeam, setSubTeam] = useState("");
  const [subOn, setSubOn] = useState("");
  const [subOff, setSubOff] = useState("");
  const [subMinute, setSubMinute] = useState("");

  // review
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState(false);

  const defaultTeam = data?.match.teamAId;
  useEffect(() => {
    if (defaultTeam) {
      setEvTeam(defaultTeam);
      setSubTeam(defaultTeam);
    }
  }, [matchId, defaultTeam]);

  const rosterByTeam = useMemo(() => {
    const map: Record<string, Player[]> = {};
    for (const t of data?.teams ?? []) map[t.id] = [];
    for (const p of data?.roster ?? []) {
      if (!p.teamId) continue;
      if (!map[p.teamId]) map[p.teamId] = [];
      map[p.teamId].push(p);
    }
    return map;
  }, [data]);

  const notify = (message: string, tone: "ok" | "error" = "ok") => setToast({ message, tone });

  const EMPTY_SELECTION: LineupSelection = { starters: [], subs: [] };
  const lineupDirty = (teamId: string) =>
    !lineupEquals(sel[teamId] ?? EMPTY_SELECTION, savedSelections[teamId] ?? EMPTY_SELECTION);

  const lineupSaving = useRef(false);
  const saveLineup = async (teamId: string) => {
    if (!matchId || !data?.canOrganize || busy || statisticsDirty || lineupSaving.current) return;
    // Nothing to submit when the selection already matches the persisted lineup.
    if (!lineupDirty(teamId)) return;
    lineupSaving.current = true;
    setBusy(true);
    setFormError(null);
    try {
      const state = sel[teamId];
      const saved = await api<{ lineups: SavedLineupEntry[] }>(`/api/matches/${matchId}/lineup`, {
        method: "PUT",
        body: lineupPayload(teamId, state),
      });
      if (!saved?.lineups?.length || saved.lineups.some((line) => !line.id)) throw new Error("The saved lineup could not be confirmed");
      const confirmed = lineupSelection(saved.lineups, teamId);
      if (JSON.stringify(confirmed) !== JSON.stringify(state)) throw new Error("The saved lineup did not match the selection. Reload before retrying.");
      setData((current) => current ? { ...current, lineups: [
        ...current.lineups.filter((entry) => entry.teamId !== teamId),
        ...saved.lineups.map((entry) => ({ ...entry, player: current.roster.find((p) => p.id === entry.playerId) ?? null })),
      ] } : current);
      setDraft((current) => {
        if (current?.id !== matchId) return current;
        const teams = { ...current.teams };
        delete teams[teamId];
        return { id: matchId, teams };
      });
      await reload();
      notify("Line-up saved");
    } catch (err) {
      const details = (err as { details?: unknown }).details;
      setFormError(
        Array.isArray(details)
          ? (details as string[]).join(" ")
          : err instanceof Error
            ? err.message
            : "Could not save the line-up",
      );
      notify("Line-up not saved", "error");
    } finally {
      lineupSaving.current = false;
      setBusy(false);
    }
  };

  const assign = (teamId: string, playerId: string, slot: "starter" | "sub" | null) => {
    if (!matchId || !data?.canOrganize || busy) return;
    setDraft((current) => {
      const teams = current?.id === matchId ? current.teams : {};
      const state = teams[teamId] ?? savedSelections[teamId] ?? { starters: [], subs: [] };
      const next = {
        starters: state.starters.filter((id) => id !== playerId),
        subs: state.subs.filter((id) => id !== playerId),
      };
      if (slot) next[slot === "starter" ? "starters" : "subs"].push(playerId);
      return { id: matchId, teams: { ...teams, [teamId]: next } };
    });
  };

  const recordEvent = async (eventType: string) => {
    if (!matchId || !data?.canEditEvents || busy) return;
    if (!evTeam || !evPlayer) {
      notify("Team and player are required", "error");
      return;
    }
    setBusy(true);
    try {
      const saved = await api<{ event?: { id: string }; substitution?: { id: string } }>(`/api/matches/${matchId}/events`, {
        method: "POST",
        body: {
          teamId: evTeam,
          playerId: evPlayer,
          assistPlayerId: eventType === "goal" ? evAssist || null : null,
          eventType,
          note: evNote || null,
        },
        idempotent: true,
      });
      setEvPlayer("");
      setEvAssist("");
      setEvNote("");
      assertConfirmed(saved?.event, "The event could not be confirmed");
      notify("Event recorded");
      notifyLeagueContentChanged(data.match.leagueId);
      reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not record the event", "error");
    } finally {
      setBusy(false);
    }
  };

  const recordSub = async () => {
    if (!matchId) return;
    if (!subTeam || !subOn || !subOff || !subMinute) {
      notify("Complete the substitution details", "error");
      return;
    }
    setBusy(true);
    try {
      const saved = await api<{ event?: { id: string }; substitution?: { id: string } }>(`/api/matches/${matchId}/events`, {
        method: "POST",
        body: {
          kind: "substitution",
          teamId: subTeam,
          playerOnId: subOn,
          playerOffId: subOff,
          minute: Number(subMinute),
        },
        idempotent: true,
      });
      setSubOn("");
      setSubOff("");
      setSubMinute("");
      assertConfirmed(saved?.substitution, "The substitution could not be confirmed");
      notify("Substitution recorded");
      if (data) notifyLeagueContentChanged(data.match.leagueId);
      reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not record the substitution", "error");
    } finally {
      setBusy(false);
    }
  };

  const deleteEvent = async (eventId: string) => {
    if (!matchId) return;
    try {
      const receipt = await api<{ deleted: boolean }>(`/api/matches/${matchId}/events?eventId=${encodeURIComponent(eventId)}`, { method: "DELETE" });
      if (receipt?.deleted !== true) throw new Error("The event removal could not be confirmed");
      notify("Event removed");
      if (data) notifyLeagueContentChanged(data.match.leagueId);
      reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not remove the event", "error");
    }
  };

  const reviewing = useRef(false);
  const flow = async (action: "submit" | "approve" | "reject" | "correct", score?: MatchScore, correctionReason?: string) => {
    if (!matchId || !data || reviewing.current || busy || statisticsDirty || (action === "approve" && !started)) return false;
    reviewing.current = true;
    setBusy(true);
    setFormError(null);
    try {
      const res = await api<{ status: string; match: { id: string; version: number; home_score: number; away_score: number } }>(
        `/api/matches/${matchId}/flow`, { method: "POST", body: {
          action, ...score, reason: action === "reject" ? rejectReason : correctionReason, version: data.match.version,
        } },
      );
      const expected = action === "submit" ? "pending" : action === "reject" ? "rejected" : "approved";
      if (res?.status !== expected || res.match?.id !== matchId || (score &&
          (res.match.home_score !== score.homeScore || res.match.away_score !== score.awayScore))) {
        throw new Error("The result could not be confirmed");
      }
      notify({ submit: "Submitted for approval", approve: "Approved — points calculated", reject: "Sent back to the organizer",
        correct: "Score corrected — points and standings updated" }[action]);
      if (action === "approve" || action === "correct") notifyLeagueContentChanged(data.match.leagueId);
      setShowReject(false);
      setRejectReason("");
      await reload();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Action failed";
      setFormError(message);
      notify(message, "error");
      return false;
    } finally {
      reviewing.current = false;
      setBusy(false);
    }
  };

  if (loading && !data)
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-24" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  if (error)
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <ErrorNote message={error} onRetry={reload} />
      </div>
    );
  if (!data) return null;

  const m = data.match;
  const editable = data.canEditEvents;

  const eventRoster = (teamId: string) =>
    data.lineups.filter((l) => l.teamId === teamId).map((l) => l.playerId)
      .map((id) => data.roster.find((p) => p.id === id))
      .filter(Boolean) as Player[];

  const teamName = (id: string) => data.teams.find((t) => t.id === id)?.name ?? "Team";

  const logoOf = (id: string) => data.teams.find((t) => t.id === id)?.crestUrl;
  const teamLabel = (id: string) => <RealTeamName name={teamName(id)} logo={logoOf(id)} />;
  const participants = (data.scoringLineups ?? data.lineups).flatMap((l) => {
    if (!l.player || ![m.teamAId, m.teamBId].includes(l.teamId) || (l.slot !== "starter" && !data.substitutions.some((sub) => sub.teamId === l.teamId && sub.playerOnId === l.playerId))) return [];
    return [{ id: l.playerId, teamId: l.teamId, name: l.player.fullName, position: data.statistics?.find((r) => r.playerId === l.playerId)?.position ?? l.matchPosition ?? l.player.position }];
  });
  const correctingStatistics = m.status === "approved" && m.homeScore != null && m.awayScore != null;
  const canRecordStatistics = started && data.canOrganize && data.statistics != null && (editable || correctingStatistics);
  const eventOptions = [...(editable ? EVENT_TYPES : []), ...(canRecordStatistics ? ["saves", "defensiveContributions"] as const : [])];
  const eventChoice = eventOptions.some((type) => type === evType) ? evType : eventOptions[0];
  const statType = eventChoice === "saves" || eventChoice === "defensiveContributions" ? eventChoice : null;
  const eligibleParticipants = statType ? participants.filter((p) => p.teamId === evTeam && (statType !== "saves" || p.position === "GK")) : [];
  const statPlayer = eligibleParticipants.find((p) => p.id === evPlayer);
  const statRow = data.statistics?.find((p) => p.playerId === statPlayer?.id);
  const count = statType && statPlayer ? statCount ?? String(statRow?.[statType] ?? 0) : "";
  const validStat = /^\d{1,3}$/.test(count);

  const saveStatistic = async () => {
    if (savingStatistic.current || busy || !canRecordStatistics || !statType || !statPlayer || !statisticsDirty || !validStat
        || (correctingStatistics && !statReason.trim())) return;
    savingStatistic.current = true;
    setBusy(true); setStatError(null);
    try {
      // The RPC replaces the match's statistics atomically; retain every other saved count.
      const stats = (data.statistics ?? []).filter((s) => s.playerId !== statPlayer.id && (s.saves || s.defensiveContributions))
        .map(({ playerId, saves, defensiveContributions }) => ({ playerId, saves, defensiveContributions }));
      const updated = { playerId: statPlayer.id, saves: statRow?.saves ?? 0, defensiveContributions: statRow?.defensiveContributions ?? 0,
        [statType]: Number(count) };
      if (updated.saves || updated.defensiveContributions) stats.push(updated);
      const receipt = await api<{ matchId: string; version: number }>(`/api/matches/${m.id}/statistics`, {
        method: "PUT", body: { version: m.version, stats, ...(correctingStatistics ? { reason: statReason.trim() } : {}) },
      });
      if (receipt?.matchId !== m.id || receipt.version !== m.version + 1) throw new Error("The save could not be confirmed. Reload before retrying.");
      notifyLeagueContentChanged(m.leagueId);
      await reload();
      resetStatistic();
    } catch (error) {
      setStatError(error instanceof Error ? error.message : "Could not save match statistics");
    } finally {
      savingStatistic.current = false;
      setBusy(false);
    }
  };

  const reschedule = async () => {
    if (started || !newKickoff || busy) return;
    setBusy(true);
    try {
      const kickoff = new Date(newKickoff).toISOString();
      const result = await api<{ match: { id: string; kick_off: string } }>(`/api/matches/${m.id}`, { method: "PATCH", body: { kickOff: kickoff } });
      if (result?.match?.id !== m.id || Date.parse(result.match.kick_off) !== Date.parse(kickoff)) throw new Error("The kickoff change could not be confirmed");
      await reload(); setRescheduling(false); setNewKickoff(""); notify("Kickoff updated");
    } catch (e) { notify(e instanceof Error ? e.message : "Could not update kickoff", "error"); }
    finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <Link href="/matches" className="slate mb-4 inline-flex items-center gap-1.5 hover:text-green">
        <ArrowLeft className="h-3.5 w-3.5" /> Match centre
      </Link>

      <PageHeader
        eyebrow={`${new Date(m.kickOff).toLocaleString(undefined, {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })} · v${m.version}`}
        title={<span className="flex flex-wrap items-center gap-2">{teamLabel(m.teamAId)} <span>v</span> {teamLabel(m.teamBId)}</span>}
        subtitle={m.durationMinutes == null ? m.title : `${m.title} · ${m.durationMinutes} min`}
        actions={<Badge tone={STATUS_TONE[m.status] ?? "neutral"}>{m.status}</Badge>}
      />

      {m.status === "approved" && data.canOrganize && <p className="mb-4 text-sm text-sage">You can update the real team lineups. These edits do not change the approved scoring record.</p>}
      {!started && editable && <div className="mb-4 flex flex-wrap items-end gap-2">
        {rescheduling ? <><Field label="New kickoff (local time)"><TextInput type="datetime-local" value={newKickoff} onChange={(e) => setNewKickoff(e.target.value)} /></Field>
          <Button size="sm" onClick={reschedule} disabled={!newKickoff || busy}>Save kickoff</Button><Button variant="ghost" size="sm" onClick={() => setRescheduling(false)}>Cancel</Button></>
          : <Button size="sm" variant="outline" onClick={() => setRescheduling(true)}>Change kickoff</Button>}
      </div>}
      {data.statistics && <MatchStatistics finalized={m.status === "approved"}
        players={data.roster.map((p) => ({ id: p.id, name: p.fullName }))} saved={data.statistics} bonusAwards={data.bonusAwards} />}
      <MatchResult key={`result:${m.id}:${m.version}`} match={m} home={teamName(m.teamAId)} away={teamName(m.teamBId)} homeLogo={logoOf(m.teamAId)} awayLogo={logoOf(m.teamBId)}
        canManage={data.canOrganize} busy={busy} unsavedStatistics={statisticsDirty} onSave={flow} />

      {m.status === "rejected" && m.rejectionReason && (
        <div className="mb-5 rounded-lg border border-card-r/40 bg-card-r/10 px-4 py-3.5">
          <Slate className="text-card-r">Rejected by the League Leader</Slate>
          <p className="mt-1 text-[14px] text-chalk">{m.rejectionReason}</p>
        </div>
      )}

      {/* review bar */}
      {data.canApprove && m.status === "pending" && (
        <div className="mb-5 rounded-xl border border-card-y/45 bg-card-y/8 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Timer className="h-4 w-4 shrink-0 text-card-y" />
            <span className="flex-1 text-[14px] text-chalk">
              Submitted {m.submittedAt ? new Date(m.submittedAt).toLocaleString() : ""} — awaiting your
              decision. {m.homeScore == null || m.awayScore == null ? "Send this match back so both scores can be recorded."
                : timeToKickoff == null ? "Waiting to confirm the scheduled kickoff."
                  : !started ? "You can approve this match once its scheduled kickoff time has been reached."
                    : "Approval finalizes provisional points and records the official result."}
            </span>
            <Button variant="primary" onClick={() => flow("approve")} loading={busy} disabled={!started || m.homeScore == null || m.awayScore == null}>
              <CheckCircle2 className="h-4 w-4" /> Approve
            </Button>
            <Button variant="danger" onClick={() => setShowReject((s) => !s)}>
              <XCircle className="h-4 w-4" /> Reject
            </Button>
          </div>
          {showReject && (
            <div className="mt-4 border-t border-card-y/25 pt-4">
              <Field label="Rejection reason" hint="Required — the organizer sees this.">
                <TextInput
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Wrong player on the second goal"
                />
              </Field>
              <div className="mt-3 flex justify-end gap-2.5">
                <Button variant="ghost" onClick={() => setShowReject(false)}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={() => flow("reject")} loading={busy} disabled={!rejectReason.trim()}>
                  Send back
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Man of the match: leader/organizer picks after the match is approved */}
      {m.status === "approved" && data.canOrganize && (
        <MotmPanel
          leagueId={m.leagueId}
          matchId={m.id}
          candidates={participants.map((p) => ({ id: p.id, name: p.name }))}
          onSaved={() => void reload()}
        />
      )}

      {/* tabs */}
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {([
          ["lineups", "Line-ups"],
          ["events", `Events (${data.events.length})`],
          ["history", "History"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`relative whitespace-nowrap px-4 py-3 text-[13.5px] font-semibold uppercase tracking-[0.1em] transition-colors ${
              tab === key ? "text-green" : "text-sage hover:text-chalk"
            }`}
          >
            {label}
            {tab === key && <span className="absolute inset-x-3 bottom-0 h-0.5 bg-green" />}
          </button>
        ))}
      </div>

      {formError && <div className="mb-4"><ErrorNote message={formError} /></div>}

      {/* ---------------- line-ups ---------------- */}
      {tab === "lineups" && (
        <div className="space-y-5">
          {[m.teamAId, m.teamBId].map((teamId) => {
            const state = sel[teamId] ?? { starters: [], subs: [] };
            const roster = [...(rosterByTeam[teamId] ?? []), ...data.roster.filter((p) => p.teamId !== teamId
              && (state.starters.includes(p.id) || state.subs.includes(p.id)))];
            const locked = !data.canOrganize;
            const lineupRules = validateLineup(data.rules, roster.filter((p) => state.starters.includes(p.id)), roster.filter((p) => state.subs.includes(p.id)));
            const allowed = (p: Player) => p.teamId === teamId && canSelectPlayer(p);
            const eligible = roster.filter((p) => state.starters.includes(p.id) || state.subs.includes(p.id)).every(allowed);
            const keeperIn = state.starters.some(
              (id) => data.roster.find((p) => p.id === id)?.position === "GK",
            );
            // Change detection against the persisted lineup (normalized value
            // comparison): the button turns into a green "saved" state only
            // when the editor matches what the server has confirmed.
            const savedSel = savedSelections[teamId] ?? EMPTY_SELECTION;
            const hasSavedLineup = savedSel.starters.length > 0 || savedSel.subs.length > 0;
            const dirty = lineupDirty(teamId);
            const savedGreen = !locked && hasSavedLineup && !dirty;

            return (
              <Panel key={teamId} className="p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-[22px] text-chalk">{teamLabel(teamId)}</h2>
                    <div className="num mt-1 flex gap-3 text-[11.5px] uppercase tracking-[0.12em]">
                      <span className={state.starters.length === data.rules.starters ? "text-green" : "text-card-y"}>
                        XI {state.starters.length}/{data.rules.starters}
                      </span>
                      <span className={state.subs.length <= data.rules.subsCount ? "text-sage" : "text-card-r"}>
                        Bench {state.subs.length}/{data.rules.subsCount}
                      </span>
                      <span className={keeperIn ? "text-sage" : "text-card-y"}>
                        {keeperIn ? "GK set" : "No goalkeeper"}
                      </span>
                    </div>
                  </div>
                  {savedGreen ? (
                    <Button
                      size="sm"
                      disabled
                      title="This line-up is saved"
                      className="border border-[#34e07f] bg-[#34e07f] text-[#04120a] shadow-[0_0_0_1px_rgba(52,224,127,0.4),0_8px_24px_-12px_rgba(52,224,127,0.75)] disabled:opacity-100"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Lineup Saved
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => saveLineup(teamId)}
                      loading={busy}
                      disabled={locked || busy || statisticsDirty || !dirty || !lineupRules.ok || !eligible}
                    >
                      <Save className="h-3.5 w-3.5" /> Save line-up
                    </Button>
                  )}
                </div>

                {roster.length === 0 ? (
                  <p className="text-[13.5px] text-sage-dim">
                    No players registered for this team yet.
                  </p>
                ) : (
                  <ul className="grid gap-1.5 sm:grid-cols-2">
                    {roster.map((p) => {
                      const isStarter = state.starters.includes(p.id);
                      const isSub = state.subs.includes(p.id);
                      return (
                        <li
                          key={p.id}
                          className={`flex items-center gap-2.5 rounded-md border px-2.5 py-2 transition-colors ${
                            isStarter
                              ? "border-green/45 bg-green/8"
                              : isSub
                                ? "border-card-y/40 bg-card-y/8"
                                : "border-line bg-pitch-900"
                          }`}
                        >
                          <Avatar name={p.fullName} url={p.photoUrl} size={26} decorative />
                          <span className="num w-7 text-[10.5px] uppercase text-green-glow/75">{p.position}</span>
                          <span className="min-w-0 flex-1 truncate text-[13.5px] text-chalk">{p.fullName}{!allowed(p) && <span className="block text-xs text-card-y">{p.teamId !== teamId ? "Not on this team" : p.status !== "active" ? "Archived" : p.availability}</span>}</span>
                          <div className="flex gap-1">
                            <button
                              disabled={locked || busy || (!isStarter && !allowed(p))}
                              aria-pressed={isStarter}
                              onClick={() => assign(teamId, p.id, isStarter ? null : "starter")}
                              className={`rounded border px-2 py-1 text-[10.5px] font-bold uppercase tracking-[0.1em] transition-colors ${
                                isStarter ? "border-green bg-green text-[#04120a]" : "border-line text-sage hover:border-green hover:text-green"
                              } disabled:opacity-50`}
                            >
                              XI
                            </button>
                            <button
                              disabled={locked || busy || (!isSub && !allowed(p))}
                              aria-pressed={isSub}
                              onClick={() => assign(teamId, p.id, isSub ? null : "sub")}
                              className={`rounded border px-2 py-1 text-[10.5px] font-bold uppercase tracking-[0.1em] transition-colors ${
                                isSub ? "border-card-y bg-card-y text-[#1a1400]" : "border-line text-sage hover:border-card-y hover:text-card-y"
                              } disabled:opacity-50`}
                            >
                              Sub
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {!locked && (!lineupRules.ok || !eligible) && (
                  <p className="mt-3 text-[13px] text-card-y">
                    {!lineupRules.ok ? lineupRules.errors.join(" ") : "Remove unavailable players before saving."}
                  </p>
                )}
              </Panel>
            );
          })}
        </div>
      )}

      {/* ---------------- events ---------------- */}
      {tab === "events" && (
        <div className="grid gap-5 lg:grid-cols-[1fr_1.15fr]">
          <div className="space-y-5">
            <Panel className="p-4">
              <Slate className="mb-3 block">Record an event</Slate>
              {!eventOptions.length ? (
                <p className="text-[13.5px] text-sage">Event entry is not available for this match.</p>
              ) : (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Team">
                      <Select value={evTeam} disabled={busy} onChange={(e) => { setEvTeam(e.target.value); setEvPlayer(""); setEvAssist(""); resetStatistic(); }}>
                        {[m.teamAId, m.teamBId].map((t) => <option key={t} value={t}>{teamName(t)}</option>)}
                      </Select>
                    </Field>
                    <Field label="Event">
                      <Select value={eventChoice} disabled={busy} onChange={(e) => { setEvType(e.target.value); resetStatistic(); }}>
                        {eventOptions.map((type) => <option key={type} value={type}>
                          {type === "saves" || type === "defensiveContributions" ? STAT_LABEL[type] : EVENT_LABEL[type] ?? type}
                        </option>)}
                      </Select>
                    </Field>
                  </div>
                  <Field label="Player">
                    <Select value={statType ? statPlayer?.id ?? "" : evPlayer} disabled={busy}
                      onChange={(e) => { setEvPlayer(e.target.value); if (e.target.value === evAssist) setEvAssist(""); resetStatistic(); }}>
                      <option value="">Select player</option>
                      {statType ? eligibleParticipants.map((p) => <option key={p.id} value={p.id}>{p.position} · {p.name}</option>)
                        : eventRoster(evTeam).map((p) => <option key={p.id} value={p.id}>{p.position} · {p.fullName}</option>)}
                    </Select>
                  </Field>

                  {statType ? <>
                    {!eligibleParticipants.length && <p className="text-sm text-sage">{statType === "saves" ? "No participating goalkeeper for this team." : "No participants for this team yet."}</p>}
                    {statPlayer && <Field label={statType === "saves" ? "Number of saves" : "Number of defensive contributions"}
                      hint={`Enter the total for this match, replacing the saved number.${statType === "defensiveContributions" && statPlayer.position === "GK" ? " Goalkeepers do not earn contribution points." : ""}`}
                      error={!validStat ? "Use a whole number from 0 to 999." : undefined}>
                      <TextInput aria-label={statType === "saves" ? "Number of saves" : "Number of defensive contributions"}
                        inputMode="numeric" maxLength={3} value={count} disabled={busy} onChange={(e) => { setStatCount(e.target.value); setStatError(null); }} />
                    </Field>}
                    {correctingStatistics && statisticsDirty && <Field label="Statistics correction reason">
                      <TextInput maxLength={400} value={statReason} disabled={busy} onChange={(e) => setStatReason(e.target.value)} />
                    </Field>}
                    {statError && <ErrorNote message={statError} />}
                    {statisticsDirty && <div className="flex flex-wrap gap-2">
                      <Button onClick={saveStatistic} loading={busy} disabled={!statPlayer || !statisticsDirty || !validStat || (correctingStatistics && !statReason.trim())}>
                        {correctingStatistics ? "Save statistics correction" : "Save statistics"}
                      </Button>
                      <Button variant="ghost" disabled={busy} onClick={resetStatistic}>Discard changes</Button>
                    </div>}
                  </> : <>
                    {eventChoice === "goal" && <Field label="Assist" hint="Optional">
                      <Select value={evAssist} disabled={busy} onChange={(e) => setEvAssist(e.target.value)}>
                        <option value="">No assist</option>
                        {eventRoster(evTeam).filter((p) => p.id !== evPlayer).map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                      </Select>
                    </Field>}
                    <Field label="Note" hint="Optional">
                      <TextInput value={evNote} disabled={busy} onChange={(e) => setEvNote(e.target.value)} placeholder="Free kick from 20 yards" />
                    </Field>
                    <Button onClick={() => recordEvent(eventChoice)} loading={busy} className="w-full">Add event</Button>
                  </>}
                </div>
              )}
            </Panel>

            <Panel className="p-4">
              <Slate className="mb-3 block">Record a substitution</Slate>
              {!editable ? (
                <p className="text-[13.5px] text-sage">Locked while the match is {m.status}.</p>
              ) : (
                <div className="space-y-3">
                  <Field label="Team">
                    <Select value={subTeam} onChange={(e) => setSubTeam(e.target.value)}>
                      {[m.teamAId, m.teamBId].map((t) => (
                        <option key={t} value={t}>
                          {teamName(t)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Player on">
                      <Select value={subOn} onChange={(e) => setSubOn(e.target.value)}>
                        <option value="">Select</option>
                        {(rosterByTeam[subTeam] ?? []).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.fullName}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Player off">
                      <Select value={subOff} onChange={(e) => setSubOff(e.target.value)}>
                        <option value="">Select</option>
                        {(rosterByTeam[subTeam] ?? []).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.fullName}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Field label="Minute">
                    <TextInput
                      type="number"
                      min={0}
                      max={200}
                      value={subMinute}
                      onChange={(e) => setSubMinute(e.target.value)}
                      placeholder="60"
                    />
                  </Field>
                  <Button variant="outline" onClick={recordSub} loading={busy} className="w-full">
                    Add substitution
                  </Button>
                </div>
              )}
            </Panel>
          </div>

          <Panel className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <Slate>Event log</Slate>
              <span className="num text-[12px] text-sage-dim">
                {data.events.length} events · {data.substitutions.length} subs
              </span>
            </div>

            {data.events.length === 0 && data.substitutions.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-[13.5px] text-sage-dim">
                No events recorded yet.
              </p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {[...data.events]
                  .map((e) => (
                    <li key={e.id} className="flex items-center gap-3 py-2.5">
                      <span className="w-20 shrink-0">
                        <Badge
                          tone={
                            e.eventType === "red_card"
                              ? "danger"
                              : e.eventType === "yellow_card"
                                ? "warn"
                                : e.eventType === "goal" || e.eventType === "penalty_saved"
                                  ? "live"
                                  : "neutral"
                          }
                        >
                          {EVENT_LABEL[e.eventType] ?? e.eventType}
                        </Badge>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] text-chalk">
                          {e.player?.fullName ?? "Unknown"}
                          {e.assistPlayer && <span className="text-sage"> — assist {e.assistPlayer.fullName}</span>}
                        </span>
                        <span className="block truncate text-[11.5px] text-sage-dim">
                          {teamLabel(e.teamId)}
                          {e.note ? ` · ${e.note}` : ""}
                        </span>
                      </span>
                      {editable && (
                        <button
                          onClick={() => deleteEvent(e.id)}
                          className="rounded border border-line p-1.5 text-sage transition-colors hover:border-card-r hover:text-card-r"
                          aria-label="Delete event"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </li>
                  ))}
                {data.substitutions.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 py-2.5">
                    <span className="num w-10 shrink-0 text-[13px] text-green">{s.minute}&apos;</span>
                    <span className="w-20 shrink-0">
                      <Badge tone="info">Sub</Badge>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] text-chalk">
                        {s.playerOn?.fullName ?? "?"} on · {s.playerOff?.fullName ?? "?"} off
                      </span>
                      <span className="block truncate text-[11.5px] text-sage-dim">{teamLabel(s.teamId)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {m.status !== "approved" && <section aria-label="Live player points" className="mt-4 border-t border-line pt-3">
              <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-chalk">Live player points</h3><Badge tone="warn">Provisional</Badge></div>
              <p className="mt-1 text-xs text-sage">Scoring events count for recorded participants as soon as they’re saved. Final-result points and bonuses are added on approval.</p>
              {!!data.livePlayerPoints?.length && <ul className="mt-2 space-y-1" aria-live="polite">{data.livePlayerPoints.map((p) => <li key={p.playerId} className="flex justify-between gap-3 text-sm text-chalk">
                <span>{data.lineups.find((l) => l.playerId === p.playerId)?.player?.fullName ?? "Player"}</span>
                <span className="num text-card-y">{p.points} pts</span>
              </li>)}</ul>}
            </section>}
          </Panel>
        </div>
      )}

      {/* ---------------- history ---------------- */}
      {tab === "history" && (
        <Panel className="p-5">
          <Slate className="mb-4 block">Match status history</Slate>
          {!data.approvals.length ? (
            <p className="text-[13.5px] text-sage-dim">No workflow actions yet — this match is a draft.</p>
          ) : (
            <ol className="relative space-y-5 border-l border-line pl-5">
              {data.approvals.map((a) => (
                <li key={a.id} className="relative">
                  <span
                    className={`absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-pitch-850 ${
                      a.action === "approved" ? "bg-green" : a.action === "rejected" ? "bg-card-r" : "bg-card-y"
                    }`}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-[17px] font-bold uppercase text-chalk">{a.action}</span>
                    <Badge tone="neutral">v{a.version}</Badge>
                    <span className="num text-[11.5px] text-sage-dim">{new Date(a.createdAt).toLocaleString()}</span>
                  </div>
                  {a.scoreChange?.statisticsCorrected ? <p className="mt-1 text-sm text-chalk">Match statistics corrected; scores recalculated.</p> : a.scoreChange && <p className="mt-1 text-sm text-chalk">{a.scoreChange.previousHomeScore}–{a.scoreChange.previousAwayScore} corrected to {a.scoreChange.homeScore}–{a.scoreChange.awayScore}</p>}
                  {a.reason && <p className="mt-1 text-[13.5px] text-sage">{a.reason}</p>}
                </li>
              ))}
            </ol>
          )}

          {m.decidedAt && (
            <div className="mt-5 border-t border-line pt-4 text-[13.5px] text-sage">
              Final decision recorded {new Date(m.decidedAt).toLocaleString()} · status{" "}
              <span className="text-chalk">{m.status}</span>
            </div>
          )}

          {m.status === "approved" && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-green/40 bg-green/8 px-4 py-3">
              <CheckCircle2 className="h-4 w-4 text-green" />
              <span className="text-[14px] text-chalk">Result is official — points and standings updated.</span>
              <Link href={`/points?matchId=${m.id}`} className="slate text-green hover:text-green-glow">
                View breakdown
              </Link>
            </div>
          )}
        </Panel>
      )}

      {league && (
        <p className="mt-6 text-[12.5px] text-sage-dim">
          League: {league.name} · format {league.format} · match id {m.id.slice(0, 8)}
        </p>
      )}
      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}
