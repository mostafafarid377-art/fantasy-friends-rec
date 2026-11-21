import type { CookieOptions } from "@supabase/ssr";

// Keep the session in a persistent, host-only cookie, not browser storage.
// Supabase still controls whether the refresh token is valid or revoked.
const PERSISTENT_MAX_AGE = 400 * 24 * 60 * 60;

export function authCookieOptions(name: string, options: CookieOptions, oauth?: { secure: boolean }): CookieOptions {
  const deleting = options.maxAge === 0;
  const googleVerifier = oauth && /-code-verifier(?:\.\d+)?$/.test(name);
  return {
    ...options,
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: oauth?.secure ?? process.env.NODE_ENV === "production",
    maxAge: deleting ? 0 : googleVerifier ? 600 : PERSISTENT_MAX_AGE,
    ...(deleting ? { expires: new Date(0) } : {}),
  };
}
