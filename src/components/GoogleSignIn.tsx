"use client";

import { useEffect, useRef, useState } from "react";
import { GOOGLE_START_FIELD } from "@/lib/google-sign-in";

export function GoogleSignIn({ next, startToken }: { next: string; startToken: string }) {
  const submitted = useRef(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    // Returning with Back can restore the previous document from the browser cache.
    const reset = () => { submitted.current = false; setPending(false); };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  return (
    <div className="mt-7 space-y-5">
      <form method="post" action="/api/auth/google" onSubmit={(event) => {
        if (submitted.current) { event.preventDefault(); return; }
        submitted.current = true;
        setPending(true);
      }}>
        <input type="hidden" name={GOOGLE_START_FIELD} value={startToken} />
        <input type="hidden" name="next" value={next} />
        <button type="submit" disabled={pending} aria-busy={pending}
          className="flex min-h-11 w-full items-center justify-center gap-3 rounded-md border border-[#747775] bg-white px-4 py-2 text-sm font-semibold text-[#1f1f1f] transition-colors hover:bg-[#f2f5fa] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-green disabled:cursor-wait disabled:opacity-80">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48" className="shrink-0" focusable="false">
            <path fill="#4285F4" d="M43.6 24.45c0-1.42-.13-2.78-.36-4.09H24v7.74h11a9.4 9.4 0 0 1-4.08 6.17v5.14h6.61c3.87-3.56 6.07-8.8 6.07-14.96Z" />
            <path fill="#34A853" d="M24 44c5.51 0 10.13-1.83 13.53-4.59l-6.61-5.14c-1.83 1.22-4.17 1.95-6.92 1.95-5.33 0-9.85-3.6-11.47-8.45H5.72v5.3A20.4 20.4 0 0 0 24 44Z" />
            <path fill="#FBBC05" d="M12.53 27.77a12 12 0 0 1 0-7.54v-5.3H5.72a20 20 0 0 0 0 18.14l6.81-5.3Z" />
            <path fill="#EA4335" d="M24 11.78c3 0 5.69 1.04 7.81 3.06l5.85-5.85C34.12 5.69 29.51 4 24 4A20.4 20.4 0 0 0 5.72 14.93l6.81 5.3C14.15 15.38 18.67 11.78 24 11.78Z" />
          </svg>
          {pending ? "Opening Google…" : "Continue with Google"}
        </button>
      </form>
      <div className="flex items-center gap-3 text-xs text-sage" role="separator" aria-label="Or continue with email">
        <span className="h-px flex-1 bg-line" /> or continue with email <span className="h-px flex-1 bg-line" />
      </div>
    </div>
  );
}
