"use client";
import { useEffect, useState } from "react";

export type SquadDeadline = { serverNow: string; matchId: string | null; title: string | null; kickOff: string | null; locked: boolean };

export function useKickoffClock(serverNow?: string, kickOff?: string | null) {
  const [sample, setSample] = useState<{ anchor?: string; elapsed: number }>({ elapsed: 0 });
  useEffect(() => {
    if (!serverNow || !kickOff) return;
    const started = performance.now();
    const tick = () => setSample({ anchor: serverNow, elapsed: performance.now() - started });
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [serverNow, kickOff]);
  return serverNow && kickOff ? Math.max(0, Date.parse(kickOff) - Date.parse(serverNow) - (sample.anchor === serverNow ? sample.elapsed : 0)) : null;
}

export function countdown(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const parts = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  return parts.map((n) => String(n).padStart(2, "0")).join(":");
}
