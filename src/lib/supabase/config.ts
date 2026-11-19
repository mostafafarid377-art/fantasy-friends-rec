/**
 * Supabase configuration helpers.
 * Accept pasted `/rest/v1/` URLs, but normalize to the project root because
 * Supabase client libraries construct Auth and Data API paths themselves.
 */
export function normalizeSupabaseUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new Error("Supabase URL must use HTTPS");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function getSupabasePublicConfig() {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!rawUrl || !publishableKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    );
  }
  if (!publishableKey.startsWith("sb_publishable_") && !publishableKey.startsWith("eyJ")) {
    throw new Error("Supabase key must be a publishable key or legacy anon JWT");
  }
  return { url: normalizeSupabaseUrl(rawUrl), publishableKey };
}
