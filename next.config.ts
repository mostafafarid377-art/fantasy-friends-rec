import type { NextConfig } from "next";

const previewEnabled = process.env.NODE_ENV === "development" && process.env.LINEUP_DESIGN_PREVIEW === "1";

/**
 * Baseline security headers for every response.
 *
 * The app never renders user HTML (React escaping, no dangerouslySetInnerHTML),
 * sets cookies only as httpOnly + SameSite=Lax, and talks only to its own API
 * and to Supabase, so the policy can stay tight:
 * - connect-src allows the app's own routes and the Supabase REST/Auth/Realtime
 *   endpoints (https + wss); Google sign-in is a same-origin form post followed
 *   by a server redirect, so it needs no CSP allowance.
 * - img-src allows https avatars/crests (Google profile pictures) and data/blob
 *   URLs used by local previews before upload.
 * - form-action allows the app's own forms plus the two hosts in the Google
 *   sign-in redirect chain. The Google button is a real same-origin form POST
 *   to /api/auth/google, which answers 303 to the Supabase authorize endpoint
 *   (https://*.supabase.co, the app's own auth backend — same scoping as
 *   connect-src), which in turn redirects to https://accounts.google.com.
 *   Chromium enforces form-action against every hop of that redirect chain
 *   (Firefox does not), so 'self' alone blocked Google sign-in in Chromium
 *   with "Sending form data to '<app origin>/api/auth/google' violates …
 *   form-action 'self'" — the message names the form action, not the blocked
 *   redirect target. No other form in the app posts cross-origin, so no other
 *   destination is allowed.
 * - script-src and frame-src additionally allow challenges.cloudflare.com,
 *   the only host Cloudflare Turnstile loads its script and challenge iframe
 *   from (see src/components/TurnstileChallenge.tsx). Nothing else changes.
 * - script-src adds 'unsafe-eval' in DEVELOPMENT only: Turbopack's dev
 *   runtime applies HMR updates through eval() (evalModuleEntry), and
 *   React's development build probes eval() availability (guarded). It is
 *   NOT needed for initial chunk execution — browser evidence (CI workflow
 *   e2e-diagnostic.yml) shows identical behavior with the header stripped.
 *   Production bundles contain no eval(), so the production policy stays
 *   unchanged.
 */
export function buildContentSecurityPolicy(isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://challenges.cloudflare.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "frame-src https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://*.supabase.co https://accounts.google.com",
    "frame-ancestors 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
  ].join("; ");
}

const isDev = process.env.NODE_ENV === "development";
const contentSecurityPolicy = buildContentSecurityPolicy(isDev);

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
];

const nextConfig: NextConfig = previewEnabled ? {
  devIndicators: false,
  allowedDevOrigins: ["*.e2b.app"],
  async redirects() {
    return [{ source: "/", destination: "/team/next-match-preview", permanent: false }];
  },
} : {
  // Development only (Next ignores this key outside `next dev`): the dev
  // server's cross-site protection allowlists `localhost`/`*.localhost` by
  // default, but NOT `127.0.0.1`. When the app is browsed via
  // http://127.0.0.1:<port> — the documented local setup and the E2E
  // suite's base URL — every WebSocket handshake to /_next/hmr is answered
  // 403. In Next 16 dev, React Server Component debug info (the Flight
  // "debug channel") is delivered over that socket; while it never connects,
  // the client's `hydrate()` awaits a payload that never resolves, so
  // hydration silently never runs: scripts execute, no console error, but
  // no event handlers — forms fall back to native submission. Proven by
  // CI A/B (workflow e2e-diagnostic.yml): same build hydrates at the
  // localhost origin and at 127.0.0.1 once this key is present, and stays
  // dead at 127.0.0.1 without it. This widens NOTHING in production.
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
