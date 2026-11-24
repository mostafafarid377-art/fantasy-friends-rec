"use client";

import { useEffect, useRef, useState } from "react";
import { loadTurnstile, turnstileSiteKey } from "@/lib/turnstile";

/**
 * Renders a Cloudflare Turnstile challenge and reports the token lifecycle to
 * the parent:
 * - success: onToken(token)
 * - expired / error: onToken(null) — the widget resets itself so the visitor
 *   can verify again (tokens are single-use and short-lived)
 * - bumping resetKey (e.g. after a failed submit) forces a fresh challenge
 *
 * Renders nothing when NEXT_PUBLIC_TURNSTILE_SITE_KEY is not configured.
 */
export function TurnstileChallenge({
  onToken,
  resetKey = 0,
}: {
  onToken: (token: string | null) => void;
  resetKey?: number;
}) {
  const siteKey = turnstileSiteKey();
  const container = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Keep the latest callback without re-rendering the widget.
  const onTokenRef = useRef(onToken);
  useEffect(() => { onTokenRef.current = onToken; }, [onToken]);

  useEffect(() => {
    if (!siteKey || !container.current) return;
    let cancelled = false;
    let mountedId: string | null = null;
    setFailed(false);

    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !container.current) return;
        mountedId = turnstile.render(container.current, {
          sitekey: siteKey,
          theme: "dark",
          size: "flexible",
          callback: (token) => { setFailed(false); onTokenRef.current(token); },
          "expired-callback": () => {
            onTokenRef.current(null);
            if (mountedId) window.turnstile?.reset(mountedId);
          },
          "error-callback": () => {
            onTokenRef.current(null);
            setFailed(true);
          },
        });
        widgetId.current = mountedId;
      })
      .catch(() => { if (!cancelled) { onTokenRef.current(null); setFailed(true); } });

    return () => {
      cancelled = true;
      if (mountedId) window.turnstile?.remove(mountedId);
      widgetId.current = null;
    };
  }, [siteKey]);

  // A parent bumps resetKey when the submitted token was consumed (failed
  // sign-in, resend after success) and the visitor must verify afresh.
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) { firstReset.current = false; return; }
    onTokenRef.current(null);
    setFailed(false);
    if (widgetId.current) window.turnstile?.reset(widgetId.current);
  }, [resetKey]);

  if (!siteKey) return null;

  return (
    <div aria-label="Human verification">
      <div ref={container} className="min-h-[65px]" />
      {failed && (
        <p role="alert" className="mt-2 text-[13px] text-card-r">
          Verification could not start. Check your connection and reload the page.
        </p>
      )}
    </div>
  );
}
