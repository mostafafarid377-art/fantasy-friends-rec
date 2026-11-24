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
 * - frame-ancestors 'self' stops the app from being framed cross-origin
 *   (clickjacking). X-Frame-Options SAMEORIGIN says the same thing to browsers
 *   without CSP support.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
].join("; ");

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
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
