import { combineChunks, isChunkLike, stringFromBase64URL, type CookieOptions } from "@supabase/ssr";

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

/** Identify only this project's unreadable Auth storage before Supabase tries
 * to decode it. This is not session validation; Auth still verifies identity. */
export async function unreadableAuthCookies(url: string, cookies: { name: string; value: string }[]) {
  const key = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
  const unreadable = new Map<string, string>();
  for (const name of [key, `${key}-user`]) {
    const chunks = cookies.filter((cookie) => isChunkLike(cookie.name, name));
    if (!chunks.length) continue;
    try {
      const raw = await combineChunks(name, (chunk) => chunks.find((cookie) => cookie.name === chunk)?.value);
      if (!raw) throw new Error("Missing cookie chunk");
      JSON.parse(raw.startsWith("base64-") ? stringFromBase64URL(raw.slice(7)) : raw);
    } catch {
      for (const cookie of chunks) unreadable.set(cookie.name, cookie.value);
    }
  }
  return unreadable;
}
