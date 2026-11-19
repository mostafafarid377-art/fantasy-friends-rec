"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { recoverPendingOperations, setOperationActor, useSession, type SessionPayload, type SessionLeague, type SessionUser } from "@/lib/client/api";

type LeagueContextValue = {
  user: SessionUser | null;
  leagues: SessionLeague[];
  league: SessionLeague | null;
  unread: number;
  setUnread: (count: number) => void;
  loading: boolean;
  selectLeague: (id: string) => void;
  refresh: () => Promise<SessionPayload>;
  logout: () => Promise<void>;
  recovered: number;
  isLeader: boolean;
  canOrganize: boolean;
};

const Ctx = createContext<LeagueContextValue | null>(null);
const ACTIVE_KEY = "ff.active.league";

export function AppProvider({ children, initialSession }: { children: ReactNode; initialSession: SessionPayload }) {
  const session = useSession(initialSession);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [recovered, setRecovered] = useState(0);
  const actor = session.user?.id ?? null;
  const { refresh } = session;

  useEffect(() => {
    try { setActiveId(window.localStorage.getItem(ACTIVE_KEY)); } catch { /* storage unavailable */ }
    setReady(true);
  }, []);

  useEffect(() => {
    setOperationActor(actor);
    if (!actor) return;
    let cancelled = false;
    const recover = async () => {
      try {
        const n = await recoverPendingOperations(actor);
        if (!cancelled && n) { setRecovered(n); await refresh(); }
      } catch (error) {
        // Keep an ambiguous request in the account's queue for explicit retry.
        console.warn("[recovery]", error);
      }
    };
    void recover();
    window.addEventListener("online", recover);
    return () => { cancelled = true; window.removeEventListener("online", recover); };
  }, [actor, refresh]);

  useEffect(() => {
    const onFocus = () => { void refresh().catch((error) => console.warn("[session refresh]", error)); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const selectLeague = useCallback((id: string) => {
    setActiveId(id);
    try {
      window.localStorage.setItem(ACTIVE_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  const league = ready ? session.leagues.find((l) => l.id === activeId) ?? session.leagues[0] ?? null : null;
  const value = useMemo<LeagueContextValue>(() => ({
    user: session.user, leagues: session.leagues, league, unread: session.unread, setUnread: session.setUnread,
    loading: !ready, selectLeague, refresh, logout: session.logout, recovered,
    isLeader: league?.role === "leader",
    canOrganize: league?.role === "leader" || league?.role === "organizer",
  }), [session.user, session.leagues, session.unread, session.setUnread, league, ready, selectLeague, refresh, session.logout, recovered]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLeague() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLeague must be used inside AppProvider");
  return ctx;
}

/** Guard for client pages that need a league to operate. */
export function useActiveLeague() {
  const { league, leagues, loading } = useLeague();
  const router = useRouter();
  useEffect(() => {
    if (!loading && !leagues.length) router.replace("/leagues");
  }, [loading, leagues.length, router]);
  return { league, loading };
}
