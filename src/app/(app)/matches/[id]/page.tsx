"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  Save,
  Timer,
  Trash2,
  XCircle,
} from "lucide-react";
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
import { notifyLeagueContentChanged } from "@/lib/client/league-updates";
import { api, assertConfirmed, useApi } from "@/lib/client/api";
import { lineupPayload, lineupSelection, type SavedLineupEntry, type LineupSelection } from "@/lib/match-lineup";
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
    kickOff: string;
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
  rules: LeagueRules;
  role: string;
  canOrganize: boolean;
  canEditEvents: boolean;
  canApprove: boolean;
  lineups: (LineupEntry & { player: Player | null })[];
  events: {
    id: string;
    teamId: string;
    playerId: string;
    assistPlayerId: string | null;
    eventType: string;
    minute: number;
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
  approvals: { id: string; action: string; actorId: string; reason: string | null; version: number; createdAt: string }[];
  roster: Player[];
  teams: { id: string; name: string }[];
};

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
  const [evMinute, setEvMinute] = useState("");
  const [evNote, setEvNote] = useState("");

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

  const lineupSaving = useRef(false);
  const saveLineup = async (teamId: string) => {
    if (!matchId || !data || lineupSaving.current) return;
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
    if (!matchId) return;
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

  const recordEvent = async () => {
    if (!matchId) return;
    if (!evTeam || !evPlayer || !evMinute) {
      notify("Team, player and minute are required", "error");
      return;
    }
    setBusy(true);
    try {
      const saved = await api<{ event?: { id: string }; substitution?: { id: string } }>(`/api/matches/${matchId}/events`, {
        method: "POST",
        body: {
          teamId: evTeam,
          playerId: evPlayer,
          assistPlayerId: evAssist || null,
          eventType: evType,
          minute: Number(evMinute),
          note: evNote || null,
        },
        idempotent: true,
      });
      setEvPlayer("");
      setEvAssist("");
      setEvNote("");
      assertConfirmed(saved?.event, "The event could not be confirmed");
      notify("Event recorded");
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
      await api(`/api/matches/${matchId}/events?eventId=${eventId}`, { method: "DELETE" });
      notify("Event removed");
      reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not remove the event", "error");
    }
  };

  const flow = async (action: "submit" | "approve" | "reject") => {
    if (!matchId || !data) return;
    setBusy(true);
    setFormError(null);
    try {
      const res = await api<{ status: string; pointsError?: string | null }>(
        `/api/matches/${matchId}/flow`,
        {
          method: "POST",
          body: { action, reason: action === "reject" ? rejectReason : undefined, version: data.match.version },
        },
      );
      if (res?.status !== (action === "submit" ? "pending" : action === "approve" ? "approved" : "rejected")) throw new Error("The result could not be confirmed");
      if (action === "approve" && res.pointsError) {
        notify(`Approved, but points failed: ${res.pointsError}`, "error");
      } else {
        notify(
          action === "submit"
            ? "Submitted for approval"
            : action === "approve"
              ? "Approved — points calculated"
              : "Sent back to the organizer",
        );
      }
      if (action === "approve") notifyLeagueContentChanged(data.match.leagueId);
      setShowReject(false);
      setRejectReason("");
      reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Action failed", "error");
    } finally {
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
        title={`${teamName(m.teamAId)} v ${teamName(m.teamBId)}`}
        subtitle={m.title}
        actions={
          <>
            <Badge tone={STATUS_TONE[m.status] ?? "neutral"}>{m.status}</Badge>
            {data.canOrganize && (m.status === "draft" || m.status === "rejected") && (
              <Button onClick={() => flow("submit")} loading={busy}>
                <ClipboardCheck className="h-4 w-4" /> Submit for review
              </Button>
            )}
          </>
        }
      />

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
              decision. Approval calculates fantasy points and rebuilds the table.
            </span>
            <Button variant="primary" onClick={() => flow("approve")} loading={busy}>
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
                  placeholder="Wrong minute on the second goal"
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
            const locked = m.status === "pending" || m.status === "approved" || !data.canOrganize;
            const lineupRules = validateLineup(data.rules, roster.filter((p) => state.starters.includes(p.id)), roster.filter((p) => state.subs.includes(p.id)));
            const allowed = (p: Player) => p.teamId === teamId && canSelectPlayer(p);
            const eligible = roster.filter((p) => state.starters.includes(p.id) || state.subs.includes(p.id)).every(allowed);
            const keeperIn = state.starters.some(
              (id) => data.roster.find((p) => p.id === id)?.position === "GK",
            );

            return (
              <Panel key={teamId} className="p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-[22px] text-chalk">{teamName(teamId)}</h2>
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => saveLineup(teamId)}
                    loading={busy}
                    disabled={locked || busy || !lineupRules.ok || !eligible}
                  >
                    <Save className="h-3.5 w-3.5" /> Save line-up
                  </Button>
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
              {!editable ? (
                <p className="text-[13.5px] text-sage">
                  Events are locked while the match is {m.status}. A rejected match reopens for
                  correction automatically.
                </p>
              ) : (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Team">
                      <Select value={evTeam} onChange={(e) => setEvTeam(e.target.value)}>
                        {[m.teamAId, m.teamBId].map((t) => (
                          <option key={t} value={t}>
                            {teamName(t)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Event">
                      <Select value={evType} onChange={(e) => setEvType(e.target.value)}>
                        {EVENT_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {EVENT_LABEL[t] ?? t}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Player">
                      <Select value={evPlayer} onChange={(e) => setEvPlayer(e.target.value)}>
                        <option value="">Select player</option>
                        {eventRoster(evTeam).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.position} · {p.fullName}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Minute">
                      <TextInput
                        type="number"
                        min={0}
                        max={200}
                        value={evMinute}
                        onChange={(e) => setEvMinute(e.target.value)}
                        placeholder="34"
                      />
                    </Field>
                  </div>

                  {evType === "goal" && (
                    <Field label="Assist" hint="Optional">
                      <Select value={evAssist} onChange={(e) => setEvAssist(e.target.value)}>
                        <option value="">No assist</option>
                        {eventRoster(evTeam)
                          .filter((p) => p.id !== evPlayer)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.fullName}
                            </option>
                          ))}
                      </Select>
                    </Field>
                  )}

                  <Field label="Note" hint="Optional">
                    <TextInput value={evNote} onChange={(e) => setEvNote(e.target.value)} placeholder="Free kick from 20 yards" />
                  </Field>

                  <Button onClick={recordEvent} loading={busy} className="w-full">
                    Add event
                  </Button>
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
                  .sort((a, b) => a.minute - b.minute)
                  .map((e) => (
                    <li key={e.id} className="flex items-center gap-3 py-2.5">
                      <span className="num w-10 shrink-0 text-[13px] text-green">{e.minute}&apos;</span>
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
                          {teamName(e.teamId)}
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
                      <span className="block truncate text-[11.5px] text-sage-dim">{teamName(s.teamId)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-4 border-t border-line pt-3 text-[12.5px] leading-relaxed text-sage-dim">
              Points are calculated from these events only after the League Leader approves the
              result, using this league&apos;s approved scoring rules.
            </p>
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
                  {a.reason && <p className="mt-1 text-[13.5px] text-card-r">{a.reason}</p>}
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
