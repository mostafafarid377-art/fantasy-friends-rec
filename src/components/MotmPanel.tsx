"use client";

import { useEffect, useRef, useState } from "react";
import { Trophy } from "lucide-react";
import { Button, ErrorNote, Field, Panel, Select, Slate } from "./ui";
import { MotmCard } from "./MotmCard";
import { MotmPhotoField, KEEP_MOTM_PHOTO, type MotmPhotoChange } from "./MotmPhotoField";
import { api } from "@/lib/client/api";
import { notifyLeagueContentChanged } from "@/lib/client/league-updates";
import type { Motm } from "@/lib/motm";

type Candidate = { id: string; name: string };

/**
 * Leader/organizer panel on an approved match: choose the Man of the Match and
 * manage the photo. Everyone else sees the resulting card on the dashboard.
 */
export function MotmPanel({ leagueId, matchId, candidates, onSaved }: {
  leagueId: string;
  matchId: string;
  candidates: Candidate[];
  onSaved?: () => void;
}) {
  const [motm, setMotm] = useState<Motm | null | undefined>(undefined);
  const [playerId, setPlayerId] = useState("");
  const [photo, setPhoto] = useState<MotmPhotoChange>(KEEP_MOTM_PHOTO);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const base = `/api/leagues/${encodeURIComponent(leagueId)}/matches/${encodeURIComponent(matchId)}/motm`;

  useEffect(() => {
    let live = true;
    api<{ motm: Motm | null }>(base)
      .then((res) => {
        if (!live) return;
        setMotm(res.motm);
        if (res.motm) setPlayerId(res.motm.playerId);
      })
      .catch((e) => { if (live) { setMotm(null); setError(e instanceof Error ? e.message : "Could not load the man of the match"); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  const dirtyPlayer = motm ? playerId !== motm.playerId : Boolean(playerId);
  const canSave = Boolean(playerId) && (dirtyPlayer || photo.kind !== "keep") && !busy && !preparing;

  async function save() {
    if (saving.current || !canSave || !playerId) return;
    saving.current = true;
    setBusy(true); setError(null);
    try {
      let current = motm ?? null;
      if (dirtyPlayer || !current) {
        const res = await api<{ motm: Motm }>(base, { method: "PUT", body: { playerId } });
        if (res?.motm?.playerId !== playerId) throw new Error("The man of the match could not be confirmed. Reload before retrying.");
        current = res.motm;
      }
      if (photo.kind === "upload") {
        const form = new FormData();
        form.append("photo", photo.blob, "motm.jpg");
        const res = await api<{ motm: Motm }>(base, { method: "POST", body: form });
        if (!res?.motm?.photoUrl) throw new Error("The photo upload could not be confirmed. Reload before retrying.");
        current = res.motm;
      } else if (photo.kind === "remove") {
        const res = await api<{ motm: Motm }>(base, { method: "DELETE" });
        if (res?.motm?.photoUrl) throw new Error("The photo removal could not be confirmed. Reload before retrying.");
        current = res.motm;
      }
      setMotm(current);
      setPhoto(KEEP_MOTM_PHOTO);
      notifyLeagueContentChanged(leagueId);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the man of the match");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <Panel className="mb-5 p-4">
      <div className="flex items-center gap-2">
        <Trophy className="h-4 w-4 text-card-y" />
        <Slate>Man of the match</Slate>
      </div>
      <p className="mt-1 text-[13px] text-sage">
        Choose the standout player. The card appears on every manager&rsquo;s dashboard.
      </p>

      <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <Field label="Man of the match player">
            <Select aria-label="Man of the match player" value={playerId} disabled={busy} onChange={(e) => setPlayerId(e.target.value)}>
              <option value="">Choose a player…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
          {motm && (
            <div className="mt-3">
              <MotmPhotoField current={motm.photoUrl} change={photo} onChange={setPhoto} disabled={busy} onPreparing={setPreparing} />
            </div>
          )}
          {error && <div className="mt-3"><ErrorNote message={error} /></div>}
          <div className="mt-3">
            <Button size="sm" onClick={save} loading={busy} disabled={!canSave}>
              {motm ? "Update man of the match" : "Set man of the match"}
            </Button>
          </div>
        </div>

        {motm && (
          <div className="w-40 shrink-0">
            <MotmCard motm={motm} href={`/matches/${matchId}`} />
          </div>
        )}
      </div>
    </Panel>
  );
}
