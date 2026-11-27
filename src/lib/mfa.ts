import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * When the signed-in session still needs a second step, returns the TOTP
 * factor to challenge. Returns null when no code is needed.
 */
export async function pendingMfaFactor(
  supabase: Pick<SupabaseClient, "auth">,
): Promise<{ factorId: string } | null> {
  // This only decides which screen to show. The session itself is refused by
  // the app until the code is verified (see resolveIdentity), so a failure to
  // look this up never lets a password-only session through.
  try {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (!data || data.nextLevel !== "aal2" || data.currentLevel === "aal2") return null;
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const factor = factors?.totp?.[0];
    return factor ? { factorId: factor.id } : null;
  } catch {
    return null;
  }
}

/**
 * Records on the account (in app_metadata, which only the server can change)
 * that two-step verification is on. The signed access token carries it, so the
 * app can refuse a password-only session without an extra database call.
 */
export async function setMfaFlag(userId: string, enrolled: boolean): Promise<void> {
  const { getServiceSupabase } = await import("@/db/service");
  const sb = await getServiceSupabase();
  const { error } = await sb.auth.admin.updateUserById(userId, { app_metadata: { mfa_enrolled: enrolled } });
  if (error) throw new Error(error.message);
}
