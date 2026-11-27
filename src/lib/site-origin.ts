import type { NextRequest } from "next/server";
import { googleAppOrigin, googleRequestOrigin } from "@/lib/supabase/google-oauth";

/**
 * The origin used to build links that are sent by email (verification and
 * password reset). It never comes from the client-supplied `Origin` header:
 * a forged header could otherwise point a victim's reset link at another site.
 *
 * With GOOGLE_OAUTH_APP_ORIGIN configured (set it in production) the link
 * always points at the canonical app domain, or at another known host this
 * request was actually addressed to. Without it (local development) the
 * request's own origin is used.
 */
export function siteOrigin(req: NextRequest): string {
  const configured = googleAppOrigin();
  if (configured) return googleRequestOrigin(req, configured) ?? configured;
  return req.nextUrl.origin;
}
