/**
 * Cloudflare Turnstile (CAPTCHA) client helpers.
 *
 * Only the public site key lives here — NEXT_PUBLIC_TURNSTILE_SITE_KEY is
 * safe to expose by design. The secret key is configured in Supabase
 * (Auth → Protection → CAPTCHA) and must never appear in this codebase.
 *
 * When no site key is configured the challenge UI renders nothing and forms
 * submit without a token, which keeps local development working while
 * CAPTCHA enforcement is disabled in Supabase.
 */

export function turnstileSiteKey(): string | null {
  const key = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  return key ? key : null;
}

/** Minimal surface of the Turnstile JS API this app uses. */
export type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

export type TurnstileRenderOptions = {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
  theme?: "light" | "dark" | "auto";
  size?: "normal" | "flexible" | "compact";
  appearance?: "always" | "execute" | "interaction-only";
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let loading: Promise<TurnstileApi> | null = null;

/** Loads the Turnstile script once and resolves with the API surface. */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window === "undefined") return Promise.reject(new Error("Turnstile is browser-only"));
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else {
        loading = null;
        reject(new Error("Turnstile did not initialize"));
      }
    };
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("Could not load the verification script"));
    };
    document.head.appendChild(script);
  });
  return loading;
}
