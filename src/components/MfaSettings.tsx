"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api, ApiRequestError } from "@/lib/client/api";
import { Button, ErrorNote, Field, Panel, Slate, TextInput } from "@/components/ui";

type Status = { enabled: boolean; factorId: string | null };
type Setup = { factorId: string; qrCode: string; secret: string };

/** Turn two-step verification (authenticator app) on or off for this account. */
export function MfaSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api<Status>("/api/auth/mfa"));
    } catch {
      setError("Could not load two-step verification");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await task(); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : "Something went wrong. Try again."); }
    finally { setBusy(false); }
  };

  const start = () => run(async () => setSetup(await api<Setup>("/api/auth/mfa", { method: "POST" })));
  const confirm = () => run(async () => {
    if (!setup) return;
    await api("/api/auth/mfa/verify", { method: "POST", body: { factorId: setup.factorId, code } });
    setSetup(null);
    setCode("");
    await load();
  });
  const turnOff = () => run(async () => {
    await api("/api/auth/mfa", { method: "DELETE" });
    setConfirmingOff(false);
    await load();
  });

  return (
    <Panel className="p-5">
      <div className="mb-4 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-green" />
        <Slate>Two-step verification</Slate>
      </div>
      <div className="space-y-4 text-[13.5px] leading-relaxed text-sage">
        {error && <ErrorNote message={error} />}

        {!status && !error && <p>Loading…</p>}

        {status && !status.enabled && !setup && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>Ask for a code from an authenticator app each time you sign in.</p>
            <Button variant="outline" onClick={start} loading={busy} disabled={busy}>Turn on</Button>
          </div>
        )}

        {setup && (
          <div className="space-y-4">
            <p>Scan this code with an authenticator app (Google Authenticator, Authy, 1Password), then enter the 6-digit code it shows.</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qrCode} alt="QR code for your authenticator app" width={176} height={176} className="rounded-lg bg-white p-2" />
            <p>
              Can’t scan it? Enter this key instead: <span className="num break-all text-chalk">{setup.secret}</span>
            </p>
            <Field label="6-digit code">
              <TextInput inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456"
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            </Field>
            <div className="flex gap-2">
              <Button variant="primary" onClick={confirm} loading={busy} disabled={busy || code.length !== 6}>Turn on</Button>
              <Button variant="outline" onClick={() => { setSetup(null); setCode(""); }} disabled={busy}>Cancel</Button>
            </div>
          </div>
        )}

        {status?.enabled && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>Two-step verification is on. If you lose your authenticator app you will not be able to sign in, so keep it safe.</p>
            {!confirmingOff ? (
              <Button variant="outline" onClick={() => setConfirmingOff(true)}>Turn off</Button>
            ) : (
              <span className="flex gap-2">
                <Button variant="outline" onClick={() => setConfirmingOff(false)} disabled={busy}>Keep on</Button>
                <Button variant="primary" onClick={turnOff} loading={busy} disabled={busy}>Turn off</Button>
              </span>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
