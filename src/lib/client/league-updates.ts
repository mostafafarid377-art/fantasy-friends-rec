"use client";

import { useEffect } from "react";
import { useAppRefresh } from "@/lib/client/refresh";

const EVENT = "ff:league-content-changed";
const keyFor = (leagueId: string) => `${EVENT}:${leagueId}`;

export function notifyLeagueContentChanged(leagueId: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: leagueId }));
  // Changes made in another tab can refresh an open dashboard too. No roster
  // data or identity information is stored here.
  try { window.localStorage.setItem(keyFor(leagueId), `${Date.now()}:${Math.random()}`); } catch { /* unavailable */ }
}

export function useLeagueContentUpdates(leagueId: string | undefined, reload: () => void, includeCurrentTab = true) {
  useEffect(() => {
    if (!leagueId) return;
    const onLocal = (e: Event) => { if ((e as CustomEvent).detail === leagueId) reload(); };
    const onOther = (e: StorageEvent) => { if (e.key === keyFor(leagueId)) reload(); };
    if (includeCurrentTab) window.addEventListener(EVENT, onLocal);
    window.addEventListener("storage", onOther);
    return () => {
      window.removeEventListener(EVENT, onLocal);
      window.removeEventListener("storage", onOther);
    };
  }, [leagueId, reload, includeCurrentTab]);
}

// Local and same-browser edits refresh immediately. Visible pages also follow
// edits from other devices without depending on browser Supabase sessions.
// Focus and polling are shared by the whole app through one coordinator.
export function useLiveLeaguePoints(leagueId: string | undefined, reload: () => void, includeCurrentTab = true) {
  useLeagueContentUpdates(leagueId, reload, includeCurrentTab);
  useAppRefresh(reload, { pollMs: 10000, enabled: Boolean(leagueId) });
}
