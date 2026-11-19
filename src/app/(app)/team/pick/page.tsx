"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Minus, Search, ShieldAlert, UserPlus } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Panel,
  SearchBox,
  Select,
  Skeleton,
  Slate,
  Toast,
} from "@/components/ui";
import { useActiveLeague } from "@/components/LeagueContext";
import { api, useApi } from "@/lib/client/api";
import { suggestFormation, type LeagueRules, type Position, type SquadPlayer } from "@/lib/domain";

type PlayerRow = {
  id: string;
  fullName: string;
  position: Position;
  photoUrl: string | null;
  shirtNumber: number | null;
  availability: string;
  status: string;
  teamId: string | null;
  description: string | null;
};

type RosterResponse = {
  players: PlayerRow[];
  teams: { id: string; name: string }[];
  total: number;
};

type SquadResponse = {
  squad: { id: string; formation: string; captainId: string | null; viceCaptainId: string | null } | null;
  rules: LeagueRules;
  players: {
    playerId: string;
    slot: SquadPlayer["slot"];
    order: number;
    fullName: string;
    position: Position;
    photoUrl: string | null;
    shirtNumber: number | null;
    availability: string;
  }[];
};

const POSITION_TABS = ["ALL", "GK", "DEF", "MID", "FWD"] as const;

export default function PickPlayersPage() {
  const { league, loading: leagueLoading } = useActiveLeague();
  const router = useRouter();

  const roster = useApi<RosterResponse>(league ? `/api/leagues/${league.id}/players` : null, [league?.id]);
  const squad = useApi<SquadResponse>(league ? `/api/leagues/${league.id}/squad` : null, [league?.id]);

  const [selected, setSelected] = useState<{ playerId: string; slot: SquadPlayer["slot"]; order: number }[]>([]);
  const [formation, setFormation] = useState("1-2-1");
  const [captainId, setCaptainId] = useState<string | null>(null);
  const [viceId, setViceId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<(typeof POSITION_TABS)[number]>("ALL");
  const [teamId, setTeamId] = useState("ALL");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);
  const [detail, setDetail] = useState<PlayerRow | null>(null);

  const rules = squad.data?.rules;

  useEffect(() => {
    if (!squad.data) return;
    setSelected(
      squad.data.players.map((p) => ({ playerId: p.playerId, slot: p.slot, order: p.order })),
    );
    setFormation(squad.data.squad?.formation ?? "");
    setCaptainId(squad.data.squad?.captainId ?? null);
    setViceId(squad.data.squad?.viceCaptainId ?? null);
  }, [squad.data]);

  const counts = useMemo(() => {
    const starters = selected.filter((s) => s.slot === "starter").length;
    const subs = selected.filter((s) => s.slot === "sub").length;
    return { starters, subs, reserves: selected.length - starters - subs };
  }, [selected]);

  const selectedIds = useMemo(() => new Set(selected.map((s) => s.playerId)), [selected]);

  const filtered = useMemo(() => {
    const list = roster.data?.players ?? [];
    const q = query.trim().toLowerCase();
    return list.filter((p) => {
      if (position !== "ALL" && p.position !== position) return false;
      if (teamId !== "ALL" && p.teamId !== teamId) return false;
      if (q && !p.fullName.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [roster.data, query, position, teamId]);

  /**
   * Auto-assigns slots while filling: keeper first, then starters until the
   * format limit, then substitutes, then reserves.
   */
  const add = (player: PlayerRow) => {
    if (!rules) return;
    if (selected.length >= rules.squadSize) {
      setToast({ message: `A squad is exactly ${rules.squadSize} players`, tone: "error" });
      return;
    }
    if (selectedIds.has(player.id)) return;

    const starters = selected.filter((s) => s.slot === "starter");
    const subs = selected.filter((s) => s.slot === "sub");
    const hasKeeper = starters.some((s) => {
      const row = roster.data?.players.find((p) => p.id === s.playerId);
      return row?.position === "GK";
    });

    let slot: SquadPlayer["slot"] = "reserve";
    if (player.position === "GK" && !hasKeeper) slot = "starter";
    else if (starters.length < rules.starters) slot = "starter";
    else if (subs.length < rules.subsCount) slot = "sub";

    if (slot === "starter" && player.position === "GK" && hasKeeper) slot = "sub";
    // no room on the bench either → bench full, go to reserves
    if (slot === "sub" && subs.length >= rules.subsCount) slot = "reserve";
    if (slot === "starter" && starters.length >= rules.starters) slot = "reserve";

    const order =
      slot === "starter"
        ? starters.length
        : slot === "sub"
          ? subs.length
          : selected.length;

    setSelected((cur) => [...cur, { playerId: player.id, slot, order }]);
  };

  const remove = (playerId: string) => {
    setSelected((cur) => cur.filter((s) => s.playerId !== playerId));
    if (captainId === playerId) setCaptainId(null);
    if (viceId === playerId) setViceId(null);
  };

  const autoFill = () => {
    if (!rules || !roster.data) return;
    const needed = rules.squadSize - selected.length;
    if (needed <= 0) return;
    const pool = roster.data.players.filter((p) => !selectedIds.has(p.id) && p.status === "active");
    const next = [...selected];

    const pick = (predicate: (p: PlayerRow) => boolean) => {
      const hit = pool.find(predicate);
      if (!hit) return false;
      pool.splice(pool.indexOf(hit), 1);
      const starters = next.filter((s) => s.slot === "starter");
      const subs = next.filter((s) => s.slot === "sub");
      const hasKeeper = starters.some((s) => roster.data!.players.find((p) => p.id === s.playerId)?.position === "GK");
      let slot: SquadPlayer["slot"] = "reserve";
      if (hit.position === "GK" && !hasKeeper) slot = "starter";
      else if (starters.length < rules.starters) slot = "starter";
      else if (subs.length < rules.subsCount) slot = "sub";
      const order =
        slot === "starter" ? starters.length : slot === "sub" ? subs.length : next.length;
      next.push({ playerId: hit.id, slot, order });
      return true;
    };

    pick((p) => p.position === "GK");
    ["DEF", "DEF", "MID", "MID", "FWD", "FWD", "DEF", "MID"].forEach((pos) => {
      if (next.length < rules.squadSize) pick((p) => p.position === pos);
    });
    while (next.length < rules.squadSize && pick(() => true)) {
      /* fill remaining */
    }
    setSelected(next.slice(0, rules.squadSize));
  };

  const save = async () => {
    if (!league || !rules) return;
    if (selected.length !== rules.squadSize) {
      setToast({ message: `Select exactly ${rules.squadSize} players before continuing`, tone: "error" });
      return;
    }
    setSaving(true);
    try {
      const starters = selected.filter((s) => s.slot === "starter");
      const outfield = starters
        .map((s) => ({
          id: s.playerId,
          position: roster.data?.players.find((p) => p.id === s.playerId)?.position ?? "MID",
          slot: s.slot,
          order: s.order,
          name: "",
        }))
        .filter((p) => p.position !== "GK");
      const shape = suggestFormation(outfield, rules.format as "5v5" | "7v7", formation || null);
      const nextFormation = formation || shape.label;

      await api(`/api/leagues/${league.id}/squad`, {
        method: "PUT",
        body: { formation: nextFormation, captainId, viceCaptainId: viceId, entries: selected },
        idempotent: true,
      });
      setToast({ message: "Squad saved — now set your line-up", tone: "ok" });
      setTimeout(() => router.push("/team"), 700);
    } catch (err) {
      const details = (err as { details?: unknown }).details;
      const message = Array.isArray(details)
        ? details.join(" ")
        : err instanceof Error
          ? err.message
          : "Could not save";
      setToast({ message, tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  if (leagueLoading || (roster.loading && !roster.data)) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
        <Skeleton className="mb-6 h-20" />
        <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[74px] rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-96 rounded-xl" />
        </div>
      </div>
    );
  }

  if (roster.error) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <ErrorNote message={roster.error} onRetry={roster.reload} />
      </div>
    );
  }

  if (!rules) return null;

  return (
    <div className="mx-auto max-w-[1240px] px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        eyebrow={`${league?.name} · ${rules.format} · ${rules.squadSize}-player squad`}
        title="Player selection"
        subtitle="Every league owns its own player database — you are only picking from this league's registered players."
        actions={
          <>
            <Button variant="ghost" onClick={autoFill} disabled={!roster.data?.players.length}>
              Auto-fill
            </Button>
            <Button onClick={save} loading={saving} disabled={selected.length !== rules.squadSize}>
              Save squad ({selected.length}/{rules.squadSize})
            </Button>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        {/* ------------- roster ------------- */}
        <div>
          <div className="mb-3 flex flex-col gap-2.5 sm:flex-row">
            <div className="flex-1">
              <SearchBox value={query} onChange={setQuery} placeholder="Search players…" />
            </div>
            <div className="sm:w-52">
              <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                <option value="ALL">All teams</option>
                {(roster.data?.teams ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="mb-4 flex flex-wrap gap-1.5">
            {POSITION_TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setPosition(tab)}
                className={`h-8 rounded-md border px-3 text-[12px] font-semibold uppercase tracking-[0.12em] transition-colors ${
                  position === tab
                    ? "border-green bg-green/12 text-green"
                    : "border-line bg-pitch-900 text-sage hover:border-green-dim hover:text-chalk"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          {!roster.data?.players.length ? (
            <EmptyState
              title="No players registered yet"
              body="The League Leader has to create this league's player database first — add teams and players from the Players screen."
              action={{ label: "Go to players", href: "/players" }}
              icon={<ShieldAlert className="h-5 w-5" />}
            />
          ) : filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line px-5 py-10 text-center text-[14px] text-sage">
              <Search className="mx-auto mb-3 h-5 w-5 text-sage-dim" />
              No players match those filters.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {filtered.map((p) => {
                const picked = selectedIds.has(p.id);
                const unavailable = p.availability !== "available";
                return (
                  <li key={p.id}>
                    <div
                      className={`group flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                        picked ? "border-green/45 bg-green/6" : "border-line bg-pitch-850 hover:border-green-dim"
                      }`}
                    >
                      <PlayerThumb player={p} />
                      <button onClick={() => setDetail(p)} className="min-w-0 flex-1 text-left">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[14.5px] font-semibold text-chalk">{p.fullName}</span>
                          {unavailable && (
                            <span className="h-1.5 w-1.5 rounded-full bg-card-r" title={p.availability} />
                          )}
                        </div>
                        <div className="num mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] uppercase tracking-[0.1em] text-sage-dim">
                          <span className="text-green-glow/80">{p.position}</span>
                          <span>#{p.shirtNumber ?? "—"}</span>
                          <span className="normal-case tracking-normal text-sage">
                            {(roster.data?.teams ?? []).find((t) => t.id === p.teamId)?.name ?? "Free agent"}
                          </span>
                        </div>
                      </button>
                      {picked ? (
                        <button
                          onClick={() => remove(p.id)}
                          className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-sage transition-colors hover:border-card-r hover:text-card-r"
                          aria-label={`Remove ${p.fullName}`}
                        >
                          <Minus className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          onClick={() => add(p)}
                          className="flex h-8 items-center gap-1.5 rounded-md border border-green-dim px-3 text-[12px] font-semibold uppercase tracking-[0.1em] text-green transition-colors hover:bg-green hover:text-[#04120a]"
                        >
                          <UserPlus className="h-3.5 w-3.5" /> Add
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ------------- selection summary ------------- */}
        <div className="space-y-4">
          <Panel className="p-4">
            <div className="flex items-center justify-between">
              <Slate>Your squad</Slate>
              <Badge tone={selected.length === rules.squadSize ? "live" : "warn"}>
                {selected.length}/{rules.squadSize}
              </Badge>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2">
              <Slot label="Starters" value={`${counts.starters}/${rules.starters}`} />
              <Slot label="Subs" value={`${counts.subs}/${rules.subsCount}`} />
              <Slot label="Reserves" value={String(counts.reserves)} />
            </div>

            {selected.length > 0 && (
              <ul className="mt-4 max-h-[46vh] space-y-1.5 overflow-y-auto pr-1">
                {(["starter", "sub", "reserve"] as const).map((slot) =>
                  selected
                    .filter((s) => s.slot === slot)
                    .map((s, i) => {
                      const player = roster.data?.players.find((p) => p.id === s.playerId);
                      if (!player) return null;
                      return (
                        <li
                          key={s.playerId}
                          className="flex items-center gap-2.5 rounded-md bg-pitch-900 px-2.5 py-2"
                        >
                          <span className="num w-8 text-[10.5px] uppercase text-green-glow/70">
                            {player.position}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[13.5px] text-chalk">
                            {player.fullName}
                          </span>
                          <span className="slate">{slot === "starter" ? "XI" : slot === "sub" ? "Bench" : "Res"}</span>
                          <button
                            onClick={() => remove(s.playerId)}
                            className="text-sage-dim transition-colors hover:text-card-r"
                            aria-label={`Remove ${player.fullName}`}
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                          {i === -1 && <Check className="h-3 w-3" />}
                        </li>
                      );
                    }),
                )}
              </ul>
            )}

            <Button
              onClick={save}
              loading={saving}
              disabled={selected.length !== rules.squadSize}
              className="mt-4 w-full"
            >
              {selected.length === rules.squadSize ? "Save & pick line-up" : `Select ${rules.squadSize - selected.length} more`}
            </Button>

            <p className="mt-3 text-[12px] leading-relaxed text-sage-dim">
              {rules.format} rules: exactly {rules.starters} starters including one goalkeeper,
              {rules.subsCount} substitutes, and {rules.squadSize - rules.starters - rules.subsCount} reserves.
            </p>
          </Panel>
        </div>
      </div>

      {/* player detail panel */}
      {detail && (
        <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-6">
          <button className="absolute inset-0 cursor-default" aria-label="Close" onClick={() => setDetail(null)} />
          <div className="animate-rise relative w-full max-w-md rounded-t-2xl border border-line bg-pitch-850 p-5 sm:rounded-xl">
            <div className="flex items-center gap-4">
              <PlayerThumb player={detail} size={64} />
              <div className="min-w-0">
                <h2 className="truncate text-2xl text-chalk">{detail.fullName}</h2>
                <div className="num mt-1 flex gap-3 text-[12px] uppercase tracking-[0.12em] text-sage">
                  <span className="text-green">{detail.position}</span>
                  <span>#{detail.shirtNumber ?? "—"}</span>
                  <span className="capitalize">{detail.availability}</span>
                </div>
              </div>
            </div>

            <dl className="mt-5 space-y-2.5 border-t border-line pt-4 text-[14px]">
              <Row label="Team" value={(roster.data?.teams ?? []).find((t) => t.id === detail.teamId)?.name ?? "Free agent"} />
              <Row label="Status" value={detail.status} />
              <Row label="Availability" value={detail.availability} />
              <Row label="In your squad" value={selectedIds.has(detail.id) ? "Yes" : "No"} />
            </dl>

            {detail.description && (
              <p className="mt-4 rounded-lg bg-pitch-900 p-3 text-[13.5px] leading-relaxed text-sage">
                {detail.description}
              </p>
            )}

            <div className="mt-5 flex gap-2.5">
              <Button variant="ghost" onClick={() => setDetail(null)}>
                Close
              </Button>
              {selectedIds.has(detail.id) ? (
                <Button
                  variant="danger"
                  onClick={() => {
                    remove(detail.id);
                    setDetail(null);
                  }}
                >
                  Remove from squad
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    add(detail);
                    setDetail(null);
                  }}
                >
                  <UserPlus className="h-4 w-4" /> Add to squad
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}

function PlayerThumb({ player, size = 40 }: { player: PlayerRow; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-pitch-900 font-display font-bold text-green"
      style={{ width: size, height: size, fontSize: size * 0.34 }}
    >
      {player.photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={player.photoUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        player.fullName.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}

function Slot({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-pitch-900 px-2.5 py-2">
      <div className="slate">{label}</div>
      <div className="num mt-0.5 text-[15px] font-semibold text-chalk">{value}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="slate">{label}</dt>
      <dd className="truncate text-chalk capitalize">{value}</dd>
    </div>
  );
}
