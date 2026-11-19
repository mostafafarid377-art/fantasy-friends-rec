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
import { recoverPendingOperations, useSession, type SessionLeague, type SessionUser } from "@/lib/client/api";

type LeagueContextValue = {
  user: SessionUser | null;
  leagues: SessionLeague[];
  league: SessionLeague | null;
  unread: number;
  loading: boolean;
  selectLeague: (id: string) => void;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
  setUnread: (n: number | ((prev: number) => number)) => void;
  recovered: number;
  isLeader: boolean;
  canOrganize: boolean;
};

const Ctx = createContext<LeagueContextValue | null>(null);
const ACTIVE_KEY = "ff.active.league";

export function AppProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [recovered, setRecovered] = useState(0);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(ACTIVE_KEY);
      if (stored) setActiveId(stored);
    } catch {
      /* storage unavailable */
    }
    // recover any mutation that never reported back (offline, crash, refresh)
    void recoverPendingOperations().then((n) => n && setRecovered(n));
  }, []);

  useEffect(() => {
    if (!session.leagues?.length) return;
    const exists = activeId && session.leagues.some((l) => l.id === activeId);
    if (!exists) {
      const first = session.leagues[0];
      setActiveId(first.id);
      try {
        window.localStorage.setItem(ACTIVE_KEY, first.id);
      } catch {
        /* ignore */
      }
    }
  }, [session.leagues, activeId]);

  const selectLeague = useCallback((id: string) => {
    setActiveId(id);
    try {
      window.localStorage.setItem(ACTIVE_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  const league = useMemo(
    () => session.leagues?.find((l) => l.id === activeId) ?? null,
    [session.leagues, activeId],
  );

  const value: LeagueContextValue = {
    user: session.user ?? null,
    leagues: session.leagues ?? [],
    league,
    unread: session.unread ?? 0,
    loading: session.loading,
    selectLeague,
    refresh: session.refresh,
    logout: session.logout,
    setUnread: (n) => session.refresh(),
    recovered,
    isLeader: league?.role === "leader",
    canOrganize: league?.role === "leader" || league?.role === "organizer",
  };

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
