"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { Archive, Pencil, Plus, ShieldAlert, UserSquare2 } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  Panel,
  SearchBox,
  Select,
  Skeleton,
  Slate,
  TextInput,
  Toast,
} from "@/components/ui";
import { useActiveLeague, useLeague } from "@/components/LeagueContext";
import { api, assertConfirmed, useApi } from "@/lib/client/api";
import { AVAILABILITY, POSITIONS, type Position } from "@/lib/domain";

type Player = {
  id: string;
  leagueId: string;
  fullName: string;
  position: Position;
  photoUrl: string | null;
  shirtNumber: number | null;
  availability: string;
  status: string;
  teamId: string | null;
  description: string | null;
};

type Team = { id: string; leagueId: string; name: string };
type Data = { players: Player[]; teams: Team[]; total: number };
const PLAYER_BATCH = 50;

type Draft = {
  fullName: string;
  position: Position;
  teamId: string;
  shirtNumber: string;
  photoUrl: string;
  availability: string;
  description: string;
};

const EMPTY: Draft = {
  fullName: "",
  position: "MID",
  teamId: "",
  shirtNumber: "",
  photoUrl: "",
  availability: "available",
  description: "",
};

export default function PlayersPage() {
  const { league, loading: leagueLoading } = useActiveLeague();
  const { isLeader } = useLeague();
  const { data, loading, error, reload, setData } = useApi<Data>(
    league ? `/api/leagues/${league.id}/players?archived=1` : null,
    [league?.id],
  );

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [visible, setVisible] = useState(PLAYER_BATCH);
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [position, setPosition] = useState<"ALL" | Position>("ALL");
  const [teamId, setTeamId] = useState("ALL");
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [teamModal, setTeamModal] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);
  const [detail, setDetail] = useState<Player | null>(null);

  const filtered = useMemo(() => {
    const list = data?.players ?? [];
    const q = deferredQuery.trim().toLowerCase();
    return list.filter((p) => {
      if (!showArchived && p.status === "archived") return false;
      if (position !== "ALL" && p.position !== position) return false;
      if (teamId !== "ALL" && p.teamId !== teamId) return false;
      if (q && !p.fullName.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, deferredQuery, position, teamId, showArchived]);

  const updatePlayer = (player: Player) => setData((old) => {
    if (!old) return old;
    const players = [...old.players.filter((p) => p.id !== player.id), player]
      .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.id.localeCompare(b.id));
    return { ...old, players, total: players.length };
  });

  const savePlayer = async () => {
    if (!league || !draft) return;
    setSaving(true);
    try {
      const body = {
        fullName: draft.fullName.trim(),
        position: draft.position,
        teamId: draft.teamId || null,
        shirtNumber: draft.shirtNumber ? Number(draft.shirtNumber) : null,
        photoUrl: draft.photoUrl.trim() || null,
        availability: draft.availability,
        description: draft.description.trim() || null,
      };
      const route = `/api/leagues/${league.id}/players${editingId ? `/${editingId}` : ""}`;
      const res = await api<{ player: Player }>(route, { method: editingId ? "PATCH" : "POST", body, idempotent: !editingId });
      const saved = assertConfirmed(res?.player, "The saved player could not be confirmed", league.id);
      if (editingId && saved.id !== editingId) throw new Error("The saved player ID did not match");
      updatePlayer(saved);
      if (!editingId) {
        setQuery(""); setPosition("ALL"); setTeamId("ALL"); setVisible(PLAYER_BATCH); setJustCreated(saved.id);
      }
      setToast({ message: editingId ? "Player updated" : "Player added", tone: "ok" });
      setDraft(null);
      setEditingId(null);
    } catch (err) {
      const details = (err as { details?: unknown }).details;
      setToast({
        message: Array.isArray(details)
          ? (details as unknown[])
              .map((d) =>
                typeof d === "string" ? d : Object.values(d as Record<string, string[]>).flat().join(" "),
              )
              .join(" ")
          : err instanceof Error
            ? err.message
            : "Could not save player",
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const archive = async (player: Player) => {
    if (!league) return;
    try {
      const restoring = player.status === "archived";
      const res = await api<{ player: Player }>(`/api/leagues/${league.id}/players/${player.id}`, restoring
        ? { method: "PATCH", body: { status: "active" } } : { method: "DELETE" });
      const saved = assertConfirmed(res?.player, "The player change could not be confirmed", league.id);
      if (saved.id !== player.id || saved.status !== (restoring ? "active" : "archived")) throw new Error("The player status did not change");
      updatePlayer(saved);
      setToast({ message: restoring ? "Player restored" : "Player archived — history preserved", tone: "ok" });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Action failed", tone: "error" });
    }
  };

  const createTeam = async () => {
    if (!league || teamName.trim().length < 2) return;
    setSaving(true);
    try {
      const res = await api<{ team: Team }>(`/api/leagues/${league.id}/teams`, {
        method: "POST",
        body: { name: teamName.trim() },
        idempotent: true,
      });
      const saved = assertConfirmed(res?.team, "The saved team could not be confirmed", league.id);
      setData((old) => old ? { ...old, teams: [...old.teams.filter((t) => t.id !== saved.id), saved]
        .sort((a, b) => a.name.localeCompare(b.name)) } : old);
      setTeamName("");
      setTeamModal(false);
      setToast({ message: "Team added", tone: "ok" });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Could not add team", tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  if (leagueLoading || (loading && !data))
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[74px] rounded-lg" />
          ))}
        </div>
      </div>
    );
  if (error)
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <ErrorNote message={error} onRetry={reload} />
      </div>
    );

  const teamsById = new Map(data?.teams.map((t) => [t.id, t.name]));
  const teamNameOf = (id: string | null) => (id && teamsById.get(id)) || "Free agent";
  const newPlayer = filtered.find((p) => p.id === justCreated);
  const shown = newPlayer ? [newPlayer, ...filtered.filter((p) => p.id !== newPlayer.id).slice(0, visible - 1)] : filtered.slice(0, visible);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow={`${league?.name} · league-scoped database`}
        title="Players"
        subtitle="Every league registers its own players. Nothing here is shared with any other league."
        actions={
          isLeader ? (
            <>
              <Button variant="outline" onClick={() => setTeamModal(true)}>
                Add team
              </Button>
              <Button
                onClick={() => {
                  setDraft({ ...EMPTY });
                  setEditingId(null);
                }}
              >
                <Plus className="h-4 w-4" /> Add player
              </Button>
            </>
          ) : undefined
        }
      />

      {!isLeader && (
        <div className="mb-5 flex items-center gap-2.5 rounded-lg border border-line bg-pitch-900 px-4 py-3 text-[13.5px] text-sage">
          <ShieldAlert className="h-4 w-4 shrink-0 text-sage-dim" />
          Only the League Leader can add or edit this league's players.
        </div>
      )}

      <div className="mb-4 flex flex-col gap-2.5 sm:flex-row">
        <div className="flex-1">
          <SearchBox value={query} onChange={setQuery} placeholder="Search players…" />
        </div>
        <div className="sm:w-44">
          <Select value={position} onChange={(e) => setPosition(e.target.value as Position | "ALL")}>
            <option value="ALL">All positions</option>
            {POSITIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </div>
        <div className="sm:w-52">
          <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="ALL">All teams</option>
            {(data?.teams ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex h-11 cursor-pointer items-center gap-2 rounded-lg border border-line bg-pitch-900 px-3 text-[13px] text-sage">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="h-4 w-4 accent-[#31E07D]"
          />
          Archived
        </label>
      </div>

      {!data?.players.length ? (
        <EmptyState
          title="No players registered"
          body="Create this league's teams first, then register players with a position, shirt number and photo."
          action={isLeader ? undefined : { label: "Dashboard", href: "/dashboard" }}
          icon={<UserSquare2 className="h-5 w-5" />}
        />
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-5 py-12 text-center text-[14px] text-sage">
          No players match those filters.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((p) => (
            <li
              key={p.id}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                p.status === "archived" ? "border-line bg-pitch-900 opacity-60" : "border-line bg-pitch-850 hover:border-green-dim"
              }`}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-pitch-900 font-display text-[15px] font-bold text-green">
                {p.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img loading="lazy" decoding="async" src={p.photoUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  p.fullName.slice(0, 1)
                )}
              </span>
              <button onClick={() => setDetail(p)} className="min-w-0 flex-1 text-left">
                <div className="truncate text-[14.5px] font-semibold text-chalk">{p.fullName}</div>
                <div className="num mt-0.5 flex flex-wrap gap-2 text-[11.5px] uppercase tracking-[0.1em] text-sage-dim">
                  <span className="text-green-glow/80">{p.position}</span>
                  <span>#{p.shirtNumber ?? "—"}</span>
                  <span className="normal-case tracking-normal">{teamNameOf(p.teamId)}</span>
                </div>
              </button>

              <Badge tone={p.availability === "available" ? "neutral" : "danger"}>{p.availability}</Badge>
              {p.status === "archived" && <Badge tone="warn">archived</Badge>}

              {isLeader && (
                <div className="flex gap-1.5">
                  <button
                    onClick={() => {
                      setEditingId(p.id);
                      setDraft({
                        fullName: p.fullName,
                        position: p.position,
                        teamId: p.teamId ?? "",
                        shirtNumber: p.shirtNumber ? String(p.shirtNumber) : "",
                        photoUrl: p.photoUrl ?? "",
                        availability: p.availability,
                        description: p.description ?? "",
                      });
                    }}
                    className="rounded border border-line p-1.5 text-sage transition-colors hover:border-green hover:text-green"
                    aria-label="Edit player"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => archive(p)}
                    className="rounded border border-line p-1.5 text-sage transition-colors hover:border-card-y hover:text-card-y"
                    aria-label={p.status === "archived" ? "Restore player" : "Archive player"}
                  >
                    {p.status === "archived" ? <UserSquare2 className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {filtered.length > visible && (
        <Button variant="outline" className="mt-4" onClick={() => setVisible((n) => n + PLAYER_BATCH)}>
          Show more players ({visible}/{filtered.length})
        </Button>
      )}

      {/* player editor */}
      <Modal
        open={Boolean(draft)}
        onClose={() => setDraft(null)}
        title={editingId ? "Edit player" : "Add player"}
      >
        {draft && (
          <div className="space-y-4">
            <Field label="Full name">
              <TextInput
                value={draft.fullName}
                onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
                placeholder="Player name"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Position">
                <Select
                  value={draft.position}
                  onChange={(e) => setDraft({ ...draft, position: e.target.value as Position })}
                >
                  {POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Shirt number">
                <TextInput
                  type="number"
                  min={1}
                  max={99}
                  value={draft.shirtNumber}
                  onChange={(e) => setDraft({ ...draft, shirtNumber: e.target.value })}
                  placeholder="1–99"
                />
              </Field>
              <Field label="Team">
                <Select
                  value={draft.teamId}
                  onChange={(e) => setDraft({ ...draft, teamId: e.target.value })}
                >
                  <option value="">Free agent</option>
                  {(data?.teams ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Availability">
                <Select
                  value={draft.availability}
                  onChange={(e) => setDraft({ ...draft, availability: e.target.value })}
                >
                  {AVAILABILITY.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Photo URL" hint="Optional. A crest-style initial is used when empty.">
              <TextInput
                value={draft.photoUrl}
                onChange={(e) => setDraft({ ...draft, photoUrl: e.target.value })}
                placeholder="https://…"
              />
            </Field>
            <Field label="Description" hint="Optional note shown in the player panel.">
              <TextInput
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="Left-footed, plays on the right"
              />
            </Field>
            <div className="flex justify-end gap-2.5 pt-1">
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button onClick={savePlayer} loading={saving} disabled={draft.fullName.trim().length < 2}>
                {editingId ? "Save changes" : "Add player"}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* add team */}
      <Modal open={teamModal} onClose={() => setTeamModal(false)} title="Add a real team" width="max-w-sm">
        <div className="space-y-4">
          <Field label="Team name">
            <TextInput value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Saturday Reds" />
          </Field>
          <div className="flex justify-end gap-2.5">
            <Button variant="ghost" onClick={() => setTeamModal(false)}>
              Cancel
            </Button>
            <Button onClick={createTeam} loading={saving} disabled={teamName.trim().length < 2}>
              Add team
            </Button>
          </div>
        </div>
      </Modal>

      {/* player detail */}
      {detail && (
        <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-6">
          <button className="absolute inset-0 cursor-default" aria-label="Close" onClick={() => setDetail(null)} />
          <div className="animate-rise relative w-full max-w-md rounded-t-2xl border border-line bg-pitch-850 p-5 sm:rounded-xl">
            <div className="flex items-center gap-4">
              <span className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full border border-green-dim bg-pitch-900 font-display text-2xl font-bold text-green">
                {detail.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img loading="lazy" decoding="async" src={detail.photoUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  detail.fullName.slice(0, 1)
                )}
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-2xl text-chalk">{detail.fullName}</h2>
                <div className="num mt-1 flex gap-3 text-[12px] uppercase tracking-[0.1em]">
                  <span className="text-green">{detail.position}</span>
                  <span className="text-sage">#{detail.shirtNumber ?? "—"}</span>
                </div>
              </div>
            </div>
            <dl className="mt-5 space-y-2.5 border-t border-line pt-4 text-[14px]">
              <div className="flex justify-between">
                <dt className="slate">Team</dt>
                <dd className="text-chalk">{teamNameOf(detail.teamId)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="slate">Availability</dt>
                <dd className="capitalize text-chalk">{detail.availability}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="slate">Status</dt>
                <dd className="capitalize text-chalk">{detail.status}</dd>
              </div>
            </dl>
            {detail.description && (
              <p className="mt-4 rounded-lg bg-pitch-900 p-3 text-[13.5px] leading-relaxed text-sage">
                {detail.description}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2.5">
              <Button variant="ghost" onClick={() => setDetail(null)}>
                Close
              </Button>
              {isLeader && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditingId(detail.id);
                    setDraft({
                      fullName: detail.fullName,
                      position: detail.position,
                      teamId: detail.teamId ?? "",
                      shirtNumber: detail.shirtNumber ? String(detail.shirtNumber) : "",
                      photoUrl: detail.photoUrl ?? "",
                      availability: detail.availability,
                      description: detail.description ?? "",
                    });
                    setDetail(null);
                  }}
                >
                  <Pencil className="h-4 w-4" /> Edit
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      <Slate className="mt-6 block">
        {filtered.length} of {data?.players.length ?? 0} players shown
      </Slate>
      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}
