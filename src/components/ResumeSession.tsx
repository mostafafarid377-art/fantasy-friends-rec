"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Keep shared entry pages usable even if resuming a stored session fails. */
export function ResumeSession({ destination }: { destination: string }) {
  const router = useRouter();

  useEffect(() => {
    const controller = new AbortController();
    async function resume() {
      try {
        // This verifies the user and loads the same session data needed by the
        // protected layout. Never send the browser there on just a cookie hint.
        const response = await fetch("/api/auth/session", {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) return;
        const session = await response.json();
        if (!controller.signal.aborted && typeof session?.user?.id === "string" && session.user.id) {
          router.replace(destination);
        }
      } catch {
        // Keep the landing or sign-in page available on an unavailable session.
      }
    }
    void resume();
    return () => controller.abort();
  }, [destination, router]);

  return null;
}
