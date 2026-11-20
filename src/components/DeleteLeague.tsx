"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { useLeague } from "./LeagueContext";
import { Button, ErrorNote, Field, Modal, Panel, TextInput } from "./ui";

export function DeleteLeague({ id, name, disabled }: { id: string; name: string; disabled?: boolean }) {
  const { forgetLeague } = useLeague();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const deleting = useRef(false);
  function close() {
    if (deleting.current) return;
    setConfirmation(""); setError(null); setOpen(false);
  }
  async function remove() {
    if (deleting.current || confirmation !== name) return;
    deleting.current = true; setBusy(true); setError(null);
    try {
      const result = await api<{ deletedId: string }>(`/api/leagues/${encodeURIComponent(id)}`, { method: "DELETE", body: { confirmation } });
      if (result?.deletedId !== id) throw new Error("League deletion could not be confirmed. Refresh your league list before retrying.");
      forgetLeague(id);
      router.replace("/leagues");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete league");
    } finally { deleting.current = false; setBusy(false); }
  }

  return <Panel className="my-5 border-card-r/35 p-5">
    <h2 className="mb-2 text-lg text-chalk">Delete league</h2>
    <p className="mb-3 text-sm text-sage">Permanently remove this league and its data for all members. Their accounts and other leagues are unaffected.</p>
    <Button variant="danger" disabled={disabled} onClick={() => setOpen(true)}><Trash2 className="size-4" /> Delete league</Button>
    {open && <Modal open title={`Delete ${name}?`} onClose={close} manageFocus>
      <p className="mb-4 text-sm text-sage">This permanently deletes the league’s teams, squads, matches and points history. This cannot be undone.</p>
      {error && <div className="mb-3"><ErrorNote message={error} /></div>}
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void remove(); }}>
        <Field label="Type the league name to confirm" hint={name}>
          <TextInput value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="off" maxLength={60} disabled={busy} />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={close} variant="ghost" disabled={busy}>Cancel</Button>
          <Button type="submit" variant="danger" loading={busy} disabled={confirmation !== name}>Permanently delete league</Button>
        </div>
      </form>
    </Modal>}
  </Panel>;
}
